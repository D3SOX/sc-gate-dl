# 🚀 Usage

- [💻 CLI](#-cli)
- [🌐 Web UI](#-web-ui)
- [🧩 Userscript](#-userscript)
- [📤 Exporting a second account](#-exporting-a-second-account)

Set up sc-gate-dl as described in [Installation](installation.md) first.

## 💻 CLI

```bash
bun start                                   # asks for the track URL
bun start https://soundcloud.com/artist/track
bun start --login                           # only log in
bun start --login https://soundcloud.com/artist/track  # log in first
```

The finished file lands in `./downloads` with tags and artwork. The [output settings](configuration.md#-output) change the format, the folder, and whether the CLI asks you to review the tags. When the track has no gate, the CLI offers to download it from SoundCloud with yt-dlp, or asks you for a gate, Bandcamp or direct file link.

## 🌐 Web UI

Start the Web UI with:

```bash
bun webui
```

Once Astro is up, it prints its address, usually [`http://localhost:4321`](http://localhost:4321). On the first run, choose **Initialize logins** from the menu next to the title. `bun webui` runs Astro's dev server. For a production build, which you want on a server, use `bun run serve` as described in [Running on a server](server.md).

You can paste a SoundCloud URL or type search terms to search SoundCloud with your account. In the results, a **Free download** badge marks a track the creator made downloadable on SoundCloud, and a **Gate** badge marks a track whose listing links a supported gate. Tracks without a badge can still hide a gate behind a short link, which sc-gate-dl checks when the job starts. When it finds no gate, you can paste a gate or direct file link, or download the SoundCloud stream with yt-dlp.

Links can start a job directly. `?url=` (or `?soundcloudUrl=`) sets the track, `outputFormat` the format (`mp3-320`, `m4a-aac`, `flac` or `original`), and `browserMode` the gate browser (`headless`, `xvfb` or `headed`):

```text
http://localhost:4321/?url=https://soundcloud.com/artist/track&outputFormat=mp3-320
```

FLAC output keeps lossless sources lossless. Converting a lossy source to FLAC only changes the container and doesn't bring back the lost quality.

The Web UI also listens on your local network. To open it from other devices or through a reverse proxy, see [Network access](server.md#-network-access).

## 🧩 Userscript

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
- **Feed position controls…** opens a box on your SoundCloud Stream that remembers the newest and the oldest track you played there. Its links scroll the Stream back to either one, **Find track URL…** scrolls to any track, and **Reset up** and **Reset down** start the newest or oldest position over.

Closing the panel (× or Escape) or clicking **Cancel download** stops a running job and closes its browser.

### 🔗 Using a Web UI on another machine

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

## 📤 Exporting a second account

`bun manage-acc` exports the followed users, liked tracks, reposted tracks and playlists of the account in `MANAGED_SC_CLIENT_ID` and `MANAGED_SC_OAUTH_TOKEN`. Get those values the [manual way](installation.md#-logging-in-manually). The export goes to a timestamped folder in `./exports` and includes `playlists.json` with the playlists' tracks and `reposted-playlists.json`. The downloader doesn't use this account.

---

## 👉 Read next

**[🔧 Configuration](configuration.md)**  
Change the output format or folder, add a proxy, or look up any `.env` variable or `config.json` key.

<sub>⬅️ Previous: [Installation](installation.md) · 📚 [All docs](README.md)</sub>
