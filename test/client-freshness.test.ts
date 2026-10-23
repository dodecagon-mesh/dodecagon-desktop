import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SERVER_VERSION_HEADER,
  keepClientDocumentFresh,
  readServerVersion
} from '../src/main/client-freshness';

type THeaders = Record<string, string>;

type THandler = (details: unknown, callback: (response: unknown) => void) => void;

const fakeSession = (): {
  session: unknown;
  call: (
    details: unknown,
    callback: (response: { responseHeaders?: THeaders }) => void
  ) => void;
} => {
  let handler: THandler | null = null;

  return {
    session: {
      webRequest: {
        onHeadersReceived: (fn: THandler) => {
          handler = fn;
        }
      }
    },
    call: (details, callback) => {
      if (!handler) throw new Error('the header handler was not registered');
      handler(details, callback as (response: unknown) => void);
    }
  };
};

const startServer = async (headers: THeaders): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer((_request, response) => {
      for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
      }
      response.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const portOf = (server: Server): number =>
  (server.address() as { port: number }).port;

describe('the client freshness', () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer({ [SERVER_VERSION_HEADER]: '0.0.55' });
  });

  afterAll(() => {
    server.close();
  });

  it('reads the version of the server behind a client url', async () => {
    const version = await readServerVersion(`http://127.0.0.1:${portOf(server)}`);

    expect(version).toBe('0.0.55');
  });

  it('reports no version when the server cannot be reached', async () => {
    const version = await readServerVersion('http://127.0.0.1:1');

    expect(version).toBeNull();
  });

  it('reports no version for an address that is not a url', async () => {
    expect(await readServerVersion('not a url')).toBeNull();
  });

  it('keeps the document of the client out of the cache', () => {
    const { session, call } = fakeSession();

    keepClientDocumentFresh(session as never);

    const mainFrame: unknown[] = [];
    call(
      { resourceType: 'mainFrame', responseHeaders: { 'Cache-Control': 'max-age=60' } },
      (response: { responseHeaders?: THeaders }) => {
        mainFrame.push(response.responseHeaders?.['Cache-Control']);
      }
    );

    expect(mainFrame).toEqual(['no-store']);
  });

  it('leaves the assets of the client in the cache', () => {
    const { session, call } = fakeSession();

    keepClientDocumentFresh(session as never);

    const asset: unknown[] = [];
    call(
      { resourceType: 'script', responseHeaders: { 'Cache-Control': 'max-age=31536000' } },
      (response: { responseHeaders?: THeaders }) => {
        asset.push(response.responseHeaders?.['Cache-Control']);
      }
    );

    expect(asset).toEqual(['max-age=31536000']);
  });
});
