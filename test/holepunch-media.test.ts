import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';

type MockStream = EventEmitter & {
  remotePublicKey: Buffer; trySend: Mock; destroy: Mock; setTimeout: Mock; setKeepAlive: Mock;
};
type MockServer = EventEmitter & {
  options: { firewall(key: Buffer): boolean }; listen: Mock; close: Mock;
};
type MockNode = EventEmitter & {
  server: MockServer; servers: MockServer[]; stream: MockStream; connect: Mock; destroy: Mock;
};
type MockSocket = EventEmitter & { bind: Mock; send: Mock; close: Mock };
const native = vi.hoisted(() => ({
  nodes: [] as MockNode[], sockets: [] as MockSocket[], listen: null as null | (() => Promise<void>)
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
    server!: MockServer;
    servers: MockServer[] = [];
    stream!: MockStream;
    destroy = vi.fn(async () => {});
    constructor() { super(); native.nodes.push(this); }
    createServer(options: { firewall(key: Buffer): boolean }) {
      this.server = Object.assign(new EventEmitter(), {
        options, listen: vi.fn(() => native.listen?.() ?? Promise.resolve()), close: vi.fn(async () => {})
      });
      this.servers.push(this.server);
      return this.server;
    }
    connect = vi.fn(() => {
      this.stream = Object.assign(new EventEmitter(), {
        remotePublicKey: Buffer.alloc(32, 3), trySend: vi.fn(), destroy: vi.fn(),
        setTimeout: vi.fn(), setKeepAlive: vi.fn()
      });
      return this.stream;
    });
  } };
});

vi.mock('node:dgram', async () => {
  // Vitest hoists factories before static imports; load this dependency inside the factory.
  const { EventEmitter } = await import('node:events');
  return { createSocket: () => {
    const socket = Object.assign(new EventEmitter(), {
      bind: vi.fn(() => { void Promise.resolve().then(() => socket.emit('listening')); }),
      address: () => ({ port: 12345, address: '127.0.0.1', family: 'IPv4' }),
      send: vi.fn((_packet: Buffer, _port: number, _address: string, callback: (error: Error | null) => void) => callback(null)),
      close: vi.fn((callback?: () => void) => callback?.())
    });
    native.sockets.push(socket);
    return socket;
  } };
});

import { HolepunchMedia, registerHolepunchMediaIpc } from '../src/main/holepunch-media';

