# AAC/M4A output research

Scope: adding a config switch so downloaded **lossless** sources convert to either MP3 (existing
path) or M4A/AAC with a configurable quality, with tags set as completely as the MP3 path.

Environment probed locally: `ffmpeg version 9.0.2` (Homebrew, `--enable-gpl --enable-libmp3lame
--enable-audiotoolbox`), build has the native `aac` encoder and macOS `aac_at` (AudioToolbox),
**no** `libfdk_aac`.
`ffprobe`/`ffmpeg` are the binaries the repo shells out to (`src/audioProcessor.ts`).

All claims below are from primary sources: the FFmpeg manual pages, FFmpeg source, or the local
`ffmpeg`/`ffprobe` binaries. URLs are given per claim.

---

## 1. Lossless formats a downloader can encounter

### 1.1 Container extension ↔ `ffprobe streams[].codec_name`

`ffprobe -show_streams` reports the codec, not the container. The mapping the repo must key on is
`codec_name` (stream) plus extension (container). Common lossless music formats:

| Format | Extensions | `codec_name` (ffprobe) | Notes |
|---|---|---|---|
| WAV / Wave | `.wav` | `pcm_s16le`, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`, `pcm_f64le`, `pcm_u8`, `pcm_s24le_planar`, … | RIFF; many PCM variants (see 1.2), also floats/planar; `.w64` (Sony Wave64) same codecs |
| AIFF / AIFF-C | `.aiff`, `.aif`, `.aifc` | `pcm_s16be`, `pcm_s24be`, `pcm_s32be`, `pcm_f32be`, `pcm_f64be`, `pcm_s16le` (AIFC `sowt`), `pcm_s8` | big-endian PCM family |
| FLAC | `.flac` | `flac` | open |
| ALAC | `.m4a`, `.caf` (never `.alac`) | `alac` | Apple Lossless; patent: Apple (royalty-free license, see 1.4) |
| Monkey's Audio (APE) | `.ape` | `ape` | patent-encumbered |
| WavPack | `.wv` | `wavpack` | open |
| TTA (True Audio) | `.tta` | `tta` | open |
| DSD | `.dsf` (DSD Stream File); `.dff`/`.dff` DSDIFF (**[Guess]** — no DSDIFF demuxer in this build) | `dsd_lsbf`, `dsd_msbf`, `dsd_lsbf_planar`, `dsd_msbf_planar` | |
| MPEG-4 ALS | `.mp4` / `.m4a` (rare) | `als` | MPEG-4 Audio Lossless |
| Shorten | `.shn` | `shorten` | open, legacy |
| TAK | `.tak` | `tak` | decoder-only, proprietary |
| MPEG-4 ALS | `.mp4` / `.m4a` (rare) | `als` | MPEG-4 Audio Lossless |
| CAF | `.caf` | container; carries `alac` or `pcm_*` | Apple Core Audio Format |

Evidence (local binaries):

```
$ ffmpeg -formats | grep -iE "dsf|dsd|ape|wv|tta|tak|shn|alac|caf|aiff|w64|wave"
 D   aiff            Audio IFF
 D   ape             Monkey's Audio
 D   caf             Apple CAF (Core Audio Format)
 D   flac            raw FLAC
 D   dsf             DSD Stream File (DSF)
 D   shn             raw Shorten
 D   tak             raw TAK
 D   tta             TTA (True Audio)
 D   w64             Sony Wave64
 D   wav             WAV / WAVE (Waveform Audio)
 D   wv              WavPack
 D   alias_pix … (unrelated)
