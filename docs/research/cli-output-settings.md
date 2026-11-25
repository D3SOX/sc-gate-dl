# CLI output settings: platform research

Research date: 2026-11-23. This note describes mechanisms and open decisions, not a product specification. Source-code references to FFmpeg are pinned to 9.0.2 where possible; behavior can differ by build and version. Local experiments used only synthetic fixtures under the approved OpenCode temporary directory, not downloaded audio or credentials.

## Existing application boundaries

- `package.json` defines `start` as `bun run .`. `src/index.ts` calls `AudioProcessor.processAudio(..., 'mp3-320', ...)` and does not consume `SC_GATE_DL_AAC_BITRATE`. The server reads that variable, rounds and clamps it to 64–320 kbps, and defaults invalid/unset values to 320 (`src/server.ts`, `src/audioProcessor.ts`, `.env.example`). That range is **existing application policy**, not an AAC codec limit.
- `OutputFormat` currently includes `original`, `mp3-320`, `m4a-aac`, and `flac` (`src/types.ts`). `processAudio` excludes `original`, accepts a filename relative to `./downloads`, converts probed lossless audio only, and otherwise retags supported lossy inputs or leaves them untouched. The server handles `original` separately without calling `processAudio` (`src/server.ts`, `src/audioProcessor.ts`). Selecting `original` for CLI therefore requires a separate path; its exact metadata semantics are a product decision.
- Downloads, extraction, artwork, conversions and renames have multiple `./downloads` dependencies, not just the final conversion (`src/audioProcessor.ts`, `src/ytdlp.ts`, `src/downloadRename.ts`, `src/archiveAudio.ts` and downloader implementations). `processAudio` returns an output **path**, including for passthrough; do not infer the final extension from the requested format. Source deletion may occur inside processing, according to `losslessHandling`.

## MP3: request versus representable bitrate

`-b:a` sets audio bitrate in **bits/s**; `128k` means 128,000 bits/s, and `:a` matches audio streams. The FFmpeg libmp3lame wrapper converts bits/s to integer kbps with `/ 1000`; without `-q:a` or `-abr 1` it calls LAME's CBR setter. `-q:a` and ABR are different modes, so the tables below are not a VBR quality scale. Sources: [FFmpeg codec options](https://ffmpeg.org/ffmpeg-codecs.html#Codec-Options), [stream specifiers and SI prefixes](https://ffmpeg.org/ffmpeg.html#Stream-specifiers-1), [9.0.2 wrapper](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/libmp3lame.c).

The upstream LAME encoder's non-free-format Layer III CBR tables and output sample-rate groups are:

| MPEG version | Output sample rate (Hz) | LAME CBR nominal choices (kbps) |
| --- | --- | --- |
| 1 | 32000, 44100, 48000 | 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320 |
| 2 | 16000, 22050, 24000 | 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160 |
| 2.5 | 8000, 11025, 12000 | 8, 16, 24, 32, 40, 48, 56, 64 |

These are **LAME's encoder choices**, not a claim about all decoders or free-format streams. In particular, the LAME table restricts MPEG-2.5 to 64 kbps even though decoder implementations can use broader low-sampling-frequency tables. Sources: [LAME tables](https://sourceforge.net/p/lame/svn/HEAD/tree/trunk/lame/libmp3lame/tables.c?format=raw), [FFmpeg MPEG audio header parsing](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/mpegaudiodecheader.c), [FFmpeg wrapper sample rates](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/libmp3lame.c).

