# 🏠 Running on a server

- [📡 Network access](#-network-access)
- [👀 Remote headed browser with noVNC](#-remote-headed-browser-with-novnc)
- [🔒 Private access with Tailscale](#-private-access-with-tailscale)
- [🪟 Using the browser view](#-using-the-browser-view)

`bun webui` runs Astro's dev server and restarts the API when its code changes. On a server, use `bun run serve` instead. It builds the Web UI and serves it on port 4321 next to the API on port 3000.

## 📡 Network access

The Web UI listens on all network interfaces and calls the API on port 3000 of the same host. A Web UI opened at `http://192.168.1.50:4321` uses `http://192.168.1.50:3000`. If the API runs elsewhere, set `PUBLIC_API_BASE_URL`.

The API rejects `POST` requests from browser pages on other origins with a 403, so a website you visit can't start downloads or clean up your SoundCloud account. If a reverse proxy serves the Web UI from a different origin, add it to `SC_GATE_DL_ALLOWED_ORIGINS`. Clients that send no `Origin` header, such as scripts, aren't affected.

## 👀 Remote headed browser with noVNC

With this setup, a server without a screen runs Chromium in headed mode on a virtual display, and you watch and control it from the Web UI. You need it for **Initialize logins**, OAuth consent and captchas.

### ⚡ Install script

On Arch Linux or Debian, this command does all the steps below. Run it as the user the services should run as:

```bash
curl -fsSL https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/install-server.sh | bash
```

It installs the packages and Bun, clones sc-gate-dl to `~/sc-gate-dl` (set `SC_GATE_DL_DIR` for another folder), creates `.env`, asks for the VNC password, and starts the systemd user services. The API only starts once you're logged in to SoundCloud, so the script then runs `bun start --login` and you sign in through noVNC at `http://SERVER:6080/vnc.html`. Afterwards, check the gate values in `.env` as described in [Installation](installation.md#-1-create-the-env-file) and restart the app service.

Running it again updates sc-gate-dl and restarts the stack. It keeps `.env` and the VNC password, but rewrites the unit files. On Debian, Bandcamp downloads also need yt-dlp's `curl_cffi` backend, which the script doesn't install.

### ✅ What you need

- A Linux host with systemd user services and a stable hostname or IP address.
- sc-gate-dl [installed](installation.md) and set up for the service user. These steps assume it is in `~/sc-gate-dl`.
- Xvfb, `xauth`, x11vnc and noVNC.
- LAN or reverse proxy access to the API (3000), Web UI (4321) and noVNC (6080) ports. Keep the raw VNC port (5900) on localhost.
- A VNC password. VNC authentication only uses the first eight characters and doesn't encrypt the connection.

### 📥 Install

On Arch Linux and Arch Linux ARM:

```bash
sudo pacman -S --needed xorg-server-xvfb xorg-xauth x11vnc python
```

Install [noVNC](https://github.com/novnc/noVNC) from your distribution, or clone a release into your user account, and set the VNC password:

```bash
mkdir -p ~/.local/share/sc-gate-dl
git clone --depth 1 --branch v1.7.0 https://github.com/novnc/noVNC.git \
  ~/.local/share/sc-gate-dl/noVNC
mkdir -p ~/.vnc
x11vnc -storepasswd
```

`x11vnc -storepasswd` writes `~/.vnc/passwd`, which the services below use. The file is only obfuscated with a fixed, publicly known key, so anyone who can read it can recover the password. Keep it at mode `600` (`chmod 600 ~/.vnc/passwd`).

To change the password later, run `x11vnc -storepasswd` again and restart the VNC server with `systemctl --user restart sc-gate-x11vnc.service`, because x11vnc only reads the password when it starts. Browsers that saved the old password with **Remember on this device** show an authentication error once and forget it, then you enter the new one.

Create a private Xauthority file. Xvfb, x11vnc and the app must all use this file:

```bash
mkdir -p ~/.local/state/sc-gate-dl
sh -c 'umask 077; touch "$HOME/.local/state/sc-gate-dl/xauthority"; chmod 600 "$HOME/.local/state/sc-gate-dl/xauthority"; xauth -f "$HOME/.local/state/sc-gate-dl/xauthority" add :99 . "$(mcookie)"'
```

Add the display settings to `.env`:

```dotenv
DISPLAY=:99
XAUTHORITY=/home/YOUR_USER/.local/state/sc-gate-dl/xauthority
XDG_SESSION_TYPE=x11
OZONE_PLATFORM=x11
SC_GATE_DL_DISABLE_GPU=true
SC_GATE_DL_DISABLE_DEV_SHM=true
BROWSER_VIEW_URL="http://{host}:6080/vnc.html?autoconnect=true&resize=scale"
```

sc-gate-dl replaces `{host}` with the hostname or IP address you opened the Web UI with, so the viewer works through both a LAN address and Tailscale. A fixed address works too if the viewer is only reachable one way. You can leave out `SC_GATE_DL_DISABLE_DEV_SHM` when Chromium can use `/dev/shm` normally.

### 🛠️ systemd user services

Create these files in `~/.config/systemd/user/` and replace `YOUR_USER` and `/home/YOUR_USER/sc-gate-dl` with your values.

<details>
<summary><code>sc-gate-xvfb.service</code></summary>

```ini
[Unit]
Description=sc-gate-dl virtual X server
PartOf=sc-gate-dl.target

[Service]
Type=simple
# -noreset keeps the display up when its last client disconnects, so a
# restarted x11vnc can connect right away.
ExecStart=/usr/bin/Xvfb :99 -noreset -screen 0 1920x1080x24 -nolisten tcp \
  -auth /home/YOUR_USER/.local/state/sc-gate-dl/xauthority
Restart=on-failure
RestartSec=2
```

</details>

<details>
<summary><code>sc-gate-x11vnc.service</code></summary>

```ini
[Unit]
Description=sc-gate-dl VNC server
Requires=sc-gate-xvfb.service
After=sc-gate-xvfb.service
PartOf=sc-gate-dl.target

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 \
  -auth /home/YOUR_USER/.local/state/sc-gate-dl/xauthority \
  -forever -shared -localhost -usepw -rfbport 5900 -noxdamage -repeat
Restart=on-failure
RestartSec=2
# x11vnc exits with 2 when stopped; that is not a failure.
SuccessExitStatus=2
```

</details>

<details>
<summary><code>sc-gate-novnc.service</code></summary>

```ini
[Unit]
Description=sc-gate-dl noVNC web gateway
Requires=sc-gate-x11vnc.service
After=sc-gate-x11vnc.service
PartOf=sc-gate-dl.target

[Service]
Type=simple
ExecStart=/home/YOUR_USER/.local/share/sc-gate-dl/noVNC/utils/novnc_proxy \
  --listen 6080 --vnc localhost:5900
Restart=on-failure
RestartSec=2
# novnc_proxy exits with 143 (SIGTERM) when stopped; that is not a failure.
SuccessExitStatus=143
```

</details>

<details>
<summary><code>sc-gate-app.service</code></summary>

```ini
[Unit]
Description=sc-gate-dl API and Web UI
Requires=sc-gate-xvfb.service
Wants=sc-gate-novnc.service
After=sc-gate-xvfb.service sc-gate-novnc.service
PartOf=sc-gate-dl.target

[Service]
Type=simple
WorkingDirectory=/home/YOUR_USER/sc-gate-dl
Environment=PATH=/home/YOUR_USER/.bun/bin:/usr/local/bin:/usr/bin
Environment=DISPLAY=:99
Environment=XAUTHORITY=/home/YOUR_USER/.local/state/sc-gate-dl/xauthority
Environment=XDG_SESSION_TYPE=x11
Environment=OZONE_PLATFORM=x11
ExecStart=/home/YOUR_USER/.bun/bin/bun run serve
Restart=on-failure
RestartSec=3
```

</details>

<details>
<summary><code>sc-gate-dl.target</code></summary>

```ini
[Unit]
Description=sc-gate-dl remote headed browser stack
# Wants=, not Requires=: with Requires=, every automatic restart of the app
# would restart the target and, through PartOf=, the display and VNC servers.
Wants=sc-gate-xvfb.service sc-gate-x11vnc.service \
  sc-gate-novnc.service sc-gate-app.service
After=sc-gate-xvfb.service sc-gate-x11vnc.service \
  sc-gate-novnc.service sc-gate-app.service

[Install]
WantedBy=default.target
```

</details>

Check the units, let the user services start at boot without a login (lingering), and start everything:

```bash
systemd-analyze --user verify ~/.config/systemd/user/sc-gate-*.service \
  ~/.config/systemd/user/sc-gate-dl.target
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now sc-gate-dl.target
```

Check the status and follow the app logs:

```bash
systemctl --user status sc-gate-dl.target
journalctl --user -u sc-gate-app.service -f
```

The Web UI tells you when the server doesn't run the latest commit. It asks the checkout's `origin` remote at most once an hour. To update sc-gate-dl, only the app service needs a restart. It rebuilds the Web UI when it starts:

```bash
cd ~/sc-gate-dl
git pull --ff-only
bun install --frozen-lockfile
systemctl --user restart sc-gate-app.service
```

To restart the whole stack, stop and start the target, so `PartOf=` stops every service:

```bash
systemctl --user stop sc-gate-dl.target
systemctl --user start sc-gate-dl.target
```

## 🔒 Private access with Tailscale

To reach the API, Web UI and noVNC from your tailnet while keeping the LAN addresses:

```bash
tailscale serve --bg --http=3000 http://127.0.0.1:3000
tailscale serve --bg --http=4321 http://127.0.0.1:4321
tailscale serve --bg --http=6080 http://127.0.0.1:6080
tailscale serve status
```

Use **Serve**, not **Funnel**. Serve stays inside your tailnet, while Funnel puts the service on the internet.

<details>
<summary>Tailscale in Docker</summary>

Run the commands inside the container, for example `docker exec tailscaled tailscale serve ...`. The `127.0.0.1` targets only work when the container uses host networking. For a bridge-mode container, add the host gateway and use it as the target:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

```bash
docker exec tailscaled tailscale serve --bg --http=3000 http://host.docker.internal:3000
docker exec tailscaled tailscale serve --bg --http=4321 http://host.docker.internal:4321
docker exec tailscaled tailscale serve --bg --http=6080 http://host.docker.internal:6080
```

The services on the host must listen on an interface the Docker bridge can reach.

</details>

With `{host}` in `BROWSER_VIEW_URL`, both `http://192.168.1.50:4321` and `http://SERVER_NAME:4321` work without further changes.

## 🪟 Using the browser view

With `BROWSER_VIEW_URL` set, the Web UI shows a monitor icon in the top right corner. It opens the remote browser in a floating panel that doesn't block the Web UI behind it.

- The panel opens by itself once a visible headed gate browser starts or login initialization begins. Only choosing headed mode doesn't open it. Leaving that flow or switching to another browser mode closes and disconnects it.
- On the first connection, enter the VNC password. **Remember on this device** stores it in this browser's `localStorage` only, never in an API request, URL or server log. **Forget credentials** removes it, and turning the option off deletes a saved password right away.
- Closing and reopening the panel keeps the VNC connection.
- Drag the header to move the panel and its corners to resize it. It starts at the remote desktop's size, scaled down to fit, and remembers its position and size.
- The header buttons zoom, disconnect, and maximize or restore the panel. Double-clicking the header also maximizes it, and dragging a maximized header restores it.
- On touchscreens, drag with one finger to move the pointer, tap to left-click, hold still to right-click, and drag with two fingers to pan while zoomed in.

VNC authentication doesn't encrypt the connection. Keep port 6080 on a trusted LAN, or put the Web UI, API and noVNC behind a reverse proxy with HTTPS and authentication. When the Web UI uses HTTPS, `BROWSER_VIEW_URL` must use HTTPS too, so the viewer connects over `wss://`.

---

## 👉 Read next

**[🔌 HTTP API](api.md)**  
Write your own client: jobs, tag review, search and artwork.

<sub>⬅️ Previous: [How it works](how-it-works.md) · 📚 [All docs](README.md)</sub>
