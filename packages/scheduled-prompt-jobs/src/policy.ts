const readOnlyPolicy = [
  "Agent Boot scheduled-job safety policy:",
  "This is a report-only job. Do not create, change, push, publish, send, or delete external state.",
  "If the requested work would require an external effect, report that requirement and stop.",
].join("\n");

export const promptWithExecutionPolicy = (
  prompt: Uint8Array,
): Uint8Array => {
  const prefix = new TextEncoder().encode(`${readOnlyPolicy}\n\n---\n\n`);
  const combined = new Uint8Array(prefix.byteLength + prompt.byteLength);
  combined.set(prefix);
  combined.set(prompt, prefix.byteLength);
  return combined;
};
