# Audio isolation selftest

The voice channel of Dodecagon Desktop must never reach the people watching the stream. The app plays its own audio into the capture device and then proves two things at once: the viewer's audio is captured, and the app's own audio is not. The selftest does that measurement inside the app itself.

## Sub-features

- `audio-captures-other-apps` proves that audio from an unrelated process on the machine reaches the capture device.
- `audio-excludes-own-process` proves that no stream from the app's own process tree is ever linked into the capture.
- `audio-excludes-own-track` proves that the app's own track is absent from the captured mix.
- `audio-keeps-default-sink` proves that the capture node did not become the user's default output device.
- `audio-no-legacy-modules` proves that no leftover virtual-sink module from an older approach is still loaded.
- `audio-selftest-report` produces a machine-readable report of the measured bands.

## How to get to it (user POV)

- Share a screen or window from the Dodecagon Desktop client on Linux and play audio from another application. The viewer hears that application; the client never hears its own voice output through the capture.
- The user never runs the selftest. It exists so a maintainer can prove the guarantee instead of asserting it.

## Driving it with the repository harness

Preconditions:

- Linux with PipeWire. The selftest refuses to run elsewhere with `selftest needs Linux/PipeWire`.
- `pactl` and `parec` (PulseAudio or PipeWire pulse shim) are on `PATH`.
- The app is built: `bun run build`.
- The run needs a real audio session *and* a real source selection. The capture node is chosen through the XDG Desktop Portal, so the person has to pick a source in the portal dialog. A headless display is not enough.
- Run it under Xvfb only if the portal dialog itself is not needed; on a headless display the source selection is what fails, not the display.

- **Run the selftest.** Run `bun run selftest`, which builds and then starts the app with `--selftest`. The app opens its own window, plays a 997 Hz tone through the app's process tree, and plays a 1493 Hz tone from an unrelated `paplay` process.
- **Read the verdict.** The app logs one line: `selftest PASS …` or `selftest FAIL …`, followed by `capture[pc=… app=…]`, `tapped[… pid(s), own=…]`, `control[app=…]` and `injected[pc=… app=…]`. The step passes only when the line says `PASS`.
- **The own-process check is the core.** The report field `own` in `tapped[… own=…]` must be `0`. A non-zero value means the app's own audio was linked into the capture, and the run fails regardless of the tone levels.
- **The leak threshold is `0.02`.** The app tone amplitude in the capture and in the injected track must stay at or below `0.02`, while the other application's tone must be at or above `0.15`. The failure log prints the band series so a failed run shows which side moved.
- **Proof.** Copy the `selftest PASS …` line, the app log and the report into `<repo>/.verification/<run-id>/`. The report is returned by `runSelftest` as `{ capture, control, injected, linked, pass, failures }`.

## Where it cannot run

Measured on 2026-10-22 in this repository on a headless Xvfb display with working PipeWire: the selftest does not reach its measurement and the app exits with code 1. The log shows the chain:

```
Error occurred in handler for 'capture:acquire': Error: no Linux audio source was selected
page capture mode: {"mode":"system-audio-unavailable"}
WARNING: isolated audio capture is unavailable; this share stays video-only.
startup failed: [Error: the display-media patch returned no audio track]
shutting down (code 1)
```

The capture node is selected through the portal, and a headless run never completes that selection, so the display-media patch returns a stream without an audio track and the measurement is skipped. Report this as an unmet precondition, not as a leak or a pass. The audio session itself is left unchanged: the same sinks, the same default sink, no leftover `dodecagon_capture` module or source.

## Gotchas

- The selftest writes into the real audio session: it creates a capture node, plays tones and reads monitors. It is not a sandboxed test. Run it on a machine whose audio the user is not currently relying on.
- It changes the system default sink check, not the default sink itself, but it does load and unload PipeWire modules. A leftover module from an aborted run can make the next run fail with `legacy virtual-sink modules are still loaded`.
- The unrelated tone is started with `setsid` on purpose. Without detaching, the `paplay` process would be a child of the app, the tap would correctly treat it as own audio, and the whole measurement would be meaningless.
- If another instance of the app is running and playing audio on the same machine, the selftest logs a note and skips the tone-based leak check, because that other instance's playback is legitimately captured. The own-process check still runs.
- The `control` band proves the app tone was audible at all. A run where `control[app=…]` is below `0.15` failed for a setup reason, not for a leak; do not report it as a passing isolation result.
- The selftest needs a real display as well as real audio. It writes its own page into the temporary directory and injects a patched `getDisplayMedia`; the measurement happens in the renderer.
- The measurement settles on the middle windows only: the first and last window are dropped because the tones start and stop inside them. Comparing the first window against the threshold gives false failures.
