# 📦 Installation

- [📋 Requirements](#-requirements)
- [📥 Install](#-install)
- [📝 1. Create the `.env` file](#-1-create-the-env-file)
- [🔑 2. Log in](#-2-log-in)
- [💾 3. Save CLI answers (optional)](#-3-save-cli-answers-optional)

## 📋 Requirements

| Tool | Needed for |
| --- | --- |
| [Bun](https://bun.sh) | Running sc-gate-dl. |
| [ffmpeg](https://ffmpeg.org) | Converting and tagging audio. It must be on your `PATH`. |
| [unzip](https://infozip.sourceforge.net/UnZip.html) | Gates that deliver a ZIP archive. |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Bandcamp links, and downloading the SoundCloud track itself. Bandcamp also needs yt-dlp's `curl_cffi` backend for Chrome impersonation: `python-curl_cffi` on Arch Linux, or `pip install "yt-dlp[default,curl-cffi]"`. |
| [Firefox](https://www.mozilla.org/firefox/) (recommended) | SoundCloud sign-ins, and Droploud's repost on Linux with an X11 display. SoundCloud's bot protection lets a plain Firefox through more reliably than an automated browser. Without it, you sign in in CloakBrowser, and Droploud reposts there too. |
| [curl-impersonate](https://github.com/lexiforest/curl-impersonate) (recommended) | Reposts and other SoundCloud engagement requests, which SoundCloud's DataDome protection often blocks when Bun sends them. sc-gate-dl uses the newest `curl_chromeN` wrapper on your `PATH` and otherwise falls back to Bun's `fetch`, which may get a 403. |

You also need accounts:

- ☁️ **SoundCloud.** Use a throwaway account. Nobody has reported a ban so far, but I can't guarantee it, and most gates make you repost, like or follow, which you may not want on your main account.
- 💚 **Spotify** (optional). Only needed for Hypeddit posts with a Spotify gate that can't be skipped. Use a throwaway account here too, because these gates save playlists and songs to your library or follow artists.

## 📥 Install

```bash
git clone https://github.com/D3SOX/sc-gate-dl
cd sc-gate-dl
bun install
```

To set up a server with the remote browser view, use the [install script](server.md#-install-script) instead.

## 📝 1. Create the `.env` file

```bash
cp .env.example .env
```

The comments in `.env.example` explain each variable, and [Configuration](configuration.md) lists them all. Before the first run, only the gate values need a look:

- `HYPEDDIT_NAME` and `HYPEDDIT_EMAIL` fill in Hypeddit, GateRush and Droploud forms that ask for them. Any name works. The email has to look valid, so a temporary one from a service like [temp-mail.org](https://temp-mail.org) is fine.
- `SC_COMMENT` is the text sc-gate-dl posts for comment gates. Anything works, but Droploud needs at least two characters.
- `INSTAGRAM_HANDLE`, `TIKTOK_HANDLE`, `X_HANDLE` and `YOUTUBE_HANDLE` are optional. Some StillHype follow steps ask for your handle. If you leave one unset, the remote browser asks you instead.

The login step below fills in the SoundCloud values.

## 🔑 2. Log in

```bash
bun start --login
```

Sign in to SoundCloud and Spotify in the windows that open. In the Web UI, **Initialize logins** in the footer does the same.

You sign in to SoundCloud once, in a Firefox window with a fresh temporary profile. On a server, that window opens on the server's display, which the [remote browser view](server.md#-remote-headed-browser-with-novnc) shows. The gate browser then takes over this session to get a login of its own, because it must not share one with the API. Without Firefox, sc-gate-dl warns and you sign in in a CloakBrowser window instead. A gate that hits SoundCloud's sign-in page in a visible browser runs the same flow.

If SoundCloud shows "You have been blocked", reload the page. If that keeps happening, SoundCloud is blocking your network, so try again later or from another connection. The Firefox window uses your system proxy settings, and the CloakBrowser window uses `CLOAKBROWSER_PROXY`.

Droploud makes you repost the track on SoundCloud, which SoundCloud's bot protection rejects from an automated browser. On Linux with an X11 display, such as the server's Xvfb, sc-gate-dl reposts in a plain Firefox with the gate browser's SoundCloud session instead. It reads the page through the accessibility bus (AT-SPI) and clicks Repost, and slides SoundCloud's verification slider if one appears, with X11 input, then closes Firefox. Firefox uses the gate browser's `CLOAKBROWSER_PROXY` or `PROXY_URL`, which has to be a SOCKS or HTTP proxy without a login for this. On other systems, in Wayland sessions and with a proxy Firefox can't use, the repost stays in CloakBrowser.

sc-gate-dl saves the logins here:

| File | Contents |
| --- | --- |
| `.env` | `SC_CLIENT_ID`, `SC_REFRESH_TOKEN` and `SC_OAUTH_TOKEN` |
| `soundcloud-token.json` | The current SoundCloud tokens, renewed automatically |
| `soundcloud-cookies.json` | SoundCloud cookies for the gate browser and yt-dlp, readable only by you |
| `spotify-cookies.json` | Spotify cookies |

Every `bun start` checks the logins first and offers to log in again when the SoundCloud login is missing or rejected. A missing Spotify login is only a warning. Run `bun start --login` again to switch accounts. If an sc-gate-dl server runs from the same folder, restart it after a new login.

### 🔁 How the SoundCloud login stays valid

SoundCloud's access tokens expire after 24 hours. sc-gate-dl renews them with `SC_REFRESH_TOKEN` and keeps the current ones in `soundcloud-token.json`. Each renewal also replaces the refresh token, so two places that use the same login log each other out. If you run sc-gate-dl in several places, log in separately for each one. When you put a new `SC_REFRESH_TOKEN` in `.env`, sc-gate-dl drops the saved tokens and starts from the new one.

### 🧾 Logging in manually

You only need this when the guided login doesn't work for you, or for the second account that [`bun manage-acc`](usage.md#-exporting-a-second-account) exports.

<details>
<summary>SoundCloud API credentials</summary>

1. Log in on [soundcloud.com](https://soundcloud.com).
2. Open the developer tools (F12) and go to the **Network** tab.
3. Reload the page and filter the requests for `session`.
4. Open the `session` request and go to the **Payload** tab.
5. Copy the client id from **Query String Parameters** to `SC_CLIENT_ID`, and `access_token` from **Request Payload** to `SC_OAUTH_TOKEN`.
6. In the **Application** tab (**Storage** in Firefox), open **Cookies** → `https://soundcloud.com` and copy `oauth_refresh_token` to `SC_REFRESH_TOKEN`.
7. Delete SoundCloud's cookies in this browser without logging out. If the browser keeps using the old refresh token, it and sc-gate-dl log each other out, and logging out may end sc-gate-dl's session too.

</details>

<details>
<summary>Cookies</summary>

Install a cookie export extension: [EditThisCookie2](https://addons.mozilla.org/en-US/firefox/addon/etc2/) for Firefox, or [EditThisCookie (fork)](https://chromewebstore.google.com/detail/editthiscookie-fork/ihfmcbadakjehneaijebhpogkegajgnk) for Chromium-based browsers.

1. Log in on [soundcloud.com](https://soundcloud.com) (or [accounts.spotify.com](https://accounts.spotify.com) for Spotify).
2. Click the extension's export button.
3. Save the copied text as `soundcloud-cookies.json` (or `spotify-cookies.json`) in the project root.

The gate browser uses the SoundCloud cookies, and yt-dlp uses them to fetch a downloadable track's original upload instead of the 128 kbps stream. An empty file or `[]` counts as no cookies.

</details>

## 💾 3. Save CLI answers (optional)

Without a config file, the CLI asks a few questions on every run. To answer them once, copy the example and adjust it as described in [Configuration](configuration.md#-configjson):

```bash
cp config.example.json config.json
```

---

## 👉 Read next

**[🚀 Usage](usage.md)**  
Download your first track with the CLI, the Web UI or the userscript.

<sub>⬅️ Previous: [Documentation](README.md) · 📚 [All docs](README.md)</sub>
