"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  KeyboardEvent,
} from "react";

interface Block {
  id: string;
  content: string;
  indent_level: number;
  sort_order: number;
  date: string;
  tag_ids?: string;
  tag_id?: string | null;
  is_page_block?: number;
}

interface TagInfo {
  id: string;
  name: string;
  parent_id?: string | null;
  block_count?: number;
}

interface Props {
  viewMode: "date" | "tag" | "admin";
  selectedDate: string;
  selectedTagId: string | null;
  selectedTagName: string;
  allTags: TagInfo[];
  onTagClick: (tagId: string, tagName: string) => void;
  onDateClick: (date: string) => void;
  onDataChange: () => void;
}

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
  allTags: TagInfo[]
) {
  const parts: (string | React.ReactElement)[] = [];
  let remaining = content;
  let key = 0;

  while (remaining.length > 0) {
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
            if (existingTag) onTagClick(existingTag.id, existingTag.name);
          }}
        >
          #{tagName}
        </span>
      );
      remaining = remaining.slice(tagMatch[0].length);
      continue;
    }

    const dateMatch = remaining.match(/^(.*?)\[\[(\d{4}-\d{2}-\d{2})\]\]/);
    if (dateMatch) {
      if (dateMatch[1]) {
        parts.push(...renderMarkdown(dateMatch[1], key));
        key += 10;
      }
      parts.push(
        <span
          key={`date-${key++}`}
          className="date-link"
          onClick={(e) => {
            e.stopPropagation();
            onDateClick(dateMatch[2]);
          }}
        >
          {dateMatch[2]}
        </span>
      );
      remaining = remaining.slice(dateMatch[0].length);
      continue;
    }

    parts.push(...renderMarkdown(remaining, key));
    break;
  }

  return parts;
}

function renderMarkdown(
  text: string,
  startKey: number
): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = [];
  let key = startKey;
  const mdRegex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = mdRegex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2])
      parts.push(
        <strong key={`md-${key++}`} className="md-bold">
          {match[2]}
        </strong>
      );
    else if (match[3])
      parts.push(
        <em key={`md-${key++}`} className="md-italic">
          {match[3]}
        </em>
      );
    else if (match[4])
      parts.push(
        <code key={`md-${key++}`} className="md-code">
          {match[4]}
        </code>
      );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  if (parts.length === 0) parts.push(text);
  return parts;
}

