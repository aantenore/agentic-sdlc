// Simulates Windows file-system contention on a story record: until this
// process holds the story mutation lock, any access to the record fails the
// way Windows reports a file that another process is replacing.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const contestedPath = process.env.AGENTIC_SDLC_TEST_STORY_RECORD_CONTENTION
  ? path.resolve(process.env.AGENTIC_SDLC_TEST_STORY_RECORD_CONTENTION)
  : null;

if (contestedPath) {
  const storyLockPattern = /[\\/]\.story-[^\\/]+\.lock$/u;
  let holdsStoryLock = false;

  const targets = (value) => {
    if (holdsStoryLock) return false;
    if (typeof value !== "string" && !Buffer.isBuffer(value)) return false;
    return path.resolve(String(value)) === contestedPath;
  };
  const contention = (syscall) => {
    const error = new Error(`${syscall} contended by a concurrent replacement`);
    error.code = "EPERM";
    error.errno = -4048;
    error.syscall = syscall;
    return error;
  };

  for (const [name, syscall] of [
    ["lstatSync", "lstat"],
    ["statSync", "stat"],
    ["readFileSync", "open"],
  ]) {
    const original = fs[name];
    fs[name] = function contendedStoryRecordAccess(filePath, ...args) {
      if (targets(filePath)) throw contention(syscall);
      return original.call(this, filePath, ...args);
    };
  }
  const originalOpenSync = fs.openSync;
  fs.openSync = function contendedStoryRecordOpen(filePath, flags, ...args) {
    if (targets(filePath)) throw contention("open");
    const descriptor = originalOpenSync.call(this, filePath, flags, ...args);
    if (flags === "wx" && storyLockPattern.test(String(filePath))) holdsStoryLock = true;
    return descriptor;
  };
  syncBuiltinESMExports();
}
