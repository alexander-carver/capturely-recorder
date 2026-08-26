import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import "./App.css";

type CameraShape = "circle" | "square" | "rectangle";
type CaptureMode = "screen" | "camera";
type Quality = "native" | "2160" | "1440" | "1080" | "720";
type Notice = { type: "error" | "success" | "info"; message: string } | null;

const qualityOptions: {
  value: Quality;
  label: string;
  maxWidth?: number;
  maxHeight?: number;
  bitrate: number;
}[] = [
  { value: "native", label: "Native (highest)", bitrate: 28_000_000 },
  {
    value: "2160",
    label: "4K · 2160p",
    maxWidth: 3840,
    maxHeight: 2160,
    bitrate: 42_000_000,
  },
  {
    value: "1440",
    label: "2K · 1440p",
    maxWidth: 2560,
    maxHeight: 1440,
    bitrate: 22_000_000,
  },
  {
    value: "1080",
    label: "1080p",
    maxWidth: 1920,
    maxHeight: 1080,
    bitrate: 12_000_000,
  },
  {
    value: "720",
    label: "720p",
    maxWidth: 1280,
    maxHeight: 720,
    bitrate: 6_000_000,
  },
];

const clamp = (number: number, minimum: number, maximum: number) =>
  Math.min(Math.max(number, minimum), maximum);
