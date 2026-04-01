import Database from "better-sqlite3";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const DB_PATH = path.join(os.homedir(), ".pi", "rss-reader.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feeds (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL,
      url                 TEXT NOT NULL UNIQUE,
      site_url            TEXT,
      category            TEXT DEFAULT 'general',
      type                TEXT DEFAULT 'rss',
      check_interval_min  INTEGER DEFAULT 60,
      last_checked_at     TEXT,
      last_error          TEXT,
      is_active           INTEGER DEFAULT 1,
      created_at          TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at          TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS articles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id       INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid          TEXT NOT NULL,
      title         TEXT NOT NULL,
      link          TEXT,
      author        TEXT,
      summary       TEXT,
      content       TEXT,
      published_at  TEXT,
      fetched_at    TEXT DEFAULT (datetime('now', 'localtime')),
      is_read       INTEGER DEFAULT 0,
      UNIQUE(feed_id, guid)
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id  INTEGER REFERENCES articles(id),
      title       TEXT NOT NULL,
      url         TEXT,
      source      TEXT DEFAULT 'manual',
      summary     TEXT,
      content     TEXT,
      notes       TEXT,
      saved_at    TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS tags (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS bookmark_tags (
      bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (bookmark_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_articles_feed_id ON articles(feed_id);
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_is_read ON articles(is_read);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_saved ON bookmarks(saved_at DESC);
  `);

  // FTS5 tables (separate try-catch since they can't use IF NOT EXISTS)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE articles_fts USING fts5(
        title, summary, content,
        content=articles, content_rowid=id
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
        INSERT INTO articles_fts(rowid, title, summary, content)
        VALUES (new.id, new.title, new.summary, new.content);
      END;
      CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
        INSERT INTO articles_fts(articles_fts, rowid, title, summary, content)
        VALUES ('delete', old.id, old.title, old.summary, old.content);
      END;
      CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
        INSERT INTO articles_fts(articles_fts, rowid, title, summary, content)
        VALUES ('delete', old.id, old.title, old.summary, old.content);
        INSERT INTO articles_fts(rowid, title, summary, content)
        VALUES (new.id, new.title, new.summary, new.content);
      END;
    `);
  } catch {
    // Already exists
  }

  // Migration: add type column if missing (for existing DBs)
  try {
    db.prepare(`SELECT type FROM feeds LIMIT 1`).get();
  } catch {
    db.exec(`ALTER TABLE feeds ADD COLUMN type TEXT DEFAULT 'rss'`);
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
        title, summary, notes,
        content=bookmarks, content_rowid=id
      );

      CREATE TRIGGER bookmarks_ai AFTER INSERT ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(rowid, title, summary, notes)
        VALUES (new.id, new.title, new.summary, new.notes);
      END;
      CREATE TRIGGER bookmarks_ad AFTER DELETE ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, summary, notes)
        VALUES ('delete', old.id, old.title, old.summary, old.notes);
      END;
      CREATE TRIGGER bookmarks_au AFTER UPDATE ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, summary, notes)
        VALUES ('delete', old.id, old.title, old.summary, old.notes);
        INSERT INTO bookmarks_fts(rowid, title, summary, notes)
        VALUES (new.id, new.title, new.summary, new.notes);
      END;
    `);
  } catch {
    // Already exists
  }
}

// ─── Feed Operations ───────────────────────────────────────────────────────

export function addFeed(name: string, url: string, category?: string, siteUrl?: string, type?: string) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO feeds (name, url, site_url, category, type) VALUES (?, ?, ?, ?, ?)`
  );
  const feedType = type || "rss";
  const result = stmt.run(name, url, siteUrl || null, category || "general", feedType);
  return { id: result.lastInsertRowid, name, url, category: category || "general", type: feedType };
}

export function removeFeed(id: number) {
  const db = getDb();
  const feed = db.prepare(`SELECT name, url FROM feeds WHERE id = ?`).get(id) as any;
  if (!feed) return null;
  db.prepare(`DELETE FROM feeds WHERE id = ?`).run(id);
  return feed;
}

export function listFeeds() {
  const db = getDb();
  return db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS total_articles,
      (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.is_read = 0) AS unread_count
    FROM feeds f ORDER BY f.category, f.name
  `).all();
}

export function getFeed(id: number) {
  const db = getDb();
  return db.prepare(`SELECT * FROM feeds WHERE id = ?`).get(id);
}

export function updateFeed(id: number, updates: Record<string, any>) {
  const db = getDb();
  const allowed = ["name", "url", "category", "check_interval_min", "is_active", "site_url"];
  const sets: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) {
      sets.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = datetime('now', 'localtime')`);
  values.push(id);
  db.prepare(`UPDATE feeds SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return db.prepare(`SELECT * FROM feeds WHERE id = ?`).get(id);
}

export function toggleFeed(id: number) {
  const db = getDb();
  db.prepare(`UPDATE feeds SET is_active = 1 - is_active, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(id);
  return db.prepare(`SELECT id, name, is_active FROM feeds WHERE id = ?`).get(id);
}

