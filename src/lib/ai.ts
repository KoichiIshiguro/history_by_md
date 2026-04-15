/**
 * AI features: embedding context builder, chunking, Voyage AI, Pinecone, Gemini
 */
import { Pinecone } from "@pinecone-database/pinecone";
import { getDb } from "./db";

// ─── Types ──────────────────────────────────────────────────────

interface BlockRow {
  id: string;
  content: string;
  indent_level: number;
  sort_order: number;
  date: string;
  page_id: string | null;
  user_id: string;
  vector_synced_at: string | null;
  updated_at: string;
}

interface PageRow {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface EmbeddingChunk {
  id: string; // "block_<blockId>" or "block_<blockId>#<chunkIndex>"
  text: string; // the text to embed
  metadata: {
    block_id: string;
    chunk_index: number;
    user_id: string;
    date: string;
    page_id: string | null;
    page_path: string;
  };
}

// ─── Config ─────────────────────────────────────────────────────

const CHUNK_THRESHOLD = 400; // characters — split if longer
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 80;
const MAX_SIBLINGS = 2; // before + after the target block
const VOYAGE_BATCH_SIZE = 128;

// ─── Page path resolver ─────────────────────────────────────────

function buildPagePath(pageId: string | null, pages: PageRow[]): string {
  if (!pageId) return "";
  const pageMap = new Map(pages.map((p) => [p.id, p]));
  const parts: string[] = [];
  let current = pageMap.get(pageId);
  while (current) {
    parts.unshift(current.name);
    current = current.parent_id ? pageMap.get(current.parent_id) : undefined;
  }
  return parts.join("/");
}

// ─── Context builder ────────────────────────────────────────────

/**
 * Build embedding text for a block with ancestors, siblings, page path, date.
 */
export function buildEmbeddingText(
  block: BlockRow,
  allBlocksInGroup: BlockRow[], // all blocks in the same page or date
  pagePath: string
): string {
  const header = [
    block.date ? `[${block.date}]` : null,
    pagePath ? pagePath : null,
  ]
    .filter(Boolean)
    .join(" ");

  // Find ancestors (walk up indent levels)
  const blockIdx = allBlocksInGroup.findIndex((b) => b.id === block.id);
  const ancestors: string[] = [];
  let targetIndent = block.indent_level;
  for (let i = blockIdx - 1; i >= 0 && targetIndent > 0; i--) {
    const b = allBlocksInGroup[i];
    if (b.indent_level < targetIndent) {
      ancestors.unshift(b.content.slice(0, 100)); // limit ancestor length
      targetIndent = b.indent_level;
    }
  }

  // Find siblings (same parent, same indent level)
  // Determine parent boundary: the nearest block above with indent_level < block.indent_level
  let parentIdx = -1;
  for (let i = blockIdx - 1; i >= 0; i--) {
    if (allBlocksInGroup[i].indent_level < block.indent_level) {
      parentIdx = i;
      break;
    }
  }
  // Find next block with indent <= parent (end of sibling group)
  let groupEnd = allBlocksInGroup.length;
  for (let i = blockIdx + 1; i < allBlocksInGroup.length; i++) {
    if (allBlocksInGroup[i].indent_level <= (parentIdx >= 0 ? allBlocksInGroup[parentIdx].indent_level : -1)) {
      groupEnd = i;
      break;
    }
  }

  const siblings: string[] = [];
  const siblingStart = Math.max(parentIdx + 1, 0);
  let siblingsBefore = 0;
  let siblingsAfter = 0;
  for (let i = siblingStart; i < groupEnd; i++) {
    const b = allBlocksInGroup[i];
    if (b.indent_level !== block.indent_level) continue;
    if (b.id === block.id) continue;
    if (i < blockIdx && siblingsBefore < MAX_SIBLINGS) {
      siblings.push(b.content.slice(0, 80));
      siblingsBefore++;
    } else if (i > blockIdx && siblingsAfter < MAX_SIBLINGS) {
      siblings.push(b.content.slice(0, 80));
      siblingsAfter++;
    }
  }

  // Assemble
  const chain = [...ancestors, block.content].join(" > ");
  const siblingText = siblings.length > 0 ? `（${siblings.join(" / ")}）` : "";

  return `${header}\n${chain}${siblingText}`.trim();
}

// ─── Chunker ────────────────────────────────────────────────────

/**
 * Split long text into overlapping chunks at sentence boundaries.
 */
function splitIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_THRESHOLD) return [text];

  // Split by sentence boundaries (。！？\n)
  const sentences = text.split(/(?<=[。！？\n])/g).filter((s) => s.length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current);
      // Overlap: carry tail of current chunk
      current = current.slice(-CHUNK_OVERLAP) + sentence;
    } else {
      current += sentence;
    }
  }
  if (current.length > 0) chunks.push(current);

  // If no sentence boundaries found, split by character
  if (chunks.length === 0) {
    for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }
  }

  return chunks;
}

