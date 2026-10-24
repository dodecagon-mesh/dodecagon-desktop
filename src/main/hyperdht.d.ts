declare module 'hyperdht' {
  import { EventEmitter } from 'node:events';

  export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
  export interface NoiseStream extends EventEmitter {
    remotePublicKey: Buffer | null;
    connected: boolean;
    trySend(packet: Buffer): void;
    setTimeout(milliseconds: number): void;
    setKeepAlive(milliseconds: number): void;
    destroy(): void;
  }
  export interface Server extends EventEmitter {
    listen(keyPair: KeyPair): Promise<void>;
    close(): Promise<void>;
  }
  export default class DHT extends EventEmitter {
    static keyPair(): KeyPair;
    createServer(options: { firewall(remotePublicKey: Buffer): boolean }): Server;
    connect(publicKey: Buffer, options: { keyPair: KeyPair }): NoiseStream;
    destroy(options: { force: boolean }): Promise<void>;
  }
}
