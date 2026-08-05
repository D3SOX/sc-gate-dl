import { describe, expect, test } from 'bun:test';
import { isSoundcloudDownloadEnabled } from './soundcloudDownload';

describe('isSoundcloudDownloadEnabled', () => {
	test('accepts tracks with creator-enabled downloads remaining', () => {
		expect(
			isSoundcloudDownloadEnabled({
				downloadable: true,
				has_downloads_left: true,
			}),
		).toBe(true);
	});

	test('rejects tracks without an available SoundCloud download', () => {
		expect(
			isSoundcloudDownloadEnabled({
				downloadable: false,
				has_downloads_left: true,
			}),
		).toBe(false);
		expect(
			isSoundcloudDownloadEnabled({
				downloadable: true,
				has_downloads_left: false,
			}),
		).toBe(false);
	});
});