/**
 * Create embedding chunks for a single block (with context).
 */
export function createEmbeddingChunks(
  block: BlockRow,
  allBlocksInGroup: BlockRow[],
  pagePath: string
): EmbeddingChunk[] {
  const fullText = buildEmbeddingText(block, allBlocksInGroup, pagePath);

  // Build header (date + page path + ancestors) separate from block content
  // so we can prepend it to each chunk
  const headerParts = [
    block.date ? `[${block.date}]` : null,
    pagePath ? pagePath : null,
  ].filter(Boolean).join(" ");

  const blockContent = block.content;

  if (blockContent.length <= CHUNK_THRESHOLD) {
    return [{
      id: `block_${block.id}`,
      text: fullText,
      metadata: {
        block_id: block.id,
        chunk_index: 0,
        user_id: block.user_id,
        date: block.date,
        page_id: block.page_id,
        page_path: pagePath,
      },
    }];
  }

  // Long block: chunk the content, prepend context header to each
  const contentChunks = splitIntoChunks(blockContent);

  // Rebuild ancestor chain for header
  const blockIdx = allBlocksInGroup.findIndex((b) => b.id === block.id);
  const ancestors: string[] = [];
  let targetIndent = block.indent_level;
  for (let i = blockIdx - 1; i >= 0 && targetIndent > 0; i--) {
    const b = allBlocksInGroup[i];
    if (b.indent_level < targetIndent) {
      ancestors.unshift(b.content.slice(0, 100));
      targetIndent = b.indent_level;
    }
  }
  const ancestorChain = ancestors.length > 0 ? ancestors.join(" > ") + " > " : "";

  return contentChunks.map((chunk, i) => ({
    id: `block_${block.id}#${i}`,
    text: `${headerParts}\n${ancestorChain}${chunk}`.trim(),
    metadata: {
      block_id: block.id,
      chunk_index: i,
      user_id: block.user_id,
      date: block.date,
      page_id: block.page_id,
      page_path: pagePath,
    },
  }));
}

// ─── Voyage AI embeddings ───────────────────────────────────────

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");

  const results: number[][] = [];

  // Process in batches of VOYAGE_BATCH_SIZE
  for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
    const batch = texts.slice(i, i + VOYAGE_BATCH_SIZE);
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: batch,
        model: "voyage-3-lite",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Voyage AI error: ${res.status} ${err}`);
    }

    const data = await res.json();
    for (const item of data.data) {
      results.push(item.embedding);
    }
  }

  return results;
}

// ─── Pinecone client ────────────────────────────────────────────

function getPineconeIndex() {
  const apiKey = process.env.PINECONE_API_KEY;
  const indexName = process.env.PINECONE_INDEX || "history-md";
  if (!apiKey) throw new Error("PINECONE_API_KEY is not set");

  const pc = new Pinecone({ apiKey });
  return pc.index(indexName);
}

export async function upsertVectors(
  chunks: EmbeddingChunk[],
  embeddings: number[][]
) {
  const index = getPineconeIndex();

  // Pinecone upsert in batches of 100
  // Remove null values from metadata (Pinecone rejects nulls)
  const vectors = chunks.map((chunk, i) => {
    const cleanMeta: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(chunk.metadata)) {
      if (v !== null && v !== undefined) cleanMeta[k] = v;
    }
    return {
      id: chunk.id,
      values: embeddings[i],
      metadata: cleanMeta,
    };
  });

  for (let i = 0; i < vectors.length; i += 100) {
    const batch = vectors.slice(i, i + 100);
    await index.upsert({ records: batch } as any);
  }
}

export async function deleteVectorsByBlockId(blockId: string) {
  const index = getPineconeIndex();
  // Delete main vector and all chunks
  const idsToDelete = [`block_${blockId}`];
  // Also try chunk IDs (up to 20 chunks should cover any block)
  for (let i = 0; i < 20; i++) {
    idsToDelete.push(`block_${blockId}#${i}`);
  }
  try {
    await index.deleteMany(idsToDelete);
  } catch {
    // Ignore errors for non-existent IDs
  }
}

