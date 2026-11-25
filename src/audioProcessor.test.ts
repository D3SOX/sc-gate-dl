import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AudioProcessor,
	artworkExtension,
	outputBitrateFromEnv,
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
				{
					artwork: { buffer: new ArrayBuffer(4), fileName: '../victim.txt' },
					losslessHandling: 'never',
				},
			);

			expect(await Bun.file(join(dir, 'victim.txt')).text()).toBe('keep me');
			expect(await readdir(join(dir, 'downloads'))).toEqual(['song.xyz']);
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	});
});

async function ffmpeg(...args: string[]): Promise<void> {
	const proc = Bun.spawn(['ffmpeg', '-v', 'error', '-y', ...args]);
	if ((await proc.exited) !== 0) throw new Error(`ffmpeg ${args.join(' ')}`);
}

async function probe(path: string): Promise<{
	tags: Record<string, string>;
	covers: number;
	codec?: string;
	kbps: number;
}> {
	const proc = Bun.spawn([
		'ffprobe',
		'-v',
		'quiet',
		'-print_format',
		'json',
		'-show_format',
		'-show_streams',
		path,
	]);
	const data = JSON.parse(await new Response(proc.stdout).text()) as {
		format: { tags?: Record<string, string> };
		streams: { codec_type: string; codec_name: string; bit_rate?: string }[];
	};
	const tags = Object.fromEntries(
		Object.entries(data.format.tags ?? {}).map(([k, v]) => [
			k.toLowerCase(),
			v,
		]),
	);
	const audio = data.streams.find((s) => s.codec_type === 'audio');
	return {
		tags,
		covers: data.streams.filter((s) => s.codec_type === 'video').length,
		codec: audio?.codec_name,
		kbps: Math.round(Number(audio?.bit_rate) / 1000),
	};
}

