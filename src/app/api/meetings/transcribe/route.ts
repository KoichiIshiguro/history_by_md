import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { compressAudioToOpus } from "@/lib/audioCompress";
import { saveAudio, getAudioPath } from "@/lib/audioStorage";
import { uploadAudioFile, geminiAudioPolish, buildAudioFirstPrompt } from "@/lib/geminiAudio";
import { logUsage, groqWhisperCost, geminiCost } from "@/lib/usageLog";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const GEMINI_MODEL = process.env.GEMINI_POLISH_MODEL || "gemini-flash-latest";
const GEMINI_THINKING_BUDGET = parseInt(process.env.GEMINI_POLISH_THINKING_BUDGET || "1024", 10); // Low

// Limits
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const GROQ_LIMIT_BYTES = 25 * 1024 * 1024;
const COMPRESS_THRESHOLD_BYTES = 20 * 1024 * 1024;
const UNCOMPRESSED_EXTENSIONS = new Set(["wav", "aiff", "aif", "flac"]);

/**
 * Accepts multipart/form-data with:
 *   file:       audio file (webm/mp4/mp3/wav/m4a/...)
 *   title, date, language, attendees(JSON), removeFillers('1'|'0')
 *
 * Pipeline:
 *   1. (optional) compress audio to Opus 32kbps mono
 *   2. persist compressed audio for 24h (re-polish window)
 *   3. Whisper transcription (Groq)
 *   4. Gemini audio + Whisper-text polish (Gemini is primary, Whisper is coverage-only)
 *   5. Log usage and costs
 *
 * Returns: { meetingId, rawTranscript, polishedTranscript, durationSec }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!groqKey) return Response.json({ error: "GROQ_API_KEY not configured" }, { status: 500 });
  if (!geminiKey) return Response.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No audio file provided" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `ファイルサイズが上限 (${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB) を超えています。` },
      { status: 413 },
    );
  }

  const titleIn = (form.get("title") as string | null)?.trim() || null;
  const dateIn = (form.get("date") as string | null) || null;
  const language = (form.get("language") as string | null) || "ja";
  const attendeesJson = (form.get("attendees") as string | null) || "[]";
  let attendees: string[] = [];
  try { attendees = JSON.parse(attendeesJson); } catch { attendees = []; }
  const removeFillers = (form.get("removeFillers") as string | null) === "1";

  const today = new Date().toISOString().slice(0, 10);
  const meetingIdIn = form.get("meetingId");
  const meetingId = typeof meetingIdIn === "string" && meetingIdIn ? meetingIdIn : crypto.randomUUID();
  const title = titleIn || file.name.replace(/\.[^.]+$/, "") || "無題の会議";
  const meetingDate = dateIn || today;

  // Upsert meeting row (status: transcribing)
  const existing = db.prepare("SELECT id FROM meetings WHERE id = ? AND user_id = ?").get(meetingId, user.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE meetings SET title = ?, meeting_date = ?, audio_filename = ?, audio_mime = ?, audio_size = ?,
                            language = ?, attendees = ?, remove_fillers = ?, status = 'transcribing',
                            error_message = NULL, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(title, meetingDate, file.name, file.type || "application/octet-stream", file.size,
           language, attendeesJson, removeFillers ? 1 : 0, meetingId, user.id);
  } else {
    db.prepare(
      `INSERT INTO meetings
         (id, user_id, title, meeting_date, audio_filename, audio_mime, audio_size, language,
          attendees, remove_fillers, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transcribing')`
    ).run(meetingId, user.id, title, meetingDate, file.name,
           file.type || "application/octet-stream", file.size, language,
           attendeesJson, removeFillers ? 1 : 0);
  }

  try {
    // ─── 1. Compress audio if needed ─────────────────────────
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const isUncompressed = UNCOMPRESSED_EXTENSIONS.has(ext);
    const shouldCompress = isUncompressed || file.size > COMPRESS_THRESHOLD_BYTES;

    let compressedBytes: Buffer;
    let compressedMime: string;
    if (shouldCompress) {
      const inputBuf = Buffer.from(await file.arrayBuffer());
      const compressed = await compressAudioToOpus(inputBuf, file.name, { bitrateKbps: 32, channels: 1 });
      if (compressed.bytes.byteLength > GROQ_LIMIT_BYTES) {
        throw new Error(`圧縮後も 25MB を超えました (${(compressed.bytes.byteLength / 1024 / 1024).toFixed(1)}MB)。`);
      }
      compressedBytes = compressed.bytes;
      compressedMime = compressed.mime;
    } else {
      if (file.size > GROQ_LIMIT_BYTES) {
        throw new Error(`25MB を超えています。圧縮を有効にするか音声を短く区切ってください。`);
      }
      compressedBytes = Buffer.from(await file.arrayBuffer());
      compressedMime = file.type || "audio/ogg";
    }

    // ─── 2. Persist compressed audio for 24h (re-polish window) ──
    const audioPath = await saveAudio(meetingId, compressedBytes);
    db.prepare(`UPDATE meetings SET audio_tmp_path = ? WHERE id = ? AND user_id = ?`)
      .run(audioPath, meetingId, user.id);

    // ─── 3. Whisper (Groq) ──────────────────────────────────
    const uploadBlob = new Blob([new Uint8Array(compressedBytes)], { type: compressedMime });
    const uploadName = `${meetingId}.opus`;

    const groqForm = new FormData();
    groqForm.append("file", uploadBlob, uploadName);
    groqForm.append("model", GROQ_MODEL);
    groqForm.append("language", language);
    groqForm.append("response_format", "verbose_json");
    const bias = await buildVocabularyBias(db, user.id);
    if (bias) groqForm.append("prompt", bias);

    const whisperRes = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: groqForm,
    });
    if (!whisperRes.ok) {
      throw new Error(`Groq Whisper error ${whisperRes.status}: ${(await whisperRes.text()).slice(0, 500)}`);
    }
    const whisperResult = (await whisperRes.json()) as { text: string; duration?: number };
    const rawTranscript = (whisperResult.text || "").trim();
    const durationSec = Math.round(whisperResult.duration ?? 0);

    logUsage({
      userId: user.id, provider: "groq", operation: "transcribe", model: GROQ_MODEL,
      audioSeconds: durationSec, costUsd: groqWhisperCost(durationSec),
      meta: { meetingId, filename: file.name },
    });

    db.prepare(
      `UPDATE meetings SET raw_transcript = ?, duration_sec = ?, status = 'polishing', updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(rawTranscript, durationSec, meetingId, user.id);

    // ─── 4. Gemini polish with audio + whisper text ────────────
    const polishedText = await runGeminiAudioPolish(db, user.id, {
      audioPath,
      audioMime: compressedMime,
      whisperText: rawTranscript,
      attendees,
      removeFillers,
      title,
      meetingId,
      geminiKey,
    });

    db.prepare(
      `UPDATE meetings SET polished_transcript = ?, status = 'ready', error_message = NULL, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(polishedText, meetingId, user.id);

    return Response.json({ meetingId, rawTranscript, polishedTranscript: polishedText, durationSec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE meetings SET status = 'error', error_message = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(message, meetingId, user.id);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function buildVocabularyBias(db: any, userId: string): Promise<string> {
  const tags = db.prepare("SELECT name FROM tags WHERE user_id = ? LIMIT 60").all(userId) as { name: string }[];
  const pages = db.prepare("SELECT name FROM pages WHERE user_id = ? LIMIT 80").all(userId) as { name: string }[];
  const terms = [...tags.map((t) => t.name), ...pages.map((p) => p.name)];
  if (terms.length === 0) return "";
  let joined = terms.join("、");
  if (joined.length > 900) joined = joined.slice(0, 900);
  return joined;
}

/**
 * Shared Gemini polish routine: uploads audio to Files API, runs generation,
 * logs usage. Callable from both /transcribe and /polish.
 */
