import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanFiles } from "../../lib/secret-scan.mjs";
import { YamlSubsetError, parseYamlSubset } from "../helpers/yaml-subset.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const examplesDirectory = path.join(repoRoot, "docs", "examples");
const exampleName = "github-action-issue-to-shadow-delivery.yml";
const examplePath = path.join(examplesDirectory, exampleName);
const workflowsDirectory = path.join(repoRoot, ".github", "workflows");

const source = fs.readFileSync(examplePath, "utf8");
const workflow = parseYamlSubset(source);
const job = workflow.jobs.shadow;
const steps = job.steps;
const readme = fs.readFileSync(path.join(examplesDirectory, "README.md"), "utf8");

const SHA_PIN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$/u;

function pinsUsedByThisRepository() {
  const pins = new Map();
  for (const name of fs.readdirSync(workflowsDirectory).filter((entry) => entry.endsWith(".yml"))) {
    const text = fs.readFileSync(path.join(workflowsDirectory, name), "utf8");
    for (const match of text.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*$/gmu)) {
      const [, action, sha] = SHA_PIN.exec(match[1]) ?? [];
      assert.ok(action, `${name} must pin ${match[1]} to a full commit SHA`);
      pins.set(action, new Set([...(pins.get(action) ?? []), sha]));
    }
  }
  return pins;
}

function runBodies() {
  return steps.filter((step) => typeof step.run === "string").map((step) => step.run);
}

function stepsWith(predicate) {
  return steps.filter(predicate);
}

// ---------------------------------------------------------------------------
// The helper that reads the workflow: it must be strict, or "parses" means little.
// ---------------------------------------------------------------------------

test("the YAML subset reader returns the structure a workflow author wrote", () => {
  const parsed = parseYamlSubset([
    "# header comment",
    "name: Demo # trailing comment",
    "on:",
    "  issues:",
    "    types: [labeled, 'edited']",
    "empty: {}",
    "nothing:",
    "jobs:",
    "  one:",
    "    if: github.event.label.name == 'x'",
    "    timeout-minutes: 20",
    "    env:",
    "      A: ${{ vars.A }}",
    "      B: \"quoted: value # not a comment\"",
    "      C: 'it''s'",
    "    steps:",
    "      - name: first",
    "        run: |",
    "          echo \"# kept\"",
    "",
    "          if true; then",
    "            echo nested",
    "          fi",
    "      - uses: actions/checkout@abc",
    "        with:",
    "          persist-credentials: false",
    "          fetch-depth: 0",
    "      - plain item",
    "    list:",
    "    - same",
    "    - indent",
    "    stripped: |-",
    "      no newline",
    "",
  ].join("\n"));
  assert.deepEqual(parsed, {
    name: "Demo",
    on: { issues: { types: ["labeled", "edited"] } },
    empty: {},
    nothing: null,
    jobs: {
      one: {
        if: "github.event.label.name == 'x'",
        "timeout-minutes": 20,
        env: { A: "${{ vars.A }}", B: "quoted: value # not a comment", C: "it's" },
        steps: [
          { name: "first", run: "echo \"# kept\"\n\nif true; then\n  echo nested\nfi\n" },
          { uses: "actions/checkout@abc", with: { "persist-credentials": false, "fetch-depth": 0 } },
          "plain item",
        ],
        list: ["same", "indent"],
        stripped: "no newline",
      },
    },
  });
});

test("the YAML subset reader refuses anything it cannot vouch for", () => {
  const refused = [
    ["tabs", "a:\n\tb: 1\n", /tabs are not allowed/u],
    ["duplicate keys", "a: 1\na: 2\n", /duplicate key 'a'/u],
    ["anchors", "a: &x 1\n", /unsupported YAML construct/u],
    ["aliases", "a: *x\n", /unsupported YAML construct/u],
    ["tags", "a: !!str 1\n", /unsupported YAML construct/u],
    ["folded scalars", "a: >\n  text\n", /unsupported YAML construct|only literal block scalars/u],
    ["document markers", "---\na: 1\n", /document markers are not supported/u],
    ["colon in a plain scalar", "a: b: c\n", /cannot contain ': '/u],
    ["an unterminated quote", "a: \"open\n", /unterminated quoted scalar/u],
    ["text after a quote", "a: 'x' y\n", /unexpected text after a quoted scalar/u],
    ["a multi-line plain scalar", "a: first\n  second\n", /unexpected indentation/u],
    ["a flow mapping with content", "a: {b: 1}\n", /only the empty flow mapping/u],
    ["nested flow collections", "a: [[1], 2]\n", /nested flow collections/u],
    ["an unclosed flow sequence", "a: [1, 2\n", /must close on the same line/u],
    ["a line that is not a mapping entry", "a: 1\njust text\n", /expected 'key: value'/u],
    ["content after the document", "- a\nb: 1\n", /unexpected content after the document/u],
    ["an empty literal block", "a: |\nb: 1\n", /needs indented content/u],
  ];
  for (const [label, text, pattern] of refused) {
    assert.throws(() => parseYamlSubset(text), (error) => {
      assert.ok(error instanceof YamlSubsetError, `${label}: ${error}`);
      assert.match(error.message, pattern, label);
      return true;
    }, label);
  }
});

