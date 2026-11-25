# sc-gate-dl

sc-gate-dl downloads SoundCloud tracks that sit behind a download gate and tags them with the track's SoundCloud metadata and artwork. You give it a SoundCloud link, and it finds the gate, unlocks it, and saves the file. It works from the command line, from a Web UI, and from a userscript on soundcloud.com.

Supported sources: Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, fangate.eu, Bandcamp, and direct file links.

- [✨ Features](#-features)
- [📋 Requirements](#-requirements)
- [📦 Installation](#-installation)
- [🧰 Setup](#-setup)
- [🚀 Usage](#-usage)
- [🔧 Configuration](#-configuration)
- [🧠 How it works](#-how-it-works)
- [🏠 Running on a server](#-running-on-a-server)
- [🔌 HTTP API](#-http-api)

## ✨ Features

- 🎵 Unlocks Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit and fangate.eu gates, and downloads Bandcamp releases and direct file links such as Dropbox `dl=1` links.
- 🔄 Finds the gate in the track description, the purchase link, or behind SoundCloud's Free download box.
- ⚡ Skips the browser for gates that are only checked in the browser, which covers most Hypeddit gates and makes them much faster.
- 🎧 Unpacks ZIP downloads, prefers the lossless file, and converts it to MP3, M4A/AAC or FLAC.
- 🏷️ Tags MP3, M4A and FLAC files with SoundCloud's metadata and artwork.
- 🎨 Lets you correct the tags before saving.
- 🧹 Can undo the gate actions on your SoundCloud account afterwards (unfollow, unlike, delete comments and reposts).
- 🔎 Web UI with SoundCloud search.
- 🧩 Userscript that opens the Web UI in a panel next to SoundCloud's buy links.

## 📋 Requirements

| Tool | Needed for |
| --- | --- |
| [Bun](https://bun.sh) | Running sc-gate-dl. |
| [ffmpeg](https://ffmpeg.org) | Converting and tagging audio. It must be on your `PATH`. |
| [unzip](https://infozip.sourceforge.net/UnZip.html) | Gates that deliver a ZIP archive. |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Bandcamp links, and downloading the SoundCloud track itself when there is no gate. Bandcamp also needs yt-dlp's `curl_cffi` backend for Chrome impersonation: `python-curl-cffi` on Arch Linux, or `pip install "yt-dlp[default,curl-cffi]"`. |
| [Firefox](https://www.mozilla.org/firefox/) (recommended) | SoundCloud sign-ins. SoundCloud's bot protection lets a plain Firefox through more reliably than an automated browser. Without it, you sign in in CloakBrowser. |
| [curl-impersonate](https://github.com/lwthiker/curl-impersonate) (recommended) | Reposts and other SoundCloud engagement requests, which SoundCloud's DataDome protection often blocks when Bun sends them. sc-gate-dl looks for `curl_chrome131`, `curl_chrome116` or `curl-impersonate` on your `PATH` and otherwise falls back to Bun's `fetch`, which may get a 403. |

You also need accounts:

- ☁️ **SoundCloud.** Use a throwaway account. Nobody has reported a ban so far, but I can't guarantee it, and most gates make you repost, like or follow, which you may not want on your main account.
- 💚 **Spotify** (optional). Only needed for Hypeddit posts with a Spotify gate that can't be skipped. Use a throwaway account here too, because these gates save playlists and songs to your library or follow artists.

## 📦 Installation

```bash
git clone https://github.com/D3SOX/sc-gate-dl
cd sc-gate-dl
bun install
```

For the [Web UI](#-web-ui), also install its dependencies:

```bash
cd webui
bun install
```

## 🧰 Setup

### 📝 1. Create the `.env` file

```bash
cp .env.example .env
```

The comments in `.env.example` explain each variable, and [Configuration](#-configuration) lists them all. Before the first run, only the gate values need a look:

- `HYPEDDIT_NAME` and `HYPEDDIT_EMAIL` fill in Hypeddit, GateRush and Droploud forms that ask for them. Any name works. The email has to look valid, so a temporary one from a service like [temp-mail.org](https://temp-mail.org) is fine.
- `SC_COMMENT` is the text sc-gate-dl posts for comment gates. Anything works, but Droploud needs at least two characters.
- `INSTAGRAM_HANDLE`, `TIKTOK_HANDLE`, `X_HANDLE` and `YOUTUBE_HANDLE` are optional. Some StillHype follow steps ask for your handle. If you leave one unset, the remote browser asks you instead.

The login step below fills in the SoundCloud values.

### 🔑 2. Log in

```bash
bun start --login
```

Sign in to SoundCloud and Spotify in the windows that open. In the Web UI, **Initialize logins** in the footer does the same.

You sign in to SoundCloud once, in a Firefox window with a fresh temporary profile. On a server, that window opens on the server's display, which the [remote browser view](#-remote-headed-browser-with-novnc) shows. The gate browser then takes over this session to get a login of its own, because it must not share one with the API. Without Firefox, sc-gate-dl warns and you sign in in a CloakBrowser window instead. A gate that hits SoundCloud's sign-in page in a visible browser runs the same flow.

If SoundCloud shows "You have been blocked", reload the page. If that keeps happening, SoundCloud is blocking your network, so try again later or from another connection. The Firefox window uses your system proxy settings, and the CloakBrowser window uses `CLOAKBROWSER_PROXY`.

sc-gate-dl saves the logins here:

| File | Contents |
| --- | --- |
| `.env` | `SC_CLIENT_ID`, `SC_REFRESH_TOKEN` and `SC_OAUTH_TOKEN` |
| `soundcloud-token.json` | The current SoundCloud tokens, renewed automatically |
| `soundcloud-cookies.json` | SoundCloud cookies for the gate browser and yt-dlp, readable only by you |
| `spotify-cookies.json` | Spotify cookies |

Every `bun start` checks the logins first and offers to log in again when the SoundCloud login is missing or rejected. A missing Spotify login is only a warning. Run `bun start --login` again to switch accounts. If an sc-gate-dl server runs from the same folder, restart it after a new login.

#### 🔁 How the SoundCloud login stays valid

SoundCloud's access tokens expire after 24 hours. sc-gate-dl renews them with `SC_REFRESH_TOKEN` and keeps the current ones in `soundcloud-token.json`. Each renewal also replaces the refresh token, so two places that use the same login log each other out. If you run sc-gate-dl in several places, log in separately for each one. When you put a new `SC_REFRESH_TOKEN` in `.env`, sc-gate-dl drops the saved tokens and starts from the new one.

<details>
<summary>Log in manually instead</summary>

**SoundCloud API credentials**

1. Log in on [soundcloud.com](https://soundcloud.com).
2. Open the developer tools (F12) and go to the **Network** tab.
3. Reload the page and filter the requests for `session`.
4. Open the `session` request and go to the **Payload** tab.
5. Copy the client id from **Query String Parameters** to `SC_CLIENT_ID`, and `access_token` from **Request Payload** to `SC_OAUTH_TOKEN`.
6. In the **Application** tab (**Storage** in Firefox), open **Cookies** → `https://soundcloud.com` and copy `oauth_refresh_token` to `SC_REFRESH_TOKEN`.
7. Delete SoundCloud's cookies in this browser without logging out. If the browser keeps using the old refresh token, it and sc-gate-dl log each other out, and logging out may end sc-gate-dl's session too.

**Cookies**

Install a cookie export extension: [EditThisCookie2](https://addons.mozilla.org/en-US/firefox/addon/etc2/) for Firefox, or [EditThisCookie (fork)](https://chromewebstore.google.com/detail/editthiscookie-fork/ihfmcbadakjehneaijebhpogkegajgnk) for Chromium-based browsers.

1. Log in on [soundcloud.com](https://soundcloud.com) (or [accounts.spotify.com](https://accounts.spotify.com) for Spotify).
2. Click the extension's export button.
3. Save the copied text as `soundcloud-cookies.json` (or `spotify-cookies.json`) in the project root.

The gate browser uses the SoundCloud cookies, and yt-dlp uses them to fetch a downloadable track's original upload instead of the 128 kbps stream. An empty file or `[]` counts as no cookies.

</details>

### 💾 3. Save CLI answers (optional)

Without a config file, the CLI asks a few questions on every run. To answer them once:

```bash
cp config.example.json config.json
```

| Key | Meaning |
| --- | --- |
| `headless` | Run the gate browser without a window. |
| `xvfb` | When `headless` is on, run a normal browser on an invisible Xvfb display instead. Sites can detect Chromium's headless mode, but not this. Needs `xorg-server-xvfb` (Arch Linux) or `xvfb` (Debian/Ubuntu). Optional, defaults to `false`. |
| `initializeLogins` | Go through the sign-in flow before the gate runs. Needs `headless` set to `false`. |
| `deleteLosslessAfterConversion` | Delete the lossless source file after converting it. |
| `cleanupSoundCloudAccount` | Undo follows, likes, comments and reposts after a browser gate. |

## 🚀 Usage

### 💻 CLI

```bash
bun start                                   # asks for the track URL
bun start https://soundcloud.com/artist/track
bun start --login                           # log in again first
```

The finished file lands in `./downloads` with tags and artwork. The [output settings](#-output) change the format, the folder, and whether the CLI asks you to review the tags.

### 🌐 Web UI

Start the Web UI with:

```bash
bun webui
```

Once Astro is up, it prints its address, usually [`http://localhost:4321`](http://localhost:4321). On the first run, click **Initialize logins** in the footer.

You can paste a SoundCloud URL or type search terms to search SoundCloud with your account. In the results, a **Free download** badge marks a track the creator made downloadable on SoundCloud, and a **Gate** badge marks a track whose listing links a supported gate. Tracks without a badge can still hide a gate behind a short link, which sc-gate-dl checks when the job starts.

Links can start a job directly. `?url=` (or `?soundcloudUrl=`) sets the track, `outputFormat` the format (`mp3-320`, `m4a-aac`, `flac` or `original`), and `browserMode` the gate browser (`headless`, `xvfb` or `headed`):

```text
http://localhost:4321/?url=https://soundcloud.com/artist/track&outputFormat=mp3-320
```

FLAC output keeps lossless sources lossless. Converting a lossy source to FLAC only changes the container and doesn't bring back the lost quality.

The Web UI also listens on your local network. To open it from other devices or through a reverse proxy, see [Network access](#-network-access).

### 🧩 Userscript

The userscript adds a download icon next to the store and buy links on SoundCloud's feed and track pages. Clicking it opens the Web UI in a floating panel that you can move and resize, while the page behind stays usable.

[![Install userscript](https://img.shields.io/badge/Install%20userscript-Violentmonkey-3b3b3b?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/userscript/sc-gate-dl.user.js)

1. Install [Violentmonkey](https://violentmonkey.github.io/). Tampermonkey works too.
2. Click **Install userscript** above, or open [`userscript/sc-gate-dl.user.js`](https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/userscript/sc-gate-dl.user.js), and confirm.
3. Start the Web UI with `bun webui`.
4. On SoundCloud, click the download icon next to the store or cart button.

Chrome may ask once whether the page may access your local network. If the panel stays blank, use **open in tab** in its toolbar.

The panel toolbar and the Violentmonkey menu (**Choose output format…**, **Choose browser mode…**) set the output format and browser mode. The script remembers both, and the panel's size and position (`sc-gate-dl-panel-geom` in `localStorage`). Other menu options:

- **Always open downloads in new tab** skips the panel.
- **Auto-close after browser download** closes the panel after you save the file or click **Start New Download**. It is on by default.

Closing the panel (× or Escape) or clicking **Cancel download** stops a running job and closes its browser.

#### 🔗 Using a Web UI on another machine

Click the gear button in the panel header, or choose **Configure server…** in the Violentmonkey menu, and enter one or more Web UI addresses, one per line:

```text
http://192.168.178.57:4321
http://100.x.y.z:8123
```

Before a download opens, the script tries the addresses in order and uses the first one that answers. It checks them through Violentmonkey (`GM_xmlhttpRequest`), so LAN and Tailscale addresses work even where the browser blocks pages from reaching private networks (Private Network Access in Chrome and Cromite). After a userscript update, approve the new network permission if Violentmonkey asks. An empty field resets to localhost.

You can also set the list from the console of a SoundCloud tab:

```js
localStorage.setItem(
  'sc-gate-dl-webui-base',
  'http://192.168.178.57:4321\nhttp://100.x.y.z:8123',
)
```

### 📤 Exporting a second account

`bun manage-acc` exports the followed users, liked tracks, reposted tracks and playlists of the account in `MANAGED_SC_CLIENT_ID` and `MANAGED_SC_OAUTH_TOKEN`. Get those values the [manual way](#-2-log-in). The export goes to a timestamped folder in `./exports` and includes `playlists.json` with the playlists' tracks and `reposted-playlists.json`. The downloader doesn't use this account.

## 🔧 Configuration

All settings go in `.env`. Settings marked "server" apply to the API that `bun webui` starts.

### 📁 Output

| Variable | Meaning |
| --- | --- |
| `SC_GATE_DL_CLI_FORMAT` | CLI output format: `mp3` (default), `m4a-aac`, `flac`, or `original` (no conversion or tagging). |
| `SC_GATE_DL_CLI_DIR` | Folder the CLI moves finished files to, for example `~/Music/SoundCloud`. It never replaces a file and names a second copy `Name (2)`. |
| `SC_GATE_DL_REVIEW_TAGS` | `false` skips the tag review in the CLI and Web UI and uses SoundCloud's tags. |
| `SC_GATE_DL_BITRATE` | MP3 and AAC bitrate in kbps for lossless sources, 64 to 320 (default 320). Lossy sources keep their own bitrate, up to this value. |

### 🔐 Sign-in, browser and network

| Variable | Meaning |
| --- | --- |
| `SC_GATE_DL_FIREFOX` | Firefox build for SoundCloud sign-ins, as a path or command (for example `librewolf`), or `off` to sign in in CloakBrowser. |
| `SC_API_PROXY`, `CLOAKBROWSER_PROXY`, `PROXY_URL` | Residential proxy for when SoundCloud blocks your IP. The gate browser uses `CLOAKBROWSER_PROXY` (SOCKS5 preferred) or `PROXY_URL`. SoundCloud API requests use the first one set, in this order. Only reposts, likes and comments are blocked this way; cleanup works without a proxy. |
| `CLOAKBROWSER_GEOIP` | `false` stops matching the browser's timezone and locale to the proxy's location. |
| `BROWSER_HEADLESS` | Server: `false` makes headed the default browser mode for jobs that don't choose one. |
| `SC_GATE_DL_DISABLE_GPU` | `true` turns off GPU access for Chromium, for virtual displays without a GPU. |
| `SC_GATE_DL_DISABLE_DEV_SHM` | `true` keeps Chromium off `/dev/shm`, for containers where it is too small. |
| `BROWSER_VIEW_URL` | Server: address of a noVNC viewer for a [remote headed browser](#-remote-headed-browser-with-novnc). |

### 🗄️ Server

| Variable | Meaning |
| --- | --- |
| `SC_GATE_DL_PORT` | API port (default 3000). If you change it, set `PUBLIC_API_BASE_URL` and update the address in the userscript. |
| `PUBLIC_API_BASE_URL` | API address for the Web UI, when it isn't port 3000 on the Web UI's host. |
| `SC_GATE_DL_ALLOWED_ORIGINS` | Comma-separated extra origins allowed to send `POST` requests, for example a reverse proxy's address for the Web UI. |
| `SC_GATE_DL_DELETE_AFTER_DOWNLOAD` | `true` deletes a finished file once its download has been fully transferred. Interrupted or failed transfers keep the file for a retry. |
| `SC_GATE_DL_LIBRARY_DIR` | Folder in your music library for [library jobs](#-jobs), for example `/home/YOUR_USER/Music/SoundCloud`. |

## 🧠 How it works

### 🔍 Finding the source

sc-gate-dl reads the SoundCloud track and looks for a download source in this order:

1. A gate URL in the track description. These win over store links.
2. The track's purchase link, which can point at a gate or at Bandcamp.
3. When there is no purchase link and no gate in the description, the gate behind the track's Free download box.
4. If nothing is found, the CLI and Web UI offer to download the SoundCloud track itself with yt-dlp.

You can also paste a direct file URL instead of a SoundCloud link: a Dropbox link with `dl=1`, a Google Drive file link, or any http(s) URL that ends in a common audio or archive extension. sc-gate-dl downloads it without a browser, which helps when a gate isn't supported but you already have the link.

### ⚡ Hypeddit without a browser

Hypeddit only checks most of its gates in the browser: email, and the follow, like, comment and repost steps for SoundCloud, Instagram, TikTok, YouTube and Facebook. sc-gate-dl first tries to pass them with plain HTTP requests and downloads the file directly, with live progress in the CLI and Web UI. If a post has a gate that Hypeddit really checks, such as a Spotify gate that can't be skipped, sc-gate-dl falls back to the browser.

### 🚪 Gates in the browser

In the browser, sc-gate-dl handles each Hypeddit step:

| Gate | What sc-gate-dl does |
| --- | --- |
| Email | Enters your name and email. |
| SoundCloud | Skips the follow, like, comment and repost steps, because Hypeddit doesn't check them. Falls back to the old OAuth connect flow when needed. |
| Facebook | Clicks next. No action needed. |
| Instagram, TikTok, YouTube | Skips the follow or subscribe step, because it isn't checked. |
| Spotify | Authorizes Spotify access. |
| Download | Starts the download. |

The other sites have their own downloaders with similar email and social steps. StillHype, PumpYourSound, MyPressKit and fangate.eu check SoundCloud follows, likes, reposts and comments on their server, so they need a real SoundCloud OAuth connection. fangate.eu runs through the site's session API: sc-gate-dl skips visit steps that can be skipped, runs SoundCloud OAuth in the browser, and stops with the step's name at any other step.

### 💿 Bandcamp

When the purchase link or description points at Bandcamp, yt-dlp downloads the file without a browser. For an album link, sc-gate-dl picks the track that matches the SoundCloud title. If that fails, the CLI and Web UI let you pick the track from the album.

### 🎛️ Converting and tagging

| Source | Result |
| --- | --- |
| Lossless (WAV, AIFF, FLAC, ALAC) | Converted to the chosen format: MP3 or AAC at `SC_GATE_DL_BITRATE`, or FLAC. |
| MP3 and AAC | Retagged without re-encoding for MP3 and M4A/AAC output. A raw `.aac` stream goes into an `.m4a` file. FLAC output converts them. |
| Other lossy formats (Ogg, Opus, WebM) | Converted at their own bitrate, up to `SC_GATE_DL_BITRATE`. |

sc-gate-dl keeps existing tags that the SoundCloud metadata doesn't replace, and the comment tag links back to the SoundCloud track.

## 🏠 Running on a server

### 📡 Network access

The Web UI listens on all network interfaces and calls the API on port 3000 of the same host. A Web UI opened at `http://192.168.1.50:4321` uses `http://192.168.1.50:3000`. If the API runs elsewhere, set `PUBLIC_API_BASE_URL`.

The API rejects `POST` requests from browser pages on other origins with a 403, so a website you visit can't start downloads or clean up your SoundCloud account. If a reverse proxy serves the Web UI from a different origin, add it to `SC_GATE_DL_ALLOWED_ORIGINS`. Clients that send no `Origin` header, such as scripts, aren't affected.

### 👀 Remote headed browser with noVNC

With this setup, a server without a screen runs Chromium in headed mode on a virtual display, and you watch and control it from the Web UI. You need it for **Initialize logins**, OAuth consent and captchas.

#### ✅ What you need

- A Linux host with systemd user services and a stable hostname or IP address.
- Bun and the sc-gate-dl dependencies, installed for the service user.
- Xvfb, `xauth`, x11vnc and noVNC.
- LAN or reverse proxy access to the API (3000), Web UI (4321) and noVNC (6080) ports. Keep the raw VNC port (5900) on localhost.
- A VNC password. VNC authentication only uses the first eight characters and doesn't encrypt the connection.

#### 📥 Install

On Arch Linux and Arch Linux ARM:

```bash
sudo pacman -S --needed xorg-server-xvfb xorg-xauth x11vnc
```

Install [noVNC](https://github.com/novnc/noVNC) from your distribution, or clone a release into your user account, and set the VNC password:

```bash
mkdir -p ~/.local/share/sc-gate-dl
git clone --depth 1 --branch v1.7.0 https://github.com/novnc/noVNC.git \
  ~/.local/share/sc-gate-dl/noVNC
mkdir -p ~/.vnc
x11vnc -storepasswd
```

`x11vnc -storepasswd` writes an encrypted `~/.vnc/passwd`, which the services below use. If you'd rather keep a plaintext password file, make it mode `600` and pass it with `-passwdfile`. `-rfbauth` only takes the encrypted format.

Install the dependencies:

```bash
cd ~/sc-gate-dl
bun install --frozen-lockfile
cd webui
bun install --frozen-lockfile
```

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

#### 🛠️ systemd user services

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
# Comma-separated hostnames used to open the Vite-powered Web UI:
Environment=__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=SERVER_NAME,SERVER_NAME.TAILNET.ts.net
ExecStart=/home/YOUR_USER/.bun/bin/bun webui
Restart=on-failure
RestartSec=3
```

</details>

<details>
<summary><code>sc-gate-dl.target</code></summary>

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

To update sc-gate-dl, only the app service needs a restart:

```bash
cd ~/sc-gate-dl
git pull --ff-only
bun install --frozen-lockfile
cd webui && bun install --frozen-lockfile && cd ..
systemctl --user restart sc-gate-app.service
```

To restart the whole stack, stop and start the target, so `PartOf=` stops every service:

```bash
systemctl --user stop sc-gate-dl.target
systemctl --user start sc-gate-dl.target
```

#### 🔒 Private access with Tailscale

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

Vite rejects hostnames it doesn't know, even private ones. Add the short MagicDNS name and the full tailnet name to `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, either in the app service as shown above or in the root `.env`:

```dotenv
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=SERVER_NAME,SERVER_NAME.TAILNET.ts.net
```

Don't set `server.allowedHosts: true`, because an explicit list keeps Vite's DNS rebinding protection. After changing it, reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart sc-gate-app.service
```

With `{host}` in `BROWSER_VIEW_URL`, both `http://192.168.1.50:4321` and `http://SERVER_NAME:4321` work without further changes.

#### 🪟 Using the browser view

With `BROWSER_VIEW_URL` set, the Web UI shows a monitor icon in the top right corner. It opens the remote browser in a floating panel that doesn't block the Web UI behind it.

- The panel opens by itself once a visible headed gate browser starts or login initialization begins. Only choosing headed mode doesn't open it. Leaving that flow or switching to another browser mode closes and disconnects it.
- On the first connection, enter the VNC password. **Remember on this device** stores it in this browser's `localStorage` only, never in an API request, URL or server log. **Forget credentials** removes it, and turning the option off deletes a saved password right away.
- Closing and reopening the panel keeps the VNC connection.
- Drag the header to move the panel and its corners to resize it. It starts at the remote desktop's size, scaled down to fit, and remembers its position and size.
- The header buttons zoom, disconnect, and maximize or restore the panel. Double-clicking the header also maximizes it, and dragging a maximized header restores it.
- On touchscreens, drag with one finger to move the pointer, tap to left-click, hold still to right-click, and drag with two fingers to pan while zoomed in.

VNC authentication doesn't encrypt the connection. Keep port 6080 on a trusted LAN, or put the Web UI, API and noVNC behind a reverse proxy with HTTPS and authentication. When the Web UI uses HTTPS, `BROWSER_VIEW_URL` must use HTTPS too, so the viewer connects over `wss://`.

## 🔌 HTTP API

The API that `bun webui` starts also serves other clients, such as [Nevumi](https://github.com/D3SOX/Nevumi).

### 📨 Jobs

A job created with `"destination": "library"` starts as soon as sc-gate-dl knows the source. It tags the file with SoundCloud's metadata and artwork and moves it to `SC_GATE_DL_LIBRARY_DIR` as `Artist - Title`. It never replaces a file and names a second copy `Artist - Title (2)`. A job with `"destination": "client"` runs the same way but keeps the file for `GET /api/job/:id/file`.

Jobs also accept `"browserMode"` (`headless`, `xvfb` or `headed`, as listed by `GET /api/capabilities`) to choose the gate browser, for example a headed one to watch through `BROWSER_VIEW_URL`.

### 🏷️ Reviewing tags

Web UI jobs stop for a tag review unless the server sets `SC_GATE_DL_REVIEW_TAGS=false`. API jobs stop for one with `"reviewTags": true`, which needs a `destination`.

Once the file is downloaded, such a job waits at the `waiting_metadata` stage. `GET /api/job/:id` then returns:

- `defaultMetadata`: SoundCloud's tags
- `existingMetadata`: the tags already in an MP3
- `downloadFilename`, `outputFormat`, `sourceIsLossless`, `hasArtwork` and `hasExistingArtwork`

`GET /api/job/:id/artwork` and `GET /api/job/:id/existing-artwork` return the two covers.

Finish the job with `POST /api/job/:id/metadata`:

```json
{
  "title": "Track title",
  "artist": "Artist",
  "album": "Album",
  "genre": "Genre",
  "nameAsArtistTitle": true,
  "preserveMetadata": false
}
```

`preserveMetadata: true` keeps the MP3's own tags. `nameAsArtistTitle` defaults to `true` for these jobs. To use a different cover, send the same fields as `multipart/form-data` with an `artwork` file. The endpoint answers `{ "success": true }` right away, and the job continues through `processing_audio` to `ready` or `error`. A second submit gets a 409. `POST /api/job/:id/cancel` drops the waiting file.

### 🔎 Search and artwork

`GET /api/search?q=…&limit=…&offset=…` searches SoundCloud tracks with the configured account. Each result has a `source` hint: `download` for a download the creator enabled, `gate` when the listing links a supported gate, and `none` otherwise. A track marked `none` can still have a gate behind a short link, which sc-gate-dl finds when the job starts.

`GET /api/artwork?url=…` returns a result's cover, so clients never contact SoundCloud themselves. It only fetches from SoundCloud's image CDN.
