const SUPPORTED_LOCALES = new Set(["en", "it"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(en, it) {
  return { en, it };
}

function option(name, value, en, it, extra = {}) {
  return {
    name,
    flag: `--${name}`,
    value,
    description: text(en, it),
    ...extra,
  };
}

export const GLOBAL_OPTIONS = deepFreeze([
  option("root", "path", "Use this project folder.", "Usa questa cartella di progetto."),
  option("locale", "en|it", "Choose the language for human-readable output.", "Scegli la lingua dell’output leggibile.", { values: ["en", "it"] }),
  option("json", null, "Return stable JSON for automation.", "Restituisce JSON stabile per le automazioni.", { boolean: true }),
  option(
    "full",
    null,
    "Include machine/JSON details omitted from compact output.",
    "Include i dettagli macchina/JSON esclusi dall’output compatto.",
    { boolean: true },
  ),
  option("cli-preset", "name|@file.json", "Apply presentation settings; repeat to compose them.", "Applica impostazioni di presentazione; ripeti per combinarle.", {
    repeatable: true,
    values: ["diagnostic", "human-en", "human-it", "machine", "no-browser"],
  }),
  option("help", null, "Show help without opening a project.", "Mostra l’aiuto senza aprire un progetto.", { boolean: true, aliases: ["-h"] }),
  option("version", null, "Show the installed version.", "Mostra la versione installata.", { boolean: true, aliases: ["-v"] }),
]);

const OPTION_LIBRARY = deepFreeze({
  id: option("id", "id", "Select the exact record.", "Seleziona il record esatto."),
  "new-id": option("new-id", "id", "Name the new immutable revision; it must not reuse an existing record ID.", "Assegna un ID alla nuova revisione immutabile; non deve riutilizzare un record esistente."),
  "project-name": option("project-name", "name", "Set the human-readable project name; defaults to the folder name.", "Imposta il nome leggibile del progetto; per default usa il nome della cartella."),
  "project-id": option("project-id", "id", "Set the stable project ID; defaults to a slug of the project name.", "Imposta l’ID stabile del progetto; per default usa una forma normalizzata del nome."),
  force: option("force", null, "Replace an existing proposal or generated local record where this command supports it.", "Sostituisce una proposta o un record locale generato quando il comando lo supporta.", { boolean: true }),
  "story-status": option(
    "status",
    "draft|ready",
    "Set only the initial story status. Later status changes are owned by the governed lifecycle.",
    "Imposta solo lo stato iniziale della story. I cambi di stato successivi appartengono al ciclo di vita governato.",
    { values: ["draft", "ready"] },
  ),
  baseline: option("baseline", "baseline-id", "Use one exact approved project baseline; defaults to the latest approved baseline.", "Usa una baseline di progetto approvata ed esatta; per default usa l’ultima baseline approvata."),
  document: option("document", "path", "Import one project document as baseline evidence; repeat for more documents.", "Importa un documento del progetto come evidenza della baseline; ripeti per altri documenti.", { repeatable: true }),
  "confirmed-source": option("confirmed-source", "id", "Record one source already confirmed as canonical; repeat when needed.", "Registra una fonte già confermata come canonica; ripeti quando serve.", { repeatable: true }),
  title: option("title", "text", "Name the requirement in plain language.", "Assegna al requisito un nome in linguaggio semplice."),
  "story-title": option("title", "text", "Name this delivery unit in plain language.", "Assegna a questa attività un nome in linguaggio semplice."),
  story: option("story", "story-id", "Select the exact story.", "Seleziona la story esatta."),
  requirement: option("requirement", "requirement-id", "Select the exact requirement; repeat for every linked requirement.", "Seleziona il requisito esatto; ripeti per ogni requisito collegato.", { repeatable: true }),
  agent: option("agent", "name", "Name the agent responsible for this work unit.", "Indica l’agente responsabile di questa attività."),
  branch: option("branch", "branch", "Use this source-control branch for the work.", "Usa questo branch per il lavoro."),
  actor: option("actor", "identity", "Record who performs the action.", "Registra chi esegue l’azione."),
  authorization: option("authorization", "authorization-id", "Use one exact delegated authorization.", "Usa una delega esatta."),
  "authorization-receipt": option(
    "authorization-receipt",
    "AUT-ACT-id",
    "Complete the exact previously authorized delivery action. Required when more than one matching action is waiting.",
    "Completa l’esatta azione di consegna già autorizzata. È obbligatorio quando più azioni corrispondenti sono in attesa.",
  ),
  summary: option("summary", "text", "Record a concise human explanation.", "Registra una spiegazione umana concisa."),
  scope: option("scope", "text", "Bind the record to one explicit project or approval boundary.", "Vincola il record a un limite esplicito di progetto o approvazione."),
  evidence: option("evidence", "path", "Attach one immutable evidence file; repeat when needed.", "Allega un file di prova immutabile; ripeti quando serve.", { repeatable: true }),
  "render-evidence": option(
    "render-evidence",
    "path",
    "Attach only render or visual verification for the produced output: a PNG, JPEG, WebP, PDF render, or a typed render-verification-receipt:v1 JSON file. This is not functional or test evidence; repeat when needed.",
    "Allega soltanto la verifica di rendering o visiva del risultato prodotto: un render PNG, JPEG, WebP o PDF, oppure un file JSON tipizzato render-verification-receipt:v1. Non è una prova funzionale o di test; ripeti quando serve.",
    { repeatable: true },
  ),
  "legacy-output-render-evidence": option(
    "evidence",
    "path",
    "Legacy alias for --render-evidence on output link. It accepts only render or visual verification, not functional or test evidence.",
    "Alias precedente di --render-evidence per output link. Accetta soltanto verifiche di rendering o visive, non prove funzionali o di test.",
    { repeatable: true },
  ),
  "approval-evidence": option("approval-evidence", "path", "Attach formal approval evidence; repeat when needed.", "Allega una prova formale dell’approvazione; ripeti quando serve.", { repeatable: true }),
  apply: option("apply", null, "Perform the displayed local change.", "Esegue la modifica locale mostrata.", { boolean: true }),
  "plan-hash": option("plan-hash", "sha256", "Bind apply to the exact reviewed plan.", "Vincola l’applicazione al piano esatto revisionato."),
  out: option("out", "path", "Write the result to this file.", "Scrive il risultato in questo file."),
  artifact: option("artifact", "path", "Attach one produced artifact; repeat for additional artifacts.", "Allega un artefatto prodotto; ripeti per altri artefatti.", { repeatable: true }),
  "receipt-json": option("receipt-json", "json", "Provide one canonical receipt as inline JSON; do not combine with --receipt-file.", "Fornisci una ricevuta canonica come JSON inline; non combinarla con --receipt-file."),
  "receipt-file": option("receipt-file", "path", "Read one canonical receipt from a project file; do not combine with --receipt-json.", "Legge una ricevuta canonica da un file del progetto; non combinarla con --receipt-json."),
  limit: option("limit", "number", "Limit the number of displayed results.", "Limita il numero di risultati mostrati."),
  view: option("view", "business|dev|agent-verbose", "Choose the level of reporting detail.", "Scegli il livello di dettaglio del report.", { values: ["agent-verbose", "business", "dev"] }),
  "no-open": option("no-open", null, "Do not open a browser window.", "Non apre una finestra del browser.", { boolean: true }),
  host: option("host", "127.0.0.1", "Bind the local viewer to loopback only.", "Collega il visualizzatore solo all’interfaccia locale."),
  port: option("port", "0..65535", "Choose the local port; 0 selects an available one.", "Sceglie la porta locale; 0 ne seleziona una disponibile."),
  "portfolio-manifest": option("portfolio-manifest", "relative.json", "Open only the projects explicitly listed in this portfolio file.", "Apre solo i progetti elencati esplicitamente in questo file portfolio."),
  manifest: option("manifest", "relative.json", "Read one explicit portfolio manifest without starting a server.", "Legge un manifest portfolio esplicito senza avviare un server."),
  "template-dir": option(
    "template-dir",
    "path",
    "Use a local template overlay. Init and onboard copy and pin its sdlc-config.json; compatible later commands resolve template assets from the same overlay and use bundled fallbacks for missing assets.",
    "Usa un overlay locale di template. Init e onboard copiano e bloccano il relativo sdlc-config.json; i comandi successivi compatibili risolvono gli asset dallo stesso overlay e usano i fallback inclusi per quelli mancanti.",
  ),
  shell: option("shell", "bash|zsh|fish|powershell", "Choose the target shell.", "Scegli la shell di destinazione.", { values: ["bash", "fish", "powershell", "zsh"] }),
  phase: option(
    "phase",
    "configured-phase",
    "Select a phase from this project's phase_order; the shipped defaults are discovery, analysis, design, implementation, validation, and release.",
    "Seleziona una fase dal phase_order del progetto; i valori predefiniti sono discovery, analysis, design, implementation, validation e release.",
  ),
  contract: option("contract", "contract-id", "Use the exact approved contract.", "Usa il contract esatto approvato."),
  "contract-id": option("contract-id", "contract-id", "Evaluate this exact work agreement when starting the task.", "Valuta questo accordo di lavoro esatto quando avvii l’attività."),
  profile: option("profile", "profile-id", "Select the project-evidence record used to choose tools.", "Seleziona il record delle evidenze di progetto usato per scegliere gli strumenti."),
  "profile-json": option("profile-json", "json", "Provide the capability profile as inline JSON; do not combine with --profile-file.", "Fornisci il profilo delle capacità come JSON inline; non combinarlo con --profile-file."),
  "profile-file": option("profile-file", "path", "Read the capability profile from one project JSON file; do not combine with --profile-json.", "Legge il profilo delle capacità da un file JSON del progetto; non combinarlo con --profile-json."),
  "recommendation-json": option("recommendation-json", "json", "Provide the capability recommendation as inline JSON; do not combine with --recommendation-file.", "Fornisci la raccomandazione delle capacità come JSON inline; non combinarla con --recommendation-file."),
  "recommendation-file": option("recommendation-file", "path", "Read the capability recommendation from one project JSON file; do not combine with --recommendation-json.", "Legge la raccomandazione delle capacità da un file JSON del progetto; non combinarla con --recommendation-json."),
  "available-capabilities-json": option("available-capabilities-json", "json", "Provide the currently available capabilities as inline JSON; do not combine with --available-capabilities-file.", "Fornisci le capacità attualmente disponibili come JSON inline; non combinarle con --available-capabilities-file."),
  "available-capabilities-file": option("available-capabilities-file", "path", "Read the currently available capabilities from one project JSON file; do not combine with --available-capabilities-json.", "Legge le capacità attualmente disponibili da un file JSON del progetto; non combinarle con --available-capabilities-json."),
  confidence: option("confidence", "0..1", "Record the confidence in the proposed capability profile.", "Registra il livello di confidenza nel profilo delle capacità proposto."),
  "approve-install": option("approve-install", null, "Also approve required installations; this needs direct explicit-user or CI approval.", "Approva anche le installazioni necessarie; richiede un’approvazione diretta explicit-user o CI.", { boolean: true }),
  "delivery-profile": option("delivery-profile", "profile-id", "Use the choice approved for this delivery only.", "Usa la scelta approvata solo per questa consegna."),
  acceptance: option("acceptance", "criterion", "Add one observable success criterion; repeat for each criterion.", "Aggiunge un criterio di successo osservabile; ripeti per ogni criterio.", { repeatable: true }),
  "autonomy-ceiling": option("autonomy-ceiling", "supervised|checkpointed|bounded-autonomous", "Set only the maximum independence that may be chosen later for a delivery.", "Imposta solo l’autonomia massima selezionabile in seguito per una consegna.", { values: ["bounded-autonomous", "checkpointed", "supervised"] }),
  "autonomy-mode": option("autonomy-mode", "off|observe|enforce_new_only|enforce_all", "Plan an exact change to the project autonomy rollout mode.", "Pianifica una modifica esatta alla modalità di adozione dell’autonomia del progetto.", { values: ["enforce_all", "enforce_new_only", "observe", "off"] }),
  "scope-summary": option("scope-summary", "text", "Provide the outcome and boundary when --summary is not used.", "Descrive risultato e limiti quando non usi --summary."),
  "scope-id": option("scope-id", "id", "Set the stable identifier for the exact assessment scope.", "Imposta l’identificatore stabile dell’ambito esatto dell’assessment."),
  "scope-title": option("scope-title", "text", "Give the exact assessment scope a short human-readable name.", "Assegna un nome breve e leggibile all’ambito esatto dell’assessment."),
  section: option("section", "heading", "Require one deliverable section; repeat for every required section.", "Richiede una sezione della consegna; ripeti per ogni sezione richiesta.", { repeatable: true }),
  source: option("source", "path", "Use one project evidence file; repeat for additional files.", "Usa un file di evidenza del progetto; ripeti per altri file.", { repeatable: true }),
  "non-goal": option("non-goal", "text", "Record what this requirement must not include; repeat when needed.", "Registra ciò che il requisito non deve includere; ripeti quando serve.", { repeatable: true }),
  constraint: option("constraint", "text", "Record one work boundary; repeat when needed.", "Registra un limite del lavoro; ripeti quando serve.", { repeatable: true }),
  nfr: option("nfr", "text", "Record one non-functional expectation; repeat when needed.", "Registra un requisito non funzionale; ripeti quando serve.", { repeatable: true }),
  integration: option("integration", "text", "Record one affected integration; repeat when needed.", "Registra un’integrazione interessata; ripeti quando serve.", { repeatable: true }),
  tool: option("tool", "name", "Allow one named local tool in the work brief; repeat when needed.", "Consenti uno strumento locale nominato nell’accordo di lavoro; ripeti quando serve.", { repeatable: true }),
  capability: option("capability", "name", "Record one permitted capability; repeat when needed.", "Registra una capacità consentita; ripeti quando serve.", { repeatable: true }),
  environment: option("environment", "name", "Record one allowed environment; repeat when needed.", "Registra un ambiente consentito; ripeti quando serve.", { repeatable: true }),
  "expires-at": option("expires-at", "ISO-8601", "Expire the proposed requirement boundary at a fixed time.", "Imposta una scadenza fissa per i limiti proposti del requisito."),
  proposal: option("proposal", "proposal-id", "Bind the requirement to one prepared proposal.", "Vincola il requisito a una proposta preparata."),
  "execution-proposal": option("proposal", "proposal-id", "Select the exact governed assessment proposal.", "Seleziona la proposta di assessment governata ed esatta."),
  "proposal-hash": option("proposal-hash", "sha256", "Bind --proposal to its exact reviewed content.", "Vincola --proposal al contenuto esatto revisionato."),
  "budget-json": option("budget-json", "json", "Provide the exact execution budget as inline JSON; do not combine with --budget-file.", "Fornisci il budget di esecuzione esatto come JSON inline; non combinarlo con --budget-file."),
  "budget-file": option("budget-file", "path", "Read the exact execution budget from one project file; do not combine with --budget-json.", "Legge il budget di esecuzione esatto da un file del progetto; non combinarlo con --budget-json."),
  "command-json": option("command-json", "json-argv", "Provide a shell-free JSON argv vector for one supported safe command.", "Fornisce un vettore argv JSON senza shell per un comando sicuro supportato."),
  "optimization-profile": option("profile", "auto|native|test|git|rg", "Choose the safe command-output route; auto selects it from the argv vector.", "Sceglie il percorso sicuro per l’output del comando; auto lo seleziona dal vettore argv.", { values: ["auto", "git", "native", "rg", "test"] }),
  "optimization-json-unsupported": option("json", null, "Not supported for this command because child output is streamed; omit --json.", "Non è supportato per questo comando perché l’output del processo viene trasmesso direttamente; ometti --json.", { boolean: true }),
  exact: option("exact", null, "Return complete native output without widening the safe command allowlist.", "Restituisce l’output nativo completo senza ampliare l’elenco dei comandi sicuri.", { boolean: true }),
  "trust-custom-rtk-command": option("trust-custom-rtk-command", null, "Trust the exact custom RTK executable and arguments already declared in project configuration for this invocation.", "Considera attendibili, per questa esecuzione, l’eseguibile RTK personalizzato e gli argomenti esatti già dichiarati nella configurazione del progetto.", { boolean: true }),
  "gate-scope": option("scope", "story|release-manifest|all", "Choose the exact evidence scope to validate.", "Sceglie l’ambito esatto delle prove da convalidare.", { values: ["all", "release-manifest", "story"] }),
  "release-manifest": option("release-manifest", "id-or-path", "Select the exact release manifest by ID or project path.", "Seleziona il manifest di rilascio esatto tramite ID o percorso del progetto."),
  strict: option("strict", null, "Fail when required governance or delivery evidence is incomplete.", "Non supera il controllo quando le prove di governo o consegna richieste sono incomplete.", { boolean: true }),
  "lifecycle-complete": option("lifecycle-complete", null, "Certify final story completion only after every canonical phase, the exact terminal delivery, and the current terminal story-bound workflow.", "Certifica il completamento finale della story solo dopo tutte le fasi canoniche, la consegna esatta terminale e il workflow corrente terminale legato alla story.", { boolean: true }),
  adapter: option("adapter", "adapter-id", "Select the configured budget meter adapter.", "Seleziona l’adapter configurato per la misurazione del budget."),
  "meter-baseline": option("baseline", "baseline-id", "Use the exact immutable meter baseline captured before execution.", "Usa la baseline immutabile ed esatta del contatore acquisita prima dell’esecuzione."),
  provider: option("provider", "provider-id", "Select the provider scope used by the configured meter.", "Seleziona l’ambito del provider usato dal contatore configurato."),
  project: option("project", "project-id", "Select the provider project used by the configured meter.", "Seleziona il progetto del provider usato dal contatore configurato."),
  "from-date": option("from", "YYYY-MM-DD", "Start the provider measurement interval on this date.", "Avvia in questa data l’intervallo di misurazione del provider."),
  "to-date": option("to", "YYYY-MM-DD", "End the provider measurement interval on this date.", "Termina in questa data l’intervallo di misurazione del provider."),
  "session-file": option("session-file", "path", "Read the exact local session evidence used by the configured meter.", "Legge la prova esatta della sessione locale usata dal contatore configurato."),
  "meter-thread-id": option("thread-id", "thread-id", "Select the exact Codex task measured by the configured session adapter.", "Seleziona il task Codex esatto misurato dall’adapter di sessione configurato."),
  "active-time-seconds": option("active-time-seconds", "number", "Record active execution seconds, excluding configured waiting time.", "Registra i secondi di esecuzione attiva, esclusi i tempi di attesa configurati."),
  steps: option("steps", "number", "Record counted agent execution steps, including subagents.", "Registra i passaggi di esecuzione dell’agente conteggiati, inclusi i subagent."),
  "model-calls": option("model-calls", "number", "Record measured model calls.", "Registra le chiamate al modello misurate."),
  "tool-calls": option("tool-calls", "number", "Record measured tool calls.", "Registra le chiamate agli strumenti misurate."),
  "input-tokens": option("input-tokens", "number", "Record measured or estimated input tokens.", "Registra i token di input misurati o stimati."),
  "output-tokens": option("output-tokens", "number", "Record measured or estimated output tokens.", "Registra i token di output misurati o stimati."),
  "cost-amount": option("cost-amount", "decimal", "Record the consumed monetary amount; use only with matching currency and pricing evidence.", "Registra l’importo monetario consumato; usalo solo con valuta e prova del prezzo corrispondenti."),
  currency: option("currency", "ISO-4217", "Set the currency for the recorded cost amount.", "Imposta la valuta dell’importo registrato."),
  "metering-accuracy": option("metering-accuracy", "estimated|unavailable", "Declare manual measurement quality; exact values require a trusted receipt file.", "Dichiara la qualità della misurazione manuale; i valori esatti richiedono un file di ricevuta attendibile.", { values: ["estimated", "unavailable"] }),
  "metering-source": option("metering-source", "adapter-id", "Identify the adapter or system that measured this usage.", "Identifica l’adapter o il sistema che ha misurato questo utilizzo."),
  "pricing-ref": option("pricing-ref", "pricing-id", "Bind a cost value to one immutable pricing reference.", "Vincola un valore di costo a un riferimento di prezzo immutabile."),
  subagent: option("subagent", "id", "Attribute usage to one subagent while keeping it in the proposal total.", "Attribuisce l’utilizzo a un subagent mantenendolo nel totale della proposta."),
  "context-summary": option("context-summary", "text", "Summarize the agreed project facts and boundaries that guide this phase.", "Riepiloga fatti e limiti del progetto concordati che guidano questa fase."),
  "context-file": option("context-file", "path", "Use one project context file; repeat for additional files.", "Usa un file di contesto del progetto; ripeti per altri file.", { repeatable: true }),
  question: option("question", "question", "Record an unresolved question only in an explicit clarification draft; repeat when needed.", "Registra una domanda aperta solo in una bozza esplicita di chiarimento; ripeti quando serve.", { repeatable: true }),
  qa: option("qa", "question|answer", "Record one answered question; repeat when needed.", "Registra una domanda con risposta; ripeti quando serve.", { repeatable: true }),
  assumption: option("assumption", "text", "Record one agreed assumption; repeat when needed.", "Registra un’ipotesi concordata; ripeti quando serve.", { repeatable: true }),
  input: option("input", "text", "Record one required input; repeat when needed.", "Registra un input richiesto; ripeti quando serve.", { repeatable: true }),
  output: option("output", "text", "Record one expected result; repeat when needed.", "Registra un risultato atteso; ripeti quando serve.", { repeatable: true }),
  "output-ref": option("output-ref", "type:template:mode[:phase]", "Use one approved output format, optionally due by workflow phase; the legacy three-part form remains all-due. Repeat for additional outputs.", "Usa un formato di output approvato, facoltativamente dovuto entro una fase del workflow; il formato storico a tre parti resta sempre dovuto. Ripeti per altri output.", { repeatable: true }),
  validation: option("validation", "text", "Record one verification check; repeat when needed.", "Registra un controllo di verifica; ripeti quando serve.", { repeatable: true }),
  "kb-write": option("kb-write", "path", "Allow one lifecycle knowledge write path; repeat when needed.", "Consenti un percorso di scrittura nella conoscenza del ciclo; ripeti quando serve.", { repeatable: true }),
  metric: option("metric", "text", "Record one success metric; repeat when needed.", "Registra una metrica di successo; ripeti quando serve.", { repeatable: true }),
  "owner-agent": option("owner-agent", "name", "Name the agent responsible for the phase.", "Indica l’agente responsabile della fase."),
  model: option("model", "name", "Override the inherited model only when already agreed.", "Sostituisce il modello ereditato solo quando già concordato."),
  reasoning: option("reasoning", "inherit|minimal|low|medium|high", "Override inherited reasoning only when already agreed.", "Sostituisce il livello di ragionamento ereditato solo quando già concordato.", {
    values: ["high", "inherit", "low", "medium", "minimal"],
  }),
  "execution-note": option("execution-note", "text", "Record one agreed execution note; repeat when needed.", "Registra una nota di esecuzione concordata; ripeti quando serve.", { repeatable: true }),
  "capability-recommendation": option("capability-recommendation", "id", "Use one approved tool recommendation; repeat when needed.", "Usa una raccomandazione di strumenti approvata; ripeti quando serve.", { repeatable: true }),
  "capability-policy-file": option("capability-policy-file", "path", "Load an agreed capability policy from a project file; repeat when needed.", "Carica una regola concordata sulle capacità da un file di progetto; ripeti quando serve.", { repeatable: true }),
  "capability-policy-json": option("capability-policy-json", "json", "Load an agreed capability policy from JSON; repeat when needed.", "Carica una regola concordata sulle capacità da JSON; ripeti quando serve.", { repeatable: true }),
  "capability-binding-file": option("capability-binding-file", "path", "Load agreed tool bindings from a project file; repeat when needed.", "Carica associazioni di strumenti concordate da un file di progetto; ripeti quando serve.", { repeatable: true }),
  "capability-binding-json": option("capability-binding-json", "json", "Load agreed tool bindings from JSON; repeat when needed.", "Carica associazioni di strumenti concordate da JSON; ripeti quando serve.", { repeatable: true }),
  "allow-incomplete-contract": option("allow-incomplete-contract", null, "Persist only an explicit clarification, migration, or recovery draft.", "Salva solo una bozza esplicita di chiarimento, migrazione o recupero.", { boolean: true }),
  "allow-unapproved-output-ref": option("allow-unapproved-output-ref", null, "Allow an unapproved output reference only for explicit migration or recovery.", "Consenti un riferimento di output non approvato solo per migrazione o recupero espliciti.", { boolean: true }),
  "replace-story-contract": option("replace-story-contract", null, "Replace an existing story link only for explicit renegotiation or recovery.", "Sostituisce un collegamento esistente della story solo per rinegoziazione o recupero espliciti.", { boolean: true }),
  delivery: option("delivery", "delivery-id", "Name this exact pull request or local release.", "Identifica questa pull request o questo rilascio locale esatto."),
  kind: option("kind", "pull_request|local_release", "Choose whether the exact delivery is a pull request or a local release.", "Scegli se la consegna esatta è una pull request o un rilascio locale.", { values: ["local_release", "pull_request"] }),
  level: option("level", "supervised|checkpointed|bounded-autonomous", "Choose explicitly for this delivery: supervised means Guided, checkpointed means Autonomy with checks, and bounded-autonomous means Full autonomy within the displayed limits.", "Scegli esplicitamente per questa consegna: supervised significa Guidato, checkpointed significa Autonomia con controlli e bounded-autonomous significa Autonomia completa entro i limiti mostrati.", { values: ["bounded-autonomous", "checkpointed", "supervised"] }),
  repository: option("repository", "owner/repository", "Bind a pull-request delivery to one exact GitHub repository.", "Vincola una consegna pull request a un repository GitHub esatto."),
  "scan-base": option(
    "base",
    "commit-ish",
    "Compare against this exact commit; it defaults to the commit the story's task start recorded.",
    "Confronta con questo commit esatto; per default usa il commit registrato all’avvio dell’attività della story.",
  ),
  "scan-head": option(
    "head",
    "commit-ish",
    "Name the commit whose changed files are scanned; it defaults to the current HEAD.",
    "Indica il commit di cui vengono analizzati i file modificati; per default usa HEAD.",
  ),
  base: option("base", "branch", "Bind a pull-request delivery to its exact base branch.", "Vincola una consegna pull request al branch base esatto."),
  head: option("head", "branch", "Bind a pull-request delivery to its exact head branch.", "Vincola una consegna pull request al branch sorgente esatto."),
  "pr-mode": option("pr-mode", "new|existing", "Choose whether this profile will create a new PR or govern one that already exists; defaults to new.", "Scegli se questo profilo creerà una nuova PR o governerà una PR già esistente; il default è new.", { values: ["existing", "new"] }),
  "pr-number": option("pr-number", "positive-integer", "Pin the exact existing pull-request number.", "Vincola il numero esatto della pull request esistente."),
  "pr-head-sha": option("pr-head-sha", "full-commit-sha", "Pin the reviewed existing PR head when it cannot be derived from the local head branch.", "Vincola il commit sorgente revisionato della PR esistente quando non può essere ricavato dal branch locale."),
  "write-path": option(
    "write-path",
    "path",
    "For a requirement or pull request, name one path inside the project; requirement paths are stored Git-relative. For a local release, use an absolute destination inside --target-root. Repeat for additional paths.",
    "Per un requisito o una pull request, indica un percorso interno al progetto; i percorsi del requisito vengono salvati relativi a Git. Per un rilascio locale usa una destinazione assoluta interna a --target-root. Ripeti per altri percorsi.",
    { repeatable: true },
  ),
  "allow-action": option("allow-action", "action", "Allow one canonical action; repeat for additional actions.", "Consenti un’azione canonica; ripeti per altre azioni.", {
    repeatable: true,
    values: ["build.local", "data.migrate", "data.rollback", "git.commit", "git.push", "pull_request.create", "pull_request.merge", "pull_request.update", "release.local", "repository.read", "repository.write", "rollback.verify", "test.run"],
  }),
  "merge-allowed": option("merge-allowed", null, "Include pull-request merge in the exact allowed action boundary.", "Include il merge della pull request nel limite esatto delle azioni consentite.", { boolean: true }),
  "target-root": option(
    "target-root",
    "absolute-path",
    "Bind a local release to one exact destination root. It may be absent while planning, but must exist as a real directory before rollback.verify, data.migrate, data.rollback, or release.local. For a new root, request build.local authorization first, let the external builder create only that root and its approved children, then complete build.local with evidence; the CLI never creates directories.",
    "Vincola un rilascio locale a una destinazione radice esatta. Può essere assente in pianificazione, ma deve esistere come cartella reale prima di rollback.verify, data.migrate, data.rollback o release.local. Per una nuova root, richiedi prima l’autorizzazione di build.local, lascia che lo strumento esterno crei soltanto quella root e i figli approvati, quindi completa build.local con evidenza; il CLI non crea mai cartelle.",
  ),
  "smoke-cwd": option("smoke-cwd", "path", "Run local smoke tests from this directory inside one allowed write path; it defaults to the only write path and is required when several are allowed.", "Esegue gli smoke test locali da questa cartella interna a un percorso di scrittura consentito; usa l'unico percorso come default ed è obbligatoria quando i percorsi sono più di uno."),
  "smoke-test": option("smoke-test", "json-argv", "Record a reviewed, shell-free command whose explicit entrypoint stays inside the artifact. Writes and host/external network are denied, but host-file confidentiality and transitive-import attestation are not provided; portable API checks must run in-process.", "Registra un comando revisionato e senza shell, con entrypoint esplicito interno all'artefatto. Scrittura e rete host/esterna sono negate, ma non sono garantite riservatezza dei file host o attestazione degli import transitivi; i controlli API portabili devono avvenire nel processo."),
  "test-command": option(
    "command",
    "json-argv",
    "Record the exact command that was executed, as a JSON argument vector such as '[\"npm\",\"test\"]'. The command is recorded, never run.",
    "Registra il comando esattamente eseguito, come vettore JSON di argomenti, ad esempio '[\"npm\",\"test\"]'. Il comando viene registrato, mai eseguito.",
  ),
  "test-cwd": option(
    "cwd",
    "path",
    "Record the project directory the command ran in; it defaults to the project root.",
    "Registra la cartella di progetto in cui il comando è stato eseguito; per default usa la radice del progetto.",
  ),
  "test-exit-code": option(
    "exit-code",
    "0..255",
    "Record the exit status the command returned.",
    "Registra il codice di uscita restituito dal comando.",
  ),
  "test-passed": option(
    "passed",
    "count",
    "Record how many test cases passed; it defaults to 0.",
    "Registra quanti casi di test sono passati; per default è 0.",
  ),
  "test-failed": option(
    "failed",
    "count",
    "Record how many test cases failed; it defaults to 0.",
    "Registra quanti casi di test sono falliti; per default è 0.",
  ),
  "test-skipped": option(
    "skipped",
    "count",
    "Record how many test cases were skipped; it defaults to 0.",
    "Registra quanti casi di test sono stati saltati; per default è 0.",
  ),
  "test-framework": option(
    "framework",
    "name",
    "Name the test runner that produced the result.",
    "Indica lo strumento di test che ha prodotto il risultato.",
  ),
  "test-started-at": option(
    "started-at",
    "timestamp",
    "Record when the run started, as an RFC 3339 timestamp; the finish time is the moment the record is written.",
    "Registra l’inizio dell’esecuzione come timestamp RFC 3339; l’ora di fine è il momento in cui il record viene scritto.",
  ),
  "incident-severity": option(
    "severity",
    "sev1|sev2|sev3|sev4",
    "Record the incident severity.",
    "Registra la gravità dell’incidente.",
    { values: ["sev1", "sev2", "sev3", "sev4"] },
  ),
  "incident-detected-at": option(
    "detected-at",
    "timestamp",
    "Record when the incident was detected, as an RFC 3339 timestamp; it defaults to the moment the record is written.",
    "Registra il momento di rilevazione dell’incidente come timestamp RFC 3339; per default usa il momento in cui il record viene scritto.",
  ),
  "incident-resolved-at": option(
    "resolved-at",
    "timestamp",
    "Record when the incident was resolved, as an RFC 3339 timestamp; omit while still open.",
    "Registra il momento di risoluzione dell’incidente come timestamp RFC 3339; ometti se ancora aperto.",
  ),
  "incident-impact": option(
    "impact",
    "text",
    "Describe the user-visible or operational impact.",
    "Descrivi l’impatto operativo o visibile agli utenti.",
  ),
  "incident-action": option(
    "action",
    "text",
    "Record one action taken in response; repeat for additional actions.",
    "Registra un’azione intrapresa in risposta; ripeti per altre azioni.",
    { repeatable: true },
  ),
  "feedback-source": option(
    "source",
    "user|monitoring|review|other",
    "Record where the feedback came from.",
    "Registra la provenienza del feedback.",
    { values: ["user", "monitoring", "review", "other"] },
  ),
  "feedback-sentiment": option(
    "sentiment",
    "positive|neutral|negative",
    "Record the observed sentiment; omit when not applicable.",
    "Registra il sentiment osservato; ometti quando non applicabile.",
    { values: ["positive", "neutral", "negative"] },
  ),
  rollback: option("rollback", "procedure", "Record the exact local rollback procedure.", "Registra la procedura esatta di rollback locale."),
  "data-target": option("data-target", "path", "Bind a reversible local migration to one exact existing data file.", "Vincola una migrazione locale reversibile a un file dati esistente ed esatto."),
  "data-scope": option("data-scope", "scope", "Bind one exact logical data scope; repeat for additional scopes.", "Vincola un ambito dati logico esatto; ripeti per altri ambiti.", { repeatable: true }),
  "migration-preview": option("migration-preview", "evidence-path", "Bind one immutable dry-run or preview evidence file; repeat for additional evidence.", "Vincola un file immutabile di dry-run o anteprima; ripeti per altre prove.", { repeatable: true }),
  "backup-path": option("backup-path", "path", "Bind the exact mandatory backup file used by data.migrate and data.rollback.", "Vincola il file di backup obbligatorio ed esatto usato da data.migrate e data.rollback."),
  "actor-type": option("actor-type", "human|ci|agent|system", "Record the approving actor type.", "Registra il tipo di soggetto che approva.", { values: ["agent", "ci", "human", "system"] }),
  "direct-approval-actor-type": option("actor-type", "human|ci", "Record the person or CI system directly approving this protected change.", "Registra la persona o il sistema CI che approva direttamente questa modifica protetta.", { values: ["ci", "human"] }),
  "actor-name": option("actor-name", "name", "Record the approving actor name.", "Registra il nome di chi approva."),
  "actor-email": option("actor-email", "email", "Record the approving actor email.", "Registra l’email di chi approva."),
  "approval-source": option("approval-source", "explicit-user|ci|automation|bootstrap", "Record the formal source of the approval.", "Registra la fonte formale dell’approvazione.", { values: ["automation", "bootstrap", "ci", "explicit-user"] }),
  "direct-approval-source": option("approval-source", "explicit-user|ci", "Record the direct user or CI source of this protected approval.", "Registra la fonte diretta, utente o CI, di questa approvazione protetta.", { values: ["ci", "explicit-user"] }),
  "approval-status": option("status", "approved|changes_requested|rejected", "Record the approval decision.", "Registra la decisione di approvazione.", { values: ["approved", "changes_requested", "rejected"] }),
  "preserve-status": option("preserve-status", null, "Record the decision without changing the contract status.", "Registra la decisione senza modificare lo stato del contract.", { boolean: true }),
  "host-receipt-file": option("host-receipt-file", "path", "Supply the trusted host receipt when project policy requires it.", "Fornisci la ricevuta dell’host fidato quando la regola del progetto la richiede."),
  "intent-json": option("intent-json", "json", "Provide the structured request already prepared for this task.", "Fornisci la richiesta strutturata già preparata per questa attività."),
  "intent-file": option("intent-file", "path", "Read the structured request from one project file.", "Legge la richiesta strutturata da un file del progetto."),
  "task-text": option("text", "text", "Keep the original request as context; the structured request still selects the workflow.", "Conserva la richiesta originale come contesto; è comunque la richiesta strutturata a selezionare il flusso."),
  "confirm-start": option("confirm-start", null, "Record that a person confirmed this exact task start after reviewing it.", "Registra che una persona ha confermato l’avvio esatto dell’attività dopo averlo controllato.", { boolean: true }),
  "confirm-legacy-bootstrap": option(
    "confirm-legacy-bootstrap",
    null,
    "Explicitly adopt the displayed exact v0.11 bootstrap before creating its first configuration lock.",
    "Adotta esplicitamente il bootstrap v0.11 esatto mostrato prima di creare il suo primo lock di configurazione.",
    { boolean: true },
  ),
  "revise-contract": option("revise-contract", null, "Stop and revise the work agreement before starting.", "Fermati e modifica l’accordo di lavoro prima di iniziare.", { boolean: true }),
  "output-type": option("type", "artifact-type", "Select the kind of output to resolve.", "Seleziona il tipo di risultato da individuare."),
  "linked-output-type": option("type", "artifact-type", "Select the kind of produced output to link.", "Seleziona il tipo di output prodotto da collegare."),
  "output-types": option("type", "artifact-type", "Select the linked output type completed by this step.", "Seleziona il tipo di output collegato completato da questa fase."),
  "assessment-artifact-type": option("type", "artifact-type", "Choose the assessment artifact type; defaults to the configured technical-analysis type.", "Sceglie il tipo di artefatto dell’assessment; per default usa il tipo technical-analysis configurato."),
  "output-template-type": option("type", "artifact-type", "Name the reusable artifact type this template produces.", "Indica il tipo di artefatto riutilizzabile prodotto dal template."),
  template: option("template", "template-id", "Use one exact approved output template.", "Usa un template di output approvato ed esatto."),
  "assessment-preset": option("preset", "technical-assessment", "Start from the included assessment preset when no custom template is selected.", "Parte dal preset di assessment incluso quando non è selezionato un template personalizzato.", { values: ["technical-assessment"] }),
  "template-from": option("from", "path", "Copy template content from one project file; do not combine with --body or --preset.", "Copia il contenuto del template da un file del progetto; non combinarlo con --body o --preset."),
  "template-body": option("body", "text", "Use inline template content; do not combine with --from or --preset.", "Usa contenuto inline per il template; non combinarlo con --from o --preset."),
  "template-preset": option("preset", "technical-assessment", "Start from the included technical-assessment preset; do not combine with --from or --body.", "Parte dal preset technical-assessment incluso; non combinarlo con --from o --body.", { values: ["technical-assessment"] }),
  "output-format": option("format", "markdown|docx|xlsx|pdf|pptx|html|json|csv|custom", "Choose the generated artifact format; defaults to markdown.", "Sceglie il formato dell’artefatto generato; il default è markdown.", { values: ["csv", "custom", "docx", "html", "json", "markdown", "pdf", "pptx", "xlsx"] }),
  "output-delivery": option("delivery", "artifact|artifact-plus-chat-summary", "Choose whether delivery includes only the artifact or also a chat summary.", "Sceglie se la consegna include solo l’artefatto oppure anche un riepilogo in chat.", { values: ["artifact", "artifact-plus-chat-summary"] }),
  extension: option("extension", ".ext", "Set the file extension; required for custom format and fixed by built-in formats.", "Imposta l’estensione del file; è obbligatoria per il formato custom e fissa per i formati inclusi."),
  "media-type": option("media-type", "type/subtype", "Set the media type for a custom format.", "Imposta il media type per un formato custom."),
  generator: option("generator", "capability", "Set the generator capability for a custom format.", "Imposta la capacità di generazione per un formato custom."),
  "decision-id": option("decision-id", "id", "Use a stable ID for the recorded template approval decision.", "Usa un ID stabile per la decisione registrata di approvazione del template."),
  "output-decision-id": option("decision-id", "id", "Use the exact approved decision for an intentional duplicate or structure override.", "Usa la decisione approvata ed esatta per un duplicato intenzionale o una modifica della struttura."),
  "verification-receipt-file": option("receipt-file", "path", "Read the generator or verification receipt for this exact artifact.", "Legge la ricevuta di generazione o verifica di questo artefatto esatto."),
  rationale: option("rationale", "text", "Explain an explicitly approved output-link exception.", "Spiega un’eccezione al collegamento dell’output approvata esplicitamente."),
  "output-mode": option("mode", "reuse|delta|new", "Choose whether this artifact reuses, extends, or newly creates the required output.", "Sceglie se l’artefatto riusa, estende oppure crea un nuovo output richiesto.", { values: ["delta", "new", "reuse"] }),
  "base-artifact": option("base-artifact", "path", "Select the exact artifact that a delta output extends.", "Seleziona l’artefatto esatto esteso da un output delta."),
  "allow-unapproved-contract-output": option("allow-unapproved-contract-output", null, "Bypass the approved-contract check only for an explicit migration or recovery.", "Salta il controllo del contract approvato solo per una migrazione o un recupero espliciti.", { boolean: true }),
  "story-step": option(
    "step",
    "configured-step",
    "Select a step from this project's phase_order; the shipped defaults are discovery, analysis, design, implementation, validation, and release. Analysis also accepts the legacy functional-analysis and technical-analysis aliases.",
    "Seleziona una fase dal phase_order del progetto; i valori predefiniti sono discovery, analysis, design, implementation, validation e release. Analysis accetta anche gli alias legacy functional-analysis e technical-analysis.",
  ),
  "manual-phase": option("phase", "manual", "Use the operator-owned manual optimization capture phase.", "Usa la fase manuale di acquisizione dell’ottimizzazione gestita dall’operatore.", { values: ["manual"] }),
  "completion-id": option("completion-id", "id", "Use a stable ID for this exact completion record.", "Usa un ID stabile per questo record di completamento esatto."),
  "next-story-step": option("next-step", "step", "Record the next expected lifecycle step instead of the default sequence.", "Registra la prossima fase prevista invece della sequenza predefinita."),
  "release-claim": option("release-claim", null, "Release the active story claim after recording this completed step.", "Rilascia l’assegnazione attiva della story dopo aver registrato questa fase completata.", { boolean: true }),
  reason: option("reason", "text", "Explain the exact change, release, or exception.", "Spiega la modifica, il rilascio o l’eccezione esatti."),
  "authorization-action": option("allow-action", "canonical-action", "Allow one configured canonical approval action; repeat for additional actions.", "Consenti un’azione canonica configurata; ripeti per altre azioni.", { repeatable: true }),
  "allow-use": option("allow-use", "action=subject", "Bind one canonical action to one exact subject; repeat for additional pairs.", "Vincola un’azione canonica a un soggetto esatto; ripeti per altre coppie.", { repeatable: true }),
  "allow-subject": option("allow-subject", "id", "Allow one exact subject; repeat for additional subjects.", "Consenti un soggetto esatto; ripeti per altri soggetti.", { repeatable: true }),
  "allow-artifact-type": option("allow-artifact-type", "artifact-type", "Limit the delegation to one artifact type; repeat when needed.", "Limita la delega a un tipo di artefatto; ripeti quando serve.", { repeatable: true }),
  "allow-boundary": option("allow-boundary", "boundary", "Limit the delegation to one approval boundary; repeat when needed.", "Limita la delega a un confine di approvazione; ripeti quando serve.", { repeatable: true }),
  "max-uses": option("max-uses", "positive-integer", "Set the maximum number of distinct authorized uses.", "Imposta il numero massimo di utilizzi autorizzati distinti."),
  "authority-assurance": option("authority-assurance", "audit_only|host_verified", "Choose the authority assurance mode for this delegation.", "Sceglie la modalità di garanzia dell’autorità per questa delega.", { values: ["audit_only", "host_verified"] }),
  "authorization-actor-type": option("actor-type", "human|ci", "Record the person or CI system directly granting the delegation.", "Registra la persona o il sistema CI che concede direttamente la delega.", { values: ["ci", "human"] }),
  "authorization-approval-source": option("approval-source", "explicit-user|ci", "Record the direct source of the delegation approval.", "Registra la fonte diretta dell’approvazione della delega.", { values: ["ci", "explicit-user"] }),
  definition: option("definition", "definition-id", "Select the reusable way of working.", "Seleziona il modo di lavorare riutilizzabile."),
  "definition-version": option("definition-version", "version", "Select one exact version of the way of working.", "Seleziona una versione esatta del modo di lavorare."),
  "definition-file": option(
    "definition-file",
    "project-path",
    "Load the proposed way of working from JSON inside the target project. For a first custom phase, initialize with templates/workflow-software-project-v3-integration-review, then copy its workflow-definition.json into the project and pass that project-relative copy.",
    "Carica il modo di lavorare proposto da un JSON interno al progetto di destinazione. Per una prima fase personalizzata, inizializza con templates/workflow-software-project-v3-integration-review, poi copia workflow-definition.json nel progetto e passa quella copia relativa al progetto.",
  ),
  "definition-json": option("definition-json", "json", "Load the proposed way of working from inline JSON.", "Carica il modo di lavorare proposto da JSON fornito direttamente."),
  overlay: option("overlay", "overlay-id", "Select the project-specific adjustment.", "Seleziona l’adattamento specifico del progetto."),
  "overlay-version": option("overlay-version", "version", "Select one exact version of the project adjustment.", "Seleziona una versione esatta dell’adattamento del progetto."),
  "overlay-file": option("overlay-file", "path", "Load the proposed project adjustment from a local JSON file.", "Carica l’adattamento proposto da un file JSON locale."),
  "overlay-json": option("overlay-json", "json", "Load the proposed project adjustment from inline JSON.", "Carica l’adattamento proposto da JSON fornito direttamente."),
  "workflow-preset": option("workflow-preset", "software-project|change-request|technical-assessment|generic-governed-process", "Start from one included way of working.", "Parti da uno dei modi di lavorare inclusi.", { values: ["change-request", "generic-governed-process", "software-project", "technical-assessment"] }),
  "guard-input-json": option("guard-input-json", "json", "Supply bounded facts used by the permitted transition checks.", "Fornisci i dati limitati usati dai controlli consentiti per il passaggio."),
  "request-id": option("request-id", "id", "Make a repeated transition request safe to retry.", "Rende sicuro riprovare la stessa richiesta di passaggio."),
  from: option("from", "state", "Declare the current state when proposing an adjustment.", "Dichiara lo stato corrente quando proponi un adattamento."),
  to: option("to", "state", "Select the next state.", "Seleziona lo stato successivo."),
  action: option("action", "canonical-action", "Select the exact protected operation to authorize or complete.", "Seleziona l’operazione protetta esatta da autorizzare o completare.", {
    values: ["build.local", "data.migrate", "data.rollback", "git.commit", "git.push", "pull_request.create", "pull_request.merge", "pull_request.update", "release.local", "repository.read", "repository.write", "rollback.verify", "test.run"],
  }),
  outcome: option("outcome", "passed|failed", "Complete the previously authorized action with its exact outcome.", "Completa l’azione già autorizzata con il suo esito esatto.", { values: ["failed", "passed"] }),
  "scope-path": option("scope-path", "path", "Bind a commit authorization to one exact staged path; repeat for the whole staged set.", "Vincola l’autorizzazione del commit a un percorso esatto già in staging; ripeti per l’intero insieme.", { repeatable: true }),
  remote: option("remote", "name", "Bind a push authorization to one exact Git remote.", "Vincola l’autorizzazione del push a un remote Git esatto."),
  "pr-url": option("pr-url", "url", "Pin an existing PR at proposal time or bind an action to one exact pull-request URL.", "Vincola una PR esistente durante la proposta oppure un’azione a un URL esatto della pull request."),
  "git-provider": option("git-provider", "provider-id", "Select the registered observer that verifies Git pushes.", "Seleziona l’osservatore registrato che verifica i push Git."),
  "pull-request-provider": option("pull-request-provider", "provider-id", "Select the registered observer that verifies pull-request state.", "Seleziona l’osservatore registrato che verifica lo stato delle pull request."),
  "local-release-provider": option("local-release-provider", "provider-id", "Select the registered observer that verifies the local release boundary.", "Seleziona l’osservatore registrato che verifica il limite del rilascio locale."),
  "expected-pr-title": option("expected-pr-title", "title", "Bind a pull-request update to the exact expected title.", "Vincola l’aggiornamento della pull request al titolo atteso esatto."),
  "expected-pr-body-sha256": option("expected-pr-body-sha256", "sha256", "Bind a pull-request update to the expected body hash.", "Vincola l’aggiornamento della pull request all’hash atteso del testo."),
  "expected-pr-state": option("expected-pr-state", "ready|draft", "Bind a pull-request update to the expected review state.", "Vincola l’aggiornamento della pull request allo stato di revisione atteso.", { values: ["draft", "ready"] }),
  "expected-pr-base": option("expected-pr-base", "branch", "Bind a pull-request update to the expected base branch.", "Vincola l’aggiornamento della pull request al branch base atteso."),
  "confirm-action": option("confirm-action", null, "Confirm the exact checkpointed action displayed for review.", "Conferma l’azione esatta mostrata al checkpoint.", { boolean: true }),
  "trace-type": option("type", "trace-type", "Choose the trace event type.", "Scegli il tipo di evento della traccia.", { values: ["assumption", "claim", "decision", "gate", "handoff", "implementation", "lock", "release", "risk", "sync", "test"] }),
  "trace-outcome": option("outcome", "passed|failed|blocked|skipped|ready", "Record the trace outcome when one exists.", "Registra l’esito della traccia quando presente.", { values: ["blocked", "failed", "passed", "ready", "skipped"] }),
  "trace-action": option("action", "action", "Record the exact action represented by the event.", "Registra l’azione esatta rappresentata dall’evento."),
  "target-event": option("target-event", "trace-event-id", "Select the historical trace event whose evidence policy is being bound.", "Seleziona l’evento storico della traccia a cui associare la regola sulle prove.", { repeatable: true }),
  "redaction-policy": option("redaction-policy", "policy-id", "Select the exact supported evidence redaction policy.", "Seleziona la regola supportata esatta per oscurare le prove.", {
    values: ["legacy_evidence_v1", "operational_evidence_v1", "operational_v2"],
  }),
  recover: option("recover", null, "Recover an interrupted identity migration using its exact lock and reviewed plan.", "Recupera una migrazione delle identità interrotta usando il lock e il piano revisionato esatti.", { boolean: true }),
  "recovery-nonce": option("recovery-nonce", "nonce", "Bind recovery to the exact interrupted migration lock.", "Vincola il recupero al lock esatto della migrazione interrotta."),
  related: option("related", "id", "Link one related record; repeat for additional records.", "Collega un record correlato; ripeti per altri record.", { repeatable: true }),
  "git-event": option("event", "push|commit|merge|pull|rebase|branch|handoff|pr", "Record which source-control event happened.", "Registra quale evento di source control è avvenuto.", {
    values: ["branch", "commit", "handoff", "merge", "pr", "pull", "push", "rebase"],
  }),
  "sync-remote": option("remote", "name", "Record the exact Git remote involved in the event.", "Registra il remote Git esatto coinvolto nell’evento."),
  "before-sha": option("before-sha", "sha", "Record the commit the event started from.", "Registra il commit da cui è partito l’evento."),
  "after-sha": option("after-sha", "sha", "Record the commit the event ended on; defaults to the current HEAD.", "Registra il commit su cui è terminato l’evento; per default usa l’HEAD corrente."),
  "sync-pr-url": option("pr-url", "url", "Record the exact pull-request URL for this event.", "Registra l’URL esatto della pull request per questo evento."),
  "archive-before": option("before", "date-or-age", "Select only records older than this date or age.", "Seleziona solo i record più vecchi di questa data o età."),
  "report-since": option("since", "date-or-age", "Start the reported window at this date or age.", "Inizia la finestra del report a questa data o età."),
  "report-until": option("until", "date-or-age", "End the reported window at this date or age.", "Termina la finestra del report a questa data o età."),
  "report-actor": option("actor", "identity", "Show only events recorded by this actor.", "Mostra solo gli eventi registrati da questo soggetto."),
  query: option("query", "text", "Provide the question or search text as an option instead of a positional argument.", "Fornisce la domanda o il testo di ricerca come opzione invece che come argomento posizionale."),
  "query-json": option("query-json", "json", "Provide one bounded query as inline JSON; do not combine with --query-file.", "Fornisce una query delimitata come JSON inline; non combinarla con --query-file."),
  "query-file": option("query-file", "path", "Read one bounded query from a project file; do not combine with --query-json.", "Legge una query delimitata da un file del progetto; non combinarla con --query-json."),
  "baseline-kind": option("kind", "kind", "Record what kind of baseline this is; defaults to existing-project.", "Registra il tipo di baseline; per default usa existing-project."),
  "work-item-type": option("type", "epic|task", "Choose which structured work item is created.", "Sceglie quale elemento di lavoro strutturato viene creato.", { values: ["epic", "task"] }),
  "work-item-title": option("title", "text", "Name this work item in plain language.", "Assegna a questo elemento di lavoro un nome in linguaggio semplice."),
  "work-item-parent": option("parent", "id", "Link this work item to its parent work item.", "Collega questo elemento di lavoro al suo elemento padre."),
  "work-item-status": option("status", "status", "Set only the initial work-item status; later status changes are owned by the governed lifecycle.", "Imposta solo lo stato iniziale dell’elemento di lavoro; i cambi di stato successivi appartengono al ciclo di vita governato."),
  "breakdown-levels": option("levels", "work-item-type", "List the work-item levels this project uses; repeat for every level.", "Elenca i livelli di elemento di lavoro usati dal progetto; ripeti per ogni livello.", { repeatable: true }),
  "default-flow": option("default-flow", "work-item-types", "Set the default sequence of work-item levels.", "Imposta la sequenza predefinita dei livelli di elemento di lavoro."),
  "delivery-unit": option("delivery-unit", "epic|story|task", "Choose which work-item level is the delivery unit.", "Sceglie quale livello di elemento di lavoro è l’unità di consegna."),
  "strict-gate-unit": option("strict-gate-unit", "epic|story|task", "Choose which work-item level the strict gate applies to.", "Sceglie a quale livello di elemento di lavoro si applica il gate strict."),
  "task-gate": option("task-gate", "mode", "Choose how task-level gates are applied.", "Sceglie come vengono applicati i gate a livello di task."),
  "breakdown-item": option("item", "type:id[:title]", "Declare one work item of the breakdown; repeat for every item.", "Dichiara un elemento di lavoro della suddivisione; ripeti per ogni elemento.", { repeatable: true }),
  "breakdown-rationale": option("rationale", "text", "Explain why the work is split this way.", "Spiega perché il lavoro è suddiviso così."),
  "dependency-edge": option("edge", "from:type:to", "Declare one dependency between work items; repeat for every dependency.", "Dichiara una dipendenza tra elementi di lavoro; ripeti per ogni dipendenza.", { repeatable: true }),
  "dependency-rationale": option("rationale", "text", "Explain why these dependencies exist.", "Spiega perché esistono queste dipendenze."),
  "terminal-status": option("terminal-status", "merged|closed|released|rolled_back|cancelled|superseded|revoked", "Record the exact final state of the closed delivery.", "Registra lo stato finale esatto della consegna chiusa.", {
    values: ["cancelled", "closed", "merged", "released", "revoked", "rolled_back", "superseded"],
  }),
  "to-agent": option("to-agent", "name", "Name the agent that receives the work.", "Indica l’agente che riceve l’attività."),
  "handoff-id": option("handoff-id", "id", "Name this handoff; defaults to a generated ID.", "Assegna un ID a questo passaggio; per default ne genera uno."),
  "handoff-status": option("status", "open|accepted|closed|rejected|cancelled", "Set only the initial handoff status.", "Imposta solo lo stato iniziale del passaggio.", { values: ["accepted", "cancelled", "closed", "open", "rejected"] }),
  "handoff-close-status": option("status", "accepted|closed|cancelled", "Choose how the handoff is closed.", "Sceglie come viene chiuso il passaggio.", { values: ["accepted", "cancelled", "closed"] }),
  "open-item": option("open-item", "text", "Record one item that is still open; repeat for additional items.", "Registra un elemento ancora aperto; ripeti per altri elementi.", { repeatable: true }),
  "trace-limit": option("trace-limit", "number", "Limit how many recent trace events the prepared package includes.", "Limita quanti eventi recenti di cronologia include il pacchetto preparato."),
  "claim-status": option("status", "active|released|transferred|cancelled", "Record the resulting assignment status.", "Registra lo stato risultante dell’assegnazione.", { values: ["active", "cancelled", "released", "transferred"] }),
  "claim-notes": option("notes", "text", "Record a concise note about this assignment.", "Registra una nota concisa su questa assegnazione."),
  "lock-id": option("id", "id", "Name this phase pause; defaults to a generated ID.", "Assegna un ID a questa pausa di fase; per default ne genera uno."),
  "lock-scope": option("scope", "text", "Bind the pause to one explicit scope; defaults to the paused phase.", "Vincola la pausa a un ambito esplicito; per default usa la fase messa in pausa."),
  "lock-status": option("status", "active|released|cancelled|expired", "Record the resulting phase-pause status.", "Registra lo stato risultante della pausa di fase.", { values: ["active", "cancelled", "expired", "released"] }),
  "identity-map-json": option("identity-map-json", "json", "Provide the identity mapping as inline JSON; do not combine with --identity-map-file.", "Fornisce la mappatura delle identità come JSON inline; non combinarla con --identity-map-file."),
  "identity-map-file": option("identity-map-file", "path", "Read the identity mapping from a project file; do not combine with --identity-map-json.", "Legge la mappatura delle identità da un file del progetto; non combinarla con --identity-map-json."),
  "from-email": option("from-email", "email", "Select the exact recorded identity to migrate.", "Seleziona l’identità registrata esatta da migrare."),
  "to-email": option("to-email", "email", "Set the exact replacement identity address.", "Imposta l’indirizzo esatto dell’identità sostitutiva."),
  "to-name": option("to-name", "name", "Set the exact replacement identity name.", "Imposta il nome esatto dell’identità sostitutiva."),
  "trace-git-event": option("git-event", "push|commit|merge|pull|rebase|branch|handoff|pr", "Record the source-control event this trace event belongs to.", "Registra l’evento di source control a cui appartiene questo evento della traccia.", {
    values: ["branch", "commit", "handoff", "merge", "pr", "pull", "push", "rebase"],
  }),
  "input-summary": option("input-summary", "text", "Summarize one input the event used; repeat for additional inputs.", "Riassume un input usato dall’evento; ripeti per altri input.", { repeatable: true }),
  "output-summary": option("output-summary", "text", "Summarize one output the event produced; repeat for additional outputs.", "Riassume un output prodotto dall’evento; ripeti per altri output.", { repeatable: true }),
  alternative: option("alternative", "text", "Record one alternative that was considered; repeat for additional alternatives.", "Registra un’alternativa valutata; ripeti per altre alternative.", { repeatable: true }),
  "rationale-summary": option("rationale-summary", "text", "Summarize why this outcome was chosen.", "Riassume perché è stato scelto questo esito."),
  explanation: option("explanation", "text", "Record the plain-language explanation stored with the event.", "Registra la spiegazione in linguaggio semplice salvata con l’evento."),
  "explanation-kind": option("explanation-kind", "codex-generated|deterministic|human-authored", "Declare how the explanation was produced; it requires --explanation.", "Dichiara come è stata prodotta la spiegazione; richiede --explanation.", {
    values: ["codex-generated", "deterministic", "human-authored"],
  }),
});

const GROUP_DESCRIPTIONS = deepFreeze({
  config: text("Inspect or safely migrate project configuration.", "Controlla o migra in sicurezza la configurazione del progetto."),
  optimization: text("Measure and reduce command output without losing evidence.", "Misura e riduce l’output dei comandi senza perdere prove."),
  onboard: text("Bring an existing project into the lifecycle.", "Inserisce un progetto esistente nel ciclo di lavoro."),
  baseline: text("Agree and track the current project state.", "Concorda e traccia lo stato attuale del progetto."),
  assessment: text("Prepare and run an agreed assessment.", "Prepara ed esegue un assessment concordato."),
  workflow: text("Reuse, adapt, and run agreed ways of working.", "Riusa, adatta ed esegue modi di lavorare concordati."),
  budget: text("Set and inspect execution limits and usage.", "Imposta e controlla limiti e utilizzo dell’esecuzione."),
  requirement: text("Agree outcomes and acceptance criteria one requirement at a time.", "Concorda risultati e criteri di accettazione requisito per requisito."),
  autonomy: text("Choose how independently one exact delivery may proceed.", "Sceglie quanta autonomia dare a una singola consegna."),
  contract: text("Define and approve the implementation agreement.", "Definisce e approva l’accordo di implementazione."),
  story: text("Create, claim, hand off, and complete delivery stories.", "Crea, assegna, passa e completa le story di consegna."),
  "story acceptance": text("Complete observable story success criteria before work starts.", "Completa i criteri di successo osservabili della story prima che inizi il lavoro."),
  work: text("Create structured work items.", "Crea elementi di lavoro strutturati."),
  breakdown: text("Agree how a requirement is split into deliverable work.", "Concorda come dividere un requisito in lavoro consegnabile."),
  dependency: text("Agree and inspect blocking relationships.", "Concorda e controlla le dipendenze bloccanti."),
  capability: text("Select the tools and skills allowed for the work.", "Seleziona strumenti e skill consentiti per il lavoro."),
  approval: text("See decisions that still need a person.", "Mostra le decisioni che richiedono ancora una persona."),
  authorization: text("Delegate exact decisions with limits and expiry.", "Delega decisioni esatte con limiti e scadenza."),
  task: text("Start work only when its agreement and limits are ready.", "Avvia il lavoro solo quando accordo e limiti sono pronti."),
  handoff: text("Close a recorded handoff.", "Chiude un passaggio di consegne registrato."),
  phase: text("Pause or reopen a lifecycle phase.", "Mette in pausa o riapre una fase del ciclo di lavoro."),
  trace: text("Record or compact the delivery history.", "Registra o compatta la cronologia della consegna."),
  sync: text("Record source-control synchronization events.", "Registra gli eventi di sincronizzazione del codice."),
  test: text("Record the evidence produced by a test run.", "Registra le prove prodotte da un’esecuzione di test."),
  output: text("Agree templates and link produced artifacts.", "Concorda template e collega gli artefatti prodotti."),
  cache: text("Maintain the local derived-data cache.", "Gestisce la cache locale dei dati derivati."),
  manifest: text("Rebuild deterministic project manifests.", "Rigenera manifest deterministici del progetto."),
  archive: text("Plan or archive completed records.", "Pianifica o archivia i record completati."),
  migration: text("Plan and apply controlled data migrations.", "Pianifica e applica migrazioni controllate dei dati."),
  report: text("Read the project history in human or machine form.", "Legge la cronologia del progetto in forma umana o automatizzabile."),
  index: text("Rebuild the local search index.", "Rigenera l’indice di ricerca locale."),
  kb: text("Search the local project knowledge base.", "Cerca nella base di conoscenza locale del progetto."),
  gate: text("Check whether recorded work is ready for the next step.", "Controlla se il lavoro registrato è pronto per il passo successivo."),
  orchestrate: text("See ready work and a safe execution order.", "Mostra il lavoro pronto e un ordine di esecuzione sicuro."),
  route: text("Interpret a request and choose the next lifecycle action.", "Interpreta una richiesta e sceglie la prossima azione del ciclo."),
  preset: text("Inspect or export safe presentation presets.", "Controlla o esporta preset sicuri di presentazione."),
});

const EFFECTS = deepFreeze({
  read: text(
    "Reads local records only. It does not change files, publish, merge, deploy, or access production.",
    "Legge soltanto record locali. Non modifica file, pubblica, unisce, distribuisce né accede alla produzione.",
  ),
  plan: text(
    "Prepares a reviewable result. Any material change remains a separate action.",
    "Prepara un risultato revisionabile. Ogni modifica materiale resta un’azione separata.",
  ),
  local: text(
    "May change only the selected local project records; remote and production actions remain separate.",
    "Può modificare solo i record locali selezionati; azioni remote e di produzione restano separate.",
  ),
  protected: text(
    "Records a protected decision for the exact displayed target; it does not perform a merge, release, or deployment by itself.",
    "Registra una decisione protetta per la destinazione esatta mostrata; da sola non esegue merge, rilascio o distribuzione.",
  ),
});

const READ_ONLY_COMMANDS = new Set([
  "approval requests",
  "assessment proposal status",
  "assessment status",
  "authorization status",
  "autonomy delivery status",
  "autonomy requirement status",
  "baseline status",
  "breakdown policy show",
  "breakdown status",
  "budget status",
  "cache status",
  "capability profile status",
  "capability status",
  "completion",
  "config status",
  "dependency status",
  "doctor",
  "help",
  "kb search",
  "observe",
  "portfolio status",
  "optimization status",
  "orchestrate plan",
  "orchestrate status",
  "output resolve",
  "output status",
  "preset export",
  "preset list",
  "preset show",
  "requirement status",
  "route",
  "route decide",
  "status",
  "story deps",
  "task preflight",
  "workflow definition list",
  "workflow definition show",
  "workflow instance explain",
  "workflow instance status",
  "workflow overlay explain",
]);

const CONDITIONAL_MUTATIONS = deepFreeze({
  "autonomy delivery explain": {
    mode: "when-option",
    match: "any",
    conditions: [{ option: "out", operator: "truthy" }],
  },
  "config migrate": {
    mode: "when-option",
    match: "any",
    conditions: [{ option: "apply", operator: "equals", value: true }],
  },
  "gate check": {
    mode: "when-option",
    match: "any",
    conditions: [{ option: "out", operator: "truthy" }],
  },
  "migration active": {
    mode: "when-option",
    match: "any",
    conditions: [{ option: "apply", operator: "equals", value: true }],
  },
  "migration identity": {
    mode: "when-option",
    match: "any",
    conditions: [
      { option: "apply", operator: "equals", value: true },
      { option: "recover", operator: "equals", value: true },
    ],
  },
  "report activity": {
    mode: "when-option",
    match: "any",
    conditions: [{ option: "out", operator: "truthy" }],
  },
  "report query": {
    mode: "when-option",
    match: "any",
    conditions: [{ option: "out", operator: "truthy" }],
  },
});

const CANONICAL_ACTION_OVERRIDES = deepFreeze({
  "assessment status": "assessment.proposal.status",
  "requirement create": "requirement.propose",
  route: "route.decide",
});

function commandMetadata(commandPath) {
  const canonicalAction = CANONICAL_ACTION_OVERRIDES[commandPath]
    ?? commandPath.split(" ").join(".");
  const mutation = CONDITIONAL_MUTATIONS[commandPath]
    ?? (READ_ONLY_COMMANDS.has(commandPath) ? { mode: "never" } : { mode: "always" });
  return { canonical_action: canonicalAction, mutation };
}

function command(path, en, it, {
  effect = "read",
  options = [],
  positionals = [],
  usage = null,
  examples = [],
  aliases = [],
} = {}) {
  return {
    path,
    description: text(en, it),
    effect,
    protection: EFFECTS[effect],
    options,
    positionals,
    usage,
    examples,
    aliases,
    ...commandMetadata(path),
  };
}

function required(name, extra = {}) {
  return { name, required: true, ...extra };
}

function conditional(name, requiredWhenEn, requiredWhenIt) {
  return { name, required_when: text(requiredWhenEn, requiredWhenIt) };
}

function formalApprovalOptions() {
  return [
    required("actor-type"),
    conditional("approval-source", "the approver is not supplied by CI", "chi approva non è indicato dalla CI"),
    "actor-name",
    "actor-email",
    {
      name: "summary",
      required_when: text("--approval-source is explicit-user, automation, or bootstrap", "--approval-source è explicit-user, automation oppure bootstrap"),
      required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence"),
    },
    {
      name: "approval-evidence",
      required_when: text("--approval-source is explicit-user, automation, or bootstrap", "--approval-source è explicit-user, automation oppure bootstrap"),
      required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence"),
    },
    conditional("authorization", "--approval-source automation", "--approval-source è automation"),
    conditional("host-receipt-file", "the project requires trusted host or CI proof", "il progetto richiede una prova attendibile dell'host o della CI"),
    "scope",
  ];
}

const C = command;
const COMMANDS = [
  C("help", "Show focused help without opening a project.", "Mostra un aiuto mirato senza aprire un progetto.", { usage: "help [command ...]", examples: ["help", "help autonomy delivery approve"] }),
  C("completion", "Generate deterministic shell completion.", "Genera il completamento deterministico per la shell.", { positionals: ["bash", "fish", "powershell", "zsh"], usage: "completion <shell>", examples: ["completion zsh", "completion powershell --json"] }),
  C("preset list", "List built-in safe presentation presets.", "Elenca i preset di presentazione sicuri inclusi.", { examples: ["preset list", "preset list --json"] }),
  C("preset show", "Show one built-in presentation preset.", "Mostra un preset di presentazione incluso.", { positionals: ["diagnostic", "human-en", "human-it", "machine", "no-browser"], usage: "preset show <name>", examples: ["preset show human-it"] }),
  C("preset export", "Combine safe presets into one reproducible settings file.", "Combina preset sicuri in un solo file di impostazioni riproducibile.", { effect: "plan", positionals: ["diagnostic", "human-en", "human-it", "machine", "no-browser"], usage: "preset export <name|@file.json>...", examples: ["preset export human-it diagnostic"] }),
  C("observe", "Open the local Change Observatory.", "Apre il Change Observatory locale.", {
    options: ["host", "port", "portfolio-manifest", "no-open"],
    usage: "observe [--root <project-or-portfolio-root>] [--portfolio-manifest <relative.json>]",
    examples: [
      "observe",
      "observe --root ./work --portfolio-manifest portfolio.json",
      "observe --no-open --json",
    ],
  }),
  C("portfolio status", "Show a compact read-only portfolio status and exit.", "Mostra uno stato portfolio compatto in sola lettura e termina.", {
    options: [required("manifest")],
    usage: "portfolio status --root <portfolio-root> --manifest <relative.json> [--json]",
    examples: [
      "portfolio status --manifest portfolio.json",
      "portfolio status --root ./work --manifest portfolio.json --json",
    ],
  }),
  C("config status", "Explain which configuration is active.", "Spiega quale configurazione è attiva."),
  C("config migrate", "Plan or apply a configuration migration or autonomy rollout-mode change.", "Pianifica o applica una migrazione della configurazione o una modifica alla modalità di adozione dell’autonomia.", {
    effect: "local",
    options: [
      "autonomy-mode",
      "apply",
      "plan-hash",
      "confirm-legacy-bootstrap",
      "direct-approval-actor-type",
      "direct-approval-source",
      "actor-name",
      "actor-email",
      "summary",
      "approval-evidence",
    ],
    usage: "config migrate [--autonomy-mode <mode>] [--apply --plan-hash <sha256>] [--confirm-legacy-bootstrap --actor-type <human|ci> --approval-source <explicit-user|ci> --summary <decision>]",
    examples: [
      "config migrate",
      "config migrate --autonomy-mode observe",
      "config migrate --autonomy-mode enforce_new_only --apply --plan-hash <sha256>",
    ],
  }),
  C("init", "Create the local lifecycle structure for a project.", "Crea la struttura locale del ciclo di lavoro per un progetto.", {
    effect: "local",
    options: ["project-name", "project-id", "template-dir", "force"],
    usage: "init [--project-name <name>] [--project-id <id>] [--template-dir <path>] [--root <path>] [--force]",
    examples: [
      "init --project-name \"Booking Service\" --project-id booking-service",
      "init --project-name \"Local Monorepo\" --template-dir ./project-templates",
      "init --project-name \"Local Monorepo\" --template-dir <plugin-root>/templates/workflow-software-project-v3-integration-review",
    ],
  }),
  C("doctor", "Check local setup and explain how to fix problems.", "Controlla la configurazione locale e spiega come correggere i problemi."),
  C("optimization status", "Show output-optimization readiness and evidence.", "Mostra preparazione e prove dell’ottimizzazione dell’output.", {
    options: ["execution-proposal", "trust-custom-rtk-command"],
    usage: "optimization status [--proposal <proposal-id>] [--trust-custom-rtk-command]",
    examples: ["optimization status --proposal ASSESS-BOOKING-001 --json"],
  }),
  C("optimization capture", "Record an optimization measurement.", "Registra una misurazione di ottimizzazione.", {
    effect: "local",
    options: [required("execution-proposal"), required("manual-phase"), "trust-custom-rtk-command"],
    usage: "optimization capture --proposal <proposal-id> --phase manual [--trust-custom-rtk-command]",
    examples: ["optimization capture --proposal ASSESS-BOOKING-001 --phase manual --json"],
  }),
  C("optimization run", "Run one explicitly supplied local command with safe output handling.", "Esegue un comando locale fornito esplicitamente con gestione sicura dell’output.", {
    effect: "local",
    options: [
      required("command-json"),
      conditional("execution-proposal", "an active governed assessment", "un assessment governato attivo"),
      "optimization-profile",
      "exact",
      "trust-custom-rtk-command",
      "optimization-json-unsupported",
    ],
    usage: "optimization run --command-json <json-argv> [--proposal <proposal-id>] [--profile <auto|native|test|git|rg>] [--exact] [--trust-custom-rtk-command]",
    examples: ["optimization run --proposal ASSESS-BOOKING-001 --command-json '[\"npm\",\"test\"]'"],
  }),
  C("onboard existing-project", "Create a reviewable starting point for an existing project.", "Crea un punto di partenza revisionabile per un progetto esistente.", {
    effect: "local",
    options: ["project-name", "project-id", "id", "baseline-kind", "document", "source", "question", "assumption", "summary", "confirmed-source", "template-dir", "force"],
    usage: "onboard existing-project [--project-name <name>] [--id <baseline-id>] [--kind <kind>] [--document <path>] [--source <path>] [--summary <text>] [--template-dir <path>]",
    examples: [
      "onboard existing-project --project-name \"Booking Service\" --document README.md --source src --summary \"Observable current project state\"",
      "onboard existing-project --project-name \"Local Monorepo\" --document README.md --source packages --template-dir ./project-templates",
    ],
  }),
  C("baseline propose", "Propose the project state that future work will use.", "Propone lo stato del progetto da usare nel lavoro successivo.", {
    effect: "plan",
    options: ["id", "document", "source", "question", "assumption", "summary", "confirmed-source", "force"],
    usage: "baseline propose [--id <baseline-id>] [--document <path>] [--source <path>] [--question <text>] [--assumption <text>] [--summary <text>] [--force]",
    examples: ["baseline propose --id BASELINE-INITIAL --document README.md --source src --summary \"Observable current project state\""],
  }),
  C("baseline approve", "Approve one exact proposed project state.", "Approva una sola proposta esatta dello stato del progetto.", {
    effect: "protected",
    options: [required("id"), ...formalApprovalOptions()],
    usage: "baseline approve --id <baseline-id> --actor-type <human|ci|agent|system> --approval-source <source> (--summary <decision> | --approval-evidence <path>)",
    examples: ["baseline approve --id BASELINE-INITIAL --actor-type human --approval-source explicit-user --summary \"The displayed sources and assumptions are accurate\""],
  }),
  C("baseline status", "Show the agreed project state.", "Mostra lo stato concordato del progetto.", { options: ["id"] }),
  C("assessment proposal prepare", "Prepare a reviewable assessment plan.", "Prepara un piano di assessment revisionabile.", {
    effect: "plan",
    options: [
      "id",
      "baseline",
      "story",
      "requirement",
      "scope-id",
      "scope-title",
      "title",
      "scope-summary",
      "summary",
      "assessment-artifact-type",
      "template",
      "assessment-preset",
      "output-format",
      "output-delivery",
      "extension",
      "media-type",
      "generator",
      "section",
      "acceptance",
      "artifact",
      "contract-id",
      "intent-json",
      "intent-file",
      "capability",
      "budget-json",
      "budget-file",
      "force",
    ],
    usage: "assessment proposal prepare [--id <proposal-id>] [--baseline <baseline-id>] [--scope-title <title>] [--scope-summary <scope>] [--artifact <path>] [--budget-json <json> | --budget-file <path>] [--force]",
    examples: ["assessment proposal prepare --id ASSESS-BOOKING-001 --baseline BASELINE-INITIAL --scope-title \"Booking delivery assessment\" --scope-summary \"Assess the approved booking scope and produce a verified technical analysis\" --artifact docs/booking-assessment.md --budget-file budget.json"],
  }),
  C("assessment proposal approve", "Approve one exact assessment plan.", "Approva un solo piano di assessment esatto.", {
    effect: "protected",
    options: [
      required("id"),
      required("direct-approval-actor-type"),
      conditional("direct-approval-source", "the approver is not supplied by CI", "chi approva non è indicato dalla CI"),
      "actor-name",
      "actor-email",
      {
        name: "summary",
        required_when: text("--approval-source is explicit-user or ci", "--approval-source è explicit-user oppure ci"),
        required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence"),
      },
      {
        name: "approval-evidence",
        required_when: text("--approval-source is explicit-user or ci", "--approval-source è explicit-user oppure ci"),
        required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence"),
      },
      conditional("host-receipt-file", "the project requires trusted host or CI proof", "il progetto richiede una prova attendibile dell'host o della CI"),
    ],
    usage: "assessment proposal approve --id <proposal-id> --actor-type <human|ci> --approval-source <explicit-user|ci> (--summary <decision> | --approval-evidence <path>) [--host-receipt-file <path>]",
    examples: ["assessment proposal approve --id ASSESS-BOOKING-001 --actor-type human --approval-source explicit-user --summary \"I approve this exact scope, tool set, deliverable, and budget\""],
  }),
  C("assessment proposal apply", "Start the approved assessment work.", "Avvia il lavoro di assessment approvato.", { effect: "local", options: ["id", "authorization"] }),
  C("assessment proposal complete", "Record completion of an assessment plan.", "Registra il completamento di un piano di assessment.", { effect: "local", options: ["id"] }),
  C("assessment proposal status", "Show assessment readiness and progress.", "Mostra preparazione e avanzamento dell’assessment.", { options: ["id"] }),
  C("assessment status", "Show assessment readiness and progress.", "Mostra preparazione e avanzamento dell’assessment.", { options: ["id"], aliases: ["assessment proposal status"] }),
  C("workflow definition list", "Show the reusable ways of working available to this project.", "Mostra i modi di lavorare riutilizzabili disponibili per questo progetto.", {
    examples: ["workflow definition list", "workflow definition list --json"],
  }),
  C("workflow definition show", "Show what one exact way of working does before it is used.", "Mostra cosa fa un modo di lavorare esatto prima di usarlo.", {
    options: [required("id"), "definition-version"],
    usage: "workflow definition show --id <definition-id> [--definition-version <version>]",
    examples: [
      "workflow definition show --id software-project --definition-version 3",
      "workflow definition show --id software-project --definition-version 1",
    ],
  }),
  C("workflow definition propose", "Prepare a reviewable way of working without activating it.", "Prepara un modo di lavorare revisionabile senza attivarlo.", {
    effect: "plan",
    options: [
      required("id"),
      required("definition-version"),
      { name: "workflow-preset", required_one_of: text("one of --workflow-preset, --definition-file, or --definition-json", "una tra --workflow-preset, --definition-file o --definition-json") },
      { name: "definition-file", required_one_of: text("one of --workflow-preset, --definition-file, or --definition-json", "una tra --workflow-preset, --definition-file o --definition-json") },
      { name: "definition-json", required_one_of: text("one of --workflow-preset, --definition-file, or --definition-json", "una tra --workflow-preset, --definition-file o --definition-json") },
      "summary",
    ],
    usage: "workflow definition propose --id <definition-id> --definition-version <version> (--workflow-preset <preset> | --definition-file <path> | --definition-json <json>)",
    examples: [
      "workflow definition propose --id team-delivery --definition-version 1 --workflow-preset software-project --summary \"Six delivery steps with agreed reviews\"",
      "workflow definition propose --id software-project-integration-review --definition-version 1 --definition-file workflow-software-project-v3-integration-review.json --summary \"Copied from templates/workflow-software-project-v3-integration-review/workflow-definition.json and edited inside this project\"",
    ],
  }),
  C("workflow definition approve", "Confirm one exact proposed way of working for later runs.", "Conferma un solo modo di lavorare proposto per le esecuzioni future.", {
    effect: "protected",
    options: [required("id"), required("definition-version"), required("actor-type"), required("approval-source"), "actor-name", "actor-email", "summary", "approval-evidence", "authorization"],
    usage: "workflow definition approve --id <definition-id> --definition-version <version> --actor-type <type> --approval-source <source> --summary <decision>",
    examples: ["workflow definition approve --id team-delivery --definition-version 1 --actor-type human --approval-source explicit-user --summary \"Approved the displayed steps, reviews, and allowed checks\""],
  }),
  C("workflow overlay propose", "Prepare project-specific adjustments without changing any active run.", "Prepara adattamenti specifici del progetto senza cambiare esecuzioni già attive.", {
    effect: "plan",
    options: [
      required("id"),
      required("overlay-version"),
      required("definition"),
      required("definition-version"),
      { name: "overlay-file", required_one_of: text("--overlay-file or --overlay-json", "--overlay-file oppure --overlay-json") },
      { name: "overlay-json", required_one_of: text("--overlay-file or --overlay-json", "--overlay-file oppure --overlay-json") },
      "summary",
    ],
    usage: "workflow overlay propose --id <overlay-id> --overlay-version <version> --definition <definition-id> --definition-version <version> (--overlay-file <path> | --overlay-json <json>)",
  }),
  C("workflow overlay approve", "Confirm one exact project adjustment for new runs only.", "Conferma un solo adattamento del progetto, valido solo per nuove esecuzioni.", {
    effect: "protected",
    options: [required("id"), required("overlay-version"), required("actor-type"), required("approval-source"), "actor-name", "actor-email", "summary", "approval-evidence", "authorization"],
    usage: "workflow overlay approve --id <overlay-id> --overlay-version <version> --actor-type <type> --approval-source <source> --summary <decision>",
  }),
  C("workflow overlay explain", "Explain the practical changes made by one project adjustment.", "Spiega le modifiche pratiche introdotte da un adattamento del progetto.", {
    options: [required("id"), "overlay-version"],
    usage: "workflow overlay explain --id <overlay-id> [--overlay-version <version>]",
  }),
  C("workflow instance start", "Start one tracked run from an approved way of working. A story-bound run must start before task start and before its first completed step.", "Avvia un’esecuzione tracciata da un modo di lavorare approvato. Un’esecuzione legata alla story deve iniziare prima del task e del primo step completato.", {
    effect: "local",
    options: [
      required("id"),
      required("definition"),
      required("definition-version"),
      conditional("story", "the selected process uses canonical lifecycle checks", "il processo selezionato usa controlli canonici del ciclo di vita"),
      "overlay",
      "overlay-version",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
      "summary",
    ],
    usage: "workflow instance start --id <instance-id> --definition <definition-id> --definition-version <version> [--story <story-id>] [--overlay <overlay-id> --overlay-version <version>] [--actor <id> --actor-type <type>]",
    examples: ["workflow instance start --id DELIVERY-42 --definition software-project --definition-version 3 --story ST-BOOKING-001"],
  }),
  C("workflow instance transition", "Move one tracked run to its next permitted state.", "Porta un’esecuzione tracciata allo stato successivo consentito.", {
    effect: "local",
    options: [
      required("id"),
      required("to"),
      required("request-id"),
      "guard-input-json",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
      "summary",
    ],
    usage: "workflow instance transition --id <instance-id> --to <state> --request-id <retry-safe-id> [--guard-input-json <json>] [--actor <id> --actor-type <type>]",
  }),
  C("workflow instance status", "Show where one tracked run is and what can happen next.", "Mostra a che punto è un’esecuzione e cosa può accadere dopo.", {
    options: [required("id")],
    usage: "workflow instance status --id <instance-id>",
  }),
  C("workflow instance explain", "Explain the history, current position, and next permitted steps.", "Spiega cronologia, posizione attuale e passaggi successivi consentiti.", {
    options: [required("id")],
    usage: "workflow instance explain --id <instance-id>",
  }),
  C("budget usage record", "Record measured execution usage.", "Registra l’utilizzo misurato dell’esecuzione.", {
    effect: "local",
    options: [
      required("execution-proposal"),
      "id",
      "receipt-json",
      "receipt-file",
      "active-time-seconds",
      "steps",
      "model-calls",
      "tool-calls",
      "input-tokens",
      "output-tokens",
      "cost-amount",
      "currency",
      "metering-accuracy",
      "metering-source",
      "pricing-ref",
      "subagent",
      "evidence",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "budget usage record --proposal <proposal-id> [--receipt-json <json> | --receipt-file <path> | --active-time-seconds <n> | --steps <n> | --input-tokens <n> --output-tokens <n> | --cost-amount <amount> --currency <code>]",
    examples: ["budget usage record --proposal ASSESS-BOOKING-001 --steps 4 --input-tokens 1200 --output-tokens 450 --metering-accuracy estimated --metering-source manual-runtime-adapter"],
  }),
  C("budget meter start", "Capture a starting measurement for a budget meter.", "Acquisisce la misurazione iniziale di un contatore di budget.", {
    effect: "local",
    options: [required("execution-proposal"), "id", "adapter", "provider", "project", "from-date", "to-date", "meter-thread-id", "session-file"],
    usage: "budget meter start --proposal <proposal-id> [--id <baseline-id>] [--adapter <adapter-id>] [--provider <provider-id>] [--project <project-id>] [--from <date>] [--to <date>] [--thread-id <thread-id>] [--session-file <path>]",
    examples: ["budget meter start --proposal ASSESS-BOOKING-001 --id METER-ASSESS-BOOKING-001 --adapter codex-session"],
  }),
  C("budget meter record", "Record the measured change from a budget meter.", "Registra la variazione misurata da un contatore di budget.", {
    effect: "local",
    options: [required("execution-proposal"), "id", "meter-baseline", "adapter", "provider", "project", "from-date", "to-date", "meter-thread-id", "session-file"],
    usage: "budget meter record --proposal <proposal-id> [--baseline <baseline-id>] [--adapter <adapter-id>] [--provider <provider-id>] [--project <project-id>] [--from <date>] [--to <date>] [--thread-id <thread-id>] [--session-file <path>]",
    examples: ["budget meter record --proposal ASSESS-BOOKING-001 --baseline METER-ASSESS-BOOKING-001 --adapter codex-session"],
  }),
  C("budget amend", "Approve a precise budget change.", "Approva una modifica precisa del budget.", {
    effect: "protected",
    options: [
      required("execution-proposal"),
      "id",
      { name: "budget-json", required_one_of: text("--budget-json or --budget-file", "--budget-json oppure --budget-file") },
      { name: "budget-file", required_one_of: text("--budget-json or --budget-file", "--budget-json oppure --budget-file") },
      { name: "reason", required_one_of: text("--reason or --summary", "--reason oppure --summary") },
      { name: "summary", required_one_of: text("--reason or --summary", "--reason oppure --summary") },
      required("direct-approval-actor-type"),
      conditional("direct-approval-source", "the approver is not supplied by CI", "chi approva non è indicato dalla CI"),
      "actor-name",
      "actor-email",
      "approval-evidence",
      conditional("host-receipt-file", "the project requires trusted host or CI proof", "il progetto richiede una prova attendibile dell'host o della CI"),
    ],
    usage: "budget amend --proposal <proposal-id> (--budget-json <json> | --budget-file <path>) (--reason <text> | --summary <text>) --actor-type <human|ci> --approval-source <explicit-user|ci> [--host-receipt-file <path>]",
    examples: ["budget amend --proposal ASSESS-BOOKING-001 --budget-json '{\"limits\":{\"steps\":{\"soft\":20,\"hard\":30}}}' --reason \"Recorded usage reached the approved checkpoint\" --actor-type human --approval-source explicit-user"],
  }),
  C("budget status", "Show limits, usage, and remaining budget.", "Mostra limiti, utilizzo e budget residuo.", {
    options: [required("execution-proposal")],
    usage: "budget status --proposal <proposal-id>",
    examples: ["budget status --proposal ASSESS-BOOKING-001 --json"],
  }),
  C("requirement create", "Legacy alias for proposing a requirement.", "Alias precedente per proporre un requisito.", { effect: "plan", aliases: ["requirement propose"] }),
  C("requirement propose", "Describe one outcome, its checks, project file areas, limits, and maximum delivery independence.", "Descrive un risultato, i controlli, le aree di file del progetto, i limiti e l’autonomia massima della consegna.", {
    effect: "plan",
    options: [
      required("id"),
      required("title"),
      { name: "summary", required_one_of: text("--summary or --scope-summary", "--summary oppure --scope-summary") },
      { name: "scope-summary", required_one_of: text("--summary or --scope-summary", "--summary oppure --scope-summary") },
      required("acceptance"),
      required("autonomy-ceiling"),
      "source",
      "non-goal",
      "constraint",
      "nfr",
      "integration",
      "tool",
      "capability",
      "environment",
      "write-path",
      "expires-at",
      conditional("proposal", "--proposal-hash is also supplied", "viene fornito anche --proposal-hash"),
      conditional("proposal-hash", "--proposal is also supplied", "viene fornito anche --proposal"),
    ],
    usage: "requirement propose --id <requirement-id> --title <title> (--summary <outcome> | --scope-summary <outcome>) --acceptance <criterion> --autonomy-ceiling <level> [--write-path <project-relative-path> ...]",
    examples: [
      "requirement propose --id REQ-BOOKING-001 --title \"Reliable booking confirmation\" --summary \"Confirm a booking once and expose a recoverable failure\" --acceptance \"A successful request returns one confirmation reference\" --autonomy-ceiling checkpointed --write-path src --write-path test --write-path docs --write-path evidence",
    ],
  }),
  C("requirement approve", "Approve one exact requirement and its limits.", "Approva un requisito esatto e i relativi limiti.", {
    effect: "protected",
    options: [
      required("id"),
      required("actor-type"),
      conditional("approval-source", "the approver is not supplied by CI", "chi approva non è indicato dalla CI"),
      "actor-name",
      "actor-email",
      { name: "summary", required_when: text("--approval-source is explicit-user, automation, or bootstrap", "--approval-source è explicit-user, automation oppure bootstrap"), required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence") },
      { name: "approval-evidence", required_when: text("--approval-source is explicit-user, automation, or bootstrap", "--approval-source è explicit-user, automation oppure bootstrap"), required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence") },
      conditional("authorization", "--approval-source automation", "--approval-source è automation"),
      conditional("host-receipt-file", "the project requires trusted host or CI proof", "il progetto richiede una prova attendibile dell'host o della CI"),
    ],
    usage: "requirement approve --id <requirement-id> --actor-type <human|ci|agent|system> --approval-source <source> (--summary <decision> | --approval-evidence <path>)",
    examples: [
      "requirement approve --id REQ-BOOKING-001 --actor-type human --approval-source explicit-user --summary \"Approved the displayed outcome, checks, limits, and maximum delivery independence\"",
    ],
  }),
  C("requirement revise", "Create a new revision without rewriting history. Existing project file areas are inherited unless an explicit replacement list is supplied.", "Crea una nuova revisione senza riscrivere la cronologia. Le aree di file del progetto vengono ereditate, salvo quando fornisci esplicitamente un elenco sostitutivo.", {
    effect: "plan",
    options: [
      required("id"),
      required("new-id"),
      "title",
      "summary",
      "scope-summary",
      "acceptance",
      "autonomy-ceiling",
      "source",
      "non-goal",
      "constraint",
      "nfr",
      "integration",
      "tool",
      "capability",
      "environment",
      "write-path",
      "expires-at",
    ],
    usage: "requirement revise --id <current-id> --new-id <new-id> [--summary <outcome>] [--write-path <project-relative-path> ...]",
    examples: [
      "requirement revise --id REQ-BOOKING-001 --new-id REQ-BOOKING-002 --summary \"Also record recoverable failures\" --write-path src --write-path test --write-path evidence",
    ],
  }),
  C("requirement supersede", "Replace an approved requirement with its approved direct revision without rewriting either requirement.", "Sostituisce un requisito approvato con la revisione diretta approvata senza riscrivere nessuno dei due requisiti.", {
    effect: "protected",
    options: [
      required("id"),
      required("new-id"),
      required("reason"),
      required("actor-type"),
      conditional("approval-source", "the approver is not supplied by CI", "chi approva non è indicato dalla CI"),
      "actor-name",
      "actor-email",
      { name: "summary", required_when: text("--approval-source is explicit-user, automation, or bootstrap", "--approval-source è explicit-user, automation oppure bootstrap"), required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence") },
      { name: "approval-evidence", required_when: text("--approval-source is explicit-user, automation, or bootstrap", "--approval-source è explicit-user, automation oppure bootstrap"), required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence") },
      conditional("authorization", "--approval-source automation", "--approval-source è automation"),
      conditional("host-receipt-file", "the project requires trusted host or CI proof", "il progetto richiede una prova attendibile dell'host o della CI"),
    ],
    usage: "requirement supersede --id <current-id> --new-id <approved-direct-revision-id> --reason <reason> --actor-type <human|ci|agent|system> --approval-source <source> (--summary <decision> | --approval-evidence <path>)",
    examples: [
      "requirement supersede --id REQ-BOOKING-001 --new-id REQ-BOOKING-002 --reason \"The approved revision adds recoverable failures\" --actor-type human --approval-source explicit-user --summary \"Use the approved direct revision and preserve the old requirement as history\"",
    ],
  }),
  C("requirement status", "Show requirement decisions and readiness.", "Mostra decisioni e stato di preparazione dei requisiti.", { options: ["id"] }),
  C("autonomy requirement status", "Explain the maximum independence allowed by one requirement.", "Spiega l’autonomia massima consentita da un requisito.", { options: ["id"] }),
  C("autonomy delivery propose", "Choose how independently I should work for this one exact delivery. Pull requests and local releases always use separate choices.", "Scegli quanta autonomia devo avere per questa singola consegna esatta. Pull request e rilasci locali usano sempre scelte separate.", {
    effect: "plan",
    options: [
      required("id"),
      required("delivery"),
      required("kind"),
      required("story"),
      required("contract"),
      required("requirement"),
      required("level"),
      conditional("repository", "--kind pull_request", "--kind è pull_request"),
      conditional("base", "--kind pull_request", "--kind è pull_request"),
      conditional("head", "--kind pull_request", "--kind è pull_request"),
      conditional("pr-mode", "--kind pull_request; defaults to new", "--kind è pull_request; il default è new"),
      conditional("pr-number", "--kind pull_request and --pr-mode existing", "--kind è pull_request e --pr-mode è existing"),
      conditional("pr-url", "--kind pull_request and --pr-mode existing", "--kind è pull_request e --pr-mode è existing"),
      conditional("pr-head-sha", "--kind pull_request and --pr-mode existing when the local head cannot supply it", "--kind è pull_request e --pr-mode è existing quando non può essere ricavato dal branch locale"),
      conditional("target-root", "--kind local_release", "--kind è local_release"),
      conditional("write-path", "the selected delivery target", "la destinazione selezionata per la consegna"),
      conditional("smoke-cwd", "--kind local_release; required when more than one --write-path is present", "--kind è local_release; obbligatorio con più di un --write-path"),
      "allow-action",
      "merge-allowed",
      "git-provider",
      "pull-request-provider",
      "local-release-provider",
      "smoke-test",
      conditional("rollback", "--kind local_release", "--kind è local_release"),
      conditional("data-target", "--kind local_release and data.migrate/data.rollback are allowed", "--kind è local_release e data.migrate/data.rollback sono consentite"),
      conditional("data-scope", "a reversible local data migration is declared", "è dichiarata una migrazione dati locale reversibile"),
      conditional("migration-preview", "a reversible local data migration is declared", "è dichiarata una migrazione dati locale reversibile"),
      conditional("backup-path", "a reversible local data migration is declared", "è dichiarata una migrazione dati locale reversibile"),
    ],
    usage: "autonomy delivery propose --id <profile-id> --delivery <delivery-id> --kind <pull_request|local_release> --story <story-id> --contract <contract-id> --requirement <requirement-id> --level <level> <target-options> [--pr-mode <new|existing>]",
    examples: [
      "autonomy delivery propose --id AUT-PR-184 --delivery PR-184 --kind pull_request --story ST-001 --contract contract-ST-001-implementation --requirement REQ-001 --level checkpointed --repository owner/repository --base main --head feature/ST-001 --write-path src",
      "autonomy delivery propose --id AUT-PR-184 --delivery PR-184 --kind pull_request --pr-mode existing --pr-number 184 --pr-url https://github.com/owner/repository/pull/184 --story ST-001 --contract contract-ST-001-implementation --requirement REQ-001 --level checkpointed --repository owner/repository --base main --head feature/ST-001 --write-path src",
      "autonomy delivery propose --id AUT-LOCAL-009 --delivery LOCAL-009 --kind local_release --story ST-001 --contract contract-ST-001-release --requirement REQ-001 --level supervised --target-root /absolute/release --write-path /absolute/release/app --smoke-cwd /absolute/release/app --smoke-test '[\"npm\",\"run\",\"smoke:local\"]' --rollback \"Restore the previous package\"",
      "autonomy delivery propose --id AUT-DATA-009 --delivery LOCAL-DATA-009 --kind local_release --story ST-001 --contract contract-ST-001-release --requirement REQ-001 --level checkpointed --target-root /absolute/local-data --write-path /absolute/local-data/app --write-path /absolute/local-data/data --smoke-cwd /absolute/local-data/app --smoke-test '[\"npm\",\"run\",\"smoke:local\"]' --allow-action build.local --allow-action test.run --allow-action data.migrate --allow-action data.rollback --allow-action release.local --data-target /absolute/local-data/data/store.json --data-scope customers.v2 --migration-preview evidence/migration-preview.json --backup-path /absolute/local-data/data/store.backup.json --rollback \"Restore data/store.json from the exact backup\"",
    ],
  }),
  C("autonomy delivery approve", "Approve the limits for this delivery only.", "Approva i limiti soltanto per questa consegna.", {
    effect: "protected",
    options: [
      required("id"),
      "phase",
      required("actor-type"),
      "actor-name",
      "actor-email",
      required("approval-source"),
      { name: "summary", required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence") },
      { name: "approval-evidence", required_one_of: text("--summary or --approval-evidence", "--summary oppure --approval-evidence") },
      "authorization",
      "host-receipt-file",
    ],
    usage: "autonomy delivery approve --id <profile-id> --actor-type <human|ci> --approval-source <source> (--summary <text> | --approval-evidence <path>)",
    examples: ["autonomy delivery approve --id AUT-PR-184 --actor-type human --approval-source explicit-user --summary \"Approve this delivery only\""],
  }),
  C("autonomy delivery revoke", "Stop a delivery from using its approved independence.", "Impedisce a una consegna di usare l’autonomia approvata.", {
    effect: "protected",
    options: [required("id"), required("reason"), "summary"],
    usage: "autonomy delivery revoke --id <profile-id> --reason <text>",
    examples: ["autonomy delivery revoke --id AUT-PR-184 --reason \"The reviewed delivery boundary changed\""],
  }),
  C("autonomy delivery action", "Check, authorize, or complete one exact protected action; execution remains separate. For a new local destination, request build.local first without confirmation. Only if it reports checkpoint_required, show that decision and repeat with direct approval. After authorization, the external builder creates the exact approved root and the build is completed with evidence before rollback.verify, data.migrate, data.rollback, or release.local.", "Controlla, autorizza o completa una singola azione protetta; l’esecuzione resta separata. Per una nuova destinazione locale, richiedi prima build.local senza conferma. Solo se risponde checkpoint_required, mostra quella decisione e ripeti con approvazione diretta. Dopo l’autorizzazione, lo strumento esterno crea la root esatta approvata e la build viene completata con evidenza prima di rollback.verify, data.migrate, data.rollback o release.local.", {
    effect: "protected",
    options: [
      required("id"),
      required("action"),
      "phase",
      "scope-path",
      "remote",
      "pr-url",
      "expected-pr-title",
      "expected-pr-body-sha256",
      "expected-pr-state",
      "expected-pr-base",
      "confirm-action",
      "actor-type",
      "actor-name",
      "actor-email",
      "approval-source",
      "summary",
      "authorization",
      "authorization-receipt",
      "host-receipt-file",
      "outcome",
      "evidence",
      "smoke-cwd",
      "smoke-test",
      "rollback",
    ],
    usage: "autonomy delivery action --id <profile-id> --action <canonical-action> [authorization-or-completion-options]",
    examples: [
      "autonomy delivery action --id AUT-PR-184 --action git.commit --scope-path src/example.mjs",
      "autonomy delivery action --id AUT-PR-184 --action git.commit --outcome passed --authorization-receipt AUT-ACT-001 --evidence evidence/commit.json",
      "autonomy delivery action --id AUT-LOCAL-009 --action build.local",
      "autonomy delivery action --id AUT-LOCAL-009 --action build.local --confirm-action --actor-type human --approval-source explicit-user --summary \"Authorize creation of the exact approved local target\"",
      "autonomy delivery action --id AUT-LOCAL-009 --action build.local --outcome passed --authorization-receipt AUT-ACT-BUILD --evidence evidence/local-build.json",
      "autonomy delivery action --id AUT-DATA-009 --action data.migrate --confirm-action --actor-type human --approval-source explicit-user --summary \"Approve the exact previewed migration\"",
      "autonomy delivery action --id AUT-DATA-009 --action data.rollback --outcome passed --evidence evidence/rollback.json",
      "autonomy delivery action --id AUT-LOCAL-009 --action rollback.verify --evidence evidence/rollback-rehearsal.json --confirm-action --actor-type human --approval-source explicit-user --summary \"Approve this exact rollback evidence\"",
      "autonomy delivery action --id AUT-LOCAL-009 --action rollback.verify --outcome passed --evidence evidence/rollback-rehearsal.json",
    ],
  }),
  C("autonomy delivery close", "Close one delivery choice so it cannot be reused.", "Chiude una scelta di consegna affinché non possa essere riutilizzata.", {
    effect: "protected",
    options: [required("id"), required("terminal-status"), required("reason"), "summary"],
    usage: "autonomy delivery close --id <profile-id> --terminal-status <merged|closed|released|rolled_back|cancelled|superseded|revoked> --reason <text>",
    examples: ["autonomy delivery close --id AUT-PR-184 --terminal-status merged --reason \"The approved pull request was merged\""],
  }),
  C("autonomy delivery status", "Explain what this one delivery may do now and confirm that its choice cannot be reused.", "Spiega cosa può fare adesso questa sola consegna e conferma che la scelta non può essere riutilizzata.", { options: ["id"] }),
  C("autonomy delivery explain", "Explain one delivery choice in plain language; technical codes remain optional details.", "Spiega in linguaggio semplice la scelta di una consegna; i codici tecnici restano dettagli facoltativi.", { options: ["id", "phase", "out", "force"] }),
  C("contract create", "Create a draft implementation agreement for one phase and send it for review.", "Crea una bozza dell’accordo di implementazione per una fase e la sottopone a revisione.", {
    effect: "plan",
    options: [
      "id",
      "story",
      required("phase"),
      conditional("delivery-profile", "an implementation, validation, or release story uses approved per-delivery limits under enforcement", "una story di implementazione, validazione o rilascio usa limiti approvati per la singola consegna"),
      "level",
      { name: "context-summary", required_one_of: text("one of --context-summary, --context-file, --qa, or --capability-recommendation", "una tra --context-summary, --context-file, --qa oppure --capability-recommendation") },
      { name: "context-file", required_one_of: text("one of --context-summary, --context-file, --qa, or --capability-recommendation", "una tra --context-summary, --context-file, --qa oppure --capability-recommendation") },
      { name: "qa", required_one_of: text("one of --context-summary, --context-file, --qa, or --capability-recommendation", "una tra --context-summary, --context-file, --qa oppure --capability-recommendation") },
      { name: "capability-recommendation", required_one_of: text("one of --context-summary, --context-file, --qa, or --capability-recommendation", "una tra --context-summary, --context-file, --qa oppure --capability-recommendation") },
      "question",
      "constraint",
      "assumption",
      "input",
      "output",
      conditional("output-ref", "a story phase declares a durable output and strict output coverage is enabled", "una fase della story richiede un risultato persistente e il controllo rigoroso dei risultati è attivo"),
      "validation",
      "tool",
      "kb-write",
      "metric",
      "owner-agent",
      "model",
      "reasoning",
      "execution-note",
      "capability-policy-file",
      "capability-policy-json",
      "capability-binding-file",
      "capability-binding-json",
      "allow-incomplete-contract",
      "allow-unapproved-output-ref",
      conditional("replace-story-contract", "the story already points to a different contract and this is explicit renegotiation or recovery", "la story indica già un accordo diverso e questa è una rinegoziazione o un recupero esplicito"),
      "force",
    ],
    usage: "contract create --phase <phase> [--id <contract-id>] [--story <story-id>] <agreed-context> [--output-ref <type:template:mode[:phase]>] [--delivery-profile <profile-id>]",
    examples: [
      "contract create --id CONTRACT-BOOKING-DESIGN-001 --phase design --context-summary \"Use the agreed booking outcome and current API boundaries\" --validation \"Review the result against the agreed acceptance criteria\"",
      "contract create --id CONTRACT-BOOKING-IMPLEMENTATION-001 --story ST-BOOKING-001 --phase implementation --delivery-profile AUT-PR-184 --context-summary \"Implement the approved booking story\" --output-ref code-change:CODE-CHANGE-V1:new:implementation --validation \"Run the agreed unit and integration tests\"",
    ],
  }),
  C("contract approve", "Approve one exact implementation agreement.", "Approva un accordo di implementazione esatto.", {
    effect: "protected",
    options: [
      required("id"),
      ...formalApprovalOptions(),
      "approval-status",
      "preserve-status",
    ],
    usage: "contract approve --id <contract-id> --actor-type <human|ci|agent|system> --approval-source <source> (--summary <decision> | --approval-evidence <path>)",
    examples: [
      "contract approve --id CONTRACT-BOOKING-DESIGN-001 --actor-type human --approval-source explicit-user --summary \"Approved the displayed work agreement\"",
    ],
  }),
  C("story create", "Create one non-overwriting delivery story; ready stories need an observable success criterion.", "Crea una story di consegna senza sovrascritture; le story ready richiedono un criterio di successo osservabile.", {
    effect: "local",
    options: [
      required("id"),
      required("story-title"),
      "requirement",
      conditional(
        "acceptance",
        "--status ready; a draft may add it later, but contract setup still requires it",
        "--status è ready; una draft può aggiungerlo dopo, ma resta obbligatorio prima di creare il contract",
      ),
      "phase",
      "story-status",
      "template-dir",
    ],
    usage: "story create --id <story-id> --title <title> [--requirement <requirement-id>] [--acceptance <criterion>] [--phase <phase>] [--status <draft|ready>] [--template-dir <path>]",
    examples: [
      "story create --id ST-BOOKING-001 --title \"Implement reliable booking confirmation\" --requirement REQ-BOOKING-001 --acceptance \"A successful request returns one confirmation reference\"",
    ],
  }),
  C("story acceptance add", "Add observable success criteria without rewriting an existing story; if a contract already exists, replace and approve it, then start the revised work before claiming.", "Aggiunge criteri di successo osservabili senza riscrivere una story esistente; se esiste già un contratto, sostituiscilo e approvalo, poi avvia il lavoro aggiornato prima dell’assegnazione.", {
    effect: "local",
    options: [required("id"), required("acceptance"), "summary"],
    usage: "story acceptance add --id <story-id> --acceptance <criterion> [--acceptance <criterion>] [--summary <reason>]",
    examples: [
      "story acceptance add --id ST-BOOKING-001 --acceptance \"A failed request is recoverable\" --summary \"Complete the story before task start\"",
    ],
  }),
  C("story claim", "Assign a started story with observable acceptance criteria and a current approved contract to one agent and branch.", "Assegna a un agente e a un branch una story già avviata, con criteri di successo osservabili e contratto corrente approvato.", {
    effect: "local",
    options: [
      required("id"),
      required("agent"),
      "branch",
      {
        name: "authorization",
        required_when: text(
          "the exact delivery profile lists story.claim as a checkpoint",
          "il profilo di consegna esatto include story.claim tra i checkpoint",
        ),
        description: text(
          "Use one exact delegated authorization. When supplied for an otherwise automatic claim, it is still validated and consumed; an invalid grant fails the command.",
          "Usa una delega esatta. Se viene fornita per un’assegnazione altrimenti automatica, viene comunque verificata e consumata; una delega non valida blocca il comando.",
        ),
      },
      "claim-notes",
      "expires-at",
      "force",
    ],
    usage: "story claim --id <story-id> --agent <name> [--branch <branch>] [--notes <text>] [--expires-at <timestamp>] [--authorization <authorization-id>] [--force]",
    examples: ["story claim --id ST-BOOKING-001 --agent codex --branch feature/ST-BOOKING-001"],
  }),
  C("story release", "Release one work assignment.", "Rilascia l’assegnazione di un’attività.", {
    effect: "local",
    options: [required("id"), "agent", "claim-status", "reason", "force"],
    usage: "story release --id <story-id> [--agent <name>] [--status <active|released|transferred|cancelled>] [--reason <text>] [--force]",
    examples: ["story release --id ST-BOOKING-001 --reason \"Handed the work to another agent\""],
  }),
  C("story complete-step", "Record one completed lifecycle step and its evidence.", "Registra una fase completata del ciclo e le relative prove.", {
    effect: "local",
    options: [
      required("id"),
      required("story-step"),
      { name: "summary", required_one_of: text("one of --summary, --type, --artifact, or --evidence", "una tra --summary, --type, --artifact oppure --evidence") },
      { name: "output-types", required_one_of: text("one of --summary, --type, --artifact, or --evidence", "una tra --summary, --type, --artifact oppure --evidence") },
      { name: "artifact", required_one_of: text("one of --summary, --type, --artifact, or --evidence", "una tra --summary, --type, --artifact oppure --evidence") },
      { name: "evidence", required_one_of: text("one of --summary, --type, --artifact, or --evidence", "una tra --summary, --type, --artifact oppure --evidence") },
      "completion-id",
      "next-story-step",
      "release-claim",
      conditional("reason", "--release-claim is supplied", "viene fornito --release-claim"),
      "allow-unapproved-contract-output",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
      {
        name: "authorization",
        required_when: text(
          "the exact delivery profile lists story.complete-step as a checkpoint",
          "il profilo di consegna esatto include story.complete-step tra i checkpoint",
        ),
        description: text(
          "Use one exact delegated authorization. When supplied for an otherwise automatic completion, it is still validated and consumed; an invalid grant fails the command.",
          "Usa una delega esatta. Se viene fornita per un completamento altrimenti automatico, viene comunque verificata e consumata; una delega non valida blocca il comando.",
        ),
      },
    ],
    usage: "story complete-step --id <story-id> --step <step> (--summary <text> | --type <artifact-type> | --artifact <path> | --evidence <path>) [--next-step <step>] [--release-claim] [--authorization <authorization-id>] [--allow-unapproved-contract-output]",
    examples: ["story complete-step --id ST-BOOKING-001 --step validation --type validation-report --evidence .sdlc/tests/ST-BOOKING-001-test-run.json --summary \"All agreed tests passed\""],
  }),
  C("story prepare-handoff", "Prepare a reviewable transfer to another agent.", "Prepara un passaggio di consegne revisionabile a un altro agente.", {
    effect: "plan",
    options: [
      required("id"),
      required("to-agent"),
      "handoff-id",
      "summary",
      "artifact",
      "open-item",
      "trace-limit",
      "release-claim",
      conditional("reason", "--release-claim is supplied", "viene fornito --release-claim"),
      "force",
    ],
    usage: "story prepare-handoff --id <story-id> --to-agent <name> [--handoff-id <id>] [--summary <text>] [--artifact <path>] [--trace-limit <number>] [--release-claim --reason <text>]",
    examples: ["story prepare-handoff --id ST-BOOKING-001 --to-agent reviewer --summary \"Implementation ready for review\""],
  }),
  C("story handoff", "Record the transfer of one unit of work.", "Registra il passaggio di un’attività.", {
    effect: "local",
    options: [
      required("id"),
      required("to-agent"),
      "handoff-id",
      "handoff-status",
      "summary",
      "artifact",
      "open-item",
      "force",
    ],
    usage: "story handoff --id <story-id> --to-agent <name> [--handoff-id <id>] [--status <open|accepted|closed|rejected|cancelled>] [--summary <text>] [--artifact <path>] [--open-item <text>]",
    examples: ["story handoff --id ST-BOOKING-001 --to-agent reviewer --summary \"Implementation ready for review\" --artifact docs/implementation-report.md"],
  }),
  C("story handoff close", "Close or accept one work transfer.", "Chiude o accetta un passaggio di attività.", {
    effect: "local",
    options: [required("id"), "handoff-close-status", "summary", "open-item"],
    usage: "story handoff close --id <handoff-id> [--status <accepted|closed|cancelled>] [--summary <text>] [--open-item <text>]",
    examples: ["story handoff close --id HND-ST-BOOKING-001-01 --status accepted --summary \"Accepted the reviewed transfer\""],
  }),
  C("story deps", "Show what blocks or depends on one unit of work.", "Mostra cosa blocca o dipende da un’attività.", { options: ["id"] }),
  C("work item create", "Create an epic or task in the local work graph.", "Crea un’epic o un task nel grafo locale del lavoro.", {
    effect: "local",
    options: [
      required("work-item-type"),
      required("id"),
      required("work-item-title"),
      "work-item-parent",
      "story",
      "requirement",
      "acceptance",
      "work-item-status",
      "force",
    ],
    usage: "work item create --type <epic|task> --id <work-item-id> --title <text> [--parent <work-item-id>] [--story <story-id>] [--requirement <requirement-id>] [--acceptance <criterion>]",
    examples: ["work item create --type task --id TASK-BOOKING-001 --title \"Add the confirmation reference\" --parent ST-BOOKING-001 --requirement REQ-BOOKING-001"],
  }),
  C("breakdown policy show", "Show how requirements are split into delivery units.", "Mostra come i requisiti vengono divisi in unità di consegna."),
  C("breakdown policy set", "Change the local work-splitting policy.", "Modifica la regola locale di suddivisione del lavoro.", {
    effect: "local",
    options: ["breakdown-levels", "default-flow", "delivery-unit", "strict-gate-unit", "task-gate"],
    usage: "breakdown policy set [--levels <work-item-type>] [--default-flow <work-item-types>] [--delivery-unit <epic|story|task>] [--strict-gate-unit <epic|story|task>] [--task-gate <mode>]",
    examples: ["breakdown policy set --delivery-unit story --strict-gate-unit story"],
  }),
  C("breakdown propose", "Propose the work items that satisfy a requirement.", "Propone gli elementi di lavoro che soddisfano un requisito.", {
    effect: "plan",
    options: [required("id"), required("requirement"), "breakdown-item", "breakdown-rationale", "force"],
    usage: "breakdown propose --id <breakdown-id> --requirement <requirement-id> [--item <type:id[:title]>] [--rationale <text>] [--force]",
    examples: ["breakdown propose --id BRK-BOOKING-001 --requirement REQ-BOOKING-001 --item story:ST-BOOKING-001:\"Confirm a booking\""],
  }),
  C("breakdown approve", "Approve one exact work breakdown.", "Approva una suddivisione esatta del lavoro.", { effect: "protected", options: [required("id"), "summary", "scope"] }),
  C("breakdown status", "Show work-breakdown readiness.", "Mostra lo stato della suddivisione del lavoro.", { options: ["requirement"] }),
  C("dependency propose", "Propose blocking relationships between work items.", "Propone relazioni bloccanti tra elementi di lavoro.", {
    effect: "plan",
    options: [required("id"), "requirement", "dependency-edge", "dependency-rationale", "force"],
    usage: "dependency propose --id <proposal-id> [--requirement <requirement-id>] [--edge <from:type:to>] [--rationale <text>] [--force]",
    examples: ["dependency propose --id DEP-BOOKING-001 --requirement REQ-BOOKING-001 --edge ST-BOOKING-002:blocks:ST-BOOKING-001"],
  }),
  C("dependency approve", "Approve one exact dependency graph.", "Approva un grafo esatto delle dipendenze.", { effect: "protected", options: [required("id"), "summary", "scope"] }),
  C("dependency status", "Show dependency readiness and blockers.", "Mostra stato e blocchi delle dipendenze.", { options: ["story"] }),
  C("capability profile propose", "Describe the context and constraints used to choose tools.", "Descrive contesto e vincoli usati per scegliere gli strumenti.", {
    effect: "plan",
    options: [required("id"), "story", "requirement", "phase", "scope", "context-file", "constraint", "confidence", "profile-json", "profile-file", "force"],
    usage: "capability profile propose --id <profile-id> [--story <story-id>] [--phase <phase>] [--context-file <path>] [--profile-json <json> | --profile-file <path>]",
    examples: ["capability profile propose --id CAP-PROFILE-ST-001 --story ST-001 --phase implementation --context-file package.json --constraint \"Use only project-approved tools\" --confidence 0.9"],
  }),
  C("capability profile approve", "Approve one exact tool-selection context.", "Approva un contesto esatto per la selezione degli strumenti.", {
    effect: "protected",
    options: [required("id"), ...formalApprovalOptions()],
    usage: "capability profile approve --id <profile-id> --actor-type <human|ci|agent|system> --approval-source <source> (--summary <decision> | --approval-evidence <path>)",
    examples: ["capability profile approve --id CAP-PROFILE-ST-001 --actor-type human --approval-source explicit-user --summary \"Approved the displayed tool-selection context\""],
  }),
  C("capability profile status", "Show tool-selection readiness.", "Mostra lo stato della selezione degli strumenti.", { options: ["profile", "story"] }),
  C("capability recommend", "Propose the smallest tool set needed for the work.", "Propone il set minimo di strumenti necessario al lavoro.", {
    effect: "plan",
    options: [required("id"), required("profile"), "recommendation-json", "recommendation-file", "available-capabilities-json", "available-capabilities-file", "force"],
    usage: "capability recommend --id <recommendation-id> --profile <profile-id> [--recommendation-json <json> | --recommendation-file <path>] [--available-capabilities-json <json> | --available-capabilities-file <path>]",
    examples: ["capability recommend --id CAP-REC-ST-001 --profile CAP-PROFILE-ST-001 --available-capabilities-file capabilities.json"],
  }),
  C("capability approve", "Approve the tools allowed for this work.", "Approva gli strumenti consentiti per questo lavoro.", {
    effect: "protected",
    options: [required("id"), ...formalApprovalOptions(), "approve-install"],
    usage: "capability approve --id <recommendation-id> --actor-type <human|ci|agent|system> --approval-source <source> (--summary <decision> | --approval-evidence <path>) [--approve-install]",
    examples: ["capability approve --id CAP-REC-ST-001 --actor-type human --approval-source explicit-user --summary \"Approved the displayed tools and limits\""],
  }),
  C("capability status", "Show approved and missing tools.", "Mostra strumenti approvati e mancanti.", { options: ["story", "profile"] }),
  C("approval requests", "List decisions that still need a person.", "Elenca le decisioni che richiedono ancora una persona.", { options: ["story"] }),
  C("authorization grant", "Delegate exact decisions with a fixed scope and expiry.", "Delega decisioni esatte con ambito e scadenza fissi.", {
    effect: "protected",
    options: [
      required("id"),
      required("scope"),
      required("summary"),
      { name: "authorization-action", required_one_of: text("--allow-action or --allow-use", "--allow-action oppure --allow-use") },
      { name: "allow-use", required_one_of: text("--allow-action or --allow-use", "--allow-action oppure --allow-use") },
      "allow-subject",
      "allow-artifact-type",
      "allow-boundary",
      "expires-at",
      conditional("proposal", "--proposal-hash is also supplied", "viene fornito anche --proposal-hash"),
      conditional("proposal-hash", "--proposal is also supplied", "viene fornito anche --proposal"),
      "max-uses",
      "authority-assurance",
      required("authorization-actor-type"),
      "actor-name",
      "actor-email",
      required("authorization-approval-source"),
      "approval-evidence",
      "force",
    ],
    usage: "authorization grant --id <authorization-id> --scope <exact-scope> (--allow-action <canonical-action> | --allow-use <action=subject>) --actor-type <human|ci> --approval-source <explicit-user|ci> --summary <text>",
    examples: ["authorization grant --id AUTH-CONTRACT-001 --scope \"Approve CONTRACT-001 only\" --allow-use contract.approve=CONTRACT-001 --actor-type human --approval-source explicit-user --summary \"Delegate this exact approval once\" --max-uses 1"],
  }),
  C("authorization status", "Show active, used, expired, or revoked delegations.", "Mostra deleghe attive, usate, scadute o revocate.", { options: ["id"] }),
  C("authorization revoke", "Revoke one delegation.", "Revoca una delega.", {
    effect: "protected",
    options: [required("id"), required("authorization-actor-type"), "reason", "force"],
    usage: "authorization revoke --id <authorization-id> --actor-type <human|ci> [--reason <text>]",
    examples: ["authorization revoke --id AUTH-CONTRACT-001 --actor-type human --reason \"Scope changed before the delegation was used\""],
  }),
  C("task preflight", "Verify and classify every approved context source immediately before task start without writing a receipt.", "Verifica e classifica ogni fonte di contesto approvata subito prima dell’avvio, senza scrivere una ricevuta.", {
    options: [
      { name: "intent-json", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      { name: "intent-file", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      "task-text",
      "story",
      "phase",
      "contract-id",
      conditional("delivery-profile", "the selected implementation, validation, or release contract requires per-delivery limits", "il contract selezionato di implementazione, validazione o rilascio richiede limiti per la singola consegna"),
      "proposal",
      "revise-contract",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "task preflight (--intent-json <json> | --intent-file <path>) --story <story-id> --phase <phase> --contract-id <contract-id> --delivery-profile <profile-id>",
    examples: [
      "task preflight --intent-file requests/ST-BOOKING-001.json --story ST-BOOKING-001 --phase implementation --contract-id CONTRACT-BOOKING-IMPLEMENTATION-001 --delivery-profile AUT-LOCAL-001 --json",
    ],
  }),
  C("task start", "Check and record whether one exact work unit can begin; a successful start enables its story claim, while each pull request or local release keeps a separate working choice.", "Controlla e registra se un’attività esatta può iniziare: un avvio riuscito abilita l’assegnazione della story, mentre ogni PR o rilascio locale mantiene una scelta separata.", {
    effect: "protected",
    options: [
      { name: "intent-json", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      { name: "intent-file", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      "task-text",
      "story",
      "phase",
      "contract-id",
      conditional("delivery-profile", "the selected implementation, validation, or release contract requires per-delivery limits", "il contract selezionato di implementazione, validazione o rilascio richiede limiti per la singola consegna"),
      "confirm-start",
      "actor",
      conditional("actor-type", "the start records an explicit actor", "l’avvio registra un soggetto esplicito"),
      "actor-name",
      "actor-email",
      conditional("authorization", "delegated automation confirms the start", "un’automazione delegata conferma l’avvio"),
      "proposal",
      "revise-contract",
    ],
    usage: "task start (--intent-json <json> | --intent-file <path>) [--text <original-request>] [--story <story-id>] [--phase <phase>] [--contract-id <contract-id>] [--delivery-profile <profile-id>] [--confirm-start] [--actor <id> --actor-type <type>]",
    examples: [
      "task start --intent-json '{\"requested_action\":\"implement_story\",\"confidence\":0.92,\"referenced_entities\":[{\"type\":\"story\",\"id\":\"ST-BOOKING-001\"}],\"provided_artifacts\":[],\"missing_context\":[],\"proposed_phase\":\"implementation\",\"artifact_type\":null,\"skip_phases\":[]}' --story ST-BOOKING-001 --phase implementation --contract-id CONTRACT-BOOKING-IMPLEMENTATION-001 --delivery-profile AUT-PR-184",
      "task start --intent-file requests/ST-BOOKING-001.json --story ST-BOOKING-001 --confirm-start --actor-type human",
    ],
  }),
  C("handoff close", "Close, accept, or cancel a recorded handoff.", "Chiude, accetta o annulla un passaggio registrato.", {
    effect: "local",
    options: [required("id"), "handoff-close-status", "summary", "open-item"],
    usage: "handoff close --id <handoff-id> [--status <accepted|closed|cancelled>] [--summary <text>] [--open-item <text>]",
    examples: ["handoff close --id HND-ST-BOOKING-001-01 --status accepted --summary \"Accepted the reviewed transfer\""],
  }),
  C("phase lock", "Pause work in one lifecycle phase.", "Mette in pausa il lavoro in una fase del ciclo.", {
    effect: "local",
    options: [required("phase"), "lock-id", "lock-scope", "reason", "expires-at", "force"],
    usage: "phase lock --phase <phase> [--id <lock-id>] [--scope <text>] [--reason <text>] [--expires-at <timestamp>] [--force]",
    examples: ["phase lock --phase implementation --reason \"Waiting for the approved contract\""],
  }),
  C("phase release", "Remove one phase pause.", "Rimuove una pausa di fase.", {
    effect: "local",
    options: [required("id"), "lock-status", "reason"],
    usage: "phase release --id <lock-id> [--status <active|released|cancelled|expired>] [--reason <text>]",
    examples: ["phase release --id LOCK-implementation-01 --reason \"The contract was approved\""],
  }),
  C("trace append", "Add a concise, attributable event to project history.", "Aggiunge un evento conciso e attribuito alla cronologia del progetto.", {
    effect: "local",
    options: [
      required("trace-type"),
      required("summary"),
      "story",
      "trace-outcome",
      "trace-action",
      "trace-git-event",
      "evidence",
      "related",
      "input-summary",
      "output-summary",
      "alternative",
      "rationale-summary",
      "explanation",
      conditional("explanation-kind", "--explanation is supplied", "viene fornito --explanation"),
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "trace append --type <trace-type> --summary <text> [--story <story-id>] [--outcome <outcome>] [--action <action>] [--git-event <event>] [--evidence <path>] [--related <id>] [--explanation <text> --explanation-kind <kind>] [--actor-type <type>]",
    examples: ["trace append --type decision --summary \"Approved the exact implementation boundary\" --outcome ready --action requirement.approve --related REQ-001 --actor-type human"],
  }),
  C("trace evidence bind", "Bind a supported redaction policy to historical trace evidence without rewriting the event.", "Associa una regola supportata di oscuramento alle prove storiche senza riscrivere l’evento.", {
    effect: "local",
    options: [required("target-event"), required("redaction-policy"), "story", "summary"],
    usage: "trace evidence bind --target-event <trace-event-id> --redaction-policy <policy-id> [--story <story-id>] [--summary <text>]",
    examples: ["trace evidence bind --target-event TR-001 --redaction-policy operational_v2 --story ST-001"],
  }),
  C("trace compact", "Plan a compact archive of older trace events.", "Pianifica un archivio compatto degli eventi meno recenti.", { effect: "plan", options: ["story", "archive-before", "out", "force"] }),
  C("sync record", "Record a source-control synchronization event.", "Registra un evento di sincronizzazione del codice.", {
    effect: "local",
    options: [
      required("git-event"),
      "story",
      "summary",
      "sync-remote",
      "before-sha",
      "after-sha",
      "sync-pr-url",
      "evidence",
      "related",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "sync record --event <push|commit|merge|pull|rebase|branch|handoff|pr> [--story <story-id>] [--summary <text>] [--remote <name>] [--before-sha <sha>] [--after-sha <sha>] [--pr-url <url>]",
    examples: ["sync record --event push --story ST-BOOKING-001 --remote origin --summary \"Pushed the reviewed implementation branch\""],
  }),
  C("test record", "Record one executed test run as durable story evidence: the exact command, its exit status, its result counts, and at least one attached output file.", "Registra un’esecuzione di test come prova durevole della story: il comando esatto, il codice di uscita, i conteggi dei risultati e almeno un file di output allegato.", {
    effect: "local",
    options: [
      required("story"),
      required("test-command"),
      required("test-exit-code"),
      required("evidence"),
      "id",
      "summary",
      "test-cwd",
      "test-passed",
      "test-failed",
      "test-skipped",
      "test-framework",
      "test-started-at",
      "phase",
      "requirement",
      "acceptance",
      "force",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "test record --story <story-id> --command '<json-argv>' --exit-code <0..255> --evidence <path> [--passed <count>] [--failed <count>] [--skipped <count>] [--framework <name>] [--cwd <path>] [--started-at <timestamp>] [--id <record-id>] [--summary <text>]",
    examples: [
      "test record --story ST-BOOKING-001 --command '[\"npm\",\"test\"]' --exit-code 0 --passed 42 --evidence .sdlc/tests/ST-BOOKING-001-run.log --framework node:test --summary \"Full suite on the reviewed implementation branch\"",
      "test record --story ST-BOOKING-001 --command '[\"npm\",\"test\"]' --exit-code 1 --passed 40 --failed 2 --evidence .sdlc/tests/ST-BOOKING-001-failure.log",
    ],
  }),
  C("incident record", "Record one operational incident observed against a released change, bound to the story and the released manifest it affects.", "Registra un incidente operativo osservato su un cambiamento rilasciato, collegato alla story e al manifest di rilascio interessato.", {
    effect: "local",
    options: [
      required("story"),
      required("release-manifest"),
      required("incident-severity"),
      required("summary"),
      required("incident-impact"),
      "incident-detected-at",
      "incident-resolved-at",
      "incident-action",
      "id",
      "phase",
      "requirement",
      "force",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "incident record --story <story-id> --release-manifest <id-or-path> --severity <sev1..sev4> --summary <text> --impact <text> [--detected-at <timestamp>] [--resolved-at <timestamp>] [--action <text>] [--id <record-id>]",
    examples: [
      "incident record --story ST-BOOKING-001 --release-manifest REL-2026-01 --severity sev2 --summary \"Checkout latency spike\" --impact \"5% of checkouts timed out for 20 minutes\" --action \"Rolled back the checkout service\"",
      "incident record --story ST-BOOKING-001 --release-manifest REL-2026-01 --severity sev4 --summary \"Minor log noise\" --impact \"No user-visible effect\" --resolved-at 2026-01-05T10:00:00Z",
    ],
  }),
  C("feedback record", "Record one feedback item observed against a released change, bound to the story and the released manifest it concerns.", "Registra un elemento di feedback osservato su un cambiamento rilasciato, collegato alla story e al manifest di rilascio a cui si riferisce.", {
    effect: "local",
    options: [
      required("story"),
      required("release-manifest"),
      required("feedback-source"),
      required("summary"),
      "feedback-sentiment",
      "evidence",
      "id",
      "phase",
      "requirement",
      "force",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "feedback record --story <story-id> --release-manifest <id-or-path> --source <user|monitoring|review|other> --summary <text> [--sentiment <positive|neutral|negative>] [--evidence <path>] [--id <record-id>]",
    examples: [
      "feedback record --story ST-BOOKING-001 --release-manifest REL-2026-01 --source user --sentiment positive --summary \"Customers report the new checkout is faster\"",
      "feedback record --story ST-BOOKING-001 --release-manifest REL-2026-01 --source monitoring --sentiment negative --summary \"Error rate up 2x post-release\" --evidence .sdlc/operations/dashboard-snapshot.png",
    ],
  }),
  C("secret scan", "Search the files one delivery changed for credentials and record the result as story evidence. Matches are stored and displayed redacted, never in clear text.", "Cerca credenziali nei file modificati da una consegna e registra l’esito come prova della story. Le corrispondenze sono salvate e mostrate in forma oscurata, mai in chiaro.", {
    effect: "local",
    options: [
      required("story"),
      "scan-base",
      "scan-head",
      "delivery",
      "id",
      "summary",
      "phase",
      "requirement",
      "force",
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "secret scan --story <story-id> [--base <commit-ish>] [--head <commit-ish>] [--delivery <delivery-id>] [--id <record-id>] [--summary <text>]",
    examples: [
      "secret scan --story ST-BOOKING-001",
      "secret scan --story ST-BOOKING-001 --base main --head HEAD --json",
    ],
  }),
  C("output template propose", "Propose a reusable output format.", "Propone un formato di output riutilizzabile.", {
    effect: "plan",
    options: [required("output-template-type"), "id", "template-from", "template-body", "template-preset", "summary", "output-format", "output-delivery", "extension", "media-type", "generator", "force"],
    usage: "output template propose --type <artifact-type> [--id <template-id>] [--from <path> | --body <text> | --preset <technical-assessment>] [--format <format>] [--delivery <mode>]",
    examples: ["output template propose --type technical-analysis --id TECH-ANALYSIS-V1 --preset technical-assessment --format markdown --delivery artifact-plus-chat-summary --summary \"Reusable technical analysis structure\""],
  }),
  C("output template approve", "Approve one exact output format.", "Approva un formato di output esatto.", {
    effect: "protected",
    options: [required("id"), ...formalApprovalOptions(), "decision-id"],
    usage: "output template approve --id <template-id> --actor-type <human|ci|agent|system> --approval-source <source> (--summary <decision> | --approval-evidence <path>) [--decision-id <id>]",
    examples: ["output template approve --id TECH-ANALYSIS-V1 --actor-type human --approval-source explicit-user --summary \"Approved the displayed template and delivery format\""],
  }),
  C("output resolve", "Find the agreed output format for one delivery.", "Trova il formato di output concordato per una consegna.", {
    options: [required("story"), required("output-type"), "requirement"],
    usage: "output resolve --story <story-id> --type <artifact-type> [--requirement <requirement-id>]",
    examples: ["output resolve --story ST-BOOKING-001 --type technical-analysis"],
  }),
  C("output link", "Link a produced artifact and optional render or visual verification evidence. Use --render-evidence for that verification; record functional or test evidence with story complete-step or trace append.", "Collega un artefatto prodotto e, facoltativamente, prove di rendering o verifica visiva. Usa --render-evidence per questa verifica; registra le prove funzionali o di test con story complete-step o trace append.", {
    effect: "local",
    options: [
      "id",
      required("story"),
      required("linked-output-type"),
      required("artifact"),
      required("template"),
      required("output-mode"),
      conditional("base-artifact", "--mode delta", "--mode delta"),
      "requirement",
      "render-evidence",
      "legacy-output-render-evidence",
      "verification-receipt-file",
      {
        name: "authorization",
        required_when: text(
          "a story bound to an approved assessment proposal or an exact delivery profile checkpoint",
          "una story vincolata a una proposta di assessment approvata o a un checkpoint del profilo di consegna esatto",
        ),
        description: text(
          "Use one exact delegated authorization. When supplied outside a required checkpoint, it is still validated and consumed; an invalid grant fails the command.",
          "Usa una delega esatta. Se viene fornita fuori da un checkpoint obbligatorio, viene comunque verificata e consumata; una delega non valida blocca il comando.",
        ),
      },
      "output-decision-id",
      conditional("rationale", "--decision-id for a new approved exception", "--decision-id per una nuova eccezione approvata"),
      conditional("actor-type", "--decision-id for a new approved exception", "--decision-id per una nuova eccezione approvata"),
      "actor-name",
      "actor-email",
      conditional("approval-source", "--decision-id for a new approved exception", "--decision-id per una nuova eccezione approvata"),
      conditional("approval-evidence", "a new --decision-id exception without --rationale", "una nuova eccezione --decision-id senza --rationale"),
      "allow-unapproved-contract-output",
    ],
    usage: "output link --story <story-id> --type <artifact-type> --artifact <path> --template <template-id> --mode <reuse|delta|new> [--base-artifact <path>] [--requirement <requirement-id>] [--render-evidence <path>] [--evidence <path>] [--receipt-file <path>] [--authorization <authorization-id>]",
    examples: [
      "output link --story ST-BOOKING-001 --type validation-report --artifact docs/validation-report.md --template VALIDATION-REPORT-V1 --mode new --requirement REQ-BOOKING-001",
      "output link --story ST-REPORT-001 --type implementation-report --artifact docs/implementation-report.pdf --template IMPLEMENTATION-REPORT-V1 --mode new --render-evidence evidence/implementation-report-render.png",
    ],
  }),
  C("output status", "Show output coverage for one delivery.", "Mostra la copertura degli output di una consegna.", { options: [required("story"), "output-types"] }),
  C("cache rebuild", "Rebuild local derived data from canonical records.", "Rigenera i dati locali derivati dai record canonici.", { effect: "local" }),
  C("cache status", "Show cache health and freshness.", "Mostra integrità e aggiornamento della cache."),
  C("cache clear", "Remove local derived cache data; canonical records remain.", "Rimuove la cache locale derivata; i record canonici restano.", { effect: "local" }),
  C("manifest rebuild", "Rebuild deterministic file manifests.", "Rigenera manifest deterministici dei file.", { effect: "local" }),
  C("archive closed", "Plan or apply archival of completed records.", "Pianifica o applica l’archiviazione dei record completati.", { effect: "local", options: ["archive-before", "apply", "out", "force"] }),
  C("migration active", "Plan or apply a migration to active-release scope.", "Pianifica o applica una migrazione all’ambito del rilascio attivo.", { effect: "local", options: ["release-manifest", "apply", "reason"] }),
  C("migration identity", "Plan, apply, or recover an attributed identity migration.", "Pianifica, applica o recupera una migrazione delle identità attribuite.", {
    effect: "protected",
    options: [
      "identity-map-json",
      "identity-map-file",
      "from-email",
      "to-email",
      "to-name",
      "reason",
      "apply",
      "recover",
      "plan-hash",
      "recovery-nonce",
    ],
    usage: "migration identity (--identity-map-json <json> | --identity-map-file <path> | --from-email <email> --to-email <email> [--to-name <name>]) [--reason <text>] [--apply --plan-hash <sha256>] [--recover --recovery-nonce <nonce> --plan-hash <sha256>]",
    examples: ["migration identity --from-email old@example.test --to-email new@example.test --to-name \"New Owner\" --reason \"The recorded address changed\""],
  }),
  C("report activity", "Summarize recent project activity for a chosen audience.", "Riepiloga l’attività recente del progetto per il pubblico scelto.", {
    options: ["view", "report-since", "report-until", "story", "report-actor", "out", "force"],
    usage: "report activity [--view <business|dev|agent-verbose>] [--since <date-or-age>] [--until <date-or-age>] [--story <story-id>] [--actor <identity>] [--out <path>]",
    examples: ["report activity --view business --since 7d --story ST-BOOKING-001"],
  }),
  C("report query", "Answer a bounded question from recorded project evidence.", "Risponde a una domanda delimitata usando le prove registrate nel progetto.", {
    options: ["query-json", "query-file", "query", "task-text", "out", "force"],
    usage: "report query (--query-json <json> | --query-file <path> | --query <text>) [--out <path>]",
    examples: ["report query --query \"Which approved requirements still have no release?\""],
  }),
  C("index rebuild", "Rebuild the local knowledge index.", "Rigenera l’indice locale della conoscenza.", { effect: "local" }),
  C("kb search", "Search local project knowledge with a bounded result count.", "Cerca nella conoscenza locale del progetto con risultati limitati.", { options: ["query", "limit"], usage: "kb search <query>" }),
  C("gate check", "Check whether evidence and boundaries are ready for the next separate action. A passing strict story check seals a local intermediate receipt; lifecycle-complete seals the distinct final receipt.", "Controlla se prove e limiti sono pronti per la prossima azione separata. Un controllo strict positivo sulla story sigilla una ricevuta locale intermedia; lifecycle-complete sigilla la distinta ricevuta finale.", {
    effect: "local",
    options: [
      conditional("story", "--scope story, inferred story scope, or --lifecycle-complete", "--scope story, ambito story dedotto oppure --lifecycle-complete"),
      "gate-scope",
      conditional("release-manifest", "--scope release-manifest", "--scope release-manifest"),
      "strict",
      "lifecycle-complete",
      "out",
      conditional("force", "--out replacing an existing report", "--out che sostituisce un report esistente"),
      "actor",
      "actor-type",
      "actor-name",
      "actor-email",
    ],
    usage: "gate check [--story <story-id>] [--scope <story|release-manifest|all>] [--release-manifest <id-or-path>] [--strict] [--lifecycle-complete] [--out <path>] [--force]",
    examples: ["gate check --story ST-BOOKING-001 --scope story --strict --lifecycle-complete --out .sdlc/reports/ST-BOOKING-001-gate-report.json"],
  }),
  C("orchestrate status", "Show ready, active, and blocked work.", "Mostra lavoro pronto, attivo e bloccato."),
  C("orchestrate plan", "Suggest a bounded execution order without starting work.", "Suggerisce un ordine di esecuzione limitato senza avviare il lavoro.", { effect: "plan", options: ["limit"] }),
  C("route", "Choose the next lifecycle action from structured intent.", "Sceglie la prossima azione del ciclo da un intento strutturato.", {
    effect: "plan",
    aliases: ["route decide"],
    options: [
      { name: "intent-json", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      { name: "intent-file", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      "task-text",
    ],
    usage: "route (--intent-json <canonical-intent-json> | --intent-file <path>) [--text <original-request>]",
    examples: ["route --intent-file requests/implement-ST-001.json --text \"Implement ST-001\""],
  }),
  C("route decide", "Choose the next lifecycle action from structured intent; requested actions come from the project routing configuration.", "Sceglie la prossima azione del ciclo da un intento strutturato; le azioni richieste provengono dalla configurazione di routing del progetto.", {
    effect: "plan",
    aliases: ["route"],
    options: [
      { name: "intent-json", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      { name: "intent-file", required_one_of: text("--intent-json or --intent-file", "--intent-json oppure --intent-file") },
      "task-text",
    ],
    usage: "route decide (--intent-json <canonical-intent-json> | --intent-file <path>) [--text <original-request>]",
    examples: ["route decide --intent-json '{\"requested_action\":\"implement_story\",\"confidence\":0.92,\"referenced_entities\":[{\"type\":\"story\",\"id\":\"ST-001\"}],\"provided_artifacts\":[],\"missing_context\":[],\"proposed_phase\":\"implementation\",\"artifact_type\":null,\"skip_phases\":[]}' --text \"Implement ST-001\""],
  }),
  C("status", "Show the current outcome, impact, decision needed, protection, and next action.", "Mostra risultato, impatto, decisione richiesta, protezione e prossimo passo."),
];

function normalizePath(path) {
  const tokens = Array.isArray(path)
    ? path
    : String(path ?? "").trim().split(/\s+/u).filter(Boolean);
  const normalized = tokens.map((token) => String(token).trim()).filter(Boolean);
  if (normalized[0] === "agentic-sdlc") normalized.shift();
  return normalized;
}

function commandOptions(specifications) {
  return specifications.map((specification) => {
    const name = typeof specification === "string" ? specification : specification?.name;
    const descriptor = OPTION_LIBRARY[name];
    if (!descriptor) throw new Error(`Unknown catalog option '${name}'`);
    if (typeof specification === "string") return descriptor;
    const { name: ignored, ...overrides } = specification;
    return { ...descriptor, ...overrides };
  });
}

function buildCatalog() {
  const root = {
    name: "agentic-sdlc",
    path: [],
    path_text: "",
    kind: "root",
    description: text(
      "Talk naturally to Codex about the outcome you want.",
      "Parla naturalmente con Codex del risultato che vuoi ottenere.",
    ),
    protection: EFFECTS.read,
    effect: "read",
    options: GLOBAL_OPTIONS,
    positionals: [],
    children: [],
  };
  const nodes = new Map([["", root]]);

  for (const definition of COMMANDS) {
    const tokens = normalizePath(definition.path);
    for (let depth = 1; depth < tokens.length; depth += 1) {
      const groupTokens = tokens.slice(0, depth);
      const key = groupTokens.join(" ");
      if (nodes.has(key)) continue;
      const parentKey = groupTokens.slice(0, -1).join(" ");
      const group = {
        name: groupTokens.at(-1),
        path: groupTokens,
        path_text: key,
        kind: "group",
        description: GROUP_DESCRIPTIONS[key] ?? GROUP_DESCRIPTIONS[groupTokens[0]] ?? text("Related commands.", "Comandi correlati."),
        protection: EFFECTS.read,
        effect: "read",
        options: [],
        positionals: [],
        children: [],
      };
      nodes.get(parentKey).children.push(group);
      nodes.set(key, group);
    }
    const key = tokens.join(" ");
    if (nodes.has(key)) {
      const existing = nodes.get(key);
      if (existing.kind !== "group") throw new Error(`Duplicate command '${key}'`);
      existing.kind = "command";
      existing.description = definition.description;
      existing.protection = definition.protection;
      existing.effect = definition.effect;
      existing.canonical_action = definition.canonical_action;
      existing.mutation = definition.mutation;
      existing.options = commandOptions(definition.options);
      existing.positionals = [...definition.positionals];
      existing.usage = definition.usage;
      existing.examples = definition.examples;
      existing.aliases = definition.aliases;
      continue;
    }
    const parentKey = tokens.slice(0, -1).join(" ");
    const leaf = {
      name: tokens.at(-1),
      path: tokens,
      path_text: key,
      kind: "command",
      description: definition.description,
      protection: definition.protection,
      effect: definition.effect,
      canonical_action: definition.canonical_action,
      mutation: definition.mutation,
      options: commandOptions(definition.options),
      positionals: [...definition.positionals],
      usage: definition.usage,
      examples: definition.examples,
      aliases: definition.aliases,
      children: [],
    };
    nodes.get(parentKey).children.push(leaf);
    nodes.set(key, leaf);
  }

  const sortTree = (node) => {
    node.children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of node.children) sortTree(child);
  };
  sortTree(root);
  return { root: deepFreeze(root), nodes };
}

const BUILT = buildCatalog();

export const COMMAND_CATALOG = BUILT.root;

export function normalizeLocale(locale = "en") {
  const normalized = String(locale).trim().toLowerCase().split(/[-_]/u)[0];
  if (!SUPPORTED_LOCALES.has(normalized)) {
    throw new TypeError(`Unsupported locale '${locale}'. Use en or it.`);
  }
  return normalized;
}

export function localized(value, locale = "en") {
  return value[normalizeLocale(locale)];
}

export function findCommand(path = []) {
  return BUILT.nodes.get(normalizePath(path).join(" ")) ?? null;
}

export function getChildCommands(path = []) {
  return findCommand(path)?.children ?? Object.freeze([]);
}

export function listCommandPaths({ includeGroups = false, asTokens = false } = {}) {
  const paths = [...BUILT.nodes.values()]
    .filter((node) => node.path.length > 0 && (includeGroups || node.kind === "command"))
    .map((node) => asTokens ? [...node.path] : node.path_text)
    .sort((left, right) => {
      const leftText = Array.isArray(left) ? left.join(" ") : left;
      const rightText = Array.isArray(right) ? right.join(" ") : right;
      return leftText.localeCompare(rightText, "en");
    });
  return deepFreeze(paths);
}

export function listOptions(path = [], { includeGlobal = true } = {}) {
  const node = findCommand(path);
  if (!node) return Object.freeze([]);
  const byName = new Map();
  if (includeGlobal) {
    for (const descriptor of GLOBAL_OPTIONS) byName.set(descriptor.name, descriptor);
  }
  for (const descriptor of node.options) byName.set(descriptor.name, descriptor);
  return deepFreeze([...byName.values()]);
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[right.length];
}

export function suggestCommand(path, { limit = 3, includeGroups = true } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError("Suggestion limit must be an integer between 1 and 10");
  }
  const input = normalizePath(path).join(" ").toLowerCase();
  if (!input) return Object.freeze([]);
  const inputFirst = input.split(" ")[0];
  const candidates = [...BUILT.nodes.values()]
    .filter((node) => node.path.length > 0 && (includeGroups || node.kind === "command"))
    .map((node) => {
      const candidate = node.path_text.toLowerCase();
      const firstPenalty = candidate.split(" ")[0] === inputFirst ? 0 : 2;
      const prefixBonus = candidate.startsWith(input) || input.startsWith(candidate) ? -2 : 0;
      return { path: node.path_text, distance: levenshtein(input, candidate) + firstPenalty + prefixBonus };
    })
    .sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path, "en"))
    .slice(0, limit)
    .map(({ path: candidatePath }) => candidatePath);
  return deepFreeze(candidates);
}

export const nearestCommand = suggestCommand;
