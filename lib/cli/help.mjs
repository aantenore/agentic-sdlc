import {
  COMMAND_CATALOG,
  findCommand,
  listOptions,
  localized,
  normalizeLocale,
  suggestCommand,
} from "./command-catalog.mjs";

const LABELS = Object.freeze({
  en: Object.freeze({
    result: "Outcome",
    impact: "What this changes in practice",
    decision: "What you need to decide",
    protection: "What remains protected",
    next: "Next step",
    usage: "Usage",
    commands: "Commands",
    options: "Options",
    examples: "Examples",
    details: "Technical details (optional)",
    none: "You do not need to decide anything to read this help; choose an action only when you are ready.",
    readImpact: "You can inspect this information without changing the project.",
    planImpact: "You can prepare and review the result before any material change.",
    localImpact: "This action can update the selected local project records.",
    mixedImpact: "Some of these actions change local project records; reading this help changes nothing.",
    protectedImpact: "This action records a decision for one exact target; any execution remains separately controlled.",
    localDecision: "Check the selected project and inputs before running it.",
    protectedDecision: "Approve the exact displayed target and limits before recording the decision.",
    rootImpact: "Normal use is conversational. This CLI is for structured recovery and automation, so it expects exact record IDs and prepared intent JSON.",
    rootDecision: "Describe the outcome you want in ordinary language; your coding agent should guide the decisions that actually need you.",
    rootNext: "Usual order: requirement -> story -> work brief/output -> autonomy -> story workflow start -> one task start -> story claim -> complete each phase and advance -> validation gate -> enter release -> delivery/release evidence -> final lifecycle gate.",
    groupNext: "Choose one action below, then read its focused help before acting.",
    leafNext: "Review the optional usage details below, then provide only the exact inputs you intend to use.",
    rootProtection: "Help reads this built-in catalog only. It does not open a project or change local or remote state.",
    unknown: "I could not find the requested action.",
    unknownImpact: "No project was opened or changed.",
    unknownDecision: "Choose whether to correct the wording or return to the main help.",
    unknownProtection: "Local files, remote repositories, releases, and production remain unchanged.",
    unknownNext: "Check the spelling or open the main help to choose an available action.",
    optionValue: "value",
  }),
  it: Object.freeze({
    result: "Risultato",
    impact: "Cosa cambia in pratica",
    decision: "Cosa devi decidere",
    protection: "Cosa resta protetto",
    next: "Prossimo passo",
    usage: "Utilizzo",
    commands: "Comandi",
    options: "Opzioni",
    examples: "Esempi",
    details: "Dettagli tecnici (facoltativi)",
    none: "Non devi decidere nulla per leggere questo aiuto; scegli un’azione solo quando sei pronto.",
    readImpact: "Puoi consultare queste informazioni senza modificare il progetto.",
    planImpact: "Puoi preparare e revisionare il risultato prima di qualsiasi modifica materiale.",
    localImpact: "Questa azione può aggiornare i record del progetto locale selezionato.",
    mixedImpact: "Alcune di queste azioni modificano i record locali del progetto; leggere questo aiuto non modifica nulla.",
    protectedImpact: "Questa azione registra una decisione per una destinazione esatta; l’eventuale esecuzione resta controllata separatamente.",
    localDecision: "Controlla il progetto selezionato e gli input prima di eseguirlo.",
    protectedDecision: "Approva la destinazione esatta e i relativi limiti prima di registrare la decisione.",
    rootImpact: "L’uso normale è conversazionale. Questa CLI serve per recupero strutturato e automazione, quindi richiede ID esatti e un intento JSON già preparato.",
    rootDecision: "Descrivi in linguaggio naturale il risultato che vuoi; il tuo agente di sviluppo deve guidarti soltanto nelle decisioni che richiedono davvero il tuo intervento.",
    rootNext: "Ordine abituale: requisito -> story -> accordo di lavoro/output -> autonomia -> avvio workflow della story -> un solo avvio attività -> assegnazione della story -> completa e avanza ogni fase -> gate di validazione -> ingresso in release -> consegna/prove di release -> gate lifecycle finale.",
    groupNext: "Scegli una delle azioni seguenti e leggi il relativo aiuto prima di agire.",
    leafNext: "Controlla i dettagli facoltativi di utilizzo qui sotto, poi fornisci soltanto gli input esatti che vuoi usare.",
    rootProtection: "L’aiuto legge soltanto questo catalogo incluso. Non apre un progetto e non modifica lo stato locale o remoto.",
    unknown: "Non ho trovato l’azione richiesta.",
    unknownImpact: "Nessun progetto è stato aperto o modificato.",
    unknownDecision: "Scegli se correggere la formulazione oppure tornare all’aiuto principale.",
    unknownProtection: "File locali, repository remoti, rilasci e produzione restano invariati.",
    unknownNext: "Controlla la scrittura oppure apri l’aiuto principale per scegliere un’azione disponibile.",
    optionValue: "valore",
  }),
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2);
}

