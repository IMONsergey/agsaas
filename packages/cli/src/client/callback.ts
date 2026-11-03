import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";

export interface OAuthCallback {
  port: number;
  code: Promise<string>;
  close: () => void;
}

/** The listener and redirect both use 127.0.0.1, avoiding localhost IPv4/IPv6 ambiguity. */
export async function startCallbackServer(
  expectedState: string,
  timeoutMs = 120000,
): Promise<OAuthCallback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (reason: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Registration/browser opening may fail before the caller starts awaiting the callback.
  // Attaching a handler prevents an unhandled rejection, without changing the returned promise.
  void code.catch(() => {});
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settleError = (error: Error) => {
    if (!settled) {
      settled = true;
      rejectCode(error);
    }
  };
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Use the browser authorization callback.");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400);
      response.end("Invalid callback.");
      return;
    }
    if (url.pathname !== "/callback") {
      response.writeHead(404);
      response.end();
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const stateBytes = Buffer.from(state);
    const expectedBytes = Buffer.from(expectedState);
    // Unrelated callbacks do not consume a legitimate pending login, including error callbacks.
    if (
      url.searchParams.getAll("state").length !== 1 ||
      stateBytes.length !== expectedBytes.length ||
      !timingSafeEqual(stateBytes, expectedBytes)
    ) {
      response.writeHead(400);
      response.end("Invalid authorization state.");
      return;
    }
    if (settled) {
      response.writeHead(409);
      response.end("Authorization callback already received.");
      return;
    }
    if (url.searchParams.has("error")) {
      response.writeHead(400);
      response.end("Authorization was declined. Return to the terminal.");
      settleError(new Error("OAuth authorization was declined"));
      return;
    }
    const authCode = url.searchParams.get("code");
    if (!authCode || url.searchParams.getAll("code").length !== 1) {
      response.writeHead(400);
      response.end("Missing authorization code.");
      return;
    }
    settled = true;
    if (timer) clearTimeout(timer);
    response.writeHead(200);
    response.end(
      "Authorization received. Return to the terminal to complete sign-in.",
    );
    resolveCode(authCode);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  const close = () => {
    if (timer) clearTimeout(timer);
    settleError(new Error("OAuth callback closed"));
    server.close();
    server.closeAllConnections();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Failed to bind OAuth callback");
    server.on("error", (error) => {
      settleError(error);
      close();
    });
    timer = setTimeout(() => {
      settleError(new Error("OAuth login timed out"));
      close();
    }, timeoutMs);
    timer.unref();
    return { port: address.port, code, close };
  } catch (error) {
    close();
    throw error;
  }
}