export function updateFeedChecked(id: number, error?: string) {
  const db = getDb();
  db.prepare(`
    UPDATE feeds SET last_checked_at = datetime('now', 'localtime'), last_error = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(error || null, id);
}

// ─── Article Operations ────────────────────────────────────────────────────

export function upsertArticles(feedId: number, articles: Array<{
  guid: string; title: string; link?: string; author?: string;
  summary?: string; content?: string; published_at?: string;
}>) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO articles (feed_id, guid, title, link, author, summary, content, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(feed_id, guid) DO NOTHING
  `);

  let newCount = 0;
  const insert = db.transaction(() => {
    for (const a of articles) {
      const r = stmt.run(feedId, a.guid, a.title, a.link || null,
        a.author || null, a.summary || null, a.content || null, a.published_at || null);
      if (r.changes > 0) newCount++;
    }
  });
  insert();
  return newCount;
}

export function getUnreadArticles(limit = 20, feedId?: number) {
  const db = getDb();
  if (feedId) {
    return db.prepare(`
      SELECT a.id, a.title, a.link, a.summary, a.published_at, a.feed_id, f.name AS feed_name
      FROM articles a JOIN feeds f ON a.feed_id = f.id
      WHERE a.is_read = 0 AND a.feed_id = ?
      ORDER BY a.published_at DESC LIMIT ?
    `).all(feedId, limit);
  }
  return db.prepare(`
    SELECT a.id, a.title, a.link, a.summary, a.published_at, a.feed_id, f.name AS feed_name
    FROM articles a JOIN feeds f ON a.feed_id = f.id
    WHERE a.is_read = 0
    ORDER BY a.published_at DESC LIMIT ?
  `).all(limit);
}

export function getLatestArticles(limit = 20, feedId?: number) {
  const db = getDb();
  if (feedId) {
    return db.prepare(`
      SELECT a.id, a.title, a.link, a.summary, a.published_at, a.is_read, a.feed_id, f.name AS feed_name
      FROM articles a JOIN feeds f ON a.feed_id = f.id
      WHERE a.feed_id = ?
      ORDER BY a.published_at DESC LIMIT ?
    `).all(feedId, limit);
  }
  return db.prepare(`
    SELECT a.id, a.title, a.link, a.summary, a.published_at, a.is_read, a.feed_id, f.name AS feed_name
    FROM articles a JOIN feeds f ON a.feed_id = f.id
    ORDER BY a.published_at DESC LIMIT ?
  `).all(limit);
}

export function getArticleDetail(id: number) {
  const db = getDb();
  const article = db.prepare(`
    SELECT a.*, f.name AS feed_name
    FROM articles a JOIN feeds f ON a.feed_id = f.id
    WHERE a.id = ?
  `).get(id);
  if (article) {
    db.prepare(`UPDATE articles SET is_read = 1 WHERE id = ?`).run(id);
  }
  return article;
}

export function markArticlesRead(ids: number[]) {
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE articles SET is_read = 1 WHERE id IN (${placeholders})`).run(...ids);
  return ids.length;
}

export function getLatestArticleDate(feedId: number): string | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT MAX(published_at) as latest FROM articles WHERE feed_id = ?`
  ).get(feedId) as any;
  return row?.latest || null;
}

export function searchArticles(query: string, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT a.id, a.title, a.link, a.summary, a.published_at, a.is_read, a.feed_id, f.name AS feed_name
    FROM articles_fts fts
    JOIN articles a ON a.id = fts.rowid
    JOIN feeds f ON a.feed_id = f.id
    WHERE articles_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(query, limit);
}

// ─── Bookmark Operations ───────────────────────────────────────────────────

export function saveBookmark(opts: {
  article_id?: number; title: string; url?: string;
  source?: string; summary?: string; content?: string; notes?: string;
  tags?: string[];
}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO bookmarks (article_id, title, url, source, summary, content, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    opts.article_id || null, opts.title, opts.url || null,
    opts.source || "manual", opts.summary || null,
    opts.content || null, opts.notes || null
  );
  const bookmarkId = result.lastInsertRowid as number;

  if (opts.tags?.length) {
    addTagsToBookmark(bookmarkId, opts.tags);
  }

  return { id: bookmarkId, ...opts };
}

export function saveBookmarkFromArticle(articleId: number, opts?: {
  summary?: string; notes?: string; tags?: string[];
}) {
  const db = getDb();
  const article = db.prepare(`SELECT * FROM articles WHERE id = ?`).get(articleId) as any;
  if (!article) return null;

  return saveBookmark({
    article_id: articleId,
    title: article.title,
    url: article.link,
    source: "rss",
    summary: opts?.summary || article.summary,
    content: article.content,
    notes: opts?.notes,
    tags: opts?.tags,
  });
}

