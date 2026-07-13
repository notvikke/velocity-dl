import { afterEach, describe, expect, it, vi } from "vitest";
import { getVersion } from "@tauri-apps/api/app";
import { loadAppVersion } from "./app-version";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(),
}));

const getRuntimeVersion = vi.mocked(getVersion);

afterEach(() => {
  getRuntimeVersion.mockReset();
});

describe("loadAppVersion", () => {
  it("returns the installed runtime version from Tauri", async () => {
    getRuntimeVersion.mockResolvedValue(" 0.2.0 ");

    await expect(loadAppVersion()).resolves.toBe("v0.2.0");
  });

  it("uses a neutral value when the runtime version is unavailable", async () => {
    getRuntimeVersion.mockRejectedValue(new Error("Tauri unavailable"));

    await expect(loadAppVersion()).resolves.toBe("v—");
  });
});
