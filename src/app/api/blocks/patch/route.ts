/**
 * Block-level patch endpoint — the new save path with per-block optimistic
 * concurrency. Replaces the old "DELETE-all + INSERT-all" bulk save for
 * normal editor flow.
 *
 * Body shape:
 *   {
 *     scope: { kind: "date" | "page" | "meeting", key: string },
 *     ops: [
 *       { op: "upsert", id, content, indent_level, sort_order,
 *         baseVersion: number | null },     // null = client-created (insert)
 *       { op: "delete", id, baseVersion: number },
 *     ]
 *   }
 *
 * Response shape:
 *   {
 *     ok: true,
 *     results: [
 *       { id, status: "applied", version },              // change accepted
 *       { id, status: "deleted" },                       // delete accepted
 *       { id, status: "conflict", server: { ... } | null }, // server has a
 *                                                        // different version
 *                                                        // (server=null = the
 *                                                        // block was deleted
 *                                                        // on the server)
 *     ],
 *     scopeVersion: string,
 *   }
 *
 * Per-op semantics:
 *   - upsert baseVersion=null: insert if id is unused; if id already exists
 *     → conflict (returns server row).
 *   - upsert baseVersion=N: only applies if the row's current version == N;
 *     otherwise → conflict.
 *   - delete baseVersion=N: only applies if version == N; otherwise →
 *     conflict. If the row is already gone, treat as success (idempotent).
 *
 * Tag/page-ref recomputation runs at scope level after ops apply, since
 * indent-based tag inheritance means even a single edit can change other
 * blocks' active tags.
 */
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseAction, todayISO, normalizeActionDate } from "@/lib/actionDate";
import { scopeVersion } from "@/lib/blockVersion";
import { NextRequest } from "next/server";

type ScopeKind = "date" | "page" | "meeting";
interface Scope { kind: ScopeKind; key: string }

interface OpUpsert {
  op: "upsert";
  id: string;
  content: string;
  indent_level: number;
  sort_order: number;
  baseVersion: number | null;
}
interface OpDelete {
  op: "delete";
  id: string;
  baseVersion: number;
}
type Op = OpUpsert | OpDelete;

interface ServerBlockSummary {
  content: string;
  indent_level: number;
  sort_order: number;
  version: number;
  due_start: string | null;
  due_end: string | null;
}

type OpResult =
  | { id: string; status: "applied"; version: number }
  | { id: string; status: "deleted" }
  | { id: string; status: "conflict"; server: ServerBlockSummary | null };

// ─── Tag / page-ref helpers (mirror save/route.ts) ────────────────────

