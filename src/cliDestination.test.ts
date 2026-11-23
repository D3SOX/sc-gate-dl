import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PathLike } from 'node:fs';
import {
	chmod,
	copyFile,
	link,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lookpath } from 'find-bin';
import { AudioProcessor } from './audioProcessor';
import {
	type CliFormat,
	cliDirFromEnv,
	cliFormatFromEnv,
	cliOutputFromEnv,
	deliverCliOutput,
	finishCliDownload,
} from './cliDestination';

type FfprobeOutput = {
	format?: { tags?: Record<string, string>; bit_rate?: string };
	streams?: Array<{
		codec_type?: string;
		codec_name?: string;
		bit_rate?: string;
		disposition?: { attached_pic?: number };
	}>;
};

describe('cliFormatFromEnv', () => {
	test('defaults to configurable mp3 when unset or blank', () => {
		expect(cliFormatFromEnv(undefined, undefined)).toEqual({
			format: 'mp3',
			bitrateKbps: 320,
		});
		expect(cliFormatFromEnv('  ', undefined)).toEqual({
			format: 'mp3',
			bitrateKbps: 320,
		});
	});

	test('accepts every CLI format', () => {
		expect(cliFormatFromEnv('m4a-aac', undefined).format).toBe('m4a-aac');
		expect(cliFormatFromEnv('flac', undefined).format).toBe('flac');
		expect(cliFormatFromEnv('original', undefined).format).toBe('original');
	});

	test('applies the shared bitrate to mp3 and m4a-aac', () => {
		expect(cliFormatFromEnv('mp3', '128').bitrateKbps).toBe(128);
		expect(cliFormatFromEnv('m4a-aac', '256').bitrateKbps).toBe(256);
	});

	test('accepts AAC bounds and rejects values just outside them', () => {
		expect(cliFormatFromEnv('m4a-aac', '64').bitrateKbps).toBe(64);
		expect(cliFormatFromEnv('m4a-aac', '320').bitrateKbps).toBe(320);
		expect(() => cliFormatFromEnv('m4a-aac', '63')).toThrow(
			'SC_GATE_DL_BITRATE=63 is not valid for m4a-aac output',
		);
		expect(() => cliFormatFromEnv('m4a-aac', '321')).toThrow(
			'SC_GATE_DL_BITRATE=321 is not valid for m4a-aac output',
		);
	});

	test('rejects an unknown format and names the supported values', () => {
		expect(() => cliFormatFromEnv('ogg', undefined)).toThrow(
			'SC_GATE_DL_CLI_FORMAT=ogg is not supported. Use one of: mp3, m4a-aac, flac, original',
		);
	});

	test('rejects an invalid bitrate for mp3 and m4a-aac', () => {
		expect(() => cliFormatFromEnv('mp3', '100')).toThrow(
			'SC_GATE_DL_BITRATE=100 is not valid for mp3 output',
		);
		expect(() => cliFormatFromEnv('m4a-aac', '32')).toThrow(
			'SC_GATE_DL_BITRATE=32 is not valid for m4a-aac output',
		);
	});

	test('ignores an invalid bitrate for flac and original', () => {
		expect(cliFormatFromEnv('flac', 'nope')).toEqual({
			format: 'flac',
			bitrateKbps: 320,
		});
		expect(cliFormatFromEnv('original', '100').format).toBe('original');
	});
});

