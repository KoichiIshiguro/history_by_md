"use client";

import { useEffect, useState, useCallback } from "react";

interface MeetingRow {
  id: string;
  title: string;
  meeting_date: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface Props {
  activeMeetingId?: string | null;
  onSelectMeeting: (meetingId: string) => void;
  onCreateNew: () => void;
  reloadSignal?: number;
}

const IN_PROGRESS = new Set(["uploaded", "transcribing", "transcribed", "polishing"]);

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "transcribing": return { label: "文字起こし中", cls: "bg-blue-50 text-blue-700" };
    case "polishing": return { label: "清書中", cls: "bg-blue-50 text-blue-700" };
    case "ready": return { label: "未承認", cls: "bg-amber-100 text-amber-800 font-medium" };
    case "error": return { label: "エラー", cls: "bg-red-50 text-red-700" };
    default: return { label: "", cls: "" };
  }
}

export default function MeetingsSidebar({ activeMeetingId, onSelectMeeting, onCreateNew, reloadSignal }: Props) {
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [openDates, setOpenDates] = useState<Set<string>>(new Set());

  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch("/api/meetings");
      if (res.ok) {
        const list = (await res.json()) as MeetingRow[];
        setMeetings(list);
        // Auto-open the most recent date on first load
        if (list.length > 0 && openDates.size === 0) {
          setOpenDates(new Set([list[0].meeting_date]));
        }
      }
    } catch { /* silent */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings, reloadSignal]);

  // Poll while any meeting is in-progress
  useEffect(() => {
    const hasInProgress = meetings.some((m) => IN_PROGRESS.has(m.status));
    if (!hasInProgress) return;
    const id = setInterval(fetchMeetings, 4000);
    return () => clearInterval(id);
  }, [meetings, fetchMeetings]);

  // Group by date (descending)
  const byDate = meetings.reduce<Record<string, MeetingRow[]>>((acc, m) => {
    const d = m.meeting_date || "日付なし";
    if (!acc[d]) acc[d] = [];
    acc[d].push(m);
    return acc;
  }, {});
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  const toggleDate = (date: string) => {
    setOpenDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  };

  const unsavedCount = meetings.filter((m) => m.status === "ready").length;
  const inProgressCount = meetings.filter((m) => IN_PROGRESS.has(m.status)).length;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-3 border-b border-gray-200">
        <h3 className="text-sm font-medium text-gray-700">会議録</h3>
        <button onClick={onCreateNew}
          className="text-xs rounded bg-theme-500 text-white px-2 py-1 hover:bg-theme-600"
        >+ 新規</button>
      </div>

      {(unsavedCount > 0 || inProgressCount > 0) && (
        <div className="px-3 py-2 space-y-1 border-b border-gray-100">
          {inProgressCount > 0 && (
            <div className="flex items-center gap-1.5 rounded bg-blue-50 border border-blue-200 px-2 py-1 text-xs text-blue-700">
              <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              処理中 {inProgressCount} 件
            </div>
          )}
          {unsavedCount > 0 && (
            <div className="rounded bg-amber-50 border border-amber-300 px-2 py-1 text-xs text-amber-800 font-medium">
              📋 未承認 {unsavedCount} 件
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {sortedDates.length === 0 && (
          <div className="px-3 py-4 text-xs text-gray-400">まだ会議録はありません</div>
        )}

        {sortedDates.map((date) => {
          const items = byDate[date];
          const isOpen = openDates.has(date);
          return (
            <div key={date} className="border-b border-gray-100">
              <button
                onClick={() => toggleDate(date)}
                className="w-full flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
              >
                <svg className={`h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
                <span>{date}</span>
                <span className="ml-auto text-[10px] text-gray-400">{items.length}</span>
              </button>
              {isOpen && (
                <div className="pb-1">
                  {items.map((m) => {
                    const isActive = activeMeetingId === m.id;
                    const isUnsaved = m.status === "ready";
                    const badge = statusBadge(m.status);
                    return (
                      <button
                        key={m.id}
                        onClick={() => onSelectMeeting(m.id)}
                        className={`w-full text-left px-5 py-1.5 text-xs flex items-start gap-1.5 ${
                          isActive ? "bg-theme-100" :
                          isUnsaved ? "bg-amber-50/60 hover:bg-amber-50" :
                          "hover:bg-gray-50"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className={`truncate ${isActive ? "font-medium text-theme-700" : "text-gray-700"}`} title={m.title}>
                            {m.title || "無題"}
                          </div>
                          {badge.label && (
                            <div className={`inline-block mt-0.5 text-[10px] rounded px-1 ${badge.cls}`}>
                              {IN_PROGRESS.has(m.status) && (
                                <svg className="inline h-2 w-2 animate-spin mr-1" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                              )}
                              {badge.label}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
