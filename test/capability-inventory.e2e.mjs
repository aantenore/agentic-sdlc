import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const created = new Set();

function temporaryDirectory(label) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-inventory-${label}-`)));
  created.add(directory);
  return directory;
}

after(() => {
  for (const directory of created) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  created.clear();
});

// Every command runs against a throw-away home so the real installed tools of
// whoever runs the suite never change what is asserted.
function run(args, { cwd = repoRoot, home, env = {} } = {}) {
  const environment = { ...process.env };
  for (const key of [
    "CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE",
    "AGENTIC_SDLC_AGENT_HOST", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  ]) delete environment[key];
  if (home) {
    environment.HOME = home;
    environment.USERPROFILE = home;
  }
  Object.assign(environment, env);
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function skillFile(root, directory, name, description) {
  writeFile(root, `${directory}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

function listTree(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      entries.push(path.relative(root, full));
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return entries.sort();
}

const SENTINEL = ["sentinel", "server", "value"].join("_");

// A project and a home that hold a skill, a command, a plugin, and MCP
// servers for both supported host families, plus values that must not leak.
function installedLayout() {
  const project = temporaryDirectory("project");
  const home = temporaryDirectory("home");
  skillFile(project, ".claude/skills/react-review", "react-review", "Review React components and hooks.");
  skillFile(project, ".agents/skills/sql-helper", "sql-helper", "Write and review Postgres queries.");
  writeFile(project, ".claude/commands/ship.md", "---\ndescription: Ship the branch\n---\n");
  writeFile(project, ".mcp.json", JSON.stringify({
    mcpServers: {
      "repo-index": { command: "node", args: ["index.js", `--flag=${SENTINEL}`], env: { SERVICE_ENV: SENTINEL } },
      "docs-hosted": { type: "http", url: `https://example.invalid/${SENTINEL}`, headers: { Authorization: `Bearer ${SENTINEL}` } },
    },
  }));
  skillFile(home, ".claude/skills/go-services", "go-services", "Design Go services.");
  skillFile(home, ".codex/skills/terraform-ops", "terraform-ops", "Operate Terraform stacks.");
  writeFile(home, ".claude/plugins/cache/market/widgets/1.0.0/.claude-plugin/plugin.json", JSON.stringify({
    name: "widgets",
    version: "1.0.0",
    description: "Widget helpers.",
  }));
  skillFile(home, ".claude/plugins/cache/market/widgets/1.0.0/skills/widget-builder", "widget-builder", "Build widgets with Vue.");
  writeFile(home, ".codex/plugins/cache/market/gadgets/2.1.0/.codex-plugin/plugin.json", JSON.stringify({
    name: "gadgets",
    version: "2.1.0",
    description: "Gadget helpers.",
  }));
  skillFile(home, ".codex/plugins/cache/market/gadgets/2.1.0/skills/gadget-builder", "gadget-builder", "Build gadgets in Rust.");
  writeFile(home, ".codex/config.toml", [
    "[mcp_servers.toml-local]",
    "command = \"node\"",
    `args = ["server.js", "--flag=${SENTINEL}"]`,
    "[mcp_servers.toml-local.env]",
    `SERVICE_ENV = "${SENTINEL}"`,
    "",
  ].join("\n"));
  return { project, home };
}

test("capability inventory lists both host layouts without leaking values or touching the project", () => {
  const { project, home } = installedLayout();
  const before = listTree(project);
  const result = mustRun(["capability", "inventory", "--root", project, "--json"], { cwd: project, home });
  assert.deepEqual(listTree(project), before, "the command is read-only and does not create .sdlc");
  assert.equal(result.stdout.includes(SENTINEL), false);
  assert.equal(result.stdout.includes(project), false, "no absolute project path is printed");
  assert.equal(result.stdout.includes(home), false, "no absolute home path is printed");

  const inventory = JSON.parse(result.stdout);
  assert.equal(inventory.schema_version, "capability-inventory:v1");
  const skills = new Map(inventory.skills.map((entry) => [entry.name, entry]));
  assert.deepEqual([...skills.keys()].sort(), [
    "gadget-builder",
    "go-services",
    "react-review",
    "sql-helper",
    "terraform-ops",
    "widget-builder",
  ]);
  assert.equal(skills.get("react-review").path, ".claude/skills/react-review/SKILL.md");
  assert.equal(skills.get("sql-helper").path, ".agents/skills/sql-helper/SKILL.md");
  assert.equal(skills.get("go-services").path, "~/.claude/skills/go-services/SKILL.md");
  assert.equal(skills.get("terraform-ops").path, "~/.codex/skills/terraform-ops/SKILL.md");
  assert.equal(skills.get("widget-builder").plugin, "widgets");
  assert.equal(skills.get("gadget-builder").plugin, "gadgets");
  assert.equal(skills.get("react-review").description, "Review React components and hooks.");
  assert.deepEqual(inventory.plugins.map((plugin) => `${plugin.name}@${plugin.version}`).sort(), ["gadgets@2.1.0", "widgets@1.0.0"]);
  assert.deepEqual(inventory.commands.map((entry) => entry.name), ["ship"]);
  const servers = new Map(inventory.mcp.map((entry) => [entry.name, entry]));
  assert.deepEqual([...servers.keys()].sort(), ["docs-hosted", "repo-index", "toml-local"]);
  assert.equal(servers.get("repo-index").transport, "stdio");
  assert.equal(servers.get("docs-hosted").transport, "http");
  assert.equal(servers.get("toml-local").path, "~/.codex/config.toml");
  assert.equal(typeof inventory.correlation_id, "string");
});