describe('cliOutputFromEnv', () => {
	test('resolves the default mp3, 320 kbps and downloads folder when nothing is set', () => {
		expect(cliOutputFromEnv({})).toEqual({
			format: 'mp3',
			bitrateKbps: 320,
			destinationDir: resolve('./downloads'),
		});
	});

	test('resolves the selected format, bitrate and destination together', () => {
		expect(
			cliOutputFromEnv({
				SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
				SC_GATE_DL_BITRATE: '192',
				SC_GATE_DL_CLI_DIR: 'music',
			}),
		).toEqual({
			format: 'm4a-aac',
			bitrateKbps: 192,
			destinationDir: resolve('music'),
		});
	});

	test('throws on an invalid format or bitrate before any gate is opened', () => {
		expect(() => cliOutputFromEnv({ SC_GATE_DL_CLI_FORMAT: 'ogg' })).toThrow(
			'SC_GATE_DL_CLI_FORMAT=ogg is not supported',
		);
		expect(() =>
			cliOutputFromEnv({
				SC_GATE_DL_CLI_FORMAT: 'mp3',
				SC_GATE_DL_BITRATE: '100',
			}),
		).toThrow('SC_GATE_DL_BITRATE=100 is not valid for mp3 output');
	});
});

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

	test('keeps an existing destination file when the source is missing', async () => {
		await mkdir(destination, { recursive: true });
		await writeFile(join(destination, 'Song.mp3'), 'mine');
		const output = join(downloads, 'Song.mp3');

		await expect(
			deliverCliOutput({
				outputPath: output,
				sourcePath: output,
				removeSource: false,
				destinationDir: destination,
			}),
		).rejects.toThrow();

		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('mine');
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

	test('copies across filesystems and removes the source only after the copy', async () => {
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile,
		};

		await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: true,
			destinationDir: destination,
			transfer,
		});

		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('output');
		expect(await readdir(downloads)).toEqual([]);
	});

	test('keeps the output and source intact when a cross-device copy fails midway', async () => {
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile: async (_from: PathLike, to: PathLike) => {
				await writeFile(to, 'out');
				throw new Error('disk full');
			},
		};

		const error = await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: true,
			destinationDir: destination,
			transfer,
		}).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain('disk full');
		expect((error as Error).message).toContain(resolve(output));
		expect((error as Error).message).toContain(resolve(source));
		expect(await Bun.file(source).text()).toBe('source');
		expect(await Bun.file(output).text()).toBe('output');
		expect(await readdir(destination).catch(() => [])).toEqual([]);
	});

	test('reports surviving paths and leaves unrelated files when the second artifact fails', async () => {
		await mkdir(destination, { recursive: true });
		await writeFile(join(destination, 'Other.mp3'), 'unrelated');
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile: async (from: PathLike, to: PathLike, mode?: number) => {
				if (from === source) throw new Error('quota exceeded');
				return copyFile(from, to, mode);
			},
		};

		const error = await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: false,
			destinationDir: destination,
			transfer,
		}).catch((caught: unknown) => caught);

		const message = (error as Error).message;
		expect(message).toContain('quota exceeded');
		expect(message).toContain(join(destination, 'Song.mp3'));
		expect(message).toContain(resolve(source));
		expect(message).not.toContain(resolve(output));
		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('output');
		expect(await Bun.file(join(destination, 'Other.mp3')).text()).toBe(
			'unrelated',
		);
		expect(await Bun.file(source).text()).toBe('source');
		expect((await readdir(destination)).sort()).toEqual([
			'Other.mp3',
			'Song.mp3',
		]);
	});
});

