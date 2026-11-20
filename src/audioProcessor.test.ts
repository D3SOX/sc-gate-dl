import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AudioProcessor,
	artworkExtension,
	isLosslessCodec,
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