export async function runGeminiAudioPolish(
  db: any,
  userId: string,
  args: {
    audioPath: string;
    audioMime: string;
    whisperText: string;
    attendees: string[];
    removeFillers: boolean;
    title?: string;
    meetingId: string;
    geminiKey: string;
  },
): Promise<string> {
  // Build vocabulary from existing tags + pages
  const tags = db.prepare("SELECT name FROM tags WHERE user_id = ? LIMIT 100").all(userId) as { name: string }[];
  const pages = db.prepare("SELECT name FROM pages WHERE user_id = ? LIMIT 150").all(userId) as { name: string }[];
  const vocab = [...new Set([
    ...tags.map((t) => `#${t.name}`),
    ...pages.map((p) => p.name),
    ...args.attendees,
  ])].join("、");

  // Upload audio to Gemini Files API
  const uploaded = await uploadAudioFile(args.geminiKey, args.audioPath, args.audioMime);

  const systemPrompt = buildAudioFirstPrompt({
    whisperText: args.whisperText,
    vocabulary: vocab,
    attendees: args.attendees,
    removeFillers: args.removeFillers,
    meetingTitle: args.title,
  });

  const { text, usage } = await geminiAudioPolish(
    args.geminiKey,
    systemPrompt,
    ["上記の仕様に従って、音声の文字起こしを行ってください。"],
    { uri: uploaded.uri, mimeType: args.audioMime },
    {
      model: GEMINI_MODEL,
      thinkingBudget: GEMINI_THINKING_BUDGET,
      temperature: 0.1,
      maxOutputTokens: 65536,
    },
  );

  logUsage({
    userId, provider: "gemini", operation: "polish", model: GEMINI_MODEL,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    costUsd: geminiCost({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      hasAudio: true,
      hasThinking: GEMINI_THINKING_BUDGET > 0,
    }),
    meta: { meetingId: args.meetingId, thinkingBudget: GEMINI_THINKING_BUDGET },
  });

  return text;
}