const formatTime = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(11, 19);
const formatBytes = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} KB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
const dateText = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`toggle ${checked ? "is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>capturely</span>
    </div>
  );
}

function DesktopOverlay() {
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const animationRef = useRef<number | null>(null);
  const writeChainRef = useRef(Promise.resolve());
  const sessionRef = useRef<string | null>(null);
  const durationRef = useRef(0);
  const finalizedDurationRef = useRef(0);
  const dimensionsRef = useRef({ width: 1920, height: 1080 });
  const overlayDragRef = useRef<{
    pointerId: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const overlayHiddenForDisplayRef = useRef(false);
  const requestedCamera =
    new URLSearchParams(window.location.search).get("cameraId") || "default";
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState(requestedCamera);
  const [micId, setMicId] = useState("default");
  const [shape, setShape] = useState<CameraShape>("circle");
  const [overlaySize, setOverlaySize] = useState(240);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("screen");
  const captureModeRef = useRef<CaptureMode>("screen");
  const [cameraVisible, setCameraVisible] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [systemAudioAvailable, setSystemAudioAvailable] = useState<
    boolean | null
  >(null);
  const [voiceIsolation, setVoiceIsolation] = useState(true);
  const [quality, setQuality] = useState<Quality>("native");
  const [recording, setRecording] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  const cameras = devices.filter((device) => device.kind === "videoinput");

  const selectCaptureMode = (nextMode: CaptureMode) => {
    captureModeRef.current = nextMode;
    setCaptureMode(nextMode);
    if (nextMode === "camera") setSystemAudio(false);
  };

  const stopStream = (stream: MediaStream | null) =>
    stream?.getTracks().forEach((track) => track.stop());
  const attachVideo = async (
    element: HTMLVideoElement | null,
    stream: MediaStream,
  ) => {
    if (!element) return;
    element.srcObject = stream;
    await element.play();
  };
  const loadDevices = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setNotice({
        type: "error",
        message: "Capturely could not list the connected recording devices.",
      });
    }
  }, []);
  const startCamera = useCallback(
    async (requestedId = cameraId) => {
      stopStream(cameraStreamRef.current);
      const deviceId =
        requestedId === "default" ? undefined : { exact: requestedId };
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId,
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
      cameraStreamRef.current = stream;
      await attachVideo(cameraVideoRef.current, stream);
      setCameraError("");
      await loadDevices();
    },
    [cameraId, loadDevices],
  );
  const chooseDimensions = (sourceWidth: number, sourceHeight: number) => {
    const requested = qualityOptions.find(
      (option) => option.value === quality,
    )!;
    if (!requested.maxWidth || !requested.maxHeight)
      return { width: sourceWidth, height: sourceHeight };
    const scale = Math.min(
      1,
      requested.maxWidth / sourceWidth,
      requested.maxHeight / sourceHeight,
    );
    return {
      width: Math.round(sourceWidth * scale),
      height: Math.round(sourceHeight * scale),
    };
  };
  const releaseCapture = useCallback(() => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    stopStream(screenStreamRef.current);
    stopStream(micStreamRef.current);
    screenStreamRef.current = null;
    micStreamRef.current = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    if (overlayHiddenForDisplayRef.current) {
      overlayHiddenForDisplayRef.current = false;
      void window.capturely?.window.showOverlay();
    }
  }, []);
  const drawComposite = useCallback(
    function drawComposite() {
      const canvas = canvasRef.current;
      if (!canvas) {
        animationRef.current = requestAnimationFrame(drawComposite);
        return;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      const { width, height } = dimensionsRef.current;
      context.fillStyle = "#0b1020";
      context.fillRect(0, 0, width, height);
      const camera = cameraVideoRef.current;
      if (captureModeRef.current === "camera") {
        if (!camera || camera.readyState < 2) {
          animationRef.current = requestAnimationFrame(drawComposite);
          return;
        }
        context.drawImage(camera, 0, 0, width, height);
        animationRef.current = requestAnimationFrame(drawComposite);
        return;
      }
      const screen = screenVideoRef.current;
      if (!screen || screen.readyState < 2) {
        animationRef.current = requestAnimationFrame(drawComposite);
        return;
      }
      const screenRatio = screen.videoWidth / screen.videoHeight;
      const outputRatio = width / height;
      let renderWidth = width;
      let renderHeight = height;
      let offsetX = 0;
      let offsetY = 0;
      if (screenRatio > outputRatio) {
        renderHeight = width / screenRatio;
        offsetY = (height - renderHeight) / 2;
      } else {
        renderWidth = height * screenRatio;
        offsetX = (width - renderWidth) / 2;
      }
      context.drawImage(screen, offsetX, offsetY, renderWidth, renderHeight);
      if (cameraVisible && camera && camera.readyState >= 2) {
        const overlayWidth = width * (overlaySize / 1100);
        const overlayHeight =
          shape === "rectangle" ? overlayWidth * (9 / 16) : overlayWidth;
        const x = width - overlayWidth - width * 0.045;
        const y = height - overlayHeight - height * 0.055;
        context.save();
        context.beginPath();
        if (shape === "circle")
          context.ellipse(
            x + overlayWidth / 2,
            y + overlayHeight / 2,
            overlayWidth / 2,
            overlayHeight / 2,
            0,
            0,
            Math.PI * 2,
          );
        else
          context.roundRect(
            x,
            y,
            overlayWidth,
            overlayHeight,
            overlayWidth * 0.075,
          );
        context.clip();
        context.translate(x + overlayWidth, y);
        context.scale(-1, 1);
        context.drawImage(camera, 0, 0, overlayWidth, overlayHeight);
        context.restore();
        context.strokeStyle = "rgba(255,255,255,.88)";
        context.lineWidth = Math.max(1, width / 1920);
        context.beginPath();
        if (shape === "circle")
          context.ellipse(
            x + overlayWidth / 2,
            y + overlayHeight / 2,
            overlayWidth / 2,
            overlayHeight / 2,
            0,
            0,
            Math.PI * 2,
          );
        else
          context.roundRect(
            x,
            y,
            overlayWidth,
            overlayHeight,
            overlayWidth * 0.075,
          );
        context.stroke();
      }
      animationRef.current = requestAnimationFrame(drawComposite);
    },
    [cameraVisible, overlaySize, shape],
  );
  const mixAudio = async (mode = captureModeRef.current) => {
    const wantsSystemAudio =
      mode === "screen" &&
      systemAudio &&
      Boolean(screenStreamRef.current?.getAudioTracks().length);
    if (!micOn && !wantsSystemAudio) return new MediaStream();
    const context = new AudioContext();
    audioContextRef.current = context;
    await context.resume();
    const destination = context.createMediaStreamDestination();
    if (wantsSystemAudio && screenStreamRef.current) {
      context
        .createMediaStreamSource(
          new MediaStream(screenStreamRef.current.getAudioTracks()),
        )
        .connect(destination);
    }
    if (micOn) {
      const deviceId = micId === "default" ? undefined : { exact: micId };
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId,
          echoCancellation: voiceIsolation,
          noiseSuppression: voiceIsolation,
          autoGainControl: voiceIsolation,
        },
        video: false,
      });
      micStreamRef.current = microphone;
      if (!microphone.getAudioTracks().length)
        throw new Error("The selected microphone did not provide audio.");
      const source = context.createMediaStreamSource(microphone);
      if (voiceIsolation) {
        const highPass = context.createBiquadFilter();
        highPass.type = "highpass";
        highPass.frequency.value = 90;
        const lowPass = context.createBiquadFilter();
        lowPass.type = "lowpass";
        lowPass.frequency.value = 9000;
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 20;
        compressor.ratio.value = 5;
        source
          .connect(highPass)
          .connect(lowPass)
          .connect(compressor)
          .connect(destination);
      } else source.connect(destination);
    }
    return destination.stream;
  };
  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    finalizedDurationRef.current = durationRef.current;
    setRecording(false);
    setPaused(false);
    setElapsed(0);
    setFinalizing(true);
    recorder.stop();
  }, []);
  const startRecording = async (modeOverride?: CaptureMode) => {
    setNotice(null);
    setSettingsOpen(false);
    const mode = modeOverride || captureModeRef.current;
    selectCaptureMode(mode);
    try {
      let source: MediaTrackSettings | undefined;
      let display: MediaStream | null = null;
      if (mode === "screen") {
        // This call stays in the overlay's button handler so macOS can present its native picker.
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 60 } },
          audio: systemAudio,
        });
        screenStreamRef.current = display;
        await attachVideo(screenVideoRef.current, display);
        source = display.getVideoTracks()[0]?.getSettings();
        if (source?.displaySurface === "monitor") {
          overlayHiddenForDisplayRef.current = true;
          await window.capturely?.window.hideOverlay();
        }
        setSystemAudioAvailable(display.getAudioTracks().length > 0);
        display.getVideoTracks()[0]?.addEventListener("ended", stopRecording);
      } else {
        setCameraVisible(true);
        if (!cameraStreamRef.current) await startCamera();
        source = cameraStreamRef.current?.getVideoTracks()[0]?.getSettings();
        setSystemAudioAvailable(false);
        cameraStreamRef.current
          ?.getVideoTracks()[0]
          ?.addEventListener("ended", stopRecording, { once: true });
      }
      const dimensions = chooseDimensions(
        source?.width || 1920,
        source?.height || 1080,
      );
      dimensionsRef.current = dimensions;
      if (!canvasRef.current)
        throw new Error("Recording canvas was unavailable.");
      canvasRef.current.width = dimensions.width;
      canvasRef.current.height = dimensions.height;
      if (mode === "screen" && cameraVisible && !cameraStreamRef.current) {
        try {
          await startCamera();
        } catch {
          setCameraVisible(false);
          setCameraError(
            "Camera is unavailable; screen recording will continue.",
          );
        }
      }
      let audioStream: MediaStream;
      try {
        audioStream = await mixAudio(mode);
      } catch (error) {
        stopStream(micStreamRef.current);
        micStreamRef.current = null;
        await audioContextRef.current?.close();
        audioContextRef.current = null;
        audioStream = new MediaStream(
          mode === "screen" && systemAudio
            ? display?.getAudioTracks() || []
            : [],
        );
        setNotice({
          type: "info",
          message:
            error instanceof Error
              ? `${error.message} Continuing without microphone audio.`
              : "Continuing without microphone audio.",
        });
      }
      drawComposite();
      const output = canvasRef.current.captureStream(30);
      audioStream.getAudioTracks().forEach((track) => output.addTrack(track));
      const mimeType =
        [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ].find(MediaRecorder.isTypeSupported) || "";
      const bitrate = qualityOptions.find(
        (option) => option.value === quality,
      )!.bitrate;
      const recorder = new MediaRecorder(
        output,
        mimeType
          ? {
              mimeType,
              videoBitsPerSecond: bitrate,
              audioBitsPerSecond: 192_000,
            }
          : { videoBitsPerSecond: bitrate },
      );
      recorderRef.current = recorder;
      const browserChunks: Blob[] = [];
      const session = window.capturely
        ? await window.capturely.recordings.begin({
            mimeType: recorder.mimeType || "video/webm",
          })
        : null;
      sessionRef.current = session?.id || null;
      writeChainRef.current = Promise.resolve();
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        if (sessionRef.current && window.capturely) {
          writeChainRef.current = writeChainRef.current.then(async () =>
            window.capturely?.recordings.append({
              id: sessionRef.current!,
              data: await event.data.arrayBuffer(),
            }),
          );
        } else browserChunks.push(event.data);
      };
      recorder.onstop = async () => {
        try {
          await writeChainRef.current;
          if (sessionRef.current && window.capturely) {
            await window.capturely.recordings.finish({
              id: sessionRef.current,
              title:
                mode === "camera"
                  ? "Camera-only recording"
                  : "Screen recording",
              duration: finalizedDurationRef.current || durationRef.current,
              ...dimensionsRef.current,
            });
            setNotice({
              type: "success",
              message: "Saved to Movies/Capturely.",
            });
          } else {
            const blob = new Blob(browserChunks, {
              type: recorder.mimeType || "video/webm",
            });
            const url = URL.createObjectURL(blob);
            const download = document.createElement("a");
            download.href = url;
            download.download = `Capturely-${Date.now()}.webm`;
            download.click();
            URL.revokeObjectURL(url);
            setNotice({ type: "success", message: "Recording downloaded." });
          }
        } catch {
          setNotice({
            type: "error",
            message: "Recording stopped, but the file could not be finalized.",
          });
        } finally {
          sessionRef.current = null;
          durationRef.current = 0;
          finalizedDurationRef.current = 0;
          setElapsed(0);
          setPaused(false);
          setRecording(false);
          setFinalizing(false);
          releaseCapture();
        }
      };
      durationRef.current = 0;
      finalizedDurationRef.current = 0;
      setElapsed(0);
      recorder.start(4_000);
      setFinalizing(false);
      setRecording(true);
    } catch (error) {
      releaseCapture();
      setNotice({
        type: "error",
        message:
          error instanceof Error && error.name === "NotAllowedError"
            ? mode === "camera"
              ? "Camera access was cancelled or blocked."
              : "Screen sharing was cancelled or blocked."
            : error instanceof Error
              ? error.message
              : "Capturely could not start this recording.",
      });
    }
  };
  const togglePause = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setPaused(true);
    } else if (recorder.state === "paused") {
      recorder.resume();
      setPaused(false);
    }
  };

  useEffect(() => {
    const startup = window.setTimeout(() => {
      void loadDevices();
      void startCamera().catch(() =>
        setCameraError("Allow camera access to show your face in the overlay."),
      );
    }, 0);
    navigator.mediaDevices.addEventListener?.("devicechange", loadDevices);
    return () => {
      window.clearTimeout(startup);
      navigator.mediaDevices.removeEventListener?.("devicechange", loadDevices);
      stopRecording();
      releaseCapture();
      stopStream(cameraStreamRef.current);
    };
  }, [loadDevices, releaseCapture, startCamera, stopRecording]);
  useEffect(() => {
    if (!recording || paused) return;
    const timer = window.setInterval(() => {
      durationRef.current += 1;
      setElapsed(durationRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [paused, recording]);
  useEffect(() => {
    void window.capturely?.window.setOverlayInteractive(false);
    return () => void window.capturely?.window.setOverlayInteractive(true);
  }, []);
  useEffect(() => {
    void window.capturely?.window.resizeOverlay(
      overlaySize,
      shape,
      settingsOpen,
    );
  }, [overlaySize, shape, settingsOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => setNotice(null),
      notice.type === "success" ? 3_500 : 6_000,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(
    () =>
      window.capturely?.recording.onToggle(() => {
        document.querySelector<HTMLButtonElement>(".overlay-record")?.click();
      }),
    [],
  );
  const changeCamera = async (nextCameraId: string) => {
    setCameraId(nextCameraId);
    try {
      await startCamera(nextCameraId);
    } catch {
      setCameraError("That camera could not be started.");
    }
  };
  const closeOverlay = useCallback(() => {
    if (!recording && !finalizing) void window.capturely?.window.closeOverlay();
  }, [finalizing, recording]);
  const showControls = () => {
    setControlsVisible(true);
    void window.capturely?.window.setOverlayInteractive(true);
  };
  const hideControls = () => {
    setControlsVisible(false);
    if (!overlayDragRef.current)
      void window.capturely?.window.setOverlayInteractive(false);
  };
  const handleCloseButtonEnter = () => {
    showControls();
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      closeOverlay();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeOverlay, settingsOpen]);
  const startOverlayDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    showControls();
    overlayDragRef.current = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveOverlay = (event: PointerEvent<HTMLDivElement>) => {
    const drag = overlayDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.screenX - drag.screenX;
    const deltaY = event.screenY - drag.screenY;
    if (deltaX || deltaY)
      void window.capturely?.window.moveOverlayBy(deltaX, deltaY);
    drag.screenX = event.screenX;
    drag.screenY = event.screenY;
  };
  const stopOverlayDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (overlayDragRef.current?.pointerId !== event.pointerId) return;
    overlayDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <main
      className={`desktop-overlay ${controlsVisible || settingsOpen ? "is-controls-visible" : ""} ${settingsOpen ? "is-settings-open" : ""}`}
      style={{ "--overlay-size": `${overlaySize}px` } as CSSProperties}
    >
      <div
        className="overlay-cluster"
        onMouseEnter={showControls}
        onMouseLeave={hideControls}
      >
        <div
          className={`overlay-video ${shape} ${cameraVisible ? "" : "off"}`}
          onPointerDown={startOverlayDrag}
          onPointerMove={moveOverlay}
          onPointerUp={stopOverlayDrag}
          onPointerCancel={stopOverlayDrag}
        >
          {cameraVisible && !cameraError ? (
            <video ref={cameraVideoRef} muted playsInline autoPlay />
          ) : (
            <div className="overlay-camera-message">
              <Icon size={20}>
                <path d="M4 7h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
                <path d="m16 10 5-3v10l-5-3" />
              </Icon>
              <span>{cameraError || "Camera hidden"}</span>
            </div>
          )}
          {recording && controlsVisible && (
            <span className="overlay-live">REC {formatTime(elapsed)}</span>
          )}
        </div>
        <div
          className="overlay-dock no-drag"
          aria-label="Capturely recorder controls"
        >
          <button
            className={`overlay-record ${recording ? "is-recording" : ""}`}
            onClick={() =>
              recording ? stopRecording() : void startRecording()
            }
            disabled={finalizing}
            aria-label={
              finalizing
                ? "Finishing recording"
                : recording
                  ? "Stop recording"
                  : captureMode === "camera"
                    ? "Record camera only"
                    : "Start recording"
            }
          >
            {recording ? (
              <span className="stop-square" />
            ) : (
              <span className="record-dot" />
            )}
          </button>
          {recording ? (
            <button
              className="overlay-action"
              onClick={togglePause}
              disabled={finalizing}
              aria-label={paused ? "Resume recording" : "Pause recording"}
              title={paused ? "Resume" : "Pause"}
            >
              {paused ? (
                <Icon size={17}>
                  <path
                    d="m8 5 10 7-10 7V5Z"
                    fill="currentColor"
                    stroke="none"
                  />
                </Icon>
              ) : (
                <Icon size={17}>
                  <path d="M8 5v14M16 5v14" />
                </Icon>
              )}
            </button>
          ) : (
            <button
              className={`overlay-camera-only ${captureMode === "camera" ? "is-active" : ""}`}
              onClick={() =>
                selectCaptureMode(
                  captureMode === "camera" ? "screen" : "camera",
                )
              }
              disabled={finalizing}
              aria-label={
                captureMode === "camera"
                  ? "Just me mode selected. Switch back to screen recording"
                  : "Select just me mode for a full-frame camera video"
              }
              title={
                captureMode === "camera"
                  ? "Just me selected — press the red Record button when ready"
                  : "Select a full-frame camera video, then press Record"
              }
            >
              <Icon size={15}>
                <rect x="3" y="6" width="13" height="12" rx="2" />
                <path d="m16 10 5-3v10l-5-3" />
              </Icon>
              <span>Just me</span>
            </button>
          )}
          <span className="overlay-divider" />
          <button
            className={`overlay-action ${micOn ? "is-active" : ""}`}
            onClick={() => setMicOn((enabled) => !enabled)}
            disabled={recording || finalizing}
            aria-label={micOn ? "Microphone on" : "Microphone off"}
            title={micOn ? "Microphone on" : "Microphone off"}
          >
            <Icon size={17}>
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17v4M8.5 21h7" />
              {!micOn && <path d="m4 4 16 16" />}
            </Icon>
          </button>
          <button
            className={`overlay-action ${cameraVisible ? "is-active" : ""}`}
            onClick={() => setCameraVisible((visible) => !visible)}
            disabled={recording || finalizing}
            aria-label={cameraVisible ? "Camera on" : "Camera off"}
            title={cameraVisible ? "Camera on" : "Camera off"}
          >
            <Icon size={17}>
              <path d="M3 7h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
              <path d="m15 10 6-3v10l-6-3" />
              {!cameraVisible && <path d="m3 3 18 18" />}
            </Icon>
          </button>
          <span className="overlay-divider" />
          <button
            className={`overlay-action ${settingsOpen ? "is-active" : ""}`}
            onClick={() => setSettingsOpen((open) => !open)}
            disabled={recording || finalizing}
            aria-label="Recording settings"
            title="Recording settings"
          >
            <Icon size={17}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56v.08h-3v-.08A1.7 1.7 0 0 0 10.68 18.7a1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7.02 15a1.7 1.7 0 0 0-1.56-1.03h-.08v-3h.08A1.7 1.7 0 0 0 7.02 9.94a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56v-.08h3v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 8l-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03h.08v3h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </Icon>
          </button>
          <button
            className="overlay-action"
            onClick={() => void window.capturely?.window.showMain()}
            aria-label="Open dashboard"
            title="Open dashboard"
          >
            <Icon size={17}>
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18M9 9v11" />
            </Icon>
          </button>
          <button
            className="overlay-close"
            onClick={closeOverlay}
            disabled={recording || finalizing}
            aria-label="Close overlay"
            title={
              recording ? "Stop recording before closing" : "Close overlay"
            }
          >
            <Icon size={16}>
              <path d="m7 7 10 10M17 7 7 17" />
            </Icon>
          </button>
        </div>
      </div>
      {settingsOpen && (
        <section
          className="overlay-settings no-drag"
          aria-label="Overlay settings"
        >
          <div className="overlay-settings-heading">
            <strong>Recording settings</strong>
            <span>
              {systemAudioAvailable === false
                ? "No system audio returned"
                : "Ready"}
            </span>
          </div>
          <label>
            Camera
            <select
              value={cameraId}
              onChange={(event) => void changeCamera(event.target.value)}
            >
              <option value="default">Default camera</option>
              {cameras.map((camera) => (
                <option key={camera.deviceId} value={camera.deviceId}>
                  {camera.label || "Camera"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Microphone
            <select
              value={micId}
              onChange={(event) => setMicId(event.target.value)}
            >
              <option value="default">Default microphone</option>
              {audioInputs.map((microphone) => (
                <option key={microphone.deviceId} value={microphone.deviceId}>
                  {microphone.label || "Microphone"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quality
            <select
              value={quality}
              onChange={(event) => setQuality(event.target.value as Quality)}
            >
              {qualityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="overlay-shape-row">
            <span>Recording mode</span>
            <div>
              <button
                className={captureMode === "screen" ? "chosen" : ""}
                onClick={() => selectCaptureMode("screen")}
              >
                Screen
              </button>
              <button
                className={captureMode === "camera" ? "chosen" : ""}
                onClick={() => selectCaptureMode("camera")}
              >
                Camera only
              </button>
            </div>
          </div>
          <div className="overlay-switch-row">
            <span>System audio</span>
            <Toggle
              checked={captureMode === "screen" && systemAudio}
              onChange={setSystemAudio}
              label="System audio"
              disabled={captureMode === "camera"}
            />
          </div>
          <div className="overlay-switch-row">
            <span>Voice isolation</span>
            <Toggle
              checked={voiceIsolation}
              onChange={setVoiceIsolation}
              label="Voice isolation"
            />
          </div>
          <div className="overlay-shape-row">
            <span>Camera shape</span>
            <div>
              <button
                className={shape === "circle" ? "chosen" : ""}
                onClick={() => setShape("circle")}
              >
                Circle
              </button>
              <button
                className={shape === "square" ? "chosen" : ""}
                onClick={() => setShape("square")}
              >
                Square
              </button>
              <button
                className={shape === "rectangle" ? "chosen" : ""}
                onClick={() => setShape("rectangle")}
              >
                Rectangle
              </button>
            </div>
          </div>
          <label className="overlay-size-control">
            Overlay size <b>{overlaySize}px</b>
            <input
              type="range"
              min="160"
              max="520"
              step="10"
              value={overlaySize}
              onChange={(event) => setOverlaySize(Number(event.target.value))}
            />
          </label>
          <p>
            Choose an app or window in the macOS picker for the cleanest
            capture.
          </p>
        </section>
      )}
      <button
        className="overlay-dismiss no-drag"
        onMouseEnter={handleCloseButtonEnter}
        onClick={closeOverlay}
        disabled={recording || finalizing}
        aria-label="Close Capturely overlay"
        title={
          recording ? "Stop recording before closing" : "Close overlay (Esc)"
        }
      >
        <Icon size={15}>
          <path d="m7 7 10 10M17 7 7 17" />
        </Icon>
      </button>
      {notice && (
        <p className={`overlay-notice ${notice.type}`} role="status">
          {notice.message}
        </p>
      )}
      <video ref={screenVideoRef} className="hidden-canvas" muted playsInline />
      <canvas ref={canvasRef} className="hidden-canvas" />
    </main>
  );
}

function RecorderApp() {
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const writeChainRef = useRef(Promise.resolve());
  const sessionRef = useRef<string | null>(null);
  const animationRef = useRef<number | null>(null);
  const meterAnimationRef = useRef<number | null>(null);
  const systemMeterAnimationRef = useRef<number | null>(null);
  const durationRef = useRef(0);
  const dimensionsRef = useRef({ width: 1920, height: 1080 });
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const cameraDragRef = useRef<number | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState("default");
  const [cameraId, setCameraId] = useState("default");
  const [screenReady, setScreenReady] = useState(false);
  const [outputDimensions, setOutputDimensions] = useState({
    width: 1920,
    height: 1080,
  });
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [systemAudioAvailable, setSystemAudioAvailable] = useState<
    boolean | null
  >(null);
  const [voiceIsolation, setVoiceIsolation] = useState(true);
  const [shape, setShape] = useState<CameraShape>("circle");
  const [cameraSize, setCameraSize] = useState(18);
  const [cameraPosition, setCameraPosition] = useState({ x: 75, y: 69 });
  const [quality, setQuality] = useState<Quality>("native");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);
  const [title, setTitle] = useState("Course lesson");
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const [showSetup, setShowSetup] = useState(
    () => localStorage.getItem("capturely-setup-complete") !== "true",
  );
  const [trimEditorId, setTrimEditorId] = useState<string | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState("idle");

  const isDesktop = Boolean(window.capturely);
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  const cameras = devices.filter((device) => device.kind === "videoinput");
  const stopStream = (stream: MediaStream | null) =>
    stream?.getTracks().forEach((track) => track.stop());
  const loadDevices = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setNotice({
        type: "error",
        message: "Your browser could not list recording devices.",
      });
    }
  }, []);
  const loadRecordings = useCallback(async () => {
    if (window.capturely)
      setRecordings(await window.capturely.recordings.list());
  }, []);

  useEffect(() => {
    const startup = window.setTimeout(() => {
      void loadDevices();
      void loadRecordings();
    }, 0);
    navigator.mediaDevices.addEventListener?.("devicechange", loadDevices);
    return () => {
      window.clearTimeout(startup);
      navigator.mediaDevices.removeEventListener?.("devicechange", loadDevices);
      stopStream(screenStreamRef.current);
      stopStream(cameraStreamRef.current);
      stopStream(micStreamRef.current);
      void audioContextRef.current?.close();
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (meterAnimationRef.current)
        cancelAnimationFrame(meterAnimationRef.current);
      if (systemMeterAnimationRef.current)
        cancelAnimationFrame(systemMeterAnimationRef.current);
    };
  }, [loadDevices, loadRecordings]);
  useEffect(
    () =>
      window.capturely?.updates.onStatus(({ status, message }) => {
        setUpdateStatus(status);
        if (status === "ready")
          setNotice({
            type: "success",
            message: "Update ready — restart to install.",
          });
        if (status === "error" && message)
          setNotice({
            type: "info",
            message: "Update check will be available after the signed release.",
          });
      }),
    [],
  );

  const attachVideo = async (
    element: HTMLVideoElement | null,
    stream: MediaStream,
  ) => {
    if (element) {
      element.srcObject = stream;
      await element.play();
    }
  };
  const startCamera = useCallback(
    async (requestedCameraId = cameraId) => {
      stopStream(cameraStreamRef.current);
      const deviceId =
        requestedCameraId === "default"
          ? undefined
          : { exact: requestedCameraId };
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      await attachVideo(cameraVideoRef.current, stream);
      setCameraReady(true);
      await loadDevices();
    },
    [cameraId, loadDevices],
  );
  const chooseDimensions = (sourceWidth: number, sourceHeight: number) => {
    const requested = qualityOptions.find(
      (option) => option.value === quality,
    )!;
    if (!requested.maxWidth || !requested.maxHeight)
      return { width: sourceWidth, height: sourceHeight };
    const scale = Math.min(
      1,
      requested.maxWidth / sourceWidth,
      requested.maxHeight / sourceHeight,
    );
    return {
      width: Math.round(sourceWidth * scale),
      height: Math.round(sourceHeight * scale),
    };
  };

  const drawComposite = useCallback(
    function drawComposite() {
      const canvas = canvasRef.current;
      const screen = screenVideoRef.current;
      if (!canvas || !screen || screen.readyState < 2) {
        animationRef.current = requestAnimationFrame(drawComposite);
        return;
      }
      const context = canvas.getContext("2d")!;
      const { width, height } = dimensionsRef.current;
      context.fillStyle = "#0b1020";
      context.fillRect(0, 0, width, height);
      const screenRatio = screen.videoWidth / screen.videoHeight;
      const outRatio = width / height;
      let renderWidth = width;
      let renderHeight = height;
      let offsetX = 0;
      let offsetY = 0;
      if (screenRatio > outRatio) {
        renderHeight = width / screenRatio;
        offsetY = (height - renderHeight) / 2;
      } else {
        renderWidth = height * screenRatio;
        offsetX = (width - renderWidth) / 2;
      }
      context.drawImage(screen, offsetX, offsetY, renderWidth, renderHeight);
      const camera = cameraVideoRef.current;
      if (cameraOn && camera && camera.readyState >= 2) {
        const overlayWidth = width * (cameraSize / 100);
        const overlayHeight =
          shape === "rectangle" ? overlayWidth * (9 / 16) : overlayWidth;
        const x = clamp(
          (cameraPosition.x / 100) * width,
          0,
          width - overlayWidth,
        );
        const y = clamp(
          (cameraPosition.y / 100) * height,
          0,
          height - overlayHeight,
        );
        context.save();
        context.beginPath();
        if (shape === "circle")
          context.ellipse(
            x + overlayWidth / 2,
            y + overlayHeight / 2,
            overlayWidth / 2,
            overlayHeight / 2,
            0,
            0,
            Math.PI * 2,
          );
        else
          context.roundRect(
            x,
            y,
            overlayWidth,
            overlayHeight,
            overlayWidth * 0.07,
          );
        context.clip();
        context.drawImage(camera, x, y, overlayWidth, overlayHeight);
        context.restore();
        context.strokeStyle = "rgba(255,255,255,.75)";
        context.lineWidth = Math.max(2, width / 960);
        context.beginPath();
        if (shape === "circle")
          context.ellipse(
            x + overlayWidth / 2,
            y + overlayHeight / 2,
            overlayWidth / 2,
            overlayHeight / 2,
            0,
            0,
            Math.PI * 2,
          );
        else
          context.roundRect(
            x,
            y,
            overlayWidth,
            overlayHeight,
            overlayWidth * 0.07,
          );
        context.stroke();
      }
      animationRef.current = requestAnimationFrame(drawComposite);
    },
    [cameraOn, cameraPosition, cameraSize, shape],
  );

  const clearPreview = () => {
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    setScreenReady(false);
    setSystemAudioAvailable(null);
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
  };
  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);
  const startPreview = async () => {
    setNotice(null);
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: systemAudio,
      });
      screenStreamRef.current = display;
      await attachVideo(screenVideoRef.current, display);
      const settings = display.getVideoTracks()[0]?.getSettings();
      const dimensions = chooseDimensions(
        settings.width || 1920,
        settings.height || 1080,
      );
      dimensionsRef.current = dimensions;
      setOutputDimensions(dimensions);
      if (canvasRef.current) {
        canvasRef.current.width = dimensions.width;
        canvasRef.current.height = dimensions.height;
      }
      setSystemAudioAvailable(display.getAudioTracks().length > 0);
      display.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recorderRef.current?.state === "recording") void finishRecording();
        else clearPreview();
      });
      let cameraSkipped = false;
      if (cameraOn) {
        try {
          await startCamera();
        } catch {
          setCameraOn(false);
          setCameraReady(false);
          cameraSkipped = true;
        }
      }
      setScreenReady(true);
      setNotice({
        type: cameraSkipped ? "info" : "success",
        message: cameraSkipped
          ? `${dimensions.width} × ${dimensions.height} source ready. Camera access was skipped.`
          : `${dimensions.width} × ${dimensions.height} source ready.`,
      });
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error && error.name === "NotAllowedError"
            ? "Screen sharing was cancelled or blocked."
            : "Could not start this display source.",
      });
    }
  };

  const mixAudio = async () => {
    const wantsScreenAudio =
      systemAudio && Boolean(screenStreamRef.current?.getAudioTracks().length);
    if (!micOn && !wantsScreenAudio) return new MediaStream();
    const context = new AudioContext();
    audioContextRef.current = context;
    await context.resume();
    const destination = context.createMediaStreamDestination();
    if (wantsScreenAudio && screenStreamRef.current) {
      const source = context.createMediaStreamSource(
        new MediaStream(screenStreamRef.current.getAudioTracks()),
      );
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      source.connect(destination);
      const samples = new Uint8Array(analyser.fftSize);
      const sampleLevel = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const level = (sample - 128) / 128;
          sum += level * level;
        }
        setSystemLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.2));
        systemMeterAnimationRef.current = requestAnimationFrame(sampleLevel);
      };
      sampleLevel();
    }
    if (micOn) {
      const selectedMic = micId === "default" ? undefined : { exact: micId };
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedMic,
          echoCancellation: voiceIsolation,
          noiseSuppression: voiceIsolation,
          autoGainControl: voiceIsolation,
        },
        video: false,
      });
      micStreamRef.current = microphone;
      await loadDevices();
      if (!microphone.getAudioTracks().length) {
        throw new Error(
          "The selected microphone did not provide an audio track.",
        );
      }
      const source = context.createMediaStreamSource(microphone);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const sampleLevel = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const level = (sample - 128) / 128;
          sum += level * level;
        }
        setMicLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.2));
        meterAnimationRef.current = requestAnimationFrame(sampleLevel);
      };
      sampleLevel();
      microphone.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (recorderRef.current?.state === "recording") {
          setNotice({
            type: "error",
            message:
              "Your microphone disconnected. Recording was stopped safely.",
          });
          void finishRecording();
        }
      });
      if (voiceIsolation) {
        const highPass = context.createBiquadFilter();
        highPass.type = "highpass";
        highPass.frequency.value = 90;
        const lowPass = context.createBiquadFilter();
        lowPass.type = "lowpass";
        lowPass.frequency.value = 9000;
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 20;
        compressor.ratio.value = 5;
        source
          .connect(highPass)
          .connect(lowPass)
          .connect(compressor)
          .connect(destination);
      } else source.connect(destination);
    }
    return destination.stream;
  };

  const startRecording = async () => {
    if (!screenReady) {
      await startPreview();
      return;
    }
    setNotice(null);
    try {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Recording canvas was unavailable.");
      const audioStream = await mixAudio();
      const outputStream = canvas.captureStream(30);
      audioStream
        .getAudioTracks()
        .forEach((track) => outputStream.addTrack(track));
      const preferredType =
        [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ].find(MediaRecorder.isTypeSupported) || "";
      const bitrate = qualityOptions.find(
        (option) => option.value === quality,
      )!.bitrate;
      const recorder = new MediaRecorder(
        outputStream,
        preferredType
          ? {
              mimeType: preferredType,
              videoBitsPerSecond: bitrate,
              audioBitsPerSecond: 192_000,
            }
          : { videoBitsPerSecond: bitrate },
      );
      recorderRef.current = recorder;
      const browserChunks: Blob[] = [];
      const session = window.capturely
        ? await window.capturely.recordings.begin({
            mimeType: recorder.mimeType || "video/webm",
          })
        : null;
      sessionRef.current = session?.id || null;
      writeChainRef.current = Promise.resolve();
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        if (sessionRef.current && window.capturely)
          writeChainRef.current = writeChainRef.current.then(async () =>
            window.capturely?.recordings.append({
              id: sessionRef.current!,
              data: await event.data.arrayBuffer(),
            }),
          );
        else browserChunks.push(event.data);
      };
      recorder.onstop = async () => {
        let completed: RecordingItem | null = null;
        try {
          if (animationRef.current) cancelAnimationFrame(animationRef.current);
          if (meterAnimationRef.current)
            cancelAnimationFrame(meterAnimationRef.current);
          if (systemMeterAnimationRef.current)
            cancelAnimationFrame(systemMeterAnimationRef.current);
          meterAnimationRef.current = null;
          systemMeterAnimationRef.current = null;
          setMicLevel(0);
          setSystemLevel(0);
          await writeChainRef.current;
          const duration = durationRef.current;
          if (sessionRef.current && window.capturely) {
            completed = await window.capturely.recordings.finish({
              id: sessionRef.current,
              title,
              duration,
              ...dimensionsRef.current,
            });
            setRecordings((items) => [completed!, ...items]);
          } else {
            const blob = new Blob(browserChunks, {
              type: recorder.mimeType || "video/webm",
            });
            const url = URL.createObjectURL(blob);
            const download = document.createElement("a");
            download.href = url;
            download.download = `Capturely-${Date.now()}.webm`;
            download.click();
            URL.revokeObjectURL(url);
            setNotice({
              type: "success",
              message: "Recording downloaded as WebM.",
            });
          }
          if (completed)
            setNotice({
              type: "success",
              message: "Recording saved to your Movies/Capturely folder.",
            });
        } catch {
          setNotice({
            type: "error",
            message:
              "The recording stopped, but Capturely could not finalize its file.",
          });
        } finally {
          sessionRef.current = null;
          setRecording(false);
          setElapsed(0);
          durationRef.current = 0;
          stopStream(micStreamRef.current);
          micStreamRef.current = null;
          await audioContextRef.current?.close();
          audioContextRef.current = null;
          clearPreview();
          stopStream(cameraStreamRef.current);
          cameraStreamRef.current = null;
          setCameraReady(false);
        }
      };
      recorder.start(4_000);
      durationRef.current = 0;
      setElapsed(0);
      setRecording(true);
      drawComposite();
    } catch (error) {
      stopStream(micStreamRef.current);
      if (meterAnimationRef.current)
        cancelAnimationFrame(meterAnimationRef.current);
      if (systemMeterAnimationRef.current)
        cancelAnimationFrame(systemMeterAnimationRef.current);
      meterAnimationRef.current = null;
      systemMeterAnimationRef.current = null;
      setMicLevel(0);
      setSystemLevel(0);
      await audioContextRef.current?.close();
      audioContextRef.current = null;
      setNotice({
        type: "error",
        message:
          error instanceof Error ? error.message : "Recording could not start.",
      });
    }
  };

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      durationRef.current += 1;
      setElapsed(durationRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(
    () =>
      window.capturely?.recording.onToggle(() => {
        document.querySelector<HTMLButtonElement>(".record-button")?.click();
      }),
    [],
  );
  const toggleCameraPreview = async () => {
    if (cameraOn) {
      setCameraOn(false);
      setCameraReady(false);
      stopStream(cameraStreamRef.current);
      cameraStreamRef.current = null;
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    } else {
      try {
        await startCamera();
        setCameraOn(true);
      } catch {
        setNotice({
          type: "error",
          message: "Camera permission was not granted.",
        });
      }
    }
  };
  const dragCamera = (event: PointerEvent<HTMLDivElement>) => {
    if (cameraDragRef.current !== event.pointerId) return;
    const stage = event.currentTarget.parentElement;
    if (!stage || recording) return;
    const box = stage.getBoundingClientRect();
    setCameraPosition({
      x: clamp(
        ((event.clientX - box.left) / box.width) * 100 -
          dragOffsetRef.current.x,
        0,
        100 - cameraSize,
      ),
      y: clamp(
        ((event.clientY - box.top) / box.height) * 100 -
          dragOffsetRef.current.y,
        0,
        100 - (shape === "rectangle" ? cameraSize * (9 / 16) : cameraSize),
      ),
    });
  };
  const share = async (item: RecordingItem) => {
    if (!window.capturely) {
      setNotice({
        type: "info",
        message: "Open the desktop app to create a local-network share link.",
      });
      return;
    }
    const link = await window.capturely.recordings.shareLink(item.id);
    setNotice({ type: "success", message: `Share link copied: ${link}` });
  };
  const dismissSetup = () => {
    localStorage.setItem("capturely-setup-complete", "true");
    setShowSetup(false);
  };
  const exportMp4 = async (item: RecordingItem) => {
    if (!window.capturely) return;
    const start = clamp(trimStart, 0, item.duration);
    const end = clamp(trimEnd || item.duration, start + 0.1, item.duration);
    setExportingId(item.id);
    try {
      const exported = await window.capturely.recordings.exportMp4({
        id: item.id,
        start,
        end,
      });
      setRecordings((items) => [exported, ...items]);
      setTrimEditorId(null);
      setNotice({
        type: "success",
        message: "Trimmed MP4 saved to Movies/Capturely.",
      });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "MP4 export failed.",
      });
    } finally {
      setExportingId(null);
    }
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <Logo />
        <nav>
          <button className="active">Recorder</button>
          <button>
            Library <span>{recordings.length}</span>
          </button>
        </nav>
        <div className="header-actions">
          {isDesktop && (
            <button
              className="update-button"
              onClick={() => {
                if (updateStatus === "ready") {
                  void window.capturely?.updates.install();
                  return;
                }
                setUpdateStatus("checking");
                void window.capturely?.updates.check();
              }}
            >
              {updateStatus === "ready"
                ? "Restart to update"
                : updateStatus === "checking" || updateStatus === "downloading"
                  ? "Checking updates…"
                  : "Check for updates"}
            </button>
          )}
          <span className="desktop-status">
            <i /> {isDesktop ? "Desktop app" : "Browser mode"}
          </span>
          <button className="help-button" aria-label="Help">
            <Icon>
              <circle cx="12" cy="12" r="9" />
              <path d="M9.5 9a2.7 2.7 0 1 1 4.34 2.15c-.9.7-1.84 1.2-1.84 2.85" />
              <path d="M12 17h.01" />
            </Icon>
          </button>
        </div>
      </header>
      {showSetup && (
        <section className="setup-guide" aria-label="Quick setup">
          <div>
            <strong>Ready in three steps</strong>
            <span>
              1. Allow Camera & Microphone. 2. Choose Screen. 3. Press Record.
            </span>
          </div>
          <kbd>⌘ ⇧ R</kbd>
          <span className="setup-shortcut">Record / stop from anywhere</span>
          <button onClick={dismissSetup}>Got it</button>
        </section>
      )}
      <section className="workspace">
        <div className="capture-area">
          <div className="source-tabs">
            <button className="source-active">
              <Icon>
                <rect x="3" y="5" width="18" height="13" rx="2" />
                <path d="M8 21h8M12 18v3" />
              </Icon>
              Screen
            </button>
            <button onClick={toggleCameraPreview}>
              <Icon>
                <rect x="3" y="6" width="13" height="12" rx="2" />
                <path d="m16 10 5-3v10l-5-3" />
              </Icon>
              Camera
            </button>
            <span className="source-divider" />
            <span className="capture-resolution">
              {screenReady
                ? `${outputDimensions.width} × ${outputDimensions.height}`
                : "No source selected"}
            </span>
          </div>
          <div className="stage">
            <video
              className={`screen-preview ${screenReady ? "ready" : ""}`}
              ref={screenVideoRef}
              muted
              playsInline
            />
            {!screenReady && (
              <div className="empty-stage">
                <div className="empty-icon">
                  <Icon size={25}>
                    <rect x="3" y="5" width="18" height="13" rx="2" />
                    <path d="M8 21h8M12 18v3" />
                  </Icon>
                </div>
                <h1>Get your screen ready</h1>
                <p>Select the window, tab, or display you want to capture.</p>
                <button className="select-screen" onClick={startPreview}>
                  Choose screen
                </button>
              </div>
            )}
            {cameraOn && (
              <div
                className={`camera-overlay ${shape}`}
                style={{
                  left: `${cameraPosition.x}%`,
                  top: `${cameraPosition.y}%`,
                  width: `${cameraSize}%`,
                }}
                onPointerDown={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  dragOffsetRef.current = {
                    x:
                      ((event.clientX - bounds.left) /
                        event.currentTarget.parentElement!.getBoundingClientRect()
                          .width) *
                      100,
                    y:
                      ((event.clientY - bounds.top) /
                        event.currentTarget.parentElement!.getBoundingClientRect()
                          .height) *
                      100,
                  };
                  cameraDragRef.current = event.pointerId;
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={dragCamera}
                onPointerUp={(event) => {
                  if (cameraDragRef.current !== event.pointerId) return;
                  cameraDragRef.current = null;
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                }}
                onPointerCancel={(event) => {
                  if (cameraDragRef.current !== event.pointerId) return;
                  cameraDragRef.current = null;
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                }}
              >
                <video ref={cameraVideoRef} muted playsInline autoPlay />
                {!cameraReady && (
                  <div className="camera-placeholder">
                    <Icon>
                      <circle cx="12" cy="8" r="3" />
                      <path d="M5 20a7 7 0 0 1 14 0" />
                    </Icon>
                  </div>
                )}
                <span className="move-hint">Drag</span>
              </div>
            )}
            {recording && (
              <div className="recording-chip">
                <span />
                REC {formatTime(elapsed)}
              </div>
            )}
          </div>
          <div className="quick-controls">
            <label className="device-control">
              <span>
                <Icon size={16}>
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
                </Icon>
                Microphone
              </span>
              <select
                value={micId}
                onChange={(event) => setMicId(event.target.value)}
                disabled={recording || !micOn}
              >
                <option value="default">Default microphone</option>
                {audioInputs.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
              <span className="audio-meter" title="Live microphone level">
                <i
                  style={{
                    transform: `scaleX(${micOn ? Math.max(0.03, micLevel) : 0})`,
                  }}
                />
              </span>
            </label>
            <label className="device-control camera-control">
              <span>
                <Icon size={16}>
                  <rect x="3" y="6" width="13" height="12" rx="2" />
                  <path d="m16 10 5-3v10l-5-3" />
                </Icon>
                Camera
              </span>
              <select
                value={cameraId}
                onChange={async (event) => {
                  const nextCameraId = event.target.value;
                  setCameraId(nextCameraId);
                  if (cameraOn && !recording) {
                    try {
                      await startCamera(nextCameraId);
                    } catch {
                      setNotice({
                        type: "error",
                        message: "The selected camera could not be started.",
                      });
                    }
                  }
                }}
                disabled={recording || !cameraOn}
              >
                <option value="default">Default camera</option>
                {cameras.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <div className="quick-toggle">
              <span>
                <Icon size={16}>
                  <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
                </Icon>
                System audio
              </span>
              <Toggle
                checked={systemAudio}
                onChange={setSystemAudio}
                label="Capture system audio"
                disabled={recording}
              />
              <span
                className="audio-meter compact"
                title="Live system-audio level"
              >
                <i
                  style={{
                    transform: `scaleX(${systemAudio ? Math.max(0.03, systemLevel) : 0})`,
                  }}
                />
              </span>
            </div>
            <div className="quick-toggle">
              <span>
                <Icon size={16}>
                  <path d="M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0" />
                  <path d="M9 12.5 11 15l4-6" />
                </Icon>
                Voice isolation
              </span>
              <Toggle
                checked={voiceIsolation}
                onChange={setVoiceIsolation}
                label="Enable voice isolation"
                disabled={recording || !micOn}
              />
            </div>
          </div>
        </div>
        <aside className="record-panel">
          <div className="panel-heading">
            <div>
              <h2>Record</h2>
              <p>Set up your capture.</p>
            </div>
            <span className="privacy-lock">
              <Icon size={14}>
                <rect x="5" y="10" width="14" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </Icon>
              Private
            </span>
          </div>
          <div className="panel-section">
            <label className="field-label">
              Recording title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={80}
                disabled={recording}
              />
            </label>
          </div>
          <div className="panel-section">
            <div className="control-line">
              <div>
                <strong>Microphone in recording</strong>
                <small>Use your selected mic, or record without one.</small>
              </div>
              <Toggle
                checked={micOn}
                onChange={setMicOn}
                label="Include microphone"
                disabled={recording}
              />
            </div>
          </div>
          <div className="panel-section">
            <div className="control-line">
              <div>
                <strong>Camera in recording</strong>
                <small>Drag it anywhere in preview.</small>
              </div>
              <Toggle
                checked={cameraOn}
                onChange={toggleCameraPreview}
                label="Include camera"
                disabled={recording}
              />
            </div>
            <div className="segment-row">
              <button
                className={shape === "circle" ? "selected" : ""}
                onClick={() => setShape("circle")}
                disabled={recording}
              >
                <Icon size={16}>
                  <circle cx="12" cy="12" r="6" />
                </Icon>
                Circle
              </button>
              <button
                className={shape === "square" ? "selected" : ""}
                onClick={() => setShape("square")}
                disabled={recording}
              >
                <Icon size={16}>
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </Icon>
                Square
              </button>
              <button
                className={shape === "rectangle" ? "selected" : ""}
                onClick={() => setShape("rectangle")}
                disabled={recording}
              >
                <Icon size={16}>
                  <rect x="4" y="7" width="16" height="10" rx="2" />
                </Icon>
                Rectangle
              </button>
            </div>
            <label className="range-label">
              Camera size <b>{cameraSize}%</b>
              <input
                type="range"
                min="10"
                max="32"
                value={cameraSize}
                onChange={(event) => setCameraSize(Number(event.target.value))}
                disabled={recording || !cameraOn}
              />
            </label>
          </div>
          <div className="panel-section">
            <div className="control-line">
              <div>
                <strong>Desktop camera overlay</strong>
                <small>
                  Movable always-on-top camera and recording controls.
                </small>
              </div>
              <button
                className="launch-overlay"
                onClick={() =>
                  isDesktop
                    ? window.capturely?.window.openOverlay(cameraId)
                    : setNotice({
                        type: "info",
                        message:
                          "The desktop overlay is available in the packaged app.",
                      })
                }
              >
                <Icon size={16}>
                  <path d="M4 4h16v16H4z" />
                  <path d="M8 8h8v8H8z" />
                </Icon>
                Open overlay
              </button>
            </div>
          </div>
          <div className="panel-section">
            <label className="field-label">
              Output resolution
              <select
                value={quality}
                onChange={(event) => setQuality(event.target.value as Quality)}
                disabled={recording}
              >
                {qualityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-help">
              Native preserves the selected display’s true detail. Lower choices
              export a real downscaled file; 4K needs a 4K source.
            </p>
          </div>
          <div className="audio-summary">
            <Icon size={16}>
              <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
            </Icon>
            <span>
              {systemAudioAvailable === false && systemAudio
                ? "The selected source did not provide system audio."
                : systemAudio && micOn
                  ? "System audio and mic will be mixed as separate capture sources."
                  : systemAudio
                    ? "Only system audio will be captured."
                    : micOn
                      ? "Only microphone audio will be captured."
                      : "This will be a silent video recording."}
            </span>
          </div>
          <button
            className={`record-button ${recording ? "stop" : ""}`}
            onClick={recording ? finishRecording : startRecording}
          >
            {recording ? (
              <>
                <span className="stop-square" />
                Stop recording <em>{formatTime(elapsed)}</em>
              </>
            ) : (
              <>
                <span className="record-dot" />
                {screenReady ? "Start recording" : "Choose screen to record"}
              </>
            )}
          </button>
          <div className="shortcut-hint">
            <kbd>⌘ ⇧ R</kbd> Start or stop recording from anywhere
          </div>
        </aside>
      </section>
      {notice && (
        <div className={`notice ${notice.type}`} role="status">
          <span>
            {notice.type === "error"
              ? "!"
              : notice.type === "success"
                ? "✓"
                : "i"}
          </span>
          {notice.message}
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}
      <section className="library">
        <div className="library-title">
          <div>
            <h2>Recent recordings</h2>
            <p>
              Your files remain private on this device until you share a local
              link.
            </p>
          </div>
          <button onClick={loadRecordings}>
            <Icon size={16}>
              <path d="M20 11a8 8 0 1 0 2 5" />
              <path d="M20 4v7h-7" />
            </Icon>
            Refresh
          </button>
        </div>
        {recordings.length ? (
          <div className="recording-list">
            {recordings.slice(0, 4).map((item) => (
              <article key={item.id} className="recording-row">
                <div className="recording-thumb">
                  <Icon size={22}>
                    <path d="M8 5v14l11-7z" />
                  </Icon>
                </div>
                <div className="recording-info">
                  <h3>{item.title}</h3>
                  <p>
                    {dateText(item.createdAt)} · {formatTime(item.duration)} ·{" "}
                    {item.width} × {item.height} · {formatBytes(item.bytes)}
                  </p>
                </div>
                <button
                  onClick={() =>
                    window.capturely?.recordings.openFolder(item.id)
                  }
                  title="Show video in Finder"
                >
                  <Icon size={18}>
                    <path d="M3 6h7l2 2h9v10H3z" />
                  </Icon>
                </button>
                <button className="share-button" onClick={() => share(item)}>
                  <Icon size={16}>
                    <path d="M12 3v12M8 7l4-4 4 4M5 14v5h14v-5" />
                  </Icon>
                  Copy share link
                </button>
                <button
                  className="mp4-button"
                  disabled={!isDesktop || exportingId === item.id}
                  onClick={() => {
                    setTrimEditorId((current) =>
                      current === item.id ? null : item.id,
                    );
                    setTrimStart(0);
                    setTrimEnd(item.duration);
                  }}
                >
                  {exportingId === item.id ? "Exporting…" : "Trim & MP4"}
                </button>
                {trimEditorId === item.id && (
                  <div className="trim-editor">
                    <label>
                      Start{" "}
                      <input
                        type="number"
                        min="0"
                        max={item.duration}
                        step="0.1"
                        value={trimStart}
                        onChange={(event) =>
                          setTrimStart(Number(event.target.value))
                        }
                      />
                    </label>
                    <label>
                      End{" "}
                      <input
                        type="number"
                        min="0.1"
                        max={item.duration}
                        step="0.1"
                        value={trimEnd}
                        onChange={(event) =>
                          setTrimEnd(Number(event.target.value))
                        }
                      />
                    </label>
                    <button onClick={() => void exportMp4(item)}>
                      Export MP4
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-library">
            <Icon size={20}>
              <path d="M8 5v14l11-7z" />
            </Icon>
            <span>Your finished recordings will appear here.</span>
          </div>
        )}
      </section>
      <canvas ref={canvasRef} className="hidden-canvas" />
    </main>
  );
}

function App() {
  return new URLSearchParams(window.location.search).has("overlay") ? (
    <DesktopOverlay />
  ) : (
    <RecorderApp />
  );
}

export default App;
