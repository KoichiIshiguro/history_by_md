"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { PageInfo, TagInfo } from "./BlockEditor";

interface MeetingRow {
  id: string;
  page_id: string | null;
  title: string;
  meeting_date: string;
  duration_sec: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface MeetingDetail extends MeetingRow {
  raw_transcript: string | null;
  polished_transcript: string | null;
  remove_fillers: number;
  attendees: string | null;
  audio_filename: string | null;
  audio_size: number | null;
}

interface Props {
  allPages: PageInfo[];
  allTags: TagInfo[];
  onPageClick: (id: string, name: string) => void;
  onDataChange: () => void;
}

type Phase = "idle" | "uploading" | "transcribing" | "transcribed" | "polishing" | "ready" | "saving" | "done" | "error";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function MeetingWorkspace({ allPages, onPageClick, onDataChange }: Props) {
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);

  // New meeting form state
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(todayStr());
  const [removeFillers, setRemoveFillers] = useState(false);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [phaseMessage, setPhaseMessage] = useState<string>("");
  const [polished, setPolished] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchMeetings = useCallback(async () => {
    const res = await fetch("/api/meetings");
    if (res.ok) setMeetings(await res.json());
  }, []);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/meetings/${id}`);
    if (!res.ok) return;
    const d = (await res.json()) as MeetingDetail;
    setDetail(d);
    setActiveId(id);
    setTitle(d.title);
    setMeetingDate(d.meeting_date || todayStr());
    setRemoveFillers(d.remove_fillers === 1);
    setAttendees(d.attendees ? JSON.parse(d.attendees) : []);
    setPolished(d.polished_transcript || d.raw_transcript || "");
    setPhase(d.status === "saved" ? "done" : d.status === "ready" ? "ready" : d.status === "error" ? "error" : "ready");
    setPhaseMessage(d.error_message || "");
  }, []);

  const resetForNew = () => {
    setActiveId(null);
    setDetail(null);
    setFile(null);
    setTitle("");
    setMeetingDate(todayStr());
    setRemoveFillers(false);
    setAttendees([]);
    setAttendeeInput("");
    setPolished("");
    setPhase("idle");
    setPhaseMessage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const addAttendee = () => {
    const name = attendeeInput.trim();
    if (!name || attendees.includes(name)) { setAttendeeInput(""); return; }
    setAttendees([...attendees, name]);
    setAttendeeInput("");
  };

  const startProcessing = async () => {
    if (!file) { alert("音声ファイルを選択してください"); return; }
    setPhase("uploading");
    setPhaseMessage("音声をアップロード中...");

    try {
      const form = new FormData();
      form.append("file", file);
      if (title.trim()) form.append("title", title.trim());
      form.append("date", meetingDate);
      form.append("language", "ja");

      setPhase("transcribing");
      setPhaseMessage("文字起こし中...（長い音声は数分かかります）");
      const transRes = await fetch("/api/meetings/transcribe", { method: "POST", body: form });
      if (!transRes.ok) {
        const err = await transRes.json().catch(() => ({}));
        throw new Error(err.error || `文字起こしエラー (HTTP ${transRes.status})`);
      }
      const transData = (await transRes.json()) as { meetingId: string; rawTranscript: string; durationSec: number };
      setActiveId(transData.meetingId);

      // Polish
      setPhase("polishing");
      setPhaseMessage("AIで清書中...");
      const polRes = await fetch("/api/meetings/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: transData.meetingId, removeFillers }),
      });
      if (!polRes.ok) {
        const err = await polRes.json().catch(() => ({}));
        throw new Error(err.error || `清書エラー (HTTP ${polRes.status})`);
      }
      const polData = (await polRes.json()) as { polishedTranscript: string };
      setPolished(polData.polishedTranscript);
      setPhase("ready");
      setPhaseMessage("");
      await fetchMeetings();
      // load detail for raw transcript display
      await loadDetail(transData.meetingId);
    } catch (err) {
      setPhase("error");
      setPhaseMessage((err as Error).message);
      fetchMeetings();
    }
  };

  const rePolish = async () => {
    if (!activeId) return;
    setPhase("polishing");
    setPhaseMessage("再清書中...");
    try {
      const res = await fetch("/api/meetings/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: activeId, removeFillers }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "再清書エラー");
      const d = (await res.json()) as { polishedTranscript: string };
      setPolished(d.polishedTranscript);
      setPhase("ready");
      await loadDetail(activeId);
    } catch (err) {
      setPhase("error");
      setPhaseMessage((err as Error).message);
    }
  };

  const commitSave = async () => {
    if (!activeId) return;
    if (!polished.trim()) { alert("本文が空です"); return; }
    setPhase("saving");
    setPhaseMessage("ページとして保存中...");
    try {
      const res = await fetch("/api/meetings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId: activeId,
          title: title.trim() || "無題の会議",
          meetingDate,
          polishedTranscript: polished,
          attendees,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "保存エラー");
      const { pageId } = (await res.json()) as { pageId: string };
      setPhase("done");
      setPhaseMessage("保存しました");
      onDataChange(); // refresh pages tree
      fetchMeetings();
      // Navigate to the newly created page
      const pageName = `会議録/${meetingDate}/${title.trim() || "無題の会議"}`;
      onPageClick(pageId, pageName);
    } catch (err) {
      setPhase("error");
      setPhaseMessage((err as Error).message);
    }
  };

  const deleteMeeting = async (id: string) => {
    if (!confirm("この会議録を削除しますか？（保存済みのページは残ります）")) return;
    await fetch("/api/meetings", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (activeId === id) resetForNew();
    fetchMeetings();
  };

  const formatStatus = (s: string) => {
    switch (s) {
      case "uploaded": return "待機中";
      case "transcribing": return "文字起こし中";
      case "transcribed": return "文字起こし完了";
      case "polishing": return "清書中";
      case "ready": return "清書完了（未保存）";
      case "saved": return "保存済み";
      case "error": return "エラー";
      default: return s;
    }
  };

  const isBusy = phase === "uploading" || phase === "transcribing" || phase === "polishing" || phase === "saving";

  return (
    <div className="mx-auto max-w-6xl flex gap-4">
      {/* Left: meeting list */}
      <div className="w-60 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-700">会議録</h3>
          <button
            onClick={resetForNew}
            className="text-xs px-2 py-0.5 rounded bg-theme-500 text-white hover:bg-theme-600"
          >+ 新規</button>
        </div>
        <div className="space-y-1">
          {meetings.length === 0 && (
            <div className="text-xs text-gray-400 py-2">まだありません</div>
          )}
          {meetings.map((m) => (
            <div
              key={m.id}
              onClick={() => loadDetail(m.id)}
              className={`cursor-pointer rounded border px-2 py-1.5 text-xs transition ${activeId === m.id ? "border-theme-400 bg-theme-50" : "border-gray-200 hover:bg-gray-50"}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate font-medium text-gray-800" title={m.title}>{m.title || "無題"}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteMeeting(m.id); }}
                  className="text-gray-400 hover:text-red-500 text-xs flex-shrink-0"
                  title="削除"
                >×</button>
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5">{m.meeting_date}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{formatStatus(m.status)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: editor panel */}
      <div className="flex-1 min-w-0">
        {phase === "idle" && !activeId && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <h2 className="text-lg font-semibold text-gray-800">新しい会議録</h2>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">タイトル</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例: 4/18 設計ミーティング"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-2 focus:ring-theme-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">日付</label>
              <input
                type="date"
                value={meetingDate}
                onChange={(e) => setMeetingDate(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-2 focus:ring-theme-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">参加者（Enter で追加）</label>
              <div className="flex gap-1 flex-wrap mb-1">
                {attendees.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-theme-100 text-theme-700">
                    {a}
                    <button onClick={() => setAttendees(attendees.filter((x) => x !== a))} className="text-theme-400 hover:text-red-500">×</button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                value={attendeeInput}
                onChange={(e) => setAttendeeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addAttendee(); } }}
                placeholder="名前を入力（例: 山田太郎）"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-2 focus:ring-theme-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">音声ファイル（mp3 / m4a / wav / webm / flac 等、最大500MB）</label>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.m4a,.mp3,.wav,.webm,.mp4,.flac,.aiff,.aif,.ogg,.opus"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 500 * 1024 * 1024) {
                    alert("ファイルサイズが上限 500MB を超えています。");
                    if (fileInputRef.current) fileInputRef.current.value = "";
                    return;
                  }
                  setFile(f);
                }}
                className="block w-full text-sm text-gray-600 file:mr-3 file:rounded file:border-0 file:bg-theme-100 file:px-3 file:py-1.5 file:text-theme-700 hover:file:bg-theme-200"
              />
              {file && <div className="text-xs text-gray-500 mt-1">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</div>}
              <div className="text-[10px] text-gray-400 mt-1">
                20MBを超える音声・WAVなどの非圧縮形式は、サーバー側で自動的に低ビットレートに圧縮されます（音声認識の精度にはほぼ影響しません）。
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-600 select-none">
              <input
                type="checkbox"
                checked={removeFillers}
                onChange={(e) => setRemoveFillers(e.target.checked)}
                className="rounded border-gray-300"
              />
              フィラー（「えーと」「あのー」等）を除去する
            </label>

            <button
              onClick={startProcessing}
              disabled={!file || isBusy}
              className="w-full rounded bg-theme-500 text-white py-2 text-sm font-medium hover:bg-theme-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              文字起こし＆清書を開始
            </button>
          </div>
        )}

        {isBusy && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
            <div className="inline-block w-8 h-8 border-3 border-theme-300 border-t-theme-600 rounded-full animate-spin mb-3" />
            <div className="text-sm text-gray-700">{phaseMessage}</div>
          </div>
        )}

        {phase === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="text-sm font-medium text-red-700 mb-1">エラーが発生しました</div>
            <div className="text-xs text-red-600 whitespace-pre-wrap">{phaseMessage}</div>
            <button onClick={resetForNew} className="mt-2 text-xs text-gray-600 hover:text-gray-900 underline">やり直す</button>
          </div>
        )}

        {(phase === "ready" || phase === "done") && detail && (
          <div className="space-y-3">
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-xs text-gray-600 block mb-0.5">タイトル</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-0.5">日付</label>
                  <input
                    type="date"
                    value={meetingDate}
                    onChange={(e) => setMeetingDate(e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-600 block mb-0.5">参加者</label>
                <div className="flex gap-1 flex-wrap mb-1">
                  {attendees.map((a) => (
                    <span key={a} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-theme-100 text-theme-700">
                      {a}
                      <button onClick={() => setAttendees(attendees.filter((x) => x !== a))} className="text-theme-400 hover:text-red-500">×</button>
                    </span>
                  ))}
                </div>
                <input
                  type="text"
                  value={attendeeInput}
                  onChange={(e) => setAttendeeInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addAttendee(); } }}
                  placeholder="名前を入力して Enter"
                  className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-gray-600 select-none">
                <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} className="rounded border-gray-300" />
                フィラー除去
              </label>
              <button
                onClick={rePolish}
                disabled={isBusy}
                className="text-xs rounded border border-gray-300 bg-white px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
              >AIで再清書</button>
              <button
                onClick={commitSave}
                disabled={isBusy || phase === "done"}
                className="ml-auto rounded bg-theme-500 text-white px-4 py-1.5 text-sm font-medium hover:bg-theme-600 disabled:opacity-50"
              >
                {phase === "done" ? "保存済み" : "ページとして保存"}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-medium text-gray-600 mb-1">文字起こし（生）</div>
                <div className="rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 whitespace-pre-wrap max-h-[60vh] overflow-auto">
                  {detail.raw_transcript || ""}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-gray-600 mb-1">清書後（編集可）</div>
                <textarea
                  value={polished}
                  onChange={(e) => setPolished(e.target.value)}
                  className="w-full rounded border border-gray-200 bg-white p-2 text-xs text-gray-800 max-h-[60vh] h-[60vh] overflow-auto font-[inherit] resize-none focus:ring-2 focus:ring-theme-400 focus:outline-none"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
