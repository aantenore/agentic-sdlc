/**
 * Message kinds on top of plain text. Everything here is presentation and
 * bookkeeping: a kind never makes a message an instruction.
 */
export const KINDS = Object.freeze(["info", "question", "answer", "ack", "offer", "request"]);
// Kinds that expect an answer from the other computers.
const EXPECTS_REPLY = new Set(["question", "request"]);
const REPLY_KINDS = new Set(["answer", "ack"]);
export const ID_PATTERN = /^[A-Za-z0-9]{1,32}$/u;

export function expectsReply(message) {
  return EXPECTS_REPLY.has(message?.kind);
}

/**
 * For each message that expects a reply, the known senders that have not
 * replied yet. Known senders are the ones seen in `messages`; a message
 * addressed with `to` waits only for that sender.
 */
export function pendingReplies(messages) {
  const senders = [...new Set(messages.map((message) => message.from).filter(Boolean))];
  const pending = {};
  for (const message of messages) {
    if (!expectsReply(message) || !message.id) continue;
    const answered = new Set(messages
      .filter((other) => REPLY_KINDS.has(other.kind) && other.reply_to === message.id)
      .map((other) => other.from));
    const expected = message.to ? [message.to] : senders.filter((sender) => sender !== message.from);
    pending[message.id] = expected.filter((sender) => !answered.has(sender));
  }
  return pending;
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(value ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** The newest plugin version announced by another computer when it is newer than `current`, else null. */
export function newerVersionSeen(messages, current) {
  const mine = versionParts(current);
  if (!mine) return null;
  let best = null;
  for (const message of messages) {
    const theirs = versionParts(message.version);
    if (theirs && compareVersions(theirs, mine) > 0 && (!best || compareVersions(theirs, versionParts(best.version)) > 0)) best = message;
  }
  return best ? { version: best.version, from: best.from } : null;
}
