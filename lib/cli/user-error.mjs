const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;

export class UserError extends Error {
  constructor(message, humanGuidance = null, errorCode = null) {
    super(message);
    this.humanGuidance = humanGuidance;
    // A stable, specific code reported by --json instead of the generic
    // USER_ERROR, so automation can react to one refusal without parsing text.
    this.errorCode = typeof errorCode === "string" && ERROR_CODE_PATTERN.test(errorCode)
      ? errorCode
      : null;
  }
}

/** A request whose command or options could not be resolved at all. */
export class UsageError extends UserError {}

export function fail(message, humanGuidance = null) {
  throw new UserError(message, humanGuidance);
}

/** Refuse on the merits with a specific machine-readable error code. */
export function failWithCode(errorCode, message, humanGuidance = null) {
  throw new UserError(message, humanGuidance, errorCode);
}

export function failUsage(message, humanGuidance = null) {
  throw new UsageError(message, humanGuidance);
}
