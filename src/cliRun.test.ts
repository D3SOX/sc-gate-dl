import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SoundcloudTrack } from 'soundcloud.ts';
import { AudioProcessor } from './audioProcessor';
import { type CliDeps, runCli } from './cliRun';
import type { AppConfig } from './config';
import type { SoundcloudClient } from './soundcloud';

const soundcloudUrl = 'https://soundcloud.com/artist/track';
const gateUrl = 'https://example.test/direct/song.flac';

const config: AppConfig = {
	headless: true,
	xvfb: false,
	initializeLogins: false,
	deleteLosslessAfterConversion: true,
	cleanupSoundCloudAccount: false,
};

async function runFfmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(
		['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args],
		{ stderr: 'ignore' },
	);
	expect(await proc.exited).toBe(0);
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

let promptCalls = 0;

class SilentAudioProcessor extends AudioProcessor {
	override async promptForMetadata(): Promise<{
		metadata: Record<string, string>;
		retag: boolean;
	}> {
		promptCalls += 1;
		return { metadata: {}, retag: true };
	}
}

describe('runCli entry wiring', () => {
	let root: string;
	let previousCwd: string;
	let destination: string;
	let gateCalls: string[];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'sc-gate-dl-cli-run-'));
		previousCwd = process.cwd();
		process.chdir(root);
		await mkdir('downloads');
		await mkdir('mock-gate');
		await runFfmpeg([
			'-f',
			'lavfi',
			'-i',
			'anoisesrc=d=1:c=pink:r=44100:a=0.5',
			'-ac',
			'2',
			'-c:a',
			'flac',
			'-y',
			join('mock-gate', 'song.flac'),
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
		destination = join(root, 'Music');
		gateCalls = [];
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await rm(root, { recursive: true, force: true });
	});

	function fakeSoundcloudClient(
		provider: 'direct' | 'droploud' = 'direct',
	): SoundcloudClient {
		const client = {
			getTrack: async () =>
				({
					title: 'Song',
					genre: 'Techno',
					user: { username: 'artist', full_name: '' },
				}) as SoundcloudTrack,
			getGateURL: async () => ({
				url: gateUrl,
				provider,
				type: 'purchase_url',
			}),
			getArtworkUrl: () => 'https://example.test/artwork.png',
			fetchArtwork: async () => ({
				buffer: await Bun.file('cover.png').arrayBuffer(),
				fileName: 'cover.png',
			}),
			cleanup: async () => {},
		};
		return client as unknown as SoundcloudClient;
	}

	function deps(env: Record<string, string>): CliDeps {
		return {
			env: { SC_COMMENT: 'test comment', ...env },
			argv: ['bun', 'index.ts', soundcloudUrl],
			loadConfig: async () => config,
			saveConfig: async () => {},
			createSoundcloudClient: fakeSoundcloudClient,
			createDroploudDownloader: () => ({
				initialize: async () => {},
				prepareLogins: async () => {},
				downloadAudio: async () => null,
				close: async () => {},
			}),
			createDirectDownloader: () => ({
				downloadAudio: async (url: string) => {
					gateCalls.push(url);
					await copyFile(
						join('mock-gate', 'song.flac'),
						join('downloads', 'song.flac'),
					);
					return 'song.flac';
				},
			}),
			createAudioProcessor: (ffmpegBin, ffprobeBin, bitrateSetting) =>
				new SilentAudioProcessor(ffmpegBin, ffprobeBin, bitrateSetting),
		};
	}

	test('calls the gate and delivers the finished m4a to SC_GATE_DL_CLI_DIR', async () => {
		await runCli(
			deps({
				SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
				SC_GATE_DL_BITRATE: '128',
				SC_GATE_DL_CLI_DIR: destination,
			}),
		);

		expect(gateCalls).toEqual([gateUrl]);
		expect(await readdir(destination)).toEqual(['song.m4a']);
		expect(await audioCodec(join(destination, 'song.m4a'))).toBe('aac');
		expect(await readdir('downloads')).toEqual([]);
	}, 60_000);

	test('passes the SoundCloud track URL to the Droploud gate', async () => {
		const received: Array<{ url: string; options?: { trackUrl?: string } }> =
			[];
		await runCli({
			...deps({
				SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
				SC_GATE_DL_CLI_DIR: destination,
			}),
			createSoundcloudClient: () => fakeSoundcloudClient('droploud'),
			createDroploudDownloader: () => ({
				initialize: async () => {},
				prepareLogins: async () => {},
				close: async () => {},
				downloadAudio: async (url: string, options?: { trackUrl?: string }) => {
					received.push({ url, options });
					await copyFile(
						join('mock-gate', 'song.flac'),
						join('downloads', 'song.flac'),
					);
					return 'song.flac';
				},
			}),
		});

		expect(received.length).toBe(1);
		expect(received).toEqual([
			{ url: gateUrl, options: { trackUrl: soundcloudUrl } },
		]);
	}, 60_000);

	describe('SC_GATE_DL_REVIEW_TAGS', () => {
		beforeEach(() => {
			promptCalls = 0;
		});

		test.each([undefined, 'false', ' FALSE '])(
			'skips the tag review when the setting is %p',
			async (value) => {
				await runCli(
					deps({
						SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
						SC_GATE_DL_CLI_DIR: destination,
						...(value === undefined ? {} : { SC_GATE_DL_REVIEW_TAGS: value }),
					}),
				);
				expect(promptCalls).toBe(0);
				expect(await readdir(destination)).toEqual(['song.m4a']);
			},
			60_000,
		);

		test('keeps the interactive review when the setting is true', async () => {
			await runCli(
				deps({
					SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
					SC_GATE_DL_CLI_DIR: destination,
					SC_GATE_DL_REVIEW_TAGS: 'true',
				}),
			);
			expect(promptCalls).toBe(1);
		}, 60_000);

		test('writes the SoundCloud title and source comment without a prompt', async () => {
			await runCli(
				deps({
					SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
					SC_GATE_DL_CLI_DIR: destination,
				}),
			);
			const proc = Bun.spawn(
				[
					'ffprobe',
					'-v',
					'quiet',
					'-print_format',
					'json',
					'-show_format',
					join(destination, 'song.m4a'),
				],
				{ stdout: 'pipe' },
			);
			const info = JSON.parse(await new Response(proc.stdout).text()) as {
				format?: { tags?: Record<string, string> };
			};
			expect(info.format?.tags?.title).toBe('Song');
			expect(info.format?.tags?.comment).toBe(soundcloudUrl);
		}, 60_000);

		test('leaves an original download untouched and never prompts', async () => {
			await runCli(
				deps({
					SC_GATE_DL_CLI_FORMAT: 'original',
					SC_GATE_DL_CLI_DIR: destination,
				}),
			);
			expect(promptCalls).toBe(0);
			expect(await readdir(destination)).toEqual(['song.flac']);
		}, 60_000);

		test.each(['', 'yes'])(
			'rejects %p before any gate action',
			async (value) => {
				await expect(
					runCli(
						deps({
							SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
							SC_GATE_DL_CLI_DIR: destination,
							SC_GATE_DL_REVIEW_TAGS: value,
						}),
					),
				).rejects.toThrow('SC_GATE_DL_REVIEW_TAGS');
				expect(gateCalls).toEqual([]);
			},
		);
	});

	test('a fangate.eu gate never falls back to the Hypeddit downloader', async () => {
		const hypedditCalls: string[] = [];
		await expect(
			runCli({
				...deps({
					SC_GATE_DL_CLI_FORMAT: 'm4a-aac',
					SC_GATE_DL_CLI_DIR: destination,
				}),
				createSoundcloudClient: () => {
					const client = fakeSoundcloudClient('droploud') as unknown as {
						getGateURL: () => Promise<unknown>;
					};
					client.getGateURL = async () => ({
						url: 'https://app.fangate.eu/tracks/user-1-song',
						provider: 'fangate',
						type: 'purchase_url',
					});
					hypedditCalls.push('client');
					return client as unknown as SoundcloudClient;
				},
			}),
		).rejects.toThrow('fangate.eu');
		expect(gateCalls).toEqual([]);
	}, 60_000);
});
