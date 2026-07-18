import { readFileSync } from "node:fs";
import { URL } from "node:url";

const fixtureRoot = new URL("../packages/protocol/fixtures/assembly/", import.meta.url);

export const readFixture = (name) =>
  JSON.parse(readFileSync(new URL(name, fixtureRoot), "utf8"));

export const validAssemblyDocuments = () => ({
  manifest: readFixture("manifest.json"),
  runnerPlan: readFixture("runner-plan.json"),
  osLock: readFixture("os-lock.json"),
});

export const clone = (value) => JSON.parse(JSON.stringify(value));

export { fixtureRoot };
