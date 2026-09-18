const timingFields = new Set([
  "createdAt", "updatedAt", "recencyAt", "startedAt", "completedAt", "durationMs",
  "startedAtMs", "completedAtMs",
]);

function withoutTiming(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTiming);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !timingFields.has(key))
    .map(([key, entry]) => [key, withoutTiming(entry)]));
}

export function normalizedNotificationEvents(
  events: readonly { readonly method: string; readonly params: unknown }[],
): Array<{ method: string; params: unknown }> {
  return events.map(({ method, params }) => ({ method, params: withoutTiming(params) }));
}
