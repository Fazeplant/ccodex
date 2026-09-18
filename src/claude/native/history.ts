/** Owns current-branch selection from Claude's non-linear transcript graph. */
import {
  isChainRecord,
  isCompactBoundary,
  type AssistantRecord,
  type TranscriptChainRecord,
  type TranscriptRecord,
  type UserRecord,
} from "./records.js";

export interface SelectedHistory {
  readonly records: readonly TranscriptChainRecord[];
  readonly compactionBoundaries: ReadonlySet<string>;
}

function apiMessageId(record: TranscriptChainRecord): string | undefined {
  return record.type === "assistant" ? record.message.id : undefined;
}

function isToolResult(record: TranscriptChainRecord): record is UserRecord & { readonly parentUuid: string } {
  return record.type === "user" && record.parentUuid !== null && Array.isArray(record.message.content)
    && record.message.content.some((block) => block.type === "tool_result");
}

function relinkCompactions(records: ReadonlyMap<string, TranscriptChainRecord>): Map<string, TranscriptChainRecord> {
  const linked = new Map(records);
  for (const record of linked.values()) {
    if (!isCompactBoundary(record)) continue;
    const messages = record.compactMetadata?.preservedMessages;
    const segment = record.compactMetadata?.preservedSegment;
    if (messages) {
      if (messages.uuids.length === 0 || messages.uuids.some((uuid) => !linked.has(uuid))) continue;
      let parentUuid: string | null = messages.anchorUuid;
      for (const uuid of messages.uuids) {
        linked.set(uuid, { ...linked.get(uuid)!, parentUuid });
        parentUuid = uuid;
      }
      const first = messages.uuids[0]!;
      const last = messages.uuids.at(-1)!;
      for (const [uuid, candidate] of linked) {
        if (candidate.parentUuid === messages.anchorUuid && uuid !== first) {
          linked.set(uuid, { ...candidate, parentUuid: last });
        }
      }
    } else if (segment) {
      const head = linked.get(segment.headUuid);
      if (head) linked.set(segment.headUuid, { ...head, parentUuid: segment.anchorUuid });
      for (const [uuid, candidate] of linked) {
        if (candidate.parentUuid === segment.anchorUuid && uuid !== segment.headUuid) {
          linked.set(uuid, { ...candidate, parentUuid: segment.tailUuid });
        }
      }
    }
  }
  return linked;
}

function siblingBlocks(
  records: ReadonlyMap<string, TranscriptChainRecord>,
  selected: readonly TranscriptChainRecord[],
  selectedUuids: Set<string>,
): TranscriptChainRecord[] {
  const selectedAssistants = selected.filter((record): record is AssistantRecord => record.type === "assistant");
  if (selectedAssistants.length === 0) return [...selected];

  const insertionPoint = new Map<string, AssistantRecord>();
  for (const record of selectedAssistants) {
    const messageId = apiMessageId(record);
    if (messageId) insertionPoint.set(messageId, record);
  }
  const assistantsByMessage = new Map<string, TranscriptChainRecord[]>();
  const resultsByParent = new Map<string, TranscriptChainRecord[]>();
  for (const record of records.values()) {
    const messageId = apiMessageId(record);
    if (messageId) {
      const values = assistantsByMessage.get(messageId) ?? [];
      values.push(record);
      assistantsByMessage.set(messageId, values);
    } else if (isToolResult(record)) {
      const values = resultsByParent.get(record.parentUuid) ?? [];
      values.push(record);
      resultsByParent.set(record.parentUuid, values);
    }
  }

  const additions = new Map<string, TranscriptChainRecord[]>();
  const seenMessages = new Set<string>();
  for (const record of selectedAssistants) {
    const messageId = apiMessageId(record);
    if (!messageId || seenMessages.has(messageId)) continue;
    seenMessages.add(messageId);
    const responseRecords = assistantsByMessage.get(messageId) ?? [record];
    const assistantSiblings = responseRecords.filter((candidate) => !selectedUuids.has(candidate.uuid));
    const toolResults: TranscriptChainRecord[] = [];
    for (const responseRecord of responseRecords) {
      for (const result of resultsByParent.get(responseRecord.uuid) ?? []) {
        if (!selectedUuids.has(result.uuid)) toolResults.push(result);
      }
    }
    const byTimestamp = (left: TranscriptChainRecord, right: TranscriptChainRecord) =>
      left.timestamp.localeCompare(right.timestamp);
    assistantSiblings.sort(byTimestamp);
    toolResults.sort(byTimestamp);
    const values = [...assistantSiblings, ...toolResults];
    if (values.length === 0) continue;
    for (const value of values) selectedUuids.add(value.uuid);
    additions.set(insertionPoint.get(messageId)!.uuid, values);
  }

  return selected.flatMap((record) => [record, ...(additions.get(record.uuid) ?? [])]);
}

