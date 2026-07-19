import type { ManualStepScheduler } from "../../engine/model.js";

const settleOnAbort = (
  delayMs: number,
  cancellation: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (cancellation.aborted) {
      resolve();
      return;
    }
    const settle = (): void => {
      clearTimeout(timeout);
      cancellation.removeEventListener("abort", settle);
      resolve();
    };
    cancellation.addEventListener("abort", settle, { once: true });
    const timeout = setTimeout(settle, delayMs);
    timeout.unref();
  });

export const systemManualStepScheduler: ManualStepScheduler = Object.freeze({
  sleep: settleOnAbort,
});
