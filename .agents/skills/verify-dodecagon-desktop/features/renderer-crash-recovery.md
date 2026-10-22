# Renderer crash recovery

If the renderer of the Dodecagon Desktop client crashes, the app must come back on its own: the user should not have to quit and relaunch it, and a client hidden in the tray must not pop up a window after the recovery. After three crashes within one minute the app stops retrying and tells the user to reload manually.

## Sub-features

- `crash-recovers-client` reloads the active route after a renderer crash and the client works again.
- `crash-keeps-tray-hidden` recovers a window that was hidden in the tray without showing it.
- `crash-pauses-after-three` stops automatic recovery after three crashes inside one minute.
- `crash-notifies-user` shows a desktop notification when the recovery is paused.
- `crash-survives-connect-window` recovers when the crash happens while the connect window is loading, including the rejected load that Electron reports.

## How to get to it (user POV)

- Use the client until something makes the renderer process die — a heavy page, a GPU crash, an OOM kill.
- Observe that the app comes back by itself, and that the tray keeps the client available.
- Repeat crashes quickly to reach the point where the app gives up and asks for a manual reload.

## Driving it with verify-desktop.mjs

Preconditions:

- `bun run build` has run in the repository root.
- `node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs doctor` reports `ready to drive`.
- The run uses its own `XDG_CONFIG_HOME` and its own local HTTP fixture, so the client route has a page to render and the run needs no network.

- **Start the app on the client route.** Run `node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs drive --feature renderer-crash-recovery`. The helper serves a local fixture, starts the app with `--url=<fixture>` and waits until the renderer is on that page.
- **Crash the renderer.** The helper sends the CDP `Page.crash` command, which kills the renderer of the running app. The command answers `Target crashed`; that rejection is the expected outcome, not a failure.
- **The app notices.** The copied `main.log` contains `renderer gone: { webContentsId: 1, reason: 'crashed', exitCode: 133 }`. The step passes only when the reason is `crashed`.
- **The app recovers.** The same log then contains `recovering crashed client` and a second `client loaded: <fixture url>`. The app reloads the active route instead of destroying the window, which is why a tray-hidden client stays hidden.
- **The renderer is back.** The helper reconnects to the page target and reads the fixture element; the step passes when the page answers `alive`.
- **Proof.** The run writes `<repo>/.verification/<run-id>/renderer-crash-recovery.png` (the recovered page), `facts.json`, `main.log` and `summary.md`. The evidence must survive cleanup.

## The repository's own harness

`test/renderer-crash-smoke.cjs` is the canonical harness for this feature and covers more than the CDP recipe does: the crash loop, the readiness crash, the three picker modes and the two interrupted picker loads. Run it before writing anything new:

```bash
bun run test:crash-smoke
```

On a headless Xvfb display with software rendering it does not pass, and the failure is not a recovery defect. Measured on 2026-10-22 in this repository: all eight modes fail, the baseline and `--crash-loop` report `crashed renderer never reloaded the client` and `recovery stopped before the allowed three attempts`, the other six report `smoke test startup timed out`, and Chromium logs `FATAL:content/child/child_thread_impl.cc:380] Crashing because hung`. The app's own `main.log` shows no `renderer gone:` line in those runs, so the main process never receives the event that a CDP-triggered crash produces. The CDP recipe above crashes the same renderer through the same recovery path and passes, so the difference is the trigger: `forcefullyCrashRenderer()` on a renderer that is already hung under software rendering.

Two consequences for a verification report:

- The CDP recipe is the proof that works in this environment. Say which one produced the evidence.
- CI does not run this harness. `.github/workflows/build.yml` runs `bun run typecheck`, `bunx vitest run` and `bun run test:native-portal` only, so the harness has no automated coverage and its state is not visible from the checks on a pull request.

## Gotchas

- The app's own recovery is in `src/main/index.ts`: it reloads the active route in the existing window instead of destroying it, so a tray-hidden client stays hidden. A test that only checks "the window is back" would also pass on a visible window and would miss that guarantee.
- The pause threshold is three crashes within 60 seconds, tracked per window in the main process. Crashing the renderer faster than the threshold is what triggers it; a test that waits a minute between crashes will never reach the pause.
- Electron can leave `loadFile` pending after a renderer crash. The repository harness handles this by racing the native load against the `render-process-gone` signal — that race is the regression being guarded, so do not "simplify" it by only awaiting the native promise.
- The CDP `Page.crash` command always answers with an error. The helper swallows exactly that error; a different error means the crash never happened.
- The crashed target is dead. Reconnect through `GET /json/list` after the crash instead of reusing the old websocket, and take the screenshot after the reconnect — the old session cannot capture anything.
- The picker modes stub `BrowserWindow.prototype.loadFile` and `forcefullyCrashRenderer`. They test the app's real code path through a patched Electron API, which is a different kind of proof from driving the shipped app: report them as harness results, not as end-user observations.
- The harness overwrites `app.setPath('userData')` with a temporary directory and sets `DODECAGON_TAP_NAME`. Without that it would collide with a real running instance through the single-instance lock.
- Run the crash modes under Xvfb. A renderer crash on the live session flashes a broken window and can steal focus.
- `ulimit -c 0` is recommended for the harness runs so a crash does not leave core dumps in the repository.