test("capability inventory explains itself in plain English and Italian with details kept optional", () => {
  const { project, home } = installedLayout();
  for (const locale of ["en", "it"]) {
    const result = mustRun(["capability", "inventory", "--root", project, "--locale", locale], { cwd: project, home });
    const divider = locale === "it" ? "Dettagli tecnici (facoltativi):" : "Technical details (optional):";
    assert.ok(result.stdout.includes(divider), result.stdout);
    const [primary, details] = result.stdout.split(divider);
    const labels = locale === "it"
      ? ["Risultato:", "Cosa cambia in pratica:", "Cosa devi decidere:", "Cosa resta protetto:", "Prossimo passo:"]
      : ["Outcome:", "What this changes in practice:", "What you need to decide:", "What remains protected:", "Next step:"];
    for (const label of labels) assert.ok(primary.includes(label), `${locale} output lacks ${label}`);
    assert.doesNotMatch(primary, /\.sdlc\/|--[a-z]|agentic-sdlc\s+[a-z]|\b(?:profile|schema|hash|receipt)\b/iu);
    assert.match(details, /react-review/u);
    assert.match(details, /go-services/u);
    assert.match(details, /~\/\.codex\/config\.toml/u);
    assert.equal(result.stdout.includes(SENTINEL), false);
  }
});

