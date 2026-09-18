#!/usr/bin/env node
// Fake ccodex relay: speaks the gateway<->relay stdio protocol without a real transport.
import { createInterface } from "node:readline";

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "status", params: { status: "connected", serverName: "fake", installationId: "i", environmentId: "e" } });
emit({ type: "ready" });

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.method === "remoteControl/pairing/status") {
    emit({ type: "response", id: command.id, error: { code: -32600, message: "exactly one of pairingCode or manualPairingCode is required" } });
  } else if (command.method === "hang") {
    // never answered: exercises rejection of in-flight requests on stop()
  } else {
    emit({ type: "response", id: command.id, result: { echo: command } });
  }
});
process.on("SIGINT", () => process.exit(0));
