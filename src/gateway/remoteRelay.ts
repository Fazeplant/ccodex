import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RemoteControlStatusChangedNotification } from "../codex/generated/v2/RemoteControlStatusChangedNotification.js";
import type { Logger } from "../observability/logger.js";
import { RpcError } from "../protocol/errors.js";
import type { RemoteControlHub } from "./remoteControlHub.js";

const START_TIMEOUT_MS = 10_000;
const require = createRequire(import.meta.url);

const RELAY_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@gkorepanov/ccodex-relay-darwin-arm64",
  "linux-arm64-gnu": "@gkorepanov/ccodex-relay-linux-arm64-gnu",
  "linux-x64-gnu": "@gkorepanov/ccodex-relay-linux-x64-gnu",
};

export interface RemoteRelay {
  readonly child: ChildProcess;
  /** Runs a pairing request on the relay-owned transport; rejects with an RpcError carrying stock's code. */
  request(method: string, params: unknown, clientName?: string): Promise<unknown>;
  stop(): Promise<void>;
}

interface RelayResponse {
  readonly type: "response";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

type RelayEvent =
  | { readonly type: "status"; readonly params: RemoteControlStatusChangedNotification }
  | { readonly type: "ready" }
  | RelayResponse;

function platformKey(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
}

export function relayBinary(): string {
  const override = process.env.CCODEX_REMOTE_RELAY ?? process.env.CODEX_HYBRID_REMOTE_RELAY;
  if (override) return override;

  const key = platformKey();
  const packageName = RELAY_PACKAGES[key];
  if (packageName) {
    try {
      return join(dirname(require.resolve(`${packageName}/package.json`)), "bin", "ccodex-relay");
    } catch {
      // Source builds keep a local relay next to compiled JavaScript.
    }
  }

  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ccodex-relay");
  if (existsSync(local)) return local;
  throw new Error(
    `CCodex relay package for '${key}' is missing. Reinstall @gkorepanov/ccodex with optional dependencies enabled.`,
  );
}

export async function startRemoteRelay(
  socketPath: string,
  hub: RemoteControlHub,
  logger: Logger,
): Promise<RemoteRelay> {
  const binary = relayBinary();
  if (!existsSync(binary)) throw new Error(`CCodex remote-control relay binary was not found: ${binary}`);
  const env: NodeJS.ProcessEnv = { RUST_LOG: "warn", ...process.env };
  delete env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED;
  const child = spawn(binary, ["--socket", socketPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stopping = false;
  let nextRequestId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(() => readyReject(new Error("Timed out starting remote-control relay.")), START_TIMEOUT_MS);

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const event = JSON.parse(line) as RelayEvent;
        if (event.type === "status") hub.update(event.params);
        if (event.type === "ready") readyResolve();
        if (event.type === "response") {
          const request = pending.get(event.id);
          pending.delete(event.id);
          if (event.error) request?.reject(new RpcError(event.error.code, event.error.message));
          else request?.resolve(event.result);
        }
      } catch (error) {
        logger.warn("remote-relay.stdout.invalid", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => logger.warn("remote-relay.stderr", { line: chunk.toString("utf8").trimEnd() }));
  child.once("error", (error) => readyReject(error));
  child.once("exit", (code, signal) => {
    failPending(new Error("Remote-control relay exited."));
    if (!stopping) {
      const error = new Error(`Remote-control relay exited unexpectedly (${signal ?? code ?? "unknown"}).`);
      readyReject(error);
      logger.error("remote-relay.exited", { code, signal });
      process.kill(process.pid, "SIGTERM");
    }
  });

  try {
    await ready;
  } catch (error) {
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  logger.info("remote-relay.started", { pid: child.pid, socketPath });

  return {
    child,
    request(method, params, clientName) {
      const id = ++nextRequestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin?.write(`${JSON.stringify({ id, method, params, clientName })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      });
    },
    async stop(): Promise<void> {
      stopping = true;
      failPending(new Error("Remote-control relay stopped."));
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            resolve();
          }, 3_000)),
        ]);
      }
      logger.info("remote-relay.stopped", { pid: child.pid });
    },
  };
}
