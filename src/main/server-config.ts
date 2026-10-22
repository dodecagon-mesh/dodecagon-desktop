import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type StoredServer = { url?: string; sentryDsn?: string | null };

/**
 * The client used to store its settings under its old name, so an existing installation
 * has its server in a file the renamed app would never look at. The file is copied over
 * once, when the new one is still missing.
 */
export const carryOverLegacySettings = (
  settingsPath: string,
  legacySettingsPath: string
): boolean => {
  if (existsSync(settingsPath)) return false;
  if (!existsSync(legacySettingsPath)) return false;

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    copyFileSync(legacySettingsPath, settingsPath);
    return true;
  } catch {
    return false;
  }
};

/** Read-modify-write: saving one setting must never wipe the other. */
const writeStored = (path: string, patch: StoredServer): void => {
  let current: StoredServer = {};
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as StoredServer;
  } catch {
    current = {};
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
};

/**
 * Accepts what people actually paste: with or without a scheme, trailing slashes, ports,
 * LAN hostnames, IPs. Returns the canonical origin+path or null when it cannot be a server.
 */
export const normalizeServerUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Anything without an explicit `scheme://` is treated as a host, so "dodecagon.example.com"
  // and "nas:4991" both work while "ftp://…" and "javascript:…" still fail validation below.
  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
};

/** Permission URLs must match the server's origin, not a hostname or port prefix. */
export const isServerOrigin = (input: string, origin: string): boolean => {
  if (!origin) return false;
  try {
    return new URL(input).origin === origin;
  } catch {
    return false;
  }
};

export const readServerUrl = (path: string): string | null => {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredServer>;
    return typeof stored.url === 'string' ? normalizeServerUrl(stored.url) : null;
  } catch {
    return null;
  }
};

export const saveServerUrl = (path: string, url: string): void => {
  writeStored(path, { url });
};

/** Reporting stays off until a DSN is stored here, and the environment can still override it. */
export const readSentryDsn = (path: string): string | null => {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredServer;
    return typeof stored.sentryDsn === 'string' && stored.sentryDsn
      ? stored.sentryDsn
      : null;
  } catch {
    return null;
  }
};

export const saveSentryDsn = (path: string, dsn: string | null): void => {
  writeStored(path, { sentryDsn: dsn });
};
