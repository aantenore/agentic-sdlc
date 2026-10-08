import { findForbiddenHumanGuidanceTerms } from "../human-guidance.mjs";

export const CAPABILITY_SUGGESTION_SCHEMA_VERSION = "capability-suggestion:v1";

const TYPE_LABELS = Object.freeze({
  en: Object.freeze({ skill: "skill", plugin: "plugin", mcp: "tool server" }),
  it: Object.freeze({ skill: "skill", plugin: "plugin", mcp: "server di strumenti" }),
});
const SHOWN_IN_MESSAGE = 3;

function label(type, italian) {
  return (italian ? TYPE_LABELS.it : TYPE_LABELS.en)[type] ?? type;
}

// A name supplied by an installed tool must not push internal terminology into
// the plain-language part of a message; such names stay in the details.
function plainName(name) {
  return findForbiddenHumanGuidanceTerms(name).length === 0;
}

function messageFor({ matches, totalMatches, basis }, italian) {
  const safe = matches.filter((match) => plainName(match.name));
  const shown = safe.slice(0, SHOWN_IN_MESSAGE);
  const list = shown.map((match) => `${match.name} (${label(match.type, italian)})`).join(", ");
  const remaining = totalMatches - shown.length;
  const more = remaining > 0
    ? (italian ? ` e altri ${remaining}` : ` and ${remaining} more`)
    : "";
  const subject = shown.length > 0
    ? `${list}${more}`
    : (italian ? `${totalMatches} strumenti installati` : `${totalMatches} installed tools`);
  if (italian) {
    return basis === "approved_profile"
      ? `Strumenti già installati che sembrano utili per questo lavoro: ${subject}. Per ora non viene usato né approvato nulla; se vuoi che vengano considerati, chiedimi di proporli alla tua revisione.`
      : `Strumenti già installati che sembrano utili per questo lavoro: ${subject}. Per ora non viene usato né approvato nulla; prima vanno riviste le evidenze e i limiti del progetto, e se vuoi che questi strumenti vengano considerati chiedimi di partire da lì.`;
  }
  return basis === "approved_profile"
    ? `Installed tools that look relevant to this work: ${subject}. Nothing is used or approved yet; if you want them considered, ask me to put them forward for your review.`
    : `Installed tools that look relevant to this work: ${subject}. Nothing is used or approved yet; the project evidence and boundaries need your review first, and if you want these tools considered, ask me to start there.`;
}

/**
 * The record that a task start or status report carries when installed
 * capabilities match the declared technology and no recommendation has been
 * approved yet. It only describes and points at a command: nothing is applied,
 * bound, or approved by it.
 */
export function buildCapabilitySuggestionRecord({
  storyId,
  phase = null,
  basis,
  profileId = null,
  tags = [],
  matches = [],
  totalMatches = matches.length,
  commands = [],
  locale = "en",
}) {
  const italian = locale === "it";
  return {
    schema_version: CAPABILITY_SUGGESTION_SCHEMA_VERSION,
    status: "available",
    story_id: storyId,
    phase,
    basis,
    profile_id: profileId,
    tags,
    total_matches: totalMatches,
    matches: matches.map((match) => ({
      type: match.type,
      name: match.name,
      description: match.description ?? null,
      source: match.source,
      path: match.path,
      matched_tags: match.matched_tags,
    })),
    message: messageFor({ matches, totalMatches, basis }, italian),
    command: commands[0] ?? null,
    commands,
    applies_automatically: false,
  };
}

/** The plain-language sentence for the primary part of a human message. */
export function capabilitySuggestionPrimaryLines(suggestion) {
  return suggestion?.message ? [suggestion.message] : [];
}

/** Technical detail lines: what matched, where it lives, and the command to record it. */
export function capabilitySuggestionDetailLines(suggestion, italian = false) {
  if (!suggestion) return [];
  const lines = [
    italian
      ? `Suggerimento strumenti installati (tecnologie dichiarate: ${suggestion.tags.join(", ") || "-"}; base: ${suggestion.basis}):`
      : `Installed-tool suggestion (declared technology: ${suggestion.tags.join(", ") || "-"}; basis: ${suggestion.basis}):`,
    ...suggestion.matches.map((match) => {
      const description = match.description ? ` - ${match.description}` : "";
      return `${match.type} ${match.name} [${match.source}] ${match.path}${description} (${italian ? "corrisponde a" : "matches"}: ${match.matched_tags.join(", ")})`;
    }),
  ];
  if (suggestion.total_matches > suggestion.matches.length) {
    lines.push(italian
      ? `... altre ${suggestion.total_matches - suggestion.matches.length} corrispondenze; esegui capability inventory per l’elenco completo`
      : `... ${suggestion.total_matches - suggestion.matches.length} more matches; run capability inventory for the whole list`);
  }
  for (const command of suggestion.commands) {
    lines.push(`${italian ? "Comando per registrare la proposta" : "Command to record the proposal"}: ${command}`);
  }
  return lines;
}