test("capability inventory follows the configured locations and can be turned off", () => {
  const { project, home } = installedLayout();
  mustRun(["init", "--root", project, "--project-name", "Inventory", "--force"], { cwd: project, home });
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  skillFile(project, "team/tools/review-kit", "review-kit", "Shared review checklist.");
  config.capability_discovery_policy.inventory.sources = [
    { id: "team-tools", kind: "skills", scope: "project", path: "team/tools" },
    { id: "user-codex-skills", kind: "skills", scope: "user", path: "${CODEX_HOME:-~/.codex}/skills" },
  ];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const preview = JSON.parse(mustRun(["config", "migrate", "--root", project, "--json"], { cwd: project, home }).stdout);
  mustRun([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash,
    "--actor-type", "system", "--json",
  ], { cwd: project, home });

  const custom = JSON.parse(mustRun(["capability", "inventory", "--root", project, "--json"], { cwd: project, home }).stdout);
  assert.deepEqual(custom.skills.map((entry) => entry.name).sort(), ["review-kit", "terraform-ops"]);
  assert.deepEqual(custom.mcp, []);
  assert.deepEqual(custom.sources.map((entry) => entry.id), ["team-tools", "user-codex-skills"]);

  const relocated = temporaryDirectory("relocated-home");
  skillFile(relocated, "skills/relocated-skill", "relocated-skill", "Found through the host variable.");
  const moved = JSON.parse(mustRun(["capability", "inventory", "--root", project, "--json"], {
    cwd: project,
    home,
    env: { CODEX_HOME: relocated },
  }).stdout);
  assert.deepEqual(moved.skills.map((entry) => entry.name).sort(), ["relocated-skill", "review-kit"]);
  assert.equal(moved.skills.find((entry) => entry.name === "relocated-skill").path.startsWith("(external)/"), true);

  config.capability_discovery_policy.inventory.enabled = false;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const offPreview = JSON.parse(mustRun(["config", "migrate", "--root", project, "--json"], { cwd: project, home }).stdout);
  mustRun([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", offPreview.plan.plan_hash,
    "--actor-type", "system", "--json",
  ], { cwd: project, home });
  const off = JSON.parse(mustRun(["capability", "inventory", "--root", project, "--json"], { cwd: project, home }).stdout);
  assert.equal(off.enabled, false);
  assert.deepEqual(off.counts, { skills: 0, commands: 0, plugins: 0, mcp: 0 });
  const offText = mustRun(["capability", "inventory", "--root", project], { cwd: project, home }).stdout;
  assert.match(offText, /turned off in this project's settings/u);
});

test("capability inventory is a catalogued read-only command", () => {
  const model = JSON.parse(mustRun(["help", "capability", "inventory", "--json"]).stdout);
  assert.equal(model.command.path, "capability inventory");
  assert.match(model.human.protection, /Reads local records only/u);
  assert.ok(model.examples.every((example) => !/<[^>]+>/u.test(example)));
  assert.match(mustRun(["help", "capability"]).stdout, /capability inventory/u);
  assert.match(mustRun(["completion", "bash"]).stdout, /inventory/u);
});

// ---------------------------------------------------------------------------
// capability recommend --from-inventory

const HUMAN = ["--actor-type", "human", "--approval-source", "explicit-user"];

function initProject(project, home) {
  mustRun(["init", "--root", project, "--project-name", "Inventory", "--force"], { cwd: project, home });
}

function ensureRequirement(project, requirementId) {
  const requirementPath = path.join(project, ".sdlc", "requirements", `${requirementId}.json`);
  if (fs.existsSync(requirementPath)) return;
  const createdAt = new Date().toISOString();
  writeFile(project, `.sdlc/requirements/${requirementId}.json`, `${JSON.stringify({
    id: requirementId,
    kind: "requirement",
    schema_version: "requirement:v1",
    title: `Requirement ${requirementId}`,
    summary: `Canonical outcome and boundary for ${requirementId}`,
    status: "active",
    acceptance_criteria: [`The linked story output provides observable evidence for ${requirementId}`],
    source_paths: [],
    proposal_ref: null,
    created_at: createdAt,
    updated_at: createdAt,
    audit: { fixture: true },
  }, null, 2)}\n`);
}

function createStory(project, home, id) {
  ensureRequirement(project, "REQ-001");
  mustRun([
    "story", "create", "--no-derived-verification", "--root", project, "--id", id, "--title", `Story ${id}`,
    "--acceptance", "Observable acceptance",
  ], { cwd: project, home });
}

function reactProject(project) {
  writeFile(project, "package.json", JSON.stringify({
    name: "inventory-fixture",
    scripts: { test: "node --test" },
    dependencies: { react: "^18.0.0" },
    devDependencies: { typescript: "^5.0.0" },
  }));
}

function installMatchingTools(project, home) {
  skillFile(project, ".claude/skills/react-review", "react-review", "Review React components and hooks.");
  skillFile(home, ".claude/skills/ts-lint", "ts-lint", "Apply TypeScript lint rules.");
  skillFile(home, ".codex/skills/node-debug", "node-debug", "Debug Node.js services.");
  skillFile(home, ".codex/skills/pdf-forms", "pdf-forms", "Fill in PDF forms.");
  writeFile(project, ".mcp.json", JSON.stringify({
    mcpServers: {
      "react-docs": { command: "node", args: ["docs.js", `--flag=${SENTINEL}`], env: { SERVICE_ENV: SENTINEL } },
      "calendar-sync": { type: "http", url: `https://example.invalid/${SENTINEL}` },
    },
  }));
}

function approvedProfile(project, home, storyId, phase = "implementation") {
  const profileId = `CAP-PROFILE-${storyId}`;
  mustRun([
    "capability", "profile", "propose", "--root", project, "--id", profileId, "--story", storyId,
    "--phase", phase, "--context-file", "package.json",
  ], { cwd: project, home });
  mustRun([
    "capability", "profile", "approve", "--root", project, "--id", profileId, ...HUMAN,
    "--summary", "Approved the evidence and boundaries",
  ], { cwd: project, home });
  return profileId;
}

function pinConfig(project, home, config) {
  fs.writeFileSync(path.join(project, ".sdlc", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const preview = JSON.parse(mustRun(["config", "migrate", "--root", project, "--json"], { cwd: project, home }).stdout);
  mustRun([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash,
    "--actor-type", "system", "--json",
  ], { cwd: project, home });
}

test("capability recommend --from-inventory proposes only installed tools that name the declared stack", () => {
  const project = temporaryDirectory("recommend-project");
  const home = temporaryDirectory("recommend-home");
  initProject(project, home);
  reactProject(project);
  createStory(project, home, "ST-001");
  installMatchingTools(project, home);
  const profileId = approvedProfile(project, home, "ST-001");

  const result = mustRun([
    "capability", "recommend", "--root", project, "--id", "CAP-REC-ST-001", "--profile", profileId,
    "--from-inventory", "--json",
  ], { cwd: project, home });
  assert.equal(result.stdout.includes(SENTINEL), false, "no server value reaches the recommendation");
  const proposed = JSON.parse(result.stdout);
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.recommendation.status, "proposed", "nothing is approved or bound automatically");
  assert.deepEqual(proposed.recommendation.approvals, []);
  assert.deepEqual(proposed.recommendation.bindings, []);

  const recommended = proposed.recommendation.recommendations.map((item) => `${item.type}:${item.name}`).sort();
  assert.deepEqual(recommended, [
    "mcp:react-docs",
    "skill:agentic-sdlc",
    "skill:node-debug",
    "skill:react-review",
    "skill:ts-lint",
    "tool:test-runner",
  ]);
  const byKey = new Map(proposed.recommendation.recommendations.map((item) => [`${item.type}:${item.name}`, item]));
  assert.equal(byKey.get("skill:react-review").availability, "available");
  assert.equal(byKey.get("skill:react-review").install_required, false);
  assert.equal(byKey.get("skill:react-review").purpose, "Review React components and hooks.");
  assert.match(byKey.get("skill:react-review").rationale, /mentions the declared technology: react/u);
  assert.deepEqual(proposed.recommendation.policy_patch.skills.allowed.sort(), ["agentic-sdlc", "node-debug", "react-review", "ts-lint"]);
  assert.deepEqual(proposed.recommendation.policy_patch.mcp.allowed, ["react-docs"]);

  const available = proposed.recommendation.available_capabilities;
  assert.equal(available.origin, "capability-inventory:v1");
  // The record is committed with the project: unrelated tools from the user's
  // home are not written into it, only how many were left out.
  assert.equal(available.skills.some((item) => item.name === "pdf-forms"), false);
  assert.deepEqual(available.omitted_user_scope, { skills: 1, plugins: 0, mcp: 0 });
  assert.equal(JSON.stringify(proposed.recommendation).includes("pdf-forms"), false);
  const stored = fs.readFileSync(path.join(project, ".sdlc", "capability-discovery", "recommendations", "CAP-REC-ST-001.json"), "utf8");
  assert.equal(stored.includes("pdf-forms"), false, "nothing unrelated from the home directory reaches the stored record");
  assert.deepEqual(available.mcp.find((item) => item.name === "calendar-sync"), {
    name: "calendar-sync",
    source: "project-mcp-json",
    recommended: false,
  });
  assert.deepEqual(proposed.inventory_match.tags, ["frontend", "node", "react", "typescript"]);
  assert.equal(proposed.inventory_match.matched_total, 4);
  assert.deepEqual(proposed.inventory_match.proposed.map((item) => item.name).sort(), ["node-debug", "react-docs", "react-review", "ts-lint"]);
  assert.equal(proposed.approval_request.type, "capability_recommendation_approval");

  // The proposal is an ordinary pending recommendation: approving it is a
  // separate, explicit step.
  mustRun([
    "capability", "approve", "--root", project, "--id", "CAP-REC-ST-001", ...HUMAN,
    "--summary", "Approved the displayed tools and limits",
  ], { cwd: project, home });
  const status = JSON.parse(mustRun(["capability", "status", "--root", project, "--story", "ST-001", "--json"], { cwd: project, home }).stdout);
  assert.deepEqual(status.recommendations.map((item) => [item.id, item.status]), [["CAP-REC-ST-001", "approved"]]);
});

test("--from-inventory reports what it considered in both languages and proposes only the governance skill when nothing matches", () => {
  const project = temporaryDirectory("recommend-none-project");
  const home = temporaryDirectory("recommend-none-home");
  initProject(project, home);
  reactProject(project);
  createStory(project, home, "ST-001");
  skillFile(home, ".claude/skills/pdf-forms", "pdf-forms", "Fill in PDF forms.");
  const profileId = approvedProfile(project, home, "ST-001");

  const english = mustRun([
    "capability", "recommend", "--root", project, "--id", "CAP-REC-ST-001", "--profile", profileId, "--from-inventory",
  ], { cwd: project, home }).stdout;
  assert.match(english, /Installed capabilities examined: 1; none names a technology the context declares, so only the built-in governance skill is proposed\./u);

  const italian = mustRun([
    "capability", "recommend", "--root", project, "--id", "CAP-REC-ST-001", "--profile", profileId, "--from-inventory",
    "--force", "--locale", "it",
  ], { cwd: project, home }).stdout;
  assert.match(italian, /Capacità installate esaminate: 1; nessuna cita le tecnologie dichiarate dal contesto/u);

  const json = JSON.parse(mustRun([
    "capability", "recommend", "--root", project, "--id", "CAP-REC-ST-001", "--profile", profileId, "--from-inventory",
    "--force", "--json",
  ], { cwd: project, home }).stdout);
  assert.deepEqual(
    json.recommendation.recommendations.map((item) => item.name).sort(),
    ["agentic-sdlc", "test-runner"],
  );
  assert.equal(json.inventory_match.matched_total, 0);
});

test("--from-inventory cannot be combined with a hand-built list, follows configuration, and can be disabled", () => {
  const project = temporaryDirectory("recommend-config-project");
  const home = temporaryDirectory("recommend-config-home");
  initProject(project, home);
  reactProject(project);
  createStory(project, home, "ST-001");
  installMatchingTools(project, home);
  const profileId = approvedProfile(project, home, "ST-001");
  const base = ["capability", "recommend", "--root", project, "--id", "CAP-REC-ST-001", "--profile", profileId];

  const both = run([...base, "--from-inventory", "--available-capabilities-json", "{}"], { cwd: project, home });
  assert.notEqual(both.status, 0);
  assert.match(`${both.stdout}${both.stderr}`, /Use either --from-inventory or --available-capabilities-json\/--available-capabilities-file, not both\./u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "capability-discovery", "recommendations", "CAP-REC-ST-001.json")), false);

  const config = JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "config.json"), "utf8"));
  config.capability_discovery_policy.inventory.matching.max_suggestions = 2;
  pinConfig(project, home, config);
  const limited = JSON.parse(mustRun([...base, "--from-inventory", "--json"], { cwd: project, home }).stdout);
  assert.equal(limited.inventory_match.proposed.length, 2);
  assert.equal(limited.inventory_match.matched_total, 4);
  assert.equal(
    limited.recommendation.recommendations.filter((item) => item.type === "skill" && item.name !== "agentic-sdlc").length
      + limited.recommendation.recommendations.filter((item) => item.type === "mcp").length,
    2,
  );

  config.capability_discovery_policy.inventory.enabled = false;
  pinConfig(project, home, config);
  const disabled = run([...base, "--from-inventory", "--force"], { cwd: project, home });
  assert.notEqual(disabled.status, 0);
  assert.match(`${disabled.stdout}${disabled.stderr}`, /turned off by capability_discovery_policy\.inventory\.enabled/u);

  // The hand-built path still works exactly as before.
  const manual = JSON.parse(mustRun([
    ...base, "--force", "--available-capabilities-json",
    JSON.stringify({ skills: [{ name: "pdf-forms", purpose: "Fill in PDF forms." }] }), "--json",
  ], { cwd: project, home }).stdout);
  assert.equal(manual.recommendation.recommendations.some((item) => item.name === "pdf-forms"), true);
  assert.equal(manual.inventory_match, undefined);
});

