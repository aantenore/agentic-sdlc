import {
  UserError,
} from "../cli/user-error.mjs";
import {
  unsupportedNodeRuntimeMessage,
} from "../runtime-support.mjs";

export class UnsupportedNodeRuntimeError extends UserError {
  constructor(version, locale) {
    super(unsupportedNodeRuntimeMessage(version, locale));
  }
}
