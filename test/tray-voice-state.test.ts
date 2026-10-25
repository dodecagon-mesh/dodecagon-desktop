import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerVoiceTrayIpc, voiceTrayStatus } from '../src/main/tray-voice-state';

vi.mock('electron', () => ({ nativeImage: {} }));

describe('voice tray status', () => {
  it('gives deafening priority over microphone mute and clears stale mute flags after leaving', () => {
    expect(voiceTrayStatus({ connected: true, micMuted: false, soundMuted: false })).toBe('connected');
    expect(voiceTrayStatus({ connected: true, micMuted: true, soundMuted: false })).toBe('microphone-muted');
    expect(voiceTrayStatus({ connected: true, micMuted: true, soundMuted: true })).toBe('deafened');
    expect(voiceTrayStatus({ connected: true, micMuted: false, soundMuted: true })).toBe('deafened');
    expect(voiceTrayStatus({ connected: false, micMuted: true, soundMuted: true })).toBe('idle');
  });
});

const setup = () => {
  const frame = { url: 'https://voice.example.test/channel/2' };
  const contents = { mainFrame: frame, isDestroyed: () => false, isCrashed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  let handler!: (event: IpcMainInvokeEvent, input: unknown) => void;
  const ipc = { handle: (_name: string, callback: typeof handler) => { handler = callback; } };
  const update = vi.fn();
  registerVoiceTrayIpc(ipc as unknown as IpcMain, () => window as unknown as BrowserWindow, () => 'https://voice.example.test', update);
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { handler, event, update, frame, contents };
};

const muted = { connected: true, micMuted: true, soundMuted: false };

describe('voice tray IPC authorization', () => {
  it('rejects a foreign window, subframe, and navigated main document', () => {
    const fixture = setup();
    expect(() => fixture.handler({ ...fixture.event, sender: {} } as IpcMainInvokeEvent, muted)).toThrow('main client');
    expect(() => fixture.handler({ ...fixture.event, senderFrame: { url: fixture.frame.url } } as IpcMainInvokeEvent, muted)).toThrow('main client');
    fixture.frame.url = 'https://attacker.example.test';
    expect(() => fixture.handler(fixture.event, muted)).toThrow('main client');
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...muted, connected: 1 }, { ...muted, micMuted: 'true' }, { ...muted, soundMuted: null }])('rejects malformed state %j', (input) => {
    const fixture = setup();
    expect(() => fixture.handler(fixture.event, input)).toThrow('invalid voice tray state');
    expect(fixture.update).not.toHaveBeenCalled();
  });
});
