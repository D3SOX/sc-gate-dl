import { describe, expect, test } from 'bun:test';
import { parseYtDlpProgressLine } from './ytdlp';

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
