"use client";

import { signOut } from "next-auth/react";
import { useState, useEffect, useCallback, useRef } from "react";
import BlockEditor from "./BlockEditor";
import AdminPanel from "./AdminPanel";
import Sidebar from "./Sidebar";
import ActionList from "./ActionList";
import TemplateEditor from "./TemplateEditor";
import GetStartedGuide from "./GetStartedGuide";
import AiChat from "./AiChat";

type ViewMode = "date" | "page" | "tag" | "admin" | "actions" | "templates" | "guide" | "chat";

function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Page {
  id: string;
  name: string;
  parent_id: string | null;
  ref_count: number;
  full_path: string;
}

interface Tag {
  id: string;
  name: string;
  block_count: number;
}

interface Props {
  user: { id: string; name?: string | null; email?: string | null; image?: string | null; role: string };
  isAdmin: boolean;
}

export default function MainApp({ user, isAdmin }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("date");
  const [selectedDate, setSelectedDate] = useState(() => toLocalDateString(new Date()));
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedPageName, setSelectedPageName] = useState("");
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [selectedTagName, setSelectedTagName] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState("");
  const [actionVersion, setActionVersion] = useState(0);
  const bumpActionVersion = useCallback(() => setActionVersion((v) => v + 1), []);
  const [reloading, setReloading] = useState(false);

  // Navigation history (back/forward)
  type NavEntry = { viewMode: ViewMode; date: string; pageId: string | null; pageName: string; tagId: string | null; tagName: string };
  const navHistoryRef = useRef<NavEntry[]>([]);
  const navIndexRef = useRef(-1);
  const isNavRef = useRef(false); // true when navigating via back/forward (skip push)
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  // Push initial entry on mount
  useEffect(() => {
    if (navHistoryRef.current.length === 0) {
      navHistoryRef.current = [{ viewMode: "date", date: selectedDate, pageId: null, pageName: "", tagId: null, tagName: "" }];
      navIndexRef.current = 0;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Swipe gesture handling
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(true);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Swipe gestures for mobile sidebars
  useEffect(() => {
    if (!isMobile) return;
    const el = mainRef.current;
    if (!el) return;

    const EDGE_ZONE = 24; // px from screen edge to trigger swipe
    const screenW = window.innerWidth;

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      const x = touch.clientX;
      // Only register if starting from screen edge
      if (x <= EDGE_ZONE || x >= screenW - EDGE_ZONE) {
        touchStartRef.current = { x, y: touch.clientY, time: Date.now() };
      } else {
        touchStartRef.current = null;
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;
      const touch = e.changedTouches[0];
      const startX = touchStartRef.current.x;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - touchStartRef.current.y;
      const dt = Date.now() - touchStartRef.current.time;
      touchStartRef.current = null;

      if (dt > 400 || Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 40) return;

      if (dx > 0 && startX <= EDGE_ZONE) {
        // Swipe right from left edge → open left sidebar or close right sidebar
        if (rightSidebarOpen) {
          setRightSidebarOpen(false);
        } else if (!sidebarOpen) {
          setSidebarOpen(true);
        }
      } else if (dx < 0 && startX >= screenW - EDGE_ZONE) {
        // Swipe left from right edge → close left sidebar or open right sidebar
        if (sidebarOpen) {
          setSidebarOpen(false);
        } else if (viewMode === "page" && selectedPageId && !rightSidebarOpen) {
          setRightSidebarOpen(true);
        }
      }
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, [isMobile, sidebarOpen, rightSidebarOpen, viewMode, selectedPageId]);

  const fetchPages = useCallback(async () => {
    const res = await fetch("/api/pages");
    if (res.ok) setPages(await res.json());
  }, []);

  const fetchTags = useCallback(async () => {
    const res = await fetch("/api/tags");
    if (res.ok) setTags(await res.json());
  }, []);

  const fetchDates = useCallback(async () => {
    const res = await fetch("/api/blocks");
    if (res.ok) {
      const data = await res.json();
      setDates(data.map((d: { date: string }) => d.date));
    }
  }, []);

  useEffect(() => {
    fetchPages();
    fetchTags();
    fetchDates();
  }, [fetchPages, fetchTags, fetchDates]);

  // Sync selectedPageName when pages list updates (e.g. after rename)
  useEffect(() => {
    if (viewMode === "page" && selectedPageId) {
      const page = pages.find((p) => p.id === selectedPageId);
      if (page) setSelectedPageName(page.full_path || page.name);
    }
  }, [pages, viewMode, selectedPageId]);

  const updateNavState = useCallback(() => {
    setCanGoBack(navIndexRef.current > 0);
    setCanGoForward(navIndexRef.current < navHistoryRef.current.length - 1);
  }, []);

  const pushNav = useCallback((entry: NavEntry) => {
    if (isNavRef.current) { isNavRef.current = false; updateNavState(); return; }
    const hist = navHistoryRef.current;
    const idx = navIndexRef.current;
    navHistoryRef.current = hist.slice(0, idx + 1);
    navHistoryRef.current.push(entry);
    navIndexRef.current = navHistoryRef.current.length - 1;
    updateNavState();
  }, [updateNavState]);

  const applyNav = useCallback((entry: NavEntry) => {
    isNavRef.current = true;
    setViewMode(entry.viewMode);
    setSelectedDate(entry.date);
    setSelectedPageId(entry.pageId);
    setSelectedPageName(entry.pageName);
    setSelectedTagId(entry.tagId);
    setSelectedTagName(entry.tagName);
  }, []);

  const goBack = useCallback(() => {
    if (navIndexRef.current <= 0) return;
    navIndexRef.current--;
    applyNav(navHistoryRef.current[navIndexRef.current]);
    updateNavState();
  }, [applyNav, updateNavState]);

  const goForward = useCallback(() => {
    if (navIndexRef.current >= navHistoryRef.current.length - 1) return;
    navIndexRef.current++;
    applyNav(navHistoryRef.current[navIndexRef.current]);
    updateNavState();
  }, [applyNav, updateNavState]);

  const handleSelectPage = (pageId: string, pageName: string) => {
    setViewMode("page");
    setSelectedPageId(pageId);
    const page = pages.find((p) => p.id === pageId);
    const name = page?.full_path || pageName;
    setSelectedPageName(name);
    pushNav({ viewMode: "page", date: selectedDate, pageId, pageName: name, tagId: null, tagName: "" });
  };

  const handleSelectTag = (tagId: string, tagName: string) => {
    setViewMode("tag");
    setSelectedTagId(tagId);
    setSelectedTagName(tagName);
    pushNav({ viewMode: "tag", date: selectedDate, pageId: null, pageName: "", tagId, tagName });
  };

  const handleSelectDate = (date: string) => {
    setViewMode("date");
    setSelectedDate(date);
    pushNav({ viewMode: "date", date, pageId: null, pageName: "", tagId: null, tagName: "" });
  };

  const handleDataChange = useCallback(() => {
    fetchPages();
    fetchTags();
    fetchDates();
  }, [fetchPages, fetchTags, fetchDates]);

  // Granular refresh: only tags (for block edits that add/remove tags)
  const handleTagsChange = useCallback(() => {
    fetchTags();
  }, [fetchTags]);

  // Full reload: sidebar data + blocks (via actionVersion bump which triggers BlockEditor fetchBlocks)
  const handleReload = useCallback(async () => {
    setReloading(true);
    try {
      await Promise.all([fetchPages(), fetchTags(), fetchDates()]);
      bumpActionVersion();
    } finally {
      // brief delay so the spinning icon is visible even on fast networks
      setTimeout(() => setReloading(false), 400);
    }
  }, [fetchPages, fetchTags, fetchDates, bumpActionVersion]);

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  const hasRightSidebar = viewMode === "page" && selectedPageId;

  return (
    <div ref={mainRef} className="flex h-screen overflow-hidden" suppressHydrationWarning>
      {/* Left sidebar overlay */}
      {isMobile && sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/30" onClick={() => setSidebarOpen(false)} />
      )}
      {/* Right sidebar overlay */}
      {isMobile && rightSidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/30" onClick={() => setRightSidebarOpen(false)} />
      )}

      {/* Left sidebar */}
      <div
        className={`${
          isMobile
            ? `fixed inset-y-0 left-0 z-30 w-72 transform transition-transform duration-200 ${
                sidebarOpen ? "translate-x-0" : "-translate-x-full"
              }`
            : `${sidebarOpen ? "w-64" : "w-0"} transition-all duration-200 overflow-hidden`
        } border-r border-theme-200 bg-theme-50 flex-shrink-0`}
      >
        <Sidebar
          user={user}
          isAdmin={isAdmin}
          pages={pages}
          tags={tags}
          dates={dates}
          selectedDate={selectedDate}
          selectedPageId={selectedPageId}
          selectedTagId={selectedTagId}
          viewMode={viewMode}
          onSelectDate={handleSelectDate}
          onSelectPage={handleSelectPage}
          onSelectTag={handleSelectTag}
          onSelectAdmin={() => setViewMode("admin")}
          onSelectActions={() => setViewMode("actions")}
          onSelectTemplates={() => { setViewMode("templates"); setSelectedTemplateId(null); setSelectedTemplateName(""); }}
          onSignOut={() => signOut()}
          onPagesChange={fetchPages}
          onTagsChange={fetchTags}
          onCloseMobile={closeMobileSidebar}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-theme-100 bg-white px-4 py-2" suppressHydrationWarning>
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="rounded p-1.5 text-gray-500 hover:bg-theme-50 flex-shrink-0"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={goBack}
                disabled={!canGoBack}
                className={`rounded p-1 transition ${!canGoBack ? "text-gray-300 cursor-default" : "text-gray-500 hover:bg-theme-50 hover:text-gray-700"}`}
                title="戻る"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={goForward}
                disabled={!canGoForward}
                className={`rounded p-1 transition ${!canGoForward ? "text-gray-300 cursor-default" : "text-gray-500 hover:bg-theme-50 hover:text-gray-700"}`}
                title="進む"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
            <h1 className="text-lg font-semibold text-gray-800 truncate">
              {viewMode === "date" && (
                <>
                  <span className="text-theme-400 text-sm mr-2">日付</span>
                  {selectedDate}
                </>
              )}
              {viewMode === "page" && (
                <>
                  <span className="text-theme-400 text-sm mr-2">ページ</span>
                  {(() => {
                    const parts = selectedPageName.split("/");
                    return parts.map((part, i) => {
                      // Build the path up to this segment to find the matching page
                      const pathUpTo = parts.slice(0, i + 1).join("/");
                      const page = pages.find((p) => p.full_path === pathUpTo || (parts.length === 1 && p.name === part));
                      const isLast = i === parts.length - 1;
                      return (
                        <span key={i}>
                          {i > 0 && <span className="text-gray-400 mx-1">/</span>}
                          {isLast ? (
                            <span>{part}</span>
                          ) : page ? (
                            <span
                              className="text-theme-500 hover:text-theme-700 cursor-pointer hover:underline"
                              onClick={() => handleSelectPage(page.id, page.full_path || page.name)}
                            >
                              {part}
                            </span>
                          ) : (
                            <span className="text-gray-500">{part}</span>
                          )}
                        </span>
                      );
                    });
                  })()}
                </>
              )}
              {viewMode === "tag" && (
                <>
                  <span className="text-theme-400 text-sm mr-2">タグ</span>
                  <span className="tag-inline">{selectedTagName}</span>
                </>
              )}
              {viewMode === "templates" && (
                <>
                  <span className="text-theme-400 text-sm mr-2">テンプレート</span>
                  {selectedTemplateName || "一覧"}
                </>
              )}
              {viewMode === "actions" && (
                <span className="text-theme-600">全アクション</span>
              )}
              {viewMode === "chat" && (
                <span className="text-theme-600">AIチャット</span>
              )}
              {viewMode === "guide" && (
                <span className="text-theme-600">Get Started</span>
              )}
              {viewMode === "admin" && "ユーザー管理"}
            </h1>
          </div>
          <div className="flex items-center gap-1">
            {/* Right sidebar toggle (mobile, page view only) */}
            {isMobile && hasRightSidebar && (
              <button
                onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
                className={`rounded p-1.5 transition ${rightSidebarOpen ? "bg-theme-100 text-theme-600" : "text-gray-500 hover:bg-theme-50"}`}
                title="アクション"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </button>
            )}
            {viewMode === "date" && (
              <>
                <button
                  onClick={() => {
                    const d = new Date(selectedDate);
                    d.setDate(d.getDate() - 1);
                    setSelectedDate(toLocalDateString(d));
                  }}
                  className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-theme-50"
                >
                  &larr;
                </button>
                <button
                  onClick={() => setSelectedDate(toLocalDateString(new Date()))}
                  className="rounded px-2 py-1 text-sm text-theme-600 hover:bg-theme-50 font-medium"
                >
                  今日
                </button>
                <button
                  onClick={() => {
                    const d = new Date(selectedDate);
                    d.setDate(d.getDate() + 1);
                    setSelectedDate(toLocalDateString(d));
                  }}
                  className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-theme-50"
                >
                  &rarr;
                </button>
              </>
            )}
            <button
              onClick={handleReload}
              disabled={reloading}
              className={`rounded p-1.5 transition text-gray-400 hover:bg-theme-50 hover:text-gray-600 disabled:opacity-50`}
              title="最新データを取得"
            >
              <svg className={`h-4 w-4 ${reloading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode("chat")}
              className={`rounded p-1.5 transition ${viewMode === "chat" ? "bg-theme-100 text-theme-600" : "text-gray-400 hover:bg-theme-50 hover:text-gray-600"}`}
              title="AIチャット"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode("guide")}
              className={`rounded p-1.5 transition ${viewMode === "guide" ? "bg-theme-100 text-theme-600" : "text-gray-400 hover:bg-theme-50 hover:text-gray-600"}`}
              title="Get Started"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </div>
        </header>

        <main className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto p-4">
            {viewMode === "chat" ? (
              <AiChat />
            ) : viewMode === "guide" ? (
              <GetStartedGuide onNavigate={(mode, id, name) => {
                if (mode === "date") handleSelectDate(toLocalDateString(new Date()));
                else if (mode === "actions") setViewMode("actions");
                else if (mode === "templates") { setViewMode("templates"); setSelectedTemplateId(null); setSelectedTemplateName(""); }
              }} />
            ) : viewMode === "templates" ? (
              <TemplateEditor
                selectedTemplateId={selectedTemplateId}
                selectedTemplateName={selectedTemplateName}
                onSelectTemplate={(id, name) => { setSelectedTemplateId(id); setSelectedTemplateName(name); }}
                onBack={() => { setSelectedTemplateId(null); setSelectedTemplateName(""); }}
                allPages={pages}
                allTags={tags}
                onPageClick={handleSelectPage}
                onTagClick={handleSelectTag}
                onDateClick={handleSelectDate}
              />
            ) : viewMode === "actions" ? (
              <ActionList
                allPages={pages}
                allTags={tags}
                onPageClick={handleSelectPage}
                onTagClick={handleSelectTag}
                onDateClick={handleSelectDate}
                actionVersion={actionVersion}
              />
            ) : viewMode === "admin" && isAdmin ? (
              <AdminPanel />
            ) : (
              <BlockEditor
                viewMode={viewMode}
                selectedDate={selectedDate}
                selectedPageId={selectedPageId}
                selectedPageName={selectedPageName}
                selectedTagId={selectedTagId}
                selectedTagName={selectedTagName}
                allPages={pages}
                allTags={tags}
                onPageClick={handleSelectPage}
                onTagClick={handleSelectTag}
                onDateClick={handleSelectDate}
                onDataChange={handleDataChange}
                actionVersion={actionVersion}
              />
            )}
          </div>
          {/* Right sidebar - desktop */}
          {hasRightSidebar && !isMobile && (
            <div className="w-72 border-l border-theme-100 bg-theme-50 overflow-auto p-3 flex-shrink-0">
              <h3 className="text-sm font-semibold text-theme-600 mb-2">アクション</h3>
              <ActionList
                pageId={selectedPageId!}
                allPages={pages}
                allTags={tags}
                onPageClick={handleSelectPage}
                onTagClick={handleSelectTag}
                onDateClick={handleSelectDate}
                onActionChange={bumpActionVersion}
                actionVersion={actionVersion}
              />
            </div>
          )}
          {/* Right sidebar - mobile (slide in from right) */}
          {isMobile && hasRightSidebar && (
            <div
              className={`fixed inset-y-0 right-0 z-30 w-72 transform transition-transform duration-200 border-l border-theme-200 bg-theme-50 overflow-auto p-3 shadow-xl ${
                rightSidebarOpen ? "translate-x-0" : "translate-x-full"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-theme-600">アクション</h3>
                <button onClick={() => setRightSidebarOpen(false)} className="rounded p-1 text-gray-400 hover:bg-theme-100">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <ActionList
                pageId={selectedPageId!}
                allPages={pages}
                allTags={tags}
                onPageClick={handleSelectPage}
                onTagClick={handleSelectTag}
                onDateClick={handleSelectDate}
                onActionChange={bumpActionVersion}
                actionVersion={actionVersion}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
