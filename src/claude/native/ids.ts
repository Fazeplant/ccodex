/** Returns the stable Codex item id for a Claude API response block. */
export function assistantBlockItemId(messageId: string, apiBlockIndex: number): string {
  return `${messageId}:${apiBlockIndex}`;
}
