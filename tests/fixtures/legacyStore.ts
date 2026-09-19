import { DatabaseSync } from "node:sqlite";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { SqliteHybridStore } from "../../src/store/sqliteStore.js";

function path(store: SqliteHybridStore): string {
  return (store as unknown as { readonly path: string }).path;
}

export function seedLegacyTurn(store: SqliteHybridStore, threadId: string, turn: Turn): void {
  const database = new DatabaseSync(path(store));
  const ordinal = database.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM turns WHERE thread_id = ?")
    .get(threadId) as { ordinal: number };
  database.prepare("INSERT INTO turns (id, thread_id, ordinal, status, turn_json) VALUES (?, ?, ?, ?, ?)")
    .run(turn.id, threadId, ordinal.ordinal, turn.status, JSON.stringify(turn));
  database.close();
}

export function updateLegacyTurn(store: SqliteHybridStore, threadId: string, turn: Turn): void {
  const database = new DatabaseSync(path(store));
  database.prepare("UPDATE turns SET status = ?, turn_json = ? WHERE id = ? AND thread_id = ?")
    .run(turn.status, JSON.stringify(turn), turn.id, threadId);
  database.close();
}
