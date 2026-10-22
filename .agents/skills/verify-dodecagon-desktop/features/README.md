# Dodecagon Desktop verification map

This directory is the maintained source for verifying the user-facing behavior of the Dodecagon Desktop app. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build the app first: `bun run build` in the repository root. It bundles `src/` into `dist/` and compiles the Linux portal helper into `native/out/`.
- Launch through the helper so the run stays on a private Xvfb display with a disposable profile: `node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs drive --feature <id>`.
- Require `node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs doctor` to pass before driving. It is read-only.
- Never drive an instance that this run did not start. The app takes a single-instance lock per user profile; an isolated `XDG_CONFIG_HOME` keeps the run from touching the copy the user may have open.
- The app is the only surface this map covers. The Dodecagon web client is a separate repository with its own Vitest and Paper visual suites.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer the stable handles over coordinates and tab order: `#url`, `#submit`, and the `#error` region with `role="alert"` in the connect window.
- Drive the app through the Chrome DevTools Protocol on the Electron debug port. Node 22 and newer provide `fetch` and a global `WebSocket`, so no extra dependency is needed.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run the repository's own harnesses before writing a new one: `bun run test:crash-smoke`, `bash scripts/test-portal-metadata-native.sh`, `bun run selftest`.
- Restore nothing that a run changed in the user's real profile; every run is disposable by construction.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes a screenshot of the app window and the facts read from the live renderer.
- Process proof includes the process output and the app's own `main.log`.
- Record the feature ID and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

| File | What the user gets | Driven by |
| --- | --- | --- |
| [`startup-connect-window.md`](startup-connect-window.md) | The address prompt on the first run | `verify-desktop.mjs drive --feature startup-connect-window` |
| [`connect-server-validation.md`](connect-server-validation.md) | A refused or failed address, with the reason on screen | `verify-desktop.mjs drive --feature connect-server-validation` |
| [`native-portal-helper.md`](native-portal-helper.md) | The chosen monitor or window is the one that gets captured | `bash scripts/test-portal-metadata-native.sh` |
| [`renderer-crash-recovery.md`](renderer-crash-recovery.md) | The client comes back after a renderer crash | `verify-desktop.mjs drive --feature renderer-crash-recovery`, and `bun run test:crash-smoke` where it passes |
| [`audio-isolation-selftest.md`](audio-isolation-selftest.md) | The app's own audio never reaches the viewers | `bun run selftest` |

The first two and the crash recovery are driven through the CDP helper in this repository. The portal helper and the audio isolation use the repository's own harnesses, which already own that ground: a new harness would prove less, not more.

One harness does not pass in a headless environment: `bun run test:crash-smoke` fails under Xvfb with software rendering because the renderer hangs before it can be crashed. The crash recovery feature file records the measured failure and names the recipe that works.

The audio isolation needs more than a headless display: the capture node is chosen through the XDG Desktop Portal, so the selftest only measures anything in an interactive session. Its feature file records what the headless run reports and why that is not a leak verdict.