export async function deleteVectorsByBlockIds(blockIds: string[]) {
  const index = getPineconeIndex();
  const allIds: string[] = [];
  for (const blockId of blockIds) {
    allIds.push(`block_${blockId}`);
    for (let i = 0; i < 20; i++) {
      allIds.push(`block_${blockId}#${i}`);
    }
  }
  // Delete in batches of 1000
  for (let i = 0; i < allIds.length; i += 1000) {
    try {
      await index.deleteMany(allIds.slice(i, i + 1000));
    } catch {
      // Ignore
    }
  }
}

export async function queryVectors(
  queryEmbedding: number[],
  userId: string,
  topK: number = 10,
  filter?: Record<string, any>
) {
  const index = getPineconeIndex();
  const queryFilter: Record<string, any> = { user_id: { $eq: userId }, ...filter };

  const results = await index.query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
    filter: queryFilter,
  });

  return results.matches || [];
}

// ─── Gemini ─────────────────────────────────────────────────────

export async function geminiChat(
  systemPrompt: string,
  userMessage: string,
  options?: { stream?: boolean }
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

export async function geminiStream(
  systemPrompt: string,
  userMessage: string
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini streaming error: ${res.status} ${err}`);
  }

  // Transform SSE stream into text stream
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      const reader = res.body?.getReader();
      if (!reader) { controller.close(); return; }

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) controller.enqueue(encoder.encode(text));
          } catch {
            // Skip malformed JSON
          }
        }
      }
      controller.close();
    },
  });
}

// ─── Sync orchestrator ──────────────────────────────────────────

/**
 * Sync vectors for a user: find changed blocks, embed, upsert, clean up deleted.
 * Returns stats.
 */
export async function syncVectors(userId: string): Promise<{
  embedded: number;
  deleted: number;
  errors: string[];
}> {
  const db = getDb();
  const errors: string[] = [];

  // 1. Find blocks that need (re)embedding
  const changedBlocks = db.prepare(`
    SELECT * FROM blocks
    WHERE user_id = ?
    AND (vector_synced_at IS NULL OR updated_at > vector_synced_at)
    AND content != ''
    ORDER BY page_id, date, sort_order
  `).all(userId) as BlockRow[];

  // 2. Find deleted blocks (blocks that were synced but no longer exist)
  //    We track this by checking vector_synced_at IS NOT NULL for all blocks,
  //    and comparing against what we'd expect. For now, we'll handle this by
  //    finding blocks with vector_synced_at that have been deleted.
  //    Actually, deleted blocks won't be in the DB at all, so we need
  //    a different approach: maintain a list, or just let Pinecone hold stale data
  //    and clean on explicit sync.
  //    For simplicity: on full sync, we query all synced block IDs and compare.
  const allSyncedBlockIds = db.prepare(`
    SELECT id FROM blocks WHERE user_id = ? AND vector_synced_at IS NOT NULL
  `).all(userId) as { id: string }[];
  const allBlockIds = db.prepare(`
    SELECT id FROM blocks WHERE user_id = ? AND content != ''
  `).all(userId) as { id: string }[];
  const blockIdSet = new Set(allBlockIds.map((b) => b.id));
  const deletedBlockIds = allSyncedBlockIds
    .map((b) => b.id)
    .filter((id) => !blockIdSet.has(id));

  // 3. Get all pages for path resolution
  const pages = db.prepare("SELECT id, name, parent_id FROM pages WHERE user_id = ?").all(userId) as PageRow[];

  // 4. Group changed blocks by page_id or date for context building
  const groups = new Map<string, BlockRow[]>();
  for (const block of changedBlocks) {
    const key = block.page_id || `date:${block.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(block);
  }

  // For each group, we need ALL blocks in that group (not just changed ones) for context
  const allChunks: EmbeddingChunk[] = [];

  for (const [key, changedInGroup] of groups) {
    let allBlocksInGroup: BlockRow[];
    let pagePath = "";

    if (key.startsWith("date:")) {
      const date = key.slice(5);
      allBlocksInGroup = db.prepare(
        "SELECT * FROM blocks WHERE user_id = ? AND date = ? AND page_id IS NULL ORDER BY sort_order"
      ).all(userId, date) as BlockRow[];
    } else {
      const pageId = key;
      allBlocksInGroup = db.prepare(
        "SELECT * FROM blocks WHERE user_id = ? AND page_id = ? ORDER BY sort_order"
      ).all(userId, pageId) as BlockRow[];
      pagePath = buildPagePath(pageId, pages);
    }

    // Create chunks only for changed blocks, but use full group for context
    for (const block of changedInGroup) {
      try {
        const chunks = createEmbeddingChunks(block, allBlocksInGroup, pagePath);
        allChunks.push(...chunks);
      } catch (e: any) {
        errors.push(`Chunk error for block ${block.id}: ${e.message}`);
      }
    }
  }

  // 5. Embed all chunks
  let embeddedCount = 0;
  if (allChunks.length > 0) {
    try {
      const texts = allChunks.map((c) => c.text);
      const embeddings = await embedTexts(texts);

      // 6. Upsert to Pinecone
      await upsertVectors(allChunks, embeddings);
      embeddedCount = allChunks.length;

      // 7. Update vector_synced_at for processed blocks
      const now = new Date().toISOString();
      const updateStmt = db.prepare("UPDATE blocks SET vector_synced_at = ? WHERE id = ?");
      const blockIdsProcessed = new Set(allChunks.map((c) => c.metadata.block_id));
      for (const blockId of blockIdsProcessed) {
        updateStmt.run(now, blockId);
      }
    } catch (e: any) {
      errors.push(`Embedding/upsert error: ${e.message}`);
    }
  }

  // 8. Delete vectors for removed blocks
  let deletedCount = 0;
  if (deletedBlockIds.length > 0) {
    try {
      await deleteVectorsByBlockIds(deletedBlockIds);
      deletedCount = deletedBlockIds.length;
      // Clear vector_synced_at for deleted blocks (they're gone from DB anyway)
    } catch (e: any) {
      errors.push(`Delete error: ${e.message}`);
    }
  }

  return { embedded: embeddedCount, deleted: deletedCount, errors };
}

// ─── Daily usage tracking ───────────────────────────────────────

export function incrementUsage(userId: string, endpoint: string): number {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];

  db.prepare(`
    INSERT INTO ai_usage (id, user_id, date, endpoint, count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(user_id, date, endpoint)
    DO UPDATE SET count = count + 1
  `).run(crypto.randomUUID(), userId, today, endpoint);

  const row = db.prepare(
    "SELECT count FROM ai_usage WHERE user_id = ? AND date = ? AND endpoint = ?"
  ).get(userId, today, endpoint) as { count: number } | undefined;

  return row?.count || 0;
}

export function getUsageCount(userId: string, endpoint: string): number {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const row = db.prepare(
    "SELECT count FROM ai_usage WHERE user_id = ? AND date = ? AND endpoint = ?"
  ).get(userId, today, endpoint) as { count: number } | undefined;
  return row?.count || 0;
}

const DAILY_LIMITS: Record<string, number> = {
  chat: 500,
  generate: 500,
  sync: 50,
};

export function checkDailyLimit(userId: string, endpoint: string): boolean {
  const limit = DAILY_LIMITS[endpoint] || 500;
  const current = getUsageCount(userId, endpoint);
  return current < limit;
}
