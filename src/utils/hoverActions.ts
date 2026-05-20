/**
 * Builds a markdown copy-link for use in trusted MarkdownString hovers.
 * Usage: appendCopyLink(sections, "42.5", "value")
 */
export function buildCopyLink(value: string, label = "Copy"): string {
  const encoded = encodeURIComponent(JSON.stringify(value));
  return `[<span class="codicon codicon-copy"></span>](command:calcdocs.copyValue?${encoded})`;
}