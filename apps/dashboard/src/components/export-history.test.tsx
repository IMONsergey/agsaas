import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  TeamExportHistoryEntry,
  TeamExportHistoryReceipt,
} from "@/utils/export-history";

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const ID = "22222222-2222-4222-8222-222222222222";
const OP = "a".repeat(64);
const HASH = "b".repeat(64);
const SECRET = "test-session-file-capability";
type ButtonProps = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => unknown;
};
let buttons: ButtonProps[] = [];
const Button = (props: ButtonProps) => {
  buttons.push(props);
  return (
    <button type="button" disabled={props.disabled}>
      {props.children}
    </button>
  );
};
mock.module("@midday/ui/button", () => ({ Button }));

const entry = (): TeamExportHistoryEntry => ({
  id: ID,
  operationId: OP,
  snapshotHash: "c".repeat(64),
  createdAt: "2026-11-03T12:00:00.000001Z",
  updatedAt: "2026-11-03T12:00:01.000002Z",
  snapshotAt: "2026-11-03T12:00:00.000Z",
  outcome: "complete",
  totalItems: 12,
  missingFiles: 0,
  archive: {
    path: `${TEAM}/exports/${OP}/${HASH}.zip`,
    fileName: "team-export.zip",
    sha256: HASH,
  },
});
const originalProfile = () => ({
  id: USER,
  team: { id: TEAM },
  fileKey: SECRET,
});
let currentProfile = originalProfile();
let currentTeam = { id: TEAM };
let historyData = { teamId: TEAM, items: [entry()], nextCursor: null };
let historyError = false;
let profileError = false;
let teamError = false;
let receipt: TeamExportHistoryReceipt;
const historyRefetch = mock(async () => {});
const profileRefetch = mock(async () => {});
const teamRefetch = mock(async () => {});
const fetchReceipt = mock(
  async (_options: unknown): Promise<TeamExportHistoryReceipt> => receipt,
);
const downloadFile = mock();

const trpc = {
  user: { me: { queryKey: () => ["user"] } },
  team: {
    current: {
      queryKey: () => ["team"],
      queryOptions: () => ({ queryKey: ["team"] }),
    },
    exportHistory: { queryOptions: () => ({ queryKey: ["history"] }) },
    exportHistoryEntry: {
      queryOptions: (input: { id: string }) => ({
        queryKey: ["entry", input.id],
      }),
    },
  },
};
mock.module("@/trpc/client", () => ({ useTRPC: () => trpc }));
mock.module("@/hooks/use-user", () => ({
  useUserQuery: () => ({
    data: currentProfile,
    isError: profileError,
    isPending: false,
    isFetching: false,
    refetch: profileRefetch,
  }),
}));
mock.module("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === "team"
      ? {
          data: currentTeam,
          isError: teamError,
          isPending: false,
          isFetching: false,
          refetch: teamRefetch,
        }
      : {
          data: historyData,
          isError: historyError,
          isPending: false,
          isFetching: false,
          refetch: historyRefetch,
        },
  useQueryClient: () => ({
    fetchQuery: fetchReceipt,
    getQueryData: (key: string[]) =>
      key[0] === "user" ? currentProfile : currentTeam,
    getQueryState: (key: string[]) => ({
      status: (key[0] === "user" ? profileError : teamError)
        ? "error"
        : "success",
    }),
  }),
}));
mock.module("@/hooks/use-file-url", () => ({
  useFileUrl: (options: { filePath: string } | null) => ({
    url: options
      ? `https://owned.example.test/files/download/file?path=${encodeURIComponent(options.filePath)}&fk=${currentProfile.fileKey}`
      : null,
  }),
}));
mock.module("@/lib/download", () => ({ downloadFile }));

const rejectNetwork = () => {
  throw new Error("Unexpected network access in export history regression");
};
const blockedFetch: typeof fetch = Object.assign(async () => rejectNetwork(), {
  preconnect: rejectNetwork,
});
const network = spyOn(globalThis, "fetch").mockImplementation(blockedFetch);
const { ExportHistory } = await import("./export-history");

function render() {
  buttons = [];
  return renderToStaticMarkup(<ExportHistory />);
}
function button(label: string) {
  const found = buttons.find((value) => value.children === label);
  if (!found) throw new Error(`Missing action ${label}`);
  return found;
}
beforeEach(() => {
  currentProfile = originalProfile();
  currentTeam = { id: TEAM };
  historyData = { teamId: TEAM, items: [entry()], nextCursor: null };
  historyError = false;
  profileError = false;
  teamError = false;
  receipt = { teamId: TEAM, item: entry() };
  fetchReceipt.mockReset();
  fetchReceipt.mockImplementation(async () => receipt);
  for (const fn of [downloadFile, historyRefetch, profileRefetch, teamRefetch])
    fn.mockClear();
});
afterAll(() => network.mockRestore());

