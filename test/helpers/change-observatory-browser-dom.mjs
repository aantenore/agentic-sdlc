function dataKey(name) {
  return name.slice(5).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function attributeNameForDataKey(key) {
  return `data-${String(key).replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

function selectorParts(selector) {
  const trimmed = String(selector ?? "").trim();
  const attribute = trimmed.match(/^(.*?)\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]$/u);
  if (attribute) {
    return {
      prefix: attribute[1],
      attribute: attribute[2],
      value: attribute[3] === undefined ? null : attribute[3],
    };
  }
  return { prefix: trimmed, attribute: null, value: null };
}

function matchesSelector(node, selector) {
  if (!(node instanceof BrowserNode)) return false;
  const { prefix, attribute, value } = selectorParts(selector);
  if (prefix.startsWith("#") && node.id !== prefix.slice(1)) return false;
  if (prefix.startsWith(".") && !node.classList.contains(prefix.slice(1))) return false;
  if (prefix && !prefix.startsWith("#") && !prefix.startsWith(".") && node.tagName !== prefix) {
    return false;
  }
  if (!attribute) return Boolean(prefix);
  const actual = attribute.startsWith("data-")
    ? node.dataset[dataKey(attribute)]
    : node.getAttribute(attribute);
  return actual !== undefined && actual !== null && (value === null || String(actual) === value);
}

export class BrowserNode {
  constructor(tagName = null, ownerDocument = null, text = "") {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.value = "";
    this._text = String(text ?? "");
    this.listeners = new Map();
    this.classList = {
      contains: (name) => this.className.split(/\s+/u).filter(Boolean).includes(name),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
        return enabled;
      },
    };
  }

  get id() {
    return this.attributes.get("id") ?? "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  append(...children) {
    for (const child of children.filter((entry) => entry !== null && entry !== undefined)) {
      if (child instanceof BrowserNode) {
        child.parentNode = this;
        child.ownerDocument = this.ownerDocument;
      }
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this._text = "";
    this.append(...children);
  }

  setAttribute(name, value) {
    const rendered = String(value);
    this.attributes.set(name, rendered);
    if (name === "class") this.className = rendered;
    if (name.startsWith("data-")) this.dataset[dataKey(name)] = rendered;
    if (name === "value") this.value = rendered;
  }

  getAttribute(name) {
    if (name === "class") return this.className || null;
    if (name.startsWith("data-")) {
      const value = this.dataset[dataKey(name)];
      return value === undefined ? null : String(value);
    }
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "class") this.className = "";
    if (name.startsWith("data-")) delete this.dataset[dataKey(name)];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (!(child instanceof BrowserNode)) continue;
        if (matchesSelector(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  cloneNode(deep = false) {
    const clone = new BrowserNode(this.tagName, this.ownerDocument, this._text);
    clone.className = this.className;
    clone.disabled = this.disabled;
    clone.hidden = this.hidden;
    clone.selected = this.selected;
    clone.value = this.value;
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    for (const [key, value] of Object.entries(this.dataset)) {
      clone.dataset[key] = value;
      clone.attributes.set(attributeNameForDataKey(key), String(value));
    }
    if (deep) clone.append(...this.children.map((child) => child.cloneNode?.(true) ?? child));
    return clone;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    const normalized = typeof event === "string" ? { type: event } : event;
    for (const listener of this.listeners.get(normalized.type) ?? []) listener(normalized);
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => child?.textContent ?? String(child ?? "")).join("")}`;
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this.children = [];
  }
}

class BrowserDocument extends BrowserNode {
  constructor() {
    super("document", null);
    this.ownerDocument = this;
    this.documentElement = new BrowserNode("html", this);
    this.body = new BrowserNode("body", this);
    this.documentElement.append(this.body);
    this.append(this.documentElement);
    this.activeElement = null;
    this.title = "Change Observatory";
  }

  createElement(tagName) {
    return new BrowserNode(String(tagName).toLowerCase(), this);
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
  }

  createTextNode(text) {
    return new BrowserNode(null, this, text);
  }

  dispatch(type, target) {
    const event = {
      type,
      target,
      key: null,
      preventDefault() {},
    };
    this.dispatchEvent(event);
  }
}

function element(document, tagName, { id = null, action = null, view = null } = {}) {
  const node = document.createElement(tagName);
  if (id) node.id = id;
  if (action) node.dataset.action = action;
  if (view) node.dataset.view = view;
  return node;
}

