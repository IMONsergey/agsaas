import { describe, expect, test } from "bun:test";
import {
  type InboxWebhookReceipt,
  InvalidInboxWebhookAttachment,
  ingestWebhookReceipts,
  type PreparedWebhookReceipt,
  prepareWebhookReceipts,
  type WebhookAttachment,
  type WebhookIngestionDependencies,
} from "./inbox-webhook-ingestion";
import {
  createInboxReceiptQueue,
  type InboxReceiptPayload,
  type RetainedInboxJob,
} from "./inbox-webhook-queue";

const TEAM = "10000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "20000000-0000-4000-8000-000000000002";

function attachment(
  value = "%PDF-one",
  name = "receipt.pdf",
): WebhookAttachment {
  return {
    Name: name,
    Content: Buffer.from(value).toString("base64"),
    ContentType: "application/pdf",
    ContentLength: Buffer.byteLength(value),
    ContentID: "",
  };
}

async function prepare(
  attachments = [attachment()],
  teamId = TEAM,
  messageId = "message-1",
) {
  return prepareWebhookReceipts({
    teamId,
    messageId,
    attachments: attachments.map((item, index) => ({
      attachment: item,
      index,
    })),
    senderEmail: "sender@example.test",
    subject: "Invoice",
  });
}

type FakeJob = RetainedInboxJob & {
  state: string;
  retries: number;
  retry(state: "failed"): Promise<void>;
};
function fixture(teamId = TEAM) {
  const objects = new Map<string, Uint8Array>();
  const rows = new Map<string, InboxWebhookReceipt>();
  const erased = new Map<
    string,
    {
      id: string;
      original: PreparedWebhookReceipt;
      legacy: boolean;
      known: boolean;
    }
  >();
  const jobs = new Map<string, FakeJob>();
  const uploads: string[] = [];
  const events: string[] = [];
  const failUploads = new Set<string>();
  let loseUploadResponse = false;
  let loseRegistrationResponse = false;
  let loseQueueResponse = false;
  let failQueue = false;
  let uncertainAdmission = false;
  let reservations = 0;
  let processingCalls = 0;
  function putJob(id: string, payload: InboxReceiptPayload): FakeJob {
    const job: FakeJob = {
      name: "process-attachment",
      data: structuredClone(payload),
      state: "waiting",
      retries: 0,
      finishedOn: 1,
      attemptsMade: 1,
      attemptsStarted: 1,
      opts: {},
      async getState() {
        return this.state as Awaited<ReturnType<RetainedInboxJob["getState"]>>;
      },
      async retry() {
        if (this.state !== "failed") throw new Error("not failed");
        this.state = "waiting";
        this.retries++;
      },
    };
    jobs.set(id, job);
    return job;
  }
  const ensureQueue = createInboxReceiptQueue({
    find: async (id) => jobs.get(id),
    enqueue: async (id, payload) => {
      if (failQueue) throw new Error("Redis unavailable");
      expect(rows.has(payload.referenceId)).toBe(true);
      events.push("enqueue");
      if (!jobs.has(id)) putJob(id, payload);
      if (loseQueueResponse) throw new Error("enqueue acknowledgment lost");
    },
    retry: async (_id, _payload, job) => {
      reservations++;
      await (job as FakeJob).retry("failed");
    },
    confirmAdmission: async () => {
      if (uncertainAdmission) throw new Error("pending retry admission");
    },
  });
  const deps: WebhookIngestionDependencies = {
    findReceipt: async (ref, expected) => {
      const row = rows.get(ref);
      if (row?.teamId === teamId) return structuredClone(row);
      const proof = erased.get(ref);
      if (!proof || proof.original.teamId !== teamId) return undefined;
      return {
        id: proof.id,
        teamId,
        referenceId: ref,
        filePath: null,
        fileName: null,
        contentType: expected.contentType,
        size: proof.original.size,
        status: "deleted",
        senderEmail: null,
        meta: null,
        deletionProof: {
          contentSha256: proof.known ? proof.original.contentSha256 : null,
          contentTypeMatches:
            proof.original.contentType === expected.contentType,
          metadataRetained: !proof.legacy,
          metadataMatches: proof.legacy
            ? null
            : JSON.stringify(proof.original.meta) ===
              JSON.stringify(expected.meta),
          unavailable: !proof.known,
        },
      };
    },
    upload: async (receipt) => {
      const path = receipt.filePath.join("/");
      uploads.push(path);
      events.push("upload");
      if (erased.has(receipt.referenceId))
        return { error: "object was deleted" };
      if (failUploads.has(receipt.referenceId)) return { error: "unavailable" };
      if (objects.has(path)) return { error: "already exists" };
      objects.set(path, new Uint8Array(receipt.bytes));
      if (loseUploadResponse) throw new Error("upload acknowledgment lost");
      return { path };
    },
    download: async (path) => {
      events.push("download");
      const bytes = objects.get(path);
      if (!bytes) throw new Error("missing object");
      return bytes;
    },
    register: async (receipt) => {
      events.push("register");
      if (erased.has(receipt.referenceId))
        throw new Error("Inbox receipt was erased");
      const {
        bytes: _bytes,
        legacyReferenceId: _legacy,
        contentSha256: _hash,
        attachmentIndex: _index,
        ...data
      } = receipt;
      if (!rows.has(receipt.referenceId))
        rows.set(receipt.referenceId, {
          ...data,
          id: crypto.randomUUID(),
          status: "new",
        });
      if (loseRegistrationResponse)
        throw new Error("commit acknowledgment lost");
      return structuredClone(rows.get(receipt.referenceId)!);
    },
    enqueue: async (...args) => {
      processingCalls++;
      return ensureQueue(...args);
    },
  };
  return {
    objects,
    rows,
    jobs,
    uploads,
    events,
    failUploads,
    deps,
    erase(
      original: PreparedWebhookReceipt,
      options: { legacy?: boolean; known?: boolean; keepBytes?: boolean } = {},
    ) {
      const ref = options.legacy
        ? original.legacyReferenceId
        : original.referenceId;
      const row = rows.get(ref);
      erased.set(ref, {
        id: row?.id ?? crypto.randomUUID(),
        original: structuredClone(original),
        legacy: options.legacy === true,
        known: options.known !== false,
      });
      rows.delete(ref);
      if (!options.keepBytes) {
        objects.delete(row?.filePath?.join("/") ?? original.filePath.join("/"));
      }
    },
    loseUpload() {
      loseUploadResponse = true;
    },
    loseRegistration() {
      loseRegistrationResponse = true;
    },
    loseQueue() {
      loseQueueResponse = true;
    },
    queueFailure(value: boolean) {
      failQueue = value;
    },
    uncertainAdmission() {
      uncertainAdmission = true;
    },
    metrics: () => ({ reservations, processingCalls }),
  };
}

