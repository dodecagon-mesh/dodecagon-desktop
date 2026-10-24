import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import DHT, { type KeyPair, type NoiseStream, type Server } from 'hyperdht';
import { isServerOrigin } from './server-config';

const MAX_SESSIONS = 128;
const MAX_PACKET_BYTES = 16_384;
const CONNECT_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^[0-9a-f]{64}$/i;

type Session = {
  id: string;
  node: DHT;
  generation: number;
  keyPair: KeyPair;
  socket: Socket;
  server: Server;
  stream: NoiseStream | null;
  remoteKey: Buffer | null;
  initiator: boolean | null;
  endpoint: { address: string; port: number } | null;
  ready: boolean;
  open: boolean;
  stopped: boolean;
  timer: NodeJS.Timeout;
  cancellation: Promise<never>;
  cancel(error: Error): void;
};

const inputSessionId = (input: unknown): string => {
  if (!input || typeof input !== 'object' || !('sessionId' in input) ||
      typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) {
    throw new Error('media sessionId must be a UUID');
  }
  return input.sessionId.toLowerCase();
};

const isInitialStun = (packet: Buffer): boolean => packet.length >= 20 &&
  packet.readUInt16BE(0) === 1 && packet.readUInt32BE(4) === 0x2112a442 &&
  packet.readUInt16BE(2) % 4 === 0 && packet.readUInt16BE(2) + 20 === packet.length;

/** Only native main owns packets and keys; the page receives an opaque localhost proxy. */
export class HolepunchMedia {
  private readonly sessions = new Map<string, Session>();
  private readonly resources = new Set<Session>();
  private readonly closing = new Set<Promise<void>>();
  private node: DHT | null = null;
  private generation = 0;
  private resetting: Promise<void> | null = null;

  constructor(
    private readonly onClosed: (event: { sessionId: string }) => void,
    private readonly createNode: () => DHT = () => new DHT()
  ) {}

