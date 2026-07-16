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


def get_model(model_size: str) -> WhisperModel:
    """對外公開的模型取得介面，行為與 _load_model 相同（延遲載入 + 快取）"""
    return _load_model(model_size)


def get_media_duration(file_path) -> float:
    """探測音檔/影片的總長度（秒），只讀取 metadata 不做完整解碼，速度很快"""
    import av

    container = av.open(str(file_path))
    duration = container.duration / 1_000_000 if container.duration else 0.0
    container.close()
    return duration


def extract_audio_chunk(input_path, start: float, end: float, output_path) -> None:
    """
    用 PyAV 擷取 [start, end) 這段時間的音訊，另存成一個獨立的暫存 wav 檔。

    不直接對整份大檔案呼叫 faster-whisper 的 clip_timestamps 參數分段，
    是因為該參數目前有已知 bug：範圍超過 30 秒時，超過的部分會被忽略、
    只會轉錄該範圍的前 30 秒（詳見
    https://github.com/SYSTRAN/faster-whisper/issues/1355）。
    改用實際擷取音訊片段另存成獨立小檔案的方式繞開這個限制。

    這樣做還有個附帶好處：即使原始來源是 60GB 的大型影片檔，
    每次處理的暫存檔案都只是幾分鐘的音訊，不會佔用大量硬碟空間，
    處理完就可以立刻刪除。
    """
    import av

    input_container = av.open(str(input_path))
    audio_stream = input_container.streams.audio[0]

    output_container = av.open(str(output_path), mode="w")
    output_stream = output_container.add_stream("pcm_s16le", rate=audio_stream.rate)
    output_stream.layout = "mono"

    # 關鍵：解碼出來的原始音框，格式/聲道數/取樣率很可能跟輸出流設定不一致
    # （例如來源是立體聲、浮點取樣格式，而輸出要求 mono s16）。
    # 如果沒有先正確重新取樣就直接塞給編碼器，會產生損毀或幾乎無聲的音訊，
    # 導致 VAD 偵測不到語音、轉錄結果幾乎是空的（這是先前版本的實際 bug）。
    resampler = av.AudioResampler(format="s16", layout="mono", rate=audio_stream.rate)

    # seek 到接近 start 的位置（seek 精度不保證到毫秒，靠下面的時間比對做精確過濾）
    input_container.seek(int(start / audio_stream.time_base), stream=audio_stream, backward=True)

    for frame in input_container.decode(audio_stream):
        frame_time = float(frame.pts * audio_stream.time_base)
        if frame_time < start:
            continue
        if frame_time >= end:
            break
        for resampled_frame in resampler.resample(frame):
            resampled_frame.pts = None
            for packet in output_stream.encode(resampled_frame):
                output_container.mux(packet)

    # 把 resampler 內部緩衝區剩餘的資料也一併沖出來，避免片段結尾的音訊被遺漏
    for resampled_frame in resampler.resample(None):
        resampled_frame.pts = None
        for packet in output_stream.encode(resampled_frame):
            output_container.mux(packet)

    for packet in output_stream.encode():
        output_container.mux(packet)

    output_container.close()
    input_container.close()


def transcribe_chunk_file(model, chunk_path, on_segment=None) -> List[TranscriptSegment]:
    """
    轉錄單一個已經切好的音訊區塊檔案，回傳的時間戳記是「相對於這個區塊本身」，
    呼叫端需要自行加上這個區塊的起始秒數，才會變成相對於原始完整檔案的絕對時間。

    on_segment: 選填，簽名為 (segment_dict) -> None 的回呼函式。
    faster-whisper 是逐句產生結果的，這裡讓呼叫端可以即時知道每一句的內容，
    避免處理一個較長的區塊時，中間有一大段時間完全沒有任何日誌輸出、
    看起來像卡住了。
    """
    segments_gen, _info = model.transcribe(
        str(chunk_path),
        beam_size=5,
        vad_filter=True,
    )
    result = []
    for s in segments_gen:
        seg = {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
        result.append(seg)
        if on_segment:
            on_segment(seg)
    return result


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