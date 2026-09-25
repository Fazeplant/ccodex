import type { Thread } from "../codex/generated/v2/Thread.js";

// Codex 0.157 removed the deprecated `thread/rollback` request from the
// app-server protocol (stock now serves only `thread/revert`, and only for
// paginated threads). CCodex still honors it for Claude and logical threads
// from older clients, so the last published shapes (Codex 0.153.3) live here.

export type ThreadRollbackParams = {
  threadId: string,
  /** The number of turns to drop from the end of the thread. Must be >= 1. */
  numTurns: number,
};

export type ThreadRollbackResponse = {
  /** The updated thread after applying the rollback, with `turns` populated. */
  thread: Thread,
};
