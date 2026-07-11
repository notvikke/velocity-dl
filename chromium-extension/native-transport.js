const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_IN_FLIGHT = 4;

export class NativeTransport {
  constructor({ connect, maxInFlight = DEFAULT_MAX_IN_FLIGHT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof connect !== "function") throw new TypeError("NativeTransport requires connect()");
    this.connect = connect;
    this.maxInFlight = Math.max(1, maxInFlight);
    this.timeoutMs = Math.max(1, timeoutMs);
    this.port = null;
    this.queue = [];
    this.pending = new Map();
    this.sequence = 0;
  }

  request(message) {
    return new Promise((resolve, reject) => {
      this.queue.push({ message, resolve, reject });
      this.drain();
    });
  }

  ensurePort() {
    if (this.port) return this.port;
    const port = this.connect();
    this.port = port;
    port.onMessage.addListener((message) => this.handleMessage(message));
    port.onDisconnect.addListener(() => this.handleDisconnect(port));
    return port;
  }

  drain() {
    while (this.queue.length && this.pending.size < this.maxInFlight) {
      let port;
      try {
        port = this.ensurePort();
      } catch (error) {
        const queued = this.queue.shift();
        queued.reject(error);
        continue;
      }
      const queued = this.queue.shift();
      const transportId = `native-${Date.now()}-${++this.sequence}`;
      const timer = setTimeout(() => {
        const pending = this.pending.get(transportId);
        if (!pending) return;
        this.pending.delete(transportId);
        pending.reject(new Error(`Native request '${pending.action}' timed out`));
        this.drain();
      }, this.timeoutMs);
      this.pending.set(transportId, {
        resolve: queued.resolve,
        reject: queued.reject,
        timer,
        action: queued.message?.action || "unknown",
      });
      try {
        port.postMessage({ ...queued.message, transport_id: transportId });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(transportId);
        queued.reject(error);
        this.port = null;
      }
    }
  }

  handleMessage(message) {
    const transportId = message?.transport_id;
    const pending = this.pending.get(transportId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(transportId);
    pending.resolve(message);
    this.drain();
  }

  handleDisconnect(port) {
    if (this.port !== port) return;
    this.port = null;
    const error = new Error("Native messaging port disconnected");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.drain();
  }
}
