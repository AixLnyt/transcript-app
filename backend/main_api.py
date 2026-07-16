"""
main_api.py
上傳音檔/影片 -> faster-whisper 轉錄 -> 回傳帶時間戳記的逐字稿

啟動方式:
    uvicorn main_api:app --reload --host 0.0.0.0 --port 8000
"""

import uuid
import shutil
import json
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from transcribe import (
    transcribe_file,
    get_model,
    get_media_duration,
    extract_audio_chunk,
    transcribe_chunk_file,
    AVAILABLE_MODELS,
    DEFAULT_MODEL_SIZE,
)
from diarize import diarize_full_file, assign_speakers_to_segments

# ---------- 把所有輸出同時寫進日誌檔案 ----------
# 不管是直接用終端機跑 uvicorn，還是透過 Electron 啟動器（會隱藏視窗）啟動，
# 都能事後（或即時）從 /api/logs 這個端點查看目前實際在做什麼，
# 不會再遇到「畫面卡在 0% 完全不知道是在跑還是死掉了」的狀況。
LOG_DIR = Path("logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE_PATH = LOG_DIR / "backend.log"


class _TeeStream:
    """同時寫進原本的 stdout/stderr 與檔案，兩邊都看得到輸出"""

    def __init__(self, original_stream, log_file):
        self.original_stream = original_stream
        self.log_file = log_file

    def write(self, data):
        try:
            self.original_stream.write(data)
        except UnicodeEncodeError:
            # Windows 主控台編碼（例如繁體中文環境的 cp950）無法顯示某些特殊
            # Unicode 字元（例如某些影片標題裡的特殊符號）。這裡改用安全替換
            # 的方式寫入主控台，避免因為顯示問題讓整個背景任務崩潰；
            # 完整原始內容仍會正確寫進日誌檔案（UTF-8 編碼，不受此限制）。
            encoding = getattr(self.original_stream, "encoding", None) or "utf-8"
            safe_data = data.encode(encoding, errors="replace").decode(encoding, errors="replace")
            self.original_stream.write(safe_data)
        self.log_file.write(data)
        self.log_file.flush()

    def flush(self):
        self.original_stream.flush()
        self.log_file.flush()


_log_file_handle = open(LOG_FILE_PATH, "a", encoding="utf-8", errors="replace")
sys.stdout = _TeeStream(sys.stdout, _log_file_handle)
sys.stderr = _TeeStream(sys.stderr, _log_file_handle)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 存放每次轉錄完成後的結果（JSON 檔），讓後端重啟後仍能回頭查看過去的逐字稿。
# JOB_STATUS 只存在記憶體裡，重啟就會消失，這裡另外落地存一份到硬碟。
HISTORY_DIR = Path("history")
HISTORY_DIR.mkdir(parents=True, exist_ok=True)

# 存放影片縮圖，讓歷史紀錄列表可以顯示預覽圖，不是只有純文字
THUMBNAIL_DIR = Path("thumbnails")
THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)

# 存放尚未完成的轉錄進度（分段處理的檢查點），支援暫停/續傳，
# 以及應用程式意外關閉後重新開啟仍能接續之前的進度，不用整份重來。
CHECKPOINT_DIR = Path("checkpoints")
CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

# 每個 session_id 對應到「是否被要求暫停」，只存在記憶體，
# 由 /api/transcribe/pause 端點設定，chunked_transcribe 迴圈會定期檢查這個旗標。
PAUSE_FLAGS: dict = {}

# 每個檔案切成多少秒一段來處理。切得越細，暫停/續傳的顆粒度越好，
# 但每段都有一次模型呼叫的固定開銷；5 分鐘是一個合理的折衷值。
CHUNK_SECONDS = 300

# 讓前端可以直接用 URL 播放使用者上傳的原始檔案（影片/音訊）
app.mount("/static/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/static/thumbnails", StaticFiles(directory=str(THUMBNAIL_DIR)), name="thumbnails")

JOB_STATUS = {}

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}


