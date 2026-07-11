import { describe, expect, it, vi } from "vitest";

import { NativeTransport } from "./native-transport.js";

function fakePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    sent: [],
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    postMessage(message) { this.sent.push(message); },
    respond(message) { messageListeners.forEach((listener) => listener(message)); },
    disconnectNow() { disconnectListeners.forEach((listener) => listener()); },
  };
}

describe("NativeTransport", () => {
  it("correlates out-of-order native responses", async () => {
    const port = fakePort();
    const transport = new NativeTransport({ connect: () => port, maxInFlight: 2 });
    const first = transport.request({ action: "capture", url: "https://e.test/1" });
    const second = transport.request({ action: "capture", url: "https://e.test/2" });
    expect(port.sent).toHaveLength(2);

    port.respond({ transport_id: port.sent[1].transport_id, ok: true, message: "two" });
    port.respond({ transport_id: port.sent[0].transport_id, ok: true, message: "one" });

    await expect(first).resolves.toMatchObject({ message: "one" });
    await expect(second).resolves.toMatchObject({ message: "two" });
  });

  it("applies FIFO backpressure at the configured in-flight limit", async () => {
    const port = fakePort();
    const transport = new NativeTransport({ connect: () => port, maxInFlight: 1 });
    const first = transport.request({ action: "capture", url: "https://e.test/1" });
    const second = transport.request({ action: "capture", url: "https://e.test/2" });
    expect(port.sent).toHaveLength(1);
    port.respond({ transport_id: port.sent[0].transport_id, ok: true });
    await first;
    expect(port.sent).toHaveLength(2);
    port.respond({ transport_id: port.sent[1].transport_id, ok: true });
    await second;
  });

  it("rejects in-flight requests on disconnect and reconnects for queued work", async () => {
    const firstPort = fakePort();
    const secondPort = fakePort();
    const connect = vi.fn().mockReturnValueOnce(firstPort).mockReturnValueOnce(secondPort);
    const transport = new NativeTransport({ connect, maxInFlight: 1 });
    const first = transport.request({ action: "ping" });
    const second = transport.request({ action: "get_preferences" });
    firstPort.disconnectNow();
    await expect(first).rejects.toThrow("disconnected");
    expect(secondPort.sent).toHaveLength(1);
    secondPort.respond({ transport_id: secondPort.sent[0].transport_id, ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("times out and releases a queue slot", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const transport = new NativeTransport({ connect: () => port, maxInFlight: 1, timeoutMs: 50 });
    const first = transport.request({ action: "ping" });
    const firstExpectation = expect(first).rejects.toThrow("timed out");
    const second = transport.request({ action: "get_preferences" });
    await vi.advanceTimersByTimeAsync(51);
    await firstExpectation;
    expect(port.sent).toHaveLength(2);
    port.respond({ transport_id: port.sent[1].transport_id, ok: true });
    await second;
    vi.useRealTimers();
  });
});
