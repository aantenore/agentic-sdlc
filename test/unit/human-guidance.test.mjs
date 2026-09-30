import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_GUIDANCE_FIELDS,
  actionCheckpointGuidance,
  assertHumanGuidancePlainLanguage,
  buildHumanGuidance,
  createHumanGuidance,
  deliveryAutonomyApprovalGuidance,
  deliveryAutonomyProposalGuidance,
  deliveryAutonomyStatusGuidance,
  findForbiddenHumanGuidanceTerms,
  gateGuidance,
  genericErrorGuidance,
  renderHumanGuidanceText,
  requirementAutonomyCeilingGuidance,
} from "../../lib/human-guidance.mjs";

const CANONICAL_CODES = [
  "supervised",
  "checkpointed",
  "bounded-autonomous",
  "audit_only",
  "host_verified",
  "pull_request.merge",
];

function humanText(block) {
  return [
    block.result,
    block.impact,
    block.required_decision,
    block.protection_boundary,
    block.next_action,
  ].join("\n");
}

function assertCanonicalCodesOnlyInDetails(block) {
  assert.deepEqual(Object.keys(block), HUMAN_GUIDANCE_FIELDS);
  for (const code of CANONICAL_CODES) assert.doesNotMatch(humanText(block), new RegExp(code, "u"));
  assert.deepEqual(findForbiddenHumanGuidanceTerms(block), []);
  assert.equal(assertHumanGuidancePlainLanguage(block), block);
  assert.equal(typeof block.result, "string");
  assert.equal(typeof block.impact, "string");
  assert.equal(typeof block.required_decision, "string");
  assert.equal(typeof block.protection_boundary, "string");
  assert.equal(typeof block.next_action, "string");
  assert.equal(typeof block.details, "object");
}

test("explains an Italian requirement ceiling without treating it as delivery authority", () => {
  const guidance = requirementAutonomyCeilingGuidance({
    requirement_id: "REQ-1",
    profile_id: "AUT-REQ-1",
    status: "approved",
    autonomy_ceiling: "bounded-autonomous",
    effective_level: "checkpointed",
    authority_mode: "audit_only",
    reason_codes: ["requirement.authority.audit_only_caps_autonomy"],
  }, { locale: "it" });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.result, /opzione più indipendente disponibile/u);
  assert.match(guidance.result, /completare una sola consegna/u);
  assert.match(guidance.impact, /Per ogni pull request o rilascio locale deciderai separatamente/u);
  assert.match(guidance.impact, /momenti di revisione che abbiamo concordato/u);
  assert.match(guidance.impact, /non può dimostrare autonomamente chi l’ha data/u);
  assert.match(guidance.required_decision, /Per ogni pull request o rilascio locale scegli separatamente/u);
  assert.match(guidance.protection_boundary, /da solo, non approva alcun lavoro/u);
  assert.match(guidance.protection_boundary, /Merge, distribuzione, accesso alla produzione, segreti/u);
  assert.match(guidance.next_action, /scelta valida una sola volta/u);
  assert.equal(guidance.details.autonomy_ceiling, "bounded-autonomous");
  assert.equal(guidance.details.effective_level, "checkpointed");
  assert.equal(guidance.details.authority_mode, "audit_only");
  assert.equal(guidance.details.narrowed, true);
  assert.throws(() => { guidance.details.narrowed = false; }, TypeError);
});

