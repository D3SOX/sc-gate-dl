import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AudioProcessor,
	artworkExtension,
	isLosslessCodec,
	parseAacBitrateKbps,
} from './audioProcessor';

describe('artworkExtension', () => {
	test('keeps known image extensions and falls back to jpg', () => {
		expect(artworkExtension('cover.PNG')).toBe('png');
		expect(artworkExtension('../../.env')).toBe('jpg');
		expect(artworkExtension('cover')).toBe('jpg');
	});
});

describe('AudioProcessor.processAudio', () => {
	test('never touches the path named by an uploaded artwork file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-artwork-'));
		const previousCwd = process.cwd();
		try {
			process.chdir(dir);
			await mkdir('downloads');
			await Bun.write('victim.txt', 'keep me');
			await Bun.write('downloads/song.xyz', 'audio');

			await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
				'song.xyz',
				{},
				{ buffer: new ArrayBuffer(4), fileName: '../victim.txt' },
				'never',
			);

			expect(await Bun.file(join(dir, 'victim.txt')).text()).toBe('keep me');
			expect(await readdir(join(dir, 'downloads'))).toEqual(['song.xyz']);
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('AudioProcessor source comment tag', () => {
	const sourceUrl = 'https://soundcloud.com/artist/track';

	async function runFfmpeg(args: string[]): Promise<void> {
		const proc = Bun.spawn(
			['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args],
			{
				stderr: 'ignore',
			},
		);
		expect(await proc.exited).toBe(0);
	}

	async function readComment(path: string): Promise<string | undefined> {
		const proc = Bun.spawn(
			['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', path],
			{ stdout: 'pipe' },
		);
		const probe = JSON.parse(await new Response(proc.stdout).text()) as {
			format?: { tags?: Record<string, string> };
		};
		expect(await proc.exited).toBe(0);
		return probe.format?.tags?.comment;
	}

	async function makeArtwork(): Promise<{
		buffer: ArrayBuffer;
		fileName: string;
	}> {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'color=c=red:s=16x16',
			'-frames:v',
			'1',
			'-y',
			'cover.png',
		]);
		return {
			buffer: await Bun.file('cover.png').arrayBuffer(),
			fileName: 'cover.png',
		};
	}

	test('writes the source URL to the comment tag of a converted MP3', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-comment-'));
		const previousCwd = process.cwd();
		try {
			process.chdir(dir);
			await mkdir('downloads');
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=0.2',
				'-c:a',
				'flac',
				'-y',
				'downloads/song.flac',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeArtwork(),
				'never',
				'mp3-320',
				sourceUrl,
			);

			expect(await readComment(outputPath)).toBe(sourceUrl);
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('replaces the comment tag of a retagged MP3 with the source URL', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-retag-'));
		const previousCwd = process.cwd();
		try {
			process.chdir(dir);
			await mkdir('downloads');
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=0.2',
				'-c:a',
				'libmp3lame',
				'-metadata',
				'comment=old',
				'-y',
				'downloads/song.mp3',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
			).processAudio(
				'song.mp3',
				{ title: 'Song' },
				await makeArtwork(),
				'never',
				'mp3-320',
				sourceUrl,
			);

			expect(await readComment(outputPath)).toBe(sourceUrl);
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('writes no comment tag when no source URL is given', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-nocomment-'));
		const previousCwd = process.cwd();
		try {
			process.chdir(dir);
			await mkdir('downloads');
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=0.2',
				'-c:a',
				'flac',
				'-y',
				'downloads/song.flac',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeArtwork(),
				'never',
			);

			expect(await readComment(outputPath)).toBeUndefined();
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('parseAacBitrateKbps', () => {
	test('defaults to 320 when unset, blank, or non-numeric', () => {
		for (const raw of [undefined, '', '   ', 'abc', '128kbps']) {
			expect(parseAacBitrateKbps(raw)).toBe(320);
		}
	});

	test('keeps values inside the range and clamps the rest', () => {
		expect(parseAacBitrateKbps('128')).toBe(128);
		expect(parseAacBitrateKbps(' 192 ')).toBe(192);
		expect(parseAacBitrateKbps('64')).toBe(64);
		expect(parseAacBitrateKbps('320')).toBe(320);
		expect(parseAacBitrateKbps('32')).toBe(64);
		expect(parseAacBitrateKbps('999')).toBe(320);
		expect(parseAacBitrateKbps('127.6')).toBe(128);
	});
});

describe('isLosslessCodec', () => {
	test('classifies lossless codec names, including tta and dsd', () => {
		for (const codec of [
			'flac',
			'alac',
			'wavpack',
			'ape',
			'pcm_s16le',
			'pcm_f32le',
			'tta',
			'dsd_lsbf',
			'dsd_msbf_planar',
		]) {
			expect(isLosslessCodec(codec)).toBe(true);
		}
	});

	test('classifies lossy codec names as not lossless', () => {
		for (const codec of ['aac', 'mp3', 'vorbis', 'opus']) {
			expect(isLosslessCodec(codec)).toBe(false);
		}
	});
});

describe('AudioProcessor.isLosslessAudio', () => {
	async function makeFixture(
		dir: string,
		name: string,
		codec: string,
		format?: string,
	): Promise<string> {
		const path = join(dir, name);
		const args = [
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=0.2',
			'-c:a',
			codec,
		];
		if (format) args.push('-f', format);
		args.push('-y', path);
		const proc = Bun.spawn(['ffmpeg', ...args], { stderr: 'ignore' });
		expect(await proc.exited).toBe(0);
		return path;
	}

	test('classifies by the probed codec, not the container extension', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-lossless-'));
		try {
			const processor = new AudioProcessor('ffmpeg', 'ffprobe');
			const cases: Array<[string, string, string, boolean]> = [
				['flac.flac', 'flac', '', true],
				['alac.m4a', 'alac', '', true],
				['aac.m4a', 'aac', '', false],
				['pcm.wav', 'pcm_s16le', '', true],
				['pcm.caf', 'pcm_s16le', 'caf', true],
				['wavpack.wv', 'wavpack', '', true],
				['tta.tta', 'tta', '', true],
				['mp3.mp3', 'libmp3lame', '', false],
			];
			for (const [name, codec, format, expected] of cases) {
				const path = await makeFixture(dir, name, codec, format || undefined);
				expect(await processor.isLosslessAudio(path)).toBe(expected);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('AudioProcessor M4A/AAC output', () => {
	const sourceUrl = 'https://soundcloud.com/artist/track';

	async function runFfmpeg(args: string[]): Promise<void> {
		const proc = Bun.spawn(
			['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args],
			{ stderr: 'ignore' },
		);
		expect(await proc.exited).toBe(0);
	}

	async function probe(path: string): Promise<{
		format: { format_name: string; tags?: Record<string, string> };
		streams: Array<{
			codec_type?: string;
			codec_name?: string;
			profile?: string;
			disposition?: { attached_pic?: number };
		}>;
	}> {
		const proc = Bun.spawn(
			[
				'ffprobe',
				'-v',
				'quiet',
				'-print_format',
				'json',
				'-show_format',
				'-show_streams',
				path,
			],
			{ stdout: 'pipe' },
		);
		const data = JSON.parse(await new Response(proc.stdout).text());
		expect(await proc.exited).toBe(0);
		return data;
	}

	function topLevelAtoms(bytes: Uint8Array): string[] {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const atoms: string[] = [];
		let offset = 0;
		while (offset + 8 <= bytes.byteLength) {
			const size = view.getUint32(offset);
			atoms.push(new TextDecoder().decode(bytes.slice(offset + 4, offset + 8)));
			if (size < 8) break;
			offset += size;
		}
		return atoms;
	}

	async function makeCover(name: string): Promise<{
		buffer: ArrayBuffer;
		fileName: string;
	}> {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'color=c=red:s=16x16',
			'-frames:v',
			'1',
			'-y',
			name,
		]);
		return { buffer: await Bun.file(name).arrayBuffer(), fileName: name };
	}

	async function inTempDir(
		prefix: string,
		fn: (dir: string) => Promise<void>,
	): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), prefix));
		const previousCwd = process.cwd();
		try {
			process.chdir(dir);
			await mkdir('downloads');
			await fn(dir);
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	}

	test('encodes a lossless source as tagged AAC in an m4a with cover and source comment', async () => {
		await inTempDir('sc-gate-dl-m4a-', async () => {
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=0.5',
				'-c:a',
				'flac',
				'-y',
				'downloads/song.flac',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				128,
			).processAudio(
				'song.flac',
				{ title: 'Song', artist: 'Artist', album: 'Album', genre: 'Genre' },
				await makeCover('cover.png'),
				'never',
				'm4a-aac',
				sourceUrl,
			);

			expect(outputPath).toBe(join('./downloads', 'song.m4a'));
			const data = await probe(outputPath);
			expect(data.format.format_name).toContain('m4a');
			const audio = data.streams.find((s) => s.codec_type === 'audio');
			expect(audio?.codec_name).toBe('aac');
			expect(audio?.profile).toBe('LC');
			const cover = data.streams.find((s) => s.codec_type === 'video');
			expect(cover?.disposition?.attached_pic).toBe(1);
			expect(data.format.tags).toMatchObject({
				title: 'Song',
				artist: 'Artist',
				album: 'Album',
				genre: 'Genre',
				comment: sourceUrl,
			});
		});
	});

	test('transcodes a gif cover to mjpeg so it embeds as an attached picture', async () => {
		await inTempDir('sc-gate-dl-m4a-gif-', async () => {
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=0.5',
				'-c:a',
				'flac',
				'-y',
				'downloads/song.flac',
			]);
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'color=c=red:s=16x16',
				'-frames:v',
				'1',
				'-y',
				'cover.gif',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				128,
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				{
					buffer: await Bun.file('cover.gif').arrayBuffer(),
					fileName: 'cover.gif',
				},
				'never',
				'm4a-aac',
			);

			const data = await probe(outputPath);
			const cover = data.streams.find((s) => s.codec_type === 'video');
			expect(cover?.codec_name).toBe('mjpeg');
			expect(cover?.disposition?.attached_pic).toBe(1);
		});
	});

	test('reads back the configured bitrate on the encoded AAC stream', async () => {
		await inTempDir('sc-gate-dl-m4a-bitrate-', async () => {
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=1',
				'-c:a',
				'flac',
				'-y',
				'downloads/song.flac',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				96,
			).processAudio(
				'song.flac',
				{},
				await makeCover('cover.png'),
				'never',
				'm4a-aac',
			);

			const proc = Bun.spawn(
				[
					'ffprobe',
					'-v',
					'quiet',
					'-select_streams',
					'a:0',
					'-show_entries',
					'stream=bit_rate',
					'-of',
					'csv=p=0',
					outputPath,
				],
				{ stdout: 'pipe' },
			);
			const bitRate = Number((await new Response(proc.stdout).text()).trim());
			expect(await proc.exited).toBe(0);
			expect(bitRate).toBeGreaterThan(90_000);
			expect(bitRate).toBeLessThan(105_000);
		});
	});

	test('does not write an id3 header into the m4a', async () => {
		await inTempDir('sc-gate-dl-m4a-id3-', async () => {
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=0.5',
				'-c:a',
				'flac',
				'-y',
				'downloads/song.flac',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				128,
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeCover('cover.png'),
				'never',
				'm4a-aac',
			);

			const bytes = new Uint8Array(await Bun.file(outputPath).arrayBuffer());
			expect(new TextDecoder().decode(bytes.slice(0, 3))).not.toBe('ID3');
			expect(topLevelAtoms(bytes)).not.toContain('ID3 ');
		});
	});

	test('places the moov atom before mdat so the file can start playing early', async () => {
		await inTempDir('sc-gate-dl-m4a-faststart-', async () => {
			await runFfmpeg([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=0.5',
				'-c:a',
				'flac',
				'-y',
				'downloads/song.flac',
			]);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				128,
			).processAudio(
				'song.flac',
				{},
				await makeCover('cover.png'),
				'never',
				'm4a-aac',
			);

			const atoms = topLevelAtoms(
				new Uint8Array(await Bun.file(outputPath).arrayBuffer()),
			);
			expect(atoms.indexOf('moov')).toBeLessThan(atoms.indexOf('mdat'));
		});
	});
});
