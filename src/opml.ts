import * as fs from "node:fs";
import * as db from "./db.js";

/**
 * Export all feeds to OPML format.
 */
export function exportOpml(outputPath: string): { path: string; feed_count: number } {
  const feeds = db.listFeeds() as any[];

  // Group by category
  const byCategory: Record<string, any[]> = {};
  for (const feed of feeds) {
    const cat = feed.category || "general";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(feed);
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>Pi RSS Feeds</title>`,
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    "  </head>",
    "  <body>",
  ];

  for (const [category, categoryFeeds] of Object.entries(byCategory)) {
    lines.push(`    <outline text="${escapeXml(category)}" title="${escapeXml(category)}">`);
    for (const feed of categoryFeeds) {
      const attrs = [
        'type="rss"',
        `text="${escapeXml(feed.name)}"`,
        `title="${escapeXml(feed.name)}"`,
        `xmlUrl="${escapeXml(feed.url)}"`,
      ];
      if (feed.site_url) attrs.push(`htmlUrl="${escapeXml(feed.site_url)}"`);
      lines.push(`      <outline ${attrs.join(" ")} />`);
    }
    lines.push("    </outline>");
  }

  lines.push("  </body>");
  lines.push("</opml>");

  const content = lines.join("\n");
  fs.writeFileSync(outputPath, content, "utf-8");

  return { path: outputPath, feed_count: feeds.length };
}

/**
 * Import feeds from an OPML file.
 */
export function importOpml(inputPath: string): {
  imported: number; skipped: number; errors: string[];
} {
  const content = fs.readFileSync(inputPath, "utf-8");

  // Simple XML parsing (no external dependency needed for OPML)
  const outlines = parseOutlines(content);

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const outline of outlines) {
    if (!outline.xmlUrl) continue; // Skip category folders

    try {
      db.addFeed(
        outline.title || outline.text || outline.xmlUrl,
        outline.xmlUrl,
        outline.category || "general",
        outline.htmlUrl
      );
      imported++;
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        skipped++;
      } else {
        errors.push(`${outline.xmlUrl}: ${err.message}`);
      }
    }
  }

  return { imported, skipped, errors };
}

interface OutlineEntry {
  text?: string;
  title?: string;
  xmlUrl?: string;
  htmlUrl?: string;
  category?: string;
}

function parseOutlines(xml: string): OutlineEntry[] {
  const results: OutlineEntry[] = [];

  // Normalize: ensure each <outline is on its own "token"
  // Split on <outline but keep the delimiter
  const tokens = xml.split(/(?=<outline[\s>])/i);

  // Track category from parent outlines (those without xmlUrl)
  // Use a stack-based approach: find category outlines by scanning structure
  let currentCategory = "";

  for (const token of tokens) {
    if (!token.includes("<outline")) continue;

    const xmlUrlMatch = token.match(/xmlUrl="([^"]*)"/i);

    if (xmlUrlMatch) {
      // This is a feed outline
      const entry: OutlineEntry = {
        xmlUrl: unescapeXml(xmlUrlMatch[1]),
        category: currentCategory || undefined,
      };
      const textMatch = token.match(/(?:^|\s)text="([^"]*)"/i);
      if (textMatch) entry.text = unescapeXml(textMatch[1]);
      const titleMatch = token.match(/(?:^|\s)title="([^"]*)"/i);
      if (titleMatch) entry.title = unescapeXml(titleMatch[1]);
      const htmlMatch = token.match(/htmlUrl="([^"]*)"/i);
      if (htmlMatch) entry.htmlUrl = unescapeXml(htmlMatch[1]);
      results.push(entry);
    } else {
      // Category outline (no xmlUrl) — extract text as category name
      const textMatch = token.match(/(?:^|\s)text="([^"]*)"/i);
      if (textMatch) {
        // Check if this outline is self-closing (no children) or has children
        // If it ends with /> it's self-closing, skip as category
        const isSelfClosing = /\/>\s*$/.test(token.split(">")[0] + ">");
        if (!isSelfClosing) {
          currentCategory = unescapeXml(textMatch[1]);
        }
      }
      // Check for closing </outline> tags to pop category
      const closingTags = token.match(/<\/outline>/gi);
      if (closingTags && closingTags.length > 0) {
        // If there are closing tags at the end of a category section, reset
        // This is a heuristic — works for most OPML structures
        currentCategory = "";
      }
    }
  }

  return results;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
