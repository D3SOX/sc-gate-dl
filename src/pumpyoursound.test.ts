import { describe, expect, test } from 'bun:test';
import {
	findFileLinkInText,
	findMediafireDirectUrl,
	pumpyoursoundMarkCompleteSelector,
	resolvePumpyoursoundFileLink,
} from './pumpyoursound';

describe('pumpyoursoundMarkCompleteSelector', () => {
	const select = (kind: string, slot: string | null) =>
		pumpyoursoundMarkCompleteSelector({ kind, slot, done: false });

	test('tells the Facebook like and share steps apart by their list item', () => {
		expect(select('facebook', 'facebook_follow')).toContain(
			':not([href*="type=share"])',
		);
		expect(select('facebook', 'facebook_follow')).toContain(
			'/auth/facebook-like/',
		);
		expect(select('facebook', 'facebook_share')).toContain(
			'[href*="type=share"]',
		);
	});

	test('maps the other honor-system steps by kind', () => {
		expect(select('instagram', 'instagram_follow')).toContain(
			'/auth/instagram-follow/',
		);
		expect(select('youtube', null)).toContain('/auth/youtube-follow/');
	});

	test('has no control for unknown or unplaced steps', () => {
		expect(select('facebook', null)).toBeNull();
		expect(select('twitter', 'twitter_follow')).toBeNull();
		expect(select('facebook', 'constructor')).toBeNull();
	});
});

describe('resolvePumpyoursoundFileLink', () => {
	// Text export of the Google Doc that gate 239012 hands out, and the
	// download link from its MediaFire page.
	const doc =
		'﻿Link tải Công Viên Lãm Làng:\r\nhttps://www.mediafire.com/file/72uyml1ix55smgr/Cong_Vien_Lam_Lang_%2528JUONGB_x_J.BAE%2529.mp3/file\r\n\r\nNgoài ra … nhắn trực tiếp mình sẽ add vào group nha ✌🏻https://www.mediafire.com/file/72uyml1ix55smgr/other/file';
	const mediafire =
		'<a class="input popsok" aria-label="Download file" href="https://download1514.mediafire.com/abc/72uyml1ix55smgr/Cong+Vien+Lam+Lang+%28JUONGB+x+J.BAE%29.mp3" id="downloadButton">';
	const pages: Record<string, string> = {
		'https://docs.google.com/document/d/1ojjwBhvx3-r2ngKibiMEtDOlTJyi43SsjVy0pdfL1xA/export?format=txt':
			doc,
		'https://www.mediafire.com/file/72uyml1ix55smgr/Cong_Vien_Lam_Lang_%2528JUONGB_x_J.BAE%2529.mp3/file':
			mediafire,
	};
	const read = async (url: string) => {
		const page = pages[url];
		if (page === undefined) throw new Error(`unexpected fetch ${url}`);
		return page;
	};

	test('follows a Google Doc to the MediaFire file', async () => {
		expect(
			await resolvePumpyoursoundFileLink(
				'https://docs.google.com/document/d/1ojjwBhvx3-r2ngKibiMEtDOlTJyi43SsjVy0pdfL1xA/edit?usp=drivesdk',
				read,
			),
		).toBe(
			'https://download1514.mediafire.com/abc/72uyml1ix55smgr/Cong+Vien+Lam+Lang+%28JUONGB+x+J.BAE%29.mp3',
		);
	});

	test('leaves other links alone', async () => {
		for (const url of [
			'https://www.dropbox.com/s/abc/track.wav?dl=0',
			'https://linapary.bandcamp.com/album/latina',
		]) {
			expect(await resolvePumpyoursoundFileLink(url, read)).toBe(url);
		}
	});

	test('fails clearly when the doc has no file link', async () => {
		await expect(
			resolvePumpyoursoundFileLink(
				'https://docs.google.com/document/d/empty/edit',
				async () => 'Thanks for downloading! https://instagram.com/artist',
			),
		).rejects.toThrow('Google Doc without a file link');
	});

	test('finds file links in free text', () => {
		expect(
			findFileLinkInText('see https://example.com/page and ok'),
		).toBeNull();
		expect(
			findFileLinkInText('file: https://cdn.example.com/a/track.mp3).'),
		).toBe('https://cdn.example.com/a/track.mp3');
		expect(findMediafireDirectUrl('<p>no button</p>')).toBeNull();
	});
});
