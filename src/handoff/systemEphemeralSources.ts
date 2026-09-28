// App-owned background tasks that fork a thread ephemerally with their own, usually
// small, Codex model. `system` is the historic source; Codex App builds for app-server
// 0.157 fork every new chat as `thread_description` to write its description.
export const SYSTEM_EPHEMERAL_FORK_SOURCES: ReadonlySet<string> = new Set(["system", "thread_description"]);

export function isSystemEphemeralForkSource(threadSource: unknown): boolean {
  return typeof threadSource === "string" && SYSTEM_EPHEMERAL_FORK_SOURCES.has(threadSource);
}