// ---------------------------------------------------------------------------
// Proactive suggestion at task start and in status

function intent(storyId, phase, overrides = {}) {
  return JSON.stringify({
    requested_action: "implement_story",
    confidence: 0.95,
    referenced_entities: [{ type: "story", id: storyId }],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: phase,
    artifact_type: null,
    skip_phases: [],
    ...overrides,
  });
}

function taskStart(project, home, storyId, phase, extra = [], overrides = {}) {
  return mustRun([
    "task", "start", "--root", project, "--story", storyId,
    "--intent-json", intent(storyId, phase, overrides), ...extra,
  ], { cwd: project, home });
}

function taskStartJson(project, home, storyId, phase = "implementation", extra = [], overrides = {}) {
  return JSON.parse(taskStart(project, home, storyId, phase, ["--json", ...extra], overrides).stdout);
}

function statusJson(project, home) {
  return JSON.parse(mustRun(["status", "--root", project, "--json"], { cwd: project, home }).stdout);
}

function createPhaseStory(project, home, id, phase, title = `Story ${id}`) {
  ensureRequirement(project, "REQ-001");
  mustRun([
    "story", "create", "--no-derived-verification", "--root", project, "--id", id, "--title", title,
    "--acceptance", "Observable acceptance", "--phase", phase, "--status", "ready",
  ], { cwd: project, home });
}

