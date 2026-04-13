import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

function extractTags(content: string): string[] {
  const matches = content.match(/#([^\s#]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

// Given an ordered list of blocks, compute which tags apply to each block.
// A #tag on a block "owns" all subsequent blocks that are indented deeper,
// until a block at the same or shallower indent level is reached.
function computeBlockTags(
  blocks: Array<{ content: string; indent_level: number }>
): string[][] {
  const result: string[][] = [];
  // Stack of active tags: { tagNames, indent_level }
  const tagStack: Array<{ tags: string[]; indent: number }> = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockIndent = block.indent_level;

    // Pop tags from stack that are at same or deeper indent than current block
    while (tagStack.length > 0 && tagStack[tagStack.length - 1].indent >= blockIndent) {
      tagStack.pop();
    }

    // Collect all active tags from the stack
    const activeTags: string[] = [];
    for (const entry of tagStack) {
      activeTags.push(...entry.tags);
    }

    // Extract tags from this block's own content
    const ownTags = extractTags(block.content);

    // This block gets: inherited tags + own tags
    result.push([...new Set([...activeTags, ...ownTags])]);

    // If this block has tags, push onto stack for children
    if (ownTags.length > 0) {
      tagStack.push({ tags: ownTags, indent: blockIndent });
    }
  }

  return result;
}

// Bulk save endpoint - saves entire page content at once
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { date, tagId, blocks } = body as {
    date?: string;
    tagId?: string;
    blocks: Array<{
      id?: string;
      content: string;
      indent_level: number;
      sort_order: number;
      parent_id?: string;
    }>;
  };

  if (tagId) {
    // Tag page save: blocks belong directly to a tag page
    const saveTransaction = db.transaction(() => {
      // Delete existing page blocks and their block_tags
      const existing = db.prepare("SELECT id FROM blocks WHERE user_id = ? AND tag_id = ?").all(user.id, tagId) as { id: string }[];
      for (const b of existing) {
        db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(b.id);
      }
      db.prepare("DELETE FROM blocks WHERE user_id = ? AND tag_id = ?").run(user.id, tagId);

      const insertBlock = db.prepare(
        `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, tag_id)
         VALUES (?, ?, '', ?, ?, ?, ?)`
      );
      const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");
      const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)");
      const insertBlockTag = db.prepare("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)");

      for (const block of blocks) {
        const blockId = block.id || crypto.randomUUID();
        insertBlock.run(blockId, user.id, block.content, block.indent_level, block.sort_order, tagId);

        // Extract and create tags from content
        const tagNames = extractTags(block.content);
        for (const tagName of tagNames) {
          let tag = findTag.get(tagName, user.id) as { id: string } | undefined;
          if (!tag) {
            const newTagId = crypto.randomUUID();
            insertTag.run(newTagId, tagName, user.id);
            tag = { id: newTagId };
          }
          insertBlockTag.run(blockId, tag.id);
        }
      }
    });
    saveTransaction();
    return Response.json({ ok: true });
  }

  // Date page save: existing behavior
  const blockTags = computeBlockTags(blocks);

  const saveTransaction = db.transaction(() => {
    const existingBlocks = db
      .prepare("SELECT id FROM blocks WHERE user_id = ? AND date = ? AND tag_id IS NULL")
      .all(user.id, date) as { id: string }[];
    for (const block of existingBlocks) {
      db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(block.id);
    }
    db.prepare("DELETE FROM blocks WHERE user_id = ? AND date = ? AND tag_id IS NULL").run(user.id, date);

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

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const tags = blockTags[i];
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

      for (const tagName of tags) {
        let tag = findTag.get(tagName, user.id) as { id: string } | undefined;
        if (!tag) {
          const tagId = crypto.randomUUID();
          insertTag.run(tagId, tagName, user.id);
          tag = { id: tagId };
        }
        insertBlockTag.run(blockId, tag.id);
      }
    }
  });

  saveTransaction();
  return Response.json({ ok: true });
}
