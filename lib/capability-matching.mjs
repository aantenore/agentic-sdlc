/**
 * Deterministic matching of an installed-capability inventory against the
 * technology tags a project declares (the detected stack and integrations of
 * a capability profile). No free text from a request is ever consulted: a
 * capability is relevant only when its own name or description names one of
 * the declared technologies as a whole word or phrase.
 */

const TYPE_ORDER = Object.freeze({ skill: 0, plugin: 1, mcp: 2 });

// Lower-case, replace every run of non-alphanumeric characters with a single
// space, and pad both ends so a phrase can be found with its neighbours.
function paddedWords(value) {
  const words = String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return words ? ` ${words} ` : " ";
}

function plainWords(value) {
  return paddedWords(value).trim();
}

function declaredTexts(entries, fields) {
  const texts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry === "string") {
      texts.push(entry);
    } else if (entry && typeof entry === "object") {
      for (const field of fields) {
        if (typeof entry[field] === "string") texts.push(entry[field]);
      }
    }
  }
  return texts;
}

/**
 * Turn declared stack and integration entries into match tags.
 *
 * Each name is split into words; generic words (`ignored_tags`) and words
 * shorter than `min_tag_length` are dropped, ambiguous words
 * (`ambiguous_tags`, such as a language called "go") match only through their
 * `aliases`, and every kept word may add alias phrases. The result is sorted
 * and free of duplicates.
 */
export function deriveCapabilityTags({ detectedStack = [], integrations = [] } = {}, matching = {}) {
  const ignored = new Set((matching.ignored_tags ?? []).map((tag) => tag.toLowerCase()));
  const ambiguous = new Set((matching.ambiguous_tags ?? []).map((tag) => tag.toLowerCase()));
  const aliases = matching.aliases ?? {};
  const minimum = matching.min_tag_length ?? 3;
  const raw = [
    ...declaredTexts(detectedStack, ["name", "type"]),
    ...declaredTexts(integrations, ["name", "id", "type"]),
  ];
  const tags = new Map();
  for (const text of raw) {
    for (const word of plainWords(text).split(" ").filter(Boolean)) {
      if (ignored.has(word)) continue;
      const phrases = new Set();
      if (!ambiguous.has(word) && word.length >= minimum) phrases.add(word);
      for (const alias of aliases[word] ?? []) {
        const normalized = plainWords(alias);
        if (normalized) phrases.add(normalized);
      }
      if (phrases.size === 0) continue;
      const known = tags.get(word) ?? new Set();
      for (const phrase of phrases) known.add(phrase);
      tags.set(word, known);
    }
  }
  return [...tags.keys()].sort().map((tag) => ({ tag, phrases: [...tags.get(tag)].sort() }));
}

function isExcluded(entry, excludedNames) {
  return excludedNames.some((excluded) => (
    entry.name === excluded
    || entry.name.startsWith(`${excluded}-`)
    || entry.plugin === excluded
  ));
}

function candidateEntries(inventory) {
  return [
    ...(inventory?.skills ?? []),
    ...(inventory?.plugins ?? []),
    ...(inventory?.mcp ?? []).filter((server) => server.enabled !== false),
  ];
}

/**
 * Rank the installed capabilities that name at least one declared technology.
 *
 * The score counts a tag found in the capability's name twice and in its
 * description once; a phase tag found in the text adds one. Phase tags never
 * make a capability relevant on their own. Ties break by type (skill, plugin,
 * MCP server) and then by name, so the result is stable.
 */
export function matchInventoryCapabilities(inventory, tags, { phase = null, matching = {} } = {}) {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  const excluded = matching.exclude_names ?? [];
  const phaseWords = (phase && matching.phase_tags?.[phase]) || [];
  const matches = [];
  const seen = new Set();
  for (const entry of candidateEntries(inventory)) {
    if (isExcluded(entry, excluded)) continue;
    // The same name found in several places counts once: the first (project)
    // entry wins, as the inventory lists project locations before user ones.
    const key = `${entry.type}:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const nameText = paddedWords(`${entry.name} ${entry.plugin ?? ""}`);
    const descriptionText = paddedWords(entry.description ?? "");
    const matchedTags = [];
    let score = 0;
    for (const { tag, phrases } of tags) {
      const inName = phrases.some((phrase) => nameText.includes(` ${phrase} `));
      const inDescription = phrases.some((phrase) => descriptionText.includes(` ${phrase} `));
      if (inName || inDescription) {
        matchedTags.push(tag);
        score += (inName ? 2 : 0) + (inDescription ? 1 : 0);
      }
    }
    if (matchedTags.length === 0) continue;
    const matchedPhaseTags = phaseWords.filter((word) => {
      const phrase = ` ${plainWords(word)} `;
      return nameText.includes(phrase) || descriptionText.includes(phrase);
    });
    score += matchedPhaseTags.length;
    matches.push({
      type: entry.type,
      name: entry.name,
      description: entry.description ?? null,
      scope: entry.scope,
      source: entry.source,
      plugin: entry.plugin ?? null,
      transport: entry.transport ?? null,
      path: entry.path,
      matched_tags: matchedTags,
      matched_phase_tags: matchedPhaseTags,
      score,
    });
  }
  return matches.sort((left, right) => (
    right.score - left.score
    || (TYPE_ORDER[left.type] ?? 9) - (TYPE_ORDER[right.type] ?? 9)
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    || (left.source < right.source ? -1 : left.source > right.source ? 1 : 0)
  ));
}

/**
 * Express an inventory in the shape `capability recommend` already accepts as
 * available capabilities. Every installed capability is declared; only those
 * named in `recommend` (a set of `type:name` keys) are left eligible, with
 * their description, the rest carry just a name and `recommended: false`, so
 * they are recorded as available but never proposed. A name found in several
 * places keeps its first (project) entry, and disabled MCP servers are left
 * out.
 */
export function inventoryToAvailableCapabilities(inventory, { recommend = new Set(), matches = [] } = {}) {
  const matchByKey = new Map(matches.map((match) => [`${match.type}:${match.name}`, match]));
  const groups = { skills: [], plugins: [], mcp: [] };
  const seen = new Set();
  const add = (group, entry) => {
    const key = `${entry.type}:${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const match = matchByKey.get(key);
    const declared = { name: entry.name, source: entry.source };
    if (recommend.has(key)) {
      declared.path = entry.path;
      if (entry.description) declared.description = entry.description;
      if (entry.transport) declared.transport = entry.transport;
      declared.rationale = `Installed (${entry.source}); its name or description mentions the declared technology: ${match?.matched_tags?.join(", ") || "match"}.`;
    } else {
      declared.recommended = false;
    }
    groups[group].push(declared);
  };
  for (const entry of inventory?.skills ?? []) add("skills", entry);
  for (const entry of inventory?.plugins ?? []) add("plugins", entry);
  for (const entry of (inventory?.mcp ?? []).filter((server) => server.enabled !== false)) add("mcp", entry);
  return Object.fromEntries(Object.entries(groups).filter(([, list]) => list.length > 0));
}
