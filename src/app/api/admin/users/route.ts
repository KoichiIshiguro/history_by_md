import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user?.email) return null;
  const db = getDb();
  const user = db
    .prepare("SELECT id, role FROM users WHERE email = ?")
    .get(session.user.email) as { id: string; role: string } | undefined;
  if (!user || user.role !== "admin") return null;
  return user;
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getDb();
  const users = db
    .prepare("SELECT id, email, name, image, role, created_at FROM users ORDER BY created_at DESC")
    .all();
  return Response.json(users);
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getDb();
  const { email, name, role } = await request.json();

  if (!email) {
    return Response.json({ error: "Email is required" }, { status: 400 });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return Response.json({ error: "User already exists" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(
    id,
    email,
    name || "",
    role || "user"
  );
  return Response.json({ id });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getDb();
  const { id, role } = await request.json();
  db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, id);
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getDb();
  const { id } = await request.json();
  if (id === admin.id) {
    return Response.json({ error: "Cannot delete yourself" }, { status: 400 });
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return Response.json({ ok: true });
}
