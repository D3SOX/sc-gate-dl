# 🔌 HTTP API

- [📨 Jobs](#-jobs)
- [🔖 Reviewing tags](#-reviewing-tags)
- [🔎 Search and artwork](#-search-and-artwork)
- [📋 Endpoints](#-endpoints)

The API that `bun webui` and `bun run serve` start on port 3000 also serves other clients, such as [Nevumi](https://github.com/D3SOX/Nevumi). Browser pages on other origins can't send it `POST` requests, as described in [Network access](server.md#-network-access).

## 📨 Jobs

Create a job with `POST /api/job`:

```json
{
  "soundcloudUrl": "https://soundcloud.com/artist/track",
  "outputFormat": "mp3-320",
  "destination": "library"
}
```

| Field | Meaning |
| --- | --- |
| `soundcloudUrl` | The track. Required. |
| `outputFormat` | `mp3-320` (default), `m4a-aac`, `flac` or `original`. |
| `destination` | `library` or `client`, for jobs that run without the Web UI. See below. |
| `browserMode` | `headless`, `xvfb` or `headed`, as listed by `GET /api/capabilities`. Without it, the server's `BROWSER_HEADLESS` default applies. A headed browser can be watched through `BROWSER_VIEW_URL`. |
| `reviewTags` | `true` stops the job for a [tag review](#-reviewing-tags). Needs a `destination`. |
| `skipAutomaticHypedditFetch` | `true` skips the gate lookup, so the job waits for a gate link. |

The response has the `jobId`, the track, the gate it found (`hypedditUrl`), and `needsHypedditUrl` when there is none. `GET /api/job/:id` returns the job, and `GET /api/job/:id/events` streams its progress as server-sent events.

A job created with `"destination": "library"` starts as soon as sc-gate-dl knows the source. It tags the file with SoundCloud's metadata and artwork and moves it to `SC_GATE_DL_LIBRARY_DIR` as `Artist - Title`. It never replaces a file and names a second copy `Artist - Title (2)`. A job with `"destination": "client"` runs the same way but keeps the file for `GET /api/job/:id/file`. A job without a `destination`, like the ones the Web UI creates, waits for `POST /api/job/:id/start`.

## 🔖 Reviewing tags

Web UI jobs stop for a tag review unless the server sets `SC_GATE_DL_REVIEW_TAGS=false`. API jobs stop for one with `"reviewTags": true`.

Once the file is downloaded, such a job waits at the `waiting_metadata` stage. `GET /api/job/:id` then returns:

- `defaultMetadata`: SoundCloud's tags
- `existingMetadata`: the tags already in an MP3
- `downloadFilename`, `fileSize` (in bytes), `outputFormat`, `sourceIsLossless`, `hasArtwork` and `hasExistingArtwork`

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

## 🔎 Search and artwork

`GET /api/search?q=…&limit=…&offset=…` searches SoundCloud tracks with the configured account. Each result has a `source` hint: `download` for a download the creator enabled, `gate` when the listing links a supported gate, and `none` otherwise. A track marked `none` can still have a gate behind a short link, which sc-gate-dl finds when the job starts.

`GET /api/artwork?url=…` returns a result's cover, so clients never contact SoundCloud themselves. It only fetches from SoundCloud's image CDN.

## 📋 Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/capabilities` | Browser modes, `BROWSER_VIEW_URL`, whether library jobs and tag review are on, and a warning when Firefox is missing |
| `GET /api/search`, `GET /api/artwork` | [Search and artwork](#-search-and-artwork) |
| `POST /api/job` | Create a job |
| `GET /api/job/:id` | The job and its progress |
| `GET /api/job/:id/events` | Progress as server-sent events |
| `POST /api/job/:id/hypeddit` | Set the gate link with `{ "hypedditUrl": "…" }` when none was found |
| `POST /api/job/:id/start` | Start a job without a `destination` |
| `POST /api/job/:id/bandcamp-track` | Pick the album track with `{ "trackUrl": "…" }` when the job waits at `waiting_bandcamp_track` |
| `POST /api/job/:id/metadata` | Finish a [tag review](#-reviewing-tags) |
| `GET /api/job/:id/artwork`, `GET /api/job/:id/existing-artwork` | The covers for the tag review |
| `GET /api/job/:id/file` | Download the finished file |
| `POST /api/job/:id/cancel` | Cancel the job and close its browser |
| `POST /api/soundcloud/cleanup` | Undo the gate actions on the SoundCloud account |
| `POST /api/logins/initialize` | Start the guided sign-in, as **Initialize logins** in the Web UI does |

---

## 👉 Read next

**[📚 Documentation](README.md)**  
That was the last page. Head back to the overview of all pages.

<sub>⬅️ Previous: [Running on a server](server.md)</sub>
