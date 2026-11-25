import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioProcessor, artworkExtension } from './audioProcessor';

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
		streams: { codec_type: string }[];
	};
	const tags = Object.fromEntries(
		Object.entries(data.format.tags ?? {}).map(([k, v]) => [
			k.toLowerCase(),
			v,
		]),
	);
	return {
		tags,
		covers: data.streams.filter((s) => s.codec_type === 'video').length,
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
});
