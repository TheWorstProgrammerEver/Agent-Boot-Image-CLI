export type NetworkCommandErrorCode =
  | "apply-failed"
  | "invalid-command"
  | "invalid-passphrase"
  | "invalid-ssid"
  | "profile-write-failed"
  | "root-required"
  | "terminal-required";

export class NetworkCommandError extends Error {
  constructor(readonly code: NetworkCommandErrorCode) {
    super(`Agent Boot network command failed (${code}).`);
    this.name = "NetworkCommandError";
  }
}
