/**
 * Standalone RSS + Newsletter check worker.
 * Runs directly via Node.js without pi/LLM overhead.
 * 
 * Usage: tsx check-worker.ts [rss|newsletter] [--notify]
 * 
 *   tsx check-worker.ts rss          # RSS feeds only
 *   tsx check-worker.ts newsletter   # Newsletter only
 *   tsx check-worker.ts              # Both
 */

import * as db from "../src/db.js";
import * as fetcher from "../src/fetcher.js";
import * as mailFetcher from "../src/mail-fetcher.js";

const mode = process.argv[2]; // "rss", "newsletter", or undefined (both)
const notify = process.argv.includes("--notify");

async function main() {
  const startTime = Date.now();
  
  // Initialize DB
  db.getDb();

  const feeds = db.listFeeds() as any[];
  const checkRss = !mode || mode === "rss";
  const checkNewsletter = !mode || mode === "newsletter";
  const rssFeeds = checkRss ? feeds.filter(f => f.is_active && f.type !== "newsletter") : [];
  const nlFeeds = checkNewsletter ? feeds.filter(f => f.is_active && f.type === "newsletter") : [];

  let totalNew = 0;
  let errors = 0;

  // Check RSS feeds
  for (const feed of rssFeeds) {
    try {
      const result = await fetcher.fetchFeed(feed.id);
      totalNew += result.new_articles;
      if (result.error) errors++;
    } catch {
      errors++;
    }
  }

  // Check newsletter feeds
  if (nlFeeds.length > 0) {
    const syncResult = mailFetcher.syncMails();
    if (syncResult.success) {
      for (const feed of nlFeeds) {
        try {
          const result = mailFetcher.fetchNewsletterFeed(feed.id);
          totalNew += result.new_articles;
          if (result.error) errors++;
        } catch {
          errors++;
        }
      }
    } else {
      errors++;
    }
  }

  const label = mode || "all";
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const summary = `[rss-check:${label}] ${rssFeeds.length} RSS + ${nlFeeds.length} newsletter, ${totalNew} new, ${errors} errors (${elapsed}s)`;

  // Cleanup: remove read + older than 90 days (skip bookmarked)
  const cleanup = db.cleanupArticles();

  if (totalNew > 0 || errors > 0 || cleanup.total_deleted > 0 || notify) {
    const parts = [summary];
    if (cleanup.total_deleted > 0) {
      parts.push(`[cleanup] removed ${cleanup.read_deleted} read + ${cleanup.old_deleted} expired (>90d)`);
    }
    console.log(parts.join(" | "));
  }

  // Exit with error code if there were issues
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[rss-check] Fatal:", err.message);
  process.exit(1);
});