test("the YAML subset reader accepts the repository's own workflows", () => {
  for (const name of fs.readdirSync(workflowsDirectory).filter((entry) => entry.endsWith(".yml"))) {
    const parsed = parseYamlSubset(fs.readFileSync(path.join(workflowsDirectory, name), "utf8"));
    assert.ok(parsed.jobs && typeof parsed.jobs === "object", name);
  }
});

// ---------------------------------------------------------------------------
// The example itself.
// ---------------------------------------------------------------------------

test("the example is documentation, not an active workflow of this repository", () => {
  assert.ok(fs.existsSync(examplePath));
  assert.ok(!fs.existsSync(path.join(workflowsDirectory, exampleName)));
  for (const name of fs.readdirSync(workflowsDirectory).filter((entry) => entry.endsWith(".yml"))) {
    assert.notEqual(parseYamlSubset(fs.readFileSync(path.join(workflowsDirectory, name), "utf8")).name, workflow.name);
  }
  assert.match(source, /NOT a workflow of\n# this repository/u);
  assert.deepEqual(Object.keys(workflow), ["name", "on", "permissions", "defaults", "jobs"]);
});

test("the example starts only from a label added to an issue", () => {
  assert.deepEqual(workflow.on, { issues: { types: ["labeled"] } });
  assert.equal(job.if, "github.event.label.name == 'agentic-sdlc-shadow'");
  assert.match(readme, /`agentic-sdlc-shadow`/u);
  assert.doesNotMatch(source, /pull_request_target|issue_comment|workflow_run|workflow_dispatch|\bschedule:/u);
});

test("permissions are the minimum: read the code, write issue comments", () => {
  assert.deepEqual(workflow.permissions, { contents: "read", issues: "write" });
  assert.deepEqual(job.permissions, workflow.permissions);
  // No other scope is ever granted, and nothing is granted write except issues.
  const grants = [...source.matchAll(/^\s*([a-z-]+):\s*(read|write|none)\s*$/gmu)].map((match) => [match[1], match[2]]);
  assert.deepEqual(grants.filter(([, level]) => level === "write"), [["issues", "write"], ["issues", "write"]]);
  assert.deepEqual([...new Set(grants.map(([scope]) => scope))].sort(), ["contents", "issues"]);
});

test("every action is pinned to a full commit SHA, in the style this repository uses", () => {
  const used = steps.filter((step) => step.uses).map((step) => step.uses);
  assert.ok(used.length >= 3);
  const repositoryPins = pinsUsedByThisRepository();
  for (const reference of used) {
    const [, action, sha] = SHA_PIN.exec(reference) ?? [];
    assert.ok(action, `${reference} must be pinned to a full 40-character commit SHA`);
    if (repositoryPins.has(action)) {
      assert.ok(repositoryPins.get(action).has(sha), `${action} must use a SHA this repository's workflows already use`);
    }
  }
  assert.doesNotMatch(source, /uses:\s*\S+@(?:v\d|main|master|latest)/u);
  for (const step of stepsWith((candidate) => String(candidate.uses ?? "").startsWith("actions/checkout@"))) {
    assert.equal(step.with["persist-credentials"], false, "the checkout must not leave the token in the workspace");
  }
});

test("the CLI is installed from a full commit SHA and verified after the fetch", () => {
  assert.match(job.env.AGENTIC_SDLC_REF, /^[0-9a-f]{40}$/u);
  const install = steps.find((step) => /Install the CLI/u.test(step.name));
  assert.match(install.run, /fetch --quiet --depth 1 https:\/\/github\.com\/aantenore\/agentic-sdlc\.git "\$AGENTIC_SDLC_REF"/u);
  assert.match(install.run, /test "\$\(git -C "\$dir" rev-parse HEAD\)" = "\$AGENTIC_SDLC_REF"/u);
});

test("secrets appear only as placeholders in env, and no credential-shaped value is written down", () => {
  const references = [...source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(references)].sort(), ["AGENT_API_KEY", "GITHUB_TOKEN"]);
  // Once the placeholders are removed, the word "secrets" must be gone.
  assert.doesNotMatch(source.replace(/\$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}/gu, ""), /\bsecrets\b/u);
  for (const candidate of steps) {
    for (const [name, value] of Object.entries(candidate.env ?? {})) {
      if (String(value).includes("secrets.")) {
        assert.match(String(value), /^\$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/u, `${name} must be exactly a secrets placeholder`);
      }
    }
    assert.ok(!String(candidate.run ?? "").includes("secrets."), "a secret is never expanded into a script");
    assert.ok(!JSON.stringify(candidate.with ?? {}).includes("secrets."), "a secret is never passed as an action input");
  }
  assert.deepEqual(scanFiles([{ path: exampleName, content: source }]).findings, []);
});

