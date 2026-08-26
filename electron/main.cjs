const {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  session,
  Tray,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const ffmpegPath = app.isPackaged
  ? path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "ffmpeg-static",
      "ffmpeg",
    )
  : require("ffmpeg-static");

let mainWindow;
let overlayWindow;
let tray;
let shareServer;
let sharePort;
const activeWrites = new Map();

const recordsPath = () => path.join(app.getPath("userData"), "recordings.json");
const recordingsDir = () => path.join(app.getPath("videos"), "Capturely");

async function readRecords() {
  try {
    return JSON.parse(await fsp.readFile(recordsPath(), "utf8"));
  } catch {
    return [];
  }
}

async function saveRecords(records) {
  await fsp.mkdir(path.dirname(recordsPath()), { recursive: true });
  await fsp.writeFile(recordsPath(), JSON.stringify(records, null, 2));
}

function getLanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal)
        return address.address;
    }
  }
  return "127.0.0.1";
}

async function getRecord(id) {
  return (await readRecords()).find((record) => record.id === id);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  );
}

function isCapturelyRecording(filePath) {
  const root = `${path.resolve(recordingsDir())}${path.sep}`;
  return path.resolve(filePath).startsWith(root);
}

function sendRecordingToggle() {
  const target =
    overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : mainWindow;
  target?.webContents.send("recording:toggle");
}

function showRecorder() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    openOverlay();
    return;
  }
  overlayWindow.showInactive();
  overlayWindow.focus();
}

function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "trayTemplate.png")
    : path.join(__dirname, "../build/trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip("Capturely — open recorder overlay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open camera overlay", click: showOverlay },
      { label: "Open Capturely", click: showRecorder },
      { type: "separator" },
      {
        label: "Start / stop recording",
        accelerator: "CommandOrControl+Shift+R",
        click: sendRecordingToggle,
      },
      { type: "separator" },
      { label: "Quit Capturely", click: () => app.quit() },
    ]),
  );
  tray.on("click", showOverlay);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    process.on("error", reject);
    process.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr || "MP4 export failed.")),
    );
  });
}

function ensureShareServer() {
  if (shareServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    shareServer = http.createServer(async (request, response) => {
      const parsed = new URL(request.url, "http://capturely.local");
      const match = parsed.pathname.match(
        /^\/(share|media)\/([a-zA-Z0-9_-]+)$/,
      );
      if (!match) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const [, kind, id] = match;
      const record = await getRecord(id);
      if (!record || !fs.existsSync(record.path)) {
        response.writeHead(404);
        response.end("Recording unavailable");
        return;
      }
      if (kind === "media") {
        const size = fs.statSync(record.path).size;
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          const start = match ? Number(match[1]) : 0;
          const end = match?.[2]
            ? Math.min(Number(match[2]), size - 1)
            : size - 1;
          if (start >= size || end < start) {
            response.writeHead(416, { "Content-Range": `bytes */${size}` });
            response.end();
            return;
          }
          response.writeHead(206, {
            "Content-Type": "video/webm",
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Disposition": `inline; filename="${record.fileName}"`,
          });
          fs.createReadStream(record.path, { start, end }).pipe(response);
          return;
        }
        response.writeHead(200, {
          "Content-Type": "video/webm",
          "Content-Length": size,
          "Accept-Ranges": "bytes",
          "Content-Disposition": `inline; filename="${record.fileName}"`,
        });
        fs.createReadStream(record.path).pipe(response);
        return;
      }
      const safeTitle = escapeHtml(record.title || "Capturely recording");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeTitle}</title><style>body{margin:0;background:#111318;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;min-height:100vh;place-items:center}.wrap{width:min(1100px,92vw)}h1{font-size:18px;font-weight:600;margin:0 0 18px}video{width:100%;background:#000;border-radius:12px;box-shadow:0 24px 80px #0008}p{color:#aeb6c5;font-size:14px}</style></head><body><main class="wrap"><h1>${safeTitle}</h1><video controls autoplay playsinline src="/media/${id}"></video><p>Shared from Capturely on the local network.</p></main></body></html>`,
      );
    });
    shareServer.once("error", reject);
    shareServer.listen(0, "0.0.0.0", () => {
      sharePort = shareServer.address().port;
      resolve();
    });
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const entry =
    process.env.VITE_DEV_SERVER_URL ||
    `file://${path.join(__dirname, "../dist/index.html")}`;
  mainWindow.loadURL(entry);
}

function openOverlay(cameraId = "default") {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus();
    return;
  }
  overlayWindow = new BrowserWindow({
    width: 354,
    height: 330,
    minWidth: 354,
    minHeight: 180,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    title: "Capturely camera overlay",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadURL(
    `${process.env.VITE_DEV_SERVER_URL || `file://${path.join(__dirname, "../dist/index.html")}`}?overlay=1&cameraId=${encodeURIComponent(cameraId)}`,
  );
  overlayWindow.webContents.once("did-finish-load", () => {
    overlayWindow?.setIgnoreMouseEvents(true, { forward: true });
  });
  overlayWindow.on("closed", () => {
    overlayWindow = undefined;
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(["media", "display-capture"].includes(permission));
    },
  );
  const macOSSystemPickerAvailable =
    process.platform === "darwin" && Number(os.release().split(".")[0]) >= 24;
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // macOS 15+ uses its chooser. If it is unavailable, denying is safer than silently recording an arbitrary display.
      callback({});
    },
    { useSystemPicker: macOSSystemPickerAvailable },
  );
  createMainWindow();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+R", sendRecordingToggle);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("recordings:list", readRecords);
