import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { PickerPayload } from '../main/picker';
import type { DesktopMedia, MediaClosedEvent, MediaConnectInput, MediaSessionInput } from '../shared/media';
import type { VoiceTrayState } from '../shared/voice-state';

type PcmCallback = (chunk: Uint8Array, firstSample?: number) => void;
const pcmListeners = new Set<PcmCallback>();

ipcRenderer.on('voice:shortcut', (_event, code: unknown) => {
  if (code !== 'KeyM' && code !== 'KeyD') return;
  window.dispatchEvent(new KeyboardEvent('keydown', {
    code,
    key: code.slice(3),
    ctrlKey: true,
    shiftKey: true,
    repeat: false,
    cancelable: true
  }));
});

ipcRenderer.on('pcm', (_event, chunk: Uint8Array, sessionId?: number, sequence?: number, firstSample?: number) => {
  try {
    if (session !== null ? sessionId !== session : typeof sessionId === 'number') return;
    if (pcmListeners.size === 0) return;
    const bytes = new Uint8Array(chunk);
    for (const callback of pcmListeners) callback(bytes, firstSample);
  } finally {
    if (typeof sessionId === 'number' && typeof sequence === 'number') ipcRenderer.send('pcm:ack', sessionId, sequence);
  }
});

let holders = 0;
let acquiring: Promise<number | null> | null = null;
let session: number | null = null;
let sessionEnded = false;
let endedThrough = 0;
const endedListeners = new Set<() => void>();

const notifyEnded = (): void => {
  for (const listener of endedListeners) listener();
};

ipcRenderer.on('capture:ended', ((_event: unknown, sessionId?: number) => {
  if (typeof sessionId !== 'number') {
    notifyEnded();
    return;
  }
  if (sessionId <= endedThrough) return;
  endedThrough = sessionId;
  if (sessionId !== session) return;
  sessionEnded = true;
  notifyEnded();
}) as never);

const bridge = {
  setVoiceState: (state: VoiceTrayState): Promise<void> => ipcRenderer.invoke('voice:state', state),
  media: {
    version: 1,
    create: (input: MediaSessionInput) => ipcRenderer.invoke('media:create', input),
    connect: (input: MediaConnectInput) => ipcRenderer.invoke('media:connect', input),
    close: (input: MediaSessionInput) => ipcRenderer.invoke('media:close', input),
    onClosed: (callback: (event: MediaClosedEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        if (!payload || typeof payload !== 'object' || !('sessionId' in payload) ||
            typeof payload.sessionId !== 'string') return;
        callback({ sessionId: payload.sessionId });
      };
      ipcRenderer.on('media:closed', handler);
      return () => { ipcRenderer.off('media:closed', handler); };
    }
  } satisfies DesktopMedia,
  /** The page picks its capture strategy from this. */
  platform: process.platform,
  /** 'pipewire' | 'windows' | 'none' — whether the app captures share audio itself (from main). */
  captureSource: (process.argv.find((arg) => arg.startsWith('--dodecagon-capture=')) ?? '--dodecagon-capture=none').split('=')[1],
  forceSystemAudio: process.env.DODECAGON_WINDOWS_AUDIO === 'on',
  /** Version/platform for the badge the page shows in its corner. */
  appInfo: (): Promise<{ version: string; platform: string }> => ipcRenderer.invoke('app:info'),
  /** The page reports which capture strategy it installed; it lands in the log. */
  reportCaptureMode: (info: {
    mode: string;
    echoTest?: string;
    ownAudioSupported?: boolean;
    ownAudioApplied?: boolean;
  }): Promise<boolean> => ipcRenderer.invoke('capture:mode', info),
  /** Used by the built-in server picker; harmless on the client page. */
  currentServer: (): Promise<string | null> => ipcRenderer.invoke('server:current'),
  submitServer: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('server:submit', url),
  /** Used by the built-in picker window. */
  pickerSources: (): Promise<unknown> => ipcRenderer.invoke('picker:sources'),
  pickerChoose: (id: string | null): Promise<boolean> => ipcRenderer.invoke('picker:choose', id),
  onPickerRefresh: (callback: (payload: PickerPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: PickerPayload) => callback(payload);
    ipcRenderer.on('picker:refresh', handler as never);
    return () => {
      ipcRenderer.off('picker:refresh', handler as never);
    };
  },
  acquireCapture: async (): Promise<void> => {
    if (holders === 0) {
      acquiring ??= ipcRenderer
        .invoke('capture:acquire')
        .then((sessionId: unknown): number | null => {
          if (typeof sessionId === 'number' && sessionId <= endedThrough) {
            throw new Error('capture ended while it was being acquired');
          }
          return typeof sessionId === 'number' ? sessionId : null;
        })
        .finally(() => {
          acquiring = null;
        });
      try {
        session = await acquiring;
        sessionEnded = false;
      } catch (error) {
        session = null;
        sessionEnded = false;
        throw error;
      }
    }
    holders += 1;
  },
  releaseCapture: async (): Promise<void> => {
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    const releasing = session;
    session = null;
    sessionEnded = false;
    await ipcRenderer.invoke('capture:release', releasing ?? undefined);
  },
  onPcm: (callback: PcmCallback): (() => void) => {
    pcmListeners.add(callback);
    return () => { pcmListeners.delete(callback); };
  },
  onCaptureEnded: (callback: () => void): (() => void) => {
    endedListeners.add(callback);
    if (session !== null && sessionEnded) callback();
    return () => {
      endedListeners.delete(callback);
    };
  }
};

contextBridge.exposeInMainWorld('dodecagonDesktop', bridge);
console.log('[dodecagon-desktop] preload ready, bridge exposed');

void (async () => {
  try {
    const source = (await ipcRenderer.invoke('patch:source')) as string;
    await webFrame.executeJavaScript(source);
  } catch (error) {
    console.error('[dodecagon-desktop] failed to inject the display-media patch', error);
  }
})();
