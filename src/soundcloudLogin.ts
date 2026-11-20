import type { BrowserContext, Page } from 'puppeteer';
import { timeout, writeBrowserCookies } from './utils';

const SOUNDCLOUD_HOST_RE = /(^|\.)soundcloud\.com$/i;
const LOGIN_COPY_RE =
	/(?:sign in or create an account|create an account or sign in)/i;

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
