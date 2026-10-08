# CodeBurn advisory metering adapter

This is a legacy compatibility adapter. New projects use the bundled
`codex-session` adapter, and token-efficiency autoconfiguration never installs,
enables, or invokes CodeBurn. Keep this adapter only when an existing project
explicitly depends on CodeBurn aggregation or estimated cost.

The CodeBurn adapter converts a local CodeBurn 0.9.x JSON report into a provider-neutral, immutable metering snapshot. It is intentionally an observation source, not an authority source: token, call, and cost measurements are always `estimated`, the assurance classification is always `advisory_observed`, and `trusted_exact` is always `false`.

The CLI integration requires CodeBurn 0.9.x to be installed separately; it never installs or upgrades CodeBurn. Use `budget meter start --proposal ASSESS-001 --adapter codeburn --from 2026-07-14 --to 2026-07-14` after approval and before execution, then `budget meter record --proposal ASSESS-001 --adapter codeburn [--baseline id]`. The stored query is reused exactly, deltas advance from the last recorded snapshot, and identical observations replay idempotently. Multi-day work should declare its full stable date window at start. The same commands meter one delivery with `--delivery <profile-id>` instead of `--proposal`; this is the meter a standing approval cost budget relies on, and CodeBurn's report currency must match the currency the delivery records cost in (see [Delivery cost and lead time](limits-and-metering.md#delivery-cost-and-lead-time)).

This distinction matters. A CodeBurn delta is useful for visibility, warnings, estimates, and later reconciliation. By itself it must not satisfy an exact hard token or cost limit.

## What each input means

Every collection uses the same four allowlisted CodeBurn filters:

- `provider` asks which local session-log producer CodeBurn should read. Example: `codex`. It does not mean a billing account or an OpenAI project ID.
- `project` asks which CodeBurn project filter should be aggregated. Example: `TravelOps`. CodeBurn can match more than one session, so use the narrowest stable project value available.
- `from` and `to` ask for a fixed inclusive calendar window in `YYYY-MM-DD` form. Example: both `2026-07-14` for one day. A baseline and its current snapshot must use exactly the same window.
- `id` identifies the persisted evidence record. Example: `ASSESSMENT-001-codeburn-start`. It does not affect CodeBurn filtering.

The adapter builds argv itself and launches CodeBurn without a shell. It rejects raw arguments, unknown query fields, control characters, option-like values such as `--all`, invalid dates, output over the configured bound, unsupported versions, and malformed JSON.

## Shell-free command configuration

The project configuration models the CodeBurn launcher as an executable plus discrete prefix arguments:

```json
{
  "enabled": true,
  "provider": "codex",
  "command": {
    "executable": "codeburn",
    "arguments": []
  },
  "metric_mapping": {
    "tokens": "tokens.total"
  }
}
```

The default works for a native executable on `PATH`. On Windows, npm installs command shims as `.cmd` files, which cannot be launched by Node's shell-free `execFile` API. Keep the no-shell boundary by pointing `executable` at `node.exe` and putting CodeBurn's installed `dist/cli.js` path in `arguments`. The adapter prepends those arguments to both `--version` and the allowlisted report argv; it never concatenates a command string or evaluates shell syntax. The same mechanism also supports hermetic tool paths in CI and other managed runtimes.

### Enabling the adapter

CodeBurn ships disabled. To use it, install CodeBurn 0.9.x yourself, set
`budget_policy.metering_adapters.codeburn.enabled` to `true` (and adjust
`provider` or `command` if needed) in `.sdlc/config.json`, then pin the edited
configuration: run `agentic-sdlc config migrate`, review the plan, and apply it
with `agentic-sdlc config migrate --apply --plan-hash <hash>`. Until it is
pinned, the project keeps using its previous configuration. If the executable
cannot be found, `budget meter start` says so and repeats these steps.

## Start snapshot

Use a start snapshot immediately before the task begins. The example below asks CodeBurn to aggregate Codex sessions matching `TravelOps` on 14 July 2026, normalizes the cumulative counters, hashes the source report, and returns a persistible snapshot:

```js
import fs from "node:fs/promises";
import { collectCodeBurnMeteringSnapshot } from "../lib/codeburn-metering-adapter.mjs";

const query = {
  provider: "codex",
  project: "TravelOps",
  from: "2026-07-14",
  to: "2026-07-14",
};

const baseline = await collectCodeBurnMeteringSnapshot({
  id: "ASSESSMENT-001-codeburn-start",
  query,
});

await fs.writeFile(
  ".sdlc/metering/ASSESSMENT-001-codeburn-start.json",
  `${JSON.stringify(baseline, null, 2)}\n`,
  { flag: "wx" },
);
```

`collectCodeBurnMeteringSnapshot` first checks the configured command with `--version`, accepts only 0.9.x, then runs the equivalent of:

