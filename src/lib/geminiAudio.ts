/**
 * Gemini multimodal (audio + text) helper.
 *
 * Uses the Files API to upload audio, then references it in generateContent.
 * Small files could be inlined as base64, but audio approaches the
 * inline size cap (20MB) quickly, so we always go via Files API.
 */
import { readFile } from "fs/promises";

const FILES_API = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GENERATE_API = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiAudioOptions {
  /** Model id. Default: `gemini-flash-latest` */
  model?: string;
  /** Token budget for thinking. 0 = disabled. Low ≈ 1024, Med ≈ 4096, High ≈ 16384 */
  thinkingBudget?: number;
  /** Temperature. 0.1 recommended for transcription accuracy. */
  temperature?: number;
  /** Max output tokens. Transcripts can be long — 65536 default. */
  maxOutputTokens?: number;
}

/**
 * Upload an audio file to Gemini Files API. Returns the `uri` you can
 * reference in generateContent. Files auto-expire after 48h on Google's side.
 */
export async function uploadAudioFile(
  apiKey: string,
  audioPath: string,
  mimeType = "audio/ogg",
): Promise<{ uri: string; name: string }> {
  const buffer = await readFile(audioPath);
  const displayName = audioPath.split("/").pop() || "audio";

  // Step 1: Start resumable upload
  const startRes = await fetch(`${FILES_API}?key=${apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) {
    throw new Error(`Files API init failed: ${startRes.status} ${await startRes.text()}`);
  }
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Files API did not return upload URL");

  // Step 2: Upload bytes
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Uint8Array(buffer),
  });
  if (!uploadRes.ok) {
    throw new Error(`Files API upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }
  const data = (await uploadRes.json()) as { file: { name: string; uri: string; state: string } };
  return { uri: data.file.uri, name: data.file.name };
}

/** Call Gemini generateContent with audio + text inputs. */
export async function geminiAudioPolish(
  apiKey: string,
  systemPrompt: string,
  userTextParts: string[],
  audio: { uri: string; mimeType: string },
  options: GeminiAudioOptions = {},
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; cachedTokens?: number } }> {
  const model = options.model ?? "gemini-flash-latest";
  const thinkingBudget = options.thinkingBudget ?? 1024; // Low
  const temperature = options.temperature ?? 0.1;
  const maxOutputTokens = options.maxOutputTokens ?? 65536;

  const parts: any[] = [
    ...userTextParts.map((text) => ({ text })),
    { fileData: { mimeType: audio.mimeType, fileUri: audio.uri } },
  ];

  const res = await fetch(`${GENERATE_API}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini audio call failed: ${res.status} ${(await res.text()).slice(0, 800)}`);
  }
  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  const usage = data.usageMetadata || {};
  return {
    text,
    usage: {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      cachedTokens: usage.cachedContentTokenCount,
    },
  };
}

/**
 * Build the strict prompt that treats Whisper as a coverage checklist only,
 * NOT as a source of truth. Gemini's own audio interpretation always wins.
 */
export function buildAudioFirstPrompt(args: {
  whisperText: string;
  vocabulary: string;
  attendees: string[];
  removeFillers: boolean;
  meetingTitle?: string;
}): string {
  const attendeesLine = args.attendees.length > 0
    ? `参加者: ${args.attendees.join("、")}`
    : "";
  const titleLine = args.meetingTitle ? `会議タイトル: ${args.meetingTitle}` : "";

  return `あなたは日本語音声の文字起こしを行う専門家です。

【主情報源】
添付された音声を**あなた自身で直接聞き取って**文字起こしします。
これがあなたの出力の基礎であり、真の正解です。

【参考リスト（Whisper出力）】
別の音声認識モデル (Whisper) による文字起こしも提供します。
**このテキストは多数の誤認識を含みます**。以下の用途のみに使用できます:

✅ 許可される使い方
- あなたの聞き取りに漏れがないかのチェック (カバレッジ保険)
- あなたが聞き取れなかった短い発話・相槌・フィラーを補完する際の参照

❌ 絶対禁止
- あなたが聞き取った発話を Whisper の表記に書き換える
- あなたが「郷馬」と聞いたのに Whisper が「傲慢」と書いているから「傲慢」と書く
- 同音異義で迷った時、Whisper を正解として採用する
- 自分の聞き取りを疑って Whisper 寄りに変更する

【作業手順】
1. まず音声を最初から最後まで注意深く聞き、**あなた自身の聞き取り**で書き起こす
2. 完成後、Whisper の出力と照合し、**自分が取り漏らした発話のみ**を特定する
3. 漏れていた発話のみを該当箇所に挿入（この時だけ Whisper テキストを参考にする）
4. 最終結果を出力

【絶対ルール】
- あなたの聞き取り結果 > Whisper の表記 （常に）
- 聞き取りに自信があるなら、Whisper と食い違っても自分の判断を採用
- 音声で全く聞き取れなかった区間のみ Whisper を採用
- 要約・短縮・意訳は一切禁止
- 不明瞭な箇所は [聞き取り不能] と明示

${titleLine ? `【会議メタ情報】\n${titleLine}\n${attendeesLine}\n` : attendeesLine ? `【会議メタ情報】\n${attendeesLine}\n` : ""}

${args.vocabulary ? `【既存の固有名詞・技術用語】\n発音が近い語はこれらの表記を優先してください:\n${args.vocabulary}\n` : ""}

${args.removeFillers
    ? "【フィラー除去: ON】\n- 「えーと」「あのー」「えっと」「まあ」などの意味のないフィラーを除去\n- 言い直しがあれば最終形を採用"
    : "【フィラー除去: OFF】\n- フィラー（「えーと」等）もそのまま残す"}

【悪い例（絶対にやるな）】
音声: 「郷馬さんが提案した」、Whisper: 「傲慢さんが提案した」
❌ 「傲慢さんが提案した」と書く（Whisperに引っ張られた）
✅ 「郷馬さんが提案した」と書く

【出力形式】
自然な日本語文字起こしのみ。前置き・解説・Markdown 記号は不要。
段落分けは話題の区切りで。

【Whisper の出力（参考のみ、誤認識多数含む可能性あり）】
<whisper>
${args.whisperText}
</whisper>`;
}
