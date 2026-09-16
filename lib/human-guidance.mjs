import { AUTONOMY_LEVELS } from "./autonomy-policy.mjs";

const SUPPORTED_LOCALES = new Set(["en", "it"]);
const LEVELS = new Set(AUTONOMY_LEVELS);

export const HUMAN_GUIDANCE_FIELDS = Object.freeze([
  "result",
  "impact",
  "required_decision",
  "protection_boundary",
  "next_action",
  "details",
]);

const PRIMARY_TEXT_FIELDS = Object.freeze(HUMAN_GUIDANCE_FIELDS.filter((field) => field !== "details"));
const TECHNICAL_DIVIDERS = Object.freeze({
  en: "Technical details (optional):",
  it: "Dettagli tecnici (facoltativi):",
});
const OUTPUT_LABELS = Object.freeze({
  en: Object.freeze({
    result: "Outcome",
    impact: "What this changes in practice",
    required_decision: "What you need to decide",
    protection_boundary: "What remains protected",
    next_action: "Next step",
  }),
  it: Object.freeze({
    result: "Risultato",
    impact: "Cosa cambia in pratica",
    required_decision: "Cosa devi decidere",
    protection_boundary: "Cosa resta protetto",
    next_action: "Prossimo passo",
  }),
});

// These expressions protect the primary explanation from internal vocabulary.
// Stable codes and identifiers remain available in `details` for automation and audit.
const FORBIDDEN_PRIMARY_PATTERNS = Object.freeze([
  Object.freeze({ label: "bounded-autonomous", pattern: /\bbounded[-_ ]autonomous\b/iu }),
  Object.freeze({ label: "checkpoint", pattern: /\bcheckpoint(?:ed|s)?\b/iu }),
  Object.freeze({ label: "audit_only", pattern: /\baudit[-_ ]only\b/iu }),
  Object.freeze({ label: "host_verified", pattern: /\bhost[-_ ]verified\b/iu }),
  Object.freeze({ label: "profile", pattern: /\bprofiles?\b|\bprofil[oi]\b/iu }),
  Object.freeze({ label: "receipt", pattern: /\breceipts?\b|\bricevut[ae]\b/iu }),
  Object.freeze({ label: "ceiling", pattern: /\bceiling\b|\btetto\b/iu }),
  Object.freeze({ label: "schema", pattern: /\bschemas?\b/iu }),
  Object.freeze({ label: "hash", pattern: /\bhash(?:es)?\b/iu }),
  Object.freeze({ label: "reason code", pattern: /\breason[_ -]?codes?\b|\bcodic[ei] (?:motivo|ragione)\b/iu }),
  // Identifier namespaces are case-insensitive at this presentation boundary;
  // the leading word boundary avoids treating ordinary words such as "first-demo" as IDs.
  Object.freeze({ label: "internal identifier", pattern: /\b(?:REQ|AUT|AUTH|CAP|ST|ACT|PR)-[A-Z0-9][A-Z0-9._-]*\b/iu }),
]);

const DELIVERY_REVIEW_MESSAGE_KEYS = Object.freeze({
  "contract.approve": "delivery.proposal.review.contract",
  "task.start.confirm": "delivery.proposal.review.start",
  "story.claim": "delivery.proposal.review.claim",
  "story.complete-step": "delivery.proposal.review.complete",
  "output.link": "delivery.proposal.review.output",
  "build.local": "delivery.proposal.review.build",
  "sync.commit": "delivery.proposal.review.commit",
  "git.commit": "delivery.proposal.review.commit",
  "sync.push": "delivery.proposal.review.push",
  "git.push": "delivery.proposal.review.push",
  "sync.pr": "delivery.proposal.review.pr",
  "pull_request.create": "delivery.proposal.review.pr",
  "pull_request.update": "delivery.proposal.review.pr",
  "release.local": "delivery.proposal.review.release",
  "pull_request.merge": "delivery.proposal.review.merge",
  "deploy.remote": "delivery.proposal.review.deploy",
});

