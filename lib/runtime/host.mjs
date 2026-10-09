import realChildProcess from "node:child_process";
import realCrypto from "node:crypto";
import realFs from "node:fs";
import realOs from "node:os";
import { boundChildProcess } from "./bounded-child-process.mjs";

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
  // Git calls are bounded in time and report progress; everything else is the real module.
  childProcess: boundChildProcess(realChildProcess, { clock: () => current.now() }),
  console: globalThis.console,
  crypto: realCrypto,
  fs: realFs,
  fsPromises: realFs.promises,
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
  // A method is resolved on the implementation in effect when it is CALLED,
  // not when it is read, so a function kept aside (const { readFileSync } = fs)
  // still follows setHost(). Wrappers are Proxies over the function rather
  // than bound copies, so its own properties (fs.realpathSync.native,
  // process.hrtime.bigint) remain reachable, and they are cached per property
  // so a method keeps a stable identity.
  const wrappers = new Map();
  let seam;
  const wrapperFor = (property, initial) => {
    let wrapper = wrappers.get(property);
    if (!wrapper) {
      const resolve = () => {
        const implementation = target();
        return { implementation, fn: Reflect.get(implementation, property, implementation) };
      };
      wrapper = new Proxy(initial, {
        apply(_initial, thisArg, args) {
          const { implementation, fn } = resolve();
          return Reflect.apply(fn, thisArg === seam ? implementation : thisArg, args);
        },
        get(original, key) {
          // A class's prototype is fixed on the wrapped function; everything
          // else comes from the implementation in effect.
          if (key === "prototype") return Reflect.get(original, key);
          return Reflect.get(resolve().fn, key);
        },
      });
      wrappers.set(property, wrapper);
    }
    return wrapper;
  };
  seam = new Proxy(Object.create(null), {
    get(_shadow, property) {
      const implementation = target();
      const value = Reflect.get(implementation, property, implementation);
      return typeof value === "function" ? wrapperFor(property, value) : value;
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
export const fsPromises = forwarding("fsPromises");
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
