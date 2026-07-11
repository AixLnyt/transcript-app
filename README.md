# 語音轉逐字稿（Transcript App）

**[English](./README_EN.md)** | 繁體中文

> 上傳音檔或影片，自動產生帶時間戳記的逐字稿，點擊任一句即可跳到該時間點播放。

---

## 這是什麼

一個本地端運作的語音／影片轉逐字稿工具。上傳檔案後，後端用 `faster-whisper` 進行語音辨識，產生帶起訖時間的逐字稿片段；前端提供影片/音訊播放器與可點擊的逐字稿列表，點擊任一句話會自動跳轉播放器到對應時間點。另外附一個 Electron 桌面啟動器，一鍵同時啟動前後端服務。

## 功能

- 支援音檔與影片上傳（`.mp3`、`.wav`、`.mp4`、`.mov` 等常見格式）
- 自動辨識語音內容，產生逐字稿（含每句起訖時間）
- 可在網頁上選擇轉錄模型（速度與準確度取捨，`tiny` 到 `large-v3`）
- 即時進度條，顯示實際轉錄進度百分比（非假動畫）
- 點擊逐字稿任一句，播放器自動跳轉並播放該時間點
- 播放過程中自動高亮目前播放到的逐字稿句子
- GPU 加速，若顯卡不相容會自動退回 CPU 執行，確保至少能運作
- Electron 桌面啟動器：一鍵啟動前後端服務並自動開啟畫面

## 技術棧

| 部分 | 技術 |
|---|---|
| 後端 | FastAPI、faster-whisper（CTranslate2） |
| 前端 | Next.js（App Router）、TypeScript、Tailwind CSS |
| 桌面啟動器 | Electron |

## 專案結構

```
transcript-app/
├── backend/
│   ├── main_api.py           # FastAPI 主程式：上傳/狀態/結果 API 端點
│   ├── transcribe.py         # faster-whisper 轉錄邏輯
│   └── requirements.txt
│
├── frontend/
│   └── app/
│       ├── components/
│       │   ├── UploadPanel.tsx       # 上傳、狀態輪詢、進度條
│       │   └── TranscriptPlayer.tsx  # 播放器 + 可點擊逐字稿
│       ├── types/transcript.ts
│       └── page.tsx
│
└── launcher/                 # Electron 桌面啟動器
    ├── main.js
    ├── preload.js
    └── index.html
```

## 開始使用

### 1. 後端

```bash
cd backend
pip install -r requirements.txt
uvicorn main_api:app --reload --host 0.0.0.0 --port 8000
```

第一次執行轉錄時，`faster-whisper` 會自動下載模型權重（`medium` 模型約 1.5GB），需要一點時間，之後會快取起來。

### 2. 前端

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

### 3.（可選）Electron 桌面啟動器

不想個別手動啟動前後端的話，可以改用桌面啟動器：

```bash
cd launcher
npm install
npm start
```

啟動視窗會自動依序啟動後端與前端，並在就緒後直接顯示網頁畫面。

## 已知限制

- **顯卡相容性**：`faster-whisper` 底層引擎綁定的 CUDA 函式庫，可能尚未支援最新架構顯卡。若 GPU 初始化失敗，程式會自動退回 CPU 執行（速度較慢但仍可運作）。
- **模型大小**：預設使用 `medium` 模型，準確度與速度平衡。可在 `backend/transcribe.py` 調整 `MODEL_SIZE`（`tiny`/`base`/`small`/`medium`/`large-v3`）。

## License

個人專案，尚未指定授權條款。