test("explains audit-only narrowing on a proposal bound to one PR and no executed merge", () => {
  const guidance = deliveryAutonomyProposalGuidance({
    id: "AUT-DEL-184",
    status: "proposed",
    delivery_kind: "pull_request",
    project_name: "Travel Operations",
    repository: "github.com/example/travel-operations",
    base_branch: "main",
    head_branch: "codex/human-guidance",
    allowed_write_paths: ["lib", "test"],
    review_moments: ["pull_request.merge", "deploy.remote"],
    expires_at: "2099-12-31T23:59:00.000Z",
    requested_level: "bounded-autonomous",
    authority_assurance: { mode: "audit_only" },
    pull_request_target: {
      pr_url: "https://github.example/pr/184",
      merge_allowed: true,
    },
    reason_codes: ["delivery.authority.audit_only_caps_autonomy"],
  }, { locale: "en" });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.result, /working choice .* ready for your review/u);
  assert.match(guidance.impact, /^You chose full autonomy within the agreed limits\./u);
  assert.match(guidance.impact, /can use only autonomy with checks/u);
  assert.match(guidance.impact, /cannot digitally verify who gave it/u);
  assert.match(guidance.impact, /project “Travel Operations”/u);
  assert.match(guidance.impact, /destination is “codex\/human-guidance” in repository “github\.com\/example\/travel-operations”, starting from “main”/u);
  assert.match(guidance.impact, /change only “lib” and “test”/u);
  assert.match(guidance.required_decision, /For this pull request, how independently should I work\?/u);
  assert.match(guidance.required_decision, /1\. Guided: I ask for confirmation before important steps/u);
  assert.match(guidance.required_decision, /2\. Autonomy with checks: I proceed independently/u);
  assert.match(guidance.required_decision, /3\. Full autonomy within these limits: I complete this pull request/u);
  assert.match(guidance.required_decision, /applies only to this pull request and will not be reused/u);
  assert.match(guidance.required_decision, /before the pull request is merged and before anything is deployed outside the local machine/u);
  assert.match(guidance.required_decision, /expires on December 31, 2099/u);
  assert.match(guidance.protection_boundary, /only to the identified pull request/u);
  assert.match(guidance.protection_boundary, /this choice has not merged anything/u);
  assert.match(guidance.protection_boundary, /production access, secrets/u);
  assert.equal(guidance.details.requested_level, "bounded-autonomous");
  assert.equal(guidance.details.effective_level, "checkpointed");
  assert.equal(guidance.details.effective_level_inferred, true);
  assert.equal(guidance.details.single_delivery, true);
  assert.equal(guidance.details.reusable_for_another_delivery, false);
  assert.equal(guidance.details.merge_executed, false);
  assert.equal(guidance.details.project_name, "Travel Operations");
  assert.deepEqual(guidance.details.allowed_write_paths, ["lib", "test"]);
  assert.deepEqual(guidance.details.review_moments, ["pull_request.merge", "deploy.remote"]);
  assert.equal(guidance.details.expires_at, "2099-12-31T23:59:00.000Z");
  assert.deepEqual(guidance.details.choice_mapping, {
    guided: "supervised",
    autonomy_with_checks: "checkpointed",
    full_autonomy_within_limits: "bounded-autonomous",
  });
  assert.match(guidance.details.digital_approver_verification.enable_with.join("\n"), /host-receipt-file/u);
});

