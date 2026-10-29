declare module 'hyperdht' {
  import { EventEmitter } from 'node:events';

  export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
  export interface NoiseStream extends EventEmitter {
    remotePublicKey: Buffer | null;
    connected: boolean;
    trySend(packet: Buffer): void;
    write(buffer: Buffer, callback?: (error?: Error | null) => void): boolean;
    pause(): void;
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
    createServer(options: { firewall(remotePublicKey: Buffer): boolean; reusableSocket: boolean }): Server;
    connect(publicKey: Buffer, options: { keyPair: KeyPair; reusableSocket: boolean }): NoiseStream;
    destroy(options: { force: boolean }): Promise<void>;
  }
}
