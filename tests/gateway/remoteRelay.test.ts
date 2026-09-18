import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteControlHub } from "../../src/gateway/remoteControlHub.js";
import { startRemoteRelay } from "../../src/gateway/remoteRelay.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("startRemoteRelay", () => {
  afterEach(() => {
    delete process.env.CCODEX_REMOTE_RELAY;
  });

  it("runs pairing commands over the relay's stdio and fails in-flight requests on stop", async () => {
    process.env.CCODEX_REMOTE_RELAY = fileURLToPath(new URL("../fixtures/fakeRemoteRelay.mjs", import.meta.url));
    const hub = new RemoteControlHub();
    const relay = await startRemoteRelay("/tmp/ccodex-fake.sock", hub, logger);
    expect(hub.current()).toMatchObject({ status: "connected", serverName: "fake" });

    await expect(relay.request("remoteControl/pairing/start", { manualCode: true }, "codex_app")).resolves.toEqual({
      echo: { id: 1, method: "remoteControl/pairing/start", params: { manualCode: true }, clientName: "codex_app" },
    });
    await expect(relay.request("remoteControl/pairing/status", {})).rejects.toMatchObject({
      code: -32600,
      message: "exactly one of pairingCode or manualPairingCode is required",
    });

    const hanging = expect(relay.request("hang", null)).rejects.toThrow("Remote-control relay stopped.");
    await relay.stop();
    await hanging;
  });
});
