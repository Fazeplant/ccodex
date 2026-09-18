import { existsSync } from "node:fs";
import { countRecordType, daemonLogEvidence, finish, pagedThreads, projectionOk, rootTranscripts,
  safeError, setEqual, startGateway, stateDir, stopGateway, truncateId } from "../lib/harness.mjs";
import { changedTables, openReadonly, sameSnapshots, sqliteSnapshots } from "../lib/sqlite.mjs";

const scenario = "migration";
const checks = [];
const timings = { firstListMs: null, daemonStartMs: null, resumes: [], restartMs: null };
const evidence = [];
let client;

function add(name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), details });
}

function backupThreads(path) {
  const database = openReadonly(path);
  try {
    return database.prepare(`
      SELECT id, claude_session_id, archived, ephemeral, thread_json
      FROM threads
    `).all().map((row) => {
      const thread = JSON.parse(row.thread_json);
      return {
        id: row.id,
        sessionId: row.claude_session_id,
        archived: Number(row.archived) !== 0,
        ephemeral: Number(row.ephemeral) !== 0,
        root: thread.parentThreadId == null,
        section: thread.section ?? null,
        namePresent: thread.name != null,
      };
    });
  } finally {
    database.close();
  }
}

async function customTitleTotal(candidates, transcriptById) {
  let count = 0;
  for (const thread of candidates) count += await countRecordType(transcriptById.get(thread.sessionId).path, "custom-title");
  return count;
}

