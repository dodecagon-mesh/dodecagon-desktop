# Native portal helper (Linux)

When a user picks what to share on Linux, the client asks the XDG Desktop Portal for a screen or a window. The portal itself does not report which physical source the user chose, so the app runs a small native helper that watches the portal's own D-Bus traffic and reports the real selection. The user-visible behavior is that the chosen source — a specific monitor or a specific window — is the one that actually gets captured.

## Sub-features

- `portal-helper-builds` compiles `native/linux/portal-metadata.c` into `native/out/portal-metadata-linux-<arch>` on Linux.
- `portal-helper-ready` emits `{"event":"ready",...}` with the portal and backend owners and the backend PID once it is attached to D-Bus.
- `portal-helper-start` emits `{"event":"start","cookie",...}` for every `Start` call the app itself made.
- `portal-helper-selection` emits `{"event":"selection","cookie","sourceType","pipewireSerial",...}` with the monitor `output` for a screen and the `windowClass` for a window.
- `portal-helper-invalid` emits `{"event":"invalid","reason":...}` and stops when the traffic is malformed, when the portal owner changed mid-flight, or when the reply does not belong to the request the app made.
- `portal-helper-ownership` refuses a selection whose requester is not this app, so another process on the machine cannot inject a source.

## How to get to it (user POV)

- Start a screen or window share from the Dodecagon Desktop client on Linux and pick a source in the portal dialog.
- The app then captures exactly that source. The user never sees the helper; they see the portal picker and the captured content.

## Driving it with the repository harness

Preconditions:

- The build tools are present: `cc` and `pkg-config` with `libsystemd` development headers. The helper links against `libsystemd` for `sd-bus`.
- A D-Bus session is not needed from the machine: the harness starts a private bus itself.

- **Build the helper.** Run `bun run build` in the repository root. It calls `scripts/build-linux-native.mjs`, which compiles the C source with `-Wall -Wextra -Werror` and prints `Built native/out/portal-metadata-linux-<arch> against libsystemd`. The step passes when that binary exists and is executable.
- **Run the protocol scenarios.** Run `bash scripts/test-portal-metadata-native.sh`. It compiles the helper with test counters enabled, compiles `test/portal-metadata-private-bus.c`, and runs the six scenarios `happy`, `malformed`, `duplicate`, `owner-change`, `no-pid` and `cancel`, each inside its own `dbus-run-session`. The step passes when all six scenarios succeed and the script exits zero.
- **The happy path is the protocol proof.** In the `happy` scenario the helper emits `ready`, then `start`, then `selection` with the `sourceType`, the `pipewireSerial` and the `output` or `windowClass` that the private bus replied with. The harness prints `private-bus happy passed: own start+selection only; foreign reply body reads=0; private sentinels absent`.
- **The refusals are the safety proof.** `malformed` prints `private-bus malformed-owned-reply passed: invalidated without forwarding body` and emits `invalid`; `duplicate` prints `private-bus duplicate-owned-reply passed: second body not decoded, observer invalidated`; `owner-change` prints `private-bus owner-change passed: observer invalidated before accepting metadata` and emits `invalid` with reason `owner-changed`; `no-pid` prints `private-bus missing-requester-PID passed: foreign request/reply ignored without body read`; `cancel` prints `private-bus cancellation passed: pending request stopped without late selection`.
- **Proof.** The harness output plus the helper's own stdout lines are the evidence. Copy them into `<repo>/.verification/<run-id>/` next to the run summary; the helper writes to stdout only, so capture the pipe.

## Gotchas

- The helper is Linux-only and Hyprland-specific: it watches `org.freedesktop.impl.portal.desktop.hyprland`. On another desktop portal the backend name differs and the helper reports `startup-failed`.
- The helper is not a general D-Bus sniffer. It only accepts a `Start` call whose sender is the portal and whose destination is the backend, and only accepts a reply that matches the cookie of a request the app itself made. A test that replays an unrelated reply must expect `invalid`, not a selection.
- `bun run build` is the only supported build path for the helper; it refuses to run on a non-Linux host and on an architecture other than `x64` or `arm64`. Do not compile the binary by hand into `native/out/` and commit it — `native/out/` is a build artifact.
- The helper needs the `libsystemd` development package, not just the runtime library. On a machine without it, `pkg-config --cflags libsystemd` fails and the build stops with a clear error; that is an unmet precondition, not a helper defect.
- `scripts/test-portal-metadata-native.sh` builds into a temporary directory and removes it on exit. It compiles two binaries of its own, so it does not test the shipped `native/out/` binary. To prove the shipped artifact, run it and compare the build flags, or copy the compiled helper out of the temp directory before the trap fires.
- The helper must be spawned with `--pid`, `--app-id` and `--backend-name`; the app passes the current process PID, the app ID `dodecagon-desktop` and `org.freedesktop.impl.portal.desktop.hyprland`. Running it without those flags exercises a different code path.
- `invalid` is emitted once per helper lifetime. After an `invalid` event the helper stops collecting, so a test that expects two different invalid reasons from one process will only see the first.
