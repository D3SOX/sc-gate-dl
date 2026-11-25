<h1><img src="webui/public/favicon.svg" alt="" width="40" height="40" align="left">sc-gate-dl</h1>

sc-gate-dl downloads SoundCloud tracks that sit behind a download gate and tags them with the track's SoundCloud metadata and artwork. You give it a SoundCloud link, and it finds the gate, unlocks it, and saves the file. It works from the command line, from a Web UI, and from a userscript on soundcloud.com.

Supported sources: Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Fangate, Bandcamp, and direct file links.

## ✨ Features

- 🎵 Unlocks Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit and Fangate gates, and downloads Bandcamp releases and direct file links such as Dropbox `dl=1` links.
- 🔄 Finds the gate in the track description, the purchase link, or behind SoundCloud's Free download box.
- ⚡ Skips the browser for gates that are only checked in the browser, which covers most Hypeddit gates and makes them much faster.
- 🎧 Unpacks ZIP downloads, prefers the lossless file, and converts it to MP3, M4A/AAC or FLAC.
- 🏷️ Tags MP3, M4A and FLAC files with SoundCloud's metadata and artwork, and lets you correct the tags before saving.
- 🧹 Can undo the gate actions on your SoundCloud account afterwards (unfollow, unlike, delete comments and reposts).
- 🔎 Web UI with SoundCloud search.
- 🧩 Userscript that opens the Web UI in a panel next to SoundCloud's buy links.
- 🔌 HTTP API for other clients, such as [Nevumi](https://github.com/D3SOX/Nevumi).

## 🚀 Getting started

sc-gate-dl needs [Bun](https://bun.sh), ffmpeg, unzip and yt-dlp, and a throwaway SoundCloud account. [Installation](docs/installation.md) lists everything and walks through the setup.

```bash
git clone https://github.com/D3SOX/sc-gate-dl
cd sc-gate-dl
bun install
cp .env.example .env
bun start --login
```

## 📚 Documentation

| Page | Contents |
| --- | --- |
| [Installation](docs/installation.md) | Requirements, accounts, the `.env` file, and logging in |
| [Usage](docs/usage.md) | The CLI, the Web UI and the userscript |
| [Configuration](docs/configuration.md) | All `.env` variables and `config.json` keys |
| [How it works](docs/how-it-works.md) | How sc-gate-dl finds and unlocks a gate, and how it converts and tags the file |
| [Running on a server](docs/server.md) | Network access, a remote headed browser with noVNC, and Tailscale |
| [HTTP API](docs/api.md) | Jobs, tag review, search and artwork |