const CATALOG = Object.freeze({
  en: Object.freeze({
    "level.supervised": "pause before changing anything important and ask you",
    "level.checkpointed": "continue between the review moments we agreed",
    "level.bounded-autonomous": "finish one delivery within the limits you approved, without routine pauses",
    "level.unknown": "use the most cautious way of working",
    "level.impact.supervised": "I pause before changing anything important and ask you.",
    "level.impact.checkpointed": "I can continue between the review moments we agreed, and I pause again before sensitive or release actions.",
    "level.impact.bounded-autonomous": "I can finish this one delivery within the limits you approved, without routine pauses.",
    "authority.audit": "Your approval is recorded, but this installation cannot independently prove who approved it.",
    "authority.audit.proposed": "If you approve this choice, the approval will be recorded, but this installation will not be able to independently prove who approved it.",
    "authority.verified": "The system or CI supplied a signed confirmation for this exact decision.",
    "authority.required": "To use the requested freedom, this installation needs a signed confirmation from the system or CI. Until then, I will pause at the review moments we agreed.",
    "authority.invalid": "I cannot safely rely on the available approval information, so I will use the most cautious way of working.",
    "requirement.result": "For this requirement, the most independent option available later is that I may {level}.",
    "requirement.impact": "This is only the maximum available choice. For every pull request or local release, you will choose separately how I work, and that choice may be more cautious.",
    "requirement.impact.narrowed": "Right now, even if you choose the maximum, I may only {level}. {authority}",
    "requirement.decision.approved": "For each pull request or local release, choose separately how independently I may work.",
    "requirement.decision.review": "Decide whether this maximum is acceptable for later pull requests or local releases.",
    "requirement.protection": "This requirement alone approves no work. Every pull request or local release needs its own choice. Merging, deployment, production access, secrets, changes outside approved files, and later deliveries remain separate.",
    "requirement.next.approved": "When the next pull request or local release is created, record its one-time working choice before material work starts.",
    "requirement.next.review": "Review and approve the requirement boundary before choosing how I may work on a delivery.",
    "delivery.pull_request": "one pull request",
    "delivery.local_release": "one local release",
    "delivery.unknown": "one delivery",
    "delivery.scope.pr": "This choice applies only to the identified pull request and ends when it is merged, closed, or cancelled; it cannot be reused for another pull request.",
    "delivery.scope.local": "This choice applies only to the identified local release and ends when it is released, rolled back, or cancelled; it cannot be reused for another release.",
    "delivery.scope.generic": "This choice applies only to the identified delivery and cannot be reused for another delivery.",
    "delivery.merge.outside": "Merging is not included in this choice and has not happened.",
    "delivery.merge.separate": "Merging is allowed only after a separate check for that exact action; this choice has not merged anything.",
    "delivery.merge.done": "The recorded merge action is complete.",
    "delivery.protection.common": "Deployment, production access, secrets, changes outside the approved files, and every later delivery need a separate decision.",
    "delivery.proposal.result": "A working choice for {delivery} is ready for your review.",
    "delivery.proposal.impact.narrowed": "You asked me to {requested}. For now, I may only {effective}. {authority}",
    "delivery.proposal.impact.normal": "For this delivery, I may {effective}. {authority}",
    "delivery.full.audit.narrowed": "You chose full autonomy within the agreed limits. In this installation I can use only autonomy with checks, because the system records the approval but cannot digitally verify who gave it.",
    "delivery.choice.question.pr": "For this pull request, how independently should I work?",
    "delivery.choice.question.local": "For this local release, how independently should I work?",
    "delivery.choice.option.supervised": "Guided: I ask for confirmation before important steps.",
    "delivery.choice.option.checkpointed": "Autonomy with checks: I proceed independently, but stop before the sensitive actions we agree.",
    "delivery.choice.option.bounded-autonomous": "Full autonomy within these limits: I complete this pull request without routine pauses.",
    "delivery.choice.option.bounded-autonomous.local": "Full autonomy within these limits: I complete this local release without routine pauses.",
    "delivery.choice.scope.pr": "This choice applies only to this pull request and will not be reused.",
    "delivery.choice.scope.local": "This choice applies only to this local release and will not be reused.",
    "delivery.choice.scope.generic": "This choice applies only to this delivery and will not be reused.",
    "delivery.choice.selected.supervised": "The choice currently shown is Guided.",
    "delivery.choice.selected.checkpointed": "The choice currently shown is Autonomy with checks.",
    "delivery.choice.selected.bounded-autonomous": "The choice currently shown is Full autonomy within these limits.",
    "delivery.proposal.boundary.pr": "This is for project {project}. The destination is {head} in repository {repository}, starting from {base}. I may change only {write_paths}.",
    "delivery.proposal.boundary.local": "This is for project {project}. The destination is the local folder {target_root}. It may be absent while this delivery is only being planned. Before rollback.verify, data.migrate, data.rollback, or release.local it must exist as a real directory. For a new destination, first request the exact local build authorization; only then may the external builder create that root and its approved children, after which the build is completed with evidence. The CLI never creates the directory itself. I may change only {write_paths}, and the smoke test runs from {smoke_cwd}. Its explicit entrypoint must stay inside the artifact; shells, dispatchers, inline code, and ambiguous loaders are rejected. Supported hosts isolate networking differently, so a portable check must not depend on listeners or connections; test an API handler in-process instead. The runner denies file writes and external or host network access, but it can read files available to your account and does not attest transitive imports: use reviewed project code that does not load ungoverned host paths.",
    "delivery.proposal.boundary.generic": "This is for project {project}. The destination and allowed file area are shown below in plain language: {destination}; {write_paths}.",
    "delivery.proposal.value.project": "the current project",
    "delivery.proposal.value.repository": "the selected repository",
    "delivery.proposal.value.head": "the selected pull-request branch",
    "delivery.proposal.value.base": "the selected base branch",
    "delivery.proposal.value.target": "the selected local folder",
    "delivery.proposal.value.destination": "the selected delivery destination",
    "delivery.proposal.value.write_path": "an approved file area listed in the optional technical details",
    "delivery.proposal.value.write_paths_missing": "the approved file area listed in the optional technical details",
    "delivery.proposal.review.none": "No routine review moment is listed, but I must still stop before any separately protected action.",
    "delivery.proposal.review.some": "I must ask you again {review_moments}.",
    "delivery.proposal.review.unknown": "before another protected step listed in the optional technical details",
    "delivery.proposal.review.contract": "before the implementation agreement is approved",
    "delivery.proposal.review.start": "before material work begins",
    "delivery.proposal.review.claim": "before the work is assigned",
    "delivery.proposal.review.complete": "before a work stage is marked complete",
    "delivery.proposal.review.output": "before implementation evidence is accepted",
    "delivery.proposal.review.build": "before the exact local destination is created or built",
    "delivery.proposal.review.commit": "before a commit is created",
    "delivery.proposal.review.push": "before changes are published",
    "delivery.proposal.review.pr": "before the pull request is created or updated",
    "delivery.proposal.review.release": "before the local release is completed",
    "delivery.proposal.review.merge": "before the pull request is merged",
    "delivery.proposal.review.deploy": "before anything is deployed outside the local machine",
    "delivery.proposal.expiry.at": "This choice expires on {expiry}.",
    "delivery.proposal.expiry.lifecycle.pr": "There is no separate calendar deadline; this choice ends when the pull request is merged, closed, or cancelled.",
    "delivery.proposal.expiry.lifecycle.local": "There is no separate calendar deadline; this choice ends when the local release is completed, rolled back, or cancelled.",
    "delivery.proposal.expiry.lifecycle.generic": "There is no separate calendar deadline; this choice ends when this delivery is completed or cancelled.",
    "delivery.proposal.next": "Confirm the displayed choice if the limits are correct. Otherwise change it before work starts.",
    "delivery.approval.result": "The working choice is approved and active for {delivery}.",
    "delivery.approval.impact": "For this delivery, I may {effective}. {authority}",
    "delivery.approval.decision": "No decision is needed now. I must ask again if the approved limits, destination, risk, or delivery changes.",
    "delivery.approval.next.checkpoint": "Start the delivery within the approved limits and ask for confirmation at the next agreed review moment.",
    "delivery.approval.next.autonomous": "Start and complete this delivery within exactly the limits approved; stop if the work, target, risk, or approval needed changes.",
    "delivery.approval.next.supervised": "Ask for explicit confirmation before starting material work.",
    "delivery.status.proposed": "The working choice has been proposed but is not active yet.",
    "delivery.status.active": "The working choice is active for {delivery}.",
    "delivery.status.terminal": "This working choice is closed and cannot be reused.",
    "delivery.status.invalid": "This working choice needs repair and cannot be used now.",
    "delivery.status.other": "This working choice cannot currently be used.",
    "delivery.status.impact": "For this delivery, I may {effective}. {authority}",
    "delivery.status.impact.invalid": "I could not validate the approved limits, so I must {effective}.",
    "delivery.status.decision.proposed": "Choose or change how I should work for this delivery before work starts.",
    "delivery.status.decision.active": "No decision is needed now. I must ask again if the approved limits, destination, risk, or delivery changes.",
    "delivery.status.decision.terminal": "Decide a new one-time working choice before any later delivery.",
    "delivery.status.decision.invalid": "Review and approve corrected limits before work continues.",
    "delivery.status.next.proposed": "Review and approve the exact delivery boundary before work starts.",
    "delivery.status.next.active": "Continue only within the approved limits and pause at every agreed review moment.",
    "delivery.status.next.terminal": "Create and approve a new one-delivery choice before any further delivery.",
    "delivery.status.next.invalid": "Correct and reapprove the exact project, version, files, actions, or approval information before continuing.",
    "action.repository.write": "change files inside the approved write set",
    "action.test.run": "run the approved tests",
    "action.git.commit": "create the exact reviewed commit",
    "action.git.push": "push the approved commit range",
    "action.pull_request.create": "create the identified pull request",
    "action.pull_request.update": "update the identified pull request",
    "action.pull_request.merge": "merge the identified pull request",
    "action.build.local": "build the approved local release",
    "action.data.migrate": "apply the exact previewed local data migration",
    "action.data.rollback": "restore the exact local data backup",
    "action.rollback.verify": "verify the exact local rollback evidence",
    "action.release.local": "complete the approved local release",
    "action.unknown": "perform the requested operation",
    "checkpoint.result.required": "The operation to {action} is paused before execution.",
    "checkpoint.result.authorized": "The operation to {action} is authorized, but it has not been executed by this decision.",
    "checkpoint.impact.audit": "An explicit confirmation can be recorded, but the tool cannot independently verify the approver. The operation remains limited to the exact displayed target.",
    "checkpoint.impact.verified": "This operation requires a signed confirmation from the system or CI for the exact action and target.",
    "checkpoint.impact.audit.authorized": "The authorization is recorded for this exact target, but it does not have an independently verified signature. The operation itself has not run.",
    "checkpoint.impact.verified.authorized": "A signed approval has been verified for this exact operation and target. The operation itself has not run.",
    "checkpoint.decision.audit": "Confirm whether I may run this exact operation on the displayed target.",
    "checkpoint.decision.verified": "Provide the signed confirmation from the system or CI for this exact operation.",
    "checkpoint.decision.authorized": "No further approval is needed for this exact operation; it still has to be run and verified.",
    "checkpoint.release.exact": "Exact local-release boundary: target {target}; smoke working directory {smoke_cwd}; smoke test {smoke}; rollback {rollback}.",
    "checkpoint.data.exact": "Exact reversible-data boundary: target {target}; scope {scope}; backup {backup}; preview evidence {preview}; rollback {rollback}.",
    "checkpoint.rollback.exact": "Exact rollback-verification boundary: target {target}; procedure {rollback}; immutable evidence {evidence}.",
    "checkpoint.protection": "This decision covers only the displayed operation and target. Another target, pull request, local release, deployment, production access, secrets, or work outside the shown files needs a separate decision.",
    "checkpoint.next.audit": "Confirm the displayed operation, then let the external tool run it and save proof that it completed.",
    "checkpoint.next.verified": "Provide the signed confirmation for this exact operation, then let the external tool run it and save proof that it completed.",
    "checkpoint.next.authorized": "Run only the exact displayed operation, then save proof that it completed.",
    "checkpoint.merge.pending": "No merge has been performed.",
    "gate.result.passed": "The checks completed without a blocking issue.",
    "gate.result.intermediate.passed": "The current story check passed, but this is not a final lifecycle certification.",
    "gate.result.final.passed": "The complete lifecycle check passed and its final proof is ready.",
    "gate.result.failed": "The checks found {count} blocking issue(s), so work cannot continue yet.",
    "gate.impact.passed": "The recorded limits and proof are consistent enough for the next separately approved step. The check itself did not change, release, deploy, or merge anything.",
    "gate.impact.intermediate.passed": "The evidence recorded so far is consistent, but later phases, tests, or delivery may still be incomplete.",
    "gate.impact.final.passed": "Every configured phase, the latest tests, and the exact delivery are complete and consistent.",
    "gate.impact.failed": "At least one required boundary or piece of evidence is missing, stale, invalid, or inconsistent. No protected action was performed.",
    "gate.decision.passed": "Decide whether to start the next step; a protected step still needs its own approval.",
    "gate.decision.intermediate.passed": "Do not treat this result as final completion; decide only whether to continue with the next approved phase.",
    "gate.decision.final.passed": "No lifecycle decision is pending for this exact delivery.",
    "gate.decision.failed": "No go-ahead is needed yet. The reported blockers must be fixed first.",
    "gate.protection": "These checks did not approve or perform a change, merge, release, deployment, production access, secret access, or work outside the approved files.",
    "gate.next.passed": "Continue only if the next action is within the approved limits and has any separate approval it requires.",
    "gate.next.intermediate.passed": "Complete the remaining phases and delivery, then run the final lifecycle check explicitly.",
    "gate.next.final.passed": "Keep the final proof with the delivery evidence; use a new governed delivery for later work.",
    "gate.next.failed": "Resolve the reported blockers, preserve the evidence, and run the check again before continuing.",
    "generic.error.result": "The operation could not be completed.",
    "generic.error.impact": "Nothing else was changed after the problem was detected.",
    "generic.error.decision": "No decision is needed unless the next step would change the approved limits or target.",
    "generic.error.protection": "The failed operation does not approve a retry, wider access, production access, secrets, or changes outside the approved files.",
    "generic.error.next": "Review the plain-language cause, correct it, and retry only within the approved limits.",
  }),
  it: Object.freeze({
    "level.supervised": "fermarmi prima di ogni modifica importante e chiederti conferma",
    "level.checkpointed": "proseguire tra i momenti di revisione che abbiamo concordato",
    "level.bounded-autonomous": "completare una sola consegna entro i limiti approvati, senza pause ordinarie",
    "level.unknown": "usare il modo di lavorare più prudente",
    "level.impact.supervised": "Mi fermo prima di ogni modifica importante e ti chiedo conferma.",
    "level.impact.checkpointed": "Posso proseguire tra i momenti di revisione concordati e mi fermo di nuovo prima delle azioni sensibili o di rilascio.",
    "level.impact.bounded-autonomous": "Posso completare questa sola consegna entro i limiti che hai approvato, senza pause ordinarie.",
    "authority.audit": "La tua approvazione viene registrata, ma questa installazione non può dimostrare autonomamente chi l’ha data.",
    "authority.audit.proposed": "Se approvi questa scelta, l’approvazione verrà registrata, ma questa installazione non potrà dimostrare autonomamente chi l’ha data.",
    "authority.verified": "Il sistema o la CI hanno fornito una conferma firmata per questa decisione esatta.",
    "authority.required": "Per usare la libertà richiesta, questa installazione deve ricevere una conferma firmata dal sistema o dalla CI. Fino ad allora mi fermerò nei momenti di revisione concordati.",
    "authority.invalid": "Non posso usare in sicurezza le informazioni disponibili sull’approvazione, quindi lavorerò nel modo più prudente.",
    "requirement.result": "Per questo requisito, l’opzione più indipendente disponibile in seguito è che io possa {level}.",
    "requirement.impact": "Questa è solo la scelta massima disponibile. Per ogni pull request o rilascio locale deciderai separatamente come lavorerò, anche in modo più prudente.",
    "requirement.impact.narrowed": "In questo momento, anche scegliendo il massimo, posso soltanto {level}. {authority}",
    "requirement.decision.approved": "Per ogni pull request o rilascio locale scegli separatamente quanto posso lavorare in autonomia.",
    "requirement.decision.review": "Decidi se questo massimo è accettabile per le pull request o i rilasci locali successivi.",
    "requirement.protection": "Questo requisito, da solo, non approva alcun lavoro. Ogni pull request o rilascio locale richiede una scelta propria. Merge, distribuzione, accesso alla produzione, segreti, modifiche fuori dai file approvati e consegne successive restano separati.",
    "requirement.next.approved": "Quando verrà creata la prossima pull request o il prossimo rilascio locale, registra la scelta valida una sola volta prima di iniziare modifiche importanti.",
    "requirement.next.review": "Rivedi e approva i limiti del requisito prima di scegliere come posso lavorare su una consegna.",
    "delivery.pull_request": "una sola pull request",
    "delivery.local_release": "un solo rilascio locale",
    "delivery.unknown": "una sola consegna",
    "delivery.scope.pr": "Questa scelta vale soltanto per la pull request identificata e termina quando viene unita, chiusa o annullata; non può essere riutilizzata per un’altra pull request.",
    "delivery.scope.local": "Questa scelta vale soltanto per il rilascio locale identificato e termina quando viene rilasciato, ripristinato o annullato; non può essere riutilizzata per un altro rilascio.",
    "delivery.scope.generic": "Questa scelta vale soltanto per la consegna identificata e non può essere riutilizzata per un’altra consegna.",
    "delivery.merge.outside": "Il merge non è incluso in questa scelta e non è stato eseguito.",
    "delivery.merge.separate": "Il merge è consentito solo dopo un controllo separato per quell’azione esatta; questa scelta non ha eseguito alcun merge.",
    "delivery.merge.done": "L’azione di merge registrata è completata.",
    "delivery.protection.common": "Distribuzione, accesso alla produzione, segreti, modifiche fuori dai file approvati e qualsiasi consegna successiva richiedono una decisione separata.",
    "delivery.proposal.result": "La scelta del modo di lavorare per {delivery} è pronta per la tua revisione.",
    "delivery.proposal.impact.narrowed": "Mi hai chiesto di {requested}. Per ora posso soltanto {effective}. {authority}",
    "delivery.proposal.impact.normal": "Per questa consegna posso {effective}. {authority}",
    "delivery.full.audit.narrowed": "Hai scelto autonomia completa entro i limiti concordati. In questa installazione posso però usare soltanto autonomia con controlli, perché il sistema registra l'approvazione ma non può verificare digitalmente chi l'ha data.",
    "delivery.choice.question.pr": "Per questa PR, quanto vuoi che lavori in autonomia?",
    "delivery.choice.question.local": "Per questo rilascio locale, quanto vuoi che lavori in autonomia?",
    "delivery.choice.option.supervised": "Guidato: ti chiedo conferma prima dei passaggi importanti.",
    "delivery.choice.option.checkpointed": "Autonomia con controlli: procedo da solo, ma mi fermo prima delle azioni delicate concordate.",
    "delivery.choice.option.bounded-autonomous": "Autonomia completa entro questi limiti: completo questa PR senza pause ordinarie.",
    "delivery.choice.option.bounded-autonomous.local": "Autonomia completa entro questi limiti: completo questo rilascio locale senza pause ordinarie.",
    "delivery.choice.scope.pr": "Questa scelta vale solo per questa PR e non sarà riutilizzata.",
    "delivery.choice.scope.local": "Questa scelta vale solo per questo rilascio locale e non sarà riutilizzata.",
    "delivery.choice.scope.generic": "Questa scelta vale solo per questa consegna e non sarà riutilizzata.",
    "delivery.choice.selected.supervised": "La scelta attualmente indicata è Guidato.",
    "delivery.choice.selected.checkpointed": "La scelta attualmente indicata è Autonomia con controlli.",
    "delivery.choice.selected.bounded-autonomous": "La scelta attualmente indicata è Autonomia completa entro questi limiti.",
    "delivery.proposal.boundary.pr": "Questa scelta riguarda il progetto {project}. La destinazione è {head} nel repository {repository}, partendo da {base}. Posso modificare soltanto {write_paths}.",
    "delivery.proposal.boundary.local": "Questa scelta riguarda il progetto {project}. La destinazione è la cartella locale {target_root}. Può essere assente finché la consegna è solo in pianificazione, ma prima di rollback.verify, data.migrate, data.rollback o release.local deve esistere come cartella reale. Per una nuova destinazione va prima richiesta l’autorizzazione della build locale esatta; solo allora lo strumento esterno può creare quella root e i figli approvati, dopodiché la build viene completata con evidenza. Il CLI non crea mai la cartella da solo. Posso modificare soltanto {write_paths} e lo smoke test parte da {smoke_cwd}. L'entrypoint esplicito deve restare nell'artefatto; shell, dispatcher, codice inline e loader ambigui sono rifiutati. Gli host supportati isolano la rete in modo diverso, quindi un controllo portabile non deve dipendere da listener o connessioni; per un'API va verificato il gestore direttamente nel processo. Il runner nega la scrittura e l'accesso alla rete esterna o dell'host, ma può leggere i file accessibili al tuo account e non attesta gli import transitivi: usa codice revisionato che non carica percorsi host non governati.",
    "delivery.proposal.boundary.generic": "Questa scelta riguarda il progetto {project}. Destinazione e area di file consentita sono indicate qui in linguaggio semplice: {destination}; {write_paths}.",
    "delivery.proposal.value.project": "il progetto corrente",
    "delivery.proposal.value.repository": "il repository selezionato",
    "delivery.proposal.value.head": "il ramo selezionato per la pull request",
    "delivery.proposal.value.base": "il ramo di partenza selezionato",
    "delivery.proposal.value.target": "la cartella locale selezionata",
    "delivery.proposal.value.destination": "la destinazione selezionata per la consegna",
    "delivery.proposal.value.write_path": "un’area di file approvata indicata nei dettagli tecnici facoltativi",
    "delivery.proposal.value.write_paths_missing": "l’area di file approvata indicata nei dettagli tecnici facoltativi",
    "delivery.proposal.review.none": "Non sono previsti momenti di revisione ordinari, ma devo comunque fermarmi prima di qualsiasi azione protetta separatamente.",
    "delivery.proposal.review.some": "Devo chiederti nuovamente conferma {review_moments}.",
    "delivery.proposal.review.unknown": "prima di un’altra azione protetta indicata nei dettagli tecnici facoltativi",
    "delivery.proposal.review.contract": "prima di approvare l’accordo di implementazione",
    "delivery.proposal.review.start": "prima di iniziare il lavoro materiale",
    "delivery.proposal.review.claim": "prima di assegnare il lavoro",
    "delivery.proposal.review.complete": "prima di segnare come completata una fase di lavoro",
    "delivery.proposal.review.output": "prima di accettare le prove dell’implementazione",
    "delivery.proposal.review.build": "prima di creare o costruire la destinazione locale esatta",
    "delivery.proposal.review.commit": "prima di creare un commit",
    "delivery.proposal.review.push": "prima di pubblicare le modifiche",
    "delivery.proposal.review.pr": "prima di creare o aggiornare la pull request",
    "delivery.proposal.review.release": "prima di completare il rilascio locale",
    "delivery.proposal.review.merge": "prima di unire la pull request",
    "delivery.proposal.review.deploy": "prima di distribuire qualcosa fuori dal computer locale",
    "delivery.proposal.expiry.at": "Questa scelta scade il {expiry}.",
    "delivery.proposal.expiry.lifecycle.pr": "Non c’è una scadenza di calendario separata; questa scelta termina quando la pull request viene unita, chiusa o annullata.",
    "delivery.proposal.expiry.lifecycle.local": "Non c’è una scadenza di calendario separata; questa scelta termina quando il rilascio locale viene completato, ripristinato o annullato.",
    "delivery.proposal.expiry.lifecycle.generic": "Non c’è una scadenza di calendario separata; questa scelta termina quando la consegna viene completata o annullata.",
    "delivery.proposal.next": "Conferma la scelta indicata se i limiti sono corretti. Altrimenti modificala prima di iniziare il lavoro.",
    "delivery.approval.result": "La scelta del modo di lavorare è approvata e attiva per {delivery}.",
    "delivery.approval.impact": "Per questa consegna posso {effective}. {authority}",
    "delivery.approval.decision": "Ora non serve alcuna decisione. Dovrò chiedere di nuovo se cambiano i limiti approvati, la destinazione, il rischio o la consegna.",
    "delivery.approval.next.checkpoint": "Avvia la consegna entro i limiti approvati e chiedi conferma al prossimo momento di revisione concordato.",
    "delivery.approval.next.autonomous": "Avvia e completa questa consegna entro gli esatti limiti approvati; fermati se cambiano il lavoro, la destinazione, il rischio o l’approvazione necessaria.",
    "delivery.approval.next.supervised": "Richiedi una conferma esplicita prima di iniziare il lavoro materiale.",
    "delivery.status.proposed": "La scelta del modo di lavorare è stata proposta ma non è ancora attiva.",
    "delivery.status.active": "La scelta del modo di lavorare è attiva per {delivery}.",
    "delivery.status.terminal": "Questa scelta del modo di lavorare è chiusa e non può essere riutilizzata.",
    "delivery.status.invalid": "Questa scelta del modo di lavorare deve essere corretta e non può essere usata adesso.",
    "delivery.status.other": "Questa scelta del modo di lavorare non può essere usata adesso.",
    "delivery.status.impact": "Per questa consegna posso {effective}. {authority}",
    "delivery.status.impact.invalid": "Non ho potuto convalidare i limiti approvati, quindi devo {effective}.",
    "delivery.status.decision.proposed": "Scegli o modifica come devo lavorare per questa consegna prima di iniziare il lavoro.",
    "delivery.status.decision.active": "Ora non serve alcuna decisione. Dovrò chiedere di nuovo se cambiano i limiti approvati, la destinazione, il rischio o la consegna.",
    "delivery.status.decision.terminal": "Decidi una nuova scelta valida una sola volta prima di qualsiasi consegna successiva.",
    "delivery.status.decision.invalid": "Rivedi e approva i limiti corretti prima di continuare il lavoro.",
    "delivery.status.next.proposed": "Rivedi e approva il perimetro esatto della consegna prima di iniziare il lavoro.",
    "delivery.status.next.active": "Continua soltanto entro i limiti approvati e fermati a ogni momento di revisione concordato.",
    "delivery.status.next.terminal": "Crea e approva una nuova scelta valida per una sola consegna prima di qualsiasi altro lavoro.",
    "delivery.status.next.invalid": "Correggi e fai riapprovare progetto, versione, file, azioni o informazioni sull’approvazione prima di continuare.",
    "action.repository.write": "modificare file entro i percorsi di scrittura approvati",
    "action.test.run": "eseguire i test approvati",
    "action.git.commit": "creare l’esatto commit revisionato",
    "action.git.push": "pubblicare l’intervallo di commit approvato",
    "action.pull_request.create": "creare la pull request identificata",
    "action.pull_request.update": "aggiornare la pull request identificata",
    "action.pull_request.merge": "unire la pull request identificata",
    "action.build.local": "costruire il rilascio locale approvato",
    "action.data.migrate": "applicare l’esatta migrazione dati locale mostrata nell’anteprima",
    "action.data.rollback": "ripristinare l’esatto backup dati locale",
    "action.rollback.verify": "verificare le prove esatte del rollback locale",
    "action.release.local": "completare il rilascio locale approvato",
    "action.unknown": "eseguire l’operazione richiesta",
    "checkpoint.result.required": "L’operazione per {action} è sospesa prima dell’esecuzione.",
    "checkpoint.result.authorized": "L’operazione per {action} è autorizzata, ma questa decisione non l’ha eseguita.",
    "checkpoint.impact.audit": "È possibile registrare una conferma esplicita, ma il tool non può verificare autonomamente chi approva. L’operazione resta limitata alla destinazione esatta mostrata.",
    "checkpoint.impact.verified": "Questa operazione richiede una conferma firmata dal sistema o dalla CI per l’azione e la destinazione esatte.",
    "checkpoint.impact.audit.authorized": "L’autorizzazione è registrata per questa destinazione esatta, ma non ha una firma verificata in modo indipendente. L’operazione non è ancora stata eseguita.",
    "checkpoint.impact.verified.authorized": "È stata verificata un’approvazione firmata per questa esatta operazione e destinazione. L’operazione non è ancora stata eseguita.",
    "checkpoint.decision.audit": "Conferma se posso eseguire questa operazione esatta sulla destinazione mostrata.",
    "checkpoint.decision.verified": "Fornisci la conferma firmata dal sistema o dalla CI per questa operazione esatta.",
    "checkpoint.decision.authorized": "Non serve un’altra approvazione per questa operazione esatta; deve ancora essere eseguita e verificata.",
    "checkpoint.release.exact": "Perimetro esatto del rilascio locale: destinazione {target}; cartella di esecuzione dello smoke test {smoke_cwd}; smoke test {smoke}; rollback {rollback}.",
    "checkpoint.data.exact": "Perimetro esatto dei dati reversibili: destinazione {target}; ambito {scope}; backup {backup}; prove di anteprima {preview}; rollback {rollback}.",
    "checkpoint.rollback.exact": "Perimetro esatto della verifica di rollback: destinazione {target}; procedura {rollback}; prove immutabili {evidence}.",
    "checkpoint.protection": "Questa decisione copre soltanto l’operazione e la destinazione mostrate. Un’altra destinazione, pull request, rilascio locale, distribuzione, accesso alla produzione, segreti o lavoro fuori dai file mostrati richiede una decisione separata.",
    "checkpoint.next.audit": "Conferma l’operazione mostrata, poi lascia che lo strumento esterno la esegua e salva la prova del completamento.",
    "checkpoint.next.verified": "Fornisci la conferma firmata per questa operazione esatta, poi lascia che lo strumento esterno la esegua e salva la prova del completamento.",
    "checkpoint.next.authorized": "Esegui soltanto l’operazione esatta mostrata, poi salva la prova del completamento.",
    "checkpoint.merge.pending": "Nessun merge è stato eseguito.",
    "gate.result.passed": "I controlli sono terminati senza blocchi.",
    "gate.result.intermediate.passed": "Il controllo corrente della storia è superato, ma non è una certificazione finale del ciclo di vita.",
    "gate.result.final.passed": "Il controllo completo del ciclo di vita è superato e la prova finale è pronta.",
    "gate.result.failed": "I controlli hanno trovato {count} blocco/i; il lavoro non può ancora proseguire.",
    "gate.impact.passed": "Ambito e prove registrate sono coerenti per il prossimo passo, che resta da autorizzare separatamente. Il controllo non ha modificato, rilasciato, distribuito né unito nulla.",
    "gate.impact.intermediate.passed": "Le prove registrate finora sono coerenti, ma fasi successive, test o consegna possono essere ancora incompleti.",
    "gate.impact.final.passed": "Tutte le fasi configurate, gli ultimi test e la consegna esatta sono completi e coerenti.",
    "gate.impact.failed": "Manca almeno un confine o una prova richiesta, oppure è obsoleta, non valida o incoerente. Nessuna azione protetta è stata eseguita.",
    "gate.decision.passed": "Decidi se avviare il prossimo passo; un’azione protetta richiede comunque la propria approvazione.",
    "gate.decision.intermediate.passed": "Non considerare questo risultato come completamento finale; decidi soltanto se continuare con la prossima fase approvata.",
    "gate.decision.final.passed": "Non resta alcuna decisione sul ciclo di vita per questa consegna esatta.",
    "gate.decision.failed": "Non serve ancora un via libera. Prima devono essere risolti i blocchi segnalati.",
    "gate.protection": "Questi controlli non hanno approvato né eseguito modifiche, merge, rilasci, distribuzioni, accessi alla produzione o ai segreti, né lavoro fuori dai file approvati.",
    "gate.next.passed": "Continua soltanto se la prossima azione rientra nei limiti approvati e ha l’eventuale approvazione separata richiesta.",
    "gate.next.intermediate.passed": "Completa le fasi e la consegna rimanenti, poi esegui esplicitamente il controllo finale del ciclo di vita.",
    "gate.next.final.passed": "Conserva la prova finale con le prove di consegna; per lavori successivi usa una nuova consegna governata.",
    "gate.next.failed": "Risolvi i blocchi segnalati, conserva le prove e ripeti il controllo prima di proseguire.",
    "generic.error.result": "Non è stato possibile completare l’operazione.",
    "generic.error.impact": "Dopo aver rilevato il problema non è stato modificato altro.",
    "generic.error.decision": "Non serve una decisione, a meno che il prossimo passo cambi i limiti o la destinazione approvati.",
    "generic.error.protection": "L’operazione fallita non approva un nuovo tentativo, accessi più ampi, produzione, segreti o modifiche fuori dai file approvati.",
    "generic.error.next": "Leggi la causa spiegata in modo semplice, correggila e riprova soltanto entro i limiti approvati.",
  }),
});

