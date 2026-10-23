import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The scale steps of the client, in the order the menu walks them. */
export const SCALE_STEPS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

export const DEFAULT_SCALE = 1;

const isStep = (value: number): boolean =>
  SCALE_STEPS.some((step) => Math.abs(step - value) < 0.001);

/** The next scale step in the given direction, the ends of the list stay where they are. */
export const scaleStep = (current: number, direction: 1 | -1): number => {
  const index = SCALE_STEPS.findIndex((step) => Math.abs(step - current) < 0.001);
  const from = index === -1 ? SCALE_STEPS.indexOf(DEFAULT_SCALE) : index;
  const next = Math.min(Math.max(from + direction, 0), SCALE_STEPS.length - 1);
  return SCALE_STEPS[next]!;
};

/** The scale of the client, the default one when nothing is stored or the stored value is unknown. */
export const readScale = (path: string): number => {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { scale?: unknown };
    return typeof stored.scale === 'number' && isStep(stored.scale)
      ? stored.scale
      : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
};

/** Read-modify-write: saving the scale must never wipe the server or the dsn. */
export const saveScale = (path: string, scale: number): void => {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    current = {};
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, scale }, null, 2)}\n`);
};
