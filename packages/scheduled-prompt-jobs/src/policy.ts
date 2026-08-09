import type { PromptJobEffectPolicy } from "./model.js";

const readOnlyPolicy = [
  "Agent Boot scheduled-job safety policy:",
  "This is a report-only job. Do not create, change, push, publish, send, or delete external state.",
  "If the requested work would require an external effect, report that requirement and stop.",
].join("\n");

const reconciliationPolicy = [
  "Agent Boot scheduled-job safety policy:",
  "Before any external write, reconcile every incomplete earlier attempt and search the complete",
  "authoritative destination for an existing equivalent effect. If reconciliation or duplicate",
  "evidence is incomplete or ambiguous, stop without writing. Never clear or retry a pending effect",
  "merely because the earlier response was lost; preserve its identity until authoritatively resolved.",
].join("\n");

export const promptWithExecutionPolicy = (
  policy: PromptJobEffectPolicy,
  prompt: Uint8Array,
): Uint8Array => {
  const envelope = policy === "read-only" ? readOnlyPolicy : reconciliationPolicy;
  const prefix = new TextEncoder().encode(`${envelope}\n\n---\n\n`);
  const combined = new Uint8Array(prefix.byteLength + prompt.byteLength);
  combined.set(prefix);
  combined.set(prompt, prefix.byteLength);
  return combined;
};
