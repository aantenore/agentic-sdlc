import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  getOptionString,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  VERSION,
} from "./definitions.mjs";
import {
  buildAttribution,
  buildContext,
  now,
} from "./common.mjs";
import {
  bootstrapNewProject,
  initHumanLines,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  runGit,
} from "./shared-refs.mjs";
import {
  appendTraceEvent,
} from "./story.mjs";
import {
  dispatchWithMutationGovernance,
  ensureDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  Date,
  crypto,
  fs,
} from "../runtime/host.mjs";

/**
 * Archive and restart a project that was never published.
 *
 * `.sdlc` holds permanent approvals and consumption records, so nothing may
 * delete it. When a project that was never shared must start over, this
 * command MOVES the whole tree to `.sdlc-archive/<id>/sdlc` (never copies and
 * deletes), writes a manifest with who, when, why and the hash of the moved
 * tree, and can then initialize a fresh `.sdlc` that keeps a trace of the
 * archive. It refuses when anything shows the records were published or
 * shared, because moving them would hide state other copies still rely on.
 */

export const ARCHIVE_DIR_NAME = ".sdlc-archive";
const SDLC_DIR = ".sdlc";
const MANIFEST_NAME = "archive-manifest.json";
const MANIFEST_SCHEMA = "project-archive-manifest:v1";
const TREE_HASH_ALGORITHM = "sha256:tree:v1";
const GIT_TIMEOUT_SECONDS = 20;
const SHARED_REF_PREFIXES = [
  "refs/agentic-sdlc/",
  "refs/agentic-sdlc-shared/",
  "refs/agentic-sdlc-local/",
  "refs/worktree/agentic-sdlc",
];
const PUBLISHING_TRACE_EVENTS = new Set(["push", "pr", "merge"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Deterministic hash of a tree: relative paths, entry kinds, file contents, and symlink targets. */
export function hashTree(treeRoot) {
  const lines = [];
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (directory, relative) => {
    const names = fs.readdirSync(directory).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      const full = path.join(directory, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        lines.push(`l\0${rel}\0${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        lines.push(`d\0${rel}\0`);
        visit(full, rel);
      } else if (stat.isFile()) {
        const bytes = fs.readFileSync(full);
        fileCount += 1;
        totalBytes += bytes.length;
        lines.push(`f\0${rel}\0${sha256(bytes)}`);
      } else {
        lines.push(`o\0${rel}\0`);
      }
    }
  };
  visit(treeRoot, "");
  return { tree_hash: sha256(lines.join("\n")), file_count: fileCount, total_bytes: totalBytes };
}

function gitOutput(root, args) {
  return runGit(root, args, { timeoutSeconds: GIT_TIMEOUT_SECONDS });
}

function listDirectory(directory) {
  try {
    return fs.readdirSync(directory).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

function publishingTraceEvents(sdlcRoot) {
  const tracesRoot = path.join(sdlcRoot, "traces");
  const found = [];
  for (const name of listDirectory(tracesRoot).filter((entry) => entry.endsWith(".jsonl"))) {
    let content;
    try {
      content = fs.readFileSync(path.join(tracesRoot, name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const gitEvent = String(event?.git?.event || "").toLowerCase();
      if (PUBLISHING_TRACE_EVENTS.has(gitEvent)) found.push(`${name}: ${event.id || "event"} (${gitEvent})`);
    }
  }
  return found;
}

/**
 * Whether anything shows the project's records were published or shared.
 * Conservative: every check that cannot be completed counts against archiving.
 */
export function inspectPublication(context) {
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, detail });

  const executions = listDirectory(path.join(context.sdlcRoot, "autonomy", "executions"));
  if (executions.length > 0) {
    add("delivery_records", `Delivery execution records exist (${executions.slice(0, 5).join(", ")}${executions.length > 5 ? ", ..." : ""}); a delivery was started, delivered, or merged.`);
  }
  const usage = listDirectory(path.join(context.sdlcRoot, "autonomy", "metering"));
  if (usage.length > 0) {
    add("consumption_records", "Delivery usage or standing-approval consumption records exist; they are append-only and must stay with their history.");
  }
  const traced = publishingTraceEvents(context.sdlcRoot);
  if (traced.length > 0) {
    add("publishing_trace_events", `The trace records pushes, pull requests, or merges (${traced.slice(0, 3).join("; ")}).`);
  }

  const inRepository = gitOutput(context.root, ["rev-parse", "--is-inside-work-tree"]);
  if (inRepository.ok && inRepository.stdout.trim() === "true") {
    const refs = gitOutput(context.root, ["for-each-ref", "--format=%(refname)", "refs/agentic-sdlc", "refs/agentic-sdlc-shared", "refs/agentic-sdlc-local", "refs/worktree"]);
    if (!refs.ok) {
      add("git_unverifiable", "The git references that hold shared project state could not be read, so it cannot be confirmed that nothing was shared.");
    } else {
      const shared = refs.stdout.split(/\r?\n/u).filter((ref) => SHARED_REF_PREFIXES.some((prefix) => ref.startsWith(prefix)));
      if (shared.length > 0) {
        add("shared_refs", `Shared project state exists in git references (${shared.slice(0, 3).join(", ")}${shared.length > 3 ? ", ..." : ""}).`);
      }
    }
    const published = gitOutput(context.root, ["rev-list", "--remotes", "-n", "1", "--", SDLC_DIR]);
    if (!published.ok) {
      add("git_unverifiable", "The remote-tracking history could not be read, so it cannot be confirmed that .sdlc was never pushed.");
    } else if (published.stdout.trim()) {
      add("committed_on_remote", `.sdlc was committed in history that a remote-tracking branch already contains (${published.stdout.trim().slice(0, 12)}).`);
    }
    const remotes = gitOutput(context.root, ["remote"]);
    const remoteNames = remotes.ok ? remotes.stdout.split(/\r?\n/u).map((name) => name.trim()).filter(Boolean) : [];
    if (!remotes.ok) {
      add("git_unverifiable", "The configured git remotes could not be listed.");
    }
    for (const remote of remoteNames) {
      const listing = gitOutput(context.root, ["ls-remote", "--refs", remote, "refs/agentic-sdlc/*"]);
      if (!listing.ok) {
        add("remote_unverifiable", `Remote '${remote}' could not be reached to confirm it holds no shared project state; try again when it is reachable.`);
      } else if (listing.stdout.trim()) {
        add("remote_shared_refs", `Remote '${remote}' already holds shared project state under refs/agentic-sdlc/.`);
      }
    }
  }
  return { published: reasons.length > 0, reasons };
}

function archiveStamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function archiveRoot(context) {
  return path.join(context.root, ARCHIVE_DIR_NAME);
}

function assertSdlcDirectory(context) {
  let stat;
  try {
    stat = fs.lstatSync(context.sdlcRoot);
  } catch {
    fail(`There is no ${SDLC_DIR} folder in ${context.root}, so there is nothing to archive. Run 'agentic-sdlc init' instead.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${SDLC_DIR} must be a real folder to be archived, not a link or a file; no files were changed.`);
  }
  if (fs.existsSync(path.join(context.root, ".sdlc-identity-migration.lock"))) {
    fail("An identity migration is active or interrupted; finish its recovery before archiving. No files were changed.");
  }
}

function buildPlan(context) {
  assertSdlcDirectory(context);
  const publication = inspectPublication(context);
  const tree = hashTree(context.sdlcRoot);
  const plan = {
    kind: "project_archive_plan",
    root: context.root,
    publication: { published: publication.published, reasons: publication.reasons },
    tree_hash: tree.tree_hash,
    hash_algorithm: TREE_HASH_ALGORITHM,
    file_count: tree.file_count,
    total_bytes: tree.total_bytes,
  };
  return { ...plan, plan_hash: computeStableHash({ root: plan.root, tree_hash: plan.tree_hash, published: plan.publication.published }) };
}

function readProjectIdentity(context) {
  try {
    const project = JSON.parse(fs.readFileSync(path.join(context.sdlcRoot, "project.json"), "utf8"));
    return { id: project.project_id ?? null, name: project.project_name ?? null };
  } catch {
    return { id: null, name: null };
  }
}

function refuseNotAllowedInAgent(italian) {
  const command = "agentic-sdlc project archive --apply --plan-hash <hash> --reason \"<why>\" "
    + "--actor-type human --approval-source explicit-user --summary \"<your words>\"";
  fail(
    "Archiving a project's .sdlc is a person's decision and cannot run inside an agent session. "
    + `Show the user the plan ('agentic-sdlc project archive') and ask them to run '${command}' in their own terminal.`,
    {
      en: {
        result: "The project was not archived.",
        impact: "An agent cannot move the project's permanent approvals and history out of place.",
        required_decision: "The person who owns the project decides to archive it, from their own terminal.",
        protection_boundary: "Nothing was moved; .sdlc is unchanged.",
        next_action: `Run '${command}' outside the agent session.`,
      },
      it: {
        result: "Il progetto non è stato archiviato.",
        impact: "Un agente non può spostare le approvazioni permanenti e la cronologia del progetto.",
        required_decision: "La persona che possiede il progetto decide di archiviarlo, dal proprio terminale.",
        protection_boundary: "Nulla è stato spostato; .sdlc è invariato.",
        next_action: `Esegui '${command}' fuori dalla sessione dell’agente.`,
      },
    },
  );
}

function refusePublished(plan) {
  const details = plan.publication.reasons.map((reason) => `- ${reason.detail}`).join("\n");
  fail(
    `This project's .sdlc may have been published or shared, so it cannot be archived and restarted:\n${details}\n`
    + "Archiving moves records other copies may still rely on (shared approvals, claims, deliveries, merged work). Nothing was moved.",
    {
      en: {
        result: "The project was not archived.",
        impact: "Moving published or shared records would hide state that other copies and remotes still use.",
        required_decision: "Keep this project's history and continue with the governed commands, or resolve the reasons listed above first.",
        protection_boundary: "Nothing was moved or deleted; .sdlc is unchanged.",
        next_action: "Continue with the governed commands, or ask for a reviewed migration of the project instead of a restart.",
      },
      it: {
        result: "Il progetto non è stato archiviato.",
        impact: "Spostare record pubblicati o condivisi nasconderebbe uno stato che altre copie e remoti usano ancora.",
        required_decision: "Mantieni la cronologia del progetto e continua con i comandi governati, oppure risolvi prima i motivi elencati sopra.",
        protection_boundary: "Nulla è stato spostato o eliminato; .sdlc è invariato.",
        next_action: "Continua con i comandi governati, oppure chiedi una migrazione rivista del progetto invece di un riavvio.",
      },
    },
  );
}

function planLines(plan, italian) {
  const reinit = "--reinit";
  const apply = `agentic-sdlc project archive --apply --plan-hash ${plan.plan_hash} --reason "<why>" `
    + `--actor-type human --approval-source explicit-user --summary "<your words>" [${reinit}]`;
  return italian
    ? [
        "Il progetto non risulta mai pubblicato o condiviso: .sdlc può essere archiviato (spostato, mai eliminato).",
        `Verrà spostato in ${ARCHIVE_DIR_NAME}/<id>/sdlc (${plan.file_count} file, ${plan.total_bytes} byte).`,
        "Nulla è stato modificato.",
        `Per procedere, l’utente esegue dal proprio terminale: ${apply}`,
        "",
        "Dettagli:",
        `- Hash dell’albero: ${plan.tree_hash}`,
        `- Piano: ${plan.plan_hash}`,
      ]
    : [
        "No sign that this project was ever published or shared: .sdlc can be archived (moved, never deleted).",
        `It will be moved to ${ARCHIVE_DIR_NAME}/<id>/sdlc (${plan.file_count} files, ${plan.total_bytes} bytes).`,
        "Nothing was changed.",
        `To proceed, the user runs in their own terminal: ${apply}`,
        "",
        "Details:",
        `- Tree hash: ${plan.tree_hash}`,
        `- Plan: ${plan.plan_hash}`,
      ];
}

/** `project archive`: show the plan, or with --apply move .sdlc aside and optionally re-initialize. */
export async function archiveProject(context, options) {
  const italian = humanGuidanceLocale(options) === "it";
  const apply = options.apply === true;
  if (apply && runsInsideAgentHost()) refuseNotAllowedInAgent(italian);

  const plan = buildPlan(context);
  if (plan.publication.published) refusePublished(plan);
  if (!apply) {
    output(options, { status: "plan", ...plan }, planLines(plan, italian));
    return;
  }

  const expectedHash = getOptionString(options, "plan-hash");
  if (!expectedHash) fail(`--plan-hash is required to apply; run 'agentic-sdlc project archive' first and pass its plan hash. Nothing was moved.`);
  if (expectedHash !== plan.plan_hash) {
    fail("The project changed since the plan was shown (plan hash mismatch). Nothing was moved; run 'agentic-sdlc project archive' again and review the new plan.");
  }
  const reason = getOptionString(options, "reason");
  if (!reason) fail("--reason must say why this project is archived. Nothing was moved.");
  const summary = getOptionString(options, "summary");
  if (!summary) fail("--summary must give, in the person's own words, the decision to archive this project. Nothing was moved.");
  const attribution = buildAttribution(context, options, "project.archive");
  requireFormalApprovalActor(context, options, attribution, "Archiving a project");
  const approvalSource = getOptionString(options, "approval-source");
  if (!["human", "ci"].includes(attribution.actor.type) || !["explicit-user", "ci"].includes(approvalSource)) {
    fail("Archiving a project needs --actor-type human or ci and --approval-source explicit-user or ci. Nothing was moved.");
  }

  const archivedAt = now();
  const archiveId = `ARCHIVE-${archiveStamp(new Date(archivedAt))}-${plan.tree_hash.slice(0, 8)}`;
  const archiveDirectory = path.join(archiveRoot(context), archiveId);
  const movedTo = path.join(archiveDirectory, "sdlc");
  if (fs.existsSync(archiveDirectory)) fail(`${toProjectPath(context, archiveDirectory)} already exists. Nothing was moved.`);
  const identity = readProjectIdentity(context);
  const manifestBase = {
    kind: "project_archive_manifest",
    schema_version: MANIFEST_SCHEMA,
    archive_id: archiveId,
    archived_at: archivedAt,
    archived_by: attribution.actor,
    approval: { source: approvalSource, summary },
    reason,
    project: identity,
    source_path: SDLC_DIR,
    archive_path: toProjectPath(context, movedTo),
    tree_hash: plan.tree_hash,
    hash_algorithm: TREE_HASH_ALGORITHM,
    file_count: plan.file_count,
    total_bytes: plan.total_bytes,
    publication_check: { published: false, checked_at: archivedAt },
    plugin_version: VERSION,
    git: attribution.git,
  };
  const manifest = { ...manifestBase, manifest_hash: computeStableHash(manifestBase) };

  // Written before the move: a crash leaves .sdlc in place and a manifest of an archive that did not happen.
  // The archive lives outside .sdlc, so plain file operations are used; the move is a rename, never a copy.
  fs.mkdirSync(archiveDirectory, { recursive: true });
  const archiveIgnore = path.join(archiveRoot(context), ".gitignore");
  if (!fs.existsSync(archiveIgnore)) {
    fs.writeFileSync(archiveIgnore, "# Archived project records stay on this computer.\n*\n", { flag: "wx" });
  }
  const manifestPath = path.join(archiveDirectory, MANIFEST_NAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  try {
    fs.renameSync(context.sdlcRoot, movedTo);
  } catch (error) {
    fail(`${SDLC_DIR} could not be moved to ${toProjectPath(context, movedTo)} (${error.message}). It is unchanged; nothing was copied or deleted.`);
  }
  const after = hashTree(movedTo);
  if (after.tree_hash !== plan.tree_hash) {
    fail(
      `The archived tree at ${toProjectPath(context, movedTo)} does not match the hash taken before the move `
      + `(${after.tree_hash} instead of ${plan.tree_hash}). Files changed while archiving; the archive was kept and nothing was deleted.`,
    );
  }

  const result = {
    status: "archived",
    archive_id: archiveId,
    archive_path: manifest.archive_path,
    manifest_path: toProjectPath(context, manifestPath),
    tree_hash: plan.tree_hash,
    file_count: plan.file_count,
    reinitialized: false,
    manifest,
  };
  const lines = italian
    ? [
        `Progetto archiviato: ${SDLC_DIR} è stato spostato (non eliminato) in ${manifest.archive_path}.`,
        `Manifest: ${result.manifest_path}`,
      ]
    : [
        `Project archived: ${SDLC_DIR} was moved (not deleted) to ${manifest.archive_path}.`,
        `Manifest: ${result.manifest_path}`,
      ];
  if (options.reinit === true) {
    const fresh = buildContext(options);
    const init = bootstrapNewProject(fresh, options);
    const recordPath = path.join(fresh.sdlcRoot, "decisions", `project-archive-${archiveId}.json`);
    // The new project's own governance policy now applies to the records written into it.
    const resolution = { canonical_action: "project.archive", canonical_path: ["project", "archive"] };
    const recorder = {
      dispatch: () => {
        ensureDir(path.dirname(recordPath));
        writeJsonFile(recordPath, manifest, { atomicCreate: true });
        return appendTraceEvent(fresh, null, {
          type: "decision",
          summary: `Archived the previous project records (${archiveId}) and started again: ${reason}`,
          action: "project.archive",
          actor: attribution.actor,
          outcome: "passed",
          evidence: [toProjectPath(fresh, recordPath)],
          related: [archiveId],
          git: attribution.git,
          run: attribution.run,
        });
      },
    };
    const event = await dispatchWithMutationGovernance(recorder, resolution, { context: fresh, options });
    result.reinitialized = true;
    result.record_path = toProjectPath(fresh, recordPath);
    result.event = event;
    result.init = init.payload;
    lines.push(
      italian
        ? `Nuovo ${SDLC_DIR} creato; la traccia dell’archivio è in ${result.record_path}.`
        : `A new ${SDLC_DIR} was created; the archive trace is kept in ${result.record_path}.`,
      ...initHumanLines(init, options),
    );
  } else {
    lines.push(
      italian
        ? "Per ricominciare esegui agentic-sdlc init; per mantenere la traccia dell’archivio usa --reinit al posto di init separato."
        : "To start again run agentic-sdlc init; use --reinit with this command instead to keep a trace of the archive in the new project.",
    );
  }
  output(options, result, lines);
}
