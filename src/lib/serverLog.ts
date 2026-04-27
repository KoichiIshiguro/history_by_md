/**
 * File-based server log for catching API errors that systemd's journal
 * eats. journalctl requires sudo on our self-hosted box, but the app
 * runs as `saltybullet` and can write under data/, which we can read
 * via SSH without elevated privileges.
 *
 * Usage:
 *   import { serverLog } from "@/lib/serverLog";
 *   serverLog("error", "transcribe.whisper.failed", { meetingId, status, body }, err);
 *
 * Format (one record per line, JSON):
 *   {"ts":"2026-04-28T03:14:15.123Z","level":"error","scope":"transcribe.whisper.failed",
 *    "ctx":{...},"err":"...","stack":"..."}
 *
 * The file is `data/server.log`. Truncated automatically once it exceeds
 * `MAX_BYTES` (keeps a single .1 backup), so it never grows unbounded.
 */
import { appendFile, stat, rename, unlink } from "fs/promises";
import path from "path";

const LOG_PATH = path.join(process.cwd(), "data", "server.log");
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

type Level = "info" | "warn" | "error";

async function maybeRotate() {
  try {
    const s = await stat(LOG_PATH);
    if (s.size < MAX_BYTES) return;
    const backup = LOG_PATH + ".1";
    try { await unlink(backup); } catch { /* ignore */ }
    await rename(LOG_PATH, backup);
  } catch {
    // file doesn't exist yet → nothing to rotate
  }
}

export async function serverLog(
  level: Level,
  scope: string,
  ctx?: Record<string, unknown>,
  err?: unknown,
): Promise<void> {
  try {
    await maybeRotate();
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
    };
    if (ctx && Object.keys(ctx).length > 0) record.ctx = ctx;
    if (err !== undefined) {
      if (err instanceof Error) {
        record.err = err.message;
        if (err.stack) record.stack = err.stack.slice(0, 4000);
      } else {
        record.err = String(err);
      }
    }
    await appendFile(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Last-resort: don't break the request just because we can't log.
  }
}