function normalizeHelpPath(pathTokens) {
  const tokens = Array.isArray(pathTokens)
    ? pathTokens.map(String)
    : String(pathTokens ?? "").trim().split(/\s+/u).filter(Boolean);
  if (tokens[0] === "agentic-sdlc") tokens.shift();
  if (tokens[0] === "help") tokens.shift();
  return tokens;
}

export class UnknownCommandError extends Error {
  constructor(path, suggestions, locale) {
    const labels = LABELS[locale];
    const technicalLines = [
      `- unknown_path: ${path}`,
      ...(suggestions.length > 0 ? [`- suggestions: ${suggestions.join(", ")}`] : []),
    ];
    super([
      `${labels.result}: ${labels.unknown}`,
      `${labels.impact}: ${labels.unknownImpact}`,
      `${labels.decision}: ${labels.unknownDecision}`,
      `${labels.protection}: ${labels.unknownProtection}`,
      `${labels.next}: ${labels.unknownNext}`,
      "",
      `${labels.details}:`,
      ...technicalLines,
    ].join("\n"));
    this.name = "UnknownCommandError";
    this.code = "UNKNOWN_COMMAND";
    this.path = path;
    this.suggestions = suggestions;
  }
}

function effectGuidance(node, labels) {
  switch (node.effect) {
    case "plan":
      return { impact: labels.planImpact, decision: labels.none };
    case "local":
      return { impact: labels.localImpact, decision: labels.localDecision };
    case "protected":
      return { impact: labels.protectedImpact, decision: labels.protectedDecision };
    case "mixed":
      return { impact: labels.mixedImpact, decision: labels.none };
    default:
      return { impact: labels.readImpact, decision: labels.none };
  }
}

function usageFor(node) {
  if (node.kind === "root") return "agentic-sdlc help [command ...]";
  const suffix = node.usage ?? node.path_text;
  return `agentic-sdlc ${suffix}`.trim();
}

