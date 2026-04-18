/**
 * API usage + cost logging for the billing dashboard.
 *
 * All external API calls should run through `logUsage()` so we can show
 * the user what they're spending per provider / per month.
 *
 * Prices are approximations (USD) and stored as constants below. Update these
 * if providers change pricing. They're used for display only; actual billing
 * still happens on the provider side.
 */
import { getDb } from "./db";

export type Provider = "groq" | "gemini" | "voyage" | "pinecone";
export type Operation =
  | "transcribe"      // audio → text (Whisper)
  | "polish"          // text cleanup or audio+text polish (Gemini)
  | "chat"            // AI chat conversation
  | "generate"        // !ai prompt generation
  | "embed"           // Voyage embedding
  | "query"           // Pinecone query
  | "upsert";         // Pinecone upsert

// ─── Pricing (USD) ─────────────────────────────────────────────
// Update when providers change their rates.

export const PRICES = {
  groq: {
    // Groq Whisper: $0.04/hour = $0.04/3600 per second
    whisperPerSecond: 0.04 / 3600,
  },
  gemini: {
    // Gemini 2.5/3 Flash rates (approx, update with official when GA)
    // Text/image input (up to 128k context)
    inputPerToken: 0.075 / 1_000_000,
    // Audio input is billed at a higher rate per token
    audioInputPerToken: 1.0 / 1_000_000,
    // Output (including thinking tokens) — Flash tier
    outputPerToken: 0.30 / 1_000_000,
    // Thinking output (Gemini 2.5+)
    thinkingOutputPerToken: 2.50 / 1_000_000,
  },
  voyage: {
    // voyage-3-large: $0.12 / 1M tokens; voyage-3: $0.06 / 1M
    perTokenLarge: 0.12 / 1_000_000,
    perToken: 0.06 / 1_000_000,
  },
  pinecone: {
    // Pinecone serverless: $0.33/GB-month storage + $8.25/M read/write units
    readWritePerUnit: 8.25 / 1_000_000,
    storagePerGBMonth: 0.33,
  },
};

export interface LogEntry {
  userId: string;
  provider: Provider;
  operation: Operation;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  costUsd: number;
  meta?: Record<string, unknown>;
}

export function logUsage(entry: LogEntry): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO api_usage_log
       (id, user_id, provider, operation, model, input_tokens, output_tokens, audio_seconds, cost_usd, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      entry.userId,
      entry.provider,
      entry.operation,
      entry.model || null,
      entry.inputTokens || 0,
      entry.outputTokens || 0,
      entry.audioSeconds || 0,
      entry.costUsd,
      entry.meta ? JSON.stringify(entry.meta) : null,
    );
  } catch (err) {
    // Never let logging break the main flow
    console.error("[usageLog] failed to log entry:", err);
  }
}

// ─── Cost calculators ─────────────────────────────────────────

export function groqWhisperCost(audioSeconds: number): number {
  return audioSeconds * PRICES.groq.whisperPerSecond;
}

/**
 * Gemini cost approximation.
 * We can't distinguish audio vs text input tokens from the usageMetadata
 * (which reports a single promptTokenCount). When an audio input is used,
 * most of the prompt tokens are audio — we approximate with audioInputPerToken.
 */
export function geminiCost(opts: {
  inputTokens: number;
  outputTokens: number;
  hasAudio?: boolean;
  hasThinking?: boolean;
}): number {
  const inputRate = opts.hasAudio
    ? PRICES.gemini.audioInputPerToken
    : PRICES.gemini.inputPerToken;
  const outputRate = opts.hasThinking
    ? PRICES.gemini.thinkingOutputPerToken
    : PRICES.gemini.outputPerToken;
  return opts.inputTokens * inputRate + opts.outputTokens * outputRate;
}

export function voyageCost(opts: { inputTokens: number; model: string }): number {
  const rate = opts.model.includes("large") ? PRICES.voyage.perTokenLarge : PRICES.voyage.perToken;
  return opts.inputTokens * rate;
}
