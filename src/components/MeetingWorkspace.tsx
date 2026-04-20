"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { PageInfo, TagInfo, MeetingInfo } from "./BlockEditor";
import BlockEditor from "./BlockEditor";

interface MeetingDetail {
  id: string;
  page_id: string | null;
  title: string;
  meeting_date: string;
  duration_sec: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  raw_transcript: string | null;
  polished_transcript: string | null;
  remove_fillers: number;
  attendees: string | null;
  audio_filename: string | null;
  audio_size: number | null;
}

interface Props {
  selectedMeetingId: string | null;
  onSelectMeeting: (id: string | null) => void;
  allPages: PageInfo[];
  allTags: TagInfo[];
  allMeetings: MeetingInfo[];
  onPageClick: (id: string, name: string) => void;
  onTagClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
  onDataChange: () => void;
  onReloadSignal: () => void;
}

const IN_PROGRESS = new Set(["uploaded", "transcribing", "transcribed", "polishing"]);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function MeetingWorkspace({
  selectedMeetingId, onSelectMeeting,
  allPages, allTags, allMeetings,
  onPageClick, onTagClick, onDateClick, onDataChange, onReloadSignal,
}: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);

  // Form state (used when no meeting selected)
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(todayStr());
  const [removeFillers, setRemoveFillers] = useState(false);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview state (for ready meetings)
  const [polished, setPolished] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDate, setEditDate] = useState(todayStr());
  const [editAttendees, setEditAttendees] = useState<string[]>([]);
  const [editAttendeeInput, setEditAttendeeInput] = useState("");

  // ─── Load meeting detail when selection changes ──────
  const loadDetail = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    try {
      const res = await fetch(`/api/meetings/${id}`);
      if (!res.ok) return;
      const d = (await res.json()) as MeetingDetail;
      setDetail(d);
      if (!opts?.silent) {
        setEditTitle(d.title);
        setEditDate(d.meeting_date || todayStr());
        const parsed: string[] = d.attendees ? JSON.parse(d.attendees) : [];
        setEditAttendees(parsed);
        setPolished(d.polished_transcript || d.raw_transcript || "");
        setRemoveFillers(d.remove_fillers === 1);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (selectedMeetingId) loadDetail(selectedMeetingId);
    else setDetail(null);
  }, [selectedMeetingId, loadDetail]);

  // Polling while in-progress (so the UI auto-updates)
  useEffect(() => {
    if (!detail) return;
    if (!IN_PROGRESS.has(detail.status)) return;
    const id = setInterval(() => {
      if (selectedMeetingId) loadDetail(selectedMeetingId, { silent: true });
      onReloadSignal(); // also refresh sidebar
    }, 4000);
    return () => clearInterval(id);
  }, [detail, selectedMeetingId, loadDetail, onReloadSignal]);

  // When detail transitions to "ready", seed the edit fields
  useEffect(() => {
    if (detail && detail.status === "ready") {
      setEditTitle(detail.title);
      setEditDate(detail.meeting_date || todayStr());
      setEditAttendees(detail.attendees ? JSON.parse(detail.attendees) : []);
      setPolished(detail.polished_transcript || "");
      setRemoveFillers(detail.remove_fillers === 1);
    }
  }, [detail?.id, detail?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = () => {
    setFile(null);
    setTitle("");
    setMeetingDate(todayStr());
    setRemoveFillers(false);
    setAttendees([]);
    setAttendeeInput("");
    setUploading(false);
    setUploadError("");
    setPastedText("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const addAttendee = () => {
    const name = attendeeInput.trim();
    if (!name || attendees.includes(name)) { setAttendeeInput(""); return; }
    setAttendees([...attendees, name]);
    setAttendeeInput("");
  };

  const addEditAttendee = () => {
    const name = editAttendeeInput.trim();
    if (!name || editAttendees.includes(name)) { setEditAttendeeInput(""); return; }
    setEditAttendees([...editAttendees, name]);
    setEditAttendeeInput("");
  };

  // ─── New upload ──────
  // Input mode: "audio" = file upload → Whisper → Gemini; "text" = pasted text → Gemini only
  const [inputMode, setInputMode] = useState<"audio" | "text">("audio");
  const [pastedText, setPastedText] = useState("");

  const startUpload = async () => {
    if (inputMode === "audio") {
      if (!file) { alert("音声ファイルを選択してください"); return; }
    } else {
      if (!pastedText.trim()) { alert("テキストを入力してください"); return; }
    }
    setUploading(true);
    setUploadError("");
    try {
      let meetingId: string;
      if (inputMode === "audio") {
        const form = new FormData();
        form.append("file", file!);
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
        const data = await res.json();
        meetingId = data.meetingId;
      } else {
        // Text-only path: skip Whisper, just polish the pasted text
        const res = await fetch("/api/meetings/create-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: pastedText,
            title: title.trim() || undefined,
            date: meetingDate,
            attendees,
            removeFillers,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `送信エラー (HTTP ${res.status})`);
        }
        const data = await res.json();
        meetingId = data.meetingId;
      }
      resetForm();
      onReloadSignal();
      onSelectMeeting(meetingId);
    } catch (err) {
      setUploadError((err as Error).message);
      setUploading(false);
    }
  };

  // ─── Approve (ready → saved) ──────
  const commitApprove = async () => {
    if (!selectedMeetingId) return;
    if (!polished.trim()) { alert("本文が空です"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/meetings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId: selectedMeetingId,
          title: editTitle.trim(),
          meetingDate: editDate,
          polishedTranscript: polished,
          attendees: editAttendees,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "保存エラー");
      onDataChange();
      onReloadSignal();
      // Reload detail — now in 'saved' state
      await loadDetail(selectedMeetingId);
    } catch (err) {
      alert("保存に失敗しました: " + (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteMeeting = async () => {
    if (!selectedMeetingId) return;
    if (!confirm("この会議録を削除しますか？")) return;
    await fetch("/api/meetings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: selectedMeetingId }),
    });
    onSelectMeeting(null);
    onReloadSignal();
  };

  // ─── Render by state ───────────────────────────────────

  // No meeting selected → upload form
  if (!selectedMeetingId) {
    return (
      <div className="mx-auto max-w-2xl">
        <NewMeetingForm
          inputMode={inputMode} setInputMode={setInputMode}
          pastedText={pastedText} setPastedText={setPastedText}
          file={file} setFile={setFile}
          title={title} setTitle={setTitle}
          meetingDate={meetingDate} setMeetingDate={setMeetingDate}
          attendees={attendees} setAttendees={setAttendees}
          attendeeInput={attendeeInput} setAttendeeInput={setAttendeeInput}
          removeFillers={removeFillers} setRemoveFillers={setRemoveFillers}
          fileInputRef={fileInputRef} addAttendee={addAttendee}
          onStart={startUpload} busy={uploading}
          error={uploadError}
        />
      </div>
    );
  }

  // No detail yet (loading)
  if (!detail) {
    return <div className="mx-auto max-w-2xl text-center text-gray-400 p-8">読み込み中...</div>;
  }

  // Error state
  if (detail.status === "error") {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="text-sm font-medium text-red-700 mb-1">エラーが発生しました</div>
        <div className="text-xs text-red-600 whitespace-pre-wrap">{detail.error_message}</div>
        <div className="flex gap-2 mt-3">
          <button onClick={() => onSelectMeeting(null)} className="text-xs rounded border border-gray-300 bg-white px-3 py-1 hover:bg-gray-50">新規作成に戻る</button>
          <button onClick={deleteMeeting} className="text-xs text-red-600 hover:underline ml-auto">この会議録を削除</button>
        </div>
      </div>
    );
  }

  // Processing (transcribing / polishing)
  if (IN_PROGRESS.has(detail.status)) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-start gap-3">
            <div className="inline-block w-6 h-6 border-3 border-blue-300 border-t-blue-600 rounded-full animate-spin flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-medium text-blue-900">処理中...</div>
              <div className="text-xs text-blue-700 mt-1">
                {detail.audio_filename
                  ? (detail.status === "polishing" ? "AI が文字起こしを清書中です..." :
                     detail.status === "transcribed" ? "文字起こし完了。清書を開始中..." :
                     "文字起こしを実行中...")
                  : "AI が清書中です..."}
              </div>
              <div className="text-[11px] text-blue-600 mt-2 rounded bg-white/60 px-2 py-1.5">
                ✅ {detail.audio_filename ? "アップロード" : "テキスト送信"}は完了しています。<br />
                <b>このブラウザを閉じても処理は続行されます</b>。
              </div>
            </div>
          </div>
        </div>
        <div className="rounded border border-gray-200 bg-white p-3 text-xs text-gray-600 space-y-0.5">
          <div><b>タイトル:</b> {detail.title}</div>
          <div><b>日付:</b> {detail.meeting_date}</div>
          {detail.audio_size && <div><b>ファイルサイズ:</b> {(detail.audio_size / 1024 / 1024).toFixed(1)} MB</div>}
        </div>
      </div>
    );
  }

  // Ready → preview + approve
  if (detail.status === "ready") {
    return (
      <div className="mx-auto max-w-5xl space-y-3">
        <div className="rounded bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-900">
          📋 <b>承認前のプレビュー</b>です。内容を確認・編集してから「承認」ボタンを押してください。
          承認すると文字起こしと音声ファイルは削除され、以降はページとして編集できます。
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600 block mb-0.5">タイトル</label>
              <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                placeholder="空のままにするとAIが自動生成します" />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-0.5">日付</label>
              <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-0.5">参加者</label>
            <div className="flex gap-1 flex-wrap mb-1">
              {editAttendees.map((a) => (
                <span key={a} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-theme-100 text-theme-700">
                  {a}
                  <button onClick={() => setEditAttendees(editAttendees.filter((x) => x !== a))} className="text-theme-400 hover:text-red-500">×</button>
                </span>
              ))}
            </div>
            <input type="text" value={editAttendeeInput} onChange={(e) => setEditAttendeeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addEditAttendee(); } }}
              placeholder="名前を入力して Enter"
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={deleteMeeting} className="text-xs text-red-500 hover:text-red-700 hover:underline">
            削除
          </button>
          <button onClick={commitApprove} disabled={saving}
            className="ml-auto rounded bg-theme-500 text-white px-6 py-2 text-sm font-medium hover:bg-theme-600 disabled:opacity-50">
            {saving ? "保存中..." : "承認して会議録ページにする"}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">{detail.audio_filename ? "文字起こし（生）" : "元のテキスト"}</div>
            <div className="rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 whitespace-pre-wrap max-h-[60vh] overflow-auto">
              {detail.raw_transcript || ""}
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

  // Saved (approved) → show as editable page
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="pb-2 border-b border-gray-200">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-semibold text-gray-800">{detail.title}</h1>
            <div className="text-xs text-gray-500 mt-0.5">
              <span className="date-link cursor-pointer" onClick={() => onDateClick(detail.meeting_date)}>
                {detail.meeting_date}
              </span>
              {detail.duration_sec ? ` · ${formatDuration(detail.duration_sec)}` : ""}
            </div>
          </div>
          <button onClick={deleteMeeting} className="text-xs text-gray-400 hover:text-red-500">削除</button>
        </div>

        <AttendeesHeader
          attendees={editAttendees}
          setAttendees={async (next) => {
            setEditAttendees(next);
            try {
              await fetch(`/api/meetings/${detail.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ attendees: next }),
              });
            } catch { /* noop */ }
          }}
          allPages={allPages}
          onPageClick={onPageClick}
        />
      </div>

      <BlockEditor
        viewMode="meeting"
        selectedDate=""
        selectedPageId={null}
        selectedPageName=""
        selectedTagId={null}
        selectedTagName=""
        selectedMeetingId={detail.id}
        allPages={allPages}
        allTags={allTags}
        allMeetings={allMeetings}
        onPageClick={onPageClick}
        onTagClick={onTagClick}
        onDateClick={onDateClick}
        onMeetingClick={onSelectMeeting}
        onDataChange={onDataChange}
      />
    </div>
  );
}

// ─── Sub components ───────────────────────────────────────────

function NewMeetingForm(props: any) {
  const { inputMode, setInputMode, pastedText, setPastedText,
    file, setFile, title, setTitle, meetingDate, setMeetingDate, attendees, setAttendees,
    attendeeInput, setAttendeeInput, removeFillers, setRemoveFillers, fileInputRef, addAttendee,
    onStart, busy, error } = props;
  const disabled = busy || (inputMode === "audio" ? !file : !pastedText.trim());
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <h2 className="text-lg font-semibold text-gray-800">新しい会議録</h2>

      {/* Input mode tabs */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setInputMode("audio")}
          className={`px-3 py-1.5 text-sm border-b-2 transition ${inputMode === "audio" ? "border-theme-500 text-theme-600 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >🎙️ 音声ファイル</button>
        <button
          onClick={() => setInputMode("text")}
          className={`px-3 py-1.5 text-sm border-b-2 transition ${inputMode === "text" ? "border-theme-500 text-theme-600 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >📝 テキスト貼り付け</button>
      </div>

      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">タイトル（空の場合はAIが自動生成）</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="例: Q2戦略MTG（省略可）"
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

      {inputMode === "audio" ? (
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">音声ファイル（最大500MB、自動圧縮）</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.m4a,.mp3,.wav,.webm,.mp4,.flac,.aiff,.aif,.ogg,.opus"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f && f.size > 500 * 1024 * 1024) { alert("上限 500MB を超えています。"); if (fileInputRef.current) fileInputRef.current.value = ""; return; }
              setFile(f);
            }}
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded file:border-0 file:bg-theme-100 file:px-3 file:py-1.5 file:text-theme-700 hover:file:bg-theme-200" />
          {file && <div className="text-xs text-gray-500 mt-1">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</div>}
        </div>
      ) : (
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">会議メモ（テキスト）</label>
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder="会議中にとったメモを貼り付けてください。断片的・口語的でも、AIが読みやすく整えます（要約はしません）。"
            rows={10}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-[inherit] focus:ring-2 focus:ring-theme-400 focus:outline-none resize-y"
          />
          <div className="text-[10px] text-gray-400 mt-0.5 flex justify-between">
            <span>{pastedText.length.toLocaleString()} 文字 / 300,000</span>
            <span>音声はアップロードされません。Geminiで整形のみ行います。</span>
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-xs text-gray-600 select-none">
        <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} className="rounded border-gray-300" />
        フィラー（「えーと」「あのー」等）を除去する
      </label>

      <button onClick={onStart} disabled={disabled}
        className="w-full rounded bg-theme-500 text-white py-2 text-sm font-medium hover:bg-theme-600 disabled:opacity-50 disabled:cursor-not-allowed">
        {busy
          ? (inputMode === "audio" ? "アップロード中..." : "送信中...")
          : (inputMode === "audio" ? "アップロードして処理開始" : "テキストを清書")}
      </button>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <div className="text-[11px] text-gray-500 text-center">
        {inputMode === "audio"
          ? "アップロード完了後、文字起こし・清書はサーバー側で実行されます（ブラウザを閉じてもOK）"
          : "送信後、清書はサーバー側で実行されます（ブラウザを閉じてもOK）"}
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${sec % 60}秒`;
  return `${sec}秒`;
}

/**
 * Attendees chip display for the meeting header.
 * - Attendees are metadata only (no pages are auto-created).
 * - If a page with the same name already exists, the chip becomes a clickable link.
 * - Editable inline: users can add/remove attendees after approval.
 */
function AttendeesHeader({
  attendees, setAttendees, allPages, onPageClick,
}: {
  attendees: string[];
  setAttendees: (next: string[]) => void;
  allPages: PageInfo[];
  onPageClick: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");

  const findPage = (name: string) => allPages.find((p) => p.name === name || p.full_path === name);

  const add = () => {
    const name = input.trim();
    if (!name || attendees.includes(name)) { setInput(""); return; }
    setAttendees([...attendees, name]);
    setInput("");
  };

  return (
    <div className="mt-2 flex items-center flex-wrap gap-1">
      <span className="text-xs text-gray-500">👥</span>
      {attendees.length === 0 && !editing && (
        <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-theme-600 underline">
          参加者を追加
        </button>
      )}
      {attendees.map((a) => {
        const page = findPage(a);
        return (
          <span key={a} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100">
            {page ? (
              <span className="page-link cursor-pointer" onClick={() => onPageClick(page.id, page.full_path || page.name)}>{a}</span>
            ) : (
              <span className="text-gray-700">{a}</span>
            )}
            {editing && (
              <button onClick={() => setAttendees(attendees.filter((x) => x !== a))} className="text-gray-400 hover:text-red-500">×</button>
            )}
          </span>
        );
      })}
      {editing && (
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); }
            else if (e.key === "Escape") { setInput(""); setEditing(false); }
          }}
          onBlur={() => { if (input.trim()) add(); setEditing(false); }}
          placeholder="名前を入力して Enter"
          autoFocus
          className="border border-gray-300 rounded px-2 py-0.5 text-xs w-40 focus:ring-1 focus:ring-theme-400 focus:outline-none"
        />
      )}
      {!editing && attendees.length > 0 && (
        <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-theme-600 ml-1">編集</button>
      )}
    </div>
  );
}
