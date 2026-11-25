import type { Browser, BrowserContext, Page } from 'puppeteer';
import Selectors from './selectors';
import { timeout, writeBrowserCookies } from './utils';

const SOUNDCLOUD_HOST_RE = /(^|\.)soundcloud\.com$/i;
// SoundCloud has used both orders.
export const LOGIN_COPY_RE =
	/sign in or create an account|create an account or sign in/i;

function isSoundcloudHost(pageUrl: string): boolean {
	try {
		return SOUNDCLOUD_HOST_RE.test(new URL(pageUrl).hostname);
	} catch {
		return false;
	}
}

export function isSoundcloudLoginDocument(
	pageUrl: string,
	text: string,
	hasApproval: boolean,
): boolean {
	return isSoundcloudHost(pageUrl) && LOGIN_COPY_RE.test(text) && !hasApproval;
}

export async function isSoundcloudLoginPage(page: Page): Promise<boolean> {
	if (page.isClosed()) return false;
	const documentState = await page
		.evaluate(() => ({
			text: document.body?.innerText || '',
			hasApproval:
				!!document.querySelector('button#submit_approval') ||
				!!document.querySelector('button[name="accept"]') ||
				Array.from(document.querySelectorAll('button')).some((button) =>
					/^(allow|accept|connect|authorize)$/i.test(
						(button.textContent || '').trim(),
					),
				),
		}))
		.catch(() => null);
	if (
		documentState &&
		isSoundcloudHost(page.url()) &&
		/\byou have been blocked\b/i.test(documentState.text)
	) {
		throw new Error(
			'SoundCloud blocked this browser or network. Stop and resolve the block with SoundCloud before retrying.',
		);
	}
	return documentState
		? isSoundcloudLoginDocument(
				page.url(),
				documentState.text,
				documentState.hasApproval,
			)
		: false;
}

type SoundcloudLoginWaitOptions = {
	interactive: boolean;
	onWaiting: () => void;
	timeoutMs?: number;
};

export async function saveSoundcloudLogin(
	context: BrowserContext,
): Promise<void> {
	const cookies = (await context.cookies()).filter((cookie) =>
		SOUNDCLOUD_HOST_RE.test(cookie.domain.replace(/^\./, '')),
	);
	if (cookies.length > 0) await writeBrowserCookies(cookies);
}

/** Wait for a user to finish a SoundCloud login in a visible browser. */
export async function waitForSoundcloudLogin(
	page: Page,
	options: SoundcloudLoginWaitOptions,
): Promise<boolean> {
	if (!(await isSoundcloudLoginPage(page))) return false;
	if (!options.interactive) {
		throw new Error(
			'SoundCloud is not logged in. Use visible headed mode or run Initialize Logins first.',
		);
	}

	await page.bringToFront().catch(() => {});
	const context = page.browserContext();
	options.onWaiting();
	const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
	while (Date.now() < deadline) {
		if (page.isClosed() || !(await isSoundcloudLoginPage(page))) {
			await saveSoundcloudLogin(context);
			return true;
		}
		await timeout(500);
	}

	throw new Error('Timed out waiting for SoundCloud login in the browser.');
}

async function hasSoundcloudSession(context: BrowserContext): Promise<boolean> {
	return (await context.cookies()).some(
		(cookie) =>
			cookie.name === 'oauth_token' &&
			cookie.value !== '' &&
			SOUNDCLOUD_HOST_RE.test(cookie.domain.replace(/^\./, '')),
	);
}

/**
 * Initialize Logins: signs the browser in to SoundCloud and saves the cookies.
 *
 * Gates authorize through secure.soundcloud.com, which keeps its own session.
 * An old `oauth_token` cookie still makes soundcloud.com look logged in when
 * that session is gone, so drop it and start from SoundCloud's sign-in page.
 * The user signs in there (a still-valid session continues on its own).
 */
export async function signInToSoundcloud(
	browser: Browser,
	options: {
		solveCaptcha?: (page: Page) => Promise<void>;
		timeoutMs?: number;
	} = {},
): Promise<void> {
	const context = browser.defaultBrowserContext();
	const staleSession = (await context.cookies()).filter(
		(cookie) =>
			cookie.name === 'oauth_token' &&
			SOUNDCLOUD_HOST_RE.test(cookie.domain.replace(/^\./, '')),
	);
	if (staleSession.length > 0) await context.deleteCookie(...staleSession);

	const page = await browser.newPage();
	try {
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto('https://soundcloud.com/signin', {
			waitUntil: 'domcontentloaded',
		});
		const captcha = await page
			.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
				timeout: 5_000,
			})
			.catch(() => null);
		if (captcha) {
			console.log(
				'SoundCloud captcha present during login; solve it in the browser window if needed.',
			);
			await options.solveCaptcha?.(page);
		}

		// The page header links the library even when logged out, so wait for
		// the session cookie that sign-in sets instead.
		console.log('Sign in to SoundCloud in the browser window...');
		const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
		while (!(await hasSoundcloudSession(context))) {
			if (Date.now() > deadline) {
				throw new Error('Timed out waiting for SoundCloud sign-in.');
			}
			await timeout(1_000);
		}
		await page.goto('https://soundcloud.com/you/library', {
			waitUntil: 'domcontentloaded',
		});
		await saveSoundcloudLogin(context);
	} finally {
		await page.close().catch(() => {});
	}
}
