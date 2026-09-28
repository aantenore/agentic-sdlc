import realChildProcess from "node:child_process";
import realCrypto from "node:crypto";
import realFs from "node:fs";
import realOs from "node:os";

/**
 * The one seam through which the lifecycle reaches the outside world: the file
 * system, child processes, the operating system, randomness, the process
 * object, the console and the clock.
 *
 * Modules import these names from here instead of from Node or the global
 * scope. Every member forwards to the real implementation unless a test has
 * replaced it with setHost(), so production behaviour is unchanged while any
 * code path can run against a fake file system, clock or random source.
 */
const RealDate = globalThis.Date;

const DEFAULT_HOST = Object.freeze({
  childProcess: realChildProcess,
  console: globalThis.console,
  crypto: realCrypto,
  fs: realFs,
  now: () => RealDate.now(),
  os: realOs,
  process: globalThis.process,
});

let current = DEFAULT_HOST;

/**
 * Replace some host members until the returned function is called. Members
 * not named keep their current implementation. Intended for tests.
 */
export function setHost(overrides) {
  const previous = current;
  current = Object.freeze({ ...current, ...overrides });
  return () => {
    current = previous;
  };
}

/** The member currently in effect, for tests that wrap rather than replace. */
export function currentHost() {
  return current;
}

function forwarding(member) {
  const target = () => current[member];
  // Functions are wrapped, not bound: a bound function loses its own
  // properties (fs.realpathSync.native, process.hrtime.bigint). The wrapper
  // keeps them, and runs a call made through this seam against the real
  // object, exactly as a direct call on it would. Wrappers are cached so a
  // method keeps a stable identity.
  const wrappers = new WeakMap();
  let seam;
  const wrap = (fn) => {
    let wrapper = wrappers.get(fn);
    if (!wrapper) {
      wrapper = new Proxy(fn, {
        apply(original, thisArg, args) {
          return Reflect.apply(original, thisArg === seam ? target() : thisArg, args);
        },
      });
      wrappers.set(fn, wrapper);
    }
    return wrapper;
  };
  seam = new Proxy(Object.create(null), {
    get(_shadow, property) {
      const implementation = target();
      const value = Reflect.get(implementation, property, implementation);
      return typeof value === "function" ? wrap(value) : value;
    },
    set(_shadow, property, value) {
      return Reflect.set(target(), property, value);
    },
    has(_shadow, property) {
      return Reflect.has(target(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(target());
    },
    getOwnPropertyDescriptor(_shadow, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target(), property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
  return seam;
}

export const childProcess = forwarding("childProcess");
export const console = forwarding("console");
export const crypto = forwarding("crypto");
export const fs = forwarding("fs");
export const os = forwarding("os");
export const process = forwarding("process");

/**
 * A Date whose "now" comes from the host clock. Constructing it with arguments,
 * and every static and prototype method, behave exactly like the built-in; a
 * value created by either class passes an instanceof check against the other.
 */
export class Date extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(current.now());
    } else {
      super(...args);
    }
  }

  static now() {
    return current.now();
  }

  static [Symbol.hasInstance](value) {
    return value instanceof RealDate;
  }
}
