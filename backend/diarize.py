"""
diarize.py

對整份音檔/影片做一次講者分離（不分段），回傳每個時間區間對應的講者標籤。
使用 pyannote-audio，這裡沿用另一個專案已經驗證過、能在這台機器上正常運作的
修補方式（k2 延遲載入 shim、speechbrain 延遲模組修補），細節說明如下。

安裝方式：
    pip install pyannote-audio speechbrain

環境變數需求：
    HF_TOKEN - HuggingFace access token，且需要先到以下頁面接受使用條款：
        https://huggingface.co/pyannote/speaker-diarization-3.1
        https://huggingface.co/pyannote/segmentation-3.0

已知風險：
- pyannote-audio 會連帶安裝 torch/torchaudio，如果你電腦上已經裝了
  特定 CUDA 版本的 torch（例如因為顯卡太新需要 nightly 版本），
  這裡的安裝可能會覆蓋掉那個版本。裝完後務必確認：
      python -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"
  如果版本被換掉、CUDA 不可用了，需要重新安裝對應的 nightly 版本。
- 沒有設定 HF_TOKEN，或還沒接受上述模型的使用條款時，這裡會拋出例外，
  呼叫端應該要捕捉這個例外並優雅降級（不做講者分離，只出純文字逐字稿），
  而不是讓整個轉錄流程失敗。
"""

import os
import sys
import types

# ---------- 修補：避免 speechbrain 的延遲模組被 inspect.stack() 誤觸發 ----------
# pyannote-audio 4.x 內部依賴會牽動 speechbrain，
# 而 speechbrain 有幾個選用的延遲載入整合模組（k2_fsa 需要 k2、
# huggingface 整合需要 transformers 等等）。
# PyTorch Lightning 載入模型時呼叫 inspect.stack() 會掃描所有已註冊的模組
# 並讀取每一個的 __file__ 屬性，不論跟目前流程有沒有關係都會被掃到、觸發載入，
# 缺少對應套件時就會把整個服務炸掉。這裡直接修補：
# 1) 塞一個假的 k2 模組，讓相關檢查直接判定「已存在」而跳過
# 2) 修補 speechbrain 延遲模組類別本身，讀取 __file__ 一律回傳假值，
#    從根源避免任何一個選用整合缺套件時把整個服務炸掉。
if "k2" not in sys.modules:
    _dummy_k2 = types.ModuleType("k2")
    _dummy_k2.__file__ = "<dummy_k2_shim>"
    sys.modules["k2"] = _dummy_k2

try:
    import speechbrain.utils.importutils as _sb_importutils

    _original_lazy_getattr = _sb_importutils.LazyModule.__getattr__

    def _patched_lazy_getattr(self, attr):
        if attr == "__file__":
            return "<lazy_module_stub>"
        return _original_lazy_getattr(self, attr)

    _sb_importutils.LazyModule.__getattr__ = _patched_lazy_getattr
except ImportError:
    pass  # speechbrain 尚未安裝或版本結構不同，略過修補

from pyannote.audio import Pipeline
import torch
import torchaudio

_pipeline_holder = {"pipeline": None}


def _load_pipeline():
    if _pipeline_holder["pipeline"] is not None:
        return _pipeline_holder["pipeline"]

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise RuntimeError(
            "沒有設定 HF_TOKEN 環境變數，無法使用講者分離功能。"
            "請先到 https://huggingface.co/settings/tokens 建立 token，"
            "並到 https://huggingface.co/pyannote/speaker-diarization-3.1 "
            "與 https://huggingface.co/pyannote/segmentation-3.0 接受使用條款。"
        )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=hf_token,
    ).to(torch.device(device))

    _pipeline_holder["pipeline"] = pipeline
    return pipeline


def diarize_full_file(file_path: str):
    """
    對整份音檔/影片做一次講者分離，回傳講者時間區間清單：
        [{"start": 0.0, "end": 12.3, "speaker": "SPEAKER_00"}, ...]

    刻意不分段處理（跟語音辨識的分段架構不同），因為講者分離需要看過
    整段錄音的全貌，才能穩定地把同一個人的聲音聚類在一起、給予一致的標籤。
    分段做的話，同一個人在不同段落可能會被標成不同的講者編號。
    """
    pipeline = _load_pipeline()

    # 用 torchaudio.load() 自己讀好 waveform，包成 pyannote 支援的字典格式傳入，
    # 避免依賴 torchcodec（在 Windows 上常因 FFmpeg 版本問題而載入失敗）。
    waveform, sample_rate = torchaudio.load(str(file_path))
    audio_input = {"waveform": waveform, "sample_rate": sample_rate}
    output = pipeline(audio_input)

    turns = []
    for turn, speaker in output.speaker_diarization:
        turns.append({"start": round(turn.start, 2), "end": round(turn.end, 2), "speaker": str(speaker)})
    return turns


def assign_speakers_to_segments(segments, speaker_turns):
    """
    把講者分離的時間區間結果，對照到語音辨識產生的逐字稿片段上。
    每個逐字稿片段依照「重疊時間最長的講者區間」來決定要標上哪個講者標籤。
    如果講者分離失敗或沒有資料，所有片段的 speaker 欄位維持 None。
    """
    if not speaker_turns:
        for seg in segments:
            seg["speaker"] = None
        return segments

    for seg in segments:
        best_speaker = None
        best_overlap = 0.0
        for turn in speaker_turns:
            overlap = min(seg["end"], turn["end"]) - max(seg["start"], turn["start"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = turn["speaker"]
        seg["speaker"] = best_speaker

    return segments