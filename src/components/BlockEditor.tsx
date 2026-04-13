"use client";

import React, { useState, useEffect, useCallback, useRef, KeyboardEvent } from "react";

interface Block {
  id: string;
  content: string;
  indent_level: number;
  sort_order: number;
  date: string;
  tag_ids?: string;
}

interface Props {
  viewMode: "date" | "tag" | "admin";
  selectedDate: string;
  selectedTagId: string | null;
  onTagClick: (tagId: string, tagName: string) => void;
  onDateClick: (date: string) => void;
  onDataChange: () => void;
}

// Extract #tags from content
function extractTags(content: string): string[] {
  const matches = content.match(/#([^\s#]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

// Render content with clickable tags and markdown
function renderContent(
  content: string,
  onTagClick: (tagId: string, tagName: string) => void,
  onDateClick: (date: string) => void,
  allTags: { id: string; name: string }[]
) {
  // Process inline markdown and tags
  const parts: (string | React.ReactElement)[] = [];
  let remaining = content;
  let key = 0;

  while (remaining.length > 0) {
    // Find tags #tagname
    const tagMatch = remaining.match(/^(.*?)#([^\s#]+)/);
    if (tagMatch) {
      if (tagMatch[1]) {
        parts.push(...renderMarkdown(tagMatch[1], key));
        key += 10;
      }
      const tagName = tagMatch[2];
      const existingTag = allTags.find((t) => t.name === tagName);
      parts.push(
        <span
          key={`tag-${key++}`}
          className="tag-inline"
          onClick={(e) => {
            e.stopPropagation();
            if (existingTag) {
              onTagClick(existingTag.id, existingTag.name);
            }
          }}
        >
          #{tagName}
        </span>
      );
      remaining = remaining.slice(tagMatch[0].length);
      continue;
    }

    // Check for date pattern [[YYYY-MM-DD]]
    const dateMatch = remaining.match(/^(.*?)\[\[(\d{4}-\d{2}-\d{2})\]\]/);
    if (dateMatch) {
      if (dateMatch[1]) {
        parts.push(...renderMarkdown(dateMatch[1], key));
        key += 10;
      }
      const date = dateMatch[2];
      parts.push(
        <span
          key={`date-${key++}`}
          className="date-link"
          onClick={(e) => {
            e.stopPropagation();
            onDateClick(date);
          }}
        >
          {date}
        </span>
      );
      remaining = remaining.slice(dateMatch[0].length);
      continue;
    }

    // No more special tokens
    parts.push(...renderMarkdown(remaining, key));
    break;
  }

  return parts;
}

function renderMarkdown(text: string, startKey: number): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = [];
  let key = startKey;

  // Simple markdown: **bold**, *italic*, `code`, ### headings
  const mdRegex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = mdRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={`md-${key++}`} className="md-bold">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={`md-${key++}`} className="md-italic">{match[3]}</em>);
    } else if (match[4]) {
      parts.push(<code key={`md-${key++}`} className="md-code">{match[4]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  if (parts.length === 0) parts.push(text);
  return parts;
}

export default function BlockEditor({
  viewMode,
  selectedDate,
  selectedTagId,
  onTagClick,
  onDateClick,
  onDataChange,
}: Props) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [allTags, setAllTags] = useState<{ id: string; name: string }[]>([]);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const fetchBlocks = useCallback(async () => {
    setLoading(true);
    let url = "/api/blocks";
    if (viewMode === "tag" && selectedTagId) {
      url += `?tagId=${selectedTagId}`;
    } else {
      url += `?date=${selectedDate}`;
    }
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      setBlocks(data);
    }
    setLoading(false);
  }, [viewMode, selectedDate, selectedTagId]);

  const fetchTags = useCallback(async () => {
    const res = await fetch("/api/tags");
    if (res.ok) {
      setAllTags(await res.json());
    }
  }, []);

  useEffect(() => {
    fetchBlocks();
    fetchTags();
  }, [fetchBlocks, fetchTags]);

  const saveBlocks = useCallback(
    async (updatedBlocks: Block[]) => {
      if (viewMode === "tag") {
        // In tag view, save individual blocks
        for (const block of updatedBlocks) {
          await fetch("/api/blocks", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: block.id,
              content: block.content,
              indent_level: block.indent_level,
              sort_order: block.sort_order,
              tags: extractTags(block.content),
            }),
          });
        }
      } else {
        // In date view, bulk save
        await fetch("/api/blocks/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: selectedDate,
            blocks: updatedBlocks.map((b, i) => ({
              id: b.id,
              content: b.content,
              indent_level: b.indent_level,
              sort_order: i,
              tags: extractTags(b.content),
            })),
          }),
        });
      }
      onDataChange();
    },
    [viewMode, selectedDate, onDataChange]
  );

  const debouncedSave = useCallback(
    (updatedBlocks: Block[]) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => saveBlocks(updatedBlocks), 800);
    },
    [saveBlocks]
  );

  const startEditing = (block: Block) => {
    setEditingBlockId(block.id);
    setEditContent(block.content);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const finishEditing = () => {
    if (!editingBlockId) return;
    const updated = blocks.map((b) =>
      b.id === editingBlockId ? { ...b, content: editContent } : b
    );
    setBlocks(updated);
    setEditingBlockId(null);
    debouncedSave(updated);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, block: Block) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Save current and create new block
      const updated = blocks.map((b) =>
        b.id === block.id ? { ...b, content: editContent } : b
      );
      const idx = updated.findIndex((b) => b.id === block.id);
      const newBlock: Block = {
        id: crypto.randomUUID(),
        content: "",
        indent_level: block.indent_level,
        sort_order: block.sort_order + 1,
        date: block.date,
      };
      updated.splice(idx + 1, 0, newBlock);
      // Reorder
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered);
      setEditingBlockId(newBlock.id);
      setEditContent("");
      debouncedSave(reordered);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const newIndent = e.shiftKey
        ? Math.max(0, block.indent_level - 1)
        : block.indent_level + 1;
      const updated = blocks.map((b) =>
        b.id === block.id ? { ...b, indent_level: newIndent, content: editContent } : b
      );
      setBlocks(updated);
      debouncedSave(updated);
    } else if (
      e.key === "Backspace" &&
      editContent === "" &&
      blocks.length > 1
    ) {
      e.preventDefault();
      const idx = blocks.findIndex((b) => b.id === block.id);
      const updated = blocks.filter((b) => b.id !== block.id);
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered);
      // Focus previous block
      if (idx > 0) {
        const prevBlock = reordered[idx - 1];
        setEditingBlockId(prevBlock.id);
        setEditContent(prevBlock.content);
      }
      debouncedSave(reordered);
    }
  };

  const addNewBlock = () => {
    const newBlock: Block = {
      id: crypto.randomUUID(),
      content: "",
      indent_level: 0,
      sort_order: blocks.length,
      date: selectedDate,
    };
    const updated = [...blocks, newBlock];
    setBlocks(updated);
    startEditing(newBlock);
    debouncedSave(updated);
  };

  // Group blocks by date in tag view
  const groupedByDate =
    viewMode === "tag"
      ? blocks.reduce(
          (acc, block) => {
            if (!acc[block.date]) acc[block.date] = [];
            acc[block.date].push(block);
            return acc;
          },
          {} as Record<string, Block[]>
        )
      : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400">
        読み込み中...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      {viewMode === "tag" && groupedByDate ? (
        // Tag view: blocks grouped by date
        Object.entries(groupedByDate)
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([date, dateBlocks]) => (
            <div key={date} className="mb-6">
              <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
                <span
                  className="date-link cursor-pointer"
                  onClick={() => onDateClick(date)}
                >
                  {date}
                </span>
              </h2>
              <div className="rounded-lg border border-gray-200 bg-white p-3">
                {dateBlocks.map((block) => (
                  <BlockLine
                    key={block.id}
                    block={block}
                    isEditing={editingBlockId === block.id}
                    editContent={editContent}
                    textareaRef={textareaRef}
                    allTags={allTags}
                    onStartEditing={startEditing}
                    onEditContentChange={setEditContent}
                    onFinishEditing={finishEditing}
                    onKeyDown={handleKeyDown}
                    onTagClick={onTagClick}
                    onDateClick={onDateClick}
                  />
                ))}
              </div>
            </div>
          ))
      ) : (
        // Date view: flat list
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          {blocks.map((block) => (
            <BlockLine
              key={block.id}
              block={block}
              isEditing={editingBlockId === block.id}
              editContent={editContent}
              textareaRef={textareaRef}
              allTags={allTags}
              onStartEditing={startEditing}
              onEditContentChange={setEditContent}
              onFinishEditing={finishEditing}
              onKeyDown={handleKeyDown}
              onTagClick={onTagClick}
              onDateClick={onDateClick}
            />
          ))}
          {blocks.length === 0 && (
            <div className="py-4 text-center text-sm text-gray-400">
              ブロックなし。クリックして追加
            </div>
          )}
        </div>
      )}

      {viewMode === "date" && (
        <button
          onClick={addNewBlock}
          className="mt-2 rounded px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          + 新しいブロック
        </button>
      )}
    </div>
  );
}

