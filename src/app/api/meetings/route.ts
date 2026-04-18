import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/meetings
 *   List the current user's meetings (most recent first).
 *   Returns lightweight rows (no transcripts). Fetch detail via /api/meetings/[id].
 */
export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  // Hide legacy meetings (those that wrote their content to a page in the tree,
  // under the old spec). They're identifiable by status='saved' AND page_id IS NOT NULL.
  const rows = db
    .prepare(
      `SELECT id, page_id, title, meeting_date, duration_sec, status, error_message, created_at, updated_at
         FROM meetings
        WHERE user_id = ?
          AND NOT (status = 'saved' AND page_id IS NOT NULL)
        ORDER BY created_at DESC`
    )
    .all(user.id);
  return Response.json(rows);
}

/**
 * DELETE /api/meetings
 *   Body: { id: string }
 *   Deletes the meeting row. Does NOT delete the saved page (that's a separate user action).
 */
export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const { id } = (await request.json()) as { id: string };
  db.prepare("DELETE FROM meetings WHERE id = ? AND user_id = ?").run(id, user.id);
  return Response.json({ ok: true });
}
