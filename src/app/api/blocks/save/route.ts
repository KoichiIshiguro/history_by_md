import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseAction, todayISO } from "@/lib/actionDate";
import { NextRequest } from "next/server";

function extractTags(content: string): string[] {
  const matches = content.match(/#([^\s#{}]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

// Extracts {{path/to/page}} references — returns the full path strings
function extractPageRefs(content: string): string[] {
  const matches = content.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(2, -2).trim());
}

// Resolve a page path like "parent/child/grandchild" to a page ID, creating pages as needed
function resolvePageByPath(db: any, userId: string, fullPath: string): { id: string } {
  const parts = fullPath.split("/").map((p) => p.trim()).filter(Boolean);
  let parentId: string | null = null;

  const findByNameAndParent = db.prepare(
    "SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id IS ?"
  );
  const findByNameAndParentId = db.prepare(
    "SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id = ?"
  );
  const insertPage = db.prepare(
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
      insertPage.run(pageId, part, userId, parentId);
    }
    parentId = pageId;
  }
  return { id: pageId };
}

function computeBlockLinks(blocks: Array<{ content: string; indent_level: number }>) {
  const tagResults: string[][] = [];
  const pageResults: string[][] = [];
  const tagStack: Array<{ tags: string[]; indent: number }> = [];
  const pageStack: Array<{ pages: string[]; indent: number }> = [];

  for (const block of blocks) {
    while (tagStack.length > 0 && tagStack[tagStack.length - 1].indent >= block.indent_level) tagStack.pop();
    while (pageStack.length > 0 && pageStack[pageStack.length - 1].indent >= block.indent_level) pageStack.pop();

    const activeTags: string[] = [];
    for (const entry of tagStack) activeTags.push(...entry.tags);
    const activePages: string[] = [];
    for (const entry of pageStack) activePages.push(...entry.pages);

    const ownTags = extractTags(block.content);
    const ownPages = extractPageRefs(block.content);

    tagResults.push([...new Set([...activeTags, ...ownTags])]);
    pageResults.push([...new Set([...activePages, ...ownPages])]);

    if (ownTags.length > 0) tagStack.push({ tags: ownTags, indent: block.indent_level });
    if (ownPages.length > 0) pageStack.push({ pages: ownPages, indent: block.indent_level });
  }

  return { tagResults, pageResults };
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { date, pageId, blocks } = body as {
    date?: string;
    pageId?: string;
    blocks: Array<{
      id?: string;
      content: string;
      indent_level: number;
      sort_order: number;
    }>;
  };

  const { tagResults, pageResults } = computeBlockLinks(blocks);

  const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)");
  const insertBlockTag = db.prepare("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)");
  const insertBlockPage = db.prepare("INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)");

  if (pageId) {
    // Page content save
    const saveTransaction = db.transaction(() => {
      const existing = db.prepare("SELECT id FROM blocks WHERE user_id = ? AND page_id = ?").all(user.id, pageId) as { id: string }[];
      for (const b of existing) {
        db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(b.id);
        db.prepare("DELETE FROM block_pages WHERE block_id = ?").run(b.id);
      }
      db.prepare("DELETE FROM blocks WHERE user_id = ? AND page_id = ?").run(user.id, pageId);

      const insertBlock = db.prepare(
        `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, page_id, due_start, due_end)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`
      );

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const blockId = block.id || crypto.randomUUID();
        // Page blocks have no block.date — fallback to today for actions without @
        const meta = parseAction(block.content, todayISO());
        const dueStart = meta.isAction ? meta.dueStart : null;
        const dueEnd = meta.isAction ? meta.dueEnd : null;
        insertBlock.run(blockId, user.id, block.content, block.indent_level, block.sort_order, pageId, dueStart, dueEnd);

        for (const tagName of tagResults[i]) {
          let tag = findTag.get(tagName, user.id) as { id: string } | undefined;
          if (!tag) { const tid = crypto.randomUUID(); insertTag.run(tid, tagName, user.id); tag = { id: tid }; }
          insertBlockTag.run(blockId, tag.id);
        }
        for (const pagePath of pageResults[i]) {
          const page = resolvePageByPath(db, user.id, pagePath);
          insertBlockPage.run(blockId, page.id);
        }
      }
      // Clean up orphaned tags (no block references)
      db.prepare("DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT DISTINCT tag_id FROM block_tags)").run(user.id);
    });
    saveTransaction();
    return Response.json({ ok: true });
  }

  // Date page save
  const saveTransaction = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM blocks WHERE user_id = ? AND date = ? AND page_id IS NULL").all(user.id, date) as { id: string }[];
    for (const b of existing) {
      db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(b.id);
      db.prepare("DELETE FROM block_pages WHERE block_id = ?").run(b.id);
    }
    db.prepare("DELETE FROM blocks WHERE user_id = ? AND date = ? AND page_id IS NULL").run(user.id, date);

    const insertBlock = db.prepare(
      `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, due_start, due_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const blockId = block.id || crypto.randomUUID();
      // Date blocks: @ omitted → use this date as default
      const meta = parseAction(block.content, date || todayISO());
      const dueStart = meta.isAction ? meta.dueStart : null;
      const dueEnd = meta.isAction ? meta.dueEnd : null;
      insertBlock.run(blockId, user.id, date, block.content, block.indent_level, block.sort_order, dueStart, dueEnd);

      for (const tagName of tagResults[i]) {
        let tag = findTag.get(tagName, user.id) as { id: string } | undefined;
        if (!tag) { const tid = crypto.randomUUID(); insertTag.run(tid, tagName, user.id); tag = { id: tid }; }
        insertBlockTag.run(blockId, tag.id);
      }
      for (const pagePath of pageResults[i]) {
        const page = resolvePageByPath(db, user.id, pagePath);
        insertBlockPage.run(blockId, page.id);
      }
    }
    // Clean up orphaned tags (no block references)
    db.prepare("DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT DISTINCT tag_id FROM block_tags)").run(user.id);
  });
  saveTransaction();
  return Response.json({ ok: true });
}
