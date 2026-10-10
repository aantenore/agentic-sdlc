// The five lines a reader needs first about a story: what it asked for, what
// was delivered, how the checks went, who did it, and where it stands. Every
// value comes from the server's structured records; nothing is inferred here.
import { node } from "./dom.js";
import { getLocale, humanizeRecordedText, t } from "./i18n.js";

function shortDate(value) {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleString(getLocale() === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function askedLine(brief, fallbackTitle) {
  const asked = brief.asked;
  const title = humanizeRecordedText(asked.title, { keepWorkIds: true }) ?? asked.title ?? fallbackTitle;
  const requirement = asked.requirementTitle && asked.requirementTitle !== asked.title
    ? ` (${t("request")}: ${asked.requirementTitle})`
    : "";
  return `${title}${requirement}${asked.summary ? ` — ${asked.summary}` : ""}`;
}

function deliveryLine(delivery) {
  if (!delivery) return t("No pull request recorded yet");
  const pr = delivery.number ? `PR #${delivery.number}` : t("Pull request");
  const parts = [
    delivery.state === "merged" ? `${pr} ${t("merged")}` : `${pr} ${t("open, not merged yet")}`,
    shortDate(delivery.at),
    delivery.mergeSha ? `${t("merge")} ${delivery.mergeSha.slice(0, 7)}` : null,
    delivery.branch ? `${t("branch")} ${delivery.branch}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function testsLine(tests) {
  if (!tests.total) return t("No checks recorded");
  return [
    `${tests.passed} ${t("passed")}`,
    `${tests.failed} ${t("failed")}`,
    `${tests.notRun} ${t("not run")}`,
  ].join(" · ");
}

function testsVerdict(tests) {
  if (!tests.total) return "missing";
  if (tests.failed) return "failed";
  if (tests.notRun) return "partial";
  return "passed";
}

function whoLine(who) {
  const parts = [];
  if (who.person && who.agent) parts.push(`${who.person} ${t("with")} ${who.agent}`);
  else if (who.person || who.agent) parts.push(who.person ?? who.agent);
  if (who.computer) parts.push(`${t("computer")} ${who.computer}`);
  const approvers = who.approvers.filter((name) => name !== who.person);
  if (approvers.length) parts.push(`${t("approved by")} ${approvers.join(", ")}`);
  return parts.length ? parts.join(" · ") : t("Not recorded");
}

/**
 * The story card shown at the top of a story row and of its dossier.
 * Returns null for servers that send no brief.
 */
export function storyBriefCard(iteration, status) {
  const brief = iteration?.brief;
  if (!brief) return null;
  const row = (label, value, dataset = {}) => node("div", { className: "story-brief-row", dataset }, [
    node("dt", { text: label, i18n: true }),
    node("dd", { text: value }),
  ]);
  return node("dl", { className: "story-brief", attrs: { "aria-label": t("Story in brief") } }, [
    row("Asked for", askedLine(brief, iteration.title ?? iteration.id)),
    row("Delivered", deliveryLine(brief.delivery), { state: brief.delivery?.state ?? "none" }),
    row("Checks", testsLine(brief.tests), { verdict: testsVerdict(brief.tests) }),
    row("Who", whoLine(brief.who)),
    row("Status", status?.reason ? `${status.label} — ${status.reason}` : status?.label ?? t("Not recorded")),
  ]);
}
