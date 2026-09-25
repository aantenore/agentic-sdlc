export class UserError extends Error {
  constructor(message, humanGuidance = null) {
    super(message);
    this.humanGuidance = humanGuidance;
  }
}

/** A request whose command or options could not be resolved at all. */
export class UsageError extends UserError {}

export function fail(message, humanGuidance = null) {
  throw new UserError(message, humanGuidance);
}

export function failUsage(message, humanGuidance = null) {
  throw new UsageError(message, humanGuidance);
}
