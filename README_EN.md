# Transcript App

English | **[繁體中文](./README.md)**

> Upload an audio or video file to automatically generate a timestamped transcript. Click any line to jump the player to that exact moment.

---

## What is this

A locally-run tool that turns audio/video into a transcript. After you upload a file, the backend uses `faster-whisper` for speech recognition and produces transcript segments with start/end timestamps. The frontend provides a video/audio player alongside a clickable transcript list — clicking any line jumps the player to that timestamp. A companion Electron desktop launcher is included to start both backend and frontend with one click.

## Features

- Supports audio and video uploads (`.mp3`, `.wav`, `.mp4`, `.mov`, and other common formats)
- Automatic speech recognition with per-sentence start/end timestamps
- Choose the transcription model in the web UI (speed vs. accuracy trade-off, `tiny` to `large-v3`)
- Real progress bar showing actual transcription percentage (not a fake loading animation)
- Click any transcript line to jump the player to that timestamp
- Auto-highlights the currently playing line during playback
- GPU-accelerated, with automatic fallback to CPU if the GPU isn't compatible
- Electron desktop launcher: start backend + frontend with one click and auto-open the app

## Tech Stack

| Part | Technology |
|---|---|
| Backend | FastAPI, faster-whisper (CTranslate2) |
| Frontend | Next.js (App Router), TypeScript, Tailwind CSS |
| Desktop launcher | Electron |

## Project Structure

```
transcript-app/
├── backend/
│   ├── main_api.py           # FastAPI app: upload/status/result endpoints
│   ├── transcribe.py         # faster-whisper transcription logic
│   └── requirements.txt
│
├── frontend/
│   └── app/
│       ├── components/
│       │   ├── UploadPanel.tsx       # Upload, status polling, progress bar
│       │   └── TranscriptPlayer.tsx  # Player + clickable transcript
│       ├── types/transcript.ts
│       └── page.tsx
│
└── launcher/                 # Electron desktop launcher
    ├── main.js
    ├── preload.js
    └── index.html
```

## Getting Started

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main_api:app --reload --host 0.0.0.0 --port 8000
```

On first run, `faster-whisper` will automatically download model weights (the `medium` model is about 1.5GB), which takes a moment and is cached afterward.

### 2. Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

### 3. (Optional) Electron desktop launcher

If you'd rather not start backend and frontend separately:

```bash
cd launcher
npm install
npm start
```

The launcher window will start the backend and frontend in sequence, then display the app once it's ready.

## Known Limitations

- **GPU compatibility**: The CUDA libraries bundled with `faster-whisper`'s underlying engine may not yet support the newest GPU architectures. If GPU initialization fails, the app automatically falls back to CPU (slower but still functional).
- **Model size**: Defaults to the `medium` model as a balance of accuracy and speed. You can change `MODEL_SIZE` in `backend/transcribe.py` (`tiny`/`base`/`small`/`medium`/`large-v3`).

## License

Personal project, no license specified yet.