function userTools(home) {
  skillFile(home, ".claude/skills/react-review", "react-review", "Review React components and hooks.");
  skillFile(home, ".codex/skills/node-debug", "node-debug", "Debug Node.js services.");
  skillFile(home, ".codex/skills/pdf-forms", "pdf-forms", "Fill in PDF forms.");
}

const DECISION_FIELDS = [
  "status", "execution_allowed", "route", "phase", "story_id", "contract_id", "contract_action",
  "blocking_reasons", "questions", "next_commands", "approval_requests",
];

function pick(source, fields) {
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}

test("task start offers installed tools that name the declared stack, without changing the decision", () => {
  const project = temporaryDirectory("suggest-project");
  const home = temporaryDirectory("suggest-home");
  const bareHome = temporaryDirectory("suggest-bare-home");
  initProject(project, home);
  reactProject(project);
  createPhaseStory(project, home, "ST-001", "implementation", "Fill in PDF forms for customers");
  userTools(home);

  // Without any installed tool the decision carries no suggestion; it is the
  // reference the suggested run must equal.
  const bare = taskStartJson(project, bareHome, "ST-001");
  assert.equal(bare.capability_suggestion, undefined, "no suggestion without an installed match");

  writeFile(project, ".mcp.json", JSON.stringify({
    mcpServers: { "react-docs": { command: "node", args: [`--flag=${SENTINEL}`], env: { SERVICE_ENV: SENTINEL } } },
  }));
  const serverOnly = taskStartJson(project, bareHome, "ST-001").capability_suggestion;
  assert.deepEqual(serverOnly.matches.map((match) => [match.type, match.name]), [["mcp", "react-docs"]]);

  const withTools = taskStartJson(project, home, "ST-001");
  assert.deepEqual(pick(withTools, DECISION_FIELDS), pick(bare, DECISION_FIELDS), "a suggestion never changes the decision");
  const suggestion = withTools.capability_suggestion;
  assert.equal(suggestion.schema_version, "capability-suggestion:v1");
  assert.equal(suggestion.story_id, "ST-001");
  assert.equal(suggestion.phase, "implementation");
  assert.equal(suggestion.basis, "project_detection");
  assert.equal(suggestion.profile_id, null);
  assert.equal(suggestion.applies_automatically, false);
  assert.deepEqual(suggestion.matches.map((match) => match.name).sort(), ["node-debug", "react-docs", "react-review"]);
  assert.equal(
    suggestion.matches.some((match) => match.name === "pdf-forms"),
    false,
    "the wording of the story is never matched, only the declared technology",
  );
  assert.deepEqual(suggestion.tags, ["frontend", "node", "react", "typescript"]);
  assert.deepEqual(suggestion.commands, [
    "agentic-sdlc capability profile propose --id CAP-PROFILE-ST-001 --story ST-001 --phase implementation --context-file package.json",
    "agentic-sdlc capability recommend --id CAP-REC-ST-001 --profile CAP-PROFILE-ST-001 --from-inventory",
  ]);
  assert.match(withTools.assistant_message, /Installed tools that look relevant to this work: .*react-review \(skill\)/u);
  assert.equal(JSON.stringify(withTools).includes(SENTINEL), false);

  // Nothing was proposed, approved, or bound by merely showing it.
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "capability-discovery", "profiles")), false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "capability-discovery", "recommendations")), false);
});

