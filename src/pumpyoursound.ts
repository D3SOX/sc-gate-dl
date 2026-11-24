import type { Browser, Page } from 'puppeteer';
import {
	BandcampGateDownloader,
	type BandcampGateOptions,
} from './bandcampGate';
import {
	browserModeToLaunchOptions,
	CancellableBrowserLaunch,
} from './browserLaunch';
import { DirectDownloader } from './directDownload';
import { urlLooksLikeDirectDownload } from './directLinkRules';
import type { ProgressCallback } from './hypeddit';
import { safeFetch } from './safeOutboundUrl';
import Selectors from './selectors';
import { signInToSoundcloud, waitForSoundcloudLogin } from './soundcloudLogin';
import {
	completeSpotifyAuthorization,
	injectSpotifyCookies,
	missingSpotifyCookiesError,
} from './spotifyAuth';
import type { HypedditConfig } from './types';
import { isBandcampUrl, loadCookies, timeout, trimExtractedUrl } from './utils';

const SC_AUTHORIZE_RE = /secure\.soundcloud\.com\/authorize/i;
const SPOTIFY_FOLLOW_LINK = 'a[href*="/auth/spotify-follow/"]';

export type PumpyoursoundStep = {
	kind: string;
	done: boolean;
	/** `id` of the step's `<li>`, e.g. `facebook_follow` or `facebook_share`. */
	slot: string | null;
};

/**
 * Honor-system confirm links, keyed by step kind (or `<li>` id for the two
 * Facebook steps). The page always contains the share confirm link inside
 * `#facebook-share-modal`, even when the gate has no Facebook share step.
 */
const MARK_COMPLETE_SELECTORS = new Map([
	['instagram', '[data-href*="/auth/instagram-follow/"]'],
	['youtube', 'a[href*="/auth/youtube-follow/"]'],
	// Like is either an `/auth/facebook-like/` AJAX link on the button or the
	// "Continue & Close" link of the like modal.
	[
		'facebook_follow',
		'#facebook_follow [data-href*="/auth/facebook-like/"], a[href*="do=markFacebookStepAsComplete"]:not([href*="type=share"])',
	],
	[
		'facebook_share',
		'a[href*="do=markFacebookStepAsComplete"][href*="type=share"]',
	],
]);

export function pumpyoursoundMarkCompleteSelector(
	step: PumpyoursoundStep,
): string | null {
	const key = step.kind === 'facebook' ? step.slot : step.kind;
	return (key && MARK_COMPLETE_SELECTORS.get(key)) || null;
}

const FILE_HOST_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const GOOGLE_DOC_RE = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/i;
const MEDIAFIRE_FILE_RE =
	/^https?:\/\/(?:www\.)?mediafire\.com\/(?:file|download)\//i;

/** First link in a Google Doc's text that points at a file or file host. */
export function findFileLinkInText(text: string): string | null {
	for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
		const link = trimExtractedUrl(match[0]);
		try {
			if (
				MEDIAFIRE_FILE_RE.test(link) ||
				isBandcampUrl(link) ||
				urlLooksLikeDirectDownload(new URL(link))
			) {
				return link;
			}
		} catch {
			// not a URL
		}
	}
	return null;
}

/** The direct `downloadNNNN.mediafire.com` URL behind a MediaFire file page. */
export function findMediafireDirectUrl(html: string): string | null {
	return (
		html.match(/https:\/\/download\d*\.mediafire\.com\/[^\s"'<>]+/)?.[0] ?? null
	);
}

/** Like the direct downloader, checks every redirect hop against private hosts. */
async function fetchText(url: string, cancel?: AbortSignal): Promise<string> {
	const timeoutSignal = AbortSignal.timeout(30_000);
	const signal = cancel
		? AbortSignal.any([cancel, timeoutSignal])
		: timeoutSignal;
	let current = url;
	for (let hop = 0; hop <= 10; hop++) {
		const { response } = await safeFetch(current, {
			headers: { 'User-Agent': FILE_HOST_UA },
			signal,
		});
		const location = response.headers.get('location');
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			current = new URL(location, current).toString();
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Fetching ${url} failed (${response.status})`);
		}
		return response.text();
	}
	throw new Error(`Fetching ${url} redirected too often.`);
}

/**
 * Some fangates link a Google Doc (with the real link inside) or a MediaFire
 * page instead of the file. Follows those to something the downloaders take.
 */
export async function resolvePumpyoursoundFileLink(
	url: string,
	read: (url: string) => Promise<string> = fetchText,
): Promise<string> {
	let current = url;
	for (let hop = 0; hop < 3; hop++) {
		const docId = current.match(GOOGLE_DOC_RE)?.[1];
		if (docId) {
			const text = await read(
				`https://docs.google.com/document/d/${docId}/export?format=txt`,
			);
			const link = findFileLinkInText(text);
			if (!link) {
				throw new Error(
					`PumpYourSound download link is a Google Doc without a file link: ${current}`,
				);
			}
			console.log(`PumpYourSound: Google Doc links ${link}`);
			current = link;
			continue;
		}
		if (MEDIAFIRE_FILE_RE.test(current)) {
			const direct = findMediafireDirectUrl(await read(current));
			if (!direct) {
				throw new Error(
					`PumpYourSound download link is a MediaFire page without a download link: ${current}`,
				);
			}
			return direct;
		}
		return current;
	}
	return current;
}

