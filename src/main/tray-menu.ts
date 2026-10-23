import type { MenuItemConstructorOptions } from 'electron';

export type TTrayMenuActions = {
  showWindow: () => void;
  changeServer: () => void;
  checkForUpdates: () => void;
  quit: () => void;
};

/** The menu of the system tray icon. */
export const buildTrayMenuTemplate = (
  actions: TTrayMenuActions
): MenuItemConstructorOptions[] => [
  { label: 'Show Dodecagon', click: actions.showWindow },
  { label: 'Change server…', click: actions.changeServer },
  { label: 'Check for updates…', click: actions.checkForUpdates },
  { type: 'separator' },
  { label: 'Quit', click: actions.quit }
];
