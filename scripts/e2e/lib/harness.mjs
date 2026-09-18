import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { connectGateway } from "./gateway.mjs";
import { sameSnapshots, sqliteSnapshots } from "./sqlite.mjs";

const execute = promisify(execFile);

export const home = process.env.HOME;
export const ccodexHome = process.env.CCODEX_HOME;
export const codexHome = process.env.CODEX_HOME;
export const projectsDir = join(process.env.CLAUDE_CONFIG_DIR, "projects");
export const stateDir = join(ccodexHome, "state");
export const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
export const ccodexBin = join(ccodexHome, "bin", "ccodex");

export function truncateId(id) {
  return typeof id === "string" ? `${id.slice(0, 8)}…` : null;
}

export function sanitize(value) {
  return String(value)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, (id) => `${id.slice(0, 8)}…`)
    .replace(/(?:\/[A-Za-z0-9_.@+,:=-]+){2,}/gu, "<path>")
    .replace(/(?:^|\s)-home-[^\s'"`]+/gu, " <project-key>")
    .slice(0, 4_000);
}

export function safeError(error, method, paramsShape) {
  return {
    method,
    paramsShape,
    code: error?.code ?? null,
    message: sanitize(error?.message ?? error),
  };
}

export async function daemon(command, { allowFailure = false } = {}) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await execute(ccodexBin, ["app-server", "daemon", command], {
      env: process.env,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      durationMs: Math.round(performance.now() - started),
      output: stdout.trim() ? JSON.parse(stdout) : {},
      stderr: sanitize(stderr),
    };
  } catch (error) {
    const result = {
      ok: false,
      durationMs: Math.round(performance.now() - started),
      error: sanitize(error?.stderr || error?.message || error),
    };
    if (!allowFailure) throw Object.assign(new Error(result.error), { daemonResult: result });
    return result;
  }
}

export async function daemonLogEvidence(maxLines = 12) {
  const path = join(codexHome, "app-server-daemon", "app-server.stderr.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-maxLines).map(sanitize);
}

export async function startGateway() {
  const startedAt = performance.now();
  const start = await daemon("start");
  const client = await connectGateway(socketPath);
  return { client, start, startedAt };
}

export async function stopGateway(client) {
  await client?.close().catch(() => undefined);
  return daemon("stop", { allowFailure: true });
}

export function rootTranscripts() {
  const sessions = [];
  for (const project of readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const directory = join(projectsDir, project.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(directory, entry.name);
      sessions.push({ id: basename(entry.name, ".jsonl"), path, size: statSync(path).size });
    }
  }
  return sessions.sort((left, right) => left.id.localeCompare(right.id));
}

export function stableRandom(sessions, count, excluded = new Set()) {
  return sessions
    .filter(({ id }) => !excluded.has(id))
    .map((session) => ({ session, key: createHash("sha256").update(`ccodex-e2e:${session.id}`).digest("hex") }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, count)
    .map(({ session }) => session);
}

export async function countRecordType(path, wanted) {
  let count = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes(`\"type\":\"${wanted}\"`) && !line.includes(`\"type\": \"${wanted}\"`)) continue;
    try { if (JSON.parse(line).type === wanted) count += 1; } catch {}
  }
  return count;
}

export async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export async function pagedThreads(client, params = {}) {
  const data = [];
  let cursor = params.cursor ?? null;
  do {
    const response = await client.request("thread/list", { ...params, cursor });
    data.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  return data;
}

export function setEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function projectionOk(thread) {
  const itemIds = [];
  const turnsOk = thread.turns.length > 0 && thread.turns.every((turn) => {
    itemIds.push(...turn.items.map((item) => item.id));
    return turn.items.length > 0 && turn.items[0].type === "userMessage";
  });
  return turnsOk && new Set(itemIds).size === itemIds.length;
}

export function readOnlyGuard() {
  let baseline = sqliteSnapshots(stateDir);
  const observations = [];
  return {
    async step(name, operation) {
      const started = performance.now();
      const value = await operation();
      const after = sqliteSnapshots(stateDir);
      observations.push({ name, ok: sameSnapshots(baseline, after), durationMs: Math.round(performance.now() - started) });
      baseline = after;
      return value;
    },
    observations,
  };
}

export async function eventually(operation, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  let error;
  while (Date.now() < deadline) {
    try {
      value = await operation();
      if (predicate(value)) return value;
    } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (error) throw error;
  throw new Error("condition did not become true before timeout");
}

export function finish(scenario, checks, timings, evidence = []) {
  const report = { scenario, ok: checks.every((check) => check.ok), checks, timings, evidence };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
