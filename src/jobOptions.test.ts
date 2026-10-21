import { describe, expect, test } from 'bun:test';
import { parseBrowserMode, parseUnattendedJobOptions } from './jobOptions';
import type { BrowserMode } from './types';

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
