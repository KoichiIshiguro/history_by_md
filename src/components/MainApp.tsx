"use client";

import { signOut } from "next-auth/react";
import { useState, useEffect, useCallback } from "react";
import BlockEditor from "./BlockEditor";
import AdminPanel from "./AdminPanel";
import Sidebar from "./Sidebar";

type ViewMode = "date" | "page" | "tag" | "admin";

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
  user: { id: string; name?: string | null; email?: string | null; image?: string | null; role: string };
  isAdmin: boolean;
}

export default function MainApp({ user, isAdmin }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("date");
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedPageName, setSelectedPageName] = useState("");
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [selectedTagName, setSelectedTagName] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

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

  const handleSelectPage = (pageId: string, pageName: string) => {
    setViewMode("page");
    setSelectedPageId(pageId);
    setSelectedPageName(pageName);
  };

  const handleSelectTag = (tagId: string, tagName: string) => {
    setViewMode("tag");
    setSelectedTagId(tagId);
    setSelectedTagName(tagName);
  };

  const handleSelectDate = (date: string) => {
    setViewMode("date");
    setSelectedDate(date);
  };

  const handleDataChange = () => {
    fetchPages();
    fetchTags();
    fetchDates();
  };

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`${
          isMobile
            ? `fixed inset-y-0 left-0 z-30 w-72 transform transition-transform duration-200 ${
                sidebarOpen ? "translate-x-0" : "-translate-x-full"
              }`
            : `${sidebarOpen ? "w-64" : "w-0"} transition-all duration-200 overflow-hidden`
        } border-r border-gray-200 bg-gray-50 flex-shrink-0`}
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
          onSignOut={() => signOut()}
          onPagesChange={fetchPages}
          onTagsChange={fetchTags}
          onCloseMobile={closeMobileSidebar}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h1 className="text-lg font-semibold text-gray-800">
              {viewMode === "date" && (
                <>
                  <span className="text-gray-400 text-sm mr-2">日付</span>
                  {selectedDate}
                </>
              )}
              {viewMode === "page" && (
                <>
                  <span className="text-gray-400 text-sm mr-2">ページ</span>
                  {selectedPageName}
                </>
              )}
              {viewMode === "tag" && (
                <>
                  <span className="text-gray-400 text-sm mr-2">タグ</span>
                  <span className="tag-inline">{selectedTagName}</span>
                </>
              )}
              {viewMode === "admin" && "ユーザー管理"}
            </h1>
          </div>
          {viewMode === "date" && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  const d = new Date(selectedDate);
                  d.setDate(d.getDate() - 1);
                  setSelectedDate(d.toISOString().split("T")[0]);
                }}
                className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
              >
                ←
              </button>
              <button
                onClick={() => setSelectedDate(new Date().toISOString().split("T")[0])}
                className="rounded px-2 py-1 text-sm text-blue-600 hover:bg-blue-50"
              >
                今日
              </button>
              <button
                onClick={() => {
                  const d = new Date(selectedDate);
                  d.setDate(d.getDate() + 1);
                  setSelectedDate(d.toISOString().split("T")[0]);
                }}
                className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
              >
                →
              </button>
            </div>
          )}
        </header>

        <main className="flex-1 overflow-auto p-4">
          {viewMode === "admin" && isAdmin ? (
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
            />
          )}
        </main>
      </div>
    </div>
  );
}
