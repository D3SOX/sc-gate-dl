#!/usr/bin/env bash
# Sets up sc-gate-dl with the remote headed browser stack from docs/server.md:
# Xvfb, x11vnc, noVNC and the app as systemd user services.
#
#   curl -fsSL https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/install-server.sh | bash
#
# Supports Arch Linux and Debian. Run it as the user the services should run
# as, not as root. Running it again updates sc-gate-dl, rewrites the unit files
# and restarts the stack, and keeps .env, the VNC password and the Xauthority
# file.
#
# SC_GATE_DL_DIR sets the checkout folder (default: ~/sc-gate-dl).

set -euo pipefail

# Everything runs from main, so a download that breaks off runs nothing.
main() {
	local repo_url=https://github.com/D3SOX/sc-gate-dl.git
	local novnc_version=v1.7.0
	local websockify_version=v0.13.0
	local app_dir=${SC_GATE_DL_DIR:-$HOME/sc-gate-dl}
	local share_dir=$HOME/.local/share/sc-gate-dl
	local state_dir=$HOME/.local/state/sc-gate-dl
	local xauthority=$state_dir/xauthority
	local unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

	if [ "$(id -u)" -eq 0 ]; then
		fail "Run this as the user the services should run as, not as root."
	fi
	command -v systemctl >/dev/null || fail "This needs systemd."
	command -v sudo >/dev/null || fail "This needs sudo to install packages and enable lingering."
	# Prompts read from the terminal, because stdin is the script under curl | bash.
	{ : </dev/tty; } 2>/dev/null || fail "Run this from an interactive terminal."
	export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

	step "Installing packages"
	install_packages

	if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
		step "Installing Bun"
		curl -fsSL https://bun.sh/install | bash
	fi
	local bun
	bun=$(command -v bun || echo "$HOME/.bun/bin/bun")

	if [ -d "$app_dir/.git" ]; then
		step "Updating $app_dir"
		git -C "$app_dir" pull --ff-only
	else
		step "Cloning sc-gate-dl to $app_dir"
		git clone "$repo_url" "$app_dir"
	fi
	# systemd needs an absolute WorkingDirectory.
	app_dir=$(cd "$app_dir" && pwd)
	(cd "$app_dir" && "$bun" install --frozen-lockfile)

	step "Configuring .env"
	[ -f "$app_dir/.env" ] || cp "$app_dir/.env.example" "$app_dir/.env"
	set_env "$app_dir/.env" DISPLAY :99
	set_env "$app_dir/.env" XAUTHORITY "$xauthority"
	set_env "$app_dir/.env" XDG_SESSION_TYPE x11
	set_env "$app_dir/.env" OZONE_PLATFORM x11
	set_env "$app_dir/.env" SC_GATE_DL_DISABLE_GPU true
	set_env "$app_dir/.env" SC_GATE_DL_DISABLE_DEV_SHM true
	set_env "$app_dir/.env" BROWSER_VIEW_URL '"http://{host}:6080/vnc.html?autoconnect=true&resize=scale"'

	if [ ! -d "$share_dir/noVNC" ]; then
		step "Installing noVNC $novnc_version"
		mkdir -p "$share_dir"
		git clone --depth 1 --branch "$novnc_version" https://github.com/novnc/noVNC.git "$share_dir/noVNC"
	fi
	if [ ! -d "$share_dir/noVNC/utils/websockify" ]; then
		# novnc_proxy uses this copy instead of cloning the newest one itself.
		git clone --depth 1 --branch "$websockify_version" https://github.com/novnc/websockify.git \
			"$share_dir/noVNC/utils/websockify"
	fi

	if [ ! -f "$HOME/.vnc/passwd" ]; then
		step "Setting the VNC password (only the first 8 characters count)"
		mkdir -p "$HOME/.vnc"
		x11vnc -storepasswd </dev/tty
	fi
	chmod 600 "$HOME/.vnc/passwd"

	if [ ! -s "$xauthority" ]; then
		mkdir -p "$state_dir"
		(umask 077 && touch "$xauthority")
		xauth -f "$xauthority" add :99 . "$(mcookie)"
	fi
	chmod 600 "$xauthority"

	step "Writing systemd user services to $unit_dir"
	mkdir -p "$unit_dir"
	write_units "$unit_dir" "$app_dir" "$bun" "$share_dir" "$xauthority"

	step "Starting the services"
	# Lingering starts the services at boot without a login. It also starts the
	# user's service manager now if this session didn't.
	sudo loginctl enable-linger "$USER"
	wait_for "the systemd user manager" test -S "$XDG_RUNTIME_DIR/bus"
	systemd-analyze --user verify "$unit_dir"/sc-gate-*.service "$unit_dir/sc-gate-dl.target"
	systemctl --user daemon-reload
	systemctl --user enable sc-gate-dl.target
	# Stopping the target stops every service through PartOf=, so a rerun
	# restarts the whole stack.
	systemctl --user stop sc-gate-dl.target
	systemctl --user start sc-gate-dl.target

	local host
	host=$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)
	host=${host:-$(uname -n)}

	# The API only starts with a SoundCloud login, so the first one runs here,
	# in a browser on the virtual display that noVNC shows.
	if ! has_login "$app_dir" "$bun"; then
		step "Logging in to SoundCloud and Spotify"
		printf 'Open http://%s:6080/vnc.html?autoconnect=true&resize=scale in a browser\n' "$host"
		printf 'and enter the VNC password. The sign-in windows open there.\n'
		printf 'Press Enter to start.'
		read -r </dev/tty
		wait_for "the virtual display" test -S /tmp/.X11-unix/X99
		# bun start --login exits with 1 when SoundCloud is still not logged in.
		if ! (cd "$app_dir" && env -u WAYLAND_DISPLAY DISPLAY=:99 XAUTHORITY="$xauthority" \
			XDG_SESSION_TYPE=x11 OZONE_PLATFORM=x11 "$bun" start --login </dev/tty); then
			fail "The SoundCloud login failed, so the API can't start. Run this script again to retry."
		fi
		systemctl --user restart sc-gate-app.service
	fi

	cat <<EOF

