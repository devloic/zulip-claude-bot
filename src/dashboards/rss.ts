import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { DashboardDef } from "./registry.js";
import { markFeedItemSeen, setDashboardBootstrapped } from "../db.js";
import type { ServiceContext } from "../services/types.js";
import type { DashboardRow } from "../db.js";

// ── XML helpers ──────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

interface FeedItem {
  guid: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
  image: string;
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function coerce(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>))
    return String((v as Record<string, unknown>)["#text"]);
  return String(v);
}

/** Extract the first image URL from an RSS/Atom item XML. */
function extractImageFromXml(it: Record<string, unknown>): string {
  // <enclosure url="..." type="image/...">
  const enc = it.enclosure as Record<string, unknown> | undefined;
  if (enc?.["@_url"] && String(enc["@_type"] ?? "").startsWith("image/")) {
    return String(enc["@_url"]);
  }

  // <media:content url="..." medium="image"> or <media:thumbnail url="...">
  const media = (it["media:content"] ?? it["media:thumbnail"]) as
    | Record<string, unknown>
    | Record<string, unknown>[]
    | undefined;
  if (media) {
    const items = Array.isArray(media) ? media : [media];
    for (const m of items) {
      const url = String(m["@_url"] ?? "");
      if (url && (!m["@_medium"] || m["@_medium"] === "image")) return url;
    }
  }

  // <img src="..."> inside description/content HTML
  const html = coerce(it.description) || coerce(it.content) || coerce(it.summary);
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return "";
}

/** Fetch og:image / twitter:image from an article's webpage. */
async function fetchOgImage(url: string): Promise<string> {
  try {
    const res = await globalThis.fetch(url, {
      headers: { "User-Agent": "ZulipBot-RSS/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "";
    // Read only the first chunk — og:image is always in <head>
    const html = await res.text();
    const head = html.slice(0, 20_000);
    const ogMatch = head.match(
      /<meta[^>]+(?:property=["']og:image["']|name=["']twitter:image["'])[^>]+content=["']([^"']+)["']/i,
    ) ?? head.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property=["']og:image["']|name=["']twitter:image["'])/i,
    );
    return ogMatch?.[1] ?? "";
  } catch {
    return "";
  }
}

function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const doc = xmlParser.parse(xml);

  // RSS 2.0
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    const rawItems = Array.isArray(ch.item)
      ? ch.item
      : ch.item
        ? [ch.item]
        : [];
    return {
      title: coerce(ch.title) || "RSS Feed",
      items: rawItems.map((it: Record<string, unknown>) => ({
        guid:
          coerce(it.guid) ||
          coerce(it.link) ||
          sha1(`${coerce(it.title)}${coerce(it.pubDate)}`),
        title: coerce(it.title),
        link: coerce(it.link),
        description: stripHtml(coerce(it.description)),
        pubDate: coerce(it.pubDate),
        image: extractImageFromXml(it),
      })),
    };
  }

  // Atom
  if (doc.feed) {
    const f = doc.feed;
    const rawEntries = Array.isArray(f.entry)
      ? f.entry
      : f.entry
        ? [f.entry]
        : [];
    return {
      title: coerce(f.title) || "Atom Feed",
      items: rawEntries.map((e: Record<string, unknown>) => {
        const link =
          coerce(
            (e.link as Record<string, unknown>)?.["@_href"] ?? e.link,
          );
        return {
          guid:
            coerce(e.id) || link || sha1(`${coerce(e.title)}${coerce(e.updated)}`),
          title: coerce(e.title),
          link,
          description: stripHtml(
            coerce(e.summary) || coerce(e.content),
          ),
          pubDate: coerce(e.updated) || coerce(e.published),
          image: extractImageFromXml(e),
        };
      }),
    };
  }

  throw new Error("Unrecognised feed format");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** Strip query strings from image URLs that already have an image extension. */
function cleanImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/\.(jpe?g|png|gif|webp|svg|avif)$/i.test(u.pathname)) {
      u.search = "";
    }
    return u.toString();
  } catch {
    return url;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function formatDate(raw: string): string {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return raw;
  }
}

// ── Rendering ────────────────────────────────────────────────────

const MAX_DISPLAY_ITEMS = 10;

function renderItem(item: FeedItem): string {
  const lines: string[] = [];

  const title = item.link
    ? `**[${item.title || "Untitled"}](${item.link})**`
    : `**${item.title || "Untitled"}**`;
  const date = item.pubDate ? ` · *${formatDate(item.pubDate)}*` : "";
  lines.push(`${title}${date}`);

  if (item.description) {
    lines.push(truncate(item.description, 200));
  }

  if (item.image) {
    // Bare URL on its own line — Zulip auto-embeds image links
    lines.push("");
    lines.push(cleanImageUrl(item.image));
  }

  return lines.join("\n");
}

function renderFeed(feed: { title: string; items: FeedItem[] }, intervalMs: number): string {
  const next = new Date(Date.now() + intervalMs);
  const nextStr = next.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
  const now = new Date();
  const nowStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
  const lines: string[] = [
    `## ${feed.title}`,
    `*Updated ${nowStr} UTC · Next at ${nextStr} UTC · React :refresh: to refresh*`,
    "",
  ];

  const display = feed.items.slice(0, MAX_DISPLAY_ITEMS);
  for (let i = 0; i < display.length; i++) {
    lines.push(renderItem(display[i]));
    if (i < display.length - 1) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Dashboard definition ─────────────────────────────────────────

export const rssDef: DashboardDef = {
  description: "RSS/Atom feed watcher",
  usage: "rss <url>",
  intervalMs: 5 * 60_000,

  validateParams(p: string): string | null {
    if (!p) return "Usage: `dashboard start rss <url>`";
    try {
      new URL(p);
      return null;
    } catch {
      return "Usage: `dashboard start rss <url>`";
    }
  },

  async fetch(
    params: string,
    ctx: ServiceContext,
    row: DashboardRow,
  ): Promise<string> {
    const feedUrl = params;

    // Fetch + parse
    const res = await globalThis.fetch(feedUrl, {
      headers: { "User-Agent": "ZulipBot-RSS/1.0" },
    });
    if (!res.ok) {
      return `**RSS** | Failed to fetch feed (HTTP ${res.status})`;
    }
    const xml = await res.text();
    const feed = parseFeed(xml);

    // Resolve missing images via og:image (parallel, capped to displayed items)
    const toResolve = feed.items.slice(0, MAX_DISPLAY_ITEMS);
    await Promise.all(
      toResolve.map(async (item) => {
        if (!item.image && item.link) {
          item.image = await fetchOgImage(item.link);
        }
      }),
    );

    // Bootstrap: mark all current items as seen
    if (row.bootstrapped === 0) {
      for (const item of feed.items) {
        markFeedItemSeen(row.id, item.guid);
      }
      setDashboardBootstrapped(row.id);
      row.bootstrapped = 1;
    } else {
      // Track new items and post them as individual messages
      const newItems: FeedItem[] = [];
      for (const item of feed.items) {
        if (markFeedItemSeen(row.id, item.guid)) {
          newItems.push(item);
        }
      }

      for (const item of newItems.reverse()) {
        const content = renderItem(item);
        await ctx.client.messages.send({
          to: row.channel,
          type: "stream",
          subject: row.topic,
          content,
        });
      }
    }

    // Always render the full feed into the pinned message
    return renderFeed(feed, rssDef.intervalMs!);
  },
};
