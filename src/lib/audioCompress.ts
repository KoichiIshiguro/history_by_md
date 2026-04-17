/**
 * Audio compression helper — re-encodes an uploaded audio file to a compact
 * speech-optimized format using ffmpeg (must be installed on the server).
 *
 * Target: 32 kbps mono Opus — ~15 MB per hour of speech. Plenty of quality
 * for Whisper; stays well under Groq's 25 MB/file limit.
 */
import { spawn } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export interface CompressResult {
  bytes: Buffer;
  filename: string;
  mime: string;
  bitrateKbps: number;
  durationSec?: number;
}

export interface CompressOptions {
  /** Audio bitrate in kbps (default 32 — speech-optimized) */
  bitrateKbps?: number;
  /** Channels: 1 = mono (default), 2 = stereo. Speech should be mono. */
  channels?: 1 | 2;
}

/**
 * Compress an audio buffer to Opus. Returns the compressed bytes + metadata.
 * Caller is responsible for error handling; throws on ffmpeg failure.
 */
export async function compressAudioToOpus(
  input: Buffer,
  originalFilename: string,
  options: CompressOptions = {},
): Promise<CompressResult> {
  const bitrateKbps = options.bitrateKbps ?? 32;
  const channels = options.channels ?? 1;

  const tmpDir = await mkdtemp(join(tmpdir(), "audio-compress-"));
  const ext = originalFilename.split(".").pop() || "bin";
  const inputPath = join(tmpDir, `input.${ext}`);
  const outputPath = join(tmpDir, "output.opus");

  try {
    await writeFile(inputPath, input);

    await runFfmpeg([
      "-i", inputPath,
      "-ac", String(channels),
      "-b:a", `${bitrateKbps}k`,
      "-vn",                      // drop any video stream
      "-application", "voip",     // Opus profile optimized for speech
      "-f", "opus",
      "-y",                       // overwrite output
      outputPath,
    ]);

    const compressed = await readFile(outputPath);
    const baseName = originalFilename.replace(/\.[^.]+$/, "");
    return {
      bytes: compressed,
      filename: `${baseName}.opus`,
      mime: "audio/ogg",
      bitrateKbps,
    };
  } finally {
    // Best-effort cleanup of temp files; swallow errors
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      // Keep only the tail — ffmpeg is verbose
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    ff.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-800)}`));
    });
  });
}