const sessionId = '01020304-1234-4123-8123-010203040506';
const remotePublicKey = '03'.repeat(32);
const stun = () => {
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(1, 0);
  packet.writeUInt32BE(0x2112a442, 4);
  return packet;
};
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
    for (let i = 1; i < 128; i++) await media.create({ sessionId: `${i.toString(16).padStart(8, '0')}-1234-4123-8123-010203040506` });
    await expect(media.create({ sessionId: 'ffffffff-1234-4123-8123-010203040506' })).rejects.toThrow();
  });

  it('shares one DHT node while closing one session leaves other peer sessions active', async () => {
    const secondId = 'ffffffff-1234-4123-8123-010203040506';
    await media.create({ sessionId });
    await media.create({ sessionId: secondId });
    expect(native.nodes).toHaveLength(1);
    const node = native.nodes[0]!;
    expect(node.servers).toHaveLength(2);
    expect(node.servers[0]!.listen.mock.calls[0]![0]).not.toBe(node.servers[1]!.listen.mock.calls[0]![0]);
    await media.close({ sessionId });
    expect(node.servers[0]!.close).toHaveBeenCalledTimes(1);
    expect(node.servers[1]!.close).not.toHaveBeenCalled();
    expect(node.destroy).not.toHaveBeenCalled();
    await media.connect({ sessionId: secondId, remotePublicKey, initiator: true });
    node.stream.emit('open');
    native.sockets[1]!.emit('message', stun(), { address: '127.0.0.1', port: 4444 });
    expect(node.stream.trySend).toHaveBeenCalledExactlyOnceWith(stun());
    await media.closeAll();
    expect(node.destroy).toHaveBeenCalledExactlyOnceWith({ force: true });
    expect(closed).not.toHaveBeenCalled();
  });

  it('blocks creates during document reset and isolates old-node failures from its replacement', async () => {
    const secondId = 'ffffffff-1234-4123-8123-010203040506';
    await media.create({ sessionId });
    const node = native.nodes[0]!;
    const destroying = Promise.withResolvers<void>();
    node.destroy.mockImplementation(() => destroying.promise);
    const reset = media.closeAll();
    await expect(media.create({ sessionId: secondId })).rejects.toThrow('closing');
    destroying.resolve();
    await reset;
    await media.create({ sessionId: secondId });
    expect(native.nodes).toHaveLength(2);
    node.emit('error', new Error('late old-node error'));
    node.emit('close');
    expect(closed).not.toHaveBeenCalled();
    await expect(media.connect({ sessionId: secondId, remotePublicKey, initiator: false })).resolves.toBeUndefined();
  });

  it('notifies every active peer on shared-node failure and starts a new document node afterwards', async () => {
    const secondId = 'ffffffff-1234-4123-8123-010203040506';
    await media.create({ sessionId });
    await media.create({ sessionId: secondId });
    native.nodes[0]!.emit('error', new Error('DHT unavailable'));
    await media.closeAll();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledWith({ sessionId });
    expect(closed).toHaveBeenCalledWith({ sessionId: secondId });
    await media.create({ sessionId });
    expect(native.nodes).toHaveLength(2);
  });

  it('rejects all incoming peers until pinned, then only accepts the receiver role and matching key', async () => {
    await media.create({ sessionId });
    const { server } = native.nodes[0]!;
    expect(server.options.firewall(Buffer.alloc(32, 3))).toBe(true);
    await media.connect({ sessionId, remotePublicKey, initiator: false });
    expect(server.options.firewall(Buffer.alloc(32, 3))).toBe(false);
    expect(server.options.firewall(Buffer.alloc(32, 4))).toBe(true);
    expect(native.nodes[0]!.connect).not.toHaveBeenCalled();
    const unexpected = Object.assign(new EventEmitter(), { remotePublicKey: Buffer.alloc(32, 4), destroy: vi.fn() });
    server.emit('connection', unexpected);
    expect(unexpected.destroy).toHaveBeenCalled();
    await expect(media.connect({ sessionId, remotePublicKey: '04'.repeat(32), initiator: false })).rejects.toThrow();
  });

  it('accepts only one authenticated receiver stream and forwards in both directions', async () => {
    await media.create({ sessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: false });
    const stream = Object.assign(new EventEmitter(), {
      remotePublicKey: Buffer.alloc(32, 3), connected: true, trySend: vi.fn(), destroy: vi.fn(),
      setTimeout: vi.fn(), setKeepAlive: vi.fn()
    });
    const server = native.nodes[0]!.server;
    server.emit('connection', stream);
    expect(server.options.firewall(Buffer.alloc(32, 3))).toBe(true);
    const socket = native.sockets[0]!;
    socket.emit('message', stun(), { address: '127.0.0.1', port: 4444 });
    expect(stream.trySend).toHaveBeenCalledExactlyOnceWith(stun());
    stream.emit('message', Buffer.from([3]));
    expect(socket.send).toHaveBeenCalledWith(Buffer.from([3]), 4444, '127.0.0.1', expect.any(Function));
    const duplicate = Object.assign(new EventEmitter(), {
      remotePublicKey: Buffer.alloc(32, 3), destroy: vi.fn()
    });
    server.emit('connection', duplicate);
    expect(duplicate.destroy).toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    stream.emit('close');
    expect(closed).toHaveBeenCalledExactlyOnceWith({ sessionId });
  });

  it('pins one valid localhost STUN source and forwards bounded packets only over unordered messages', async () => {
    await media.create({ sessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: true });
    const { stream, connect } = native.nodes[0]!;
    expect(connect).toHaveBeenCalledWith(Buffer.alloc(32, 3), expect.objectContaining({ keyPair: expect.any(Object) }));
    stream.emit('open');
    const socket = native.sockets[0]!;
    expect(socket.bind).toHaveBeenCalledWith(0, '127.0.0.1');
    stream.emit('message', Buffer.from([1]));
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit('message', stun(), { address: '192.168.1.2', port: 4444 });
    socket.emit('message', Buffer.from([1]), { address: '127.0.0.1', port: 4444 });
    expect(stream.trySend).not.toHaveBeenCalled();
    socket.emit('message', stun(), { address: '127.0.0.1', port: 4444 });
    socket.emit('message', Buffer.from([2]), { address: '127.0.0.1', port: 5555 });
    socket.emit('message', Buffer.alloc(65_536), { address: '127.0.0.1', port: 4444 });
    expect(stream.trySend).toHaveBeenCalledTimes(1);
    stream.emit('message', Buffer.from([3]));
    stream.emit('message', Buffer.alloc(65_536));
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(Buffer.from([3]), 4444, '127.0.0.1', expect.any(Function));
  });

  it('accepts an assigned NIC IPv4 source and pins both address and port without allowing arbitrary private hosts', async () => {
    await media.create({ sessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: true });
    const stream = native.nodes[0]!.stream;
    const socket = native.sockets[0]!;
    stream.emit('open');
    for (const address of ['192.168.0.103', '192.168.1.2', '10.2.3.5', '203.0.113.9']) {
      socket.emit('message', stun(), { address, port: 4444 });
    }
    socket.emit('message', Buffer.from([1]), { address: '192.168.0.102', port: 4444 });
    expect(stream.trySend).not.toHaveBeenCalled();
    stream.emit('message', Buffer.from([3]));
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit('message', stun(), { address: '192.168.0.102', port: 4444 });
    expect(stream.trySend).toHaveBeenCalledExactlyOnceWith(stun());
    for (const endpoint of [
      { address: '10.2.3.4', port: 4444 },
      { address: '127.0.0.1', port: 4444 },
      { address: '192.168.0.102', port: 5555 }
    ]) socket.emit('message', stun(), endpoint);
    expect(stream.trySend).toHaveBeenCalledTimes(1);
    socket.emit('message', Buffer.from([2]), { address: '192.168.0.102', port: 4444 });
    expect(stream.trySend).toHaveBeenCalledTimes(2);
    stream.emit('message', Buffer.from([3]));
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(
      Buffer.from([3]), 4444, '192.168.0.102', expect.any(Function)
    );
    expect(socket.bind).toHaveBeenCalledWith(0, '127.0.0.1');
  });

  it('rechecks the authenticated stream identity and reports one unexpected close', async () => {
    await media.create({ sessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: true });
    const stream = native.nodes[0]!.stream;
    stream.remotePublicKey = Buffer.alloc(32, 4);
    stream.emit('open'); stream.emit('error', new Error('late')); stream.emit('close');
    expect(closed).toHaveBeenCalledExactlyOnceWith({ sessionId });
    expect(stream.destroy).toHaveBeenCalled();
    expect(native.sockets[0]!.close).toHaveBeenCalled();
  });

  it('closes pending creation without resurrecting it or notifying a replacement session', async () => {
    const pendingListen = Promise.withResolvers<void>();
    const listenStarted = Promise.withResolvers<void>();
    native.listen = () => { listenStarted.resolve(); return pendingListen.promise; };
    const creating = media.create({ sessionId });
    const rejected = expect(creating).rejects.toThrow();
    await listenStarted.promise;
    await media.closeAll();
    pendingListen.resolve(); await rejected;
    native.listen = null;
    await media.create({ sessionId });
    native.nodes[0]!.server.emit('close');
    expect(closed).not.toHaveBeenCalled();
    await media.close({ sessionId }); await media.close({ sessionId });
    expect(closed).not.toHaveBeenCalled();
  });

  it('notifies on connection timeout and ignores stream events after normal close', async () => {
    await media.create({ sessionId });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(closed).toHaveBeenCalledExactlyOnceWith({ sessionId });
    await media.create({ sessionId });
    await media.connect({ sessionId, remotePublicKey, initiator: true });
    const stream = native.nodes.at(-1)!.stream;
    await media.close({ sessionId });
    stream.emit('error', new Error('stale')); stream.emit('close');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled bootstrap creation and rejects it without waiting for network progress', async () => {
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    native.listen = () => { started.resolve(); return pending.promise; };
    const creating = media.create({ sessionId });
    const rejection = expect(creating).rejects.toThrow('closed');
    await started.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(closed).toHaveBeenCalledExactlyOnceWith({ sessionId });
    expect(native.nodes[0]!.server.close).toHaveBeenCalled();
    expect(native.nodes[0]!.destroy).not.toHaveBeenCalled();
    pending.resolve();
  });

  it.each(['error', 'close'])('releases native resources on unexpected UDP %s', async (event) => {
    await media.create({ sessionId });
    native.sockets[0]!.emit(event, new Error('UDP unavailable'));
    await media.closeAll();
    expect(closed).toHaveBeenCalledExactlyOnceWith({ sessionId });
    expect(native.nodes[0]!.destroy).toHaveBeenCalledWith({ force: true });
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
    expect(handlers.size).toBe(3);
    for (const handler of handlers.values()) {
      for (const inputEvent of [
        { sender: {}, senderFrame: frame },
        { sender: contents, senderFrame: null },
        { sender: contents, senderFrame: { url: frame.url } },
        { sender: contents, senderFrame: { url: 'https://evil.example' } }
      ]) {
        // Deliberately incomplete/malicious Electron events test the production checks.
        const event = inputEvent as unknown as IpcMainInvokeEvent;
        await expect(Promise.resolve().then(() => handler(event, { sessionId }))).rejects.toThrow();
      }
    }
    // Only the Electron fields consumed by authorization are needed in this event double.
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    frame.url = 'https://evil.example';
    for (const handler of handlers.values()) {
      await expect(Promise.resolve().then(() => handler(event, { sessionId }))).rejects.toThrow();
    }
    frame.url = 'https://chat.example/room';
    origin = '';
    for (const handler of handlers.values()) {
      await expect(Promise.resolve().then(() => handler(event, { sessionId }))).rejects.toThrow();
    }
    origin = 'https://chat.example';
    destroyed = true;
    for (const handler of handlers.values()) {
      await expect(Promise.resolve().then(() => handler(event, { sessionId }))).rejects.toThrow();
    }
    destroyed = false;
    crashed = true;
    for (const handler of handlers.values()) {
      await expect(Promise.resolve().then(() => handler(event, { sessionId }))).rejects.toThrow();
    }
    crashed = false;
    owner = null;
    for (const handler of handlers.values()) {
      await expect(Promise.resolve().then(() => handler(event, { sessionId }))).rejects.toThrow();
    }
    owner = window as unknown as BrowserWindow;
    await expect(handlers.get('media:create')!(event, { sessionId })).resolves.toMatchObject({ port: 12345 });
  });
});
