import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const date = request.nextUrl.searchParams.get("date");
  const pageId = request.nextUrl.searchParams.get("pageId");
  const tagId = request.nextUrl.searchParams.get("tagId");

  if (pageId) {
    // Page view: 3 sections
    // 1. Page's own content blocks (page_id = pageId)
    const pageBlocks = db
      .prepare(
        `SELECT b.* FROM blocks b
         WHERE b.page_id = ? AND b.user_id = ?
         ORDER BY b.sort_order ASC`
      )
      .all(pageId, user.id);

    // 2. References from other pages (blocks on other pages that mention this page via {{page}})
    const pageRefs = db
      .prepare(
        `SELECT b.*, p.name as source_page_name, p.id as source_page_id
         FROM blocks b
         JOIN block_pages bp ON bp.block_id = b.id
         JOIN pages p ON p.id = b.page_id
         WHERE bp.page_id = ? AND b.user_id = ? AND b.page_id != ?
         ORDER BY b.updated_at DESC, b.sort_order ASC`
      )
      .all(pageId, user.id, pageId);

    // 3. References from dates (date blocks that mention this page)
    const dateRefs = db
      .prepare(
        `SELECT b.*
         FROM blocks b
         JOIN block_pages bp ON bp.block_id = b.id
         WHERE bp.page_id = ? AND b.user_id = ? AND b.page_id IS NULL AND b.date != ''
         ORDER BY b.date DESC, b.sort_order ASC`
      )
      .all(pageId, user.id);

    return Response.json({ pageBlocks, pageRefs, dateRefs });
  }

  if (tagId) {
    // Tag view: blocks that have this tag
    const blocks = db
      .prepare(
        `SELECT b.*
         FROM blocks b
         JOIN block_tags bt ON bt.block_id = b.id
         WHERE bt.tag_id = ? AND b.user_id = ?
         ORDER BY b.date DESC, b.sort_order ASC`
      )
      .all(tagId, user.id);
    return Response.json(blocks);
  }

  if (date) {
    const blocks = db
      .prepare(
        `SELECT b.*
         FROM blocks b
         WHERE b.user_id = ? AND b.date = ? AND b.page_id IS NULL
         ORDER BY b.sort_order ASC`
      )
      .all(user.id, date);
    return Response.json(blocks);
  }

  // Get recent dates
  const dates = db
    .prepare(
      `SELECT DISTINCT date FROM blocks WHERE user_id = ? AND date != '' AND page_id IS NULL ORDER BY date DESC LIMIT 30`
    )
    .all(user.id);
  return Response.json(dates);
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { id, content, indent_level, sort_order } = body;

  const block = db.prepare("SELECT date, page_id FROM blocks WHERE id = ? AND user_id = ?").get(id, user.id) as { date: string; page_id: string | null } | undefined;
  if (!block) {
    return Response.json({ error: "Block not found" }, { status: 404 });
  }

  const updateTransaction = db.transaction(() => {
    db.prepare(
      `UPDATE blocks SET content = ?, indent_level = ?, sort_order = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).run(content, indent_level || 0, sort_order || 0, id, user.id);

    // Recompute tags and page refs for this block's context
    if (!block.page_id && block.date) {
      recomputeLinksForDate(db, user.id, block.date);
    }
  });

  updateTransaction();
  return Response.json({ ok: true });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { id, content, indent_level, sort_order, date, page_id } = body;

  db.prepare(
    `INSERT INTO blocks (id, content, indent_level, sort_order, date, page_id, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(id, content || "", indent_level || 0, sort_order || 0, date || "", page_id || null, user.id);

  // Recompute links if it's a date block
  if (!page_id && date) {
    recomputeLinksForDate(db, user.id, date);
  }

  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const { id } = await request.json();
  db.prepare("DELETE FROM blocks WHERE id = ? AND user_id = ?").run(id, user.id);
  return Response.json({ ok: true });
}

// Extract #tags from content
function extractTags(content: string): string[] {
  const matches = content.match(/#([^\s#{}]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

// Extract {{path/to/page}} references from content
function extractPageRefs(content: string): string[] {
  const matches = content.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(2, -2).trim());
}

// Resolve page path to ID, creating pages along the way as needed
function resolvePageByPath(db: any, userId: string, fullPath: string): { id: string } {
  const parts = fullPath.split("/").map((p) => p.trim()).filter(Boolean);
  let parentId: string | null = null;

  const findByNameAndParent = db.prepare(
    "SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id IS ?"
  );
  const findByNameAndParentId = db.prepare(
    "SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id = ?"
  );
  const insertPageStmt = db.prepare(
    "INSERT OR IGNORE INTO pages (id, name, user_id, parent_id, sort_order) VALUES (?, ?, ?, ?, 0)"
  );

  let pageId = "";
  for (const part of parts) {
    let found: { id: string } | undefined;
    if (parentId === null) {
      found = findByNameAndParent.get(part, userId, null) as { id: string } | undefined;
    } else {
      found = findByNameAndParentId.get(part, userId, parentId) as { id: string } | undefined;
    }
    if (found) {
      pageId = found.id;
    } else {
      pageId = crypto.randomUUID();
      insertPageStmt.run(pageId, part, userId, parentId);
    }
    parentId = pageId;
  }
  return { id: pageId };
}

function recomputeLinksForDate(db: any, userId: string, date: string) {
  const allBlocks = db
    .prepare("SELECT id, content, indent_level FROM blocks WHERE user_id = ? AND date = ? AND page_id IS NULL ORDER BY sort_order ASC")
    .all(userId, date) as { id: string; content: string; indent_level: number }[];

  const tagStack: Array<{ tags: string[]; indent: number }> = [];
  const pageStack: Array<{ pages: string[]; indent: number }> = [];

  const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)");
  const insertBlockTag = db.prepare("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)");
  const insertBlockPage = db.prepare("INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)");

  for (const block of allBlocks) {
    while (tagStack.length > 0 && tagStack[tagStack.length - 1].indent >= block.indent_level) tagStack.pop();
    while (pageStack.length > 0 && pageStack[pageStack.length - 1].indent >= block.indent_level) pageStack.pop();

    const activeTags: string[] = [];
    for (const entry of tagStack) activeTags.push(...entry.tags);
    const activePages: string[] = [];
    for (const entry of pageStack) activePages.push(...entry.pages);

    const ownTags = extractTags(block.content);
    const ownPages = extractPageRefs(block.content);
    const allTags = [...new Set([...activeTags, ...ownTags])];
    const allPages = [...new Set([...activePages, ...ownPages])];

    // Clear and re-insert
    db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(block.id);
    db.prepare("DELETE FROM block_pages WHERE block_id = ?").run(block.id);

    for (const tagName of allTags) {
      let tag = findTag.get(tagName, userId) as { id: string } | undefined;
      if (!tag) {
        const tagId = crypto.randomUUID();
        insertTag.run(tagId, tagName, userId);
        tag = { id: tagId };
      }
      insertBlockTag.run(block.id, tag.id);
    }

    for (const pagePath of allPages) {
      const page = resolvePageByPath(db, userId, pagePath);
      insertBlockPage.run(block.id, page.id);
    }

    if (ownTags.length > 0) tagStack.push({ tags: ownTags, indent: block.indent_level });
    if (ownPages.length > 0) pageStack.push({ pages: ownPages, indent: block.indent_level });
  }
}
