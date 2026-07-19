import { createOsCatalog } from "./catalog.js";
import { RASPBERRY_PI_OS_LITE_TRIXIE_ARM64 } from "./raspberry-pi-os.js";

export { createOsCatalog, type ImmutableOsLock, type OsCatalog } from "./catalog.js";
export {
  OsCatalogResolutionError,
  OsCatalogValidationError,
  type OsCatalogResolutionErrorCode,
} from "./errors.js";
export {
  osCatalogEntrySchema,
  osCatalogSchema,
  type OsCatalogEntry,
} from "./schema.js";
export { type OsCatalogSelection } from "./selection.js";
export const osCatalog = createOsCatalog([RASPBERRY_PI_OS_LITE_TRIXIE_ARM64]);
