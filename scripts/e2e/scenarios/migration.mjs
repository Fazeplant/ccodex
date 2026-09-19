import { countRecordType, daemonLogEvidence, finish, pagedThreads, rootTranscripts,
  safeError, setEqual, startGateway, stateDir, stopGateway, transcriptAssistantMessageIds,
  truncateId } from "../lib/harness.mjs";
import { changedTables, openReadonly, sqliteSnapshots } from "../lib/sqlite.mjs";

const scenario = "migration";
const checks = [];
const timings = { firstListMs: null, daemonStartMs: null, reads: [], resumes: [], restartMs: null };
const evidence = [];
let client;

function add(name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), details });
}

const droppedHistoryTables = [
  "events", "provider_events", "processed_provider_events", "provider_item_correlations",
  "pending_requests", "thread_queues",
];
const allowedRowCountChanges = new Set([
  "state.sqlite:threads",
  "state.sqlite:claude_session_flags",
  "state.sqlite:goals",
  "state.sqlite:goal_checkpoints",
  "state.sqlite:section_orders",
  "state.sqlite:pending_thread_removals",
  "handoffs.sqlite:lineage_tasks",
  "handoffs.sqlite:lineage_epochs",
  "handoffs.sqlite:lineage_segments",
]);
const userUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/*
 * Stage 3 expectations exercised here:
 * - migration 14 exists and removes the event/provider/pending/queue tables;
 * - every eligible legacy thread is read and resumed without changing history row counts;
 *   only retained settings, flags, goals, or lineage tables are allowed to change;
 * - transcript-backed legacy history uses projected IDs: user-record UUIDs for turns and
 *   `<message.id>:<apiBlockIndex>` for assistant text/reasoning items.
 */

function projectedIdShape(thread, nativeMessageIds) {
  return thread.turns.every((turn) => userUuid.test(turn.id)
    && turn.items.filter((item) => item.type === "agentMessage" || item.type === "reasoning")
      .every((item) => {
        const separator = item.id.lastIndexOf(":");
        return separator > 0 && /^\d+$/u.test(item.id.slice(separator + 1))
          && nativeMessageIds.has(item.id.slice(0, separator));
      }));
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
  const hasMigration14 = database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 14").get().count;
  const remainingDroppedTables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name IN (${droppedHistoryTables.map(() => "?").join(",")})
    ORDER BY name
  `).all(...droppedHistoryTables).map(({ name }) => name);
  const actualFlagCount = database.prepare("SELECT count(*) AS count FROM claude_session_flags").get().count;
  database.close();
  add("schema_migration_14", Number(hasMigration14) === 1, { present: Number(hasMigration14) === 1 });
  add("stage3_history_tables_dropped", remainingDroppedTables.length === 0, {
    expectedAbsent: droppedHistoryTables,
    unexpectedlyPresent: remainingDroppedTables,
  });
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

  const eligible = rootRows.filter((thread) => !thread.ephemeral && !logicalBackendIds.has(thread.id));
  const withTranscript = eligible.filter((thread) => transcriptById.has(thread.sessionId));
  const withoutTranscript = eligible.filter((thread) => !transcriptById.has(thread.sessionId));
  const assistantMessageIds = new Map();
  for (const thread of withTranscript) {
    if (!assistantMessageIds.has(thread.sessionId)) {
      assistantMessageIds.set(thread.sessionId,
        await transcriptAssistantMessageIds(transcriptById.get(thread.sessionId).path));
    }
  }
  add("legacy_resume_sample_available", withTranscript.length >= 3 && withoutTranscript.length >= 2, {
    withTranscript: withTranscript.length,
    withoutTranscript: withoutTranscript.length,
  });
  let rowCountBaseline = sqliteSnapshots(stateDir);
  const unexpectedRowCountChanges = [];
  const idShapeFailures = [];
  const resumeFailures = [];
  const readFailures = [];
  for (const thread of eligible) {
    let started = performance.now();
    try {
      const read = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
      if (read.thread.id !== thread.id) readFailures.push(truncateId(thread.id));
      if (transcriptById.has(thread.sessionId)
        && !projectedIdShape(read.thread, assistantMessageIds.get(thread.sessionId))) idShapeFailures.push(truncateId(thread.id));
    } catch (error) {
      readFailures.push(truncateId(thread.id));
      evidence.push(safeError(error, "thread/read", { threadId: "<id>", includeTurns: true }));
    }
    timings.reads.push({ id: truncateId(thread.id), transcript: transcriptById.has(thread.sessionId), ms: Math.round(performance.now() - started) });
    let after = sqliteSnapshots(stateDir);
    const readChanges = changedTables(rowCountBaseline, after).filter((name) => !allowedRowCountChanges.has(name));
    if (readChanges.length > 0) unexpectedRowCountChanges.push({ operation: "read", id: truncateId(thread.id), tables: readChanges });
    rowCountBaseline = after;

    started = performance.now();
    try {
      const resumed = await client.request("thread/resume", { threadId: thread.id, excludeTurns: false });
      timings.resumes.push({ id: truncateId(thread.id), transcript: transcriptById.has(thread.sessionId), ms: Math.round(performance.now() - started) });
      if (resumed.thread.id !== thread.id) resumeFailures.push(truncateId(thread.id));
      if (transcriptById.has(thread.sessionId)
        && !projectedIdShape(resumed.thread, assistantMessageIds.get(thread.sessionId))) idShapeFailures.push(truncateId(thread.id));
    } catch (error) {
      resumeFailures.push(truncateId(thread.id));
      evidence.push(safeError(error, "thread/resume", { threadId: "<id>", excludeTurns: false }));
    }
    after = sqliteSnapshots(stateDir);
    const resumeChanges = changedTables(rowCountBaseline, after).filter((name) => !allowedRowCountChanges.has(name));
    if (resumeChanges.length > 0) unexpectedRowCountChanges.push({ operation: "resume", id: truncateId(thread.id), tables: resumeChanges });
    rowCountBaseline = after;
  }
  add("legacy_read", readFailures.length === 0, { attempted: eligible.length, failedIds: [...new Set(readFailures)] });
  add("legacy_resume", resumeFailures.length === 0, {
    attempted: eligible.length,
    failedIds: [...new Set(resumeFailures)],
  });
  add("legacy_projected_id_shapes", idShapeFailures.length === 0, {
    checked: withTranscript.length,
    failedIds: [...new Set(idShapeFailures)],
  });
  add("all_legacy_read_resume_history_counts_unchanged", unexpectedRowCountChanges.length === 0, {
    operations: eligible.length * 2,
    failures: unexpectedRowCountChanges,
    ignoredAbsentTables: droppedHistoryTables,
    allowedClasses: ["settings", "flags", "goals", "lineage"],
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
  const restartChanges = changedTables(beforeRestartCounts, afterRestartCounts)
    .filter((name) => !allowedRowCountChanges.has(name));
  add("restart_history_counts_unchanged", restartChanges.length === 0, {
    unchanged: restartChanges.length === 0,
    unexpectedChangedTables: restartChanges,
    ignoredAbsentTables: droppedHistoryTables,
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