test("describes an Italian local-release proposal with its real boundary before technical details", () => {
  const guidance = deliveryAutonomyProposalGuidance({
    profile_id: "AUT-LOCAL-UX",
    status: "proposed",
    delivery_kind: "local_release",
    project_name: "Operazioni di viaggio",
    target_root: "/opt/travel-operations/local-release",
    smoke_cwd: "/opt/travel-operations/local-release/app",
    allowed_write_paths: [
      "/opt/travel-operations/local-release/app",
      "/opt/travel-operations/local-release/config",
    ],
    review_moments: ["release.local"],
    expires_at: "2099-12-31T23:59:00.000Z",
    requested_level: "checkpointed",
    effective_level: "checkpointed",
    authority_mode: "audit_only",
  }, { locale: "it" });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.impact, /progetto “Operazioni di viaggio”/u);
  assert.match(guidance.impact, /cartella locale “\/opt\/travel-operations\/local-release”/u);
  assert.match(guidance.impact, /Può essere assente finché la consegna è solo in pianificazione/u);
  assert.match(
    guidance.impact,
    /prima di rollback\.verify, data\.migrate, data\.rollback o release\.local deve esistere come cartella reale/u,
  );
  assert.match(guidance.impact, /prima richiesta l’autorizzazione della build locale esatta/u);
  assert.match(guidance.impact, /strumento esterno può creare quella root e i figli approvati/u);
  assert.match(guidance.impact, /CLI non crea mai la cartella da solo/u);
  assert.match(guidance.impact, /“\/opt\/travel-operations\/local-release\/app” e “\/opt\/travel-operations\/local-release\/config”/u);
  assert.match(guidance.impact, /smoke test parte da “\/opt\/travel-operations\/local-release\/app”/u);
  assert.match(guidance.impact, /un controllo portabile non deve dipendere da listener o connessioni/u);
  assert.match(guidance.impact, /verificato il gestore direttamente nel processo/u);
  assert.match(guidance.impact, /entrypoint esplicito deve restare nell'artefatto/u);
  assert.match(guidance.impact, /non attesta gli import transitivi.*codice revisionato/u);
  assert.match(guidance.required_decision, /prima di completare il rilascio locale/u);
  assert.match(guidance.required_decision, /scade il 31 dicembre 2099/u);
  assert.match(guidance.required_decision, /Per questo rilascio locale, quanto vuoi che lavori in autonomia\?/u);
  assert.match(guidance.required_decision, /1\. Guidato: ti chiedo conferma prima dei passaggi importanti/u);
  assert.match(guidance.required_decision, /2\. Autonomia con controlli: procedo da solo/u);
  assert.match(guidance.required_decision, /3\. Autonomia completa entro questi limiti: completo questo rilascio locale senza pause ordinarie/u);
  assert.match(guidance.required_decision, /Questa scelta vale solo per questo rilascio locale e non sarà riutilizzata/u);
  assert.doesNotMatch(guidance.required_decision, /Per questa PR|PR o rilascio locale/u);
  assert.equal(guidance.details.target_root, "/opt/travel-operations/local-release");
  assert.equal(guidance.details.smoke_cwd, "/opt/travel-operations/local-release/app");
  assert.deepEqual(guidance.details.smoke_execution_boundary, {
    schema_version: "local-smoke-execution-boundary:v1",
    provider: "host_specific",
    provider_available: null,
    filesystem_writes: "denied",
    readable_files: "host_account_scope",
    confidentiality_isolation: "not_provided",
    transitive_code_attestation: "not_provided",
    external_network: "denied",
    loopback_network: "host_specific_isolated",
    listener_based_smoke: "not_portable",
    reviewed_code_required: true,
    explicit_entrypoint_binding: "artifact_manifest_bound",
    portable_recommendation: "do_not_depend_on_network_or_listeners",
    recommended_patterns: [
      "exercise an exported API handler in-process",
      "validate built artifact files without opening sockets",
    ],
  });
  assert.deepEqual(guidance.details.review_moments, ["release.local"]);
  assert.equal(guidance.details.expires_at, "2099-12-31T23:59:00.000Z");
  assert.doesNotMatch(guidance.impact, /Attenzione:/u);
});

test("warns in the primary proposal text when a local destination is visible to Git", () => {
  const input = {
    status: "proposed",
    delivery_kind: "local_release",
    project_name: "Operazioni di viaggio",
    target_root: "/opt/travel-operations",
    smoke_cwd: "/opt/travel-operations/.local-release/app",
    allowed_write_paths: ["/opt/travel-operations/.local-release/app"],
    destinations_visible_to_git: [".local-release/app"],
    requested_level: "checkpointed",
    effective_level: "checkpointed",
    authority_mode: "audit_only",
  };
  const italian = deliveryAutonomyProposalGuidance(input, { locale: "it" });
  assertHumanGuidancePlainLanguage(italian, { locale: "it" });
  assert.match(
    italian.impact,
    /Attenzione: “\.local-release\/app” si trova nel repository e Git non la ignora/u,
  );
  assert.match(italian.impact, /Aggiungi la cartella a \.gitignore oppure scegli una destinazione fuori dal repository/u);
  const english = deliveryAutonomyProposalGuidance(input, { locale: "en" });
  assertHumanGuidancePlainLanguage(english, { locale: "en" });
  assert.match(english.impact, /Warning: “\.local-release\/app” is inside the repository and not ignored by Git/u);
  assert.match(english.impact, /files the app writes there later make that check fail/u);
});

test("explains a host-verified approval while keeping merge a separate unexecuted action", () => {
  const guidance = deliveryAutonomyApprovalGuidance({
    profile_id: "AUT-DEL-9",
    status: "active",
    delivery_kind: "pull_request",
    requested_level: "bounded-autonomous",
    effective_level: "bounded-autonomous",
    authority_mode: "host_verified",
    authority_verified: true,
    merge_allowed: true,
    merge_executed: false,
  }, { locale: "it" });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.result, /approvata e attiva/u);
  assert.match(guidance.impact, /conferma firmata/u);
  assert.match(guidance.required_decision, /Ora non serve alcuna decisione/u);
  assert.match(guidance.protection_boundary, /soltanto per la pull request identificata/u);
  assert.match(guidance.protection_boundary, /decisione separata/u);
  assert.match(guidance.next_action, /non ha eseguito alcun merge/u);
  assert.equal(guidance.details.authority_mode, "host_verified");
  assert.equal(guidance.details.authority_verified, true);
  assert.equal(guidance.details.merge_allowed, true);
  assert.equal(guidance.details.merge_executed, false);
});

