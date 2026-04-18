/**
 * Temporary audio storage for re-polish within 24h.
 *
 * We store compressed Opus files under ./data/meeting-audio/{meetingId}.opus.
 * A GC sweep runs lazily on each transcribe call to remove files > 24h old.
 */
import { writeFile, unlink, stat, readdir, mkdir } from "fs/promises";
import path from "path";

const AUDIO_DIR = path.join(process.cwd(), "data", "meeting-audio");
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function ensureDir() {
  await mkdir(AUDIO_DIR, { recursive: true });
}

export async function saveAudio(meetingId: string, bytes: Buffer): Promise<string> {
  await ensureDir();
  const filePath = path.join(AUDIO_DIR, `${meetingId}.opus`);
  await writeFile(filePath, bytes);
  // Fire-and-forget GC
  gcOldFiles().catch(() => {});
  return filePath;
}

export async function getAudioPath(meetingId: string): Promise<string | null> {
  const filePath = path.join(AUDIO_DIR, `${meetingId}.opus`);
  try {
    const s = await stat(filePath);
    if (Date.now() - s.mtimeMs > TTL_MS) {
      await unlink(filePath).catch(() => {});
      return null;
    }
    return filePath;
  } catch {
    return null;
  }
}

export async function deleteAudio(meetingId: string): Promise<void> {
  const filePath = path.join(AUDIO_DIR, `${meetingId}.opus`);
  await unlink(filePath).catch(() => {});
}

/** Remove files older than 24h. Called lazily on saveAudio. */
async function gcOldFiles() {
  try {
    const entries = await readdir(AUDIO_DIR);
    const now = Date.now();
    for (const entry of entries) {
      const p = path.join(AUDIO_DIR, entry);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > TTL_MS) {
          await unlink(p).catch(() => {});
        }
      } catch {
        // Ignore errors per-file
      }
    }
  } catch {
    // Ignore if dir doesn't exist yet
  }
}
