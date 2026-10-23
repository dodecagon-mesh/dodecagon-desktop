import type { Session } from 'electron';

/** The header the server sends its own version in. */
export const SERVER_VERSION_HEADER = 'x-dodecagon-version';

/** The version of the server behind a client url, null when it cannot be read. */
export const readServerVersion = async (url: string): Promise<string | null> => {
  try {
    const origin = new URL(url).origin;
    const response = await fetch(`${origin}/info`, { method: 'GET' });

    if (!response.ok) return null;

    return response.headers.get(SERVER_VERSION_HEADER);
  } catch {
    return null;
  }
};

/**
 * The document of the client must never come from the cache, the hashed assets still can.
 * A published client is a new document, and a stale one would keep the old code alive.
 */
export const keepClientDocumentFresh = (target: Session): void => {
  target.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cache-Control': 'no-store'
      }
    });
  });
};
