import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCapabilityInventoryPolicy } from "../../lib/capability-inventory.mjs";
import {
  deriveCapabilityTags,
  inventoryToAvailableCapabilities,
  matchInventoryCapabilities,
} from "../../lib/capability-matching.mjs";
import { buildDefaultCapabilityRecommendations } from "../../lib/lifecycle/capability.mjs";

const MATCHING = normalizeCapabilityInventoryPolicy({}).matching;

function entry(type, name, description, extra = {}) {
  return {
    type,
    name,
    description,
    scope: "user",
    source: "user-skills",
    plugin: null,
    path: `~/${name}`,
    ...extra,
  };
}

function inventoryOf(...entries) {
  return {
    skills: entries.filter((item) => item.type === "skill"),
    commands: entries.filter((item) => item.type === "command"),
    plugins: entries.filter((item) => item.type === "plugin"),
    mcp: entries.filter((item) => item.type === "mcp"),
  };
}

function tagsOf(detectedStack, integrations = []) {
  return deriveCapabilityTags({ detectedStack, integrations }, MATCHING);
}

test("tags come from the declared stack and integrations, never from generic words", () => {
  const tags = tagsOf(
    [
      { name: "package-json", type: "node" },
      { name: "react", type: "frontend-library" },
      { name: "npm-scripts", type: "automation" },
      { name: "@angular/core", type: "frontend-framework" },
      { name: "jest", type: "test-runner" },
      { name: "python-requirements", type: "dependency-file" },
      { name: "package-json-unreadable", type: "warning" },
    ],
    ["postgres", { name: "Stripe API" }, { id: "billing-service" }, 42, null],
  );
  assert.deepEqual(tags.map((item) => item.tag), [
    "angular",
    "billing",
    "frontend",
    "jest",
    "node",
    "postgres",
    "python",
    "react",
    "service",
    "stripe",
  ]);
  const byTag = new Map(tags.map((item) => [item.tag, item.phrases]));
  assert.deepEqual(byTag.get("node"), ["node", "node js", "nodejs"]);
  assert.deepEqual(byTag.get("react"), ["react"]);
  assert.deepEqual(tagsOf([]), []);
  assert.deepEqual(tagsOf(undefined), []);
});

test("short and ambiguous tags match only through their aliases", () => {
  const tags = tagsOf([{ name: "go", type: "language" }, { name: "next", type: "web-framework" }, { name: "ab", type: "x" }]);
  const byTag = new Map(tags.map((item) => [item.tag, item.phrases]));
  assert.deepEqual(byTag.get("go"), ["golang"]);
  assert.deepEqual(byTag.get("next"), ["next js", "nextjs"]);
  assert.equal(byTag.has("ab"), false, "a two-letter word is too short to stand alone");

  const inventory = inventoryOf(
    entry("skill", "task-planner", "Plan the next steps and go through the list."),
    entry("skill", "golang-services", "Design Go services."),
    entry("skill", "nextjs-routing", "Routing for Next.js apps."),
  );
  assert.deepEqual(
    matchInventoryCapabilities(inventory, tags, { matching: MATCHING }).map((item) => item.name),
    ["nextjs-routing", "golang-services"],
  );
});

test("a capability matches only when it names a declared technology as a whole word", () => {
  const tags = tagsOf([{ name: "react", type: "frontend-library" }]);
  const inventory = inventoryOf(
    entry("skill", "react-review", "Review components."),
    entry("skill", "ui-helper", "Helps with React and other UI libraries."),
    entry("skill", "reactive-streams", "Reactive programming patterns."),
    entry("skill", "pre-react-notes", "Notes."),
    entry("skill", "unrelated", "Writes release notes."),
    entry("skill", "null-description", null),
  );
  const matches = matchInventoryCapabilities(inventory, tags, { matching: MATCHING });
  assert.deepEqual(matches.map((item) => item.name), ["pre-react-notes", "react-review", "ui-helper"]);
  assert.deepEqual(matches.map((item) => item.score), [2, 2, 1]);
  assert.deepEqual(matches[0].matched_tags, ["react"]);
  assert.equal(matchInventoryCapabilities(inventory, [], { matching: MATCHING }).length, 0);
  assert.equal(matchInventoryCapabilities(inventory, undefined, { matching: MATCHING }).length, 0);
});

