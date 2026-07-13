import { describe, expect, it } from "vitest";
import defaultConfig from "../../src-tauri/tauri.conf.json";
import slimConfig from "../../src-tauri/tauri.slim.conf.json";
import fullConfig from "../../src-tauri/tauri.full.conf.json";

const tauriConfigs = [defaultConfig, slimConfig, fullConfig];

describe("Tauri release version configuration", () => {
  it("uses the root package version for every Windows bundle", () => {
    for (const config of tauriConfigs) {
      expect(config.version).toBe("../package.json");
    }
  });
});
