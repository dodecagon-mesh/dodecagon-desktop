import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';

type MockStream = EventEmitter & {
  remotePublicKey: Buffer | null;
  connected: boolean;
  trySend: Mock;
  write: Mock;
  pause: Mock;
  destroy: Mock;
  setTimeout: Mock;
  setKeepAlive: Mock;
};
type MockServer = EventEmitter & {
  options: { firewall(key: Buffer): boolean; reusableSocket: boolean };
  listen: Mock;
  close: Mock;
};
type MockNode = EventEmitter & {
  servers: MockServer[];
  stream: MockStream;
  connect: Mock;
  destroy: Mock;
};
type MockSocket = EventEmitter & {
  bind: Mock;
  address: () => { port: number; address: string; family: string };
  send: Mock;
  close: Mock;
};
const native = vi.hoisted(() => ({
  nodes: [] as MockNode[],
  sockets: [] as MockSocket[],
  listen: null as null | (() => Promise<void>)
}));

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    eth0: [{
      address: '192.168.0.102', family: 'IPv4', netmask: '255.255.255.0',
      mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.0.102/24'
    }],
    wlan0: [{
      address: '10.2.3.4', family: 'IPv4', netmask: '255.255.255.0',
      mac: '00:00:00:00:00:02', internal: false, cidr: '10.2.3.4/24'
    }],
    absent: undefined
  } satisfies Record<string, NetworkInterfaceInfo[] | undefined>)
}));

vi.mock('hyperdht', async () => {
  // Vitest hoists factories before static imports; load this dependency inside the factory.
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static keyPair() { return { publicKey: Buffer.alloc(32, 1), secretKey: Buffer.alloc(64, 2) }; }
    servers: MockServer[] = [];
    stream!: MockStream;
    destroy = vi.fn(async () => {});
    constructor() { super(); native.nodes.push(this); }
    createServer(options: MockServer['options']) {
      const server = Object.assign(new EventEmitter(), {
        options,
        listen: vi.fn(() => native.listen?.() ?? Promise.resolve()),
        close: vi.fn(async () => {})
      });
      this.servers.push(server);
      return server;
    }
    connect = vi.fn((key: Buffer) => {
      const stream = Object.assign(new EventEmitter(), {
        remotePublicKey: key,
        connected: false,
        trySend: vi.fn(),
        write: vi.fn((_header: Buffer, callback?: (error?: Error | null) => void) => {
          callback?.(null);
          return true;
        }),
        pause: vi.fn(),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
        setKeepAlive: vi.fn()
      });
      this.stream = stream;
      return stream;
    });
  } };
});

vi.mock('node:dgram', () => ({
  createSocket: () => {
    const socket = Object.assign(new EventEmitter(), {
      bind: vi.fn(() => { void Promise.resolve().then(() => socket.emit('listening')); }),
      address: () => ({ port: 12345 + native.sockets.length - 1, address: '127.0.0.1', family: 'IPv4' }),
      send: vi.fn((_packet: Buffer, _port: number, _address: string, callback: (error: Error | null) => void) => callback(null)),
      close: vi.fn((callback?: () => void) => callback?.())
    });
    native.sockets.push(socket);
    return socket;
  }
}));

import { HolepunchMedia, registerHolepunchMediaIpc } from '../src/main/holepunch-media';

const sessionId = '01020304-1234-4123-8123-010203040506';
const secondSessionId = 'ffffffff-1234-4123-8123-010203040506';
const remotePublicKey = '03'.repeat(32);
const stun = () => {
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(1, 0);
  packet.writeUInt32BE(0x2112a442, 4);
  return packet;
};
const header = (id = sessionId) => Buffer.from(id.replace(/-/g, ''), 'hex');
const incoming = (key = Buffer.alloc(32, 3)): MockStream =>
  Object.assign(new EventEmitter(), {
    remotePublicKey: key, connected: true, trySend: vi.fn(), write: vi.fn(),
    pause: vi.fn(), destroy: vi.fn(), setTimeout: vi.fn(), setKeepAlive: vi.fn()
  });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

let media: HolepunchMedia;
let closed: Mock;
beforeEach(() => {
  vi.useFakeTimers(); native.nodes.length = 0; native.sockets.length = 0; native.listen = null;
  closed = vi.fn(); media = new HolepunchMedia(closed);
});
afterEach(async () => { await media.closeAll(); vi.useRealTimers(); });

