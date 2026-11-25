import { describe, expect, spyOn, test } from 'bun:test';
import type { Cookie, Page } from 'puppeteer';
import {
	isSoundcloudLoginDocument,
	throwIfSoundcloudBlocked,
	waitForSoundcloudLogin,
} from './soundcloudLogin';
import * as utils from './utils';

describe('SoundCloud interactive login detection', () => {
	test('detects a SoundCloud sign-in page without an approval action', () => {
		expect(
			isSoundcloudLoginDocument(
				'https://secure.soundcloud.com/authorize',
				'Sign in or create an account',
				false,
			),
		).toBe(true);
		expect(
			isSoundcloudLoginDocument(
				'https://secure.soundcloud.com/authorize',
				'Create an account or sign in',
				false,
			),
		).toBe(true);
	});

	test('does not interrupt an OAuth approval page or another host', () => {
		expect(
			isSoundcloudLoginDocument(
				'https://secure.soundcloud.com/authorize',
				'Sign in or create an account',
				true,
			),
		).toBe(false);
		expect(
			isSoundcloudLoginDocument(
				'https://example.com/',
				'Sign in or create an account',
				false,
			),
		).toBe(false);
	});

	test('reports SoundCloud block page only on SoundCloud', () => {
		const blocked =
			'You have been blocked. We detected unusual activity from your device or network.';
		expect(() =>
			throwIfSoundcloudBlocked('https://secure.soundcloud.com/', blocked),
		).toThrow('SoundCloud blocked');
		expect(() =>
			throwIfSoundcloudBlocked('https://example.com/', blocked),
		).not.toThrow();
		expect(() =>
			throwIfSoundcloudBlocked(
				'https://soundcloud.com/signin',
				'Sign in or create an account',
			),
		).not.toThrow();
	});
});

describe('SoundCloud login persistence', () => {
	const cookie = (value: string, domain = '.soundcloud.com'): Cookie => ({
		name: 'oauth_token',
		value,
		domain,
		path: '/',
		expires: -1,
		size: value.length,
		secure: true,
		session: true,
	});

	async function finishLogin(cookies: Cookie[]) {
		let checks = 0;
		const page = {
			isClosed: () => false,
			url: () => 'https://secure.soundcloud.com/authorize',
			bringToFront: async () => {},
			evaluate: async () => ({
				text: ++checks === 1 ? 'Sign in or create an account' : 'Allow',
				hasApproval: checks > 1,
			}),
			browserContext: () => ({ cookies: async () => cookies }),
		} as unknown as Page;
		return waitForSoundcloudLogin(page, {
			interactive: true,
			onWaiting: () => {},
		});
	}

	test('saves a refreshed login without exporting other sites cookies', async () => {
		const save = spyOn(utils, 'writeBrowserCookies').mockResolvedValue(
			undefined,
		);
		try {
			const refreshed = cookie('refreshed');
			await finishLogin([refreshed, cookie('private', 'other.example')]);
			expect(save).toHaveBeenCalledTimes(1);
			expect(save).toHaveBeenCalledWith([refreshed]);
		} finally {
			save.mockRestore();
		}
	});

	test('stops waiting when SoundCloud shows its block page', async () => {
		const save = spyOn(utils, 'writeBrowserCookies').mockResolvedValue(
			undefined,
		);
		let checks = 0;
		const page = {
			isClosed: () => false,
			url: () => 'https://secure.soundcloud.com/authorize',
			bringToFront: async () => {},
			evaluate: async () => ({
				text:
					++checks === 1
						? 'Sign in or create an account'
						: 'You have been blocked.',
				hasApproval: false,
			}),
			browserContext: () => ({ cookies: async () => [cookie('private')] }),
		} as unknown as Page;
		try {
			await expect(
				waitForSoundcloudLogin(page, {
					interactive: true,
					onWaiting: () => {},
				}),
			).rejects.toThrow('SoundCloud blocked');
			expect(save).not.toHaveBeenCalled();
		} finally {
			save.mockRestore();
		}
	});

	test('does not overwrite saved credentials with an empty session', async () => {
		const save = spyOn(utils, 'writeBrowserCookies').mockResolvedValue(
			undefined,
		);
		try {
			await finishLogin([]);
			expect(save).not.toHaveBeenCalled();
		} finally {
			save.mockRestore();
		}
	});
});
