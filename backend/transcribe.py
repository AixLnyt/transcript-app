"""
transcribe.py

使用 faster-whisper（CTranslate2 後端）將音檔/影片轉錄成帶時間戳記的逐字稿。

選用 faster-whisper 而非 transformers 版 Whisper 的原因：
之前在同一台機器上用 transformers 的 Whisper pipeline 時，
曾在較新的 torch/transformers 版本組合下遇到 "meta tensor" 相關錯誤。
faster-whisper 底層是獨立的 CTranslate2 引擎，不依賴 transformers/accelerate
的模型搬移機制，能避開那類問題。

安裝方式：
    pip install faster-whisper av

faster-whisper 透過 PyAV（av 套件）解碼音訊，PyAV 內建 FFmpeg 綁定，
可以直接讀取影片檔案並抽取音軌，不需要另外用 ffmpeg CLI 前處理。

已知風險：CTranslate2（faster-whisper 的推理引擎）綁定的 CUDA 函式庫
可能尚未支援最新架構的顯卡（例如 RTX 50 系列 Blackwell）。
這裡的實作會自動偵測：先嘗試 GPU，若初始化失敗則自動退回 CPU 執行，
確保至少能跑起來，不會因為顯卡太新而整個掛掉。
"""

from pathlib import Path
from typing import List, TypedDict

from faster_whisper import WhisperModel


class TranscriptSegment(TypedDict):
    start: float
    end: float
    text: str


_model_cache: dict = {}

# 可選模型清單：速度與準確度的取捨
# tiny/base 最快但準確度較低，medium 是預設的平衡選擇，
# large-v3 最準確但最慢，適合對準確度要求高、不趕時間的情況。
AVAILABLE_MODELS = ["tiny", "base", "small", "medium", "large-v3"]
DEFAULT_MODEL_SIZE = "medium"


def _load_model(model_size: str) -> WhisperModel:
    """
    依指定的模型尺寸延遲載入，並快取起來。
    同一個尺寸只會真正載入一次（含下載權重），之後重複使用；
    切換到不同尺寸時才會觸發新的載入（含下載，若尚未下載過）。
    優先嘗試 GPU，失敗則自動退回 CPU。
    """
    if model_size in _model_cache:
        return _model_cache[model_size]

    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        print(f"[transcribe] 已載入模型 (device=cuda, size={model_size})")
    except Exception as e:
        print(f"[transcribe] GPU 初始化失敗，改用 CPU: {e}")
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        print(f"[transcribe] 已載入模型 (device=cpu, size={model_size})")

    _model_cache[model_size] = model
    return model


def transcribe_file(
    file_path: str, model_size: str = DEFAULT_MODEL_SIZE, progress_callback=None
) -> List[TranscriptSegment]:
    """
    轉錄音檔/影片，回傳帶時間戳記的逐字稿片段清單。
    每個片段包含 start（開始秒數）、end（結束秒數）、text（文字內容）。

    model_size: 指定要使用的模型尺寸（見 AVAILABLE_MODELS），
    不同尺寸在速度與準確度上是取捨關係。

    progress_callback: 選填，簽名為 (percent: float) -> None 的函式。
    faster-whisper 是逐段（segment-by-segment）產生結果的，
    這裡利用 info.duration（音檔總長度）與每段的 end 時間，
    即時算出目前轉錄進度百分比，讓呼叫端可以回報真實進度，
    而不是假的載入動畫。
    """
    model = _load_model(model_size)

    segments_gen, info = model.transcribe(
        file_path,
        beam_size=5,
        vad_filter=True,  # 過濾靜音片段，避免產生空白逐字稿行
    )

    total_duration = info.duration if info.duration else None

    result: List[TranscriptSegment] = []
    for segment in segments_gen:
        result.append(
            {
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text.strip(),
            }
        )
        if progress_callback and total_duration:
            percent = min(99.0, (segment.end / total_duration) * 100)
            progress_callback(percent)

    if progress_callback:
        progress_callback(100.0)

    return result