import { createConnection } from "node:net";
import { createRequire } from "node:module";

const packageJson = `${process.env.CCODEX_HOME}/current/node_modules/@gkorepanov/ccodex/package.json`;
const require = createRequire(packageJson);
const WebSocket = require("ws");

export class GatewayClient {
  #socket;
  #pending = new Map();
  #nextId = 0;
  #requestTimeoutMs;

  constructor(socketPath, { requestTimeoutMs = 240_000 } = {}) {
    this.socketPath = socketPath;
    this.notifications = [];
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async connect() {
    this.#socket = new WebSocket("ws://ccodex-e2e/rpc", {
      createConnection: () => createConnection(this.socketPath),
      maxPayload: 512 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.#socket.on("message", (bytes) => this.#onMessage(bytes));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gateway websocket open timed out")), 30_000);
      this.#socket.once("open", () => { clearTimeout(timer); resolve(); });
      this.#socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    await this.request("initialize", {
      clientInfo: { name: "ccodex-container-e2e", title: "CCodex Container E2E", version: "1" },
      capabilities: { experimentalApi: true },
    });
    this.#socket.send(JSON.stringify({ method: "initialized", params: {} }));
    return this;
  }

  request(method, params = {}) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${this.#requestTimeoutMs}ms`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (!this.#socket) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      this.#socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.#socket.close();
    });
  }

  #onMessage(bytes) {
    const message = JSON.parse(bytes.toString());
    if (message.id !== undefined && message.method) {
      this.#socket.send(JSON.stringify({
        id: message.id,
        result: { decision: "decline", action: "cancel" },
      }));
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? `${pending.method} failed`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.notifications.push(message);
  }
}

export async function connectGateway(socketPath, options) {
  return new GatewayClient(socketPath, options).connect();
}