export function buildHumanGuidance({
  locale = "en",
  result,
  impact,
  requiredDecision,
  required_decision: requiredDecisionSnake,
  protectionBoundary,
  protection_boundary: protectionBoundarySnake,
  nextAction,
  next_action: nextActionSnake,
  details = {},
} = {}) {
  const normalizedLocale = normalizeLocale(locale);
  if (!isPlainObject(details)) throw new TypeError("Human guidance details must be an object");
  const guidance = {
    result: requiredHumanText(result, "result"),
    impact: requiredHumanText(impact, "impact"),
    required_decision: requiredHumanText(requiredDecision ?? requiredDecisionSnake, "required_decision"),
    protection_boundary: requiredHumanText(protectionBoundary ?? protectionBoundarySnake, "protection_boundary"),
    next_action: requiredHumanText(nextAction ?? nextActionSnake, "next_action"),
    details: cloneValue(details),
  };
  assertHumanGuidancePlainLanguage(guidance, { locale: normalizedLocale });
  return deepFreeze(guidance);
}

export function humanGuidancePrimaryText(guidance) {
  assertHumanGuidanceShape(guidance);
  return PRIMARY_TEXT_FIELDS.map((field) => guidance[field]).join("\n");
}

export function findForbiddenHumanGuidanceTerms(value) {
  const text = typeof value === "string" ? value : humanGuidancePrimaryText(value);
  return FORBIDDEN_PRIMARY_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
}

