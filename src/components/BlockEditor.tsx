"use client";

import React, {
  useState, useEffect, useCallback, useRef, KeyboardEvent, useMemo,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

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
}

export interface PageInfo { id: string; name: string; parent_id?: string | null; ref_count?: number; full_path?: string; }
export interface TagInfo { id: string; name: string; block_count?: number; }

interface Props {
  viewMode: "date" | "page" | "tag" | "admin" | "actions";
  selectedDate: string;
  selectedPageId: string | null;
  selectedPageName: string;
  selectedTagId: string | null;
  selectedTagName: string;
  allPages: PageInfo[];
  allTags: TagInfo[];
  onPageClick: (pageId: string, pageName: string) => void;
  onTagClick: (tagId: string, tagName: string) => void;
  onDateClick: (date: string) => void;
  onDataChange: () => void;
}

// Pre-process custom syntax into HTML spans before markdown rendering
export function preprocessCustomSyntax(content: string, allPages: PageInfo[], allTags: TagInfo[]): string {
  let result = content;

  // {{page/path}} → HTML span
  result = result.replace(/\{\{([^}]+)\}\}/g, (_match, pageName: string) => {
    const trimmed = pageName.trim();
    // Match by full_path first, then by name for backwards compat
    const page = allPages.find((p) => p.full_path === trimmed) || allPages.find((p) => p.name === trimmed);
    const dataId = page ? page.id : "";
    return `<span class="page-link" data-page-id="${dataId}" data-page-name="${trimmed}">${trimmed}</span>`;
  });

  // !action / !done prefix → styled span
  result = result.replace(/^!(action)\s/i, '<span class="action-flag action-open">!action</span> ');
  result = result.replace(/^!(done)\s/i, '<span class="action-flag action-done">!done</span> ');

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
  content, allPages, allTags, onPageClick, onTagClick, onDateClick,
}: {
  content: string;
  allPages: PageInfo[];
  allTags: TagInfo[];
  onPageClick: (id: string, name: string) => void;
  onTagClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
}) {
  const processed = useMemo(() => preprocessCustomSyntax(content, allPages, allTags), [content, allPages, allTags]);

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
        // Custom span handler for our custom syntax
        span({ className, children, ...props }) {
          const dataProps = props as Record<string, string>;
          if (className === "page-link") {
            return (
              <span className="page-link" onClick={(e) => {
                e.stopPropagation();
                const pageId = dataProps["data-page-id"];
                const pageName = dataProps["data-page-name"];
                if (pageId && pageName) onPageClick(pageId, pageName);
              }}>
                {children}
              </span>
            );
          }
          if (className === "tag-inline") {
            return (
              <span className="tag-inline" onClick={(e) => {
                e.stopPropagation();
                const tagId = dataProps["data-tag-id"];
                const tagName = dataProps["data-tag-name"];
                if (tagId && tagName) onTagClick(tagId, tagName);
              }}>
                {children}
              </span>
            );
          }
          if (className === "date-link") {
            return (
              <span className="date-link" onClick={(e) => {
                e.stopPropagation();
                const date = dataProps["data-date"];
                if (date) onDateClick(date);
              }}>
                {children}
              </span>
            );
          }
          return <span className={className} {...props}>{children}</span>;
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}

export default function BlockEditor({
  viewMode, selectedDate, selectedPageId, selectedPageName,
  selectedTagId, selectedTagName, allPages, allTags,
  onPageClick, onTagClick, onDateClick, onDataChange,
}: Props) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [pageRefs, setPageRefs] = useState<Block[]>([]);
  const [dateRefs, setDateRefs] = useState<Block[]>([]);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<{ type: "tag" | "page"; items: { id: string; name: string }[] }>({ type: "tag", items: [] });
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
  const [editingPageTitle, setEditingPageTitle] = useState(false);
  const [pageTitleDraft, setPageTitleDraft] = useState("");
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const shiftHeldRef = useRef(false);

  const fetchBlocks = useCallback(async () => {
    setLoading(true);
    let url = "/api/blocks";
    if (viewMode === "page" && selectedPageId) {
      url += `?pageId=${selectedPageId}`;
    } else if (viewMode === "tag" && selectedTagId) {
      url += `?tagId=${selectedTagId}`;
    } else {
      url += `?date=${selectedDate}`;
    }
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (viewMode === "page" && data.pageBlocks !== undefined) {
        setBlocks(data.pageBlocks);
        setPageRefs(data.pageRefs || []);
        setDateRefs(data.dateRefs || []);
      } else if (viewMode === "tag") {
        setBlocks(data);
        setPageRefs([]);
        setDateRefs([]);
      } else {
        setBlocks(data);
        setPageRefs([]);
        setDateRefs([]);
      }
    }
    setLoading(false);
  }, [viewMode, selectedDate, selectedPageId, selectedTagId]);

  useEffect(() => { fetchBlocks(); }, [fetchBlocks]);

  const saveBlocks = useCallback(async (updatedBlocks: Block[]) => {
    if (viewMode === "page" && selectedPageId) {
      await fetch("/api/blocks/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId: selectedPageId, blocks: updatedBlocks.map((b, i) => ({ id: b.id, content: b.content, indent_level: b.indent_level, sort_order: i })) }),
      });
    } else if (viewMode === "tag") {
      for (const block of updatedBlocks) {
        await fetch("/api/blocks", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: block.id, content: block.content, indent_level: block.indent_level, sort_order: block.sort_order }),
        });
      }
    } else {
      await fetch("/api/blocks/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: selectedDate, blocks: updatedBlocks.map((b, i) => ({ id: b.id, content: b.content, indent_level: b.indent_level, sort_order: i })) }),
      });
    }
    onDataChange();
  }, [viewMode, selectedDate, selectedPageId, onDataChange]);

  const debouncedSave = useCallback((updatedBlocks: Block[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => saveBlocks(updatedBlocks), 800);
  }, [saveBlocks]);

  const refSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedRefSave = useCallback((block: Block) => {
    if (refSaveTimeoutRef.current) clearTimeout(refSaveTimeoutRef.current);
    refSaveTimeoutRef.current = setTimeout(async () => {
      await fetch("/api/blocks", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: block.id, content: block.content, indent_level: block.indent_level, sort_order: block.sort_order }),
      });
      onDataChange();
    }, 800);
  }, [onDataChange]);

  const clearSelection = useCallback(() => { setSelectedBlockIds(new Set()); setSelectionAnchor(null); }, []);

  const selectRange = useCallback((from: number, to: number) => {
    const start = Math.min(from, to), end = Math.max(from, to);
    const ids = new Set<string>();
    for (let i = start; i <= end; i++) if (blocks[i]) ids.add(blocks[i].id);
    setSelectedBlockIds(ids);
  }, [blocks]);

  const deleteSelectedBlocks = useCallback(() => {
    if (selectedBlockIds.size === 0) return;
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
  }, [blocks, selectedBlockIds, selectedDate, viewMode, clearSelection, debouncedSave]);

  const copySelectedBlocks = useCallback(async (cut: boolean) => {
    if (selectedBlockIds.size === 0) return;
    const texts = blocks.filter((b) => selectedBlockIds.has(b.id)).map((b) => "  ".repeat(b.indent_level) + b.content);
    await navigator.clipboard.writeText(texts.join("\n"));
    if (cut) deleteSelectedBlocks();
  }, [blocks, selectedBlockIds, deleteSelectedBlocks]);

  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingBlockId) return;
    if (selectedBlockIds.size === 0) return;
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteSelectedBlocks(); return; }
    if (meta && e.key === "c") { e.preventDefault(); copySelectedBlocks(false); return; }
    if (meta && e.key === "x") { e.preventDefault(); copySelectedBlocks(true); return; }
    if (meta && e.key === "a") { e.preventDefault(); setSelectedBlockIds(new Set(blocks.map((b) => b.id))); setSelectionAnchor(0); return; }
    if (e.key === "Escape") { clearSelection(); return; }
  }, [editingBlockId, selectedBlockIds, blocks, deleteSelectedBlocks, copySelectedBlocks, clearSelection]);

  const handleBlockMouseDown = useCallback((e: React.MouseEvent, blockIndex: number) => {
    if (editingBlockId === blocks[blockIndex]?.id) return;
    if (e.shiftKey && selectionAnchor !== null) { e.preventDefault(); selectRange(selectionAnchor, blockIndex); return; }
    if (!e.shiftKey) { clearSelection(); setSelectionAnchor(blockIndex); }
  }, [editingBlockId, blocks, selectionAnchor, selectRange, clearSelection]);

  const setInputRef = (id: string, el: HTMLTextAreaElement | null) => {
    if (el) inputRefs.current.set(id, el); else inputRefs.current.delete(id);
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
    // Save current editing block before switching
    if (editingBlockId && editingBlockId !== block.id) {
      const refBlock = [...pageRefs, ...dateRefs].find((b) => b.id === editingBlockId);
      if (refBlock) {
        const updated = { ...refBlock, content: editContent };
        setPageRefs(pageRefs.map((b) => b.id === editingBlockId ? updated : b));
        setDateRefs(dateRefs.map((b) => b.id === editingBlockId ? updated : b));
        debouncedRefSave(updated);
      } else {
        const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
        setBlocks(updated);
        debouncedSave(updated);
      }
    }
    setEditingBlockId(block.id); setEditContent(block.content); setShowSuggestions(false);
    setTimeout(() => { inputRefs.current.get(block.id)?.focus(); }, 0);
  };

  const finishEditing = () => {
    if (!editingBlockId) return;
    const refBlock = [...pageRefs, ...dateRefs].find((b) => b.id === editingBlockId);
    if (refBlock) {
      const updated = { ...refBlock, content: editContent };
      setPageRefs(pageRefs.map((b) => b.id === editingBlockId ? updated : b));
      setDateRefs(dateRefs.map((b) => b.id === editingBlockId ? updated : b));
      setEditingBlockId(null); setShowSuggestions(false);
      debouncedRefSave(updated); return;
    }
    const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
    setBlocks(updated); setEditingBlockId(null); setShowSuggestions(false);
    debouncedSave(updated);
  };

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
    setShowSuggestions(false);
  };

  const applySuggestion = (name: string) => {
    if (suggestions.type === "page") {
      const newContent = editContent.replace(/\{\{([^}]*)$/, `{{${name}}} `);
      setEditContent(newContent);
    } else {
      const newContent = editContent.replace(/#([^\s#{}]*)$/, `#${name} `);
      setEditContent(newContent);
    }
    setShowSuggestions(false);
  };

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
      e.preventDefault();
      const before = editContent.slice(0, cursorPos);
      const after = editContent.slice(cursorPos);
      const updated = blocks.map((b) => b.id === block.id ? { ...b, content: before } : b);
      const newBlock: Block = { id: crypto.randomUUID(), content: after, indent_level: block.indent_level, sort_order: block.sort_order + 1, date: block.date };
      updated.splice(blockIndex + 1, 0, newBlock);
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered); setEditContent(after); setEditingBlockId(newBlock.id);
      setTimeout(() => { const el = inputRefs.current.get(newBlock.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = 0; } }, 0);
      debouncedSave(reordered);
    } else if (e.key === "Tab") {
      e.preventDefault();
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

  const handleRefKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, block: Block) => {
    if (e.key === "Shift") shiftHeldRef.current = true;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (showSuggestions) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedSuggestion((p) => Math.min(p + 1, suggestions.items.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedSuggestion((p) => Math.max(p - 1, 0)); return; }
      if (e.key === "Tab" || e.key === "Enter") { if (suggestions.items[selectedSuggestion]) { e.preventDefault(); applySuggestion(suggestions.items[selectedSuggestion].name); return; } }
      if (e.key === "Escape") { setShowSuggestions(false); return; }
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const newIndent = e.shiftKey ? Math.max(0, block.indent_level - 1) : block.indent_level + 1;
      const updated = { ...block, indent_level: newIndent, content: editContent };
      setPageRefs(pageRefs.map((b) => b.id === block.id ? updated : b));
      setDateRefs(dateRefs.map((b) => b.id === block.id ? updated : b));
      debouncedRefSave(updated);
    }
    if (e.key === "Enter") {
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart ?? 0;
      // Check unclosed code fence
      const lines = editContent.slice(0, cursorPos).split("\n");
      const openFences = lines.filter((l) => l.trimStart().startsWith("```")).length;
      if (openFences % 2 === 1) return; // inside code block, allow newline

      e.preventDefault();
      const before = editContent.slice(0, cursorPos);
      const after = editContent.slice(cursorPos);

      // Update current block content
      const updatedBlock = { ...block, content: before };

      // Create new block in the same context (same date / page_id)
      const newBlock: Block = {
        id: crypto.randomUUID(),
        content: after,
        indent_level: block.indent_level,
        sort_order: block.sort_order + 1,
        date: block.date,
        page_id: block.page_id,
        source_page_name: block.source_page_name,
        source_page_id: block.source_page_id,
      };

      // Insert into the correct ref list
      const isPageRef = pageRefs.some((b) => b.id === block.id);
      if (isPageRef) {
        const idx = pageRefs.findIndex((b) => b.id === block.id);
        const updated = [...pageRefs];
        updated[idx] = updatedBlock;
        updated.splice(idx + 1, 0, newBlock);
        setPageRefs(updated);
      } else {
        const idx = dateRefs.findIndex((b) => b.id === block.id);
        const updated = [...dateRefs];
        updated[idx] = updatedBlock;
        updated.splice(idx + 1, 0, newBlock);
        setDateRefs(updated);
      }

      setEditContent(after);
      setEditingBlockId(newBlock.id);
      setTimeout(() => {
        const el = inputRefs.current.get(newBlock.id);
        if (el) { el.focus(); el.selectionStart = el.selectionEnd = 0; }
      }, 0);

      // Save both blocks
      debouncedRefSave(updatedBlock);
      // Save new block via POST to create it on server
      fetch("/api/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newBlock.id,
          content: newBlock.content,
          indent_level: newBlock.indent_level,
          sort_order: newBlock.sort_order,
          date: newBlock.date,
          page_id: newBlock.page_id || null,
        }),
      }).then(() => onDataChange());
    }
  };

  const addNewBlock = () => {
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

  const groupedTagBlocks = viewMode === "tag" ? blocks.reduce((acc, b) => {
    const key = b.date || "no-date";
    if (!acc[key]) acc[key] = [];
    acc[key].push(b);
    return acc;
  }, {} as Record<string, Block[]>) : null;

  if (loading) {
    return <div className="flex items-center justify-center py-8 text-gray-400">読み込み中...</div>;
  }

  const blockLineProps = (block: Block, blockIndex: number, isRef = false) => ({
    block, blockIndex,
    isEditing: editingBlockId === block.id,
    isSelected: selectedBlockIds.has(block.id),
    editContent, showSuggestions: showSuggestions && editingBlockId === block.id,
    suggestions, selectedSuggestion,
    allPages, allTags,
    setInputRef, onStartEditing: startEditing,
    onEditContentChange: handleContentChange,
    onFinishEditing: () => { blurTimeoutRef.current = setTimeout(finishEditing, 150); },
    onKeyDown: isRef ? ((e: KeyboardEvent<HTMLTextAreaElement>, b: Block, _i: number) => handleRefKeyDown(e, b)) : handleKeyDown,
    onPageClick, onTagClick, onDateClick, onApplySuggestion: applySuggestion,
    onBlockMouseDown: isRef ? (() => {}) : handleBlockMouseDown,
  });

  return (
    <div ref={containerRef} className="mx-auto max-w-3xl outline-none" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === "Shift") shiftHeldRef.current = true; handleContainerKeyDown(e); }}
      onKeyUp={(e) => { if (e.key === "Shift") shiftHeldRef.current = false; }}>
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
                className="w-full text-xl font-bold text-gray-800 bg-orange-50 border border-orange-300 rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-orange-400"
              />
            ) : (
              <h2
                className="text-xl font-bold text-gray-800 cursor-pointer hover:text-orange-600 transition px-1"
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

          {/* Child pages */}
          {(() => {
            const childPages = allPages.filter((p) => p.parent_id === selectedPageId);
            if (childPages.length === 0) return null;
            return (
              <div className="mb-4 rounded-lg border border-gray-200 bg-white">
                <ul className="divide-y divide-gray-100">
                  {childPages.map((cp) => (
                    <li key={cp.id}>
                      <button
                        onClick={() => onPageClick(cp.id, cp.name)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-700 transition text-left"
                      >
                        <svg className="h-4 w-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        {cp.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          {/* Page content */}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            {blocks.map((block, i) => <BlockLine key={block.id} {...blockLineProps(block, i)} />)}
            {blocks.length === 0 && (
              <div className="py-4 cursor-text text-sm text-gray-300 min-h-[2em]" onClick={addNewBlock}>&nbsp;</div>
            )}
          </div>
          <button onClick={addNewBlock} className="mt-2 rounded px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600">+ 新しいブロック</button>

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
          {Object.entries(groupedTagBlocks).sort(([a], [b]) => b.localeCompare(a)).map(([date, dateBlocks]) => (
            <div key={date} className="mb-6">
              <h2 className="mb-2 text-sm font-medium">
                <span className="date-link cursor-pointer" onClick={() => onDateClick(date)}>{date}</span>
              </h2>
              <div className="rounded-lg border border-gray-200 bg-white p-3">
                {dateBlocks.map((b) => <BlockLine key={b.id} {...blockLineProps(b, 0, true)} />)}
              </div>
            </div>
          ))}
          {blocks.length === 0 && <p className="text-sm text-gray-400 py-4">このタグを含むブロックはありません</p>}
        </>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            {blocks.map((block, i) => <BlockLine key={block.id} {...blockLineProps(block, i)} />)}
            {blocks.length === 0 && (
              <div className="py-4 cursor-text text-sm text-gray-300 min-h-[2em]" onClick={addNewBlock}>&nbsp;</div>
            )}
          </div>
          <button onClick={addNewBlock} className="mt-2 rounded px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600">+ 新しいブロック</button>
        </>
      )}
    </div>
  );
}

function BlockLine({ block, blockIndex, isEditing, isSelected, editContent, showSuggestions,
  suggestions, selectedSuggestion, allPages, allTags, setInputRef, onStartEditing,
  onEditContentChange, onFinishEditing, onKeyDown, onPageClick, onTagClick, onDateClick,
  onApplySuggestion, onBlockMouseDown,
}: {
  block: Block; blockIndex: number; isEditing: boolean; isSelected: boolean;
  editContent: string; showSuggestions: boolean;
  suggestions: { type: "tag" | "page"; items: { id: string; name: string }[] };
  selectedSuggestion: number; allPages: PageInfo[]; allTags: TagInfo[];
  setInputRef: (id: string, el: HTMLTextAreaElement | null) => void;
  onStartEditing: (block: Block) => void; onEditContentChange: (c: string) => void;
  onFinishEditing: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>, block: Block, blockIndex: number) => void;
  onPageClick: (id: string, name: string) => void;
  onTagClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
  onApplySuggestion: (name: string) => void;
  onBlockMouseDown: (e: React.MouseEvent, blockIndex: number) => void;
}) {
  const indent = block.indent_level * 24;

  return (
    <div className={`group relative flex items-stretch min-h-[2em] ${isSelected ? "bg-blue-100 rounded" : ""} ${!isEditing ? "cursor-text hover:bg-gray-50 rounded" : ""}`}
      style={{ paddingLeft: `${indent}px` }}
      onMouseDown={(e) => onBlockMouseDown(e, blockIndex)}
      onMouseUp={(e) => {
        if (isEditing) return;
        // Don't enter edit mode if clicking on a link (page, tag, date)
        const target = e.target as HTMLElement;
        if (target.closest('.page-link, .tag-inline, .date-link, .gfm-link')) return;
        onStartEditing(block);
      }}>
      {isEditing ? (
        <div className="relative flex-1">
          <textarea ref={(el) => setInputRef(block.id, el)}
            value={editContent} onChange={(e) => onEditContentChange(e.target.value)}
            onBlur={onFinishEditing}
            onKeyDown={(e) => onKeyDown(e, block, blockIndex)}
            className="block-line w-full resize-none border-none bg-blue-50 p-1 text-sm outline-none rounded leading-snug"
            rows={Math.max(1, editContent.split("\n").length)} autoFocus />
          {showSuggestions && (
            <div className="absolute left-0 top-full z-10 mt-1 min-w-56 max-w-md rounded border border-gray-200 bg-white shadow-lg">
              {suggestions.items.map((item, i) => (
                <button key={item.id}
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === selectedSuggestion ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-50"}`}
                  onMouseDown={(e) => { e.preventDefault(); onApplySuggestion(item.name); }}>
                  {suggestions.type === "page" ? (
                    <span className="page-link text-xs">{item.name}</span>
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
            ? <MarkdownContent content={block.content} allPages={allPages} allTags={allTags}
                onPageClick={onPageClick} onTagClick={onTagClick} onDateClick={onDateClick} />
            : "\u00A0"}
        </div>
      )}
    </div>
  );
}

