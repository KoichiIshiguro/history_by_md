"use client";

import { useState, useRef, useEffect } from "react";

interface Page {
  id: string;
  name: string;
  parent_id: string | null;
  ref_count: number;
}

interface Tag {
  id: string;
  name: string;
  block_count: number;
}

interface Props {
  user: { name?: string | null; email?: string | null; image?: string | null };
  isAdmin: boolean;
  pages: Page[];
  tags: Tag[];
  dates: string[];
  selectedDate: string;
  selectedPageId: string | null;
  selectedTagId: string | null;
  viewMode: string;
  onSelectDate: (date: string) => void;
  onSelectPage: (pageId: string, pageName: string) => void;
  onSelectTag: (tagId: string, tagName: string) => void;
  onSelectAdmin: () => void;
  onSelectActions: () => void;
  onSignOut: () => void;
  onPagesChange: () => void;
  onTagsChange: () => void;
  onCloseMobile: () => void;
}

type PageTreeNode = Page & { children: PageTreeNode[] };

function buildPageTree(pages: Page[]): PageTreeNode[] {
  const map = new Map<string, PageTreeNode>();
  const roots: PageTreeNode[] = [];
  for (const p of pages) map.set(p.id, { ...p, children: [] });
  for (const p of pages) {
    const node = map.get(p.id)!;
    if (p.parent_id && map.has(p.parent_id)) {
      map.get(p.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function groupDatesByMonth(dates: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const date of dates) {
    const month = date.slice(0, 7);
    if (!grouped.has(month)) grouped.set(month, []);
    grouped.get(month)!.push(date);
  }
  return grouped;
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return `${y}年${parseInt(m)}月`;
}

const THEME_PRESETS: Record<string, Record<string, string>> = {
  orange: { '50': '#fff7ed', '100': '#ffedd5', '200': '#fed7aa', '300': '#fdba74', '400': '#fb923c', '500': '#f97316', '600': '#ea580c', '700': '#c2410c' },
  blue: { '50': '#eff6ff', '100': '#dbeafe', '200': '#bfdbfe', '300': '#93c5fd', '400': '#60a5fa', '500': '#3b82f6', '600': '#2563eb', '700': '#1d4ed8' },
  purple: { '50': '#faf5ff', '100': '#f3e8ff', '200': '#e9d5ff', '300': '#d8b4fe', '400': '#c084fc', '500': '#a855f7', '600': '#9333ea', '700': '#7e22ce' },
  green: { '50': '#f0fdf4', '100': '#dcfce7', '200': '#bbf7d0', '300': '#86efac', '400': '#4ade80', '500': '#22c55e', '600': '#16a34a', '700': '#15803d' },
  pink: { '50': '#fdf2f8', '100': '#fce7f3', '200': '#fbcfe8', '300': '#f9a8d4', '400': '#f472b6', '500': '#ec4899', '600': '#db2777', '700': '#be185d' },
};

function applyTheme(themeName: string) {
  const preset = THEME_PRESETS[themeName];
  if (!preset) return;
  const root = document.documentElement;
  for (const [shade, value] of Object.entries(preset)) {
    root.style.setProperty(`--theme-${shade}`, value);
  }
  try { localStorage.setItem('theme-color', themeName); } catch {}
}

export default function Sidebar({
  user, isAdmin, pages, tags, dates, selectedDate, selectedPageId, selectedTagId,
  viewMode, onSelectDate, onSelectPage, onSelectTag, onSelectAdmin, onSelectActions,
  onSignOut, onPagesChange, onTagsChange, onCloseMobile,
}: Props) {
  const [expandedPages, setExpandedPages] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [addingChildOf, setAddingChildOf] = useState<string | null>(null);
  const [tagSearch, setTagSearch] = useState("");
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => {
    const now = new Date().toISOString().slice(0, 7);
    return new Set([now]);
  });
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [currentTheme, setCurrentTheme] = useState('orange');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('theme-color');
      if (saved && THEME_PRESETS[saved]) { setCurrentTheme(saved); }
    } catch {}
  }, []);

  const pageTree = buildPageTree(pages);
  const filteredTags = tagSearch
    ? tags.filter((t) => t.name.toLowerCase().includes(tagSearch.toLowerCase()))
    : tags;
  const datesByMonth = groupDatesByMonth(dates);

  const toggleExpand = (id: string) => {
    setExpandedPages((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleMonth = (month: string) => {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      next.has(month) ? next.delete(month) : next.add(month);
      return next;
    });
  };

  const toggleSection = (section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.has(section) ? next.delete(section) : next.add(section);
      return next;
    });
  };

  const createPage = async (name: string, parentId: string | null) => {
    if (!name.trim()) return;
    const res = await fetch("/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), parent_id: parentId }),
    });
    if (res.ok) {
      if (parentId) setExpandedPages((prev) => new Set(prev).add(parentId));
      onPagesChange();
    }
    setAddingChildOf(null);
  };

  const confirmDeletePage = async () => {
    if (!deleteTarget) return;
    await fetch("/api/pages", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deleteTarget.id }),
    });
    onPagesChange();
    setDeleteTarget(null);
  };

  const click = (action: () => void) => { action(); onCloseMobile(); };

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="flex h-full flex-col">
      {/* User */}
      <div className="relative border-b border-theme-200 p-3">
        <button onClick={() => setShowUserMenu(!showUserMenu)} className="flex w-full items-center gap-2 rounded-lg p-1 hover:bg-theme-50 transition">
          {user.image ? (
            <img src={user.image} alt="" className="h-8 w-8 rounded-full" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-theme-100 text-sm font-bold text-theme-600">
              {user.name?.[0] || "U"}
            </div>
          )}
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-medium text-gray-800">{user.name}</p>
            <p className="truncate text-xs text-gray-500">{user.email}</p>
          </div>
          <svg className={`h-4 w-4 text-gray-400 transition-transform ${showUserMenu ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showUserMenu && (
          <div className="absolute left-2 right-2 top-full z-20 mt-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
            {isAdmin && (
              <button onClick={() => { click(onSelectAdmin); setShowUserMenu(false); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                ユーザー管理
              </button>
            )}
            <div className="px-3 py-2 border-t border-gray-100">
              <p className="text-xs font-medium text-gray-500 mb-1.5">テーマ色</p>
              <div className="flex gap-1.5">
                {Object.entries(THEME_PRESETS).map(([name, colors]) => (
                  <button
                    key={name}
                    onClick={() => { applyTheme(name); setCurrentTheme(name); }}
                    className={`h-6 w-6 rounded-full border-2 transition ${currentTheme === name ? 'border-gray-800 scale-110' : 'border-transparent hover:scale-110'}`}
                    style={{ backgroundColor: colors['500'] }}
                    title={name}
                  />
                ))}
              </div>
            </div>
            <button onClick={() => { onSignOut(); setShowUserMenu(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 border-t border-gray-100">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              ログアウト
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {/* All Actions button */}
        <div className="p-2">
          <button
            onClick={() => click(onSelectActions)}
            className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              viewMode === "actions"
                ? "bg-theme-100 text-theme-700 border border-theme-300"
                : "text-gray-600 hover:bg-theme-50 border border-transparent"
            }`}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            全アクション
          </button>
        </div>

        {/* 1. Pages */}
        <div className="p-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <button onClick={() => toggleSection("pages")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600">
              <svg className={`h-3 w-3 transition-transform ${collapsedSections.has("pages") ? "" : "rotate-90"}`} fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              </svg>
              ページ
            </button>
            <button onClick={() => setAddingChildOf(addingChildOf === "__root__" ? null : "__root__")}
              className="text-gray-400 hover:text-gray-600" title="新しいページ">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
          {!collapsedSections.has("pages") && (
            <>
              {addingChildOf === "__root__" && (
                <InlineInput depth={0} placeholder="ページ名..."
                  onSubmit={(n) => createPage(n, null)} onCancel={() => setAddingChildOf(null)} />
              )}
              {pages.length === 0 && addingChildOf !== "__root__" && (
                <p className="px-3 py-2 text-xs text-gray-400">ページなし</p>
              )}
              {pageTree.map((p) => (
                <PageNode key={p.id} page={p} depth={0} selectedPageId={selectedPageId} viewMode={viewMode}
                  expandedPages={expandedPages} addingChildOf={addingChildOf}
                  onToggleExpand={toggleExpand}
                  onSelectPage={(id, name) => click(() => onSelectPage(id, name))}
                  onDeletePage={(id, name) => setDeleteTarget({ id, name })}
                  onAddChild={(id) => setAddingChildOf(addingChildOf === id ? null : id)}
                  onCreatePage={createPage} onCancelAdd={() => setAddingChildOf(null)} />
              ))}
            </>
          )}
        </div>

        {/* 2. Dates (month-grouped) */}
        <div className="p-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <button onClick={() => toggleSection("dates")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600">
              <svg className={`h-3 w-3 transition-transform ${collapsedSections.has("dates") ? "" : "rotate-90"}`} fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              </svg>
              日付
            </button>
          </div>
          {!collapsedSections.has("dates") && (
            <>
              <button
                onClick={() => click(() => onSelectDate(today))}
                className={`w-full rounded px-3 py-1.5 text-left text-sm font-medium ${
                  viewMode === "date" && selectedDate === today ? "bg-theme-100 text-theme-700" : "text-theme-600 hover:bg-theme-50"
                }`}
              >今日</button>
              {[...datesByMonth.entries()].map(([month, monthDates]) => (
                <div key={month}>
                  <button
                    onClick={() => toggleMonth(month)}
                    className="flex w-full items-center gap-1 rounded px-3 py-1 text-left text-xs font-medium text-gray-500 hover:bg-gray-100"
                  >
                    <svg className={`h-3 w-3 transition-transform ${expandedMonths.has(month) ? "rotate-90" : ""}`} fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                    </svg>
                    {formatMonth(month)}
                    <span className="ml-auto text-gray-400">{monthDates.length}</span>
                  </button>
                  {expandedMonths.has(month) && monthDates.map((date) => (
                    <button key={date} onClick={() => click(() => onSelectDate(date))}
                      className={`w-full rounded py-1 pl-7 pr-3 text-left text-sm ${
                        viewMode === "date" && selectedDate === date ? "bg-theme-100 text-theme-700" : "text-gray-600 hover:bg-gray-100"
                      }`}
                    >{date.slice(5)}</button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>

        {/* 3. Tags */}
        <div className="p-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <button onClick={() => toggleSection("tags")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600">
              <svg className={`h-3 w-3 transition-transform ${collapsedSections.has("tags") ? "" : "rotate-90"}`} fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              </svg>
              タグ
            </button>
          </div>
          {!collapsedSections.has("tags") && (
            <>
              <div className="mb-1 px-1">
                <input type="text" value={tagSearch} onChange={(e) => setTagSearch(e.target.value)}
                  placeholder="タグを検索..." className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs outline-none focus:border-theme-300" />
              </div>
              {filteredTags.length === 0 && <p className="px-3 py-1 text-xs text-gray-400">タグなし</p>}
              {filteredTags.map((tag) => (
                <button key={tag.id} onClick={() => click(() => onSelectTag(tag.id, tag.name))}
                  className={`w-full rounded px-3 py-1 text-left text-sm flex items-center justify-between ${
                    viewMode === "tag" && selectedTagId === tag.id ? "bg-theme-100 text-theme-700" : "text-gray-600 hover:bg-gray-100"
                  }`}>
                  <span>#{tag.name}</span>
                  <span className="text-xs text-gray-400">{tag.block_count}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Delete modal */}
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
                <h3 className="text-sm font-semibold text-gray-900">ページを削除</h3>
                <p className="text-xs text-gray-500">この操作は取り消せません</p>
              </div>
            </div>
            <p className="mb-5 text-sm text-gray-600"><strong>{deleteTarget.name}</strong> を削除しますか？</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50">キャンセル</button>
              <button onClick={confirmDeletePage} className="flex-1 rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-600">削除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineInput({ depth, placeholder, onSubmit, onCancel }: {
  depth: number; placeholder: string; onSubmit: (v: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="flex items-center py-0.5" style={{ paddingLeft: `${8 + depth * 16}px` }}>
      <span className="mr-1 inline-block h-4 w-4 flex-shrink-0" />
      <input ref={ref} type="text" value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(value); }
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => { value.trim() ? onSubmit(value) : onCancel(); }}
        placeholder={placeholder}
        className="flex-1 rounded border border-theme-300 bg-white px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-theme-400" />
    </div>
  );
}

function PageNode({ page, depth, selectedPageId, viewMode, expandedPages, addingChildOf,
  onToggleExpand, onSelectPage, onDeletePage, onAddChild, onCreatePage, onCancelAdd,
}: {
  page: PageTreeNode; depth: number; selectedPageId: string | null; viewMode: string;
  expandedPages: Set<string>; addingChildOf: string | null;
  onToggleExpand: (id: string) => void; onSelectPage: (id: string, name: string) => void;
  onDeletePage: (id: string, name: string) => void; onAddChild: (id: string) => void;
  onCreatePage: (name: string, parentId: string | null) => void; onCancelAdd: () => void;
}) {
  const hasChildren = page.children.length > 0;
  const isExpanded = expandedPages.has(page.id);
  const isSelected = viewMode === "page" && selectedPageId === page.id;

  return (
    <div>
      <div className={`group/pg flex items-center rounded py-1 pr-1 text-sm ${isSelected ? "bg-theme-100 text-theme-700" : "text-gray-600 hover:bg-gray-100"}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <button onClick={() => hasChildren && onToggleExpand(page.id)}
          className={`mr-1 flex h-4 w-4 flex-shrink-0 items-center justify-center text-xs ${hasChildren ? "text-gray-400 hover:text-gray-600" : "text-transparent"}`}>
          {hasChildren ? (
            <svg className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg className="h-3.5 w-3.5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          )}
        </button>
        <button onClick={() => onSelectPage(page.id, page.name)} className="flex-1 text-left truncate">{page.name}</button>
        <div className="hidden items-center gap-0.5 group-hover/pg:flex">
          <button onClick={(e) => { e.stopPropagation(); onAddChild(page.id); }}
            className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600" title="サブページ追加">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDeletePage(page.id, page.name); }}
            className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500" title="削除">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      </div>
      {(hasChildren && isExpanded || addingChildOf === page.id) && (
        <div>
          {hasChildren && isExpanded && page.children.map((child) => (
            <PageNode key={child.id} page={child} depth={depth + 1} selectedPageId={selectedPageId} viewMode={viewMode}
              expandedPages={expandedPages} addingChildOf={addingChildOf}
              onToggleExpand={onToggleExpand} onSelectPage={onSelectPage} onDeletePage={onDeletePage}
              onAddChild={onAddChild} onCreatePage={onCreatePage} onCancelAdd={onCancelAdd} />
          ))}
          {addingChildOf === page.id && (
            <InlineInput depth={depth + 1} placeholder="サブページ名..."
              onSubmit={(n) => onCreatePage(n, page.id)} onCancel={onCancelAdd} />
          )}
        </div>
      )}
    </div>
  );
}
