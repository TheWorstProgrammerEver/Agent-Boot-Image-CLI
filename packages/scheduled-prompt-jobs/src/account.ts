import { readFile } from "node:fs/promises";

import { PromptJobOperationError } from "./errors.js";
import type { PromptJobAccount } from "./units.js";

const accountPattern = /^[a-z_][a-z0-9_-]{0,31}$/u;

const parseAccountFile = (
  contents: string,
  username: string,
  groups: string,
): PromptJobAccount => {
  if (!accountPattern.test(username)) throw new PromptJobOperationError("Invalid account name.");
  const matches = contents.split("\n").filter(line => line.split(":")[0] === username);
  if (matches.length !== 1) throw new PromptJobOperationError("Target account is unavailable.");
  const fields = matches[0]?.split(":") ?? [];
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const homeDirectory = fields[5] ?? "";
  const groupMatches = groups.split("\n").filter(line => Number(line.split(":")[2]) === gid);
  const group = groupMatches.length === 1 ? groupMatches[0]?.split(":")[0] ?? "" : "";
  if (
    !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0 ||
    !accountPattern.test(group) || !homeDirectory.startsWith("/")
  ) throw new PromptJobOperationError("Target account metadata is invalid.");
  return { gid, group, homeDirectory, uid, username };
};

export const resolvePromptJobAccount = async (
  username: string,
  options: { groupPath?: string; passwdPath?: string } = {},
): Promise<PromptJobAccount> => {
  const [passwd, groups] = await Promise.all([
    readFile(options.passwdPath ?? "/etc/passwd", "utf8"),
    readFile(options.groupPath ?? "/etc/group", "utf8"),
  ]);
  return parseAccountFile(passwd, username, groups);
};
