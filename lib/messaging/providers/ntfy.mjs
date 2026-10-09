import { Date } from "../../runtime/host.mjs";

/**
 * ntfy (https://ntfy.sh, or a self-hosted server) messaging adapter.
 *
 * Messages are published as JSON to the server root so UTF-8 text survives;
 * the sender and story travel as tags, so a plain `curl -d text` message from
 * a person is still read, just without them.
 */
export const NTFY_PROVIDER_ID = "ntfy";
const APP_TAG = "agentic-sdlc";
const FROM_TAG = "from:";
const STORY_TAG = "story:";
const RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);

function topicUrl(server, topic, query) {
  const url = new URL(`${server}/${encodeURIComponent(topic)}/json`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

export function toNtfyPayload(topic, { from, story, text }) {
  const tags = [APP_TAG, `${FROM_TAG}${from}`];
  if (story) tags.push(`${STORY_TAG}${story}`);
  return {
    topic,
    title: story ? `${from} · ${story}` : from,
    message: text,
    tags,
  };
}

export function fromNtfyEvent(event) {
  if (!event || event.event !== "message") return null;
  const tags = Array.isArray(event.tags) ? event.tags.map(String) : [];
  const tagValue = (prefix) => tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) || null;
  return {
    id: String(event.id ?? ""),
    time: Number.isFinite(event.time) ? new Date(event.time * 1000).toISOString() : null,
    from: tagValue(FROM_TAG),
    story: tagValue(STORY_TAG),
    text: String(event.message ?? ""),
    title: event.title ? String(event.title) : null,
    plugin_message: tags.includes(APP_TAG),
  };
}

function parseLines(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = fromNtfyEvent(event);
    if (message) messages.push(message);
  }
  return messages;
}

async function failedResponse(response, action) {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200).trim();
  } catch {
    // The status alone is enough to report.
  }
  return new Error(`ntfy ${action} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

export function createNtfyProvider({ fetchImpl = globalThis.fetch, sleep } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime has no fetch; messaging needs Node.js 18 or newer.");
  }
  const wait = sleep ?? ((ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }));

  async function publish({ server, topic, message, signal }) {
    const response = await fetchImpl(server, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toNtfyPayload(topic, message)),
      signal,
    });
    if (!response.ok) throw await failedResponse(response, "publish");
    return fromNtfyEvent(await response.json());
  }

  async function poll({ server, topic, since, signal }) {
    const response = await fetchImpl(topicUrl(server, topic, { poll: "1", since }), { signal });
    if (!response.ok) throw await failedResponse(response, "read");
    return parseLines(await response.text());
  }

  /**
   * Stream messages until the signal aborts. A dropped connection is reopened
   * from the last message seen, so nothing is lost or repeated.
   */
  async function subscribe({ server, topic, since, signal, onMessage, onError }) {
    let cursor = since;
    let attempt = 0;
    while (!signal?.aborted) {
      try {
        const response = await fetchImpl(topicUrl(server, topic, { since: cursor }), { signal });
        if (!response.ok) throw await failedResponse(response, "listen");
        attempt = 0;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            for (const message of parseLines(line)) {
              if (message.id) cursor = message.id;
              const keepGoing = await onMessage(message);
              if (keepGoing === false) return;
            }
            newline = buffer.indexOf("\n");
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        onError?.(error);
      }
      if (signal?.aborted) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      await wait(delay, signal);
    }
  }

  return Object.freeze({ id: NTFY_PROVIDER_ID, publish, poll, subscribe });
}
