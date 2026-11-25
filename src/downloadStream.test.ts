import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createDownloadBar,
	downloadProgressReporter,
	saveDownloadStream,
	withContentTypeExtension,
} from './downloadStream';

const MB = 1024 * 1024;

describe('createDownloadBar without a known size', () => {
	test('prints a throttled MB line and a final total', () => {
		const lines: string[] = [];
		let time = 10_000;
		const bar = createDownloadBar(
			0,
			(line) => lines.push(line),
			() => time,
		);
		bar.update(1 * MB);
		bar.update(2 * MB);
		expect(lines).toEqual(['Downloading... 1 MB']);
		time += 5_000;
		bar.update(3 * MB);
		bar.stop();
		expect(lines).toEqual([
			'Downloading... 1 MB',
			'Downloading... 3 MB',
			'Downloaded 3 MB',
		]);
	});

	test('stops once, reports a failed download, and prints nothing afterwards', () => {
		const lines: string[] = [];
		let time = 10_000;
		const bar = createDownloadBar(
			0,
			(line) => lines.push(line),
			() => time,
		);
		bar.update(2 * MB);
		bar.stop(false);
		bar.stop();
		time += 10_000;
		bar.update(4 * MB);
		expect(lines).toEqual(['Downloading... 2 MB', 'Download stopped at 2 MB']);
	});
});

describe('withContentTypeExtension', () => {
	test('keeps a known audio or archive extension', () => {
		expect(withContentTypeExtension('song.mp3', 'audio/wav')).toBe('song.mp3');
		expect(withContentTypeExtension('pack.zip', null)).toBe('pack.zip');
	});

	test('adds the extension the Content-Type names', () => {
		expect(withContentTypeExtension('Track.Remix', 'audio/mpeg')).toBe(
			'Track.Remix.mp3',
		);
		expect(
			withContentTypeExtension('song', 'audio/x-wav; charset=binary'),
		).toBe('song.wav');
	});

	test('does not guess a format for an unknown type', () => {
		expect(withContentTypeExtension('song', 'application/octet-stream')).toBe(
			'song',
		);
		expect(withContentTypeExtension('song', null)).toBe('song');
	});
});

describe('downloadProgressReporter', () => {
	test('reports bytes and a percent, with the total only when known', () => {
		const events: unknown[] = [];
		const report = downloadProgressReporter((...event) => events.push(event), {
			browserless: true,
		});
		report(1 * MB, 4 * MB);
		report(1 * MB, 0);
		expect(events).toEqual([
			[
				'downloading',
				'Downloading... 1.0 / 4.0 MB',
				25,
				{ browserless: true, downloadBytes: MB, totalBytes: 4 * MB },
			],
			[
				'downloading',
				'Downloading... 1.0 MB',
				0,
				{ browserless: true, downloadBytes: MB },
			],
		]);
	});
});

describe('saveDownloadStream', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-stream-test-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function body(chunks: Uint8Array[], failAfter = Infinity) {
		let sent = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= failAfter) {
					controller.error(new Error('connection reset'));
					return;
				}
				const chunk = chunks[sent++];
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
		});
	}

	test('writes through a .part file and renames it into place', async () => {
		const dest = join(dir, 'song.wav');
		await writeFile(dest, '');
		const received = await saveDownloadStream(
			body([new Uint8Array([1, 2]), new Uint8Array([3])]),
			dest,
			{ totalBytes: 3 },
		);
		expect(received).toBe(3);
		expect([...(await readFile(dest))]).toEqual([1, 2, 3]);
		expect(await readdir(dir)).toEqual(['song.wav']);
	});

	test('removes the partial and reserved files when the body fails', async () => {
		const dest = join(dir, 'song.wav');
		await writeFile(dest, '');
		await expect(
			saveDownloadStream(body([new Uint8Array([1])], 1), dest, {
				totalBytes: 0,
			}),
		).rejects.toThrow('connection reset');
		expect(await readdir(dir)).toEqual([]);
	});

	test('stops at the size limit', async () => {
		const dest = join(dir, 'song.wav');
		await expect(
			saveDownloadStream(body([new Uint8Array(4), new Uint8Array(4)]), dest, {
				totalBytes: 0,
				maxBytes: 6,
			}),
		).rejects.toThrow('too large');
		expect(await readdir(dir)).toEqual([]);
	});

	test('a cancel stops the download and keeps no file', async () => {
		const dest = join(dir, 'song.wav');
		const controller = new AbortController();
		const stream = new ReadableStream<Uint8Array>({
			pull(streamController) {
				streamController.enqueue(new Uint8Array(1));
				controller.abort();
			},
		});
		await expect(
			saveDownloadStream(stream, dest, {
				totalBytes: 0,
				signal: controller.signal,
			}),
		).rejects.toThrow('Download cancelled');
		expect(await readdir(dir)).toEqual([]);
	});
});
