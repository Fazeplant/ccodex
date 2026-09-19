import { existsSync, statSync } from "node:fs";
import { changedTables, sqliteSnapshots } from "../lib/sqlite.mjs";
import { openReadonly } from "../lib/sqlite.mjs";
import {
  countRecordSubtype, countRecordType, daemon, daemonLogEvidence, eventually, fileHash, finish, pagedThreads,
  projectionOk, readOnlyGuard, rootTranscripts, safeError, setEqual, startGateway,
  stateDir, stopGateway, truncateId,
} from "../lib/harness.mjs";

const scenario = "fresh_install";
const checks = [];
const timings = {
  firstListMs: null,
  daemonStartMs: null,
  largestTranscriptResumeMs: null,
  rollbackMs: null,
  stopStartMs: null,
  reads: [],
  resumes: [],
};
const evidence = [];
let client;

function add(name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), details });
}

function count(snapshot, table) {
  return snapshot["state.sqlite"]?.[table] ?? 0;
}

/*
 * Stage 3 expectations exercised here:
 * - read/resume are transcript projections and may not change SQLite row counts for any copied session;
 * - non-empty rollback is a process-local anchor, so it leaves the transcript untouched and is lost on restart;
 * - zero-prefix rollback deletes the copied native transcript instead of rewriting it.
 * No model turn is sent by this scenario.
 */

