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

  // Helper: get child blocks for an action (stop at next block with <= indent)
  function getActionChildren(action: any) {
    const candidates = db
      .prepare(
        `SELECT id, content, indent_level, sort_order, date FROM blocks
         WHERE user_id = ? AND date = ? AND sort_order > ?
         AND (page_id IS NULL AND ? IS NULL OR page_id = ?)
         ORDER BY sort_order ASC`
      )
      .all(user.id, action.date, action.sort_order, action.page_id, action.page_id);
    const consecutive: any[] = [];
    for (const child of candidates as any[]) {
      if (child.indent_level > action.indent_level) consecutive.push(child);
      else break;
    }
    return consecutive;
  }

  if (pageId) {
    // Collect this page + all descendant page IDs
    const allPageIds: string[] = [pageId];
    const collectDescendants = (parentId: string) => {
      const children = db
        .prepare("SELECT id FROM pages WHERE parent_id = ? AND user_id = ?")
        .all(parentId, user.id) as { id: string }[];
      for (const child of children) {
        allPageIds.push(child.id);
        collectDescendants(child.id);
      }
    };
    collectDescendants(pageId);

    // Actions linked to this page or any descendant page
    const placeholders = allPageIds.map(() => "?").join(",");
    const actions = db
      .prepare(
        `SELECT DISTINCT b.id, b.content, b.indent_level, b.sort_order, b.date, b.page_id
         FROM blocks b
         JOIN block_pages bp ON bp.block_id = b.id
         WHERE bp.page_id IN (${placeholders}) AND b.user_id = ? AND ${contentFilter}
         ORDER BY b.date DESC, b.sort_order ASC`
      )
      .all(...allPageIds, user.id);

    // Also include actions directly on descendant pages (page_id column)
    const directActions = db
      .prepare(
        `SELECT b.id, b.content, b.indent_level, b.sort_order, b.date, b.page_id
         FROM blocks b
         WHERE b.page_id IN (${placeholders}) AND b.user_id = ? AND ${contentFilter}
         ORDER BY b.date DESC, b.sort_order ASC`
      )
      .all(...allPageIds, user.id);

    // Merge and deduplicate
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const a of [...(actions as any[]), ...(directActions as any[])]) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
    merged.sort((a, b) => b.date.localeCompare(a.date) || a.sort_order - b.sort_order);

    const getLinkedPages = db.prepare(
      `SELECT p.id, p.name FROM pages p JOIN block_pages bp ON bp.page_id = p.id WHERE bp.block_id = ?`
    );
    const enriched = merged.map((action: any) => ({
      ...action,
      children: getActionChildren(action),
      linkedPages: getLinkedPages.all(action.id) as { id: string; name: string }[],
    }));

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
    return { ...action, linkedPages, children: getActionChildren(action) };
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