sc-gate-dl is running. The Web UI builds on each start, which takes a moment.

  Web UI:  http://$host:4321
  Logs:    journalctl --user -u sc-gate-app.service -f

$app_dir/.env holds the gate settings. Restart the app after changing it:
  systemctl --user restart sc-gate-app.service

Keep ports 4321, 3000 and 6080 on a trusted network. docs/server.md explains
private access with Tailscale.
EOF
}

step() {
	printf '\n\033[1m==> %s\033[0m\n' "$1"
}

# Polls a check for up to 10 seconds.
wait_for() {
	local what=$1 tries=0
	shift
	until "$@"; do
		tries=$((tries + 1))
		[ "$tries" -le 50 ] || fail "Timed out waiting for $what."
		sleep 0.2
	done
}

fail() {
	printf '\033[31merror:\033[0m %s\n' "$1" >&2
	exit 1
}

install_packages() {
	if command -v pacman >/dev/null; then
		# --needed only skips the exact package name, so an AUR build such as
		# yt-dlp-nightly-bin would conflict. Keep any yt-dlp or Firefox the
		# services find on their PATH.
		local optional=() cmd
		for cmd in yt-dlp firefox; do
			PATH=/usr/local/bin:/usr/bin command -v "$cmd" >/dev/null || optional+=("$cmd")
		done
		# pacman asks for confirmation on the terminal; sudo needn't open it.
		# shellcheck disable=SC2024
		sudo pacman -S --needed git curl unzip ffmpeg python-curl_cffi "${optional[@]}" \
			xorg-server-xvfb xorg-xauth x11vnc python iproute2 at-spi2-core libxtst </dev/tty
	elif command -v apt-get >/dev/null; then
		sudo apt-get update
		# libnss3 is the one CloakBrowser library firefox-esr doesn't pull in.
		# Droploud's Firefox repost needs AT-SPI, XTest and a user session bus.
		sudo apt-get install -y git curl unzip ffmpeg yt-dlp xvfb xauth x11vnc python3 \
			libnss3 iproute2 firefox-esr at-spi2-core libxtst6 dbus-user-session
	else
		printf 'Unknown package manager. Install git, curl, unzip, ffmpeg, yt-dlp, Firefox,\n'
		printf 'Xvfb, xauth, x11vnc and python3 yourself, then press Enter.\n'
		read -r </dev/tty
	fi
}

