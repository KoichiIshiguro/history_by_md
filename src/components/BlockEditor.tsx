"use client";

import React, {
  useState, useEffect, useCallback, useRef, KeyboardEvent, useMemo,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  DragStartEvent, DragEndEvent,
} from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { normalizeActionDate, todayISO } from "@/lib/actionDate";

// Load mermaid dynamically from CDN to avoid 291MB npm dependency
let mermaidLoaded = false;
let mermaidLoadPromise: Promise<void> | null = null;
function loadMermaid(): Promise<void> {
  if (mermaidLoaded) return Promise.resolve();
  if (mermaidLoadPromise) return mermaidLoadPromise;
  mermaidLoadPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") { resolve(); return; }
    const existing = document.querySelector('script[src*="mermaid"]');
    if (existing) { mermaidLoaded = true; resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.onload = () => {
      (window as any).mermaid?.initialize({ startOnLoad: false, theme: "default" });
      mermaidLoaded = true;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return mermaidLoadPromise;
}

interface Block {
  id: string;
  content: string;
  indent_level: number;
  sort_order: number;
  date: string;
  page_id?: string | null;
  source_page_name?: string;
  source_page_id?: string;
  /**
   * Server-acknowledged version. Bumped on every server-side UPDATE.
   * Undefined for blocks that exist only client-side (not yet sent).
   */
  version?: number;
}

/**
 * Per-block snapshot from the last server interaction (initial fetch +
 * each successful patch). Used to compute diffs for the next patch save.
 * Without this we can't tell which blocks the client actually modified
 * vs blocks that were just re-rendered, which makes per-block
 * conflict-detection moot.
 */
interface BlockSnapshot {
  content: string;
  indent_level: number;
  sort_order: number;
  version: number;
}

/**
 * Server-side block state returned alongside a conflict result. Shown to
 * the user so they can pick "mine" / "theirs" / "both".
 */
interface BlockConflict {
  id: string;
  serverContent: string;
  serverIndent: number;
  serverSortOrder: number;
  serverVersion: number;
  /** What the client tried to save when the conflict happened. */
  localContent: string;
  localIndent: number;
}

/**
 * Parse leading indentation from a pasted line.
 *
 * Rules:
 *   - 1 tab         = 1 indent level
 *   - 4 spaces      = 1 indent level
 *   - Mixed is OK; leading whitespace is counted left-to-right, the
 *     remainder (<4 trailing spaces) is discarded so "pretty-printed"
 *     markdown/code pastes round down cleanly.
 *
 * Returns { indent, content } where content has the leading whitespace stripped.
 */
function parseLeadingIndent(line: string): { indent: number; content: string } {
  const m = line.match(/^([\t ]*)/);
  const ws = m?.[1] || "";
  let indent = 0;
  let spaceRun = 0;
  for (const ch of ws) {
    if (ch === "\t") {
      indent += 1 + Math.floor(spaceRun / 4);
      spaceRun = 0;
    } else {
      spaceRun += 1;
    }
  }
  indent += Math.floor(spaceRun / 4);
  return { indent, content: line.slice(ws.length) };
}

export interface PageInfo { id: string; name: string; parent_id?: string | null; ref_count?: number; full_path?: string; }
export interface TagInfo { id: string; name: string; block_count?: number; }
export interface Template { id: string; name: string; content: string; }
export interface MeetingInfo { id: string; title: string; meeting_date: string; status: string; }

interface Props {
  viewMode: "date" | "page" | "tag" | "admin" | "actions" | "meeting";
  selectedDate: string;
  selectedPageId: string | null;
  selectedPageName: string;
  selectedTagId: string | null;
  selectedTagName: string;
  selectedMeetingId?: string | null;
  allPages: PageInfo[];
  allTags: TagInfo[];
  allMeetings?: MeetingInfo[];
  onPageClick: (pageId: string, pageName: string) => void;
  onTagClick: (tagId: string, tagName: string) => void;
  onDateClick: (date: string) => void;
  onMeetingClick?: (meetingId: string) => void;
  onDataChange: () => void;
  actionVersion?: number;
}

// Pre-process custom syntax into HTML spans before markdown rendering
export function preprocessCustomSyntax(content: string, allPages: PageInfo[], allTags: TagInfo[], allMeetings?: MeetingInfo[]): string {
  let result = content;

  // @YYYYMMDD/title → meeting link span
  // Title can contain any non-whitespace chars up to end-of-word/line
  result = result.replace(/@(\d{8})\/([^\s]+)/g, (_match, ymd: string, title: string) => {
    const y = ymd.slice(0, 4), m = ymd.slice(4, 6), d = ymd.slice(6, 8);
    const date = `${y}-${m}-${d}`;
    // Try to resolve to an actual meeting ID if we have the list
    let meetingId = "";
    if (allMeetings) {
      const match = allMeetings.find((mt) => mt.meeting_date === date && mt.title === title);
      if (match) meetingId = match.id;
    }
    return `<span class="meeting-link" data-meeting-id="${meetingId}" data-meeting-date="${date}" data-meeting-title="${title}">📝 ${ymd}/${title}</span>`;
  });

  // {{page/path}} → HTML span
  result = result.replace(/\{\{([^}]+)\}\}/g, (_match, pageName: string) => {
    const trimmed = pageName.trim();
    // Match by full_path first, then by name for backwards compat
    const page = allPages.find((p) => p.full_path === trimmed) || allPages.find((p) => p.name === trimmed);
    const dataId = page ? page.id : "";
    return `<span class="page-link" data-page-id="${dataId}" data-page-name="${trimmed}">${trimmed}</span>`;
  });

  // !action / !done prefix (optionally with @-date spec) → styled span + inline date pill
  const renderActionPrefix = (kind: "action" | "done", spec: string | undefined) => {
    const dot = `<span class="action-flag action-${kind === "done" ? "done" : "open"}">\u25CF</span>`;
    if (spec) {
      // spec is like "4/17-29" or "2026/4/17-2026/6/1" — show as a small pill
      return `${dot} <span class="action-date-pill">📅 ${spec}</span> `;
    }
    return `${dot} `;
  };
  result = result.replace(/^!(action|done)(?:@(\S+))?\s/i, (_m, kind: string, spec?: string) =>
    renderActionPrefix(kind.toLowerCase() as "action" | "done", spec)
  );

  // #tag → HTML span (but not inside code blocks or HTML tags)
  result = result.replace(/(^|[^&\w])#([^\s#{}()<>]+)/g, (_match, prefix: string, tagName: string) => {
    const tag = allTags.find((t) => t.name === tagName);
    const dataId = tag ? tag.id : "";
    return `${prefix}<span class="tag-inline" data-tag-id="${dataId}" data-tag-name="${tagName}">#${tagName}</span>`;
  });

  // [[date]] → HTML span
  result = result.replace(/\[\[(\d{4}-\d{2}-\d{2})\]\]/g, (_match, date: string) => {
    return `<span class="date-link" data-date="${date}">${date}</span>`;
  });

  return result;
}

// Mermaid rendering component (CDN loaded)
function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    (async () => {
      try {
        await loadMermaid();
        const m = (window as any).mermaid;
        if (!m || cancelled) return;
        const { svg } = await m.render(idRef.current, chart);
        if (!cancelled && el) el.innerHTML = svg;
      } catch {
        if (!cancelled && el) el.innerHTML = `<pre class="text-red-500 text-xs">Mermaid rendering error</pre>`;
      }
    })();
    return () => { cancelled = true; };
  }, [chart]);

  return <div ref={containerRef} className="my-2 overflow-auto" />;
}