function visible(record: TranscriptChainRecord): boolean {
  if (record.type !== "user" && record.type !== "assistant" && record.type !== "system") return false;
  return record.isMeta !== true && record.isSidechain !== true && !record.teamName;
}

export function selectHistory(input: readonly TranscriptRecord[]): SelectedHistory {
  const chain = input.filter(isChainRecord);
  const lastWins = new Map<string, TranscriptChainRecord>();
  for (const record of chain) lastWins.set(record.uuid, record);
  const records = relinkCompactions(lastWins);
  const positions = new Map<string, number>();
  chain.forEach((record, index) => positions.set(record.uuid, index));
  const occurrences = new Map<string, { readonly index: number; readonly record: TranscriptChainRecord }[]>();
  chain.forEach((record, index) => {
    const values = occurrences.get(record.uuid) ?? [];
    values.push({ index, record });
    occurrences.set(record.uuid, values);
  });
  const before = (uuid: string, limit: number): TranscriptChainRecord | undefined =>
    occurrences.get(uuid)?.findLast((value) => value.index < limit)?.record;

  const parentUuids = new Set<string>();
  for (const record of records.values()) if (record.parentUuid) parentUuids.add(record.parentUuid);
  const conversationalLeaves: TranscriptChainRecord[] = [];
  for (const leaf of [...records.values()].filter((record) => !parentUuids.has(record.uuid))) {
    let cursor: TranscriptChainRecord | undefined = leaf;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor.uuid)) break;
      seen.add(cursor.uuid);
      if (cursor.type === "user" || cursor.type === "assistant") {
        conversationalLeaves.push(cursor);
        break;
      }
      cursor = cursor.parentUuid ? records.get(cursor.parentUuid) : undefined;
    }
  }
  if (conversationalLeaves.length === 0) {
    return { records: [], compactionBoundaries: new Set() };
  }
  const preferred = conversationalLeaves.filter((record) =>
    record.isSidechain !== true && !record.teamName && record.isMeta !== true);
  const candidates = preferred.length > 0 ? preferred : conversationalLeaves;
  const leaf = candidates.reduce((latest, candidate) =>
    (positions.get(candidate.uuid) ?? -1) > (positions.get(latest.uuid) ?? -1) ? candidate : latest);

  const reversed: TranscriptChainRecord[] = [];
  const selectedUuids = new Set<string>();
  let cursor: TranscriptChainRecord | undefined = records.get(leaf.uuid);
  let physicalWalk = false;
  let snapshotLimit = chain.length;
  const seenPhysicalRecords = new Set<TranscriptChainRecord>();
  while (cursor) {
    if (physicalWalk && selectedUuids.has(cursor.uuid)) {
      if (seenPhysicalRecords.has(cursor)) break;
      seenPhysicalRecords.add(cursor);
      cursor = cursor.parentUuid ? before(cursor.parentUuid, snapshotLimit) : undefined;
      continue;
    }
    if (selectedUuids.has(cursor.uuid)) break;
    selectedUuids.add(cursor.uuid);
    reversed.push(cursor);
    if (isCompactBoundary(cursor) && cursor.logicalParentUuid) {
      physicalWalk = true;
      snapshotLimit = positions.get(cursor.uuid) ?? snapshotLimit;
      cursor = before(cursor.logicalParentUuid, snapshotLimit);
    } else {
      cursor = cursor.parentUuid
        ? (physicalWalk ? before(cursor.parentUuid, snapshotLimit) : records.get(cursor.parentUuid))
        : undefined;
    }
  }
  const selected = siblingBlocks(records, reversed.reverse(), selectedUuids).filter(visible);
  return {
    records: selected,
    compactionBoundaries: new Set(selected.filter(isCompactBoundary).map((record) => record.uuid)),
  };
}