function BlockLine({
  block,
  isEditing,
  editContent,
  textareaRef,
  allTags,
  onStartEditing,
  onEditContentChange,
  onFinishEditing,
  onKeyDown,
  onTagClick,
  onDateClick,
}: {
  block: Block;
  isEditing: boolean;
  editContent: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  allTags: { id: string; name: string }[];
  onStartEditing: (block: Block) => void;
  onEditContentChange: (content: string) => void;
  onFinishEditing: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>, block: Block) => void;
  onTagClick: (tagId: string, tagName: string) => void;
  onDateClick: (date: string) => void;
}) {
  const indent = block.indent_level * 24;

  // Detect heading
  const headingMatch = block.content.match(/^(#{1,3})\s/);
  let headingClass = "";
  if (headingMatch) {
    const level = headingMatch[1].length;
    headingClass =
      level === 1 ? "md-heading-1" : level === 2 ? "md-heading-2" : "md-heading-3";
  }

  return (
    <div
      className="group flex items-start py-0.5"
      style={{ paddingLeft: `${indent}px` }}
    >
      <span className="mt-1.5 mr-1.5 flex-shrink-0 text-gray-300 text-xs select-none">
        •
      </span>
      {isEditing ? (
        <textarea
          ref={textareaRef}
          value={editContent}
          onChange={(e) => onEditContentChange(e.target.value)}
          onBlur={onFinishEditing}
          onKeyDown={(e) => onKeyDown(e, block)}
          className="block-line flex-1 resize-none border-none bg-blue-50 p-1 text-sm outline-none rounded"
          rows={Math.max(1, editContent.split("\n").length)}
          autoFocus
        />
      ) : (
        <div
          onClick={() => onStartEditing(block)}
          className={`block-line flex-1 cursor-text p-1 text-sm hover:bg-gray-50 rounded ${headingClass}`}
        >
          {block.content ? (
            renderContent(block.content, onTagClick, onDateClick, allTags)
          ) : (
            <span className="text-gray-300">クリックして編集...</span>
          )}
        </div>
      )}
    </div>
  );
}
