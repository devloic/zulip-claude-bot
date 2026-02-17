/**
 * Convert Zulip HTML message content to plain text.
 * Strips mention spans, converts block elements to newlines,
 * removes remaining tags, and decodes HTML entities.
 */
export function htmlToText(html: string): string {
  let text = html;

  // Remove user-mention and user-group-mention spans entirely
  text = text.replace(
    /<span[^>]*class="user-mention[^"]*"[^>]*>@[^<]*<\/span>/gi,
    "",
  );
  text = text.replace(
    /<span[^>]*class="user-group-mention[^"]*"[^>]*>@[^<]*<\/span>/gi,
    "",
  );

  // Convert block-level elements to newlines
  text = text.replace(/<\/p>\s*<p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<li>/gi, "- ");
  text = text.replace(/<\/?(p|div|blockquote|h[1-6]|ul|ol|pre)[^>]*>/gi, "\n");

  // Convert code blocks
  text = text.replace(
    /<code[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/code>/gi,
    "$1",
  );
  text = text.replace(/<\/?code[^>]*>/gi, "`");

  // Convert links: <a href="url">text</a> -> text (url)
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