export function assertHumanGuidancePlainLanguage(guidance, { locale = "en" } = {}) {
  normalizeLocale(locale);
  const forbidden = findForbiddenHumanGuidanceTerms(guidance);
  if (forbidden.length > 0) {
    throw new Error(`Primary human guidance contains internal terminology (${forbidden.join(", ")}); move it to details`);
  }
  return guidance;
}

export function renderHumanGuidanceText(guidance, {
  locale = "en",
  detailLines,
} = {}) {
  const normalizedLocale = normalizeLocale(locale);
  assertHumanGuidancePlainLanguage(guidance, { locale: normalizedLocale });
  const labels = OUTPUT_LABELS[normalizedLocale];
  const technicalLines = Array.isArray(detailLines)
    ? detailLines.map((line) => String(line))
    : JSON.stringify(guidance.details, null, 2).split("\n");
  return [
    `${labels.result}: ${guidance.result}`,
    `${labels.impact}: ${guidance.impact}`,
    `${labels.required_decision}: ${guidance.required_decision}`,
    `${labels.protection_boundary}: ${guidance.protection_boundary}`,
    `${labels.next_action}: ${guidance.next_action}`,
    "",
    TECHNICAL_DIVIDERS[normalizedLocale],
    ...technicalLines,
  ].join("\n");
}

