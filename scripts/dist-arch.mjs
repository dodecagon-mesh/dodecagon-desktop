import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';

if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
  throw new Error('dist:arch packages only the current supported Linux host architecture.');
}

execFileSync('electron-builder', ['--linux', 'pacman', `--${process.arch}`, '--publish', 'never'], { stdio: 'inherit' });

// Old packages stay in release/ between local builds; report the one just written.
const packages = readdirSync('release')
  .filter((name) => name.endsWith('.pacman'))
  .map((name) => `release/${name}`)
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
if (packages.length === 0) {
  throw new Error('electron-builder produced no .pacman package');
}
const built = packages[0];
const size = statSync(built).size;
console.log(`built ${built} (${(size / 1024 / 1024).toFixed(0)} MiB)`);
console.log(`install: sudo pacman -U ${built}`);
