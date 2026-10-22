#!/usr/bin/env bash
# Launcher template: the install script substitutes the image and install paths below.
#
# The client runs from an unpacked copy of the image, never from the mounted one: the AppImage
# runtime keeps the content in a FUSE mount, and when the main process dies the runtime unmounts it
# while helper processes are still executing from that mapping — they die with SIGBUS.
image="@IMAGE@"
app_root="@OPT@/app"
unpacker="@OPT@/unpack.sh"

# An update that was interrupted between removing and replacing the image leaves only the backup.
if [ ! -x "$image" ] && [ -x "$image.bak" ]; then mv "$image.bak" "$image"; fi

if [ -x "$image" ] && [ -x "$unpacker" ]; then
  app_dir="$("$unpacker" "$image" "$app_root")" || exit 1
  # The updater replaces the image in place and has to find it.
  export APPIMAGE="$image"
else
  # No image (a failed or interrupted update): run the newest unpacked copy.
  app_dir="$(ls -1dt "$app_root"/*/ 2>/dev/null | head -1)"
  app_dir="${app_dir%/}"
  if [ -z "$app_dir" ] || [ ! -x "$app_dir/AppRun" ]; then
    echo 'dodecagon-desktop: no binary found — re-run scripts/install-local.sh' >&2
    exit 1
  fi
fi

exec "$app_dir/AppRun" "$@"