describe("actual export history UI and protected download confirmation", () => {
  test("a persisted complete receipt is downloadable after reload without a Redis job or queue mutation", async () => {
    const html = render();
    expect(html).toContain("Complete archive");
    expect(html).not.toContain(SECRET);
    await button("Download").onClick?.();
    expect(fetchReceipt).toHaveBeenCalledWith({
      queryKey: ["entry", ID],
      staleTime: 0,
    });
    expect(downloadFile).toHaveBeenCalledWith(
      `https://owned.example.test/files/download/file?path=${encodeURIComponent(entry().archive!.path)}&fk=${SECRET}`,
      "team-export.zip",
    );
    expect(network).not.toHaveBeenCalled();
  });

  test("a failed history read hides even successful cached rows and offers a read-only refresh", async () => {
    historyError = true;
    const html = render();
    expect(html).toContain("Export history is unavailable");
    expect(html).not.toContain(ID);
    expect(html).not.toContain("Complete archive");
    expect(buttons.some((value) => value.children === "Download")).toBe(false);
    await button("Refresh").onClick?.();
    expect(historyRefetch).toHaveBeenCalledTimes(1);
    expect(fetchReceipt).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  test("previous-team cached history cannot expose an archive or its reference", () => {
    historyData = { ...historyData, teamId: OTHER };
    const html = render();
    expect(html).toContain("Could not confirm this team");
    expect(html).not.toContain(ID);
    expect(buttons.some((value) => value.children === "Download")).toBe(false);
  });

  test("profile/team disagreement hides cached history until current scope is confirmed", () => {
    currentTeam = { id: OTHER };
    const html = render();
    expect(html).toContain("Could not confirm your current team");
    expect(html).not.toContain(ID);
    expect(buttons.some((value) => value.children === "Download")).toBe(false);
  });

  test("team or session changes during the fresh GET cancel download before a React rerender", async () => {
    for (const change of ["team", "session"]) {
      currentProfile = originalProfile();
      currentTeam = { id: TEAM };
      let resolve: (value: TeamExportHistoryReceipt) => void = () => {
        throw new Error("Resolver not installed");
      };
      const pending = new Promise<TeamExportHistoryReceipt>((done) => {
        resolve = done;
      });
      fetchReceipt.mockImplementationOnce(() => pending);
      render();
      const action = button("Download").onClick?.();
      if (change === "team") {
        currentProfile = { ...currentProfile, team: { id: OTHER } };
        currentTeam = { id: OTHER };
      } else {
        currentProfile = {
          ...currentProfile,
          fileKey: "new-session-file-capability",
        };
      }
      resolve(receipt);
      await action;
      expect(downloadFile).not.toHaveBeenCalled();
    }
  });

  test("fresh foreign, changed or missing receipts never use the stale list URL", async () => {
    const changed = entry();
    if (!changed.archive) throw new Error("Fixture archive missing");
    const responses: TeamExportHistoryReceipt[] = [
      { teamId: OTHER, item: entry() },
      { teamId: TEAM, item: null },
      {
        teamId: TEAM,
        item: {
          ...changed,
          archive: { ...changed.archive, sha256: "d".repeat(64) },
        },
      },
    ];
    for (const next of responses) {
      receipt = next;
      render();
      await button("Download").onClick?.();
      expect(downloadFile).not.toHaveBeenCalled();
    }
  });

  test("transport failure during confirmation never starts a download", async () => {
    fetchReceipt.mockImplementationOnce(async () => {
      throw new Error("private provider transport detail");
    });
    render();
    await button("Download").onClick?.();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  test("an asynchronous download/save rejection is caught by the actual handler", async () => {
    downloadFile.mockImplementationOnce(async () => {
      throw new Error("private desktop save failure");
    });
    render();
    await expect(
      Promise.resolve(button("Download").onClick?.()),
    ).resolves.toBeUndefined();
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(fetchReceipt).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  });

  test("partial and failed archives are diagnostic; an unknown outcome has no download", () => {
    historyData.items = [
      { ...entry(), id: ID, outcome: "partial", missingFiles: 0 },
      {
        ...entry(),
        id: "55555555-5555-4555-8555-555555555555",
        outcome: "failed",
      },
      {
        ...entry(),
        id: "66666666-6666-4666-8666-666666666666",
        outcome: "unknown",
        archive: null,
        totalItems: null,
        missingFiles: null,
      },
    ];
    const html = render();
    expect(html).toContain("Incomplete archive");
    expect(html).toContain("Failed export");
    expect(html).toContain("Outcome not yet confirmed");
    expect(html).not.toContain("Complete archive");
    expect(button("Download incomplete archive")).toBeDefined();
    expect(button("Download diagnostic archive")).toBeDefined();
    expect(
      buttons.filter((value) => String(value.children).startsWith("Download")),
    ).toHaveLength(2);
  });
});
