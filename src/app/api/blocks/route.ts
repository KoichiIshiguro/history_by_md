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
    // Tag view: get all blocks associated with this tag, grouped by date
    const blocks = db
      .prepare(
        `SELECT b.*, GROUP_CONCAT(bt2.tag_id) as tag_ids
         FROM blocks b
         JOIN block_tags bt ON bt.block_id = b.id
         LEFT JOIN block_tags bt2 ON bt2.block_id = b.id
         WHERE bt.tag_id = ? AND b.user_id = ?
         GROUP BY b.id
         ORDER BY b.date DESC, b.sort_order ASC`
      )
      .all(tagId, user.id);
    return Response.json(blocks);
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
  const { date, content, indent_level, sort_order, parent_id, tags } = body;

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, user.id, date, content || "", indent_level || 0, sort_order || 0, parent_id || null);

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

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { id, content, indent_level, sort_order, tags } = body;

  db.prepare(
    `UPDATE blocks SET content = ?, indent_level = ?, sort_order = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).run(content, indent_level || 0, sort_order || 0, id, user.id);

  // Update tags
  db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(id);
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
