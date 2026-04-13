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

  const templates = db
    .prepare("SELECT * FROM templates WHERE user_id = ? ORDER BY name ASC")
    .all(user.id);

  return Response.json(templates);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const { name, content } = await request.json();
  if (!name?.trim() || content == null) {
    return Response.json({ error: "name and content are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      "INSERT INTO templates (id, name, content, user_id) VALUES (?, ?, ?, ?)"
    ).run(id, name.trim(), content, user.id);
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) {
      return Response.json({ error: "Template name already exists" }, { status: 409 });
    }
    throw e;
  }

  return Response.json({ id, name: name.trim(), content });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const { id, name, content } = await request.json();
  if (!id || !name?.trim() || content == null) {
    return Response.json({ error: "id, name, and content are required" }, { status: 400 });
  }

  const result = db
    .prepare("UPDATE templates SET name = ?, content = ? WHERE id = ? AND user_id = ?")
    .run(name.trim(), content, id, user.id);

  if (result.changes === 0) {
    return Response.json({ error: "Template not found" }, { status: 404 });
  }

  return Response.json({ id, name: name.trim(), content });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const { id } = await request.json();
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  db.prepare("DELETE FROM templates WHERE id = ? AND user_id = ?").run(id, user.id);

  return Response.json({ ok: true });
}
