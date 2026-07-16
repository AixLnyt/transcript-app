"use client";

import { useEffect, useRef, useState } from "react";
import { TranscribeResponse, TranscriptSegment } from "@/app/types/transcript";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

interface TranscriptPlayerProps {
  result: TranscribeResponse;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// 依講者名稱字串算出一個固定的顏色索引，讓同一位講者在畫面上顏色一致
const SPEAKER_COLORS = [
  "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
];

function speakerColor(speaker: string): string {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length];
}

// srt 格式時間戳記: 00:00:01,000（逗號分隔毫秒）
function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
}

// vtt 格式時間戳記: 00:00:01.000（句點分隔毫秒）
function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(",", ".");
}

function speakerPrefix(seg: TranscriptSegment): string {
  return seg.speaker ? `[${seg.speaker.replace("SPEAKER_", "講者")}] ` : "";
}

function buildTxt(segments: TranscriptSegment[]): string {
  return segments.map((seg) => `${formatTime(seg.start)}\t${speakerPrefix(seg)}${seg.text}`).join("\n");
}

function buildSrt(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${speakerPrefix(seg)}${seg.text}\n`
    )
    .join("\n");
}

function buildVtt(segments: TranscriptSegment[]): string {
  const body = segments
    .map((seg) => `${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}\n${speakerPrefix(seg)}${seg.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function DownloadButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 hover:border-indigo-300 dark:border-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

function highlightMatch(text: string, query: string) {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-amber-200 px-0.5 dark:bg-amber-500/40 dark:text-amber-100">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function TranscriptPlayer({ result }: TranscriptPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  // 自動捲動追蹤：不管是影片播放中自然推進到下一句，
  // 還是手動點擊/搜尋跳轉，只要 activeIndex 改變，
  // 就把該行捲動到逐字稿列表的可視範圍內。
  useEffect(() => {
    if (activeIndex === null) return;
    segmentRefs.current[activeIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  };

  const handleDownload = (builder: (segs: TranscriptSegment[]) => string, filename: string) => {
    try {
      if (result.segments.length === 0) {
        throw new Error("沒有逐字稿內容可以下載");
      }
      downloadText(builder(result.segments), filename);
      showToast(`已下載 ${filename}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "下載失敗，請稍後再試", "error");
    }
  };

  const handleSegmentClick = (index: number, start: number) => {
    if (mediaRef.current) {
      mediaRef.current.currentTime = start;
      mediaRef.current.play();
    }
    setActiveIndex(index);
  };

  const handleTimeUpdate = () => {
    if (!mediaRef.current) return;
    const currentTime = mediaRef.current.currentTime;
    const idx = result.segments.findIndex(
      (seg) => currentTime >= seg.start && currentTime < seg.end
    );
    if (idx !== -1 && idx !== activeIndex) {
      setActiveIndex(idx);
    }
  };

  const mediaUrl = `${API_BASE}${result.media_url}`;

  const matchIndices = searchQuery.trim()
    ? result.segments.reduce<number[]>((acc, seg, i) => {
        if (seg.text.toLowerCase().includes(searchQuery.toLowerCase())) acc.push(i);
        return acc;
      }, [])
    : [];

  const jumpToMatch = (direction: 1 | -1) => {
    if (matchIndices.length === 0) return;
    const next = (matchCursor + direction + matchIndices.length) % matchIndices.length;
    setMatchCursor(next);
    const targetIndex = matchIndices[next];
    handleSegmentClick(targetIndex, result.segments[targetIndex].start);
  };

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = rate;
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* 播放器區塊 */}
      <div className="lg:col-span-3">
        <div className="sticky top-6 space-y-2">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-black shadow-sm dark:border-slate-700">
            {result.media_type === "video" ? (
              <video
                ref={mediaRef}
                src={mediaUrl}
                controls
                onTimeUpdate={handleTimeUpdate}
                className="aspect-video w-full bg-black"
              />
            ) : (
              <div className="flex flex-col gap-4 bg-slate-900 p-8">
                <div className="flex h-32 items-center justify-center rounded-xl bg-slate-800">
                  <span className="text-4xl">🎵</span>
                </div>
                <audio
                  ref={mediaRef}
                  src={mediaUrl}
                  controls
                  onTimeUpdate={handleTimeUpdate}
                  className="w-full"
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5 dark:border-slate-700 dark:bg-slate-800">
            <span className="px-1.5 text-xs text-slate-400 dark:text-slate-500">速度</span>
            {PLAYBACK_RATES.map((rate) => (
              <button
                key={rate}
                onClick={() => handlePlaybackRateChange(rate)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                  playbackRate === rate
                    ? "bg-indigo-500 text-white"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 逐字稿區塊 */}
      <div className="lg:col-span-2">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            逐字稿（{result.segments.length} 段）
          </h2>
          <div className="flex gap-2">
            <DownloadButton
              label="TXT"
              title="下載純文字逐字稿（含時間戳記）"
              onClick={() => handleDownload(buildTxt, "transcript.txt")}
            />
            <DownloadButton
              label="SRT"
              title="下載字幕檔（可匯入剪輯軟體）"
              onClick={() => handleDownload(buildSrt, "transcript.srt")}
            />
            <DownloadButton
              label="VTT"
              title="下載網頁字幕檔（WebVTT）"
              onClick={() => handleDownload(buildVtt, "transcript.vtt")}
            />
          </div>
        </div>

        {/* 搜尋列 */}
        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setMatchCursor(0);
              }}
              placeholder="搜尋逐字稿內容..."
              className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
          </div>
          {searchQuery.trim() && (
            <div className="flex shrink-0 items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
              <span>
                {matchIndices.length > 0 ? `${matchCursor + 1}/${matchIndices.length}` : "無符合"}
              </span>
              <button
                onClick={() => jumpToMatch(-1)}
                disabled={matchIndices.length === 0}
                className="rounded-md p-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
              >
                ↑
              </button>
              <button
                onClick={() => jumpToMatch(1)}
                disabled={matchIndices.length === 0}
                className="rounded-md p-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
              >
                ↓
              </button>
            </div>
          )}
        </div>

        <div className="max-h-[70vh] space-y-1 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          {result.segments.length === 0 && (
            <p className="p-4 text-sm text-slate-400 dark:text-slate-500">沒有偵測到語音內容</p>
          )}
          {result.segments.map((seg, i) => (
            <button
              key={i}
              ref={(el) => {
                segmentRefs.current[i] = el;
              }}
              onClick={() => handleSegmentClick(i, seg.start)}
              className={`flex w-full gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                activeIndex === i
                  ? "bg-indigo-50 text-indigo-900 dark:bg-indigo-500/20 dark:text-indigo-200"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700/50"
              }`}
            >
              <span
                className={`shrink-0 pt-0.5 font-mono text-xs ${
                  activeIndex === i ? "text-indigo-500" : "text-slate-400 dark:text-slate-500"
                }`}
              >
                {formatTime(seg.start)}
              </span>
              {seg.speaker && (
                <span
                  className={`shrink-0 self-start rounded-full px-1.5 py-0.5 text-[10px] font-medium ${speakerColor(
                    seg.speaker
                  )}`}
                >
                  {seg.speaker.replace("SPEAKER_", "講者")}
                </span>
              )}
              <span className="text-sm leading-relaxed">{highlightMatch(seg.text, searchQuery)}</span>
            </button>
          ))}
        </div>
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 rounded-lg px-4 py-2 text-sm font-medium text-white shadow-lg transition-opacity ${
            toast.type === "success" ? "bg-slate-900 dark:bg-slate-100 dark:text-slate-900" : "bg-red-600"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}