import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseAction, todayISO, normalizeActionDate } from "@/lib/actionDate";
import { scopeVersion } from "@/lib/blockVersion";
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
  const { date, pageId, meetingId, expectedVersion, blocks } = body as {
    date?: string;
    pageId?: string;
    meetingId?: string;
    /**
     * Optimistic concurrency token — the `version` the client received when
     * it last fetched this scope. If the server's current version differs,
     * return 409 so the client can show a conflict dialog.
     */
    expectedVersion?: string | null;
    blocks: Array<{
      id?: string;
      content: string;
      indent_level: number;
      sort_order: number;
    }>;
  };

  // Version check (only when client provides expectedVersion)
  if (expectedVersion !== undefined && expectedVersion !== null) {
    const scope = meetingId
      ? { user_id: user.id, meeting_id: meetingId }
      : pageId
        ? { user_id: user.id, page_id: pageId }
        : { user_id: user.id, date: date || "" };
    const currentVersion = scopeVersion(db, scope);
    // If the scope has blocks and their version doesn't match, reject.
    // (Empty scope with null version is acceptable — no prior state to conflict with.)
    if (currentVersion && currentVersion !== expectedVersion) {
      return Response.json({
        code: "VERSION_CONFLICT",
        error: "他のデバイスでこのページが更新されています",
        currentVersion,
      }, { status: 409 });
    }
  }

  // Normalize action date specs in content upfront so storage always holds
  // the full `@YYYY/MM/DD-YYYY/MM/DD` form. This freezes the year against
  // calendar-rollover drift: a "!action@4/3" typed in 2026 saved a year
  // later still means 2026/04/03, not 2027/04/03.
  const scopeDefaultDate = meetingId || pageId ? todayISO() : (date || todayISO());
  for (const b of blocks) {
    b.content = normalizeActionDate(b.content, scopeDefaultDate);
  }

  const { tagResults, pageResults } = computeBlockLinks(blocks);

  const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)");
  const insertBlockTag = db.prepare("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)");
  const insertBlockPage = db.prepare("INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)");

  /**
   * The bulk save does DELETE-all + INSERT-all for the scope, which triggers
   * ON DELETE CASCADE on action_slots (they reference blocks.id). That would
   * silently wipe the user's calendar assignments whenever they edited any
   * action block. Save the slots for blocks that will be re-inserted, then
   * restore them after the new INSERTs run. Slots whose action_block_id no
   * longer appears in the incoming block list are intentionally NOT restored
   * (the user deleted that action block, so the slot should follow).
   */
  const incomingBlockIds = new Set(blocks.map((b) => b.id).filter((id): id is string => !!id));
  const preservedSlots: Array<{
    id: string; user_id: string; action_block_id: string;
    start_at: string; end_at: string; created_at: string; updated_at: string;
  }> = incomingBlockIds.size > 0
    ? (db.prepare(
        `SELECT id, user_id, action_block_id, start_at, end_at, created_at, updated_at
           FROM action_slots
          WHERE user_id = ?
            AND action_block_id IN (${Array.from(incomingBlockIds).map(() => "?").join(",")})`
      ).all(user.id, ...Array.from(incomingBlockIds)) as any[])
    : [];
  const restoreSlotStmt = db.prepare(
    `INSERT OR IGNORE INTO action_slots (id, user_id, action_block_id, start_at, end_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const restorePreservedSlots = () => {
    for (const s of preservedSlots) {
      restoreSlotStmt.run(s.id, s.user_id, s.action_block_id, s.start_at, s.end_at, s.created_at, s.updated_at);
    }
  };

  /**
   * Preserve per-block version counter across the DELETE+INSERT rewrite.
   * Without this every save resets every block's version back to 1, which
   * makes the optimistic-concurrency token (MAX(version)) unable to detect
   * any conflict beyond the very first one. We snapshot {id -> version}
   * before delete and re-stamp after insert so version is monotonic across
   * saves for blocks that survive (and effectively bumped, since we'll set
   * it to old+1).
   */
  const versionRows: Array<{ id: string; version: number }> = incomingBlockIds.size > 0
    ? (db.prepare(
        `SELECT id, version FROM blocks
          WHERE user_id = ?
            AND id IN (${Array.from(incomingBlockIds).map(() => "?").join(",")})`
      ).all(user.id, ...Array.from(incomingBlockIds)) as any[])
    : [];
  const versionMap = new Map<string, number>(versionRows.map((r) => [r.id, r.version]));
  const stampVersionStmt = db.prepare("UPDATE blocks SET version = ? WHERE id = ? AND user_id = ?");
  const restampVersions = (idList: string[]) => {
    for (const id of idList) {
      const prev = versionMap.get(id);
      // Surviving block: prev+1. New block: stays at default 1 (skip).
      if (prev != null) stampVersionStmt.run(prev + 1, id, user.id);
    }
  };

  if (meetingId) {
    // Meeting content save — blocks belong to a meeting (not a page)
    const saveTransaction = db.transaction(() => {
      const existing = db.prepare("SELECT id FROM blocks WHERE user_id = ? AND meeting_id = ?").all(user.id, meetingId) as { id: string }[];
      for (const b of existing) {
        db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(b.id);
        db.prepare("DELETE FROM block_pages WHERE block_id = ?").run(b.id);
      }
      db.prepare("DELETE FROM blocks WHERE user_id = ? AND meeting_id = ?").run(user.id, meetingId);

      const insertBlock = db.prepare(
        `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, meeting_id, due_start, due_end)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`
      );

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const blockId = block.id || crypto.randomUUID();
        const meta = parseAction(block.content, todayISO());
        const dueStart = meta.isAction ? meta.dueStart : null;
        const dueEnd = meta.isAction ? meta.dueEnd : null;
        insertBlock.run(blockId, user.id, block.content, block.indent_level, block.sort_order, meetingId, dueStart, dueEnd);

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
      db.prepare("DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT DISTINCT tag_id FROM block_tags)").run(user.id);
      restorePreservedSlots(); restampVersions(Array.from(incomingBlockIds));
    });
    saveTransaction();
    const newVersion = scopeVersion(db, { user_id: user.id, meeting_id: meetingId });
    return Response.json({ ok: true, version: newVersion });
  }

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
      restorePreservedSlots(); restampVersions(Array.from(incomingBlockIds));
    });
    saveTransaction();
    const newVersion = scopeVersion(db, { user_id: user.id, page_id: pageId });
    return Response.json({ ok: true, version: newVersion });
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
    restorePreservedSlots(); restampVersions(Array.from(incomingBlockIds));
  });
  saveTransaction();
  const newVersion = scopeVersion(db, { user_id: user.id, date: date || "" });
  return Response.json({ ok: true, version: newVersion });
}
