import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

interface SlotRow {
  id: string;
  action_block_id: string;
  start_at: string;
  end_at: string;
  content?: string;
  page_id?: string | null;
  date?: string;
}

/**
 * GET /api/action-slots?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   - With from/to: return slots whose start_at falls in [from, to).
 *   - Without params: return ALL slots for the user (small volumes only).
 * Always joins the underlying action block so the client can render
 * labels and determine done state without a second round-trip.
 *
 * Also returns `latestByAction`: { [action_block_id]: latest_end_at },
 * used to classify actions as scheduled / unscheduled independent of
 * the filtered week.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();

  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");

  let rows: SlotRow[];
  if (from && to) {
    rows = db.prepare(
      `SELECT s.id, s.action_block_id, s.start_at, s.end_at,
              b.content, b.page_id, b.date
         FROM action_slots s
         LEFT JOIN blocks b ON b.id = s.action_block_id
        WHERE s.user_id = ? AND s.start_at >= ? AND s.start_at < ?
        ORDER BY s.start_at ASC`
    ).all(user.id, `${from}T00:00:00`, `${to}T00:00:00`) as SlotRow[];
  } else {
    rows = db.prepare(
      `SELECT s.id, s.action_block_id, s.start_at, s.end_at,
              b.content, b.page_id, b.date
         FROM action_slots s
         LEFT JOIN blocks b ON b.id = s.action_block_id
        WHERE s.user_id = ?
        ORDER BY s.start_at ASC`
    ).all(user.id) as SlotRow[];
  }

  // Latest end_at per action (across all time, not just the filtered window)
  const latestRows = db.prepare(
    `SELECT action_block_id, MAX(end_at) as latest
       FROM action_slots
      WHERE user_id = ?
      GROUP BY action_block_id`
  ).all(user.id) as { action_block_id: string; latest: string }[];
  const latestByAction: Record<string, string> = {};
  for (const r of latestRows) latestByAction[r.action_block_id] = r.latest;

  return Response.json({ slots: rows, latestByAction });
}

/**
 * POST /api/action-slots
 * Body: { action_block_id, start_at, end_at }
 * Returns: { id }
 *
 * Overlap with other actions is intentionally NOT rejected — the feature
 * allows multiple slots in the same time range (different actions or the
 * same action twice).
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const { action_block_id, start_at, end_at } = await request.json();
  if (!action_block_id || !start_at || !end_at) {
    return Response.json({ error: "Missing fields" }, { status: 400 });
  }
  // Verify the action block belongs to the user
  const block = db.prepare("SELECT id FROM blocks WHERE id = ? AND user_id = ?").get(action_block_id, user.id) as { id: string } | undefined;
  if (!block) return Response.json({ error: "Action block not found" }, { status: 404 });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO action_slots (id, user_id, action_block_id, start_at, end_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, user.id, action_block_id, start_at, end_at);
  return Response.json({ id });
}
