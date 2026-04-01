/**
 * Standalone RSS + Newsletter check worker.
 * Runs directly via Node.js without pi/LLM overhead.
 * 
 * Usage: node --import tsx check-worker.ts [--notify]
 */

import * as db from "../src/db.js";
import * as fetcher from "../src/fetcher.js";
import * as mailFetcher from "../src/mail-fetcher.js";

const notify = process.argv.includes("--notify");

async function main() {
  const startTime = Date.now();
  
  // Initialize DB
  db.getDb();

  const feeds = db.listFeeds() as any[];
  const rssFeeds = feeds.filter(f => f.is_active && f.type !== "newsletter");
  const nlFeeds = feeds.filter(f => f.is_active && f.type === "newsletter");

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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const summary = `[rss-check] ${rssFeeds.length} RSS + ${nlFeeds.length} newsletter feeds, ${totalNew} new articles, ${errors} errors (${elapsed}s)`;

  if (totalNew > 0 || errors > 0 || notify) {
    console.log(summary);
  }

  // Exit with error code if there were issues
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[rss-check] Fatal:", err.message);
  process.exit(1);
});