export default function BlockEditor({
  viewMode,
  selectedDate,
  selectedTagId,
  selectedTagName,
  allTags,
  onTagClick,
  onDateClick,
  onDataChange,
}: Props) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [refBlocks, setRefBlocks] = useState<Block[]>([]);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState<TagInfo[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

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
      if (viewMode === "tag" && data.pageBlocks !== undefined) {
        setBlocks(data.pageBlocks);
        setRefBlocks(data.refBlocks || []);
      } else {
        setBlocks(data);
        setRefBlocks([]);
      }
    }
    setLoading(false);
  }, [viewMode, selectedDate, selectedTagId]);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  const saveBlocks = useCallback(
    async (updatedBlocks: Block[]) => {
      if (viewMode === "tag" && selectedTagId) {
        await fetch("/api/blocks/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tagId: selectedTagId,
            blocks: updatedBlocks.map((b, i) => ({
              id: b.id,
              content: b.content,
              indent_level: b.indent_level,
              sort_order: i,
            })),
          }),
        });
      } else {
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
            })),
          }),
        });
      }
      onDataChange();
    },
    [viewMode, selectedDate, selectedTagId, onDataChange]
  );

  // Save a single ref block via PUT (for editing date-referenced blocks in tag view)
  const saveRefBlock = useCallback(
    async (block: Block) => {
      await fetch("/api/blocks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: block.id,
          content: block.content,
          indent_level: block.indent_level,
          sort_order: block.sort_order,
        }),
      });
      onDataChange();
    },
    [onDataChange]
  );

  const debouncedSave = useCallback(
    (updatedBlocks: Block[]) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => saveBlocks(updatedBlocks), 800);
    },
    [saveBlocks]
  );

  const refSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedRefSave = useCallback(
    (block: Block) => {
      if (refSaveTimeoutRef.current) clearTimeout(refSaveTimeoutRef.current);
      refSaveTimeoutRef.current = setTimeout(() => saveRefBlock(block), 800);
    },
    [saveRefBlock]
  );

  const clearSelection = useCallback(() => {
    setSelectedBlockIds(new Set());
    setSelectionAnchor(null);
  }, []);

  const selectRange = useCallback(
    (fromIndex: number, toIndex: number) => {
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const ids = new Set<string>();
      for (let i = start; i <= end; i++) {
        if (blocks[i]) ids.add(blocks[i].id);
      }
      setSelectedBlockIds(ids);
    },
    [blocks]
  );

  const deleteSelectedBlocks = useCallback(() => {
    if (selectedBlockIds.size === 0) return;
    const remaining = blocks.filter((b) => !selectedBlockIds.has(b.id));
    if (remaining.length === 0) {
      const newBlock: Block = {
        id: crypto.randomUUID(),
        content: "",
        indent_level: 0,
        sort_order: 0,
        date: selectedDate,
      };
      const updated = [newBlock];
      setBlocks(updated);
      clearSelection();
      setEditingBlockId(newBlock.id);
      setEditContent("");
      setTimeout(() => {
        const el = textareaRefs.current.get(newBlock.id);
        if (el) el.focus();
      }, 0);
      debouncedSave(updated);
      return;
    }
    const reordered = remaining.map((b, i) => ({ ...b, sort_order: i }));
    setBlocks(reordered);
    clearSelection();
    debouncedSave(reordered);
  }, [blocks, selectedBlockIds, selectedDate, clearSelection, debouncedSave]);

  const copySelectedBlocks = useCallback(
    async (cut: boolean) => {
      if (selectedBlockIds.size === 0) return;
      const selectedTexts = blocks
        .filter((b) => selectedBlockIds.has(b.id))
        .map((b) => "  ".repeat(b.indent_level) + b.content);
      await navigator.clipboard.writeText(selectedTexts.join("\n"));
      if (cut) deleteSelectedBlocks();
    },
    [blocks, selectedBlockIds, deleteSelectedBlocks]
  );

  // Handle keyboard shortcuts on the container (for when no block is being edited)
  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (editingBlockId) return; // Let block handle its own keys
      if (selectedBlockIds.size === 0) return;

      const metaKey = e.metaKey || e.ctrlKey;

      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSelectedBlocks();
        return;
      }
      if (metaKey && e.key === "c") {
        e.preventDefault();
        copySelectedBlocks(false);
        return;
      }
      if (metaKey && e.key === "x") {
        e.preventDefault();
        copySelectedBlocks(true);
        return;
      }
      if (metaKey && e.key === "a") {
        e.preventDefault();
        setSelectedBlockIds(new Set(blocks.map((b) => b.id)));
        setSelectionAnchor(0);
        return;
      }
      if (e.key === "Escape") {
        clearSelection();
        return;
      }
    },
    [editingBlockId, selectedBlockIds, blocks, deleteSelectedBlocks, copySelectedBlocks, clearSelection]
  );

  const handleBlockMouseDown = useCallback(
    (e: React.MouseEvent, blockIndex: number) => {
      // Only handle selection on the non-editing display view
      if (editingBlockId === blocks[blockIndex]?.id) return;

      if (e.shiftKey && selectionAnchor !== null) {
        e.preventDefault();
        selectRange(selectionAnchor, blockIndex);
        return;
      }
      // Normal click clears selection
      if (!e.shiftKey) {
        clearSelection();
        setSelectionAnchor(blockIndex);
      }
    },
    [editingBlockId, blocks, selectionAnchor, selectRange, clearSelection]
  );

  const setTextareaRef = (id: string, el: HTMLTextAreaElement | null) => {
    if (el) textareaRefs.current.set(id, el);
    else textareaRefs.current.delete(id);
  };

  const focusBlock = (blockId: string, cursorPos?: number) => {
    setEditingBlockId(blockId);
    const block = blocks.find((b) => b.id === blockId);
    if (block) setEditContent(block.content);
    setTimeout(() => {
      const el = textareaRefs.current.get(blockId);
      if (el) {
        el.focus();
        if (cursorPos !== undefined) {
          el.selectionStart = el.selectionEnd = cursorPos;
        }
      }
    }, 0);
  };

  const startRefEditing = (block: Block) => {
    if (selectedBlockIds.size > 0) return;
    setEditingBlockId(block.id);
    setEditContent(block.content);
    setShowSuggestions(false);
    setTimeout(() => {
      const el = textareaRefs.current.get(block.id);
      if (el) el.focus();
    }, 0);
  };

  const handleRefKeyDown = (
    e: KeyboardEvent<HTMLTextAreaElement>,
    block: Block,
    _blockIndex: number
  ) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Tag suggestions in ref blocks
    if (showSuggestions) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedSuggestion((p) => Math.min(p + 1, tagSuggestions.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedSuggestion((p) => Math.max(p - 1, 0)); return; }
      if (e.key === "Tab" || e.key === "Enter") { if (tagSuggestions[selectedSuggestion]) { e.preventDefault(); applySuggestion(tagSuggestions[selectedSuggestion].name); return; } }
      if (e.key === "Escape") { setShowSuggestions(false); return; }
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const newIndent = e.shiftKey ? Math.max(0, block.indent_level - 1) : block.indent_level + 1;
      const updatedRef = { ...block, indent_level: newIndent, content: editContent };
      setRefBlocks(refBlocks.map((b) => b.id === block.id ? updatedRef : b));
      debouncedRefSave(updatedRef);
    }
  };

  const startEditing = (block: Block) => {
    if (selectedBlockIds.size > 0) return; // Don't enter edit mode during selection
    setEditingBlockId(block.id);
    setEditContent(block.content);
    setShowSuggestions(false);
    setTimeout(() => {
      const el = textareaRefs.current.get(block.id);
      if (el) el.focus();
    }, 0);
  };

  const finishEditing = () => {
    if (!editingBlockId) return;
    // Check if it's a ref block
    const refBlock = refBlocks.find((b) => b.id === editingBlockId);
    if (refBlock) {
      const updatedRef = { ...refBlock, content: editContent };
      setRefBlocks(refBlocks.map((b) => b.id === editingBlockId ? updatedRef : b));
      setEditingBlockId(null);
      setShowSuggestions(false);
      debouncedRefSave(updatedRef);
      return;
    }
    const updated = blocks.map((b) =>
      b.id === editingBlockId ? { ...b, content: editContent } : b
    );
    setBlocks(updated);
    setEditingBlockId(null);
    setShowSuggestions(false);
    debouncedSave(updated);
  };

  // Tag suggestion logic
  const handleContentChange = (value: string) => {
    setEditContent(value);
    // Check if user is typing a tag
    const cursorMatch = value.match(/#([^\s#]*)$/);
    if (cursorMatch) {
      const query = cursorMatch[1].toLowerCase();
      const suggestions = allTags.filter(
        (t) => t.name.toLowerCase().includes(query) && t.name.toLowerCase() !== query
      );
      setTagSuggestions(suggestions.slice(0, 5));
      setShowSuggestions(suggestions.length > 0);
      setSelectedSuggestion(0);
    } else {
      setShowSuggestions(false);
    }
  };

  const applySuggestion = (tagName: string) => {
    const newContent = editContent.replace(/#([^\s#]*)$/, `#${tagName} `);
    setEditContent(newContent);
    setShowSuggestions(false);
  };

  const handleKeyDown = (
    e: KeyboardEvent<HTMLTextAreaElement>,
    block: Block,
    blockIndex: number
  ) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    // Handle suggestion navigation
    if (showSuggestions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSuggestion((prev) =>
          Math.min(prev + 1, tagSuggestions.length - 1)
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSuggestion((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        if (tagSuggestions[selectedSuggestion]) {
          e.preventDefault();
          applySuggestion(tagSuggestions[selectedSuggestion].name);
          return;
        }
      }
      if (e.key === "Escape") {
        setShowSuggestions(false);
        return;
      }
    }

    const textarea = e.currentTarget;
    const cursorPos = textarea.selectionStart;
    const metaKey = e.metaKey || e.ctrlKey;

    // Ctrl/Cmd+A: select all blocks
    if (metaKey && e.key === "a") {
      e.preventDefault();
      finishEditing();
      setSelectedBlockIds(new Set(blocks.map((b) => b.id)));
      setSelectionAnchor(0);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Split content at cursor position
      const before = editContent.slice(0, cursorPos);
      const after = editContent.slice(cursorPos);

      const updated = blocks.map((b) =>
        b.id === block.id ? { ...b, content: before } : b
      );
      const newBlock: Block = {
        id: crypto.randomUUID(),
        content: after,
        indent_level: block.indent_level,
        sort_order: block.sort_order + 1,
        date: block.date,
      };
      updated.splice(blockIndex + 1, 0, newBlock);
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered);
      setEditContent(after);
      setEditingBlockId(newBlock.id);
      setTimeout(() => {
        const el = textareaRefs.current.get(newBlock.id);
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = 0;
        }
      }, 0);
      debouncedSave(reordered);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const newIndent = e.shiftKey
        ? Math.max(0, block.indent_level - 1)
        : block.indent_level + 1;
      const updated = blocks.map((b) =>
        b.id === block.id
          ? { ...b, indent_level: newIndent, content: editContent }
          : b
      );
      setBlocks(updated);
      debouncedSave(updated);
    } else if (e.key === "ArrowUp" && cursorPos === 0) {
      // Move to previous block
      e.preventDefault();
      if (blockIndex > 0) {
        const prevBlock = blocks[blockIndex - 1];
        const updated = blocks.map((b) =>
          b.id === block.id ? { ...b, content: editContent } : b
        );
        setBlocks(updated);
        focusBlock(prevBlock.id, prevBlock.content.length);
      }
    } else if (
      e.key === "ArrowDown" &&
      cursorPos === editContent.length
    ) {
      // Move to next block
      e.preventDefault();
      if (blockIndex < blocks.length - 1) {
        const nextBlock = blocks[blockIndex + 1];
        const updated = blocks.map((b) =>
          b.id === block.id ? { ...b, content: editContent } : b
        );
        setBlocks(updated);
        focusBlock(nextBlock.id, 0);
      }
    } else if (e.key === "ArrowLeft" && cursorPos === 0 && blockIndex > 0) {
      // Move to end of previous block
      e.preventDefault();
      const prevBlock = blocks[blockIndex - 1];
      const updated = blocks.map((b) =>
        b.id === block.id ? { ...b, content: editContent } : b
      );
      setBlocks(updated);
      focusBlock(prevBlock.id, prevBlock.content.length);
    } else if (
      e.key === "ArrowRight" &&
      cursorPos === editContent.length &&
      blockIndex < blocks.length - 1
    ) {
      // Move to start of next block
      e.preventDefault();
      const nextBlock = blocks[blockIndex + 1];
      const updated = blocks.map((b) =>
        b.id === block.id ? { ...b, content: editContent } : b
      );
      setBlocks(updated);
      focusBlock(nextBlock.id, 0);
    } else if (
      e.key === "Backspace" &&
      cursorPos === 0 &&
      textarea.selectionEnd === 0 &&
      blockIndex > 0
    ) {
      // Merge with previous block
      e.preventDefault();
      const prevBlock = blocks[blockIndex - 1];
      const mergedContent = prevBlock.content + editContent;
      const cursorAt = prevBlock.content.length;
      const updated = blocks
        .map((b) =>
          b.id === prevBlock.id ? { ...b, content: mergedContent } : b
        )
        .filter((b) => b.id !== block.id);
      const reordered = updated.map((b, i) => ({ ...b, sort_order: i }));
      setBlocks(reordered);
      setEditContent(mergedContent);
      setEditingBlockId(prevBlock.id);
      setTimeout(() => {
        const el = textareaRefs.current.get(prevBlock.id);
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = cursorAt;
        }
      }, 0);
      debouncedSave(reordered);
    }
  };

  const addNewBlock = () => {
    const newBlock: Block = {
      id: crypto.randomUUID(),
      content: "",
      indent_level: 0,
      sort_order: blocks.length,
      date: viewMode === "tag" ? "" : selectedDate,
      tag_id: viewMode === "tag" ? selectedTagId : null,
    };
    const updated = [...blocks, newBlock];
    setBlocks(updated);
    startEditing(newBlock);
    debouncedSave(updated);
  };

  // Group ref blocks by date in tag view
  const groupedRefByDate =
    viewMode === "tag"
      ? refBlocks.reduce(
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
    <div
      ref={containerRef}
      className="mx-auto max-w-3xl outline-none"
      tabIndex={-1}
      onKeyDown={handleContainerKeyDown}
    >
      {viewMode === "tag" ? (
        <>
          {/* Page content: directly editable */}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            {blocks.map((block, blockIndex) => (
              <BlockLine
                key={block.id}
                block={block}
                blockIndex={blockIndex}
                isEditing={editingBlockId === block.id}
                isSelected={selectedBlockIds.has(block.id)}
                editContent={editContent}
                allTags={allTags}
                showSuggestions={
                  showSuggestions && editingBlockId === block.id
                }
                tagSuggestions={tagSuggestions}
                selectedSuggestion={selectedSuggestion}
                setTextareaRef={setTextareaRef}
                onStartEditing={startEditing}
                onEditContentChange={handleContentChange}
                onFinishEditing={finishEditing}
                onKeyDown={handleKeyDown}
                onTagClick={onTagClick}
                onDateClick={onDateClick}
                onApplySuggestion={applySuggestion}
                onBlockMouseDown={handleBlockMouseDown}
              />
            ))}
            {blocks.length === 0 && (
              <div
                className="py-4 cursor-text text-sm text-gray-300 min-h-[2em]"
                onClick={() => addNewBlock()}
              >
                &nbsp;
              </div>
            )}
          </div>
          <button
            onClick={() => addNewBlock()}
            className="mt-2 rounded px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            + 新しいブロック
          </button>

          {/* Referenced blocks from dates */}
          {groupedRefByDate && Object.keys(groupedRefByDate).length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                日付からの参照
              </h3>
              {Object.entries(groupedRefByDate)
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([date, dateBlocks]) => (
                  <div key={date} className="mb-4">
                    <h2 className="mb-1 flex items-center gap-2 text-sm font-medium">
                      <span
                        className="date-link cursor-pointer"
                        onClick={() => onDateClick(date)}
                      >
                        {date}
                      </span>
                    </h2>
                    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                      {dateBlocks.map((block) => {
                        const refIndex = refBlocks.indexOf(block);
                        return (
                          <BlockLine
                            key={block.id}
                            block={block}
                            blockIndex={refIndex}
                            isEditing={editingBlockId === block.id}
                            isSelected={false}
                            editContent={editContent}
                            allTags={allTags}
                            showSuggestions={showSuggestions && editingBlockId === block.id}
                            tagSuggestions={tagSuggestions}
                            selectedSuggestion={selectedSuggestion}
                            setTextareaRef={setTextareaRef}
                            onStartEditing={startRefEditing}
                            onEditContentChange={handleContentChange}
                            onFinishEditing={finishEditing}
                            onKeyDown={handleRefKeyDown}
                            onTagClick={onTagClick}
                            onDateClick={onDateClick}
                            onApplySuggestion={applySuggestion}
                            onBlockMouseDown={() => {}}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          {blocks.map((block, blockIndex) => (
            <BlockLine
              key={block.id}
              block={block}
              blockIndex={blockIndex}
              isEditing={editingBlockId === block.id}
              isSelected={selectedBlockIds.has(block.id)}
              editContent={editContent}
              allTags={allTags}
              showSuggestions={
                showSuggestions && editingBlockId === block.id
              }
              tagSuggestions={tagSuggestions}
              selectedSuggestion={selectedSuggestion}
              setTextareaRef={setTextareaRef}
              onStartEditing={startEditing}
              onEditContentChange={handleContentChange}
              onFinishEditing={finishEditing}
              onKeyDown={handleKeyDown}
              onTagClick={onTagClick}
              onDateClick={onDateClick}
              onApplySuggestion={applySuggestion}
              onBlockMouseDown={handleBlockMouseDown}
            />
          ))}
          {blocks.length === 0 && (
            <div
              className="py-4 cursor-text text-sm text-gray-300 min-h-[2em]"
              onClick={() => addNewBlock()}
            >
              &nbsp;
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
  blockIndex,
  isEditing,
  isSelected,
  editContent,
  allTags,
  showSuggestions,
  tagSuggestions,
  selectedSuggestion,
  setTextareaRef,
  onStartEditing,
  onEditContentChange,
  onFinishEditing,
  onKeyDown,
  onTagClick,
  onDateClick,
  onApplySuggestion,
  onBlockMouseDown,
}: {
  block: Block;
  blockIndex: number;
  isEditing: boolean;
  isSelected: boolean;
  editContent: string;
  allTags: TagInfo[];
  showSuggestions: boolean;
  tagSuggestions: TagInfo[];
  selectedSuggestion: number;
  setTextareaRef: (id: string, el: HTMLTextAreaElement | null) => void;
  onStartEditing: (block: Block) => void;
  onEditContentChange: (content: string) => void;
  onFinishEditing: () => void;
  onKeyDown: (
    e: KeyboardEvent<HTMLTextAreaElement>,
    block: Block,
    blockIndex: number
  ) => void;
  onTagClick: (tagId: string, tagName: string) => void;
  onDateClick: (date: string) => void;
  onApplySuggestion: (tagName: string) => void;
  onBlockMouseDown: (e: React.MouseEvent, blockIndex: number) => void;
}) {
  const indent = block.indent_level * 24;

  const headingMatch = block.content.match(/^(#{1,3})\s/);
  let headingClass = "";
  if (headingMatch) {
    const level = headingMatch[1].length;
    headingClass =
      level === 1
        ? "md-heading-1"
        : level === 2
          ? "md-heading-2"
          : "md-heading-3";
  }

  return (
    <div
      className={`group relative flex items-start py-0.5 ${isSelected ? "bg-blue-100 rounded" : ""}`}
      style={{ paddingLeft: `${indent}px` }}
      onMouseDown={(e) => onBlockMouseDown(e, blockIndex)}
    >
      {isEditing ? (
        <div className="relative flex-1">
          <textarea
            ref={(el) => setTextareaRef(block.id, el)}
            value={editContent}
            onChange={(e) => onEditContentChange(e.target.value)}
            onBlur={() => {
              // Delay to allow suggestion click
              setTimeout(onFinishEditing, 150);
            }}
            onKeyDown={(e) => onKeyDown(e, block, blockIndex)}
            className="block-line w-full resize-none border-none bg-blue-50 p-1 text-sm outline-none rounded"
            rows={Math.max(1, editContent.split("\n").length)}
            autoFocus
          />
          {/* Tag suggestions dropdown */}
          {showSuggestions && (
            <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded border border-gray-200 bg-white shadow-lg">
              {tagSuggestions.map((tag, i) => (
                <button
                  key={tag.id}
                  className={`block w-full px-3 py-1.5 text-left text-sm ${
                    i === selectedSuggestion
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onApplySuggestion(tag.name);
                  }}
                >
                  <span className="tag-inline text-xs">{tag.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          onClick={() => onStartEditing(block)}
          className={`block-line flex-1 cursor-text p-1 text-sm hover:bg-gray-50 rounded ${headingClass}`}
        >
          {block.content
            ? renderContent(block.content, onTagClick, onDateClick, allTags)
            : "\u00A0"}
        </div>
      )}
    </div>
  );
}
