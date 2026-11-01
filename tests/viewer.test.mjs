import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// A minimal capture-DOM: enough for the viewer's createElement/createTextNode/append rendering so the real
// renderWeekly and openLightbox from map.js run in Node and their output trees can be asserted — no browser,
// no dependency. It also records event listeners and supports classList/remove so the lightbox open/close flow
// can be driven and inspected.
function makeElement(tagName) {
  const classes = new Set();
  const element = {
    tagName: tagName,
    childNodes: [],
    parentNode: null,
    attributes: {},
    listeners: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = element;
        element.childNodes.push(node);
      }
    },
    setAttribute(name, value) {
      element.attributes[name] = value;
    },
    getAttribute(name) {
      return Object.hasOwn(element.attributes, name) ? element.attributes[name] : null;
    },
    addEventListener(type, handler) {
      (element.listeners[type] ??= []).push(handler);
    },
    removeEventListener(type, handler) {
      element.listeners[type] = (element.listeners[type] ?? []).filter((candidate) => candidate !== handler);
    },
    dispatch(type, event) {
      for (const handler of element.listeners[type] ?? []) {
        handler(event ?? { target: element });
      }
    },
    remove() {
      if (element.parentNode !== null) {
        const siblings = element.parentNode.childNodes;
        siblings.splice(siblings.indexOf(element), 1);
        element.parentNode = null;
      }
    },
    focus() {},
    // Native <dialog> surface the lightbox drives: showModal opens, close fires the "close" event our cleanup listens for.
    open: false,
    showModal() {
      element.open = true;
    },
    close() {
      element.open = false;
      element.dispatch("close");
    },
  };
  return element;
}

// Set the test flag and DOM globals before importing map.js so its browser bootstrap is skipped and its
// top-level document lookups resolve; the render functions then build into this capture-DOM.
globalThis.__ALPIN_VIEWER_TEST__ = true;
globalThis.window = { addEventListener() {}, location: { hash: "" } };
const documentListeners = {};
globalThis.document = {
  body: makeElement("body"),
  activeElement: null,
  createElement: (tagName) => makeElement(tagName),
  createTextNode: (textContent) => ({ tagName: "#text", textContent: textContent, childNodes: [] }),
  getElementById: () => makeElement("div"),
  querySelectorAll: () => [],
  addEventListener(type, handler) {
    (documentListeners[type] ??= []).push(handler);
  },
  removeEventListener(type, handler) {
    documentListeners[type] = (documentListeners[type] ?? []).filter((candidate) => candidate !== handler);
  },
  dispatch(type, event) {
    for (const handler of documentListeners[type] ?? []) {
      handler(event);
    }
  },
};

const { renderWeekly, openLightbox, closeLightbox } = await import("../map.js");

function textOf(node) {
  // A text node carries its string; a leaf element carries textContent; a container concatenates its children.
  if (node.tagName === "#text") {
    return node.textContent ?? "";
  }
  if (typeof node.textContent === "string" && node.childNodes.length === 0) {
    return node.textContent;
  }
  return node.childNodes.map(textOf).join("");
}

function collect(node, tagName, found) {
  if (node.tagName === tagName) {
    found.push(node);
  }
  for (const child of node.childNodes) {
    collect(child, tagName, found);
  }
  return found;
}

test("renderWeekly renders the published weekly markdown into the expected DOM", async () => {
  const markdown = await readFile(new URL("../weekly_briefing.md", import.meta.url), "utf8");
  const section = renderWeekly({ markdown: markdown });

  // Exactly one cover image with an absolute forum src, and its caption rendered as emphasis.
  const images = collect(section, "img", []);
  assert.equal(images.length, 1);
  assert.match(images[0].src, /^https:\/\//);
  assert.ok(collect(section, "em", []).length >= 1, "the cover caption should render as <em>");

  // The five section headings render in order as <h2> (the H1 title is dropped; the chrome shows it).
  assert.deepEqual(collect(section, "h2", []).map(textOf), [
    "1. Infrastruktur",
    "2. Schnee- und Bergbedingungen",
    "3. Berichte der Woche",
    "4. Tipps & Insights",
    "5. Community-Diskussion",
  ]);

  // Bullets render as <li> carrying their forum source links.
  assert.ok(collect(section, "li", []).length >= 5, "section bullets should render as <li>");
  const hrefs = collect(section, "a", []).map((anchor) => anchor.href);
  assert.ok(hrefs.length > 0, "forum source links should render as <a>");

  // The email's promo links back to this very site, so the viewer must filter that one self-link out.
  assert.ok(
    hrefs.every((href) => !href.includes("michaelmedek.github.io/alpin-map")),
    "the live-map self-link must not render in the viewer",
  );
});

test("clicking an image opens a native modal <dialog> lightbox that light-dismisses", () => {
  closeLightbox(); // start from a clean slate regardless of prior tests
  const baseline = document.body.childNodes.length;

  const dialog = openLightbox({ src: "https://img.example/peak.jpg", alt: "A snowy peak" });

  // The dialog is appended to the body and shown modally, carrying exactly the one full-size image.
  assert.equal(dialog.tagName, "dialog");
  assert.equal(document.body.childNodes.at(-1), dialog);
  assert.equal(dialog.open, true);
  assert.equal(document.body.classList.contains("lightbox-open"), true);
  const images = collect(dialog, "img", []);
  assert.equal(images.length, 1);
  assert.equal(images[0].src, "https://img.example/peak.jpg");
  assert.equal(images[0].alt, "A snowy peak");

  // A backdrop click (target === the dialog) closes it; the close event removes it and releases the scroll lock.
  dialog.dispatch("click", { target: dialog });
  assert.equal(dialog.open, false);
  assert.equal(document.body.childNodes.length, baseline);
  assert.equal(document.body.classList.contains("lightbox-open"), false);
});

test("closeLightbox() closes the open dialog", () => {
  closeLightbox();
  const dialog = openLightbox({ src: "https://img.example/a.jpg", alt: "a" });
  assert.equal(dialog.open, true);

  closeLightbox();

  assert.equal(dialog.open, false);
  assert.equal(document.body.classList.contains("lightbox-open"), false);
});

test("the viewer entry script parses as valid JavaScript", () => {
  // map_state.mjs is unit-tested, but map.js (the browser entry and rendering) was never loaded by the suite,
  // so a syntax error in it passed green; this gate parses both so a broken viewer script fails the suite.
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const file of ["map.js", "map_state.mjs"]) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file], { cwd: root, stdio: "pipe" }));
  }
});
