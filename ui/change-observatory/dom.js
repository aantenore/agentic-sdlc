import { localizeUiText } from "./i18n.js";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) {
    element.textContent = options.i18n
      ? localizeUiText(options.text)
      : String(options.text ?? "");
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value !== null && value !== undefined) {
      const rendered = options.i18n && (name === "title" || name.startsWith("aria-"))
        ? localizeUiText(value)
        : value;
      element.setAttribute(name, String(rendered));
    }
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    if (value !== null && value !== undefined) element.dataset[name] = String(value);
  }
  element.append(...children.filter(Boolean));
  return element;
}

// SVG presentation attributes keep charts compatible with a style-src 'self'
// policy: no inline style attribute is ever written.
export function svgNode(tag, attrs = {}, children = []) {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (name === "className") element.setAttribute("class", String(value));
    else if (name === "text") element.textContent = String(value);
    else if (name === "dataset") {
      for (const [key, data] of Object.entries(value)) {
        if (data !== null && data !== undefined) element.dataset[key] = String(data);
      }
    } else element.setAttribute(name, String(value));
  }
  element.append(...children.filter(Boolean));
  return element;
}

export function icon(name, className = "") {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NAMESPACE, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}
