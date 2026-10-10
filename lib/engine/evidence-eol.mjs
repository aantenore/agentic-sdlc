import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const EVIDENCE_GITATTRIBUTES_RULE = "**/evidence/** -text";

function localAttributesPath(root) {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "info/attributes"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim();
    return out ? path.resolve(root, out) : null;
  } catch {
    return null;
  }
}

/**
 * Evidence files are hash-bound byte for byte, so a checkout or rebase that
 * converts line endings looks like drift. Declare evidence files as not
 * text-converted in the repository-local, untracked .git/info/attributes, so
 * no tracked project file is modified (and no story scope is affected).
 * Idempotent, additive. Returns true when the file was changed.
 */
export function ensureEvidenceGitattributes(context) {
  const target = localAttributesPath(context.root);
  if (!target) return false;
  let current = "";
  try {
    current = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  if (current.split(/\r?\n/u).some((line) => line.trim() === EVIDENCE_GITATTRIBUTES_RULE)) return false;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${current}${separator}${EVIDENCE_GITATTRIBUTES_RULE}\n`);
  } catch {
    return false;
  }
  return true;
}
