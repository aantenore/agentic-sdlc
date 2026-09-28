import { process } from "./runtime/host.mjs";
export const NODE_ENGINE_RANGE = "^18.20.3 || ^20.12.0 || >=21.6.0";
export const NODE_RUNTIME_REQUIREMENT = "Node.js 18.20.3–18.x, 20.12.0–20.x, or 21.6.0+";

export function unsupportedNodeRuntimeMessage(version, locale = "en") {
  if (String(locale).trim().toLowerCase().split(/[-_]/u)[0] === "it") {
    return `Serve ${NODE_RUNTIME_REQUIREMENT}; rilevato Node.js ${version}. Aggiorna Node.js prima di usare Agentic SDLC.`;
  }
  return `${NODE_RUNTIME_REQUIREMENT} is required; found ${version}. Upgrade Node.js before using Agentic SDLC.`;
}

export function isSupportedNodeRuntime(version) {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;

  const { major, minor, patch } = parsed;
  if (major === 18) {
    return minor > 20 || (minor === 20 && patch >= 3);
  }
  if (major === 20) {
    return minor >= 12;
  }
  if (major === 21) {
    return minor >= 6;
  }
  return major >= 22;
}

export function assertSupportedNodeRuntime(version = process.versions.node) {
  if (!isSupportedNodeRuntime(version)) {
    throw new Error(unsupportedNodeRuntimeMessage(version));
  }
}

function parseNodeVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}
