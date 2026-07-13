import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import defaultConfig from "../src-tauri/tauri.conf.json";
import slimConfig from "../src-tauri/tauri.slim.conf.json";
import fullConfig from "../src-tauri/tauri.full.conf.json";

const tauriConfigs = [defaultConfig, slimConfig, fullConfig];

describe("Windows installer upgrade safety", () => {
  it("stops the browser native host before replacing installed files", () => {
    for (const config of tauriConfigs) {
      expect(config.bundle.windows.nsis?.installerHooks).toBe(
        "windows/installer-hooks.nsh",
      );
    }

    const hookPath = fileURLToPath(
      new URL("../src-tauri/windows/installer-hooks.nsh", import.meta.url),
    );
    const hooks = readFileSync(hookPath, "utf8");

    expect(hooks).toContain("NSIS_HOOK_PREINSTALL");
    expect(hooks).toMatch(/taskkill[^\r\n]*vdl_native_host\.exe/i);
    expect(hooks).not.toContain("MessageBox");
  });
});
