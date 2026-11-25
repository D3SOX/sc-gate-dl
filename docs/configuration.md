# Configuration

Every setting that sc-gate-dl reads, grouped by where it lives. Values are never
shown here. `.env.example` is the template for the operator settings.

## Precedence

1. A request or deep-link choice wins for that job.
2. A stored browser preference (Web UI `localStorage`, userscript storage) comes next.
3. The server default (environment) applies when nothing else was chosen.
4. Built-in defaults apply last.

An invalid stored value is ignored and the next level applies. The environment never
rewrites a stored browser preference.

## Operator settings (`.env`, read at process start)

| Setting | Scope | Default | Valid values |
| --- | --- | --- | --- |
| `SC_COMMENT` | CLI and server | none, required | text of at least 2 characters |
| `SC_CLIENT_ID`, `SC_OAUTH_TOKEN`, `SC_REFRESH_TOKEN` | CLI and server | none | SoundCloud credentials |
| `MANAGED_SC_CLIENT_ID`, `MANAGED_SC_OAUTH_TOKEN` | cleanup of the managed account | none | SoundCloud credentials |
| `HYPEDDIT_NAME`, `HYPEDDIT_EMAIL` | CLI and server | none | only needed when a gate asks for them |
| `SC_GATE_DL_BITRATE` | CLI and server | 320 | MP3: 32 to 320 in the listed steps; AAC: 64 to 320 |
| `SC_GATE_DL_REVIEW_TAGS` | CLI and server | `false` | `true` or `false`, case-insensitive; others stop startup |
| `SC_GATE_DL_CLI_FORMAT`, `SC_GATE_DL_CLI_DIR` | CLI | see `.env.example` | `mp3`, `m4a-aac`, `flac`, `original`; a folder |
| `SC_GATE_DL_PORT` | server | 3000 | whole number from 1 to 65535 |
| `SC_GATE_DL_ALLOWED_ORIGINS` | server | none | comma-separated origins |
| `BROWSER_VIEW_URL` | server | none | `http(s)` URL, `{host}` is replaced |
| `BROWSER_HEADLESS` | server | headless | `false` makes new jobs headed |
| `SC_GATE_DL_LIBRARY_DIR` | server | none | folder for `destination: "library"` |
| `SC_GATE_DL_DELETE_AFTER_DOWNLOAD` | server | `false` | `true` deletes the file after a complete client download |
| `SC_GATE_DL_DISABLE_GPU`, `SC_GATE_DL_DISABLE_DEV_SHM` | browser launch | off | platform workarounds |
| `SC_API_PROXY`, `CLOAKBROWSER_PROXY`, `PROXY_URL`, `CLOAKBROWSER_GEOIP` | browser and SoundCloud API | none | proxy URL; `false` turns geo lookup off |

`PUBLIC_API_BASE_URL` is a Web UI build setting, not a server setting. It is baked
into the bundle when the Web UI is built. Restarting the server does not change an
already-built bundle.

## CLI arguments

`bun start [--login] [url]`. `--login` runs the guided SoundCloud and Spotify login
before anything else. Broken logins go straight to the browser; working ones are only redone after a yes to "Log in again anyway?". Without it the guided
login is only offered when a login is missing, expired or invalid, and only in a
terminal. `SC_GATE_DL_ENV_FILE` (tests only) points the `.env` writer elsewhere.

## CLI configuration (`config.json`)

`headless`, `xvfb`, `initializeLogins`, `deleteLosslessAfterConversion`,
`cleanupSoundCloudAccount`. When a key has an environment equivalent (none today),
the environment wins. Without `config.json` the CLI asks interactively.
`config.json` is never migrated automatically.

## Per-request options (`POST /api/job`, `POST /api/job/:id/metadata`)

`outputFormat`, `destination`, `browserMode`, `reviewTags`, `skipAutomaticHypedditFetch`,
and on finalization `preserveMetadata`, `nameAsArtistTitle`, the tag fields and an
uploaded `artwork`. They are job options, not `.env` settings. An omitted `reviewTags`
uses `SC_GATE_DL_REVIEW_TAGS` for jobs with a destination.
`GET /api/capabilities` reports the browser modes, the remote-view URL, library
availability and `reviewTagsDefault`.

## Browser preferences

Web UI `localStorage`: `sc-gate-dl-browser-mode`, `sc-gate-dl-output-format`,
`sc-gate-dl-review-tags`. Deep-link parameters: `url`, `browserMode`, `outputFormat`,
`reviewTags`, `embedded`.

Userscript storage keys: `sc-gate-dl-webui-base`, `sc-gate-dl-api-base`,
`sc-gate-dl-panel-geom`, `sc-gate-dl-queue-geom`, `sc-gate-dl-output-format`,
`sc-gate-dl-browser-mode`, `sc-gate-dl-auto-close`, `sc-gate-dl-always-open-tab`.

## Test-only controls (not user configuration)

`SC_GATE_DL_TEST_FIXTURE_JOB`, `SC_GATE_DL_TEST_FIXTURE_JOB_FORMAT` and
`SC_GATE_DL_TEST_FIXTURE_JOB_FINISH` and `SC_GATE_DL_TEST_FIXTURE_JOB_DESTINATION` seed a fake job for HTTP tests. They only take
effect together with `SC_GATE_DL_ALLOW_TEST_FIXTURES=1`, so a stray variable cannot
create a job in normal operation.
`SC_GATE_DL_SECOND_VOLUME` points a delivery test at a second filesystem.
Do not set them in a real deployment.

## Internal

`CLOAKBROWSER_SUPPRESS_FONT_WARNING` is set by the code itself. `TMPDIR` is a platform
variable. `SC_GATE_PROGRESS` is a line prefix used between the downloader and the
server, not a setting.

## SoundCloud login and where it is stored

SoundCloud rotates the refresh token on every renewal, so the old one stops working
at once. Every renewed pair is therefore written to two places in the same call:

- `soundcloud-token.json` (mode 600, ignored by git) is the source of truth for the
  running process and other processes in the same folder.
- `.env` receives `SC_OAUTH_TOKEN` and `SC_REFRESH_TOKEN` (user-approved), so the next
  start begins from the latest pair. The write replaces the file atomically with mode
  600, keeps every other line and comment, and never logs a value. If the write fails
  the run continues and the message says the login was not saved.

Browser cookies stay in `soundcloud-cookies.json` and `spotify-cookies.json` (both
ignored). They are not copied into `.env`: they are session data for the browser, not
settings. Spotify is mandatory like SoundCloud: a missing, broken or expired
`spotify-cookies.json` stops the CLI before any download (`bun start --login` fixes it).

When a renewal is not possible (refresh token revoked, expired or rotated elsewhere),
the check reports `expired` or `invalid` and says to log in again and set
`SC_REFRESH_TOKEN`. A network error or a rate limit is `unverifiable` and keeps the
stored login. No token is ever copied by hand except after such a message.
`SC_GATE_DL_ENV_FILE` points the writer at another file; it is meant for tests.