describe('deliverCliOutput failure recovery', () => {
	let root: string;
	let downloads: string;
	let destination: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'sc-gate-cli-recover-'));
		downloads = join(root, 'downloads');
		destination = join(root, 'Music');
		await mkdir(downloads);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('keeps the source and no partial file when publication fails', async () => {
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile: async (from: PathLike, to: PathLike, mode?: number) => {
				if (String(to).endsWith('Song.mp3')) {
					await writeFile(to, 'out');
					throw new Error('publish failed');
				}
				return copyFile(from, to, mode);
			},
		};

		const error = await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: true,
			destinationDir: destination,
			transfer,
		}).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain('publish failed');
		expect((error as Error).message).toContain(resolve(source));
		expect(await Bun.file(source).text()).toBe('source');
		expect(await Bun.file(output).text()).toBe('output');
		expect(await readdir(destination).catch(() => [])).toEqual([]);
	});

	test('removes the delivered copy and keeps the source when the source cannot be removed', async () => {
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile,
		};
		await chmod(downloads, 0o555);

		try {
			const error = await deliverCliOutput({
				outputPath: output,
				sourcePath: source,
				removeSource: true,
				destinationDir: destination,
				transfer,
			}).catch((caught: unknown) => caught);

			expect((error as Error).message).toContain(resolve(source));
			expect(await Bun.file(source).text()).toBe('source');
			expect(await readdir(destination).catch(() => [])).toEqual([]);
		} finally {
			await chmod(downloads, 0o755);
		}
	});

	test('reports the surviving output when the second artifact cannot be delivered', async () => {
		const source = join(downloads, 'Song.flac');
		const output = join(downloads, 'Song.mp3');
		await writeFile(source, 'source');
		await writeFile(output, 'output');
		await mkdir(destination);
		const transfer = {
			link: async (from: PathLike, to: PathLike) => {
				if (from === source) {
					throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
				}
				return link(from, to);
			},
			copyFile: async (from: PathLike, to: PathLike, mode?: number) => {
				if (from === source) throw new Error('quota exceeded');
				return copyFile(from, to, mode);
			},
		};

		const error = await deliverCliOutput({
			outputPath: output,
			sourcePath: source,
			removeSource: false,
			destinationDir: destination,
			transfer,
		}).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain(join(destination, 'Song.mp3'));
		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('output');
		expect(await Bun.file(source).text()).toBe('source');
	});

	test('keeps two concurrent deliveries of the same name under distinct names', async () => {
		const first = join(downloads, 'a', 'Song.mp3');
		const second = join(downloads, 'b', 'Song.mp3');
		await mkdir(join(downloads, 'a'));
		await mkdir(join(downloads, 'b'));
		await writeFile(first, 'first');
		await writeFile(second, 'second');
		await mkdir(destination);
		await writeFile(join(destination, 'Song.mp3'), 'mine');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile,
		};

		const [a, b] = await Promise.all([
			deliverCliOutput({
				outputPath: first,
				sourcePath: first,
				removeSource: false,
				destinationDir: destination,
				transfer,
			}),
			deliverCliOutput({
				outputPath: second,
				sourcePath: second,
				removeSource: false,
				destinationDir: destination,
				transfer,
			}),
		]);

		const names = [...a, ...b].sort();
		expect(names).toEqual([
			join(destination, 'Song (2).mp3'),
			join(destination, 'Song (3).mp3'),
		]);
		expect(await Bun.file(join(destination, 'Song.mp3')).text()).toBe('mine');
		const contents = await Promise.all(
			names.map((name) => Bun.file(name).text()),
		);
		expect(contents.sort()).toEqual(['first', 'second']);
	});
});