export function createHumanGuidance({ locale = "en", messages = {} } = {}) {
  const normalizedLocale = normalizeLocale(locale);
  if (!isPlainObject(messages)) throw new TypeError("Human guidance messages must be an object");
  const t = (key, values = {}) => renderTemplate(messages[key] ?? CATALOG[normalizedLocale][key], values, key);
  const levelLabel = (level) => t(LEVELS.has(level) ? `level.${level}` : "level.unknown");

  const requirementAutonomyCeiling = (input = {}) => {
    const requested = input.autonomy_ceiling ?? input.requested_level ?? "supervised";
    const authority = authorityMode(input);
    const authorityVerified = isAuthorityVerified(input);
    const { effective, inferred } = effectiveLevel(input, requested, authority);
    const narrowed = levelRank(effective) < levelRank(requested);
    const requirementImpact = t("requirement.impact", { level: levelLabel(requested) });
    const approved = ["approved", "active"].includes(input.status) || input.active === true;
    return buildHumanGuidance({
      locale: normalizedLocale,
      result: t("requirement.result", { level: levelLabel(requested) }),
      impact: narrowed
        ? `${requirementImpact} ${t("requirement.impact.narrowed", {
            level: levelLabel(effective),
            authority: authorityText(t, authority, authorityVerified, approved),
          })}`
        : `${requirementImpact} ${authorityText(t, authority, authorityVerified, approved)}`,
      required_decision: t(approved ? "requirement.decision.approved" : "requirement.decision.review"),
      protection_boundary: t("requirement.protection"),
      next_action: t(approved ? "requirement.next.approved" : "requirement.next.review"),
      details: commonDetails("requirement_autonomy_ceiling", input, {
        autonomy_ceiling: requested,
        effective_level: effective,
        effective_level_inferred: inferred,
        authority_mode: authority,
        authority_verified: authorityVerified,
        narrowed,
      }),
    });
  };

  const deliveryAutonomyProposal = (input = {}) => {
    const context = deliveryContext(input, t, levelLabel);
    const workingImpact = deliveryWorkingImpact(context, t, "proposal");
    return buildHumanGuidance({
      locale: normalizedLocale,
      result: t("delivery.proposal.result", { delivery: context.deliveryLabel }),
      impact: `${workingImpact} ${deliveryProposalBoundary(input, context, t, normalizedLocale)}`,
      required_decision: `${deliveryAutonomyChoicePrompt(context, t)} ${deliveryProposalReview(input, t, normalizedLocale)} ${deliveryProposalExpiry(input, context, t, normalizedLocale)}`,
      protection_boundary: deliveryProtection(t, context),
      next_action: t("delivery.proposal.next"),
      details: deliveryDetails("delivery_autonomy_proposal", input, context),
    });
  };

  const deliveryAutonomyApproval = (input = {}) => {
    const context = deliveryContext({ ...input, status: input.status ?? "active" }, t, levelLabel);
    const nextKey = context.effective === "bounded-autonomous"
      ? "delivery.approval.next.autonomous"
      : context.effective === "checkpointed"
        ? "delivery.approval.next.checkpoint"
        : "delivery.approval.next.supervised";
    return buildHumanGuidance({
      locale: normalizedLocale,
      result: t("delivery.approval.result", { delivery: context.deliveryLabel }),
      impact: deliveryWorkingImpact(context, t, "approval"),
      required_decision: t("delivery.approval.decision"),
      protection_boundary: deliveryProtection(t, context),
      next_action: `${t(nextKey)}${context.mergePending ? ` ${context.mergeText}` : ""}`,
      details: deliveryDetails("delivery_autonomy_approval", input, context),
    });
  };

  const deliveryAutonomyStatus = (input = {}) => {
    const context = deliveryContext(input, t, levelLabel);
    const statusGroup = deliveryStatusGroup(input.status);
    const decisionGroup = ["other", "terminal"].includes(statusGroup) ? "terminal" : statusGroup;
    return buildHumanGuidance({
      locale: normalizedLocale,
      result: t(`delivery.status.${statusGroup}`, { delivery: context.deliveryLabel }),
      impact: statusGroup === "invalid"
        ? t("delivery.status.impact.invalid", context.templateValues)
        : deliveryWorkingImpact(context, t, "status"),
      required_decision: statusGroup === "proposed"
        ? deliveryAutonomyChoicePrompt(context, t)
        : t(`delivery.status.decision.${decisionGroup}`),
      protection_boundary: deliveryProtection(t, context),
      next_action: t(`delivery.status.next.${decisionGroup}`),
      details: deliveryDetails("delivery_autonomy_status", input, context),
    });
  };

  const actionCheckpoint = (input = {}) => {
    const authority = authorityMode(input);
    const action = String(input.action ?? "unknown");
    const actionLabel = t(CATALOG[normalizedLocale][`action.${action}`] ? `action.${action}` : "action.unknown");
    const authorized = input.status === "authorized";
    const mergePending = action === "pull_request.merge" && input.merge_executed !== true;
    const localReleaseBoundary = action === "release.local"
      ? t("checkpoint.release.exact", {
          target: humanBoundaryValue(
            input.target_root ?? input.local_release_target?.root_path,
            normalizedLocale === "it" ? "la cartella locale mostrata" : "the displayed local folder",
          ),
          smoke_cwd: humanBoundaryValue(
            input.smoke_cwd ?? input.local_release_target?.smoke_cwd,
            normalizedLocale === "it"
              ? "la cartella di output mostrata"
              : "the displayed output folder",
          ),
          smoke: humanBoundaryList(
            input.smoke_tests ?? input.local_release_target?.smoke_tests,
            normalizedLocale === "it"
              ? "un comando di verifica approvato elencato nei dettagli tecnici facoltativi"
              : "an approved smoke command listed in the optional technical details",
            normalizedLocale === "it" ? "il comando mostrato" : "the displayed command",
            normalizedLocale,
          ),
          rollback: humanBoundaryValue(
            input.rollback ?? input.local_release_target?.rollback?.procedure,
            normalizedLocale === "it" ? "la procedura mostrata" : "the displayed procedure",
          ),
        })
      : ["data.migrate", "data.rollback"].includes(action)
        ? t("checkpoint.data.exact", {
            target: humanBoundaryValue(
              input.data_target,
              normalizedLocale === "it" ? "il file dati mostrato" : "the displayed data file",
            ),
            scope: humanBoundaryList(
              input.data_scopes,
              normalizedLocale === "it"
                ? "un ambito dati approvato elencato nei dettagli tecnici facoltativi"
                : "an approved data scope listed in the optional technical details",
              normalizedLocale === "it" ? "l’ambito mostrato" : "the displayed scope",
              normalizedLocale,
            ),
            backup: humanBoundaryValue(
              input.backup_path,
              normalizedLocale === "it" ? "il file di backup mostrato" : "the displayed backup file",
            ),
            preview: humanBoundaryList(
              input.preview_evidence,
              normalizedLocale === "it"
                ? "un file di prova dell’anteprima elencato nei dettagli tecnici facoltativi"
                : "an approved preview evidence file listed in the optional technical details",
              normalizedLocale === "it" ? "le prove mostrate" : "the displayed evidence",
              normalizedLocale,
            ),
            rollback: humanBoundaryValue(
              input.rollback,
              normalizedLocale === "it" ? "la procedura mostrata" : "the displayed procedure",
            ),
          })
        : action === "rollback.verify"
          ? t("checkpoint.rollback.exact", {
              target: humanBoundaryValue(
                input.target_root ?? input.local_release_target?.root_path,
                normalizedLocale === "it" ? "la cartella locale mostrata" : "the displayed local folder",
              ),
              rollback: humanBoundaryValue(
                input.rollback ?? input.local_release_target?.rollback?.procedure,
                normalizedLocale === "it" ? "la procedura mostrata" : "the displayed procedure",
              ),
              evidence: humanBoundaryList(
                input.rollback_evidence,
                normalizedLocale === "it"
                  ? "un file di prova del ripristino elencato nei dettagli tecnici facoltativi"
                  : "an approved rollback evidence file listed in the optional technical details",
                normalizedLocale === "it" ? "le prove mostrate" : "the displayed evidence",
                normalizedLocale,
              ),
            })
      : null;
    const decisionKey = authorized
      ? "checkpoint.decision.authorized"
      : authority === "host_verified" ? "checkpoint.decision.verified" : "checkpoint.decision.audit";
    return buildHumanGuidance({
      locale: normalizedLocale,
      result: t(authorized ? "checkpoint.result.authorized" : "checkpoint.result.required", {
        action: actionLabel,
      }),
      impact: t(authorized
        ? authority === "host_verified" ? "checkpoint.impact.verified.authorized" : "checkpoint.impact.audit.authorized"
        : authority === "host_verified" ? "checkpoint.impact.verified" : "checkpoint.impact.audit"),
      required_decision: `${t(decisionKey)}${localReleaseBoundary ? ` ${localReleaseBoundary}` : ""}`,
      protection_boundary: t("checkpoint.protection"),
      next_action: `${t(authorized
        ? "checkpoint.next.authorized"
        : authority === "host_verified" ? "checkpoint.next.verified" : "checkpoint.next.audit")}${
        mergePending ? ` ${t("checkpoint.merge.pending")}` : ""
      }`,
      details: commonDetails("action_checkpoint", input, {
        action,
        authority_mode: authority,
        authority_verified: isAuthorityVerified(input),
        host_receipt_required: Boolean(input.host_receipt_required ?? authority === "host_verified"),
        execution_performed: Boolean(input.execution_performed),
        merge_executed: Boolean(input.merge_executed),
        target_root: input.target_root ?? input.local_release_target?.root_path ?? null,
        smoke_cwd: input.smoke_cwd ?? input.local_release_target?.smoke_cwd ?? null,
        smoke_tests: stringList(input.smoke_tests ?? input.local_release_target?.smoke_tests),
        data_target: input.data_target ?? null,
        data_scopes: stringList(input.data_scopes),
        backup_path: input.backup_path ?? null,
        preview_evidence: stringList(input.preview_evidence),
        rollback_evidence: stringList(input.rollback_evidence),
        rollback: input.rollback ?? input.local_release_target?.rollback?.procedure ?? null,
      }),
    });
  };

  const gate = (input = {}) => {
    const passed = input.status === "passed" || input.passed === true;
    const errors = stringList(input.errors ?? input.blocking_reasons);
    const warnings = stringList(input.warnings);
    const count = errors.length || (passed ? 0 : Number(input.blocking_count ?? 1));
    const finalLifecycle = passed && input.lifecycle_complete === true;
    const intermediateStory = passed
      && input.strict === true
      && input.scope === "story"
      && !finalLifecycle;
    const passedVariant = finalLifecycle ? "final.passed" : intermediateStory ? "intermediate.passed" : "passed";
    return buildHumanGuidance({
      locale: normalizedLocale,
      result: t(passed ? `gate.result.${passedVariant}` : "gate.result.failed", { count }),
      impact: t(passed ? `gate.impact.${passedVariant}` : "gate.impact.failed"),
      required_decision: t(passed ? `gate.decision.${passedVariant}` : "gate.decision.failed"),
      protection_boundary: t("gate.protection"),
      next_action: t(passed ? `gate.next.${passedVariant}` : "gate.next.failed"),
      details: commonDetails("gate", input, {
        gate_status: passed ? "passed" : "failed",
        lifecycle_complete: finalLifecycle,
        certification_level: input.certification_level ?? null,
        blocking_count: count,
        human_blockers: stringList(input.human_blockers),
        errors,
        warnings,
        merge_executed: Boolean(input.merge_executed),
      }),
    });
  };

  const genericError = (input = {}) => buildHumanGuidance({
    locale: normalizedLocale,
    result: input.result ?? t("generic.error.result"),
    impact: input.impact ?? t("generic.error.impact"),
    required_decision: input.required_decision ?? input.requiredDecision ?? t("generic.error.decision"),
    protection_boundary: input.protection_boundary ?? input.protectionBoundary ?? t("generic.error.protection"),
    next_action: input.next_action ?? input.nextAction ?? t("generic.error.next"),
    details: commonDetails("generic_error", input, {
      error_code: input.error_code ?? null,
      cause: input.cause ?? null,
      ...(isPlainObject(input.details) ? cloneValue(input.details) : {}),
    }),
  });

  return Object.freeze({
    locale: normalizedLocale,
    requirementAutonomyCeiling,
    deliveryAutonomyStatus,
    deliveryAutonomyProposal,
    deliveryAutonomyApproval,
    actionCheckpoint,
    gate,
    genericError,
  });
}