test("reports active and terminal delivery status with an explicit single-delivery boundary", () => {
  const active = deliveryAutonomyStatusGuidance({
    status: "active",
    delivery_kind: "pull_request",
    requested_level: "checkpointed",
    effective_level: "checkpointed",
    authority_mode: "audit_only",
  });
  assertCanonicalCodesOnlyInDetails(active);
  assert.match(active.result, /active for one pull request/u);
  assert.match(active.required_decision, /No decision is needed now/u);
  assert.match(active.protection_boundary, /cannot be reused/u);

  const closed = deliveryAutonomyStatusGuidance({
    status: "merged",
    delivery_kind: "pull_request",
    requested_level: "checkpointed",
    effective_level: "checkpointed",
    authority_mode: "audit_only",
    merge_executed: true,
  });
  assertCanonicalCodesOnlyInDetails(closed);
  assert.match(closed.result, /closed and cannot be reused/u);
  assert.match(closed.required_decision, /Decide a new one-time working choice/u);
  assert.match(closed.next_action, /Create and approve a new one-delivery choice/u);
  assert.equal(closed.details.merge_executed, true);
});

test("uses the exact Italian downgrade explanation before optional technical details", () => {
  const guidance = deliveryAutonomyStatusGuidance({
    status: "active",
    delivery_kind: "pull_request",
    requested_level: "bounded-autonomous",
    effective_level: "checkpointed",
    authority_mode: "audit_only",
  }, { locale: "it" });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(
    guidance.impact,
    /^Hai scelto autonomia completa entro i limiti concordati\. In questa installazione posso però usare soltanto autonomia con controlli, perché il sistema registra l'approvazione ma non può verificare digitalmente chi l'ha data\.$/u,
  );
  assert.equal(guidance.details.digital_approver_verification.current_effect.includes("checkpointed"), true);
  assert.match(guidance.details.digital_approver_verification.enable_with.join("\n"), /authority_policy\.mode.*host_verified/u);
});

