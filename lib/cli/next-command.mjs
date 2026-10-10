import path from "node:path";

import { console, process } from "../runtime/host.mjs";
import { decideKeepGoing, keepGoingWork } from "../host-hooks/keep-going.mjs";

/** Read-only: the next step while this computer has work, with the same decision as the end-of-turn hook. */
export async function nextCommand(options) {
  const root = path.resolve(String(options.root || process.cwd()));
  const work = await keepGoingWork(root);
  const decision = decideKeepGoing(work);
  const result = { work_pending: decision.block, next: decision.reason, human_decision: decision.note, ...work };
  if (options.json === true) console.log(JSON.stringify(result, null, 2));
  else if (decision.block) console.log(decision.reason);
  else console.log(decision.note ? `Nessun lavoro per l'agente. ${decision.note}` : "Nessun lavoro in sospeso: il turno puo' chiudersi.");
  return result;
}
