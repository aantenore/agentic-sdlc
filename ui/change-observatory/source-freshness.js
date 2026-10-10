import { t } from "./i18n.js";

// The warning shown when the records come from a local checkout that is
// behind its base branch: the views may show work as not done yet.
export function staleCheckoutMessage(source) {
  const behind = Number(source?.behind);
  if (source?.mode === "ref" || !Number.isSafeInteger(behind) || behind <= 0) return null;
  const base = typeof source.base === "string" && source.base ? source.base : "main";
  const template = behind === 1
    ? "This view is 1 commit behind {base}: the data may be old"
    : "This view is {count} commits behind {base}: the data may be old";
  return t(template).replace("{count}", String(behind)).replace("{base}", base);
}