test("the task start suggestion reads in plain language first and keeps commands in the details", () => {
  const project = temporaryDirectory("suggest-text-project");
  const home = temporaryDirectory("suggest-text-home");
  initProject(project, home);
  reactProject(project);
  createPhaseStory(project, home, "ST-001", "implementation");
  userTools(home);
  skillFile(home, ".claude/skills/schema-react-helper", "schema-react-helper", "Helps with React schemas.");

  for (const locale of ["en", "it"]) {
    const text = taskStart(project, home, "ST-001", "implementation", ["--locale", locale]).stdout;
    const divider = locale === "it" ? "Dettagli tecnici (facoltativi):" : "Technical details (optional):";
    const [primary, details] = text.split(divider);
    const prefix = locale === "it" ? "Suggerimento strumenti:" : "Tool suggestion:";
    const line = primary.split("\n").find((entry) => entry.startsWith(prefix));
    assert.ok(line, `${locale} primary lacks the suggestion\n${text}`);
    assert.match(line, /react-review/u);
    assert.doesNotMatch(
      primary,
      /\.sdlc\/|--[a-z]|agentic-sdlc\s+[a-z]|\b(?:profile|schema|hash|receipt|checkpoint)\b|\b(?:REQ|AUT|AUTH|CAP|ST|ACT|PR)-[A-Z0-9]/iu,
      "the primary part carries no commands, identifiers, or internal terms",
    );
    assert.equal(line.includes("schema-react-helper"), false, "a name with an internal term stays in the details");
    assert.match(details, /capability recommend --id CAP-REC-ST-001 --profile CAP-PROFILE-ST-001 --from-inventory/u);
    assert.match(details, /capability profile propose --id CAP-PROFILE-ST-001 --story ST-001 --phase implementation --context-file package\.json/u);
    assert.match(details, /schema-react-helper/u);
    assert.equal(
      text.split(/Installed tools that look relevant to this work|Strumenti già installati che sembrano utili per questo lavoro/u).length - 1,
      1,
      "the suggestion sentence is shown once",
    );
    assert.match(details, /~\/\.claude\/skills\/react-review\/SKILL\.md/u);
  }
});

