#!/usr/bin/env bash
# Installs the app for the current user from the latest GitHub release, without root.
# The AppImage lands in ~/.local/opt and keeps itself up to date; a launcher, icon and desktop
# entry are installed too. The client runs from an unpacked copy of the image, so it never needs
# a FUSE mount and cannot die with SIGBUS when the mount goes away.
# DODECAGON_LOCAL_BUILD=1 installs the checkout instead of downloading a release.
set -euo pipefail

repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
opt="$HOME/.local/opt/dodecagon-desktop"
bin="$HOME/.local/bin/dodecagon-desktop"
image="$opt/Dodecagon.AppImage"
launcher_template="$repo/scripts/dodecagon-desktop-launcher.sh"
unpack_script="$repo/scripts/unpack-appimage.sh"

asset_url() {
  curl -fsSL https://api.github.com/repos/dodecagon-mesh/dodecagon-desktop/releases/latest |
    grep -o 'https://[^"]*linux-x86_64.AppImage' | head -1
}

# Unpacks the image into its own directory, next to the image. The launcher starts the client from
# there: a mounted AppImage dies with SIGBUS as soon as the runtime unmounts it.
unpack() {
  "$opt/unpack.sh" "$image" "$opt/app" >/dev/null
}

cd "$repo"
mkdir -p "$opt" "$(dirname "$bin")" "$data/applications" "$data/icons/hicolor/512x512/apps"
install -m 755 "$unpack_script" "$opt/unpack.sh"

if [ -n "${DODECAGON_LOCAL_BUILD:-}" ]; then
  echo "building locally…"
  node build.mjs >/dev/null
  npx electron-builder --linux dir --publish never >/dev/null
  # The launcher starts the image when there is one, so a local build has to take its place.
  rm -f "$image" "$image.bak"
  rm -rf "$opt/app/local-build"
  install -d "$opt/app/local-build"
  cp -a release/linux-unpacked/. "$opt/app/local-build/"
  [ -x "$opt/app/local-build/dodecagon-desktop" ] || {
    echo "unexpected local build layout: no dodecagon-desktop binary" >&2
    exit 1
  }
  # A local build has no AppRun: give it the same entry point the image has, so the launcher
  # starts both the same way.
  cat > "$opt/app/local-build/AppRun" <<'EOF'
#!/usr/bin/env bash
set -e
APPDIR="$(dirname "$(readlink -f "$0")")"
export PATH="${APPDIR}:${APPDIR}/usr/sbin${PATH:+:${PATH}}"
export XDG_DATA_DIRS="${APPDIR}/usr/share/${XDG_DATA_DIRS:+:${XDG_DATA_DIRS}:/usr/share/gnome:/usr/local/share/:/usr/share/}"
export LD_LIBRARY_PATH="${APPDIR}/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
export GSETTINGS_SCHEMA_DIR="${APPDIR}/usr/share/glib-2.0/schemas${GSETTINGS_SCHEMA_DIR:+:${GSETTINGS_SCHEMA_DIR}}"
NO_SANDBOX=()
unshare -Ur true 2>/dev/null || NO_SANDBOX=(--no-sandbox)
exec "$APPDIR/dodecagon-desktop" "${NO_SANDBOX[@]}" "$@"
EOF
  chmod +x "$opt/app/local-build/AppRun"
else
  echo "fetching the latest release…"
  url="$(asset_url)"
  [ -n "$url" ] || { echo "could not find a Linux AppImage in the latest release" >&2; exit 1; }
  curl -fL "$url" -o "$image.tmp"
  chmod +x "$image.tmp"
  mv "$image.tmp" "$image"
  rm -f "$image.bak"

  # A second, unpacked copy: a self-updating AppImage replaces its own file, and an interrupted swap
  # would otherwise leave nothing to start.
  unpack || echo "note: could not unpack the fallback copy" >&2
fi

sed "s|@IMAGE@|$image|; s|@OPT@|$opt|" "$launcher_template" > "$bin"
chmod +x "$bin"
install -m 644 "$repo/build/icon.png" "$data/icons/hicolor/512x512/apps/dodecagon-desktop.png"

cat > "$data/applications/dodecagon-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Dodecagon
Comment=Dodecagon client whose screen share carries all PC audio except Dodecagon
Exec=$bin
Icon=dodecagon-desktop
Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass=dodecagon-desktop
EOF

if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$data/applications" || true
fi
if command -v gtk-update-icon-cache >/dev/null; then
  gtk-update-icon-cache -f -t "$data/icons/hicolor" >/dev/null || true
fi

echo "installed: $bin"
echo "launcher:  $data/applications/dodecagon-desktop.desktop"