export function buildHelpModel(pathTokens = [], { locale = "en", version = null } = {}) {
  const normalizedLocale = normalizeLocale(locale);
  const labels = LABELS[normalizedLocale];
  const path = normalizeHelpPath(pathTokens);
  const node = findCommand(path);
  if (!node) {
    const pathText = path.join(" ");
    throw new UnknownCommandError(pathText, suggestCommand(pathText), normalizedLocale);
  }

  const effect = effectGuidance(node, labels);
  const root = node === COMMAND_CATALOG;
  const group = node.kind === "group" || (node.children.length > 0 && node.kind !== "root");
  const nextAction = root ? labels.rootNext : group ? labels.groupNext : labels.leafNext;
  const impact = root ? labels.rootImpact : effect.impact;
  const decision = root ? labels.rootDecision : effect.decision;
  const options = listOptions(node.path).map((descriptor) => ({
    name: descriptor.name,
    flag: descriptor.flag,
    value: descriptor.value,
    repeatable: descriptor.repeatable === true,
    required: descriptor.required === true,
    required_when: descriptor.required_when
      ? localized(descriptor.required_when, normalizedLocale)
      : null,
    required_one_of: descriptor.required_one_of
      ? localized(descriptor.required_one_of, normalizedLocale)
      : null,
    description: localized(descriptor.description, normalizedLocale),
  }));
  const commands = node.children.map((child) => ({
    path: child.path_text,
    name: child.name,
    kind: child.kind,
    description: localized(child.description, normalizedLocale),
  }));

  return deepFreeze({
    schema_version: "agentic-sdlc-help-v1",
    locale: normalizedLocale,
    version: version === null ? null : String(version),
    command: {
      path: node.path_text,
      kind: node.kind,
      aliases: [...(node.aliases ?? [])],
    },
    human: {
      result: localized(node.description, normalizedLocale),
      impact,
      decision,
      protection: root ? labels.rootProtection : localized(node.protection, normalizedLocale),
      next_action: nextAction,
    },
    usage: usageFor(node),
    commands,
    options,
    examples: [...(node.examples ?? [])].map((example) => `agentic-sdlc ${example}`),
    technical_details: {
      catalog_path: node.path_text || "<root>",
      effect: node.effect,
    },
  });
}

// "required with --flag" reads naturally for an option condition; any other
// condition is a clause and needs "when".
function requiredWhenLabel(condition, locale) {
  const optionCondition = /^--[a-z0-9-]+(?: [A-Za-z0-9_.-]+)?(?: and --[a-z0-9-]+(?: [A-Za-z0-9_.-]+)?)*$/u
    .test(String(condition));
  if (locale === "it") {
    return optionCondition ? ` (obbligatoria con ${condition})` : ` (obbligatoria quando ${condition})`;
  }
  return optionCondition ? ` (required with ${condition})` : ` (required when ${condition})`;
}

function optionLine(option, locale) {
  const labels = LABELS[locale];
  const value = option.value ? ` <${option.value || labels.optionValue}>` : "";
  const repeatable = option.repeatable ? (locale === "it" ? " (ripetibile)" : " (repeatable)") : "";
  const required = option.required ? (locale === "it" ? " (obbligatoria)" : " (required)") : "";
  const requiredWhen = option.required_when
    ? requiredWhenLabel(option.required_when, locale)
    : "";
  const requiredOneOf = option.required_one_of
    ? (locale === "it" ? ` (serve ${option.required_one_of})` : ` (requires ${option.required_one_of})`)
    : "";
  return `  ${option.flag}${value}${required}${requiredWhen}${requiredOneOf}${repeatable}\n      ${option.description}`;
}

export function renderHelp(pathTokens = [], { locale = "en", json = false, version = null } = {}) {
  const model = buildHelpModel(pathTokens, { locale, version });
  if (json === true) return stableStringify(model);
  const labels = LABELS[model.locale];
  const lines = [
    `${labels.result}: ${model.human.result}`,
    `${labels.impact}: ${model.human.impact}`,
    `${labels.decision}: ${model.human.decision}`,
    `${labels.protection}: ${model.human.protection}`,
    `${labels.next}: ${model.human.next_action}`,
    "",
    `${labels.details}:`,
    `${labels.usage}:`,
    `  ${model.usage}`,
  ];

  if (model.commands.length > 0) {
    lines.push("", `${labels.commands}:`);
    for (const child of model.commands) lines.push(`  ${child.path.padEnd(34)} ${child.description}`);
  }
  if (model.options.length > 0) {
    lines.push("", `${labels.options}:`);
    for (const descriptor of model.options) lines.push(optionLine(descriptor, model.locale));
  }
  if (model.examples.length > 0) {
    lines.push("", `${labels.examples}:`);
    for (const example of model.examples) lines.push(`  ${example}`);
  }

  lines.push("", "- product: Agentic SDLC", `- catalog_path: ${model.technical_details.catalog_path}`, `- effect: ${model.technical_details.effect}`);
  if (model.version) lines.push(`- version: ${model.version}`);
  return lines.join("\n");
}
