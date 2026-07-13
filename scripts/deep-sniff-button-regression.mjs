import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const rustSource = readFileSync(
  new URL("../src-tauri/src/extractor/webview.rs", import.meta.url),
  "utf8",
);
const scriptMatch = rustSource.match(
  /\.initialization_script\(\s*r#"([\s\S]*?)"#,\s*\)/,
);

assert.ok(scriptMatch, "Deep Sniff initialization script must remain discoverable");
const injectedScript = scriptMatch[1];
const addUrlModalSource = readFileSync(
  new URL("../src/components/AddUrlModal.tsx", import.meta.url),
  "utf8",
);

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.currentSrc = "";
    this.src = "";
    this.nodeType = 1;
    this.isConnected = true;
  }

  appendChild(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    const event = {
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {},
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  querySelector(selector) {
    if (selector === "source[src], source[data-src]") {
      return this.walk().find((element) =>
        element.tagName === "SOURCE" &&
        (element.src || element.getAttribute("src") || element.getAttribute("data-src"))
      ) ?? null;
    }
    return null;
  }

  querySelectorAll(selector) {
    const descendants = this.walk();
    if (selector === "video, audio, source, embed, object") {
      return descendants.filter((element) =>
        ["VIDEO", "AUDIO", "SOURCE", "EMBED", "OBJECT"].includes(element.tagName)
      );
    }
    if (selector === "video, audio") {
      return descendants.filter((element) => ["VIDEO", "AUDIO"].includes(element.tagName));
    }
    return [];
  }

  contains(candidate) {
    return candidate === this || this.walk().includes(candidate);
  }

  walk() {
    return this.children.flatMap((child) => [child, ...child.walk()]);
  }

  getBoundingClientRect() {
    return { top: 40, right: 640, bottom: 400, left: 20, width: 620, height: 360 };
  }
}

class FakeDocument {
  constructor(mediaElements) {
    this.readyState = "complete";
    this.listeners = new Map();
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
    for (const media of mediaElements) this.body.appendChild(media);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return [this.documentElement, ...this.documentElement.walk()].find(
      (element) => element.id === id,
    ) ?? null;
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
}

class FakeHeaders {
  *[Symbol.iterator]() {}
}

class FakeXmlHttpRequest {
  open() {}
  send() {}
  setRequestHeader() {}
  addEventListener() {}
  getResponseHeader() { return null; }
}

function mediaElement({ currentSrc = "", src = "", sourceSrc = "" } = {}) {
  const media = new FakeElement("video", null);
  media.currentSrc = currentSrc;
  media.src = src;
  if (sourceSrc) {
    const source = new FakeElement("source", null);
    source.src = sourceSrc;
    source.setAttribute("src", sourceSrc);
    media.appendChild(source);
  }
  return media;
}

function createHarness(mediaElements) {
  const pageUrl = "https://media.example.test/gallery/index.html";
  const topLevelNavigations = [];
  const intervalCallbacks = [];
  const document = new FakeDocument(mediaElements);
  const location = {
    _href: pageUrl,
    origin: new URL(pageUrl).origin,
    get href() {
      return this._href;
    },
    set href(value) {
      this._href = String(value);
      topLevelNavigations.push(this._href);
    },
  };

  const sandbox = {
    document,
    location,
    navigator: { userAgent: "VelocityDL-Test-Agent/1.0" },
    innerHeight: 900,
    console: { log() {}, error() {} },
    TextEncoder,
    URL,
    Headers: FakeHeaders,
    XMLHttpRequest: FakeXmlHttpRequest,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      disconnect() {}
    },
    fetch: async () => ({ headers: { get: () => null } }),
    btoa: (binary) => Buffer.from(binary, "binary").toString("base64"),
    setInterval: (callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    setTimeout: () => 1,
    addEventListener() {},
  };
  sandbox.window = sandbox;

  vm.runInNewContext(injectedScript, sandbox, { filename: "deep-sniff-injected.js" });

  return {
    document,
    intervalCallbacks,
    pageUrl,
    topLevelNavigations,
    buttons: () => [document.documentElement, ...document.documentElement.walk()]
      .filter((element) => element.tagName === "BUTTON"),
  };
}

function decodeCapture(navigationUrl) {
  assert.ok(navigationUrl, "click must initiate a top-level capture navigation");
  const url = new URL(navigationUrl);
  assert.equal(url.protocol, "vdl-detect:");
  const encoded = url.searchParams.get("d");
  assert.ok(encoded, "capture navigation must include the encoded payload");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

{
  const firstUrl = "https://cdn.example.test/first.mp4?token=one";
  const secondUrl = "https://cdn.example.test/second.mp4?token=two";
  const harness = createHarness([
    mediaElement({ currentSrc: firstUrl }),
    mediaElement({ currentSrc: secondUrl }),
  ]);

  assert.equal(harness.buttons().length, 2, "one button must be injected per media element");
  const navigationCountBeforeClick = harness.topLevelNavigations.length;
  harness.buttons()[1].dispatch("click");
  assert.equal(
    harness.topLevelNavigations.length,
    navigationCountBeforeClick + 1,
    "an explicit click must bypass passive detection dedupe and reach native navigation",
  );

  const capture = decodeCapture(harness.topLevelNavigations.at(-1));
  assert.equal(capture.url, secondUrl, "the second button must submit the second video URL");
  assert.equal(capture.headers.Referer, harness.pageUrl);
  assert.equal(capture.headers.Origin, "https://media.example.test");
  assert.equal(capture.headers["User-Agent"], "VelocityDL-Test-Agent/1.0");

  for (const scan of harness.intervalCallbacks) scan();
  assert.equal(harness.buttons().length, 2, "rescanning must not add duplicate buttons/listeners");
}

{
  const sourceUrl = "https://cdn.example.test/nested-source.mp4";
  const harness = createHarness([mediaElement({ sourceSrc: sourceUrl })]);
  harness.buttons()[0].dispatch("click");
  const capture = decodeCapture(harness.topLevelNavigations.at(-1));
  assert.equal(capture.url, sourceUrl, "a child <source> URL must be resolved");
}

{
  const harness = createHarness([mediaElement({ currentSrc: "blob:https://media.example.test/id" })]);
  harness.buttons()[0].dispatch("click");
  assert.equal(harness.topLevelNavigations.length, 0);
  assert.equal(
    harness.buttons()[0].textContent,
    "Play media first",
    "an unresolved blob must produce visible feedback",
  );
}

assert.match(
  addUrlModalSource,
  /listen(?:<[^>]+>)?\("sniffer_error"/,
  "the main modal must display native Deep Sniff submission errors",
);
assert.match(
  addUrlModalSource,
  /downloadOrigin:\s*["']sniff_capture["']/,
  "Deep Sniff downloads must retain sniff_capture provenance in the normal pipeline",
);

console.log("Deep Sniff button regression passed");
