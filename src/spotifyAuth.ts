import type { Browser, Page } from 'puppeteer';
import Selectors from './selectors';
import { loadCookies, timeout } from './utils';

export const SPOTIFY_COOKIES_FILE = 'spotify-cookies.json';

/** Loads spotify-cookies.json into the browser. False when the file is missing. */
export async function injectSpotifyCookies(browser: Browser): Promise<boolean> {
	if (!(await Bun.file(SPOTIFY_COOKIES_FILE).exists())) return false;
	let cookies: Awaited<ReturnType<typeof loadCookies>>;
	try {
		cookies = await loadCookies(SPOTIFY_COOKIES_FILE);
	} catch (error) {
		// Spotify is optional; a broken export must not stop SoundCloud-only gates.
		console.warn(
			`Ignoring ${SPOTIFY_COOKIES_FILE}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	await browser.defaultBrowserContext().setCookie(...cookies);
	return cookies.length > 0;
}

export function missingSpotifyCookiesError(platform: string): Error {
	return new Error(
		`${platform} requires Spotify for this gate. Export your Spotify cookies and save them to ${SPOTIFY_COOKIES_FILE} in the project root.`,
	);
}

function isSpotifyAuthorizeUrl(url: string): boolean {
	try {
		const { hostname, pathname } = new URL(url);
		return (
			hostname === 'accounts.spotify.com' &&
			/\/authorize|\/login/.test(pathname)
		);
	} catch {
		return false;
	}
}

/** The open Spotify consent or login page, in a popup or the gate tab itself. */
export async function findSpotifyAuthorizePage(
	browser: Browser,
): Promise<Page | null> {
	for (const page of await browser.pages(true)) {
		if (!page.isClosed() && isSpotifyAuthorizeUrl(page.url())) return page;
	}
	return null;
}

/**
 * Finishes a Spotify OAuth flow that the gate just started. Clicks Agree when
 * Spotify asks for consent; an app that is already authorized redirects back
 * on its own. Resolves once the Spotify page closed or navigated away.
 */
export async function completeSpotifyAuthorization(
	browser: Browser,
	{ appearTimeoutMs = 15_000, finishTimeoutMs = 60_000 } = {},
): Promise<'approved' | 'redirected' | 'not_opened'> {
	const appearDeadline = Date.now() + appearTimeoutMs;
	let authPage: Page | null = null;
	while (!authPage && Date.now() < appearDeadline) {
		authPage = await findSpotifyAuthorizePage(browser);
		if (!authPage) await timeout(250);
	}
	if (!authPage) return 'not_opened';

	const finished = () =>
		authPage.isClosed() || !isSpotifyAuthorizeUrl(authPage.url());
	const finishDeadline = Date.now() + finishTimeoutMs;
	let clicked = false;
	while (!finished() && Date.now() < finishDeadline) {
		if (/\/login/.test(new URL(authPage.url()).pathname)) {
			throw new Error(
				`Spotify asked to sign in. Refresh ${SPOTIFY_COOKIES_FILE} with cookies from a logged-in session.`,
			);
		}
		const accept = await authPage
			.$(Selectors.SP_AUTH_ACCEPT_BUTTON)
			.catch(() => null);
		if (accept && !clicked) {
			await authPage.bringToFront().catch(() => {});
			clicked = await accept.click().then(
				() => true,
				() => false,
			);
		}
		await timeout(250);
	}
	if (!finished()) {
		throw new Error('Timed out waiting for Spotify authorization to finish.');
	}
	return clicked ? 'approved' : 'redirected';
}
