# Startup connect window

On a first run, with no server address saved yet, Dodecagon Desktop opens a window that asks which server the client should open. The user sees the app name and version, a hint that the address can be changed later, an address field, and a `Connect` button.

## Sub-features

- `startup-connect-window` shows the connect window as the first thing the user sees.
- `startup-window-identity` shows the product name and the running version.
- `startup-server-hint` tells the user how to change the server later.
- `startup-saved-server` is the counterpart: with a server address already saved, the app opens that server instead of asking.

## How to get to it (user POV)

- Start Dodecagon Desktop on a machine where the client has never been pointed at a server.
- Choose `Change server…` in the tray menu, or press `Ctrl`/`Cmd`+`Shift`+`S`, to return to this window from a running client.

## Driving it with verify-desktop.mjs

Preconditions:

- `bun run build` has run in the repository root, so `dist/main.js`, `dist/connect.html` and `native/out/portal-metadata-linux-<arch>` exist.
- `node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs doctor` reports `ready to drive`.
- The run uses its own `XDG_CONFIG_HOME`, so no server address is saved and the first-run state is guaranteed.

- **Start the app.** Run `node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs drive --feature startup-connect-window`. The helper launches the app on a private Xvfb display and waits for the CDP page target.
- **Window is ready.** The window facts report title `Dodecagon`, an address field (`#url`) and a button labelled `Connect` (`#submit`). The step passes only when all three hold.
- **The app agrees.** The copied `main.log` contains `no server chosen yet, showing the picker`. That line is the app's own statement that it reached the connect route.
- **Proof.** The run writes `<repo>/.verification/<run-id>/startup-connect-window.png` (the window as the user sees it), `facts.json` (the read facts) and `summary.md` (the step outcome). The run passes when the step passes and the evidence exists after cleanup.

## Gotchas

- Launching the app on the live Wayland or X session flashes windows and steals focus. Always drive it under Xvfb.
- The app decides it is on Wayland from `WAYLAND_DISPLAY` or `XDG_SESSION_TYPE=wayland`. Under Xvfb, strip both, or the app tries the system portal against an X11 session. The helper strips them and sets `DODECAGON_PICKER=inapp`.
- The app's single-instance lock is per user profile. An isolated `XDG_CONFIG_HOME` keeps the run from taking over (or being taken over by) an instance the user already has open.
- The connect window is loaded by the code path named `loadPicker`; that name refers to the server picker route, not the capture source picker. The capture picker is a different window.
- `startup-saved-server` is not proved by this recipe. To see it, put a server address in the run's profile `config.json` before launch; the app then skips the connect window and loads the client route instead, which needs a reachable server.
