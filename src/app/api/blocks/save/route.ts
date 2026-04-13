import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

// Bulk save endpoint - saves entire page content at once
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { date, blocks } = body as {
    date: string;
    blocks: Array<{
      id?: string;
      content: string;
      indent_level: number;
      sort_order: number;
      parent_id?: string;
      tags: string[];
    }>;
  };

  const saveTransaction = db.transaction(() => {
    // Delete existing blocks for this date
    const existingBlocks = db
      .prepare("SELECT id FROM blocks WHERE user_id = ? AND date = ?")
      .all(user.id, date) as { id: string }[];
    for (const block of existingBlocks) {
      db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(block.id);
    }
    db.prepare("DELETE FROM blocks WHERE user_id = ? AND date = ?").run(user.id, date);

    // Insert new blocks
    const insertBlock = db.prepare(
      `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTag = db.prepare(
      "INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)"
    );
    const insertBlockTag = db.prepare(
      "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)"
    );
    const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");

    for (const block of blocks) {
      const blockId = block.id || crypto.randomUUID();
      insertBlock.run(
        blockId,
        user.id,
        date,
        block.content,
        block.indent_level,
        block.sort_order,
        block.parent_id || null
      );

      if (block.tags && block.tags.length > 0) {
        for (const tagName of block.tags) {
          let tag = findTag.get(tagName, user.id) as { id: string } | undefined;
          if (!tag) {
            const tagId = crypto.randomUUID();
            insertTag.run(tagId, tagName, user.id);
            tag = { id: tagId };
          }
          insertBlockTag.run(blockId, tag.id);
        }
      }
    }
  });

  saveTransaction();
  return Response.json({ ok: true });
}
