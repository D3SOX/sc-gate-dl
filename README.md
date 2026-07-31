# sc-gate-dl

Download and tag SoundCloud tracks unlocked via Hypeddit, Droploud, GateRush, DownloadGater, or Bandcamp.

## Features

- 🎵 Automatically download audio from Hypeddit, Droploud, GateRush, DownloadGater, and Bandcamp links
- ⚡ Browserless fast path that skips the browser for gates that don't need real verification (see [How It Works](#how-it-works))
- 🔄 Handles multiple gate types (see [How It Works](#how-it-works))
- 📝 Fetches metadata from the provided SoundCloud link
- 🎨 Manual metadata correction before finalizing
- 🎧 Converts Lossless (WAV/AIFF/FLAC) files to MP3 (320kbps)
- 🏷️ Tags MP3 files with metadata and artwork from SoundCloud
- 🧹 Optional cleanup of the SoundCloud account (unfollow, unlike, delete comments/reposts)

## Prerequisites

- [**Bun**](https://bun.sh) - JavaScript runtime and package manager
- [**ffmpeg**](https://ffmpeg.org) - Must be installed and available in your `PATH`
- [**yt-dlp**](https://github.com/yt-dlp/yt-dlp) - Required for Bandcamp purchase/download links and for downloading a SoundCloud track directly when no gate is found
- **SoundCloud account** - It is recommended to create a throwaway account for this. Even though there were no reports of accounts getting banned I can't guarantee it. Also most gate downloads require reposts/likes/follows which you might not want to do with your main account
- **Spotify account** (optional) - Required when a Hypeddit post has an unskippable Spotify gate. I also recommend creating a throwaway account as most Hypeddit downloads require saving playlists/songs to your library or following artists which you might not want on your main account.

## Installation

Clone the repository

```bash
git clone https://github.com/D3SOX/hypeddit-soundcloud-downloader
cd hypeddit-soundcloud-downloader
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

#### SoundCloud Cookies (Required)

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

If it's the first time you're running it you will need to initialize the logins by clicking the button in the footer.

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

Droploud, GateRush, and DownloadGater gates are handled via their own downloaders with similar email / social unlock flows.

**Bandcamp / yt-dlp**: When a SoundCloud track’s purchase URL (or description) points at Bandcamp instead of a gate, the file is downloaded with [yt-dlp](https://github.com/yt-dlp/yt-dlp) (browserless). For Bandcamp album links, the matching track is selected from the SoundCloud title. Traditional unlock gates still take priority if both are present. If no gate or Bandcamp URL is found, the CLI and Web UI can fall back to downloading the SoundCloud track itself via yt-dlp.

**File Processing**:

- **Lossless (WAV/AIFF/FLAC) files**: Converted to MP3 (320kbps) with metadata and artwork
- **MP3 files**: Retagged with metadata and artwork (no re-encoding)
