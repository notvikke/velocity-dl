import { describe, expect, it } from "vitest";
import {
  browserConnectionPresentation,
  browserSetupInstruction,
  selectBrowserProfile,
  type BrowserIntegrationProfile,
} from "./browser-integration";

describe("browserConnectionPresentation", () => {
  it("accepts the official extension independently of manifest diagnostics", () => {
    const state = browserConnectionPresentation({
      runtimeId: "alnagakehjhbfkdianlkmcncefldpmhm",
      identity: {
        kind: "chrome_web_store",
        supported: true,
        production: true,
        recommended: true,
      },
      nativeHostAvailable: true,
      anyBrowserAvailable: true,
      anyManifestInstalled: false,
    });

    expect(state.title).toBe("Connected with the official extension");
    expect(state.extensionModeLabel).toBe("Official Web Store");
    expect(state.tone).toBe("success");
  });

  it("labels an explicitly supported unpacked identity as local", () => {
    const state = browserConnectionPresentation({
      runtimeId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      identity: {
        kind: "local_unpacked",
        supported: true,
        production: false,
        recommended: false,
      },
      nativeHostAvailable: true,
      anyBrowserAvailable: true,
      anyManifestInstalled: true,
    });

    expect(state.title).toBe("Connected via local extension");
    expect(state.extensionModeLabel).toBe("Local extension");
  });

  it("warns only when a detected identity is unsupported", () => {
    const state = browserConnectionPresentation({
      runtimeId: "cccccccccccccccccccccccccccccccc",
      identity: {
        kind: "unsupported",
        supported: false,
        production: false,
        recommended: false,
      },
      nativeHostAvailable: true,
      anyBrowserAvailable: true,
      anyManifestInstalled: true,
    });

    expect(state.title).toBe("Extension ID mismatch");
    expect(state.extensionModeLabel).toBe("Unknown");
    expect(state.tone).toBe("warning");
  });

  it("distinguishes a missing host from an extension that has not connected", () => {
    expect(browserConnectionPresentation({
      nativeHostAvailable: false,
      anyBrowserAvailable: true,
      anyManifestInstalled: false,
    }).title).toBe("Native host unavailable");
    expect(browserConnectionPresentation({
      nativeHostAvailable: true,
      anyBrowserAvailable: true,
      anyManifestInstalled: true,
    }).title).toBe("Waiting for extension connection");
  });
});

const profiles: BrowserIntegrationProfile[] = [
  {
    id: "chrome",
    label: "Chrome",
    available: true,
    manifest_installed: true,
    runtime_matches_manifest: true,
    manifest_id_readable: true,
    install_url: "https://chromewebstore.google.com/detail/velocitydl-bridge/id",
    extensions_url: "chrome://extensions",
    setup_hint: "Install from the Chrome Web Store.",
  },
  {
    id: "helium",
    label: "Helium",
    available: true,
    manifest_installed: false,
    runtime_matches_manifest: false,
    manifest_id_readable: false,
    install_url: "https://chromewebstore.google.com/detail/velocitydl-bridge/id",
    extensions_url: "chrome://extensions",
    setup_hint: "Repair Helium registration.",
  },
];

describe("selectBrowserProfile", () => {
  it("selects a named browser and falls back to the only available profile", () => {
    expect(selectBrowserProfile(profiles, "Helium")?.id).toBe("helium");
    expect(selectBrowserProfile([profiles[0]], "chromium")?.id).toBe("chrome");
  });
});

describe("browserSetupInstruction", () => {
  it("names the browser page and app-managed unpacked fallback", () => {
    const instruction = browserSetupInstruction(
      profiles[1],
      String.raw`C:\Users\vikas\AppData\Local\VelocityDL\chromium-extension`,
    );
    expect(instruction).toContain("Helium");
    expect(instruction).toContain("chrome://extensions");
    expect(instruction).toContain("AppData\\Local\\VelocityDL\\chromium-extension");
  });
});