def generate_thumbnail(video_path: Path, output_path: Path) -> bool:
    """
    用 PyAV（faster-whisper 本來就依賴的 av 套件）擷取影片的第一個畫面當縮圖，
    不需要額外安裝或呼叫系統的 ffmpeg CLI。
    縮圖產生失敗（例如檔案損壞）不應該讓整個轉錄流程失敗，這裡吞掉錯誤只印警告。
    """
    try:
        import av

        container = av.open(str(video_path))
        stream = container.streams.video[0]
        for frame in container.decode(stream):
            img = frame.to_image()
            img.thumbnail((320, 180))
            img.save(str(output_path), quality=70)
            container.close()
            return True
        container.close()
        return False
    except Exception as e:
        print(f"[thumbnail] 縮圖產生失敗（不影響轉錄結果）: {e}")
        return False


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str
    speaker: Optional[str] = None


class TranscribeResponse(BaseModel):
    session_id: str
    status: str
    media_type: str  # "video" | "audio"
    media_url: str
    segments: List[TranscriptSegment]


class JobStatusResponse(BaseModel):
    session_id: str
    status: str
    progress_message: Optional[str] = None
    progress: Optional[float] = None
    eta_seconds: Optional[float] = None


class IncompleteItem(BaseModel):
    session_id: str
    original_name: str
    completed_seconds: float
    total_seconds: float


class HistoryItem(BaseModel):
    session_id: str
    original_name: str
    media_type: str
    created_at: str
    segment_count: int
    thumbnail_url: Optional[str] = None


