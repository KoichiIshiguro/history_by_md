/**
 * Text-only meeting polish via Gemini.
 *
 * Two flavors sharing the same call signature:
 *   - source = "whisper": the input is a Whisper transcription with
 *     speech-recognition errors. Prompt focuses on fixing misheard
 *     homophones, proper nouns, punctuation, spacing, etc.
 *   - source = "notes":   the input was typed by the user (meeting
 *     memo, quick notes). Prompt focuses on tidying the wording,
 *     punctuation, paragraphing — without inventing content.
 */
import { logUsage, geminiCost } from "./usageLog";

export interface TextPolishArgs {
  db: any;
  userId: string;
  meetingId: string;
  rawText: string;
  attendees: string[];
  removeFillers: boolean;
  title?: string;
  source: "whisper" | "notes";
  geminiKey: string;
}

const MODEL = process.env.GEMINI_POLISH_MODEL || "gemini-flash-latest";
const THINKING_BUDGET = parseInt(process.env.GEMINI_POLISH_THINKING_BUDGET || "1024", 10);

export async function polishText(args: TextPolishArgs): Promise<string> {
  const tags = args.db.prepare("SELECT name FROM tags WHERE user_id = ? LIMIT 100").all(args.userId) as { name: string }[];
  const pages = args.db.prepare("SELECT name FROM pages WHERE user_id = ? LIMIT 150").all(args.userId) as { name: string }[];
  const vocabulary = [
    ...new Set([...tags.map((t) => `#${t.name}`), ...pages.map((p) => p.name), ...args.attendees]),
  ].join("、");

  const systemPrompt = args.source === "whisper"
    ? whisperPostEditPrompt(vocabulary, args.removeFillers)
    : notesCleanupPrompt(vocabulary, args.removeFillers, args.title);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${args.geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: args.rawText }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
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
    userId: args.userId,
    provider: "gemini",
    operation: "polish",
    model: MODEL,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    costUsd: geminiCost({
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      hasAudio: false,
      hasThinking: THINKING_BUDGET > 0,
    }),
    meta: { meetingId: args.meetingId, mode: `text-only-${args.source}`, thinkingBudget: THINKING_BUDGET },
  });

  return text;
}

function whisperPostEditPrompt(vocabulary: string, removeFillers: boolean): string {
  return `あなたは日本語音声の文字起こしをポストエディットする専門家です。
入力は別の音声認識モデル (Whisper) の出力で、誤認識を含みます。
発言内容の改変・要約・省略は絶対に禁止。誤認識の修正と表記統一のみ行います。
語彙辞書: ${vocabulary || "(なし)"}
${removeFillers ? "フィラー (えーと、あのー等) は除去" : "フィラーもそのまま残す"}
出力は修正後のテキストのみ。`;
}

function notesCleanupPrompt(vocabulary: string, removeFillers: boolean, title?: string): string {
  return `あなたは日本語のメモ・ノートを読みやすく整理する専門家です。
入力はユーザーが会議中・会議後に素早く打ったメモで、断片的・口語的です。
以下の方針で整えてください。

【行うこと】
- 句読点を補い、文章として成立させる
- 誤字・衍字の修正
- 表記揺れの統一（半角/全角、漢字/カナ）
- 箇条書きや段落分けで読みやすく整える
- 語彙辞書に合致しそうな箇所はその表記を優先: ${vocabulary || "(なし)"}
${title ? `- 会議タイトル「${title}」の文脈を考慮` : ""}

【絶対にやらないこと】
- 要約・短縮・省略
- 書かれていない内容の追加・推測による補完
- 意味の改変

${removeFillers ? "- フィラー（えーと、あのー等）は除去" : "- フィラーもそのまま残す"}

出力は整形後のテキストのみ。前置き・解説は不要です。`;
}