function createDocument() {
  const document = new BrowserDocument();
  const skipLink = element(document, "a", { id: "skip-link" });
  skipLink.className = "skip-link";
  skipLink.setAttribute("href", "#workspace");
  const app = element(document, "div", { id: "app" });
  const navToggle = element(document, "button", { action: "toggle-navigation" });
  const projectSelect = element(document, "select", { id: "project-select" });
  const snapshotSelect = element(document, "select", { id: "snapshot-select" });
  const snapshotControl = element(document, "label");
  snapshotControl.className = "field-control snapshot-control";
  snapshotControl.append(snapshotSelect);
  const refresh = element(document, "button", { action: "refresh" });
  const openFirstRaw = element(document, "button", { action: "open-first-raw" });
  const navigation = element(document, "nav", { id: "primary-navigation" });
  for (const view of [
    "overview",
    "timeline",
    "contracts",
    "decisions",
    "changes",
    "intent-evidence",
    "verification",
  ]) navigation.append(element(document, "button", { view }));
  const apiStatus = element(document, "strong", { id: "api-status" });
  navigation.append(apiStatus);
  const workspace = element(document, "main", { id: "workspace" });
  workspace.setAttribute("aria-labelledby", "workspace-heading");
  const workspaceHeading = element(document, "h1", { id: "workspace-heading" });
  const summary = element(document, "section", { id: "summary-region" });
  const diagnostics = element(document, "div", { id: "diagnostics-region" });
  const primary = element(document, "section", { id: "primary-view" });
  primary.setAttribute("aria-labelledby", "workspace-heading");
  const inspector = element(document, "aside", { id: "inspector" });
  workspace.append(workspaceHeading, summary, diagnostics, primary, inspector);
  const rawDrawer = element(document, "section", { id: "raw-drawer" });
  const rawToggle = element(document, "button", { action: "toggle-raw" });
  const rawPath = element(document, "span", { id: "raw-path" });
  const rawContent = element(document, "div", { id: "raw-content" });
  const rawCode = element(document, "code", { id: "raw-code" });
  const rawPre = element(document, "pre");
  rawPre.setAttribute("tabindex", "0");
  rawPre.append(rawCode);
  rawContent.append(rawPre);
  rawDrawer.append(rawToggle, rawPath, rawContent);
  app.append(
    navToggle,
    projectSelect,
    snapshotControl,
    refresh,
    openFirstRaw,
    navigation,
    workspace,
    rawDrawer,
  );
  document.body.append(skipLink, app);
  return document;
}

class BrowserWindow {
  constructor(url) {
    this.listeners = new Map();
    this.urls = [new URL(url)];
    this.index = 0;
    this.sessionValues = new Map();
    this.sessionStorage = {
      getItem: (key) => this.sessionValues.get(key) ?? null,
      setItem: (key, value) => this.sessionValues.set(key, String(value)),
      removeItem: (key) => this.sessionValues.delete(key),
    };
    this.location = {};
    for (const key of ["href", "pathname", "search", "hash"]) {
      Object.defineProperty(this.location, key, {
        enumerable: true,
        get: () => this.urls[this.index][key],
      });
    }
    this.history = {
      pushState: (_state, _title, href) => this.#push(href),
      replaceState: (_state, _title, href) => this.#replace(href),
      back: () => this.#move(-1),
      forward: () => this.#move(1),
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    const normalized = typeof event === "string" ? { type: event } : event;
    for (const listener of this.listeners.get(normalized.type) ?? []) listener(normalized);
  }

  matchMedia() {
    return { matches: false };
  }

  replaceAndDispatch(href, type) {
    this.#replace(href);
    this.dispatchEvent({ type });
  }

  #push(href) {
    const next = new URL(String(href), this.urls[this.index]);
    this.urls.splice(this.index + 1, this.urls.length, next);
    this.index += 1;
  }

  #replace(href) {
    this.urls[this.index] = new URL(String(href), this.urls[this.index]);
  }

  #move(offset) {
    const nextIndex = this.index + offset;
    if (nextIndex < 0 || nextIndex >= this.urls.length) return;
    const previousHash = this.urls[this.index].hash;
    this.index = nextIndex;
    this.dispatchEvent({ type: "popstate" });
    if (previousHash !== this.urls[this.index].hash) this.dispatchEvent({ type: "hashchange" });
  }
}

export function createChangeObservatoryBrowser(url) {
  const document = createDocument();
  const window = new BrowserWindow(url);
  return Object.freeze({ document, window });
}

export async function waitForBrowser(predicate, message, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
