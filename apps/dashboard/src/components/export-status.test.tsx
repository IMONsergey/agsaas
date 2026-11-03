import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type {
  DependencyList,
  EffectCallback,
  ReactElement,
  ReactNode,
} from "react";

const react = await import("react");

// Exercise the real components and their emitted actions without a browser or
// new renderer dependency. Only React's passive-hook scheduling and IO leaves
// are adapted; the export state decisions remain in ExportStatus.
let slots: unknown[] = [];
let cursor = 0;
let dirty = false;
let effects: EffectCallback[] = [];
const equalDeps = (
  a: DependencyList | undefined,
  b: DependencyList | undefined,
) =>
  !!a &&
  !!b &&
  a.length === b.length &&
  a.every((value, i) => Object.is(value, b[i]));
mock.module("react", () => ({
  ...react,
  useState: <T,>(initial: T | (() => T)) => {
    const i = cursor++;
    if (!(i in slots))
      slots[i] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    return [
      slots[i] as T,
      (value: T | ((old: T) => T)) => {
        const next =
          typeof value === "function"
            ? (value as (old: T) => T)(slots[i] as T)
            : value;
        if (!Object.is(next, slots[i])) {
          slots[i] = next;
          dirty = true;
        }
      },
    ] as const;
  },
  useRef: <T,>(initial: T) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: initial };
    return slots[i] as { current: T };
  },
  useCallback: <T,>(fn: T, deps: DependencyList) => {
    const i = cursor++;
    const old = slots[i] as { deps: DependencyList; fn: T } | undefined;
    if (!old || !equalDeps(old.deps, deps)) slots[i] = { deps, fn };
    return (slots[i] as { fn: T }).fn;
  },
  useEffect: (effect: EffectCallback, deps?: DependencyList) => {
    const i = cursor++;
    const old = slots[i] as DependencyList | undefined;
    if (!equalDeps(old, deps)) {
      slots[i] = deps;
      effects.push(effect);
    }
  },
}));

type Props = {
  children?: ReactNode;
  onClick?: () => unknown;
  disabled?: boolean;
  [key: string]: unknown;
};
const Button = (props: Props) => react.createElement("button", props);
const Container = (props: Props) => react.createElement("div", props);
mock.module("@midday/ui/button", () => ({ Button }));
mock.module("@midday/ui/card", () => ({
  Card: Container,
  CardDescription: Container,
  CardFooter: Container,
  CardHeader: Container,
  CardTitle: Container,
}));
mock.module("@midday/ui/dropdown-menu", () => ({
  DropdownMenu: Container,
  DropdownMenuContent: Container,
  DropdownMenuItem: Container,
  DropdownMenuTrigger: Container,
}));
mock.module("@midday/ui/icons", () => ({ Icons: { ChevronDown: () => null } }));
mock.module("lucide-react", () => ({ Loader2: () => null }));
mock.module("usehooks-ts", () => ({
  useCopyToClipboard: () => [null, mock()],
}));

type Toast = {
  id: string;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  variant?: string;
  progress?: number;
  open?: boolean;
};
let currentToast: Toast | undefined;
let toastCount = 0;
const dismiss = mock((id?: string) => {
  if (currentToast && currentToast.id === id) currentToast.open = false;
});
const update = mock((id: string, value: Partial<Toast>) => {
  if (currentToast?.id === id) currentToast = { ...currentToast, ...value };
});
const toast = mock((value: Omit<Toast, "id">) => {
  const id = String(++toastCount);
  currentToast = { ...value, id, open: true };
  return {
    id,
    dismiss: () => dismiss(id),
    update: (value: Partial<Toast>) => update(id, value),
  };
});
mock.module("@midday/ui/use-toast", () => ({
  useToast: () => ({ toast, dismiss, update }),
}));

type ExportData = {
  runId?: string;
  exportType?: "file" | "team-data" | "accounting";
};
let exportData: ExportData | undefined;
const setExportData = mock((next?: ExportData) => {
  exportData = next;
  dirty = true;
});
mock.module("@/store/export", () => ({
  useExportStore: () => ({ exportData, setExportData }),
}));

