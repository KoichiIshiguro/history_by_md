import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getAudioPath } from "@/lib/audioStorage";
import { runGeminiAudioPolish } from "../transcribe/route";
import { serverLog } from "@/lib/serverLog";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Re-run polish for an existing meeting.
 *
 * If the audio file is still cached (within 24h) we re-run the full
 * audio+text Gemini pipeline. Otherwise we gracefully fall back to
 * a text-only cleanup using the stored raw transcript.
 *
 * Body: { meetingId: string, removeFillers?: boolean }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();

  const { meetingId, removeFillers } = (await request.json()) as {
    meetingId: string;
    removeFillers?: boolean;
  };

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return Response.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });

  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ? AND user_id = ?").get(meetingId, user.id) as any;
  if (!meeting) return Response.json({ error: "Meeting not found" }, { status: 404 });
  if (!meeting.raw_transcript) return Response.json({ error: "No raw transcript to polish" }, { status: 404 });

  let attendees: string[] = [];
  try { attendees = meeting.attendees ? JSON.parse(meeting.attendees) : []; } catch {}

  db.prepare("UPDATE meetings SET status = 'polishing', updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(meetingId, user.id);

  try {
    const audioPath = await getAudioPath(meetingId);
    let polished: string;
    let usedAudio = false;

    if (audioPath) {
      // Audio still cached → run full audio+text polish
      polished = await runGeminiAudioPolish(db, user.id, {
        audioPath,
        audioMime: meeting.audio_mime || "audio/ogg",
        whisperText: meeting.raw_transcript,
        attendees,
        removeFillers: !!removeFillers,
        title: meeting.title,
        meetingId,
        geminiKey,
      });
      usedAudio = true;
    } else {
      // Fallback: text-only polish (original behavior)
      polished = await textOnlyPolish({
        rawTranscript: meeting.raw_transcript,
        attendees,
        removeFillers: !!removeFillers,
        title: meeting.title,
        db, userId: user.id, meetingId, geminiKey,
      });
    }

    db.prepare(
      `UPDATE meetings SET polished_transcript = ?, remove_fillers = ?, status = 'ready', error_message = NULL,
                            updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(polished, removeFillers ? 1 : 0, meetingId, user.id);

    return Response.json({ polishedTranscript: polished, usedAudio });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await serverLog("error", "polish.failed", {
      meetingId, userId: user.id, removeFillers: !!removeFillers,
    }, err);
    db.prepare("UPDATE meetings SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(message, meetingId, user.id);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function textOnlyPolish(args: {
  rawTranscript: string;
  attendees: string[];
  removeFillers: boolean;
  title?: string;
  db: any;
  userId: string;
  meetingId: string;
  geminiKey: string;
}): Promise<string> {
  const { logUsage, geminiCost } = await import("@/lib/usageLog");
  const tags = args.db.prepare("SELECT name FROM tags WHERE user_id = ? LIMIT 100").all(args.userId) as { name: string }[];
  const pages = args.db.prepare("SELECT name FROM pages WHERE user_id = ? LIMIT 150").all(args.userId) as { name: string }[];
  const vocabulary = [...new Set([...tags.map((t) => `#${t.name}`), ...pages.map((p) => p.name), ...args.attendees])].join("、");

  const systemPrompt = `あなたは日本語音声の文字起こしをポストエディットする専門家です。
入力は別の音声認識モデル (Whisper) の出力で、誤認識を含みます。
発言内容の改変・要約・省略は絶対に禁止。誤認識の修正と表記統一のみ行います。
語彙辞書: ${vocabulary || "(なし)"}
${args.removeFillers ? "フィラー (えーと、あのー等) は除去" : "フィラーもそのまま残す"}
出力は修正後のテキストのみ。`;

  const model = process.env.GEMINI_POLISH_MODEL || "gemini-flash-latest";
  const thinkingBudget = parseInt(process.env.GEMINI_POLISH_THINKING_BUDGET || "1024", 10);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${args.geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: args.rawTranscript }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  if (!text) throw new Error("Gemini returned empty response");

  const usage = data.usageMetadata || {};
  logUsage({
    userId: args.userId, provider: "gemini", operation: "polish", model,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    costUsd: geminiCost({
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      hasAudio: false,
      hasThinking: thinkingBudget > 0,
    }),
    meta: { meetingId: args.meetingId, mode: "text-only", thinkingBudget },
  });

  return text;
}
