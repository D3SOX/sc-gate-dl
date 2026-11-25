# 🔧 Configuration

- [🚪 Gates and accounts](#-gates-and-accounts)
- [📁 Output](#-output)
- [🔐 Sign-in, browser and network](#-sign-in-browser-and-network)
- [📡 Server](#-server)
- [💾 `config.json`](#-configjson)

All settings go in `.env`, which you create from [`.env.example`](../.env.example). Settings marked "server" apply to the API that `bun webui` and `bun run serve` start. The CLI also reads `config.json` for the answers it would otherwise ask for.

## 🚪 Gates and accounts

| Variable | Meaning |
| --- | --- |
| `HYPEDDIT_NAME`, `HYPEDDIT_EMAIL` | Name and email for Hypeddit, GateRush and Droploud forms that ask for them. The email has to look valid. |
| `SC_COMMENT` | Text for SoundCloud comment gates. Droploud needs at least two characters. |
| `INSTAGRAM_HANDLE`, `TIKTOK_HANDLE`, `X_HANDLE`, `YOUTUBE_HANDLE` | Your handles for StillHype follow steps that ask for them. Unset ones are asked for in the remote browser. |
| `SC_CLIENT_ID`, `SC_REFRESH_TOKEN`, `SC_OAUTH_TOKEN` | The SoundCloud login. `bun start --login` fills them in. See [Installation](installation.md#-2-log-in). |
| `MANAGED_SC_CLIENT_ID`, `MANAGED_SC_OAUTH_TOKEN` | A separate account for [`bun manage-acc`](usage.md#-exporting-a-second-account). The downloader doesn't use it. |

## 📁 Output

| Variable | Meaning |
| --- | --- |
| `SC_GATE_DL_CLI_FORMAT` | CLI output format: `mp3` (default), `m4a-aac`, `flac`, or `original` (no conversion or tagging). |
| `SC_GATE_DL_CLI_DIR` | Folder the CLI moves finished files to, for example `~/Music/SoundCloud`. It never replaces a file and names a second copy `Name (2)`. |
| `SC_GATE_DL_REVIEW_TAGS` | `false` skips the tag review in the CLI and Web UI and uses SoundCloud's tags. |
| `SC_GATE_DL_BITRATE` | MP3 and AAC bitrate in kbps for lossless sources, 64 to 320 (default 320). Lossy sources keep their own bitrate, up to this value. |

## 🔐 Sign-in, browser and network

| Variable | Meaning |
| --- | --- |
| `SC_GATE_DL_FIREFOX` | Firefox build for SoundCloud sign-ins, as a path or command (for example `librewolf`), or `off` to sign in in CloakBrowser. |
| `SC_API_PROXY`, `CLOAKBROWSER_PROXY`, `PROXY_URL` | Residential proxy for when SoundCloud blocks your IP. The gate browser uses `CLOAKBROWSER_PROXY` (SOCKS5 preferred) or `PROXY_URL`. SoundCloud API requests use the first one set, in this order. SoundCloud only blocks reposts, likes and comments this way, so cleanup works without a proxy. |
| `CLOAKBROWSER_GEOIP` | `false` stops matching the browser's timezone and locale to the proxy's location. |
| `BROWSER_HEADLESS` | Server: `false` makes headed the default browser mode for jobs that don't choose one. |
| `SC_GATE_DL_DISABLE_GPU` | `true` turns off GPU access for Chromium, for virtual displays without a GPU. |
| `SC_GATE_DL_DISABLE_DEV_SHM` | `true` keeps Chromium off `/dev/shm`, for containers where it is too small. |
| `BROWSER_VIEW_URL` | Server: address of a noVNC viewer for a [remote headed browser](server.md#-remote-headed-browser-with-novnc). |

## 📡 Server

| Variable | Meaning |
| --- | --- |
| `SC_GATE_DL_PORT` | API port (default 3000). If you change it, set `PUBLIC_API_BASE_URL` and update the address in the userscript. |
| `PUBLIC_API_BASE_URL` | API address for the Web UI, when it isn't port 3000 on the Web UI's host. |
| `SC_GATE_DL_ALLOWED_ORIGINS` | Comma-separated extra origins allowed to send `POST` requests, for example a reverse proxy's address for the Web UI. |
| `SC_GATE_DL_DELETE_AFTER_DOWNLOAD` | `true` deletes a finished file once its download has been fully transferred. Interrupted or failed transfers keep the file for a retry. |
| `SC_GATE_DL_LIBRARY_DIR` | Folder in your music library for [library jobs](api.md#-jobs), for example `/home/YOUR_USER/Music/SoundCloud`. |

## 💾 `config.json`

Without this file, the CLI asks these questions on every run. Copy [`config.example.json`](../config.example.json) to `config.json` to answer them once.

| Key | Meaning |
| --- | --- |
| `headless` | Run the gate browser without a window. |
| `xvfb` | When `headless` is on, run a normal browser on an invisible Xvfb display instead. Sites can detect Chromium's headless mode, but not this. Needs `xorg-server-xvfb` (Arch Linux) or `xvfb` (Debian/Ubuntu). Optional, defaults to `false`. |
| `initializeLogins` | Sign in again in the gate browser before the gate runs, for when its saved login stopped working. `bun start` already checks the logins from `bun start --login`, so leave this `false` normally. Needs `headless` set to `false`, and the CLI sets it back to `false` after the sign-in. |
| `deleteLosslessAfterConversion` | Delete the lossless source file after converting it. |
| `cleanupSoundCloudAccount` | Undo follows, likes, comments and reposts after a browser gate. |
