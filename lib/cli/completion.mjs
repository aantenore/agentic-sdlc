import { crypto } from "../runtime/host.mjs";
import { COMMAND_CATALOG, findCommand, listOptions } from "./command-catalog.mjs";

const { createHash } = crypto;

export const SUPPORTED_SHELLS = Object.freeze(["bash", "zsh", "fish", "powershell"]);

function normalizeShell(shell) {
  const normalized = String(shell ?? "").trim().toLowerCase();
  if (["pwsh", "powershell-core", "power-shell"].includes(normalized)) return "powershell";
  if (!SUPPORTED_SHELLS.includes(normalized)) {
    throw new TypeError(`Unsupported shell '${shell}'. Use ${SUPPORTED_SHELLS.join(", ")}.`);
  }
  return normalized;
}

function validateBinary(binary) {
  const normalized = String(binary ?? "agentic-sdlc").trim();
  if (!/^[a-zA-Z0-9._-]+$/u.test(normalized)) {
    throw new TypeError("Completion binary must contain only letters, numbers, dot, underscore, or hyphen");
  }
  return normalized;
}

function sorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function catalogNodes() {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(COMMAND_CATALOG);
  return nodes.sort((left, right) => left.path_text.localeCompare(right.path_text, "en"));
}

const NODES = catalogNodes();

function allOptionDescriptors() {
  const byFlag = new Map();
  for (const node of NODES) {
    for (const descriptor of listOptions(node.path)) {
      byFlag.set(descriptor.flag, descriptor);
      for (const alias of descriptor.aliases ?? []) byFlag.set(alias, descriptor);
    }
  }
  return byFlag;
}

const OPTIONS_BY_FLAG = allOptionDescriptors();

function candidatesForNode(node) {
  return sorted([
    ...node.children.map((child) => child.name),
    ...(node.positionals ?? []),
    ...listOptions(node.path).flatMap((descriptor) => [descriptor.flag, ...(descriptor.aliases ?? [])]),
  ]);
}

function optionValues(descriptor) {
  return sorted(descriptor?.values ?? []);
}

function optionForNode(node, flag) {
  return listOptions(node.path).find((descriptor) =>
    descriptor.flag === flag || (descriptor.aliases ?? []).includes(flag)) ?? null;
}

function normalizeTokens(tokens) {
  if (!Array.isArray(tokens)) throw new TypeError("Completion tokens must be an array");
  const normalized = tokens.map((token) => String(token));
  if (normalized[0] === "agentic-sdlc") normalized.shift();
  return normalized;
}

function resolveCompletionContext(tokens) {
  let node = COMMAND_CATALOG;
  let expecting = null;
  for (const token of normalizeTokens(tokens)) {
    if (expecting) {
      expecting = null;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) continue;
    const option = optionForNode(node, token) ?? OPTIONS_BY_FLAG.get(token);
    if (option) {
      if (option.boolean !== true) expecting = option;
      continue;
    }
    const child = node.children.find((candidate) => candidate.name === token);
    if (child) node = child;
  }
  return { node, expecting };
}

export function completionCandidates(tokens = [], { current = "" } = {}) {
  const normalizedCurrent = String(current);
  const assignment = /^(--[a-z0-9-]+)=(.*)$/iu.exec(normalizedCurrent);
  if (assignment) {
    const { node } = resolveCompletionContext(tokens);
    const descriptor = optionForNode(node, assignment[1]);
    return Object.freeze(optionValues(descriptor)
      .map((value) => `${assignment[1]}=${value}`)
      .filter((value) => value.startsWith(normalizedCurrent)));
  }
  const { node, expecting } = resolveCompletionContext(tokens);
  const candidates = expecting ? optionValues(expecting) : candidatesForNode(node);
  return Object.freeze(candidates.filter((candidate) => candidate.startsWith(normalizedCurrent)));
}