test("distinguishes audit-only and host-verified action checkpoints without executing merge", () => {
  const audit = actionCheckpointGuidance({
    status: "checkpoint_required",
    action: "pull_request.merge",
    authority_mode: "audit_only",
    merge_executed: false,
  }, { locale: "en" });
  assertCanonicalCodesOnlyInDetails(audit);
  assert.match(audit.result, /paused before execution/u);
  assert.match(audit.impact, /cannot independently verify the approver/u);
  assert.match(audit.required_decision, /Confirm whether I may run this exact operation/u);
  assert.match(audit.protection_boundary, /only the displayed operation and target/u);
  assert.match(audit.next_action, /No merge has been performed/u);
  assert.equal(audit.details.action, "pull_request.merge");
  assert.equal(audit.details.host_receipt_required, false);
  assert.equal(audit.details.execution_performed, false);

  const localRelease = actionCheckpointGuidance({
    status: "checkpoint_required",
    action: "release.local",
    authority_mode: "audit_only",
    target_root: "/opt/travel-operations/local-release",
    smoke_cwd: "/opt/travel-operations/local-release/app",
    smoke_tests: ['["node","test/smoke.mjs"]'],
    rollback: "Restore the previous release snapshot.",
  }, { locale: "en" });
  assertCanonicalCodesOnlyInDetails(localRelease);
  assert.match(
    localRelease.required_decision,
    /Exact local-release boundary: target “\/opt\/travel-operations\/local-release”/u,
  );
  assert.match(localRelease.required_decision, /node.*test\/smoke\.mjs/u);
  assert.match(localRelease.required_decision, /smoke working directory “\/opt\/travel-operations\/local-release\/app”/u);
  assert.match(localRelease.required_decision, /Restore the previous release snapshot/u);
  assert.equal(localRelease.details.target_root, "/opt/travel-operations/local-release");
  assert.equal(localRelease.details.smoke_cwd, "/opt/travel-operations/local-release/app");
  assert.deepEqual(localRelease.details.smoke_tests, ['["node","test/smoke.mjs"]']);
  assert.equal(localRelease.details.rollback, "Restore the previous release snapshot.");

  const dataMigration = actionCheckpointGuidance({
    status: "checkpoint_required",
    action: "data.migrate",
    authority_mode: "audit_only",
    data_target: "/opt/travel-operations/local-data/store.json",
    data_scopes: ["records[*].schemaVersion"],
    backup_path: "/opt/travel-operations/local-data/store.before.json",
    preview_evidence: ["evidence/migration-preview.json"],
    rollback: "Restore store.json from store.before.json.",
  }, { locale: "en" });
  assert.match(dataMigration.result, /previewed local data migration/u);
  assert.match(dataMigration.required_decision, /Exact reversible-data boundary/u);
  assert.match(dataMigration.required_decision, /records\[\*\]\.schemaVersion/u);
  assert.match(dataMigration.required_decision, /store\.before\.json/u);
  assert.deepEqual(dataMigration.details.data_scopes, ["records[*].schemaVersion"]);
  assert.equal(
    dataMigration.details.backup_path,
    "/opt/travel-operations/local-data/store.before.json",
  );

  const rollbackVerification = actionCheckpointGuidance({
    status: "checkpoint_required",
    action: "rollback.verify",
    authority_mode: "audit_only",
    target_root: "/opt/travel-operations/local-release",
    rollback: "Restore the previous release snapshot.",
    rollback_evidence: ["evidence/rollback-rehearsal.json"],
  }, { locale: "en" });
  assert.match(rollbackVerification.result, /verify the exact local rollback evidence/u);
  assert.match(rollbackVerification.required_decision, /Exact rollback-verification boundary/u);
  assert.match(rollbackVerification.required_decision, /rollback-rehearsal\.json/u);
  assert.deepEqual(
    rollbackVerification.details.rollback_evidence,
    ["evidence/rollback-rehearsal.json"],
  );

  const verified = actionCheckpointGuidance({
    status: "checkpoint_required",
    action: "pull_request.merge",
    authority_mode: "host_verified",
    host_receipt_required: true,
    merge_executed: false,
  }, { locale: "it" });
  assertCanonicalCodesOnlyInDetails(verified);
  assert.match(verified.impact, /conferma firmata/u);
  assert.match(verified.required_decision, /Fornisci la conferma firmata/u);
  assert.match(verified.next_action, /Fornisci la conferma firmata/u);
  assert.match(verified.next_action, /Nessun merge è stato eseguito/u);
  assert.equal(verified.details.host_receipt_required, true);

  const authorized = actionCheckpointGuidance({
    status: "authorized",
    action: "pull_request.merge",
    authority_mode: "host_verified",
    authority_verified: true,
    merge_executed: false,
  }, { locale: "en" });
  assertCanonicalCodesOnlyInDetails(authorized);
  assert.match(authorized.result, /authorized, but it has not been executed/u);
  assert.match(authorized.impact, /signed approval has been verified/u);
  assert.match(authorized.required_decision, /No further approval is needed/u);
  assert.match(authorized.next_action, /^Run only the exact displayed operation/u);
  assert.doesNotMatch(authorized.next_action, /Provide|Confirm/u);
});