export function listBookmarks(limit = 20) {
  const db = getDb();
  const bookmarks = db.prepare(`
    SELECT b.*, GROUP_CONCAT(t.name) AS tag_names
    FROM bookmarks b
    LEFT JOIN bookmark_tags bt ON b.id = bt.bookmark_id
    LEFT JOIN tags t ON bt.tag_id = t.id
    GROUP BY b.id
    ORDER BY b.saved_at DESC LIMIT ?
  `).all(limit);
  return bookmarks;
}

export function getBookmark(id: number) {
  const db = getDb();
  const bookmark = db.prepare(`
    SELECT b.*, GROUP_CONCAT(t.name) AS tag_names
    FROM bookmarks b
    LEFT JOIN bookmark_tags bt ON b.id = bt.bookmark_id
    LEFT JOIN tags t ON bt.tag_id = t.id
    WHERE b.id = ?
    GROUP BY b.id
  `).get(id);
  return bookmark;
}

export function removeBookmark(id: number) {
  const db = getDb();
  const bookmark = db.prepare(`SELECT title FROM bookmarks WHERE id = ?`).get(id) as any;
  if (!bookmark) return null;
  db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id);
  return bookmark;
}

export function searchBookmarks(query: string, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT b.id, b.title, b.url, b.summary, b.notes, b.saved_at,
           GROUP_CONCAT(t.name) AS tag_names
    FROM bookmarks_fts fts
    JOIN bookmarks b ON b.id = fts.rowid
    LEFT JOIN bookmark_tags bt ON b.id = bt.bookmark_id
    LEFT JOIN tags t ON bt.tag_id = t.id
    WHERE bookmarks_fts MATCH ?
    GROUP BY b.id
    ORDER BY rank LIMIT ?
  `).all(query, limit);
}

export function searchBookmarksByTag(tag: string, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT b.id, b.title, b.url, b.summary, b.notes, b.saved_at,
           GROUP_CONCAT(t2.name) AS tag_names
    FROM bookmarks b
    JOIN bookmark_tags bt ON b.id = bt.bookmark_id
    JOIN tags t ON bt.tag_id = t.id AND t.name = ?
    LEFT JOIN bookmark_tags bt2 ON b.id = bt2.bookmark_id
    LEFT JOIN tags t2 ON bt2.tag_id = t2.id
    GROUP BY b.id
    ORDER BY b.saved_at DESC LIMIT ?
  `).all(tag, limit);
}

// ─── Tag Operations ────────────────────────────────────────────────────────

export function addTagsToBookmark(bookmarkId: number, tagNames: string[]) {
  const db = getDb();
  const ensureTag = db.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`);
  const getTagId = db.prepare(`SELECT id FROM tags WHERE name = ?`);
  const link = db.prepare(`INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`);

  db.transaction(() => {
    for (const name of tagNames) {
      const normalized = name.toLowerCase().replace(/^#/, "").trim();
      if (!normalized) continue;
      ensureTag.run(normalized);
      const tag = getTagId.get(normalized) as any;
      if (tag) link.run(bookmarkId, tag.id);
    }
  })();
}

export function removeTagFromBookmark(bookmarkId: number, tagName: string) {
  const db = getDb();
  const normalized = tagName.toLowerCase().replace(/^#/, "").trim();
  const tag = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(normalized) as any;
  if (!tag) return false;
  db.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?`).run(bookmarkId, tag.id);
  return true;
}

export function listTags() {
  const db = getDb();
  return db.prepare(`
    SELECT t.name, COUNT(bt.bookmark_id) AS count
    FROM tags t
    LEFT JOIN bookmark_tags bt ON t.id = bt.tag_id
    GROUP BY t.id
    ORDER BY count DESC, t.name
  `).all();
}

// ─── Stats ─────────────────────────────────────────────────────────────────

export function getStats() {
  const db = getDb();
  const feeds = db.prepare(`SELECT COUNT(*) as c FROM feeds WHERE is_active = 1`).get() as any;
  const articles = db.prepare(`SELECT COUNT(*) as c FROM articles`).get() as any;
  const unread = db.prepare(`SELECT COUNT(*) as c FROM articles WHERE is_read = 0`).get() as any;
  const bookmarks = db.prepare(`SELECT COUNT(*) as c FROM bookmarks`).get() as any;
  const tags = db.prepare(`SELECT COUNT(*) as c FROM tags`).get() as any;
  return {
    active_feeds: feeds.c,
    total_articles: articles.c,
    unread_articles: unread.c,
    total_bookmarks: bookmarks.c,
    total_tags: tags.c,
  };
}
