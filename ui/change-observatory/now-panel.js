import { node } from "./dom.js";
import { getLocale } from "./i18n.js";

// "Now" panel: who is doing what across computers. Self-contained: it reads
// its own endpoint, refreshes itself and stays hidden when there is nothing
// to show or the server predates the endpoint.
const REFRESH_MS = 30_000;

const ITALIAN = Object.freeze({
  Now: "Adesso",
  "Who is doing what across computers": "Chi sta facendo cosa sui vari computer",
  "In progress": "In corso",
  "Nobody is working on a story right now.": "Nessuno sta lavorando a una storia in questo momento.",
  phase: "fase",
  since: "da",
  branch: "branch",
  reserved: "riservata",
  parked: "parcheggiata",
  waiting: "in attesa",
  idle: "ferma",
  abandoned: "abbandonata",
  "Latest from each computer": "Ultimo da ogni computer",
  status: "stato",
  "Open questions and requests": "Domande e richieste aperte",
  "waiting on": "attende",
  "Free computers": "Computer liberi",
  "Messaging is off: only the shared claims are shown.": "Messaggi disattivati: sono mostrate solo le prenotazioni condivise.",
  "Messages could not be read right now.": "I messaggi non sono leggibili in questo momento.",
  "just now": "adesso",
  "min ago": "min fa",
  "h ago": "h fa",
  "d ago": "g fa",
  from: "da",
  "local base checkout": "checkout base locale",
  updated: "aggiornato",
  inconsistent: "incoerente",
  "branch not on the remote": "branch assente sul remoto",
});

const SOURCE_KIND = Object.freeze({ base: "base", branch: "branch", claim: "claim" });

function label(text) {
  return getLocale() === "it" ? ITALIAN[text] ?? text : text;
}

export function relativeTime(value, nowMs = Date.now()) {
  const at = Date.parse(String(value ?? ""));
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 1) return label("just now");
  if (minutes < 60) return `${minutes} ${label("min ago")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${label("h ago")}`;
  return `${Math.floor(hours / 24)} ${label("d ago")}`;
}

function section(title, items) {
  return node("section", { className: "now-section" }, [
    node("h3", { text: label(title) }),
    node("ul", { className: "now-list" }, items),
  ]);
}

function workItem(item) {
  const parts = [];
  if (item.phase) {
    const source = item.phaseSource ? `${label("from")} ${SOURCE_KIND[item.phaseSource.kind] ?? item.phaseSource.kind} ${label(item.phaseSource.ref)}` : "";
    const when = item.phaseSince ? `${label("updated")} ${relativeTime(item.phaseSince)}` : "";
    const detail = [source, when].filter(Boolean).join(", ");
    parts.push(`${label("phase")} ${item.phase}${detail ? ` (${detail})` : ""}`);
  }
  if (item.since) parts.push(`${label("since")} ${relativeTime(item.since)}`);
  if (item.branch) parts.push(`${label("branch")} ${item.branch}`);
  const flag = item.state !== "claimed" ? item.state : item.health && item.health !== "active" ? item.health : null;
  const issues = Array.isArray(item.issues) ? item.issues : [];
  return node("li", { className: "now-item" }, [
    node("strong", { text: item.storyId }),
    node("span", { className: "now-who", text: item.who || item.agent || "" }),
    flag ? node("span", { className: "now-flag", text: label(flag) }) : null,
    node("span", { className: "now-meta", text: parts.join(" · ") }),
    issues.length ? node("span", { className: "now-flag", text: label("inconsistent") }) : null,
    ...issues.map((issue) => node("span", { className: "now-meta", text: `${issue.code}: ${issue.detail}` })),
  ]);
}

function senderItem(sender) {
  const shown = sender.status && sender.status !== sender.last ? [sender.status, sender.last] : [sender.last];
  return node("li", { className: "now-item" }, [
    node("strong", { text: sender.from }),
    ...shown.filter(Boolean).map((message) => node("span", { className: "now-meta" }, [
      node("span", { text: `${message.text} ` }),
      node("time", { text: relativeTime(message.time), attrs: { datetime: message.time } }),
    ])),
  ]);
}

function openItem(message) {
  return node("li", { className: "now-item" }, [
    node("strong", { text: message.from }),
    node("span", { className: "now-flag", text: message.kind }),
    node("span", { className: "now-meta", text: `${message.text} · ${label("waiting on")} ${message.waitingOn.join(", ")} · ${relativeTime(message.time)}` }),
  ]);
}

export function renderNowPanel(container, view) {
  const wasOpen = container.querySelector("details")?.open ?? true;
  container.replaceChildren();
  if (!view) {
    container.hidden = true;
    return;
  }
  const work = Array.isArray(view.work) ? view.work : [];
  const senders = Array.isArray(view.senders) ? view.senders : [];
  const open = Array.isArray(view.open) ? view.open : [];
  const free = Array.isArray(view.free) ? view.free : [];
  const children = [
    node("summary", {}, [
      node("strong", { text: label("Now") }),
      node("span", { className: "now-meta", text: ` ${label("Who is doing what across computers")}` }),
    ]),
    section("In progress", work.length
      ? work.map(workItem)
      : [node("li", { className: "now-empty", text: label("Nobody is working on a story right now.") })]),
  ];
  if (view.messaging === "off") children.push(node("p", { className: "now-note", text: label("Messaging is off: only the shared claims are shown.") }));
  if (view.messaging === "unavailable") children.push(node("p", { className: "now-note", text: label("Messages could not be read right now.") }));
  if (open.length) children.push(section("Open questions and requests", open.map(openItem)));
  if (free.length) {
    children.push(section("Free computers", free.map((entry) => node("li", { className: "now-item" }, [
      node("strong", { text: entry.from }),
      node("span", { className: "now-meta", text: relativeTime(entry.time) }),
    ]))));
  }
  if (senders.length) children.push(section("Latest from each computer", senders.map(senderItem)));
  const details = node("details", { className: "now-details", attrs: { open: wasOpen ? "" : null } }, children);
  container.append(details);
  container.hidden = false;
}

// Mounts the panel under `anchor` and keeps it fresh; failures keep it hidden.
export function mountNowPanel({ api, anchor }) {
  if (!api || typeof api.loadNow !== "function" || typeof anchor?.after !== "function") return null;
  const container = node("section", { className: "now-panel", attrs: { id: "now-region", "aria-live": "polite" } });
  container.hidden = true;
  anchor.after(container);
  let lastKey = null;
  async function refresh() {
    try {
      const view = await api.loadNow();
      const key = JSON.stringify({ ...view, generatedAt: null });
      if (key === lastKey) return;
      lastKey = key;
      renderNowPanel(container, view);
    } catch {
      container.hidden = true;
    }
  }
  refresh();
  const timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  return { refresh, stop: () => clearInterval(timer) };
}
