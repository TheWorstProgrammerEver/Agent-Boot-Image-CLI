import { Buffer } from "node:buffer";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const audit = { active: true, deviceAccessAttempts: [] };
globalThis.__agentBootNonDestructiveAudit = audit;

const pathText = value => {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
  return undefined;
};

const guard = (operation, value) => {
  if (Array.isArray(value)) {
    for (const item of value) guard(operation, item);
    return;
  }
  const path = pathText(value);
  if (path === undefined) return;
  const absolutePath = resolve(path);
  if (absolutePath !== "/dev" && !absolutePath.startsWith("/dev/")) return;
  audit.deviceAccessAttempts.push(operation);
  throw new Error("Non-destructive integration blocked device filesystem access.");
};

const wrapPathMethod = (owner, name, pathIndexes = [0]) => {
  if (typeof owner[name] !== "function") return;
  const original = owner[name].bind(owner);
  owner[name] = (...arguments_) => {
    for (const index of pathIndexes) guard(name, arguments_[index]);
    return original(...arguments_);
  };
};

const wrapPathConstructor = (owner, name) => {
  const Original = owner[name];
  if (typeof Original !== "function") return;
  owner[name] = new Proxy(Original, {
    apply(target, thisArgument, arguments_) {
      guard(name, arguments_[0]);
      return Reflect.apply(target, thisArgument, arguments_);
    },
    construct(target, arguments_, newTarget) {
      guard(name, arguments_[0]);
      return Reflect.construct(target, arguments_, newTarget);
    },
  });
};

const realpathNative = fs.realpath.native?.bind(fs.realpath);

for (const name of [
  "access",
  "accessSync",
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "createReadStream",
  "createWriteStream",
  "exists",
  "existsSync",
  "glob",
  "globSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "lstat",
  "lstatSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempDisposableSync",
  "mkdtempSync",
  "open",
  "openAsBlob",
  "openSync",
  "opendir",
  "opendirSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "stat",
  "statfs",
  "statfsSync",
  "statSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "unwatchFile",
  "utimes",
  "utimesSync",
  "watch",
  "watchFile",
  "writeFile",
  "writeFileSync",
]) wrapPathMethod(fs, name);
if (realpathNative !== undefined) {
  fs.realpath.native = (path, ...arguments_) => {
    guard("realpath.native", path);
    return realpathNative(path, ...arguments_);
  };
}

for (const name of ["copyFile", "cp", "link", "rename", "symlink"]) {
  wrapPathMethod(fs, name, [0, 1]);
  wrapPathMethod(fs, `${name}Sync`, [0, 1]);
}
for (const name of ["FileReadStream", "FileWriteStream", "ReadStream", "WriteStream"]) {
  wrapPathConstructor(fs, name);
}

for (const name of [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "glob",
  "lchmod",
  "lchown",
  "lstat",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "mkdtempDisposable",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "truncate",
  "unlink",
  "utimes",
  "watch",
  "writeFile",
]) {
  wrapPathMethod(fs.promises, name);
}
for (const name of ["copyFile", "cp", "link", "rename", "symlink"]) {
  wrapPathMethod(fs.promises, name, [0, 1]);
}
syncBuiltinESMExports();

process.once("beforeExit", () => {
  if (audit.deviceAccessAttempts.length > 0) process.exitCode = 1;
});