function quoteSingle(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function functionName(binary) {
  return `_${binary.replaceAll(/[^a-zA-Z0-9_]/gu, "_")}_completion`;
}

function completionTables() {
  const contexts = NODES.map((node) => ({
    path: node.path_text,
    candidates: candidatesForNode(node),
  }));
  const transitions = NODES
    .filter((node) => node.path.length > 0)
    .map((node) => ({
      from: node.path.slice(0, -1).join(" "),
      token: node.name,
      to: node.path_text,
    }));
  const descriptors = [...new Set(OPTIONS_BY_FLAG.values())];
  const booleanFlags = sorted(descriptors
    .filter((descriptor) => descriptor.boolean === true)
    .flatMap((descriptor) => [descriptor.flag, ...(descriptor.aliases ?? [])]));
  const valueFlags = sorted(descriptors
    .filter((descriptor) => descriptor.boolean !== true)
    .flatMap((descriptor) => [descriptor.flag, ...(descriptor.aliases ?? [])]));
  const values = NODES.flatMap((node) => listOptions(node.path)
    .filter((descriptor) => optionValues(descriptor).length > 0)
    .map((descriptor) => ({
      path: node.path_text,
      flags: sorted([descriptor.flag, ...(descriptor.aliases ?? [])]),
      values: optionValues(descriptor),
    })))
    .sort((left, right) => left.path.localeCompare(right.path, "en") || left.flags[0].localeCompare(right.flags[0], "en"));
  return { contexts, transitions, booleanFlags, valueFlags, values };
}

function shellCaseAlternatives(values) {
  return values.map(quoteSingle).join("|");
}

function bashScript(binary, tables) {
  const name = functionName(binary);
  const transitions = tables.transitions
    .map((entry) => `      ${quoteSingle(`${entry.from}|${entry.token}`)}) context=${quoteSingle(entry.to)} ;;`)
    .join("\n");
  const contexts = tables.contexts
    .map((entry) => `      ${quoteSingle(entry.path)}) candidates=(${entry.candidates.map(quoteSingle).join(" ")}) ;;`)
    .join("\n");
  const values = tables.values
    .map((entry) => `      ${shellCaseAlternatives(entry.flags.map((flag) => `${entry.path}|${flag}`))}) candidates=(${entry.values.map(quoteSingle).join(" ")}) ;;`)
    .join("\n");
  return `# Generated by ${binary}; static, hierarchical, and deterministic.
${name}() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local context='' expecting='' token candidate
  local index
  local -a candidates=()
  for ((index = 1; index < COMP_CWORD; index++)); do
    token="\${COMP_WORDS[index]}"
    if [[ -n "$expecting" ]]; then
      expecting=''
      continue
    fi
    if [[ "$token" == --*=* ]]; then
      continue
    fi
    case "$token" in
      ${shellCaseAlternatives(tables.booleanFlags)}) continue ;;
      ${shellCaseAlternatives(tables.valueFlags)}) expecting="$token"; continue ;;
    esac
    case "$context|$token" in
${transitions}
    esac
  done
  if [[ -n "$expecting" ]]; then
    case "$context|$expecting" in
${values}
    esac
  else
    case "$context" in
${contexts}
    esac
  fi
  COMPREPLY=()
  for candidate in "\${candidates[@]}"; do
    if [[ "$candidate" == "$current"* ]]; then
      COMPREPLY+=("$candidate")
    fi
  done
}
complete -F ${name} ${binary}
`;
}

function zshScript(binary, tables) {
  const name = functionName(binary);
  const transitions = tables.transitions
    .map((entry) => `      ${quoteSingle(`${entry.from}|${entry.token}`)}) context=${quoteSingle(entry.to)} ;;`)
    .join("\n");
  const contexts = tables.contexts
    .map((entry) => `      ${quoteSingle(entry.path)}) candidates=(${entry.candidates.map(quoteSingle).join(" ")}) ;;`)
    .join("\n");
  const values = tables.values
    .map((entry) => `      ${shellCaseAlternatives(entry.flags.map((flag) => `${entry.path}|${flag}`))}) candidates=(${entry.values.map(quoteSingle).join(" ")}) ;;`)
    .join("\n");
  return `#compdef ${binary}
# Generated by ${binary}; static, hierarchical, and deterministic.
${name}() {
  local context='' expecting='' token
  local index
  local -a candidates
  for ((index = 2; index < CURRENT; index++)); do
    token="$words[index]"
    if [[ -n "$expecting" ]]; then
      expecting=''
      continue
    fi
    if [[ "$token" == --*=* ]]; then
      continue
    fi
    case "$token" in
      ${shellCaseAlternatives(tables.booleanFlags)}) continue ;;
      ${shellCaseAlternatives(tables.valueFlags)}) expecting="$token"; continue ;;
    esac
    case "$context|$token" in
${transitions}
    esac
  done
  if [[ -n "$expecting" ]]; then
    case "$context|$expecting" in
${values}
    esac
  else
    case "$context" in
${contexts}
    esac
  fi
  _describe '${binary} completion' candidates
}
compdef ${name} ${binary}
`;
}

function fishScript(binary, tables) {
  const name = functionName(binary);
  const transitions = tables.transitions
    .map((entry) => `      case ${quoteSingle(`${entry.from}|${entry.token}`)}\n        set context ${quoteSingle(entry.to)}`)
    .join("\n");
  const contexts = tables.contexts
    .map((entry) => `      case ${quoteSingle(entry.path)}\n        set candidates ${entry.candidates.map(quoteSingle).join(" ")}`)
    .join("\n");
  const values = tables.values
    .map((entry) => `      case ${entry.flags.map((flag) => quoteSingle(`${entry.path}|${flag}`)).join(" ")}\n        set candidates ${entry.values.map(quoteSingle).join(" ")}`)
    .join("\n");
  return `# Generated by ${binary}; static, hierarchical, and deterministic.
function ${name}
  set -l tokens (commandline -opc)
  if test (count $tokens) -gt 0
    set -e tokens[1]
  end
  set -l context ''
  set -l expecting ''
  set -l candidates
  for token in $tokens
    if test -n "$expecting"
      set expecting ''
      continue
    end
    if string match -q -- '--*=*' "$token"
      continue
    end
    switch "$token"
      case ${tables.booleanFlags.map(quoteSingle).join(" ")}
        continue
      case ${tables.valueFlags.map(quoteSingle).join(" ")}
        set expecting "$token"
        continue
    end
    switch "$context|$token"
${transitions}
    end
  end
  if test -n "$expecting"
    switch "$context|$expecting"
${values}
    end
  else
    switch "$context"
${contexts}
    end
  end
  set -l current (commandline -ct)
  for candidate in $candidates
    if string match -q -- "$current*" "$candidate"
      echo "$candidate"
    end
  end
end
complete -c ${binary} -f -a ${quoteSingle(`(${name})`)}
`;
}

function powerShellScript(binary, tables) {
  const transitions = tables.transitions
    .map((entry) => `      ${quoteSingle(`${entry.from}|${entry.token}`)} { $context = ${quoteSingle(entry.to)}; continue }`)
    .join("\n");
  const contexts = tables.contexts
    .map((entry) => `      ${quoteSingle(entry.path)} { $candidates = @(${entry.candidates.map(quoteSingle).join(", ")}) }`)
    .join("\n");
  const values = tables.values
    .flatMap((entry) => entry.flags.map((flag) => `      ${quoteSingle(`${entry.path}|${flag}`)} { $candidates = @(${entry.values.map(quoteSingle).join(", ")}) }`))
    .join("\n");
  const booleans = tables.booleanFlags.map(quoteSingle).join(", ");
  const valued = tables.valueFlags.map(quoteSingle).join(", ");
  return `# Generated by ${binary}; static, hierarchical, and deterministic.
Register-ArgumentCompleter -Native -CommandName ${quoteSingle(binary)} -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
  if ($tokens.Count -gt 0 -and $tokens[$tokens.Count - 1] -eq $wordToComplete) {
    $tokens = @($tokens | Select-Object -First ($tokens.Count - 1))
  }
  $context = ''
  $expecting = ''
  $candidates = @()
  $booleanFlags = @(${booleans})
  $valueFlags = @(${valued})
  foreach ($rawToken in $tokens) {
    $token = [string]$rawToken
    if ($expecting) {
      $expecting = ''
      continue
    }
    if ($token -like '--*=*') { continue }
    if ($booleanFlags -contains $token) { continue }
    if ($valueFlags -contains $token) {
      $expecting = $token
      continue
    }
    switch ("$context|$token") {
${transitions}
    }
  }
  if ($expecting) {
    switch ("$context|$expecting") {
${values}
    }
  } else {
    switch ($context) {
${contexts}
    }
  }
  foreach ($candidate in $candidates) {
    if ($candidate.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
      [System.Management.Automation.CompletionResult]::new($candidate, $candidate, 'ParameterValue', $candidate)
    }
  }
}
`;
}

function stableStringify(value) {
  const ordered = Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  return JSON.stringify(ordered, null, 2);
}

export function buildCompletion(shell, { binary = "agentic-sdlc" } = {}) {
  const normalizedShell = normalizeShell(shell);
  const normalizedBinary = validateBinary(binary);
  const tables = completionTables();
  const script = normalizedShell === "bash"
    ? bashScript(normalizedBinary, tables)
    : normalizedShell === "zsh"
      ? zshScript(normalizedBinary, tables)
      : normalizedShell === "fish"
        ? fishScript(normalizedBinary, tables)
        : powerShellScript(normalizedBinary, tables);
  return Object.freeze({
    schema_version: "agentic-sdlc-completion-v1",
    shell: normalizedShell,
    binary: normalizedBinary,
    sha256: createHash("sha256").update(script, "utf8").digest("hex"),
    script,
  });
}

export function generateCompletion(shell, { json = false, binary = "agentic-sdlc" } = {}) {
  const completion = buildCompletion(shell, { binary });
  return json === true ? stableStringify(completion) : completion.script;
}