test("with an approved profile the suggestion points at the recommendation and stops once one is recorded", () => {
  const project = temporaryDirectory("suggest-profile-project");
  const home = temporaryDirectory("suggest-profile-home");
  initProject(project, home);
  reactProject(project);
  createPhaseStory(project, home, "ST-001", "implementation");
  userTools(home);

  mustRun([
    "capability", "profile", "propose", "--root", project, "--id", "CAP-PROFILE-ST-001", "--story", "ST-001",
    "--phase", "implementation", "--context-file", "package.json",
  ], { cwd: project, home });
  assert.equal(
    taskStartJson(project, home, "ST-001").capability_suggestion,
    undefined,
    "a proposed profile is already a pending decision",
  );

  mustRun([
    "capability", "profile", "approve", "--root", project, "--id", "CAP-PROFILE-ST-001", ...HUMAN,
    "--summary", "Approved the evidence and boundaries",
  ], { cwd: project, home });
  const suggestion = taskStartJson(project, home, "ST-001").capability_suggestion;
  assert.equal(suggestion.basis, "approved_profile");
  assert.equal(suggestion.profile_id, "CAP-PROFILE-ST-001");
  assert.deepEqual(suggestion.commands, [
    "agentic-sdlc capability recommend --id CAP-REC-ST-001 --profile CAP-PROFILE-ST-001 --from-inventory",
  ]);
  assert.match(suggestion.message, /ask me to put them forward for your review/u);
  assert.doesNotMatch(suggestion.message, /evidence and boundaries need your review first/u);
  // The stack does not change with the phase of the same story.
  assert.equal(taskStartJson(project, home, "ST-001", "validation").capability_suggestion?.basis, "approved_profile");

  // Running the suggested command records a proposal; from then on the
  // pending decision, not another suggestion, is what is shown.
  const [, ...argv] = suggestion.commands[0].split(" ");
  mustRun([...argv, "--root", project], { cwd: project, home });
  assert.equal(taskStartJson(project, home, "ST-001").capability_suggestion, undefined);
  mustRun([
    "capability", "approve", "--root", project, "--id", "CAP-REC-ST-001", ...HUMAN,
    "--summary", "Approved the displayed tools and limits",
  ], { cwd: project, home });
  assert.equal(taskStartJson(project, home, "ST-001").capability_suggestion, undefined);
});

