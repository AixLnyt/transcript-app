"use client";

import { useEffect, useState } from "react";
import TranscriptPlayer from "./TranscriptPlayer";
import { TranscribeResponse } from "@/app/types/transcript";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

const MODEL_LABELS: Record<string, string> = {
  tiny: "tiny・最快，準確度較低",
  base: "base・快，準確度普通",
  small: "small・速度與準確度均衡",
  medium: "medium・預設，準確度較佳",
  "large-v3": "large-v3・最準確，速度較慢",
};

export default function UploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "processing" | "done" | "failed">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [result, setResult] = useState<TranscribeResponse | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelSize, setModelSize] = useState<string>("medium");
  const [isDark, setIsDark] = useState(false);

  // 初始化深色模式：優先讀取使用者之前的選擇（localStorage），
  // 若沒有存過偏好，預設就是深色模式（不跟隨系統設定）。
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const shouldBeDark = saved ? saved === "dark" : true;
    setIsDark(shouldBeDark);
    document.documentElement.classList.toggle("dark", shouldBeDark);
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  // 修復瀏覽器 bfcache：按返回鍵還原凍結頁面時重置狀態，避免按鈕卡住
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setStatus("idle");
        setUploadError(null);
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // 頁面載入時向後端取得可選模型清單與預設值
  useEffect(() => {
    fetch(`${API_BASE}/api/transcribe/models`)
      .then((res) => res.json())
      .then((data) => {
        setAvailableModels(data.models ?? []);
        setModelSize(data.default ?? "medium");
      })
      .catch(() => {
        // 取不到清單就用前端寫死的預設選項，不影響基本操作
        setAvailableModels(["tiny", "base", "small", "medium", "large-v3"]);
      });
  }, []);

  const handleUpload = async () => {
    if (!file) return;
    setStatus("processing");
    setResult(null);
    setUploadError(null);
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("model_size", modelSize);

      const res = await fetch(`${API_BASE}/api/transcribe/upload`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(`上傳失敗（狀態碼 ${res.status}）`);

      const data = await res.json();
      setSessionId(data.session_id);
    } catch (e) {
      setStatus("idle");
      setUploadError(e instanceof Error ? e.message : "連線失敗，請稍後再試一次");
    }
  };

  useEffect(() => {
    if (!sessionId || status !== "processing") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/transcribe/status/${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        setStatusMessage(data.progress_message ?? "");
        if (typeof data.progress === "number") {
          setProgress(data.progress);
        }

        if (data.status === "done") {
          clearInterval(interval);
          const resultRes = await fetch(`${API_BASE}/api/transcribe/result/${sessionId}`);
          if (!resultRes.ok) {
            setStatus("failed");
            return;
          }
          setResult(await resultRes.json());
          setStatus("done");
        } else if (data.status === "failed") {
          clearInterval(interval);
          setStatus("failed");
        }
      } catch {
        // 輪詢期間偶發網路失敗不中斷流程，下一輪再試
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [sessionId, status]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            語音轉逐字稿
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            上傳音檔或影片，自動產生帶時間戳記的逐字稿，點擊任一句就能跳到那個時間點播放。
          </p>
        </div>
        <button
          onClick={toggleTheme}
          aria-label="切換深色模式"
          className="shrink-0 rounded-full border border-slate-200 bg-white p-2 text-slate-600 shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
        >
          {isDark ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      </header>

      <div className="mb-8 flex flex-col gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-800/50 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setUploadError(null);
          }}
          className="text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 file:shadow-sm hover:file:bg-slate-100 dark:text-slate-300 dark:file:bg-slate-700 dark:file:text-slate-200 dark:hover:file:bg-slate-600"
        />
        <div className="flex items-center gap-3">
          <select
            value={modelSize}
            onChange={(e) => setModelSize(e.target.value)}
            disabled={status === "processing"}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:disabled:bg-slate-700"
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m] ?? m}
              </option>
            ))}
          </select>
          <button
            onClick={handleUpload}
            disabled={!file || status === "processing"}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:bg-slate-300 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300 dark:disabled:bg-slate-700 dark:disabled:text-slate-500"
          >
            {status === "processing" ? "分析中…" : "上傳並轉錄"}
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="mb-6 flex items-center justify-between rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400">
          <span>{uploadError}</span>
          <button
            onClick={handleUpload}
            className="ml-3 shrink-0 rounded-md bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-800"
          >
            重試
          </button>
        </div>
      )}

      {status === "processing" && (
        <div className="mb-6 space-y-2">
          <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
            <span>處理中… {statusMessage}</span>
            {progress !== null && <span className="font-mono text-xs">{Math.round(progress)}%</span>}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-300 ease-out"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
        </div>
      )}
      {status === "failed" && (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400">
          轉錄失敗，請重新上傳再試一次
        </div>
      )}

      {result && <TranscriptPlayer result={result} />}
    </div>
  );
}