test("issue text and expressions never reach a shell script", () => {
  for (const body of runBodies()) {
    assert.ok(!body.includes("${{"), `a run block interpolates an expression:\n${body}`);
  }
  const eventTextSteps = stepsWith((candidate) => JSON.stringify(candidate.env ?? {}).includes("github.event.issue.title")
    || JSON.stringify(candidate.env ?? {}).includes("github.event.issue.body"));
  assert.equal(eventTextSteps.length, 1, "issue text enters the job through one step's env only");
  assert.match(eventTextSteps[0].run, /> \.agentic-sdlc-shadow\/issue\.md/u);
});

test("the run is a shadow: nothing is approved, pushed, merged, or written to a branch", () => {
  const bodies = runBodies().join("\n");
  assert.doesNotMatch(bodies, /git\s+(?:push|commit|merge|tag|rebase|cherry-pick|remote\s+(?:add|set-url))/u);
  assert.doesNotMatch(bodies, /\bgh\s+(?!issue\s+comment\b)\S+/u, "the only gh call is the issue comment");
  assert.doesNotMatch(bodies, /--force|--admin|--delete-branch/u);
  assert.doesNotMatch(
    bodies,
    /(?:requirement|contract|assessment proposal|baseline|workflow definition|output template)\s+approve|autonomy\s+(?:delivery|standing)\s+(?:approve|action)|--actor-type|--approval-source|--confirm-/u,
  );
  assert.match(bodies, /requirement propose/u);
  assert.match(bodies, /--autonomy-ceiling supervised/u);
  assert.match(bodies, /jq -e '\.status == "proposed"'/u);
  // Only the step that posts the comment receives a token.
  const withToken = stepsWith((candidate) => Object.keys(candidate.env ?? {}).some((name) => /TOKEN/u.test(name)));
  assert.deepEqual(withToken.map((candidate) => candidate.name), ["Post the comment"]);
  assert.equal(withToken[0].env.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
  assert.match(withToken[0].run, /gh issue comment "\$ISSUE_NUMBER" --body-file/u);
});

test("both agent host CLIs are offered as read-only alternatives chosen by one variable", () => {
  const agentSteps = stepsWith((candidate) => /codex |claude /u.test(String(candidate.run ?? "")));
  assert.deepEqual(agentSteps.map((candidate) => candidate.if), [
    "vars.AGENT_HOST == 'codex'",
    "vars.AGENT_HOST == 'claude-code'",
  ]);
  const [codex, claude] = agentSteps;
  assert.match(codex.run, /codex exec --sandbox read-only /u);
  assert.match(claude.run, /claude -p /u);
  assert.match(claude.run, /--allowedTools "Read,Grep,Glob"/u);
  assert.match(claude.run, /--disallowedTools "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"/u);
  for (const candidate of agentSteps) {
    assert.equal(candidate["continue-on-error"], true, "a failed draft falls back instead of failing the run");
    assert.equal(candidate.env.AGENT_API_KEY, "${{ secrets.AGENT_API_KEY }}");
    assert.match(candidate.run, /\[\[ "\$AGENT_API_KEY_VARIABLE" =~ \^\[A-Z\]\[A-Z0-9_\]\*\$ \]\]/u);
  }
  // Without a host variable the run still produces a brief, from the issue title.
  const validate = steps.find((step) => /Validate the draft/u.test(step.name));
  assert.equal(validate.if, undefined);
  assert.match(validate.run, /issue-title/u);
  const install = steps.find((step) => /Install the agent host CLI/u.test(step.name));
  assert.equal(install.if, "vars.AGENT_HOST != ''");
});

test("the example and its guide name no assistant product, only the host CLI commands", () => {
  const forbidden = /\b(?:anthropic|openai|chatgpt|gemini|copilot|cursor|windsurf|llama|mistral)\b|gpt-\d|\bclaude\s+(?:code|opus|sonnet|haiku)\b/iu;
  assert.doesNotMatch(source, forbidden);
  assert.doesNotMatch(readme, forbidden);
});

test("the job is bounded and one run per issue at a time", () => {
  assert.equal(job["timeout-minutes"], 20);
  assert.deepEqual(job.concurrency, { group: "shadow-delivery-${{ github.event.issue.number }}", "cancel-in-progress": true });
  assert.equal(workflow.concurrency, undefined, "workflow-level concurrency would let an unrelated label cancel a run");
  assert.equal(job["runs-on"], "ubuntu-latest");
});

test("the guide documents every variable, secret, and label the example reads", () => {
  const variables = [...new Set([...source.matchAll(/\bvars\.([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(variables, ["AGENT_API_KEY_VARIABLE", "AGENT_CLI_PACKAGE", "AGENT_HOST"]);
  for (const name of [...variables, "AGENT_API_KEY", "GITHUB_TOKEN"]) {
    assert.ok(readme.includes(`\`${name}\``), `docs/examples/README.md must explain ${name}`);
  }
  for (const phrase of ["contents: read", "issues: write", "codex exec", "claude -p", "autonomy delivery checks"]) {
    assert.ok(readme.includes(phrase), `docs/examples/README.md must mention ${phrase}`);
  }
  assert.ok(readme.includes(exampleName));
  assert.ok(readme.includes(".github/workflows/"));
});