try {
  const statePath = `${stateDir}/state.sqlite`;
  const rows = backupThreads(statePath);
  const rootRows = rows.filter(({ root }) => root);
  const sessions = rootTranscripts();
  const transcriptById = new Map(sessions.map((session) => [session.id, session]));
  const diskIds = new Set(transcriptById.keys());
  const referencedSessionIds = new Set(rows.map(({ sessionId }) => sessionId));
  const aliases = rootRows.filter(({ id, sessionId }) => id !== sessionId);
  const expectedFlagCount = rootRows.filter((thread) =>
    thread.id !== thread.sessionId || thread.archived || thread.ephemeral || thread.section !== null).length;

  const titleCandidates = rootRows.filter((thread) =>
    !thread.ephemeral && thread.namePresent && transcriptById.has(thread.sessionId));
  let expectedTitleAppends = 0;
  for (const thread of titleCandidates) {
    if (await countRecordType(transcriptById.get(thread.sessionId).path, "custom-title") === 0) expectedTitleAppends += 1;
  }
  const titleCountBefore = await customTitleTotal(titleCandidates, transcriptById);

  const expectedActive = new Set(rootRows
    .filter(({ archived, ephemeral }) => !archived && !ephemeral)
    .map(({ id }) => id));
  for (const id of diskIds) if (!referencedSessionIds.has(id)) expectedActive.add(id);
  const handoffs = openReadonly(`${stateDir}/handoffs.sqlite`);
  const claudeEpochs = handoffs.prepare(`
    SELECT public_thread_id, backend_thread_id, state
    FROM lineage_epochs
    WHERE provider = 'claude'
  `).all();
  handoffs.close();
  const logicalBackendIds = new Set(claudeEpochs.map(({ backend_thread_id }) => backend_thread_id));
  for (const { public_thread_id, backend_thread_id, state } of claudeEpochs) {
    if (!expectedActive.delete(backend_thread_id)) continue;
    if (state === "current") expectedActive.add(public_thread_id);
  }

  const startup = await startGateway();
  client = startup.client;
  timings.daemonStartMs = startup.start.durationMs;
  const database = openReadonly(statePath);
  const hasMigration13 = database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 13").get().count;
  const actualFlagCount = database.prepare("SELECT count(*) AS count FROM claude_session_flags").get().count;
  database.close();
  add("schema_migration_13", Number(hasMigration13) === 1, { present: Number(hasMigration13) === 1 });
  add("migration_13_flag_backfill", Number(actualFlagCount) === expectedFlagCount, {
    expected: expectedFlagCount,
    actual: Number(actualFlagCount),
  });

  const titleCountAfter = await customTitleTotal(titleCandidates, transcriptById);
  const actualTitleAppends = titleCountAfter - titleCountBefore;
  add("native_title_backfill", actualTitleAppends === expectedTitleAppends, {
    expected: expectedTitleAppends,
    actual: actualTitleAppends,
    candidates: titleCandidates.length,
  });

  const listed = await pagedThreads(client, { archived: false, limit: 100 });
  timings.firstListMs = Math.round(performance.now() - startup.startedAt);
  const listedIds = listed.map(({ id }) => id);
  const aliasSessionIds = new Set(aliases.map(({ sessionId }) => sessionId));
  add("migrated_thread_list", setEqual(new Set(listedIds), expectedActive), {
    expected: expectedActive.size,
    actual: listedIds.length,
    missing: [...expectedActive].filter((id) => !listedIds.includes(id)).map(truncateId),
    unexpected: listedIds.filter((id) => !expectedActive.has(id)).map(truncateId),
  });
  add("migrated_thread_list_no_duplicates", new Set(listedIds).size === listedIds.length, {
    count: listedIds.length,
    unique: new Set(listedIds).size,
  });
  add("alias_session_ids_hidden", listedIds.every((id) => !aliasSessionIds.has(id)), {
    aliasRows: aliases.length,
    leaked: listedIds.filter((id) => aliasSessionIds.has(id)).map(truncateId),
  });

  const withTranscript = rootRows.filter((thread) =>
    !thread.ephemeral && !logicalBackendIds.has(thread.id) && transcriptById.has(thread.sessionId)).slice(0, 3);
  const withoutTranscript = rootRows.filter((thread) =>
    !thread.ephemeral && !logicalBackendIds.has(thread.id) && !transcriptById.has(thread.sessionId)).slice(0, 2);
  add("legacy_resume_sample_available", withTranscript.length === 3 && withoutTranscript.length === 2, {
    withTranscript: withTranscript.length,
    withoutTranscript: withoutTranscript.length,
  });
  const countsBeforeResume = sqliteSnapshots(stateDir);
  const resumeFailures = [];
  for (const thread of [...withTranscript, ...withoutTranscript]) {
    const started = performance.now();
    try {
      const resumed = await client.request("thread/resume", { threadId: thread.id, excludeTurns: false });
      timings.resumes.push({ id: truncateId(thread.id), transcript: transcriptById.has(thread.sessionId), ms: Math.round(performance.now() - started) });
      if (resumed.thread.id !== thread.id) resumeFailures.push(truncateId(thread.id));
      if (transcriptById.has(thread.sessionId) && !projectionOk(resumed.thread)) resumeFailures.push(truncateId(thread.id));
    } catch (error) {
      resumeFailures.push(truncateId(thread.id));
      evidence.push(safeError(error, "thread/resume", { threadId: "<id>", excludeTurns: false }));
    }
  }
  const countsAfterResume = sqliteSnapshots(stateDir);
  add("legacy_resume", resumeFailures.length === 0, {
    attempted: withTranscript.length + withoutTranscript.length,
    failedIds: [...new Set(resumeFailures)],
  });
  // Stage 3 removes the legacy event/provider journals. Stage 2 only promises that
  // resuming a SQLite-owned thread does not rewrite its core stored history.
  const resumeChanges = changedTables(countsBeforeResume, countsAfterResume);
  const coreHistoryChanges = resumeChanges.filter((name) => [
    "state.sqlite:threads", "state.sqlite:turns", "state.sqlite:items",
  ].includes(name));
  add("legacy_resume_core_history_read_only", coreHistoryChanges.length === 0, {
    unchanged: coreHistoryChanges.length === 0,
    changedTables: resumeChanges,
    assertedTables: ["state.sqlite:threads", "state.sqlite:turns", "state.sqlite:items"],
  });

  const beforeRestartTitles = await customTitleTotal(titleCandidates, transcriptById);
  const beforeRestartCounts = sqliteSnapshots(stateDir);
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
  const afterRestartTitles = await customTitleTotal(titleCandidates, transcriptById);
  const afterRestartCounts = sqliteSnapshots(stateDir);
  add("title_backfill_idempotent", afterRestartTitles === beforeRestartTitles, {
    appendedOnRestart: afterRestartTitles - beforeRestartTitles,
  });
  add("restart_row_counts_unchanged", sameSnapshots(beforeRestartCounts, afterRestartCounts), {
    unchanged: sameSnapshots(beforeRestartCounts, afterRestartCounts),
    stopOk: stopped.ok,
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