test("keeps ID-bearing technical action boundaries out of primary guidance and exact in details", () => {
  const migrationInput = {
    status: "checkpoint_required",
    action: "data.migrate",
    authority_mode: "audit_only",
    data_target: "/opt/travel-operations/st-demo/store.json",
    data_scopes: ["records.st-demo.schemaVersion"],
    backup_path: "/opt/travel-operations/st-demo/store.before.json",
    preview_evidence: ["evidence/st-demo-migration-preview.json"],
    rollback: "Restore st-demo from its approved backup.",
  };
  const dataMigration = actionCheckpointGuidance(migrationInput, { locale: "en" });

  assertCanonicalCodesOnlyInDetails(dataMigration);
  assert.doesNotMatch(humanText(dataMigration), /st-demo/iu);
  assert.match(
    dataMigration.required_decision,
    /approved preview evidence file listed in the optional technical details/u,
  );
  assert.deepEqual(dataMigration.details.data_scopes, migrationInput.data_scopes);
  assert.deepEqual(dataMigration.details.preview_evidence, migrationInput.preview_evidence);
  assert.equal(dataMigration.details.data_target, migrationInput.data_target);
  assert.equal(dataMigration.details.backup_path, migrationInput.backup_path);
  assert.equal(dataMigration.details.rollback, migrationInput.rollback);

  const rollbackInput = {
    status: "checkpoint_required",
    action: "rollback.verify",
    authority_mode: "audit_only",
    target_root: "/opt/travel-operations/St-Rollback-Demo/release",
    rollback: "Restore the St-Rollback-Demo release snapshot.",
    rollback_evidence: ["evidence/St-Rollback-Demo-rehearsal.json"],
  };
  const rollbackVerification = actionCheckpointGuidance(rollbackInput, { locale: "en" });

  assertCanonicalCodesOnlyInDetails(rollbackVerification);
  assert.doesNotMatch(humanText(rollbackVerification), /st-rollback-demo/iu);
  assert.match(
    rollbackVerification.required_decision,
    /approved rollback evidence file listed in the optional technical details/u,
  );
  assert.equal(rollbackVerification.details.target_root, rollbackInput.target_root);
  assert.equal(rollbackVerification.details.rollback, rollbackInput.rollback);
  assert.deepEqual(
    rollbackVerification.details.rollback_evidence,
    rollbackInput.rollback_evidence,
  );

  const releaseInput = {
    status: "checkpoint_required",
    action: "release.local",
    authority_mode: "audit_only",
    target_root: "/opt/travel-operations/sT-Local-Demo/release",
    smoke_cwd: "/opt/travel-operations/sT-Local-Demo/release/app",
    smoke_tests: ['["node","test/sT-Local-Demo-smoke.mjs"]'],
    rollback: "Restore the sT-Local-Demo release snapshot.",
  };
  const localRelease = actionCheckpointGuidance(releaseInput, { locale: "en" });

  assertCanonicalCodesOnlyInDetails(localRelease);
  assert.doesNotMatch(humanText(localRelease), /st-local-demo/iu);
  assert.match(
    localRelease.required_decision,
    /approved smoke command listed in the optional technical details/u,
  );
  assert.equal(localRelease.details.target_root, releaseInput.target_root);
  assert.equal(localRelease.details.smoke_cwd, releaseInput.smoke_cwd);
  assert.deepEqual(localRelease.details.smoke_tests, releaseInput.smoke_tests);
  assert.equal(localRelease.details.rollback, releaseInput.rollback);
});

test("does not mistake ordinary words containing an ID-like substring for internal identifiers", () => {
  const input = {
    status: "checkpoint_required",
    action: "release.local",
    authority_mode: "audit_only",
    target_root: "/opt/travel-operations/first-demo/release",
    smoke_cwd: "/opt/travel-operations/first-demo/release/app",
    smoke_tests: ['["node","test/first-demo-smoke.mjs"]'],
    rollback: "Restore the first-demo release snapshot.",
  };
  const guidance = actionCheckpointGuidance(input, { locale: "en" });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.required_decision, /first-demo\/release/u);
  assert.match(guidance.required_decision, /first-demo-smoke\.mjs/u);
  assert.match(guidance.required_decision, /Restore the first-demo release snapshot/u);
});

test("fails closed in human status when an active delivery cannot be evaluated", () => {
  const guidance = deliveryAutonomyStatusGuidance({
    status: "needs_repair",
    delivery_kind: "pull_request",
    requested_level: "bounded-autonomous",
    effective_level: "supervised",
    authority_mode: "host_verified",
    reason_codes: ["autonomy_profile_evaluation_failed"],
  });
  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.result, /needs repair and cannot be used now/u);
  assert.match(guidance.impact, /pause before changing anything important and ask you/u);
  assert.match(guidance.required_decision, /Review and approve corrected limits/u);
  assert.match(guidance.next_action, /Correct and reapprove/u);
  assert.equal(guidance.details.effective_level, "supervised");
});

test("never presents unverified host authority as effective full autonomy", () => {
  const guidance = deliveryAutonomyStatusGuidance({
    status: "active",
    delivery_kind: "pull_request",
    requested_level: "bounded-autonomous",
    effective_level: "bounded-autonomous",
    authority_mode: "host_verified",
    authority_verified: false,
  });
  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.impact, /pause before changing anything important and ask you/u);
  assert.match(guidance.impact, /needs a signed confirmation/u);
  assert.doesNotMatch(guidance.impact, /finish one delivery/u);
  assert.equal(guidance.details.effective_level, "supervised");
  assert.equal(guidance.details.authority_verified, false);
});

