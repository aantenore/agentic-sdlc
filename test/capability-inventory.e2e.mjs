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
    "[mcp_servers.codex-local]",
    "command = \"node\"",
    `args = ["server.js", "--flag=${SENTINEL}"]`,
    "[mcp_servers.codex-local.env]",
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
  assert.deepEqual([...servers.keys()].sort(), ["codex-local", "docs-hosted", "repo-index"]);
  assert.equal(servers.get("repo-index").transport, "stdio");
  assert.equal(servers.get("docs-hosted").transport, "http");
  assert.equal(servers.get("codex-local").path, "~/.codex/config.toml");
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

  const relocated = temporaryDirectory("codex-home");
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
    "story", "create", "--root", project, "--id", id, "--title", `Story ${id}`,
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
  assert.deepEqual(available.skills.find((item) => item.name === "pdf-forms"), {
    name: "pdf-forms",
    source: "user-codex-skills",
    recommended: false,
  });
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
