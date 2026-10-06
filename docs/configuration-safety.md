# Configuration safety

The plugin pins each initialized project's complete effective configuration. Updating the plugin can add new defaults, but it cannot silently change the rules already governing that project.

A Codex plugin installation does not create a global `agentic-sdlc`
executable. Set the installer-managed entry point once before using the
commands in this guide:

```bash
PLUGIN_CLI="$HOME/plugins/agentic-sdlc-codex-plugin/bin/agentic-sdlc.mjs"
node "$PLUGIN_CLI" help config
```

An npm installation may expose an equivalent bin shim. The explicit Node form
below always identifies the plugin-local copy.

## The short version

Run:

```bash
node "$PLUGIN_CLI" config status --root /path/to/project
```

The first three lines tell you the result, its impact, and the next action. Technical hashes and internal labels follow only as supporting detail.

| Message | Meaning | What to do |
| --- | --- | --- |
| Configuration is pinned and safe | The stored config matches its lock | Nothing |
| Previous compatible behavior is preserved | This is an older project without a lock | Preview a migration |
| Configuration changed after the lock | A person or tool changed project policy | Review and accept or restore the change |
| The lock cannot be trusted | The lock is malformed or inconsistent | Restore a valid config and lock before governed writes |

Commands that only inspect state remain available during recovery. Commands that change governed project records stop before writing when the config is drifted or invalid.

## Review before applying

The preview is read-only:

```bash
node "$PLUGIN_CLI" config migrate --root /path/to/project
```

It reports every JSON path that would be added, replaced, or removed and prints a deterministic plan hash. It does not change `config.json`, create a lock, or write a migration receipt.

For automation, the machine-readable preview is compact by default:

```bash
node "$PLUGIN_CLI" config migrate --root /path/to/project --json
```

It keeps the plan hash and reviewable changes but reports which plan details
were omitted. The envelope explicitly reports `plan_complete: false` and
`plan_hash_verification: requires_full_preview`: its nested `plan` is a compact
summary, not a complete `config-migration-plan:v1`, and its hash cannot be
independently recomputed from that summary alone. The hash remains the exact
opaque reference accepted by apply, which recomputes the full plan before any
write.

Request the complete machine payload to inspect the target configuration or
verify the plan hash independently:

```bash
node "$PLUGIN_CLI" config migrate --root /path/to/project --json --full
```

Here `--full` expands details omitted from compact machine/JSON output; it does
not change the plan or apply it. It reports `plan_complete: true` and
`plan_hash_verification: self-contained`; its nested plan validates against
`schemas/config-migration-plan.schema.json`.

Apply only the plan you just reviewed:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --apply \
  --plan-hash <displayed-sha256>
```

Before writing, the CLI recomputes the plan under a project lock. If the config, previous lock, or plan changed after review, the command stops and preserves the existing files. A successful apply atomically materializes the reviewed config, writes `config.lock.json`, and stores an immutable receipt under `.sdlc/migrations/config/`.

### Adopt an exact manifestless v0.11 project

Projects initialized by the bundled v0.11 format predate
`.sdlc/bootstrap-manifest.json`. The CLI recognizes only that exact legacy
shape. Preview remains read-only and identifies the adoption separately; it
does not treat a changed project version as proof of a legacy bootstrap.

After reviewing both the migration plan and the identified legacy bootstrap,
apply them with a separate, directly attributed decision:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --apply \
  --plan-hash <displayed-sha256> \
  --confirm-legacy-bootstrap \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Adopt this exact legacy bootstrap"
```

An approved CI actor may instead use `--actor-type ci --approval-source ci`.
Both human and CI adoption require a decision summary or approval-evidence
file. A missing, mismatched, or previously locked bootstrap stops before any
configuration file, lock, or receipt is written. This flag is only for the
first v0.11 lock; it cannot repair or bypass an incomplete newer bootstrap.

## Change the autonomy rollout mode

Do not edit `autonomy_policy.mode` by hand. Preview one of the four supported modes through the same hash-bound configuration workflow:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --autonomy-mode observe
```

The preview shows the semantic JSON change, for example:

```text
replace /autonomy_policy/mode: "enforce_new_only" -> "observe"
```

Apply the exact reviewed mode and plan together:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --autonomy-mode observe \
  --apply \
  --plan-hash <displayed-sha256>
```

Valid modes are `off`, `observe`, `enforce_new_only`, and `enforce_all`. The mode is part of the plan hash: omitting it, selecting a different mode, or changing the config after preview causes apply to fail before any file is written.

Release-history migration is deliberately separate. It never upgrades configuration as a side effect; pin the project config first, then run the release migration.

## Esempio in italiano

```text
La configurazione è stata modificata dopo l'ultimo blocco approvato.
Impatto: il plugin non presume che la modifica sia intenzionale e sospende le scritture governate.
Prossima azione: esegui l'anteprima, controlla le differenze e applica soltanto l'hash del piano mostrato.
```

L'anteprima non modifica file. Se qualcuno cambia nuovamente la configurazione prima dell'applicazione, il vecchio hash viene rifiutato e occorre revisionare un nuovo piano.

## English example

```text
Configuration changed after the last approved lock.
Impact: the plugin does not guess whether the change was intentional, so governed writes are paused.
Next: preview the migration, review the diff, and apply only the displayed plan hash.
```

The preview changes no files. If the configuration changes again before apply, the old hash is rejected and a new plan must be reviewed.

## Technical records

- `.sdlc/config.json` is the fully materialized project policy.
- `.sdlc/config.lock.json` binds the complete config hash, defaults profile, inherited paths, and creation time.
- `.sdlc/migrations/config/*.json` records an applied plan, resulting lock, audit attribution, and immutable receipt hash.
- `templates/config-compat/` contains frozen compatibility defaults used only for older projects that do not yet have a lock.

The lock is hash-bound evidence, not a digital signature. A signed host approval is a different record with a verified trusted-key attestation; the CLI does not call an ordinary config lock “signed.”

## Standing approval limits

`standing_approval_policy` caps what any standing approval may request: `max_validity_days`, `max_deliveries`, `max_changed_files`, `max_changed_lines`, and `expiry_warning_hours`, plus `enabled`. Projects created before this section existed use the same documented fallback values without changing their effective configuration hash. Changing the configuration later, through the hash-bound workflow above, suspends every standing approval approved under the previous configuration: it reports `stale` and covers nothing until the user approves a new one.
