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

type UiState =
  | "form"            // no active meeting — show upload form
  | "uploading"       // HTTP upload in progress (blocking)
  | "processing"     // upload done, server is working in background
  | "ready"           // polished transcript is ready to review
  | "saving"          // saving to page
  | "done"            // page saved
  | "error";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "uploaded": return "待機中";
    case "transcribing": return "文字起こし中";
    case "transcribed": return "文字起こし完了";
    case "polishing": return "清書中";
    case "ready": return "未保存";
    case "saved": return "保存済み";
    case "error": return "エラー";
    default: return status;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "transcribing":
    case "polishing":
    case "uploaded":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "ready":
      return "bg-amber-100 text-amber-800 border-amber-300 font-semibold";
    case "saved":
      return "bg-gray-100 text-gray-500 border-gray-200";
    case "error":
      return "bg-red-50 text-red-700 border-red-200";
    default:
      return "bg-gray-100 text-gray-600 border-gray-200";
  }
}

const IN_PROGRESS = new Set(["uploaded", "transcribing", "transcribed", "polishing"]);

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

  const [ui, setUi] = useState<UiState>("form");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [polished, setPolished] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch("/api/meetings");
      if (res.ok) setMeetings(await res.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

  // ─── Polling: keep fetching while any meeting is in-progress ──
  useEffect(() => {
    const hasInProgress = meetings.some((m) => IN_PROGRESS.has(m.status));
    if (!hasInProgress) {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      return;
    }
    if (pollingRef.current) return; // already polling

    pollingRef.current = setInterval(() => {
      fetchMeetings();
      // Also refresh active detail if it's in progress
      if (activeId) {
        const active = meetings.find((m) => m.id === activeId);
        if (active && IN_PROGRESS.has(active.status)) {
          loadDetail(activeId, { silent: true });
        }
      }
    }, 4000);

    return () => {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    };
  }, [meetings, activeId, fetchMeetings]);

  // ─── Load meeting detail ──────────────────────────────────
  const loadDetail = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    try {
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
      setErrorMsg(d.error_message || "");

      // Map server status → UI state
      if (d.status === "saved") setUi("done");
      else if (d.status === "ready") setUi("ready");
      else if (d.status === "error") setUi("error");
      else if (IN_PROGRESS.has(d.status)) setUi("processing");
      else if (!opts?.silent) setUi("ready");
    } catch { /* silent */ }
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
    setUi("form");
    setErrorMsg("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const addAttendee = () => {
    const name = attendeeInput.trim();
    if (!name || attendees.includes(name)) { setAttendeeInput(""); return; }
    setAttendees([...attendees, name]);
    setAttendeeInput("");
  };

  // ─── Upload (blocking) then hand off to background ────────
  const startProcessing = async () => {
    if (!file) { alert("音声ファイルを選択してください"); return; }
    setUi("uploading");
    setErrorMsg("");

    try {
      const form = new FormData();
      form.append("file", file);
      if (title.trim()) form.append("title", title.trim());
      form.append("date", meetingDate);
      form.append("language", "ja");
      form.append("attendees", JSON.stringify(attendees));
      form.append("removeFillers", removeFillers ? "1" : "0");

      const res = await fetch("/api/meetings/transcribe", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `アップロードエラー (HTTP ${res.status})`);
      }
      const { meetingId } = (await res.json()) as { meetingId: string };
      // Upload complete — server is now working in the background.
      setActiveId(meetingId);
      setUi("processing");
      await fetchMeetings();
    } catch (err) {
      setUi("error");
      setErrorMsg((err as Error).message);
    }
  };

  // ─── Re-polish (reuses cached audio if within 24h) ──────
  const rePolish = async () => {
    if (!activeId) return;
    setUi("processing");
    setErrorMsg("");
    try {
      const res = await fetch("/api/meetings/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: activeId, removeFillers }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "再清書エラー");
      const d = (await res.json()) as { polishedTranscript: string; usedAudio: boolean };
      setPolished(d.polishedTranscript);
      setUi("ready");
      await loadDetail(activeId, { silent: true });
    } catch (err) {
      setUi("error");
      setErrorMsg((err as Error).message);
    }
  };

  const commitSave = async () => {
    if (!activeId) return;
    if (!polished.trim()) { alert("本文が空です"); return; }
    setUi("saving");
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
      setUi("done");
      onDataChange();
      fetchMeetings();
      const pageName = `会議録/${meetingDate}/${title.trim() || "無題の会議"}`;
      onPageClick(pageId, pageName);
    } catch (err) {
      setUi("error");
      setErrorMsg((err as Error).message);
    }
  };

  const deleteMeeting = async (id: string) => {
    if (!confirm("この会議録を削除しますか？（保存済みのページは残ります）")) return;
    await fetch("/api/meetings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (activeId === id) resetForNew();
    fetchMeetings();
  };

  const unsavedCount = meetings.filter((m) => m.status === "ready").length;
  const inProgressCount = meetings.filter((m) => IN_PROGRESS.has(m.status)).length;

  return (
    <div className="mx-auto max-w-6xl flex gap-4">
      {/* Left: meeting list */}
      <div className="w-64 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-700">会議録</h3>
          <button
            onClick={resetForNew}
            className="text-xs px-2 py-0.5 rounded bg-theme-500 text-white hover:bg-theme-600"
          >+ 新規</button>
        </div>

        {/* Summary callouts */}
        {(unsavedCount > 0 || inProgressCount > 0) && (
          <div className="mb-2 space-y-1">
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
                📋 未保存 {unsavedCount} 件 — 確認してページ化を
              </div>
            )}
          </div>
        )}

        <div className="space-y-1">
          {meetings.length === 0 && (
            <div className="text-xs text-gray-400 py-2">まだありません</div>
          )}
          {meetings.map((m) => {
            const isActive = activeId === m.id;
            const isUnsaved = m.status === "ready";
            return (
              <div
                key={m.id}
                onClick={() => loadDetail(m.id)}
                className={`cursor-pointer rounded border px-2 py-1.5 text-xs transition ${
                  isActive
                    ? "border-theme-400 bg-theme-50"
                    : isUnsaved
                    ? "border-amber-300 bg-amber-50/60 hover:bg-amber-50"
                    : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-medium text-gray-800" title={m.title}>{m.title || "無題"}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteMeeting(m.id); }}
                    className="text-gray-400 hover:text-red-500 text-xs flex-shrink-0 leading-none"
                    title="削除"
                  >×</button>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">{m.meeting_date}</div>
                <span className={`inline-block mt-0.5 text-[10px] rounded border px-1 ${statusColor(m.status)}`}>
                  {IN_PROGRESS.has(m.status) && (
                    <span className="inline-block mr-1">
                      <svg className="inline h-2 w-2 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    </span>
                  )}
                  {statusLabel(m.status)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: editor panel */}
      <div className="flex-1 min-w-0">
        {ui === "form" && (
          <NewMeetingForm
            file={file} setFile={setFile}
            title={title} setTitle={setTitle}
            meetingDate={meetingDate} setMeetingDate={setMeetingDate}
            attendees={attendees} setAttendees={setAttendees}
            attendeeInput={attendeeInput} setAttendeeInput={setAttendeeInput}
            removeFillers={removeFillers} setRemoveFillers={setRemoveFillers}
            fileInputRef={fileInputRef} addAttendee={addAttendee}
            onStart={startProcessing}
            busy={false}
          />
        )}

        {ui === "uploading" && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
            <div className="inline-block w-8 h-8 border-3 border-theme-300 border-t-theme-600 rounded-full animate-spin mb-3" />
            <div className="text-sm text-gray-700">音声をアップロード中...</div>
            <div className="text-xs text-gray-400 mt-2">ファイルサイズと回線速度によって時間がかかります</div>
          </div>
        )}

        {ui === "processing" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-3">
                <div className="inline-block w-6 h-6 border-3 border-blue-300 border-t-blue-600 rounded-full animate-spin flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-blue-900">処理中...</div>
                  <div className="text-xs text-blue-700 mt-1">
                    {detail?.status === "polishing" ? "AI が文字起こしを清書中です..." :
                     detail?.status === "transcribed" ? "文字起こし完了。清書を開始中..." :
                     "文字起こしを実行中..."}
                  </div>
                  <div className="text-[11px] text-blue-600 mt-2 rounded bg-white/60 px-2 py-1.5">
                    ✅ アップロードは完了しています。<br />
                    <b>このブラウザを閉じても処理は続行されます</b>。後で戻ってきて結果を確認できます。
                  </div>
                </div>
              </div>
            </div>
            {detail && (
              <div className="rounded border border-gray-200 bg-white p-3 text-xs text-gray-600">
                <div><b>タイトル:</b> {detail.title}</div>
                <div><b>日付:</b> {detail.meeting_date}</div>
                {detail.audio_size && <div><b>ファイルサイズ:</b> {(detail.audio_size / 1024 / 1024).toFixed(1)} MB</div>}
              </div>
            )}
          </div>
        )}

        {ui === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="text-sm font-medium text-red-700 mb-1">エラーが発生しました</div>
            <div className="text-xs text-red-600 whitespace-pre-wrap">{errorMsg}</div>
            <div className="flex gap-2 mt-3">
              <button onClick={resetForNew} className="text-xs text-gray-600 hover:text-gray-900 underline">やり直す</button>
              {activeId && <button onClick={rePolish} className="text-xs text-theme-600 hover:text-theme-800 underline">再清書を試す</button>}
            </div>
          </div>
        )}

        {(ui === "ready" || ui === "done" || ui === "saving") && detail && (
          <PreviewPanel
            title={title} setTitle={setTitle}
            meetingDate={meetingDate} setMeetingDate={setMeetingDate}
            attendees={attendees} setAttendees={setAttendees}
            attendeeInput={attendeeInput} setAttendeeInput={setAttendeeInput}
            addAttendee={addAttendee}
            removeFillers={removeFillers} setRemoveFillers={setRemoveFillers}
            polished={polished} setPolished={setPolished}
            rawTranscript={detail.raw_transcript || ""}
            onRePolish={rePolish}
            onSave={commitSave}
            busy={ui === "saving"}
            isDone={ui === "done"}
          />
        )}
      </div>
    </div>
  );
}

// ─── Sub components ───────────────────────────────────────────

function NewMeetingForm(props: any) {
  const { file, setFile, title, setTitle, meetingDate, setMeetingDate, attendees, setAttendees,
    attendeeInput, setAttendeeInput, removeFillers, setRemoveFillers, fileInputRef, addAttendee,
    onStart, busy } = props;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <h2 className="text-lg font-semibold text-gray-800">新しい会議録</h2>

      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">タイトル</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="例: 4/18 設計ミーティング"
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-2 focus:ring-theme-400 focus:outline-none" />
      </div>

      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">日付</label>
        <input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-2 focus:ring-theme-400 focus:outline-none" />
      </div>

      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">参加者（Enter で追加）</label>
        <div className="flex gap-1 flex-wrap mb-1">
          {attendees.map((a: string) => (
            <span key={a} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-theme-100 text-theme-700">
              {a}
              <button onClick={() => setAttendees(attendees.filter((x: string) => x !== a))} className="text-theme-400 hover:text-red-500">×</button>
            </span>
          ))}
        </div>
        <input type="text" value={attendeeInput} onChange={(e) => setAttendeeInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addAttendee(); } }}
          placeholder="名前を入力（例: 山田太郎）"
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-2 focus:ring-theme-400 focus:outline-none" />
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
          className="block w-full text-sm text-gray-600 file:mr-3 file:rounded file:border-0 file:bg-theme-100 file:px-3 file:py-1.5 file:text-theme-700 hover:file:bg-theme-200" />
        {file && <div className="text-xs text-gray-500 mt-1">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</div>}
        <div className="text-[10px] text-gray-400 mt-1">
          20MBを超える音声・WAVなどの非圧縮形式は、サーバー側で自動的に低ビットレートに圧縮されます。
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-600 select-none">
        <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} className="rounded border-gray-300" />
        フィラー（「えーと」「あのー」等）を除去する
      </label>

      <button onClick={onStart} disabled={!file || busy}
        className="w-full rounded bg-theme-500 text-white py-2 text-sm font-medium hover:bg-theme-600 disabled:opacity-50 disabled:cursor-not-allowed">
        アップロードして処理開始
      </button>
      <div className="text-[11px] text-gray-500 text-center">
        アップロード完了後、文字起こし・清書はサーバー側で実行されます（ブラウザを閉じてもOK）
      </div>
    </div>
  );
}

function PreviewPanel(props: any) {
  const { title, setTitle, meetingDate, setMeetingDate, attendees, setAttendees,
    attendeeInput, setAttendeeInput, addAttendee, removeFillers, setRemoveFillers,
    polished, setPolished, rawTranscript, onRePolish, onSave, busy, isDone } = props;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-xs text-gray-600 block mb-0.5">タイトル</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-0.5">日付</label>
            <input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600 block mb-0.5">参加者</label>
          <div className="flex gap-1 flex-wrap mb-1">
            {attendees.map((a: string) => (
              <span key={a} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-theme-100 text-theme-700">
                {a}
                <button onClick={() => setAttendees(attendees.filter((x: string) => x !== a))} className="text-theme-400 hover:text-red-500">×</button>
              </span>
            ))}
          </div>
          <input type="text" value={attendeeInput} onChange={(e) => setAttendeeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addAttendee(); } }}
            placeholder="名前を入力して Enter"
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-gray-600 select-none">
          <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} className="rounded border-gray-300" />
          フィラー除去
        </label>
        <button onClick={onRePolish} disabled={busy}
          className="text-xs rounded border border-gray-300 bg-white px-2 py-1 hover:bg-gray-50 disabled:opacity-50">
          AIで再清書
        </button>
        <button onClick={onSave} disabled={busy || isDone}
          className="ml-auto rounded bg-theme-500 text-white px-4 py-1.5 text-sm font-medium hover:bg-theme-600 disabled:opacity-50">
          {isDone ? "保存済み" : "ページとして保存"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">文字起こし（生）</div>
          <div className="rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 whitespace-pre-wrap max-h-[60vh] overflow-auto">
            {rawTranscript}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">清書後（編集可）</div>
          <textarea value={polished} onChange={(e) => setPolished(e.target.value)}
            className="w-full rounded border border-gray-200 bg-white p-2 text-xs text-gray-800 max-h-[60vh] h-[60vh] overflow-auto font-[inherit] resize-none focus:ring-2 focus:ring-theme-400 focus:outline-none" />
        </div>
      </div>
    </div>
  );
}
