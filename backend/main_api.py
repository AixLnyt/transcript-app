"""
main_api.py
上傳音檔/影片 -> faster-whisper 轉錄 -> 回傳帶時間戳記的逐字稿

啟動方式:
    uvicorn main_api:app --reload --host 0.0.0.0 --port 8000
"""

import uuid
import shutil
import traceback
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from transcribe import transcribe_file, AVAILABLE_MODELS, DEFAULT_MODEL_SIZE

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 讓前端可以直接用 URL 播放使用者上傳的原始檔案（影片/音訊）
app.mount("/static/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

JOB_STATUS = {}

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str


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


def run_transcription(session_id: str, input_path: Path, model_size: str):
    try:
        JOB_STATUS[session_id] = {"status": "processing", "message": "轉錄中...", "progress": 0.0}

        def on_progress(percent: float):
            # 更新進度時保留其他既有欄位，只覆蓋 progress/message
            JOB_STATUS[session_id]["progress"] = round(percent, 1)
            JOB_STATUS[session_id]["message"] = f"轉錄中... {round(percent)}%"

        segments = transcribe_file(str(input_path), model_size=model_size, progress_callback=on_progress)
        JOB_STATUS[session_id] = {
            "status": "done",
            "message": "完成",
            "progress": 100.0,
            "segments": segments,
            "input_path": input_path,
        }
        print(f"[{session_id}] 轉錄完成，共 {len(segments)} 個片段（模型: {model_size}）")
    except Exception as e:
        JOB_STATUS[session_id] = {"status": "failed", "message": str(e), "progress": None}
        print(f"[{session_id}] 轉錄失敗，完整錯誤如下：")
        traceback.print_exc()


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
    background_tasks.add_task(run_transcription, session_id, input_path, model_size)

    return JobStatusResponse(session_id=session_id, status="processing", progress_message="已加入佇列")


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
    )


@app.get("/api/transcribe/result/{session_id}", response_model=TranscribeResponse)
async def get_result(session_id: str):
    job = JOB_STATUS.get(session_id)
    if not job:
        raise HTTPException(status_code=404, detail="session_id 不存在")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"任務尚未完成，目前狀態: {job['status']}")

    input_path: Path = job["input_path"]
    media_type = "video" if input_path.suffix.lower() in VIDEO_EXTENSIONS else "audio"
    media_url = f"/static/uploads/{input_path.name}"

    return TranscribeResponse(
        session_id=session_id,
        status="done",
        media_type=media_type,
        media_url=media_url,
        segments=job["segments"],
    )