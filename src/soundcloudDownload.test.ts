import { describe, expect, test } from 'bun:test';
import {
	CREATOR_DOWNLOAD_WARNING,
	checkCreatorDownload,
	isSoundcloudDownloadEnabled,
} from './soundcloudDownload';

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

describe('checkCreatorDownload', () => {
	const url = 'https://soundcloud.com/artist/track';
	const enabled = { downloadable: true, has_downloads_left: true };

	test('uses an enabled download that yt-dlp can reach', async () => {
		expect(await checkCreatorDownload(enabled, url, async () => true)).toEqual({
			available: true,
			warning: null,
		});
	});

	test('warns and falls back when yt-dlp cannot reach it', async () => {
		expect(await checkCreatorDownload(enabled, url, async () => false)).toEqual(
			{ available: false, warning: CREATOR_DOWNLOAD_WARNING },
		);
	});

	test('skips the yt-dlp check without an enabled download', async () => {
		let checked = false;
		const result = await checkCreatorDownload(
			{ downloadable: false, has_downloads_left: true },
			url,
			async () => {
				checked = true;
				return true;
			},
		);
		expect(result).toEqual({ available: false, warning: null });
		expect(checked).toBe(false);
	});
});
