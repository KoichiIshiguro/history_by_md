import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const { id } = await ctx.params;
  const row = db.prepare("SELECT * FROM meetings WHERE id = ? AND user_id = ?").get(id, user.id);
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(row);
}

/**
 * PATCH /api/meetings/[id]
 * Update metadata (title / date / attendees) without touching the content blocks.
 * Used post-approval to edit header fields.
 *
 * Body: { title?, meetingDate?, attendees? }
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const { id } = await ctx.params;

  const existing = db.prepare("SELECT id FROM meetings WHERE id = ? AND user_id = ?").get(id, user.id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json() as {
    title?: string;
    meetingDate?: string;
    attendees?: string[];
  };

  const sets: string[] = [];
  const vals: any[] = [];
  if (typeof body.title === "string") { sets.push("title = ?"); vals.push(body.title.trim()); }
  if (typeof body.meetingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.meetingDate)) {
    sets.push("meeting_date = ?"); vals.push(body.meetingDate);
  }
  if (Array.isArray(body.attendees)) {
    sets.push("attendees = ?"); vals.push(JSON.stringify(body.attendees));
  }
  if (sets.length === 0) return Response.json({ ok: true, noop: true });

  sets.push("updated_at = datetime('now')");
  vals.push(id, user.id);
  db.prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...vals);

  return Response.json({ ok: true });
}
