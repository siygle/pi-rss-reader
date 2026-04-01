import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as path from "node:path";
import * as os from "node:os";
import * as db from "./db.js";
import * as fetcher from "./fetcher.js";
import * as opml from "./opml.js";

export default function (pi: ExtensionAPI) {
  // Initialize DB on load
  try {
    db.getDb();
  } catch (err: any) {
    console.error("RSS Reader: Failed to initialize database:", err.message);
  }

  // ─── Tool: rss_manage ──────────────────────────────────────────────────

  pi.registerTool({
    name: "rss_manage",
    label: "RSS Feed Management",
    description:
      "Manage RSS feed subscriptions: add, remove, list, update, toggle, import/export OPML.",
    promptSnippet:
      "Manage RSS feeds (add/remove/list/toggle/import/export OPML)",
    promptGuidelines: [
      "When user wants to add an RSS feed, use rss_manage with action 'add'. Try to discover the feed first to get a good name.",
      "When user uploads an OPML file, use rss_manage with action 'import' and the file path.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "add",
        "remove",
        "list",
        "update",
        "toggle",
        "export",
        "import",
      ] as const),
      name: Type.Optional(
        Type.String({ description: "Feed display name" })
      ),
      url: Type.Optional(
        Type.String({ description: "RSS/Atom feed URL" })
      ),
      category: Type.Optional(
        Type.String({ description: "Feed category (e.g., tech, finance, news)" })
      ),
      feed_id: Type.Optional(
        Type.Number({ description: "Feed ID for remove/update/toggle" })
      ),
      path: Type.Optional(
        Type.String({ description: "File path for OPML import/export" })
      ),
      updates: Type.Optional(
        Type.Object(
          {
            name: Type.Optional(Type.String()),
            category: Type.Optional(Type.String()),
            check_interval_min: Type.Optional(Type.Number()),
          },
          { description: "Fields to update" }
        )
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        switch (params.action) {
          case "add": {
            if (!params.url) {
              return error("URL is required to add a feed");
            }
            // Discover feed info if name not provided
            let name = params.name;
            if (!name) {
              const info = await fetcher.discoverFeed(params.url);
              name = info?.title || params.url;
            }
            const feed = db.addFeed(name, params.url, params.category);
            // Fetch initial articles
            const result = await fetcher.fetchFeed(feed.id as number);
            return ok({
              message: `Feed "${name}" added successfully`,
              feed,
              initial_fetch: result,
            });
          }

          case "remove": {
            if (!params.feed_id) return error("feed_id is required");
            const removed = db.removeFeed(params.feed_id);
            if (!removed) return error(`Feed #${params.feed_id} not found`);
            return ok({ message: `Feed "${removed.name}" removed`, feed: removed });
          }

          case "list": {
            const feeds = db.listFeeds();
            const stats = db.getStats();
            return ok({ stats, feeds });
          }

          case "update": {
            if (!params.feed_id) return error("feed_id is required");
            const updated = db.updateFeed(params.feed_id, params.updates || {});
            if (!updated) return error(`Feed #${params.feed_id} not found or nothing to update`);
            return ok({ message: "Feed updated", feed: updated });
          }

          case "toggle": {
            if (!params.feed_id) return error("feed_id is required");
            const toggled = db.toggleFeed(params.feed_id) as any;
            if (!toggled) return error(`Feed #${params.feed_id} not found`);
            const state = toggled.is_active ? "enabled" : "disabled";
            return ok({ message: `Feed "${toggled.name}" ${state}`, feed: toggled });
          }

          case "export": {
            const outputPath =
              params.path || path.join(os.homedir(), ".pi", "rss-feeds.opml");
            const result = opml.exportOpml(outputPath);
            return ok({ message: `Exported ${result.feed_count} feeds`, ...result });
          }

          case "import": {
            if (!params.path) return error("File path is required for import");
            const result = opml.importOpml(params.path);
            return ok({
              message: `Imported ${result.imported} feeds, skipped ${result.skipped} duplicates`,
              ...result,
            });
          }

          default:
            return error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        return error(err.message);
      }
    },
  });

  // ─── Tool: rss_read ────────────────────────────────────────────────────

  pi.registerTool({
    name: "rss_read",
    label: "RSS Read Articles",
    description:
      "Read RSS articles: list unread, latest, search, or view article detail.",
    promptSnippet:
      "Read RSS articles (unread/latest/search/detail/mark-read)",
    parameters: Type.Object({
      action: StringEnum([
        "unread",
        "latest",
        "search",
        "feed",
        "detail",
        "mark_read",
      ] as const),
      feed_id: Type.Optional(
        Type.Number({ description: "Filter by feed ID" })
      ),
      query: Type.Optional(
        Type.String({ description: "Search query (FTS5)" })
      ),
      article_id: Type.Optional(
        Type.Number({ description: "Article ID for detail view" })
      ),
      article_ids: Type.Optional(
        Type.Array(Type.Number(), { description: "Article IDs to mark as read" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 20)" })
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const limit = params.limit || 20;

        switch (params.action) {
          case "unread": {
            const articles = db.getUnreadArticles(limit, params.feed_id);
            return ok({
              count: articles.length,
              articles: formatArticleList(articles as any[]),
            });
          }

          case "latest": {
            const articles = db.getLatestArticles(limit, params.feed_id);
            return ok({
              count: articles.length,
              articles: formatArticleList(articles as any[]),
            });
          }

          case "search": {
            if (!params.query) return error("query is required for search");
            const articles = db.searchArticles(params.query, limit);
            return ok({
              query: params.query,
              count: articles.length,
              articles: formatArticleList(articles as any[]),
            });
          }

          case "feed": {
            if (!params.feed_id) return error("feed_id is required");
            const articles = db.getLatestArticles(limit, params.feed_id);
            return ok({
              feed_id: params.feed_id,
              count: articles.length,
              articles: formatArticleList(articles as any[]),
            });
          }

          case "detail": {
            if (!params.article_id) return error("article_id is required");
            const article = db.getArticleDetail(params.article_id) as any;
            if (!article) return error(`Article #${params.article_id} not found`);
            return ok({
              id: article.id,
              title: article.title,
              feed: article.feed_name,
              link: article.link,
              author: article.author,
              published_at: article.published_at,
              summary: article.summary,
              content: article.content
                ? article.content.substring(0, 5000)
                : null,
              content_truncated:
                article.content && article.content.length > 5000,
            });
          }

          case "mark_read": {
            if (!params.article_ids?.length) return error("article_ids required");
            const count = db.markArticlesRead(params.article_ids);
            return ok({ message: `Marked ${count} articles as read` });
          }

          default:
            return error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        return error(err.message);
      }
    },
  });

  // ─── Tool: rss_bookmark ────────────────────────────────────────────────

  pi.registerTool({
    name: "rss_bookmark",
    label: "RSS Bookmark",
    description:
      "Save and manage bookmarked articles with tags. Can save from RSS or manually by URL/title.",
    promptSnippet:
      "Bookmark articles with auto-tagging, search saved items",
    promptGuidelines: [
      "When saving a bookmark, always include relevant tags based on the article content.",
      "Use rss_bookmark search to find previously saved articles.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "save",
        "save_article",
        "list",
        "search",
        "search_tag",
        "detail",
        "remove",
        "tag",
        "untag",
        "tags",
      ] as const),
      article_id: Type.Optional(
        Type.Number({ description: "RSS article ID to bookmark" })
      ),
      bookmark_id: Type.Optional(
        Type.Number({ description: "Bookmark ID for operations" })
      ),
      title: Type.Optional(Type.String({ description: "Article title" })),
      url: Type.Optional(Type.String({ description: "Article URL" })),
      summary: Type.Optional(
        Type.String({ description: "AI-generated summary" })
      ),
      notes: Type.Optional(Type.String({ description: "User notes" })),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tags to add (auto-generated or user-specified)",
        })
      ),
      query: Type.Optional(Type.String({ description: "Search query" })),
      tag: Type.Optional(
        Type.String({ description: "Tag name for search/untag" })
      ),
      limit: Type.Optional(Type.Number({ description: "Max results" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const limit = params.limit || 20;

        switch (params.action) {
          case "save_article": {
            if (!params.article_id)
              return error("article_id is required");
            const bookmark = db.saveBookmarkFromArticle(
              params.article_id,
              {
                summary: params.summary,
                notes: params.notes,
                tags: params.tags,
              }
            );
            if (!bookmark) return error(`Article #${params.article_id} not found`);
            return ok({
              message: `Bookmarked "${bookmark.title}"`,
              bookmark,
            });
          }

          case "save": {
            if (!params.title && !params.url)
              return error("title or url is required");
            const bookmark = db.saveBookmark({
              title: params.title || params.url || "",
              url: params.url,
              source: "manual",
              summary: params.summary,
              notes: params.notes,
              tags: params.tags,
            });
            return ok({
              message: `Bookmarked "${bookmark.title}"`,
              bookmark,
            });
          }

          case "list": {
            const bookmarks = db.listBookmarks(limit);
            return ok({
              count: bookmarks.length,
              bookmarks: formatBookmarkList(bookmarks as any[]),
            });
          }

          case "search": {
            if (!params.query) return error("query is required");
            const bookmarks = db.searchBookmarks(params.query, limit);
            return ok({
              query: params.query,
              count: bookmarks.length,
              bookmarks: formatBookmarkList(bookmarks as any[]),
            });
          }

          case "search_tag": {
            if (!params.tag) return error("tag is required");
            const bookmarks = db.searchBookmarksByTag(params.tag, limit);
            return ok({
              tag: params.tag,
              count: bookmarks.length,
              bookmarks: formatBookmarkList(bookmarks as any[]),
            });
          }

          case "detail": {
            if (!params.bookmark_id) return error("bookmark_id is required");
            const bookmark = db.getBookmark(params.bookmark_id);
            if (!bookmark) return error(`Bookmark #${params.bookmark_id} not found`);
            return ok({ bookmark });
          }

          case "remove": {
            if (!params.bookmark_id) return error("bookmark_id is required");
            const removed = db.removeBookmark(params.bookmark_id) as any;
            if (!removed)
              return error(`Bookmark #${params.bookmark_id} not found`);
            return ok({ message: `Removed "${removed.title}"` });
          }

          case "tag": {
            if (!params.bookmark_id || !params.tags?.length)
              return error("bookmark_id and tags are required");
            db.addTagsToBookmark(params.bookmark_id, params.tags);
            return ok({
              message: `Added tags [${params.tags.join(", ")}] to bookmark #${params.bookmark_id}`,
            });
          }

          case "untag": {
            if (!params.bookmark_id || !params.tag)
              return error("bookmark_id and tag are required");
            db.removeTagFromBookmark(params.bookmark_id, params.tag);
            return ok({
              message: `Removed tag "${params.tag}" from bookmark #${params.bookmark_id}`,
            });
          }

          case "tags": {
            const tags = db.listTags();
            return ok({ tags });
          }

          default:
            return error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        return error(err.message);
      }
    },
  });

  // ─── Tool: rss_check ───────────────────────────────────────────────────

  pi.registerTool({
    name: "rss_check",
    label: "RSS Check Updates",
    description:
      "Check RSS feeds for new articles. Can check all feeds or a specific one.",
    promptSnippet: "Check RSS feeds for new articles",
    parameters: Type.Object({
      feed_id: Type.Optional(
        Type.Number({ description: "Specific feed ID to check, omit for all" })
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        let results: fetcher.FetchResult[];
        if (params.feed_id) {
          const r = await fetcher.fetchFeed(params.feed_id);
          results = [r];
        } else {
          results = await fetcher.fetchAllFeeds();
        }

        const totalNew = results.reduce((s, r) => s + r.new_articles, 0);
        const errors = results.filter((r) => r.error);

        return ok({
          message: `Checked ${results.length} feeds, found ${totalNew} new articles`,
          total_new: totalNew,
          results,
          errors_count: errors.length,
        });
      } catch (err: any) {
        return error(err.message);
      }
    },
  });

  // ─── Command: /rss ─────────────────────────────────────────────────────

  pi.registerCommand("rss", {
    description: "RSS Reader overview and quick actions",
    handler: async (_args, ctx) => {
      try {
        const stats = db.getStats();
        const feeds = db.listFeeds() as any[];

        const lines = [
          "📰 RSS Reader",
          "",
          `📡 Feeds: ${stats.active_feeds} active`,
          `📄 Articles: ${stats.total_articles} total, ${stats.unread_articles} unread`,
          `🔖 Bookmarks: ${stats.total_bookmarks}`,
          `🏷️ Tags: ${stats.total_tags}`,
        ];

        if (feeds.length > 0) {
          lines.push("", "📡 Feeds:");
          for (const f of feeds) {
            const status = f.is_active ? "✅" : "⏸️";
            lines.push(
              `  ${status} #${f.id} ${f.name} [${f.category}] (${f.unread_count} unread)`
            );
          }
        } else {
          lines.push("", "No feeds yet. Ask me to add one!");
        }

        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`❌ ${err.message}`, "error");
      }
    },
  });

  // ─── Helpers ───────────────────────────────────────────────────────────

  function ok(data: any) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      details: data,
    };
  }

  function error(msg: string) {
    throw new Error(msg);
  }

  function formatArticleList(articles: any[]) {
    return articles.map((a) => ({
      id: a.id,
      title: a.title,
      feed: a.feed_name,
      link: a.link,
      published: a.published_at,
      is_read: a.is_read === 1,
      summary: a.summary?.substring(0, 150),
    }));
  }

  function formatBookmarkList(bookmarks: any[]) {
    return bookmarks.map((b) => ({
      id: b.id,
      title: b.title,
      url: b.url,
      tags: b.tag_names ? b.tag_names.split(",") : [],
      saved_at: b.saved_at,
      summary: b.summary?.substring(0, 150),
    }));
  }
}
