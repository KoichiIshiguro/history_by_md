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
  const tagId = request.nextUrl.searchParams.get("tagId");

  if (tagId) {
    // Page blocks: blocks directly on this tag page (no date association)
    const pageBlocks = db
      .prepare(
        `SELECT b.*, '' as tag_ids, 1 as is_page_block
         FROM blocks b
         WHERE b.tag_id = ? AND b.user_id = ?
         ORDER BY b.sort_order ASC`
      )
      .all(tagId, user.id);

    // Referenced blocks: blocks from dates that have this tag
    const refBlocks = db
      .prepare(
        `SELECT b.*, GROUP_CONCAT(DISTINCT bt2.tag_id) as tag_ids, 0 as is_page_block
         FROM blocks b
         JOIN block_tags bt ON bt.block_id = b.id
         LEFT JOIN block_tags bt2 ON bt2.block_id = b.id
         WHERE bt.tag_id = ? AND b.user_id = ? AND b.tag_id IS NULL
         GROUP BY b.id
         ORDER BY b.date DESC, b.sort_order ASC`
      )
      .all(tagId, user.id);

    return Response.json({ pageBlocks, refBlocks });
  }

  if (date) {
    const blocks = db
      .prepare(
        `SELECT b.*, GROUP_CONCAT(bt.tag_id) as tag_ids
         FROM blocks b
         LEFT JOIN block_tags bt ON bt.block_id = b.id
         WHERE b.user_id = ? AND b.date = ?
         GROUP BY b.id
         ORDER BY b.sort_order ASC`
      )
      .all(user.id, date);
    return Response.json(blocks);
  }

  // Get recent dates
  const dates = db
    .prepare(
      `SELECT DISTINCT date FROM blocks WHERE user_id = ? ORDER BY date DESC LIMIT 30`
    )
    .all(user.id);
  return Response.json(dates);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { date, content, indent_level, sort_order, parent_id, tags, tag_id } = body;

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, parent_id, tag_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, user.id, date || "", content || "", indent_level || 0, sort_order || 0, parent_id || null, tag_id || null);

  // Handle tags
  if (tags && tags.length > 0) {
    for (const tagName of tags) {
      let tag = db
        .prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?")
        .get(tagName, user.id) as { id: string } | undefined;
      if (!tag) {
        const tagId = crypto.randomUUID();
        db.prepare("INSERT INTO tags (id, name, user_id) VALUES (?, ?, ?)").run(
          tagId,
          tagName,
          user.id
        );
        tag = { id: tagId };
      }
      db.prepare(
        "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)"
      ).run(id, tag.id);
    }
  }

  return Response.json({ id });
}

function extractTags(content: string): string[] {
  const matches = content.match(/#([^\s#]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

function recomputeTagsForDate(db: any, userId: string, date: string) {
  // Get all blocks for this date in order
  const allBlocks = db
    .prepare("SELECT id, content, indent_level FROM blocks WHERE user_id = ? AND date = ? ORDER BY sort_order ASC")
    .all(userId, date) as { id: string; content: string; indent_level: number }[];

  // Recompute tags using the hierarchy logic
  const tagStack: Array<{ tags: string[]; indent: number }> = [];

  const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)");
  const insertBlockTag = db.prepare("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)");

  for (const block of allBlocks) {
    // Pop tags from stack at same or deeper indent
    while (tagStack.length > 0 && tagStack[tagStack.length - 1].indent >= block.indent_level) {
      tagStack.pop();
    }

    // Collect inherited tags
    const activeTags: string[] = [];
    for (const entry of tagStack) {
      activeTags.push(...entry.tags);
    }

    const ownTags = extractTags(block.content);
    const allTags = [...new Set([...activeTags, ...ownTags])];

    // Clear existing and re-insert
    db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(block.id);
    for (const tagName of allTags) {
      let tag = findTag.get(tagName, userId) as { id: string } | undefined;
      if (!tag) {
        const tagId = crypto.randomUUID();
        insertTag.run(tagId, tagName, userId);
        tag = { id: tagId };
      }
      insertBlockTag.run(block.id, tag.id);
    }

    if (ownTags.length > 0) {
      tagStack.push({ tags: ownTags, indent: block.indent_level });
    }
  }
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

  // Get the block's date and tag_id for recomputing tags
  const block = db.prepare("SELECT date, tag_id FROM blocks WHERE id = ? AND user_id = ?").get(id, user.id) as { date: string; tag_id: string | null } | undefined;
  if (!block) {
    return Response.json({ error: "Block not found" }, { status: 404 });
  }

  const updateTransaction = db.transaction(() => {
    db.prepare(
      `UPDATE blocks SET content = ?, indent_level = ?, sort_order = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).run(content, indent_level || 0, sort_order || 0, id, user.id);

    // Only recompute tags for date blocks (page blocks don't have tag hierarchy)
    if (!block.tag_id && block.date) {
      recomputeTagsForDate(db, user.id, block.date);
    }
  });

  updateTransaction();
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
