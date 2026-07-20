import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const audit = { active: true, deviceAccessAttempts: [] };
globalThis.__agentBootNonDestructiveAudit = audit;

const pathText = value => {
  if (typeof value === "string") return value;
  if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
  return undefined;
};

const guard = value => {
  const path = pathText(value);
  if (path !== "/dev" && !path?.startsWith("/dev/")) return;
  audit.deviceAccessAttempts.push("blocked");
  throw new Error("Non-destructive integration blocked device filesystem access.");
};

const wrapPathMethod = (owner, name) => {
  const original = owner[name].bind(owner);
  owner[name] = (path, ...arguments_) => {
    guard(path);
    return original(path, ...arguments_);
  };
};

for (const name of [
  "createReadStream",
  "createWriteStream",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
]) wrapPathMethod(fs, name);

for (const name of ["open", "readFile", "writeFile"]) {
  wrapPathMethod(fs.promises, name);
}
syncBuiltinESMExports();

process.once("beforeExit", () => {
  if (audit.deviceAccessAttempts.length > 0) process.exitCode = 1;
});