function only<T>(values: Iterable<T>) {
  return [...values][0]!;
}
function legacyRow(
  expected: PreparedWebhookReceipt,
  teamId = TEAM,
): InboxWebhookReceipt {
  return {
    id: crypto.randomUUID(),
    teamId,
    referenceId: expected.legacyReferenceId,
    filePath: [teamId, "inbox", "receipt_old.pdf"],
    fileName: "receipt_old.pdf",
    contentType: expected.contentType,
    size: expected.size,
    status: "new",
    senderEmail: "historical@example.test",
    meta: null,
  };
}

describe("Postmark durable receipt handoff", () => {
  test("uses canonical scoped identity, not provider filenames or mutable bytes", async () => {
    const [one] = await prepare([
      attachment("%PDF-one", "../unsafe%2f/name.pdf"),
    ]);
    const [changed] = await prepare([
      attachment("%PDF-two", "../unsafe%2f/name.pdf"),
    ]);
    const [otherTeam] = await prepare([attachment()], OTHER_TEAM);
    expect(one!.filePath.slice(0, 3)).toEqual([TEAM, "inbox", "uploads"]);
    expect(one!.filePath[3]).toMatch(/^receipt_[a-f0-9]{64}\.bin$/);
    expect(changed!.referenceId).toBe(one!.referenceId);
    expect(changed!.filePath).toEqual(one!.filePath);
    expect(changed!.contentSha256).not.toBe(one!.contentSha256);
    expect(otherTeam!.referenceId).not.toBe(one!.referenceId);
  });

  test("same-name attachment slots remain distinct", async () => {
    const receipts = await prepare([
      attachment("%PDF-one"),
      attachment("%PDF-two"),
    ]);
    expect(receipts[0]!.referenceId).not.toBe(receipts[1]!.referenceId);
    const f = fixture();
    expect((await ingestWebhookReceipts(receipts, f.deps)).accepted).toBe(2);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([2, 2, 2]);
  });

  test("validates every attachment before any handoff", async () => {
    await expect(
      prepare([attachment(), { ...attachment(), ContentLength: 1 }]),
    ).rejects.toBeInstanceOf(InvalidInboxWebhookAttachment);
    await expect(
      prepare([{ ...attachment(), Content: "%%%" }]),
    ).rejects.toBeInstanceOf(InvalidInboxWebhookAttachment);
    await expect(prepare([attachment()], "not-a-team")).rejects.toThrow();
    await expect(prepare([attachment()], TEAM, " ")).rejects.toBeInstanceOf(
      InvalidInboxWebhookAttachment,
    );
  });

  test("registers before enqueue and concurrent replay keeps one object/row/job", async () => {
    const receipts = await prepare();
    const f = fixture();
    const results = await Promise.all([
      ingestWebhookReceipts(receipts, f.deps),
      ingestWebhookReceipts(receipts, f.deps),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([1, 1, 1]);
    expect(f.events.indexOf("register")).toBeLessThan(
      f.events.indexOf("enqueue"),
    );
  });

  test("lost Storage response is verified against the exact stored bytes", async () => {
    const f = fixture();
    f.loseUpload();
    expect((await ingestWebhookReceipts(await prepare(), f.deps)).success).toBe(
      true,
    );
    expect(f.events).toContain("download");
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([1, 1, 1]);
  });

  test("an existing object with different bytes is never accepted or overwritten", async () => {
    const receipts = await prepare();
    const f = fixture();
    const path = receipts[0]!.filePath.join("/");
    f.objects.set(path, Buffer.from("unrelated"));
    const result = await ingestWebhookReceipts(receipts, f.deps);
    expect(result).toEqual({
      success: false,
      attempted: 1,
      accepted: 0,
      failed: 1,
      deleted: 0,
    });
    expect(Buffer.from(f.objects.get(path)!).toString()).toBe("unrelated");
    expect(f.rows.size).toBe(0);
    expect(f.jobs.size).toBe(0);
  });

  test("lost registration response leaves a durable row that replay enqueues", async () => {
    const receipts = await prepare();
    const f = fixture();
    f.loseRegistration();
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(false);
    expect(f.rows.size).toBe(1);
    expect(f.jobs.size).toBe(0);
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([1, 1, 1]);
  });

  test("lost enqueue response is accepted only when its exact job exists", async () => {
    const receipts = await prepare();
    const f = fixture();
    f.loseQueue();
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
    expect(f.jobs.size).toBe(1);
  });

  test("partial and complete Storage failures remain retriable; replay fills only gaps", async () => {
    const receipts = await prepare([
      attachment("%PDF-one"),
      attachment("%PDF-two"),
    ]);
    const f = fixture();
    for (const receipt of receipts) f.failUploads.add(receipt.referenceId);
    expect(await ingestWebhookReceipts(receipts, f.deps)).toEqual({
      success: false,
      attempted: 2,
      accepted: 0,
      failed: 2,
      deleted: 0,
    });
    f.failUploads.delete(receipts[0]!.referenceId);
    expect(await ingestWebhookReceipts(receipts, f.deps)).toEqual({
      success: false,
      attempted: 2,
      accepted: 1,
      failed: 1,
      deleted: 0,
    });
    f.failUploads.clear();
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([2, 2, 2]);
  });

  test("queue outage keeps registration and does not claim success", async () => {
    const receipts = await prepare();
    const f = fixture();
    f.queueFailure(true);
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(false);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([1, 1, 0]);
    f.queueFailure(false);
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([1, 1, 1]);
  });

  test("changed bytes, name or MIME on the same delivery conflict before writes", async () => {
    const f = fixture();
    const original = await prepare();
    await ingestWebhookReceipts(original, f.deps);
    const uploads = f.uploads.length;
    for (const changed of [
      attachment("%PDF-two"),
      attachment("%PDF-one", "another.pdf"),
      { ...attachment(), ContentType: "application/octet-stream" },
    ]) {
      expect(
        (await ingestWebhookReceipts(await prepare([changed]), f.deps)).success,
      ).toBe(false);
    }
    expect(f.uploads.length).toBe(uploads);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([1, 1, 1]);
  });

  test("completed receipts are not reuploaded or reprocessed after queue eviction", async () => {
    const f = fixture();
    const receipts = await prepare();
    await ingestWebhookReceipts(receipts, f.deps);
    const row = only(f.rows.values());
    const before = f.metrics().processingCalls;
    for (const status of ["done", "pending", "other", "archived"]) {
      row.status = status;
      f.objects.clear();
      f.jobs.clear();
      f.uploads.length = 0;
      expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(
        true,
      );
      expect(f.objects.size).toBe(0);
      expect(f.uploads).toEqual([]);
    }
    expect(f.metrics().processingCalls).toBe(before);
  });

  test("only the persisted canonical path may become the processing payload", async () => {
    const receipts = await prepare();
    const f = fixture();
    await ingestWebhookReceipts(receipts, f.deps);
    only(f.rows.values()).filePath = [
      OTHER_TEAM,
      "inbox",
      "uploads",
      "wrong.bin",
    ];
    f.jobs.clear();
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(false);
    expect(f.jobs.size).toBe(0);
  });

  test("legacy receipt is adopted only through its exact scoped identity and bytes", async () => {
    const receipts = await prepare();
    const f = fixture();
    const expected = receipts[0]!;
    const row = legacyRow(expected);
    f.rows.set(row.referenceId!, row);
    f.objects.set(row.filePath!.join("/"), expected.bytes);
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
    expect([f.objects.size, f.rows.size, f.jobs.size]).toEqual([1, 1, 1]);
    expect(
      (only(f.jobs.values()).data as InboxReceiptPayload).filePath,
    ).toEqual(row.filePath!);
    expect(f.uploads).toEqual([]);
    const different = await prepare([attachment("%PDF-two")]);
    expect((await ingestWebhookReceipts(different, f.deps)).success).toBe(
      false,
    );
    expect([f.objects.size, f.rows.size]).toEqual([1, 1]);
  });

  test("another team's legacy global reference is not reused", async () => {
    const receipts = await prepare();
    const f = fixture();
    const row = legacyRow(receipts[0]!, OTHER_TEAM);
    f.rows.set(row.referenceId!, row);
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
    expect(f.rows.size).toBe(2);
    expect((only(f.jobs.values()).data as InboxReceiptPayload).teamId).toBe(
      TEAM,
    );
  });

  test("failed retained jobs reacquire admission and retry atomically, including a replay race", async () => {
    const f = fixture();
    const receipts = await prepare();
    await ingestWebhookReceipts(receipts, f.deps);
    const job = only(f.jobs.values());
    job.state = "failed";
    const results = await Promise.all([
      ingestWebhookReceipts(receipts, f.deps),
      ingestWebhookReceipts(receipts, f.deps),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(job.retries).toBe(1);
    expect(job.state).toBe("waiting");
    expect(f.metrics().reservations).toBeGreaterThanOrEqual(1);
    expect(f.jobs.size).toBe(1);
  });

  test("retained jobs with unrelated identity are never retried or accepted", async () => {
    const f = fixture();
    const receipts = await prepare();
    await ingestWebhookReceipts(receipts, f.deps);
    const job = only(f.jobs.values());
    job.state = "failed";
    (job.data as InboxReceiptPayload).teamId = OTHER_TEAM;
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(false);
    expect(job.retries).toBe(0);
    expect(f.metrics().reservations).toBe(0);
  });

  test("failed or missing retry is not treated as an active handoff", async () => {
    const f = fixture();
    const receipts = await prepare();
    await ingestWebhookReceipts(receipts, f.deps);
    const job = only(f.jobs.values());
    job.state = "failed";
    job.retry = async () => {
      throw new Error("retry unavailable");
    };
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(false);
  });

  test("a pending or missing admission is not acknowledged even when native queue state is waiting", async () => {
    const f = fixture();
    f.uncertainAdmission();
    const result = await ingestWebhookReceipts(await prepare(), f.deps);
    expect(result.success).toBe(false);
    expect(only(f.jobs.values()).state).toBe("waiting");
    expect(f.rows.size).toBe(1);
  });

  test("completed queue job needs the persisted processing outcome", async () => {
    const f = fixture();
    const receipts = await prepare();
    await ingestWebhookReceipts(receipts, f.deps);
    only(f.jobs.values()).state = "completed";
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(false);
    only(f.rows.values()).status = "done";
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(true);
  });
});

describe("erased receipt replay proof", () => {
  test("physical deletion is acknowledged after object and job removal without another handoff", async () => {
    const receipts = await prepare();
    const f = fixture();
    await ingestWebhookReceipts(receipts, f.deps);
    const calls = f.metrics().processingCalls;
    f.erase(receipts[0]!);
    f.jobs.clear();
    f.events.length = 0;
    expect(await ingestWebhookReceipts(receipts, f.deps)).toEqual({
      success: true,
      attempted: 1,
      accepted: 1,
      failed: 0,
      deleted: 1,
    });
    expect([f.rows.size, f.objects.size, f.jobs.size]).toEqual([0, 0, 0]);
    expect(f.events).toEqual([]);
    expect(f.metrics().processingCalls).toBe(calls);
  });

  test("erasure proof rejects changed same-length bytes, MIME and retained attachment metadata", async () => {
    const receipts = await prepare();
    const f = fixture();
    await ingestWebhookReceipts(receipts, f.deps);
    f.erase(receipts[0]!);
    f.jobs.clear();
    f.events.length = 0;
    for (const changed of [
      attachment("%PDF-two"),
      attachment("%PDF-one", "renamed.pdf"),
      { ...attachment(), ContentType: "application/octet-stream" },
      { ...attachment(), ContentID: "changed-content-id" },
    ]) {
      const result = await ingestWebhookReceipts(
        await prepare([changed]),
        f.deps,
      );
      expect(result.success).toBe(false);
      expect(result.deleted).toBe(0);
    }
    expect(f.events).toEqual([]);
    expect(f.rows.size).toBe(0);
  });

  test("a legacy random path can acknowledge from a retained exact digest after its bytes were erased", async () => {
    const receipts = await prepare();
    const f = fixture();
    const row = legacyRow(receipts[0]!);
    f.rows.set(row.referenceId!, row);
    f.erase(receipts[0]!, { legacy: true });
    expect((await ingestWebhookReceipts(receipts, f.deps)).deleted).toBe(1);
    expect(f.events).toEqual([]);
    expect(f.rows.size).toBe(0);
    expect(
      (
        await ingestWebhookReceipts(
          await prepare([attachment("%PDF-two")]),
          f.deps,
        )
      ).success,
    ).toBe(false);
  });

  test("unknown legacy evidence and old soft-deleted rows do not turn absence into equality", async () => {
    const receipts = await prepare();
    for (const legacy of [false, true]) {
      const f = fixture();
      f.erase(receipts[0]!, { legacy, known: false });
      expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(
        false,
      );
      expect(f.events).toEqual([]);
      expect(f.rows.size).toBe(0);
    }
    const f = fixture();
    const row = legacyRow(receipts[0]!);
    row.status = "deleted";
    f.rows.set(row.referenceId!, row);
    expect((await ingestWebhookReceipts(receipts, f.deps)).success).toBe(false);
    expect(f.events).toEqual([]);
  });

  for (const stage of ["upload", "download", "register", "enqueue"] as const) {
    test(`deletion during ${stage} is recovered only from exact erasure proof`, async () => {
      const receipts = await prepare();
      const expected = receipts[0]!;
      const f = fixture();
      if (stage !== "register") await ingestWebhookReceipts(receipts, f.deps);
      f.jobs.clear();
      f.events.length = 0;
      const deps = { ...f.deps };
      if (stage === "upload") {
        deps.upload = async () => {
          f.erase(expected, { keepBytes: true });
          throw new Error("deletion raced the upload response");
        };
      } else if (stage === "download") {
        deps.upload = async () => ({ error: "conflict" });
        deps.download = async (path) => {
          f.erase(expected);
          return f.deps.download(path);
        };
      } else if (stage === "register") {
        deps.register = async (input) => {
          await f.deps.register(input);
          f.erase(expected);
          throw new Error("deleted before registration response");
        };
      } else {
        deps.enqueue = async () => {
          f.erase(expected);
          throw new Error("deletion raced the queue response");
        };
      }
      const result = await ingestWebhookReceipts(receipts, deps);
      expect(result).toEqual({
        success: true,
        attempted: 1,
        accepted: 1,
        failed: 0,
        deleted: 1,
      });
      expect(f.rows.size).toBe(0);
      expect(f.jobs.size).toBe(0);
    });
  }
});
