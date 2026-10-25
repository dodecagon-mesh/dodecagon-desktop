import { nativeImage, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type NativeImage, type Tray } from 'electron';
import { isServerOrigin } from './server-config';
import type { VoiceTrayState } from '../shared/voice-state';

export type VoiceTrayStatus = 'idle' | 'connected' | 'microphone-muted' | 'deafened';

export const voiceTrayStatus = (state: VoiceTrayState): VoiceTrayStatus => {
  if (!state.connected) return 'idle';
  if (state.soundMuted) return 'deafened';
  return state.micMuted ? 'microphone-muted' : 'connected';
};

const labels: Record<VoiceTrayStatus, string> = {
  idle: 'Dodecagon',
  connected: 'Dodecagon · Voice connected',
  'microphone-muted': 'Dodecagon · Microphone muted',
  deafened: 'Dodecagon · Sound muted'
};

type Point = readonly [number, number];
type Stroke = readonly Point[];
const microphone: readonly Stroke[] = [
  [[26, 12], [28, 9], [32, 8], [36, 9], [38, 12], [38, 28], [36, 32], [32, 34], [28, 32], [26, 28], [26, 12]],
  [[20, 25], [20, 30], [23, 37], [27, 40], [32, 41], [37, 40], [41, 37], [44, 30], [44, 25]],
  [[32, 41], [32, 53]],
  [[24, 53], [40, 53]]
];
const headphones: readonly Stroke[] = [
  [[12, 38], [12, 28], [14, 20], [19, 14], [25, 10], [32, 9], [39, 10], [45, 14], [50, 20], [52, 28], [52, 38]],
  [[12, 34], [17, 34], [20, 37], [20, 48], [17, 51], [12, 51], [10, 48], [10, 37], [12, 34]],
  [[52, 34], [47, 34], [44, 37], [44, 48], [47, 51], [52, 51], [54, 48], [54, 37], [52, 34]]
];
const slash: Stroke = [[10, 10], [54, 54]];

const distanceToStroke = (x: number, y: number, stroke: Stroke): number => {
  let closest = Infinity;
  for (let i = 1; i < stroke.length; i += 1) {
    const a = stroke[i - 1]!;
    const b = stroke[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    closest = Math.min(closest, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
  }
  return closest;
};

const samples = [0.25, 0.75];
// cached bitmap icons avoid unsupported SVG decoding and stay legible on either tray surface.
const createMutedIcon = (deafened: boolean): NativeImage => {
  const size = 64;
  const pixels = Buffer.alloc(size * size * 4);
  const strokes = deafened ? headphones : microphone;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let outer = 0;
      let inner = 0;
      for (const ox of samples) {
        for (const oy of samples) {
          const slashDistance = distanceToStroke(x + ox, y + oy, slash);
          let distance = Infinity;
          for (const stroke of strokes) distance = Math.min(distance, distanceToStroke(x + ox, y + oy, stroke));
          if (distance <= 3.5 || slashDistance <= 4.5) outer += 1;
          if (slashDistance <= 2.5 || (slashDistance > 4.5 && distance <= 2)) inner += 1;
        }
      }
      const offset = (y * size + x) * 4;
      const alpha = Math.round((process.platform === 'darwin' ? inner : outer) * 255 / 4);
      const white = process.platform === 'darwin' ? 0 : Math.round(inner * 255 / 4);
      pixels[offset] = white;
      pixels[offset + 1] = white;
      pixels[offset + 2] = white;
      pixels[offset + 3] = alpha;
    }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
};

export class VoiceTray {
  private status: VoiceTrayStatus = 'idle';
  private microphoneIcon?: NativeImage;
  private headphonesIcon?: NativeImage;

  constructor(private readonly tray: Tray, private readonly defaultIcon: NativeImage) {}

  update = (state: VoiceTrayState): void => {
    const status = voiceTrayStatus(state);
    if (status === this.status) return;
    this.status = status;
    if (this.tray.isDestroyed()) return;
    let icon = this.defaultIcon;
    if (status === 'deafened') icon = this.headphonesIcon ??= createMutedIcon(true);
    else if (status === 'microphone-muted') icon = this.microphoneIcon ??= createMutedIcon(false);
    this.tray.setImage(icon);
    this.tray.setToolTip(labels[status]);
  };

  reset = (): void => this.update({ connected: false, micMuted: false, soundMuted: false });
}

export const registerVoiceTrayIpc = (
  ipc: Pick<IpcMain, 'handle'>,
  mainWindow: () => BrowserWindow | null,
  allowedOrigin: () => string,
  update: (state: VoiceTrayState) => void
): void => {
  ipc.handle('voice:state', (event: IpcMainInvokeEvent, input: unknown) => {
    const window = mainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed() ||
        event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame || !isServerOrigin(event.senderFrame.url, allowedOrigin())) {
      throw new Error('voice state is only available to the main client document');
    }
    if (!input || typeof input !== 'object' || !('connected' in input) || typeof input.connected !== 'boolean' ||
        !('micMuted' in input) || typeof input.micMuted !== 'boolean' ||
        !('soundMuted' in input) || typeof input.soundMuted !== 'boolean') {
      throw new Error('invalid voice tray state');
    }
    update({ connected: input.connected, micMuted: input.micMuted, soundMuted: input.soundMuted });
  });
};