function extractTags(content: string): string[] {
  const matches = content.match(/#([^\s#{}]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}
function extractPageRefs(content: string): string[] {
  const matches = content.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(2, -2).trim());
}
function resolvePageByPath(db: any, userId: string, fullPath: string): { id: string } {
  const parts = fullPath.split("/").map((p) => p.trim()).filter(Boolean);
  let parentId: string | null = null;
  const findByNameAndParent = db.prepare(
    "SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id IS ?"
  );
  const findByNameAndParentId = db.prepare(
    "SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id = ?"
  );
  const insertPage = db.prepare(
    "INSERT OR IGNORE INTO pages (id, name, user_id, parent_id, sort_order) VALUES (?, ?, ?, ?, 0)"
  );
  let pageId = "";
  for (const part of parts) {
    let found: { id: string } | undefined;
    if (parentId === null) {
      found = findByNameAndParent.get(part, userId, null) as { id: string } | undefined;
    } else {
      found = findByNameAndParentId.get(part, userId, parentId) as { id: string } | undefined;
    }
    if (found) pageId = found.id;
    else {
      pageId = crypto.randomUUID();
      insertPage.run(pageId, part, userId, parentId);
    }
    parentId = pageId;
  }
  return { id: pageId };
}

function recomputeScopeLinks(db: any, userId: string, scope: Scope) {
  // Pull all blocks for the scope ordered by sort_order so the indent-based
  // tag/page inheritance walks correctly.
  let blockRows: Array<{ id: string; content: string; indent_level: number }> = [];
  if (scope.kind === "meeting") {
    blockRows = db.prepare(
      "SELECT id, content, indent_level FROM blocks WHERE user_id = ? AND meeting_id = ? ORDER BY sort_order"
    ).all(userId, scope.key) as any[];
  } else if (scope.kind === "page") {
    blockRows = db.prepare(
      "SELECT id, content, indent_level FROM blocks WHERE user_id = ? AND page_id = ? ORDER BY sort_order"
    ).all(userId, scope.key) as any[];
  } else {
    blockRows = db.prepare(
      "SELECT id, content, indent_level FROM blocks WHERE user_id = ? AND date = ? AND page_id IS NULL AND meeting_id IS NULL ORDER BY sort_order"
    ).all(userId, scope.key) as any[];
  }

  // Indent-walk to compute inherited tags/pages
  const tagStack: Array<{ tags: string[]; indent: number }> = [];
  const pageStack: Array<{ pages: string[]; indent: number }> = [];
  const tagsByBlock = new Map<string, Set<string>>();
  const pagesByBlock = new Map<string, Set<string>>();

  for (const b of blockRows) {
    while (tagStack.length > 0 && tagStack[tagStack.length - 1].indent >= b.indent_level) tagStack.pop();
    while (pageStack.length > 0 && pageStack[pageStack.length - 1].indent >= b.indent_level) pageStack.pop();
    const activeTags = new Set<string>();
    for (const e of tagStack) for (const t of e.tags) activeTags.add(t);
    const activePages = new Set<string>();
    for (const e of pageStack) for (const p of e.pages) activePages.add(p);
    const ownTags = extractTags(b.content);
    const ownPages = extractPageRefs(b.content);
    for (const t of ownTags) activeTags.add(t);
    for (const p of ownPages) activePages.add(p);
    tagsByBlock.set(b.id, activeTags);
    pagesByBlock.set(b.id, activePages);
    if (ownTags.length > 0) tagStack.push({ tags: ownTags, indent: b.indent_level });
    if (ownPages.length > 0) pageStack.push({ pages: ownPages, indent: b.indent_level });
  }

  // Wipe + re-insert join rows for all blocks in this scope
  const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)");
  const insertBlockTag = db.prepare("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)");
  const insertBlockPage = db.prepare("INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)");

  for (const b of blockRows) {
    db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(b.id);
    db.prepare("DELETE FROM block_pages WHERE block_id = ?").run(b.id);
    for (const tagName of tagsByBlock.get(b.id) || []) {
      let tag = findTag.get(tagName, userId) as { id: string } | undefined;
      if (!tag) { const tid = crypto.randomUUID(); insertTag.run(tid, tagName, userId); tag = { id: tid }; }
      insertBlockTag.run(b.id, tag.id);
    }
    for (const pagePath of pagesByBlock.get(b.id) || []) {
      const page = resolvePageByPath(db, userId, pagePath);
      insertBlockPage.run(b.id, page.id);
    }
  }
  db.prepare("DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT DISTINCT tag_id FROM block_tags)").run(userId);
}

