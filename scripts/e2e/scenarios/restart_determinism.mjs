import { daemonLogEvidence, finish, rootTranscripts, safeError, stableRandom, startGateway,
  stopGateway, truncateId } from "../lib/harness.mjs";

const scenario = "restart_determinism";
const checks = [];
const timings = { daemonStartMs: null, restartMs: null, resumesBefore: [], resumesAfter: [] };
const evidence = [];
let client;

function add(name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), details });
}

function identity(thread) {
  return {
    thread: thread.id,
    turns: thread.turns.map((turn) => ({
      id: turn.id,
      items: turn.items.map((item) => item.id),
    })),
  };
}

try {
  const selected = stableRandom(rootTranscripts(), 5);
  add("resume_sample_available", selected.length === 5, { count: selected.length });
  const startup = await startGateway();
  client = startup.client;
  timings.daemonStartMs = startup.start.durationMs;
  const before = new Map();
  const beforeFailures = [];
  for (const session of selected) {
    const started = performance.now();
    try {
      const resumed = await client.request("thread/resume", { threadId: session.id, excludeTurns: false });
      before.set(session.id, identity(resumed.thread));
    } catch (error) {
      beforeFailures.push(truncateId(session.id));
      evidence.push(safeError(error, "thread/resume", { threadId: "<id>", excludeTurns: false, phase: "before" }));
    }
    timings.resumesBefore.push({ id: truncateId(session.id), ms: Math.round(performance.now() - started) });
  }
  add("resume_before_restart", beforeFailures.length === 0, { attempted: selected.length, failedIds: beforeFailures });

  const stopped = await stopGateway(client);
  client = undefined;
  add("daemon_stop_for_restart", stopped.ok, stopped.ok
    ? { durationMs: stopped.durationMs }
    : { durationMs: stopped.durationMs, error: stopped.error });
  if (!stopped.ok) evidence.push({ method: "ccodex app-server daemon stop", paramsShape: [], error: stopped.error });
  const restartStarted = performance.now();
  const restarted = await startGateway();
  client = restarted.client;
  timings.restartMs = Math.round(performance.now() - restartStarted);
  const mismatches = [];
  const afterFailures = [];
  for (const session of selected) {
    const started = performance.now();
    try {
      const resumed = await client.request("thread/resume", { threadId: session.id, excludeTurns: false });
      if (!before.has(session.id) || JSON.stringify(before.get(session.id)) !== JSON.stringify(identity(resumed.thread))) {
        mismatches.push(truncateId(session.id));
      }
    } catch (error) {
      afterFailures.push(truncateId(session.id));
      evidence.push(safeError(error, "thread/resume", { threadId: "<id>", excludeTurns: false, phase: "after" }));
    }
    timings.resumesAfter.push({ id: truncateId(session.id), ms: Math.round(performance.now() - started) });
  }
  add("resume_after_restart", afterFailures.length === 0, { attempted: selected.length, failedIds: afterFailures });
  add("thread_turn_item_ids_deterministic", beforeFailures.length === 0 && afterFailures.length === 0 && mismatches.length === 0, {
    checked: selected.length,
    mismatchedIds: mismatches,
    blockedResumes: beforeFailures.length + afterFailures.length,
  });
} catch (error) {
  add("scenario_completed", false, safeError(error, "scenario", {}));
  evidence.push(safeError(error, "scenario", {}));
  evidence.push(...(await daemonLogEvidence()).map((line) => ({ daemonLog: line })));
} finally {
  const stopped = await stopGateway(client);
  add("daemon_final_stop", stopped.ok, stopped.ok
    ? { durationMs: stopped.durationMs }
    : { durationMs: stopped.durationMs, error: stopped.error });
  if (!stopped.ok) evidence.push({ method: "ccodex app-server daemon stop", paramsShape: [], error: stopped.error });
}

finish(scenario, checks, timings, evidence);
