import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * Busy slots are time ranges that are "off-limits" to action scheduling —
 * e.g., meetings, OOO, appointments. Optionally recurring (daily / weekly).
 *
 * GET  /api/busy-slots?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Expands recurrences into individual instances within [from, to).
 *   Each instance has an `instance_id` = "<baseId>::<YYYY-MM-DD>" for
 *   rendering keys; the underlying `id` still maps to the DB row.
 * POST /api/busy-slots
 *   Create. Body: { title, start_at, end_at, recurrence, weekdays?, recur_until? }
 */

interface BusyRow {
  id: string;
  user_id: string;
  title: string;
  start_at: string;
  end_at: string;
  recurrence: string;
  weekdays: string | null;
  recur_until: string | null;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();

  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");

  const rows = db.prepare(
    `SELECT id, user_id, title, start_at, end_at, recurrence, weekdays, recur_until
       FROM busy_slots WHERE user_id = ?`
  ).all(user.id) as BusyRow[];

  if (!from || !to) {
    return Response.json({ busySlots: rows });
  }

  const rangeStart = new Date(`${from}T00:00:00`);
  const rangeEnd = new Date(`${to}T00:00:00`);

  const instances: Array<{
    instance_id: string;
    id: string;
    title: string;
    start_at: string;
    end_at: string;
    recurrence: string;
  }> = [];

  for (const bs of rows) {
    const baseStart = parseISO(bs.start_at);
    const baseEnd = parseISO(bs.end_at);
    const durationMs = baseEnd.getTime() - baseStart.getTime();

    const recurUntil = bs.recur_until ? new Date(`${bs.recur_until}T23:59:59`) : null;

    if (bs.recurrence === "none") {
      if (baseStart >= rangeStart && baseStart < rangeEnd) {
        instances.push({
          instance_id: bs.id,
          id: bs.id,
          title: bs.title,
          start_at: bs.start_at,
          end_at: bs.end_at,
          recurrence: bs.recurrence,
        });
      }
      continue;
    }

    // Expand recurrence day-by-day from max(baseStart, rangeStart)
    const weekdays: number[] = bs.weekdays ? JSON.parse(bs.weekdays) : [];
    let cur = new Date(Math.max(baseStart.getTime(), rangeStart.getTime()));
    cur.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds(), 0);
    while (cur < rangeEnd) {
      if (recurUntil && cur > recurUntil) break;
      if (cur >= baseStart) {
        const include = bs.recurrence === "daily"
          || (bs.recurrence === "weekly" && weekdays.includes(cur.getDay()));
        if (include) {
          const inst = new Date(cur);
          const instEnd = new Date(cur.getTime() + durationMs);
          const ymd = `${inst.getFullYear()}-${pad(inst.getMonth() + 1)}-${pad(inst.getDate())}`;
          instances.push({
            instance_id: `${bs.id}::${ymd}`,
            id: bs.id,
            title: bs.title,
            start_at: isoLocal(inst),
            end_at: isoLocal(instEnd),
            recurrence: bs.recurrence,
          });
        }
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  return Response.json({ busySlots: instances });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { title, start_at, end_at, recurrence, weekdays, recur_until } = body;
  if (!start_at || !end_at) return Response.json({ error: "Missing fields" }, { status: 400 });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO busy_slots (id, user_id, title, start_at, end_at, recurrence, weekdays, recur_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, user.id,
    (title || "").toString().slice(0, 200),
    start_at, end_at,
    recurrence || "none",
    weekdays ? JSON.stringify(weekdays) : null,
    recur_until || null,
  );
  return Response.json({ id });
}

function parseISO(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return new Date(s);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}
function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
