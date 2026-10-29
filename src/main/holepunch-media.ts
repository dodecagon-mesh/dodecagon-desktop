import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import DHT, { type KeyPair, type NoiseStream, type Server } from 'hyperdht';
import { isServerOrigin } from './server-config';

const MAX_SESSIONS = 128;
const MAX_PACKET_BYTES = 16_384;
const MAX_PENDING_PACKETS = 32;
const MAX_PENDING_STREAMS = 16;
const CONNECT_TIMEOUT_MS = 30_000;
const HEADER_TIMEOUT_MS = 10_000;
const SESSION_HEADER_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^[0-9a-f]{64}$/i;
const HEADER_ACK = Buffer.from([1]);

type Session = {
  id: string;
  generation: number;
  socket: Socket;
  localAddresses: Set<string>;
  stream: NoiseStream | null;
  remoteKey: Buffer | null;
  initiator: boolean | null;
  endpoint: { address: string; port: number } | null;
  open: boolean;
  stopped: boolean;
  headerSent: boolean;
  timer: NodeJS.Timeout;
  outgoing: Buffer[];
  incoming: Buffer[];
  connect?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
};

const inputSessionId = (input: unknown): string => {
  if (!input || typeof input !== 'object' || !('sessionId' in input) ||
      typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) {
    throw new Error('media sessionId must be a UUID');
  }
  return input.sessionId.toLowerCase();
};

/** One authenticated document link: every media session to a peer rides its announced key and route. */
export class HolepunchMedia {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingStreams = new Set<NoiseStream>();
  private node: DHT | null = null;
  private keyPair: KeyPair | null = null;
  private server: Server | null = null;
  private serverReady = false;
  private serverPromise: Promise<void> | null = null;
  private serverSetup: { server: Server; cancel: (error: Error) => void } | null = null;
  private generation = 0;
  private resetting: Promise<void> | null = null;

  constructor(
    private readonly onClosed: (event: { sessionId: string }) => void,
    private readonly createNode: () => DHT = () => new DHT()
  ) {}

  async warm(): Promise<void> {
    await this.ensureServer();
  }

