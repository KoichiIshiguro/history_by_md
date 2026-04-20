import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { polishText } from "@/lib/meetingPolish";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Create a meeting from pasted text (no audio).
 *
 * Pipeline:
 *   1. Upsert a meeting row with the text as `raw_transcript`, status='polishing'
 *   2. Return meetingId immediately so the client can close / navigate away
 *   3. Background: run a text-only Gemini polish and flip status → 'ready'
 *
 * Body: { text, title?, date?, attendees?(JSON array of names), removeFillers? }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return Response.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });

  const body = await request.json() as {
    text?: string;
    title?: string;
    date?: string;
    attendees?: string[];
    removeFillers?: boolean;
  };

  const text = (body.text || "").trim();
  if (!text) return Response.json({ error: "テキストが空です" }, { status: 400 });
  if (text.length > 300_000) return Response.json({ error: "テキストが長すぎます (最大30万文字)" }, { status: 413 });

  const today = new Date().toISOString().slice(0, 10);
  const meetingId = crypto.randomUUID();
  const title = (body.title || "").trim() || "無題のメモ";
  const meetingDate = body.date || today;
  const attendees = Array.isArray(body.attendees) ? body.attendees : [];
  const removeFillers = !!body.removeFillers;

  db.prepare(
    `INSERT INTO meetings (id, user_id, title, meeting_date, language, attendees, remove_fillers,
                           raw_transcript, status)
     VALUES (?, ?, ?, ?, 'ja', ?, ?, ?, 'polishing')`
  ).run(
    meetingId, user.id, title, meetingDate,
    JSON.stringify(attendees), removeFillers ? 1 : 0,
    text,
  );

  // Fire-and-forget polish
  runTextPolish({ meetingId, userId: user.id, text, title, attendees, removeFillers, geminiKey })
    .catch((err) => console.error(`[meetings/create-text] polish failed for ${meetingId}:`, err));

  return Response.json({ meetingId, status: "polishing" });
}

async function runTextPolish(args: {
  meetingId: string;
  userId: string;
  text: string;
  title: string;
  attendees: string[];
  removeFillers: boolean;
  geminiKey: string;
}) {
  const db = getDb();
  try {
    const polished = await polishText({
      db, userId: args.userId, meetingId: args.meetingId,
      rawText: args.text, attendees: args.attendees,
      removeFillers: args.removeFillers, title: args.title,
      source: "notes", // typed-notes flavor — no Whisper errors to correct
      geminiKey: args.geminiKey,
    });
    db.prepare(
      `UPDATE meetings SET polished_transcript = ?, status = 'ready', error_message = NULL, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(polished, args.meetingId, args.userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE meetings SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(message, args.meetingId, args.userId);
    throw err;
  }
}
