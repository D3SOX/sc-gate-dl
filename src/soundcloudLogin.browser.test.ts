import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Browser } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { isSoundcloudPageBlocked } from './soundcloudLogin';

let browser: Browser;
beforeAll(async () => {
	browser = await launchAppBrowser({ headless: true, humanize: false });
}, 30_000);
afterAll(async () => {
	await browser?.close();
});

// Local replay of a sign-in page whose form frame shows DataDome's hard block,
// as seen on soundcloud.com/signin. Every request is answered locally.
test('sees a DataDome block shown in a frame inside the sign-in form', async () => {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setRequestInterception(true);
	page.on('request', (request) => {
		const url = new URL(request.url());
		const body =
			url.hostname === 'soundcloud.com'
				? '<h1>Sign in or create an account</h1><iframe src="https://secure.soundcloud.com/web-auth"></iframe>'
				: url.hostname === 'secure.soundcloud.com'
					? `<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=a&cid=b&t=${url.searchParams.get('t') ?? 'bv'}"></iframe>`
					: '<p>You have been blocked.</p>';
		void request.respond({ status: 200, contentType: 'text/html', body });
	});
	try {
		await page.goto('https://soundcloud.com/signin', { waitUntil: 'load' });
		await page.waitForFrame((frame) =>
			frame.url().startsWith('https://geo.captcha-delivery.com/'),
		);
		expect(await isSoundcloudPageBlocked(page)).toBe(true);
	} finally {
		await context.close();
	}
}, 30_000);
