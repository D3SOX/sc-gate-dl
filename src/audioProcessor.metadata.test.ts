import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioProcessor } from './audioProcessor';

async function runFfmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(
		['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args],
		{ stderr: 'ignore' },
	);
	expect(await proc.exited).toBe(0);
}

async function formatTags(path: string): Promise<Record<string, string>> {
	const proc = Bun.spawn(
		[
			'ffprobe',
			'-v',
			'quiet',
			'-show_entries',
			'format_tags:stream_tags',
			'-of',
			'json',
			path,
		],
		{ stdout: 'pipe' },
	);
	const data = JSON.parse(await new Response(proc.stdout).text()) as {
		format?: { tags?: Record<string, string> };
		streams?: Array<{ tags?: Record<string, string> }>;
	};
	expect(await proc.exited).toBe(0);
	const tags = Object.assign(
		{},
		...(data.streams ?? []).map((stream) => stream.tags ?? {}),
		data.format?.tags ?? {},
	) as Record<string, string>;
	return Object.fromEntries(
		Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]),
	);
}

async function audioCodec(path: string): Promise<string> {
	const proc = Bun.spawn(
		[
			'ffprobe',
			'-v',
			'quiet',
			'-select_streams',
			'a:0',
			'-show_entries',
			'stream=codec_name',
			'-of',
			'csv=p=0',
			path,
		],
		{ stdout: 'pipe' },
	);
	const codec = (await new Response(proc.stdout).text()).trim();
	expect(await proc.exited).toBe(0);
	return codec;
}

async function audioPayload(path: string): Promise<Uint8Array> {
	const proc = Bun.spawn(
		[
			'ffmpeg',
			'-v',
			'error',
			'-i',
			path,
			'-map',
			'0:a',
			'-c',
			'copy',
			'-f',
			'data',
			'-',
		],
		{ stdout: 'pipe', stderr: 'ignore' },
	);
	const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
	expect(await proc.exited).toBe(0);
	return bytes;
}

describe('lossy MP3 retagging keeps unrelated tags', () => {
	let dir: string;
	let previousCwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-metadata-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	test('changes the requested title and keeps the composer and track number', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'128k',
			'-metadata',
			'title=Old Title',
			'-metadata',
			'composer=Jane Composer',
			'-metadata',
			'track=7',
			'-y',
			join('downloads', 'song.mp3'),
		]);
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
		const cover = {
			buffer: await Bun.file('cover.png').arrayBuffer(),
			fileName: 'cover.png',
		};

		const output = await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
			'song.mp3',
			{ title: 'New Title' },
			cover,
			'never',
			'mp3-320',
		);

		expect(await audioCodec(output)).toBe('mp3');
		const tags = await formatTags(output);
		expect(tags.title).toBe('New Title');
		expect(tags.composer).toBe('Jane Composer');
		expect(tags.track).toBe('7');
	}, 60_000);

	test('keeps the composer of a lossy M4A when only the title changes', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			'-metadata',
			'title=Old Title',
			'-metadata',
			'composer=Jane Composer',
			'-y',
			join('downloads', 'song.m4a'),
		]);

		const output = await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
			'song.m4a',
			{ title: 'New Title' },
			{ buffer: new ArrayBuffer(0), fileName: 'none.jpg' },
			'never',
			'mp3-320',
		);

		expect(await audioCodec(output)).toBe('aac');
		const tags = await formatTags(output);
		expect(tags.title).toBe('New Title');
		expect(tags.composer).toBe('Jane Composer');
	}, 60_000);

	test('writes the source link comment when no other metadata is requested', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			'-y',
			join('downloads', 'plain.m4a'),
		]);

		const output = await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
			'plain.m4a',
			{},
			{ buffer: new ArrayBuffer(0), fileName: 'none.jpg' },
			'never',
			'mp3-320',
			'https://soundcloud.com/artist/track',
		);

		expect(await audioCodec(output)).toBe('aac');
		expect((await formatTags(output)).comment).toBe(
			'https://soundcloud.com/artist/track',
		);
	}, 60_000);

	test('leaves an MP3 byte-identical when its codec probe fails', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'128k',
			'-metadata',
			'title=Original',
			'-y',
			join('downloads', 'probe.mp3'),
		]);
		const before = await Bun.file(join('downloads', 'probe.mp3')).bytes();
		await writeFile(
			join(dir, 'failing-ffprobe'),
			'#!/bin/sh\necho "probe broken" >&2\nexit 1\n',
		);
		await chmod(join(dir, 'failing-ffprobe'), 0o755);

		const output = await new AudioProcessor(
			'ffmpeg',
			join(dir, 'failing-ffprobe'),
		).processAudio(
			'probe.mp3',
			{ title: 'Changed' },
			{ buffer: new ArrayBuffer(0), fileName: 'none.jpg' },
			'never',
			'mp3-320',
		);

		expect(output).toBe(join('downloads', 'probe.mp3'));
		expect(await Bun.file(output).bytes()).toEqual(before);
	}, 60_000);
});

