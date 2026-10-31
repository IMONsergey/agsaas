export interface RedisProbeClient {
  connect(): Promise<unknown>;
  send(command: string, args: string[]): Promise<unknown>;
  close(): void;
}

/** Release a probe's short-lived connection on both success and failure. */
export async function pingRedisClient(client: RedisProbeClient): Promise<true> {
  let failed = false;
  let failure: unknown;
  try {
    await client.connect();
    await client.send("PING", []);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      client.close();
    } catch (closeError) {
      // Cleanup must not hide the original connection/command failure.
      if (!failed) {
        failed = true;
        failure = closeError;
      }
    }
  }
  if (failed) throw failure;
  return true;
}
