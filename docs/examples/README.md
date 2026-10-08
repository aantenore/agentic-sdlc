# Examples

Copy-paste material that is documented, tested, and deliberately **not active** in this repository. Nothing under `docs/examples/` runs here; copy a file into your own project to use it.

## GitHub Action: issue to shadow delivery

[`github-action-issue-to-shadow-delivery.yml`](github-action-issue-to-shadow-delivery.yml) turns a labelled issue into a **proposed** work brief and posts it back as a comment, without approving, pushing, or merging anything.

To use it, copy the file into your project as `.github/workflows/issue-to-shadow-delivery.yml`, create the label `agentic-sdlc-shadow`, and set the variables and secret listed below.

### What "shadow" means here

The run observes and proposes; it never decides. It has no approval, no write access to any branch, and no way to merge. A person reads the comment and then approves, changes, or ignores it in their own session. The proposed requirement is recorded only in the runner's throwaway workspace (and kept for seven days as a workflow artifact), so approving it means asking your agent to propose the same requirement in your own checkout and approving it there.

### What happens, in order

1. A maintainer adds the `agentic-sdlc-shadow` label to an issue. Adding any other label does nothing, and adding it never cancels a run in progress for another label.
2. The default branch is checked out without credentials, and the CLI is fetched at the full commit SHA in `AGENTIC_SDLC_REF`, verified after the fetch, and run with `node`.
3. The issue title and body are saved as a data file. They reach the job only through `env:` and are never interpolated into a script.
4. If `AGENT_HOST` is set, one read-only agent turn drafts a JSON brief (title, summary, observable acceptance criteria) from the issue and the repository. Without it, or if the draft is missing or invalid, the brief falls back to the issue title and a single placeholder criterion, so the run always ends with a comment.
5. `requirement propose` records the brief as a `proposed` requirement with the lowest independence ceiling (`supervised`). The step fails if the record is not `proposed`.
6. `status` and `approval requests` read the project state and the decisions that wait for a person. Both only read.
7. A comment is posted with the proposed work brief, the waiting decisions, the status, and the delivery checks (below). Text that came from the issue is shown inside a code fence with every backtick removed, so it cannot close the fence or ping anyone.

### Choose a host CLI

The example offers two alternatives and picks one with the repository variable `AGENT_HOST`. Both run read-only and both print one line of JSON.

| `AGENT_HOST` | Command in the workflow | Read-only because |
|---|---|---|
| `codex` | `codex exec --sandbox read-only --skip-git-repo-check --output-last-message <file> <prompt>` | the sandbox is read-only |
| `claude-code` | `claude -p <prompt> --allowedTools "Read,Grep,Glob" --disallowedTools "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"` | only read tools are allowed and every other tool is refused |

Both agent steps use `continue-on-error`, so a failed or slow draft falls back instead of failing the run. The flags above are those the example was written against; check them against `--help` of the exact release you pin, because host CLIs change their options between releases.

### Variables and secrets

Set these in the repository (Settings, then Secrets and variables, then Actions). The workflow never contains a credential; it only refers to `${{ secrets.NAME }}` placeholders.

| Name | Kind | Purpose |
|---|---|---|
| `AGENT_HOST` | variable | `codex` or `claude-code`. Leave it unset to run without an agent. |
| `AGENT_CLI_PACKAGE` | variable | The exact, reviewed npm package spec of the host CLI, for example `<package>@<exact-version>`. Required when `AGENT_HOST` is set. |
| `AGENT_API_KEY` | secret | The credential the host CLI authenticates with. Use a dedicated, low-limit key. |
| `AGENT_API_KEY_VARIABLE` | variable | The name of the environment variable your host CLI reads its credential from (documented by that CLI). It must be upper-case letters, digits, and underscores. |
| `GITHUB_TOKEN` | secret | Supplied by GitHub. Only the step that posts the comment receives it. |

### Permissions and guarantees

| Guarantee | How the example enforces it |
|---|---|
| Minimal permissions | The workflow and the job both declare exactly `contents: read` and `issues: write`. |
| No write to the default branch | The token cannot write contents, the checkout keeps no credentials, and no `git push`, `git commit`, `git merge`, or `gh pr` call exists. |
| No merge, no approval | The only lifecycle command that changes a record is `requirement propose`. There is no `approve`, no `autonomy delivery action`, and no `--actor-type`. |
| Pinned supply chain | Every action is pinned to a full commit SHA, in the same style as this repository's own workflows, and so is the CLI. |
| The agent holds no GitHub token | `GITHUB_TOKEN` is passed to the posting step alone; the agent steps receive only the agent credential. |
| Untrusted input stays data | Issue text enters through `env:`, is written to a file, and is read by the agent as data with an instruction to ignore instructions inside it. |
| Bounded | `timeout-minutes: 20`, one run per issue at a time. |

The unit test `test/unit/github-action-example.test.mjs` checks these properties against the file, so an edit that widens permissions, unpins an action, interpolates an expression into a script, or adds an approval fails the test suite.

### The delivery checks in the comment

The comment ends with the table printed by `autonomy delivery checks`, for the pull-request delivery named `AUT-ISSUE-<issue number>` when that delivery exists on the checked-out branch. Each row is `[PASS]`, `[FAIL]`, or `[NOT RUN]`, and nothing is re-run to produce it.

A first run has no delivery yet, because a delivery can only be proposed after a person approves the requirement and its work brief. The comment then says so instead of showing an empty table. Name the delivery `AUT-ISSUE-<number>` when you propose it, and re-labelling the issue shows the table with whatever has been recorded.

### Security notes

- **Who can start it.** Only people who may label issues can add `agentic-sdlc-shadow`. Keep that permission narrow.
- **Untrusted text.** An issue is written by anyone who can open one. The example treats it as data end to end; keep it that way when you adapt the file, and never move the trigger to `pull_request_target` or `issue_comment`.
- **The agent's reach.** The agent runs with the runner's network access and the one credential you give it, so use a dedicated key with a low spending limit, and prefer a runner with restricted egress if your policy needs it.
- **Reviewing the pin.** `AGENTIC_SDLC_REF` is a full commit SHA. Review a newer revision before changing it.
- **What the artifact holds.** The audit artifact contains the issue-derived brief, which is already visible in the issue and the comment.

### Adapting it

- To post nothing but the brief, delete the `Print the recorded checks` step and the `head -c 12000 "$out/checks.md"` line.
- To keep the proposal for review in your repository, have a person commit it from their own checkout; the workflow deliberately cannot.
- To use a different label or a different host variable, change the `if:` on the job and the matching text in this guide together; the test reads both.
