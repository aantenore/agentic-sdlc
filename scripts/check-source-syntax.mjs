import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOTS = Object.freeze(["bin", "hooks", "lib", "scripts", "test", "ui"]);
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function discoverSourceFiles(root = PROJECT_ROOT) {
  return SOURCE_ROOTS
    .flatMap((directory) => walk(path.join(root, directory)))
    .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function checkSourceSyntax(root = PROJECT_ROOT) {
  const failures = [];
  const files = discoverSourceFiles(root);
  for (const filePath of files) {
    const result = childProcess.spawnSync(process.execPath, ["--check", filePath], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (result.status !== 0) {
      failures.push({
        file: path.relative(root, filePath).split(path.sep).join("/"),
        output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
      });
    }
  }
  return { files, failures };
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walk(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const result = checkSourceSyntax();
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.error(`${failure.file}\n${failure.output}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Syntax check passed for ${result.files.length} JavaScript source files.`);
  }
}
