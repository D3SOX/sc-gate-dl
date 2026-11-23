import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { AudioProcessor } from './audioProcessor';

const sourceUrl = 'https://soundcloud.com/artist/track';
const mp3Steps = [
	32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const slowTestMs = 60_000;

async function runFfmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(
		['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args],
		{ stderr: 'ignore' },
	);
	expect(await proc.exited).toBe(0);
}

async function audioStream(path: string): Promise<{
	codec_name?: string;
	sample_rate?: string;
	channels?: number;
	bit_rate?: string;
}> {
	const proc = Bun.spawn(
		[
			'ffprobe',
			'-v',
			'quiet',
			'-select_streams',
			'a:0',
			'-show_streams',
			'-print_format',
			'json',
			path,
		],
		{ stdout: 'pipe' },
	);
	const data = JSON.parse(await new Response(proc.stdout).text());
	expect(await proc.exited).toBe(0);
	return data.streams[0];
}

async function makeLosslessSource(
	name: string,
	sampleRate = 44100,
	channels = 2,
): Promise<void> {
	await runFfmpeg([
		'-f',
		'lavfi',
		'-i',
		'anoisesrc=d=1:c=pink:r=44100:a=0.5',
		'-ac',
		String(channels),
		'-ar',
		String(sampleRate),
		'-c:a',
		'flac',
		'-y',
		join('downloads', name),
	]);
}

async function makeCover(): Promise<{ buffer: ArrayBuffer; fileName: string }> {
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

describe('AudioProcessor encoder bitrates measured by ffprobe', () => {
	let dir: string;
	let previousCwd: string;
	let warn: ReturnType<typeof spyOn<Console, 'warn'>>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-bitrate-proof-'));
		previousCwd = process.cwd();
		process.chdir(dir);
		await mkdir('downloads');
		warn = spyOn(console, 'warn');
	});

	afterEach(async () => {
		warn.mockRestore();
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	});

	function warnings(): string[] {
		return warn.mock.calls.map((args) => args.map(String).join(' '));
	}

	// AAC is a target, not an exact average. Bounds are wide enough for FFmpeg's
	// native encoder. Measured on the stereo 44.1 kHz pink-noise fixture: 64 kbps
	// target gave ~64.4 kbps, 320 kbps target gave ~205-224 kbps.
	test(
		'encodes AAC at a 64 kbps target within 10% of that target',
		async () => {
			await makeLosslessSource('song.flac');

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				'64',
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeCover(),
				'never',
				'm4a-aac',
				sourceUrl,
			);

			const bitRate = Number((await audioStream(outputPath)).bit_rate);
			expect(bitRate).toBeGreaterThanOrEqual(57_600);
			expect(bitRate).toBeLessThanOrEqual(70_400);
			expect(warnings()).toEqual([]);
		},
		slowTestMs,
	);

	test(
		'encodes AAC at a 320 kbps target inside the encoder band, not at 64 kbps',
		async () => {
			await makeLosslessSource('song.flac');

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				'320',
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeCover(),
				'never',
				'm4a-aac',
				sourceUrl,
			);

			const bitRate = Number((await audioStream(outputPath)).bit_rate);
			expect(bitRate).toBeGreaterThanOrEqual(150_000);
			expect(bitRate).toBeLessThanOrEqual(326_400);
			expect(warnings()).toEqual([]);
		},
		slowTestMs,
	);

	test(
		'writes every MP3 nominal step at exactly that stream bitrate without warning',
		async () => {
			await makeLosslessSource('song.flac');
			const cover = await makeCover();

			for (const step of mp3Steps) {
				const outputPath = await new AudioProcessor(
					'ffmpeg',
					'ffprobe',
					String(step),
				).processAudio('song.flac', {}, cover, 'never', 'mp3', sourceUrl);

				expect(basename(outputPath)).toBe('song.mp3');
				const stream = await audioStream(outputPath);
				expect(stream.codec_name).toBe('mp3');
				expect(Number(stream.bit_rate)).toBe(step * 1000);
				await rm(outputPath);
			}
			expect(warnings()).toEqual([]);
		},
		slowTestMs,
	);

	test(
		'encodes MP3 at 8 kHz and warns with the bitrate FFmpeg actually wrote',
		async () => {
			await makeLosslessSource('song.flac', 8000, 1);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				'128',
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeCover(),
				'never',
				'mp3',
				sourceUrl,
			);

			const stream = await audioStream(outputPath);
			expect(stream.codec_name).toBe('mp3');
			expect(stream.sample_rate).toBe('8000');
			expect(Number(stream.bit_rate)).toBe(64_000);
			expect(await Bun.file(outputPath).exists()).toBe(true);
			expect(
				warnings().some((message) =>
					message.includes(
						'Requested 128kbps MP3 but the encoder wrote 64kbps',
					),
				),
			).toBe(true);
		},
		slowTestMs,
	);

	test(
		'warns when FFmpeg reports AAC clamping to max for a low sample rate',
		async () => {
			await makeLosslessSource('song.flac', 11025);

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				'320',
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeCover(),
				'never',
				'm4a-aac',
				sourceUrl,
			);

			expect(basename(outputPath)).toBe('song.m4a');
			expect(await Bun.file(outputPath).exists()).toBe(true);
			expect(
				warnings().some((message) =>
					message.includes('was capped by the encoder'),
				),
			).toBe(true);
		},
		slowTestMs,
	);

	test(
		'does not warn about AAC clamping at 44.1 kHz stereo, even with a lower measured average',
		async () => {
			await makeLosslessSource('song.flac');

			const outputPath = await new AudioProcessor(
				'ffmpeg',
				'ffprobe',
				'320',
			).processAudio(
				'song.flac',
				{ title: 'Song' },
				await makeCover(),
				'never',
				'm4a-aac',
				sourceUrl,
			);

			expect(Number((await audioStream(outputPath)).bit_rate)).toBeLessThan(
				300_000,
			);
			expect(warnings()).toEqual([]);
		},
		slowTestMs,
	);
});
