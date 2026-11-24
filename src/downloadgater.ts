import { Presets, SingleBar } from 'cli-progress';
import type { Browser, Frame, Page } from 'puppeteer';
import { CancellableBrowserLaunch } from './browserLaunch';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import { signInToSoundcloud, waitForSoundcloudLogin } from './soundcloudLogin';
import {
	completeSpotifyAuthorization,
	injectSpotifyCookies,
	missingSpotifyCookiesError,
} from './spotifyAuth';
import type { HypedditConfig } from './types';
import { loadCookies, timeout } from './utils';

const DG_EMAIL_INPUT =
	'section.gate-flow .email-capture-row input[type="email"]';
const DG_EMAIL_NEXT = 'section.gate-flow .email-capture-row button';
const DG_FLOW_ERROR = 'section.gate-flow .download-error';

type Pane =
	| 'email'
	| 'instagram'
	| 'soundcloud'
	| 'spotify'
	| 'spotify-oauth'
	| 'youtube'
	| 'download'
	| 'unknown';

export class DownloadgaterDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;
	private cancelPendingDownloadWait: (() => void) | null = null;
	private hasSpotifyCookies = false;

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
		this.browser = await this.browserLaunch.launchConfigured(this.config);

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
		this.hasSpotifyCookies = await injectSpotifyCookies(this.browser);
	}

	async prepareLogins() {
		await signInToSoundcloud(this.browser);
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to DownloadGater gate...');
		this.emitProgress(
			'handling_gates',
			'Navigating to DownloadGater gate...',
			25,
		);

		const page = await this.browser.newPage();
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(url, { waitUntil: 'domcontentloaded' });
			try {
				await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
			} catch {
				// continue
			}

			await this.clickFreeDownload(page);

			let soundcloudAttempted = false;
			let deadline = Date.now() + 180_000;
			while (Date.now() < deadline) {
				if (await this.hasDownloadButton(page)) break;

				// Post-OAuth UI can show "Verified unlock" / Finish before Download file.
				await this.clickUnlockFinishIfPresent(page);
				if (await this.hasDownloadButton(page)) break;

				const pane = await this.detectPane(page);
				console.log('DownloadGater pane:', pane);

				if (pane === 'email') {
					this.emitProgress(
						'handling_gates',
						'Submitting DownloadGater email...',
						30,
						{ currentGate: 'email' },
					);
					await this.handleEmailStep(page);
					continue;
				}

				if (pane === 'spotify-oauth') {
					this.emitProgress(
						'handling_gates',
						'Connecting Spotify on DownloadGater...',
						45,
						{ currentGate: 'sp' },
					);
					await this.handleSpotifyOauthStep(page);
					continue;
				}

				if (pane === 'youtube') {
					this.emitProgress(
						'handling_gates',
						'Handling DownloadGater YouTube step...',
						50,
						{ currentGate: 'yt' },
					);
					await this.handleYoutubeStep(page);
					continue;
				}

				if (pane === 'instagram') {
					this.emitProgress(
						'handling_gates',
						'Handling DownloadGater Instagram follows...',
						40,
						{ currentGate: 'ig' },
					);
					await this.handleInstagramStep(page);
					continue;
				}

				if (pane === 'soundcloud') {
					if (soundcloudAttempted) {
						const urlError = await this.readSoundcloudUrlError(page);
						if (urlError) {
							throw new Error(
								`DownloadGater SoundCloud unlock failed: ${urlError}`,
							);
						}
						// Still hydrating unlock → Download file; do not re-click Connect.
						await timeout(500);
						continue;
					}
					soundcloudAttempted = true;
					this.emitProgress(
						'handling_gates',
						'Connecting SoundCloud on DownloadGater...',
						55,
						{ currentGate: 'sc' },
					);
					await this.handleSoundcloudConnect(page);
					deadline = Math.max(deadline, Date.now() + 180_000);
					continue;
				}

				if (pane === 'spotify') {
					this.emitProgress(
						'handling_gates',
						'Handling DownloadGater Spotify step...',
						35,
						{ currentGate: 'sp' },
					);
					await this.handleSpotifyStep(page);
					continue;
				}

				await timeout(500);
			}

			if (!(await this.hasDownloadButton(page))) {
				throw new Error(
					'DownloadGater download button never appeared after completing gates.',
				);
			}

			await this.handleDownload(page);
			return this.downloadFilename;
		} finally {
			await page.close().catch(() => {});
		}
	}

	async close() {
		this.cancelPendingDownloadWait?.();
		this.cancelPendingDownloadWait = null;
		await this.browserLaunch.close();
	}

	private async clickFreeDownload(page: Page) {
		// GatePage is a lazy SPA chunk — wait for hydration before looking for CTA.
		await page.waitForFunction(
			() => {
				const byClass = document.querySelector<HTMLButtonElement>(
					'button.download-button',
				);
				if (byClass && !byClass.disabled) return true;
				return Array.from(document.querySelectorAll('button')).some((btn) =>
					/free\s*download/i.test((btn.textContent || '').trim()),
				);
			},
			{ timeout: 30_000 },
		);

		const clicked = await page.evaluate(() => {
			const byClass = document.querySelector<HTMLButtonElement>(
				'button.download-button',
			);
			if (byClass && !byClass.disabled) {
				byClass.click();
				return 'class';
			}
			const free = Array.from(document.querySelectorAll('button')).find(
				(btn) =>
					/free\s*download/i.test((btn.textContent || '').trim()) &&
					!(btn as HTMLButtonElement).disabled,
			) as HTMLButtonElement | undefined;
			if (free) {
				free.click();
				return 'text';
			}
			return null;
		});
		if (!clicked) {
			throw new Error('DownloadGater FREE DOWNLOAD button not found.');
		}
		await timeout(800);
	}

	/**
	 * Classifies the current unlock step from GatePage's markup: the title's
	 * `data-gate-platform` wordmark, honor-system buttons' `data-gate-key`, and
	 * the email capture row. OAuth steps (SoundCloud, Spotify) share the
	 * "Verified unlock" kicker, so it does not mean the gate is unlocked.
	 */
	private async detectPane(page: Page): Promise<Pane> {
		return page.evaluate((emailInput): Pane => {
			const buttons = Array.from(document.querySelectorAll('button'));
			const buttonText = (btn: Element) => (btn.textContent || '').trim();
			const hasButton = (pattern: RegExp) =>
				buttons.some((btn) => pattern.test(buttonText(btn)));

			if (hasButton(/^(download file|download zip|finish)$/i)) {
				return 'download';
			}
			if (document.querySelector(emailInput)) return 'email';

			const heading = document.querySelector('#gate-flow-title');
			const wordmark = heading?.querySelector('[data-gate-platform]');
			const platform = wordmark?.getAttribute('data-gate-platform') ?? '';
			const title =
				wordmark?.getAttribute('aria-label') ||
				heading?.textContent?.trim() ||
				'';
			const gateKeys = buttons.map((btn) => btn.dataset.gateKey ?? '');

			if (
				hasButton(/connect\b.*\bspotify/i) ||
				(platform === 'spotify' &&
					!!document.querySelector('.spotify-action-list'))
			) {
				return 'spotify-oauth';
			}
			if (
				platform === 'soundcloud' ||
				hasButton(/connect.*soundcloud/i) ||
				(/^complete soundcloud$/i.test(title) &&
					!!document.querySelector('textarea'))
			) {
				return 'soundcloud';
			}
			if (
				platform === 'instagram' ||
				gateKeys.includes('instagramFollow') ||
				/instagram/i.test(title) ||
				hasButton(/follow on instagram/i)
			) {
				return 'instagram';
			}
			if (
				platform === 'spotify' ||
				gateKeys.some((key) => key.startsWith('spotify')) ||
				/spotify/i.test(title)
			) {
				return 'spotify';
			}
			if (platform === 'youtube' || gateKeys.includes('youtubeSubscribe')) {
				return 'youtube';
			}
			return 'unknown';
		}, DG_EMAIL_INPUT);
	}

	private async hasDownloadButton(page: Page): Promise<boolean> {
		return page.evaluate(() =>
			Array.from(document.querySelectorAll('button')).some((btn) =>
				/^(download file|download zip)$/i.test((btn.textContent || '').trim()),
			),
		);
	}

	/**
	 * Shared honor-system gate flow: open the requested social page, wait for
	 * DownloadGater's confirmation, close the popup, and confirm completion.
	 */
	private async handleHonorSystemPopupStep(
		page: Page,
		options: {
			pane: 'instagram' | 'spotify' | 'youtube';
			/** `data-gate-key` values of the step's open button. */
			gateKeys: string[];
			actionButtonPattern: string;
			confirmButtonPattern: string;
			popupUrlPattern: string;
			maxAttempts: number;
			confirmationTimeoutMs: number;
		},
	) {
		const popupUrlPattern = new RegExp(options.popupUrlPattern, 'i');
		for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
			if ((await this.detectPane(page)) !== options.pane) return;
			if (await this.hasDownloadButton(page)) return;

			const pagesBefore = new Set(await this.browser.pages(true));
			const opened = await page.evaluate(
				(pattern, gateKeys) => {
					const actionPattern = new RegExp(pattern, 'i');
					// Multi-account steps label the button "Follow @name — 1 of 3".
					const btn = Array.from(
						document.querySelectorAll<HTMLButtonElement>('button'),
					).find(
						(el) =>
							!el.disabled &&
							(gateKeys.includes(el.dataset.gateKey ?? '') ||
								actionPattern.test((el.textContent || '').trim())),
					);
					btn?.click();
					return btn ? (btn.textContent || '').trim() : null;
				},
				options.actionButtonPattern,
				options.gateKeys,
			);

			if (opened === null) {
				await timeout(500);
				continue;
			}

			let popup: Page | undefined;
			const popupDeadline = Date.now() + 8_000;
			while (!popup && Date.now() < popupDeadline) {
				const pages = await this.browser.pages(true);
				popup = pages.find(
					(candidate) =>
						candidate !== page &&
						!pagesBefore.has(candidate) &&
						popupUrlPattern.test(candidate.url()),
				);
				if (!popup) await timeout(200);
			}
			if (!popup) {
				await timeout(500);
				continue;
			}

			await page
				.waitForFunction(
					(pattern, gateKeys, clicked) => {
						const confirmPattern = new RegExp(pattern, 'i');
						const buttons = Array.from(
							document.querySelectorAll<HTMLButtonElement>('button'),
						);
						if (
							buttons.some(
								(el) =>
									confirmPattern.test((el.textContent || '').trim()) &&
									!el.disabled,
							)
						)
							return true;
						// Multi-account steps relabel the open button for the next account.
						const next = buttons.find((el) =>
							gateKeys.includes(el.dataset.gateKey ?? ''),
						);
						return (
							!!next &&
							!next.disabled &&
							(next.textContent || '').trim() !== clicked
						);
					},
					{ timeout: options.confirmationTimeoutMs },
					options.confirmButtonPattern,
					options.gateKeys,
					opened,
				)
				.catch(() => {});

			if (popup && !popup.isClosed()) {
				await popup.close().catch(() => {});
			}

			const confirmed = await page.evaluate((pattern) => {
				const confirmPattern = new RegExp(pattern, 'i');
				const btn = Array.from(document.querySelectorAll('button')).find(
					(el) =>
						confirmPattern.test((el.textContent || '').trim()) &&
						!(el as HTMLButtonElement).disabled,
				) as HTMLButtonElement | undefined;
				btn?.click();
				return !!btn;
			}, options.confirmButtonPattern);

			await timeout(confirmed ? 800 : 500);
			if ((await this.detectPane(page)) !== options.pane) return;
		}

		throw new Error(
			`DownloadGater ${options.pane} step did not advance. Allow popups and retry.`,
		);
	}

	/** Honor-system Spotify gate; no Spotify OAuth is required. */
	private async handleSpotifyStep(page: Page) {
		await this.handleHonorSystemPopupStep(page, {
			pane: 'spotify',
			gateKeys: ['spotifyFollow', 'spotifyPlaylistFollow'],
			actionButtonPattern: '^(follow|save|open).*spotify$',
			confirmButtonPattern:
				"^(i followed|i saved it|i opened it|i['’]?(?:ve)? done it)$",
			popupUrlPattern: 'open\\.spotify\\.com',
			maxAttempts: 8,
			confirmationTimeoutMs: 8_000,
		});
	}

	/** "Email capture": one email field and a Next button that enables once valid. */
	private async handleEmailStep(page: Page) {
		if (!this.config.email) {
			throw new Error(
				'This DownloadGater gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
			);
		}
		await page.evaluate(
			(selector, value) => {
				const el = document.querySelector<HTMLInputElement>(selector);
				if (!el) return;
				// React-controlled input: use the native setter so onChange sees it.
				Object.getOwnPropertyDescriptor(
					window.HTMLInputElement.prototype,
					'value',
				)?.set?.call(el, value);
				el.dispatchEvent(new Event('input', { bubbles: true }));
			},
			DG_EMAIL_INPUT,
			this.config.email,
		);
		await page.waitForFunction(
			(selector) =>
				document.querySelector<HTMLButtonElement>(selector)?.disabled === false,
			{ timeout: 10_000 },
			DG_EMAIL_NEXT,
		);
		await page.$eval(DG_EMAIL_NEXT, (button) =>
			(button as HTMLButtonElement).click(),
		);
		const handle = await page.waitForFunction(
			(input, error) => {
				if (!document.querySelector(input)) return 'done';
				return document.querySelector(error)?.textContent?.trim() || false;
			},
			{ timeout: 30_000 },
			DG_EMAIL_INPUT,
			DG_FLOW_ERROR,
		);
		const outcome = await handle.jsonValue();
		await handle.dispose();
		if (outcome !== 'done') {
			throw new Error(`DownloadGater email capture failed: ${outcome}`);
		}
	}

	/**
	 * Spotify OAuth variant (`spotifyVerification` other than `visit`): the
	 * button starts Spotify login in this tab, DownloadGater follows the
	 * profiles and playlists server-side, then redirects back to the gate with
	 * `spotify_unlock=<token>` or `spotify_error=<code>`.
	 */
	private async handleSpotifyOauthStep(page: Page) {
		if (!this.hasSpotifyCookies) {
			throw missingSpotifyCookiesError('DownloadGater');
		}

		let unlocked = false;
		let spotifyError: string | null = null;
		const onNavigated = (frame: Frame) => {
			if (frame !== page.mainFrame()) return;
			try {
				const params = new URL(frame.url()).searchParams;
				unlocked ||= params.has('spotify_unlock');
				spotifyError = params.get('spotify_error') ?? spotifyError;
			} catch {
				// not a URL yet
			}
		};
		page.on('framenavigated', onNavigated);
		try {
			const clicked = await page.evaluate(() => {
				const btn = Array.from(
					document.querySelectorAll<HTMLButtonElement>('button'),
				).find((el) => /connect\b.*\bspotify/i.test(el.textContent || ''));
				if (!btn || btn.disabled) return false;
				btn.click();
				return true;
			});
			if (!clicked) {
				throw new Error('DownloadGater Spotify connect button not found.');
			}

			const authorization = await completeSpotifyAuthorization(this.browser);
			console.log(`DownloadGater: Spotify authorization ${authorization}`);

			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				if (spotifyError) {
					throw new Error(
						`DownloadGater Spotify unlock failed: ${spotifyError}`,
					);
				}
				const onGate =
					!page.isClosed() &&
					/^\/g\//.test(new URL(page.url()).pathname) &&
					new URL(page.url()).hostname.endsWith('downloadgater.com');
				const pane = onGate
					? await this.detectPane(page).catch(() => null)
					: null;
				// GatePage hydrates lazily after the redirect; wait for a real step.
				if (pane && pane !== 'spotify-oauth' && pane !== 'unknown') return;
				if (
					pane === 'spotify-oauth' &&
					authorization === 'not_opened' &&
					!unlocked
				) {
					throw new Error(
						'DownloadGater did not open Spotify authorization. Review the gate in the remote browser.',
					);
				}
				await timeout(500);
			}
			throw new Error(
				'DownloadGater did not unlock after Spotify authorization.',
			);
		} finally {
			page.off('framenavigated', onNavigated);
		}
	}

	/** Honor-system YouTube subscribe: open the channel, then confirm. */
	private async handleYoutubeStep(page: Page) {
		await this.handleHonorSystemPopupStep(page, {
			pane: 'youtube',
			gateKeys: ['youtubeSubscribe'],
			actionButtonPattern: '^subscribe on youtube$',
			confirmButtonPattern: '^i subscribed$',
			popupUrlPattern: 'youtube\\.com|youtu\\.be',
			maxAttempts: 4,
			confirmationTimeoutMs: 8_000,
		});
	}

	private async clickUnlockFinishIfPresent(page: Page): Promise<boolean> {
		return page.evaluate(() => {
			const btn = Array.from(document.querySelectorAll('button')).find(
				(el) =>
					/^finish$/i.test((el.textContent || '').trim()) &&
					!(el as HTMLButtonElement).disabled,
			) as HTMLButtonElement | undefined;
			btn?.click();
			return !!btn;
		});
	}

	private async readSoundcloudUrlError(page: Page): Promise<string | null> {
		try {
			return new URL(page.url()).searchParams.get('soundcloud_error');
		} catch {
			return null;
		}
	}

	/**
	 * Honor-system Instagram: open each target (popup), wait for the 5s unlock
	 * timer, then confirm. Multiple IG targets are served one at a time.
	 */
	private async handleInstagramStep(page: Page) {
		await this.handleHonorSystemPopupStep(page, {
			pane: 'instagram',
			gateKeys: ['instagramFollow'],
			actionButtonPattern: 'follow on instagram',
			confirmButtonPattern: '^(i followed|i opened it)$',
			popupUrlPattern: 'instagram\\.com',
			maxAttempts: 8,
			confirmationTimeoutMs: 8_000,
		});
	}

	private async handleSoundcloudConnect(page: Page) {
		const comment = this.config.comment.trim();
		const needsComment = await page.evaluate(() =>
			Boolean(document.querySelector('textarea')),
		);
		if (needsComment) {
			if (comment.length < 1) {
				throw new Error(
					'This DownloadGater gate requires SC_COMMENT before connecting SoundCloud.',
				);
			}
			await page.focus('textarea');
			await page.evaluate((value) => {
				const el = document.querySelector('textarea');
				if (!el) return;
				const setter = Object.getOwnPropertyDescriptor(
					window.HTMLTextAreaElement.prototype,
					'value',
				)?.set;
				setter?.call(el, value);
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}, comment);
			await timeout(300);
		}

		const pagesBefore = new Set(await this.browser.pages(true));

		const clicked = await page.evaluate(() => {
			// "Connect & Follow on Spotify" is the Spotify step, not this one.
			const btn = Array.from(document.querySelectorAll('button')).find((el) => {
				const text = el.textContent || '';
				return (
					/connect.*soundcloud/i.test(text) ||
					(/connect & (follow|repost)/i.test(text) && !/spotify/i.test(text))
				);
			}) as HTMLButtonElement | undefined;
			if (!btn || btn.disabled) return false;
			btn.click();
			return true;
		});
		if (!clicked) {
			throw new Error('DownloadGater SoundCloud connect button not found.');
		}

		// Same-tab OAuth (window.location.assign) — keep one loop like the working
		// Nico Chromium flow: wait for authorize → click Allow → wait for unlock.
		// Never treat "still on downloadgater Connecting…" as done, and never click
		// email "Continue".
		const hardDeadline = Date.now() + 12 * 60_000;
		let deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			const oauthPage = await this.findSoundcloudOauthPage(page, pagesBefore);
			const active =
				oauthPage ??
				(!page.isClosed() ? page : null) ??
				(await this.findPageWithApprovalButton());

			if (!active || active.isClosed()) {
				await timeout(300);
				continue;
			}

			const url = active.url();

			if (
				/soundcloud\.com|secure\.soundcloud\.com/i.test(url) &&
				!url.includes('downloadgater.com')
			) {
				const allowed = await this.clickSoundcloudOauthAllow(active);
				if (!allowed) {
					// Authorize shell can render before #submit_approval is attached.
					await timeout(400);
				} else {
					deadline = Math.min(
						hardDeadline,
						Math.max(deadline, Date.now() + 120_000),
					);
					await timeout(1_000);
				}
				continue;
			}

			// Gate tab may still be downloadgater while authorize is another target.
			const approvalTab = await this.findPageWithApprovalButton();
			if (approvalTab) {
				const allowed = await this.clickSoundcloudOauthAllow(approvalTab);
				if (allowed) {
					deadline = Math.min(
						hardDeadline,
						Math.max(deadline, Date.now() + 120_000),
					);
				}
				await timeout(1_000);
				continue;
			}

			if (!url.includes('downloadgater.com')) {
				await timeout(300);
				continue;
			}

			// Still on the OAuth callback endpoint — wait for the gate redirect.
			// Do not navigate away; that drops the unlock token.
			if (/\/api\/soundcloud\/callback/i.test(url)) {
				await timeout(300);
				continue;
			}

			const soundcloudError = await this.readSoundcloudUrlError(active);
			if (soundcloudError) {
				throw new Error(
					`DownloadGater SoundCloud unlock failed: ${soundcloudError}`,
				);
			}

			await this.clickUnlockFinishIfPresent(active);

			if (await this.hasDownloadButton(active)) {
				await timeout(500);
				return;
			}

			// Unlock query is present briefly, then stripped into localStorage by the SPA.
			if (/[?&]unlock=/i.test(url)) {
				await timeout(1_500);
				return;
			}

			if (!page.isClosed()) {
				const pane = await this.detectPane(page);
				if (pane !== 'soundcloud' && pane !== 'unknown') {
					await timeout(500);
					return;
				}
			}

			await timeout(400);
		}

		throw new Error(
			'DownloadGater did not unlock after SoundCloud OAuth. Check Allow was clicked / Initialize Logins.',
		);
	}

	private async findSoundcloudOauthPage(
		gatePage: Page,
		pagesBefore: Set<Page>,
	): Promise<Page | null> {
		const pages = await this.browser.pages(true);

		const byAuthorizeUrl = pages.find((candidate) => {
			if (candidate.isClosed()) return false;
			return /secure\.soundcloud\.com\/authorize|soundcloud\.com\/.*\/?authorize/i.test(
				candidate.url(),
			);
		});
		if (byAuthorizeUrl) return byAuthorizeUrl;

		if (!gatePage.isClosed()) {
			const gateUrl = gatePage.url();
			if (/soundcloud\.com|secure\.soundcloud\.com/i.test(gateUrl)) {
				return gatePage;
			}
		}

		return (
			pages.find((candidate) => {
				if (candidate === gatePage || candidate.isClosed()) return false;
				const candidateUrl = candidate.url();
				return (
					/soundcloud\.com|secure\.soundcloud\.com/i.test(candidateUrl) ||
					(!pagesBefore.has(candidate) &&
						candidateUrl !== 'about:blank' &&
						/soundcloud/i.test(candidateUrl))
				);
			}) ?? null
		);
	}

	private async findPageWithApprovalButton(): Promise<Page | null> {
		for (const candidate of await this.browser.pages(true)) {
			if (candidate.isClosed()) continue;
			try {
				for (const frame of candidate.frames()) {
					const handle = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
					if (handle) {
						await handle.dispose();
						return candidate;
					}
				}
			} catch {
				// page/frame navigated
			}
		}
		return null;
	}

	/** Approve OAuth only — never the sign-in email "Continue". */
	private async clickSoundcloudOauthAllow(oauthPage: Page): Promise<boolean> {
		try {
			await oauthPage.bringToFront();
		} catch {
			// tab may be navigating
		}

		const needsLogin = await oauthPage
			.evaluate(() =>
				/sign in or create an account/i.test(document.body?.innerText || ''),
			)
			.catch(() => false);

		// Trusted pointer click — authorize ignores plain DOM click() under CloakBrowser.
		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (submit) {
					await submit.click({ delay: 40 });
					console.log(
						'DownloadGater: clicked SoundCloud OAuth submit_approval',
					);
					return true;
				}
			} catch {
				// frame detached / navigated
			}
		}

		for (const frame of oauthPage.frames()) {
			try {
				const clicked = await frame.evaluate(() => {
					const approve = Array.from(document.querySelectorAll('button')).find(
						(btn) =>
							/^(connect|allow|authorize|accept)$/i.test(
								(btn.textContent || '').trim(),
							) && !(btn as HTMLButtonElement).disabled,
					) as HTMLButtonElement | undefined;
					if (!approve) return null;
					approve.click();
					return (approve.textContent || '').trim();
				});
				if (clicked) {
					console.log(`DownloadGater: clicked SoundCloud OAuth ${clicked}`);
					return true;
				}
			} catch {
				// frame detached / navigated
			}
		}

		if (needsLogin) {
			await waitForSoundcloudLogin(oauthPage, {
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
			return this.clickSoundcloudOauthAllow(oauthPage);
		}

		return false;
	}

	private async handleDownload(page: Page) {
		this.emitProgress(
			'handling_gates',
			'Preparing DownloadGater download...',
			75,
		);

		const client = await page.createCDPSession();
		await client.send('Browser.setDownloadBehavior', {
			behavior: 'allow',
			downloadPath: './downloads',
			eventsEnabled: true,
		});

		let downloadGuid: string | null = null;
		let downloadCompleteResolve: (value: string) => void;
		let downloadCompleteReject: (reason: Error) => void;
		const downloadCompletePromise = new Promise<string>((resolve, reject) => {
			downloadCompleteResolve = resolve;
			downloadCompleteReject = reject;
		});
		const cancelPendingDownloadWait = () => {
			downloadCompleteReject(new Error('Download was canceled'));
		};
		this.cancelPendingDownloadWait = cancelPendingDownloadWait;
		const downloadTimer = setTimeout(
			() =>
				downloadCompleteReject(
					new Error('DownloadGater download did not complete in time'),
				),
			5 * 60_000,
		);

		const pBar = new SingleBar(
			{
				format:
					'{prefix} {bar} {percentage}% | {current_mb}/{total_mb} MB | ETA: {eta_formatted}',
				hideCursor: true,
			},
			{
				barCompleteChar: '█',
				barIncompleteChar: '░',
				format: Presets.shades_classic.format,
			},
		);

		client.on('Browser.downloadWillBegin', (event) => {
			downloadGuid = event.guid;
			this.downloadFilename = event.suggestedFilename;
			console.log('Download started:', this.downloadFilename);
			this.emitProgress(
				'downloading',
				`Downloading ${this.downloadFilename}...`,
				0,
			);
		});

		client.on('Browser.downloadProgress', (event) => {
			if (event.guid !== downloadGuid || !this.downloadFilename) return;
			if (event.state === 'completed') {
				pBar.stop();
				console.log('Download completed');
				this.emitProgress('downloading', 'Download complete', 100);
				downloadCompleteResolve(this.downloadFilename);
			} else if (event.state === 'inProgress') {
				const { receivedBytes, totalBytes } = event;
				if (pBar.isActive) {
					pBar.update(receivedBytes, {
						total_mb: Number((totalBytes / 1024 / 1024).toFixed(2)),
						current_mb: Number((receivedBytes / 1024 / 1024).toFixed(2)),
					});
				} else {
					pBar.start(totalBytes, receivedBytes, { prefix: 'Downloading' });
				}
				this.emitProgress(
					'downloading',
					`Downloading... ${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
					0,
					{ downloadBytes: receivedBytes, totalBytes },
				);
			} else if (event.state === 'canceled') {
				pBar.stop();
				downloadCompleteReject(new Error('Download was canceled'));
			}
		});

		const clickDownload = async () => {
			await page.evaluate(() => {
				const btn = Array.from(document.querySelectorAll('button')).find((el) =>
					/^(download file|download zip)$/i.test((el.textContent || '').trim()),
				) as HTMLButtonElement | undefined;
				btn?.click();
			});
		};

		const retryTimer = setTimeout(async () => {
			if (!downloadGuid) {
				console.log(
					'Download not started after 10 seconds, clicking button again...',
				);
				try {
					await clickDownload();
				} catch {
					// ignore
				}
			}
		}, 10_000);

		try {
			await Promise.all([clickDownload(), downloadCompletePromise]);
		} finally {
			if (this.cancelPendingDownloadWait === cancelPendingDownloadWait) {
				this.cancelPendingDownloadWait = null;
			}
			clearTimeout(downloadTimer);
			clearTimeout(retryTimer);
			pBar.stop();
			await client.detach().catch(() => {});
		}
	}
}
