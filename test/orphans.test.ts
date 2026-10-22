import { describe, expect, it } from 'vitest';
import {
  isPreviousInstanceMain,
  isStaleHelper,
  parseStat,
  type ProcessSnapshot
} from '../src/main/orphans';

const APP_DIR = '/home/user/.local/opt/dodecagon-desktop/app/1234-1700000000';

const process = (overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot => ({
  pid: 4242,
  exePath: `${APP_DIR}/dodecagon-desktop`,
  cmdline: `${APP_DIR}/dodecagon-desktop --type=renderer`,
  ppid: 1165,
  startTime: 500,
  ...overrides
});

describe('parseStat', () => {
  it('reads the parent pid and the start time out of a real stat line', () => {
    const line =
      '3347669 (cat) R 3347668 3347668 3347668 0 -1 4194304 120 0 0 0 0 0 0 0 20 0 1 0 96894318 6422528 530';

    expect(parseStat(line)).toEqual({ ppid: 3347668, startTime: 96894318 });
  });

  it('keeps the fields apart when the command name contains a parenthesis', () => {
    const line =
      '3347669 (weird)name) R 3347668 3347668 3347668 0 -1 4194304 120 0 0 0 0 0 0 0 20 0 1 0 96894318 0';

    expect(parseStat(line)).toEqual({ ppid: 3347668, startTime: 96894318 });
  });

  it('returns null for a line it cannot read', () => {
    expect(parseStat('')).toBeNull();
    expect(parseStat('3347669 (cat) R')).toBeNull();
  });
});

describe('isStaleHelper', () => {
  const context = { appDir: APP_DIR, startTime: 1000 };

  it('takes a helper of an earlier instance of the same installation', () => {
    expect(isStaleHelper(process({ startTime: 900 }), context)).toBe(true);
  });

  it('leaves the helpers of this instance alone', () => {
    expect(isStaleHelper(process({ startTime: 1100 }), context)).toBe(false);
  });

  it('leaves the helpers of another installation alone', () => {
    expect(
      isStaleHelper(process({ exePath: '/opt/other/dodecagon-desktop', startTime: 900 }), context)
    ).toBe(false);
  });

  it('leaves the main process alone', () => {
    expect(
      isStaleHelper(
        process({ cmdline: `${APP_DIR}/dodecagon-desktop `, startTime: 900 }),
        context
      )
    ).toBe(false);
  });

  it('takes the crash reporter of an earlier instance, but not one of another application', () => {
    expect(
      isStaleHelper(
        process({
          exePath: `${APP_DIR}/chrome_crashpad_handler`,
          cmdline: `${APP_DIR}/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler`,
          startTime: 900
        }),
        context
      )
    ).toBe(true);

    expect(
      isStaleHelper(
        process({
          exePath: '/opt/google/chrome/chrome_crashpad_handler',
          cmdline: '/opt/google/chrome/chrome_crashpad_handler --monitor-self',
          startTime: 900
        }),
        context
      )
    ).toBe(false);
  });
});

describe('isPreviousInstanceMain', () => {
  const context = { appDir: APP_DIR, startTime: 1000 };

  it('recognises the main process of an earlier instance', () => {
    expect(
      isPreviousInstanceMain(
        process({ cmdline: `${APP_DIR}/dodecagon-desktop `, startTime: 900 }),
        context
      )
    ).toBe(true);
  });

  it('does not mistake a helper for a main process', () => {
    expect(isPreviousInstanceMain(process({ startTime: 900 }), context)).toBe(false);
  });

  it('does not mistake this instance for a previous one', () => {
    expect(
      isPreviousInstanceMain(
        process({ cmdline: `${APP_DIR}/dodecagon-desktop `, startTime: 1100 }),
        context
      )
    ).toBe(false);
  });
});
