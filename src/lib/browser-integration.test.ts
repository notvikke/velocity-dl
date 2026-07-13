import { describe, expect, it } from "vitest";
import {
  browserSetupInstruction,
  selectBrowserProfile,
  type BrowserIntegrationProfile,
} from "./browser-integration";

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