describe('explicit preserve choice', () => {
	let dir: string;
	let previousCwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-preserve-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	test('an MP3 the user chose not to retag stays byte-identical without a source comment', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'128k',
			'-metadata',
			'title=Kept',
			'-y',
			join('downloads', 'keep.mp3'),
		]);
		const before = await Bun.file(join('downloads', 'keep.mp3')).bytes();

		const output = await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
			'keep.mp3',
			{},
			{ buffer: new ArrayBuffer(0), fileName: 'none.jpg' },
			'never',
			'mp3-320',
			'https://soundcloud.com/artist/track',
			false,
		);

		expect(await Bun.file(output).bytes()).toEqual(before);
		expect((await formatTags(output)).comment).toBeUndefined();
	}, 60_000);
});

describe('lossy OGG passthrough without artwork', () => {
	let dir: string;
	let previousCwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-ogg-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	test('tags a lossy OGG, keeps its audio bytes and needs no artwork', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'libopus',
			'-b:a',
			'96k',
			'-y',
			join('downloads', 'lossy.ogg'),
		]);
		const audioBefore = await audioPayload(join('downloads', 'lossy.ogg'));

		const output = await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
			'lossy.ogg',
			{ title: 'Tagged Title' },
			{ buffer: new ArrayBuffer(0), fileName: 'missing.jpg' },
			'never',
			'mp3-320',
			'https://soundcloud.com/artist/track',
		);

		expect(await audioCodec(output)).toBe('opus');
		expect(await audioPayload(output)).toEqual(audioBefore);
		const tags = await formatTags(output);
		expect(tags.title).toBe('Tagged Title');
		expect(tags.comment).toBe('https://soundcloud.com/artist/track');
	}, 60_000);
});

describe('lossy AAC passthrough without artwork', () => {
	let dir: string;
	let previousCwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-aac-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	test('tags a lossy raw AAC, keeps its audio payload and needs no artwork', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			'-f',
			'adts',
			'-y',
			join('downloads', 'lossy.aac'),
		]);
		const payloadBefore = await audioPayload(join('downloads', 'lossy.aac'));

		const output = await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
			'lossy.aac',
			{ title: 'Tagged AAC' },
			{ buffer: new ArrayBuffer(0), fileName: 'missing.jpg' },
			'never',
			'mp3-320',
			'https://soundcloud.com/artist/track',
		);

		expect(await audioCodec(output)).toBe('aac');
		expect(await audioPayload(output)).toEqual(payloadBefore);
		const tags = await formatTags(output);
		expect(tags.title).toBe('Tagged AAC');
		expect(tags.comment).toBe('https://soundcloud.com/artist/track');
	}, 60_000);
});

describe('retagging an MP3 copies the audio stream without re-encoding', () => {
	let dir: string;
	let previousCwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-copy-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	test('keeps the MP3 audio payload byte-identical while the title changes', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'128k',
			'-y',
			join('downloads', 'payload.mp3'),
		]);
		const before = await audioPayload(join('downloads', 'payload.mp3'));

		const output = await new AudioProcessor('ffmpeg', 'ffprobe').processAudio(
			'payload.mp3',
			{ title: 'Retitled' },
			{ buffer: new ArrayBuffer(0), fileName: 'none.jpg' },
			'never',
			'mp3-320',
		);

		expect(await audioPayload(output)).toEqual(before);
		expect((await formatTags(output)).title).toBe('Retitled');
	}, 60_000);
});

describe('a failed retag keeps the original MP3', () => {
	let dir: string;
	let previousCwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-fail-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	test('leaves the original MP3 byte-identical when FFmpeg fails during the retag', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'128k',
			'-y',
			join('downloads', 'original.mp3'),
		]);
		const before = await Bun.file(join('downloads', 'original.mp3')).bytes();
		const failingFfmpeg = join(dir, 'failing-ffmpeg');
		await writeFile(
			failingFfmpeg,
			'#!/bin/sh\necho "retag broke" >&2\nexit 1\n',
		);
		await chmod(failingFfmpeg, 0o755);

		await expect(
			new AudioProcessor(failingFfmpeg, 'ffprobe').processAudio(
				'original.mp3',
				{ title: 'Changed' },
				{ buffer: new ArrayBuffer(0), fileName: 'none.jpg' },
				'never',
				'mp3-320',
			),
		).rejects.toThrow();

		expect(await Bun.file(join('downloads', 'original.mp3')).bytes()).toEqual(
			before,
		);
	}, 60_000);
});
