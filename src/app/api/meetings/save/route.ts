import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { deleteAudio } from "@/lib/audioStorage";
import { logUsage, geminiCost } from "@/lib/usageLog";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

const TITLE_GEN_MODEL = process.env.GEMINI_POLISH_MODEL || "gemini-flash-latest";

/**
 * Approve a meeting. The polished transcript is split into blocks and
 * stored against this meeting (blocks.meeting_id). The meeting itself
 * IS the page — no separate entry is created in the pages tree.
 *
 * After approval:
 *   - raw_transcript / polished_transcript are cleared
 *   - cached audio file is deleted
 *   - audio_tmp_path is cleared
 *   - if title is empty, auto-generate a short title via Gemini
 *
 * Body: { meetingId, title?, meetingDate?, polishedTranscript, attendees? }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { meetingId, title: titleIn, meetingDate: dateIn, polishedTranscript, attendees } = body as {
    meetingId: string;
    title?: string;
    meetingDate?: string;
    polishedTranscript: string;
    attendees?: string[];
  };

  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ? AND user_id = ?").get(meetingId, user.id) as any;
  if (!meeting) return Response.json({ error: "Meeting not found" }, { status: 404 });

  let title = (titleIn || meeting.title || "").trim();
  const meetingDate = dateIn || meeting.meeting_date || new Date().toISOString().slice(0, 10);
  const content = (polishedTranscript || "").trim();
  if (!content) return Response.json({ error: "Empty transcript" }, { status: 400 });

  // Auto-generate title if empty or still a filename fallback
  const needsAutoTitle = !title || title === meeting.audio_filename?.replace(/\.[^.]+$/, "");
  if (needsAutoTitle) {
    try {
      title = await generateShortTitle(content, user.id);
    } catch { /* fall back to existing title */ }
  }

  const tx = db.transaction(() => {
    // 1. Split polished transcript into paragraph blocks.
    //    Attendees are NOT inserted as content blocks — they live as
    //    metadata on the meeting row and render in the header UI.
    //    This avoids inadvertently creating pages via {{name}} auto-resolution.
    const paragraphs = content.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    type NewBlock = { id: string; content: string; indent: number };
    const newBlocks: NewBlock[] = paragraphs.map((p) => ({
      id: crypto.randomUUID(), content: p, indent: 0,
    }));

    // 2. Clear any existing blocks attached to this meeting (re-approval case)
    const existing = db.prepare("SELECT id FROM blocks WHERE user_id = ? AND meeting_id = ?").all(user.id, meetingId) as { id: string }[];
    for (const b of existing) {
      db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(b.id);
      db.prepare("DELETE FROM block_pages WHERE block_id = ?").run(b.id);
    }
    db.prepare("DELETE FROM blocks WHERE user_id = ? AND meeting_id = ?").run(user.id, meetingId);

    // 3. Insert blocks with meeting_id
    const insertBlock = db.prepare(
      `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, meeting_id)
       VALUES (?, ?, '', ?, ?, ?, ?)`
    );
    for (let i = 0; i < newBlocks.length; i++) {
      insertBlock.run(newBlocks[i].id, user.id, newBlocks[i].content, newBlocks[i].indent, i, meetingId);
    }

    // 4. Update meeting row: mark as saved, clear transcripts and audio path,
    //    keep attendees as JSON metadata only
    db.prepare(
      `UPDATE meetings SET title = ?, meeting_date = ?,
                            raw_transcript = NULL, polished_transcript = NULL,
                            audio_tmp_path = NULL,
                            attendees = ?, status = 'saved',
                            page_id = NULL,
                            updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(title, meetingDate, JSON.stringify(attendees || []), meetingId, user.id);
  });
  tx();

  // 7. Delete the cached audio file (outside the transaction, non-blocking)
  deleteAudio(meetingId).catch(() => {});

  return Response.json({ meetingId, title });
}

async function generateShortTitle(transcript: string, userId: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("no api key");

  // Only the first ~3000 chars are needed to get the gist
  const excerpt = transcript.slice(0, 3000);

  const systemPrompt = `あなたは会議録に短いタイトルをつけるアシスタントです。
以下の会議内容から、10〜15文字程度の簡潔なタイトルを1つだけ出力してください。
- 句読点・記号は使わない
- "会議" "MTG" などの汎用語で埋めない（内容の主題を入れる）
- 前置き・解説・引用符は一切出力しない
- 出力はタイトル文字列のみ`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TITLE_GEN_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: excerpt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 100,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );
  if (!res.ok) throw new Error("title gen failed");
  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

  const usage = data.usageMetadata || {};
  try {
    logUsage({
      userId, provider: "gemini", operation: "generate", model: TITLE_GEN_MODEL,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      costUsd: geminiCost({
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        hasAudio: false,
        hasThinking: false,
      }),
      meta: { purpose: "meeting-title" },
    });
  } catch { /* ignore */ }

  // Sanitize: strip quotes, linebreaks, trim
  return text.replace(/^["'「『]+|["'」』]+$/g, "").split("\n")[0].trim().slice(0, 40);
}

