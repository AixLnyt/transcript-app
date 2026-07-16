// main.js
// Electron 主行程：負責開啟啟動器視窗、
// 用 child_process 啟動後端(uvicorn)與前端(next dev)，
// 並在前端就緒後自動切換到顯示網頁畫面。

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn, exec } = require("child_process");
const path = require("path");
const net = require("net");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(ROOT, "backend");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const LOG_DIR = path.join(__dirname, "logs");

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const backendLogStream = fs.createWriteStream(path.join(LOG_DIR, "backend.log"), { flags: "a" });
const frontendLogStream = fs.createWriteStream(path.join(LOG_DIR, "frontend.log"), { flags: "a" });

let mainWindow = null;
let backendProcess = null;
let frontendProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 260,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket
      .once("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .once("error", () => resolve(false))
      .once("timeout", () => {
        socket.destroy();
        resolve(false);
      })
      .connect(port, "localhost");
  });
}

function sendStatus(message) {
  if (mainWindow) {
    mainWindow.webContents.send("status-update", message);
  }
}

async function waitForPort(port, maxSeconds = 60) {
  for (let i = 0; i < maxSeconds; i++) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function killWhatIsUsingPort(port) {
  return new Promise((resolve) => {
    // 每次啟動前先清掉可能殘留占用該 port 的舊行程
    // （例如之前測試時 npm run dev 沒有被完全關乾淨，留下孤兒行程）
    const cmd = `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`;
    exec(cmd, () => resolve()); // 不管有沒有真的清到東西都繼續，忽略錯誤
  });
}

async function startServices() {
  try {
    sendStatus("清除殘留行程中...");
    await killWhatIsUsingPort(8000);
    await killWhatIsUsingPort(3000);

    sendStatus("啟動後端中...");

    backendProcess = spawn("uvicorn", ["main_api:app", "--reload", "--host", "0.0.0.0", "--port", "8000"], {
      cwd: BACKEND_DIR,
      shell: true,
      windowsHide: true,
    });
    backendProcess.on("error", (err) => sendStatus(`後端啟動失敗: ${err.message}`));
    backendProcess.stdout.pipe(backendLogStream);
    backendProcess.stderr.pipe(backendLogStream);

    sendStatus("啟動前端中...");
    frontendProcess = spawn("npm run dev", {
      cwd: FRONTEND_DIR,
      shell: true,
      windowsHide: true,
    });
    frontendProcess.on("error", (err) => sendStatus(`前端啟動失敗: ${err.message}`));
    frontendProcess.stdout.pipe(frontendLogStream);
    frontendProcess.stderr.pipe(frontendLogStream);

    sendStatus("等待後端就緒...");
    const backendReady = await waitForPort(8000, 60);
    if (!backendReady) {
      sendStatus("後端等待逾時，請檢查日誌");
      return;
    }

    sendStatus("等待前端就緒...");
    const ready = await waitForPort(3000, 60);

    if (ready) {
      sendStatus("已就緒，開啟畫面中...");
      try {
        mainWindow.setResizable(true);
        mainWindow.setSize(1280, 800);
        mainWindow.center();
        await mainWindow.loadURL("http://localhost:3000");
        sendStatus("已就緒");
      } catch (err) {
        sendStatus(`載入畫面失敗: ${err.message}`);
        console.error(err);
      }
    } else {
      sendStatus("等待逾時，請檢查後端/前端是否有錯誤（見終端機輸出）");
    }
  } catch (err) {
    sendStatus(`發生錯誤: ${err.message}`);
    console.error(err);
  }
}

function killProcessTree(proc) {
  if (!proc) return;
  // Windows 上 npm/uvicorn 會產生子行程，單純 kill 父行程可能留下孤兒行程，
  // 用 taskkill /T（連同子行程樹）/F（強制）確保真的關乾淨。
  if (process.platform === "win32") {
    exec(`taskkill /pid ${proc.pid} /T /F`);
  } else {
    proc.kill("SIGTERM");
  }
}

function stopServices() {
  killProcessTree(backendProcess);
  killProcessTree(frontendProcess);
  backendProcess = null;
  frontendProcess = null;
}

ipcMain.on("start-services", () => {
  startServices();
});

ipcMain.on("stop-services", () => {
  stopServices();
  sendStatus("已停止");
});

ipcMain.on("open-logs", () => {
  shell.openPath(LOG_DIR);
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  stopServices();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopServices();
});