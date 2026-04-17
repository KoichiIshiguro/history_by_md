import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rewriteActionDate } from "@/lib/actionDate";
import { NextRequest } from "next/server";

/**
 * Change an action block's due range. Rewrites the block content's @-spec
 * (or inserts one if absent) and updates due_start/due_end columns.
 *
 * Body: { blockId: string, dueStart: string, dueEnd: string }
 */
export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const { blockId, dueStart, dueEnd } = await request.json();

  if (!blockId || !dueStart || !dueEnd) {
    return Response.json({ error: "Missing fields" }, { status: 400 });
  }

  const block = db.prepare("SELECT content FROM blocks WHERE id = ? AND user_id = ?").get(blockId, user.id) as { content: string } | undefined;
  if (!block) return Response.json({ error: "Block not found" }, { status: 404 });

  const newContent = rewriteActionDate(block.content, dueStart, dueEnd);

  db.prepare(
    `UPDATE blocks SET content = ?, due_start = ?, due_end = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).run(newContent, dueStart, dueEnd, blockId, user.id);

  return Response.json({ ok: true, content: newContent });
}
