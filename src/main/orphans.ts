import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * A process as the kernel sees it.
 */
export interface ProcessSnapshot {
  pid: number;
  /** Absolute path of the running binary, without the "(deleted)" suffix. */
  exePath: string;
  /** The command line, with its NUL separators turned into spaces. */
  cmdline: string;
  /** The parent pid the kernel knows. */
  ppid: number;
  /** Start time in clock ticks since boot — the only stable identity of a process. */
  startTime: number;
}

/**
 * Where this instance runs, and when it started. Everything the reaper compares against.
 */
export interface ReapContext {
  /** The directory this installation lives in. */
  appDir: string;
  /** The start time of this instance. */
  startTime: number;
}

const CRASHPAD_HANDLER = 'chrome_crashpad_handler';

/**
 * Reads the fields this module needs out of a /proc/<pid>/stat line.
 *
 * The command name may contain spaces and parentheses, so the numeric fields start after the last
 * ")". What is left is the kernel's field 3 (state) first, which puts the parent pid at index 1
 * and the start time at index 19.
 */
export const parseStat = (stat: string): { ppid: number; startTime: number } | null => {
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
  if (!tail) return null;
  const fields = tail.split(/\s+/);
  const ppid = Number(fields[1]);
  const startTime = Number(fields[19]);
  if (!Number.isInteger(ppid) || !Number.isInteger(startTime)) return null;
  return { ppid, startTime };
};

/** Reads one process. Returns null when it is gone, or owned by someone else. */
export const readProcess = (pid: number): ProcessSnapshot | null => {
  let stat: string;
  let exePath: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    exePath = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
  const parsed = parseStat(stat);
  if (!parsed) return null;

  let cmdline = '';
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    // The process is on its way out; the fields read so far still describe it.
  }

  return {
    pid,
    exePath: exePath.replace(/ \(deleted\)$/, ''),
    cmdline,
    ppid: parsed.ppid,
    startTime: parsed.startTime
  };
};

/** Every process this user can see. */
export const listProcesses = (): ProcessSnapshot[] => {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }

  const processes: ProcessSnapshot[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const process = readProcess(Number(entry));
    if (process) processes.push(process);
  }
  return processes;
};

/**
 * Chromium's own processes announce themselves with --type=; the crash reporter carries its own
 * name instead.
 */
export const isHelperProcess = (candidate: ProcessSnapshot): boolean =>
  candidate.cmdline.includes('--type=') || basename(candidate.exePath) === CRASHPAD_HANDLER;

/** The main process of an instance: our own binary, without a --type= marker. */
export const isInstanceMain = (candidate: ProcessSnapshot): boolean =>
  !candidate.cmdline.includes('--type=') && basename(candidate.exePath) !== CRASHPAD_HANDLER;

/**
 * A helper of an earlier instance of this same installation.
 *
 * The installation is matched by directory, not by name: the crash reporter of another application
 * is called chrome_crashpad_handler too. The start time tells the instances apart — a helper that
 * started before this instance belongs to a previous one.
 */
export const isStaleHelper = (candidate: ProcessSnapshot, context: ReapContext): boolean => {
  if (!candidate.exePath) return false;
  if (dirname(candidate.exePath) !== context.appDir) return false;
  if (!isHelperProcess(candidate)) return false;
  return candidate.startTime < context.startTime;
};

/** The main process of an earlier instance of this same installation. */
export const isPreviousInstanceMain = (candidate: ProcessSnapshot, context: ReapContext): boolean => {
  if (!candidate.exePath) return false;
  if (dirname(candidate.exePath) !== context.appDir) return false;
  if (!isInstanceMain(candidate)) return false;
  return candidate.startTime < context.startTime;
};

/**
 * Takes down the helpers that an earlier instance left behind.
 *
 * When the main process is killed outright — a signal no handler can catch — Chromium's helper
 * processes survive it and keep running from the installation. They are of no use to anybody, so
 * they are killed before this instance starts its own.
 */
export const reapStaleHelpers = (log: (...parts: unknown[]) => void = () => {}): number => {
  if (process.platform !== 'linux') return 0;

  const self = readProcess(process.pid);
  if (!self) return 0;

  const context: ReapContext = { appDir: dirname(self.exePath), startTime: self.startTime };
  const processes = listProcesses();

  const previousInstance = processes.find(
    (candidate) => candidate.pid !== self.pid && isPreviousInstanceMain(candidate, context)
  );
  if (previousInstance) {
    // Another instance is still running and still needs its helpers.
    log(`another instance is still running (pid ${previousInstance.pid}): leaving its helpers alone`);
    return 0;
  }

  let reaped = 0;
  for (const candidate of processes) {
    if (candidate.pid === self.pid) continue;
    if (!isStaleHelper(candidate, context)) continue;
    try {
      process.kill(candidate.pid, 'SIGKILL');
      reaped += 1;
      log(`reaped orphaned helper ${candidate.pid}`);
    } catch (error) {
      log(`could not reap orphaned helper ${candidate.pid}:`, error);
    }
  }
  if (reaped > 0) log(`reaped ${reaped} orphaned helper process(es)`);
  return reaped;
};
