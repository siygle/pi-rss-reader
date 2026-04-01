import RSSParser from "rss-parser";
import * as db from "./db.js";

const parser = new RSSParser({
  timeout: 15000,
  headers: {
    "User-Agent": "Pi-RSS-Reader/1.0",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
  },
});

export interface FetchResult {
  feed_id: number;
  feed_name: string;
  new_articles: number;
  error?: string;
}

/**
 * Fetch a single feed and store new articles.
 */
export async function fetchFeed(feedId: number): Promise<FetchResult> {
  const feed = db.getFeed(feedId) as any;
  if (!feed) {
    return { feed_id: feedId, feed_name: "unknown", new_articles: 0, error: "Feed not found" };
  }

  try {
    const parsed = await parser.parseURL(feed.url);

    // Update feed site_url if not set
    if (!feed.site_url && parsed.link) {
      db.updateFeed(feedId, { site_url: parsed.link });
    }

    const articles = (parsed.items || []).map((item) => {
      const guid = item.guid || item.link || item.title || "";
      const summary = item.contentSnippet || item.content?.substring(0, 500) || "";
      const content = item["content:encoded"] || item.content || "";

      let publishedAt: string | undefined;
      if (item.isoDate) {
        try {
          publishedAt = new Date(item.isoDate).toISOString().replace("T", " ").replace("Z", "");
        } catch {
          publishedAt = item.isoDate;
        }
      } else if (item.pubDate) {
        try {
          publishedAt = new Date(item.pubDate).toISOString().replace("T", " ").replace("Z", "");
        } catch {
          publishedAt = item.pubDate;
        }
      }

      return {
        guid,
        title: item.title || "(untitled)",
        link: item.link,
        author: item.creator || item.author,
        summary: stripHtml(summary).substring(0, 1000),
        content: stripHtml(content).substring(0, 10000),
        published_at: publishedAt,
      };
    });

    const newCount = db.upsertArticles(feedId, articles);
    db.updateFeedChecked(feedId);

    return { feed_id: feedId, feed_name: feed.name, new_articles: newCount };
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    db.updateFeedChecked(feedId, errorMsg);
    return { feed_id: feedId, feed_name: feed.name, new_articles: 0, error: errorMsg };
  }
}

/**
 * Fetch all active feeds.
 */
export async function fetchAllFeeds(): Promise<FetchResult[]> {
  const feeds = db.listFeeds() as any[];
  const activeFeeds = feeds.filter((f) => f.is_active);

  const results: FetchResult[] = [];
  for (const feed of activeFeeds) {
    const result = await fetchFeed(feed.id);
    results.push(result);
  }
  return results;
}

/**
 * Discover feed info from a URL (for adding new feeds).
 */
export async function discoverFeed(url: string): Promise<{
  title: string; description?: string; link?: string; items_count: number;
} | null> {
  try {
    const parsed = await parser.parseURL(url);
    return {
      title: parsed.title || "Unknown",
      description: parsed.description,
      link: parsed.link,
      items_count: parsed.items?.length || 0,
    };
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
