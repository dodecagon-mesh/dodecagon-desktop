export type MediaSessionInput = { sessionId: string };
export type MediaConnectInput = MediaSessionInput & { remotePublicKey: string; initiator: boolean };
export type MediaClosedEvent = MediaSessionInput;
export type MediaProxy = { publicKey: string; port: number };

export interface DesktopMedia {
  version: 1;
  warm(): Promise<void>;
  create(input: MediaSessionInput): Promise<MediaProxy>;
  connect(input: MediaConnectInput): Promise<void>;
  close(input: MediaSessionInput): Promise<void>;
  onClosed(callback: (event: MediaClosedEvent) => void): () => void;
}