  async create(input: unknown): Promise<{ publicKey: string; port: number }> {
    const id = inputSessionId(input);
    if (this.sessions.has(id)) throw new Error('media session already exists');
    if (this.resources.size >= MAX_SESSIONS) throw new Error('too many media sessions');
    if (this.resetting) throw new Error('media document is closing');
    const generation = this.generation;
    let node = this.node;
    if (!node) {
      node = this.createNode();
      this.node = node;
      const fail = (): void => {
        if (this.node !== node) return;
        for (const session of this.sessions.values()) this.stop(session, true);
        this.closeAll();
      };
      node.on('error', fail);
      node.on('close', fail);
    }
    const localAddresses = new Set<string>();
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === 'IPv4') localAddresses.add(address.address);
      }
    }
    const socket = createSocket('udp4');
    const keyPair = DHT.keyPair();
    const cancelled = Promise.withResolvers<never>();
    const session: Session = {
      id, node, generation, socket, keyPair,
      server: node.createServer({ firewall: (key) => session.stopped || session.initiator !== false ||
        session.remoteKey === null || session.stream !== null || !key.equals(session.remoteKey) }),
      stream: null, remoteKey: null, initiator: null, endpoint: null, ready: false, open: false, stopped: false,
      timer: setTimeout(() => this.stop(session, true), CONNECT_TIMEOUT_MS),
      cancellation: cancelled.promise, cancel: cancelled.reject
    };
    session.timer.unref();
    this.sessions.set(id, session);
    this.resources.add(session);
    const fail = (): void => { this.stop(session, true); };
    session.server.on('error', fail);
    session.server.on('close', fail);
    session.server.on('connection', (stream: NoiseStream) => this.accept(session, stream));
    socket.on('error', fail);
    socket.on('close', fail);
    socket.on('message', (packet, source) => {
      if (session.stopped || packet.length === 0 || packet.length > MAX_PACKET_BYTES) return;
      if (session.endpoint === null) {
        if (!isInitialStun(packet) ||
            (!source.address.startsWith('127.') && !localAddresses.has(source.address))) return;
        // Chromium can send localhost ICE from a socket bound to an assigned host NIC.
        session.endpoint = { address: source.address, port: source.port };
      }
      if (source.address !== session.endpoint.address || source.port !== session.endpoint.port ||
          !session.open || !session.stream) return;
      // Unordered datagrams only: reliable writes introduce head-of-line media stalls.
      try { session.stream.trySend(packet); } catch { fail(); }
    });
    const setup = async (): Promise<{ publicKey: string; port: number }> => {
      const listening = Promise.withResolvers<void>();
      const onListening = (): void => { listening.resolve(); };
      const onError = (error: Error): void => { listening.reject(error); };
      socket.once('listening', onListening);
      socket.once('error', onError);
      try {
        socket.bind(0, '127.0.0.1');
        await Promise.race([listening.promise, session.cancellation]);
      } finally {
        socket.off('listening', onListening);
        socket.off('error', onError);
      }
      if (session.stopped || session.generation !== this.generation) throw new Error('media session closed during creation');
      await session.server.listen(keyPair);
      if (session.stopped || session.generation !== this.generation || this.sessions.get(id) !== session) {
        throw new Error('media session closed during creation');
      }
      const address = socket.address();
      if (typeof address === 'string') throw new Error('invalid media proxy address');
      session.ready = true;
      return { publicKey: keyPair.publicKey.toString('hex'), port: address.port };
    };
    try {
      return await Promise.race([setup(), session.cancellation]);
    } catch (error) {
      this.stop(session, false);
      throw error;
    }
  }

  async connect(input: unknown): Promise<void> {
    const id = inputSessionId(input);
    if (!input || typeof input !== 'object' || !('remotePublicKey' in input) ||
        typeof input.remotePublicKey !== 'string' || !PUBLIC_KEY.test(input.remotePublicKey) ||
        !('initiator' in input) || typeof input.initiator !== 'boolean') {
      throw new Error('invalid media peer');
    }
    const session = this.sessions.get(id);
    if (!session || !session.ready || session.stopped) throw new Error('media session is not ready');
    const key = Buffer.from(input.remotePublicKey, 'hex');
    if (session.remoteKey) {
      if (!session.remoteKey.equals(key) || session.initiator !== input.initiator) throw new Error('media peer already pinned');
      return;
    }
    if (key.equals(session.keyPair.publicKey)) throw new Error('cannot connect media to itself');
    session.remoteKey = key;
    session.initiator = input.initiator;
    // Pin the receiver before its answer, without waiting for the incoming connection.
    if (!input.initiator) return;
    try {
      const stream = session.node.connect(key, { keyPair: session.keyPair });
      this.attach(session, stream);
    } catch (error) {
      this.stop(session, true);
      throw error;
    }
  }

  async close(input: unknown): Promise<void> {
    const session = this.sessions.get(inputSessionId(input));
    if (session) await this.stop(session, false);
  }

  async closeAll(): Promise<void> {
    if (this.resetting) return this.resetting;
    this.generation += 1;
    const node = this.node;
    this.node = null;
    for (const session of this.sessions.values()) this.stop(session, false);
    // Destroy the document's shared DHT concurrently to cancel pending bootstrap/listen work.
    const cleanup = Promise.allSettled([
      ...this.closing,
      ...(node ? [node.destroy({ force: true })] : [])
    ]).then(() => {
      if (this.resetting === cleanup) this.resetting = null;
    });
    this.resetting = cleanup;
    await cleanup;
  }

  private accept(session: Session, stream: NoiseStream): void {
    // Keep an error listener even on rejected streams: destroy can emit asynchronously.
    stream.on('error', () => {});
    if (session.stopped || session.initiator !== false || session.stream || !session.remoteKey ||
        !stream.remotePublicKey?.equals(session.remoteKey)) {
      stream.destroy();
      return;
    }
    this.attach(session, stream);
  }

  private attach(session: Session, stream: NoiseStream): void {
    session.stream = stream;
    const fail = (): void => { this.stop(session, true); };
    const opened = (): void => {
      if (session.stopped) return;
      if (!session.remoteKey || !stream.remotePublicKey?.equals(session.remoteKey)) { fail(); return; }
      clearTimeout(session.timer);
      session.open = true;
    };
    stream.on('error', fail);
    stream.on('close', fail);
    stream.on('timeout', fail);
    stream.on('open', opened);
    stream.on('connect', opened);
    stream.on('message', (packet: Buffer) => {
      if (session.stopped || !session.open || session.endpoint === null || !Buffer.isBuffer(packet) ||
          packet.length === 0 || packet.length > MAX_PACKET_BYTES) return;
      try {
        session.socket.send(packet, session.endpoint.port, session.endpoint.address, (error) => { if (error) fail(); });
      } catch { fail(); }
    });
    stream.setKeepAlive(5_000);
    stream.setTimeout(30_000);
    // Accepted streams may have completed their handshake before the server callback.
    if (stream.connected) opened();
  }

  private stop(session: Session, unexpected: boolean): Promise<void> {
    if (session.stopped) return Promise.resolve();
    session.stopped = true;
    session.open = false;
    clearTimeout(session.timer);
    session.cancel(new Error('media session closed'));
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    session.stream?.destroy();
    try { session.socket.close(); } catch { /* A failed bind has no open socket. */ }
    // Closing one peer must not interrupt other sessions on the shared DHT node.
    const cleanup = Promise.allSettled([session.server.close()]).then(() => {
      session.keyPair.secretKey.fill(0);
      this.resources.delete(session);
      this.closing.delete(cleanup);
    });
    this.closing.add(cleanup);
    if (unexpected) this.onClosed({ sessionId: session.id });
    return cleanup;
  }
}

/** Check every operation, including close: an iframe or picker never owns native media. */
export const registerHolepunchMediaIpc = (
  ipc: Pick<IpcMain, 'handle'>,
  media: HolepunchMedia,
  mainWindow: () => BrowserWindow | null,
  allowedOrigin: () => string
): void => {
  const authorize = (event: IpcMainInvokeEvent): void => {
    const window = mainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed() ||
        event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame || !isServerOrigin(event.senderFrame.url, allowedOrigin())) {
      throw new Error('media is only available to the main client document');
    }
  };
  ipc.handle('media:create', (event, input: unknown) => { authorize(event); return media.create(input); });
  ipc.handle('media:connect', (event, input: unknown) => { authorize(event); return media.connect(input); });
  ipc.handle('media:close', (event, input: unknown) => { authorize(event); return media.close(input); });
};
