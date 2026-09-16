export function parseDocumentScroll(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  return message.type === 'agentdocs:scroll' && typeof message.ratio === 'number' &&
    Number.isFinite(message.ratio) && message.ratio >= 0 && message.ratio <= 1
    ? message.ratio
    : null;
}
