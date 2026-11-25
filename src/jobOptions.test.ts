import { describe, expect, test } from 'bun:test';
import {
	needsSourceLosslessProbe,
	parseBrowserMode,
	parseOutputFormat,
	parseReviewTagsSetting,
	parseUnattendedJobOptions,
} from './jobOptions';
import type { BrowserMode } from './types';

describe('needsSourceLosslessProbe', () => {
	test('probes the source for every converting format, not for original', () => {
		expect(needsSourceLosslessProbe('original')).toBe(false);
		for (const value of ['mp3', 'mp3-320', 'm4a-aac', 'flac'] as const) {
			expect(needsSourceLosslessProbe(value)).toBe(true);
		}
	});
});

describe('parseOutputFormat', () => {
	test('accepts every output format value, including mp3 and m4a-aac', () => {
		for (const value of ['original', 'mp3', 'mp3-320', 'm4a-aac', 'flac']) {
			expect(parseOutputFormat(value)).toBe(value);
		}
	});

	test('rejects unknown and non-string values', () => {
		for (const value of ['m4a', 'aac', 'M4A-AAC', '', 1, null]) {
			expect(parseOutputFormat(value)).toBe(
				'outputFormat must be "original", "mp3", "mp3-320", "m4a-aac", or "flac"',
			);
		}
	});
});

const linuxModes: BrowserMode[] = ['headless', 'xvfb', 'headed'];

describe('parseBrowserMode', () => {
	test('accepts an available mode', () => {
		expect(parseBrowserMode('headed', linuxModes)).toBe('headed');
	});

	test('rejects unknown and unavailable modes', () => {
		expect(parseBrowserMode('visible', linuxModes)).toBe(
			'Invalid browser mode',
		);
		expect(parseBrowserMode('xvfb', ['headless', 'headed'])).toBe(
			'Xvfb browser mode is only available on Linux',
		);
	});
});

describe('parseUnattendedJobOptions', () => {
	test('keeps the server defaults when both fields are omitted', () => {
		expect(parseUnattendedJobOptions({}, 'library', linuxModes)).toEqual({
			browserMode: undefined,
			reviewTags: false,
		});
	});

	test('passes a browser mode and tag review through', () => {
		expect(
			parseUnattendedJobOptions(
				{ browserMode: 'headed', reviewTags: true },
				'client',
				linuxModes,
			),
		).toEqual({ browserMode: 'headed', reviewTags: true });
	});

	test('rejects an invalid browser mode', () => {
		expect(
			parseUnattendedJobOptions({ browserMode: 'xvfb' }, 'library', [
				'headless',
				'headed',
			]),
		).toBe('Xvfb browser mode is only available on Linux');
	});

	test('rejects a non-boolean reviewTags', () => {
		expect(
			parseUnattendedJobOptions({ reviewTags: 'yes' }, 'library', linuxModes),
		).toBe('reviewTags must be true or false');
	});

	test('rejects tag review for Web UI jobs', () => {
		expect(
			typeof parseUnattendedJobOptions({ reviewTags: true }, null, linuxModes),
		).toBe('string');
		expect(
			parseUnattendedJobOptions({ reviewTags: false }, null, linuxModes),
		).toEqual({ browserMode: undefined, reviewTags: false });
	});
});

describe('parseReviewTagsSetting', () => {
	test.each([
		[undefined, false],
		['false', false],
		[' FALSE ', false],
		['true', true],
		[' True ', true],
	])('reads %p as %p', (value, expected) => {
		expect(parseReviewTagsSetting(value)).toBe(expected);
	});

	test.each(['', '  ', 'yes', '1', 'maybe'])(
		'rejects %p and names the setting',
		(value) => {
			expect(() => parseReviewTagsSetting(value)).toThrow(
				'SC_GATE_DL_REVIEW_TAGS',
			);
		},
	);
});