try {
  const sessions = rootTranscripts();
  const expectedIds = new Set(sessions.map(({ id }) => id));
  add("root_transcripts_discovered", sessions.length > 0, { count: sessions.length });

  const startup = await startGateway();
  client = startup.client;
  timings.daemonStartMs = startup.start.durationMs;
  const version = await daemon("version", { allowFailure: true });
  add("daemon_version", version.ok, version.ok
    ? { durationMs: version.durationMs }
    : { durationMs: version.durationMs, error: version.error });
  if (!version.ok) evidence.push({ method: "ccodex app-server daemon version", paramsShape: [], error: version.error });

  const guard = readOnlyGuard();
  const unfiltered = await guard.step("thread/list no filters", () => pagedThreads(client, { limit: 100 }));
  timings.firstListMs = Math.round(performance.now() - startup.startedAt);
  const active = await guard.step("thread/list archived:false", () => pagedThreads(client, { archived: false, limit: 100 }));

  const unfilteredIds = unfiltered.map(({ id }) => id);
  const activeIds = active.map(({ id }) => id);
  add("thread_list_exact_disk_set", setEqual(new Set(unfilteredIds), expectedIds)
    && setEqual(new Set(activeIds), expectedIds), {
    diskCount: expectedIds.size,
    unfilteredCount: unfilteredIds.length,
    activeCount: activeIds.length,
  });
  add("thread_list_no_duplicates", new Set(unfilteredIds).size === unfilteredIds.length
    && new Set(activeIds).size === activeIds.length, {
    unfilteredUnique: new Set(unfilteredIds).size,
    activeUnique: new Set(activeIds).size,
  });
  add("thread_list_metadata", active.every((thread) =>
    thread.modelProvider === "claude"
      && thread.source === "vscode"
      && typeof thread.cwd === "string" && thread.cwd.length > 0
      && thread.createdAt <= thread.updatedAt
      && Boolean(thread.name || thread.preview)), { checked: active.length });

  const bySize = [...sessions].sort((left, right) => right.size - left.size);
  const largest = bySize[0];
  const selected = bySize;
  let rollbackTarget;
  for (const session of selected) {
    if (await countRecordType(session.path, "user") >= 2
      && await countRecordSubtype(session.path, "system", "compact_boundary") === 0) {
      rollbackTarget = session;
      break;
    }
  }
  const projectionFailures = [];
  const projected = new Map();
  for (const session of selected) {
    let started = performance.now();
    try {
      const metadata = await guard.step(`thread/read false ${truncateId(session.id)}`, () =>
        client.request("thread/read", { threadId: session.id, includeTurns: false }));
      if (metadata.thread.id !== session.id) projectionFailures.push(truncateId(session.id));
    } catch (error) {
      projectionFailures.push(truncateId(session.id));
      evidence.push(safeError(error, "thread/read", { threadId: "<id>", includeTurns: false }));
    }
    timings.reads.push({ id: truncateId(session.id), includeTurns: false, ms: Math.round(performance.now() - started) });

    started = performance.now();
    try {
      const full = await guard.step(`thread/read true ${truncateId(session.id)}`, () =>
        client.request("thread/read", { threadId: session.id, includeTurns: true }));
      projected.set(session.id, full.thread);
      if (full.thread.id !== session.id || !projectionOk(full.thread)) projectionFailures.push(truncateId(session.id));
    } catch (error) {
      projectionFailures.push(truncateId(session.id));
      evidence.push(safeError(error, "thread/read", { threadId: "<id>", includeTurns: true }));
    }
    timings.reads.push({ id: truncateId(session.id), includeTurns: true, ms: Math.round(performance.now() - started) });

    if (session.id !== rollbackTarget?.id) {
      started = performance.now();
      try {
        const resumed = await guard.step(`thread/resume ${truncateId(session.id)}`, () =>
          client.request("thread/resume", { threadId: session.id, excludeTurns: false }));
        if (resumed.thread.id !== session.id) projectionFailures.push(truncateId(session.id));
      } catch (error) {
        projectionFailures.push(truncateId(session.id));
        evidence.push(safeError(error, "thread/resume", { threadId: "<id>", excludeTurns: false }));
      }
      const resumeMs = Math.round(performance.now() - started);
      timings.resumes.push({ id: truncateId(session.id), ms: resumeMs });
      if (session.id === largest.id) timings.largestTranscriptResumeMs = resumeMs;
    }
  }

  let zeroPrefixTarget;
  for (const session of selected) {
    if (session.id !== rollbackTarget?.id && projected.get(session.id)?.turns.length >= 1
      && await countRecordSubtype(session.path, "system", "compact_boundary") === 0) {
      zeroPrefixTarget = session;
      break;
    }
  }
  add("rollback_samples_available", Boolean(rollbackTarget && zeroPrefixTarget), {
    nonEmptyPrefix: Boolean(rollbackTarget),
    zeroPrefix: Boolean(zeroPrefixTarget),
    nonEmptyPrefixUncompacted: Boolean(rollbackTarget),
  });
  if (!rollbackTarget || !zeroPrefixTarget) throw new Error("rollback fixture sessions were not available");

  const originalTurns = projected.get(rollbackTarget.id).turns;
  const rollbackSizeBefore = statSync(rollbackTarget.path).size;
  let started = performance.now();
  const rolledBack = await client.request("thread/rollback", { threadId: rollbackTarget.id, numTurns: 1 });
  timings.rollbackMs = Math.round(performance.now() - started);
  const truncatedRead = await client.request("thread/read", { threadId: rollbackTarget.id, includeTurns: true });
  const rollbackSizeAfter = statSync(rollbackTarget.path).size;
  add("rollback_keeps_n_minus_one_in_memory", rolledBack.thread.turns.length === originalTurns.length - 1
    && truncatedRead.thread.turns.length === originalTurns.length - 1, {
    originalTurns: originalTurns.length,
    rollbackTurns: rolledBack.thread.turns.length,
    readTurns: truncatedRead.thread.turns.length,
  });
  add("rollback_non_empty_prefix_leaves_transcript_unchanged", rollbackSizeAfter === rollbackSizeBefore, {
    bytesBefore: rollbackSizeBefore,
    bytesAfter: rollbackSizeAfter,
  });

  started = performance.now();
  const rollbackStop = await stopGateway(client);
  client = undefined;
  const rollbackRestart = await startGateway();
  client = rollbackRestart.client;
  timings.stopStartMs = Math.round(performance.now() - started);
  const restoredRead = await client.request("thread/read", { threadId: rollbackTarget.id, includeTurns: true });
  add("rollback_anchor_lost_after_restart", rollbackStop.ok && restoredRead.thread.turns.length === originalTurns.length, {
    stopOk: rollbackStop.ok,
    originalTurns: originalTurns.length,
    restartedTurns: restoredRead.thread.turns.length,
  });
  started = performance.now();
  try {
    const resumed = await guard.step(`thread/resume ${truncateId(rollbackTarget.id)}`, () =>
      client.request("thread/resume", { threadId: rollbackTarget.id, excludeTurns: false }));
    if (resumed.thread.id !== rollbackTarget.id) {
      projectionFailures.push(truncateId(rollbackTarget.id));
    }
  } catch (error) {
    projectionFailures.push(truncateId(rollbackTarget.id));
    evidence.push(safeError(error, "thread/resume", { threadId: "<id>", excludeTurns: false, phase: "after-restart" }));
  }
  const rollbackTargetResumeMs = Math.round(performance.now() - started);
  timings.resumes.push({ id: truncateId(rollbackTarget.id), ms: rollbackTargetResumeMs });
  if (rollbackTarget.id === largest.id) timings.largestTranscriptResumeMs = rollbackTargetResumeMs;
  add("read_resume_projection", projectionFailures.length === 0, {
    selected: selected.length,
    failedIds: [...new Set(projectionFailures)],
  });
  add("read_only_sqlite_counts", guard.observations.every(({ ok }) => ok), {
    steps: guard.observations.length,
    failedSteps: guard.observations.filter(({ ok }) => !ok).map(({ name }) => name.replace(/[0-9a-f]{8}…/gu, "<id>")),
  });

  const restartIds = new Set((await pagedThreads(client, { limit: 100 })).map(({ id }) => id));
  const postRestartZeroPrefixTarget = restartIds.has(zeroPrefixTarget.id) && existsSync(zeroPrefixTarget.path)
    ? zeroPrefixTarget
    : undefined;
  if (!postRestartZeroPrefixTarget) throw new Error("post-restart zero-prefix fixture session was not available");
  const hydratedZeroPrefix = await client.request("thread/read", {
    threadId: postRestartZeroPrefixTarget.id,
    includeTurns: true,
  });
  const zeroPrefixTurns = hydratedZeroPrefix.thread.turns.length;
  const reset = await client.request("thread/rollback", {
    threadId: postRestartZeroPrefixTarget.id,
    numTurns: zeroPrefixTurns,
  });
  add("rollback_zero_prefix_removes_transcript", reset.thread.turns.length === 0 && !existsSync(postRestartZeroPrefixTarget.path), {
    removedTurns: zeroPrefixTurns,
    responseTurns: reset.thread.turns.length,
    transcriptRemoved: !existsSync(postRestartZeroPrefixTarget.path),
  });

  const mutationTargets = selected.filter(({ id }) => id !== rollbackTarget.id && id !== postRestartZeroPrefixTarget.id);
  const [renameTarget, archiveTarget] = mutationTargets;
  const sectionTarget = [...sessions].sort((left, right) => left.size - right.size)
    .find(({ id }) => id !== renameTarget.id && id !== archiveTarget.id
      && id !== rollbackTarget.id && id !== postRestartZeroPrefixTarget.id);
  const title = "Isolated container title";
  try {
    const titleCountBefore = await countRecordType(renameTarget.path, "custom-title");
    const titleHashBefore = await fileHash(renameTarget.path);
    const titleCountsBefore = sqliteSnapshots(stateDir);
    await client.request("thread/name/set", { threadId: renameTarget.id, name: title });
    await eventually(
      () => pagedThreads(client, { archived: false, limit: 100 }),
      (threads) => threads.some((thread) => thread.id === renameTarget.id && thread.name === title),
    );
    const titleCountAfter = await countRecordType(renameTarget.path, "custom-title");
    const titleHashAfter = await fileHash(renameTarget.path);
    const titleCountsAfter = sqliteSnapshots(stateDir);
    add("native_title_append", titleCountAfter === titleCountBefore + 1 && titleHashBefore !== titleHashAfter, {
      appended: titleCountAfter - titleCountBefore,
      hashChanged: titleHashBefore !== titleHashAfter,
      listNameUpdated: true,
    });
    add("title_does_not_change_sqlite_counts", JSON.stringify(titleCountsBefore) === JSON.stringify(titleCountsAfter), {
      changedTables: changedTables(titleCountsBefore, titleCountsAfter),
    });
  } catch (error) {
    add("native_title_append", false, safeError(error, "thread/name/set", { threadId: "<id>", name: "<constant>" }));
    evidence.push(safeError(error, "thread/name/set", { threadId: "<id>", name: "<constant>" }));
  }

  try {
    const beforeArchive = sqliteSnapshots(stateDir);
    await client.request("thread/archive", { threadId: archiveTarget.id });
    const afterArchive = sqliteSnapshots(stateDir);
    const activeAfterArchive = await pagedThreads(client, { archived: false, limit: 100 });
    const archivedAfterArchive = await pagedThreads(client, { archived: true, limit: 100 });
    const afterArchiveReads = sqliteSnapshots(stateDir);
    add("archive_visibility", !activeAfterArchive.some(({ id }) => id === archiveTarget.id)
      && archivedAfterArchive.some(({ id }) => id === archiveTarget.id), {
      absentFromActive: !activeAfterArchive.some(({ id }) => id === archiveTarget.id),
      presentInArchived: archivedAfterArchive.some(({ id }) => id === archiveTarget.id),
    });
    add("archive_flags_only", count(afterArchive, "claude_session_flags") === count(beforeArchive, "claude_session_flags") + 1
      && changedTables(beforeArchive, afterArchive).every((name) => name === "state.sqlite:claude_session_flags"), {
      changedTables: changedTables(beforeArchive, afterArchive),
    });
    add("archive_lists_are_read_only", JSON.stringify(afterArchive) === JSON.stringify(afterArchiveReads), {
      changedTables: changedTables(afterArchive, afterArchiveReads),
    });
    await client.request("thread/unarchive", { threadId: archiveTarget.id });
    const afterUnarchive = sqliteSnapshots(stateDir);
    add("unarchive_removes_default_flags", count(afterUnarchive, "claude_session_flags") === count(beforeArchive, "claude_session_flags"), {
      before: count(beforeArchive, "claude_session_flags"),
      after: count(afterUnarchive, "claude_session_flags"),
    });
  } catch (error) {
    add("archive_unarchive", false, safeError(error, "thread/archive|thread/unarchive", { threadId: "<id>" }));
    evidence.push(safeError(error, "thread/archive|thread/unarchive", { threadId: "<id>" }));
  }

  try {
    const createdSection = await client.request("threadSection/create", {
      name: "Container E2E section",
      appearance: null,
    });
    const beforeSection = sqliteSnapshots(stateDir);
    await client.request("thread/section/move", { threadId: sectionTarget.id, sectionId: createdSection.section.id });
    const afterSection = sqliteSnapshots(stateDir);
    const database = openReadonly(`${stateDir}/state.sqlite`);
    const flag = database.prepare("SELECT section_json FROM claude_session_flags WHERE session_id = ?").get(sectionTarget.id);
    database.close();
    add("section_flags", flag?.section_json != null
      && count(afterSection, "claude_session_flags") === count(beforeSection, "claude_session_flags") + 1, {
      sectionJsonSet: flag?.section_json != null,
      changedTables: changedTables(beforeSection, afterSection),
    });
    add("section_changes_only_expected_tables", setEqual(
      new Set(changedTables(beforeSection, afterSection)),
      new Set(["state.sqlite:claude_session_flags", "state.sqlite:section_orders"]),
    ), {
      changedTables: changedTables(beforeSection, afterSection),
    });
  } catch (error) {
    add("section_flags", false, safeError(error, "thread/section/move", { threadId: "<id>", sectionId: "<id>" }));
    evidence.push(safeError(error, "thread/section/move", { threadId: "<id>", sectionId: "<id>" }));
  }

  try {
    await client.request("thread/delete", { threadId: sectionTarget.id });
    const deletedList = await eventually(
      () => pagedThreads(client, { archived: false, limit: 100 }),
      (threads) => !threads.some(({ id }) => id === sectionTarget.id),
    );
    const afterDelete = sqliteSnapshots(stateDir);
    const verifyDatabase = openReadonly(`${stateDir}/state.sqlite`);
    const remainingFlag = verifyDatabase.prepare("SELECT count(*) AS count FROM claude_session_flags WHERE session_id = ?")
      .get(sectionTarget.id).count;
    verifyDatabase.close();
    add("delete_native_session", !existsSync(sectionTarget.path)
      && Number(remainingFlag) === 0
      && !deletedList.some(({ id }) => id === sectionTarget.id), {
      transcriptRemoved: !existsSync(sectionTarget.path),
      flagsRemoved: Number(remainingFlag) === 0,
      absentFromList: !deletedList.some(({ id }) => id === sectionTarget.id),
      flagsCount: count(afterDelete, "claude_session_flags"),
    });
  } catch (error) {
    add("delete_native_session", false, safeError(error, "thread/delete", { threadId: "<id>" }));
    evidence.push(safeError(error, "thread/delete", { threadId: "<id>" }));
  }
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
