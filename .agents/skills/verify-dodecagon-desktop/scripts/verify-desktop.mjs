#!/usr/bin/env node
// Verification helper for the Dodecagon Desktop Electron app.
//
//   verify-desktop.mjs doctor   [--repo PATH] [--json]
//   verify-desktop.mjs drive    [--repo PATH] [--feature <id>] [--evidence DIR] [--display :N] [--timeout SEC]
//   verify-desktop.mjs cleanup  [--repo PATH]
//
// The app is launched inside a private Xvfb display with its own XDG_CONFIG_HOME,
// so it never touches the live desktop session and never shares state with a
// running instance. Evidence is written under <repo>/.verification/<run-id>/ and
// survives cleanup; the throwaway profile does not.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = import.meta.dirname;
const DEFAULT_REPO = resolve(HERE, '..', '..', '..', '..');
const APP_NAME = 'dodecagon-desktop';
const CONNECT_TITLE = 'Dodecagon';

const args = process.argv.slice(2);
const command = args[0] ?? 'doctor';
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const repo = resolve(flag('repo', DEFAULT_REPO));
const evidenceRoot = flag('evidence', join(repo, '.verification'));
const feature = flag('feature', 'startup-connect-window');
const timeoutSec = Number(flag('timeout', '60'));
const explicitDisplay = flag('display', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- doctor ----

const check = (id, ok, detail, hard = true) => ({ id, ok: Boolean(ok), detail, hard });

const readElectronVersion = () => {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'node_modules', 'electron', 'package.json'), 'utf8'));
    return pkg.version ?? null;
  } catch { return null; }
};

const doctor = () => {
  const checks = [];
  const electronBin = join(repo, 'node_modules', '.bin', 'electron');
  checks.push(check('electron-installed', existsSync(electronBin), electronBin));
  checks.push(check('electron-version', readElectronVersion() !== null, `electron ${readElectronVersion() ?? 'unknown'}`));

  const mainJs = join(repo, 'dist', 'main.js');
  const connectHtml = join(repo, 'dist', 'connect.html');
  checks.push(check('bundle-built', existsSync(mainJs) && existsSync(connectHtml), 'dist/main.js and dist/connect.html exist'));
  if (existsSync(mainJs) && existsSync(join(repo, 'src', 'main', 'index.ts'))) {
    const fresh = statSync(mainJs).mtimeMs >= statSync(join(repo, 'src', 'main', 'index.ts')).mtimeMs;
    checks.push(check('bundle-fresh', fresh, fresh ? 'bundle is newer than src/main' : 'bundle is stale: run `bun run build`'));
  }

  const helper = join(repo, 'native', 'out', `portal-metadata-linux-${process.arch}`);
  const helperOk = existsSync(helper) && statSync(helper).size > 0;
  checks.push(check('native-helper', helperOk, helperOk ? helper : 'missing: run `bun run build` on Linux', false));

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check('node-version', nodeMajor >= 22, `node ${process.versions.node} (global WebSocket needs >= 22)`));

  const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
  const displayOk = Boolean(explicitDisplay) || xvfb.status === 0;
  checks.push(check('display', displayOk, explicitDisplay ? `using display ${explicitDisplay}` : xvfb.status === 0 ? 'xvfb-run available' : 'no xvfb-run and no --display', !explicitDisplay && xvfb.status !== 0));

  try {
    mkdirSync(evidenceRoot, { recursive: true });
    checks.push(check('evidence-dir', true, evidenceRoot));
  } catch (error) {
    checks.push(check('evidence-dir', false, String(error)));
  }

  const failed = checks.filter((c) => !c.ok && c.hard);
  return { repo, checks, ok: failed.length === 0, failed: failed.map((c) => c.id) };
};

// ------------------------------------------------------------------ cdp -----

const cdpConnect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((resolvePromise, rejectPromise) => {
    ws.addEventListener('open', resolvePromise);
    ws.addEventListener('error', () => rejectPromise(new Error(`cdp connect failed: ${wsUrl}`)));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: ok, reject: bad } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? bad(new Error(JSON.stringify(message.error))) : ok(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const messageId = ++id;
    pending.set(messageId, { resolve: ok, reject: bad });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  return { send, close: () => ws.close() };
};

const freePort = () => new Promise((ok, bad) => {
  const probe = createServer();
  probe.on('error', bad);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => ok(port));
  });
});

