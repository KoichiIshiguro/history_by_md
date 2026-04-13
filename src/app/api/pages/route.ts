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

  const pages = db
    .prepare(
      `SELECT p.*, COUNT(bp.block_id) as ref_count
       FROM pages p
       LEFT JOIN block_pages bp ON bp.page_id = p.id
       WHERE p.user_id = ?
       GROUP BY p.id
       ORDER BY p.parent_id NULLS FIRST, p.sort_order ASC, p.name ASC`
    )
    .all(user.id) as Array<{ id: string; name: string; parent_id: string | null; sort_order: number; ref_count: number }>;

  // Compute full_path for each page (parent/child/grandchild)
  const pageMap = new Map(pages.map((p) => [p.id, p]));
  const pagesWithPath = pages.map((p) => {
    const parts: string[] = [];
    let current: typeof p | undefined = p;
    while (current) {
      parts.unshift(current.name);
      current = current.parent_id ? pageMap.get(current.parent_id) : undefined;
    }
    return { ...p, full_path: parts.join("/") };
  });

  return Response.json(pagesWithPath);
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

  // Check duplicate within same parent
  const existing = parent_id
    ? db.prepare("SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id = ?").get(name.trim(), user.id, parent_id)
    : db.prepare("SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id IS NULL").get(name.trim(), user.id);
  if (existing) {
    return Response.json({ error: "Page already exists" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const maxOrder = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM pages WHERE user_id = ? AND parent_id IS ?"
    )
    .get(user.id, parent_id || null) as { max_order: number };

  db.prepare(
    "INSERT INTO pages (id, name, user_id, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)"
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
    // Check for duplicate within same parent
    const page = db.prepare("SELECT parent_id FROM pages WHERE id = ? AND user_id = ?").get(id, user.id) as { parent_id: string | null } | undefined;
    if (page) {
      const dup = page.parent_id
        ? db.prepare("SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id = ? AND id != ?").get(name.trim(), user.id, page.parent_id, id)
        : db.prepare("SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id IS NULL AND id != ?").get(name.trim(), user.id, id);
      if (dup) {
        return Response.json({ error: "同じ階層に同名のページがあります" }, { status: 409 });
      }
    }
    db.prepare("UPDATE pages SET name = ? WHERE id = ? AND user_id = ?").run(
      name.trim(), id, user.id
    );
  }
  if (parent_id !== undefined) {
    db.prepare("UPDATE pages SET parent_id = ? WHERE id = ? AND user_id = ?").run(
      parent_id, id, user.id
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

  const page = db
    .prepare("SELECT parent_id FROM pages WHERE id = ? AND user_id = ?")
    .get(id, user.id) as { parent_id: string | null } | undefined;
  if (page) {
    // Move children to parent of deleted page
    db.prepare("UPDATE pages SET parent_id = ? WHERE parent_id = ? AND user_id = ?").run(
      page.parent_id, id, user.id
    );
  }

  // Delete page content blocks
  db.prepare("DELETE FROM blocks WHERE page_id = ? AND user_id = ?").run(id, user.id);
  db.prepare("DELETE FROM pages WHERE id = ? AND user_id = ?").run(id, user.id);
  return Response.json({ ok: true });
}