test("explains passed and failed gates without leaking canonical blocker codes", () => {
  const passed = gateGuidance({
    status: "passed",
    scope: "story",
    merge_executed: false,
    warnings: ["gate.optional_evidence_missing"],
  }, { locale: "en" });
  assertCanonicalCodesOnlyInDetails(passed);
  assert.match(passed.result, /without a blocking issue/u);
  assert.match(passed.impact, /did not change, release, deploy, or merge anything/u);
  assert.match(passed.required_decision, /Decide whether to start the next step/u);
  assert.match(passed.protection_boundary, /did not approve or perform/u);
  assert.deepEqual(passed.details.warnings, ["gate.optional_evidence_missing"]);

  const intermediate = gateGuidance({
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: false,
    certification_level: "strict_intermediate",
  });
  assert.match(intermediate.result, /not a final lifecycle certification/u);
  assert.match(intermediate.next_action, /run the final lifecycle check explicitly/u);
  assert.equal(intermediate.details.lifecycle_complete, false);

  const final = gateGuidance({
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: true,
    certification_level: "lifecycle_complete",
  }, { locale: "it" });
  assert.match(final.result, /controllo completo del ciclo di vita è superato/u);
  assert.match(final.impact, /Tutte le fasi configurate/u);
  assert.equal(final.details.lifecycle_complete, true);
  assert.equal(final.details.certification_level, "lifecycle_complete");

  const failed = gateGuidance({
    status: "failed",
    errors: ["baseline.source_stale", "contract.approval_missing"],
    next_command: "agentic-sdlc gate check --strict",
  }, { locale: "it" });
  assertCanonicalCodesOnlyInDetails(failed);
  assert.match(failed.result, /2 blocco\/i/u);
  assert.match(failed.required_decision, /Non serve ancora un via libera/u);
  assert.doesNotMatch(humanText(failed), /baseline\.source_stale/u);
  assert.deepEqual(failed.details.errors, ["baseline.source_stale", "contract.approval_missing"]);
  assert.equal(failed.details.next_command, "agentic-sdlc gate check --strict");
});

test("supports localized message overrides without changing the block contract", () => {
  const guidance = createHumanGuidance({
    locale: "en-US",
    messages: {
      "gate.result.passed": "CUSTOM RESULT",
      "gate.impact.passed": "CUSTOM IMPACT",
      "gate.next.passed": "CUSTOM NEXT",
    },
  }).gate({ status: "passed" });
  assert.deepEqual(
    {
      result: guidance.result,
      impact: guidance.impact,
      required_decision: guidance.required_decision,
      protection_boundary: guidance.protection_boundary,
      next_action: guidance.next_action,
    },
    {
      result: "CUSTOM RESULT",
      impact: "CUSTOM IMPACT",
      required_decision: "Decide whether to start the next step; a protected step still needs its own approval.",
      protection_boundary: "These checks did not approve or perform a change, merge, release, deployment, production access, secret access, or work outside the approved files.",
      next_action: "CUSTOM NEXT",
    },
  );
  assert.throws(() => createHumanGuidance({ locale: "fr" }), /Unsupported/u);
});

test("builds an exact frozen additive block and keeps technical identifiers in details", () => {
  const guidance = buildHumanGuidance({
    locale: "en",
    result: "The working choice is ready.",
    impact: "No files have changed yet.",
    requiredDecision: "Decide whether these limits are correct for this one pull request.",
    protectionBoundary: "Merging, deployment, production access, secrets, and later work remain separate.",
    nextAction: "Approve the choice or correct its limits.",
    details: {
      profile_id: "AUT-PR-42",
      requested_level: "bounded-autonomous",
      authority_mode: "audit_only",
    },
  });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.equal(Object.isFrozen(guidance), true);
  assert.equal(Object.isFrozen(guidance.details), true);
  assert.equal(guidance.details.profile_id, "AUT-PR-42");
  assert.throws(() => { guidance.details.profile_id = "AUT-PR-43"; }, TypeError);
  assert.throws(() => buildHumanGuidance({
    result: "The bounded-autonomous profile is ready.",
    impact: "No files changed.",
    requiredDecision: "Approve it.",
    protectionBoundary: "Only this work is covered.",
    nextAction: "Continue.",
  }), /internal terminology/u);
  assert.throws(() => buildHumanGuidance({
    result: "The work for st-demo is ready.",
    impact: "No files changed.",
    requiredDecision: "Approve it.",
    protectionBoundary: "Only this work is covered.",
    nextAction: "Continue.",
  }), /internal terminology/u);
  assert.throws(() => buildHumanGuidance({
    result: "The work for St-DeMo is ready.",
    impact: "No files changed.",
    requiredDecision: "Approve it.",
    protectionBoundary: "Only this work is covered.",
    nextAction: "Continue.",
  }), /internal terminology/u);
});

