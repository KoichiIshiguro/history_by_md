import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { compressAudioToOpus } from "@/lib/audioCompress";
import { saveAudio } from "@/lib/audioStorage";
import { uploadAudioFile, geminiAudioPolish, buildAudioFirstPrompt } from "@/lib/geminiAudio";
import { logUsage, groqWhisperCost, geminiCost } from "@/lib/usageLog";
import { serverLog } from "@/lib/serverLog";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const GEMINI_MODEL = process.env.GEMINI_POLISH_MODEL || "gemini-flash-latest";
const GEMINI_THINKING_BUDGET = parseInt(process.env.GEMINI_POLISH_THINKING_BUDGET || "1024", 10);

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const GROQ_LIMIT_BYTES = 25 * 1024 * 1024;
const COMPRESS_THRESHOLD_BYTES = 20 * 1024 * 1024;
const UNCOMPRESSED_EXTENSIONS = new Set(["wav", "aiff", "aif", "flac"]);

/**
 * Upload + compress audio synchronously, then kick off background
 * Whisper + Gemini processing and return immediately.
 *
 * The client can close the browser after this response — the server
 * continues to completion (or records an error). Poll GET /api/meetings/[id]
 * to watch progress.
 *
 * Status lifecycle:
 *   uploaded → transcribing → polishing → ready | error
 *
 * Returns: { meetingId, status: 'transcribing' }
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

  // ─── Synchronous phase: validate, compress, persist audio ──────
  let compressedBytes: Buffer;
  let compressedMime: string;
  try {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const isUncompressed = UNCOMPRESSED_EXTENSIONS.has(ext);
    const shouldCompress = isUncompressed || file.size > COMPRESS_THRESHOLD_BYTES;

    if (shouldCompress) {
      const inputBuf = Buffer.from(await file.arrayBuffer());
      const compressed = await compressAudioToOpus(inputBuf, file.name, { bitrateKbps: 32, channels: 1 });
      if (compressed.bytes.byteLength > GROQ_LIMIT_BYTES) {
        return Response.json({ error: `圧縮後も 25MB を超えました (${(compressed.bytes.byteLength / 1024 / 1024).toFixed(1)}MB)。音声を分割してください。` }, { status: 400 });
      }
      compressedBytes = compressed.bytes;
      compressedMime = compressed.mime;
    } else {
      if (file.size > GROQ_LIMIT_BYTES) {
        return Response.json({ error: `25MB を超えています。` }, { status: 400 });
      }
      compressedBytes = Buffer.from(await file.arrayBuffer());
      compressedMime = file.type || "audio/ogg";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await serverLog("error", "transcribe.upload.compress_failed", {
      userId: user.id, fileName: file.name, fileSize: file.size,
    }, err);
    return Response.json({ error: `音声処理エラー: ${message}` }, { status: 500 });
  }

  const audioPath = await saveAudio(meetingId, compressedBytes);

  // Upsert meeting row (status: transcribing — background work starts next)
  const existing = db.prepare("SELECT id FROM meetings WHERE id = ? AND user_id = ?").get(meetingId, user.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE meetings SET title = ?, meeting_date = ?, audio_filename = ?, audio_mime = ?, audio_size = ?,
                            language = ?, attendees = ?, remove_fillers = ?,
                            audio_tmp_path = ?, status = 'transcribing', error_message = NULL,
                            updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(title, meetingDate, file.name, file.type || "application/octet-stream", file.size,
           language, attendeesJson, removeFillers ? 1 : 0, audioPath, meetingId, user.id);
  } else {
    db.prepare(
      `INSERT INTO meetings
         (id, user_id, title, meeting_date, audio_filename, audio_mime, audio_size, language,
          attendees, remove_fillers, audio_tmp_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transcribing')`
    ).run(meetingId, user.id, title, meetingDate, file.name,
           file.type || "application/octet-stream", file.size, language,
           attendeesJson, removeFillers ? 1 : 0, audioPath);
  }

  // ─── Fire-and-forget background work ─────────────────────────
  // These promises continue running even after the HTTP response is sent.
  // Errors are caught and recorded in the DB; nothing is thrown to the caller.
  const backgroundArgs = {
    meetingId, userId: user.id, audioPath, compressedMime,
    language, attendees, removeFillers, title,
    fileName: file.name, groqKey, geminiKey,
  };
  runBackgroundPipeline(backgroundArgs).catch(async (err) => {
    console.error(`[meetings/transcribe] background error for ${meetingId}:`, err);
    await serverLog("error", "transcribe.background.unhandled", {
      meetingId, userId: user.id, fileName: file.name,
    }, err);
  });

  // Return immediately — the browser can close now
  return Response.json({
    meetingId,
    status: "transcribing",
    message: "音声のアップロードが完了しました。文字起こしと清書は裏側で続行されます。",
  });
}

async function runBackgroundPipeline(args: {
  meetingId: string;
  userId: string;
  audioPath: string;
  compressedMime: string;
  language: string;
  attendees: string[];
  removeFillers: boolean;
  title: string;
  fileName: string;
  groqKey: string;
  geminiKey: string;
}) {
  const db = getDb();
  try {
    // 1. Whisper (Groq) — with retry + fallback ladder.
    //
    // Groq's whisper-large-v3-turbo has a known intermittent 500 issue
    // (see community.groq.com forum thread on /audio/transcriptions
    // 500s, frequently correlated with the `prompt` parameter). We wrap
    // the call in a 4-step ladder:
    //   1. turbo + prompt (normal path)
    //   2. retry with backoff for transient 5xx
    //   3. drop the prompt and retry on turbo (avoid the prompt-bug)
    //   4. fall back to whisper-large-v3 (non-turbo) without prompt
    // Only after all four fail do we mark the meeting as error.
    const { readFile } = await import("fs/promises");
    const audioBytes = await readFile(args.audioPath);
    const bias = await buildVocabularyBias(db, args.userId, { attendees: args.attendees });

    const buildForm = (model: string, includeBias: boolean) => {
      const f = new FormData();
      f.append("file", new Blob([new Uint8Array(audioBytes)], { type: args.compressedMime }), `${args.meetingId}.opus`);
      f.append("model", model);
      f.append("language", args.language);
      f.append("response_format", "verbose_json");
      if (includeBias && bias) f.append("prompt", bias);
      return f;
    };

    const callGroq = async (model: string, includeBias: boolean) =>
      fetch(GROQ_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${args.groqKey}` },
        body: buildForm(model, includeBias),
      });

    type Attempt = { model: string; includeBias: boolean; backoffMs: number };
    const attempts: Attempt[] = [
      { model: GROQ_MODEL, includeBias: true,  backoffMs: 0 },     // 1. turbo + prompt
      { model: GROQ_MODEL, includeBias: true,  backoffMs: 2000 },  // 2. retry on 5xx
      { model: GROQ_MODEL, includeBias: true,  backoffMs: 5000 },  // 3. retry again
      { model: GROQ_MODEL, includeBias: false, backoffMs: 1000 },  // 4. drop prompt
      { model: "whisper-large-v3", includeBias: false, backoffMs: 1000 }, // 5. non-turbo
    ];

    let whisperRes: Response | null = null;
    let lastBody = "";
    let usedModel = GROQ_MODEL;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if (a.backoffMs > 0) await new Promise((r) => setTimeout(r, a.backoffMs));
      const res = await callGroq(a.model, a.includeBias);
      if (res.ok) {
        whisperRes = res;
        usedModel = a.model;
        if (i > 0) {
          await serverLog("warn", "transcribe.whisper.recovered", {
            meetingId: args.meetingId, userId: args.userId,
            attempt: i + 1, model: a.model, includeBias: a.includeBias,
          });
        }
        break;
      }
      lastBody = (await res.text()).slice(0, 1000);
      const isRetryable = res.status >= 500 && res.status < 600;
      await serverLog(isRetryable ? "warn" : "error", "transcribe.whisper.http_error", {
        meetingId: args.meetingId, userId: args.userId,
        attempt: i + 1, model: a.model, includeBias: a.includeBias,
        status: res.status,
        biasBytes: a.includeBias && bias ? Buffer.byteLength(bias, "utf8") : 0,
        body: lastBody,
      });
      if (!isRetryable) {
        // 4xx → no point retrying (auth, rate limit, validation). Fail fast.
        throw new Error(`Groq Whisper error ${res.status}: ${lastBody.slice(0, 500)}`);
      }
    }
    if (!whisperRes) {
      throw new Error(`Groq Whisper failed after ${attempts.length} attempts. Last body: ${lastBody.slice(0, 500)}`);
    }

    const whisperResult = (await whisperRes.json()) as { text: string; duration?: number };
    const rawTranscript = (whisperResult.text || "").trim();
    const durationSec = Math.round(whisperResult.duration ?? 0);

    logUsage({
      userId: args.userId, provider: "groq", operation: "transcribe", model: usedModel,
      audioSeconds: durationSec, costUsd: groqWhisperCost(durationSec),
      meta: { meetingId: args.meetingId, filename: args.fileName },
    });

    db.prepare(
      `UPDATE meetings SET raw_transcript = ?, duration_sec = ?, status = 'polishing', updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(rawTranscript, durationSec, args.meetingId, args.userId);

    // 2. Gemini polish (audio + whisper text)
    const polishedText = await runGeminiAudioPolish(db, args.userId, {
      audioPath: args.audioPath,
      audioMime: args.compressedMime,
      whisperText: rawTranscript,
      attendees: args.attendees,
      removeFillers: args.removeFillers,
      title: args.title,
      meetingId: args.meetingId,
      geminiKey: args.geminiKey,
    });

    db.prepare(
      `UPDATE meetings SET polished_transcript = ?, status = 'ready', error_message = NULL, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(polishedText, args.meetingId, args.userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await serverLog("error", "transcribe.pipeline.failed", {
      meetingId: args.meetingId, userId: args.userId, fileName: args.fileName,
    }, err);
    db.prepare(
      `UPDATE meetings SET status = 'error', error_message = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(message, args.meetingId, args.userId);
    throw err; // rethrow so the catch in POST logs it
  }
}

/**
 * Build the Whisper `prompt` (vocabulary bias).
 *
 * Groq's error message says "896 characters" but it actually counts
 * UTF-8 bytes — a JS .length cap doesn't help. We clamp by bytes.
 *
 * Selection priority (high → low):
 *   1. Attendees of THIS meeting (most likely proper nouns in the audio)
 *   2. Tags / pages ranked by reference count desc, then recency desc
 *   3. Skip noise (pure digits, 1-char names, duplicates)
 *   4. If a term doesn't fit, SKIP it and try the next — one long term
 *      shouldn't starve out a dozen shorter useful ones.
 */
