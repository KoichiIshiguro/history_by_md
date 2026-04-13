import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const tags = db
    .prepare(
      `SELECT t.*, COUNT(bt.block_id) as block_count
       FROM tags t
       LEFT JOIN block_tags bt ON bt.tag_id = t.id
       WHERE t.user_id = ?
       GROUP BY t.id
       ORDER BY t.name ASC`
    )
    .all(user.id);

  return Response.json(tags);
}