const waitForTarget = async (port, deadline) => {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('CDP target did not appear in time');
};

// ---------------------------------------------------------------- drive -----

const readFacts = async (cdp) => {
  const result = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => ({
      title: document.title,
      location: location.href,
      form: Boolean(document.querySelector('#form')),
      urlField: Boolean(document.querySelector('#url')),
      submitLabel: document.querySelector('#submit')?.textContent?.trim() ?? null,
      submitDisabled: document.querySelector('#submit')?.disabled ?? null,
      errorRole: document.querySelector('#error')?.getAttribute('role') ?? null,
      errorText: document.querySelector('#error')?.textContent?.trim() ?? null,
      body: document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 300) ?? null
    }))()`
  });
  return result.result?.value ?? null;
};

const screenshot = async (cdp, path) => {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
};

const submitUrl = async (cdp, value) => {
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.getElementById('url');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('submit').click();
      return true;
    })()`
  });
};

const waitForError = async (cdp, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let facts = await readFacts(cdp);
  while (Date.now() < deadline && !(facts?.errorText)) {
    await sleep(250);
    facts = await readFacts(cdp);
  }
  return facts;
};

const driveConnectValidation = async (cdp) => {
  const steps = [];

  // A scheme the app refuses is rejected locally: no network is touched.
  await submitUrl(cdp, 'ftp://example.com');
  let facts = await waitForError(cdp, 8000);
  steps.push({
    step: 'submit-refused-scheme',
    expected: 'the error region asks for a usable http(s) address and the form stays usable',
    observed: facts?.errorText ?? '(no error text)',
    errorRole: facts?.errorRole ?? null,
    submitDisabled: facts?.submitDisabled ?? null,
    pass: /Enter an address such as/.test(facts?.errorText ?? '') && facts?.submitDisabled === false
  });

  // A host that does not resolve fails on the network and the app reloads the
  // connect window with the reason in the query string.
  await submitUrl(cdp, 'not-a-url');
  facts = await waitForError(cdp, 15000);
  steps.push({
    step: 'submit-unreachable-host',
    expected: 'the unreachable server is reported in the error region and the form stays usable',
    observed: facts?.errorText ?? '(no error text)',
    location: facts?.location ?? null,
    errorRole: facts?.errorRole ?? null,
    submitDisabled: facts?.submitDisabled ?? null,
    pass: Boolean(facts?.errorText) && facts?.errorRole === 'alert' && facts?.submitDisabled === false
  });

  return { facts, steps };
};

const driveStartup = async (cdp) => {
  const facts = await readFacts(cdp);
  const steps = [{
    step: 'connect-window-visible',
    expected: `${CONNECT_TITLE} window with a server address field and a Connect button`,
    observed: `${facts?.title ?? '?'} | field=${facts?.urlField} | button=${facts?.submitLabel}`,
    pass: facts?.title === CONNECT_TITLE && facts?.urlField === true && facts?.submitLabel === 'Connect'
  }];
  return { facts, steps };
};

// The client route needs a page to render. A local fixture keeps the run offline
// and gives the renderer something alive to lose and get back.
const FIXTURE_HTML = '<!doctype html><meta charset="utf-8"><title>Dodecagon crash fixture</title><body><div id="fixture">alive</div></body>';

const startFixture = async () => {
  const server = createHttpServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(FIXTURE_HTML);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
};