type Observation = {
  status?:
    | "waiting"
    | "active"
    | "delayed"
    | "unknown"
    | "completed"
    | "failed";
  progress?: number;
  result?: unknown;
  queryError?: Error | null;
  isFetching: boolean;
};
let observation: Observation;
let nextObservation: Observation;
let observedJobId: string | undefined;
const refetch = mock(async () => {
  observation = nextObservation;
  dirty = true;
  return { data: observation };
});
mock.module("@/hooks/use-job-status", () => ({
  useJobStatus: ({ jobId }: { jobId?: string }) => {
    observedJobId = jobId;
    return { ...observation, refetch };
  },
}));
const queueMutation = mock();
const invalidateQueries = mock();
const trpc = {
  team: { exportAllData: { mutationOptions: (options: unknown) => options } },
  shortLinks: {
    createForDocument: { mutationOptions: (options: unknown) => options },
  },
  documents: { get: { infiniteQueryKey: () => ["documents"] } },
  search: { global: { queryKey: () => ["search"] } },
};
mock.module("@/trpc/client", () => ({ useTRPC: () => trpc }));
mock.module("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: queueMutation, isPending: false }),
  useQueryClient: () => ({ invalidateQueries }),
}));
const play = mock();
const downloadFile = mock();
mock.module("@/hooks/use-success-sound", () => ({
  useSuccessSound: () => ({ play }),
}));
mock.module("@/hooks/use-file-url", () => ({
  useFileUrl: ({ filePath }: { filePath: string }) => ({
    url: `https://owned.example.test/files/${filePath}`,
  }),
}));
mock.module("@/lib/download", () => ({ downloadFile }));

mock.module("./export-history", () => ({ ExportHistory: () => null }));

const { ExportStatus } = await import("./export-status");
const { ExportAllData } = await import("./export-all-data");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let timers: Array<() => void> = [];
let restoreTimer = () => {};

function renderStatus() {
  for (let iterations = 0; iterations < 20; iterations++) {
    dirty = false;
    cursor = 0;
    effects = [];
    ExportStatus();
    for (const effect of effects) effect();
    if (!dirty) return;
  }
  throw new Error("Export status did not settle");
}
function flushTimers() {
  for (let iterations = 0; timers.length && iterations < 20; iterations++) {
    const pending = timers.splice(0);
    for (const callback of pending) callback();
    renderStatus();
  }
  expect(timers).toHaveLength(0);
}
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return react.isValidElement<Props>(node) ? textOf(node.props.children) : "";
}
function findButton(
  node: ReactNode,
  label: string,
): ReactElement<Props> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return;
  }
  if (!react.isValidElement<Props>(node)) return;
  if (node.type === Button && textOf(node.props.children).includes(label))
    return node;
  if (typeof node.type === "function") {
    const child = (node.type as (props: Props) => ReactNode)(node.props);
    return findButton(child, label);
  }
  return findButton(node.props.children, label);
}
function button(node: ReactNode, label: string) {
  const result = findButton(node, label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result.props;
}
const completeResult = {
  fullPath: "team/exports/operation/hash.zip",
  fileName: "team-export.zip",
  filePath: "team-export",
  totalItems: 12,
  status: "complete",
  missingFiles: 0,
};

beforeEach(() => {
  slots = [];
  cursor = 0;
  dirty = false;
  effects = [];
  timers = [];
  currentToast = undefined;
  toastCount = 0;
  exportData = { runId: "transactions:export-42", exportType: "team-data" };
  observation = { status: "active", progress: 35, isFetching: false };
  nextObservation = {
    status: "completed",
    result: completeResult,
    isFetching: false,
  };
  for (const fn of [
    dismiss,
    update,
    toast,
    setExportData,
    refetch,
    queueMutation,
    invalidateQueries,
    play,
    downloadFile,
  ])
    fn.mockClear();
  // A callable proxy preserves the installed timer's overloads and function
  // properties (including Node's __promisify__) without a type assertion.
  const controlledTimeout = new Proxy(realSetTimeout, {
    apply(_target, _receiver, args: unknown[]) {
      const callback = args[0];
      if (typeof callback !== "function")
        throw new Error("Only function timers are supported");
      timers.push(() => callback(...args.slice(2)));
      const handle = realSetTimeout(() => {}, 0);
      realClearTimeout(handle);
      return handle;
    },
  });
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    controlledTimeout,
  );
  restoreTimer = () => timerSpy.mockRestore();
});
afterEach(() => restoreTimer());