describe('native Holepunch media', () => {
  it('validates ids and keys, bounds sessions and forbids duplicate sessions', async () => {
    await expect(media.create({ sessionId: '../../x' })).rejects.toThrow();
    await expect(media.create({ sessionId })).resolves.toEqual({ publicKey: '01'.repeat(32), port: 12345 });
    await expect(media.create({ sessionId })).rejects.toThrow();
    await expect(media.connect({ sessionId, remotePublicKey: 'bad', initiator: false })).rejects.toThrow();
    await expect(media.connect({ sessionId, remotePublicKey, initiator: 'yes' })).rejects.toThrow();
    for (let i = 1; i < 128; i++) {
      await media.create({ sessionId: `${i.toString(16).padStart(8, '0')}-1234-4123-8123-010203040506` });
    }
    await expect(media.create({ sessionId: 'ffffffff-1234-4123-8123-010203040506' })).rejects.toThrow();
  });

  it('warms one server and announces one reusable key for every session', async () => {
    await media.warm();
    await media.warm();
    const node = native.nodes[0]!;
    expect(node.servers).toHaveLength(1);
    const server = node.servers[0]!;
    expect(server.options.reusableSocket).toBe(true);
    expect(server.listen).toHaveBeenCalledTimes(1);
    const first = await media.create({ sessionId });
    const second = await media.create({ sessionId: secondSessionId });
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.port).not.toBe(second.port);
    expect(node.servers).toHaveLength(1);
  });

  it('opens a sender stream over the reusable route and forwards only after the ack', async () => {
    await media.create({ sessionId });
    const connecting = media.connect({ sessionId, remotePublicKey, initiator: true });
    const node = native.nodes[0]!;
    const stream = node.stream;
    expect(node.connect).toHaveBeenCalledWith(Buffer.from(remotePublicKey, 'hex'), {
      keyPair: expect.any(Object),
      reusableSocket: true
    });
    const socket = native.sockets[0]!;
    socket.emit('message', stun(), { address: '127.0.0.1', port: 4444 });
    expect(stream.trySend).not.toHaveBeenCalled();
    stream.emit('open');
    expect(stream.write).toHaveBeenCalledWith(header(), expect.any(Function));
    stream.emit('data', Buffer.from([1]));
    await connecting;
    expect(stream.trySend).toHaveBeenCalledExactlyOnceWith(stun());
  });

  it('accepts a receiver stream only for its pinned session and matching key, then forwards both ways', async () => {
    await media.create({ sessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: false });
    const server = native.nodes[0]!.servers[0]!;
    const socket = native.sockets[0]!;
    expect(server.options.firewall(Buffer.alloc(32, 3))).toBe(false);
    expect(server.options.firewall(Buffer.alloc(32, 4))).toBe(true);
    const stream = incoming();
    server.emit('connection', stream);
    stream.emit('data', header());
    expect(stream.pause).toHaveBeenCalled();
    expect(stream.write).toHaveBeenCalledWith(Buffer.from([1]), expect.any(Function));
    socket.emit('message', stun(), { address: '127.0.0.1', port: 4444 });
    expect(stream.trySend).toHaveBeenLastCalledWith(stun());
    stream.emit('message', Buffer.from([3]));
    expect(socket.send).toHaveBeenCalledWith(Buffer.from([3]), 4444, '127.0.0.1', expect.any(Function));
    expect(closed).not.toHaveBeenCalled();
  });

  it('rejects an unknown header, a mismatched key and a duplicate stream', async () => {
    await media.create({ sessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: false });
    const server = native.nodes[0]!.servers[0]!;
    const unknown = incoming();
    server.emit('connection', unknown);
    unknown.emit('data', Buffer.alloc(16, 9));
    expect(unknown.destroy).toHaveBeenCalled();
    const mismatched = incoming(Buffer.alloc(32, 4));
    server.emit('connection', mismatched);
    mismatched.emit('data', header());
    expect(mismatched.destroy).toHaveBeenCalled();
    const first = incoming();
    server.emit('connection', first);
    first.emit('data', header());
    const duplicate = incoming();
    server.emit('connection', duplicate);
    duplicate.emit('data', header());
    expect(duplicate.destroy).toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it('buffers early datagrams until the link and the local endpoint are ready', async () => {
    await media.create({ sessionId });
    const connecting = media.connect({ sessionId, remotePublicKey, initiator: true });
    const stream = native.nodes[0]!.stream;
    const socket = native.sockets[0]!;
    socket.emit('message', stun(), { address: '127.0.0.1', port: 4444 });
    expect(stream.trySend).not.toHaveBeenCalled();
    stream.emit('open');
    stream.emit('data', Buffer.from([1]));
    await connecting;
    expect(stream.trySend).toHaveBeenCalledExactlyOnceWith(stun());

    await media.create({ sessionId: secondSessionId });
    await media.connect({ sessionId: secondSessionId, remotePublicKey: '05'.repeat(32), initiator: false });
    const receiver = incoming(Buffer.alloc(32, 5));
    native.nodes[0]!.servers[0]!.emit('connection', receiver);
    receiver.emit('data', header(secondSessionId));
    const secondSocket = native.sockets[1]!;
    receiver.emit('message', Buffer.from([7]));
    expect(secondSocket.send).not.toHaveBeenCalled();
    secondSocket.emit('message', stun(), { address: '127.0.0.1', port: 5555 });
    expect(secondSocket.send).toHaveBeenCalledWith(Buffer.from([7]), 5555, '127.0.0.1', expect.any(Function));
  });

  it('keeps other sessions alive when one peer stream closes', async () => {
    await media.create({ sessionId });
    await media.create({ sessionId: secondSessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: false });
    await media.connect({ sessionId: secondSessionId, remotePublicKey, initiator: false });
    const server = native.nodes[0]!.servers[0]!;
    const first = incoming();
    const second = incoming();
    server.emit('connection', first);
    first.emit('data', header());
    server.emit('connection', second);
    second.emit('data', header(secondSessionId));
    first.emit('close');
    expect(closed).toHaveBeenCalledExactlyOnceWith({ sessionId });
    expect(second.destroy).not.toHaveBeenCalled();
    const secondSocket = native.sockets[1]!;
    secondSocket.emit('message', stun(), { address: '127.0.0.1', port: 6666 });
    expect(second.trySend).toHaveBeenCalledWith(stun());
    expect(native.nodes[0]!.destroy).not.toHaveBeenCalled();
  });

  it('times out an unanswered sender and ignores stream events after normal close', async () => {
    await media.create({ sessionId });
    const connecting = media.connect({ sessionId, remotePublicKey, initiator: true }).catch((error) => error);
    const stream = native.nodes[0]!.stream;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await connecting).toBeInstanceOf(Error);
    expect(closed).toHaveBeenCalledExactlyOnceWith({ sessionId });
    stream.emit('error', new Error('late')); stream.emit('close');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled bootstrap and lets closeAll cancel it', async () => {
    const pending = Promise.withResolvers<void>();
    native.listen = () => pending.promise;
    const creating = media.create({ sessionId });
    const rejection = expect(creating).rejects.toThrow('closing');
    await flush();
    await media.closeAll();
    await rejection;
    pending.resolve();
    expect(native.nodes[0]!.servers[0]!.close).toHaveBeenCalled();
  });
});

