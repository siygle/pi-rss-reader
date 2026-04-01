import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as db from "./db.js";

const MAILS_DB_PATH = path.join(os.homedir(), ".mails", "mails.db");

export interface MailFetchResult {
  feed_id: number;
  feed_name: string;
  new_articles: number;
  error?: string;
}

/**
 * Run `mails sync` to pull latest emails from the worker.
 */
export function syncMails(): { success: boolean; error?: string } {
  try {
    execSync("mails sync", {
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env },
    });
    return { success: true };
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    return { success: false, error: stderr };
  }
}

/**
 * Open the mails database (read-only).
 */
function openMailsDb(): Database.Database | null {
  if (!fs.existsSync(MAILS_DB_PATH)) return null;
  const mailsDb = new Database(MAILS_DB_PATH, { readonly: true });
  mailsDb.pragma("journal_mode = WAL");
  return mailsDb;
}

/**
 * Fetch newsletter emails for a specific newsletter feed.
 * A newsletter feed has type='newsletter' and url stores the sender email pattern.
 */
export function fetchNewsletterFeed(feedId: number): MailFetchResult {
  const feed = db.getFeed(feedId) as any;
  if (!feed) {
    return { feed_id: feedId, feed_name: "unknown", new_articles: 0, error: "Feed not found" };
  }

  const mailsDb = openMailsDb();
  if (!mailsDb) {
    return { feed_id: feedId, feed_name: feed.name, new_articles: 0, error: "Mails DB not found at " + MAILS_DB_PATH };
  }

  try {
    // feed.url for newsletter feeds stores the sender email/pattern
    // e.g. "newsletter@example.com" or "%@substack.com"
    const senderPattern = feed.url;

    // Get the last fetched article's received_at for this feed to only get new ones
    const lastArticle = db.getLatestArticleDate(feedId);

    let emails: any[];
    if (lastArticle) {
      emails = mailsDb.prepare(`
        SELECT id, from_address, from_name, subject, body_text, body_html, received_at, message_id
        FROM emails
        WHERE direction = 'inbound'
          AND from_address LIKE ?
          AND received_at > ?
        ORDER BY received_at ASC
      `).all(senderPattern, lastArticle);
    } else {
      // First fetch: get last 50 emails from this sender
      emails = mailsDb.prepare(`
        SELECT id, from_address, from_name, subject, body_text, body_html, received_at, message_id
        FROM emails
        WHERE direction = 'inbound'
          AND from_address LIKE ?
        ORDER BY received_at DESC
        LIMIT 50
      `).all(senderPattern);
      emails.reverse(); // oldest first for insertion order
    }

    const articles = emails.map((email) => {
      // Use message_id or email id as guid
      const guid = `mail:${email.message_id || email.id}`;

      // Extract text content, preferring body_text, falling back to stripped html
      let content = email.body_text || "";
      let summary = "";

      if (email.body_html && !content) {
        content = stripHtml(email.body_html);
      }
      summary = content.substring(0, 1000);

      // Parse received_at to ISO-like format
      let publishedAt = email.received_at;
      try {
        publishedAt = new Date(email.received_at).toISOString().replace("T", " ").replace("Z", "");
      } catch {
        // keep as-is
      }

      return {
        guid,
        title: email.subject || "(no subject)",
        link: undefined as string | undefined,
        author: email.from_name || email.from_address,
        summary: summary.substring(0, 1000),
        content: content.substring(0, 10000),
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
  } finally {
    mailsDb.close();
  }
}

/**
 * Fetch all active newsletter feeds.
 */
export function fetchAllNewsletterFeeds(): MailFetchResult[] {
  const feeds = db.listFeeds() as any[];
  const newsletterFeeds = feeds.filter((f) => f.is_active && f.type === "newsletter");

  if (newsletterFeeds.length === 0) return [];

  const results: MailFetchResult[] = [];
  for (const feed of newsletterFeeds) {
    const result = fetchNewsletterFeed(feed.id);
    results.push(result);
  }
  return results;
}

/**
 * List unique senders from the mails database for discovery.
 */
export function listMailSenders(limit = 30): Array<{ from_address: string; from_name: string; count: number; latest: string }> {
  const mailsDb = openMailsDb();
  if (!mailsDb) return [];

  try {
    return mailsDb.prepare(`
      SELECT from_address, from_name, COUNT(*) as count, MAX(received_at) as latest
      FROM emails
      WHERE direction = 'inbound'
      GROUP BY from_address
      ORDER BY count DESC
      LIMIT ?
    `).all(limit) as any[];
  } finally {
    mailsDb.close();
  }
}

/**
 * Check for verification/confirmation emails and extract confirm links.
 * Polls every `intervalSec` for up to `timeoutSec`.
 */
export async function waitForVerification(opts: {
  senderPattern?: string;
  timeoutSec?: number;
  intervalSec?: number;
}): Promise<{
  found: boolean;
  email?: { from: string; subject: string; received_at: string };
  confirm_links: string[];
  body_preview?: string;
}> {
  const timeout = (opts.timeoutSec || 300) * 1000;
  const interval = (opts.intervalSec || 10) * 1000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    syncMails();

    const mailsDb = openMailsDb();
    if (!mailsDb) {
      await sleep(interval);
      continue;
    }

    try {
      // Look for recent verification-like emails (last 5 minutes)
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      let query = `
        SELECT id, from_address, from_name, subject, body_text, body_html, received_at
        FROM emails
        WHERE direction = 'inbound'
          AND received_at > ?
          AND (subject LIKE '%confirm%' OR subject LIKE '%verify%' OR subject LIKE '%確認%'
               OR subject LIKE '%activate%' OR subject LIKE '%welcome%' OR subject LIKE '%subscribe%')
      `;
      const params: any[] = [cutoff];

      if (opts.senderPattern) {
        query += ` AND from_address LIKE ?`;
        params.push(opts.senderPattern);
      }

      query += ` ORDER BY received_at DESC LIMIT 1`;

      const email = mailsDb.prepare(query).get(...params) as any;

      if (email) {
        // Extract confirmation links from HTML or text body
        const body = email.body_html || email.body_text || "";
        const links = extractConfirmLinks(body);
        const textPreview = (email.body_text || stripHtml(email.body_html || "")).substring(0, 500);

        return {
          found: true,
          email: {
            from: email.from_address,
            subject: email.subject,
            received_at: email.received_at,
          },
          confirm_links: links,
          body_preview: textPreview,
        };
      }
    } finally {
      mailsDb.close();
    }

    await sleep(interval);
  }

  return { found: false, confirm_links: [] };
}

/**
 * Extract confirmation/verification links from email body.
 */
function extractConfirmLinks(body: string): string[] {
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  const allLinks = body.match(urlRegex) || [];

  const confirmKeywords = ["confirm", "verify", "activate", "subscribe", "opt-in", "click", "token", "auth"];
  const filtered = allLinks.filter((link) =>
    confirmKeywords.some((kw) => link.toLowerCase().includes(kw))
  );

  // Deduplicate
  return [...new Set(filtered.length > 0 ? filtered : allLinks.slice(0, 5))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
