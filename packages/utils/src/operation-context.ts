import { AsyncLocalStorage } from "node:async_hooks";

const operationSignals = new AsyncLocalStorage<AbortSignal>();
/** Server-only context: transports inherit the deadline of the operation that starts them. */
export function getOperationSignal() {
  return operationSignals.getStore();
}
export function withOperationSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
) {
  return operationSignals.run(signal, operation);
}
