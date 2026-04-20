import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

/** PUT /api/action-slots/[id] — update start_at / end_at (move or resize). */
export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const { id } = await ctx.params;
  const { start_at, end_at } = await request.json();
  if (!start_at || !end_at) return Response.json({ error: "Missing fields" }, { status: 400 });

  const existing = db.prepare("SELECT id FROM action_slots WHERE id = ? AND user_id = ?").get(id, user.id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  db.prepare(
    `UPDATE action_slots SET start_at = ?, end_at = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
  ).run(start_at, end_at, id, user.id);
  return Response.json({ ok: true });
}

/** DELETE /api/action-slots/[id] */
export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const { id } = await ctx.params;
  db.prepare("DELETE FROM action_slots WHERE id = ? AND user_id = ?").run(id, user.id);
  return Response.json({ ok: true });
}