export function requirementAutonomyCeilingGuidance(input, options = {}) {
  return createHumanGuidance(options).requirementAutonomyCeiling(input);
}

export function deliveryAutonomyStatusGuidance(input, options = {}) {
  return createHumanGuidance(options).deliveryAutonomyStatus(input);
}

export function deliveryAutonomyProposalGuidance(input, options = {}) {
  return createHumanGuidance(options).deliveryAutonomyProposal(input);
}

export function deliveryAutonomyApprovalGuidance(input, options = {}) {
  return createHumanGuidance(options).deliveryAutonomyApproval(input);
}

export function actionCheckpointGuidance(input, options = {}) {
  return createHumanGuidance(options).actionCheckpoint(input);
}

export function gateGuidance(input, options = {}) {
  return createHumanGuidance(options).gate(input);
}

export function genericErrorGuidance(input, options = {}) {
  return createHumanGuidance(options).genericError(input);
}

function deliveryWorkingImpact(context, t, presentation) {
  if (
    context.authority === "audit_only"
    && context.requested === "bounded-autonomous"
    && context.effective === "checkpointed"
  ) {
    return t("delivery.full.audit.narrowed");
  }
  if (presentation === "proposal") {
    return context.narrowed
      ? t("delivery.proposal.impact.narrowed", context.templateValues)
      : t("delivery.proposal.impact.normal", context.templateValues);
  }
  return t(presentation === "approval" ? "delivery.approval.impact" : "delivery.status.impact", context.templateValues);
}