def download_media_from_url(url: str, session_id: str) -> tuple[Path, str]:
    """
    用 yt-dlp 下載 YouTube/B站等網址的影片，回傳下載後的檔案路徑與原始標題。

    優先嘗試 bestvideo+bestaudio 合併（需要系統裝有 ffmpeg，此環境已確認裝好），
    取得含畫面的完整版本；如果來源沒有提供可用的視訊軌（少數純音訊來源），
    才依序退回 best（單一已合併格式）、bestaudio（純音訊）。
    """
    import yt_dlp

    outtmpl = str(UPLOAD_DIR / f"{session_id}_%(title).100s.%(ext)s")

    # 這台機器已確認裝有 ffmpeg（full-shared 版本），可以讓 yt-dlp
    # 合併分離的音視訊軌，優先取得含畫面的版本；
    # 如果來源真的沒有提供可用的視訊軌，才退回純音訊。
    format_fallbacks = ["bestvideo+bestaudio/best", "best", "bestaudio/best"]

    last_error = None
    for fmt in format_fallbacks:
        ydl_opts = {
            "format": fmt,
            "outtmpl": outtmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            # 影片標題常含 Windows 不允許的字元（: * ? " < > | 等），
            # 明確要求用 Windows 安全的檔名規則清理，避免存檔時
            # 發生 [Errno 22] Invalid argument 這類錯誤。
            "windowsfilenames": True,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                filepath = Path(ydl.prepare_filename(info))
                title = info.get("title", "downloaded_video")
            return filepath, title
        except Exception as e:
            last_error = e
            print(f"[{session_id}] 格式 '{fmt}' 下載失敗，嘗試下一個備援格式: {e}")

    raise last_error


def run_download_and_transcribe(session_id: str, url: str, model_size: str):
    try:
        JOB_STATUS[session_id] = {"status": "processing", "message": "正在下載影片...", "progress": 0.0}
        input_path, title = download_media_from_url(url, session_id)
        print(f"[{session_id}] 下載完成: {title} -> {input_path}")
        chunked_transcribe(session_id, input_path, model_size, title)
    except Exception as e:
        JOB_STATUS[session_id] = {"status": "failed", "message": f"下載失敗: {e}", "progress": None}
        print(f"[{session_id}] 下載失敗，完整錯誤如下：")
        traceback.print_exc()


def _finalize_transcription(session_id: str, input_path: Path, original_name: str, segments: list):
    """轉錄全部完成後的收尾工作：講者分離、產生縮圖、寫入歷史紀錄、更新 JOB_STATUS、清掉檢查點檔案"""

    # 講者分離對整份檔案做一次（不分段），這樣同一個人的標籤在全程都會一致。
    # 這個步驟沒辦法暫停/續傳，也可能因為缺少 HF_TOKEN 或授權而失敗，
    # 失敗時優雅降級成純文字逐字稿（不標講者），不讓整個轉錄流程失敗。
    JOB_STATUS[session_id] = {"status": "processing", "message": "正在辨識講者...", "progress": 99.0}
    print(f"[{session_id}] 開始講者分離（對整份檔案，這步無法中途暫停）...")
    try:
        diarize_started = time.time()
        speaker_turns = diarize_full_file(str(input_path))
        segments = assign_speakers_to_segments(segments, speaker_turns)
        print(f"[{session_id}] 講者分離完成，共偵測到 "
              f"{len(set(t['speaker'] for t in speaker_turns))} 位講者"
              f"（花費 {time.time() - diarize_started:.1f} 秒）")
    except Exception as e:
        print(f"[{session_id}] 講者分離失敗，改用純文字逐字稿（不影響其他功能）: {e}")
        for seg in segments:
            seg["speaker"] = None

    media_type = "video" if input_path.suffix.lower() in VIDEO_EXTENSIONS else "audio"
    # 檔名可能含中文字、空格等特殊字元，直接塞進網址字串會讓瀏覽器
    # 的 <video>/<audio> 標籤載入失敗（"no supported sources" 錯誤）。
    media_url = f"/static/uploads/{quote(input_path.name)}"

    thumbnail_url = None
    if media_type == "video":
        thumb_path = THUMBNAIL_DIR / f"{session_id}.jpg"
        if generate_thumbnail(input_path, thumb_path):
            thumbnail_url = f"/static/thumbnails/{thumb_path.name}"

    JOB_STATUS[session_id] = {
        "status": "done",
        "message": "完成",
        "progress": 100.0,
        "segments": segments,
        "input_path": input_path,
        "media_type": media_type,
        "media_url": media_url,
    }

    history_record = {
        "session_id": session_id,
        "original_name": original_name,
        "stored_filename": input_path.name,
        "media_type": media_type,
        "media_url": media_url,
        "thumbnail_url": thumbnail_url,
        "segments": segments,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(HISTORY_DIR / f"{session_id}.json", "w", encoding="utf-8") as f:
        json.dump(history_record, f, ensure_ascii=False)

    checkpoint_path = CHECKPOINT_DIR / f"{session_id}.json"
    if checkpoint_path.exists():
        checkpoint_path.unlink()

    print(f"[{session_id}] 轉錄完成，共 {len(segments)} 個片段")


def chunked_transcribe(
    session_id: str,
    input_path: Path,
    model_size: str,
    original_name: str,
    resume: bool = False,
):
    """
    把音檔/影片切成固定時長的區塊逐段轉錄，而不是一次呼叫整份檔案。

    這樣設計的原因：
    - 支援暫停：迴圈每處理完一個區塊就檢查一次 PAUSE_FLAGS，
      可以在合理的時間內（最多一個區塊的處理時間）真正停下來，
      不是理論上的暫停按鈕。
    - 支援續傳：每個區塊處理完就立刻把目前進度（已完成到第幾秒、
      累積的逐字稿片段）寫進檢查點檔案。不管是手動暫停、
      還是整個程式意外關閉，下次都能從檢查點接續，不用整份重來。
    - 對超大檔案（例如數十 GB 的長影片）更友善：每次只解碼一小段
      音訊到暫存檔，不會一次把整份檔案載入記憶體或一次卡住無法回報進度。
    """
    checkpoint_path = CHECKPOINT_DIR / f"{session_id}.json"
    print(f"[{session_id}] chunked_transcribe 開始（resume={resume}, input={input_path}）")

    if resume and checkpoint_path.exists():
        with open(checkpoint_path, "r", encoding="utf-8") as f:
            state = json.load(f)
        print(f"[{session_id}] 從檢查點續傳，已完成到 {state['completed_seconds']:.1f} 秒")
    else:
        print(f"[{session_id}] 正在讀取媒體資訊（大型檔案可能需要一段時間，"
              f"若中繼資料存在檔案尾端，這一步會需要掃過整個檔案）...")
        JOB_STATUS[session_id] = {
            "status": "processing",
            "message": "正在讀取媒體資訊...",
            "progress": 0.0,
        }
        probe_started = time.time()
        try:
            total_duration = get_media_duration(input_path)
        except Exception as e:
            JOB_STATUS[session_id] = {"status": "failed", "message": f"無法讀取媒體長度: {e}", "progress": None}
            print(f"[{session_id}] 讀取媒體長度失敗，完整錯誤如下：")
            traceback.print_exc()
            return
        print(f"[{session_id}] 媒體長度讀取完成: {total_duration:.1f} 秒"
              f"（花費 {time.time() - probe_started:.1f} 秒）")
        state = {
            "session_id": session_id,
            "input_path": str(input_path),
            "original_name": original_name,
            "model_size": model_size,
            "chunk_seconds": CHUNK_SECONDS,
            "total_seconds": total_duration,
            "completed_seconds": 0.0,
            "segments": [],
        }

    started_at = time.time()
    # 續傳時，之前已完成的秒數對應的處理時間不算進這次的速率估算，
    # 避免 ETA 被「之前暫停的那段時間」拉低估算準確度。
    baseline_completed = state["completed_seconds"]

    JOB_STATUS[session_id] = {
        "status": "processing",
        "message": "轉錄中...",
        "progress": round(min(99.0, state["completed_seconds"] / max(state["total_seconds"], 0.01) * 100), 1),
        "started_at": started_at,
    }

    total = state["total_seconds"]
    chunk_seconds = state["chunk_seconds"]

    print(f"[{session_id}] 載入模型 ({state['model_size']})...")
    model = get_model(state["model_size"])
    print(f"[{session_id}] 模型載入完成，開始分段處理，共約 {total:.1f} 秒，每段 {chunk_seconds} 秒")

    with tempfile.TemporaryDirectory() as tmp_dir:
        while state["completed_seconds"] < total:
            if PAUSE_FLAGS.pop(session_id, None):
                with open(checkpoint_path, "w", encoding="utf-8") as f:
                    json.dump(state, f, ensure_ascii=False)
                JOB_STATUS[session_id] = {
                    "status": "paused",
                    "message": "已暫停",
                    "progress": round(min(99.0, state["completed_seconds"] / max(total, 0.01) * 100), 1),
                }
                print(f"[{session_id}] 已暫停，進度存於 {checkpoint_path}")
                return

            chunk_start = state["completed_seconds"]
            chunk_end = min(chunk_start + chunk_seconds, total)
            chunk_path = Path(tmp_dir) / f"chunk_{int(chunk_start)}.wav"

            print(f"[{session_id}] 處理區塊 {chunk_start:.1f}s ~ {chunk_end:.1f}s（切出暫存音訊中...）")

            try:
                extract_audio_chunk(input_path, chunk_start, chunk_end, chunk_path)
                print(f"[{session_id}] 暫存音訊切出完成，開始轉錄這段...")
                def _log_segment(seg, _session_id=session_id, _chunk_start=chunk_start):
                    abs_start = seg["start"] + _chunk_start
                    preview = seg["text"][:40]
                    print(f"[{_session_id}]   [{abs_start:.1f}s] {preview}")

                chunk_segments = transcribe_chunk_file(model, chunk_path, on_segment=_log_segment)
            except Exception as e:
                JOB_STATUS[session_id] = {"status": "failed", "message": str(e), "progress": None}
                print(f"[{session_id}] 轉錄失敗，完整錯誤如下：")
                traceback.print_exc()
                return
            finally:
                if chunk_path.exists():
                    chunk_path.unlink()

            print(f"[{session_id}] 這段完成，取得 {len(chunk_segments)} 個逐字稿片段")

            # 區塊內的時間戳記是相對於區塊本身，這裡加回 chunk_start 換算成絕對時間
            for seg in chunk_segments:
                state["segments"].append(
                    {"start": round(seg["start"] + chunk_start, 2), "end": round(seg["end"] + chunk_start, 2), "text": seg["text"]}
                )

            state["completed_seconds"] = chunk_end
            with open(checkpoint_path, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False)

            percent = min(99.0, state["completed_seconds"] / total * 100) if total > 0 else 0.0
            elapsed = time.time() - started_at
            processed_this_run = state["completed_seconds"] - baseline_completed
            eta_seconds = None
            if processed_this_run > 0:
                rate = elapsed / processed_this_run  # 每處理 1 秒音訊實際花費的秒數
                remaining = total - state["completed_seconds"]
                eta_seconds = round(rate * remaining, 1)

            JOB_STATUS[session_id] = {
                "status": "processing",
                "message": f"轉錄中... {round(percent)}%",
                "progress": round(percent, 1),
                "eta_seconds": eta_seconds,
                "started_at": started_at,
            }

    _finalize_transcription(session_id, input_path, state["original_name"], state["segments"])


@app.get("/api/logs")
async def get_logs(lines: int = 300):
    """回傳後端日誌檔案的最後 N 行，供前端顯示即時處理狀態，方便排查長時間卡住的狀況"""
    if not LOG_FILE_PATH.exists():
        return {"log": ""}
    with open(LOG_FILE_PATH, "r", encoding="utf-8", errors="replace") as f:
        content = f.readlines()
    return {"log": "".join(content[-lines:])}


@app.get("/api/transcribe/models")
async def list_models():
    """回傳可選模型清單，供前端渲染下拉選單"""
    return {"models": AVAILABLE_MODELS, "default": DEFAULT_MODEL_SIZE}


@app.post("/api/transcribe/upload", response_model=JobStatusResponse)
async def upload_media(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    model_size: str = Form(DEFAULT_MODEL_SIZE),
):
    session_id = uuid.uuid4().hex[:8]
    original_name = file.filename or "upload"
    input_path = UPLOAD_DIR / f"{session_id}_{original_name}"

    with open(input_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    JOB_STATUS[session_id] = {"status": "processing", "message": "已加入佇列"}
    background_tasks.add_task(chunked_transcribe, session_id, input_path, model_size, original_name)

    return JobStatusResponse(session_id=session_id, status="processing", progress_message="已加入佇列")


@app.post("/api/transcribe/from_url", response_model=JobStatusResponse)
async def upload_from_url(
    background_tasks: BackgroundTasks,
    url: str = Form(...),
    model_size: str = Form(DEFAULT_MODEL_SIZE),
):
    """接收 YouTube/B站等網址，背景下載後接續原本的轉錄流程"""
    session_id = uuid.uuid4().hex[:8]
    JOB_STATUS[session_id] = {"status": "processing", "message": "已加入佇列，準備下載...", "progress": 0.0}
    background_tasks.add_task(run_download_and_transcribe, session_id, url, model_size)
    return JobStatusResponse(session_id=session_id, status="processing", progress_message="已加入佇列，準備下載...")


@app.get("/api/transcribe/status/{session_id}", response_model=JobStatusResponse)
async def get_status(session_id: str):
    job = JOB_STATUS.get(session_id)
    if not job:
        raise HTTPException(status_code=404, detail="session_id 不存在")
    return JobStatusResponse(
        session_id=session_id,
        status=job["status"],
        progress_message=job.get("message"),
        progress=job.get("progress"),
        eta_seconds=job.get("eta_seconds"),
    )


@app.post("/api/transcribe/pause/{session_id}")
async def pause_transcription(session_id: str):
    """
    要求暫停一個正在處理中的轉錄任務。
    暫停不是立即生效——會在目前這個區塊（預設 5 分鐘音訊）處理完之後才真正停下來，
    並把進度存進檢查點檔案，之後可以用 /resume 接續。
    """
    job = JOB_STATUS.get(session_id)
    if not job or job.get("status") != "processing":
        raise HTTPException(status_code=409, detail="目前沒有可暫停的轉錄任務")
    PAUSE_FLAGS[session_id] = True
    return {"status": "pausing"}


@app.post("/api/transcribe/resume/{session_id}", response_model=JobStatusResponse)
async def resume_transcription(background_tasks: BackgroundTasks, session_id: str):
    """
    從檢查點接續一個暫停中／應用程式意外關閉而中斷的轉錄任務。
    即使後端整個重啟過（記憶體裡的 JOB_STATUS 消失了），
    只要檢查點檔案還在，一樣可以呼叫這個端點繼續。
    """
    checkpoint_path = CHECKPOINT_DIR / f"{session_id}.json"
    if not checkpoint_path.exists():
        raise HTTPException(status_code=404, detail="找不到可繼續的轉錄任務")

    with open(checkpoint_path, "r", encoding="utf-8") as f:
        state = json.load(f)

    JOB_STATUS[session_id] = {"status": "processing", "message": "準備繼續轉錄...", "progress": None}
    background_tasks.add_task(
        chunked_transcribe,
        session_id,
        Path(state["input_path"]),
        state["model_size"],
        state["original_name"],
        True,
    )
    return JobStatusResponse(session_id=session_id, status="processing", progress_message="準備繼續轉錄...")


@app.get("/api/transcribe/incomplete")
async def list_incomplete():
    """
    列出所有尚未完成的轉錄檢查點（暫停中，或應用程式意外關閉而中斷的），
    供前端在畫面上提示使用者「有未完成的轉錄，要不要繼續？」。
    """
    records = []
    for file in CHECKPOINT_DIR.glob("*.json"):
        try:
            with open(file, "r", encoding="utf-8") as f:
                state = json.load(f)
            records.append(
                IncompleteItem(
                    session_id=state["session_id"],
                    original_name=state["original_name"],
                    completed_seconds=state["completed_seconds"],
                    total_seconds=state["total_seconds"],
                )
            )
        except Exception:
            continue
    return {"incomplete": records}


@app.get("/api/transcribe/history")
async def list_history():
    """回傳過去轉錄過的紀錄清單，依時間新到舊排序，供前端顯示歷史紀錄列表"""
    records = []
    for file in HISTORY_DIR.glob("*.json"):
        try:
            with open(file, "r", encoding="utf-8") as f:
                data = json.load(f)
            records.append(
                HistoryItem(
                    session_id=data["session_id"],
                    original_name=data["original_name"],
                    media_type=data["media_type"],
                    created_at=data["created_at"],
                    segment_count=len(data["segments"]),
                    thumbnail_url=data.get("thumbnail_url"),
                )
            )
        except Exception:
            continue  # 忽略讀取失敗的檔案，不影響其他紀錄正常顯示

    records.sort(key=lambda r: r.created_at, reverse=True)
    return {"history": records}


@app.delete("/api/transcribe/history/{session_id}")
async def delete_history(session_id: str):
    """
    刪除一筆歷史紀錄，同時清掉對應的上傳檔案與縮圖檔案，
    避免刪了紀錄卻留下孤兒檔案佔用硬碟空間。
    """
    history_file = HISTORY_DIR / f"{session_id}.json"
    if not history_file.exists():
        raise HTTPException(status_code=404, detail="找不到這筆歷史紀錄")

    with open(history_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    stored_filename = data.get("stored_filename")
    if stored_filename:
        stored_path = UPLOAD_DIR / stored_filename
        if stored_path.exists():
            stored_path.unlink()

    thumbnail_path = THUMBNAIL_DIR / f"{session_id}.jpg"
    if thumbnail_path.exists():
        thumbnail_path.unlink()

    history_file.unlink()
    JOB_STATUS.pop(session_id, None)

    return {"status": "deleted", "session_id": session_id}


@app.get("/api/transcribe/result/{session_id}", response_model=TranscribeResponse)
async def get_result(session_id: str):
    job = JOB_STATUS.get(session_id)

    if job:
        if job["status"] != "done":
            raise HTTPException(status_code=409, detail=f"任務尚未完成，目前狀態: {job['status']}")
        return TranscribeResponse(
            session_id=session_id,
            status="done",
            media_type=job["media_type"],
            media_url=job["media_url"],
            segments=job["segments"],
        )

    # 記憶體裡沒有這筆紀錄（例如後端重啟過），改讀取落地的歷史紀錄檔案
    history_file = HISTORY_DIR / f"{session_id}.json"
    if history_file.exists():
        with open(history_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return TranscribeResponse(
            session_id=session_id,
            status="done",
            media_type=data["media_type"],
            media_url=data["media_url"],
            segments=data["segments"],
        )

    raise HTTPException(status_code=404, detail="session_id 不存在")