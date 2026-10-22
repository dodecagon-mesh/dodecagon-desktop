#!/usr/bin/env bash
# Unpacks an AppImage into a directory that is reused while the image itself does not change.
#
# The client runs from this unpacked copy on purpose: an AppImage keeps its content in a FUSE
# mount, and when the main process dies the runtime unmounts it while helper processes are still
# executing from that mapping — they die with SIGBUS.
set -euo pipefail

usage() {
  echo "usage: unpack-appimage.sh <image> <app-root>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
image="$1"
app_root="$2"

[ -f "$image" ] || { echo "unpack-appimage: no image at $image" >&2; exit 1; }

# The stamp follows the image's size and modification time, so a replaced image gets its own
# directory: a running client never sees its files swapped underneath it.
stamp="$(stat -c '%s-%Y' "$image")"
target="$app_root/$stamp"

if [ -x "$target/AppRun" ]; then
  echo "$target"
  exit 0
fi

mkdir -p "$app_root"
# The scratch directory lives next to the target: the finished copy is renamed into place, and a
# rename inside one filesystem is atomic.
work="$(mktemp -d "$app_root/.unpack.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT

# --appimage-extract writes squashfs-root into the current directory.
( cd "$work" && "$image" --appimage-extract >/dev/null )

if [ ! -d "$work/squashfs-root" ]; then
  echo "unpack-appimage: extraction produced nothing for $image" >&2
  exit 1
fi

staged="$work/staged"
mkdir -p "$staged"
( cd "$work/squashfs-root" && shopt -s dotglob && mv -- * "$staged/" )

if ! mv -T -- "$staged" "$target" 2>/dev/null; then
  # Another launch unpacked the same image at the same time and won the race.
  if [ ! -x "$target/AppRun" ]; then
    # An interrupted run left an incomplete directory behind: replace it.
    stale="$target.incomplete.$$"
    mv -T -- "$target" "$stale" 2>/dev/null || true
    rm -rf -- "$stale"
    mv -T -- "$staged" "$target"
  fi
fi

echo "$target"
