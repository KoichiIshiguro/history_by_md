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

  const pageId = request.nextUrl.searchParams.get("pageId");
  const includeCompleted = request.nextUrl.searchParams.get("includeCompleted") === "true";

  const contentFilter = includeCompleted
    ? "(b.content LIKE '!action %' OR b.content LIKE '!done %')"
    : "b.content LIKE '!action %'";

  if (pageId) {
    // Actions linked to a specific page
    const actions = db
      .prepare(
        `SELECT b.id, b.content, b.indent_level, b.sort_order, b.date, b.page_id
         FROM blocks b
         JOIN block_pages bp ON bp.block_id = b.id
         WHERE bp.page_id = ? AND b.user_id = ? AND ${contentFilter}
         ORDER BY b.date DESC, b.sort_order ASC`
      )
      .all(pageId, user.id);

    // For each action, fetch child blocks (same date, higher indent, immediately following)
    const enriched = actions.map((action: any) => {
      const children = db
        .prepare(
          `SELECT id, content, indent_level, sort_order, date FROM blocks
           WHERE user_id = ? AND date = ? AND sort_order > ? AND indent_level > ?
           AND (page_id IS NULL AND ? IS NULL OR page_id = ?)
           ORDER BY sort_order ASC`
        )
        .all(user.id, action.date, action.sort_order, action.indent_level, action.page_id, action.page_id);
      // Only take consecutive children with higher indent
      const consecutive: any[] = [];
      for (const child of children as any[]) {
        if (child.indent_level > action.indent_level) consecutive.push(child);
        else break;
      }
      return { ...action, children: consecutive };
    });

    return Response.json(enriched);
  }

  // All actions across all dates/pages
  const actions = db
    .prepare(
      `SELECT b.id, b.content, b.indent_level, b.sort_order, b.date, b.page_id
       FROM blocks b
       WHERE b.user_id = ? AND ${contentFilter}
       ORDER BY b.date DESC, b.sort_order ASC`
    )
    .all(user.id);

  // Fetch linked pages for each action
  const getLinkedPages = db.prepare(
    `SELECT p.id, p.name FROM pages p
     JOIN block_pages bp ON bp.page_id = p.id
     WHERE bp.block_id = ?`
  );

  const enriched = (actions as any[]).map((action) => {
    const linkedPages = getLinkedPages.all(action.id) as { id: string; name: string }[];
    // Fetch children
    const children = db
      .prepare(
        `SELECT id, content, indent_level, sort_order, date FROM blocks
         WHERE user_id = ? AND date = ? AND sort_order > ? AND indent_level > ?
         AND (page_id IS NULL AND ? IS NULL OR page_id = ?)
         ORDER BY sort_order ASC`
      )
      .all(user.id, action.date, action.sort_order, action.indent_level, action.page_id, action.page_id);
    const consecutive: any[] = [];
    for (const child of children as any[]) {
      if (child.indent_level > action.indent_level) consecutive.push(child);
      else break;
    }
    return { ...action, linkedPages, children: consecutive };
  });

  return Response.json(enriched);
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const { blockId, content } = await request.json();

  db.prepare("UPDATE blocks SET content = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(content, blockId, user.id);

  return Response.json({ ok: true });
}
