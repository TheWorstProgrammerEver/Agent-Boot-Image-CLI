export {
  ASSEMBLY_PATHS,
  manifestSchema,
  type AccountBootstrapDescriptor,
  type AssemblyManifest,
  type AssetDescriptor,
  type BootstrapDescriptor,
  type NetworkBootstrapDescriptor,
  type PromptDescriptor,
  type RunnerInstallationDescriptor,
  type WifiBootstrapDescriptor,
} from "./manifest.js";
export { assemblyDocumentsSchema, type AssemblyDocuments } from "./assembly.js";
export { osLockSchema, type OsLock, type PartitionDescriptor } from "./os-lock.js";
export {
  runnerPlanSchema,
  type ProviderDescriptor,
  type RunnerPlan,
} from "./runner-plan.js";
export {
  type AutomaticStep,
  type EnvironmentStep,
  type FireAndForgetStep,
  type InstallUserSecretStep,
  type ManualStep,
  type PromptStep,
  type PromptVariableBinding,
  type PromptVariableSource,
  type ProviderStep,
  type RunnerStep,
} from "./steps.js";
export {
  SCHEMA_VERSION,
  type CommandDescriptor,
  type SchemaVersion,
  type SecretReference,
  type TargetLocation,
} from "./common.js";
export {
  ProtocolValidationError,
  type RuntimeSchema,
} from "./schema.js";
export {
  assertCompatibleSchemaVersion,
  SchemaCompatibilityError,
} from "./version.js";
