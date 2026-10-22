---
name: verify-dodecagon-desktop
description: "Drive the Dodecagon Desktop Electron app the way a user does and capture proof: the startup connect window, server address validation, the Linux portal helper, renderer crash recovery and the audio isolation selftest. Use when changing the desktop client and you need evidence that the app still works, or when a claim about the desktop app was never shown."
---

# Verify Dodecagon Desktop

Dodecagon Desktop is the Electron client in this repository: a main process, a renderer that hosts the Dodecagon web client, and native helpers (a C program that talks to `xdg-desktop-portal` on Linux, C++ capture helpers on Windows). This skill drives the real application and records what a user would see. It is the maintained verification source for this repository — the feature map in `features/` lists every user-facing entry point, and a proof that drives only one convenient entry point is incomplete.

The sibling Dodecagon web client is a separate repository with its own Vitest and Paper visual suites. This skill does not cover it.

## Launch

The app is an Electron bundle, so launch means: build once, then start the app in a private display with a disposable profile.

```bash
cd <repo>
bun run build          # bundles src/ into dist/ and builds native/out/portal-metadata-linux-<arch>
```

`bun run build` is the only supported build: on Linux it also compiles the native portal helper, and a bundle without that binary silently loses the window picker.

For verification runs, always launch through the helper, which owns the isolation:

```bash
node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs drive --feature startup-connect-window
```

The helper starts the app inside a private Xvfb display with its own `XDG_CONFIG_HOME`, so the run never shows a window on the live desktop session and never collides with an instance the user already has running.

To launch it by hand, keep the same three properties — private display, disposable profile, debug port:

```bash
XDG_CONFIG_HOME="$(mktemp -d)" xvfb-run -a ./node_modules/.bin/electron . --remote-debugging-port=9222
```

Ready means: the CDP endpoint answers `GET http://127.0.0.1:9222/json/list` with one page target titled `Dodecagon` pointing at `dist/connect.html`, and `main.log` contains `no server chosen yet, showing the picker`. A running process is not a ready app: the bundle is loaded inside that page target.

## Doctor

Run this first whenever anything looks off. It is read-only and touches no state:

```bash
node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs doctor
```

It reports the Electron version, whether `dist/` is built and newer than `src/`, whether the native helper exists, the Node version, and whether a display is reachable. It fails on the checks that make a drive meaningless (missing Electron, missing or stale bundle, Node below 22, no display) and warns on the ones that only reduce coverage (missing native helper).

## Drive

The harness is the Chrome DevTools Protocol over the Electron debug port. It needs no new dependency: Node 22 and newer ship a global `WebSocket`, and `fetch` covers the HTTP side.

- Stable handles in the connect window: `#url` (server address field), `#submit` (the `Connect` button), `#error` (a `role="alert"` region). Prefer them over coordinates or tab order.
- Read the window with `Runtime.evaluate`, capture with `Page.captureScreenshot`.
- The repository's own harnesses come first for everything they already cover: `bun run test:crash-smoke` for renderer crashes and picker lifecycle, `bash scripts/test-portal-metadata-native.sh` for the Linux portal helper, `bun run selftest` for the audio isolation path.

The helper drives three features directly:

```bash
node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs drive --feature startup-connect-window
node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs drive --feature connect-server-validation
node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs drive --feature renderer-crash-recovery
```

`renderer-crash-recovery` serves a local fixture, crashes the renderer over CDP and proves that the app brings the client back. The repository's `bun run test:crash-smoke` covers more of the crash surface, but it does not pass on a headless Xvfb display with software rendering; the feature file explains the difference and how to report it.

## Evidence

A run writes everything into `<repo>/.verification/<run-id>/`:

| Artifact | What it proves |
| --- | --- |
| `summary.md` | The run outcome, every step with expected and observed, and the artifact list |
| `facts.json` | The window facts read from the live renderer |
| `<feature>.png` | What the user saw at that moment |
| `main.log`, `chromium.log`, `renderer.log` | What the app itself recorded |
| `electron.out` | The process stdout and stderr of the run |
| `doctor.json` | The preconditions that were checked before driving |

Proof standards:

- Exercise the real user path. A unit test, an internal setter or a test-only endpoint is not proof of the user-visible behavior.
- Capture the action and the resulting state, not only the final screen. A window that opened and then showed an error is a different claim from a window that opened.
- Verify side effects next to what is visible: a saved server address lands in the profile's `config.json`, a native helper emits its JSON events on stdout, a crash-recovery run leaves the app process alive.
- The evidence directory is gitignored. Keep runs out of commits; keep the artifacts on disk when a reviewer needs them.

## Cleanup

The helper removes the disposable profile and quits only what it started (it holds the process group it spawned and closes the browser over CDP). It never kills an instance by process name, and it never deletes the evidence directory.

```bash
node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs cleanup
```

`cleanup` removes leftover `dodecagon-verify-*` profiles in the temp directory from runs that were interrupted. Run it after a failed attempt so a broken run does not strand a profile or a port.

## Helpers

- `scripts/verify-desktop.mjs` — the verification helper. Subcommands: `doctor` (read-only preconditions), `drive --feature <id>` (launch, drive, capture, clean up), `cleanup` (remove stray profiles). It is executable; run it with `node` and pass `--repo <path>` when the repository is not the parent of this skill folder.

Keep the feature map honest as the app changes: `/maintain-verification-skill` re-reads the app, updates the map, and says which proofs are now stale.
