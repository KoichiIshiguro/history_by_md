import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * PUT /api/busy-slots/[id]
 *   Body: { title?, start_at?, end_at?, recurrence?, weekdays?, recur_until? }
 *   Updates the base definition. All future instances reflect the change.
 * DELETE /api/busy-slots/[id] — removes the base + all instances.
 */
export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const { id } = await ctx.params;
  const existing = db.prepare("SELECT id FROM busy_slots WHERE id = ? AND user_id = ?").get(id, user.id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await request.json();
  const sets: string[] = [];
  const vals: any[] = [];
  if (typeof body.title === "string") { sets.push("title = ?"); vals.push(body.title); }
  if (typeof body.start_at === "string") { sets.push("start_at = ?"); vals.push(body.start_at); }
  if (typeof body.end_at === "string") { sets.push("end_at = ?"); vals.push(body.end_at); }
  if (typeof body.recurrence === "string") { sets.push("recurrence = ?"); vals.push(body.recurrence); }
  if ("weekdays" in body) { sets.push("weekdays = ?"); vals.push(body.weekdays ? JSON.stringify(body.weekdays) : null); }
  if ("recur_until" in body) { sets.push("recur_until = ?"); vals.push(body.recur_until || null); }
  if (sets.length === 0) return Response.json({ ok: true, noop: true });
  sets.push("updated_at = datetime('now')");
  vals.push(id, user.id);
  db.prepare(`UPDATE busy_slots SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...vals);
  return Response.json({ ok: true });
}

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const { id } = await ctx.params;
  db.prepare("DELETE FROM busy_slots WHERE id = ? AND user_id = ?").run(id, user.id);
  return Response.json({ ok: true });
}
