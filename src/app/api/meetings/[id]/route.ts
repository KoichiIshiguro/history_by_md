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
