import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const starters = {
  assessment: "Contextualize this project and prepare an initial technical assessment.",
  newPullRequest: "Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request.",
  existingPullRequest: "Continue this existing pull request, verify the requested changes, and update the PR without creating a new one.",
  localOnly: "Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.",
};

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("plugin metadata preserves the assessment starter first and exposes novice delivery starters", () => {
  const manifest = JSON.parse(read(".codex-plugin/plugin.json"));
  const prompts = manifest.interface.defaultPrompt;

  assert.equal(prompts[0], starters.assessment);
  assert.ok(prompts.includes(starters.newPullRequest));
  assert.ok(prompts.includes(starters.existingPullRequest));
  assert.ok(prompts.includes(starters.localOnly));
  assert.match(manifest.interface.shortDescription, /pull requests/i);
  assert.match(manifest.interface.longDescription, /local-only results/i);

  const coreAgentCard = read("skills/agentic-sdlc/agents/openai.yaml");
  assert.match(coreAgentCard, new RegExp(starters.newPullRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(coreAgentCard, /deliver verified PRs or local results/);
});

test("getting-started and README distinguish novice destinations and execution boundaries", () => {
  const readme = read("README.md");
  const gettingStarted = read("docs/getting-started.md");
  const docsIndex = read("docs/README.md");

  for (const prompt of Object.values(starters)) {
    assert.ok(readme.includes(prompt), `README is missing starter: ${prompt}`);
    assert.ok(gettingStarted.includes(prompt), `getting-started is missing starter: ${prompt}`);
  }

  assert.match(docsIndex, /\[Getting started\]\(getting-started\.md\)/);

  for (const boundary of [
    "Codex conversation",
    "Deterministic CLI",
    "Local execution and data",
    "Repository publication",
    "Deployment or production",
  ]) {
    assert.ok(gettingStarted.includes(boundary), `getting-started is missing boundary: ${boundary}`);
  }

  assert.match(gettingStarted, /new pull request/i);
  assert.match(gettingStarted, /existing pull request/i);
  assert.match(gettingStarted, /does not mean unrestricted/i);
});

test("core skill documents the required order and discloses autonomy reduction before choice", () => {
  const skill = read("skills/agentic-sdlc/SKILL.md");
  const orderSectionStart = skill.indexOf("### Required Delivery Order");
  const workflowStart = skill.indexOf("## Workflow", orderSectionStart);

  assert.ok(orderSectionStart >= 0, "Required Delivery Order section is missing");
  assert.ok(workflowStart > orderSectionStart, "Required Delivery Order must precede the detailed workflow");

  const orderSection = skill.slice(orderSectionStart, workflowStart);
  const stages = [
    "**Preview and normalize the request**",
    "**Agree the requirement**",
    "**Decompose only when needed**",
    "**Agree the output and work brief**",
    "**Choose autonomy for this delivery**",
    "**Start the story workflow, then start once**",
    "**Implement, test, and advance phases**",
    "**Validate, then enter release**",
    "**Finish and certify at the named destination**",
  ];

  let previous = -1;
  for (const stage of stages) {
    const current = orderSection.indexOf(stage);
    assert.ok(current > previous, `stage is missing or out of order: ${stage}`);
    previous = current;
  }

  const finishStage = orderSection.slice(orderSection.indexOf("**Finish and certify at the named destination**"));
  const operationsStep = finishStage.indexOf("complete the `operations` step");
  assert.ok(
    operationsStep >= 0 && operationsStep < finishStage.indexOf("lifecycle-complete"),
    "the final stage must complete the operations step before lifecycle-complete certification",
  );
  const gettingStarted = read("docs/getting-started.md");
  const finishJourney = gettingStarted.slice(gettingStarted.indexOf("**Finish and certify at the named destination**"));
  assert.ok(
    finishJourney.indexOf("`operations` step") >= 0
      && finishJourney.indexOf("`operations` step") < finishJourney.indexOf("lifecycle-complete"),
    "getting-started must complete the operations step before lifecycle-complete certification",
  );

  assert.match(orderSection, /Do not call `task start`/);
  assert.match(orderSection, /Before presenting the choices/);
  assert.match(orderSection, /reduced to “Autonomy with checkpoints”/);
  assert.match(skill, /--allow-action pull_request\.create/);
  assert.match(skill, /For an existing pull request/);
  for (const document of [skill, read("commands/continue-pr.md")]) {
    assert.match(document, /--pr-mode existing/u);
    assert.match(document, /--pr-number/u);
    assert.match(document, /--pr-url/u);
  }
});

test("local novice guidance verifies rollback before release and requires a terminal lifecycle certificate", () => {
  const skill = read("skills/agentic-sdlc/SKILL.md");
  const rollbackAuthorization = skill.indexOf("--action rollback.verify");
  const releaseAuthorization = skill.indexOf("--action release.local --confirm-action");

  assert.ok(rollbackAuthorization >= 0, "skill is missing rollback verification");
  assert.ok(
    releaseAuthorization > rollbackAuthorization,
    "skill must verify rollback before authorizing local release",
  );
  assert.match(skill, /intermediate readiness check, not the final delivery certificate/u);
  assert.match(skill, /--lifecycle-complete/u);
  assert.match(skill, /requires every configured phase to have a completed canonical step/u);
  assert.match(skill, /current story-bound workflow to its configured `release` phase/u);
  assert.doesNotMatch(
    skill.slice(releaseAuthorization, releaseAuthorization + 500),
    /--host-receipt-file/u,
    "default audit-only release example must not require a host receipt",
  );
});

test("installer guides bind candidate registration to the exact returned target", () => {
  for (const relativePath of ["README.md", "docs/portable-install.md", "docs/self-service-cli.md"]) {
    const document = read(relativePath);
    assert.match(document, /candidate_registration\.command\.argv/u, relativePath);
    assert.match(document, /candidate_registration\.verification\.argv/u, relativePath);
    assert.match(document, /Default target example only/u, relativePath);
    assert.match(document, /CODEX_HOME/u, relativePath);
  }
});

test("configuration and autonomy references use executable local guidance and current profile lineage", () => {
  const configurationSafety = read("docs/configuration-safety.md");
  assert.match(configurationSafety, /PLUGIN_CLI=/u);
  assert.match(configurationSafety, /node "\$PLUGIN_CLI" config status/u);
  assert.doesNotMatch(configurationSafety, /^agentic-sdlc config/gmu);

  for (const relativePath of [
    "skills/agentic-sdlc/references/contracts.md",
    "skills/agentic-sdlc/references/knowledge-base.md",
  ]) {
    const reference = read(relativePath);
    assert.match(reference, /delivery-execution-profile:v2/u, relativePath);
    assert.match(reference, /historical `?delivery-execution-profile:v1/iu, relativePath);
    assert.match(reference, /never rewritten/u, relativePath);
  }
});

test("the Claude Code packaging stays version-locked to the package and exposes the same starter intents", () => {
  const packageMetadata = JSON.parse(read("package.json"));
  const claudeManifest = JSON.parse(read(".claude-plugin/plugin.json"));
  const codexManifest = JSON.parse(read(".codex-plugin/plugin.json"));

  assert.equal(claudeManifest.name, "agentic-sdlc");
  assert.equal(claudeManifest.version, packageMetadata.version);
  assert.equal(claudeManifest.version, codexManifest.version);
  assert.equal(claudeManifest.license, packageMetadata.license);
  assert.equal(claudeManifest.commands, "./commands/");
  assert.equal(claudeManifest.skills, "./skills/");
  assert.doesNotMatch(claudeManifest.name, /codex/iu);

  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, claudeManifest.name);
  assert.equal(entry.version, claudeManifest.version);
  assert.equal(entry.source, "./");

  const commandsDirectory = path.join(repoRoot, "commands");
  const commandFiles = fs.readdirSync(commandsDirectory)
    .filter((entryName) => entryName.endsWith(".md"))
    .sort();
  assert.deepEqual(commandFiles, [
    "assess.md",
    "continue-pr.md",
    "deliver.md",
    "doctor.md",
    "local.md",
    "observe.md",
    "status.md",
  ]);

  const commandsByStarter = {
    "commands/assess.md": starters.assessment,
    "commands/deliver.md": starters.newPullRequest,
    "commands/continue-pr.md": starters.existingPullRequest,
    "commands/local.md": starters.localOnly,
  };
  for (const [relativePath, starter] of Object.entries(commandsByStarter)) {
    const command = read(relativePath);
    assert.ok(command.includes(starter), `${relativePath} is missing starter: ${starter}`);
  }

  for (const commandFile of commandFiles) {
    const relativePath = `commands/${commandFile}`;
    const command = read(relativePath);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(command);
    assert.ok(frontmatter, `${relativePath} has no YAML frontmatter`);
    assert.match(frontmatter[1], /^description: \S.*$/mu, relativePath);
    assert.doesNotMatch(command, /\$\{CODEX_PLUGIN_ROOT\}/u, relativePath);
  }

  for (const relativePath of ["commands/observe.md", "commands/status.md", "commands/doctor.md"]) {
    assert.match(read(relativePath), /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/agentic-sdlc\.mjs/u, relativePath);
  }

  // Doctor always inspects the project in the working directory when --root is omitted.
  const doctorCommand = read("commands/doctor.md");
  assert.doesNotMatch(doctorCommand, /installation only/iu);
  assert.match(doctorCommand, /current working directory/u);
});

test("the release surface ships and requires both host packagings", () => {
  const packageMetadata = JSON.parse(read("package.json"));
  const policy = JSON.parse(read("config/release-artifact-policy.json"));

  for (const selector of [".claude-plugin/", "commands/", ".codex-plugin/plugin.json", "skills/"]) {
    assert.ok(packageMetadata.files.includes(selector), `package.json files is missing: ${selector}`);
  }

  for (const topLevel of [".claude-plugin", ".codex-plugin", "commands", "skills"]) {
    assert.ok(
      policy.package.allowed_top_level.includes(topLevel),
      `release policy does not allow top-level entry: ${topLevel}`,
    );
  }

  for (const required of [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
  ]) {
    assert.ok(
      policy.package.required_files.includes(required),
      `release policy does not require: ${required}`,
    );
  }
});

test("the Claude Code installation guide documents the marketplace flow and the Codex-only exclusions", () => {
  const guide = read("docs/claude-code-install.md");
  const docsIndex = read("docs/README.md");
  const readme = read("README.md");

  assert.match(guide, /\/plugin marketplace add aantenore\/agentic-sdlc/u);
  assert.match(guide, /\/plugin install agentic-sdlc@aantenore/u);
  assert.match(guide, /\$\{CLAUDE_PLUGIN_ROOT\}/u);
  assert.match(guide, /install-personal-marketplace-v2\.py/u);
  assert.match(guide, /does not apply/iu);
  assert.match(docsIndex, /\[Claude Code installation\]\(claude-code-install\.md\)/u);

  // The guide says skill bodies locate the plugin root themselves; every skill using <plugin-root> must define it.
  for (const skillName of fs.readdirSync(path.join(repoRoot, "skills")).sort()) {
    const relativePath = `skills/${skillName}/SKILL.md`;
    if (!fs.existsSync(path.join(repoRoot, relativePath))) continue;
    const skill = read(relativePath);
    if (!skill.includes("<plugin-root>")) continue;
    assert.match(skill, /(?:plugin root|<plugin-root>)[^.]*\bexactly two directories above/iu, `${relativePath} does not define <plugin-root>`);
  }
  assert.match(readme, /\[Claude Code Installation\]\(docs\/claude-code-install\.md\)/u);
});

test("delivery guidance agrees the delivery shape, write scope, and local commit ownership up front", () => {
  const skill = read("skills/agentic-sdlc/SKILL.md");
  const orderSection = skill.slice(skill.indexOf("### Required Delivery Order"), skill.indexOf("## Workflow"));
  const decomposeStage = orderSection.slice(
    orderSection.indexOf("**Decompose only when needed**"),
    orderSection.indexOf("**Agree the output and work brief**"),
  );
  assert.match(decomposeStage, /own pull request or local release and its own autonomy choice/u);
  assert.match(decomposeStage, /ONE pull request or ONE local release for several parts, propose one delivery story whose parts are tasks/u);
  assert.match(decomposeStage, /before approval, not after/u);
  assert.match(skill, /--item story:ST-001 --item task:T-001/u);

  const agreeStage = orderSection.slice(
    orderSection.indexOf("**Agree the requirement**"),
    orderSection.indexOf("**Decompose only when needed**"),
  );
  assert.match(agreeStage, /`\.gitignore`/u);
  assert.match(orderSection, /### Choose where the result goes/u);
  assert.match(orderSection, /outside the Git worktree/u);
  assert.match(orderSection, /add its project-relative path \(`\.local-release`\) to the requirement `--write-path` list/u);

  assert.match(orderSection, /does not commit their code/u);
  assert.match(orderSection, /`git -C <target-project> add -- [^`]*\.sdlc` followed by `git -C <target-project> commit -m/u);
  assert.match(orderSection, /do not hide them through `\.git\/info\/exclude`/u);

  const localCommand = read("commands/local.md");
  assert.match(localCommand, /does not commit code/u);
  assert.match(localCommand, /git -C <project> add --/u);
  assert.match(localCommand, /one delivery story with tasks/u);
  assert.match(localCommand, /`\.gitignore`/u);
  assert.match(read("commands/deliver.md"), /one delivery story with tasks at breakdown time/u);

  const gettingStarted = read("docs/getting-started.md");
  assert.match(gettingStarted, /own pull request or local\s+release and its own autonomy choice/u);
  assert.match(gettingStarted, /local-only journey does not commit your code/u);
  assert.match(gettingStarted, /git -C \/absolute\/project commit -m/u);
  assert.match(gettingStarted, /Include `\.gitignore` whenever the work may add or change it/u);
  const howItWorks = read("docs/how-it-works.md");
  assert.match(howItWorks, /one delivery story whose parts are tasks/u);
  assert.match(howItWorks, /does not commit the project's source/u);
  assert.doesNotMatch(howItWorks, /aggregation requirement/u);
});

test("guidance names a story retirement command only when the CLI catalog provides one", () => {
  const catalog = read("lib/cli/command-catalog.mjs");
  const guidanceFiles = [
    "skills/agentic-sdlc/SKILL.md",
    "skills/agentic-sdlc/references/commands.md",
    "commands/local.md",
    "commands/deliver.md",
    "docs/getting-started.md",
    "docs/how-it-works.md",
  ];
  for (const verb of ["supersede", "cancel", "retire", "abandon", "withdraw"]) {
    const command = `story ${verb}`;
    if (catalog.includes(`C("${command}"`)) continue;
    for (const relativePath of guidanceFiles) {
      assert.doesNotMatch(read(relativePath), new RegExp(`\\b${command}\\b`, "u"), `${relativePath} names missing command: ${command}`);
    }
  }
  assert.match(read("skills/agentic-sdlc/SKILL.md"), /### Approved stories that will not be delivered/u);
});
