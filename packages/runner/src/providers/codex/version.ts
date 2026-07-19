const versionIdentifier = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*|0|[1-9]\\d*)";
const exactVersionPattern = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${versionIdentifier}(?:\\.${versionIdentifier})*)?$`,
  "u",
);

export const isExactCodexVersion = (value: string): boolean =>
  exactVersionPattern.test(value);

export const matchesCodexVersionOutput = (output: string, version: string): boolean => {
  const normalized = output.trim();
  return normalized === `codex-cli ${version}` || normalized === `codex ${version}`;
};