test("the request text is never consulted: only the declared tags decide", () => {
  const inventory = inventoryOf(
    entry("skill", "pdf-forms", "Fill in PDF forms."),
    entry("skill", "react-review", "Review React components."),
  );
  // The same declared stack gives the same result whatever the user asked for.
  const tags = tagsOf([{ name: "react", type: "frontend-library" }]);
  assert.deepEqual(
    matchInventoryCapabilities(inventory, tags, { matching: MATCHING }).map((item) => item.name),
    ["react-review"],
  );
  assert.deepEqual(
    matchInventoryCapabilities(inventory, tags, { matching: MATCHING, text: "please fill in a PDF form", request: "pdf" }),
    matchInventoryCapabilities(inventory, tags, { matching: MATCHING }),
    "request text passed alongside is ignored",
  );
});

test("phase words rank a capability but never make it relevant on their own", () => {
  const tags = tagsOf([{ name: "react", type: "frontend-library" }]);
  const inventory = inventoryOf(
    entry("skill", "react-basics", "React fundamentals."),
    entry("skill", "react-testing", "Testing React components and review checklists."),
    entry("skill", "release-notes", "Prepare release notes and deployment checklists."),
  );
  const validation = matchInventoryCapabilities(inventory, tags, { phase: "validation", matching: MATCHING });
  assert.deepEqual(validation.map((item) => item.name), ["react-testing", "react-basics"]);
  assert.deepEqual(validation[0].matched_phase_tags, ["testing", "review"]);
  assert.deepEqual(validation[1].matched_phase_tags, []);
  assert.equal(validation.some((item) => item.name === "release-notes"), false);
  const release = matchInventoryCapabilities(inventory, tags, { phase: "release", matching: MATCHING });
  assert.deepEqual(release.map((item) => item.name), ["react-basics", "react-testing"]);
  const unknownPhase = matchInventoryCapabilities(inventory, tags, { phase: "no-such-phase", matching: MATCHING });
  assert.deepEqual(unknownPhase.map((item) => item.name), ["react-basics", "react-testing"]);
});

test("ranking is stable and prefers a name match, then skills before plugins before servers", () => {
  const tags = tagsOf([], ["postgres"]);
  const inventory = inventoryOf(
    entry("mcp", "postgres", null, { transport: "stdio", enabled: true }),
    entry("plugin", "postgres-tools", "Database helpers.", { version: "1.0.0" }),
    entry("skill", "postgres-migrations", "Plan schema changes."),
    entry("skill", "db-review", "Review Postgres queries."),
    entry("skill", "alpha-postgres", "Another one."),
  );
  const names = matchInventoryCapabilities(inventory, tags, { matching: MATCHING }).map((item) => `${item.type}:${item.name}`);
  assert.deepEqual(names, [
    "skill:alpha-postgres",
    "skill:postgres-migrations",
    "plugin:postgres-tools",
    "mcp:postgres",
    "skill:db-review",
  ]);
  const reversed = inventoryOf(...[...inventory.mcp, ...inventory.plugins, ...inventory.skills].reverse());
  assert.deepEqual(
    matchInventoryCapabilities(reversed, tags, { matching: MATCHING }).map((item) => `${item.type}:${item.name}`),
    names,
    "the order of the inventory does not change the ranking",
  );
});

test("the plugin's own governance skills, disabled servers, and repeated names are left out", () => {
  const tags = tagsOf([{ name: "react", type: "frontend-library" }]);
  const inventory = inventoryOf(
    entry("skill", "agentic-sdlc", "Governs React delivery."),
    entry("skill", "agentic-sdlc-assessment", "Assess React apps."),
    entry("skill", "bundled-react", "Bundled React helper.", { plugin: "agentic-sdlc" }),
    entry("skill", "react-review", "Project copy.", { scope: "project", source: "project-skills" }),
    entry("skill", "react-review", "User copy."),
    entry("mcp", "react-docs", null, { transport: "http", enabled: false }),
    entry("mcp", "react-live", null, { transport: "http", enabled: true }),
  );
  const matches = matchInventoryCapabilities(inventory, tags, { matching: MATCHING });
  assert.deepEqual(matches.map((item) => item.name), ["react-review", "react-live"]);
  assert.equal(matches.find((item) => item.name === "react-review").description, "Project copy.");
  const custom = normalizeCapabilityInventoryPolicy({ matching: { exclude_names: [] } }).matching;
  const unrestricted = matchInventoryCapabilities(inventory, tags, { matching: custom }).map((item) => item.name);
  assert.equal(unrestricted.includes("agentic-sdlc"), true, "the exclusion list is configuration, not hard-coded");
  assert.equal(unrestricted.includes("bundled-react"), true);
});

