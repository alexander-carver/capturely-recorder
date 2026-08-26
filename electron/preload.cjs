const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capturely", {
  recordings: {
    list: () => ipcRenderer.invoke("recordings:list"),
    begin: (details) => ipcRenderer.invoke("recordings:begin", details),
    append: (details) => ipcRenderer.invoke("recordings:append", details),
    finish: (details) => ipcRenderer.invoke("recordings:finish", details),
    openFolder: (id) => ipcRenderer.invoke("recordings:open-folder", id),
    shareLink: (id) => ipcRenderer.invoke("recordings:share-link", id),
    exportMp4: (details) =>
      ipcRenderer.invoke("recordings:export-mp4", details),
  },
  recording: {
    onToggle: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("recording:toggle", listener);
      return () => ipcRenderer.removeListener("recording:toggle", listener);
    },
  },
  window: {
    openOverlay: (cameraId) =>
      ipcRenderer.invoke("window:open-overlay", cameraId),
    closeOverlay: () => ipcRenderer.invoke("window:close-overlay"),
    hideOverlay: () => ipcRenderer.invoke("window:hide-overlay"),
    showOverlay: () => ipcRenderer.invoke("window:show-overlay"),
    showMain: () => ipcRenderer.invoke("window:show-main"),
    setOverlayInteractive: (interactive) =>
      ipcRenderer.invoke("window:set-overlay-interactive", interactive),
    moveOverlayBy: (deltaX, deltaY) =>
      ipcRenderer.invoke("window:move-overlay-by", { deltaX, deltaY }),
    resizeOverlay: (size, shape, settingsOpen) =>
      ipcRenderer.invoke("window:resize-overlay", {
        size,
        shape,
        settingsOpen,
      }),
  },
});
