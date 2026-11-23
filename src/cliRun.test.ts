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

class SilentAudioProcessor extends AudioProcessor {
	override async promptForMetadata(): Promise<{
		metadata: Record<string, string>;
		retag: boolean;
	}> {
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

	function fakeSoundcloudClient(): SoundcloudClient {
		const client = {
			getTrack: async () => ({ title: 'Song' }) as SoundcloudTrack,
			getGateURL: async () => ({
				url: gateUrl,
				provider: 'direct',
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
});