// ─── Endpoint ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json() as { scope: Scope; ops: Op[] };
  const { scope, ops } = body;

  if (!scope || !scope.kind || !Array.isArray(ops)) {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const defaultDate =
    scope.kind === "date" ? (scope.key || todayISO()) : todayISO();

  // Convenience refs
  const selectBlock = db.prepare(
    `SELECT id, content, indent_level, sort_order, version, due_start, due_end
       FROM blocks WHERE id = ? AND user_id = ?`
  );

  const insertBlockDate = db.prepare(
    `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, due_start, due_end, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const insertBlockPage = db.prepare(
    `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, page_id, due_start, due_end, version)
     VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 1)`
  );
  const insertBlockMeeting = db.prepare(
    `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, meeting_id, due_start, due_end, version)
     VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 1)`
  );
  const updateBlock = db.prepare(
    `UPDATE blocks SET content = ?, indent_level = ?, sort_order = ?,
                       due_start = ?, due_end = ?,
                       version = version + 1, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  );
  const deleteBlock = db.prepare("DELETE FROM blocks WHERE id = ? AND user_id = ?");

  const results: OpResult[] = [];

  const applyTx = db.transaction(() => {
    for (const op of ops) {
      if (op.op === "upsert") {
        const normalized = normalizeActionDate(op.content, defaultDate);
        const meta = parseAction(normalized, defaultDate);
        const dueStart = meta.isAction ? meta.dueStart : null;
        const dueEnd = meta.isAction ? meta.dueEnd : null;

        const existing = selectBlock.get(op.id, user.id) as {
          version: number; content: string; indent_level: number; sort_order: number;
          due_start: string | null; due_end: string | null;
        } | undefined;

        if (op.baseVersion == null) {
          // Client-created insert
          if (existing) {
            results.push({
              id: op.id,
              status: "conflict",
              server: {
                content: existing.content,
                indent_level: existing.indent_level,
                sort_order: existing.sort_order,
                version: existing.version,
                due_start: existing.due_start,
                due_end: existing.due_end,
              },
            });
            continue;
          }
          if (scope.kind === "meeting") {
            insertBlockMeeting.run(op.id, user.id, normalized, op.indent_level, op.sort_order, scope.key, dueStart, dueEnd);
          } else if (scope.kind === "page") {
            insertBlockPage.run(op.id, user.id, normalized, op.indent_level, op.sort_order, scope.key, dueStart, dueEnd);
          } else {
            insertBlockDate.run(op.id, user.id, scope.key, normalized, op.indent_level, op.sort_order, dueStart, dueEnd);
          }
          results.push({ id: op.id, status: "applied", version: 1 });
        } else {
          // Existing-block update
          if (!existing) {
            results.push({ id: op.id, status: "conflict", server: null });
            continue;
          }
          if (existing.version !== op.baseVersion) {
            results.push({
              id: op.id,
              status: "conflict",
              server: {
                content: existing.content,
                indent_level: existing.indent_level,
                sort_order: existing.sort_order,
                version: existing.version,
                due_start: existing.due_start,
                due_end: existing.due_end,
              },
            });
            continue;
          }
          updateBlock.run(normalized, op.indent_level, op.sort_order, dueStart, dueEnd, op.id, user.id);
          results.push({ id: op.id, status: "applied", version: existing.version + 1 });
        }
      } else if (op.op === "delete") {
        const existing = selectBlock.get(op.id, user.id) as { version: number } | undefined;
        if (!existing) {
          // Already gone — idempotent success
          results.push({ id: op.id, status: "deleted" });
          continue;
        }
        if (existing.version !== op.baseVersion) {
          const full = selectBlock.get(op.id, user.id) as any;
          results.push({
            id: op.id,
            status: "conflict",
            server: {
              content: full.content,
              indent_level: full.indent_level,
              sort_order: full.sort_order,
              version: full.version,
              due_start: full.due_start,
              due_end: full.due_end,
            },
          });
          continue;
        }
        deleteBlock.run(op.id, user.id);
        results.push({ id: op.id, status: "deleted" });
      }
    }
    // Recompute tags/page refs for the whole scope (indent-based inheritance
    // means single-block edits can affect siblings).
    recomputeScopeLinks(db, user.id, scope);
  });
  applyTx();

  // Compute the new scope version
  const versionScope =
    scope.kind === "meeting" ? { user_id: user.id, meeting_id: scope.key } :
    scope.kind === "page" ? { user_id: user.id, page_id: scope.key } :
    { user_id: user.id, date: scope.key };
  const newVersion = scopeVersion(db, versionScope);

  return Response.json({ ok: true, results, scopeVersion: newVersion });
}
