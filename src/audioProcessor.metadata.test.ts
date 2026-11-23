import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
			'format_tags',
			'-of',
			'json',
			path,
		],
		{ stdout: 'pipe' },
	);
	const data = JSON.parse(await new Response(proc.stdout).text()) as {
		format?: { tags?: Record<string, string> };
	};
	expect(await proc.exited).toBe(0);
	const tags = data.format?.tags ?? {};
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
});