const readMainLog = (profile) => {
  const base = join(profile, APP_NAME, 'logs');
  if (!existsSync(base)) return '';
  const sessions = readdirSync(base).sort();
  if (!sessions.length) return '';
  const file = join(base, sessions[sessions.length - 1], 'main.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

/**
 * Crash the renderer of the running client and prove the app brought it back.
 * The crash is triggered over CDP, so the run needs no test hook in the app.
 */
const driveRendererCrashRecovery = async (cdp, port, profile, evidenceDir) => {
  const steps = [];

  const deadline = Date.now() + 30000;
  let loaded = false;
  while (Date.now() < deadline && !loaded) {
    await sleep(500);
    const result = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => null);
    loaded = Boolean(result?.result?.value?.startsWith('http://127.0.0.1:'));
  }
  steps.push({
    step: 'client-route-loaded',
    expected: 'the client route is loaded in the renderer',
    observed: loaded ? 'the renderer is on the local fixture' : 'the renderer never reached the fixture',
    pass: loaded
  });

  const before = readMainLog(profile);
  try {
    await cdp.send('Page.crash');
  } catch {
    // The command answers with "Target crashed": the crash is the expected outcome.
  }

  let recovered = false;
  let logLines = [];
  const recoverDeadline = Date.now() + 20000;
  while (Date.now() < recoverDeadline && !recovered) {
    await sleep(500);
    const after = readMainLog(profile);
    const added = after.slice(before.length);
    logLines = added.split('\n').filter((line) => /renderer gone:|recovering crashed client|client loaded:/.test(line));
    recovered = /recovering crashed client/.test(added) && /client loaded:/.test(added);
  }
  const after = readMainLog(profile);
  const added = after.slice(before.length);
  const gone = added.split('\n').find((line) => /renderer gone:/.test(line)) ?? '(no renderer gone line)';
  steps.push({
    step: 'app-noticed-the-crash',
    expected: 'the main process reports the renderer gone',
    observed: gone.trim(),
    pass: /renderer gone:.*reason: 'crashed'/.test(added)
  });
  steps.push({
    step: 'app-recovered-the-client',
    expected: 'the app reloads the client route after the crash',
    observed: logLines.join(' | ') || '(no recovery lines)',
    pass: recovered
  });

  // The crashed target is dead; reconnect to the page and look at it again.
  let alive = null;
  let target = null;
  try {
    target = await waitForTarget(port, Date.now() + 15000);
    const again = await cdpConnect(target.webSocketDebuggerUrl);
    const result = await again.send('Runtime.evaluate', {
      expression: 'document.getElementById("fixture")?.textContent ?? "(no fixture)"',
      returnByValue: true
    }).catch(() => null);
    alive = result?.result?.value ?? null;
    await screenshot(again, join(evidenceDir, 'renderer-crash-recovery.png'));
    again.close();
  } catch (error) {
    alive = `(no usable target: ${error})`;
  }
  steps.push({
    step: 'renderer-alive-after-crash',
    expected: 'the renderer serves the page again after the recovery',
    observed: String(alive),
    pass: alive === 'alive'
  });

  return { facts: { alive, logLines }, steps };
};

const runDrive = async () => {
  const report = doctor();
  mkdirSync(evidenceRoot, { recursive: true });
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const evidenceDir = join(evidenceRoot, runId);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'doctor.json'), JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('doctor failed:', report.failed.join(', '));
    return { ok: false, runId, evidenceDir, report };
  }

  const profile = join(tmpdir(), `dodecagon-verify-${process.pid}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const port = await freePort();
  const electronBin = join(repo, 'node_modules', '.bin', 'electron');

  // The crash-recovery feature needs a live client route to crash; the connect
  // window has no renderer state worth losing.
  const fixture = feature === 'renderer-crash-recovery' ? await startFixture() : null;

  const env = { ...process.env };
  delete env.WAYLAND_DISPLAY;
  delete env.XDG_SESSION_TYPE;
  delete env.DISPLAY;
  env.XDG_CONFIG_HOME = profile;
  env.DODECAGON_PICKER = 'inapp';
  env.DODECAGON_DEBUG_APP_QUIT_AFTER = String(Math.max(timeoutSec, 90));

  const useXvfb = !explicitDisplay;
  const launcher = useXvfb ? 'xvfb-run' : electronBin;
  const appArgs = fixture ? ['.', `--url=${fixture.url}`, `--remote-debugging-port=${port}`] : ['.', `--remote-debugging-port=${port}`];
  const launcherArgs = useXvfb ? ['-a', electronBin, ...appArgs] : appArgs;

  const logFd = openSync(join(evidenceDir, 'electron.out'), 'w');
  const child = spawn(launcher, launcherArgs, {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });

  const steps = [];
  let target = null;
  let cdp = null;
  try {
    target = await waitForTarget(port, Date.now() + timeoutSec * 1000);
    cdp = await cdpConnect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const driven = feature === 'connect-server-validation'
      ? await driveConnectValidation(cdp)
      : feature === 'renderer-crash-recovery'
        ? await driveRendererCrashRecovery(cdp, port, profile, evidenceDir)
        : await driveStartup(cdp);

    steps.push(...driven.steps);
    writeFileSync(join(evidenceDir, 'facts.json'), JSON.stringify(driven.facts, null, 2));
    // The crashed target is gone after a crash run; the screenshot is taken there.
    if (feature !== 'renderer-crash-recovery') {
      await screenshot(cdp, join(evidenceDir, `${feature}.png`));
    }

    const logDir = join(profile, APP_NAME, 'logs');
    if (existsSync(logDir)) {
      for (const session of readdirSync(logDir)) {
        for (const file of readdirSync(join(logDir, session))) {
          copyFileSync(join(logDir, session, file), join(evidenceDir, file));
        }
      }
    }
  } catch (error) {
    steps.push({ step: 'drive', expected: 'the app exposes its window over CDP', observed: String(error), pass: false });
  } finally {
    if (cdp) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        if (version.webSocketDebuggerUrl) {
          const browser = await cdpConnect(version.webSocketDebuggerUrl);
          // The browser goes away before it answers, so never wait for the reply.
          await Promise.race([browser.send('Browser.close').catch(() => {}), sleep(3000)]);
          browser.close();
        }
      } catch { /* fall through to the signal path */ }
      cdp.close();
    }
    await sleep(1200);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await sleep(600);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    closeSync(logFd);
    if (fixture) fixture.server.close();
  }

  rmSync(profile, { recursive: true, force: true });

  const artifacts = readdirSync(evidenceDir);
  const proofSurvived = artifacts.includes(`${feature}.png`) || artifacts.includes('facts.json');
  const pass = steps.length > 0 && steps.every((s) => s.pass) && proofSurvived;

  const summary = [
    `# Dodecagon Desktop verification run ${runId}`,
    '',
    `- feature: ${feature}`,
    `- profile: isolated XDG_CONFIG_HOME (removed during cleanup)`,
    `- display: ${useXvfb ? 'private Xvfb display' : explicitDisplay}`,
    `- port: ${port}`,
    `- result: ${pass ? 'PASS' : 'FAIL'}`,
    '',
    '## Steps',
    ...steps.map((s) => `- ${s.pass ? 'PASS' : 'FAIL'} — ${s.step}: expected ${s.expected}; observed ${s.observed}`),
    '',
    '## Artifacts',
    ...artifacts.map((a) => `- ${a}`)
  ].join('\n');
  writeFileSync(join(evidenceDir, 'summary.md'), `${summary}\n`);

  console.log(summary);
  return { ok: pass, runId, evidenceDir, steps, report };
};

// -------------------------------------------------------------- cleanup -----

const cleanup = () => {
  const removed = [];
  if (existsSync(evidenceRoot)) {
    for (const entry of readdirSync(evidenceRoot)) {
      if (entry.startsWith('run-') && entry.includes('profile')) {
        rmSync(join(evidenceRoot, entry), { recursive: true, force: true });
        removed.push(entry);
      }
    }
  }
  const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith('dodecagon-verify-'));
  for (const name of leftovers) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  console.log(JSON.stringify({ removed, tempProfilesRemoved: leftovers }, null, 2));
  return removed.length + leftovers.length;
};

if (command === 'doctor') {
  const report = doctor();
  console.log(has('json') ? JSON.stringify(report, null, 2) : [
    `repo: ${report.repo}`,
    ...report.checks.map((c) => `${c.ok ? 'ok  ' : (c.hard ? 'FAIL' : 'warn')} ${c.id}: ${c.detail}`),
    `result: ${report.ok ? 'ready to drive' : 'not ready'}`
  ].join('\n'));
  process.exit(report.ok ? 0 : 1);
} else if (command === 'drive') {
  const result = await runDrive();
  process.exit(result.ok ? 0 : 1);
} else if (command === 'cleanup') {
  cleanup();
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
