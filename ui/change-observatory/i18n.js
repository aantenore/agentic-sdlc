import {
  ITERATION_PLACEHOLDER_PATTERN,
  MODEL_PLACEHOLDERS,
} from "./model.js";

const SUPPORTED_LOCALES = new Set(["en", "it"]);
const MAX_TECHNICAL_ERROR_CHARACTERS = 1_024;
const TECHNICAL_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const TECHNICAL_CORRELATION_ID_PATTERN = /^corr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const UNSAFE_TECHNICAL_ERROR_PATTERNS = Object.freeze([
  /\b[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{1,63}\b/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:AKIA[A-Z0-9]{16}|(?:github_pat_|gh[opsur]_|glpat-|sk-(?:proj-)?|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]{8,})/iu,
  /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,768}\.[A-Za-z0-9_-]{10,512}\b/u,
  /\b(?:Set-Cookie|Cookie)\s*:/iu,
  /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/u,
  /(?:["'](?=[A-Za-z0-9_])|\b)[A-Za-z0-9_]{0,128}(?:access[_-]?token|account[_-]?key|api[_-]?key|authorization|client[_-]?secret|credentials?|cookie|passphrase|passwd|password|private[_-]?key|pwd|refresh[_-]?token|secret[_-]?access[_-]?key|secret[_-]?key|secret|set[_-]?cookie|storage[_-]?account[_-]?key|token)["']?\s*[:=]/iu,
]);

let activeLocale = "en";

const ITALIAN = Object.freeze({
  "Skip to project lineage": "Vai alla storia del progetto",
  "Skip to project evidence": "Vai alle prove del progetto",
  "Skip to portfolio overview": "Vai alla panoramica del portfolio",
  "Project evidence": "Prove del progetto",
  "Toggle navigation": "Apri o chiudi la navigazione",
  "Project controls": "Controlli del progetto",
  Project: "Progetto",
  "Branch / snapshot": "Branch / istantanea",
  "Branch or snapshot": "Branch o istantanea",
  "Current evidence": "Prove correnti",
  "Loading…": "Caricamento…",
  "All projects": "Tutti i progetti",
  "Choose a portfolio project": "Scegli un progetto del portfolio",
  Projects: "Progetti",
  "Available projects": "Progetti disponibili",
  "Unavailable projects": "Progetti non disponibili",
  "Portfolio overview": "Panoramica del portfolio",
  "Portfolio could not be loaded": "Non è stato possibile caricare il portfolio",
  "Choose a project to load its detailed evidence. Project details are read only when you open them.": "Scegli un progetto per caricarne le prove dettagliate. I dettagli vengono letti solo quando apri il progetto.",
  "Local · read-only": "Locale · sola lettura",
  "Portfolio projects": "Progetti del portfolio",
  "This project’s evidence is unavailable.": "Le prove di questo progetto non sono disponibili.",
  "Other projects remain available. Choose All projects to continue browsing the portfolio.": "Gli altri progetti restano disponibili. Scegli Tutti i progetti per continuare a esplorare il portfolio.",
  "Loading project evidence": "Caricamento delle prove del progetto",
  "The rest of the portfolio remains unchanged.": "Il resto del portfolio rimane invariato.",
  "Open project details": "Apri i dettagli del progetto",
  "Review unavailable project": "Controlla il progetto non disponibile",
  "This project could not be read safely. Other projects are still available.": "Non è stato possibile leggere questo progetto in sicurezza. Gli altri progetti sono ancora disponibili.",
  "Portfolio · ready": "Portfolio · pronto",
  "Portfolio · partly available": "Portfolio · parzialmente disponibile",
  "Loading project…": "Caricamento del progetto…",
  Ready: "Pronto",
  Review: "Da verificare",
  Checks: "Controlli",
  Changed: "Modificato",
  Refresh: "Aggiorna",
  "Open raw evidence": "Apri la prova grezza",
  Overview: "Panoramica",
  Timeline: "Cronologia",
  Contracts: "Accordi",
  Decisions: "Decisioni",
  Changes: "Modifiche",
  "Intent evidence": "Prove dell’intento",
  Verification: "Verifica",
  "Evidence API": "API delle prove",
  Connecting: "Connessione in corso",
  "Change summary": "Riepilogo delle modifiche",
  "What was asked?": "Cosa è stato richiesto?",
  "What changed?": "Cosa è cambiato?",
  "Why was it decided?": "Perché è stato deciso?",
  "Loading recorded requirements…": "Caricamento delle richieste registrate…",
  "Loading recorded changes…": "Caricamento delle modifiche registrate…",
  "Loading recorded decisions…": "Caricamento delle decisioni registrate…",
  "Reconstructing project lineage": "Ricostruzione della storia del progetto",
  "Reading canonical SDLC evidence. No history is inferred silently.": "Lettura delle prove SDLC registrate. Nessun passaggio viene ricostruito senza dichiararlo.",
  "Evidence inspector": "Dettagli della prova",
  Inspector: "Dettagli",
  "No record selected": "Nessuna prova selezionata",
  "Select a lineage state or evidence record to inspect its recorded inputs, outputs, rationale, alternatives, and sources.": "Seleziona un passaggio o una prova per vedere dati in ingresso, risultati, motivazioni, alternative e fonti registrate.",
  "Raw record": "Prova grezza",
  "Select a source record": "Seleziona una fonte",
  "JSON / text": "JSON / testo",
  "Close raw record": "Chiudi la prova grezza",
  "No source record selected.": "Nessuna fonte selezionata.",
  "Change Observatory needs JavaScript to load the local, read-only evidence API.": "Change Observatory richiede JavaScript per leggere l’API locale e in sola lettura delle prove.",
  "Read-only · ready": "Sola lettura · pronto",
  Unavailable: "Non disponibile",
  "Canonical source": "Fonte registrata",
  "Loading canonical source…": "Caricamento della fonte registrata…",
  "Raw source unavailable": "Fonte grezza non disponibile",
  "Source records": "Fonti registrate",
  "Open raw source": "Apri la fonte grezza",
  "Open dossier source": "Apri la fonte del dossier",
  "No canonical evidence was recorded for this answer.": "Non è stata registrata alcuna prova per questa risposta.",
  "No recorded evidence answers this question yet.": "Nessuna prova registrata risponde ancora a questa domanda.",
  "This part of the project history may be incomplete.": "Questa parte della storia del progetto potrebbe essere incompleta.",
  "Do not treat missing evidence as approval or completed work.": "Non considerare l’assenza di prove come un’approvazione o un lavoro completato.",
  "This view remains read-only and does not invent missing facts.": "Questa vista resta in sola lettura e non inventa informazioni mancanti.",
  "Return to the Codex chat and describe the missing evidence in natural language; after it is recorded, refresh this view.": "Torna nella chat di Codex e descrivi in linguaggio naturale la prova mancante; dopo che è stata registrata, aggiorna questa vista.",
  "Evidence diagnostics": "Problemi nelle prove",
  "Equivalent diagnostics grouped": "Problemi equivalenti raggruppati",
  Iteration: "Iterazione",
  Phase: "Fase",
  Discovery: "Scoperta",
  Analysis: "Analisi",
  Design: "Progettazione",
  Implementation: "Implementazione",
  Validation: "Validazione",
  Release: "Rilascio",
  Asked: "Richiesto",
  Decided: "Deciso",
  Contract: "Accordo",
  Done: "Completato",
  Verified: "Verificato",
  Active: "Attivo",
  Approved: "Approvato",
  Partial: "Parziale",
  "Project lineage": "Storia del progetto",
  "Iteration-by-phase reconstruction from canonical evidence": "Ricostruzione per iterazione e fase basata sulle prove registrate",
  "No recorded iterations match the selected filters.": "Nessuna iterazione registrata corrisponde ai filtri scelti.",
  "Scrollable lineage matrix": "Matrice scorrevole della storia del progetto",
  "Lineage status legend": "Legenda dello stato",
  Complete: "Completato",
  "In progress": "In corso",
  Blocked: "Bloccato",
  Missing: "Mancante",
  Recorded: "Registrato",
  Inferred: "Dedotto",
  Malformed: "Non valido",
  "Recorded rationale": "Motivazione registrata",
  "Generated explanation": "Spiegazione generata",
  "Not recorded.": "Non registrata.",
  "Release evidence": "Prova di rilascio",
  "Link metadata missing": "Collegamento non registrato",
  "Link method not recorded": "Metodo di collegamento non registrato",
  "Linked to related recorded evidence": "Collegato alle prove registrate correlate",
  "Related evidence link not recorded": "Collegamento alle prove correlate non registrato",
  "No linked evidence": "Nessuna prova collegata",
  "No explicitly linked canonical record was provided for this lane.": "Non è stata fornita una prova registrata e collegata esplicitamente a questo passaggio.",
  "Evidence missing": "Prova mancante",
  "Unlinked project evidence": "Prove del progetto non collegate",
  "These canonical records are visible, but no explicit story link assigns them to an iteration dossier.": "Queste prove sono visibili, ma nessun collegamento esplicito le assegna al dossier di un’iterazione.",
  "Dossier iteration": "Iterazione del dossier",
  "Iteration dossier": "Dossier dell’iterazione",
  "The recorded path from request to verification; links are never inferred in the browser": "Il percorso registrato dalla richiesta alla verifica; il browser non inventa collegamenti",
  "No recorded iteration is available for a lineage dossier.": "Non è disponibile alcuna iterazione registrata per il dossier.",
  "Selected iteration": "Iterazione selezionata",
  "Dossier not recorded": "Dossier non registrato",
  "This iteration has no proof-bound dossier. Project-level or unlinked evidence is not assigned here.": "Questa iterazione non ha un dossier collegato alle prove. Le prove generali o non collegate non vengono assegnate qui.",
  "Unsupported dossier schema: ": "Formato del dossier non supportato: ",
  "Dossier diagnostics": "Problemi del dossier",
  "Contract evolution": "Evoluzione degli accordi",
  "Versions, approvals, and status": "Versioni, approvazioni e stato",
  "Approved boundaries, versions, and source evidence": "Limiti approvati, versioni e prove di origine",
  "Recorded changes": "Modifiche registrate",
  "Implementation and sync evidence grouped by recorded intent": "Prove di implementazione e sincronizzazione raggruppate per obiettivo registrato",
  "No change records were found.": "Non sono state trovate modifiche registrate.",
  "Verification evidence": "Prove di verifica",
  "Tests, gates, and validation outcomes": "Test, controlli e risultati della validazione",
  "No verification evidence was recorded.": "Non è stata registrata alcuna prova di verifica.",
  "Recorded rationale and alternatives across delivery": "Motivazioni e alternative registrate durante la consegna",
  "Versions, approvals, and source evidence": "Versioni, approvazioni e prove di origine",
  "Not recorded for this evidence item.": "Non registrato per questa prova.",
  Evidence: "Prove",
  "No source evidence was linked to this item.": "Nessuna fonte è stata collegata a questa prova.",
  Open: "Apri",
  "Request / record": "Richiesta / registrazione",
  "Decision rationale": "Motivazione della decisione",
  Inputs: "Dati in ingresso",
  Outputs: "Risultati",
  "Plain-language explanation": "Spiegazione in parole semplici",
  "No plain-language explanation was recorded for this evidence item.": "Per questa prova non è stata registrata una spiegazione in parole semplici.",
  "No rationale was recorded for this evidence item.": "Per questa prova non è stata registrata alcuna motivazione.",
  "Private reasoning": "Ragionamento privato",
  "Hidden by design. Change Observatory never renders private chain-of-thought.": "Nascosto per scelta. Change Observatory non mostra mai il ragionamento privato del modello.",
  "Alternatives rejected": "Alternative scartate",
  "Intent evidence": "Prove dell’intento",
  "Project link": "Collegamento al progetto",
  "No trace link was recorded.": "Non è stato registrato alcun collegamento alla traccia.",
  "Read-only": "Sola lettura",
  "Content-free evidence only. MAC present · not verified by Change Observatory.": "Sono mostrati solo dati tecnici privi del contenuto della richiesta. L’integrità è presente, ma Change Observatory non la verifica.",
  "Content-free IntentABI shadow observations; integrity is shown without asserting verification": "Osservazioni tecniche prive del contenuto della richiesta; l’integrità è mostrata senza dichiararla verificata",
  "No IntentABI shadow observations were recorded.": "Non è stata registrata alcuna osservazione tecnica dell’intento.",
  "Project lineage could not be loaded": "Non è stato possibile caricare la storia del progetto",
  "Evidence needs attention": "Le prove richiedono attenzione",
  "Some recorded evidence could not be read safely.": "Alcune prove registrate non possono essere lette in sicurezza.",
  "Related views may be incomplete until the evidence is corrected.": "Le viste collegate potrebbero essere incomplete finché le prove non vengono corrette.",
  "Do not make a decision from the affected view alone.": "Non prendere una decisione basandoti soltanto sulla vista interessata.",
  "Unsafe or unsupported evidence is omitted and no project file is changed.": "Le prove non sicure o non supportate vengono omesse e nessun file del progetto viene modificato.",
  "Open technical details, then return to the Codex chat and describe the correction in natural language; after it is recorded, refresh this view.": "Apri i dettagli tecnici, poi torna nella chat di Codex e descrivi la correzione in linguaggio naturale; dopo che è stata registrata, aggiorna questa vista.",
  Outcome: "Risultato",
  Impact: "Cosa cambia in pratica",
  Decision: "Cosa devi decidere",
  Protection: "Cosa resta protetto",
  "Next action": "Prossimo passo",
  "Technical details": "Dettagli tecnici",
  "Technical details (optional)": "Dettagli tecnici (facoltativi)",
  "Not recorded": "Non registrato",
  "Unidentified record": "Voce senza identificativo",
  "Untitled record": "Voce senza titolo",
  "No recorded summary.": "Nessun riepilogo registrato.",
  "Unknown project": "Progetto sconosciuto",
  "Intent not recorded": "Intento non registrato",
  "Time not recorded": "Ora non registrata",
  "The evidence API reported an unspecified diagnostic.": "L’API delle prove ha segnalato un problema non specificato.",
  "No contract evolution were recorded.": "Non è stata registrata alcuna evoluzione del contratto.",
  "No decisions were recorded.": "Non è stata registrata alcuna decisione.",
  "Source recorded": "Fonte registrata",
  "not recorded": "non registrata",
  "not displayed": "non mostrato",
  Generated: "Generata",
  "Codex generated": "Generata da Codex",
  Deterministic: "Deterministica",
  "Human authored": "Scritta da una persona",
  "How to read these records": "Come leggere queste voci",
  "Each card shows only what is specific to it; the full explanation for each kind of recorded state is here.": "Ogni scheda mostra solo ciò che la riguarda; qui trovi la spiegazione completa per ogni tipo di stato registrato.",
  "Recorded items": "Voci registrate",
  Proposals: "Proposte",
  "Items without a recorded status": "Voci senza stato registrato",
  "Items no longer in effect": "Voci non più in vigore",
  "Recorded answer": "Risposta registrata",
  "Recorded request": "Richiesta registrata",
  "Recorded change": "Modifica registrata",
  "Recorded decision": "Decisione registrata",
  "Recorded check": "Verifica registrata",
  "Project record": "Informazione registrata sul progetto",
  "A project request and its expected outcome were recorded.": "Sono stati registrati una richiesta di progetto e il risultato atteso.",
  "A change to the project was recorded.": "È stata registrata una modifica al progetto.",
  "A project decision was recorded.": "È stata registrata una decisione di progetto.",
  "A project check was recorded; review the explanation below before relying on it.": "È stata registrata una verifica; prima di farvi affidamento, leggi la spiegazione qui sotto.",
  "A working agreement for this delivery was recorded.": "È stato registrato un accordo operativo per questa consegna.",
  "Evidence about a release was recorded.": "È stata registrata una prova relativa a un rilascio.",
  "Recorded project information is available; use the explanation below to understand its practical meaning.": "È disponibile un’informazione registrata sul progetto; usa la spiegazione qui sotto per capirne il significato pratico.",
  "Working limit for this request": "Limite operativo per questa richiesta",
  "Working agreement": "Accordo operativo",
  "Working agreement for this delivery": "Accordo operativo per questa consegna",
  "How this delivery can proceed now": "Come può procedere ora questa consegna",
  "Working limit awaiting approval": "Limite operativo in attesa di approvazione",
  "Approved working limit for this request": "Limite operativo approvato per questa richiesta",
  "Revoked working limit for this request": "Limite operativo revocato per questa richiesta",
  "Working limit needs attention": "Il limite operativo richiede attenzione",
  "A limit has been proposed for this request, but no delivery may rely on it until it is approved.": "È stato proposto un limite per questa richiesta, ma nessuna consegna può farvi affidamento finché non viene approvato.",
  "This sets how independently a delivery may be configured; every code change or local installation still needs its own agreement.": "Stabilisce quanto una consegna può essere configurata per procedere in autonomia; ogni modifica al codice o installazione locale richiede comunque un accordo separato.",
  "This limit can no longer be used; unfinished work needs a new approved limit before it continues.": "Questo limite non è più utilizzabile; il lavoro non concluso richiede un nuovo limite approvato prima di continuare.",
  "The recorded state does not confirm that this request can be used to configure a delivery.": "Lo stato registrato non conferma che questa richiesta possa essere usata per configurare una consegna.",
  "This work may continue": "Questo lavoro può continuare",
  "Review needed before the next protected step": "Serve una verifica prima del prossimo passaggio protetto",
  "Approval needed before work continues": "Serve un’approvazione prima che il lavoro continui",
  "This work is blocked": "Questo lavoro è bloccato",
  "Current permission needs attention": "Il permesso corrente richiede attenzione",
  "Routine work may proceed within the agreed limits; protected steps still keep their separate safeguards.": "Il lavoro ordinario può procedere entro i limiti concordati; i passaggi protetti mantengono le loro garanzie separate.",
  "Routine work has reached a boundary where the recorded evidence must be reviewed before continuing.": "Il lavoro ordinario ha raggiunto un limite in cui occorre verificare le prove registrate prima di continuare.",
  "The next step will wait until a person reviews the evidence and approves or changes the plan.": "Il prossimo passaggio resterà in attesa finché una persona non avrà verificato le prove e approvato o modificato il piano.",
  "Work cannot continue until the recorded conflict or missing protection is resolved.": "Il lavoro non può continuare finché non viene risolto il conflitto registrato o la protezione mancante.",
  "The recorded state does not make clear whether this work may continue.": "Lo stato registrato non chiarisce se questo lavoro possa continuare.",
  "Awaiting approval": "In attesa di approvazione",
  "Awaiting review": "In attesa di verifica",
  "In effect": "In vigore",
  "No longer usable": "Non più utilizzabile",
  "Needs attention": "Richiede attenzione",
  "Ready to continue": "Pronto a continuare",
  "Review needed": "Verifica necessaria",
  "Approval needed": "Approvazione necessaria",
  Completed: "Completato",
  Type: "Tipo",
  Status: "Stato",
  "Recorded title": "Titolo registrato",
  "Recorded summary": "Riepilogo registrato",
  "Event ID": "ID evento",
  Mode: "Modalità",
  Submitted: "Inviato",
  Reason: "Motivo",
  Proof: "Prova",
  Story: "Storia",
  "Linked traces": "Tracce collegate",
  Shadow: "Osservazione",
  Original: "Originale",
  "Candidate observed": "Possibile corrispondenza osservata",
  Identity: "Identità",
  Bypass: "Escluso",
  "Preparer fault": "Errore di preparazione",
  "Preparer timeout": "Tempo di preparazione scaduto",
  "Invalid preparer result": "Risultato di preparazione non valido",
  "Present · unverified": "Presente · non verificato",
  "Not observed": "Non osservato",
  "Present · not verified": "Presente · non verificato",
  "IntentABI · Codex shadow": "IntentABI · osservazione Codex",
  "Unlinked. No complete explicit story and trace link was recorded.": "Non collegata. Non è stato registrato un collegamento completo ed esplicito alla storia e alla traccia.",
});

const AUTONOMY_TYPES = new Set([
  "requirement-execution-profile",
  "delivery-execution-profile",
  "autonomy-decision",
]);

export function normalizeLocale(value) {
  const locale = String(value ?? "en").trim().toLowerCase().split(/[-_]/u)[0];
  return SUPPORTED_LOCALES.has(locale) ? locale : "en";
}

export function localeFromLocation(locationLike = {}) {
  const params = new URLSearchParams(String(locationLike.search ?? ""));
  return normalizeLocale(params.get("locale") || "en");
}

export function setLocale(value) {
  activeLocale = normalizeLocale(value);
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

export function t(text) {
  const value = String(text ?? "");
  if (activeLocale !== "it") return value;
  return ITALIAN[value] ?? translatePattern(value) ?? value;
}

export function localizeUiText(text) {
  return t(text);
}

const MODEL_PLACEHOLDER_SET = new Set(MODEL_PLACEHOLDERS);

// Recorded values pass through unchanged; only fallback text generated by
// the browser model for an absent field is localized.
export function localizePlaceholder(value) {
  const text = String(value ?? "");
  if (MODEL_PLACEHOLDER_SET.has(text)) return t(text);
  const iteration = text.match(ITERATION_PLACEHOLDER_PATTERN);
  if (iteration) return `${t("Iteration")} ${iteration[1]}`;
  return text;
}

function translatePattern(value) {
  let match = value.match(/^(.+): All$/u);
  if (match) return `${t(match[1])}: Tutti`;
  match = value.match(/^(\d+) (category|categories) · (\d+) (record|records)$/u);
  if (match) return `${match[1]} ${match[1] === "1" ? "categoria" : "categorie"} · ${match[3]} ${match[3] === "1" ? "prova" : "prove"}`;
  match = value.match(/^(\d+) records$/u);
  if (match) return `${match[1]} prove`;
  match = value.match(/^(\d+) linked (record|records)$/u);
  if (match) return `${match[1]} ${match[1] === "1" ? "prova collegata" : "prove collegate"}`;
  match = value.match(/^Showing (\d+) of (\d+)\.(.*)$/u);
  if (match) return `Visualizzati ${match[1]} di ${match[2]}.${match[3]}`;
  match = value.match(/^Inspect IntentABI event (.+)$/u);
  if (match) return `Esamina l’evento IntentABI ${match[1]}`;
  match = value.match(/^Inspect (.+)$/u);
  if (match) return `Esamina ${match[1]}`;
  match = value.match(/^Event · (.+)$/u);
  if (match) return `Evento · ${match[1]}`;
  match = value.match(/^Linked by (.+)$/u);
  if (match) return `Collegato tramite ${match[1]}`;
  match = value.match(/^Generated explanation · (.+)$/u);
  if (match) return `${t("Generated explanation")} · ${t(match[1])}`;
  match = value.match(/^Dossier diagnostics · (\d+)$/u);
  if (match) return `Problemi del dossier · ${match[1]}`;
  match = value.match(/^Five-lane dossier for (.+)$/u);
  if (match) return `Dossier in cinque passaggi per ${match[1]}`;
  match = value.match(/^(Discovery|Analysis|Design|Implementation|Validation|Release) is (.+) for (.+)\.$/u);
  if (match) return `${t(match[1])}: ${t(match[2])} per ${match[3]}.`;
  match = value.match(/^(Working agreement awaiting approval|Approved working agreement|Revoked working agreement|Working agreement needs attention) for this (code change|local installation|delivery)$/u);
  if (match) {
    const state = {
      "Working agreement awaiting approval": "Accordo operativo in attesa di approvazione",
      "Approved working agreement": "Accordo operativo approvato",
      "Revoked working agreement": "Accordo operativo revocato",
      "Working agreement needs attention": "Accordo operativo da verificare",
    }[match[1]];
    return `${state} per ${autonomySubjectItalian(match[2])}`;
  }
  match = value.match(/^A separate way of working has been proposed for this (code change|local installation|delivery); work must wait for approval\.$/u);
  if (match) return `È stato proposto un modo di lavorare separato per ${autonomySubjectItalian(match[1])}; il lavoro deve attendere l’approvazione.`;
  match = value.match(/^The approved way of working applies only to this (code change|local installation|delivery) and cannot be reused for another change or installation\.$/u);
  if (match) return `Il modo di lavorare approvato vale solo per ${autonomySubjectItalian(match[1])} e non può essere riutilizzato per un’altra modifica o installazione.`;
  match = value.match(/^The previous agreement no longer permits work on this (code change|local installation|delivery); a new approval is required to continue\.$/u);
  if (match) return `L’accordo precedente non consente più di lavorare su ${autonomySubjectItalian(match[1])}; per continuare serve una nuova approvazione.`;
  match = value.match(/^The recorded state does not confirm that work may proceed on this (code change|local installation|delivery)\.$/u);
  if (match) return `Lo stato registrato non conferma che il lavoro possa procedere su ${autonomySubjectItalian(match[1])}.`;
  return null;
}

function autonomySubjectItalian(subject) {
  return {
    "code change": "questa modifica al codice",
    "local installation": "questa installazione locale",
    delivery: "questa consegna",
  }[subject] ?? subject;
}

export function applyDocumentLocale(root, locale = activeLocale) {
  setLocale(locale);
  const documentElement = root?.documentElement ?? root?.ownerDocument?.documentElement;
  if (documentElement) documentElement.lang = activeLocale;
  for (const element of root?.querySelectorAll?.("[data-i18n]") ?? []) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root?.querySelectorAll?.("[data-i18n-aria-label]") ?? []) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
}

export function isAutonomyRecord(item) {
  return AUTONOMY_TYPES.has(item?.type);
}

const INTERNAL_PRIMARY_VOCABULARY = /\b(?:bounded[-_ ]autonomous|checkpointed|checkpoint_required|audit_only|host_verified|execution[ _-]?profile|profile|receipt|ceiling|schema|hash|reason[ _-]?code)\b/iu;
const CANONICAL_RECORD_ID = /(?:\b[A-Z][A-Z0-9]{1,20}-[A-Z0-9][A-Z0-9._:-]*\b|\bcontract-[a-z0-9][a-z0-9._:-]*\b)/u;
const POSIX_ABSOLUTE_PATH = /(?:^|[\s("'`])\/(?!\/)(?:[A-Za-z0-9._~+-]+(?:\/[A-Za-z0-9._~+ -]+)*)/u;
const WINDOWS_DRIVE_PATH = /\b[A-Za-z]:[\\/][^\s"'`<>]+/u;
const WINDOWS_UNC_PATH = /(?:^|[\s("'`])\\\\(?:\?\\)?[^\\/\s"'`<>]+\\[^\s"'`<>]+/u;
const EXECUTABLE_COMMAND_LINE = /(?:^|[\s("'`])(?:npm|npx|pnpm|yarn|node|bun|deno|python(?:3(?:\.\d+)?)?|pip3?|pytest|git|gh|docker(?:-compose)?|kubectl|helm|terraform|cargo|mvn|gradle|dotnet|java|rtk)(?:\.exe)?\s+(?:--?[A-Za-z0-9][\w-]*|[A-Za-z0-9][\w./:@=+-]*)/iu;

function containsInternalPrimaryText(value) {
  const text = String(value ?? "").trim();
  return [
    INTERNAL_PRIMARY_VOCABULARY,
    CANONICAL_RECORD_ID,
    POSIX_ABSOLUTE_PATH,
    WINDOWS_DRIVE_PATH,
    WINDOWS_UNC_PATH,
    EXECUTABLE_COMMAND_LINE,
  ].some((pattern) => pattern.test(text));
}

function recordPresentation(item) {
  const type = String(item?.type ?? "").trim().toLowerCase();
  if (type.includes("requirement")) return {
    kind: "Recorded request",
    summary: "A project request and its expected outcome were recorded.",
  };
  if (["implementation", "sync", "change", "trace"].some((part) => type.includes(part))) return {
    kind: "Recorded change",
    summary: "A change to the project was recorded.",
  };
  if (["decision", "approval", "assumption", "risk"].some((part) => type.includes(part))) return {
    kind: "Recorded decision",
    summary: "A project decision was recorded.",
  };
  if (type.includes("contract")) return {
    kind: "Working agreement",
    summary: "A working agreement for this delivery was recorded.",
  };
  if (["gate", "test", "verification", "validation"].some((part) => type.includes(part))) return {
    kind: "Recorded check",
    summary: "A project check was recorded; review the explanation below before relying on it.",
  };
  if (type.includes("release")) return {
    kind: "Release evidence",
    summary: "Evidence about a release was recorded.",
  };
  return {
    kind: "Project record",
    summary: "Recorded project information is available; use the explanation below to understand its practical meaning.",
  };
}

function projectedStatus(item, fallbackStatus = null) {
  const explicitHumanStatus = String(item?.humanStatus ?? "").trim();
  if (explicitHumanStatus && !containsInternalPrimaryText(explicitHumanStatus)) {
    return t(explicitHumanStatus);
  }
  if (fallbackStatus) return t(fallbackStatus);

  const status = normalizedStatus(item);
  if (["proposed", "draft", "pending"].includes(status)) return t("Awaiting review");
  if (status === "approval_required") return t("Approval needed");
  if (["checkpoint_required", "review_required"].includes(status)) return t("Review needed");
  if (status === "ready") return t("Ready to continue");
  if (["active", "in_effect"].includes(status)) return t("In effect");
  if (["approved", "accepted"].includes(status)) return t("Approved");
  if (["complete", "completed", "done", "passed", "verified", "succeeded", "merged", "ready_for_review", "released"].includes(status)) {
    return t("Completed");
  }
  if (["in_progress", "running"].includes(status)) return t("In progress");
  if (["blocked", "denied", "rejected"].includes(status)) return t("Blocked");
  if (["revoked", "closed", "cancelled", "canceled", "superseded", "expired", "rolled_back"].includes(status)) {
    return t("No longer usable");
  }
  if (!status || ["missing", "not_recorded"].includes(status)) return t("Missing");
  return t("Needs attention");
}

export function displayKindForItem(item) {
  if (isAutonomyRecord(item)) return t("Working agreement");
  return t(recordPresentation(item).kind);
}

export function displayTextForItem(item) {
  if (isAutonomyRecord(item)) {
    const fallback = fallbackAutonomyPresentation(item);
    const humanTitle = String(item?.humanTitle ?? "").trim();
    const humanSummary = String(item?.humanSummary ?? "").trim();
    return {
      title: t(humanTitle && !containsInternalPrimaryText(humanTitle) ? humanTitle : fallback.title),
      summary: t(humanSummary && !containsInternalPrimaryText(humanSummary) ? humanSummary : fallback.summary),
      status: projectedStatus(item, fallback.status),
    };
  }

  const fallback = recordPresentation(item);
  const recordedTitle = String(item?.title ?? "").trim();
  const recordedSummary = String(item?.summary ?? "").trim();
  return {
    title: recordedTitle && !containsInternalPrimaryText(recordedTitle)
      ? localizePlaceholder(recordedTitle)
      : t(fallback.kind),
    summary: recordedSummary && !containsInternalPrimaryText(recordedSummary)
      ? localizePlaceholder(recordedSummary)
      : t(fallback.summary),
    status: projectedStatus(item),
  };
}

function fallbackAutonomyPresentation(item) {
  const status = normalizedStatus(item);
  if (item?.type === "requirement-execution-profile") {
    if (status === "proposed") return {
      title: "Working limit awaiting approval",
      summary: "A limit has been proposed for this request, but no delivery may rely on it until it is approved.",
      status: "Awaiting approval",
    };
    if (["active", "approved"].includes(status)) return {
      title: "Approved working limit for this request",
      summary: "This sets how independently a delivery may be configured; every code change or local installation still needs its own agreement.",
      status: "In effect",
    };
    if (status === "revoked") return {
      title: "Revoked working limit for this request",
      summary: "This limit can no longer be used; unfinished work needs a new approved limit before it continues.",
      status: "No longer usable",
    };
    return {
      title: "Working limit needs attention",
      summary: "The recorded state does not confirm that this request can be used to configure a delivery.",
      status: "Needs attention",
    };
  }
  if (item?.type === "delivery-execution-profile") {
    if (status === "proposed") return {
      title: "Working agreement awaiting approval for this delivery",
      summary: "A separate way of working has been proposed for this delivery; work must wait for approval.",
      status: "Awaiting approval",
    };
    if (["active", "approved"].includes(status)) return {
      title: "Approved working agreement for this delivery",
      summary: "The approved way of working applies only to this delivery and cannot be reused for another change or installation.",
      status: "In effect",
    };
    if (status === "revoked") return {
      title: "Revoked working agreement for this delivery",
      summary: "The previous agreement no longer permits work on this delivery; a new approval is required to continue.",
      status: "No longer usable",
    };
    return {
      title: "Working agreement needs attention for this delivery",
      summary: "The recorded state does not confirm that work may proceed on this delivery.",
      status: "Needs attention",
    };
  }
  if (status === "ready") return {
    title: "This work may continue",
    summary: "Routine work may proceed within the agreed limits; protected steps still keep their separate safeguards.",
    status: "Ready to continue",
  };
  if (status === "checkpoint_required") return {
    title: "Review needed before the next protected step",
    summary: "Routine work has reached a boundary where the recorded evidence must be reviewed before continuing.",
    status: "Review needed",
  };
  if (status === "approval_required") return {
    title: "Approval needed before work continues",
    summary: "The next step will wait until a person reviews the evidence and approves or changes the plan.",
    status: "Approval needed",
  };
  if (status === "blocked") return {
    title: "This work is blocked",
    summary: "Work cannot continue until the recorded conflict or missing protection is resolved.",
    status: "Blocked",
  };
  return {
    title: "Current permission needs attention",
    summary: "The recorded state does not make clear whether this work may continue.",
    status: "Needs attention",
  };
}

function normalizedStatus(item) {
  return String(item?.status ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_");
}

function requirementGuidance(status, isItalian) {
  if (["proposed", "draft", "pending", "approval_required"].includes(status)) {
    return isItalian ? {
      outcome: "È stato preparato un limite operativo per questa richiesta, ma non è ancora approvato.",
      impact: "Nessuna consegna può usare questa bozza per iniziare o proseguire il lavoro.",
      decision: "Rivedi il limite proposto e approvalo oppure chiedi una correzione.",
      protection: "La bozza non autorizza modifiche, pubblicazioni, accessi esterni o consegne.",
      nextAction: "Torna nella chat di Codex e rispondi in linguaggio naturale per approvare il limite proposto oppure descrivere la correzione che vuoi.",
    } : {
      outcome: "A working limit has been drafted for this request, but it is not approved yet.",
      impact: "No delivery can use this draft to start or continue work.",
      decision: "Review the proposed limit and approve it or request a correction.",
      protection: "The draft does not authorize changes, publishing, external access, or any delivery.",
      nextAction: "Return to the Codex chat and reply in natural language to approve the proposed limit or describe the correction you want.",
    };
  }

  if (["active", "approved"].includes(status)) {
    return isItalian ? {
      outcome: status === "approved"
        ? "Il limite operativo di questa richiesta è stato approvato."
        : "Il limite operativo di questa richiesta è in vigore.",
      impact: "Ogni consegna può ricevere una modalità di lavoro distinta, scelta in base al suo rischio.",
      decision: "Per ogni pull request o rilascio locale scegli e approva separatamente come procedere.",
      protection: "Questo limite, da solo, non autorizza modifiche, unioni, rilasci o accessi esterni.",
      nextAction: "Torna nella chat di Codex e descrivi in linguaggio naturale la consegna da avviare; chiedi un accordo separato e approvalo lì.",
    } : {
      outcome: status === "approved"
        ? "The working limit for this request was approved."
        : "The working limit for this request is in effect.",
      impact: "Each delivery can receive a separate way of working chosen for its risk.",
      decision: "For every pull request or local release, choose and approve separately how to proceed.",
      protection: "This limit alone does not authorize changes, merges, releases, or external access.",
      nextAction: "Return to the Codex chat and describe the delivery in natural language; ask for a separate agreement and approve it there.",
    };
  }

  if (status === "revoked") {
    return isItalian ? {
      outcome: "Il limite operativo di questa richiesta è stato revocato e non è più utilizzabile.",
      impact: "Le consegne non possono iniziare o continuare facendo affidamento su questo limite.",
      decision: "Decidi se serve un nuovo limite e approvalo prima di proseguire.",
      protection: "La revoca mantiene bloccate modifiche, unioni, rilasci e accessi esterni non autorizzati.",
      nextAction: "Torna nella chat di Codex e indica in linguaggio naturale se vuoi creare un nuovo limite oppure chiudere il lavoro collegato.",
    } : {
      outcome: "The working limit for this request was revoked and can no longer be used.",
      impact: "Deliveries cannot start or continue by relying on this limit.",
      decision: "Decide whether a new limit is needed and approve it before proceeding.",
      protection: "The revocation keeps unauthorized changes, merges, releases, and external access blocked.",
      nextAction: "Return to the Codex chat and say in natural language whether you want a new limit or want to close the linked work.",
    };
  }

  if (["closed", "superseded", "expired", "cancelled"].includes(status)) {
    return isItalian ? {
      outcome: "Il limite operativo di questa richiesta è chiuso e non è più corrente.",
      impact: "Le consegne nuove o ancora aperte non possono usarlo per proseguire.",
      decision: "Decidi se il lavoro è concluso o se serve un nuovo limite approvato.",
      protection: "Il limite chiuso non autorizza nuove attività o consegne.",
      nextAction: "Torna nella chat di Codex e indica in linguaggio naturale se vuoi usare il limite sostitutivo registrato oppure crearne uno nuovo.",
    } : {
      outcome: "The working limit for this request is closed and is no longer current.",
      impact: "New or unfinished deliveries cannot use it to proceed.",
      decision: "Decide whether the work is finished or a new approved limit is needed.",
      protection: "The closed limit does not authorize new work or deliveries.",
      nextAction: "Return to the Codex chat and say in natural language whether to use the recorded replacement limit or create a new one.",
    };
  }

  return isItalian ? {
    outcome: "Non è possibile confermare se il limite operativo di questa richiesta sia utilizzabile.",
    impact: "Nessuna consegna deve fare affidamento su questo stato non riconosciuto.",
    decision: "Verifica le prove registrate prima di scegliere come procedere.",
    protection: "In assenza di uno stato valido, modifiche, unioni, rilasci e accessi esterni restano bloccati.",
    nextAction: "Torna nella chat di Codex e descrivi in linguaggio naturale come correggere o sostituire il limite; dopo la registrazione, aggiorna questa vista.",
  } : {
    outcome: "It is not possible to confirm whether this request’s working limit can be used.",
    impact: "No delivery should rely on this unrecognized state.",
    decision: "Check the recorded evidence before choosing how to proceed.",
    protection: "Without a valid state, changes, merges, releases, and external access remain blocked.",
    nextAction: "Return to the Codex chat and describe in natural language how to correct or replace the limit; after it is recorded, refresh this view.",
  };
}

function deliveryGuidance(status, isItalian) {
  if (["proposed", "draft", "pending", "approval_required"].includes(status)) {
    return isItalian ? {
      outcome: "È stato proposto come lavorare su questa consegna, ma la proposta non è ancora approvata.",
      impact: "Il lavoro non deve iniziare o continuare sulla base di questa proposta.",
      decision: "Rivedi la proposta e approvala oppure chiedi una correzione.",
      protection: "La proposta non autorizza attività ordinarie o protette.",
      nextAction: "Torna nella chat di Codex e rispondi in linguaggio naturale per approvare la proposta oppure descrivere la correzione che vuoi.",
    } : {
      outcome: "A way of working was proposed for this delivery, but it is not approved yet.",
      impact: "Work must not start or continue under this proposal.",
      decision: "Review the proposal and approve it or request a correction.",
      protection: "The proposal authorizes neither routine nor protected actions.",
      nextAction: "Return to the Codex chat and reply in natural language to approve the proposal or describe the correction you want.",
    };
  }

  if (["active", "approved"].includes(status)) {
    return isItalian ? {
      outcome: status === "approved"
        ? "Il modo di lavorare per questa consegna è stato approvato."
        : "Il modo di lavorare per questa consegna è in vigore.",
      impact: "Il lavoro può procedere solo entro i limiti concordati per questa consegna.",
      decision: "Non devi riapprovare le attività ordinarie già comprese; approva separatamente ogni azione protetta.",
      protection: "Unione, rilascio, produzione, segreti, percorsi esterni e nuove consegne restano separati finché non sono approvati in modo esplicito.",
      nextAction: "Controlla risultati e prove; fermati se il lavoro supera i limiti concordati.",
    } : {
      outcome: status === "approved"
        ? "The way of working for this delivery was approved."
        : "The way of working for this delivery is in effect.",
      impact: "Work may proceed only within the limits agreed for this delivery.",
      decision: "You do not need to reapprove covered routine work; approve each protected action separately.",
      protection: "Merge, release, production, secrets, outside paths, and new deliveries remain separate until explicitly approved.",
      nextAction: "Review results and evidence; stop if the work exceeds the agreed limits.",
    };
  }

  if (status === "revoked") {
    return isItalian ? {
      outcome: "Il modo di lavorare per questa consegna è stato revocato e non può più essere usato.",
      impact: "Il lavoro deve fermarsi e non può proseguire sulla base dell’accordo revocato.",
      decision: "Decidi se chiudere la consegna o creare e approvare un nuovo accordo.",
      protection: "Nessuna attività ordinaria o protetta resta autorizzata da questo accordo.",
      nextAction: "Torna nella chat di Codex e indica in linguaggio naturale se vuoi chiudere la consegna oppure creare e approvare un nuovo accordo separato.",
    } : {
      outcome: "The way of working for this delivery was revoked and can no longer be used.",
      impact: "Work must stop and cannot continue under the revoked agreement.",
      decision: "Decide whether to close the delivery or create and approve a new agreement.",
      protection: "This agreement no longer authorizes routine or protected actions.",
      nextAction: "Return to the Codex chat and say in natural language whether to close the delivery or create and approve a separate new agreement.",
    };
  }

  if (["closed", "merged", "ready_for_review", "released", "rolled_back", "cancelled", "superseded", "expired"].includes(status)) {
    return isItalian ? {
      outcome: "L’accordo di questa consegna è chiuso e non può essere riutilizzato.",
      impact: "Nessun nuovo lavoro può iniziare o continuare sulla base di questo accordo.",
      decision: "Se serve altro lavoro, scegli e approva un nuovo accordo per una nuova consegna.",
      protection: "La chiusura impedisce di estendere automaticamente l’autorizzazione ad altre attività o consegne.",
      nextAction: "Torna nella chat di Codex e indica in linguaggio naturale se vuoi aprire una nuova consegna con un accordo separato; altrimenti non intraprendere altre azioni.",
    } : {
      outcome: "This delivery agreement is closed and cannot be reused.",
      impact: "No new work may start or continue under this agreement.",
      decision: "If more work is needed, choose and approve a new agreement for a new delivery.",
      protection: "Closure prevents authority from being carried automatically into other work or deliveries.",
      nextAction: "Return to the Codex chat and say in natural language whether to open a new delivery with a separate agreement; otherwise take no further action.",
    };
  }

  return isItalian ? {
    outcome: "Non è possibile confermare se l’accordo di questa consegna sia utilizzabile.",
    impact: "Il lavoro non deve iniziare o continuare finché lo stato non viene chiarito.",
    decision: "Verifica le prove registrate e stabilisci se serve un nuovo accordo.",
    protection: "Attività ordinarie e protette restano bloccate in assenza di uno stato valido.",
    nextAction: "Torna nella chat di Codex e descrivi in linguaggio naturale come correggere o sostituire l’accordo; dopo la registrazione, aggiorna questa vista.",
  } : {
    outcome: "It is not possible to confirm whether this delivery agreement can be used.",
    impact: "Work must not start or continue until the state is clarified.",
    decision: "Check the recorded evidence and decide whether a new agreement is needed.",
    protection: "Routine and protected actions remain blocked without a valid state.",
    nextAction: "Return to the Codex chat and describe in natural language how to correct or replace the agreement; after it is recorded, refresh this view.",
  };
}

function genericGuidanceBucket(status) {
  if (["proposed", "draft", "pending", "approval_required"].includes(status)) return "proposed";
  if (status === "missing" || status === "") return "status_missing";
  if ([
    "revoked", "closed", "cancelled", "superseded", "expired", "failed", "blocked", "denied",
    "rejected", "rolled_back", "malformed",
  ].includes(status)) return "inactive";
  return "recorded";
}

function genericRecordGuidance(status, isItalian) {
  const bucket = genericGuidanceBucket(status);
  const proposed = bucket === "proposed";
  const statusMissing = bucket === "status_missing";
  const inactive = bucket === "inactive";
  if (proposed) {
    return isItalian ? {
      outcome: "Questa voce del progetto è una proposta e non è ancora stata accettata.",
      impact: "Non deve essere considerata una decisione approvata o un lavoro completato.",
      decision: "Rivedi le prove e accetta la proposta oppure chiedi una correzione.",
      protection: "Questa vista è in sola lettura e non trasforma la proposta in un’approvazione.",
      nextAction: "Apri le prove collegate, poi torna nella chat di Codex e rispondi in linguaggio naturale per accettare la proposta oppure descrivere la correzione che vuoi.",
    } : {
      outcome: "This project item is a proposal and has not been accepted yet.",
      impact: "It must not be treated as an approved decision or completed work.",
      decision: "Review the evidence and accept the proposal or request a correction.",
      protection: "This view is read-only and does not turn the proposal into an approval.",
      nextAction: "Open the linked evidence, then return to the Codex chat and reply in natural language to accept the proposal or describe the correction you want.",
    };
  }
  if (statusMissing) {
    return isItalian ? {
      outcome: "È disponibile una risposta registrata, ma questa voce non dichiara uno stato corrente.",
      impact: "Puoi leggere la risposta, ma non usarla da sola come prova di approvazione o completamento.",
      decision: "Verifica la fonte collegata e lo stato corrente prima di prendere una decisione.",
      protection: "Questa vista resta in sola lettura e non deduce uno stato che non è stato registrato.",
      nextAction: "Apri i dettagli tecnici soltanto se devi verificare la fonte o trovare una registrazione più recente.",
    } : {
      outcome: "A recorded answer is available, but this item does not declare a current status.",
      impact: "You can read the answer, but cannot use it alone as proof of approval or completion.",
      decision: "Check the linked source and current state before making a decision.",
      protection: "This view remains read-only and does not infer a state that was not recorded.",
      nextAction: "Open technical details only if you need to verify the source or find a newer record.",
    };
  }
  if (inactive) {
    return isItalian ? {
      outcome: "Questa voce non è utilizzabile come stato corrente del progetto.",
      impact: "Non fare affidamento su questa voce per iniziare, proseguire, approvare o rilasciare lavoro.",
      decision: "Decidi se serve una registrazione sostitutiva o un’attività correttiva.",
      protection: "Questa vista resta in sola lettura e non riattiva né corregge automaticamente la voce.",
      nextAction: "Apri le prove tecniche e individua la registrazione corrente prima di proseguire.",
    } : {
      outcome: "This project item cannot be used as the project’s current state.",
      impact: "Do not rely on this item to start, continue, approve, or release work.",
      decision: "Decide whether a replacement record or corrective action is needed.",
      protection: "This view remains read-only and does not reactivate or repair the item automatically.",
      nextAction: "Open the technical evidence and find the current record before proceeding.",
    };
  }
  return isItalian ? {
    outcome: "Questa voce è disponibile come informazione registrata sul progetto.",
    impact: "Mostra lo stato registrato, ma da sola non autorizza il passo successivo.",
    decision: "Usa le prove collegate per decidere se il passo successivo è giustificato.",
    protection: "Questa vista è in sola lettura, non inventa dati mancanti e non modifica il progetto.",
    nextAction: "Esamina le prove e continua soltanto attraverso le approvazioni previste.",
  } : {
    outcome: "This project item is available as recorded project information.",
    impact: "It shows the recorded state, but does not by itself authorize the next step.",
    decision: "Use the linked evidence to decide whether the next step is justified.",
    protection: "This view is read-only, does not invent missing facts, and does not change the project.",
    nextAction: "Review the evidence and continue only through the required approvals.",
  };
}

// Guidance for ordinary records depends only on the kind of recorded state,
// so list views explain each kind once per view. Autonomy records carry
// guidance specific to their delivery and return null here.
export const RECORD_GUIDANCE_BUCKETS = Object.freeze([
  "recorded",
  "proposed",
  "status_missing",
  "inactive",
]);

const BUCKET_REPRESENTATIVE_STATUS = Object.freeze({
  recorded: "recorded",
  proposed: "proposed",
  status_missing: "missing",
  inactive: "revoked",
});

export function recordGuidanceBucket(item) {
  if (!item || AUTONOMY_TYPES.has(item.type)) return null;
  return genericGuidanceBucket(normalizedStatus(item));
}

export function sharedRecordGuidance(bucket = "recorded") {
  const status = BUCKET_REPRESENTATIVE_STATUS[bucket] ?? "recorded";
  return Object.freeze(genericRecordGuidance(status, activeLocale === "it"));
}

export function humanGuidanceForItem(item) {
  if (!item) return null;
  const isItalian = activeLocale === "it";
  const status = normalizedStatus(item);
  if (item.type === "requirement-execution-profile") {
    return Object.freeze(requirementGuidance(status, isItalian));
  }
  if (item.type === "delivery-execution-profile") {
    return Object.freeze(deliveryGuidance(status, isItalian));
  }
  if (item.type !== "autonomy-decision") {
    return Object.freeze(genericRecordGuidance(status, isItalian));
  }
  const decisionMayProceed = ["ready", "active", "approved"].includes(status);
  return Object.freeze({
    outcome: decisionMayProceed
      ? (isItalian ? "Il lavoro può continuare entro i limiti concordati." : "Work may continue within the agreed limits.")
      : (isItalian ? "Il lavoro è arrivato a un punto che richiede una verifica." : "Work reached a point that needs review."),
    impact: decisionMayProceed
      ? (isItalian ? "Le attività ordinarie comprese nell’accordo possono proseguire." : "Routine work covered by the agreement may proceed.")
      : (isItalian ? "L’azione protetta successiva non verrà eseguita automaticamente." : "The next protected action will not run automatically."),
    decision: decisionMayProceed
      ? (isItalian ? "Non è richiesta una decisione adesso." : "No decision is required now.")
      : (isItalian ? "Verifica le prove e conferma se vuoi proseguire." : "Review the evidence and confirm whether you want to continue."),
    protection: isItalian ? "Unione, rilascio, produzione, segreti e attività fuori dai limiti concordati restano bloccati senza un’approvazione specifica." : "Merge, release, production, secrets, and work outside the agreed limits remain blocked without specific approval.",
    nextAction: decisionMayProceed
      ? (isItalian ? "Continua a monitorare i risultati; apri i dettagli solo se ti servono." : "Keep reviewing outcomes; open details only when needed.")
      : (isItalian ? "Apri le prove tecniche, poi torna nella chat di Codex e rispondi in linguaggio naturale per approvare il piano oppure descrivere la correzione che vuoi." : "Open the technical evidence, then return to the Codex chat and reply in natural language to approve the plan or describe the correction you want."),
  });
}

export function humanGuidanceTextForItem(item, locale = activeLocale) {
  const previous = activeLocale;
  setLocale(locale);
  const guidance = humanGuidanceForItem(item);
  const display = displayTextForItem(item);
  const lines = guidance ? [
    `${t("Outcome")}: ${guidance.outcome}`,
    `${t("Impact")}: ${guidance.impact}`,
    `${t("Decision")}: ${guidance.decision}`,
    `${t("Protection")}: ${guidance.protection}`,
    `${t("Next action")}: ${guidance.nextAction}`,
    "",
    `${t("Technical details (optional)")}:`,
    `- type: ${item?.type ?? "record"}`,
    `- id: ${item?.id ?? "not-recorded"}`,
    `- status: ${item?.status ?? "not-recorded"}`,
    `- recorded title: ${item?.title ?? display.title ?? "not-recorded"}`,
    `- recorded summary: ${item?.summary ?? display.summary ?? "not-recorded"}`,
  ] : [];
  setLocale(previous);
  return lines.join("\n");
}

export function localizedErrorGuidance(error) {
  const isItalian = activeLocale === "it";
  const fallback = isItalian ? "Errore non specificato" : "Unspecified error";
  const message = boundedTechnicalErrorProperty(error, "message", null, fallback);
  const code = boundedTechnicalErrorProperty(error, "code", TECHNICAL_ERROR_CODE_PATTERN);
  const correlationId = boundedTechnicalErrorProperty(
    error,
    "correlationId",
    TECHNICAL_CORRELATION_ID_PATTERN,
  )?.toLowerCase();
  const technical = [
    `${isItalian ? "Errore" : "Error"}: ${message}`,
    ...(code ? [`${isItalian ? "Codice" : "Code"}: ${code}`] : []),
    ...(correlationId
      ? [`${isItalian ? "ID correlazione" : "Correlation ID"}: ${correlationId}`]
      : []),
  ].join(" · ");
  return Object.freeze({
    outcome: isItalian ? "La storia del progetto non è disponibile." : "The project history is unavailable.",
    impact: isItalian ? "Questa pagina non può mostrare richieste, decisioni o prove finché il collegamento non viene ripristinato." : "This page cannot show requests, decisions, or evidence until the connection is restored.",
    decision: isItalian ? "Non approvare nulla basandoti su questa vista incompleta." : "Do not approve anything based on this incomplete view.",
    protection: isItalian ? "La vista resta in sola lettura e non modifica alcun file." : "The view remains read-only and does not change any files.",
    nextAction: isItalian ? "Aggiorna la pagina; se il problema continua, apri i dettagli tecnici." : "Refresh the page; if the problem continues, open technical details.",
    technical,
  });
}

function boundedTechnicalErrorProperty(error, property, pattern = null, fallback = null) {
  let value;
  try {
    value = error?.[property];
  } catch {
    return fallback;
  }
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_TECHNICAL_ERROR_CHARACTERS
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)
    || (property === "message"
      && UNSAFE_TECHNICAL_ERROR_PATTERNS.some((candidate) => candidate.test(normalized)))
    || (pattern && !pattern.test(normalized))
  ) {
    return fallback;
  }
  return normalized;
}
