# sc-gate-dl

Download and tag SoundCloud tracks unlocked via Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, or a direct download link.

## Features

- 🎵 Automatically download audio from Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, and direct file links (e.g. Dropbox `dl=1`)
- ⚡ Browserless fast path that skips the browser for gates that don't need real verification (see [How It Works](#how-it-works))
- 🔄 Handles multiple gate types (see [How It Works](#how-it-works))
- 📝 Fetches metadata from the provided SoundCloud link
- 🎨 Manual metadata correction before finalizing
- 🎧 Converts Lossless (WAV/AIFF/FLAC) files to MP3 (320kbps)
- 🏷️ Tags MP3 files with metadata and artwork from SoundCloud
- 🧹 Optional cleanup of the SoundCloud account (unfollow, unlike, delete comments/reposts)
- 🧩 Userscript (Violentmonkey) that opens the Web UI in a floating panel next to SoundCloud store/buy links

## Prerequisites

- [**Bun**](https://bun.sh) - JavaScript runtime and package manager
- [**ffmpeg**](https://ffmpeg.org) - Must be installed and available in your `PATH`
- [**yt-dlp**](https://github.com/yt-dlp/yt-dlp) - Required for Bandcamp purchase/download links and for downloading a SoundCloud track directly when no gate is found. Bandcamp support requires the optional `curl_cffi` backend (`python-curl-cffi` on Arch Linux or `yt-dlp[default,curl-cffi]` with pip) for Chrome impersonation.
- [**curl-impersonate**](https://github.com/lwthiker/curl-impersonate) (optional but recommended) - Chrome-TLS curl binary (`curl_chrome131`, `curl_chrome116`, or `curl-impersonate` on your `PATH`). Used for SoundCloud engagement writes (repost GraphQL / `me/track_reposts`) that DataDome often blocks when done with Bun's normal TLS. Without it the tool falls back to Bun `fetch`, which may get a 403. Pair with a residential proxy via `SC_API_PROXY`, `CLOAKBROWSER_PROXY`, or `PROXY_URL` when your IP is hard-blocked.
- **SoundCloud account** - It is recommended to create a throwaway account for this. Even though there were no reports of accounts getting banned I can't guarantee it. Also most gate downloads require reposts/likes/follows which you might not want to do with your main account
- **Spotify account** (optional) - Required when a Hypeddit post has an unskippable Spotify gate. I also recommend creating a throwaway account as most Hypeddit downloads require saving playlists/songs to your library or following artists which you might not want on your main account.

## Installation

Clone the repository

```bash
git clone https://github.com/D3SOX/sc-gate-dl
cd sc-gate-dl
```

Install dependencies

```bash
bun install
```

If you want to use the [Web UI](#web-ui) you also need to install the dependencies for it

```bash
cd webui
bun install
```

## Setup

### Environment Variables

Create a `.env` file in the project root by copying the `.env.example` file and filling in the values.

For `HYPEDDIT_NAME` and `SC_COMMENT` currently everything works (I use just `asd`)

For `HYPEDDIT_EMAIL` you can enter any valid email address (For example grab one from [temp-mail.org](https://temp-mail.org))

#### Get SoundCloud API Credentials

1. Go to [soundcloud.com](https://soundcloud.com) and log in (skip if you are already logged in)
2. Open up the developer tools (Right click → Inspect or press F12) and go to the **Network** tab
3. Navigate to soundcloud.com (refresh the page if needed), and you should see a bunch of requests in the network tab
4. Find the request that has the name `session` (you can filter by typing `session` in the filter box) and click on it
5. Go to the **Payload** tab
6. You should see your client id in the **Query String Parameters** section, and your oauth token (`access_token`) in the **Request Payload** section
7. Copy these values to your `.env` file as `SC_CLIENT_ID` and `SC_OAUTH_TOKEN`

If you want to export data from a separate SoundCloud account, add that account's credentials as `MANAGED_SC_CLIENT_ID` and `MANAGED_SC_OAUTH_TOKEN`.

### Cookies

**For Firefox-based browsers:**
Install the [EditThisCookie2](https://addons.mozilla.org/en-US/firefox/addon/etc2/) extension

**For Chromium-based browsers (Chrome, Edge, Brave, Helium, etc.):**
Install the [EditThisCookie (fork)](https://chromewebstore.google.com/detail/editthiscookie-fork/ihfmcbadakjehneaijebhpogkegajgnk) extension

#### SoundCloud Cookies

Used for SoundCloud API/session automation and for **yt-dlp** when downloading a SoundCloud track directly (so downloadable tracks can fetch the original upload, not only the 128k stream).

You can omit `soundcloud-cookies.json` and use **Initialize Logins** in the Web
UI instead. Sign in through the visible or remote browser; after SoundCloud's
Library page opens, sc-gate-dl saves the browser cookies to
`soundcloud-cookies.json` with owner-only permissions. A blank file and `[]` are
also treated as an empty cookie set. The exported cookies are reused by browser
gate jobs and yt-dlp.

**Steps:**

1. Go to [soundcloud.com](https://soundcloud.com) and log in
2. Open the extension and click on the export button
3. Save what was copied to the clipboard to a file called `soundcloud-cookies.json` in the project root

#### Spotify Cookies (Optional)

If you plan to download tracks that require Spotify gates, you'll also need Spotify cookies:

**Steps:**

1. Go to [accounts.spotify.com](https://accounts.spotify.com) and log in
2. Open the extension and click on the export button
3. Save what was copied to the clipboard to a file called `spotify-cookies.json` in the project root

### CLI Config file (Optional)

If you want to use the CLI and not be prompted for values every time, you can create a config file by copying the example config and filling in the values:

```bash
cp config.example.json config.json
```

Set `xvfb` to `true` to keep the browser window invisible while running
CloakBrowser in headed mode. This avoids Chromium's detectable headless rendering
path. Install `xorg-server-xvfb` on Arch Linux (`xvfb` on Debian/Ubuntu) first.

For anti-bot sites, configure a residential proxy with
`CLOAKBROWSER_PROXY` (SOCKS5 is preferred when available). Proxy GeoIP matching
and humanized browser input are enabled automatically; set
`CLOAKBROWSER_GEOIP=false` only to opt out. The Web UI also exposes Xvfb mode
next to its headful-browser option.

## Usage

### CLI

Run the tool and follow the prompts.

```bash
bun start
```

You can also pass a SoundCloud track URL directly.

```bash
bun start https://soundcloud.com/artist/track
```

The final MP3 file will be saved in the `./downloads` directory with proper metadata and artwork embedded.

### Managed account export

To export the followed users, liked tracks, reposted tracks, and playlists from the separate managed SoundCloud account in your `.env`, run:

```bash
bun manage-acc
```

The export will be written to a timestamped directory inside `./exports` and includes `playlists.json` with playlist track data. `reposted-playlists.json` is also included as an extra export.

### Web UI

There is now also an experimental (vibe-coded) web UI for the tool. You can start it by running

```bash
bun webui
```

Wait for Astro to be started. It will then tell you the address it's available on, most likely [`http://localhost:4321`](http://localhost:4321).

The Web UI also listens on the local network and automatically calls the API on
port `3000` of the same host. For example, a Web UI opened at
`http://192.168.1.50:4321` uses `http://192.168.1.50:3000`. Set
`PUBLIC_API_BASE_URL` when the public API uses a different host or port. If a
reverse proxy gives the Web UI a different origin, add it to the comma-separated
`SC_GATE_DL_ALLOWED_ORIGINS` environment variable.

Set `SC_GATE_DL_DELETE_AFTER_DOWNLOAD=true` on the server to remove completed
MP3, FLAC, and original files after their HTTP response has been transferred in
full. This applies to headless, Xvfb, and visible-headed jobs. Interrupted or
failed transfers retain the file so the download can be retried.

For a remotely hosted headed browser, set `BROWSER_VIEW_URL` to an HTTP(S)
viewer such as noVNC. The Web UI then shows a **View Browser** button next to
**Initialize Logins**. Virtual displays without GPU device access can set
`SC_GATE_DL_DISABLE_GPU=true`. Containers with a constrained `/dev/shm` can
separately set `SC_GATE_DL_DISABLE_DEV_SHM=true`.

#### Remotely hosted headed browser with noVNC

This setup lets a headless server open Chromium in headed mode while you view
and control it inside the sc-gate-dl Web UI. It is useful for **Initialize
Logins**, OAuth consent, and captchas.

##### Prerequisites

- A Linux host with systemd user services and a stable hostname or IP address.
- Bun and the sc-gate-dl dependencies installed for the service user.
- Xvfb, `xauth`, x11vnc, and noVNC.
- LAN or reverse-proxy access to the API (`3000`), Web UI (`4321`), and noVNC
  (`6080`) ports. Keep the raw VNC port (`5900`) bound to localhost.
- A VNC password. Traditional VNC authentication uses only the first eight
  password characters and does not encrypt the connection.

On Arch Linux / Arch Linux ARM, install the native packages:

```bash
sudo pacman -S --needed xorg-server-xvfb xorg-xauth x11vnc
```

Install [noVNC](https://github.com/novnc/noVNC) from your distribution, or use
an upstream release in your user account:

```bash
mkdir -p ~/.local/share/sc-gate-dl
git clone --depth 1 --branch v1.7.0 https://github.com/novnc/noVNC.git \
  ~/.local/share/sc-gate-dl/noVNC
mkdir -p ~/.vnc
x11vnc -storepasswd
```

Install both dependency sets before creating the services:

```bash
cd ~/sc-gate-dl
bun install --frozen-lockfile
cd webui
bun install --frozen-lockfile
```

Create a private Xauthority file once. Xvfb, x11vnc, and the app service must
use this same file:

```bash
mkdir -p ~/.local/state/sc-gate-dl
sh -c 'umask 077; touch "$HOME/.local/state/sc-gate-dl/xauthority"; chmod 600 "$HOME/.local/state/sc-gate-dl/xauthority"; xauth -f "$HOME/.local/state/sc-gate-dl/xauthority" add :99 . "$(mcookie)"'
```

Add the runtime environment to the project `.env`. Replace `SERVER_ADDRESS`
with the stable hostname or IP address reachable by the browser that opens the
Web UI:

```dotenv
DISPLAY=:99
XAUTHORITY=/home/YOUR_USER/.local/state/sc-gate-dl/xauthority
XDG_SESSION_TYPE=x11
OZONE_PLATFORM=x11
SC_GATE_DL_DISABLE_GPU=true
SC_GATE_DL_DISABLE_DEV_SHM=true
BROWSER_VIEW_URL="http://SERVER_ADDRESS:6080/vnc.html?autoconnect=true&resize=scale"
```

`SC_GATE_DL_DISABLE_DEV_SHM` is mainly useful for containers or constrained
hosts. It may be omitted when Chromium can use `/dev/shm` normally.

##### Automatic startup with systemd user services

Create the following files under `~/.config/systemd/user/`. Replace
`YOUR_USER` and `/home/YOUR_USER/sc-gate-dl` where shown. The examples use the
encrypted `~/.vnc/passwd` produced by `x11vnc -storepasswd`.

`sc-gate-xvfb.service`:

```ini
[Unit]
Description=sc-gate-dl virtual X server
PartOf=sc-gate-dl.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp \
  -auth /home/YOUR_USER/.local/state/sc-gate-dl/xauthority
Restart=on-failure
RestartSec=2
```

`sc-gate-x11vnc.service`:

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
```

`sc-gate-novnc.service`:

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
```

`sc-gate-app.service`:

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
ExecStart=/home/YOUR_USER/.bun/bin/bun webui
Restart=on-failure
RestartSec=3
```

`sc-gate-dl.target`:

```ini
[Unit]
Description=sc-gate-dl remote headed browser stack
Requires=sc-gate-xvfb.service sc-gate-x11vnc.service \
  sc-gate-novnc.service sc-gate-app.service
After=sc-gate-xvfb.service sc-gate-x11vnc.service \
  sc-gate-novnc.service sc-gate-app.service

[Install]
WantedBy=default.target
```

Validate the units, enable user services at boot, and start the stack:

```bash
systemd-analyze --user verify ~/.config/systemd/user/sc-gate-*.service \
  ~/.config/systemd/user/sc-gate-dl.target
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now sc-gate-dl.target
```

The lingering user manager is required for startup before the user logs in.
Check the complete stack and follow the app logs with:

```bash
systemctl --user status sc-gate-dl.target
journalctl --user -u sc-gate-app.service -f
```

For future application updates, only the app service needs restarting:

```bash
cd ~/sc-gate-dl
git pull --ff-only
bun install --frozen-lockfile
cd webui && bun install --frozen-lockfile && cd ..
systemctl --user restart sc-gate-app.service
```

To restart the complete display/VNC/application stack, stop and start the
target so `PartOf=` cleanly stops every service:

```bash
systemctl --user stop sc-gate-dl.target
systemctl --user start sc-gate-dl.target
```

If you intentionally keep a plaintext password file instead of
`~/.vnc/passwd`, protect it with mode `600` and use x11vnc's `-passwdfile`
option. Do not pass a plaintext file to `-rfbauth`; that option expects
x11vnc's encrypted password-file format.

The monitor icon in the top-right opens a floating browser panel without
blocking the Web UI behind it. The panel is draggable, resizable proportionally
from its corners, defaults to the remote desktop's native view size (scaled down
to fit), remembers its geometry, and automatically opens once a visible headed
gate browser has actually started or login initialization starts. Selecting
visible headed mode alone does not open it. Leaving that browser flow or
switching to another browser mode closes, disconnects, and hides the viewer.
On the first
connection, enter the VNC password and optionally select **Remember on this
device**. The password is stored only in that browser profile's `localStorage`,
never in an API request, URL, or server log. Use **Forget credentials** to
remove it. The remember choice itself is persisted, and turning it off removes
any saved password immediately. Closing and reopening the panel keeps the
established VNC connection. Use the header controls to zoom, disconnect, or
maximize/restore the viewer. Double-clicking the header also toggles maximized
mode, while dragging a maximized header restores the floating window.
On touchscreens, drag with one finger to move the remote pointer, tap to
left-click, hold without moving to right-click, and drag with two fingers to
pan the local view while zoomed in.

VNC authentication does not encrypt the connection. Keep port `6080` on a
trusted LAN, or put the Web UI, API, and noVNC behind an authenticated HTTPS
reverse proxy. When the Web UI uses HTTPS, `BROWSER_VIEW_URL` must also use
HTTPS so the embedded client connects over `wss://`.

If it's the first time you're running it you will need to initialize the logins by clicking the button in the footer.

You can deep-link a track with `?url=` (also accepted as `?soundcloudUrl=`), optional `outputFormat` (`mp3-320`, `flac`, or `original`), and optional `browserMode` (`headless`, `xvfb`, or `headed`), which pre-fills the form and starts the job. FLAC output preserves lossless sources; converting a lossy source to FLAC changes the container but cannot restore lost quality.

```text
http://localhost:4321/?url=https://soundcloud.com/artist/track&outputFormat=mp3-320
```

### Browser userscript

Adds a download icon next to SoundCloud store/buy links (feed and track pages). Clicking it opens the **exact Web UI** in a floating, movable panel on the right (resizable from all edges) — the page behind stays usable (no dimmed overlay). Choose both output format and browser mode from the panel toolbar, or from Violentmonkey's **Choose output format…** and **Choose browser mode…** menu commands. Both choices are remembered and passed to the Web UI. Auto-close after the **browser file download** (Download MP3/Original) or **Start New Download** is on by default — toggle via **Auto-close after browser download**. Closing the panel (× / Escape) or **Cancel download** in the Web UI stops an in-progress job and exits the browser cleanly.

**Recommended:** [Violentmonkey](https://violentmonkey.github.io/) (Firefox / Chrome / Edge). Tampermonkey also works.

[![Install userscript](https://img.shields.io/badge/Install%20userscript-Violentmonkey-3b3b3b?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/userscript/sc-gate-dl.user.js)

Or open the raw file: [`userscript/sc-gate-dl.user.js`](https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/userscript/sc-gate-dl.user.js)

1. Install [Violentmonkey](https://violentmonkey.github.io/)
2. Click **Install userscript** above (Violentmonkey will prompt to confirm)
3. Start the Web UI locally: `bun webui`
4. Browse SoundCloud — use the download icon beside the store/cart button

Chrome may ask once to allow the page to access your local network (`localhost`). If the panel iframe is blocked, use **open in tab** in the panel toolbar.

To point the userscript at another machine without developer tools, click the
gear button in its panel header or choose **Configure server…** from
Violentmonkey's userscript menu. Enter the complete Web UI address, for example
`http://192.168.178.57:4321`. The setting is remembered across browser
restarts. Leaving the address empty resets it to localhost.

The same setting can also be changed from the SoundCloud tab console:

```js
localStorage.setItem('sc-gate-dl-webui-base', 'http://localhost:4321')
```

Panel size/position is remembered in `localStorage` (`sc-gate-dl-panel-geom`).

## How It Works

**Browserless fast path**: Most Hypeddit gates (email and the social follow/like/comment/repost buttons for SoundCloud, Instagram, TikTok, YouTube and Facebook) are only verified client-side, so the tool first tries to satisfy them with plain HTTP requests and downloads the file directly, without launching a browser. This is much faster and shows live download progress in both the CLI and Web UI. If a post has a gate that needs real verification (e.g. an unskippable Spotify gate), it automatically falls back to the browser-based flow below.

**Gate Handling**: When the browser flow is used, the tool automatically detects and handles different Hypeddit gates:

- Email gate: Enters your name and email
- SoundCloud gate: Handles the follow/like/comment/repost buttons (This gets bypassed as Hypeddit does not actually verify the actions). The legacy OAuth "connect" flow is still handled as a fallback
- Facebook gate: Clicks the next button (Does not require any action)
- Instagram gate: Handles Instagram follow requirements (This gets bypassed as it does not actually require a follow)
- TikTok gate: Handles TikTok follow requirements (This gets bypassed as it does not actually require a follow)
- YouTube gate: Handles YouTube subscribe requirements (This gets bypassed as it does not actually require subscribing)
- Spotify gate: Authorizes Spotify access
- Download gate: Triggers the audio download

Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, and MyPressKit gates are handled via their own downloaders with similar email / social unlock flows. StillHype, PumpYourSound, and MyPressKit require a real SoundCloud OAuth connection (follow / like / repost / comment are verified server-side). Traditional gate URLs in the track description are preferred over Bandcamp/SoundCloud store links in `purchase_url`.

**Bandcamp / yt-dlp**: When a SoundCloud track’s purchase URL (or description) points at Bandcamp instead of a gate, the file is downloaded with [yt-dlp](https://github.com/yt-dlp/yt-dlp) (browserless). For Bandcamp album links, the matching track is selected from the SoundCloud title; if auto-match fails, the CLI and Web UI let you pick a track from the album. Traditional unlock gates still take priority if both are present. If no gate or Bandcamp URL is found, the CLI and Web UI can fall back to downloading the SoundCloud track itself via yt-dlp.

**Direct download**: Paste a file URL (Dropbox with `dl=1`, Google Drive file links, or any http(s) URL ending in a common audio/archive extension). The file is fetched browserlessly — useful when a gate is unsupported but you already have the download link.

**File Processing**:

- **Lossless (WAV/AIFF/FLAC) files**: Converted to MP3 (320kbps) with metadata and artwork
- **MP3 files**: Retagged with metadata and artwork (no re-encoding)
