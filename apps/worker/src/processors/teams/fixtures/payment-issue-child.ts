import { mock } from "bun:test";
import { Socket } from "node:net";
import type { Job } from "bullmq";
import type { CreateEmailOptions } from "resend";
import type { PaymentIssuePayload } from "../../../schemas/teams";

// Module mocks are confined to this fresh child. The registry import exercises
// real provider modules without their credentials; no job handlers run there.
const scenario = process.argv[2];
let fetchAttempts = 0;
let networkAttempts = 0;
function blockNetwork(kind: string): never {
  networkAttempts++;
  throw new Error(`NETWORK_FORBIDDEN:${kind}`);
}
globalThis.fetch = Object.assign(
  async () => {
    fetchAttempts++;
    return blockNetwork("fetch");
  },
  { preconnect: () => blockNetwork("fetch.preconnect") },
);
Socket.prototype.connect = () => blockNetwork("socket");
Bun.connect = () => blockNetwork("Bun.connect");
Bun.serve = () => blockNetwork("Bun.serve");

const deadline = setTimeout(() => {
  console.error("Payment issue fixture deadline exceeded");
  process.exit(124);
}, 15_000);

async function run() {
  if (scenario === "registry-import") {
    const bullmq = { ...(await import("bullmq")) };
    class NoNetworkQueue {
      constructor(
        readonly name: string,
        readonly opts: unknown,
      ) {}
      on() {
        return this;
      }
      async close() {}
    }
    mock.module("bullmq", () => ({ ...bullmq, Queue: NoNetworkQueue }));
    const registry = await import("../../registry");
    return {
      imported: true,
      registeredJobs: [
        "payment-issue",
        "enrich-transactions",
        "process-document",
        "notification",
      ].filter((jobName) => registry.hasProcessor(jobName)),
    };
  }

  const constructionKeys: string[] = [];
  const sent: CreateEmailOptions[] = [];
  const sdkError = new Error("fixture SDK send rejection");
  if (scenario === "configured-send" || scenario === "send-error") {
    mock.module("resend", () => ({
      Resend: class {
        constructor(apiKey: string) {
          constructionKeys.push(apiKey);
        }
        emails = {
          send: async (payload: CreateEmailOptions) => {
            sent.push(payload);
            if (scenario === "send-error") throw sdkError;
            return { data: { id: "fixture-message" }, error: null };
          },
        };
      },
    }));
  }

  // Template and renderer stay real in every scenario. Only the SDK transport
  // is mocked for configured sends; the missing-key case uses the actual SDK.
  const { PaymentIssueProcessor } = await import("../payment-issue");
  const constructorCountAfterImport = constructionKeys.length;
  const processor = new PaymentIssueProcessor();
  const job = (index: number) =>
    ({
      id: `fixture-job-${index}`,
      data: {
        teamId: "00000000-0000-4000-8000-000000000001",
        email: `recipient-${index}@example.test`,
        fullName: `FixtureName${index} FixtureSurname`,
        teamName: `FixtureTeam${index}`,
      },
    }) as Job<PaymentIssuePayload>;

  if (scenario === "missing-key") {
    try {
      await processor.process(job(0));
    } catch (error) {
      return {
        imported: true,
        missingKeyError: error instanceof Error ? error.message : String(error),
      };
    }
    throw new Error("Expected the real SDK to reject the missing email key");
  }

  if (scenario === "send-error") {
    try {
      await processor.process(job(0));
    } catch (error) {
      return {
        imported: true,
        preservedSdkError: error === sdkError,
        constructionKeys,
        sent,
      };
    }
    throw new Error("Expected the processor to propagate the SDK rejection");
  }

  if (scenario !== "configured-send")
    throw new Error("Unknown fixture scenario");
  const firstResult = await processor.process(job(0));
  const secondResult = await processor.process(job(1));
  return {
    imported: true,
    constructorCountAfterImport,
    constructionKeys,
    sent,
    resultsWereUndefined:
      firstResult === undefined && secondResult === undefined,
  };
}

try {
  const result = await run();
  console.log(
    `PAYMENT_ISSUE_FIXTURE ${JSON.stringify({ ...result, fetchAttempts, networkAttempts })}`,
  );
  process.exitCode = 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.exit(process.exitCode ?? 0);
}
