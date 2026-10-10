/** Configuração declarativa e isolada por instância. Sem envio automático. */
export type ContentSettings = {
  autoProcess: boolean;
  query: string;
  onlyRelevant: boolean;
  maxItems: number;
  createStory: boolean;
  fetchImages: boolean;
  enrichImages: boolean;
};
export const DEFAULT_CONTENT_SETTINGS: ContentSettings = {
  autoProcess: false,
  query: "",
  onlyRelevant: false,
  maxItems: 100,
  createStory: true,
  fetchImages: false,
  enrichImages: false,
};
export function contentSettings(metadata: unknown): ContentSettings {
  const raw =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).content
      : undefined;
  const c =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    autoProcess: c.autoProcess === true,
    query: typeof c.query === "string" ? c.query.slice(0, 150) : "",
    onlyRelevant: c.onlyRelevant === true,
    maxItems:
      typeof c.maxItems === "number" && Number.isInteger(c.maxItems)
        ? Math.min(250, Math.max(1, c.maxItems))
        : 100,
    createStory: c.createStory !== false,
    fetchImages: c.fetchImages === true,
    enrichImages: c.enrichImages === true,
  };
}
