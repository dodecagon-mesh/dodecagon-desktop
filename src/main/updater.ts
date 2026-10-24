import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

let pendingVersion: string | null = null;

export type UpdaterHooks = {
  log: (...parts: unknown[]) => void;
  /** Called just before the app is restarted into the new version. */
  beforeInstall: () => void;
};

const githubFeed = (): { provider: 'github'; owner: 'dodecagon-mesh'; repo: 'dodecagon-desktop' } => ({
  provider: 'github',
  owner: 'dodecagon-mesh',
  repo: 'dodecagon-desktop'
});

/** electron-builder records the Linux package type next to the app resources. */
const packageManaged = (): boolean => {
  if (process.platform !== 'linux') return false;
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim() === 'pacman';
  } catch {
    return false;
  }
};

/**
 * Updates come from the release page: the Windows NSIS installer replaces itself in place. The
 * Linux client is an Arch package, so pacman owns its updates and the app never replaces its files.
 */
export const setupAutoUpdates = (hooks: UpdaterHooks): void => {
  if (!app.isPackaged) return;

  const { log } = hooks;
  if (packageManaged()) {
    log('updates are managed by pacman');
    return;
  }
  // Point the updater somewhere else (a local server, a mirror) for testing or self-hosting.
  const feed = process.env.DODECAGON_UPDATE_FEED;
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  else autoUpdater.setFeedURL(githubFeed());

  autoUpdater.logger = {
    info: (...parts: unknown[]) => log('updater:', ...parts),
    warn: (...parts: unknown[]) => log('updater:', ...parts),
    error: (...parts: unknown[]) => log('updater:', ...parts),
    debug: () => {}
  } as unknown as typeof autoUpdater.logger;

  autoUpdater.autoDownload = true;
  // Never install behind the user's back: that relaunches the app and looks like "it will not close".
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => log('checking for updates'));
  autoUpdater.on('update-not-available', () => log('no update available'));
  autoUpdater.on('error', (error: Error) => {
    log(`update check failed: ${error?.message ?? String(error)}`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    pendingVersion = info.version;
    log(`update downloaded: ${info.version}`);
    if (process.env.DODECAGON_UPDATE_NO_PROMPT === '1') {
      log('not prompting: the update installs silently on quit');
      return;
    }
    void (async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Dodecagon ${info.version} has been downloaded`,
        detail: 'Restart to switch to the new version. It will also be applied next time you quit.'
      });
      if (response !== 0) return;
      hooks.beforeInstall();
      autoUpdater.quitAndInstall();
    })();
  });

  void autoUpdater.checkForUpdates().catch((error: Error) => {
    log(`update check failed: ${error?.message ?? String(error)}`);
  });
};

/**
 * Replaces the installed app with a downloaded update without relaunching it, so an explicit quit
 * really quits. Returns false when there is nothing to install.
 */
export const installPendingUpdateSilently = (): boolean => {
  if (pendingVersion === null) return false;

  autoUpdater.quitAndInstall(true, false);
  return true;
};

/** Menu action: check on demand and say what happened. */
export const checkForUpdatesNow = async (log: (...parts: unknown[]) => void): Promise<void> => {
  if (!app.isPackaged) {
    log('update check skipped: this is a development build');
    return;
  }
  if (packageManaged()) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Updates',
      message: 'Dodecagon is installed as a pacman package.',
      detail: 'Update it with `sudo pacman -Syu`; the app does not replace its own files.'
    });
    return;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version ?? 'unknown';
    if (latest === app.getVersion()) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'No updates',
        message: `Dodecagon ${app.getVersion()} is the latest version.`
      });
      return;
    }
    await dialog.showMessageBox({
      type: 'info',
      title: 'Update found',
      message: `Dodecagon ${latest} is downloading`,
      detail: 'You will be asked to restart once it is ready.'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`update check failed: ${message}`);
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Update check failed',
      message,
      detail:
        'Automatic updates work for the Windows installer.'
    });
  }
};
