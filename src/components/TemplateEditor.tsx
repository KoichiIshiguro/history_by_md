"use client";

import React, { useState, useEffect, useCallback, useRef, KeyboardEvent } from "react";
import { MarkdownContent, PageInfo, TagInfo, Template } from "./BlockEditor";

interface TemplateBlock {
  id: string;
  content: string;
  indent_level: number;
}

interface Props {
  selectedTemplateId: string | null;
  selectedTemplateName: string;
  onSelectTemplate: (id: string, name: string) => void;
  onBack: () => void;
  allPages: PageInfo[];
  allTags: TagInfo[];
  onPageClick: (id: string, name: string) => void;
  onTagClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
}

function contentToBlocks(content: string): TemplateBlock[] {
  if (!content.trim()) return [{ id: crypto.randomUUID(), content: "", indent_level: 0 }];
  return content.split("\n").map((line) => {
    const spaces = line.match(/^( *)/)?.[1]?.length || 0;
    return { id: crypto.randomUUID(), content: line.trimStart(), indent_level: Math.floor(spaces / 2) };
  });
}

function blocksToContent(blocks: TemplateBlock[]): string {
  return blocks.map((b) => "  ".repeat(b.indent_level) + b.content).join("\n");
}

export default function TemplateEditor({
  selectedTemplateId, selectedTemplateName, onSelectTemplate, onBack,
  allPages, allTags, onPageClick, onTagClick, onDateClick,
}: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [blocks, setBlocks] = useState<TemplateBlock[]>([]);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [aiGenerating, setAiGenerating] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<{ blockId: string; text: string } | null>(null);
  const inputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shiftHeldRef = useRef(false);
  const undoStackRef = useRef<TemplateBlock[][]>([]);
  const redoStackRef = useRef<TemplateBlock[][]>([]);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/templates");
    if (res.ok) setTemplates(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  // When a template is selected, load its content into blocks
  useEffect(() => {
    if (!selectedTemplateId) { setBlocks([]); return; }
    const t = templates.find((t) => t.id === selectedTemplateId);
    if (t) {
      setBlocks(contentToBlocks(t.content));
      undoStackRef.current = [];
      redoStackRef.current = [];
    }
  }, [selectedTemplateId, templates]);

  const saveTemplate = useCallback(async (updatedBlocks: TemplateBlock[]) => {
    if (!selectedTemplateId) return;
    const content = blocksToContent(updatedBlocks);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      await fetch("/api/templates", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedTemplateId, name: selectedTemplateName, content }),
      });
    }, 800);
  }, [selectedTemplateId, selectedTemplateName]);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(blocks.map((b) => ({ ...b })));
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, [blocks]);

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const snapshot = undoStackRef.current.pop()!;
    redoStackRef.current.push(blocks.map((b) => ({ ...b })));
    setBlocks(snapshot); setEditingBlockId(null);
    saveTemplate(snapshot);
  }, [blocks, saveTemplate]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const snapshot = redoStackRef.current.pop()!;
    undoStackRef.current.push(blocks.map((b) => ({ ...b })));
    setBlocks(snapshot); setEditingBlockId(null);
    saveTemplate(snapshot);
  }, [blocks, saveTemplate]);

  const autoResizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  const setInputRef = (id: string, el: HTMLTextAreaElement | null) => {
    if (el) {
      inputRefs.current.set(id, el);
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

  const startEditing = (block: TemplateBlock) => {
    if (blurTimeoutRef.current) { clearTimeout(blurTimeoutRef.current); blurTimeoutRef.current = null; }
    if (!editingBlockId || editingBlockId !== block.id) pushUndo();
    if (editingBlockId && editingBlockId !== block.id) {
      const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
      setBlocks(updated); saveTemplate(updated);
    }
    setEditingBlockId(block.id); setEditContent(block.content);
    setTimeout(() => { inputRefs.current.get(block.id)?.focus(); }, 0);
  };

  const finishEditing = () => {
    if (!editingBlockId) return;
    if (aiGenerating || aiResult) {
      setEditingBlockId(null);
      return;
    }
    const updated = blocks.map((b) => b.id === editingBlockId ? { ...b, content: editContent } : b);
    setBlocks(updated); setEditingBlockId(null);
    saveTemplate(updated);
  };

  const handleContentChange = (value: string) => {
    if (!shiftHeldRef.current) value = value.replace(/\n/g, "");
    setEditContent(value);
  };

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>, block: TemplateBlock, blockIndex: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text || !text.includes("\n")) return;
    e.preventDefault();
    pushUndo();
    const textarea = e.currentTarget;
    const cursorPos = textarea.selectionStart ?? 0;
    const selEnd = textarea.selectionEnd ?? cursorPos;
    const before = editContent.slice(0, cursorPos);
    const after = editContent.slice(selEnd);
    const lines = text.split("\n");
    const firstContent = before + lines[0];
    const lastLineContent = lines[lines.length - 1] + after;
    const updated = blocks.map((b) => b.id === block.id ? { ...b, content: firstContent } : b);
    const newBlocks: TemplateBlock[] = [];
    for (let i = 1; i < lines.length; i++) {
      newBlocks.push({ id: crypto.randomUUID(), content: i === lines.length - 1 ? lastLineContent : lines[i], indent_level: block.indent_level });
    }
    updated.splice(blockIndex + 1, 0, ...newBlocks);
    setBlocks(updated);
    const lastBlock = newBlocks[newBlocks.length - 1];
    const cursorAt = lines[lines.length - 1].length;
    setEditingBlockId(lastBlock.id); setEditContent(lastBlock.content);
    setTimeout(() => { const el = inputRefs.current.get(lastBlock.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorAt; } }, 0);
    saveTemplate(updated);
  }, [blocks, editContent, pushUndo, saveTemplate]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, block: TemplateBlock, blockIndex: number) => {
    if (e.key === "Shift") shiftHeldRef.current = true;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const textarea = e.currentTarget;
    const cursorPos = textarea.selectionStart ?? 0;
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (meta && e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); return; }

    if (e.key === "Enter") {
      const lines = editContent.slice(0, cursorPos).split("\n");
      const openFences = lines.filter((l) => l.trimStart().startsWith("```")).length;
      if (openFences % 2 === 1) return;

      // !ai prompt detection
      const aiMatch = editContent.match(/^!ai\s+(.+)$/i);
      if (aiMatch) {
        e.preventDefault();
        const prompt = aiMatch[1];
        setAiGenerating(block.id);
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
      const updated = blocks.map((b) => b.id === block.id ? { ...b, content: before } : b);
      const newBlock: TemplateBlock = { id: crypto.randomUUID(), content: after, indent_level: block.indent_level };
      updated.splice(blockIndex + 1, 0, newBlock);
      setBlocks(updated); setEditContent(after); setEditingBlockId(newBlock.id);
      setTimeout(() => { const el = inputRefs.current.get(newBlock.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = 0; } }, 0);
      saveTemplate(updated);
    } else if (e.key === "Tab") {
      e.preventDefault(); pushUndo();
      const newIndent = e.shiftKey ? Math.max(0, block.indent_level - 1) : block.indent_level + 1;
      const updated = blocks.map((b) => b.id === block.id ? { ...b, indent_level: newIndent, content: editContent } : b);
      setBlocks(updated); saveTemplate(updated);
    } else if (e.key === "ArrowUp" && cursorPos === 0) {
      e.preventDefault();
      if (blockIndex > 0) { const prev = blocks[blockIndex - 1]; setBlocks(blocks.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(prev.id, prev.content.length); }
    } else if (e.key === "ArrowDown" && cursorPos === editContent.length) {
      e.preventDefault();
      if (blockIndex < blocks.length - 1) { const next = blocks[blockIndex + 1]; setBlocks(blocks.map((b) => b.id === block.id ? { ...b, content: editContent } : b)); focusBlock(next.id, 0); }
    } else if (e.key === "Backspace" && cursorPos === 0 && (textarea.selectionEnd ?? 0) === 0 && blockIndex > 0) {
      e.preventDefault(); pushUndo();
      const prev = blocks[blockIndex - 1];
      const merged = prev.content + editContent;
      const cursorAt = prev.content.length;
      const updated = blocks.map((b) => b.id === prev.id ? { ...b, content: merged } : b).filter((b) => b.id !== block.id);
      setBlocks(updated); setEditContent(merged); setEditingBlockId(prev.id);
      setTimeout(() => { const el = inputRefs.current.get(prev.id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorAt; } }, 0);
      saveTemplate(updated);
    }
  };

  const addNewBlock = () => {
    pushUndo();
    const newBlock: TemplateBlock = { id: crypto.randomUUID(), content: "", indent_level: 0 };
    const updated = [...blocks, newBlock];
    setBlocks(updated); startEditing(newBlock); saveTemplate(updated);
  };

  const handleContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (meta && e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); return; }
  };

  const createTemplate = async () => {
    if (!newName.trim()) return;
    const res = await fetch("/api/templates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), content: "" }),
    });
    if (res.ok) {
      const data = await res.json();
      await fetchTemplates();
      onSelectTemplate(data.id, data.name);
      setAddingNew(false); setNewName("");
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await fetch("/api/templates", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deleteTarget.id }),
    });
    setDeleteTarget(null);
    if (selectedTemplateId === deleteTarget.id) onBack();
    fetchTemplates();
  };

  const renameTemplate = async (name: string) => {
    if (!name.trim() || !selectedTemplateId) return;
    const t = templates.find((t) => t.id === selectedTemplateId);
    if (!t) return;
    await fetch("/api/templates", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: selectedTemplateId, name: name.trim(), content: t.content }),
    });
    onSelectTemplate(selectedTemplateId, name.trim());
    fetchTemplates();
  };

  if (loading) {
    return <div className="flex items-center justify-center py-8 text-gray-400">読み込み中...</div>;
  }

  // Template list view
  if (!selectedTemplateId) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">テンプレート</h2>
          <button
            onClick={() => setAddingNew(true)}
            className="flex items-center gap-1.5 rounded-lg bg-theme-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-theme-600 transition"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            新規作成
          </button>
        </div>

        {addingNew && (
          <div className="mb-4 flex items-center gap-2">
            <input
              type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="テンプレート名..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); createTemplate(); }
                if (e.key === "Escape") { setAddingNew(false); setNewName(""); }
              }}
              autoFocus
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-theme-300 focus:ring-1 focus:ring-theme-400"
            />
            <button onClick={createTemplate} className="rounded-lg bg-theme-500 px-3 py-2 text-sm font-medium text-white hover:bg-theme-600">作成</button>
            <button onClick={() => { setAddingNew(false); setNewName(""); }} className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          </div>
        )}

        {templates.length === 0 && !addingNew && (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
            </svg>
            <p className="text-sm text-gray-500">テンプレートがありません</p>
            <p className="text-xs text-gray-400 mt-1">「新規作成」でテンプレートを作成しましょう</p>
          </div>
        )}

        <div className="space-y-1">
          {templates.map((t) => (
            <div key={t.id} className="group flex items-center rounded-lg border border-gray-200 bg-white hover:border-theme-200 transition">
              <button
                onClick={() => onSelectTemplate(t.id, t.name)}
                className="flex-1 flex items-center gap-3 px-4 py-3 text-left"
              >
                <svg className="h-5 w-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-gray-800">{t.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5 truncate max-w-md">
                    {t.content ? t.content.split("\n")[0].slice(0, 60) + (t.content.length > 60 ? "..." : "") : "空のテンプレート"}
                  </p>
                </div>
              </button>
              <button
                onClick={() => setDeleteTarget(t)}
                className="hidden group-hover:flex items-center justify-center h-8 w-8 mr-3 rounded text-gray-400 hover:bg-red-50 hover:text-red-500"
                title="削除"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* Delete confirmation */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setDeleteTarget(null)} />
            <div className="relative mx-4 w-full max-w-xs animate-modal-in rounded-xl bg-white p-5 shadow-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50">
                  <svg className="h-5 w-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">テンプレートを削除</h3>
                  <p className="text-xs text-gray-500">この操作は取り消せません</p>
                </div>
              </div>
              <p className="mb-5 text-sm text-gray-600"><strong>{deleteTarget.name}</strong> を削除しますか？</p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteTarget(null)} className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50">キャンセル</button>
                <button onClick={confirmDelete} className="flex-1 rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-600">削除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Template editor view (block-editor style)
  return (
    <div className="mx-auto max-w-3xl outline-none" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === "Shift") shiftHeldRef.current = true; handleContainerKeyDown(e); }}
      onKeyUp={(e) => { if (e.key === "Shift") shiftHeldRef.current = false; }}>
      {/* Back + title */}
      <div className="mb-4 flex items-center gap-2">
        <button onClick={onBack} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="一覧に戻る">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {editingTitle ? (
          <input
            type="text" value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => { if (titleDraft.trim()) renameTemplate(titleDraft); setEditingTitle(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
              if (e.key === "Escape") setEditingTitle(false);
            }}
            autoFocus
            className="flex-1 text-xl font-bold text-gray-800 bg-theme-50 border border-theme-300 rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-theme-400"
          />
        ) : (
          <h2
            className="text-xl font-bold text-gray-800 cursor-pointer hover:text-theme-600 transition"
            onClick={() => { setTitleDraft(selectedTemplateName); setEditingTitle(true); }}
            title="クリックで名前変更"
          >
            {selectedTemplateName}
          </h2>
        )}
      </div>

      {/* Block editor */}
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        {blocks.map((block, i) => {
          const indent = block.indent_level * 24;
          const isEditing = editingBlockId === block.id;
          return (
            <div
              key={block.id}
              className={`group relative flex items-stretch min-h-[2em] ${!isEditing ? "cursor-text hover:bg-gray-50 rounded" : ""}`}
              style={{ paddingLeft: `${indent}px` }}
              onMouseUp={() => { if (!isEditing) startEditing(block); }}
            >
              {aiGenerating === block.id ? (
                <div className="flex items-center gap-2 p-1 text-sm text-gray-500">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  AI生成中...
                  <button onClick={() => setAiGenerating(null)} className="ml-2 text-xs text-red-400 hover:text-red-600">キャンセル</button>
                </div>
              ) : isEditing ? (
                <div className="relative flex-1">
                  <textarea
                    ref={(el) => setInputRef(block.id, el)}
                    value={editContent}
                    onChange={(e) => { handleContentChange(e.target.value); requestAnimationFrame(() => { const ta = e.target as HTMLTextAreaElement; if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; } }); }}
                    onBlur={() => { blurTimeoutRef.current = setTimeout(finishEditing, 150); }}
                    onKeyDown={(e) => handleKeyDown(e, block, i)}
                    onPaste={(e) => handlePaste(e, block, i)}
                    className="block-line w-full resize-none border-none bg-blue-50 p-1 text-sm outline-none rounded leading-snug overflow-hidden"
                    rows={1}
                    autoFocus
                  />
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
        })}
        {blocks.length === 0 && (
          <div className="py-4 cursor-text text-sm text-gray-300 min-h-[2em]" onClick={addNewBlock}>&nbsp;</div>
        )}
      </div>

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
                  const updated = blocks.map((b) => b.id === block.id ? { ...b, content: lines[0] } : b);
                  const newBlocks: TemplateBlock[] = [];
                  for (let i = 1; i < lines.length; i++) {
                    if (lines[i] === "" && i < lines.length - 1) continue;
                    newBlocks.push({
                      id: crypto.randomUUID(),
                      content: lines[i],
                      indent_level: block.indent_level,
                    });
                  }
                  if (newBlocks.length > 0) updated.splice(blockIndex + 1, 0, ...newBlocks);
                  setBlocks(updated);
                  setEditContent(lines[0]);
                  setEditingBlockId(block.id);
                  saveTemplate(updated);
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
