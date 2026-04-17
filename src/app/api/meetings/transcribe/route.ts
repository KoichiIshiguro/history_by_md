import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { compressAudioToOpus } from "@/lib/audioCompress";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

// Accept up to 500MB of raw upload. Anything above 20MB is auto-compressed
// server-side to Opus 32kbps mono, which gets a 1-hour meeting down to ~15MB.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
// Groq's per-file limit.
const GROQ_LIMIT_BYTES = 25 * 1024 * 1024;
// Compress anything larger than this (also covers uncompressed WAV/AIFF).
const COMPRESS_THRESHOLD_BYTES = 20 * 1024 * 1024;
const UNCOMPRESSED_EXTENSIONS = new Set(["wav", "aiff", "aif", "flac"]);

/**
 * Accepts multipart/form-data with:
 *   file:      audio file (webm/mp4/mp3/wav/m4a)
 *   meetingId: (optional) if continuing an existing meeting row; else a new one is created
 *   title:     meeting title (optional, defaults to filename)
 *   date:      meeting date YYYY-MM-DD (optional, defaults to today)
 *   language:  BCP-47 code (default "ja")
 *
 * Returns: { meetingId, rawTranscript, durationSec }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GROQ_API_KEY not configured on server" }, { status: 500 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No audio file provided" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `ファイルサイズが上限 (${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB) を超えています。` },
      { status: 413 },
    );
  }

  const meetingIdIn = form.get("meetingId");
  const titleIn = (form.get("title") as string | null) ?? null;
  const dateIn = (form.get("date") as string | null) ?? null;
  const language = (form.get("language") as string | null) ?? "ja";

  const today = new Date().toISOString().slice(0, 10);
  const meetingId = typeof meetingIdIn === "string" && meetingIdIn ? meetingIdIn : crypto.randomUUID();
  const title = titleIn?.trim() || file.name.replace(/\.[^.]+$/, "") || "無題の会議";
  const meetingDate = dateIn || today;

  // Upsert meeting row
  const existing = db.prepare("SELECT id FROM meetings WHERE id = ? AND user_id = ?").get(meetingId, user.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE meetings SET title = ?, meeting_date = ?, audio_filename = ?, audio_mime = ?, audio_size = ?,
                            language = ?, status = 'transcribing', error_message = NULL, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(title, meetingDate, file.name, file.type || "application/octet-stream", file.size, language, meetingId, user.id);
  } else {
    db.prepare(
      `INSERT INTO meetings (id, user_id, title, meeting_date, audio_filename, audio_mime, audio_size, language, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transcribing')`
    ).run(meetingId, user.id, title, meetingDate, file.name, file.type || "application/octet-stream", file.size, language);
  }

  try {
    // Decide whether we need to compress. We compress if:
    //  - File is uncompressed (WAV/AIFF/FLAC)
    //  - File is bigger than our threshold (>20MB)
    //  - File is too big for Groq directly (>25MB) — hard requirement
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const isUncompressed = UNCOMPRESSED_EXTENSIONS.has(ext);
    const shouldCompress = isUncompressed || file.size > COMPRESS_THRESHOLD_BYTES;

    let uploadBlob: Blob;
    let uploadName: string;
    if (shouldCompress) {
      const inputBuf = Buffer.from(await file.arrayBuffer());
      const compressed = await compressAudioToOpus(inputBuf, file.name, { bitrateKbps: 32, channels: 1 });
      if (compressed.bytes.byteLength > GROQ_LIMIT_BYTES) {
        // Still too big even at 32kbps mono — would need chunking. Report for now.
        throw new Error(
          `圧縮後も Groq の 25MB 上限を超えました (${(compressed.bytes.byteLength / 1024 / 1024).toFixed(1)}MB)。音声を分割してください。`,
        );
      }
      uploadBlob = new Blob([new Uint8Array(compressed.bytes)], { type: compressed.mime });
      uploadName = compressed.filename;
    } else {
      if (file.size > GROQ_LIMIT_BYTES) {
        throw new Error(
          `Groq の上限 (25MB) を超えています。圧縮を有効にするか、音声を短く区切ってください。`,
        );
      }
      uploadBlob = file;
      uploadName = file.name;
    }

    // Forward to Groq. FormData / File are available in Node 20+ runtime.
    const groqForm = new FormData();
    groqForm.append("file", uploadBlob, uploadName);
    groqForm.append("model", GROQ_MODEL);
    groqForm.append("language", language);
    groqForm.append("response_format", "verbose_json");
    // Prompt biases the model toward better domain vocabulary (first 224 tokens only)
    const bias = await buildVocabularyBias(db, user.id);
    if (bias) groqForm.append("prompt", bias);

    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: groqForm,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 500)}`);
    }
    const result = (await res.json()) as { text: string; duration?: number };
    const rawTranscript = (result.text || "").trim();
    const durationSec = Math.round(result.duration ?? 0);

    db.prepare(
      `UPDATE meetings SET raw_transcript = ?, duration_sec = ?, status = 'transcribed', updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(rawTranscript, durationSec, meetingId, user.id);

    return Response.json({ meetingId, rawTranscript, durationSec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE meetings SET status = 'error', error_message = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(message, meetingId, user.id);
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Build a short vocabulary bias string from existing tags & page names.
 * Whisper's `prompt` parameter biases the model toward domain terms.
 * Keep it <= 1000 chars so we stay within the ~224-token window.
 */
async function buildVocabularyBias(db: any, userId: string): Promise<string> {
  const tags = db.prepare("SELECT name FROM tags WHERE user_id = ? LIMIT 60").all(userId) as { name: string }[];
  const pages = db.prepare("SELECT name FROM pages WHERE user_id = ? LIMIT 80").all(userId) as { name: string }[];
  const terms = [...tags.map((t) => t.name), ...pages.map((p) => p.name)];
  if (terms.length === 0) return "";
  // Whisper prompt: comma-separated vocabulary, no instructions.
  let joined = terms.join("、");
  if (joined.length > 900) joined = joined.slice(0, 900);
  return joined;
}
