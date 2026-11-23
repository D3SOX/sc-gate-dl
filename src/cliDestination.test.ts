import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AudioProcessor } from './audioProcessor';
import { cliDirFromEnv, deliverCliOutput } from './cliDestination';

describe('cliDirFromEnv', () => {
	test('defaults to the downloads folder when unset or blank', () => {
		expect(cliDirFromEnv(undefined)).toBe(resolve('./downloads'));
		expect(cliDirFromEnv('  ')).toBe(resolve('./downloads'));
	});

	test('resolves relative paths from the process working directory', () => {
		expect(cliDirFromEnv('music')).toBe(resolve('music'));
	});

	test('expands ~ and ~/... to the current user home', () => {
		expect(cliDirFromEnv('~')).toBe(homedir());
		expect(cliDirFromEnv('~/Music/SoundCloud')).toBe(
			join(homedir(), 'Music', 'SoundCloud'),
		);
	});

	test('rejects ~user instead of treating it as the current user home', () => {
		expect(() => cliDirFromEnv('~someoneelse/Music')).toThrow(
			'~user paths are not supported',
		);
	});

	test('keeps absolute paths', () => {
		expect(cliDirFromEnv('/var/music')).toBe('/var/music');
	});
});

describe('deliverCliOutput', () => {
	let root: string;
	let downloads: string;
	let destination: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'sc-gate-cli-'));
		downloads = join(root, 'downloads');
		destination = join(root, 'Music', 'SoundCloud');
		await mkdir(downloads);
	});

	afterEach(async () => {
		await chmod(destination, 0o755).catch(() => {});
		await rm(root, { recursive: true, force: true });
	});

	test('creates the destination and moves the output there', async () => {
		const output = join(downloads, 'Song.mp3');
		await writeFile(output, 'mp3');

		const delivered = await deliverCliOutput({
			outputPath: output,
			sourcePath: output,
			removeSource: false,
			destinationDir: destination,
		});

		expect(delivered).toEqual([join(destination, 'Song.mp3')]);
		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('mp3');
		expect(await readdir(downloads)).toEqual([]);
	});

	test('never overwrites an existing destination file', async () => {
		await mkdir(destination, { recursive: true });
		await writeFile(join(destination, 'Song.mp3'), 'mine');
		const output = join(downloads, 'Song.mp3');
		await writeFile(output, 'new');

		const delivered = await deliverCliOutput({
			outputPath: output,
			sourcePath: output,
			removeSource: false,
			destinationDir: destination,
		});

		expect(delivered).toEqual([join(destination, 'Song (2).mp3')]);
		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('mine');
		expect(await Bun.file(join(destination, 'Song (2).mp3')).text()).toBe(
			'new',
		);
	});

	test('leaves a file in place when the destination is the downloads folder', async () => {
		const output = join(downloads, 'Song.mp3');
		await writeFile(output, 'mp3');

		const delivered = await deliverCliOutput({
			outputPath: output,
			sourcePath: output,
			removeSource: false,
			destinationDir: downloads,
		});

		expect(delivered).toEqual([output]);
		expect(await readdir(downloads)).toEqual(['Song.mp3']);
	});

	test('delivers a retained lossless source and its output with the same extension', async () => {
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song (2).flac');
		await writeFile(source, 'source');
		await writeFile(output, 'output');

		const delivered = await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: false,
			destinationDir: destination,
		});

		expect(delivered).toEqual([
			join(destination, 'Song (2).flac'),
			join(destination, 'Song.flac'),
		]);
		expect(await Bun.file(join(destination, 'Song.flac')).text()).toBe(
			'source',
		);
		expect(await Bun.file(join(destination, 'Song (2).flac')).text()).toBe(
			'output',
		);
		expect(await readdir(downloads)).toEqual([]);
	});

	test('deletes the source only after the output is delivered', async () => {
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');

		await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: true,
			destinationDir: destination,
		});

		expect(await readdir(destination)).toEqual(['Song.mp3']);
		expect(await readdir(downloads)).toEqual([]);
	});

	test('reports an invalid destination that is a file without losing the download', async () => {
		const blocker = join(root, 'not-a-dir');
		await writeFile(blocker, 'file');
		const output = join(downloads, 'Song.mp3');
		await writeFile(output, 'output');

		await expect(
			deliverCliOutput({
				outputPath: output,
				sourcePath: output,
				removeSource: false,
				destinationDir: blocker,
			}),
		).rejects.toThrow(join(downloads, 'Song.mp3'));

		expect(await Bun.file(output).text()).toBe('output');
	});

	test('keeps the output and source when the destination is unwritable', async () => {
		await mkdir(destination, { recursive: true });
		await chmod(destination, 0o555);
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');

		await expect(
			deliverCliOutput({
				outputPath: output,
				sourcePath: source,
				removeSource: true,
				destinationDir: destination,
			}),
		).rejects.toThrow(join(downloads, 'Song.mp3'));

		expect(await Bun.file(output).text()).toBe('output');
		expect(await Bun.file(source).text()).toBe('source');
	});

	test('reports the delivered and surviving files when a retained source is missing', async () => {
		const output = join(downloads, 'Song.mp3');
		const source = join(downloads, 'Song.flac');
		await writeFile(output, 'output');

		const error = await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: false,
			destinationDir: destination,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(join(destination, 'Song.mp3'));
		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('output');
		expect(await readdir(downloads)).toEqual([]);
	});
});

describe('deliverCliOutput with real FFmpeg output', () => {
	async function runFfmpeg(args: string[]): Promise<void> {
		const proc = Bun.spawn(
			['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args],
			{ stderr: 'ignore' },
		);
		expect(await proc.exited).toBe(0);
	}

	test('converts a FLAC download and keeps the source in the destination', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-cli-ffmpeg-'));
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
				'downloads/Song.flac',
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
			const artwork = {
				buffer: await Bun.file('cover.png').arrayBuffer(),
				fileName: 'cover.png',
			};

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
			).processAudio(
				'Song.flac',
				{ title: 'Song' },
				artwork,
				'never',
				'mp3-320',
				'https://soundcloud.com/artist/track',
			);
			const delivered = await deliverCliOutput({
				outputPath,
				sourcePath: resolve('downloads/Song.flac'),
				removeSource: false,
				destinationDir: join(dir, 'Music'),
			});

			expect(delivered).toEqual([
				join(dir, 'Music', 'Song.mp3'),
				join(dir, 'Music', 'Song.flac'),
			]);
			expect((await readdir(join(dir, 'Music'))).sort()).toEqual([
				'Song.flac',
				'Song.mp3',
			]);
			expect(await readdir(join(dir, 'downloads'))).toEqual([]);
		} finally {
			process.chdir(previousCwd);
			await rm(dir, { recursive: true, force: true });
		}
	});
});