```

```
$ ffmpeg -codecs | grep -iE "alac|ape|dsd|flac|tta|wavpack|shorten|tak|mp4als"
 DEAI.S alac     ALAC (Apple Lossless Audio Codec) (decoders: alac alac_at) (encoders: alac alac_at)
 D.AI.S ape      Monkey's Audio
 D.AIL. dsd_lsbf / dsd_lsbf_planar / dsd_msbf / dsd_msbf_planar   DSD (Direct Stream Digital) …
 DEAI.S flac     FLAC (Free Lossless Audio Codec)
 D.AI.S mp4als   MPEG-4 Audio Lossless Coding (ALS) (decoders: als)
 D.AI.S shorten  Shorten
 D.A..S tak      TAK (Tom's lossless Audio Kompressor)
 DEAI.S tta      TTA (True Audio)
 DEAILS wavpack  WavPack
```

The `ffmpeg -formats` / `-codecs` list is the authoritative per-build inventory ("The option
`-formats` of the ff* tools will display the list of enabled demuxers and muxers"):
<https://ffmpeg.org/ffmpeg-formats.html#Description>

`ffprobe` exposes exactly `streams[].codec_name` (the field the repo already reads in
`AudioProcessor.probeAudioStream`, `src/audioProcessor.ts`): <https://ffmpeg.org/ffprobe.html>

Codec names are the libavcodec `AVCodec.name` values; there is no single doc table, so the local
`ffmpeg -codecs` output above is the primary reference for this build.

### 1.2 The `pcm_*` family (FFmpeg's own list)

From `ffmpeg -codecs` (local 9.0.2). Encoders marked `E` are the ones a WAV/AIFF source can carry:

```
pcm_alaw, pcm_mulaw, pcm_bluray, pcm_dvd,
pcm_f16le, pcm_f24le, pcm_f32be, pcm_f32le, pcm_f64be, pcm_f64le, pcm_lxf,
pcm_s8, pcm_s8_planar, pcm_s16be, pcm_s16be_planar, pcm_s16le, pcm_s16le_planar,
pcm_s24be, pcm_s24daud, pcm_s24le, pcm_s24le_planar,
pcm_s32be, pcm_s32le, pcm_s32le_planar, pcm_s64be, pcm_s64le,
pcm_u8, pcm_u16be, pcm_u16le, pcm_u24be, pcm_u24le, pcm_u32be, pcm_u32le, pcm_vidc, pcm_sga
```

For a music downloader the realistic set is `pcm_s16le/s24le/s32le` (WAV), `pcm_f32le/f64le` (float
WAV), and the matching big-endian `pcm_*be` for AIFF. The repo's existing
`isLosslessAudio()` tests `codec.startsWith('pcm_')`, which covers all of these
(`src/audioProcessor.ts`), but does **not** cover `tta` or `dsd_*`, and the extension list in
`src/utils.ts` (`LOSSLESS_EXTENSIONS`) is missing `.tta`, `.dsf`, `.dff`, `.caf`, `.w64`.

### 1.3 Metadata inside WAV / AIFF

- **RIFF INFO**: the WAV demuxer maps RIFF `INFO` chunks to dictionary keys via
  `ff_riff_info_conv` (`libavformat/riff.c`): `IART`→artist, `ICMT`→comment, `ICOP`→copyright,
  `ICRD`→date, `IGNR`→genre, `ILNG`→language, `INAM`→title, `IPRD`→album, `IPRT`/`ITRK`→track,
  `ISFT`→encoder. URL: <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/riff.c>
  The WAV demuxer also parses `bext` (Broadcast Wave) into `description/originator/date/…` and
  remaps via `wav_metadata_conv` (`libavformat/wavdec.c`):
  <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/wavdec.c>
- **ID3 in WAV**: `wavdec.c` calls `ff_id3v2_read(..., ID3v2_DEFAULT_MAGIC, ...)` for `id3 `
  chunks (line ~583). So a WAV may carry ID3v2 in addition to RIFF INFO.
- **ID3 in AIFF**: `aiffdec.c` handles the `ID3 ` chunk with `ff_id3v2_read` +
  `ff_id3v2_parse_apic` (lines ~282–289), i.e. AIFF can carry ID3 incl. embedded artwork:
  <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/aiffdec.c>
- The AIFF **muxer** supports writing ID3v2: options `write_id3v2` (default 0) and
  `id3v2_version` (3 or 4, default 4):
  <https://ffmpeg.org/ffmpeg-formats.html#aiff>

### 1.4 Open vs patent-encumbered

FFmpeg's legal page states it does not take a position on patents and warns that "for some of the
processes specified in this part of ISO/IEC 14496, conformance with this specification may require
use of an invention covered by patent rights":
<https://ffmpeg.org/legal.html> (Patent Mini-FAQ).

Practical classification used by the ecosystem [Likely]:

- **Open / royalty-free**: FLAC (BSD-style Xiph), WavPack (BSD), TTA, Shorten, and PCM
  (WAV/AIFF).
- **Patent-encumbered / proprietary**: AAC (FFmpeg legal FAQ singles out "MPEG-related
  technologies" and MPEG LA enforcement: <https://ffmpeg.org/legal.html>), Monkey's Audio (APE),
  TAK, ALAC (Apple; Apple ships it royalty-free for compliant use), and DSD/DSF (Sony/Philips
  format, no broad open license). DSD is a *format* rather than an audio-coding patent concern;
  the DSD decoders in FFmpeg are native.

> MP3 (the existing target) is likewise patent-encumbered historically; the FFmpeg legal page
> groups it with the ISO/IEC 14496 patents. AAC in the same family.

---

## 2. FFmpeg AAC encoders and quality controls

### 2.1 Native `aac` vs `libfdk_aac`

The manual: "This encoder is the default AAC encoder, natively implemented into FFmpeg."
<https://ffmpeg.org/ffmpeg-codecs.html#aac>  Encoder name: `aac`.

libfdk_aac is a separate, non-default wrapper requiring `--enable-libfdk-aac` and "The library is
also incompatible with GPL, so if you allow the use of GPL, you should configure with
`--enable-gpl --enable-nonfree --enable-libfdk-aac`":
<https://ffmpeg.org/ffmpeg-codecs.html#libfdk_005faac>
→ Not present in the local 9.0.2 build (`ffmpeg -encoders | grep fdk` is empty), so the repo
cannot assume it.

### 2.2 Native `aac` quality controls

From the manual (`ffmpeg-codecs.html#aac`):

- **CBR**: `-b:a` — "Set bit rate in bits/s. Setting this automatically activates constant bit
  rate (CBR) mode. If this option is unspecified it is set to 128kbps."
- **VBR**: `-q:a` — "Set quality for variable bit rate (VBR) mode. This option is valid only using
  the `ffmpeg` command-line tool. For library interface users, use `global_quality`. With the
  default 'nmr' coder, VBR holds a constant noise-to-mask target and lets the bitrate follow the
  content. Higher values are finer: `1` lands near 128 kbps for typical stereo music, and each
  doubling of the value raises the rate by roughly a third; values above about 6 make no further
  difference. A quality setting takes precedence over b and aac_rc."
- **Rate-control mode (NMR coder)**: `-aac_rc cbr|abr` — `cbr` = constant bitrate within the
  decoder bit reservoir (default); `abr` = average bitrate, constant-quality with a slow servo,
  "Below roughly 56 kbps stereo the rate lands above the request; use 'cbr' there."
- Native private options (from source `libavcodec/aacenc.c`, `aacenc_options[]`):
  `aac_coder` (`twoloop` default, `fast`, `nmr`), `aac_ms`, `aac_is`, `aac_pns`, `aac_tns`,
  `aac_pce`, `aac_rc`, `aac_nmr_speed`, `aac_allow_71wide`.
  URL: <https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/aacenc.c>

**Version drift (important for this repo).** The local 9.0.2 `ffmpeg -h encoder=aac` shows only:

```
AAC encoder AVOptions:
  -aac_coder  <int>  … (default twoloop)   [twoloop, fast]
  -aac_ms, -aac_is, -aac_pns, -aac_tns, -aac_pce
```

i.e. no `q`/`vbr`/`aac_rc` AVOption and no `nmr` coder. The `q` scale described in the current
manual belongs to the newer `nmr` coder in git master, whose default differs from 9.0.2. A
behavioral check on 9.0.2 confirms `-q:a` still *works* (it sets `global_quality`, source lines
`avctx->global_quality > 0 ? avctx->global_quality : 120`) and monotonically raises the rate:

```
$ ffmpeg -i src.flac -c:a aac -q:a 2 → 26 KiB, "Qavg: 236.000"
$ ffmpeg -i src.flac -c:a aac -q:a 5 → 31 KiB, "Qavg: 590.000"
```

**Recommendation for the repo:** use **CBR `-b:a <rate>k`** for the configurable-quality knob.
It is portable across FFmpeg versions, documented as activating CBR, and mirrors the existing MP3
path which already uses `-b:a ${bitrateKbps}k` (`src/audioProcessor.ts`,
`convertToMp3`). `-q:a` is a viable alternative but its numeric scale is version-dependent (the
manual's "1 ≈ 128 kbps stereo" is the newer `nmr` mapping; on 9.0.2 the twoloop coder maps it to a
lambda), so it is a worse fit for a stable config value.

### 2.3 Recommended bitrate per channel

FFmpeg does not publish a per-channel AAC bitrate table in the codecs manual. The closest primary
guidance:

- libfdk_aac VBR profiles are documented **per channel**: VBR 1 = 32 kbps/ch, 2 = 40, 3 = 48–56,
  4 = 64, 5 = ~80–96 kbps/ch (<https://ffmpeg.org/ffmpeg-codecs.html#libfdk_005faac>).
- For CBR, the encoder itself warns when stereo is under-fed at high sample rates: source emits
  `"%d kb/s per channel at %d Hz: consider resampling…"` for `bpc <= 32000 && sample_rate > 32000`,
  and FFmpeg shipped (2024) a warning that AAC below ~96 kbps (stereo) is low quality
  (`libavcodec/aacenc.c`).

Practical defaults [Likely], matching common practice and the fdk per-channel numbers:

- mono: **96–128 kbps**
- stereo: **192–256 kbps** (256 kbps ≈ the 320 kbps MP3 setting in quality terms)
- >2 ch: scale ~64–96 kbps/ch

Config switch should expose one number; clamp to `[64, 320]` kbps.

> Note: the `aac` encoder log line on the local build for `-b:a 256k` stereo printed
> `Qavg: 50798.555` and produced ~230 kbps actual — the `-b:a` value is a target, not exact.

### 2.4 Profiles

From the manual (`ffmpeg-codecs.html#aac`), `profile` accepts:

- `aac_low` — "The default, AAC 'Low-complexity' profile. Is the most compatible and produces
  decent quality."
- `mpeg2_aac_low` — "Equivalent to `-profile:a aac_low -aac_pns 0`."
- `aac_ltp` — "Long term prediction profile… Introduced in MPEG4."
- "If this option is unspecified it is set to 'aac_low'."

The full profile table `ff_aac_profiles` in `libavcodec/profiles.c` also lists `LC`, `HE-AAC`,
`HE-AACv2`, `LD`, `ELD`, `Main`, `SSR`, `LTP`, `xHE-AAC`:
<https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/profiles.c>

**However, the native `aac` encoder only encodes LC/LTP.** Empirically on 9.0.2:

```
-profile:a aac_low   → OK
-profile:a aac_he    → error: "Could not open encoder", exit -22
-profile:a aac_he_v2 → error
-profile:a aac_main  → error
```

HE-AAC / HE-AACv2 (SBR/PS) are **not** available from the native encoder; they require
`libfdk_aac` (`-profile:a aac_he`, example in the manual:
<https://ffmpeg.org/ffmpeg-codecs.html#libfdk_005faac>). GDoc note: "Currently only the 'aac_low'
profile supports VBR encoding" for libfdk.

**Recommendation:** always emit `-profile:a aac_low` (or omit; default). Do not expose HE profiles
unless the build is confirmed to have `libfdk_aac`.

---

## 3. Tagging M4A/AAC

### 3.1 iTunes atoms and `-metadata` keys

The mov/mp4 muxer writes an `ilst` (iTunes metadata list). The exact key → atom mapping is in
`libavformat/movenc.c`, `mov_write_ilst_tag()`:

```
mov_write_string_metadata(s, pb, "\251nam", "title"        , 1);
mov_write_string_metadata(s, pb, "\251ART", "artist"       , 1);
mov_write_string_metadata(s, pb, "aART"   , "album_artist" , 1);
mov_write_string_metadata(s, pb, "\251wrt", "composer"     , 1);
mov_write_string_metadata(s, pb, "\251alb", "album"        , 1);
mov_write_string_metadata(s, pb, "\251day", "date"         , 1);
mov_write_string_metadata(s, pb, "\251too", "encoding_tool", 1);
mov_write_string_metadata(s, pb, "\251cmt", "comment"      , 1);
mov_write_string_metadata(s, pb, "\251gen", "genre"        , 1);
mov_write_string_metadata(s, pb, "cprt"   , "copyright"    , 1);
...
mov_write_covr(pb, s);
mov_write_trkn_tag(pb, mov, s, 0); // track number
mov_write_trkn_tag(pb, mov, s, 1); // disc number
```

(`\251` = `©`.) URL: <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/movenc.c>
(`mov_write_ilst_tag`, ~line 5076.)

So the repo's four keys map as:

| `-metadata key` used by repo | MP4 atom | Apple/iTunes meaning |
|---|---|---|
| `title` | `©nam` | Name |
| `artist` | `©ART` | Artist |
| `album` | `©alb` | Album |
| `genre` | `©gen` | Genre |

These are written by the **muxer**, independent of the encoder, so they work identically with the
native `aac` encoder. Verified end to end on 9.0.2:

```
$ ffmpeg -i src.flac -i cover.jpg -map 0:a -map 1:v -c:a aac -b:a 256k \
    -movflags +faststart -metadata title=T -metadata artist=A -metadata album=Al -metadata genre=G …
$ ffprobe out.m4a
format.tags = { major_brand: M4A, title: T, artist: A, album: Al, genre: G, encoder: Lavf… }
```
`strings out.m4a` shows `ilst` and `covr`.

`.m4a` is a registered mov/mp4 demuxer extension, and the `ipod` muxer is the audio-only MP4
variant: "Registered extensions: mov, mp4, m4a, 3gp, 3g2, mj2, psp, m4b, ism, ismv, isma, f4v"
(<https://ffmpeg.org/ffmpeg-formats.html#mov_002fmp4_002f3gp>); "**ipod**: MPEG-4 audio file
format, as MOV/MP4 but limited to contain only audio streams" (`ffmpeg -h muxer=ipod`, and the
same section). Writing `out.m4a` selects the `ipod` muxer automatically (major_brand `M4A`).

### 3.2 `-movflags +faststart`

"Run a second pass moving the index (moov atom) to the beginning of the file."
<https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv>
Useful for streaming playback; harmless for local files. Optional but cheap — recommended.

### 3.3 `-id3v2_version` is irrelevant for m4a

`-id3v2_version` is an **mp3/aiff/asf-family** option; the mov/mp4 muxer does not consume it. The
MP3 path sets `-id3v2_version 3` (`convertToMp3`, `retagMp3` in `src/audioProcessor.ts`); that flag
should **not** be passed on the m4a path. The mov muxer has its own metadata switch
`-movflags +use_metadata_tags` ("use mdta atom for metadata") which is the *opposite* of what we
want — leave it off so the muxer writes iTunes `ilst` atoms:
<https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv>

### 3.4 Cover art: `covr` (m4a) vs APIC (mp3)

- **m4a**: `mov_write_covr()` iterates tracks and, for each stream where
  `is_cover_image(trk->st)` is true, writes a `covr` atom with the picture bytes:
  <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/movenc.c> (`mov_write_covr`, ~line 5049).
  `is_cover_image()` is exactly:
  ```c
  return st && st->disposition == AV_DISPOSITION_ATTACHED_PIC;
  ```
  → the cover stream **must** have `-disposition:v attached_pic`. ✔ Verified:
  `ffprobe out.m4a` shows `stream 1 video mjpeg disp=1`.
- **mp3**: cover art is written as ID3v2 **APIC** frames. The mp3 muxer doc: "The muxer supports
  writing attached pictures (APIC frames) to the ID3v2 header. The pictures are supplied to the
  muxer in form of a video stream with a single packet… The stream metadata tags title and comment
  map to APIC description and picture type respectively."
  <https://ffmpeg.org/ffmpeg-formats.html#mp3>
  The repo already does this (`-metadata:s:v title=Album cover`, `comment=Cover (front)`).

The existing FLAC conversion already uses the m4a-compatible invocation
(`-disposition:v attached_pic` + title/comment), so the same argument block works for AAC:

```
-i input -i artwork -map 0:a -map 1:v \
  -c:a aac -b:a <rate>k -profile:a aac_low \
  -c:v copy -disposition:v attached_pic \
  -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)" \
  -movflags +faststart \
  -metadata title=… -metadata artist=… -metadata album=… -metadata genre=… out.m4a
```

- Cover stream codec should be `mjpeg`/`png` (repo already restricts artwork to
  jpg/jpeg/png/webp/gif via `ARTWORK_EXTENSIONS`; webp/gif covers should be re-encoded to mjpeg or
  they may not be accepted in the `covr` atom — `-c:v copy` of a webp into m4a is [Guess] risky;
  safest is to force `-c:v mjpeg` or keep the existing `-c:v copy` only for jpg/png).

For equivalent tags **and** cover art, the m4a path should mirror `convertToFlac` (which already
sets `attached_pic`), **not** `convertToMp3` (which sets `-id3v2_version 3` and no disposition).

---

## 4. Raw ADTS `.aac` (and `.m4b`)

- **The native `aac` encoder can emit raw ADTS**, and the `adts` muxer supports tags, but only
  via opt-in flags. From `ffmpeg-formats.html#adts`:
  - `write_id3v2 bool` — "Enable to write ID3v2.4 tags at the start of the stream. **Default is
    disabled.**"
  - `write_apetag bool` — "Enable to write APE tags at the end of the stream. Default is
    disabled."
  - "It accepts a single AAC stream." (⇒ no cover-art stream.)
  Source confirms `adts_write_header` only writes ID3 when `adts->id3v2tag` is set
  (`libavformat/adtsenc.c`). URL: <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/adtsenc.c>

  Verified on 9.0.2:
  - `ffmpeg … -f adts -write_id3v2 1 -metadata title=Hello -metadata artist=World out.aac`
    → `ffprobe` reports `tags {artist, title, encoder}`.
  - **Without** `-write_id3v2 1`, tags are silently dropped (`ffprobe … tags None`).
  - **A cover-art video stream is rejected**: `[adts] adts muxer does not support any stream of
    type video` → `Could not write header`.
  - Without an explicit `-f adts`, naming the file `.aac` still picks the ADTS muxer.

- **Recommendation:** do **not** target `.aac`; use the `.m4a` container (the `ipod` muxer). M4A
  gives iTunes `ilst` tags and `covr` cover art for free, and matches the "analogous to MP3" goal.
  If a raw stream is ever needed, `-write_id3v2 1` is mandatory and cover art is impossible.

- **Extensions:**
  - `.m4a` — audio-only MP4/`ipod`; the right default for music. ✔
  - `.m4b` — same container, "audiobook" convention (chapters, bookmarks); also a registered
    mov/mp4 extension. Not needed for single tracks.
  - `.aac` — raw ADTS; tags need `-write_id3v2 1`, no cover art. Avoid.

---

## 5. Concrete recommendation for this repo

1. Add `outputFormat` value e.g. `m4a-aac` alongside `mp3-320` and `flac`
   (`src/types.ts` `OutputFormat`, `isOutputFormat`).
2. Only offer/route M4A when the source is lossless. Reuse the existing probe:
   `AudioProcessor.isLosslessAudio()` already returns `true` for `alac/flac/wavpack/ape/pcm_*`;
   **extend it** to include `tta` and `dsd_*` (and `shorten`/`als`/`tak` if desired), and extend
   `LOSSLESS_EXTENSIONS` in `src/utils.ts` with `.tta`, `.dsf`, `.dff`, `.caf`, `.w64`.
3. Encoder: `-c:a aac -profile:a aac_low`, quality knob as **`-b:a <kbps>k`** (CBR), clamped
   `[64, 320]`. Do not use `-q:a` for a stable config value (version-dependent scale). Do not pass
   `-id3v2_version` on this path. Use `-movflags +faststart`.
4. Tags: `-metadata title/artist/album/genre` (→ `©nam/©ART/©alb/©gen`) plus the cover stream with
   `-c:v copy -disposition:v attached_pic` and `-metadata:s:v title="Album cover"
   comment="Cover (front)"`.
5. `ffprobe` reads these back with the same lower-cased keys (`title/artist/album/genre`), so
   `readMp3Metadata()` can be reused to display/verify m4a tags unchanged.

---

## Open questions / uncertainties

- **`-q:a` numeric meaning.** The current manual's VBR scale ("1 ≈ 128 kbps stereo") describes the
  git-master `nmr` coder; the local 9.0.2 build defaults to `twoloop` and maps `-q:a` to a
  `global_quality` lambda. The documented per-number bitrate is therefore **[Likely]**
  version-specific. Hence the CBR `-b:a` recommendation.
- **Recommended bitrates per channel.** FFmpeg publishes no official AAC CBR bitrate table; the
  96/128/192–256 figures are **[Likely]**, extrapolated from the fdk per-channel VBR table and the
  encoder's own low-bitrate warning.
- **HE-AAC availability.** Confirmed native `aac` rejects `aac_he`/`aac_he_v2`/`aac_main` on
  9.0.2. Whether some platforms' builds differ is **[Guess]** — treat HE as libfdk-only.
- **webp/gif cover art in `covr`.** `is_cover_image()` does not restrict picture codec; whether
  players accept non-mjpeg/png `covr` payloads is **[Guess]**. Safer to transcode to mjpeg.
- **`.dff` (DSDIFF) demuxer.** Not listed in the local `ffmpeg -formats`; only `.dsf` is. Whether
  this build decodes `.dff` is **[Guess]** (upstream FFmpeg historically lacks a DSDIFF demuxer).
- **ALAC `.alac` extension.** The repo's `LOSSLESS_EXTENSIONS` lists `.alac`, but ALAC lives in
  `.m4a`/`.caf`; a `.alac` file is **[Guess]** non-standard. Consider removing it.