ipcMain.handle("recordings:begin", async (_event, { mimeType }) => {
  await fsp.mkdir(recordingsDir(), { recursive: true });
  const id = crypto.randomUUID().replaceAll("-", "");
  const fileName = `Capturely-${new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "")}.webm`;
  const filePath = path.join(recordingsDir(), `${id}.webm`);
  fs.writeFileSync(filePath, "");
  activeWrites.set(id, { filePath, fileName, mimeType, bytes: 0 });
  return { id, fileName };
});
ipcMain.handle("recordings:append", async (_event, { id, data }) => {
  const write = activeWrites.get(id);
  if (!write) throw new Error("Recording session was not found.");
  const buffer = Buffer.from(data);
  await fsp.appendFile(write.filePath, buffer);
  write.bytes += buffer.length;
});
ipcMain.handle(
  "recordings:finish",
  async (_event, { id, title, duration, width, height }) => {
    const write = activeWrites.get(id);
    if (!write) throw new Error("Recording session was not found.");
    activeWrites.delete(id);
    const record = {
      id,
      fileName: write.fileName,
      path: write.filePath,
      title: title || "Untitled recording",
      duration,
      width,
      height,
      createdAt: new Date().toISOString(),
      bytes: write.bytes,
    };
    const records = await readRecords();
    records.unshift(record);
    await saveRecords(records);
    return record;
  },
);
ipcMain.handle("recordings:open-folder", async (_event, id) => {
  const record = await getRecord(id);
  if (!record || !isCapturelyRecording(record.path))
    throw new Error("Recording was not found.");
  shell.showItemInFolder(record.path);
});
ipcMain.handle("recordings:share-link", async (_event, id) => {
  const record = await getRecord(id);
  if (!record || !isCapturelyRecording(record.path))
    throw new Error("Recording was not found.");
  await ensureShareServer();
  const link = `http://${getLanAddress()}:${sharePort}/share/${id}`;
  clipboard.writeText(link);
  return link;
});
ipcMain.handle("recordings:export-mp4", async (_event, { id, start, end }) => {
  const record = await getRecord(id);
  if (!record || !isCapturelyRecording(record.path))
    throw new Error("Recording was not found.");
  const startSeconds = Math.max(0, Number(start) || 0);
  const requestedEnd = Number(end);
  const endSeconds = Number.isFinite(requestedEnd)
    ? Math.max(startSeconds, requestedEnd)
    : record.duration;
  const duration = Math.max(0.1, endSeconds - startSeconds);
  const idSuffix = crypto.randomUUID().replaceAll("-", "");
  const fileName = `${path.parse(record.fileName).name}-trimmed.mp4`;
  const filePath = path.join(recordingsDir(), `${idSuffix}.mp4`);
  await runFfmpeg([
    "-y",
    "-ss",
    String(startSeconds),
    "-i",
    record.path,
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    filePath,
  ]);
  const exported = {
    id: idSuffix,
    fileName,
    path: filePath,
    title: `${record.title} (MP4)`,
    duration,
    width: record.width,
    height: record.height,
    createdAt: new Date().toISOString(),
    bytes: (await fsp.stat(filePath)).size,
  };
  const records = await readRecords();
  records.unshift(exported);
  await saveRecords(records);
  return exported;
});
ipcMain.handle("window:open-overlay", (_event, cameraId) =>
  openOverlay(cameraId),
);
ipcMain.handle("window:close-overlay", () => overlayWindow?.close());
ipcMain.handle("window:hide-overlay", () => overlayWindow?.hide());
ipcMain.handle("window:show-overlay", () => {
  overlayWindow?.showInactive();
  overlayWindow?.setAlwaysOnTop(true, "screen-saver");
});
ipcMain.handle("window:set-overlay-interactive", (_event, interactive) => {
  overlayWindow?.setIgnoreMouseEvents(!interactive, { forward: true });
  return { interactive: Boolean(interactive) };
});
ipcMain.handle("window:move-overlay-by", (_event, { deltaX, deltaY }) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const [x, y] = overlayWindow.getPosition();
  const nextX = x + Math.round(Number(deltaX) || 0);
  const nextY = y + Math.round(Number(deltaY) || 0);
  overlayWindow.setPosition(nextX, nextY);
  return { x: nextX, y: nextY };
});
ipcMain.handle(
  "window:resize-overlay",
  (_event, { size, shape, settingsOpen }) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const normalizedSize = Math.min(520, Math.max(160, Number(size) || 240));
    const cameraHeight =
      shape === "rectangle" ? normalizedSize * (9 / 16) : normalizedSize;
    const display = screen.getDisplayMatching(overlayWindow.getBounds());
    const width = Math.min(
      Math.max(Math.round(normalizedSize + 24), settingsOpen ? 356 : 354),
      display.workAreaSize.width - 20,
    );
    const height = Math.min(
      Math.max(Math.round(cameraHeight + 92), settingsOpen ? 452 : 0),
      display.workAreaSize.height - 20,
    );
    const bounds = overlayWindow.getBounds();
    const maxX = display.workArea.x + display.workArea.width - width;
    const maxY = display.workArea.y + display.workArea.height - height;
    overlayWindow.setBounds({
      x: Math.max(display.workArea.x, Math.min(bounds.x, maxX)),
      y: Math.max(display.workArea.y, Math.min(bounds.y, maxY)),
      width,
      height,
    });
    return overlayWindow.getBounds();
  },
);
ipcMain.handle("window:show-main", () => {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
});
