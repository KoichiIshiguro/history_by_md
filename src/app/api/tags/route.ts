import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const search = request.nextUrl.searchParams.get("q");

  let tags;
  if (search) {
    tags = db
      .prepare(
        `SELECT t.*, COUNT(bt.block_id) as block_count
         FROM tags t
         LEFT JOIN block_tags bt ON bt.tag_id = t.id
         WHERE t.user_id = ? AND t.name LIKE ?
         GROUP BY t.id
         ORDER BY block_count DESC, t.name ASC`
      )
      .all(user.id, `%${search}%`);
  } else {
    tags = db
      .prepare(
        `SELECT t.*, COUNT(bt.block_id) as block_count
         FROM tags t
         LEFT JOIN block_tags bt ON bt.tag_id = t.id
         WHERE t.user_id = ?
         GROUP BY t.id
         ORDER BY block_count DESC, t.name ASC`
      )
      .all(user.id);
  }

  return Response.json(tags);
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const { id } = await request.json();

  db.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").run(id, user.id);
  return Response.json({ ok: true });
}
