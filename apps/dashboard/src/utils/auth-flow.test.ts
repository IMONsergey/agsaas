import { describe, expect, mock, test } from "bun:test";
import {
  getAuthCallbackErrorMessage,
  getAuthOperationSession,
  runAuthRequest,
} from "./auth-flow";

describe("Auth operation session", () => {
  const session = {
    user: { id: "fixture-user", created_at: "2030-01-01T00:00:00Z" },
  };

  test.each([
    "OTP",
    "PKCE",
  ])("accepts a fresh session from a successful %s response", async () => {
    const authenticate = mock(async () => ({ data: { session }, error: null }));
    expect(await getAuthOperationSession(authenticate)).toBe(session);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  test("a returned verification error cannot be rescued by an existing session", async () => {
    const authenticate = mock(async () => ({
      data: { session },
      error: new Error("expired OTP or PKCE code"),
    }));
    expect(await getAuthOperationSession(authenticate)).toBeNull();
  });

  test.each([
    { session: null },
    null,
  ])("requires a session even when the SDK returned no error (%j)", async (data) => {
    expect(
      await getAuthOperationSession(async () => ({ data, error: null })),
    ).toBeNull();
  });

  test("a rejected Auth transport request fails closed", async () => {
    expect(
      await getAuthOperationSession(async () => {
        throw new Error("fixture transport failure");
      }),
    ).toBeNull();
  });
});

describe("OTP request state cleanup", () => {
  test("only a successful send shows the code form and clears loading", async () => {
    const pending: boolean[] = [];
    const onSuccess = mock(() => {});
    const onError = mock((_error: unknown) => {});
    await runAuthRequest({
      request: async () => ({ error: null }),
      setPending: (value) => pending.push(value),
      onSuccess,
      onError,
    });
    expect(pending).toEqual([true, false]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test.each([
    "SMTP failure",
    "rate limited",
    "rejected OTP",
  ])("reported %s shows one error, does not advance and clears loading", async (message) => {
    const pending: boolean[] = [];
    const error = new Error(message);
    const onSuccess = mock(() => {});
    const onError = mock((_error: unknown) => {});
    await runAuthRequest({
      request: async () => ({ error }),
      setPending: (value) => pending.push(value),
      onSuccess,
      onError,
    });
    expect(pending).toEqual([true, false]);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });

  test("thrown verification/network errors also release the loading state", async () => {
    const pending: boolean[] = [];
    const error = new Error("fixture network failure");
    const onError = mock((_error: unknown) => {});
    await runAuthRequest({
      request: async () => {
        throw error;
      },
      setPending: (value) => pending.push(value),
      onError,
    });
    expect(pending).toEqual([true, false]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });

  test("keeps loading active until the request settles", async () => {
    const pending: boolean[] = [];
    let resolve!: (value: { error: null }) => void;
    const request = new Promise<{ error: null }>((done) => {
      resolve = done;
    });
    const result = runAuthRequest({
      request: () => request,
      setPending: (value) => pending.push(value),
      onError: () => {},
    });
    expect(pending).toEqual([true]);
    resolve({ error: null });
    await result;
    expect(pending).toEqual([true, false]);
  });

  test("still releases loading if the notification callback throws", async () => {
    const pending: boolean[] = [];
    const onError = mock(() => {
      throw new Error("fixture toast failure");
    });
    await expect(
      runAuthRequest({
        request: async () => ({ error: new Error("fixture SMTP failure") }),
        setPending: (value) => pending.push(value),
        onError,
      }),
    ).rejects.toThrow("fixture toast failure");
    expect(pending).toEqual([true, false]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("callback error notification", () => {
  test("uses a fixed message for the known callback failure marker", () => {
    expect(getAuthCallbackErrorMessage("auth_callback")).toBe(
      "The sign-in link is invalid or has expired. Please try signing in again.",
    );
  });

  test.each([
    null,
    "",
    "access_denied",
    "<script>private provider error</script>",
  ])("ignores untrusted/unknown URL value %j", (value) => {
    expect(getAuthCallbackErrorMessage(value)).toBeNull();
  });
});
