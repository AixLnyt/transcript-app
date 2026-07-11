// preload.js
// 安全橋接：renderer（index.html）不能直接存取 Node.js API，
// 透過 contextBridge 只暴露必要的幾個方法。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcherAPI", {
  start: () => ipcRenderer.send("start-services"),
  stop: () => ipcRenderer.send("stop-services"),
  openLogs: () => ipcRenderer.send("open-logs"),
  onStatusUpdate: (callback) => {
    ipcRenderer.on("status-update", (_event, message) => callback(message));
  },
});