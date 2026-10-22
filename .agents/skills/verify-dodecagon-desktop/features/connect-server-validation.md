# Server address validation

When the user types a server address into the connect window and presses `Connect`, the client either accepts it or refuses it with a message in the error region. The refusal is the user-visible behavior: an address that is not a server is rejected before any network request, and an address that is a server but unreachable fails with the browser's own error text.

## Sub-features

- `connect-empty-address` refuses an empty field with the hint `Enter an address such as https://dodecagon.example.com`.
- `connect-refuses-non-http-scheme` refuses anything that is not `http:` or `https:` — for example `ftp://example.com`.
- `connect-normalizes-bare-host` turns a host without a scheme into `https://` before connecting, so `dodecagon.example.com` and `nas:4991` work.
- `connect-reports-unreachable-host` shows the load failure text when the address is well-formed but the host does not resolve.
- `connect-error-region` puts every refusal into the `#error` region with `role="alert"`, so assistive technology announces it.

## How to get to it (user POV)

- Start Dodecagon Desktop on a machine where the client has never been pointed at a server, then type an address into the connect window.
- Press `Connect` with an empty field, with a `ftp://` address, with a bare host name, and with a host that does not exist.
- Press `Ctrl`/`Cmd`+`Shift`+`S` or choose `Change server…` in the tray menu to come back to the connect window from a running client.

## Driving it with verify-desktop.mjs

Preconditions:

- `bun run build` has run in the repository root.
- `node .agents/skills/verify-dodecagon-desktop/scripts/verify-desktop.mjs doctor` reports `ready to drive`.
- The run uses its own `XDG_CONFIG_HOME`, so no address is saved and the connect window is the first route.
- No reachable server is required. A refused address proves the validation, and an unresolvable host proves the failure path without depending on the network.

- **Refuse a non-server scheme.** Type `ftp://example.com` into `#url` and click `#submit`. The step passes when the error region is non-empty and the client did not attempt a page load.
- **Refuse an empty address.** Clear `#url` and click `#submit`. The error region shows the hint `Enter an address such as https://dodecagon.example.com`.
- **Report an unreachable host.** Type `not-a-url` into `#url` and click `#submit`. The error region shows the load failure for `https://not-a-url/`, which proves the address was normalized to `https://` and then failed on the network, not on validation.
- **The app agrees.** The copied `main.log` records the connection attempt for the submitted address.
- **Proof.** The run writes `<repo>/.verification/<run-id>/connect-server-validation.png`, `facts.json` (including the error text and `errorRole`) and `summary.md`. The evidence must survive cleanup.

## Gotchas

- `normalizeServerUrl` prepends `https://` to any input without `://`, so a bare host is never a validation failure. Test the refusal path with a scheme that is not `http(s)` — `ftp://example.com` — and not with `example.com`.
- An address with credentials (`https://user:pass@host`) is refused by the same check. It is not needed for the base proof.
- `javascript:` and `data:` inputs are refused too, but only because they are not `http(s)`. Do not treat a refusal as a proof of a security property without naming the check that produced it.
- The unreachable-host step needs a name that cannot resolve. `not-a-url` resolves nowhere; `example.com` usually resolves and would turn the step into a network-dependent test.
- The error region is `role="alert"`. Reading its text content is enough; do not look for a class name, the markup uses no stable class.
- The error text after a failed load is the Chromium message, for example `ERR_NAME_NOT_RESOLVED (-105) loading 'https://not-a-url/'`. Assert on the presence of the error and its role, not on the exact Chromium wording — that string changes between Chromium versions.
- A refused address must not write to the profile `config.json`. If the run ever needs to prove that a saved address was persisted, that is a separate check on the profile file, not part of the refusal proof.
