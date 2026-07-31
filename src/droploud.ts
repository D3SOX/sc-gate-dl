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
			userDataDir: './browser-data',
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
	 * Manual Droploud repost step: open track URL, ensure a repost via API, then
	 * fall back to clicking Repost in the SoundCloud UI if engagement PUTs fail.
	 */
	private async performSoundcloudManualActions(
		popup: Page,
		actions: { repost: boolean },
	) {
		if (!actions.repost) return;

		const deadline = Date.now() + 25_000;
		while (Date.now() < deadline) {
			if (popup.isClosed()) return;
			const url = popup.url();
			if (
				url.includes('soundcloud.com') &&
				url !== 'about:blank' &&
				!url.includes('/web-auth')
			) {
				break;
			}
			await timeout(200);
		}

		const trackUrl = popup.url();
		if (!trackUrl.includes('soundcloud.com')) {
			throw new Error('SoundCloud popup never navigated to a track URL.');
		}

		try {
			const soundcloud = new SoundcloudClient();
			await soundcloud.repostTrack(trackUrl);
			console.log('Droploud: SoundCloud repost ensured via API.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`Droploud: API repost failed (${message.slice(0, 180)}); trying browser UI…`,
			);
			await this.repostTrackInBrowser(popup);
			console.log('Droploud: SoundCloud repost ensured via browser UI.');
		}
		await timeout(500);
	}

	/** Click SoundCloud's track-page Repost control (trusted UI path). */
	private async repostTrackInBrowser(page: Page) {
		try {
			await page.bringToFront();
		} catch {
			// ignore
		}

		const findRepostHandle = async () => {
			const handles = await page.$$('button');
			for (const handle of handles) {
				const meta = await handle.evaluate((btn) => {
					const text = (btn.textContent || '').trim();
					const aria = btn.getAttribute('aria-label') || '';
					const title = btn.title || '';
					const pressed = btn.getAttribute('aria-pressed');
					const label = `${aria} ${text} ${title}`;
					return {
						text,
						aria,
						pressed,
						isRepost:
							/^repost$/i.test(text) ||
							/^repost$/i.test(aria) ||
							(/^repost/i.test(label) && !/unrepost|reposted/i.test(label)),
						already:
							/unrepost|reposted/i.test(label) ||
							(pressed === 'true' && /repost/i.test(label)),
					};
				});
				if (meta.already) {
					await handle.dispose();
					return 'already' as const;
				}
				if (meta.isRepost) return handle;
				await handle.dispose();
			}
			return null;
		};

		const started = Date.now();
		let target: Awaited<ReturnType<typeof findRepostHandle>> = null;
		while (Date.now() - started < 20_000) {
			target = await findRepostHandle();
			if (target) break;
			await timeout(300);
		}

		if (target === 'already') {
			console.log('Droploud: track already looks reposted in the browser.');
			return;
		}
		if (!target) {
			throw new Error(
				'SoundCloud Repost button not found. Is the account logged in (Initialize Logins)?',
			);
		}

		await target.click({ delay: 40 });
		await target.dispose();

		// Some layouts open a menu; confirm "Repost to profile" / plain Repost.
		await timeout(600);
		const menuHandles = await page.$$('button, [role="menuitem"], a');
		for (const handle of menuHandles) {
			const text = await handle.evaluate((el) => (el.textContent || '').trim());
			if (
				/^repost( to (your )?profile)?$/i.test(text) ||
				/^repost track$/i.test(text)
			) {
				await handle.click({ delay: 40 });
				await handle.dispose();
				break;
			}
			await handle.dispose();
		}

		await page
			.waitForFunction(
				() => {
					const buttons = Array.from(document.querySelectorAll('button'));
					return buttons.some((btn) => {
						const label =
							`${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''} ${btn.title || ''}`.toLowerCase();
						return (
							/unrepost|reposted/i.test(label) ||
							(btn.getAttribute('aria-pressed') === 'true' &&
								/repost/i.test(label))
						);
					});
				},
				{ timeout: 15_000 },
			)
			.catch(() => {
				// Soft-ok: Droploud verify-repost API is the real check.
				console.warn(
					'Droploud: browser Repost click did not show a clear Reposted state; continuing for Droploud verify.',
				);
			});
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
				const needsLogin = await oauthPage
					.evaluate(() =>
						/sign in or create an account/i.test(
							document.body?.innerText || '',
						),
					)
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

		setTimeout(async () => {
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
			pBar.stop();
			await client.detach().catch(() => {});
		}
	}
}
