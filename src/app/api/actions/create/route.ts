import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayISO } from "@/lib/actionDate";
import { NextRequest } from "next/server";

/**
 * Create a new !action block at the end of today's date page.
 * If `pageId` is provided, the action is nested under a `{{page}}` parent block
 * (reusing existing `{{page}}` parent if one is already at indent 0 on today).
 * Otherwise the action is inserted as a top-level block.
 *
 * Body: { pageId?: string, content?: string }
 * Returns: { blockId: string }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { pageId, content: rawContent } = body as { pageId?: string; content?: string };

  const today = todayISO();
  const actionContent = (rawContent ?? "新しいアクション").trim() || "新しいアクション";
  const actionLine = actionContent.startsWith("!action ") || actionContent.startsWith("!done ")
    ? actionContent
    : `!action ${actionContent}`;

  // Fetch today's blocks (date-based only, no page_id)
  const todaysBlocks = db
    .prepare(
      `SELECT id, content, indent_level, sort_order FROM blocks
       WHERE user_id = ? AND date = ? AND page_id IS NULL
       ORDER BY sort_order ASC`
    )
    .all(user.id, today) as { id: string; content: string; indent_level: number; sort_order: number }[];

  const maxSort = todaysBlocks.reduce((m, b) => Math.max(m, b.sort_order), -1);
  let newBlockId: string;

  const tx = db.transaction(() => {
    if (pageId) {
      // Need: find or create {{pageName}} parent block at indent 0 on today's page
      const page = db.prepare("SELECT id, name FROM pages WHERE id = ? AND user_id = ?").get(pageId, user.id) as { id: string; name: string } | undefined;
      if (!page) throw new Error("Page not found");

      // Build the full path for the {{page}} reference (matches how resolvePageByPath parses)
      const pathParts: string[] = [];
      let cur: any = page;
      while (cur) {
        pathParts.unshift(cur.name);
        const parent = db.prepare("SELECT p.id, p.name FROM pages p JOIN pages c ON c.parent_id = p.id WHERE c.id = ? AND p.user_id = ?").get(cur.id, user.id) as any;
        cur = parent;
      }
      const fullPath = pathParts.join("/");
      const pageRefContent = `{{${fullPath}}}`;

      // Look for an existing {{pageName}} parent block at indent 0 whose content contains this ref
      // We match by checking the block_pages linkage AND indent_level 0
      let parentBlock = todaysBlocks.find((b) =>
        b.indent_level === 0 && b.content.includes(pageRefContent)
      );

      let parentId: string;
      let parentIndent: number;
      let insertAfterSort: number;

      if (parentBlock) {
        parentId = parentBlock.id;
        parentIndent = parentBlock.indent_level;
        // Find the last child of this parent (consecutive blocks with indent > parent's indent)
        const parentIdx = todaysBlocks.findIndex((b) => b.id === parentBlock!.id);
        let lastChildIdx = parentIdx;
        for (let i = parentIdx + 1; i < todaysBlocks.length; i++) {
          if (todaysBlocks[i].indent_level > parentIndent) lastChildIdx = i;
          else break;
        }
        insertAfterSort = todaysBlocks[lastChildIdx].sort_order;
        // Shift sort_order of blocks after insertAfterSort by +1
        db.prepare(`UPDATE blocks SET sort_order = sort_order + 1, version = version + 1, updated_at = datetime('now') WHERE user_id = ? AND date = ? AND page_id IS NULL AND sort_order > ?`)
          .run(user.id, today, insertAfterSort);
      } else {
        // Insert new {{page}} parent at end, then action as child
        parentIndent = 0;
        parentId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))`
        ).run(parentId, user.id, today, pageRefContent, maxSort + 1);
        // Link block_pages
        db.prepare("INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)").run(parentId, pageId);
        insertAfterSort = maxSort + 1;
      }

      // Insert the action as child of the parent
      newBlockId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, due_start, due_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(newBlockId, user.id, today, actionLine, parentIndent + 1, insertAfterSort + 1, today, today);
      // Link the action to this page too (inherits parent context)
      db.prepare("INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)").run(newBlockId, pageId);
    } else {
      // No page — just append the action at the end of today's date page
      newBlockId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, due_start, due_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(newBlockId, user.id, today, actionLine, maxSort + 1, today, today);
    }
  });
  tx();

  return Response.json({ blockId: newBlockId! });
}
