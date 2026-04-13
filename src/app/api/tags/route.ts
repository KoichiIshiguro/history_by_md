import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const tags = db
    .prepare(
      `SELECT t.*, COUNT(bt.block_id) as block_count
       FROM tags t
       LEFT JOIN block_tags bt ON bt.tag_id = t.id
       WHERE t.user_id = ?
       GROUP BY t.id
       ORDER BY t.parent_id NULLS FIRST, t.sort_order ASC, t.name ASC`
    )
    .all(user.id);

  return Response.json(tags);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const { name, parent_id } = await request.json();

  if (!name || !name.trim()) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }

  const existing = db
    .prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?")
    .get(name.trim(), user.id);
  if (existing) {
    return Response.json({ error: "Tag already exists" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const maxOrder = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tags WHERE user_id = ? AND parent_id IS ?"
    )
    .get(user.id, parent_id || null) as { max_order: number };

  db.prepare(
    "INSERT INTO tags (id, name, user_id, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)"
  ).run(id, name.trim(), user.id, parent_id || null, maxOrder.max_order + 1);

  return Response.json({ id, name: name.trim() });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const { id, name, parent_id } = await request.json();

  if (name !== undefined) {
    db.prepare("UPDATE tags SET name = ? WHERE id = ? AND user_id = ?").run(
      name.trim(),
      id,
      user.id
    );
  }
  if (parent_id !== undefined) {
    db.prepare("UPDATE tags SET parent_id = ? WHERE id = ? AND user_id = ?").run(
      parent_id,
      id,
      user.id
    );
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

  // Move children to parent of deleted tag
  const tag = db
    .prepare("SELECT parent_id FROM tags WHERE id = ? AND user_id = ?")
    .get(id, user.id) as { parent_id: string | null } | undefined;
  if (tag) {
    db.prepare("UPDATE tags SET parent_id = ? WHERE parent_id = ? AND user_id = ?").run(
      tag.parent_id,
      id,
      user.id
    );
  }

  db.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").run(id, user.id);
  return Response.json({ ok: true });
}
