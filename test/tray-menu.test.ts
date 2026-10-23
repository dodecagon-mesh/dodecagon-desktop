import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { buildTrayMenuTemplate } from '../src/main/tray-menu';

const createActions = () => ({
  showWindow: vi.fn(),
  changeServer: vi.fn(),
  checkForUpdates: vi.fn(),
  quit: vi.fn()
});

// electron hands the click handler the menu item and the window, the tray
// actions ignore both
const click = (item?: MenuItemConstructorOptions) => {
  (item?.click as (() => void) | undefined)?.();
};

describe('the tray menu', () => {
  it('offers a check for updates entry', () => {
    const actions = createActions();
    const template = buildTrayMenuTemplate(actions);
    const entry = template.find((item) => item.label === 'Check for updates…');

    expect(entry).toBeDefined();

    click(entry);

    expect(actions.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('keeps the show, change server and quit entries', () => {
    const actions = createActions();
    const template = buildTrayMenuTemplate(actions);

    expect(template.map((item) => item.label)).toEqual([
      'Show Dodecagon',
      'Change server…',
      'Check for updates…',
      undefined,
      'Quit'
    ]);

    click(template[0]);
    click(template[1]);
    click(template[4]);

    expect(actions.showWindow).toHaveBeenCalledTimes(1);
    expect(actions.changeServer).toHaveBeenCalledTimes(1);
    expect(actions.quit).toHaveBeenCalledTimes(1);
  });
});
