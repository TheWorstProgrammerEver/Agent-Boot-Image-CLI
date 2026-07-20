import type { AgentDefinition } from "@agent-boot/definition";
import { osCatalog } from "@agent-boot/os-adapters/catalog";
import { osLockSchema, type OsLock } from "@agent-boot/protocol";

export const resolveDefinitionOsLock = (definition: AgentDefinition): OsLock =>
  osLockSchema.parse(osCatalog.resolve({
    architecture: definition.operatingSystem.compatibility.architecture,
    boards: definition.operatingSystem.compatibility.boards,
    catalogId: definition.operatingSystem.catalogId,
  }));