# Sets KEY=VALUE in a dotenv file unless the key already has an uncommented line.
set_env() {
	local file=$1 key=$2 value=$3
	if ! grep -q "^$key=" "$file"; then
		# Don't append to a last line without a newline.
		if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then
			echo >>"$file"
		fi
		printf '%s=%s\n' "$key" "$value" >>"$file"
	fi
}

# True when .env holds the SoundCloud login the API needs to start, as the app
# parses it.
has_login() {
	(cd "$1" && env -u SC_CLIENT_ID -u SC_OAUTH_TOKEN -u SC_REFRESH_TOKEN "$2" -e \
		"import { hasSoundcloudLogin } from './src/soundcloud'; process.exit(hasSoundcloudLogin() ? 0 : 1);")
}

write_units() {
	local dir=$1 app_dir=$2 bun=$3 share_dir=$4 xauthority=$5

	cat >"$dir/sc-gate-xvfb.service" <<EOF
[Unit]
Description=sc-gate-dl virtual X server
PartOf=sc-gate-dl.target

[Service]
Type=simple
# -noreset keeps the display up when its last client disconnects, so a
# restarted x11vnc can connect right away.
ExecStart=/usr/bin/Xvfb :99 -noreset -screen 0 1920x1080x24 -nolisten tcp -auth $xauthority
Restart=on-failure
RestartSec=2
EOF

	cat >"$dir/sc-gate-x11vnc.service" <<EOF
[Unit]
Description=sc-gate-dl VNC server
Requires=sc-gate-xvfb.service
After=sc-gate-xvfb.service
PartOf=sc-gate-dl.target

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 -auth $xauthority -forever -shared -localhost -usepw -rfbport 5900 -noxdamage -repeat
Restart=on-failure
RestartSec=2
# x11vnc exits with 2 when stopped; that is not a failure.
SuccessExitStatus=2
EOF

	cat >"$dir/sc-gate-novnc.service" <<EOF
[Unit]
Description=sc-gate-dl noVNC web gateway
Requires=sc-gate-x11vnc.service
After=sc-gate-x11vnc.service
PartOf=sc-gate-dl.target

[Service]
Type=simple
ExecStart=$share_dir/noVNC/utils/novnc_proxy --listen 6080 --vnc localhost:5900
Restart=on-failure
RestartSec=2
# novnc_proxy exits with 143 (SIGTERM) when stopped; that is not a failure.
SuccessExitStatus=143
EOF

	cat >"$dir/sc-gate-app.service" <<EOF
[Unit]
Description=sc-gate-dl API and Web UI
Requires=sc-gate-xvfb.service
Wants=sc-gate-novnc.service
After=sc-gate-xvfb.service sc-gate-novnc.service
PartOf=sc-gate-dl.target

[Service]
Type=simple
WorkingDirectory=$app_dir
Environment=PATH=$(dirname "$bun"):/usr/local/bin:/usr/bin
Environment=DISPLAY=:99
Environment=XAUTHORITY=$xauthority
Environment=XDG_SESSION_TYPE=x11
Environment=OZONE_PLATFORM=x11
ExecStart=$bun run serve
Restart=on-failure
RestartSec=3
EOF

	cat >"$dir/sc-gate-dl.target" <<EOF
[Unit]
Description=sc-gate-dl remote headed browser stack
# Wants=, not Requires=: with Requires=, every automatic restart of the app
# would restart the target and, through PartOf=, the display and VNC servers.
Wants=sc-gate-xvfb.service sc-gate-x11vnc.service sc-gate-novnc.service sc-gate-app.service
After=sc-gate-xvfb.service sc-gate-x11vnc.service sc-gate-novnc.service sc-gate-app.service

[Install]
WantedBy=default.target
EOF
}

main "$@"