const WHISPER_PROMPT_MAX_BYTES = 880;

function isVocabNoise(name: string): boolean {
  if (!name || name.length <= 1) return true;
  if (/^\d+$/.test(name)) return true;
  if (/^[\s_\-]+$/.test(name)) return true;
  return false;
}

async function buildVocabularyBias(
  db: any,
  userId: string,
  opts: { attendees?: string[] } = {},
): Promise<string> {
  const tagRows = db.prepare(
    "SELECT t.name AS name, COUNT(bt.block_id) AS refs, IFNULL(MAX(b.updated_at), '') AS last " +
    "FROM tags t LEFT JOIN block_tags bt ON bt.tag_id = t.id " +
    "LEFT JOIN blocks b ON b.id = bt.block_id " +
    "WHERE t.user_id = ? GROUP BY t.id ORDER BY refs DESC, last DESC LIMIT 80"
  ).all(userId) as { name: string }[];

  const pageRows = db.prepare(
    "SELECT p.name AS name, COUNT(bp.block_id) AS refs, IFNULL(MAX(b.updated_at), p.created_at) AS last " +
    "FROM pages p LEFT JOIN block_pages bp ON bp.page_id = p.id " +
    "LEFT JOIN blocks b ON b.id = bp.block_id " +
    "WHERE p.user_id = ? GROUP BY p.id ORDER BY refs DESC, last DESC LIMIT 100"
  ).all(userId) as { name: string }[];

  const ranked: string[] = [];
  for (const a of opts.attendees || []) ranked.push(a);
  for (const t of tagRows) ranked.push(`#${t.name}`);
  for (const p of pageRows) ranked.push(p.name);

  const seen = new Set<string>();
  const useful = ranked.filter((n) => {
    if (isVocabNoise(n)) return false;
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  if (useful.length === 0) return "";

  const sep = "、";
  const enc = new TextEncoder();
  let out = "";
  let outBytes = 0;
  for (const term of useful) {
    const piece = out ? sep + term : term;
    const pb = enc.encode(piece).length;
    if (outBytes + pb > WHISPER_PROMPT_MAX_BYTES) continue;
    out += piece;
    outBytes += pb;
  }
  return out;
}

/**
 * Shared Gemini polish routine: uploads audio to Files API, runs generation,
 * logs usage. Exported for reuse by /api/meetings/polish.
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
  const tags = db.prepare("SELECT name FROM tags WHERE user_id = ? LIMIT 100").all(userId) as { name: string }[];
  const pages = db.prepare("SELECT name FROM pages WHERE user_id = ? LIMIT 150").all(userId) as { name: string }[];
  const vocab = [...new Set([
    ...tags.map((t) => `#${t.name}`),
    ...pages.map((p) => p.name),
    ...args.attendees,
  ])].join("、");

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