function deliveryAutonomyChoicePrompt(context, t) {
  const suffix = context.deliveryKind === "pull_request"
    ? "pr"
    : context.deliveryKind === "local_release" ? "local" : "generic";
  const questionKey = suffix === "pr"
    ? "delivery.choice.question.pr"
    : suffix === "local" ? "delivery.choice.question.local" : "delivery.choice.question.pr";
  const fullChoiceKey = suffix === "local"
    ? "delivery.choice.option.bounded-autonomous.local"
    : "delivery.choice.option.bounded-autonomous";
  const selectedKey = LEVELS.has(context.requested)
    ? `delivery.choice.selected.${context.requested}`
    : "delivery.choice.selected.supervised";
  return [
    t(questionKey),
    `1. ${t("delivery.choice.option.supervised")}`,
    `2. ${t("delivery.choice.option.checkpointed")}`,
    `3. ${t(fullChoiceKey)}`,
    t(`delivery.choice.scope.${suffix}`),
    t(selectedKey),
  ].join("\n");
}

function deliveryProtection(t, context) {
  return `${context.scope} ${context.mergeText} ${t("delivery.protection.common")}`;
}

function deliveryProposalBoundary(input, context, t, locale) {
  const project = humanBoundaryValue(input.project_name ?? input.project, t("delivery.proposal.value.project"));
  const writePaths = humanBoundaryList(
    input.allowed_write_paths ?? input.write_paths,
    t("delivery.proposal.value.write_path"),
    t("delivery.proposal.value.write_paths_missing"),
    locale,
  );
  if (context.deliveryKind === "pull_request") {
    const target = input.pull_request_target ?? {};
    return t("delivery.proposal.boundary.pr", {
      project,
      repository: humanBoundaryValue(input.repository ?? target.repository, t("delivery.proposal.value.repository")),
      head: humanBoundaryValue(input.head_branch ?? target.head_branch, t("delivery.proposal.value.head")),
      base: humanBoundaryValue(input.base_branch ?? target.base_branch, t("delivery.proposal.value.base")),
      write_paths: writePaths,
    });
  }
  if (context.deliveryKind === "local_release") {
    const target = input.local_release_target ?? {};
    return t("delivery.proposal.boundary.local", {
      project,
      target_root: humanBoundaryValue(input.target_root ?? target.root_path, t("delivery.proposal.value.target")),
      write_paths: writePaths,
      smoke_cwd: humanBoundaryValue(
        input.smoke_cwd ?? target.smoke_cwd,
        locale === "it" ? "la cartella di output selezionata" : "the selected output folder",
      ),
    });
  }
  return t("delivery.proposal.boundary.generic", {
    project,
    destination: humanBoundaryValue(input.destination, t("delivery.proposal.value.destination")),
    write_paths: writePaths,
  });
}

function deliveryProposalReview(input, t, locale) {
  const reviewMoments = stringList(input.review_moments ?? input.checkpoints);
  if (reviewMoments.length === 0) return t("delivery.proposal.review.none");
  const labels = [...new Set(reviewMoments.map((moment) =>
    t(DELIVERY_REVIEW_MESSAGE_KEYS[moment] ?? "delivery.proposal.review.unknown")))];
  return t("delivery.proposal.review.some", {
    review_moments: humanList(labels, locale),
  });
}

function deliveryProposalExpiry(input, context, t, locale) {
  if (input.expires_at) {
    return t("delivery.proposal.expiry.at", {
      expiry: humanTimestamp(input.expires_at, locale),
    });
  }
  const suffix = context.deliveryKind === "pull_request"
    ? "pr"
    : context.deliveryKind === "local_release" ? "local" : "generic";
  return t(`delivery.proposal.expiry.lifecycle.${suffix}`);
}

