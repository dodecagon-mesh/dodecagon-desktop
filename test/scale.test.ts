import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCALE,
  SCALE_STEPS,
  readScale,
  saveScale,
  scaleStep
} from '../src/main/scale';

const settingsPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dodecagon-scale-'));
  return join(dir, 'config.json');
};

describe('the client scale', () => {
  it('walks the steps up and down', () => {
    expect(scaleStep(1, 1)).toBe(1.1);
    expect(scaleStep(1, -1)).toBe(0.9);
    expect(scaleStep(1.25, 1)).toBe(1.5);
    expect(scaleStep(1.25, -1)).toBe(1.1);
  });

  it('stays at the ends of the list', () => {
    expect(scaleStep(SCALE_STEPS[0]!, -1)).toBe(SCALE_STEPS[0]);
    expect(scaleStep(SCALE_STEPS[SCALE_STEPS.length - 1]!, 1)).toBe(
      SCALE_STEPS[SCALE_STEPS.length - 1]
    );
  });

  it('falls back to the default step for an unknown scale', () => {
    expect(scaleStep(1.37, 1)).toBe(1.1);
    expect(scaleStep(1.37, -1)).toBe(0.9);
  });

  it('stores the scale without wiping the other settings', () => {
    const path = settingsPath();
    writeFileSync(path, JSON.stringify({ url: 'https://dodecagon.example.com' }));

    saveScale(path, 1.25);

    expect(readScale(path)).toBe(1.25);
    expect(JSON.parse(readFileSync(path, 'utf8')).url).toBe(
      'https://dodecagon.example.com'
    );
  });

  it('ignores an unknown stored scale', () => {
    const path = settingsPath();
    writeFileSync(path, JSON.stringify({ scale: 2.5 }));

    expect(readScale(path)).toBe(DEFAULT_SCALE);
  });

  it('reports the default scale when nothing is stored', () => {
    expect(readScale(settingsPath())).toBe(DEFAULT_SCALE);
  });
});