describe('AudioProcessor.processAudio with FFmpeg', () => {
	const sourceUrl = 'https://soundcloud.com/artist/track';
	let dir: string;
	let previousCwd: string;

	async function inTempDir(run: () => Promise<void>): Promise<void> {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-tags-'));
		previousCwd = process.cwd();
		try {
			process.chdir(dir);
			await mkdir('downloads');
			await ffmpeg('-f', 'lavfi', '-i', 'sine=d=1', 'downloads/song.wav');
			await ffmpeg(
				'-f',
				'lavfi',
				'-i',
				'color=c=red:s=16x16',
				'-frames:v',
				'1',
				'cover.png',
			);
			await run();
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	}

	async function taggedMp3WithCover(): Promise<void> {
		await ffmpeg(
			'-i',
			'downloads/song.wav',
			'-i',
			'cover.png',
			'-map',
			'0:a',
			'-map',
			'1:v',
			'-c:v',
			'copy',
			'-id3v2_version',
			'3',
			'-metadata',
			'title=Old title',
			'-metadata',
			'composer=Someone',
			'downloads/song.mp3',
		);
		await rm('downloads/song.wav');
	}

	const processor = () => new AudioProcessor('ffmpeg', 'ffprobe');

	test('a retag keeps unrelated tags and the existing cover', () =>
		inTempDir(async () => {
			await taggedMp3WithCover();
			await processor().processAudio(
				'song.mp3',
				{ title: 'New title' },
				{ artwork: null, sourceUrl },
			);
			const { tags, covers } = await probe('downloads/song.mp3');
			expect(tags.title).toBe('New title');
			expect(tags.composer).toBe('Someone');
			expect(tags.comment).toBe(sourceUrl);
			expect(covers).toBe(1);
			expect(await readdir('downloads')).toEqual(['song.mp3']);
		}));

	test('a retag keeps an embedded cover larger than 10 MiB', () =>
		inTempDir(async () => {
			await ffmpeg(
				'-f',
				'lavfi',
				'-i',
				'nullsrc=s=2200x2200,geq=random(1)*255:random(2)*255:random(3)*255',
				'-frames:v',
				'1',
				'cover.png',
			);
			expect(Bun.file('cover.png').size).toBeGreaterThan(10 * 1024 * 1024);
			await taggedMp3WithCover();
			await processor().processAudio(
				'song.mp3',
				{ title: 'New title' },
				{ artwork: null },
			);
			expect((await probe('downloads/song.mp3')).covers).toBe(1);
		}));

	test('a retag with new artwork replaces the old cover', () =>
		inTempDir(async () => {
			await taggedMp3WithCover();
			await processor().processAudio(
				'song.mp3',
				{ title: 'New title' },
				{
					artwork: {
						buffer: await Bun.file('cover.png').arrayBuffer(),
						fileName: 'cover.png',
					},
				},
			);
			expect((await probe('downloads/song.mp3')).covers).toBe(1);
		}));

	for (const outputFormat of ['mp3-320', 'flac'] as const) {
		test(`a ${outputFormat} conversion without artwork finishes coverless`, () =>
			inTempDir(async () => {
				const output = await processor().processAudio(
					'song.wav',
					{ title: 'Song' },
					{ artwork: null, outputFormat, losslessHandling: 'never', sourceUrl },
				);
				const { tags, covers } = await probe(output);
				expect(tags.title).toBe('Song');
				expect(tags.comment).toBe(sourceUrl);
				expect(covers).toBe(0);
			}));
	}

	test('M4A/AAC output encodes a lossless source at the configured bitrate', () =>
		inTempDir(async () => {
			const output = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				192,
			).processAudio(
				'song.wav',
				{ title: 'Song' },
				{
					artwork: {
						buffer: await Bun.file('cover.png').arrayBuffer(),
						fileName: 'cover.png',
					},
					outputFormat: 'm4a-aac',
					losslessHandling: 'always',
					sourceUrl,
				},
			);
			expect(output).toBe('downloads/song.m4a');
			const { tags, covers, codec, kbps } = await probe(output);
			expect(codec).toBe('aac');
			expect(kbps).toBeLessThanOrEqual(200);
			expect(kbps).toBeGreaterThan(150);
			expect(tags.title).toBe('Song');
			expect(tags.comment).toBe(sourceUrl);
			expect(covers).toBe(1);
			expect(await readdir('downloads')).toEqual(['song.m4a']);
		}));

	test('an AAC download is retagged, not re-encoded, for MP3 output', () =>
		inTempDir(async () => {
			await ffmpeg(
				'-i',
				'downloads/song.wav',
				'-c:a',
				'aac',
				'downloads/song.m4a',
			);
			await rm('downloads/song.wav');
			const before = await Bun.file('downloads/song.m4a').size;
			const output = await processor().processAudio(
				'song.m4a',
				{ title: 'Song' },
				{ artwork: null, losslessHandling: 'always', sourceUrl },
			);
			expect(output).toBe('downloads/song.m4a');
			const { tags, codec } = await probe(output);
			expect(codec).toBe('aac');
			expect(tags.title).toBe('Song');
			expect(Math.abs((await Bun.file(output).size) - before)).toBeLessThan(
				2048,
			);
		}));

	test('a raw .aac download moves into an .m4a when tagged', () =>
		inTempDir(async () => {
			await ffmpeg(
				'-i',
				'downloads/song.wav',
				'-c:a',
				'aac',
				'downloads/song.aac',
			);
			await rm('downloads/song.wav');
			const output = await processor().processAudio(
				'song.aac',
				{ title: 'Song' },
				{ artwork: null, losslessHandling: 'never' },
			);
			expect(output).toBe('downloads/song.m4a');
			expect((await probe(output)).tags.title).toBe('Song');
			expect(await readdir('downloads')).toEqual(['song.m4a']);
		}));

	test('an Ogg download is converted to MP3', () =>
		inTempDir(async () => {
			await ffmpeg(
				'-i',
				'downloads/song.wav',
				'-c:a',
				'libvorbis',
				'downloads/song.ogg',
			);
			await rm('downloads/song.wav');
			const output = await processor().processAudio(
				'song.ogg',
				{ title: 'Song' },
				{ artwork: null, losslessHandling: 'always' },
			);
			expect(output).toBe('downloads/song.mp3');
			expect((await probe(output)).codec).toBe('mp3');
		}));

	test('an ALAC source with the same name is kept unless it is removed', () =>
		inTempDir(async () => {
			await ffmpeg(
				'-i',
				'downloads/song.wav',
				'-c:a',
				'alac',
				'downloads/song.m4a',
			);
			await rm('downloads/song.wav');
			const kept = await processor().processAudio(
				'song.m4a',
				{ title: 'Song' },
				{ artwork: null, outputFormat: 'm4a-aac', losslessHandling: 'never' },
			);
			expect(kept).not.toBe('downloads/song.m4a');
			expect((await probe('downloads/song.m4a')).codec).toBe('alac');
			expect((await probe(kept)).codec).toBe('aac');
			await rm(kept);

			const replaced = await processor().processAudio(
				'song.m4a',
				{ title: 'Song' },
				{ artwork: null, outputFormat: 'm4a-aac', losslessHandling: 'always' },
			);
			expect(replaced).toBe('downloads/song.m4a');
			expect((await probe(replaced)).codec).toBe('aac');
			expect(await readdir('downloads')).toEqual(['song.m4a']);
		}));
});

describe('outputBitrateFromEnv', () => {
	test('defaults to 320 when unset or blank', () => {
		expect(outputBitrateFromEnv(undefined)).toBe(320);
		expect(outputBitrateFromEnv('')).toBe(320);
	});

	test('accepts 64 to 320 kbps', () => {
		expect(outputBitrateFromEnv('64')).toBe(64);
		expect(outputBitrateFromEnv(' 256 ')).toBe(256);
	});

	test.each(['63', '321', '128k', 'abc'])('rejects %p', (value) => {
		expect(() => outputBitrateFromEnv(value)).toThrow('SC_GATE_DL_BITRATE');
	});
});
