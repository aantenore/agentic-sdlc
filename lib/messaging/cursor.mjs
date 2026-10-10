/**
 * Read position in the channel. A cursor names the last message seen as
 * "<created time>|<comment id>": the time narrows the request (GitHub's
 * `since`), the id drops what was already seen, because comment ids only grow.
 */
export const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\|\d{1,20}$/u;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export function isCursor(value) {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

export function cursorOf(message) {
  return message?.id && message?.time ? `${message.time}|${message.id}` : null;
}

export function parseCursor(value) {
  if (!isCursor(value)) return null;
  const [time, id] = value.split("|");
  return { time, id: Number(id) };
}