function humanBoundaryValue(value, fallback) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized || findForbiddenHumanGuidanceTerms(normalized).length > 0) return fallback;
  return `“${normalized.replace(/[“”]/gu, "'")}”`;
}

function humanBoundaryList(values, hiddenFallback, missingFallback, locale) {
  const rawValues = stringList(values).filter((value) => value.trim() !== "");
  if (rawValues.length === 0) return missingFallback;
  const labels = [...new Set(rawValues.map((value) => humanBoundaryValue(value, hiddenFallback)))];
  return humanList(labels, locale);
}

function humanList(values, locale) {
  if (values.length <= 1) return values[0] ?? "";
  return new Intl.ListFormat(locale === "it" ? "it-IT" : "en", {
    style: "long",
    type: "conjunction",
  }).format(values);
}

function humanTimestamp(value, locale) {
  const timestamp = new Date(String(value));
  if (!Number.isFinite(timestamp.getTime())) {
    return humanBoundaryValue(value, locale === "it" ? "alla data registrata" : "on the recorded date");
  }
  const formatted = new Intl.DateTimeFormat(locale === "it" ? "it-IT" : "en", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(timestamp);
  return `${formatted} UTC`;
}

function deliveryContext(input, t, levelLabel) {
  const requested = input.requested_level ?? input.autonomy_level ?? "supervised";
  const authority = authorityMode(input);
  const authorityVerified = isAuthorityVerified(input);
  const approvalRecorded = ![undefined, null, "", "proposed", "draft", "pending"].includes(input.status);
  const { effective, inferred } = effectiveLevel(input, requested, authority);
  const deliveryKind = input.delivery_kind ?? input.kind ?? "pull_request";
  const mergeExecuted = Boolean(input.merge_executed);
  const mergeAllowed = Boolean(input.merge_allowed ?? input.pull_request_target?.merge_allowed);
  const mergeText = mergeExecuted
    ? t("delivery.merge.done")
    : mergeAllowed
      ? t("delivery.merge.separate")
      : t("delivery.merge.outside");
  const scope = t(deliveryKind === "pull_request"
    ? "delivery.scope.pr"
    : deliveryKind === "local_release"
      ? "delivery.scope.local"
      : "delivery.scope.generic");
  const deliveryLabel = t(deliveryKind === "pull_request"
    ? "delivery.pull_request"
    : deliveryKind === "local_release"
      ? "delivery.local_release"
      : "delivery.unknown");
  return {
    requested,
    effective,
    effectiveInferred: inferred,
    authority,
    authorityVerified,
    deliveryKind,
    deliveryLabel,
    mergeAllowed,
    mergeExecuted,
    mergePending: deliveryKind === "pull_request" && !mergeExecuted,
    mergeText,
    scope,
    narrowed: levelRank(effective) < levelRank(requested),
    templateValues: {
      requested: levelLabel(requested),
      effective: levelLabel(effective),
      authority: authorityText(t, authority, authorityVerified, approvalRecorded),
      scope,
      merge: mergeText,
    },
  };
}

function deliveryDetails(kind, input, context) {
  const verificationUpgrade = context.authority === "audit_only"
    && context.requested === "bounded-autonomous"
    && context.effective === "checkpointed"
    ? {
        current_effect: "execution is limited to checkpointed until approver identity is digitally verified",
        enable_with: [
          "set authority_policy.mode to host_verified",
          "configure the matching Ed25519 public key in authority_policy.trusted_host_keys",
          "supply the externally signed approval with --host-receipt-file",
        ],
      }
    : null;
  return commonDetails(kind, input, {
    delivery_kind: context.deliveryKind,
    requested_level: context.requested,
    effective_level: context.effective,
    effective_level_inferred: context.effectiveInferred,
    authority_mode: context.authority,
    authority_verified: context.authorityVerified,
    narrowed: context.narrowed,
    single_delivery: true,
    reusable_for_another_delivery: false,
    merge_allowed: context.mergeAllowed,
    merge_executed: context.mergeExecuted,
    project_name: input.project_name ?? input.project ?? null,
    project_root: input.project_root ?? null,
    repository: input.repository ?? input.pull_request_target?.repository ?? null,
    base_branch: input.base_branch ?? input.pull_request_target?.base_branch ?? null,
    head_branch: input.head_branch ?? input.pull_request_target?.head_branch ?? null,
    target_root: input.target_root ?? input.local_release_target?.root_path ?? null,
    smoke_cwd: input.smoke_cwd ?? input.local_release_target?.smoke_cwd ?? null,
    ...(context.deliveryKind === "local_release"
      ? {
          smoke_execution_boundary: cloneValue(input.smoke_execution_boundary ?? {
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
          }),
        }
      : {}),
    allowed_write_paths: stringList(input.allowed_write_paths ?? input.write_paths),
    review_moments: stringList(input.review_moments ?? input.checkpoints),
    expires_at: input.expires_at ?? null,
    choice_mapping: {
      guided: "supervised",
      autonomy_with_checks: "checkpointed",
      full_autonomy_within_limits: "bounded-autonomous",
    },
    digital_approver_verification: verificationUpgrade,
  });
}

function commonDetails(kind, input, extra) {
  return {
    guidance_kind: kind,
    status: input.status ?? null,
    requirement_id: input.requirement_id ?? input.requirement_ref?.id ?? null,
    profile_id: input.profile_id ?? input.id ?? null,
    delivery_id: input.delivery_id ?? input.delivery?.id ?? null,
    pull_request_url: input.pr_url ?? input.pull_request_target?.pr_url ?? null,
    reason_codes: stringList(input.reason_codes),
    next_command: input.next_command ?? null,
    ...cloneValue(extra),
  };
}

function authorityMode(input) {
  return input.authority_mode ?? input.authority_assurance?.mode ?? "audit_only";
}

function authorityText(t, mode, verified = false, approvalRecorded = true) {
  if (mode === "host_verified") return t(verified ? "authority.verified" : "authority.required");
  if (mode === "audit_only") return t(approvalRecorded ? "authority.audit" : "authority.audit.proposed");
  return t("authority.invalid");
}

function isAuthorityVerified(input) {
  return input.authority_verified === true
    || input.authority_assurance?.verified === true
    || input.receipt_verified === true;
}

function effectiveLevel(input, requested, authority) {
  if (authority === "host_verified" && !isAuthorityVerified(input)) {
    return { effective: "supervised", inferred: true };
  }
  if (input.effective_level) return { effective: input.effective_level, inferred: false };
  if (authority === "audit_only" && requested === "bounded-autonomous") {
    return { effective: "checkpointed", inferred: true };
  }
  if (!LEVELS.has(requested)) return { effective: "supervised", inferred: true };
  return { effective: requested, inferred: false };
}

function levelRank(level) {
  return level === "bounded-autonomous" ? 2 : level === "checkpointed" ? 1 : 0;
}

function deliveryStatusGroup(status) {
  if (["active", "approved", "started", "running"].includes(status)) return "active";
  if (["proposed", "draft", "pending_approval"].includes(status)) return "proposed";
  if (["invalid", "needs_repair", "blocked"].includes(status)) return "invalid";
  if (["closed", "merged", "released", "revoked", "expired", "cancelled", "rolled_back", "superseded", "terminal"].includes(status)) {
    return "terminal";
  }
  return "other";
}

function normalizeLocale(locale) {
  const normalized = String(locale).trim().toLowerCase().split(/[-_]/)[0];
  if (!SUPPORTED_LOCALES.has(normalized)) {
    throw new RangeError(`Unsupported human guidance locale: ${locale}`);
  }
  return normalized;
}

function renderTemplate(template, values, key) {
  if (typeof template !== "string") throw new Error(`Missing human guidance message: ${key}`);
  return template.replace(/\{([a-z_]+)\}/gi, (_, name) => String(values[name] ?? ""));
}

function requiredHumanText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Human guidance ${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertHumanGuidanceShape(guidance) {
  if (!isPlainObject(guidance)) throw new TypeError("Human guidance must be an object");
  for (const field of PRIMARY_TEXT_FIELDS) requiredHumanText(guidance[field], field);
  if (!isPlainObject(guidance.details)) throw new TypeError("Human guidance details must be an object");
  return guidance;
}

function stringList(value) {
  if (!Array.isArray(value)) return value === undefined || value === null ? [] : [String(value)];
  return value.map((item) => String(item));
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