test("matching follows the configured aliases and ignored words", () => {
  const matching = normalizeCapabilityInventoryPolicy({
    matching: {
      aliases: { react: ["preact"] },
      ignored_tags: ["frontend"],
      min_tag_length: 8,
    },
  }).matching;
  const tags = deriveCapabilityTags({ detectedStack: [{ name: "react", type: "frontend-library" }] }, matching);
  assert.deepEqual(tags, [{ tag: "react", phrases: ["preact"] }], "react is below the minimum length, so only its alias stands");
  const inventory = inventoryOf(entry("skill", "preact-review", "Review components."), entry("skill", "react-review", "Review components."));
  assert.deepEqual(
    matchInventoryCapabilities(inventory, tags, { matching }).map((item) => item.name),
    ["preact-review"],
  );
});

test("available capabilities keep chosen entries, project names, and only a count of user-scoped extras", () => {
  const inventory = inventoryOf(
    entry("skill", "react-review", "Review React components.", { scope: "project", source: "project-skills", path: ".claude/skills/react-review/SKILL.md" }),
    entry("skill", "react-review", "Duplicate in another place."),
    entry("skill", "team-notes", "Project-scoped, not chosen.", { scope: "project", source: "project-skills" }),
    entry("skill", "pdf-forms", "Fill in PDF forms."),
    entry("plugin", "widgets", "Widget helpers.", { version: "1.0.0" }),
    entry("mcp", "docs", null, { transport: "http", enabled: true }),
    entry("mcp", "parked", null, { transport: "stdio", enabled: false }),
    entry("command", "ship", "Ship it."),
  );
  const tags = tagsOf([{ name: "react", type: "frontend-library" }]);
  const matches = matchInventoryCapabilities(inventory, tags, { matching: MATCHING });
  const available = inventoryToAvailableCapabilities(inventory, {
    recommend: new Set(matches.map((item) => `${item.type}:${item.name}`)),
    matches,
  });
  assert.deepEqual(Object.keys(available).sort(), ["omitted_user_scope", "skills"], "commands are not a recommendation type");
  assert.deepEqual(available.skills, [
    {
      name: "react-review",
      source: "project-skills",
      path: ".claude/skills/react-review/SKILL.md",
      description: "Review React components.",
      rationale: "Installed (project-skills); its name or description mentions the declared technology: react.",
    },
    { name: "team-notes", source: "project-skills", recommended: false },
  ]);
  assert.deepEqual(available.omitted_user_scope, { skills: 1, plugins: 1, mcp: 1 });
  const serialized = JSON.stringify(available);
  for (const unrelated of ["pdf-forms", "widgets", "docs", "parked"]) assert.equal(serialized.includes(unrelated), false, unrelated);
  assert.deepEqual(inventoryToAvailableCapabilities({}), {});
});

test("only the matched capabilities become recommendations, next to the built-in governance skill", () => {
  const inventory = inventoryOf(
    entry("skill", "react-review", "Review React components."),
    entry("skill", "pdf-forms", "Fill in PDF forms."),
    entry("mcp", "docs", null, { transport: "http", enabled: true }),
  );
  const tags = tagsOf([{ name: "react", type: "frontend-library" }]);
  const matches = matchInventoryCapabilities(inventory, tags, { matching: MATCHING });
  const available = inventoryToAvailableCapabilities(inventory, {
    recommend: new Set(matches.map((item) => `${item.type}:${item.name}`)),
    matches,
  });
  const recommendations = buildDefaultCapabilityRecommendations({ detected_stack: [] }, available);
  assert.deepEqual(
    recommendations.map((item) => `${item.type}:${item.name}:${item.availability}`),
    ["skill:agentic-sdlc:available", "skill:react-review:available"],
  );
  assert.equal(recommendations[1].purpose, "Review React components.");
  assert.equal(recommendations.every((item) => item.install_required === false), true);
});
