export type UserSecretInstallErrorCode =
  | "cleanup-failed"
  | "install-failed"
  | "invalid-configuration"
  | "missing-source"
  | "unsafe-destination"
  | "unsafe-source"
  | "verification-failed";

export class UserSecretInstallError extends Error {
  readonly code: UserSecretInstallErrorCode;

  constructor(code: UserSecretInstallErrorCode, options: ErrorOptions = {}) {
    super(`User secret installation stopped (${code}).`, options);
    this.name = "UserSecretInstallError";
    this.code = code;
  }
}
