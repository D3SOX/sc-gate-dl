import { describe, expect, test } from 'bun:test';
import {
	canAccessSoundcloudOriginalDownload,
	parseYtDlpProgressLine,
	readProcessLines,
} from './ytdlp';

const streamChunks = (...chunks: string[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(new TextEncoder().encode(chunk));
			}
			controller.close();
		},
	});

describe('readProcessLines', () => {
	test('splits chunked output and filters handled progress lines', async () => {
		const handled: string[] = [];
		const output = await readProcessLines(
			streamChunks('SC_GATE_', 'PROGRESS\n./downloads/', 'track.flac\n'),
			(line) => {
				handled.push(line);
				return !line.startsWith('SC_GATE_PROGRESS');
			},
		);

		expect(handled).toEqual(['SC_GATE_PROGRESS', './downloads/track.flac']);
		expect(output).toEqual(['./downloads/track.flac']);
	});

	test('preserves a final line without a newline', async () => {
		expect(await readProcessLines(streamChunks('metadata json'))).toEqual([
			'metadata json',
		]);
	});
});

describe('parseYtDlpProgressLine', () => {
	test('calculates byte progress using the exact total', () => {
		expect(
			parseYtDlpProgressLine('SC_GATE_DL_PROGRESS:31161266:62322532:NA:NA:NA'),
		).toEqual({
			downloadBytes: 31161266,
			totalBytes: 62322532,
			percent: 50,
		});
	});

	test('uses an estimated total when yt-dlp has no exact size', () => {
		expect(
			parseYtDlpProgressLine('SC_GATE_DL_PROGRESS:25:NA:100:NA:NA'),
		).toEqual({ downloadBytes: 25, totalBytes: 100, percent: 25 });
	});

	test('uses fragment progress for HLS downloads without byte totals', () => {
		expect(parseYtDlpProgressLine('SC_GATE_DL_PROGRESS:NA:NA:NA:3:12')).toEqual(
			{ downloadBytes: undefined, totalBytes: undefined, percent: 25 },
		);
	});

	test('ignores regular yt-dlp output', () => {
		expect(parseYtDlpProgressLine('./downloads/track.m4a')).toBeNull();
	});
});

describe('canAccessSoundcloudOriginalDownload', () => {
	test('does not allow automatic direct download without exported cookies', async () => {
		expect(
			await canAccessSoundcloudOriginalDownload(
				'https://soundcloud.com/artist/track',
				'./missing-soundcloud-cookies.json',
			),
		).toBe(false);
	});
});
