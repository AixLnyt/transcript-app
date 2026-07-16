"use client";

import { useEffect, useRef, useState } from "react";
import TranscriptPlayer from "./TranscriptPlayer";
import { TranscribeResponse, HistoryItem, IncompleteItem } from "@/app/types/transcript";

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
  const [status, setStatus] = useState<"idle" | "processing" | "paused" | "done" | "failed">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [result, setResult] = useState<TranscribeResponse | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [incompleteList, setIncompleteList] = useState<IncompleteItem[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelSize, setModelSize] = useState<string>("medium");
  const [isDark, setIsDark] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logText, setLogText] = useState("");
  const [uploadMode, setUploadMode] = useState<"file" | "url">("file");
  const [urlInput, setUrlInput] = useState("");
  const logBoxRef = useRef<HTMLPreElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // 頁面載入時向後端取得可選模型清單與預設值，
  // 若使用者之前選過模型（存在 localStorage），優先套用上次的選擇。
  useEffect(() => {
    fetch(`${API_BASE}/api/transcribe/models`)
      .then((res) => res.json())
      .then((data) => {
        setAvailableModels(data.models ?? []);
        const savedModel = localStorage.getItem("preferredModelSize");
        const models: string[] = data.models ?? [];
        setModelSize(savedModel && models.includes(savedModel) ? savedModel : data.default ?? "medium");
      })
      .catch(() => {
        // 取不到清單就用前端寫死的預設選項，不影響基本操作
        setAvailableModels(["tiny", "base", "small", "medium", "large-v3"]);
      });
  }, []);

  const handleModelChange = (size: string) => {
    setModelSize(size);
    localStorage.setItem("preferredModelSize", size);
  };

  const fetchHistory = () => {
    fetch(`${API_BASE}/api/transcribe/history`)
      .then((res) => res.json())
      .then((data) => setHistory(data.history ?? []))
      .catch(() => {
        // 取不到歷史紀錄不影響主要上傳功能，靜默失敗即可
      });
  };

  // 頁面載入時取得歷史紀錄清單
  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchIncomplete = () => {
    fetch(`${API_BASE}/api/transcribe/incomplete`)
      .then((res) => res.json())
      .then((data) => setIncompleteList(data.incomplete ?? []))
      .catch(() => {
        // 取不到清單不影響主要功能
      });
  };

  // 頁面載入時檢查有沒有之前暫停/意外中斷、尚未完成的轉錄任務
  useEffect(() => {
    fetchIncomplete();
  }, []);

  // 請求瀏覽器通知權限，讓轉錄在背景完成時即使視窗沒有聚焦也能提醒使用者
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  const notify = (title: string, body: string) => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  };

  const handlePause = async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${API_BASE}/api/transcribe/pause/${sessionId}`, { method: "POST" });
      if (!res.ok) throw new Error("暫停失敗");
      setStatusMessage("正在暫停，將於目前區塊處理完後停止...");
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "暫停失敗，請稍後再試");
    }
  };

  const resumeBySessionId = async (id: string) => {
    setUploadError(null);
    try {
      const res = await fetch(`${API_BASE}/api/transcribe/resume/${id}`, { method: "POST" });
      if (!res.ok) throw new Error("繼續轉錄失敗");
      setSessionId(id);
      setStatus("processing");
      setResult(null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "繼續轉錄失敗，請稍後再試");
    }
  };

  const handleResumeIncomplete = (item: IncompleteItem) => resumeBySessionId(item.session_id);

  const formatEta = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)} 秒`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分鐘`;
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return `${hours} 小時 ${remainMinutes} 分鐘`;
  };

  const loadHistoryItem = async (item: HistoryItem) => {
    setHistoryLoading(item.session_id);
    setUploadError(null);
    try {
      const res = await fetch(`${API_BASE}/api/transcribe/result/${item.session_id}`);
      if (!res.ok) throw new Error("讀取歷史紀錄失敗");
      const data = await res.json();
      setResult(data);
      setStatus("done");
      setShowHistoryPanel(false);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "讀取歷史紀錄失敗，請稍後再試");
    } finally {
      setHistoryLoading(null);
    }
  };

  const handleDeleteHistory = async (sessionId: string) => {
    if (!confirm("確定要刪除這筆歷史紀錄嗎？此動作無法復原。")) return;
    try {
      const res = await fetch(`${API_BASE}/api/transcribe/history/${sessionId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("刪除失敗");
      setHistory((prev) => prev.filter((h) => h.session_id !== sessionId));
    } catch (e) {
      alert(e instanceof Error ? e.message : "刪除失敗，請稍後再試");
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      setFile(dropped);
      setUploadError(null);
    }
  };

  // 展開日誌面板且正在處理時，定期輪詢後端日誌，讓長時間處理的檔案
  // 也能看到目前實際在做什麼，不會只看到卡在原地的百分比。
  useEffect(() => {
    if (!showLogs || status !== "processing") return;

    const fetchLogs = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/logs?lines=300`);
        if (!res.ok) return;
        const data = await res.json();
        setLogText(data.log ?? "");
      } catch {
        // 輪詢失敗不影響主要流程
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [showLogs, status]);

  // 日誌內容更新時自動捲到最底部，跟著最新輸出走
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logText]);

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

  const extractUrl = (text: string): string => {
    const match = text.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : text.trim();
  };

  const handleUploadFromUrl = async () => {
    if (!urlInput.trim()) return;
    setStatus("processing");
    setResult(null);
    setUploadError(null);
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append("url", extractUrl(urlInput));
      formData.append("model_size", modelSize);

      const res = await fetch(`${API_BASE}/api/transcribe/from_url`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(`提交失敗（狀態碼 ${res.status}）`);

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
        setEtaSeconds(typeof data.eta_seconds === "number" ? data.eta_seconds : null);

        if (data.status === "done") {
          clearInterval(interval);
          try {
            const resultRes = await fetch(`${API_BASE}/api/transcribe/result/${sessionId}`);
            if (!resultRes.ok) throw new Error(`讀取結果失敗（狀態碼 ${resultRes.status}）`);
            setResult(await resultRes.json());
            setStatus("done");
            fetchHistory(); // 這次轉錄完成了，重新整理歷史紀錄清單讓新項目出現
            notify("轉錄完成", "逐字稿已經產生完成，回來看看結果吧");
          } catch (e) {
            // 這裡是關鍵修正：之前若這一步出錯，會被最外層的 catch 靜默吞掉，
            // 但 clearInterval 已經執行過，畫面就會永遠卡在「處理中」不會再更新。
            // 現在改成明確顯示錯誤，不會再無聲卡住。
            setStatus("failed");
            setUploadError(e instanceof Error ? e.message : "讀取轉錄結果失敗，請重新整理頁面再試");
          }
        } else if (data.status === "paused") {
          clearInterval(interval);
          setStatus("paused");
          fetchIncomplete(); // 暫停後這筆會出現在「未完成的轉錄」清單裡
        } else if (data.status === "failed") {
          clearInterval(interval);
          setStatus("failed");
          notify("轉錄失敗", data.progress_message ?? "請查看詳細紀錄了解原因");
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
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => {
              setShowHistoryPanel(true);
              fetchHistory(); // 每次打開都重新抓一次，避免依賴頁面剛載入時
                              // 後端可能還沒完全就緒導致的那一次性失敗
            }}
            className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 3v5h5M12 7v5l4 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            歷史紀錄{history.length > 0 ? ` (${history.length})` : ""}
          </button>
          <button
            onClick={toggleTheme}
            aria-label="切換深色模式"
            className="rounded-full border border-slate-200 bg-white p-2 text-slate-600 shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
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
        </div>
      </header>

      {/* 上傳模式切換：檔案上傳 / 貼上網址 */}
      <div className="mb-3 flex gap-1">
        <button
          onClick={() => setUploadMode("file")}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            uploadMode === "file"
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
              : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          }`}
        >
          上傳檔案
        </button>
        <button
          onClick={() => setUploadMode("url")}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            uploadMode === "url"
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
              : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          }`}
        >
          貼上網址（YouTube／B站）
        </button>
      </div>

      {uploadMode === "file" ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`mb-8 flex flex-col gap-3 rounded-2xl border border-dashed p-5 transition-colors sm:flex-row sm:items-center sm:justify-between ${
            isDragging
              ? "border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-500/10"
              : "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50"
          }`}
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-100 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
            >
              選擇檔案
            </button>
            <span className="truncate text-sm text-slate-600 dark:text-slate-300">
              {file ? file.name : "未選擇任何檔案"}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setUploadError(null);
              }}
              className="hidden"
            />
          </div>
          <div className="flex items-center gap-3">
            <select
              value={modelSize}
              onChange={(e) => handleModelChange(e.target.value)}
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
      ) : (
        <div className="mb-8 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-800/50 sm:flex-row sm:items-center sm:justify-between">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="貼上 YouTube 或 B站影片網址..."
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          />
          <div className="flex items-center gap-3">
            <select
              value={modelSize}
              onChange={(e) => handleModelChange(e.target.value)}
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
              onClick={handleUploadFromUrl}
              disabled={!urlInput.trim() || status === "processing"}
              className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:bg-slate-300 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300 dark:disabled:bg-slate-700 dark:disabled:text-slate-500"
            >
              {status === "processing" ? "分析中…" : "下載並轉錄"}
            </button>
          </div>
        </div>
      )}

      {status === "idle" && incompleteList.length > 0 && (
        <div className="mb-6 space-y-2">
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400">未完成的轉錄</h2>
          {incompleteList.map((item) => (
            <div
              key={item.session_id}
              className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm dark:border-amber-900 dark:bg-amber-950/30"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-amber-800 dark:text-amber-300">{item.original_name}</p>
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  已完成 {Math.round((item.completed_seconds / Math.max(item.total_seconds, 1)) * 100)}%
                </p>
              </div>
              <button
                onClick={() => handleResumeIncomplete(item)}
                className="shrink-0 rounded-md bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-300 dark:hover:bg-amber-800"
              >
                繼續轉錄
              </button>
            </div>
          ))}
        </div>
      )}

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
            <div className="flex items-center gap-2">
              {etaSeconds !== null && (
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  預計剩餘 {formatEta(etaSeconds)}
                </span>
              )}
              {progress !== null && <span className="font-mono text-xs">{Math.round(progress)}%</span>}
              <button
                onClick={handlePause}
                className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                暫停
              </button>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-300 ease-out"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
          <button
            onClick={() => setShowLogs((v) => !v)}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
          >
            <span className={`inline-block transition-transform ${showLogs ? "rotate-90" : ""}`}>▶</span>
            {showLogs ? "隱藏詳細紀錄" : "展開詳細紀錄（處理中卡住時可查看目前實際狀況）"}
          </button>
          {showLogs && (
            <pre
              ref={logBoxRef}
              className="max-h-64 overflow-y-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300"
            >
              {logText || "尚無日誌內容..."}
            </pre>
          )}
        </div>
      )}
      {status === "paused" && (
        <div className="mb-6 flex items-center justify-between rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
          <span>已暫停，進度已保存，可以隨時繼續</span>
          <button
            onClick={() => sessionId && resumeBySessionId(sessionId)}
            className="rounded-md bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-300 dark:hover:bg-amber-800"
          >
            繼續轉錄
          </button>
        </div>
      )}
      {status === "failed" && (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400">
          轉錄失敗，請重新上傳再試一次
        </div>
      )}

      {result && (
        <button
          onClick={() => {
            setResult(null);
            setStatus("idle");
            setFile(null);
            setSessionId(null);
          }}
          className="mb-4 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          ← 回到上傳
        </button>
      )}
      {result && <TranscriptPlayer result={result} />}

      {/* 歷史紀錄側邊抽屜：不管目前是不是正在看某份逐字稿，
          都能從 header 的按鈕隨時打開，不用先按「回到上傳」才看得到。 */}
      {showHistoryPanel && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          onClick={() => setShowHistoryPanel(false)}
        >
          <div
            className="flex h-full w-full max-w-sm flex-col bg-white shadow-xl dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 p-5 dark:border-slate-800">
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                歷史紀錄
              </h2>
              <button
                onClick={() => setShowHistoryPanel(false)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {history.length === 0 && (
                <p className="p-4 text-center text-sm text-slate-400 dark:text-slate-500">
                  還沒有轉錄紀錄
                </p>
              )}
              {history.map((item) => (
                <div
                  key={item.session_id}
                  className="group relative flex items-center gap-3 rounded-xl border border-slate-200 p-2 transition-colors hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-slate-700 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/10"
                >
                  <button
                    onClick={() => loadHistoryItem(item)}
                    disabled={historyLoading !== null}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-60"
                  >
                    {item.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${API_BASE}${item.thumbnail_url}`}
                        alt=""
                        className="h-12 w-20 shrink-0 rounded-lg bg-slate-100 object-cover dark:bg-slate-800"
                      />
                    ) : (
                      <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xl dark:bg-slate-800">
                        {item.media_type === "video" ? "🎬" : "🎵"}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                        {item.original_name}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                        {new Date(item.created_at).toLocaleString()}
                      </p>
                      <p className="text-xs text-slate-400 dark:text-slate-500">
                        {item.segment_count} 段
                      </p>
                    </div>
                    {historyLoading === item.session_id && (
                      <span className="shrink-0 text-xs text-indigo-500">載入中…</span>
                    )}
                  </button>
                  <button
                    onClick={() => handleDeleteHistory(item.session_id)}
                    title="刪除這筆紀錄"
                    className="shrink-0 rounded-md p-1.5 text-slate-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}