describe('finishCliDownload with real FFmpeg output', () => {
	const sourceUrl = 'https://soundcloud.com/artist/track';
	let dir: string;
	let previousCwd: string;
	let destination: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-cli-finish-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
		destination = join(dir, 'Music');
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	async function runFfmpeg(args: string[]): Promise<void> {
		const proc = Bun.spawn(
			['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args],
			{ stderr: 'ignore' },
		);
		expect(await proc.exited).toBe(0);
	}

	async function probe(path: string): Promise<FfprobeOutput> {
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
		const data = JSON.parse(
			await new Response(proc.stdout).text(),
		) as FfprobeOutput;
		expect(await proc.exited).toBe(0);
		return data;
	}

	function audioStream(data: FfprobeOutput) {
		return data.streams?.find((stream) => stream.codec_type === 'audio');
	}

	async function makeFlacSource(name: string): Promise<void> {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=0.5',
			'-ac',
			'2',
			'-ar',
			'44100',
			'-c:a',
			'flac',
			'-y',
			join('downloads', name),
		]);
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

	function steps(
		overrides: Partial<{
			fetchArtwork: () => Promise<{ buffer: ArrayBuffer; fileName: string }>;
			promptMetadata: () => Promise<{ title?: string }>;
			confirmRemoveSource: (filename: string) => Promise<boolean>;
		}> = {},
	) {
		return {
			fetchArtwork: overrides.fetchArtwork ?? makeArtwork,
			promptMetadata:
				overrides.promptMetadata ??
				(async () => ({ title: 'Song', artist: 'Artist', album: 'Album' })),
			confirmRemoveSource: overrides.confirmRemoveSource ?? (async () => false),
		};
	}

	function finish(
		downloadFilename: string,
		options: {
			format: CliFormat;
			losslessHandling?: 'prompt' | 'always' | 'never';
			bitrateSetting?: string;
			stepOverrides?: Parameters<typeof steps>[0];
		},
	) {
		return finishCliDownload({
			downloadFilename,
			output: { format: options.format },
			losslessHandling: options.losslessHandling ?? 'never',
			destinationDir: destination,
			soundcloudUrl: sourceUrl,
			audioProcessor: new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				options.bitrateSetting,
			),
			steps: steps(options.stepOverrides),
		});
	}

	test('encodes a lossless source as MP3 at the configured bitrate with tags and source comment', async () => {
		await makeFlacSource('Song.flac');

		await finish('Song.flac', {
			format: 'mp3',
			bitrateSetting: '128',
		});

		const output = await probe(join(destination, 'Song.mp3'));
		expect(audioStream(output)?.codec_name).toBe('mp3');
		expect(audioStream(output)?.bit_rate).toBe('128000');
		expect(output.format?.tags?.title).toBe('Song');
		expect(output.format?.tags?.comment).toBe(sourceUrl);
	});

	test('encodes a lossless source as AAC in an m4a with artwork and tags', async () => {
		await makeFlacSource('Song.flac');

		await finish('Song.flac', {
			format: 'm4a-aac',
			bitrateSetting: '256',
		});

		const output = await probe(join(destination, 'Song.m4a'));
		expect(audioStream(output)?.codec_name).toBe('aac');
		expect(output.format?.tags?.title).toBe('Song');
		expect(output.format?.tags?.comment).toBe(sourceUrl);
		const cover = output.streams?.find(
			(stream) => stream.codec_type === 'video',
		);
		expect(cover?.disposition?.attached_pic).toBe(1);
	});

	test('keeps a lossless FLAC output without using the common bitrate', async () => {
		await makeFlacSource('Song.flac');

		await finish('Song.flac', {
			format: 'flac',
			losslessHandling: 'always',
			bitrateSetting: 'not-a-bitrate',
		});

		const output = await probe(
			join(destination, (await readdir(destination))[0] ?? ''),
		);
		expect(audioStream(output)?.codec_name).toBe('flac');
		expect(output.format?.tags?.comment).toBe(sourceUrl);
		expect(await readdir(join(dir, 'downloads'))).toEqual([]);
	});

	test('delivers the selected audio unchanged for original', async () => {
		await makeFlacSource('Song.flac');
		const source = await Bun.file(join(dir, 'downloads', 'Song.flac')).bytes();
		let artworkFetched = false;
		let metadataPrompted = false;

		await finish('Song.flac', {
			format: 'original',
			losslessHandling: 'always',
			stepOverrides: {
				fetchArtwork: async () => {
					artworkFetched = true;
					return makeArtwork();
				},
				promptMetadata: async () => {
					metadataPrompted = true;
					return {};
				},
			},
		});

		expect(await Bun.file(join(destination, 'Song.flac')).bytes()).toEqual(
			source,
		);
		expect(artworkFetched).toBeFalse();
		expect(metadataPrompted).toBeFalse();
		expect(await readdir(join(dir, 'downloads'))).toEqual([]);
	});

	test('extracts the audio from a ZIP download before delivering it as original', async () => {
		const zipBin = await lookpath('zip');
		if (!zipBin) return;
		await makeFlacSource('Song.flac');
		await mkdir('archive');
		await rename(
			join(dir, 'downloads', 'Song.flac'),
			join(dir, 'archive', 'Song.flac'),
		);
		const flacBytes = await Bun.file(join(dir, 'archive', 'Song.flac')).bytes();
		Bun.spawnSync([zipBin, '-q', 'download.bin', 'Song.flac'], {
			cwd: join(dir, 'archive'),
		});
		await rename(
			join(dir, 'archive', 'download.bin'),
			join(dir, 'downloads', 'download.bin'),
		);

		await finish('download.bin', { format: 'original' });

		expect(await Bun.file(join(destination, 'Song.flac')).bytes()).toEqual(
			flacBytes,
		);
		expect(await readdir(join(dir, 'downloads'))).toEqual([]);
	});

	test('does not re-encode a lossy MP3 for a conversion target', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=0.5',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'192k',
			'-y',
			join('downloads', 'Song.mp3'),
		]);
		const source = audioStream(await probe(join(dir, 'downloads', 'Song.mp3')));

		await finish('Song.mp3', {
			format: 'm4a-aac',
			bitrateSetting: '256',
		});

		const output = await probe(join(destination, 'Song.mp3'));
		expect(audioStream(output)?.codec_name).toBe('mp3');
		expect(audioStream(output)?.bit_rate).toBe(source?.bit_rate);
		expect(output.format?.tags?.comment).toBe(sourceUrl);
		expect(await readdir(join(dir, 'downloads'))).toEqual([]);
	});

	test('retags a lossy M4A without re-encoding and keeps its extension', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=0.5',
			'-c:a',
			'aac',
			'-b:a',
			'192k',
			'-y',
			join('downloads', 'Song.m4a'),
		]);
		const source = audioStream(await probe(join(dir, 'downloads', 'Song.m4a')));

		await finish('Song.m4a', { format: 'mp3', bitrateSetting: '128' });

		const output = await probe(join(destination, 'Song.m4a'));
		expect(audioStream(output)?.codec_name).toBe('aac');
		expect(audioStream(output)?.bit_rate).toBe(source?.bit_rate);
		expect(output.format?.tags?.title).toBe('Song');
		expect(output.format?.tags?.comment).toBe(sourceUrl);
	});

	test('leaves an unknown source type as delivered bytes', async () => {
		await Bun.write(join(dir, 'downloads', 'Notes.xyz'), 'not audio');

		await finish('Notes.xyz', { format: 'mp3', bitrateSetting: '128' });

		expect(await Bun.file(join(destination, 'Notes.xyz')).text()).toBe(
			'not audio',
		);
	});

	test('keeps the source and reports it when conversion fails', async () => {
		await makeFlacSource('Song.flac');
		const source = await Bun.file(join(dir, 'downloads', 'Song.flac')).bytes();

		const failing = finishCliDownload({
			downloadFilename: 'Song.flac',
			output: { format: 'mp3' },
			losslessHandling: 'always',
			destinationDir: destination,
			soundcloudUrl: sourceUrl,
			audioProcessor: new AudioProcessor(
				'/definitely/missing/ffmpeg',
				'ffprobe',
				'128',
			),
			steps: steps(),
		});

		await expect(failing).rejects.toThrow('Files kept: ');
		await expect(failing).rejects.toThrow(
			`${await realpath(join(dir, 'downloads', 'Song.flac'))}`,
		);
		expect(await Bun.file(join(dir, 'downloads', 'Song.flac')).bytes()).toEqual(
			source,
		);
		expect(await readdir(destination).catch(() => [])).toEqual([]);
	});

	test('delivers a retained ALAC source beside its AAC output with the same extension', async () => {
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=0.5',
			'-c:a',
			'alac',
			'-y',
			join('downloads', 'Song.m4a'),
		]);

		await finish('Song.m4a', {
			format: 'm4a-aac',
			losslessHandling: 'never',
			bitrateSetting: '256',
		});

		const files = (await readdir(destination)).sort();
		expect(files).toHaveLength(2);
		const codecs = await Promise.all(
			files.map(
				async (file) =>
					audioStream(await probe(join(destination, file)))?.codec_name,
			),
		);
		expect(codecs.sort()).toEqual(['aac', 'alac']);
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