describe('media IPC ownership', () => {
  it('gates every handler on exact window, main frame, allowed origin and liveness', async () => {
    type Handler = (event: IpcMainInvokeEvent, input: unknown) => unknown;
    const handlers = new Map<string, Handler>();
    const frame = { url: 'https://chat.example/room' };
    let destroyed = false;
    let crashed = false;
    const contents = { mainFrame: frame, isDestroyed: () => destroyed, isCrashed: () => crashed };
    const window = { webContents: contents, isDestroyed: () => destroyed };
    const ipc: Pick<IpcMain, 'handle'> = { handle: (name, handler) => { handlers.set(name, handler); } };
    // These test doubles intentionally implement only the Electron ownership boundary.
    let owner: BrowserWindow | null = window as unknown as BrowserWindow;
    let origin = 'https://chat.example';
    registerHolepunchMediaIpc(ipc, media, () => owner, () => origin);
    expect(handlers.size).toBe(4);
    for (const handler of handlers.values()) {
      for (const inputEvent of [
        { sender: {}, senderFrame: frame },
        { sender: contents, senderFrame: null },
        { sender: contents, senderFrame: { url: frame.url } },
        { sender: contents, senderFrame: { url: 'https://evil.example' } }
      ]) {
        expect(() => handler(inputEvent as IpcMainInvokeEvent, { sessionId })).toThrow();
      }
    }
    destroyed = true;
    expect(() => handlers.get('media:warm')!({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, undefined)).toThrow();
    destroyed = false;
    crashed = true;
    expect(() => handlers.get('media:warm')!({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, undefined)).toThrow();
    crashed = false;
    owner = null;
    expect(() => handlers.get('media:warm')!({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, undefined)).toThrow();
    owner = window as unknown as BrowserWindow;
    await expect(handlers.get('media:create')!({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, { sessionId })).resolves.toMatchObject({ port: 12345 });
    await expect(handlers.get('media:warm')!({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, undefined)).resolves.toBeUndefined();
  });
});
