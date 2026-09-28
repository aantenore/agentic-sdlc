import path from "node:path";
import { fileURLToPath } from "node:url";

/** The installed plugin's root directory: two levels above lib/runtime. */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