test("renders golden English and Italian journeys with jargon only after the technical divider", () => {
  const english = deliveryAutonomyProposalGuidance({
    profile_id: "AUT-PR-ENT-UX",
    status: "proposed",
    delivery_kind: "pull_request",
    requested_level: "bounded-autonomous",
    authority_mode: "audit_only",
    merge_allowed: false,
  }, { locale: "en" });
  const englishText = renderHumanGuidanceText(english, {
    locale: "en",
    detailLines: [
      "profile_id=AUT-PR-ENT-UX",
      "requested_level=bounded-autonomous",
      "effective_level=checkpointed",
      "authority_mode=audit_only",
    ],
  });
  const [englishPrimary, englishTechnical] = englishText.split("\nTechnical details (optional):\n");
  assert.match(englishPrimary, /^Outcome: A working choice for one pull request is ready for your review\./u);
  assert.match(englishPrimary, /What you need to decide: For this pull request, how independently should I work\?/u);
  assert.match(englishPrimary, /1\. Guided: I ask for confirmation before important steps/u);
  assert.match(englishPrimary, /This choice applies only to this pull request and will not be reused/u);
  assert.match(englishPrimary, /What remains protected: This choice applies only to the identified pull request/u);
  assert.deepEqual(findForbiddenHumanGuidanceTerms(englishPrimary), []);
  assert.match(englishTechnical, /AUT-PR-ENT-UX/u);
  assert.match(englishTechnical, /bounded-autonomous/u);
  assert.match(englishTechnical, /audit_only/u);

  const italian = requirementAutonomyCeilingGuidance({
    requirement_id: "REQ-ENTERPRISE-001",
    status: "approved",
    autonomy_ceiling: "bounded-autonomous",
    effective_level: "checkpointed",
    authority_mode: "audit_only",
  }, { locale: "it" });
  const italianText = renderHumanGuidanceText(italian, {
    locale: "it",
    detailLines: [
      "requirement_id=REQ-ENTERPRISE-001",
      "autonomy_ceiling=bounded-autonomous",
      "effective_level=checkpointed",
      "authority_mode=audit_only",
    ],
  });
  const [italianPrimary, italianTechnical] = italianText.split("\nDettagli tecnici (facoltativi):\n");
  assert.match(italianPrimary, /^Risultato: Per questo requisito, l’opzione più indipendente/u);
  assert.match(italianPrimary, /Cosa devi decidere: Per ogni pull request o rilascio locale scegli separatamente/u);
  assert.match(italianPrimary, /Cosa resta protetto: Questo requisito, da solo, non approva alcun lavoro/u);
  assert.deepEqual(findForbiddenHumanGuidanceTerms(italianPrimary), []);
  assert.match(italianTechnical, /REQ-ENTERPRISE-001/u);
  assert.match(italianTechnical, /bounded-autonomous/u);
  assert.match(italianTechnical, /audit_only/u);
});

test("provides a localized generic error without leaking the machine cause", () => {
  const guidance = genericErrorGuidance({
    error_code: "contract.profile_hash_mismatch",
    cause: "profile AUT-PR-42 has stale schema hash",
    reason_codes: ["profile.source_stale"],
  }, { locale: "it" });

  assertCanonicalCodesOnlyInDetails(guidance);
  assert.match(guidance.result, /Non è stato possibile completare/u);
  assert.match(guidance.impact, /non è stato modificato altro/u);
  assert.doesNotMatch(humanText(guidance), /profile|schema|hash|AUT-PR-42/u);
  assert.equal(guidance.details.error_code, "contract.profile_hash_mismatch");
  assert.equal(guidance.details.cause, "profile AUT-PR-42 has stale schema hash");
});