test("a story that already binds an approved recommendation is not offered another", () => {
  const project = temporaryDirectory("suggest-bound-project");
  const home = temporaryDirectory("suggest-bound-home");
  initProject(project, home);
  reactProject(project);
  createPhaseStory(project, home, "ST-001", "design");
  userTools(home);
  approvedProfile(project, home, "ST-001", "design");
  mustRun([
    "capability", "recommend", "--root", project, "--id", "CAP-REC-ST-001", "--profile", "CAP-PROFILE-ST-001", "--from-inventory",
  ], { cwd: project, home });
  mustRun([
    "capability", "approve", "--root", project, "--id", "CAP-REC-ST-001", ...HUMAN, "--summary", "Approved the tools",
  ], { cwd: project, home });
  mustRun(["output", "template", "propose", "--root", project, "--type", "functional-analysis", "--summary", "Standard template"], { cwd: project, home });
  mustRun([
    "output", "template", "approve", "--root", project, "--id", "functional-analysis-v1", ...HUMAN, "--summary", "Approved template",
  ], { cwd: project, home });
  mustRun([
    "contract", "create", "--root", project, "--phase", "design", "--story", "ST-001", "--id", "contract-ST-001-design",
    "--context-summary", "Design with the approved tools.", "--qa", "Who approves?|Owner",
    "--output-ref", "functional-analysis:functional-analysis-v1:new", "--capability-recommendation", "CAP-REC-ST-001",
  ], { cwd: project, home });
  const decision = taskStartJson(project, home, "ST-001", "design", ["--contract-id", "contract-ST-001-design"]);
  assert.equal(decision.capability_suggestion, undefined);
  assert.equal(statusJson(project, home).capability_suggestion, undefined);
});

test("status carries the same suggestion for the first operational story", () => {
  const project = temporaryDirectory("suggest-status-project");
  const home = temporaryDirectory("suggest-status-home");
  initProject(project, home);
  reactProject(project);
  createPhaseStory(project, home, "ST-001", "implementation");
  userTools(home);

  const status = statusJson(project, home);
  assert.equal(status.capability_suggestion.story_id, "ST-001");
  assert.deepEqual(status.capability_suggestion.matches.map((match) => match.name).sort(), ["node-debug", "react-review"]);
  assert.equal(status.capability_suggestion.commands[1], "agentic-sdlc capability recommend --id CAP-REC-ST-001 --profile CAP-PROFILE-ST-001 --from-inventory");

  for (const locale of ["en", "it"]) {
    const text = mustRun(["status", "--root", project, "--locale", locale], { cwd: project, home }).stdout;
    const divider = locale === "it" ? "Dettagli tecnici (facoltativi):" : "Technical details (optional):";
    const [primary, details] = text.split(divider);
    assert.match(primary, new RegExp(`${locale === "it" ? "Suggerimento strumenti" : "Tool suggestion"}: .*react-review`, "u"));
    assert.doesNotMatch(primary, /--[a-z]|agentic-sdlc\s+[a-z]|\b(?:profile|schema|hash)\b/iu);
    assert.match(details, /capability profile propose --id CAP-PROFILE-ST-001/u);
  }

  mustRun([
    "capability", "profile", "propose", "--root", project, "--id", "CAP-PROFILE-ST-001", "--story", "ST-001",
    "--phase", "implementation",
  ], { cwd: project, home });
  assert.equal(statusJson(project, home).capability_suggestion, undefined, "a pending profile is already surfaced as a decision");
});

test("the suggestion stays quiet when nothing matches, when switched off, or for assessments", () => {
  const project = temporaryDirectory("suggest-quiet-project");
  const home = temporaryDirectory("suggest-quiet-home");
  initProject(project, home);
  createPhaseStory(project, home, "ST-001", "implementation");
  userTools(home);

  // No declared technology at all: there is nothing to match against.
  assert.equal(taskStartJson(project, home, "ST-001").capability_suggestion, undefined);
  assert.equal(statusJson(project, home).capability_suggestion, undefined);

  reactProject(project);
  assert.ok(taskStartJson(project, home, "ST-001").capability_suggestion);
  const assessment = taskStartJson(project, home, "ST-001", "analysis", [], {
    requested_action: "technical_assessment",
    artifact_type: "technical-analysis",
  });
  assert.equal(assessment.capability_suggestion, undefined, "assessments settle their tools in their own journey");

  const config = JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "config.json"), "utf8"));
  config.capability_discovery_policy.inventory.suggest = false;
  pinConfig(project, home, config);
  assert.equal(taskStartJson(project, home, "ST-001").capability_suggestion, undefined);
  assert.equal(statusJson(project, home).capability_suggestion, undefined);
  assert.ok(JSON.parse(mustRun(["capability", "inventory", "--root", project, "--json"], { cwd: project, home }).stdout).skills.length > 0, "the inventory command is unaffected");

  config.capability_discovery_policy.inventory.suggest = true;
  config.capability_discovery_policy.inventory.enabled = false;
  pinConfig(project, home, config);
  assert.equal(taskStartJson(project, home, "ST-001").capability_suggestion, undefined);
});