// Markdown content renderer with GFM + custom syntax
export function MarkdownContent({
  content, allPages, allTags, allMeetings, onPageClick, onTagClick, onDateClick,
}: {
  content: string;
  allPages: PageInfo[];
  allTags: TagInfo[];
  allMeetings?: MeetingInfo[];
  onPageClick: (id: string, name: string) => void;
  onTagClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
}) {
  const processed = useMemo(() => preprocessCustomSyntax(content, allPages, allTags, allMeetings), [content, allPages, allTags, allMeetings]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      components={{
        // Mermaid code blocks
        code({ className, children, ...props }) {
          const match = /language-mermaid/.exec(className || "");
          const codeStr = String(children).replace(/\n$/, "");
          if (match) {
            return <MermaidDiagram chart={codeStr} />;
          }
          // Inline code vs code blocks
          const isBlock = className || codeStr.includes("\n");
          if (isBlock) {
            return (
              <code className={`${className || ""} block-code`} {...props}>
                {children}
              </code>
            );
          }
          return <code className="md-code" {...props}>{children}</code>;
        },
        pre({ children }) {
          return <pre className="gfm-pre">{children}</pre>;
        },
        // Tables
        table({ children }) {
          return <table className="gfm-table">{children}</table>;
        },
        th({ children }) {
          return <th className="gfm-th">{children}</th>;
        },
        td({ children }) {
          return <td className="gfm-td">{children}</td>;
        },
        // Task list items
        li({ children, ...props }) {
          const inputChild = React.Children.toArray(children).find(
            (child) => React.isValidElement(child) && (child as React.ReactElement<{ type?: string }>).props.type === "checkbox"
          );
          if (inputChild) {
            return <li className="gfm-task-item" {...props}>{children}</li>;
          }
          return <li {...props}>{children}</li>;
        },
        input({ checked, ...props }) {
          return <input type="checkbox" checked={checked} readOnly className="gfm-checkbox" {...props} />;
        },
        // Strikethrough
        del({ children }) {
          return <del className="gfm-strikethrough">{children}</del>;
        },
        // Headings
        h1({ children }) { return <span className="md-heading-1">{children}</span>; },
        h2({ children }) { return <span className="md-heading-2">{children}</span>; },
        h3({ children }) { return <span className="md-heading-3">{children}</span>; },
        h4({ children }) { return <span className="md-heading-4">{children}</span>; },
        // Paragraph — render inline to avoid extra spacing in block editor
        p({ children }) { return <span>{children}</span>; },
        // Blockquote
        blockquote({ children }) {
          return <blockquote className="gfm-blockquote">{children}</blockquote>;
        },
        // Links
        a({ href, children }) {
          return <a href={href} target="_blank" rel="noopener noreferrer" className="gfm-link">{children}</a>;
        },
        // Images
        img({ src, alt }) {
          return <img src={src} alt={alt || ""} className="gfm-img" />;
        },
        // Horizontal rule
        hr() {
          return <hr className="gfm-hr" />;
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}

function BlockEditorInner({
  viewMode, selectedDate, selectedPageId, selectedPageName,
  selectedTagId, selectedTagName, selectedMeetingId, allPages, allTags, allMeetings,
  onPageClick, onTagClick, onDateClick, onMeetingClick, onDataChange, actionVersion,
}: Props) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [pageRefs, setPageRefs] = useState<Block[]>([]);
  // Optimistic concurrency: server returns MAX(updated_at) for the current
  // scope; we echo it back on save. Null means "no version yet" (empty scope).
  const [lastVersion, setLastVersion] = useState<string | null>(null);
  const lastVersionRef = useRef<string | null>(null);
  lastVersionRef.current = lastVersion;
  // Conflict modal state: holds just the text the user was editing (not the
  // whole scope). If there was no active edit, text is "" and we just refetch.
  const [conflict, setConflict] = useState<{ text: string; manualCopyNeeded?: boolean } | null>(null);
  /**
   * Per-block conflict map (new patch-based path). When a block-level
   * baseVersion mismatch comes back from /api/blocks/patch, we stash the
   * server state here and render an inline resolution card above the
   * affected block. Independent block edits stay un-conflicted, so this
   * only surfaces when two devices edited the SAME block.
   */
  const [blockConflicts, setBlockConflicts] = useState<Map<string, BlockConflict>>(new Map());
  /**
   * Snapshot of last server-acked state per block, used to diff for the
   * next patch. Populated by fetchBlocks() and after each successful save.
   */
  const snapshotRef = useRef<Map<string, BlockSnapshot>>(new Map());
  /**
   * "Did the initial fetch complete for the current scope?" guard.
   *
   * Without this, a stale tab whose `selectedDate` flips to "today" can
   * fire a debounced save with empty `blocks` BEFORE the fetch resolves —
   * which (under the old bulk-save endpoint) would write [] over real
   * server data and silently wipe everything. The new patch endpoint
   * already won't delete blocks the client doesn't know about, but a
   * naïve "blocks=[] + snapshot=empty" save still produces zero ops which
   * is harmless — yet we want belt-and-suspenders here so future code
   * paths can't accidentally regress this.
   */
  const snapshotLoadedRef = useRef(false);
  const [dateRefs, setDateRefs] = useState<Block[]>([]);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<{ type: "tag" | "page" | "template"; items: { id: string; name: string; content?: string }[] }>({ type: "tag", items: [] });
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
  const [editingPageTitle, setEditingPageTitle] = useState(false);
  const [pageTitleDraft, setPageTitleDraft] = useState("");
  const [backlinksOpen, setBacklinksOpen] = useState(true);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const shiftHeldRef = useRef(false);
  const skipMouseUpRef = useRef(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [aiGenerating, setAiGenerating] = useState<string | null>(null); // block ID being generated
  const [aiResult, setAiResult] = useState<{ blockId: string; text: string } | null>(null);
  const [addingChildPage, setAddingChildPage] = useState(false);
  const [newChildPageName, setNewChildPageName] = useState("");
  const undoStackRef = useRef<Block[][]>([]);
  const redoStackRef = useRef<Block[][]>([]);
  const editStartedAtRef = useRef<number>(0);

  // Keep refs in sync with latest state to avoid stale closures in setTimeout callbacks
  const editContentRef = useRef(editContent);
  editContentRef.current = editContent;
  const editingBlockIdRef = useRef(editingBlockId);
  editingBlockIdRef.current = editingBlockId;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const pageRefsRef = useRef(pageRefs);
  pageRefsRef.current = pageRefs;
  const dateRefsRef = useRef(dateRefs);
  dateRefsRef.current = dateRefs;

  useEffect(() => {
    fetch("/api/templates").then((r) => r.ok ? r.json() : []).then(setTemplates).catch(() => {});
  }, []);

  // Request-ID guard: when the user switches scopes quickly, multiple
  // fetchBlocks calls can be in flight. If a stale (older) response resolves
  // AFTER a newer one, it would overwrite the current view with the previous
  // page's data. We tag each request with an incrementing ID and ignore any
  // response whose ID is no longer the latest.
  const fetchReqIdRef = useRef(0);

  const fetchBlocks = useCallback(async () => {
    const myReqId = ++fetchReqIdRef.current;
    setLoading(true);
    let url = "/api/blocks";
    if (viewMode === "meeting" && selectedMeetingId) {
      url += `?meetingId=${selectedMeetingId}`;
    } else if (viewMode === "page" && selectedPageId) {
      url += `?pageId=${selectedPageId}`;
    } else if (viewMode === "tag" && selectedTagId) {
      url += `?tagId=${selectedTagId}`;
    } else {
      url += `?date=${selectedDate}`;
    }

    /**
     * Merge incoming server blocks against current state without clobbering
     * unsaved local edits. Strategy:
     *   - For a block that is currently being edited by the user
     *     (editingBlockIdRef matches its id) → keep the local copy.
     *   - For a block that has an unresolved conflict → keep the local copy
     *     (the conflict card needs the local content to compare against).
     *   - Otherwise → take the server version.
     * Snapshot is rebuilt fresh from server (it represents server-acked
     * state, not local edits).
     */
    const mergeWithLocal = (serverBlocks: Block[]): Block[] => {
      const localBlocks = blocksRef.current;
      const editingId = editingBlockIdRef.current;
      const conflictIds = new Set(blockConflicts.keys());
      const localById = new Map(localBlocks.map((b) => [b.id, b]));
      return serverBlocks.map((sb) => {
        if (sb.id === editingId || conflictIds.has(sb.id)) {
          const local = localById.get(sb.id);
          if (local) return { ...local, version: sb.version };
        }
        return sb;
      });
    };

    const buildSnapshot = (serverBlocks: Block[]) => {
      const snap = new Map<string, BlockSnapshot>();
      serverBlocks.forEach((b, i) => {
        snap.set(b.id, {
          content: b.content,
          indent_level: b.indent_level,
          sort_order: typeof b.sort_order === "number" ? b.sort_order : i,
          version: b.version ?? 1,
        });
      });
      snapshotRef.current = snap;
      snapshotLoadedRef.current = true;
    };

    try {
      const res = await fetch(url);
      if (myReqId !== fetchReqIdRef.current) return; // a newer request superseded us
      if (res.ok) {
        const data = await res.json();
        if (myReqId !== fetchReqIdRef.current) return; // re-check after JSON parse
        if ((viewMode === "page" || viewMode === "meeting") && data.pageBlocks !== undefined) {
          const serverBlocks = data.pageBlocks as Block[];
          buildSnapshot(serverBlocks);
          setBlocks(mergeWithLocal(serverBlocks));
          setPageRefs(data.pageRefs || []);
          setDateRefs(data.dateRefs || []);
          setLastVersion(data.version ?? null);
        } else if (viewMode === "tag") {
          setBlocks(data);
          setPageRefs([]);
          setDateRefs([]);
          setLastVersion(null);
          snapshotRef.current = new Map(); // tag view doesn't use patch saves
          snapshotLoadedRef.current = true;
        } else {
          let serverBlocks: Block[] = [];
          if (Array.isArray(data)) {
            serverBlocks = data as Block[];
            setLastVersion(null);
          } else {
            serverBlocks = (data.pageBlocks || []) as Block[];
            setLastVersion(data.version ?? null);
          }
          buildSnapshot(serverBlocks);
          setBlocks(mergeWithLocal(serverBlocks));
          setPageRefs([]);
          setDateRefs([]);
        }
      }
    } finally {
      // Only the LATEST request is allowed to clear the loading flag,
      // otherwise a stale "done" would briefly hide the spinner while the
      // newer request is still in flight.
      if (myReqId === fetchReqIdRef.current) setLoading(false);
    }
  }, [viewMode, selectedDate, selectedPageId, selectedTagId, selectedMeetingId, blockConflicts]);

  useEffect(() => { fetchBlocks(); }, [fetchBlocks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear stale per-block conflicts when the scope changes (otherwise a
  // banner from page A would surface on page B if a block id collides).
  // Also drop the "loaded" flag so saves can't fire against the new scope
  // until fetchBlocks confirms what's actually there.
  useEffect(() => {
    setBlockConflicts(new Map());
    snapshotLoadedRef.current = false;
    snapshotRef.current = new Map();
  }, [viewMode, selectedDate, selectedPageId, selectedMeetingId]);

  // Re-fetch blocks when actions are toggled in ActionList
  useEffect(() => {
    if (actionVersion && actionVersion > 0) { fetchBlocks(); }
  }, [actionVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Conflict resolution actions.
   *
   *   - keepLocal:   user wants their version. We've already synced
   *                  snapshot to server's version, so the next save will
   *                  send the local content as an upsert with the server's
   *                  baseVersion → succeed and overwrite the server.
   *   - takeServer:  replace the local block with the server's content.
   *   - keepBoth:    insert a new block right after, copy server's content
   *                  there, keep local in the original position. Both end
   *                  up persisted.
   * In all three cases the conflict entry is cleared from blockConflicts.
   */
  const resolveConflictKeepLocal = useCallback((id: string) => {
    setBlockConflicts((prev) => {
      const m = new Map(prev); m.delete(id); return m;
    });
    // Trigger a save so the local content reaches the server (snapshot is
    // already synced to the conflict's server version, so this will succeed).
    debouncedSaveRef.current?.(blocksRef.current);
  }, []);

  const resolveConflictTakeServer = useCallback((id: string) => {
    setBlockConflicts((prev) => {
      const m = new Map(prev);
      const conflict = m.get(id);
      m.delete(id);
      if (conflict) {
        const updated = blocksRef.current.map((b) =>
          b.id === id ? { ...b, content: conflict.serverContent, indent_level: conflict.serverIndent } : b
        );
        setBlocks(updated);
      }
      return m;
    });
  }, []);

  const resolveConflictKeepBoth = useCallback((id: string) => {
    setBlockConflicts((prev) => {
      const m = new Map(prev);
      const conflict = m.get(id);
      m.delete(id);
      if (conflict) {
        const idx = blocksRef.current.findIndex((b) => b.id === id);
        if (idx >= 0) {
          const newBlock: Block = {
            id: crypto.randomUUID(),
            content: conflict.serverContent,
            indent_level: conflict.serverIndent,
            sort_order: idx + 1,
            date: blocksRef.current[idx].date,
            page_id: blocksRef.current[idx].page_id,
          };
          const updated = [...blocksRef.current];
          updated.splice(idx + 1, 0, newBlock);
          const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
          setBlocks(reordered);
          debouncedSaveRef.current?.(reordered);
        }
      }
      return m;
    });
  }, []);

  // Forward-declared ref to debouncedSave (defined below) so resolution
  // helpers can re-trigger a save without circular hook deps.
  const debouncedSaveRef = useRef<((blocks: Block[]) => void) | null>(null);

  /**
   * Patch-based save with per-block optimistic concurrency.
   *
   * Diffs `updatedBlocks` against `snapshotRef.current` to build the
   * minimum set of upsert/delete ops, then sends them to /api/blocks/patch.
   * Per-op results:
   *   - applied   → bump that block's snapshot to the new version
   *   - deleted   → drop from snapshot
   *   - conflict  → push into blockConflicts; the inline UI lets the user
   *                 pick mine / theirs / both. Local block stays put so
   *                 nothing is lost; snapshot syncs to server's version so
   *                 subsequent saves don't keep colliding.
   *
   * Tag view stays on per-block PUT (no scope concept there).
   */
  const saveBlocks = useCallback(async (updatedBlocks: Block[]) => {
    // Guard: never save before the initial fetch resolves for this scope.
    // Otherwise a stale tab that flipped to a new date can save [] and
    // overwrite real server data. (Real-world repro: PC left open
    // overnight, mobile edits "today", PC's `selectedDate` flips at
    // wakeup, debounced save fires before fetch — bye, day of work.)
    if (!snapshotLoadedRef.current) return;

    if (viewMode === "tag") {
      for (const block of updatedBlocks) {
        await fetch("/api/blocks", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: block.id, content: block.content, indent_level: block.indent_level, sort_order: block.sort_order }),
        });
      }
      return;
    }

    type PatchScope = { kind: "date" | "page" | "meeting"; key: string };
    let scope: PatchScope;
    if (viewMode === "meeting" && selectedMeetingId) scope = { kind: "meeting", key: selectedMeetingId };
    else if (viewMode === "page" && selectedPageId) scope = { kind: "page", key: selectedPageId };
    else scope = { kind: "date", key: selectedDate };

    const snapshot = snapshotRef.current;
    const currentIds = new Set(updatedBlocks.map((b) => b.id));

    type UpsertOp = { op: "upsert"; id: string; content: string; indent_level: number; sort_order: number; baseVersion: number | null };
    type DeleteOp = { op: "delete"; id: string; baseVersion: number };
    const ops: Array<UpsertOp | DeleteOp> = [];

    // Build upserts: only blocks that differ from snapshot. Skip blocks
    // currently in conflict — the user must resolve those manually first
    // (otherwise we'd just keep colliding on every debounce tick).
    updatedBlocks.forEach((b, idx) => {
      if (blockConflicts.has(b.id)) return;
      const sort_order = idx;
      const snap = snapshot.get(b.id);
      if (!snap) {
        ops.push({ op: "upsert", id: b.id, content: b.content, indent_level: b.indent_level, sort_order, baseVersion: null });
      } else if (snap.content !== b.content || snap.indent_level !== b.indent_level || snap.sort_order !== sort_order) {
        ops.push({ op: "upsert", id: b.id, content: b.content, indent_level: b.indent_level, sort_order, baseVersion: snap.version });
      }
    });

    // Build deletes: blocks that were in the snapshot but not in current state
    for (const [id, snap] of snapshot) {
      if (!currentIds.has(id)) {
        ops.push({ op: "delete", id, baseVersion: snap.version });
      }
    }

    if (ops.length === 0) return;

    let res: Response | null = null;
    try {
      res = await fetch("/api/blocks/patch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, ops }),
      });
    } catch {
      return; // network error — keep snapshot, retry next tick
    }
    if (!res.ok) return;

    type PatchResult =
      | { id: string; status: "applied"; version: number }
      | { id: string; status: "deleted" }
      | { id: string; status: "conflict"; server: { content: string; indent_level: number; sort_order: number; version: number; due_start: string | null; due_end: string | null } | null };
    const data = await res.json() as { results: PatchResult[]; scopeVersion: string | null };

    // Reconcile snapshot + conflicts based on results
    const newSnapshot = new Map(snapshot);
    const newConflicts = new Map<string, BlockConflict>();
    for (const r of data.results) {
      const localIdx = updatedBlocks.findIndex((b) => b.id === r.id);
      const local = localIdx >= 0 ? updatedBlocks[localIdx] : null;
      if (r.status === "applied" && local) {
        newSnapshot.set(r.id, {
          content: local.content,
          indent_level: local.indent_level,
          sort_order: localIdx,
          version: r.version,
        });
      } else if (r.status === "deleted") {
        newSnapshot.delete(r.id);
      } else if (r.status === "conflict") {
        if (r.server) {
          newConflicts.set(r.id, {
            id: r.id,
            serverContent: r.server.content,
            serverIndent: r.server.indent_level,
            serverSortOrder: r.server.sort_order,
            serverVersion: r.server.version,
            localContent: local?.content || "",
            localIndent: local?.indent_level ?? 0,
          });
          // Re-stamp snapshot to server's version so subsequent ops carry
          // the right baseVersion. Local block content stays in `blocks`
          // state until the user resolves the conflict.
          newSnapshot.set(r.id, {
            content: r.server.content,
            indent_level: r.server.indent_level,
            sort_order: r.server.sort_order,
            version: r.server.version,
          });
        } else {
          // Block was deleted on the server while we were editing it.
          // Drop from snapshot; local copy stays as-is (next save will
          // re-insert it as a new block).
          newSnapshot.delete(r.id);
        }
      }
    }
    snapshotRef.current = newSnapshot;
    if (newConflicts.size > 0) {
      setBlockConflicts((prev) => {
        const merged = new Map(prev);
        for (const [k, v] of newConflicts) merged.set(k, v);
        return merged;
      });
    }
    if (data.scopeVersion !== undefined) setLastVersion(data.scopeVersion ?? null);

    // Sidebar notifications
    const hasTags = updatedBlocks.some((b) => /#[^\s#]+/.test(b.content));
    const hasActions = updatedBlocks.some((b) => /^!(action|done)(@\S+)?\s/i.test(b.content));
    if (hasTags) window.dispatchEvent(new Event("tags-changed"));
    if (hasActions) window.dispatchEvent(new Event("actions-changed"));
  }, [viewMode, selectedDate, selectedPageId, selectedMeetingId, blockConflicts]);

  const debouncedSave = useCallback((updatedBlocks: Block[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => saveBlocks(updatedBlocks), 800);
  }, [saveBlocks]);
  // Keep the ref in sync so conflict resolvers (defined above) can call
  // through to the latest closure without a circular dependency.
  debouncedSaveRef.current = debouncedSave;

  const refSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedRefSave = useCallback((block: Block) => {
    if (refSaveTimeoutRef.current) clearTimeout(refSaveTimeoutRef.current);
    refSaveTimeoutRef.current = setTimeout(async () => {
      await fetch("/api/blocks", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: block.id, content: block.content, indent_level: block.indent_level, sort_order: block.sort_order }),
      });
    }, 800);
  }, []);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(blocks.map((b) => ({ ...b })));
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, [blocks]);

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const snapshot = undoStackRef.current.pop()!;
    redoStackRef.current.push(blocks.map((b) => ({ ...b })));
    if (redoStackRef.current.length > 50) redoStackRef.current.shift();
    setBlocks(snapshot);
    setEditingBlockId(null);
    setShowSuggestions(false);
    debouncedSave(snapshot);
  }, [blocks, debouncedSave]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const snapshot = redoStackRef.current.pop()!;
    undoStackRef.current.push(blocks.map((b) => ({ ...b })));
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    setBlocks(snapshot);
    setEditingBlockId(null);
    setShowSuggestions(false);
    debouncedSave(snapshot);
  }, [blocks, debouncedSave]);

  const clearSelection = useCallback(() => { setSelectedBlockIds(new Set()); setSelectionAnchor(null); }, []);

  const selectRange = useCallback((from: number, to: number) => {
    const start = Math.min(from, to), end = Math.max(from, to);
    const ids = new Set<string>();
    for (let i = start; i <= end; i++) if (blocks[i]) ids.add(blocks[i].id);
    setSelectedBlockIds(ids);
  }, [blocks]);

  const deleteSelectedBlocks = useCallback(() => {
    if (selectedBlockIds.size === 0) return;
    pushUndo();
    const remaining = blocks.filter((b) => !selectedBlockIds.has(b.id));
    if (remaining.length === 0) {
      const newBlock: Block = { id: crypto.randomUUID(), content: "", indent_level: 0, sort_order: 0, date: viewMode === "page" ? "" : selectedDate };
      setBlocks([newBlock]); clearSelection();
      setEditingBlockId(newBlock.id); setEditContent("");
      setTimeout(() => { inputRefs.current.get(newBlock.id)?.focus(); }, 0);
      debouncedSave([newBlock]); return;
    }
    const reordered = remaining.map((b, i) => ({ ...b, sort_order: i }));
    setBlocks(reordered); clearSelection(); debouncedSave(reordered);
  }, [blocks, selectedBlockIds, selectedDate, viewMode, clearSelection, debouncedSave, pushUndo]);

  const indentSelectedBlocks = useCallback((outdent: boolean) => {
    if (selectedBlockIds.size === 0) return;
    pushUndo();
    const updated = blocks.map((b) =>
      selectedBlockIds.has(b.id)
        ? { ...b, indent_level: outdent ? Math.max(0, b.indent_level - 1) : b.indent_level + 1 }
        : b
    );
    setBlocks(updated);
    debouncedSave(updated);
  }, [blocks, selectedBlockIds, pushUndo, debouncedSave]);

  const copySelectedBlocks = useCallback(async (cut: boolean) => {
    if (selectedBlockIds.size === 0) return;
    const texts = blocks.filter((b) => selectedBlockIds.has(b.id)).map((b) => "  ".repeat(b.indent_level) + b.content);
    await navigator.clipboard.writeText(texts.join("\n"));
    if (cut) deleteSelectedBlocks();
  }, [blocks, selectedBlockIds, deleteSelectedBlocks]);

  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const meta = e.metaKey || e.ctrlKey;
    // Undo/redo works regardless of editing state
    if (meta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (meta && e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); return; }
    if (editingBlockId) return;
    if (selectedBlockIds.size === 0) return;
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteSelectedBlocks(); return; }
    if (e.key === "Tab") { e.preventDefault(); indentSelectedBlocks(e.shiftKey); return; }
    if (meta && e.key === "c") { e.preventDefault(); copySelectedBlocks(false); return; }
    if (meta && e.key === "x") { e.preventDefault(); copySelectedBlocks(true); return; }
    if (meta && e.key === "v") {
      // Paste when blocks are selected (not editing) — replace selection with pasted lines
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (!text) return;
        pushUndo();
        const lines = text.split("\n");
        const firstSelectedIdx = blocks.findIndex((b) => selectedBlockIds.has(b.id));
        const remaining = blocks.filter((b) => !selectedBlockIds.has(b.id));
        const insertAt = firstSelectedIdx >= 0 ? firstSelectedIdx : remaining.length;
        const baseDate = viewMode === "page" ? "" : selectedDate;
        const newBlocks: Block[] = lines.map((line) => {
          const { indent, content } = parseLeadingIndent(line);
          return { id: crypto.randomUUID(), content, indent_level: indent, sort_order: 0, date: baseDate };
        });
        remaining.splice(insertAt, 0, ...newBlocks);
        const reordered = remaining.map((b, i) => ({ ...b, sort_order: i }));
        setBlocks(reordered); clearSelection(); debouncedSave(reordered);
        if (newBlocks.length > 0) {
          const lastNew = newBlocks[newBlocks.length - 1];
          setEditingBlockId(lastNew.id); setEditContent(lastNew.content);
          setTimeout(() => { const el = inputRefs.current.get(lastNew.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = lastNew.content.length; } }, 0);
        }
      }).catch(() => {});
      return;
    }
    if (meta && e.key === "a") { e.preventDefault(); setSelectedBlockIds(new Set(blocks.map((b) => b.id))); setSelectionAnchor(0); return; }
    if (e.key === "Escape") { clearSelection(); return; }
  }, [editingBlockId, selectedBlockIds, blocks, deleteSelectedBlocks, copySelectedBlocks, indentSelectedBlocks, clearSelection, undo, redo, pushUndo, viewMode, selectedDate, debouncedSave]);

  const toggleBlockSelected = useCallback((blockIndex: number) => {
    const b = blocks[blockIndex];
    if (!b) return;
    const next = new Set(selectedBlockIds);
    if (next.has(b.id)) next.delete(b.id);
    else next.add(b.id);
    setSelectedBlockIds(next);
    setSelectionAnchor(blockIndex);
  }, [blocks, selectedBlockIds]);

  const selectJustBlock = useCallback((blockIndex: number) => {
    const b = blocks[blockIndex];
    if (!b) return;
    if (editingBlockId) {
      const updated = blocks.map((x) => x.id === editingBlockId ? { ...x, content: editContent } : x);
      setBlocks(updated); debouncedSave(updated);
      setEditingBlockId(null); setShowSuggestions(false);
    }
    setSelectedBlockIds(new Set([b.id]));
    setSelectionAnchor(blockIndex);
    setTimeout(() => containerRef.current?.focus(), 0);
  }, [blocks, editingBlockId, editContent, debouncedSave]);

  const handleBlockMouseDown = useCallback((e: React.MouseEvent, blockIndex: number) => {
    // Cmd/Ctrl+Click: toggle this block in/out of the selection set
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      skipMouseUpRef.current = true;
      if (editingBlockId) {
        const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
        setBlocks(updated); debouncedSave(updated);
        setEditingBlockId(null); setShowSuggestions(false);
      }
      toggleBlockSelected(blockIndex);
      setTimeout(() => containerRef.current?.focus(), 0);
      return;
    }
    if (e.shiftKey && selectionAnchor !== null) {
      e.preventDefault();
      skipMouseUpRef.current = true;
      // Exit editing mode — save current content first
      if (editingBlockId) {
        const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
        setBlocks(updated);
        debouncedSave(updated);
        setEditingBlockId(null);
        setShowSuggestions(false);
      }
      selectRange(selectionAnchor, blockIndex);
      // Focus container so Delete/Ctrl+C etc. work
      setTimeout(() => containerRef.current?.focus(), 0);
      return;
    }
    if (!e.shiftKey) { clearSelection(); setSelectionAnchor(blockIndex); }
  }, [editingBlockId, editContent, blocks, selectionAnchor, selectRange, clearSelection, debouncedSave]);

  const autoResizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  const setInputRef = (id: string, el: HTMLTextAreaElement | null) => {
    if (el) {
      inputRefs.current.set(id, el);
      // Auto-resize on mount
      requestAnimationFrame(() => autoResizeTextarea(el));
    } else {
      inputRefs.current.delete(id);
    }
  };

  const focusBlock = (blockId: string, cursorPos?: number) => {
    setEditingBlockId(blockId);
    const block = blocks.find((b) => b.id === blockId);
    if (block) setEditContent(block.content);
    setTimeout(() => {
      const el = inputRefs.current.get(blockId);
      if (el) { el.focus(); if (cursorPos !== undefined) el.selectionStart = el.selectionEnd = cursorPos; }
    }, 0);
  };

  const startEditing = (block: Block) => {
    if (selectedBlockIds.size > 0) return;
    if (blurTimeoutRef.current) { clearTimeout(blurTimeoutRef.current); blurTimeoutRef.current = null; }
    // Push undo snapshot when starting to edit a new block
    const currentEditingId = editingBlockIdRef.current;
    const currentContent = editContentRef.current;
    if (!currentEditingId || currentEditingId !== block.id) pushUndo();
    // Save current editing block before switching (use refs for latest values)
    if (currentEditingId && currentEditingId !== block.id) {
      const currentPageRefs = pageRefsRef.current;
      const currentDateRefs = dateRefsRef.current;
      const currentBlocks = blocksRef.current;
      const refBlock = [...currentPageRefs, ...currentDateRefs].find((b) => b.id === currentEditingId);
      if (refBlock) {
        const updated = { ...refBlock, content: currentContent };
        setPageRefs(currentPageRefs.map((b) => b.id === currentEditingId ? updated : b));
        setDateRefs(currentDateRefs.map((b) => b.id === currentEditingId ? updated : b));
        debouncedRefSave(updated);
      } else {
        const updated = currentBlocks.map((b) => b.id === currentEditingId ? { ...b, content: currentContent } : b);
        setBlocks(updated);
        debouncedSave(updated);
      }
    }
    setEditingBlockId(block.id); setEditContent(block.content); setShowSuggestions(false);
    editStartedAtRef.current = Date.now();
    // Focus + place caret at end of content (default browser behavior puts
    // it at index 0, which surprises everyone — they expect to keep typing).
    setTimeout(() => {
      const el = inputRefs.current.get(block.id);
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.selectionStart = el.selectionEnd = len;
    }, 0);
  };

  const finishEditing = useCallback(() => {
    // Read from refs to always get latest values (avoids stale closures in setTimeout)
    const currentEditingId = editingBlockIdRef.current;
    const currentContent = editContentRef.current;
    const currentBlocks = blocksRef.current;
    const currentPageRefs = pageRefsRef.current;
    const currentDateRefs = dateRefsRef.current;

    if (!currentEditingId) return;
    // Ignore blur that fires immediately after entering edit mode (mobile keyboard layout shift)
    if (Date.now() - editStartedAtRef.current < 500) return;
    // Don't save during AI generation or when AI result is pending — the !ai content should not overwrite anything
    if (aiGenerating || aiResult) {
      setEditingBlockId(null); setShowSuggestions(false);
      return;
    }
    // Normalize any !action / !done date spec eagerly so the user sees
    // "@2026/04/03-2026/04/03" immediately after blur/Enter (not just in
    // the DB). Year-locking is safer the earlier it happens.
    const defaultDate =
      viewMode === "date" ? (selectedDate || todayISO()) : todayISO();
    const normalizedContent = normalizeActionDate(currentContent, defaultDate);
    if (normalizedContent !== currentContent) {
      setEditContent(normalizedContent);
    }

    const refBlock = [...currentPageRefs, ...currentDateRefs].find((b) => b.id === currentEditingId);
    if (refBlock) {
      const updated = { ...refBlock, content: normalizedContent };
      setPageRefs(currentPageRefs.map((b) => b.id === currentEditingId ? updated : b));
      setDateRefs(currentDateRefs.map((b) => b.id === currentEditingId ? updated : b));
      setEditingBlockId(null); setShowSuggestions(false);
      debouncedRefSave(updated); return;
    }
    // Create new object only for edited block — React.memo skips unchanged blocks
    const updated = currentBlocks.map((b) => b.id === currentEditingId ? { ...b, content: normalizedContent } : b);
    setBlocks(updated);
    debouncedSave(updated);
    setEditingBlockId(null); setShowSuggestions(false);
  }, [aiGenerating, aiResult, debouncedSave, debouncedRefSave, viewMode, selectedDate]);

  const handleContentChange = (value: string) => {
    // Strip newlines unless Shift is held (Shift+Enter = intentional newline)
    if (!shiftHeldRef.current) {
      value = value.replace(/\n/g, "");
    }
    setEditContent(value);
    const pageMatch = value.match(/\{\{([^}]*)$/);
    if (pageMatch) {
      const q = pageMatch[1].toLowerCase();
      // Match against full_path: each segment of the path is checked
      // Score: 0 = name exact, 1 = name starts-with, 2 = name includes, 3 = any segment includes, 4 = full_path includes
      const scored: { id: string; name: string; score: number }[] = [];
      for (const p of allPages) {
        const fp = (p.full_path || p.name).toLowerCase();
        const nm = p.name.toLowerCase();
        const segments = fp.split("/");
        let score = -1;
        if (nm === q) score = 0;
        else if (nm.startsWith(q)) score = 1;
        else if (nm.includes(q)) score = 2;
        else if (segments.some((s) => s.includes(q))) score = 3;
        else if (fp.includes(q)) score = 4;
        if (score >= 0) scored.push({ id: p.id, name: p.full_path || p.name, score });
      }
      scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
      const items = scored.slice(0, 10);
      setSuggestions({ type: "page", items }); setShowSuggestions(items.length > 0); setSelectedSuggestion(0);
      return;
    }
    const tagMatch = value.match(/#([^\s#{}]*)$/);
    if (tagMatch) {
      const q = tagMatch[1].toLowerCase();
      const items = allTags.filter((t) => t.name.toLowerCase().includes(q) && t.name.toLowerCase() !== q).slice(0, 5);
      setSuggestions({ type: "tag", items }); setShowSuggestions(items.length > 0); setSelectedSuggestion(0);
      return;
    }
    const templateMatch = value.match(/^!(?:template|t)\s*(.*)$/i);
    if (templateMatch) {
      const q = templateMatch[1].toLowerCase();
      const items = templates
        .filter((t) => t.name.toLowerCase().includes(q))
        .map((t) => ({ id: t.id, name: t.name, content: t.content }))
        .slice(0, 8);
      setSuggestions({ type: "template", items });
      setShowSuggestions(items.length > 0);
      setSelectedSuggestion(0);
      return;
    }
    setShowSuggestions(false);
  };

  const applySuggestion = (name: string) => {
    if (suggestions.type === "template") {
      const template = suggestions.items.find((t) => t.name === name);
      if (!template?.content) { setShowSuggestions(false); return; }
      pushUndo();
      const lines = template.content.split("\n");
      if (!editingBlockId) { setShowSuggestions(false); return; }
      const blockIndex = blocks.findIndex((b) => b.id === editingBlockId);
      if (blockIndex === -1) { setShowSuggestions(false); return; }
      const block = blocks[blockIndex];
      // First line replaces current block content
      const first = parseLeadingIndent(lines[0]);
      const firstContent = first.content;
      const firstIndent = block.indent_level + first.indent;
      const updated = blocks.map((b) => b.id === block.id ? { ...b, content: firstContent, indent_level: firstIndent } : b);
      // Remaining lines become new blocks
      const newBlocks: Block[] = [];
      for (let i = 1; i < lines.length; i++) {
        const parsed = parseLeadingIndent(lines[i]);
        newBlocks.push({
          id: crypto.randomUUID(),
          content: parsed.content,
          indent_level: block.indent_level + parsed.indent,
          sort_order: 0,
          date: block.date,
        });
      }
      if (newBlocks.length > 0) updated.splice(blockIndex + 1, 0, ...newBlocks);
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered);
      setEditContent(firstContent);
      setShowSuggestions(false);
      debouncedSave(reordered);
      return;
    }
    if (suggestions.type === "page") {
      const newContent = editContent.replace(/\{\{([^}]*)$/, `{{${name}}} `);
      setEditContent(newContent);
    } else {
      const newContent = editContent.replace(/#([^\s#{}]*)$/, `#${name} `);
      setEditContent(newContent);
    }
    setShowSuggestions(false);
  };

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>, block: Block, blockIndex: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text || !text.includes("\n")) return; // single line paste is handled natively
    e.preventDefault();
    pushUndo();
    const textarea = e.currentTarget;
    const cursorPos = textarea.selectionStart ?? 0;
    const selEnd = textarea.selectionEnd ?? cursorPos;
    const before = editContent.slice(0, cursorPos);
    const after = editContent.slice(selEnd);
    const lines = text.split("\n");
    // First line merges with content before cursor
    const firstContent = before + lines[0];
    // Last line merges with content after cursor
    const lastLineContent = lines[lines.length - 1] + after;

    if (lines.length === 1) {
      // Shouldn't reach here but just in case
      const newContent = firstContent + after;
      setEditContent(newContent);
      const updated = blocks.map((b) => b.id === block.id ? { ...b, content: newContent } : b);
      setBlocks(updated); debouncedSave(updated);
      return;
    }

    // Update current block with first line
    const updated = blocks.map((b) => b.id === block.id ? { ...b, content: firstContent } : b);

    // Create new blocks for middle + last lines. Middle lines respect
    // their leading-indent (4-spaces or tab-per-level); the last line
    // inherits its own leading-indent too, with trailing `after` appended.
    const newBlocks: Block[] = [];
    for (let i = 1; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      const { indent, content: stripped } = parseLeadingIndent(lines[i]);
      const content = isLast ? stripped + after : stripped;
      newBlocks.push({
        id: crypto.randomUUID(),
        content,
        indent_level: block.indent_level + indent,
        sort_order: 0,
        date: block.date,
      });
    }
    updated.splice(blockIndex + 1, 0, ...newBlocks);
    const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
    setBlocks(reordered);

    // Focus last new block at end of pasted content (before the "after" text)
    const lastBlock = newBlocks[newBlocks.length - 1];
    const { content: lastStripped } = parseLeadingIndent(lines[lines.length - 1]);
    const cursorAt = lastStripped.length;
    setEditingBlockId(lastBlock.id);
    setEditContent(lastBlock.content);
    setTimeout(() => { const el = inputRefs.current.get(lastBlock.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorAt; } }, 0);
    debouncedSave(reordered);
  }, [blocks, editContent, pushUndo, debouncedSave]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, block: Block, blockIndex: number) => {
    if (e.key === "Shift") shiftHeldRef.current = true;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (showSuggestions) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedSuggestion((p) => Math.min(p + 1, suggestions.items.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedSuggestion((p) => Math.max(p - 1, 0)); return; }
      if (e.key === "Tab" || e.key === "Enter") { if (suggestions.items[selectedSuggestion]) { e.preventDefault(); applySuggestion(suggestions.items[selectedSuggestion].name); return; } }
      if (e.key === "Escape") { setShowSuggestions(false); return; }
    }

    const textarea = e.currentTarget;
    const cursorPos = textarea.selectionStart ?? 0;
    const meta = e.metaKey || e.ctrlKey;

    // Escape from !ai mode: clear the block content
    if (e.key === "Escape" && /^!ai\s/i.test(editContent)) {
      e.preventDefault();
      setEditContent("");
      return;
    }

    if (meta && e.key === "a") {
      e.preventDefault(); finishEditing();
      setSelectedBlockIds(new Set(blocks.map((b) => b.id))); setSelectionAnchor(0); return;
    }

    if (e.key === "Enter") {
      // Inside unclosed ``` code block: allow newline (like Shift+Enter)
      const lines = editContent.slice(0, cursorPos).split("\n");
      const openFences = lines.filter((l) => l.trimStart().startsWith("```")).length;
      if (openFences % 2 === 1) {
        // Inside a fenced code block — let newline through
        return;
      }

      // !ai prompt detection
      const aiMatch = editContent.match(/^!ai\s+(.+)$/i);
      if (aiMatch) {
        e.preventDefault();
        const prompt = aiMatch[1];
        setAiGenerating(block.id);
        // Build context from surrounding blocks
        const contextLines = blocks
          .slice(Math.max(0, blockIndex - 3), blockIndex)
          .map((b) => b.content)
          .filter(Boolean)
          .join("\n");
        fetch("/api/ai/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, context: contextLines }),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.error) {
              setAiGenerating(null);
              alert(`AI生成エラー: ${data.error}`);
              return;
            }
            setAiGenerating(null);
            setAiResult({ blockId: block.id, text: data.text });
          })
          .catch((err) => {
            setAiGenerating(null);
            alert(`AI生成エラー: ${err.message}`);
          });
        return;
      }

      e.preventDefault();
      pushUndo();
      const before = editContent.slice(0, cursorPos);
      const after = editContent.slice(cursorPos);
      // Normalize !action/!done date spec on the block that's being "closed"
      // by this Enter. Makes "@4/3" become "@2026/04/03-2026/04/03" immediately.
      const defaultDate = viewMode === "date" ? (selectedDate || todayISO()) : todayISO();
      const beforeNorm = normalizeActionDate(before, defaultDate);
      const updated = blocks.map((b) => b.id === block.id ? { ...b, content: beforeNorm } : b);
      const newBlock: Block = { id: crypto.randomUUID(), content: after, indent_level: block.indent_level, sort_order: block.sort_order + 1, date: block.date };
      updated.splice(blockIndex + 1, 0, newBlock);
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered); setEditContent(after); setEditingBlockId(newBlock.id);
      setTimeout(() => { const el = inputRefs.current.get(newBlock.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = 0; } }, 0);
      debouncedSave(reordered);
    } else if (e.key === "Tab") {
      e.preventDefault();
      pushUndo();
      const newIndent = e.shiftKey ? Math.max(0, block.indent_level - 1) : block.indent_level + 1;
      const updated = blocks.map((b) => b.id === block.id ? { ...b, indent_level: newIndent, content: editContent } : b);
      setBlocks(updated); debouncedSave(updated);
    } else if (e.key === "ArrowUp" && cursorPos === 0) {
      e.preventDefault();
      if (blockIndex > 0) { const prev = blocks[blockIndex - 1]; setBlocks(blocks.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(prev.id, prev.content.length); }
    } else if (e.key === "ArrowDown" && cursorPos === editContent.length) {
      e.preventDefault();
      if (blockIndex < blocks.length - 1) { const next = blocks[blockIndex + 1]; setBlocks(blocks.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(next.id, 0); }
    } else if (e.key === "ArrowLeft" && cursorPos === 0 && blockIndex > 0) {
      e.preventDefault(); const prev = blocks[blockIndex - 1];
      setBlocks(blocks.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(prev.id, prev.content.length);
    } else if (e.key === "ArrowRight" && cursorPos === editContent.length && blockIndex < blocks.length - 1) {
      e.preventDefault(); const next = blocks[blockIndex + 1];
      setBlocks(blocks.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(next.id, 0);
    } else if (e.key === "Backspace" && cursorPos === 0 && (textarea.selectionEnd ?? 0) === 0 && blockIndex > 0) {
      e.preventDefault();
      pushUndo();
      const prev = blocks[blockIndex - 1];
      const merged = prev.content + editContent;
      const cursorAt = prev.content.length;
      const updated = blocks.map((b) => b.id === prev.id ? { ...b, content: merged } : b).filter((b) => b.id !== block.id);
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered); setEditContent(merged); setEditingBlockId(prev.id);
      setTimeout(() => { const el = inputRefs.current.get(prev.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorAt; } }, 0);
      debouncedSave(reordered);
    }
  };

  // Helper: get ref list and setter for a block
  const getRefContext = (block: Block) => {
    const isPageRef = pageRefs.some((b) => b.id === block.id);
    return {
      list: isPageRef ? pageRefs : dateRefs,
      setList: isPageRef ? setPageRefs : setDateRefs,
    };
  };

  const handleRefKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, block: Block) => {
    if (e.key === "Shift") shiftHeldRef.current = true;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (showSuggestions) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedSuggestion((p) => Math.min(p + 1, suggestions.items.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedSuggestion((p) => Math.max(p - 1, 0)); return; }
      if (e.key === "Tab" || e.key === "Enter") { if (suggestions.items[selectedSuggestion]) { e.preventDefault(); applySuggestion(suggestions.items[selectedSuggestion].name); return; } }
      if (e.key === "Escape") { setShowSuggestions(false); return; }
    }

    const textarea = e.currentTarget;
    const cursorPos = textarea.selectionStart ?? 0;
    const meta = e.metaKey || e.ctrlKey;
    const { list: refList, setList: setRefList } = getRefContext(block);
    const blockIndex = refList.findIndex((b) => b.id === block.id);

    // Escape from !ai mode
    if (e.key === "Escape" && /^!ai\s/i.test(editContent)) {
      e.preventDefault();
      setEditContent("");
      return;
    }

    // Ctrl+A: select all blocks in ref group
    if (meta && e.key === "a") {
      e.preventDefault(); finishEditing();
      setSelectedBlockIds(new Set(refList.map((b) => b.id))); setSelectionAnchor(0); return;
    }

    if (e.key === "Enter") {
      // Inside unclosed ``` code block: allow newline
      const lines = editContent.slice(0, cursorPos).split("\n");
      const openFences = lines.filter((l) => l.trimStart().startsWith("```")).length;
      if (openFences % 2 === 1) return;

      // !ai prompt detection
      const aiMatch = editContent.match(/^!ai\s+(.+)$/i);
      if (aiMatch) {
        e.preventDefault();
        const prompt = aiMatch[1];
        setAiGenerating(block.id);
        const contextLines = refList
          .slice(Math.max(0, blockIndex - 3), blockIndex)
          .map((b) => b.content).filter(Boolean).join("\n");
        fetch("/api/ai/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, context: contextLines }),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.error) { setAiGenerating(null); alert(`AI生成エラー: ${data.error}`); return; }
            setAiGenerating(null);
            setAiResult({ blockId: block.id, text: data.text });
          })
          .catch((err) => { setAiGenerating(null); alert(`AI生成エラー: ${err.message}`); });
        return;
      }

      e.preventDefault();
      const before = editContent.slice(0, cursorPos);
      const after = editContent.slice(cursorPos);
      const defaultDate = viewMode === "date" ? (selectedDate || todayISO()) : todayISO();
      const beforeNorm = normalizeActionDate(before, defaultDate);
      const updatedBlock = { ...block, content: beforeNorm };
      const newBlock: Block = {
        id: crypto.randomUUID(), content: after, indent_level: block.indent_level,
        sort_order: block.sort_order + 1, date: block.date, page_id: block.page_id,
        source_page_name: block.source_page_name, source_page_id: block.source_page_id,
      };
      const updated = [...refList];
      updated[blockIndex] = updatedBlock;
      updated.splice(blockIndex + 1, 0, newBlock);
      setRefList(updated);
      setEditContent(after); setEditingBlockId(newBlock.id);
      setTimeout(() => { const el = inputRefs.current.get(newBlock.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = 0; } }, 0);
      debouncedRefSave(updatedBlock);
      fetch("/api/blocks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: newBlock.id, content: newBlock.content, indent_level: newBlock.indent_level, sort_order: newBlock.sort_order, date: newBlock.date, page_id: newBlock.page_id || null }),
      });
    } else if (e.key === "Tab") {
      e.preventDefault();
      const newIndent = e.shiftKey ? Math.max(0, block.indent_level - 1) : block.indent_level + 1;
      const updated = { ...block, indent_level: newIndent, content: editContent };
      setRefList(refList.map((b) => b.id === block.id ? updated : b));
      debouncedRefSave(updated);
    } else if (e.key === "ArrowUp" && cursorPos === 0) {
      e.preventDefault();
      if (blockIndex > 0) { const prev = refList[blockIndex - 1]; setRefList(refList.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(prev.id, prev.content.length); }
    } else if (e.key === "ArrowDown" && cursorPos === editContent.length) {
      e.preventDefault();
      if (blockIndex < refList.length - 1) { const next = refList[blockIndex + 1]; setRefList(refList.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(next.id, 0); }
    } else if (e.key === "ArrowLeft" && cursorPos === 0 && blockIndex > 0) {
      e.preventDefault(); const prev = refList[blockIndex - 1];
      setRefList(refList.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(prev.id, prev.content.length);
    } else if (e.key === "ArrowRight" && cursorPos === editContent.length && blockIndex < refList.length - 1) {
      e.preventDefault(); const next = refList[blockIndex + 1];
      setRefList(refList.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(next.id, 0);
    } else if (e.key === "Backspace" && cursorPos === 0 && (textarea.selectionEnd ?? 0) === 0 && blockIndex > 0) {
      e.preventDefault();
      const prev = refList[blockIndex - 1];
      const merged = prev.content + editContent;
      const cursorAt = prev.content.length;
      const updated = refList.map((b) => b.id === prev.id ? { ...b, content: merged } : b).filter((b) => b.id !== block.id);
      setRefList(updated);
      fetch("/api/blocks", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: block.id }) });
      debouncedRefSave({ ...prev, content: merged });
      setEditContent(merged); setEditingBlockId(prev.id);
      setTimeout(() => { const el = inputRefs.current.get(prev.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorAt; } }, 0);
    }
  };

  const handleRefPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>, block: Block, _blockIndex: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text || !text.includes("\n")) return; // single line paste is handled natively
    e.preventDefault();
    const textarea = e.currentTarget;
    const cursorPos = textarea.selectionStart ?? 0;
    const selEnd = textarea.selectionEnd ?? cursorPos;
    const before = editContent.slice(0, cursorPos);
    const after = editContent.slice(selEnd);
    const lines = text.split("\n");
    const firstContent = before + lines[0];
    const lastLineContent = lines[lines.length - 1] + after;
    const { list: refList, setList: setRefList } = getRefContext(block);
    const blockIndex = refList.findIndex((b) => b.id === block.id);

    if (lines.length === 1) {
      const newContent = firstContent + after;
      setEditContent(newContent);
      const updated = { ...block, content: newContent };
      setRefList(refList.map((b) => b.id === block.id ? updated : b));
      debouncedRefSave(updated);
      return;
    }

    // Update current block with first line
    const updatedCurrent = { ...block, content: firstContent };
    const updated = [...refList];
    updated[blockIndex] = updatedCurrent;

    // Create new blocks for middle + last lines. Respect 4-space/tab indent.
    const newBlocks: Block[] = [];
    for (let i = 1; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      const { indent, content: stripped } = parseLeadingIndent(lines[i]);
      const content = isLast ? stripped + after : stripped;
      newBlocks.push({
        id: crypto.randomUUID(), content, indent_level: block.indent_level + indent,
        sort_order: 0, date: block.date, page_id: block.page_id,
        source_page_name: block.source_page_name, source_page_id: block.source_page_id,
      });
    }
    updated.splice(blockIndex + 1, 0, ...newBlocks);
    setRefList(updated);

    // Save current block + create new blocks on server
    debouncedRefSave(updatedCurrent);
    for (const nb of newBlocks) {
      fetch("/api/blocks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: nb.id, content: nb.content, indent_level: nb.indent_level, sort_order: nb.sort_order, date: nb.date, page_id: nb.page_id || null }),
      });
    }

    // Focus last new block
    const lastBlock = newBlocks[newBlocks.length - 1];
    const cursorAt = lines[lines.length - 1].length;
    setEditingBlockId(lastBlock.id);
    setEditContent(lastBlock.content);
    setTimeout(() => { const el = inputRefs.current.get(lastBlock.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorAt; } }, 0);
  };

  const handleRefBlockMouseDown = useCallback((e: React.MouseEvent, _blockIndex: number, block: Block) => {
    const { list: refList } = getRefContext(block);
    const refIndex = refList.findIndex((b) => b.id === block.id);
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      // Cmd/Ctrl+Click: toggle this block's selection
      e.preventDefault();
      skipMouseUpRef.current = true;
      const next = new Set(selectedBlockIds);
      if (next.has(block.id)) next.delete(block.id);
      else next.add(block.id);
      setSelectedBlockIds(next);
      setSelectionAnchor(refIndex);
      setTimeout(() => containerRef.current?.focus(), 0);
      return;
    }
    if (e.shiftKey && selectionAnchor !== null) {
      e.preventDefault();
      skipMouseUpRef.current = true;
      if (editingBlockId) {
        const updated = refList.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
        const { setList: setRefList } = getRefContext(block);
        setRefList(updated);
        setEditingBlockId(null);
        setShowSuggestions(false);
      }
      // Select range within ref group
      const start = Math.min(selectionAnchor, refIndex);
      const end = Math.max(selectionAnchor, refIndex);
      setSelectedBlockIds(new Set(refList.slice(start, end + 1).map((b) => b.id)));
      setSelectionAnchor(refIndex);
      setTimeout(() => containerRef.current?.focus(), 0);
      return;
    }
    if (!e.shiftKey) { clearSelection(); setSelectionAnchor(refIndex); }
  }, [editingBlockId, editContent, selectionAnchor, clearSelection]);

  const addNewBlock = () => {
    pushUndo();
    const newBlock: Block = { id: crypto.randomUUID(), content: "", indent_level: 0, sort_order: blocks.length, date: viewMode === "page" ? "" : selectedDate };
    const updated = [...blocks, newBlock];
    setBlocks(updated); startEditing(newBlock); debouncedSave(updated);
  };

  const groupedDateRefs = dateRefs.reduce((acc, b) => {
    if (!acc[b.date]) acc[b.date] = [];
    acc[b.date].push(b);
    return acc;
  }, {} as Record<string, Block[]>);

  const groupedPageRefs = pageRefs.reduce((acc, b) => {
    const key = b.source_page_id || "unknown";
    if (!acc[key]) acc[key] = { name: b.source_page_name || "", blocks: [] };
    acc[key].blocks.push(b);
    return acc;
  }, {} as Record<string, { name: string; blocks: Block[] }>);

  // Group tag blocks: date-based blocks grouped by date, page-based blocks grouped by "page:pageId"
  const groupedTagBlocks = viewMode === "tag" ? blocks.reduce((acc, b) => {
    const key = b.page_id && b.source_page_id
      ? `page:${b.source_page_id}`
      : (b.date || "no-date");
    if (!acc[key]) acc[key] = { label: "", isPage: false, pageId: "", blocks: [] };
    if (key.startsWith("page:")) {
      acc[key].label = b.source_page_name || "不明なページ";
      acc[key].isPage = true;
      acc[key].pageId = b.source_page_id || "";
    } else {
      acc[key].label = b.date || "日付なし";
      acc[key].isPage = false;
    }
    acc[key].blocks.push(b);
    return acc;
  }, {} as Record<string, { label: string; isPage: boolean; pageId: string; blocks: Block[] }>) : null;

  if (loading) {
    return <div className="flex items-center justify-center py-8 text-gray-400">読み込み中...</div>;
  }

  const blockLineProps = (block: Block, blockIndex: number, isRef = false) => ({
    block, blockIndex,
    isEditing: editingBlockId === block.id,
    isSelected: selectedBlockIds.has(block.id),
    editContent, showSuggestions: showSuggestions && editingBlockId === block.id,
    suggestions, selectedSuggestion,
    allPages, allTags, allMeetings,
    setInputRef, onStartEditing: startEditing,
    onEditContentChange: handleContentChange,
    onFinishEditing: () => { blurTimeoutRef.current = setTimeout(finishEditing, 150); },
    onKeyDown: isRef ? ((e: KeyboardEvent<HTMLTextAreaElement>, b: Block, _i: number) => handleRefKeyDown(e, b)) : handleKeyDown,
    onPaste: isRef ? handleRefPaste : handlePaste,
    onPageClick, onTagClick, onDateClick, onMeetingClick, onApplySuggestion: applySuggestion,
    onBlockMouseDown: isRef ? ((e: React.MouseEvent, blockIndex: number) => handleRefBlockMouseDown(e, blockIndex, block)) : handleBlockMouseDown,
    onBulletMouseDown: isRef ? undefined : (e: React.MouseEvent, blockIndex: number) => {
      // Cmd/Ctrl → toggle; Shift → extend range; plain click → select just this.
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        skipMouseUpRef.current = true;
        if (editingBlockId) {
          const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
          setBlocks(updated); debouncedSave(updated);
          setEditingBlockId(null); setShowSuggestions(false);
        }
        toggleBlockSelected(blockIndex);
        setTimeout(() => containerRef.current?.focus(), 0);
        return;
      }
      if (e.shiftKey && selectionAnchor !== null) {
        e.preventDefault();
        skipMouseUpRef.current = true;
        if (editingBlockId) {
          const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
          setBlocks(updated); debouncedSave(updated);
          setEditingBlockId(null); setShowSuggestions(false);
        }
        selectRange(selectionAnchor, blockIndex);
        setTimeout(() => containerRef.current?.focus(), 0);
        return;
      }
      e.preventDefault();
      skipMouseUpRef.current = true;
      selectJustBlock(blockIndex);
    },
    skipMouseUpRef,
    onIndent: isRef ? (b: Block) => {
      const updated = { ...b, indent_level: b.indent_level + 1, content: editContent };
      setPageRefs(pageRefs.map((bl) => bl.id === b.id ? updated : bl));
      setDateRefs(dateRefs.map((bl) => bl.id === b.id ? updated : bl));
      debouncedRefSave(updated);
    } : (b: Block) => {
      pushUndo();
      const updated = blocks.map((bl) => bl.id === b.id ? { ...bl, indent_level: b.indent_level + 1, content: editContent } : bl);
      setBlocks(updated); debouncedSave(updated);
    },
    onOutdent: isRef ? (b: Block) => {
      if (b.indent_level <= 0) return;
      const updated = { ...b, indent_level: b.indent_level - 1, content: editContent };
      setPageRefs(pageRefs.map((bl) => bl.id === b.id ? updated : bl));
      setDateRefs(dateRefs.map((bl) => bl.id === b.id ? updated : bl));
      debouncedRefSave(updated);
    } : (b: Block) => {
      if (b.indent_level <= 0) return;
      pushUndo();
      const updated = blocks.map((bl) => bl.id === b.id ? { ...bl, indent_level: b.indent_level - 1, content: editContent } : bl);
      setBlocks(updated); debouncedSave(updated);
    },
  });

  const handleCopyAndRefresh = async () => {
    if (!conflict) return;
    try {
      await navigator.clipboard.writeText(conflict.text);
      setConflict(null);
      await fetchBlocks();
    } catch {
      // Clipboard refused (e.g., insecure context). Show the text inside
      // the modal so the user can manually select + copy.
      setConflict({ ...conflict, manualCopyNeeded: true });
    }
  };

  const handleDismissConflict = () => setConflict(null);

  return (
    <div ref={containerRef} className="mx-auto max-w-3xl outline-none" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === "Shift") shiftHeldRef.current = true; handleContainerKeyDown(e); }}
      onKeyUp={(e) => { if (e.key === "Shift") shiftHeldRef.current = false; }}>
      {/* Selection toolbar — floats at top when ≥1 block is selected */}
      {selectedBlockIds.size > 0 && (
        <div className="sticky top-0 z-30 mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-theme-300 bg-theme-50 px-3 py-1.5 shadow-sm text-xs">
          <span className="font-semibold text-theme-700">{selectedBlockIds.size}件選択中</span>
          <span className="text-gray-400">|</span>
          <button
            onClick={() => copySelectedBlocks(false)}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100"
            title="⌘C"
          >コピー</button>
          <button
            onClick={() => copySelectedBlocks(true)}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100"
            title="⌘X"
          >カット</button>
          <button
            onClick={() => indentSelectedBlocks(true)}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100"
            title="Shift+Tab"
          >⇐ アウトデント</button>
          <button
            onClick={() => indentSelectedBlocks(false)}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100"
            title="Tab"
          >インデント ⇒</button>
          <button
            onClick={deleteSelectedBlocks}
            className="rounded border border-red-300 bg-white px-2 py-0.5 text-red-600 hover:bg-red-50"
            title="Delete"
          >削除</button>
          <span className="ml-auto text-gray-500 hidden sm:inline">
            Shift/⌘+クリック・⌘A で選択、Esc で解除
          </span>
          <button
            onClick={clearSelection}
            className="rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100"
            title="Esc"
          >✕</button>
        </div>
      )}
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-start gap-3 mb-3">
              <svg className="h-6 w-6 text-amber-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div>
                <h3 className="text-base font-semibold text-gray-800">他のデバイスで編集されています</h3>
                <p className="mt-1 text-sm text-gray-600">
                  このページは別のデバイスから先に更新されました。いま保存すると、あちらの変更を上書きしてしまいます。
                </p>
              </div>
            </div>
            {!conflict.manualCopyNeeded && (
              <div className="rounded bg-amber-50 border border-amber-200 p-2 text-xs text-amber-900 mb-4">
                編集中だったブロックの内容をコピーして、最新の内容に更新します。
                コピーされた内容は必要な箇所にペーストで戻せます。
              </div>
            )}
            {conflict.manualCopyNeeded && (
              <div className="mb-4">
                <div className="text-xs text-gray-600 mb-1">
                  クリップボードへの自動コピーが拒否されました。下のテキストを選択してコピー（⌘/Ctrl + C）してください。
                </div>
                <textarea
                  readOnly
                  value={conflict.text}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full h-24 text-xs border border-gray-300 rounded p-2 font-mono focus:ring-2 focus:ring-theme-400 focus:outline-none"
                />
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={handleDismissConflict}
                className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
              >キャンセル</button>
              {conflict.manualCopyNeeded ? (
                <button
                  onClick={async () => { setConflict(null); await fetchBlocks(); }}
                  className="rounded bg-theme-500 text-white px-4 py-1.5 text-sm font-medium hover:bg-theme-600"
                >更新する</button>
              ) : (
                <button
                  onClick={handleCopyAndRefresh}
                  className="rounded bg-theme-500 text-white px-4 py-1.5 text-sm font-medium hover:bg-theme-600"
                >編集内容をコピーして更新</button>
              )}
            </div>
          </div>
        </div>
      )}
      {viewMode === "page" ? (
        <>
          {/* Page title (editable) */}
          <div className="mb-4">
            {editingPageTitle ? (
              <input
                type="text"
                value={pageTitleDraft}
                onChange={(e) => setPageTitleDraft(e.target.value)}
                onBlur={async () => {
                  const trimmed = pageTitleDraft.trim();
                  if (trimmed && trimmed !== selectedPageName.split("/").pop()) {
                    await fetch("/api/pages", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: selectedPageId, name: trimmed }),
                    });
                    onDataChange();
                  }
                  setEditingPageTitle(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") setEditingPageTitle(false);
                }}
                autoFocus
                className="w-full text-xl font-bold text-gray-800 bg-theme-50 border border-theme-300 rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-theme-400"
              />
            ) : (
              <h2
                className="text-xl font-bold text-gray-800 cursor-pointer hover:text-theme-600 transition px-1"
                onClick={() => {
                  setPageTitleDraft(selectedPageName.split("/").pop() || selectedPageName);
                  setEditingPageTitle(true);
                }}
                title="クリックでタイトル編集"
              >
                {selectedPageName.split("/").pop() || selectedPageName}
              </h2>
            )}
          </div>

          {/* Child pages with drag & drop */}
          {(() => {
            const childPages = allPages.filter((p) => p.parent_id === selectedPageId);
            if (childPages.length === 0 && !addingChildPage && viewMode !== "page") return null;
            const handleCreateChildPage = async () => {
              if (!newChildPageName.trim() || !selectedPageId) return;
              const res = await fetch("/api/pages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: newChildPageName.trim(), parent_id: selectedPageId }),
              });
              if (res.ok) {
                setNewChildPageName("");
                setAddingChildPage(false);
                onDataChange();
              }
            };
            const handleChildPageDrop = async (dragId: string, dropId: string) => {
              if (dragId === dropId) return;
              if (dropId === "__parent__") {
                // Move to grandparent (parent of current page)
                const currentPage = allPages.find((p) => p.id === selectedPageId);
                const grandparentId = currentPage?.parent_id ?? null;
                await fetch("/api/pages", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reorder: [{ id: dragId, parent_id: grandparentId, sort_order: 999 }] }),
                });
              } else {
                // Move as child of the drop target (sibling → child)
                await fetch("/api/pages", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reorder: [{ id: dragId, parent_id: dropId, sort_order: 0 }] }),
                });
              }
              onDataChange();
            };
            return (
              <ChildPageList
                childPages={childPages}
                selectedPageId={selectedPageId!}
                onPageClick={onPageClick}
                onDrop={handleChildPageDrop}
                addingChildPage={addingChildPage}
                newChildPageName={newChildPageName}
                setNewChildPageName={setNewChildPageName}
                setAddingChildPage={setAddingChildPage}
                handleCreateChildPage={handleCreateChildPage}
              />
            );
          })()}

          {/* Page content */}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            {blocks.map((block, i) => (
              <React.Fragment key={block.id}>
                {blockConflicts.has(block.id) && (
                  <ConflictBanner
                    conflict={blockConflicts.get(block.id)!}
                    indentPx={block.indent_level * 24}
                    onKeepLocal={() => resolveConflictKeepLocal(block.id)}
                    onTakeServer={() => resolveConflictTakeServer(block.id)}
                    onKeepBoth={() => resolveConflictKeepBoth(block.id)}
                  />
                )}
                <BlockLine {...blockLineProps(block, i)} />
                {aiGenerating === block.id && (
                  <div className="flex items-center gap-2 py-2 px-3 text-sm text-theme-500" style={{ paddingLeft: `${block.indent_level * 24 + 12}px` }}>
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    AI生成中...
                    <button
                      onClick={() => setAiGenerating(null)}
                      className="ml-2 text-xs text-gray-400 hover:text-red-500"
                    >
                      キャンセル
                    </button>
                  </div>
                )}
              </React.Fragment>
            ))}
            {blocks.length === 0 && (
              <div className="py-4 cursor-text text-sm text-gray-300 min-h-[2em]" onClick={addNewBlock}>&nbsp;</div>
            )}
          </div>

          {/* Backlinks accordion */}
          {(Object.keys(groupedPageRefs).length > 0 || Object.keys(groupedDateRefs).length > 0) && (
            <div className="mt-6 rounded-lg border border-gray-200 bg-white">
              <button
                onClick={() => setBacklinksOpen(!backlinksOpen)}
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600"
              >
                <span className="flex items-center gap-1">
                  <svg className={`h-3 w-3 transition-transform ${backlinksOpen ? "rotate-90" : ""}`} fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                  </svg>
                  このページへの参照
                </span>
                <span className="text-gray-400 font-normal normal-case">
                  {Object.values(groupedPageRefs).reduce((s, g) => s + g.blocks.length, 0) + Object.values(groupedDateRefs).reduce((s, g) => s + g.length, 0)}件
                </span>
              </button>
              {backlinksOpen && (
                <div className="border-t border-gray-100 px-3 py-2 space-y-3">
                  {Object.entries(groupedPageRefs).map(([pageId, { name, blocks: refBlocks }]) => (
                    <div key={pageId}>
                      <h4 className="mb-1 text-sm font-medium">
                        <span className="page-link cursor-pointer" onClick={() => { const p = allPages.find((pp) => pp.id === pageId); if (p) onPageClick(p.id, p.name); }}>{name}</span>
                      </h4>
                      <div className="rounded border border-gray-100 bg-gray-50 p-2">
                        {refBlocks.map((b) => <BlockLine key={b.id} {...blockLineProps(b, 0, true)} />)}
                      </div>
                    </div>
                  ))}
                  {Object.entries(groupedDateRefs).sort(([a], [b]) => b.localeCompare(a)).map(([date, refBlocks]) => (
                    <div key={date}>
                      <h4 className="mb-1 text-sm font-medium">
                        <span className="date-link cursor-pointer" onClick={() => onDateClick(date)}>{date}</span>
                      </h4>
                      <div className="rounded border border-gray-100 bg-gray-50 p-2">
                        {refBlocks.map((b) => <BlockLine key={b.id} {...blockLineProps(b, 0, true)} />)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : viewMode === "tag" && groupedTagBlocks ? (
        <>
          {Object.entries(groupedTagBlocks)
            .sort(([a, ga], [b, gb]) => {
              // Sort: dates descending first, then pages
              if (ga.isPage && !gb.isPage) return 1;
              if (!ga.isPage && gb.isPage) return -1;
              if (ga.isPage && gb.isPage) return ga.label.localeCompare(gb.label);
              return b.localeCompare(a);
            })
            .map(([key, group]) => (
            <div key={key} className="mb-6">
              <h2 className="mb-2 text-sm font-medium">
                {group.isPage ? (
                  <span className="page-link cursor-pointer" onClick={() => {
                    const page = allPages.find((p) => p.id === group.pageId);
                    onPageClick(group.pageId, page?.full_path || group.label);
                  }}>{group.label}</span>
                ) : (
                  <span className="date-link cursor-pointer" onClick={() => onDateClick(group.blocks[0]?.date || "")}>{group.label}</span>
                )}
              </h2>
              <div className="rounded-lg border border-gray-200 bg-white p-3">
                {group.blocks.map((b) => <BlockLine key={b.id} {...blockLineProps(b, 0, true)} />)}
              </div>
            </div>
          ))}
          {blocks.length === 0 && <p className="text-sm text-gray-400 py-4">このタグを含むブロックはありません</p>}
        </>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            {blocks.map((block, i) => (
              <React.Fragment key={block.id}>
                {blockConflicts.has(block.id) && (
                  <ConflictBanner
                    conflict={blockConflicts.get(block.id)!}
                    indentPx={block.indent_level * 24}
                    onKeepLocal={() => resolveConflictKeepLocal(block.id)}
                    onTakeServer={() => resolveConflictTakeServer(block.id)}
                    onKeepBoth={() => resolveConflictKeepBoth(block.id)}
                  />
                )}
                <BlockLine {...blockLineProps(block, i)} />
                {aiGenerating === block.id && (
                  <div className="flex items-center gap-2 py-2 px-3 text-sm text-theme-500" style={{ paddingLeft: `${block.indent_level * 24 + 12}px` }}>
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    AI生成中...
                    <button
                      onClick={() => setAiGenerating(null)}
                      className="ml-2 text-xs text-gray-400 hover:text-red-500"
                    >
                      キャンセル
                    </button>
                  </div>
                )}
              </React.Fragment>
            ))}
            {blocks.length === 0 && (
              <div className="py-4 cursor-text text-sm text-gray-300 min-h-[2em]" onClick={addNewBlock}>&nbsp;</div>
            )}
          </div>
        </>
      )}

      {/* AI generation result modal */}
      {aiResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">AI生成結果</h3>
            <div className="mb-4 max-h-64 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm whitespace-pre-wrap">
              {aiResult.text}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAiResult(null)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                キャンセル
              </button>
              <button
                onClick={() => {
                  pushUndo();
                  const lines = aiResult.text.split("\n");
                  const blockIndex = blocks.findIndex((b) => b.id === aiResult.blockId);
                  if (blockIndex === -1) { setAiResult(null); return; }
                  const block = blocks[blockIndex];
                  // Replace the !ai block with first line, insert rest as new blocks
                  const updated = blocks.map((b) => b.id === block.id ? { ...b, content: lines[0] } : b);
                  const newBlocks: Block[] = [];
                  for (let i = 1; i < lines.length; i++) {
                    if (lines[i] === "" && i < lines.length - 1) continue; // skip empty intermediate lines
                    newBlocks.push({
                      id: crypto.randomUUID(),
                      content: lines[i],
                      indent_level: block.indent_level,
                      sort_order: 0,
                      date: block.date,
                    });
                  }
                  if (newBlocks.length > 0) updated.splice(blockIndex + 1, 0, ...newBlocks);
                  const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
                  setBlocks(reordered);
                  setEditContent(lines[0]);
                  setEditingBlockId(block.id);
                  debouncedSave(reordered);
                  setAiResult(null);
                }}
                className="rounded-lg bg-theme-500 px-4 py-2 text-sm text-white hover:bg-theme-600"
              >
                挿入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline conflict resolution card. Renders above a block when its
 * blockConflicts entry is set. Three explicit choices, no auto-resolution.
 */
function ConflictBanner({
  conflict, indentPx, onKeepLocal, onTakeServer, onKeepBoth,
}: {
  conflict: BlockConflict;
  indentPx: number;
  onKeepLocal: () => void;
  onTakeServer: () => void;
  onKeepBoth: () => void;
}) {
  return (
    <div className="my-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs" style={{ marginLeft: indentPx }}>
      <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-amber-800">
        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        このブロックは別の端末でも変更されています
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        <div className="rounded border border-blue-200 bg-blue-50 p-1.5">
          <div className="text-[10px] font-medium text-blue-700 mb-0.5">あなたの内容</div>
          <div className="text-[11px] text-gray-800 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
            {conflict.localContent || <span className="text-gray-400">（空）</span>}
          </div>
        </div>
        <div className="rounded border border-gray-300 bg-white p-1.5">
          <div className="text-[10px] font-medium text-gray-600 mb-0.5">別端末の内容（v{conflict.serverVersion}）</div>
          <div className="text-[11px] text-gray-800 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
            {conflict.serverContent || <span className="text-gray-400">（空）</span>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button onClick={onKeepLocal} className="rounded bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-600">自分の内容を残す</button>
        <button onClick={onTakeServer} className="rounded bg-gray-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-gray-800">別端末の内容にする</button>
        <button onClick={onKeepBoth} className="rounded border border-amber-400 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-50">両方残す（新規ブロック）</button>
      </div>
    </div>
  );
}

const BlockEditor = React.memo(BlockEditorInner, (prev, next) => {
  // Skip re-render if only allPages/allTags references changed but content is same
  if (prev.viewMode !== next.viewMode) return false;
  if (prev.selectedDate !== next.selectedDate) return false;
  if (prev.selectedPageId !== next.selectedPageId) return false;
  if (prev.selectedMeetingId !== next.selectedMeetingId) return false;
  if (prev.selectedPageName !== next.selectedPageName) return false;
  if (prev.selectedTagId !== next.selectedTagId) return false;
  if (prev.selectedTagName !== next.selectedTagName) return false;
  if (prev.actionVersion !== next.actionVersion) return false;
  // allPages: compare by length + ids (not reference)
  if (prev.allPages.length !== next.allPages.length) return false;
  if (prev.allPages.some((p, i) => p.id !== next.allPages[i]?.id || p.name !== next.allPages[i]?.name || p.parent_id !== next.allPages[i]?.parent_id)) return false;
  // allTags: compare by length + ids
  if (prev.allTags.length !== next.allTags.length) return false;
  if (prev.allTags.some((t, i) => t.id !== next.allTags[i]?.id || t.name !== next.allTags[i]?.name)) return false;
  // Callbacks: always stable with useCallback, skip check
  return true;
});
export default BlockEditor;

interface BlockLineProps {
  block: Block; blockIndex: number; isEditing: boolean; isSelected: boolean;
  editContent: string; showSuggestions: boolean;
  suggestions: { type: "tag" | "page" | "template" | "meeting"; items: { id: string; name: string; content?: string }[] };
  selectedSuggestion: number; allPages: PageInfo[]; allTags: TagInfo[]; allMeetings?: MeetingInfo[];
  setInputRef: (id: string, el: HTMLTextAreaElement | null) => void;
  onStartEditing: (block: Block) => void; onEditContentChange: (c: string) => void;
  onFinishEditing: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>, block: Block, blockIndex: number) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>, block: Block, blockIndex: number) => void;
  onPageClick: (id: string, name: string) => void;
  onTagClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
  onMeetingClick?: (meetingId: string) => void;
  onApplySuggestion: (name: string) => void;
  onBlockMouseDown: (e: React.MouseEvent, blockIndex: number) => void;
  onBulletMouseDown?: (e: React.MouseEvent, blockIndex: number) => void;
  skipMouseUpRef: React.MutableRefObject<boolean>;
  onIndent?: (block: Block) => void;
  onOutdent?: (block: Block) => void;
}

const BlockLine = React.memo(function BlockLine({ block, blockIndex, isEditing, isSelected, editContent, showSuggestions,
  suggestions, selectedSuggestion, allPages, allTags, allMeetings, setInputRef, onStartEditing,
  onEditContentChange, onFinishEditing, onKeyDown, onPaste, onPageClick, onTagClick, onDateClick, onMeetingClick,
  onApplySuggestion, onBlockMouseDown, onBulletMouseDown, skipMouseUpRef, onIndent, onOutdent,
}: BlockLineProps) {
  const indent = block.indent_level * 24;

  return (
    <div className={`group relative flex items-stretch min-h-[2em] ${isSelected ? "bg-blue-100 rounded" : ""} ${!isEditing ? "cursor-text hover:bg-gray-50 rounded" : ""}`}
      style={{ paddingLeft: `${indent + 14}px` }}
      onMouseDown={(e) => {
        // Don't trigger selection/re-render when clicking on links — it replaces DOM nodes
        // and prevents the click event from firing
        const target = e.target as HTMLElement;
        if (target.closest('.page-link, .tag-inline, .date-link, .meeting-link, .gfm-link')) return;
        onBlockMouseDown(e, blockIndex);
      }}
      onMouseUp={(e) => {
        // Skip mouseUp after shift+click selection
        if (skipMouseUpRef.current) { skipMouseUpRef.current = false; return; }
        if (isEditing) return;
        const target = e.target as HTMLElement;
        const link = target.closest('.page-link, .tag-inline, .date-link, .meeting-link') as HTMLElement | null;
        if (link) {
          // Navigate via event delegation using data attributes from DOM
          e.stopPropagation();
          if (link.classList.contains('page-link')) {
            const pageId = link.getAttribute('data-page-id') || "";
            const pageName = link.getAttribute('data-page-name') || "";
            if (pageId && pageName) onPageClick(pageId, pageName);
          } else if (link.classList.contains('tag-inline')) {
            const tagId = link.getAttribute('data-tag-id') || "";
            const tagName = link.getAttribute('data-tag-name') || "";
            if (tagId && tagName) onTagClick(tagId, tagName);
          } else if (link.classList.contains('date-link')) {
            const date = link.getAttribute('data-date') || "";
            if (date) onDateClick(date);
          } else if (link.classList.contains('meeting-link')) {
            const meetingId = link.getAttribute('data-meeting-id') || "";
            if (meetingId && onMeetingClick) onMeetingClick(meetingId);
          }
          return;
        }
        // Don't enter edit mode if clicking on external links
        if (target.closest('.gfm-link')) return;
        onStartEditing(block);
      }}>
      {/* Bullet handle — click to select just this block (Cmd/Shift to extend). */}
      {onBulletMouseDown && (
        <span
          onMouseDown={(e) => { e.stopPropagation(); onBulletMouseDown(e, blockIndex); }}
          onClick={(e) => e.stopPropagation()}
          className={`absolute cursor-pointer select-none flex items-center justify-center ${
            isSelected ? "opacity-100" : "opacity-40 group-hover:opacity-100"
          }`}
          style={{ left: indent, top: 0, bottom: 0, width: 14 }}
          title="クリックで選択 / ⌘+クリックで追加選択 / Shift+クリックで範囲選択"
        >
          <span className={`block h-1.5 w-1.5 rounded-full transition ${isSelected ? "bg-theme-600" : "bg-gray-400"}`} />
        </span>
      )}
      {isEditing && /^!ai\s/i.test(editContent) ? (
        <div className="relative flex-1">
          <div className="flex items-center gap-2 rounded-lg border border-purple-300 bg-purple-50 px-3 py-1.5">
            <svg className="h-4 w-4 text-purple-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-xs font-medium text-purple-600 flex-shrink-0">AI</span>
            <input
              ref={(el) => { if (el) { setInputRef(block.id, el as any); el.focus(); } }}
              type="text"
              value={editContent.replace(/^!ai\s/i, "")}
              onChange={(e) => onEditContentChange("!ai " + e.target.value)}
              onBlur={onFinishEditing}
              onKeyDown={(e) => onKeyDown(e as unknown as KeyboardEvent<HTMLTextAreaElement>, block, blockIndex)}
              placeholder="AIに指示を入力... (Enterで生成、Escでキャンセル)"
              className="flex-1 bg-transparent text-sm text-purple-900 outline-none placeholder:text-purple-300"
              autoFocus
            />
          </div>
        </div>
      ) : isEditing ? (
        <div className="relative flex-1">
          <textarea ref={(el) => setInputRef(block.id, el)}
            value={editContent} onChange={(e) => { onEditContentChange(e.target.value); requestAnimationFrame(() => { const ta = e.target as HTMLTextAreaElement; if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; } }); }}
            onBlur={onFinishEditing}
            onKeyDown={(e) => onKeyDown(e, block, blockIndex)}
            onPaste={onPaste ? (e) => onPaste(e, block, blockIndex) : undefined}
            className="block-line w-full resize-none border-none bg-blue-50 p-1 text-sm outline-none rounded leading-snug overflow-hidden"
            rows={1} autoFocus />
          {/* Indent/Outdent buttons for mobile */}
          {(onIndent || onOutdent) && (
            <div className="flex items-center gap-1 mt-0.5">
              <button
                onMouseDown={(e) => { e.preventDefault(); onOutdent?.(block); }}
                disabled={block.indent_level <= 0}
                className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs transition ${
                  block.indent_level <= 0 ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:bg-gray-200 active:bg-gray-300"
                }`}
                title="インデント減"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7" />
                </svg>
                <svg className="h-3 w-3 -ml-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <button
                onMouseDown={(e) => { e.preventDefault(); onIndent?.(block); }}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-200 active:bg-gray-300 transition"
                title="インデント増"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                <svg className="h-3 w-3 -ml-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}
          {showSuggestions && (
            <div className="absolute left-0 top-full z-10 mt-1 min-w-56 max-w-md rounded border border-gray-200 bg-white shadow-lg">
              {suggestions.items.map((item, i) => (
                <button key={item.id}
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === selectedSuggestion ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-50"}`}
                  onMouseDown={(e) => { e.preventDefault(); onApplySuggestion(item.name); }}>
                  {suggestions.type === "page" ? (
                    <span className="page-link text-xs">{item.name}</span>
                  ) : suggestions.type === "template" ? (
                    <span className="flex items-center gap-1.5 text-xs">
                      <svg className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                      </svg>
                      {item.name}
                    </span>
                  ) : (
                    <span className="tag-inline text-xs">{item.name}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="block-line block-content flex-1 p-1 text-sm w-full select-none">
          {block.content
            ? <MarkdownContent content={block.content} allPages={allPages} allTags={allTags} allMeetings={allMeetings}
                onPageClick={onPageClick} onTagClick={onTagClick} onDateClick={onDateClick} />
            : "\u00A0"}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Only re-render if this block's data or editing state actually changed
  // block ref: .map() preserves ref for unchanged blocks, so === is sufficient
  if (prev.block !== next.block) return false;
  if (prev.blockIndex !== next.blockIndex) return false;
  if (prev.isEditing !== next.isEditing) return false;
  if (prev.isSelected !== next.isSelected) return false;
  // Only compare edit-mode props when editing
  if (next.isEditing) {
    if (prev.editContent !== next.editContent) return false;
    if (prev.showSuggestions !== next.showSuggestions) return false;
    if (prev.selectedSuggestion !== next.selectedSuggestion) return false;
  }
  // allPages/allTags: only affect markdown rendering (non-editing blocks)
  if (!next.isEditing) {
    if (prev.allPages !== next.allPages) return false;
    if (prev.allTags !== next.allTags) return false;
  }
  // Skip function props — they're recreated each render but functionally identical
  return true;
});

// --- Draggable child page item ---
function DraggableChildPage({ page, onPageClick }: { page: PageInfo; onPageClick: (id: string, name: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `child-${page.id}` });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, opacity: isDragging ? 0.4 : 1 } : undefined;
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={style}
      className="cursor-grab active:cursor-grabbing">
      <DroppableChildPage page={page} onPageClick={onPageClick} />
    </div>
  );
}

// --- Droppable wrapper for each child page (drop = make dragged page a child of this) ---
function DroppableChildPage({ page, onPageClick }: { page: PageInfo; onPageClick: (id: string, name: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `childDrop-${page.id}` });
  return (
    <div ref={setNodeRef}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition ${
        isOver ? "bg-theme-100 border-theme-400 ring-1 ring-theme-400" : "bg-white border-gray-200 hover:bg-theme-50 hover:border-theme-300"
      }`}>
      <svg className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <button onClick={() => onPageClick(page.id, page.name)} className="text-gray-700 hover:text-theme-600 truncate">
        {page.name}
      </button>
    </div>
  );
}

// --- ChildPageList with drag & drop ---
function ChildPageList({ childPages, selectedPageId, onPageClick, onDrop, addingChildPage, newChildPageName, setNewChildPageName, setAddingChildPage, handleCreateChildPage }: {
  childPages: PageInfo[];
  selectedPageId: string;
  onPageClick: (id: string, name: string) => void;
  onDrop: (dragId: string, dropId: string) => void;
  addingChildPage: boolean;
  newChildPageName: string;
  setNewChildPageName: (v: string) => void;
  setAddingChildPage: (v: boolean) => void;
  handleCreateChildPage: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [draggedId, setDraggedId] = useState<string | null>(null);

  // ../  drop target
  const { setNodeRef: setParentDropRef, isOver: isOverParent } = useDroppable({ id: "childDrop-__parent__" });

  const handleDragStart = (event: DragStartEvent) => {
    setDraggedId(String(event.active.id).replace("child-", ""));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggedId(null);
    if (!over) return;
    const dragId = String(active.id).replace("child-", "");
    const dropRawId = String(over.id).replace("childDrop-", "");
    if (dragId === dropRawId) return;
    onDrop(dragId, dropRawId);
  };

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">子ページ</span>
        <button onClick={() => setAddingChildPage(!addingChildPage)}
          className="text-gray-400 hover:text-theme-500 transition" title="子ページ追加">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex flex-wrap gap-1.5">
          {/* ../ parent drop target */}
          <div ref={setParentDropRef}
            className={`flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm transition ${
              isOverParent ? "bg-yellow-50 border-yellow-400 ring-1 ring-yellow-400" : "bg-gray-50 border-gray-200 text-gray-400"
            }`}>
            <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            ../
          </div>
          {childPages.map((cp) => (
            <DraggableChildPage key={cp.id} page={cp} onPageClick={onPageClick} />
          ))}
        </div>
        <DragOverlay>
          {draggedId ? (
            <div className="rounded-lg bg-white px-3 py-1.5 text-sm shadow-lg border border-theme-300">
              {childPages.find((p) => p.id === draggedId)?.name}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {addingChildPage && (
        <div className="mt-1.5 flex gap-1">
          <input
            type="text"
            value={newChildPageName}
            onChange={(e) => setNewChildPageName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); handleCreateChildPage(); }
              if (e.key === "Escape") setAddingChildPage(false);
            }}
            placeholder="子ページ名..."
            autoFocus
            className="flex-1 rounded-lg border border-theme-300 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-theme-400"
          />
          <button onClick={handleCreateChildPage}
            className="rounded-lg bg-theme-500 px-3 py-1 text-sm text-white hover:bg-theme-600 transition">追加</button>
        </div>
      )}
    </div>
  );
}

