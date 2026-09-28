// Child process that is killed while writing a new record: the first write
// to an open descriptor delivers SIGKILL to this process before any byte lands.
import { writeJsonFile } from "../../lib/engine/storage.mjs";
import { runWithMutationGovernance } from "../../lib/governance/mutation-guard.mjs";
import { currentHost, setHost } from "../../lib/runtime/host.mjs";

const [root, recordPath] = process.argv.slice(2);
const realFs = currentHost().fs;

setHost({
  fs: {
    ...realFs,
    writeFileSync(target, ...args) {
      if (typeof target === "number") process.kill(process.pid, "SIGKILL");
      return realFs.writeFileSync(target, ...args);
    },
  },
});

runWithMutationGovernance({ mode: "disabled", root }, () => {
  writeJsonFile(recordPath, { id: "REQ-CRASH-001" });
});
