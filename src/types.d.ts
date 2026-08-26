export {};

declare global {
  interface Window {
    capturely?: {
      recordings: {
        list: () => Promise<RecordingItem[]>;
        begin: (details: {
          mimeType: string;
        }) => Promise<{ id: string; fileName: string }>;
        append: (details: { id: string; data: ArrayBuffer }) => Promise<void>;
        finish: (details: {
          id: string;
          title: string;
          duration: number;
          width: number;
          height: number;
        }) => Promise<RecordingItem>;
        openFolder: (id: string) => Promise<void>;
        shareLink: (id: string) => Promise<string>;
        exportMp4: (details: {
          id: string;
          start: number;
          end: number;
        }) => Promise<RecordingItem>;
      };
      recording: {
        onToggle: (callback: () => void) => () => void;
      };
      updates: {
        check: () => Promise<{ status: string }>;
        install: () => Promise<void>;
        onStatus: (
          callback: (update: { status: string; message?: string }) => void,
        ) => () => void;
      };
      window: {
        openOverlay: (cameraId?: string) => Promise<void>;
        closeOverlay: () => Promise<void>;
        hideOverlay: () => Promise<void>;
        showOverlay: () => Promise<void>;
        setCameraOnlyFullscreen: (fullscreen: boolean) => Promise<{
          fullscreen: boolean;
        }>;
        showMain: () => Promise<void>;
        setOverlayInteractive: (interactive: boolean) => Promise<void>;
        moveOverlayBy: (deltaX: number, deltaY: number) => Promise<void>;
        resizeOverlay: (
          size: number,
          shape: "circle" | "square" | "rectangle",
          settingsOpen?: boolean,
          fullscreen?: boolean,
        ) => Promise<void>;
      };
    };
  }

  interface RecordingItem {
    id: string;
    fileName: string;
    path: string;
    title: string;
    duration: number;
    width: number;
    height: number;
    bytes: number;
    createdAt: string;
  }
}