function isFacebookUrl(url: string): boolean {
	try {
		return /(^|\.)facebook\.com$/i.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

function isSpotifyAccountsUrl(url: string): boolean {
	try {
		return new URL(url).hostname === 'accounts.spotify.com';
	} catch {
		return false;
	}
}

/**
 * PumpYourSound fangate downloader.
 *
 * Flow (from live repro):
 * 1. Complete SC Follow via SC.connect popup → Allow →
 *    `/?do=mySoundcloud*` → `/auth/soundcloud-events/`
 * 2. Mark Instagram/YouTube/Facebook like/share via their honor-system
 *    confirm links (`/auth/...` or `?do=markFacebookStepAsComplete`)
 * 3. Spotify Follow via same-tab Spotify OAuth (`/auth/spotify-follow/`)
 * 4. Optional SC comment via `/auth/sc-comment/`
 * 5. POST free-download form → 303 `/fangate/download/{id}?downloadLink=...`
 * 6. Fetch `downloadLink` / `data-redirect-link` (Google Doc and MediaFire
 *    links resolved first) via DirectDownloader, or hand Bandcamp links to
 *    BandcampGateDownloader
 *
 * Every step waits for the page's late-bound handlers (`#preloader` hidden).
 */
export class PumpyoursoundDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private directDownloader: DirectDownloader | null = null;
	private bandcampDownloader: BandcampGateDownloader | null = null;
	downloadMethod: 'gate' | 'bandcamp-stream' = 'gate';
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	/** Aborted by close(), so file-link lookups stop with the job. */
	private readonly closeController = new AbortController();
	private progressCallback: ProgressCallback | null = null;
	private spotifyCookiesLoaded = false;

	constructor(config: HypedditConfig) {
		this.config = config;
	}

	setProgressCallback(callback: ProgressCallback): void {
		this.progressCallback = callback;
	}

	private emitProgress(
		stage: Parameters<ProgressCallback>[0],
		message: string,
		percent: number,
		extra?: Parameters<ProgressCallback>[3],
	): void {
		this.progressCallback?.(stage, message, percent, extra);
	}

	async initialize() {
		this.browser = await this.browserLaunch.launch({
			...browserModeToLaunchOptions(this.config.browserMode),
			userDataDir: this.config.userDataDir ?? './browser-data',
			// SC.connect authorize popup shares session cookies more reliably with this.
			args: ['--fingerprint-allow-3p-cookies'],
		});

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
		this.spotifyCookiesLoaded = await injectSpotifyCookies(this.browser);
	}

	async prepareLogins() {
		await signInToSoundcloud(this.browser);
	}

	async downloadAudio(
		url: string,
		options: BandcampGateOptions = {},
	): Promise<string | null> {
		this.downloadMethod = 'gate';
		console.log('Navigating to PumpYourSound gate...');
		this.emitProgress(
			'handling_gates',
			'Navigating to PumpYourSound gate...',
			25,
		);

		const page = await this.browser.newPage();
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
			try {
				await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
			} catch {
				// continue
			}

			await this.dismissOverlays(page);
			await this.completeGateSteps(page);

			const fileUrl = await resolvePumpyoursoundFileLink(
				await this.submitAndReadDownloadLink(page),
				(link) => fetchText(link, this.closeController.signal),
			);
			// close() can't reach a downloader that doesn't exist yet.
			if (this.closeController.signal.aborted)
				throw new Error('Download cancelled');
			if (isBandcampUrl(fileUrl)) {
				// The download page redirects to the link itself after a countdown,
				// which would race the Bandcamp navigation.
				await page.goto('about:blank').catch(() => {});
				const bandcamp = new BandcampGateDownloader(
					page,
					this.progressCallback ?? undefined,
					this.config.browserMode === 'headed',
				);
				this.bandcampDownloader = bandcamp;
				const result = await bandcamp.downloadAudio(fileUrl, options);
				this.downloadMethod = result.method;
				this.downloadFilename = result.filename;
				return result.filename;
			}
			this.emitProgress(
				'handling_gates',
				'Downloading PumpYourSound file...',
				80,
			);

			const direct = new DirectDownloader();
			this.directDownloader = direct;
			if (this.progressCallback) {
				// File bytes come from HTTP, but this job already used the browser and
				// SoundCloud OAuth — keep browserless false so the Web UI still offers
				// the SoundCloud cleanup prompt when the download starts.
				direct.setProgressCallback((stage, message, percent, extra) => {
					this.progressCallback?.(stage, message, percent, {
						...extra,
						browserless: false,
					});
				});
			}
			this.downloadFilename = await direct.downloadAudio(fileUrl);
			return this.downloadFilename;
		} finally {
			await page.close().catch(() => {});
		}
	}

	async close() {
		this.closeController.abort();
		await this.bandcampDownloader?.close();
		await this.directDownloader?.close();
		await this.browserLaunch.close();
	}

	private async dismissOverlays(page: Page) {
		await page.evaluate(() => {
			document
				.querySelector<HTMLElement>(
					'#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept',
				)
				?.click();
			for (const btn of document.querySelectorAll('button')) {
				if (/^no$/i.test((btn.textContent || '').trim())) {
					btn.click();
				}
			}
		});
		await timeout(400);
	}

	private async completeGateSteps(page: Page) {
		const deadline = Date.now() + 240_000;
		let loops = 0;
		while (Date.now() < deadline && loops++ < 14) {
			await this.waitForGateReady(page);
			const status = await this.readStepStatus(page);
			console.log('PumpYourSound steps:', status);

			if (status.length > 0 && status.every((s) => s.done)) {
				return;
			}

			const needSc = status.some((s) => s.kind === 'soundcloud' && !s.done);
			const needComment = status.some((s) => s.kind === 'comment' && !s.done);
			const needSpotify = status.some((s) => s.kind === 'spotify' && !s.done);
			// Twitter is listed on some fangates but has no mark-complete control yet —
			// leave it out so it surfaces as unsupported instead of a false social miss.
			const socialIndex = status.findIndex(
				(s) =>
					(s.kind === 'instagram' ||
						s.kind === 'facebook' ||
						s.kind === 'youtube') &&
					!s.done,
			);

			if (needSc) {
				this.emitProgress(
					'handling_gates',
					'Connecting SoundCloud on PumpYourSound...',
					40,
					{ currentGate: 'sc' },
				);
				await this.handleSoundcloudFollow(page);
				continue;
			}

			const social = status[socialIndex];
			if (social) {
				this.emitProgress(
					'handling_gates',
					'Handling PumpYourSound social step...',
					55,
					{ currentGate: 'social' },
				);
				await this.handleSocialMarkComplete(page, social, socialIndex);
				continue;
			}

			if (needSpotify) {
				this.emitProgress(
					'handling_gates',
					'Following on Spotify for PumpYourSound...',
					60,
					{ currentGate: 'sp' },
				);
				await this.handleSpotifyFollow(page);
				continue;
			}

			if (needComment) {
				this.emitProgress(
					'handling_gates',
					'Sending SoundCloud comment on PumpYourSound...',
					65,
					{ currentGate: 'sc' },
				);
				await this.handleComment(page);
				continue;
			}

			// Email-only / unknown remaining UI — try continuing to download.
			if (status.length === 0) {
				return;
			}
			throw new Error(
				`Unsupported PumpYourSound gate steps: ${status
					.filter((s) => !s.done)
					.map((s) => s.kind)
					.join(', ')}`,
			);
		}

		const finalStatus = await this.readStepStatus(page);
		if (!(finalStatus.length > 0 && finalStatus.every((s) => s.done))) {
			throw new Error(
				'PumpYourSound gate steps did not complete in time. Check SoundCloud login / Allow OAuth.',
			);
		}
	}

	/**
	 * The site binds its click handlers (social AJAX, SC.connect, nette) late,
	 * via require.js, and hides `#preloader` once that's done and again after
	 * every nette request. Clicks before that only open the social popup.
	 */
	private async waitForGateReady(page: Page) {
		await page
			.waitForFunction(
				() => {
					const preloader = document.querySelector('#preloader');
					// Steps are server-rendered, so an email-only gate has none to wait for.
					return (
						document.readyState === 'complete' &&
						(!preloader || getComputedStyle(preloader).display === 'none')
					);
				},
				{ timeout: 30_000 },
			)
			.catch(() => {
				console.log(
					'PumpYourSound: page scripts not ready after 30s, continuing',
				);
			});
	}

	private async readStepStatus(page: Page): Promise<PumpyoursoundStep[]> {
		return page.evaluate(() => {
			return Array.from(document.querySelectorAll('.fangateStep')).map((el) => {
				const cls = el.className;
				const kind =
					cls.match(/fangateStep--([a-z]+)/i)?.[1]?.toLowerCase() || 'unknown';
				return {
					kind,
					done: el.classList.contains('done'),
					slot: el.closest('li')?.id || null,
				};
			});
		});
	}

	/**
	 * `/auth/spotify-follow/` redirects the gate tab to Spotify's consent page;
	 * the callback follows the artist and redirects back to the fangate.
	 */
	private async handleSpotifyFollow(page: Page) {
		if (!this.spotifyCookiesLoaded) {
			throw missingSpotifyCookiesError('PumpYourSound');
		}
		const href = await page
			.$eval(SPOTIFY_FOLLOW_LINK, (a) => (a as HTMLAnchorElement).href)
			.catch(() => null);
		if (!href) {
			throw new Error('PumpYourSound Spotify Follow link not found.');
		}
		await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		if (isSpotifyAccountsUrl(page.url())) {
			const result = await completeSpotifyAuthorization(this.browser);
			console.log(`PumpYourSound: Spotify authorization ${result}`);
		}
		await page.waitForFunction(
			() =>
				/(^|\.)pumpyoursound\.com$/.test(location.hostname) &&
				!location.pathname.startsWith('/auth/') &&
				!!document.querySelector('.fangateStep'),
			{ timeout: 60_000 },
		);
		const done = await page.$('.fangateStep--spotify.done');
		if (!done) {
			throw new Error(
				`PumpYourSound Spotify step is still incomplete after Spotify authorization (back on ${page.url()}).`,
			);
		}
		await done.dispose();
		console.log('PumpYourSound: spotify step marked done');
	}

	private async handleSoundcloudFollow(page: Page) {
		const clicked = await page.evaluate(() => {
			const el = document.querySelector<HTMLElement>(
				'.socBtn__soundcloud.sn-connect-with-soundcloud',
			);
			if (!el) return false;
			el.click();
			return true;
		});
		if (!clicked) {
			throw new Error('PumpYourSound SoundCloud Follow button not found.');
		}
		await this.completeSoundcloudOauth(page, 'soundcloud');
	}

	private async handleComment(page: Page) {
		const comment = this.config.comment.trim();
		if (comment.length < 2) {
			throw new Error(
				'This PumpYourSound gate requires SC_COMMENT (at least 2 characters).',
			);
		}

		await page.evaluate((text) => {
			const input = document.querySelector<HTMLInputElement>(
				'input[name="fangate_comment"], input.fangatex__icomment',
			);
			if (!input) {
				throw new Error('PumpYourSound comment input not found.');
			}
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
			const send = document.querySelector<HTMLElement>('#fangate-send-comment');
			if (!send) {
				throw new Error('PumpYourSound comment send button not found.');
			}
			const href = send.getAttribute('data-href');
			if (href) {
				const u = new URL(href, location.origin);
				u.searchParams.set('text', text);
				send.setAttribute('data-href', `${u.pathname}${u.search}`);
			}
			send.click();
		}, comment);

		await this.completeSoundcloudOauth(page, 'comment');
	}

	/**
	 * Wait for authorize + #submit_approval, click Allow, then wait until the
	 * matching fangate step is marked done. Never force-closes the Allow tab.
	 */
	private async completeSoundcloudOauth(
		gatePage: Page,
		expect: 'soundcloud' | 'comment',
	) {
		let deadline = Date.now() + 180_000;
		let lastLog = 0;
		let lastAllowAt = 0;

		while (Date.now() < deadline) {
			if (gatePage.isClosed()) {
				throw new Error(
					'PumpYourSound gate tab closed during SoundCloud OAuth.',
				);
			}

			const done = await gatePage
				.evaluate((kind) => {
					const sel =
						kind === 'comment'
							? '.fangateStep--comment.done'
							: '.fangateStep--soundcloud.done';
					return !!document.querySelector(sel);
				}, expect)
				.catch(() => false);
			if (done) {
				console.log(`PumpYourSound: ${expect} step marked done`);
				return;
			}

			const authorizePage = await this.findAuthorizePageWithAllow();
			if (authorizePage) {
				const canRetry = Date.now() - lastAllowAt > 4_000;
				if (lastAllowAt === 0 || canRetry) {
					const method = await this.clickSoundcloudAllow(authorizePage);
					console.log(
						`PumpYourSound: Allow → ${method} (${authorizePage.url().slice(0, 100)})`,
					);
					if (method !== 'miss') {
						lastAllowAt = Date.now();
						await timeout(2_000);
						continue;
					}
				}
			}

			for (const candidate of await this.browser.pages(true)) {
				if (candidate.isClosed() || candidate === gatePage) continue;
				if (!SC_AUTHORIZE_RE.test(candidate.url())) continue;
				const needsLogin = await candidate
					.evaluate(async () => {
						const loginRe =
							/sign in or create an account|create an account or sign in/i;
						if (!loginRe.test(document.body?.innerText || '')) return false;
						await new Promise((r) => setTimeout(r, 1_500));
						const text = document.body?.innerText || '';
						const hasAllow = !!document.querySelector('#submit_approval');
						return loginRe.test(text) && !hasAllow;
					})
					.catch(() => false);
				if (needsLogin) {
					await waitForSoundcloudLogin(candidate, {
						interactive: this.config.browserMode === 'headed',
						onWaiting: () =>
							this.emitProgress(
								'handling_gates',
								'Log in to SoundCloud in the browser to continue...',
								50,
								{
									currentGate: 'soundcloud',
									browserActive: true,
									requiresAttention: true,
								},
							),
					});
					deadline = Date.now() + 180_000;
				}
			}

			if (Date.now() - lastLog > 5_000) {
				const urls = (await this.browser.pages(true)).map((p) =>
					p.isClosed() ? '(closed)' : p.url().slice(0, 100),
				);
				console.log('PumpYourSound OAuth waiting…', urls.join(' | '));
				lastLog = Date.now();
			}

			await timeout(400);
		}

		throw new Error(
			`Timed out waiting for PumpYourSound ${expect} step after SoundCloud OAuth.`,
		);
	}

	private async findAuthorizePageWithAllow(): Promise<Page | null> {
		const pages = (await this.browser.pages(true)).filter((p) => !p.isClosed());
		for (const candidate of [...pages].reverse()) {
			if (!SC_AUTHORIZE_RE.test(candidate.url())) continue;
			try {
				for (const frame of candidate.frames()) {
					const handle = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
					if (handle) {
						await handle.dispose().catch(() => {});
						return candidate;
					}
				}
			} catch {
				// navigated
			}
		}
		return null;
	}

	private async clickSoundcloudAllow(oauthPage: Page): Promise<string> {
		await oauthPage.bringToFront().catch(() => {});
		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (submit) {
					await submit.click({ delay: 40 });
					return 'submit_approval';
				}
			} catch {
				// frame gone
			}
		}
		for (const frame of oauthPage.frames()) {
			try {
				const clicked = await frame.evaluate(() => {
					const btn = Array.from(document.querySelectorAll('button')).find(
						(b) =>
							/^(allow|accept|connect)$/i.test((b.textContent || '').trim()),
					) as HTMLButtonElement | undefined;
					if (!btn) return null;
					btn.click();
					return (btn.textContent || '').trim();
				});
				if (clicked) return clicked;
			} catch {
				// ignore
			}
		}
		return 'miss';
	}

	/**
	 * Clicks the step's own confirm link (the site's jQuery/nette handlers send
	 * the AJAX request) and waits until that step shows `.done`.
	 */
	private async handleSocialMarkComplete(
		page: Page,
		step: PumpyoursoundStep,
		index: number,
	) {
		const label = step.slot ?? step.kind;
		const selector = pumpyoursoundMarkCompleteSelector(step);
		const href = selector
			? await page.evaluate((sel) => {
					const el = document.querySelector<HTMLElement>(sel);
					if (!el) return null;
					el.click();
					return el.getAttribute('data-href') || el.getAttribute('href');
				}, selector)
			: null;
		if (!href) {
			throw new Error(
				`PumpYourSound ${label} step is incomplete but no mark-complete control was found.`,
			);
		}
		console.log('PumpYourSound social mark-complete:', href);
		await this.waitForStepDone(page, index, label);
		for (const p of await this.browser.pages(true)) {
			if (p === page || p.isClosed()) continue;
			if (/instagram\.com|youtube\.com|facebook\.com/i.test(p.url())) {
				await p.close().catch(() => {});
			}
		}
	}

	/** Waits for step `index` to show `.done`, reloading once if it does not. */
	private async waitForStepDone(page: Page, index: number, label: string) {
		for (const reload of [false, true]) {
			if (reload) {
				await page
					.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
					.catch(() => {});
			}
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (isFacebookUrl(page.url())) {
					throw new Error(
						`PumpYourSound ${label} step redirected to Facebook sign-in, which is not supported.`,
					);
				}
				const done = await page
					.evaluate(
						(i) =>
							document
								.querySelectorAll('.fangateStep')
								[i]?.classList.contains('done') ?? false,
						index,
					)
					.catch(() => false);
				if (done) return;
				await timeout(400);
			}
		}
		throw new Error(
			`PumpYourSound ${label} step did not complete after clicking its mark-complete control.`,
		);
	}

	private async submitAndReadDownloadLink(page: Page): Promise<string> {
		this.emitProgress(
			'handling_gates',
			'Submitting PumpYourSound download...',
			75,
		);

		const emailRequired = await page.$('#frm-freeDownloadForm-email');
		if (emailRequired) {
			const email = this.config.email?.trim();
			if (!email) {
				throw new Error(
					'This PumpYourSound gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
				);
			}
			await page.evaluate((value) => {
				const modalToggle = document.querySelector<HTMLElement>(
					'a[href="#confirm-email-subscription"]',
				);
				modalToggle?.click();
				const input = document.querySelector<HTMLInputElement>(
					'#frm-freeDownloadForm-email',
				);
				if (input) {
					input.value = value;
					input.dispatchEvent(new Event('input', { bubbles: true }));
				}
			}, email);
			await timeout(400);
		}

		const navigation = page
			.waitForNavigation({
				waitUntil: 'domcontentloaded',
				timeout: 60_000,
			})
			.catch(() => null);

		try {
			await page.evaluate(() => {
				const submit = document.querySelector<HTMLInputElement>(
					'#frm-freeDownloadForm input[type="submit"][name="send"]',
				);
				if (submit) {
					submit.click();
					return;
				}
				document
					.querySelector<HTMLFormElement>('#frm-freeDownloadForm')
					?.requestSubmit();
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				!/Execution context was destroyed|Cannot find context|frame was detached|Navigating frame/i.test(
					message,
				)
			) {
				throw error;
			}
			// Form submit navigated away — expected.
		}

		await navigation;

		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const fromUrl = new URL(page.url()).searchParams.get('downloadLink');
				if (fromUrl) return trimExtractedUrl(fromUrl);
			} catch {
				// ignore
			}
			const link = await this.readDownloadLink(page).catch(() => null);
			if (link) return link;
			await timeout(400);
		}

		throw new Error(
			'PumpYourSound download page never exposed a downloadLink after form submit. Incomplete gate steps?',
		);
	}

	private async readDownloadLink(page: Page): Promise<string | null> {
		if (page.isClosed()) return null;
		try {
			const fromUrl = new URL(page.url()).searchParams.get('downloadLink');
			if (fromUrl) return trimExtractedUrl(fromUrl);
		} catch {
			// ignore
		}
		return page
			.evaluate(() => {
				const fromData = document
					.querySelector('.fangateDownload')
					?.getAttribute('data-redirect-link');
				if (fromData) return fromData;
				try {
					const fromQuery = new URL(location.href).searchParams.get(
						'downloadLink',
					);
					return fromQuery;
				} catch {
					return null;
				}
			})
			.then((value) => (value ? trimExtractedUrl(value) : null));
	}
}
