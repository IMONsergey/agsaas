import { describe, expect, test } from "bun:test";
import { UnrecoverableError } from "bullmq";
import {
  classifyError,
  isNonRetryableError,
  isRetryableError,
  NonRetryableError,
  UnsupportedFileTypeError,
} from "./error-classification";
import { extractErrorDetails } from "./error-details";

describe("permanent job error contract", () => {
  test("uses BullMQ's unrecoverable type without losing application metadata", () => {
    const cause = Object.assign(new Error("original fixture failure"), {
      code: "FIXTURE_CODE",
    });
    const error = new NonRetryableError("invalid fixture", cause, "validation");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error.name).toBe("NonRetryableError");
    expect(error.message).toBe("invalid fixture");
    expect(error.originalError).toBe(cause);
    expect(error.cause).toBe(cause);
    expect(error.category).toBe("validation");
    expect(error.stack).toContain("NonRetryableError: invalid fixture");
    expect(extractErrorDetails(error).cause?.code).toBe("FIXTURE_CODE");
  });

  test("explicit permanence takes precedence over transient-looking text/stack", () => {
    const error = new NonRetryableError(
      "network request rejected permanently",
      undefined,
      "unauthorized",
    );
    error.stack = "at fetch fixture";

    expect(classifyError(error)).toEqual({
      category: "unauthorized",
      retryable: false,
    });
    expect(isRetryableError(error)).toBe(false);
    expect(isNonRetryableError(error)).toBe(true);
  });

  test("preserves permanent subclasses and their domain metadata", () => {
    const error = new UnsupportedFileTypeError("fixture/type", "fixture.bin");

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.name).toBe("UnsupportedFileTypeError");
    expect(error.mimetype).toBe("fixture/type");
    expect(error.fileName).toBe("fixture.bin");
    expect(classifyError(error)).toEqual({
      category: "unsupported_file_type",
      retryable: false,
    });
  });

  test.each([
    {
      label: "native BullMQ instance",
      error: new UnrecoverableError("network"),
    },
    {
      label: "BullMQ named error contract",
      error: Object.assign(new Error("network"), {
        name: "UnrecoverableError",
      }),
    },
  ])("recognizes $label", ({ error }) => {
    expect(isNonRetryableError(error)).toBe(true);
    expect(classifyError(error)).toEqual({
      category: "non_retryable",
      retryable: false,
    });
  });

  test.each([
    { message: "ECONNRESET fixture", category: "network" },
    { message: "429 rate limit fixture", category: "rate_limit" },
    { message: "503 service unavailable fixture", category: "retryable" },
    { message: "unknown fixture failure", category: "retryable" },
  ])("preserves retryability of $category", ({ message, category }) => {
    const error = new Error(message);
    expect(isNonRetryableError(error)).toBe(false);
    expect(classifyError(error)).toMatchObject({ category, retryable: true });
  });
});
