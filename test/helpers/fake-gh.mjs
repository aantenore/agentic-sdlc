import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A fake `gh api` for messaging tests: a small in-memory GitHub (issues, labels,
 * comments) that answers like `gh api -i` does (status line, headers, body).
 * `createFakeGh()` is injected as the provider's exec; `installFakeGh(dir)` writes a
 * real `gh` executable (state kept in a JSON file) for tests that run the CLI.
 * No test ever reaches the real GitHub.
 */
const CORE = fileURLToPath(import.meta.url);
const FIXED_START = Date.parse("2026-01-01T00:00:00Z");
const FIRST_COMMENT_ID = 4_000_000_000;

export function newState(overrides = {}) {
  return { start: FIXED_START, issues: [], comments: [], clock: 0, nextIssue: 1, nextComment: FIRST_COMMENT_ID, calls: [], faults: [], noAuth: false, raceOnCreate: false, login: "antonio", ...overrides };
}

function stamp(state) {
  state.clock += 1;
  return new Date(state.start + state.clock * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function reply(status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const lines = [`HTTP/2.0 ${status} X`, "Content-Type: application/json", ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)];
  return { code: status >= 400 ? 1 : 0, stdout: `${lines.join("\r\n")}\r\n\r\n${text}`, stderr: status >= 400 ? `gh: ${body?.message ?? "error"} (HTTP ${status})\n` : "" };
}

function page(items, params) {
  const size = Number(params.get("per_page") ?? 30);
  const index = Number(params.get("page") ?? 1);
  return items.slice((index - 1) * size, index * size);
}

/** Runs one `gh` invocation against `state`. */
export function handle(state, args) {
  state.calls.push(args);
  if (state.noAuth) return { code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login\n" };
  const method = args[args.indexOf("--method") + 1];
  const endpoint = args[args.indexOf("--method") + 2];
  const fields = {};
  const lists = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-f") continue;
    const [key, ...rest] = args[i + 1].split("=");
    const value = rest.join("=");
    if (key.endsWith("[]")) (lists[key.slice(0, -2)] ??= []).push(value);
    else fields[key] = value;
  }
  const fault = state.faults.find((entry) => (!entry.method || entry.method === method) && (!entry.match || endpoint.includes(entry.match)));
  if (fault) {
    if (!fault.keep) state.faults.splice(state.faults.indexOf(fault), 1);
    return reply(fault.status, { message: fault.message ?? "fault" }, fault.headers);
  }
  const url = new URL(`https://api.github.test/${endpoint}`);
  if (url.pathname === "/user") return reply(200, { login: state.login });
  const route = /^\/repos\/[^/]+\/[^/]+\/(issues|labels)(?:\/(\d+))?(?:\/(comments))?$/u.exec(url.pathname);
  if (!route) return reply(404, { message: "Not Found" });
  const number = route[2] ? Number(route[2]) : null;
  if (route[1] === "issues" && !number) {
    if (method === "GET") {
      const label = url.searchParams.get("labels");
      const found = state.issues.filter((issue) => !label || issue.labels.some((entry) => entry.name === label));
      return reply(200, page(found, url.searchParams));
    }
    if (state.raceOnCreate) {
      state.raceOnCreate = false;
      state.issues.push({ number: state.nextIssue++, title: fields.title, state: "open", labels: (lists.labels ?? []).map((name) => ({ name })), body: "" });
    }
    const issue = { number: state.nextIssue++, title: fields.title, body: fields.body, state: "open", labels: (lists.labels ?? []).map((name) => ({ name })) };
    state.issues.push(issue);
    return reply(201, issue);
  }
  const issue = state.issues.find((entry) => entry.number === number);
  if (!issue) return reply(404, { message: "Not Found" });
  if (!route[3]) {
    if (method === "PATCH") Object.assign(issue, fields);
    return reply(200, issue);
  }
  if (method === "POST") {
    const at = stamp(state);
    const comment = { id: state.nextComment++, body: fields.body, created_at: at, updated_at: at, user: { login: state.login }, issue: number };
    state.comments.push(comment);
    return reply(201, comment);
  }
  const since = url.searchParams.get("since");
  const mine = state.comments.filter((comment) => comment.issue === number && (!since || comment.updated_at >= since));
  return reply(200, page(mine, url.searchParams).map(({ issue: _issue, ...rest }) => rest));
}

/** A fake exec (the provider's injectable): `{ exec, state }`. */
export function createFakeGh(overrides = {}) {
  const state = newState(overrides);
  return { state, exec: async (args) => handle(state, args) };
}

/** Writes an executable `gh` into `dir` serving the state file; returns { state path, env } for the CLI. */
export function installFakeGh(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, "gh-state.json");
  fs.writeFileSync(statePath, JSON.stringify(newState(overrides)));
  const shim = path.join(dir, "gh");
  fs.writeFileSync(shim, `#!${process.execPath}\nimport(${JSON.stringify(`file://${CORE}`)}).then(({ runShim }) => runShim(process.argv.slice(2)));\n`, { mode: 0o755 });
  return {
    statePath,
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: statePath },
    read: () => JSON.parse(fs.readFileSync(statePath, "utf8")),
    write: (mutate) => {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      mutate(state);
      fs.writeFileSync(statePath, JSON.stringify(state));
    },
  };
}

export function runShim(args) {
  const file = process.env.FAKE_GH_STATE;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = handle(state, args);
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