LAME's CBR initialization uses `FindNearestBitrate` for the output sample rate; the cited implementation chooses the lower candidate on an exact tie. Thus accepting an arbitrary integer or checking only 64–320 cannot guarantee the requested nominal value. The FFmpeg wrapper fixes LAME's input and output rate to its negotiated encoder rate; automatic FFmpeg format negotiation/resampling may change the rate from the source, so inspect the **actual output**. The wrapper supports mono/stereo, and encoder initialization can fail; check actual build support with `ffmpeg -encoders` and `ffmpeg -h encoder=libmp3lame`. Sources: [LAME initialization](https://sourceforge.net/p/lame/svn/HEAD/tree/trunk/lame/libmp3lame/lame.c?format=raw), [nearest selection](https://sourceforge.net/p/lame/svn/HEAD/tree/trunk/lame/libmp3lame/util.c?format=raw), [FFmpeg 9.0.2 wrapper](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/libmp3lame.c), [FFmpeg command and automatic conversion](https://ffmpeg.org/ffmpeg.html#Filtering).

## AAC, FLAC and Original

- FFmpeg documents native `aac` `-b:a` in bits/s as its bitrate-mode setting; `-q:a` selects a quality-based mode. An encoder target is not a promise that every frame, the stream average, or the full file has that exact rate. Current online documentation may describe features/defaults newer than 9.0.2; the local 9.0.2 help lists `twoloop` as default, not the newer documented coder. Sources: [FFmpeg native AAC](https://ffmpeg.org/ffmpeg-codecs.html#aac), [9.0.2 encoder source](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/aacenc.c).
- In **9.0.2 source**, AAC caps the requested target at `6 * channels * sample_rate` bits/s, warning when it clamps; unsupported channel layouts and profiles can fail. At 11,025 Hz this cap is 66,150 bps mono or 132,300 bps stereo. This is an initialization target cap, **not** an assertion that these rates will be achieved or a universal range for other AAC encoders/versions. Low requested rates can also produce a very different measured rate. Source: [9.0.2 `aac_encode_init` and rate-control loop](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/aacenc.c).
- FLAC is lossless for the PCM supplied to its encoder and the current conversion uses `-compression_level 8`, not `-b:a`; Original involves no bitrate-controlled re-encode. FLAC output size/bitrate is not a fixed-quality bitrate setting. **Caveat:** FLAC losslessness does not guarantee an arbitrary source-to-FLAC pipeline is bit-identical if sample format, depth, or channels change; FFmpeg 9.0.2 can reduce input depth to 24 bits. Sources: [Xiph FLAC](https://xiph.org/flac/features.html), [FFmpeg FLAC options](https://ffmpeg.org/ffmpeg-codecs.html#flac-2), [9.0.2 FLAC initialization](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/flacenc.c).

## Observations: local FFmpeg / ffprobe 9.0.2

Homebrew's build reports `--enable-libmp3lame`; help reports `libmp3lame` mono/stereo and the nine rates above. Native `aac` reports sample rates 7350–96000 Hz from its discrete list. These observations apply only to this build, not every FFmpeg installation. A three-second 1 kHz synthetic sine, with explicitly selected output rate/channels, produced the following (`ffprobe` bps; all exits zero unless stated):

| Encoder, Hz, channels, requested | Audio `stream.bit_rate` | `format.bit_rate` / observation |
| --- | ---: | --- |
| MP3, 44100, 2, 128k | 128000 | 130517 |
| MP3, 44100, 2, 130k | 128000 | 130517; no warning at `-loglevel warning` |
| MP3, 22050, 2, 320k | 160000 | 164514; no warning |
| MP3, 22050, 2, 144k | 144000 | 148074 |
| MP3, 11025, 2, 128k | 64000 | 69216; no warning |
| AAC, 44100, 2, 128k | 128046 | 132584 |
| AAC, 44100, 2, 320k | 221311 | 226570 |
| AAC, 11025, 1, 320k | 37849 | 41533; warning: clamped to max |
| AAC, 11025, 2, 320k | 56017 | 60264; warning: clamped to max |
| AAC, 44100, 2, 1k | 21280 | 24992 |

With explicit `-ac 6`, `libmp3lame` failed at initialization for 5.1 on this build; the native AAC fixture succeeded. These simple tones do not establish audio quality, production-track averages, or cross-build guarantees. FFmpeg's MP3 header parser derives the nominal stream bitrate from frame headers; MP4/M4A muxer calculates an average from packet sizes and duration where possible. Container `format.bit_rate` describes the whole file, not just encoded audio, so tags, artwork, container data, delay and duration affect comparison. Sources: [MP3 frame header parser](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavcodec/mpegaudiodecheader.c), [9.0.2 MP4 average calculation](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/movenc.c), [ffprobe sections and packets](https://ffmpeg.org/ffprobe.html#Main-options).

For verification, inspect stream and container separately, including tags and cover disposition:

```sh
ffprobe -v error -show_format -show_streams -of json OUTPUT
ffprobe -v error -select_streams a:0 -show_packets -show_entries packet=size,duration_time -of json OUTPUT
```

`stream.bit_rate` may be absent or estimated depending on format and probe; packet-size/duration calculations have their own priming, padding and duration caveats. Do not equate `format.bit_rate` with nominal audio bitrate, or assert AAC equals the requested target. The MP3 muxer writes cover pictures as ID3v2 APIC; in 9.0.2 the MOV muxer recognizes a cover stream with `attached_pic` disposition and writes `covr`. Verify both tags and cover independently, since they affect output and measurements. Sources: [ffprobe optional fields](https://ffmpeg.org/ffprobe.html#Main-options), [FFmpeg MP3 muxer](https://ffmpeg.org/ffmpeg-formats.html#mp3), [MOV muxer source](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/movenc.c).

## Bun environment and output directories

Bun automatically loads `.env`, then the `NODE_ENV`-specific `.env.production`, `.env.development` or `.env.test`, then `.env.local` except under test, then the corresponding mode-specific `.local`; later files have higher precedence. Explicit `--env-file` and `--no-env-file` / `bunfig.toml` `env = false` alter loading. Bun exposes values through `process.env`; its script runner executes a package script in a subshell. Sources: [Bun environment docs](https://bun.com/docs/runtime/environment-variables), [Bun package scripts](https://bun.com/docs/runtime#run-a-package-json-script).

On **Bun 1.4.4**, an isolated synthetic package with the same `start: "bun run ."` observed `.env.local` overriding `.env`, `.env.test.local` winning with `NODE_ENV=test`, and an inherited shell variable winning over those files. Invoking `bun start` from a child directory of that synthetic package ran the script with the package-root cwd and loaded its root `.env`, not the child's. These are observations for this version and layout; do not promise that arbitrary launchers, Bun versions, explicit flags, or nested invocations select the same files. In particular, an outer invocation's flags need not automatically configure the separately invoked inner `bun run .`.

`process.cwd()` is the running process's working directory, not necessarily the invoking shell's original directory or the source-file directory. `path.resolve()` uses cwd when no absolute path has been supplied; it does not imply shell-style `~` expansion. Decide and document the base for relative `SC_GATE_DL_CLI_DIR` values, empty/unset handling, and whether to create missing directories. `mkdir(..., { recursive: true })` is available; permissions, an existing non-directory, and other I/O errors still require handling. Sources: [Node process.cwd](https://nodejs.org/api/process.html#processcwd), [Node path.resolve](https://nodejs.org/api/path.html#pathresolvepaths), [Node mkdir](https://nodejs.org/api/fs.html#fspromisesmkdirpath-options).

Node's `fsPromises.rename` is a rename operation, not a portable cross-filesystem move; POSIX specifies `EXDEV` when cross-filesystem links are unsupported. Existing destinations may be replaced by rename, and a copy/delete fallback is not atomic as a whole. A future delivery flow must account for collisions, partial copies and failed cleanup and must not remove the only good source before successful delivery; a destination-local temporary file followed by rename is one possible design, subject to collision policy. Sources: [Node rename](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath), [Node copyFile](https://nodejs.org/api/fs.html#fspromisescopyfilesrc-dest-mode), [POSIX rename and EXDEV](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html).

## Proposed implementation plan

This is a plan, not implemented behavior. Decisions explicitly approved by the user are separated from proposed details and unresolved questions.

### 1. Configuration contract

User-approved contract:

- `SC_GATE_DL_CLI_DIR` controls the final CLI output location. Downloads, ZIP extraction and processing remain in `./downloads`. When a lossless source is deliberately retained, deliver it to the configured directory as well.
- If `SC_GATE_DL_CLI_DIR` is unset, preserve the current `./downloads` destination. Resolve relative paths from the process working directory, expand `~` to the user's home directory, create missing directories, and never overwrite an existing destination file. The behavior of `~otheruser` remains unspecified; it must not be silently interpreted as the current user's home directory.
- Choose the CLI target persistently through `.env`; support MP3, M4A/AAC, FLAC and Original. Original means no conversion or retagging of the selected audio file. Existing ZIP extraction precedes this choice and is not byte-for-byte preservation of the archive.
- Use **one common bitrate setting** for configurable MP3 and M4A/AAC in both the CLI and server. The bitrate relevant to the selected format is used; FLAC and Original do not use it.
- Preserve `outputFormat: "mp3-320"` as the existing fixed-320-kbps API selection. Add a separate configurable MP3 format, and show that configurable choice as `MP3` in the Web UI instead of the existing `MP3 320` control. Legacy `mp3-320` remains available to existing API clients.
- Replace `SC_GATE_DL_AAC_BITRATE` with `SC_GATE_DL_BITRATE`: the old setting no longer supplies a fallback. The common setting defaults to 320 kbps when unset. Existing installations using the old setting must migrate its value to the new variable; otherwise AAC returns to the 320-kbps default. This is an intentional configuration compatibility break.
- Invalid common bitrate settings are errors when a configurable MP3 or AAC target is selected, even if the eventual source is lossy and will not be encoded. Inputs must be whole numbers of kbps. For configurable MP3, the accepted values are the MPEG-1 rates in section 2 above: 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256 and 320 kbps. For AAC the selected common value must be in the inclusive 64–320 kbps range. MPEG output sampling constraints can still make an accepted MP3 setting unrepresentable for a particular input.
- Warn and keep successful output if the requested MP3 nominal rate cannot be met for a particular source or the AAC encoder reports a capped target. Do not silently change sample rate or channels to force a rate. Keep the existing no-lossy-re-encoding rule.

Proposed names and details, not user-approved implementation decisions:

```dotenv
SC_GATE_DL_CLI_DIR=~/Music/SoundCloud
SC_GATE_DL_CLI_FORMAT=m4a-aac
SC_GATE_DL_BITRATE=256
```

The proposed CLI format values are `mp3`, `m4a-aac`, `flac` and `original`. CLI default `mp3` with a 320-kbps default preserves the current effective default. The user approved whole-number-only common bitrate inputs; this differs from the former AAC parser, which rounded decimals.

### 2. CLI delivery

1. Parse the CLI output configuration before a gate is opened. Report invalid format or path configuration clearly; never change the process working directory, because cookies, configuration, browser profile and other paths depend on it.
2. Keep downloads and processing in their existing shared working directory. Capture `processAudio`'s returned path rather than predicting an output filename: a lossy file may retain its original extension. For `original`, bypass metadata prompts and audio processing just as server Original does, after any ZIP extraction.
3. Deliver the completed audio to `SC_GATE_DL_CLI_DIR`. Reuse the existing collision-safe `moveIntoLibrary` behavior only after verifying its failure semantics for this use. Explicitly handle the destination being `./downloads` or resolving to the same directory; do not move a file onto itself or generate an unnecessary duplicate.
4. When source retention is selected, deliver both the source and result safely. If conversion or delivery fails, report the surviving file paths and retain at least one intact copy of each required artifact. Source deletion must not happen before the selected output is safely delivered. This requires coordinating `losslessHandling` with delivery; the current conversion can delete or replace the source before delivery, especially for ALAC/M4A and FLAC inputs with the same destination extension.
5. Handle cross-filesystem destinations, existing filenames, partial-copy failures and rollback without replacing unrelated files. Print the actual final paths. Whether multiple-file delivery should be all-or-nothing remains open; an implementation must not silently lose or discard either file on a partial failure.

### 3. Format and bitrate wiring

1. Add an explicit configurable `mp3` output value and keep `mp3-320` fixed at its existing encoder request of 320 kbps. At unusual sample rates, the installed encoder can still select a different supported nominal bitrate; distinguish the fixed request from a guarantee of resulting bitrate.
2. Read `SC_GATE_DL_BITRATE` for both CLI and server. The configurable `mp3` and `m4a-aac` paths use it; legacy `mp3-320` does not. Default to 320 when the common setting is absent. Remove the old `SC_GATE_DL_AAC_BITRATE` parsing and current-configuration documentation; document the intentional migration break.
3. Pass the configured value to the MP3 and AAC encoder paths. Validate when the relevant target is selected, before downloading even when the eventual source is lossy; fail with the actual setting name, format and supported values. FLAC, Original and fixed `mp3-320` do not consume the common setting.
4. For MP3, compare the requested nominal rate against the resulting audio stream bitrate, not the container bitrate. For AAC, surface encoder cap warnings; do **not** treat every difference between measured average and target as an error or proof of clamping. Surface warnings in CLI output and server logs; structured API/Web UI warnings are out of scope.
5. Update server request validation, CLI selection, Web UI format control, deep-link handling, stored Web UI preferences, format hints and API documentation. Existing `mp3-320` links and API requests must still work. `userscript/sc-gate-dl.user.js` also names `mp3-320` explicitly, so check its selected format and deep links for backward compatibility rather than assuming it is covered by the shared types.
6. Preserve audio metadata and cover behavior and the original SoundCloud URL in the comment on processed outputs. Original remains unmodified; supported lossy source formats remain unencoded but can be retagged as today.

### 4. Verification

- Add configuration tests for absence, invalid values per selected format, MP3 discrete choices, AAC bounds and legacy `mp3-320` behavior. Verify the obsolete AAC variable is not used as a fallback.
- Add CLI-oriented tests for MP3, M4A/AAC, FLAC, Original and lossy passthrough, checking actual output paths and extensions. Cover directory creation, a pre-existing destination, same-directory operation, retained sources, cross-device copy, and a failed transfer without losing source data.
- Use synthetic lossless fixtures and `ffprobe` to check MP3 requested versus actual nominal bitrate, AAC's reported output without asserting exact equality to its target, metadata/comment/cover, and behavior for low-sample-rate and unsupported channel cases. Preserve the source if FFmpeg or delivery fails.
- Test Web UI/API/deep-link and userscript compatibility, particularly `mp3` versus `mp3-320`, and ensure `SC_GATE_DL_CLI_DIR` does not affect server/Web UI download storage.

### 5. Remaining questions

- How retained-source delivery should behave on a partial two-file transfer is not specified beyond never overwriting or losing files.
- The user requested `~` expansion. The intended interpretation of `~otheruser` is still unspecified; ordinary `~` and `~/...` refer to the current user's home directory.

Search note: the configured SearXNG service was unreachable; primary documentation and source were fetched directly. No service restart or user data access was performed.
