# 🧠 How it works

- [🔍 Finding the source](#-finding-the-source)
- [⚡ Hypeddit without a browser](#-hypeddit-without-a-browser)
- [🚪 Gates in the browser](#-gates-in-the-browser)
- [💿 Bandcamp](#-bandcamp)
- [🎧 Converting and tagging](#-converting-and-tagging)

## 🔍 Finding the source

sc-gate-dl reads the SoundCloud track and looks for a download source in this order:

1. A download the creator enabled on SoundCloud. yt-dlp fetches the original upload with your SoundCloud cookies and skips the gate. Without working cookies, sc-gate-dl warns and continues with the gate.
2. A gate URL in the track description. These win over store links.
3. The track's purchase link, which can point at a gate or at Bandcamp.
4. When there is no purchase link and no gate in the description, the gate behind the track's Free download box.

Short links and smart links in these places are followed to the gate behind them. If nothing is found, the CLI and Web UI ask for a gate link, or offer to download the SoundCloud track itself with yt-dlp. A gate link can also be a direct file URL: a Dropbox link with `dl=1`, a Google Drive file link, or any http(s) URL that ends in a common audio or archive extension. sc-gate-dl downloads it without a browser, which helps when a gate isn't supported but you already have the link.

## ⚡ Hypeddit without a browser

Hypeddit only checks most of its gates in the browser: email, and the follow, like, comment and repost steps for SoundCloud, Instagram, TikTok, YouTube and Facebook. sc-gate-dl first tries to pass them with plain HTTP requests and downloads the file directly, with live progress in the CLI and Web UI. If a post has a gate that Hypeddit really checks, such as a Spotify gate that can't be skipped, sc-gate-dl falls back to the browser.

## 🚪 Gates in the browser

In the browser, sc-gate-dl handles each Hypeddit step:

| Gate | What sc-gate-dl does |
| --- | --- |
| Email | Enters your name and email. |
| SoundCloud | Skips the follow, like, comment and repost steps, because Hypeddit doesn't check them. Falls back to the old OAuth connect flow when needed. |
| Facebook | Clicks next. No action needed. |
| Instagram, TikTok, YouTube | Skips the follow or subscribe step, because it isn't checked. |
| Spotify | Authorizes Spotify access. |
| Download | Starts the download. |

The other sites have their own downloaders with similar email and social steps. StillHype, PumpYourSound, MyPressKit and Fangate check SoundCloud follows, likes, reposts and comments on their server, so they need a real SoundCloud OAuth connection. Fangate runs through the site's session API: sc-gate-dl skips visit steps that can be skipped, runs SoundCloud OAuth in the browser, and stops with the step's name at any other step.

After a browser gate, sc-gate-dl can undo the follows, likes, comments and reposts on your SoundCloud account (`cleanupSoundCloudAccount` in [`config.json`](configuration.md#-configjson) for the CLI).

## 💿 Bandcamp

When the purchase link or description points at Bandcamp, yt-dlp downloads the file without a browser. For an album link, sc-gate-dl picks the track that matches the SoundCloud title. If that fails, the CLI and Web UI let you pick the track from the album.

## 🎧 Converting and tagging

When a gate delivers a ZIP archive, sc-gate-dl unpacks it and picks the audio file, preferring a lossless one.

| Source | Result |
| --- | --- |
| Lossless (WAV, AIFF, FLAC, ALAC) | Converted to the chosen format: MP3 or AAC at `SC_GATE_DL_BITRATE`, or FLAC. |
| MP3 and AAC | Retagged without re-encoding for MP3 and M4A/AAC output. A raw `.aac` stream goes into an `.m4a` file. FLAC output converts them. |
| Other lossy formats (Ogg, Opus, WebM) | Converted at their own bitrate, up to `SC_GATE_DL_BITRATE`. |

sc-gate-dl keeps existing tags that the SoundCloud metadata doesn't replace, and the comment tag links back to the SoundCloud track. The `original` format skips conversion and tagging.