  async create(input: unknown): Promise<{ publicKey: string; port: number }> {
    const id = inputSessionId(input);
    if (this.sessions.has(id)) throw new Error('media session already exists');
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('too many media sessions');
    if (this.resetting) throw new Error('media document is closing');
    const generation = this.generation;
    await this.ensureServer();
    if (this.resetting || generation !== this.generation || !this.keyPair) {
      throw new Error('media document is closing');
    }
    const localAddresses = new Set<string>();
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === 'IPv4') localAddresses.add(address.address);
      }
    }
    const socket = createSocket('udp4');
    const session: Session = {
      id, generation, socket, localAddresses,
      stream: null, remoteKey: null, initiator: null, endpoint: null,
      open: false, stopped: false, headerSent: false,
      timer: setTimeout(() => this.stop(session, true), CONNECT_TIMEOUT_MS),
      outgoing: [], incoming: []
    };
    session.timer.unref();
    this.sessions.set(id, session);
    const fail = (): void => { this.stop(session, true); };
    socket.on('error', fail);
    socket.on('close', fail);
    socket.on('message', (packet, source) => {
      if (session.stopped || packet.length === 0 || packet.length > MAX_PACKET_BYTES) return;
      if (session.endpoint === null) {
        const isStun = packet.length >= 20 && packet.readUInt16BE(0) === 1 &&
          packet.readUInt32BE(4) === 0x2112a442 &&
          packet.readUInt16BE(2) % 4 === 0 && packet.readUInt16BE(2) + 20 === packet.length;
        if (!isStun ||
            (!source.address.startsWith('127.') && !session.localAddresses.has(source.address))) return;
        // Chromium can send localhost ICE from a socket bound to an assigned host NIC.
        session.endpoint = { address: source.address, port: source.port };
        for (const queued of session.incoming) {
          socket.send(queued, source.port, source.address, (error) => {
            if (error) this.stop(session, true);
          });
        }
        session.incoming.length = 0;
      }
      if (source.address !== session.endpoint.address || source.port !== session.endpoint.port) return;
      if (!session.open || !session.stream) {
        if (session.outgoing.length < MAX_PENDING_PACKETS) session.outgoing.push(packet);
        return;
      }
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
        await Promise.race([listening.promise]);
      } finally {
        socket.off('listening', onListening);
        socket.off('error', onError);
      }
      if (session.stopped || session.generation !== this.generation) {
        throw new Error('media session closed during creation');
      }
      const address = socket.address();
      if (typeof address === 'string') throw new Error('invalid media proxy address');
      return { publicKey: this.keyPair!.publicKey.toString('hex'), port: address.port };
    };
    try {
      return await setup();
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
    if (!session || session.stopped) throw new Error('media session is not ready');
    const key = Buffer.from(input.remotePublicKey, 'hex');
    const node = this.node;
    const keyPair = this.keyPair;
    if (!node || !keyPair) throw new Error('media link is not ready');
    if (key.equals(keyPair.publicKey)) throw new Error('cannot connect media to itself');
    if (session.remoteKey) {
      if (!session.remoteKey.equals(key) || session.initiator !== input.initiator) {
        throw new Error('media peer already pinned');
      }
      if (session.connect) return session.connect.promise;
      if (session.stream) return;
    }
    session.remoteKey = key;
    session.initiator = input.initiator;
    if (!input.initiator) return;
    const stream = node.connect(key, { keyPair, reusableSocket: true });
    session.stream = stream;
    const connected = Promise.withResolvers<void>();
    session.connect = { promise: connected.promise, resolve: connected.resolve, reject: connected.reject };
    this.listen(session, stream, true);
    await connected.promise;
  }

  async close(input: unknown): Promise<void> {
    const session = this.sessions.get(inputSessionId(input));
    if (session) this.stop(session, false);
  }

  async closeAll(): Promise<void> {
    if (this.resetting) return this.resetting;
    this.generation += 1;
    const server = this.server;
    const node = this.node;
    const keyPair = this.keyPair;
    const setup = this.serverSetup;
    this.serverSetup = null;
    setup?.cancel(new Error('media document is closing'));
    void setup?.server.close().catch(() => {});
    this.server = null;
    this.node = null;
    this.keyPair = null;
    this.serverReady = false;
    this.serverPromise = null;
    for (const session of this.sessions.values()) this.stop(session, false);
    for (const stream of this.pendingStreams) stream.destroy();
    this.pendingStreams.clear();
    keyPair?.secretKey.fill(0);
    // Destroy the document's shared DHT concurrently to cancel pending bootstrap/listen work.
    const cleanup = Promise.allSettled([
      ...(server ? [server.close()] : []),
      ...(node ? [node.destroy({ force: true })] : [])
    ]).then(() => {
      if (this.resetting === cleanup) this.resetting = null;
    });
    this.resetting = cleanup;
    await cleanup;
  }

  private ensureServer(): Promise<void> {
    if (this.serverReady) return Promise.resolve();
    if (this.resetting) return Promise.reject(new Error('media document is closing'));
    if (this.serverPromise) return this.serverPromise;
    const generation = this.generation;
    const setup = (async () => {
      let node = this.node;
      if (!node) {
        node = this.createNode();
        this.node = node;
        const fail = (): void => {
          if (this.node !== node) return;
          for (const session of this.sessions.values()) this.stop(session, true);
          void this.closeAll();
        };
        node.on('error', fail);
        node.on('close', fail);
      }
      const keyPair = DHT.keyPair();
      const server = node.createServer({
        reusableSocket: true,
        firewall: (remotePublicKey: Buffer) => {
          for (const session of this.sessions.values()) {
            if (!session.stopped && session.initiator === false &&
                session.remoteKey?.equals(remotePublicKey)) return false;
          }
          return true;
        }
      });
      const fail = (): void => {
        if (this.server !== server && this.serverSetup?.server !== server) return;
        for (const session of this.sessions.values()) this.stop(session, true);
        void this.closeAll();
      };
      server.on('error', fail);
      server.on('close', fail);
      server.on('connection', (stream: NoiseStream) => this.accept(stream));
      const cancelled = Promise.withResolvers<never>();
      this.serverSetup = { server, cancel: cancelled.reject };
      try {
        await Promise.race([server.listen(keyPair), cancelled.promise]);
      } catch (error) {
        await server.close().catch(() => {});
        throw error;
      } finally {
        if (this.serverSetup?.server === server) this.serverSetup = null;
      }
      if (generation !== this.generation || this.resetting || this.node !== node) {
        await server.close().catch(() => {});
        throw new Error('media document closed during creation');
      }
      this.keyPair = keyPair;
      this.server = server;
      this.serverReady = true;
    })();
    this.serverPromise = setup;
    setup.catch(() => {
      if (this.serverPromise === setup) this.serverPromise = null;
    });
    return setup;
  }

  private accept(stream: NoiseStream): void {
    if (!this.serverReady || this.resetting || this.pendingStreams.size >= MAX_PENDING_STREAMS) {
      stream.destroy();
      return;
    }
    this.pendingStreams.add(stream);
    // Keep an error listener even on rejected streams: destroy can emit asynchronously.
    stream.on('error', () => {});
    const timer = setTimeout(() => {
      this.pendingStreams.delete(stream);
      stream.destroy();
    }, HEADER_TIMEOUT_MS);
    timer.unref();
    let header = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      if (header.length < SESSION_HEADER_BYTES) return;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.pause();
      this.pendingStreams.delete(stream);
      const hex = header.subarray(0, SESSION_HEADER_BYTES).toString('hex');
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const session = UUID.test(id) ? this.sessions.get(id) : undefined;
      if (!session || session.stopped || session.stream || session.initiator !== false ||
          !session.remoteKey || !stream.remotePublicKey?.equals(session.remoteKey)) {
        stream.destroy();
        return;
      }
      session.stream = stream;
      session.open = true;
      clearTimeout(session.timer);
      this.listen(session, stream, false);
      stream.write(HEADER_ACK, (error?: Error | null) => {
        if (error) this.stop(session, true);
      });
      this.flush(session);
    };
    stream.on('data', onData);
    stream.once('close', () => {
      clearTimeout(timer);
      this.pendingStreams.delete(stream);
    });
  }

  private listen(session: Session, stream: NoiseStream, initiator: boolean): void {
    const fail = (): void => { this.stop(session, true); };
    stream.on('error', fail);
    stream.on('close', fail);
    stream.on('timeout', fail);
    stream.setKeepAlive(5_000);
    stream.setTimeout(30_000);
    stream.on('message', (packet: Buffer) => {
      if (session.stopped || !Buffer.isBuffer(packet) || packet.length === 0 ||
          packet.length > MAX_PACKET_BYTES) return;
      if (!session.open || !session.endpoint) {
        if (session.incoming.length < MAX_PENDING_PACKETS) session.incoming.push(packet);
        return;
      }
      session.socket.send(packet, session.endpoint.port, session.endpoint.address, (error) => {
        if (error) fail();
      });
    });
    if (!initiator) return;
    let ack = Buffer.alloc(0);
    const onAck = (chunk: Buffer): void => {
      ack = Buffer.concat([ack, chunk]);
      if (ack.length === 0) return;
      stream.off('data', onAck);
      session.open = true;
      clearTimeout(session.timer);
      session.connect?.resolve();
      this.flush(session);
    };
    stream.on('data', onAck);
    const open = (): void => {
      if (session.stopped || session.headerSent) return;
      if (!session.remoteKey || !stream.remotePublicKey?.equals(session.remoteKey)) {
        fail();
        return;
      }
      session.headerSent = true;
      const header = Buffer.from(session.id.replace(/-/g, ''), 'hex');
      try {
        stream.write(header, (error?: Error | null) => {
          if (error) fail();
        });
      } catch {
        fail();
      }
    };
    if (stream.connected) open();
    else stream.on('open', open);
  }

  private flush(session: Session): void {
    if (session.open && session.stream) {
      for (const packet of session.outgoing) {
        try { session.stream.trySend(packet); } catch { this.stop(session, true); return; }
      }
      session.outgoing.length = 0;
    }
    if (!session.endpoint) return;
    for (const packet of session.incoming) {
      session.socket.send(packet, session.endpoint.port, session.endpoint.address, (error) => {
        if (error) this.stop(session, true);
      });
    }
    session.incoming.length = 0;
  }

  private stop(session: Session, unexpected: boolean): void {
    if (session.stopped) return;
    session.stopped = true;
    session.open = false;
    clearTimeout(session.timer);
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    session.connect?.reject(new Error('media session closed'));
    session.stream?.destroy();
    try { session.socket.close(); } catch { /* A failed bind has no open socket. */ }
    session.outgoing.length = 0;
    session.incoming.length = 0;
    // Closing one peer must not interrupt other sessions on the shared link.
    if (unexpected) this.onClosed({ sessionId: session.id });
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
  ipc.handle('media:warm', (event) => { authorize(event); return media.warm(); });
  ipc.handle('media:create', (event, input: unknown) => { authorize(event); return media.create(input); });
  ipc.handle('media:connect', (event, input: unknown) => { authorize(event); return media.connect(input); });
  ipc.handle('media:close', (event, input: unknown) => { authorize(event); return media.close(input); });
};
