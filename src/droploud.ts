import { Presets, SingleBar } from 'cli-progress';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import { SoundcloudClient } from './soundcloud';
import type { HypedditConfig } from './types';
import { loadCookies, timeout } from './utils';

type PaneKind =
	| 'social_open'
	| 'soundcloud_connect'
	| 'email'
	| 'droploud_follow'
	| 'disclaimer'
	| 'unlocked'
	| 'unknown';

export class DroploudDownloader {
	private browser!: Browser;
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;

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
		this.browser = await launchAppBrowser({
			headless: this.config.headless,
			userDataDir: this.config.userDataDir ?? './browser-data',
		});

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
	}

	async prepareLogins() {
		const soundCloudPage = await this.browser.newPage();
		soundCloudPage.setViewport({ width: 1920, height: 1080 });
		await soundCloudPage.goto('https://soundcloud.com/messages');

		try {
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ timeout: 5_000 },
			);
			console.log(
				'Droploud: SoundCloud captcha present during login warm-up; solve it in the browser window if needed.',
			);
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ hidden: true, timeout: 120_000 },
			);
		} catch {
			// no captcha
		}

		await soundCloudPage.waitForSelector(Selectors.SOUNDCLOUD_LIBRARY_LINK, {
			timeout: 30_000,
		});
		await Promise.all([
			soundCloudPage.click(Selectors.SOUNDCLOUD_LIBRARY_LINK),
			soundCloudPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		]);
		await soundCloudPage.waitForFunction(() =>
			window.location.href.includes('/you/library'),
		);
		await soundCloudPage.close();
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to Droploud gate...');
		this.emitProgress('handling_gates', 'Navigating to Droploud gate...', 25);

		const page = await this.browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		try {
			await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
		} catch {
			// continue with whatever rendered
		}

		await this.dismissCookieBanner(page);
		await this.startGateIfNeeded(page);

		const maxSteps = 12;
		for (let i = 0; i < maxSteps; i++) {
			const kind = await this.detectPaneKind(page);
			console.log(`Droploud pane: ${kind}`);

			if (kind === 'unlocked') {
				break;
			}
			if (kind === 'email') {
				this.emitProgress(
					'handling_gates',
					'Submitting Droploud email step...',
					30 + i * 5,
					{ currentGate: 'email' },
				);
				await this.handleEmailStep(page);
				continue;
			}
			if (kind === 'droploud_follow') {
				this.emitProgress(
					'handling_gates',
					'Skipping Droploud follow step...',
					32 + i * 5,
					{ currentGate: 'social' },
				);
				await this.handleDroploudFollowStep(page);
				continue;
			}
			if (kind === 'disclaimer') {
				this.emitProgress(
					'handling_gates',
					'Confirming Droploud disclaimer...',
					33 + i * 5,
					{ currentGate: 'social' },
				);
				await this.handleDisclaimerStep(page);
				continue;
			}
			if (kind === 'soundcloud_connect') {
				this.emitProgress(
					'handling_gates',
					'Connecting SoundCloud on Droploud...',
					40 + i * 5,
					{ currentGate: 'sc' },
				);
				await this.handleSoundcloudConnect(page);
				continue;
			}
			if (kind === 'social_open') {
				this.emitProgress(
					'handling_gates',
					'Handling Droploud social step...',
					35 + i * 5,
					{ currentGate: 'social' },
				);
				await this.handleSocialOpenStep(page);
				continue;
			}

			const title = await page.evaluate((selector) => {
				return document.querySelector(selector)?.textContent?.trim() || '';
			}, Selectors.DROPLOUD_UNLOCKED_TITLE);
			throw new Error(
				`Unsupported Droploud gate step${title ? `: ${title}` : ''}. Please create an issue if this keeps happening.`,
			);
		}

		const unlocked = await this.detectPaneKind(page);
		if (unlocked !== 'unlocked') {
			throw new Error('Droploud gate did not unlock after completing steps');
		}

		await this.handleDownload(page);
		await page.close();
		return this.downloadFilename;
	}

	async close() {
		await this.browser?.close();
	}

	private async dismissCookieBanner(page: Page) {
		const accepted = await page.evaluate(() => {
			const buttons = Array.from(document.querySelectorAll('button'));
			const accept = buttons.find((btn) =>
				/accept all/i.test(btn.textContent || ''),
			);
			if (!accept) return false;
			accept.click();
			return true;
		});
		if (accepted) {
			await timeout(500);
		}
	}

	private async startGateIfNeeded(page: Page) {
		const stepPane = await page.$(Selectors.DROPLOUD_STEP_PANE);
		if (stepPane) return;

		const started = await page.evaluate((selector) => {
			const buttons = Array.from(
				document.querySelectorAll<HTMLButtonElement>(selector),
			);
			const freeDownload = buttons.find((btn) =>
				/free download/i.test(btn.textContent || ''),
			);
			if (!freeDownload || freeDownload.disabled) return false;
			freeDownload.click();
			return true;
		}, Selectors.DROPLOUD_FREE_DOWNLOAD_BUTTON);

		if (started) {
			await page.waitForSelector(Selectors.DROPLOUD_STEP_PANE, {
				timeout: 15_000,
			});
		}
	}

	private async detectPaneKind(page: Page): Promise<PaneKind> {
		return page.evaluate(
			(selectors) => {
				const title =
					document.querySelector(selectors.title)?.textContent || '';
				if (/drop unlocked/i.test(title)) {
					return 'unlocked';
				}

				const downloadButtons = Array.from(
					document.querySelectorAll<HTMLButtonElement>(selectors.downloadBtn),
				);
				const hasDownload = downloadButtons.some((btn) =>
					/^(\s*)download(\s*)$/i.test((btn.textContent || '').trim()),
				);
				if (hasDownload || /your download is ready/i.test(title)) {
					return 'unlocked';
				}

				if (document.querySelector(selectors.emailWrap)) {
					return 'email';
				}

				if (document.querySelector(selectors.dlFollowWrap)) {
					return 'droploud_follow';
				}

				const connectBtn = Array.from(
					document.querySelectorAll<HTMLButtonElement>('button'),
				).find((btn) => /connect soundcloud/i.test(btn.textContent || ''));
				if (connectBtn || document.querySelector(selectors.commentInput)) {
					return 'soundcloud_connect';
				}

				if (document.querySelector(selectors.openLinks)) {
					return 'social_open';
				}

				const confirmBtn = Array.from(
					document.querySelectorAll<HTMLButtonElement>('button'),
				).find((btn) => /^i confirm/i.test((btn.textContent || '').trim()));
				if (confirmBtn && document.querySelector(selectors.disclaimerCheck)) {
					return 'disclaimer';
				}

				return 'unknown';
			},
			{
				title: Selectors.DROPLOUD_UNLOCKED_TITLE,
				downloadBtn: Selectors.DROPLOUD_DOWNLOAD_BUTTON,
				commentInput: Selectors.DROPLOUD_SC_COMMENT_INPUT,
				openLinks: Selectors.DROPLOUD_OPEN_LINK_BUTTONS,
				emailWrap: Selectors.DROPLOUD_EMAIL_WRAP,
				dlFollowWrap: Selectors.DROPLOUD_DLFOLLOW_WRAP,
				disclaimerCheck: Selectors.DROPLOUD_DISCLAIMER_CHECK,
			},
		);
	}

	private async handleEmailStep(page: Page) {
		const email = this.config.email?.trim();
		if (!email) {
			throw new Error(
				'This Droploud gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
			);
		}

		await page.waitForSelector(Selectors.DROPLOUD_EMAIL_INPUT, {
			timeout: 10_000,
		});

		// Instant fill — React-controlled input needs the native value setter.
		await page.evaluate(
			(selector, value) => {
				const el = document.querySelector<HTMLInputElement>(selector);
				if (!el) return;
				const setter = Object.getOwnPropertyDescriptor(
					window.HTMLInputElement.prototype,
					'value',
				)?.set;
				setter?.call(el, value);
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			},
			Selectors.DROPLOUD_EMAIL_INPUT,
			email,
		);

		await page.evaluate((selector) => {
			const checkbox = document.querySelector<HTMLInputElement>(selector);
			if (checkbox && !checkbox.checked) {
				checkbox.click();
			}
		}, Selectors.DROPLOUD_EMAIL_CONSENT);

		await page.waitForFunction(
			() => {
				const btn = Array.from(document.querySelectorAll('button')).find((el) =>
					/continue/i.test((el.textContent || '').trim()),
				) as HTMLButtonElement | undefined;
				return !!btn && !btn.disabled;
			},
			{ timeout: 10_000 },
		);

		const beforeTitle = await page.evaluate((selector) => {
			return document.querySelector(selector)?.textContent?.trim() || '';
		}, Selectors.DROPLOUD_UNLOCKED_TITLE);

		await page.evaluate(() => {
			const btn = Array.from(document.querySelectorAll('button')).find((el) =>
				/continue/i.test((el.textContent || '').trim()),
			) as HTMLButtonElement | undefined;
			btn?.click();
		});

		await page.waitForFunction(
			(selector, previous) => {
				const title =
					document.querySelector(selector)?.textContent?.trim() || '';
				return title !== previous || !document.querySelector('.dtr-email-wrap');
			},
			{ timeout: 20_000 },
			Selectors.DROPLOUD_UNLOCKED_TITLE,
			beforeTitle,
		);
		await timeout(400);
	}

	private async handleDroploudFollowStep(page: Page) {
		await page.waitForSelector(Selectors.DROPLOUD_DLFOLLOW_WRAP, {
			timeout: 10_000,
		});

		const beforeTitle = await page.evaluate((selector) => {
			return document.querySelector(selector)?.textContent?.trim() || '';
		}, Selectors.DROPLOUD_UNLOCKED_TITLE);

		const skipped = await page.evaluate((selector) => {
			const skip = document.querySelector<HTMLButtonElement>(selector);
			if (skip && !skip.disabled) {
				skip.click();
				return true;
			}
			const fallback = Array.from(document.querySelectorAll('button')).find(
				(btn) =>
					/skip|i.?m done|continue/i.test((btn.textContent || '').trim()) &&
					!(btn as HTMLButtonElement).disabled,
			) as HTMLButtonElement | undefined;
			fallback?.click();
			return !!fallback;
		}, Selectors.DROPLOUD_DLFOLLOW_SKIP);

		if (!skipped) {
			throw new Error('Droploud follow skip/continue button not found.');
		}

		await page.waitForFunction(
			(selector, previous) => {
				const title =
					document.querySelector(selector)?.textContent?.trim() || '';
				return (
					title !== previous || !document.querySelector('.dtr-dlfollow-wrap')
				);
			},
			{ timeout: 20_000 },
			Selectors.DROPLOUD_UNLOCKED_TITLE,
			beforeTitle,
		);
		await timeout(400);
	}

	private async handleDisclaimerStep(page: Page) {
		await page.evaluate((selector) => {
			const checkbox = document.querySelector<HTMLInputElement>(selector);
			if (checkbox && !checkbox.checked) {
				checkbox.click();
			}
		}, Selectors.DROPLOUD_DISCLAIMER_CHECK);

		await page.waitForFunction(
			() => {
				const btn = Array.from(document.querySelectorAll('button')).find((el) =>
					/^i confirm/i.test((el.textContent || '').trim()),
				) as HTMLButtonElement | undefined;
				return !!btn && !btn.disabled;
			},
			{ timeout: 10_000 },
		);

		const beforeTitle = await page.evaluate((selector) => {
			return document.querySelector(selector)?.textContent?.trim() || '';
		}, Selectors.DROPLOUD_UNLOCKED_TITLE);

		await page.evaluate(() => {
			const btn = Array.from(document.querySelectorAll('button')).find((el) =>
				/^i confirm/i.test((el.textContent || '').trim()),
			) as HTMLButtonElement | undefined;
			btn?.click();
		});

		await page.waitForFunction(
			(selector, previous) => {
				const title =
					document.querySelector(selector)?.textContent?.trim() || '';
				return title !== previous;
			},
			{ timeout: 20_000 },
			Selectors.DROPLOUD_UNLOCKED_TITLE,
			beforeTitle,
		);
		await timeout(400);
	}

	private async handleSocialOpenStep(page: Page) {
		await page.waitForSelector(Selectors.DROPLOUD_OPEN_LINK_BUTTONS, {
			timeout: 15_000,
		});

		const stepTitle = await page.evaluate((selector) => {
			return document.querySelector(selector)?.textContent?.trim() || '';
		}, Selectors.DROPLOUD_UNLOCKED_TITLE);
		const isManualRepost =
			/repost/i.test(stepTitle) ||
			(await page.evaluate((selector) => {
				const btn = document.querySelector(selector);
				return /reposted,\s*verify/i.test(btn?.textContent || '');
			}, Selectors.DROPLOUD_CONFIRM_BUTTON));

		console.log(`Droploud social open: ${stepTitle || 'untitled step'}`);

		for (let attempt = 0; attempt < 10; attempt++) {
			const nextButtonIndex = await page.evaluate((selector) => {
				const buttons = Array.from(
					document.querySelectorAll<HTMLButtonElement>(selector),
				);
				return buttons.findIndex(
					(btn) => !/^\s*✓/.test((btn.textContent || '').trim()),
				);
			}, Selectors.DROPLOUD_OPEN_LINK_BUTTONS);

			if (nextButtonIndex < 0) {
				break;
			}

			const pagesBefore = new Set(await this.browser.pages(true));
			const handles = await page.$$(Selectors.DROPLOUD_OPEN_LINK_BUTTONS);
			const handle = handles[nextButtonIndex];
			if (!handle) {
				for (const h of handles) await h.dispose();
				throw new Error('Droploud open-link button disappeared mid-step.');
			}

			// Trusted click — needed so React marks the link opened (enables "I did it").
			await handle.click({ delay: 40 });
			for (const h of handles) await h.dispose();

			let popup: Page | undefined;
			const started = Date.now();
			while (!popup && Date.now() - started < 8_000) {
				const pages = await this.browser.pages(true);
				popup = pages.find(
					(candidate) =>
						candidate !== page &&
						!pagesBefore.has(candidate) &&
						candidate.url() !== 'about:blank',
				);
				if (!popup) {
					popup = pages.find(
						(candidate) =>
							candidate !== page &&
							!candidate.url().includes('droploud.com') &&
							candidate.url() !== 'about:blank',
					);
				}
				if (!popup) await timeout(200);
			}

			if (popup && !popup.isClosed()) {
				try {
					// Honor-system social (IG/Spotify/etc.): open is enough.
					// SoundCloud manual repost gates actually verify the repost.
					if (isManualRepost || /soundcloud\.com/i.test(popup.url())) {
						await this.performSoundcloudManualActions(popup, {
							repost: isManualRepost || /repost/i.test(stepTitle),
						});
					} else {
						// Give Spotify/etc. a moment to load before closing.
						await timeout(1_200);
					}
				} finally {
					if (!popup.isClosed()) {
						try {
							await popup.close();
						} catch {
							// already closed
						}
					}
				}
			}

			// Wait until this button shows the ✓ opened marker.
			try {
				await page.waitForFunction(
					(selector, index) => {
						const buttons = Array.from(
							document.querySelectorAll<HTMLButtonElement>(selector),
						);
						const btn = buttons[index];
						return !!btn && /^\s*✓/.test((btn.textContent || '').trim());
					},
					{ timeout: 8_000 },
					Selectors.DROPLOUD_OPEN_LINK_BUTTONS,
					nextButtonIndex,
				);
			} catch {
				console.warn(
					`Droploud: open-link #${nextButtonIndex + 1} did not show ✓; retrying.`,
				);
			}

			await timeout(300);
		}

		const stillPending = await page.evaluate((selector) => {
			return Array.from(
				document.querySelectorAll<HTMLButtonElement>(selector),
			).some((btn) => !/^\s*✓/.test((btn.textContent || '').trim()));
		}, Selectors.DROPLOUD_OPEN_LINK_BUTTONS);
		if (stillPending) {
			throw new Error(
				`Droploud social step still has unopened links (${stepTitle || 'unknown'}). Popups may be blocked.`,
			);
		}

		const confirm = await page.waitForSelector(
			Selectors.DROPLOUD_CONFIRM_BUTTON,
			{ timeout: 10_000 },
		);
		if (!confirm) {
			throw new Error('Droploud confirm button not found');
		}

		await page.waitForFunction(
			(selector) => {
				const btn = document.querySelector<HTMLButtonElement>(selector);
				return !!btn && !btn.disabled;
			},
			{ timeout: 15_000 },
			Selectors.DROPLOUD_CONFIRM_BUTTON,
		);

		const titleBeforeConfirm = await page.evaluate((selector) => {
			return document.querySelector(selector)?.textContent?.trim() || '';
		}, Selectors.DROPLOUD_UNLOCKED_TITLE);

		let verifyFound: boolean | null = null;
		const onVerify = async (res: {
			url: () => string;
			ok: () => boolean;
			text: () => Promise<string>;
		}) => {
			if (!res.url().includes('/api/soundcloud/verify-repost')) return;
			try {
				const body = JSON.parse(await res.text()) as { found?: boolean };
				verifyFound = body.found === true;
			} catch {
				// ignore parse errors
			}
		};
		page.on('response', onVerify);

		await page.click(Selectors.DROPLOUD_CONFIRM_BUTTON);

		// Next gate step can also be social-open (e.g. TikTok → Spotify), so do NOT
		// wait for `.dtr-open-grid` to vanish — wait for the step title to change.
		try {
			await page.waitForFunction(
				(selectors, previousTitle) => {
					const title =
						document.querySelector(selectors.title)?.textContent?.trim() || '';
					if (/drop unlocked|download is ready/i.test(title)) return true;
					if (title && title !== previousTitle) return true;

					const confirmBtn = document.querySelector<HTMLButtonElement>(
						selectors.confirm,
					);
					if (
						confirmBtn &&
						/confirming|verifying/i.test(confirmBtn.textContent || '')
					) {
						return false;
					}
					return false;
				},
				{ timeout: 45_000 },
				{
					title: Selectors.DROPLOUD_UNLOCKED_TITLE,
					confirm: Selectors.DROPLOUD_CONFIRM_BUTTON,
				},
				titleBeforeConfirm,
			);
		} catch {
			page.off('response', onVerify);
			if (verifyFound === false) {
				throw new Error(
					'Droploud could not verify the SoundCloud repost. Make sure the SoundCloud account is logged in (Initialize Logins) and try again.',
				);
			}
			throw new Error(
				`Droploud social step did not advance after confirm (${titleBeforeConfirm || 'unknown'}). Try again or run non-headless.`,
			);
		}
		page.off('response', onVerify);
		await timeout(500);
	}

	/**
	 * Manual Droploud repost step: open the track in a full-size tab (Droploud's
	 * window.open popup often never mounts `.soundActions`), then click Repost.
	 */
	private async performSoundcloudManualActions(
		popup: Page,
		actions: { repost: boolean },
	) {
		if (!actions.repost) return;

		const deadline = Date.now() + 25_000;
		while (Date.now() < deadline) {
			const live = await this.resolveSoundcloudPage(popup);
			if (!live) {
				await timeout(200);
				continue;
			}
			popup = live;
			const url = live.url();
			if (
				url.includes('soundcloud.com') &&
				url !== 'about:blank' &&
				!url.includes('/web-auth') &&
				!url.includes('captcha-delivery.com')
			) {
				break;
			}
			await timeout(200);
		}

		let page = popup;
		let trackUrl = '';
		try {
			trackUrl = page.url();
		} catch {
			const live = await this.resolveSoundcloudPage(page);
			if (live && !live.isClosed()) {
				page = live;
				trackUrl = live.url();
			}
		}
		if (!trackUrl.includes('soundcloud.com')) {
			throw new Error('SoundCloud popup never navigated to a track URL.');
		}

		// Stay on Droploud's SoundCloud window — do not open a second tab or strip
		// login cookies (that logged the session out).
		try {
			await page.setViewport({ width: 1440, height: 900 });
		} catch {
			// popup may not allow resize; continue anyway
		}
		await page.bringToFront().catch(() => {});
		console.log(`Droploud: SoundCloud Repost on existing tab (${trackUrl})…`);

		const soundcloud = new SoundcloudClient();
		const alreadyReposted = async (target: Page) => {
			if (!target.isClosed()) {
				if (await this.pageLooksReposted(target).catch(() => false)) {
					return 'ui' as const;
				}
			}
			try {
				if (await soundcloud.isTrackReposted(trackUrl)) return 'api' as const;
			} catch {
				// logged inside isTrackReposted
			}
			return null;
		};

		const already = await alreadyReposted(page);
		if (already) {
			console.log(`Droploud: SoundCloud track already reposted (${already}).`);
			return;
		}

		const loggedIn = await page
			.evaluate(
				() =>
					!!document.querySelector('a[href="/you/library"]') &&
					!(document.body?.innerText || '').includes(
						'Sign in or create an account',
					),
			)
			.catch(() => false);
		if (!loggedIn) {
			console.warn(
				'Droploud: SoundCloud tab does not look logged in — GraphQL/UI repost will likely fail. Re-run Initialize Logins.',
			);
		}

		// Prefer webi GraphQL (same mutation the real Repost button fires).
		if (await this.repostViaPageFetch(page, trackUrl)) {
			console.log('Droploud: SoundCloud repost ensured via GraphQL.');
			await timeout(500);
			return;
		}

		const uiError = await this.repostTrackInBrowser(page)
			.then(() => null)
			.catch((error: unknown) => error);

		if (!uiError) {
			const confirmed = await alreadyReposted(page);
			if (confirmed) {
				console.log(
					`Droploud: SoundCloud repost ensured via browser UI (${confirmed}).`,
				);
				await timeout(500);
				return;
			}
			console.warn(
				'Droploud: browser Repost click finished but repost not confirmed; trying API…',
			);
		}

		const uiMessage =
			uiError instanceof Error
				? uiError.message
				: uiError
					? String(uiError)
					: 'repost not confirmed after UI click';
		const closed = /track tab closed|Target closed|Session closed/i.test(
			uiMessage,
		);
		console.warn(
			`Droploud: browser Repost UI failed (${uiMessage.slice(0, 160)}); trying API GraphQL…`,
		);

		try {
			await soundcloud.repostTrack(trackUrl);
			console.log('Droploud: SoundCloud repost ensured via API GraphQL.');
			return;
		} catch (apiError) {
			console.warn(
				`Droploud: API GraphQL/PUT repost failed (${apiError instanceof Error ? apiError.message.slice(0, 160) : String(apiError)})`,
			);
		}

		const after = await alreadyReposted(page);
		if (after) {
			console.log(
				`Droploud: SoundCloud repost confirmed after attempts (${after}).`,
			);
			return;
		}

		if (!this.config.headless && !closed && !page.isClosed()) {
			console.log(
				'Droploud: waiting up to 2 minutes for manual Repost / captcha solve…',
			);
			const manualDeadline = Date.now() + 120_000;
			while (Date.now() < manualDeadline) {
				if (page.isClosed()) break;
				await this.handlePossibleCaptcha(page).catch(() => false);
				if (await this.repostViaPageFetch(page, trackUrl)) {
					console.log(
						'Droploud: SoundCloud repost ensured via GraphQL during manual wait.',
					);
					return;
				}
				const status = await alreadyReposted(page);
				if (status) {
					console.log(
						`Droploud: SoundCloud repost confirmed after manual UI (${status}).`,
					);
					return;
				}
				await this.tryClickRepostButton(page).catch(() => null);
				await timeout(1_000);
			}
		}

		if (closed) {
			console.warn(
				'Droploud: SoundCloud tab closed during repost; continuing so Droploud can verify.',
			);
			return;
		}

		const finalCheck = await alreadyReposted(page);
		if (finalCheck) {
			console.log(`Droploud: SoundCloud repost confirmed (${finalCheck}).`);
			return;
		}

		throw new Error(
			`SoundCloud repost failed (${uiMessage.slice(0, 180)}). Stay logged in on SoundCloud (Initialize Logins), complete Repost + captcha if shown, then retry.`,
		);
	}

	/** Prefer a live SoundCloud (or DataDome) tab — popups can swap/navigate. */
	private async resolveSoundcloudPage(
		preferred?: Page,
	): Promise<Page | undefined> {
		if (preferred && !preferred.isClosed()) {
			try {
				const url = preferred.url();
				if (
					url.includes('soundcloud.com') ||
					url.includes('captcha-delivery.com')
				) {
					return preferred;
				}
			} catch {
				// fall through
			}
		}
		return this.findSoundcloudTrackPage();
	}

	private async findSoundcloudTrackPage(): Promise<Page | undefined> {
		const pages = (await this.browser.pages(true)).filter((p) => !p.isClosed());
		const scored: { page: Page; score: number }[] = [];
		for (const candidate of pages) {
			try {
				const url = candidate.url();
				if (url === 'about:blank') continue;
				if (url.includes('captcha-delivery.com')) {
					scored.push({ page: candidate, score: 1 });
				} else if (
					url.includes('soundcloud.com') &&
					!url.includes('/web-auth')
				) {
					const trackLike = /soundcloud\.com\/[^/]+\/[^/?#]+/.test(url);
					scored.push({ page: candidate, score: trackLike ? 3 : 2 });
				}
			} catch {
				// ignore
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored[0]?.page;
	}

	private async pageLooksReposted(page: Page): Promise<boolean> {
		if (page.isClosed()) return false;
		return page.evaluate(() => {
			const classic = document.querySelector('button.sc-button-repost');
			if (
				classic?.classList.contains('sc-button-selected') ||
				classic?.getAttribute('aria-pressed') === 'true'
			) {
				return true;
			}
			return Array.from(
				document.querySelectorAll('button, [role="button"]'),
			).some((btn) => {
				const label =
					`${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''} ${btn.getAttribute('title') || ''} ${(btn as HTMLElement).title || ''}`.toLowerCase();
				if (
					/unrepost|unpost|delete\s*repost|reposted|edit\s*repost/i.test(label)
				)
					return true;
				if (
					/repost/i.test(label) &&
					(btn.classList.contains('sc-button-selected') ||
						btn.getAttribute('aria-pressed') === 'true')
				) {
					return true;
				}
				return false;
			});
		});
	}

	/** Click the track Repost control if present. Returns status. */
	private async tryClickRepostButton(
		page: Page,
	): Promise<'clicked' | 'already' | 'missing'> {
		if (page.isClosed()) return 'missing';

		const classicHandle = await page.$(Selectors.SOUNDCLOUD_REPOST_BUTTON);
		if (classicHandle) {
			const already = await classicHandle.evaluate(
				(btn) =>
					btn.classList.contains('sc-button-selected') ||
					btn.getAttribute('aria-pressed') === 'true',
			);
			if (already) {
				await classicHandle.dispose();
				return 'already';
			}
			await classicHandle.evaluate((el) =>
				el.scrollIntoView({ block: 'center', inline: 'center' }),
			);
			await classicHandle.click({ delay: 40 });
			await classicHandle.dispose();

			await timeout(600);
			// Caption overlay after a successful webi/classic repost
			const overlayClosed = await page.evaluate(() => {
				const close = document.querySelector(
					'.repostOverlay__closeButton',
				) as HTMLElement | null;
				if (close) {
					close.click();
					return true;
				}
				return false;
			});
			if (overlayClosed) return 'clicked';

			await page.evaluate(() => {
				for (const el of Array.from(
					document.querySelectorAll(
						'button, [role="menuitem"], a, .sc-button-dropdown, .repostDialog button',
					),
				)) {
					const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
					if (
						/^repost( to (your )?profile)?$/i.test(text) ||
						/^repost track$/i.test(text) ||
						/^reposten$/i.test(text) ||
						/repost(en)?\s+(auf|to)\s+(dein|your|mein)/i.test(text) ||
						/^republier$/i.test(text)
					) {
						(el as HTMLElement).click();
						return;
					}
				}
			});
			return 'clicked';
		}

		return page.evaluate(() => {
			const isAlready = (btn: Element) => {
				const label =
					`${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''} ${btn.getAttribute('title') || ''} ${(btn as HTMLElement).title || ''}`.toLowerCase();
				return (
					btn.classList.contains('sc-button-selected') ||
					/unrepost|unpost|reposted|delete\s*repost|edit\s*repost|rückgängig|entfernen/i.test(
						label,
					) ||
					btn.getAttribute('aria-pressed') === 'true'
				);
			};

			const mui = document.querySelector<HTMLElement>(
				'button[aria-label="Repost"], button[title="Repost"], [title="Repost"] > button',
			);
			if (mui) {
				if (isAlready(mui)) return 'already' as const;
				mui.scrollIntoView({ block: 'center', inline: 'center' });
				mui.click();
				return 'clicked' as const;
			}

			for (const btn of Array.from(
				document.querySelectorAll('button, [role="button"]'),
			)) {
				const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
				const aria = (btn.getAttribute('aria-label') || '').trim();
				const title = (
					btn.getAttribute('title') ||
					(btn as HTMLElement).title ||
					''
				).trim();
				const parentTitle = (
					btn.parentElement?.getAttribute('title') || ''
				).trim();
				const cls =
					typeof (btn as HTMLElement).className === 'string'
						? (btn as HTMLElement).className
						: '';
				const parts = [aria, text, title, parentTitle].filter(Boolean);
				const label = parts.join(' ');
				const looksRepost =
					cls.includes('sc-button-repost') ||
					parts.some((p) =>
						/^(repost|reposted|reposts|reposting|republier|reposten|erneut\s*posten)$/i.test(
							p,
						),
					) ||
					/^(repost|reposten|republier)\b/i.test(label);
				if (!looksRepost) continue;
				if (isAlready(btn)) return 'already' as const;
				btn.scrollIntoView({ block: 'center', inline: 'center' });
				(btn as HTMLElement).click();
				return 'clicked' as const;
			}
			return 'missing' as const;
		});
	}

	/**
	 * Drag DataDome slider when visible. After solve, reload — SPA often stays
	 * without `.soundActions` until a fresh navigation.
	 * @returns true if a captcha was present and cleared
	 */
	private async handlePossibleCaptcha(page: Page): Promise<boolean> {
		const visible = await page
			.evaluate((sel) => {
				const el = document.querySelector(sel) as HTMLElement | null;
				if (!el) return false;
				if (el.getClientRects().length === 0) return false;
				const style = window.getComputedStyle(el);
				if (style.display === 'none' || style.visibility === 'hidden') {
					return false;
				}
				const rect = el.getBoundingClientRect();
				return rect.width > 1 && rect.height > 1;
			}, Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER)
			.catch(() => false);
		if (!visible) return false;

		const captchaIframe = await page.$(Selectors.SOUNDCLOUD_CAPTCHA_IFRAME);
		if (!captchaIframe) {
			console.log(
				'Droploud: SoundCloud captcha visible; waiting for solve (no iframe yet)…',
			);
			await page
				.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
					hidden: true,
					timeout: 120_000,
				})
				.catch(() => {});
		} else {
			console.log('Droploud: attempting DataDome slider solve…');
			await timeout(1_500);
			const frame = await captchaIframe.contentFrame();
			if (!frame) {
				await captchaIframe.dispose();
				return false;
			}

			try {
				await frame.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_SLIDER, {
					timeout: 20_000,
				});
			} catch {
				await captchaIframe.dispose();
				console.log(
					'Droploud: captcha slider not ready; waiting for manual solve…',
				);
				await page
					.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
						hidden: true,
						timeout: 120_000,
					})
					.catch(() => {});
				await this.reloadTrackAfterCaptcha(page);
				return true;
			}

			const slider = await frame.$(Selectors.SOUNDCLOUD_CAPTCHA_SLIDER);
			const sliderTrack = await frame.$(Selectors.SOUNDCLOUD_CAPTCHA_TRACK);
			const iframeBox = await captchaIframe.boundingBox();
			const sliderBox = slider ? await slider.boundingBox() : null;
			const trackBox = sliderTrack ? await sliderTrack.boundingBox() : null;
			await slider?.dispose();
			await sliderTrack?.dispose();
			await captchaIframe.dispose();

			if (iframeBox && sliderBox && trackBox) {
				const startX = iframeBox.x + sliderBox.x + sliderBox.width / 2;
				const startY = iframeBox.y + sliderBox.y + sliderBox.height / 2;
				const endX =
					iframeBox.x + trackBox.x + trackBox.width - sliderBox.width / 2;

				await page.mouse.move(startX, startY);
				await page.mouse.down();
				await page.mouse.move(endX, startY, { steps: 25 });
				await timeout(400);
				await page.mouse.up();
				console.log('Droploud: DataDome slider drag performed');
			}

			await page
				.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
					hidden: true,
					timeout: 60_000,
				})
				.catch(() => {
					console.warn(
						'Droploud: captcha still visible after slider drag — solve it manually if needed.',
					);
				});
		}

		await this.reloadTrackAfterCaptcha(page);
		return true;
	}

	private async reloadTrackAfterCaptcha(page: Page) {
		if (page.isClosed()) return;
		const url = page.url();
		if (!url.includes('soundcloud.com')) return;
		console.log(
			'Droploud: captcha cleared — reloading track so engagement UI can mount…',
		);
		await page
			.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
			.catch(() => page.reload({ waitUntil: 'domcontentloaded' }));
		await timeout(1_500);
		await this.dismissSoundcloudConsent(page);
		await page
			.waitForSelector(
				`${Selectors.SOUNDCLOUD_REPOST_BUTTON}, ${Selectors.SOUNDCLOUD_SOUND_ACTIONS}`,
				{ timeout: 25_000 },
			)
			.catch(() => {});
	}

	private isTransientPageError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return /detached Frame|Execution context was destroyed|Target closed|Session closed|frame was detached|Navigating frame was detached/i.test(
			message,
		);
	}

	/** Dismiss OneTrust preference center / banner so the engagement bar can mount. */
	private async dismissSoundcloudConsent(page: Page) {
		const clicked = await page
			.evaluate(
				(sels) => {
					const pc = document.querySelector(sels.pc);
					const banner = document.querySelector(sels.banner);
					const pcOpen =
						!!pc &&
						!pc.classList.contains('ot-hide') &&
						window.getComputedStyle(pc).display !== 'none';
					const bannerOpen =
						!!banner &&
						!banner.classList.contains('ot-hide') &&
						window.getComputedStyle(banner).display !== 'none' &&
						(banner as HTMLElement).getBoundingClientRect().height > 1;

					// Preference center open: force-click Allow All even if OT reports 0×0.
					if (pcOpen) {
						const allow = document.querySelector(
							'#accept-recommended-btn-handler',
						) as HTMLElement | null;
						if (allow) {
							allow.click();
							return 'ot-pc-allow-all';
						}
						const confirm = document.querySelector(
							'button.save-preference-btn-handler',
						) as HTMLElement | null;
						if (confirm) {
							confirm.click();
							return 'ot-pc-confirm';
						}
						const close = document.querySelector(
							'#close-pc-btn-handler',
						) as HTMLElement | null;
						if (close) {
							close.click();
							return 'ot-pc-close';
						}
					}

					if (bannerOpen) {
						const accept = document.querySelector(
							'#onetrust-accept-btn-handler',
						) as HTMLElement | null;
						if (accept) {
							accept.click();
							return 'ot-banner-accept';
						}
					}

					const isVisible = (el: Element | null): el is HTMLElement => {
						if (!el) return false;
						const html = el as HTMLElement;
						if (html.getClientRects().length === 0) return false;
						const style = window.getComputedStyle(html);
						if (style.display === 'none' || style.visibility === 'hidden') {
							return false;
						}
						if (Number.parseFloat(style.opacity || '1') === 0) return false;
						const rect = html.getBoundingClientRect();
						return rect.width > 1 && rect.height > 1;
					};

					for (const sel of sels.accept.split(',')) {
						const el = document.querySelector(sel.trim());
						if (isVisible(el)) {
							el.click();
							return 'known';
						}
					}

					const accept = Array.from(document.querySelectorAll('button')).find(
						(btn) =>
							isVisible(btn) &&
							/^(allow\s*all|accept\s*(all|cookies)?|alle\s*akzeptieren|zustimmen|alles\s*erlauben|confirm\s*my\s*choices|reject\s*all)$/i.test(
								(btn.textContent || '').replace(/\s+/g, ' ').trim(),
							),
					);
					if (accept) {
						accept.click();
						return 'text';
					}
					return null;
				},
				{
					accept: Selectors.SOUNDCLOUD_COOKIE_ACCEPT,
					pc: Selectors.SOUNDCLOUD_COOKIE_PC,
					banner: Selectors.SOUNDCLOUD_COOKIE_BANNER,
				},
			)
			.catch(() => null);

		if (clicked) {
			console.log(`Droploud: dismissed SoundCloud consent (${clicked})`);
			await page
				.waitForFunction(
					(pcSel) => {
						const pc = document.querySelector(pcSel);
						if (!pc) return true;
						return (
							pc.classList.contains('ot-hide') ||
							window.getComputedStyle(pc).display === 'none'
						);
					},
					{ timeout: 10_000 },
					Selectors.SOUNDCLOUD_COOKIE_PC,
				)
				.catch(() => {});
			await timeout(800);
		}
	}

	/** Ensure the track engagement bar exists; reload once if consent blocked it. */
	private async ensureSoundcloudEngagement(page: Page): Promise<Page> {
		try {
			await page.setViewport({ width: 1400, height: 900 });
		} catch {
			// ignore
		}

		await this.dismissSoundcloudConsent(page);

		const ready = await page
			.waitForSelector(
				`${Selectors.SOUNDCLOUD_REPOST_BUTTON}, ${Selectors.SOUNDCLOUD_REPOST_BUTTON_MUI}, ${Selectors.SOUNDCLOUD_SOUND_ACTIONS}`,
				{ timeout: 12_000 },
			)
			.then(() => true)
			.catch(() => false);
		if (ready) return page;

		const url = page.url();
		if (url.includes('soundcloud.com')) {
			console.log('Droploud: engagement bar missing — reloading track page…');
			await page.goto(url, {
				waitUntil: 'domcontentloaded',
				timeout: 30_000,
			});
			await timeout(1_000);
			await this.dismissSoundcloudConsent(page);
			await page
				.waitForSelector(
					`${Selectors.SOUNDCLOUD_REPOST_BUTTON}, ${Selectors.SOUNDCLOUD_REPOST_BUTTON_MUI}, ${Selectors.SOUNDCLOUD_SOUND_ACTIONS}`,
					{ timeout: 20_000 },
				)
				.catch(() => {});
		}
		return page;
	}

	/**
	 * In-page webi GraphQL repost (same mutation the MUI Repost button fires).
	 */
	private async repostViaPageFetch(
		page: Page,
		trackUrl?: string,
	): Promise<boolean> {
		let trackIdHint = '';
		let oauthHint = process.env.SC_OAUTH_TOKEN?.trim() || '';
		try {
			const cookies = await loadCookies('soundcloud-cookies.json');
			oauthHint =
				cookies.find((c) => c.name === 'oauth_token')?.value || oauthHint;
		} catch {
			// optional
		}
		if (trackUrl) {
			try {
				const track = await new SoundcloudClient().getTrack(trackUrl);
				trackIdHint = String(track.id);
			} catch {
				// page HTML may still have the urn
			}
		}

		const result = await page
			.evaluate(
				async (hints) => {
					const urnMatch =
						document.body.innerHTML.match(/soundcloud:tracks:(\d+)/) ||
						document.documentElement.innerHTML.match(/soundcloud:tracks:(\d+)/);
					const trackId = urnMatch?.[1] || hints.trackIdHint;
					if (!trackId) return { ok: false, reason: 'no-track-id' };

					const clientId = (
						document.cookie.match(/(?:^|;\s*)client_id=([^;]+)/)?.[1] ||
						document.body.innerHTML.match(
							/client_id["'=:\s]+([a-zA-Z0-9]{16,})/,
						)?.[1] ||
						'yNSW5UvBmb1A5j7qPUtIMuB9Itx3jsOC'
					).trim();

					const oauth =
						document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/)?.[1] ||
						hints.oauthHint ||
						'';
					const datadome =
						document.cookie.match(/(?:^|;\s*)datadome=([^;]+)/)?.[1] || '';

					if (!oauth) {
						return { ok: false, reason: 'no-oauth' };
					}

					const headers: Record<string, string> = {
						accept: '*/*',
						'content-type': 'application/json',
						origin: 'https://soundcloud.com',
						referer: location.href,
						'apollographql-client-name': 'webi',
						'apollographql-client-version': '0.1.0',
						'app-locale': 'en',
						Authorization: `OAuth ${oauth}`,
					};
					if (datadome) headers['x-datadome-clientid'] = datadome;

					const res = await fetch(
						`https://graph.soundcloud.com/graphql?client_id=${encodeURIComponent(clientId)}`,
						{
							method: 'POST',
							credentials: 'include',
							headers,
							body: JSON.stringify({
								query: `
    mutation RepostTrack($trackUrn: ID!) {
  repostTrack(trackRepost: {urn: $trackUrn}) {
    __typename
    ... on Repost {
      caption
    }
    ... on TrackRepostFailedError {
      errorMessage
    }
    ... on TrackRepostCaptionFailedError {
      errorMessage
    }
  }
}
    `,
								variables: { trackUrn: `soundcloud:tracks:${trackId}` },
							}),
						},
					);
					const body = await res.text();
					if (!res.ok) {
						return {
							ok: false,
							status: res.status,
							reason: `http-${res.status}`,
							body: body.slice(0, 160),
						};
					}
					try {
						const json = JSON.parse(body) as {
							data?: {
								repostTrack?: {
									__typename?: string;
									errorMessage?: string;
								};
							};
						};
						const typename = json.data?.repostTrack?.__typename || '';
						if (typename === 'Repost' || typename === 'TrackRepost') {
							return { ok: true, status: 200, reason: typename };
						}
						if (/FailedError$/i.test(typename)) {
							return {
								ok: false,
								status: 200,
								reason: json.data?.repostTrack?.errorMessage || typename,
							};
						}
						if (typename) return { ok: true, status: 200, reason: typename };
					} catch {
						// ignore
					}
					return {
						ok: false,
						status: res.status,
						reason: 'graphql-unexpected',
						body: body.slice(0, 160),
					};
				},
				{ trackIdHint, oauthHint },
			)
			.catch((error: unknown) => ({
				ok: false as const,
				reason:
					error instanceof Error
						? error.message.slice(0, 80)
						: 'evaluate-failed',
			}));

		if (result?.ok) {
			console.log(
				`Droploud: SoundCloud repost via GraphQL (${'reason' in result ? result.reason : 'ok'})`,
			);
			return true;
		}
		console.warn(
			`Droploud: in-page GraphQL repost failed (${'reason' in (result ?? {}) ? (result as { reason?: string }).reason : 'unknown'})`,
		);
		return false;
	}

	/**
	 * Click Repost on the dedicated full-size track tab.
	 */
	private async repostTrackInBrowser(page: Page) {
		const started = Date.now();
		let ensured = false;
		let fetchTried = false;

		while (Date.now() - started < 60_000) {
			if (page.isClosed()) {
				throw new Error('SoundCloud track tab closed during repost.');
			}

			try {
				await page.bringToFront().catch(() => {});

				if (!ensured) {
					page = await this.ensureSoundcloudEngagement(page);
					ensured = true;
				} else {
					const solved = await this.handlePossibleCaptcha(page);
					if (solved) {
						// reloadTrackAfterCaptcha already ran — try click immediately
						const afterCaptcha = await this.tryClickRepostButton(page);
						if (afterCaptcha === 'already') {
							console.log(
								'Droploud: SoundCloud already reposted after captcha',
							);
							return;
						}
						if (afterCaptcha === 'clicked') {
							await timeout(800);
							await this.handlePossibleCaptcha(page);
							if (await this.pageLooksReposted(page)) return;
							if (await this.repostViaPageFetch(page, page.url())) return;
						}
					}
					await this.dismissSoundcloudConsent(page);
				}

				if (await this.pageLooksReposted(page)) {
					console.log('Droploud: track already looks reposted in the browser.');
					return;
				}

				const action = await this.tryClickRepostButton(page);
				if (action === 'already') {
					console.log('Droploud: track already looks reposted in the browser.');
					return;
				}
				if (action === 'clicked') {
					console.log('Droploud: clicked SoundCloud Repost button');
					await timeout(800);
					const solved = await this.handlePossibleCaptcha(page);
					if (solved) {
						const again = await this.tryClickRepostButton(page);
						if (again === 'already') {
							console.log(
								'Droploud: SoundCloud already reposted after post-click captcha',
							);
							return;
						}
					}
					if (await this.pageLooksReposted(page)) return;
					if (await this.repostViaPageFetch(page, page.url())) return;
					console.warn(
						'Droploud: browser Repost click did not confirm repost; retrying…',
					);
					await timeout(500);
					continue;
				}

				// Still missing — try in-page GraphQL once, then keep waiting for UI.
				if (!fetchTried) {
					fetchTried = true;
					if (await this.repostViaPageFetch(page, page.url())) return;
				}
			} catch (error) {
				if (!this.isTransientPageError(error)) throw error;
				console.warn(
					`Droploud: transient page error during repost (${error instanceof Error ? error.message : String(error)}); retrying…`,
				);
				ensured = false;
				await timeout(500);
				continue;
			}

			await timeout(500);
		}

		const debug = await page
			.evaluate(() => ({
				url: location.href,
				w: window.innerWidth,
				h: window.innerHeight,
				hasClassic: !!document.querySelector('button.sc-button-repost'),
				hasSelected: !!document.querySelector(
					'button.sc-button-repost.sc-button-selected',
				),
				hasSoundActions: !!document.querySelector(
					'.soundActions, .listenEngagement__actions',
				),
				hasListen: !!document.querySelector(
					'.l-listen-wrapper, .fullHero, .listenEngagement',
				),
				otPcOpen: (() => {
					const pc = document.querySelector('#onetrust-pc-sdk');
					return (
						!!pc &&
						!pc.classList.contains('ot-hide') &&
						window.getComputedStyle(pc).display !== 'none'
					);
				})(),
			}))
			.catch(() => null);
		console.warn('Droploud: Repost button debug', debug);
		throw new Error(
			'SoundCloud Repost button not found. Is the account logged in (Initialize Logins)?',
		);
	}

	private async handleSoundcloudConnect(page: Page) {
		const commentInput = await page.$(Selectors.DROPLOUD_SC_COMMENT_INPUT);
		if (commentInput) {
			const comment = this.config.comment.trim();
			// Droploud keeps Connect disabled while comment.trim().length < 2
			if (comment.length < 2) {
				throw new Error(
					'Droploud requires SC_COMMENT to be at least 2 characters (your .env value is too short).',
				);
			}

			// React-controlled textarea: native setter + input event enables Connect.
			await page.focus(Selectors.DROPLOUD_SC_COMMENT_INPUT);
			await page.evaluate(
				(selector, value) => {
					const el = document.querySelector<HTMLTextAreaElement>(selector);
					if (!el) return;
					const setter = Object.getOwnPropertyDescriptor(
						window.HTMLTextAreaElement.prototype,
						'value',
					)?.set;
					setter?.call(el, value);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				},
				Selectors.DROPLOUD_SC_COMMENT_INPUT,
				comment,
			);
			await timeout(300);
		}

		try {
			await page.waitForFunction(
				() => {
					const btn = Array.from(document.querySelectorAll('button')).find(
						(el) => /connect soundcloud/i.test(el.textContent || ''),
					) as HTMLButtonElement | undefined;
					return !!btn && !btn.disabled;
				},
				{ timeout: 10_000 },
			);
		} catch {
			throw new Error(
				'Droploud Connect SoundCloud button stayed disabled. Set SC_COMMENT to at least 2 characters.',
			);
		}

		const pagesBefore = await this.browser.pages(true);

		await page.evaluate(() => {
			const btn = Array.from(document.querySelectorAll('button')).find((el) =>
				/connect soundcloud/i.test(el.textContent || ''),
			);
			(btn as HTMLButtonElement | undefined)?.click();
		});

		let oauthPage: Page | undefined;
		const started = Date.now();
		while (!oauthPage && Date.now() - started < 15_000) {
			const pages = await this.browser.pages(true);
			oauthPage = pages.find((candidate) => {
				if (candidate === page) return false;
				if (
					pagesBefore.includes(candidate) &&
					candidate.url() === 'about:blank'
				) {
					return false;
				}
				const url = candidate.url();
				return (
					url.includes('soundcloud.com') ||
					url.includes('api.droploud.com/api/soundcloud')
				);
			});
			if (!oauthPage) await timeout(200);
		}

		if (!oauthPage) {
			// Popup blocked → Droploud may have navigated this tab
			if (
				page.url().includes('soundcloud.com') ||
				page.url().includes('api.droploud.com/api/soundcloud')
			) {
				oauthPage = page;
			} else {
				throw new Error(
					'SoundCloud OAuth window not found. Try initializing logins or disabling headless mode.',
				);
			}
		}

		await this.completeSoundcloudOauth(oauthPage);

		// Wait for Droploud gate page to mark SC steps done / unlock
		if (oauthPage !== page && !oauthPage.isClosed()) {
			const closeStarted = Date.now();
			while (!oauthPage.isClosed() && Date.now() - closeStarted < 20_000) {
				await timeout(200);
			}
			if (!oauthPage.isClosed()) {
				try {
					await oauthPage.close();
				} catch {
					// ignore
				}
			}
		}

		// If we navigated the main page for OAuth, go back to the gate URL
		if (oauthPage === page || !page.url().includes('droploud.com')) {
			throw new Error(
				'Droploud redirected this tab for SoundCloud OAuth (popup blocked). Re-run with popups allowed or non-headless.',
			);
		}

		await page.waitForFunction(
			() => {
				const title =
					document.querySelector('.dtr-card-title')?.textContent || '';
				if (/drop unlocked/i.test(title)) return true;
				const downloadButtons = Array.from(
					document.querySelectorAll<HTMLButtonElement>(
						'.ds-free-dl.dtr-card-cta',
					),
				);
				if (
					downloadButtons.some((btn) =>
						/^(\s*)download(\s*)$/i.test((btn.textContent || '').trim()),
					)
				) {
					return true;
				}
				const connect = Array.from(document.querySelectorAll('button')).find(
					(btn) => /connect soundcloud/i.test(btn.textContent || ''),
				);
				const comment = document.querySelector('#dtr-sc-comment-input');
				// Advanced past the SoundCloud connect pane
				return !connect && !comment;
			},
			{ timeout: 90_000 },
		);
		await timeout(1_000);
	}

	private async completeSoundcloudOauth(oauthPage: Page) {
		await oauthPage.bringToFront();
		try {
			await oauthPage.setViewport({ width: 1920, height: 1080 });
		} catch {
			// popup may already be closing
		}

		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			if (oauthPage.isClosed()) {
				return;
			}

			const url = oauthPage.url();
			if (
				url.includes('api.droploud.com/api/soundcloud/callback') ||
				/connected/i.test(await oauthPage.title().catch(() => ''))
			) {
				// Connected page auto-closes; give it a moment
				await timeout(1_500);
				return;
			}

			if (url.includes('soundcloud.com')) {
				// Wait for the OAuth document to settle — early navigations can briefly
				// show marketing/login copy before the session cookies apply.
				const needsLogin = await oauthPage
					.evaluate(async () => {
						const loginRe = /sign in or create an account/i;
						if (!loginRe.test(document.body?.innerText || '')) return false;
						await new Promise((r) => setTimeout(r, 1_500));
						const text = document.body?.innerText || '';
						const hasApproval =
							!!document.querySelector('button#submit_approval') ||
							!!document.querySelector('button[name="accept"]') ||
							Array.from(document.querySelectorAll('button')).some((btn) =>
								/^(allow|accept|connect)$/i.test(
									(btn.textContent || '').trim(),
								),
							);
						return loginRe.test(text) && !hasApproval;
					})
					.catch(() => false);
				if (needsLogin) {
					throw new Error(
						'SoundCloud is not logged in. Run Initialize Logins (or CLI initializeLogins) first.',
					);
				}

				const clicked = await this.clickSoundcloudOauthAllow(oauthPage);
				if (clicked) {
					await timeout(1_000);
					continue;
				}
			}

			const approvalTab = await this.findPageWithApprovalButton(oauthPage);
			if (approvalTab) {
				const clicked = await this.clickSoundcloudOauthAllow(approvalTab);
				if (clicked) {
					await timeout(1_000);
					continue;
				}
			}

			await timeout(300);
		}

		throw new Error('Timed out waiting for SoundCloud OAuth to complete');
	}

	private async findPageWithApprovalButton(
		prefer?: Page,
	): Promise<Page | null> {
		const pages = await this.browser.pages(true);
		const ordered = prefer
			? [prefer, ...pages.filter((p) => p !== prefer)]
			: pages;
		for (const candidate of ordered) {
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

		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (submit) {
					await submit.click({ delay: 40 });
					console.log('Droploud: clicked SoundCloud OAuth submit_approval');
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
					console.log(`Droploud: clicked SoundCloud OAuth ${clicked}`);
					return true;
				}
			} catch {
				// frame detached / navigated
			}
		}

		return false;
	}

	private async handleDownload(page: Page) {
		this.emitProgress('downloading', 'Preparing Droploud download...', 75);

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
		const downloadTimer = setTimeout(
			() =>
				downloadCompleteReject(
					new Error('Droploud download did not complete in time'),
				),
			10 * 60_000,
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
				76,
			);
		});

		client.on('Browser.downloadProgress', (event) => {
			if (event.guid !== downloadGuid || !this.downloadFilename) return;
			if (event.state === 'completed') {
				pBar.stop();
				console.log('Download completed');
				this.emitProgress('downloading', 'Download complete', 85);
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
				const downloadPercent = totalBytes > 0 ? receivedBytes / totalBytes : 0;
				this.emitProgress(
					'downloading',
					`Downloading... ${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
					76 + downloadPercent * 8,
					{ downloadBytes: receivedBytes, totalBytes },
				);
			} else if (event.state === 'canceled') {
				pBar.stop();
				downloadCompleteReject(new Error('Download was canceled'));
			}
		});

		const clickDownload = async () => {
			const clicked = await page.evaluate((selector) => {
				const buttons = Array.from(
					document.querySelectorAll<HTMLButtonElement>(selector),
				);
				const download = buttons.find((btn) =>
					/^(\s*)download(\s*)$/i.test((btn.textContent || '').trim()),
				);
				if (!download || download.disabled) return false;
				download.click();
				return true;
			}, Selectors.DROPLOUD_DOWNLOAD_BUTTON);
			if (!clicked) {
				throw new Error('Droploud DOWNLOAD button not found');
			}
		};

		const retryTimer = setTimeout(async () => {
			if (!downloadGuid) {
				console.log(
					'Download not started after 10 seconds, clicking button again...',
				);
				try {
					await clickDownload();
				} catch {
					// ignore retry errors
				}
			}
		}, 10_000);

		try {
			await Promise.all([clickDownload(), downloadCompletePromise]);
		} finally {
			clearTimeout(downloadTimer);
			clearTimeout(retryTimer);
			pBar.stop();
			await client.detach().catch(() => {});
		}
	}
}