```text
codeburn report --provider codex --project TravelOps --from 2026-07-14 --to 2026-07-14 --format json
```

The displayed command is explanatory; callers should use the library so unvalidated values cannot become raw argv.

## Current snapshot and delta

Collect a second snapshot with the exact same provider, project, date window, CodeBurn patch version, and currency. Then subtract the cumulative counters:

```js
import fs from "node:fs/promises";
import {
  calculateMeteringDelta,
  collectCodeBurnMeteringSnapshot,
} from "../lib/codeburn-metering-adapter.mjs";

const baseline = JSON.parse(await fs.readFile(
  ".sdlc/metering/ASSESSMENT-001-codeburn-start.json",
  "utf8",
));

const current = await collectCodeBurnMeteringSnapshot({
  id: "ASSESSMENT-001-codeburn-current",
  query: baseline.scope,
});

const delta = calculateMeteringDelta(baseline, current, {
  id: "ASSESSMENT-001-codeburn-delta",
});

await fs.writeFile(
  ".sdlc/metering/ASSESSMENT-001-codeburn-delta.json",
  `${JSON.stringify(delta, null, 2)}\n`,
  { flag: "wx" },
);
```

The delta contains separate `input`, `output`, `cache_read`, and `cache_write` token quantities, plus calls, sessions, and decimal cost. The configurable budget mapper can bind `tokens` to the explicit sum of those four counters, or bind individual token components, `model_calls`, and same-currency `cost`. It maps only metrics present in the approved budget and preserves `estimated`/`advisory_observed` assurance.

Both snapshot references carry their IDs, hashes, and capture times. Any counter decrease, source reset, filter drift, currency change, adapter patch change, reversed timestamp, or tampered snapshot fails closed instead of producing a negative or incomparable delta.

## Persisted evidence

`metering-snapshot.schema.json` validates snapshots and `metering-delta.schema.json` validates deltas. A snapshot includes:

- adapter ID, CodeBurn version, and supported report contract;
- exact provider/project/date scope and allowlisted argv;
- cumulative token categories, calls, sessions, cost, and currency;
- matched CodeBurn project records, which help expose unexpectedly broad filters;
- a stable hash of the parsed source report;
- advisory assurance fields and a stable snapshot hash.

The normalized record does not embed CodeBurn's potentially large raw report. If independent replay is required, persist the raw JSON as separate evidence and verify that its canonical SHA-256 equals `source.report_hash`.

When `cost` is mapped into the approved budget, the usage receipt also records a non-authoritative `pricing_ref` with CodeBurn as the estimator, `estimated` classification, adapter version, currency, and source report hash. This identifies the estimate without turning it into provider billing evidence.

## Limitations and enforcement boundary

- CodeBurn reads local session logs. Missing, deleted, delayed, duplicated, or imported logs can change completeness. The result is not provider-signed.
- The cost is calculated from CodeBurn's pricing catalog. Catalog rates, model aliases, caching rules, proxy behavior, discounts, taxes, credits, and invoice timing can differ from actual provider charges. Reconcile financial controls against the provider Costs API or invoice.
- Project and date filters are aggregation filters, not task ownership. If two sessions run concurrently under the same provider/project/window, the delta includes both. Use an isolated project/session boundary when available; otherwise keep the result advisory.
- A report is a point-in-time observation. It cannot stop a model call that has already happened and is not a real-time hard-limit hook.
- Cache reads and writes remain separate because providers price and report them differently. Do not add them to input/output unless an explicit budget metric defines that formula.
- A CodeBurn update, currency change, pricing-catalog refresh, filter change, or cumulative counter reset requires a new baseline.
- Only the 0.9.x report contract is accepted. A later CodeBurn series must be reviewed and versioned rather than silently treated as compatible.

See the official [JSON output documentation](https://codeburn.app/docs/json-output), [model and pricing documentation](https://codeburn.app/docs/models), [provider notes](https://codeburn.app/docs/provider-notes), and the [CodeBurn source repository](https://github.com/getagentseal/codeburn) for upstream behavior.

## Library API

- `normalizeCodeBurnQuery` and `buildCodeBurnReportArgv` create the safe, reproducible scope.
- `parseCodeBurnVersion` and `detectCodeBurn` identify a supported 0.9.x installation.
- `parseCodeBurnReport`, `validateCodeBurnReport`, and `assertCodeBurnReport` enforce the report contract.
- `executeCodeBurnReport` executes and validates a report without shell interpolation.
- `normalizeCodeBurnObservation` produces the provider-neutral cumulative observation.
- `buildCodeBurnMeteringSnapshot` and `collectCodeBurnMeteringSnapshot` build hash-bound evidence.
- `validateMeteringSnapshotIntegrity` verifies snapshot content and hash.
- `calculateMeteringDelta` subtracts two comparable monotonic snapshots.
- `validateMeteringDeltaIntegrity` verifies delta content and hash.
