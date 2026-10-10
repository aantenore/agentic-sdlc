import fs from "node:fs";
import path from "node:path";

export const EVIDENCE_GITATTRIBUTES_RULE = "**/evidence/** -text";

/**
 * Evidence files are hash-bound byte for byte, so a checkout or rebase that
 * converts line endings looks like drift. Declare evidence files as not
 * text-converted in the project's .gitattributes (idempotent, additive).
 * Returns true when the file was changed.
 */
export function ensureEvidenceGitattributes(context) {
  const target = path.join(context.root, ".gitattributes");
  let current = "";
  try {
    current = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  if (current.split(/\r?\n/u).some((line) => line.trim() === EVIDENCE_GITATTRIBUTES_RULE)) return false;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  try {
    fs.writeFileSync(target, `${current}${separator}${EVIDENCE_GITATTRIBUTES_RULE}\n`);
  } catch {
    return false;
  }
  return true;
}