describe("export status recovery in the actual components", () => {
  test("read error keeps the same handle and busy button; retry reads to a ready download", async () => {
    renderStatus();
    observation = {
      ...observation,
      queryError: new Error("private transport detail"),
    };
    renderStatus();
    expect(currentToast?.title).toBe("Export status is unavailable");
    expect(textOf(currentToast?.description)).not.toContain("private");
    expect(exportData?.runId).toBe("transactions:export-42");
    expect(button(ExportAllData(), "Exporting").disabled).toBe(true);
    expect(setExportData).not.toHaveBeenCalled();
    await button(currentToast?.footer, "Check status").onClick?.();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(observedJobId).toBe("transactions:export-42");
    expect(queueMutation).not.toHaveBeenCalled();
    renderStatus();
    flushTimers();
    expect(currentToast?.title).toBe("Export completed");
    expect(currentToast?.variant).toBe("success");
    expect(exportData).toBeUndefined();
    await button(currentToast?.footer, "Download").onClick?.();
    expect(downloadFile).toHaveBeenCalledWith(
      "https://owned.example.test/files/team/exports/operation/hash.zip",
      "team-export.zip",
    );
    expect(play).toHaveBeenCalledTimes(1);
  });

  test("a stale completed cache plus a read error remains uncertain until a successful read", async () => {
    observation = { ...nextObservation, queryError: new Error("read failed") };
    renderStatus();
    flushTimers();
    expect(currentToast?.title).toBe("Export status is unavailable");
    expect(exportData?.runId).toBe("transactions:export-42");
    expect(findButton(currentToast?.footer, "Download")).toBeUndefined();
    expect(play).not.toHaveBeenCalled();
    await button(currentToast?.footer, "Check status").onClick?.();
    renderStatus();
    flushTimers();
    expect(currentToast?.title).toBe("Export completed");
    expect(queueMutation).not.toHaveBeenCalled();
  });

  test("unknown retains the handle and resumes progress after another read", async () => {
    observation = { status: "unknown", isFetching: false };
    renderStatus();
    expect(currentToast?.title).toBe("Export status is unknown");
    expect(exportData?.runId).toBe("transactions:export-42");
    expect(setExportData).not.toHaveBeenCalled();
    nextObservation = { status: "active", progress: 67, isFetching: false };
    await button(currentToast?.footer, "Check status").onClick?.();
    renderStatus();
    expect(currentToast?.variant).toBe("progress");
    expect(currentToast?.progress).toBe(67);
    expect(currentToast?.footer).toBeUndefined();
    expect(button(ExportAllData(), "Exporting").disabled).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  test("the retry button is disabled while the status read is in flight", () => {
    observation = { status: "unknown", isFetching: true };
    renderStatus();
    expect(button(currentToast?.footer, "Checking status").disabled).toBe(true);
    expect(exportData?.runId).toBe("transactions:export-42");
    expect(queueMutation).not.toHaveBeenCalled();
  });

  test("an observed terminal failure clears busy state without being overwritten by a new progress toast", () => {
    observation = { status: "failed", isFetching: false };
    renderStatus();
    expect(currentToast?.variant).toBe("error");
    expect(currentToast?.title).toBe("Something went wrong please try again.");
    expect(exportData).toBeUndefined();
    expect(button(ExportAllData(), "Export").disabled).toBe(false);
    expect(findButton(currentToast?.footer, "Download")).toBeUndefined();
    expect(refetch).not.toHaveBeenCalled();
    expect(queueMutation).not.toHaveBeenCalled();
  });

  test("a partial archive reached through retry remains explicitly incomplete", async () => {
    observation = { queryError: new Error("read failed"), isFetching: false };
    nextObservation = {
      status: "completed",
      isFetching: false,
      result: { ...completeResult, status: "partial", missingFiles: 2 },
    };
    renderStatus();
    await button(currentToast?.footer, "Check status").onClick?.();
    renderStatus();
    flushTimers();
    expect(currentToast?.title).toBe("Export is incomplete");
    expect(currentToast?.variant).toBe("error");
    expect(textOf(currentToast?.description)).toContain("2 files");
    expect(play).not.toHaveBeenCalled();
    expect(queueMutation).not.toHaveBeenCalled();
  });

  test("accounting recovery remains owned by its existing export bar", () => {
    exportData = { runId: "accounting:77", exportType: "accounting" };
    observation = {
      status: "failed",
      queryError: new Error("read failed"),
      isFetching: false,
    };
    renderStatus();
    expect(currentToast).toBeUndefined();
    expect(setExportData).not.toHaveBeenCalled();
  });
});
