import { Presets, SingleBar } from 'cli-progress';
import type { Browser, CookieData, Frame, HTTPResponse, Page } from 'puppeteer';
import { CancellableBrowserLaunch } from './browserLaunch';
import {
	firefoxRepostAvailable,
	repostInFirefox,
	SoundcloudBlockedError,
} from './firefoxRepost';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import { hasSoundcloudLogin, SoundcloudClient } from './soundcloud';
import { signInToSoundcloud, waitForSoundcloudLogin } from './soundcloudLogin';
import type { HypedditConfig } from './types';
import { loadCookies, timeout } from './utils';

type PaneKind =
	| 'reveal'
	| 'email'
	| 'social_open'
	| 'soundcloud_connect'
	| 'soundcloud_repost'
	| 'soundcloud_wait'
	| 'droploud_follow'
	| 'disclaimer'
	| 'unlocked'
	| 'unknown';

export class DroploudDownloader {
	/** Set when the API fallback saved the repost the browser couldn't. */
	private repostSavedViaApi = false;
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;
	private cancelPendingDownloadWait: (() => void) | null = null;

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
	}

	/** `signInCookies`: a session from `soundcloudSessionFromFirefox`. */
	async prepareLogins(signInCookies?: CookieData[]) {
		await signInToSoundcloud(this.browser, { signInCookies });
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

		await this.waitForHydration(page);
		await this.dismissCookieBanner(page);

		const maxSteps = 16;
		let unlocked = false;
		for (let i = 0; i < maxSteps; i++) {
			const kind = await this.detectPaneKind(page);
			console.log(`Droploud pane: ${kind}`);
			const percent = Math.min(70, 30 + i * 4);

			if (kind === 'unlocked') {
				unlocked = true;
				break;
			}
			if (kind === 'reveal') {
				this.emitProgress(
					'handling_gates',
					'Opening Droploud gate...',
					percent,
				);
				await this.handleRevealStep(page);
				continue;
			}
			if (kind === 'email') {
				this.emitProgress(
					'handling_gates',
					'Submitting Droploud email step...',
					percent,
					{ currentGate: 'email' },
				);
				await this.handleEmailStep(page);
				continue;
			}
			if (kind === 'droploud_follow') {
				this.emitProgress(
					'handling_gates',
					'Skipping Droploud follow step...',
					percent,
					{ currentGate: 'social' },
				);
				await this.handleDroploudFollowStep(page);
				continue;
			}
			if (kind === 'disclaimer') {
				this.emitProgress(
					'handling_gates',
					'Confirming Droploud disclaimer...',
					percent,
					{ currentGate: 'social' },
				);
				await this.handleDisclaimerStep(page);
				continue;
			}
			if (kind === 'soundcloud_connect') {
				this.emitProgress(
					'handling_gates',
					'Connecting SoundCloud on Droploud...',
					percent,
					{ currentGate: 'sc' },
				);
				await this.handleSoundcloudConnect(page);
				continue;
			}
			if (kind === 'soundcloud_repost') {
				this.emitProgress(
					'handling_gates',
					'Reposting on SoundCloud for Droploud...',
					percent,
					{ currentGate: 'sc' },
				);
				await this.handleSoundcloudRepostStep(page);
				continue;
			}
			if (kind === 'soundcloud_wait') {
				this.emitProgress(
					'handling_gates',
					'Waiting for Droploud to check SoundCloud...',
					percent,
					{ currentGate: 'sc' },
				);
				await this.waitForPaneAdvance(page, 60_000, 'SoundCloud connected');
				continue;
			}
			if (kind === 'social_open') {
				this.emitProgress(
					'handling_gates',
					'Handling Droploud social step...',
					percent,
					{ currentGate: 'social' },
				);
				await this.handleSocialOpenStep(page);
				continue;
			}

			const title = await this.paneTitle(page);
			throw new Error(
				`Unsupported Droploud gate step${title ? `: ${title}` : ''}. Please create an issue if this keeps happening.`,
			);
		}

		if (!unlocked && (await this.detectPaneKind(page)) !== 'unlocked') {
			throw new Error('Droploud gate did not unlock after completing steps');
		}

		await this.handleDownload(page);
		await page.close();
		return this.downloadFilename;
	}

	async close() {
		this.cancelPendingDownloadWait?.();
		this.cancelPendingDownloadWait = null;
		await this.browserLaunch.close();
	}

	private async dismissCookieBanner(page: Page) {
		const dismissed = await page.evaluate((selector) => {
			const buttons = Array.from(
				document.querySelectorAll<HTMLButtonElement>(selector),
			);
			const choice =
				buttons.find((btn) =>
					/reject non-essential/i.test(btn.textContent || ''),
				) ?? buttons.find((btn) => /accept all/i.test(btn.textContent || ''));
			choice?.click();
			return !!choice;
		}, Selectors.DROPLOUD_COOKIE_BUTTONS);
		if (!dismissed) return;
		await page
			.waitForFunction(
				(selector) => !document.querySelector(selector),
				{ timeout: 5_000 },
				Selectors.DROPLOUD_COOKIE_BUTTONS,
			)
			.catch(() => {});
	}

	/** Classifies the visible gate card; waits briefly while the stage fades between steps. */
	private async detectPaneKind(page: Page): Promise<PaneKind> {
		const deadline = Date.now() + 6_000;
		while (true) {
			const kind: PaneKind = await page.evaluate(
				(selectors) => {
					const text = (el: Element | null | undefined) =>
						(el?.textContent || '').replace(/\s+/g, ' ').trim();
					// The stage hides for ~210 ms while it swaps in the next step.
					if (
						document.querySelector(selectors.stage) &&
						!document.querySelector(selectors.stageVisible)
					) {
						return 'unknown';
					}
					const title = text(document.querySelector(selectors.title));
					const primary = Array.from(
						document.querySelectorAll<HTMLButtonElement>(selectors.primary),
					);
					if (
						/download unlocked/i.test(title) ||
						primary.some((btn) => /^download$/i.test(text(btn)))
					) {
						return 'unlocked';
					}
					if (document.querySelector(selectors.emailInput)) return 'email';
					if (
						primary.some(
							(btn) =>
								btn.type === 'button' &&
								!btn.closest('form') &&
								/^free download$/i.test(text(btn)),
						)
					) {
						return 'reveal';
					}
					if (document.querySelector(selectors.dlFollowWrap)) {
						return 'droploud_follow';
					}
					if (
						document.querySelector(selectors.scConnect) ||
						document.querySelector(selectors.scComment)
					) {
						return 'soundcloud_connect';
					}
					if (document.querySelector(selectors.scRows)) {
						return 'soundcloud_repost';
					}
					if (/soundcloud connected/i.test(title)) return 'soundcloud_wait';
					if (
						document.querySelector(selectors.honorDone) ||
						document.querySelector(selectors.honorRow)
					) {
						return 'social_open';
					}
					if (
						document.querySelector(selectors.disclaimerCheck) &&
						Array.from(document.querySelectorAll(selectors.buttons)).some(
							(btn) => /^i confirm/i.test(text(btn)),
						)
					) {
						return 'disclaimer';
					}
					return 'unknown';
				},
				{
					stage: Selectors.DROPLOUD_STAGE,
					stageVisible: Selectors.DROPLOUD_STAGE_VISIBLE,
					title: Selectors.DROPLOUD_PANE_TITLE,
					primary: Selectors.DROPLOUD_PRIMARY_BUTTON,
					buttons: Selectors.DROPLOUD_PANE_BUTTONS,
					emailInput: Selectors.DROPLOUD_EMAIL_INPUT,
					dlFollowWrap: Selectors.DROPLOUD_DLFOLLOW_WRAP,
					scConnect: Selectors.DROPLOUD_SC_CONNECT,
					scComment: Selectors.DROPLOUD_SC_COMMENT_INPUT,
					scRows: Selectors.DROPLOUD_SC_ROWS,
					honorRow: Selectors.DROPLOUD_HONOR_ROW,
					honorDone: Selectors.DROPLOUD_HONOR_DONE,
					disclaimerCheck: Selectors.DROPLOUD_DISCLAIMER_CHECK,
				},
			);
			if (kind !== 'unknown' || Date.now() >= deadline) return kind;
			await timeout(250);
		}
	}

	private async paneTitle(page: Page): Promise<string> {
		return page.evaluate((selector) => {
			return document.querySelector(selector)?.textContent?.trim() || '';
		}, Selectors.DROPLOUD_PANE_TITLE);
	}

	/**
	 * Identifies the current step: its title plus its link targets, since two
	 * consecutive link steps can share a label. Null while the stage is fading.
	 */
	private async paneSignature(page: Page): Promise<string | null> {
		return page.evaluate(
			(selectors) => {
				if (
					document.querySelector(selectors.stage) &&
					!document.querySelector(selectors.stageVisible)
				) {
					return null;
				}
				const title =
					document.querySelector(selectors.title)?.textContent?.trim() || '';
				const links = Array.from(
					document.querySelectorAll(`${selectors.honorRow} .ds-honor-n a`),
				)
					.map((link) => link.getAttribute('href') || link.textContent || '')
					.join(',');
				return `${title}|${links}`;
			},
			{
				stage: Selectors.DROPLOUD_STAGE,
				stageVisible: Selectors.DROPLOUD_STAGE_VISIBLE,
				title: Selectors.DROPLOUD_PANE_TITLE,
				honorRow: Selectors.DROPLOUD_HONOR_ROW,
			},
		);
	}

	/**
	 * Polls until a different step is visible. `failure` may return an error
	 * message (e.g. a validation alert) to stop waiting early.
	 */
	private async waitForPaneChange(
		page: Page,
		before: string | null,
		timeoutMs: number,
		failure?: () => Promise<string | null>,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const current = await this.paneSignature(page);
			if (current !== null && current !== before) {
				await timeout(300);
				return true;
			}
			const message = await failure?.();
			if (message) throw new Error(message);
			await timeout(200);
		}
		return false;
	}

	private async waitForPaneAdvance(
		page: Page,
		timeoutMs: number,
		step: string,
	) {
		const before = await this.paneSignature(page);
		if (!(await this.waitForPaneChange(page, before, timeoutMs))) {
			throw new Error(`Droploud step did not advance (${step}).`);
		}
	}

	/** Finds a visible gate-card button by its normalized label. */
	private async findPaneButton(
		page: Page,
		label: RegExp,
	): Promise<{ index: number; enabled: boolean } | null> {
		return page.evaluate(
			(selector, source, flags) => {
				const pattern = new RegExp(source, flags);
				const buttons = Array.from(
					document.querySelectorAll<HTMLButtonElement>(selector),
				);
				const index = buttons.findIndex((btn) =>
					pattern.test((btn.textContent || '').replace(/\s+/g, ' ').trim()),
				);
				const button = buttons[index];
				if (!button) return null;
				return {
					index,
					enabled:
						!button.disabled &&
						button.getAttribute('aria-disabled') !== 'true' &&
						button.getAttribute('aria-busy') !== 'true',
				};
			},
			Selectors.DROPLOUD_PANE_BUTTONS,
			label.source,
			label.flags,
		);
	}

	/** Clicks an enabled gate-card button; trusted clicks keep popups allowed. */
	private async clickPaneButton(
		page: Page,
		label: RegExp,
		trusted = false,
	): Promise<boolean> {
		// Match and click the same element, so a re-rendered pane can't swap
		// in another action between the lookup and the click.
		const handles = await page.$$(Selectors.DROPLOUD_PANE_BUTTONS);
		// Untrusted clicks check and click in one call. A trusted click is a
		// separate input event, so it re-checks right before clicking.
		const usable = (handle: (typeof handles)[number], click: boolean) =>
			handle
				.evaluate(
					(button, source, flags, click) => {
						const ok =
							new RegExp(source, flags).test(
								(button.textContent || '').replace(/\s+/g, ' ').trim(),
							) &&
							!(button as HTMLButtonElement).disabled &&
							button.getAttribute('aria-disabled') !== 'true' &&
							button.getAttribute('aria-busy') !== 'true';
						if (ok && click) (button as HTMLElement).click();
						return ok;
					},
					label.source,
					label.flags,
					click,
				)
				.catch(() => false);
		try {
			for (const handle of handles) {
				if (!trusted) {
					if (await usable(handle, true)) return true;
					continue;
				}
				if (!(await usable(handle, false))) continue;
				await handle.scrollIntoView().catch(() => {});
				if (!(await usable(handle, false))) return false;
				await handle.click({ delay: 40 });
				return true;
			}
			return false;
		} finally {
			for (const handle of handles) await handle.dispose();
		}
	}

	/** Waits for a tab opened after `pagesBefore` was taken. */
	private async waitForNewPage(
		page: Page,
		pagesBefore: Set<Page>,
		timeoutMs: number,
	): Promise<Page | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const pages = await this.browser.pages(true);
			const opened = pages.find(
				(candidate) =>
					candidate !== page &&
					!pagesBefore.has(candidate) &&
					!candidate.isClosed(),
			);
			if (opened) return opened;
			await timeout(200);
		}
		return undefined;
	}

	private async closePage(target: Page | undefined) {
		if (!target || target.isClosed()) return;
		try {
			await target.close();
		} catch {
			// already closed
		}
	}

	/**
	 * The gate is server-rendered; clicks and typing before React hydrates are
	 * dropped or reset. Hydrated elements carry React's `__reactProps$…` key.
	 */
	private async waitForHydration(page: Page) {
		try {
			await page.waitForFunction(
				(selector) => {
					const button = document.querySelector(selector);
					return (
						!!button &&
						Object.keys(button).some((key) => key.startsWith('__reactProps'))
					);
				},
				{ timeout: 30_000 },
				Selectors.DROPLOUD_PANE_BUTTONS,
			);
		} catch {
			console.warn('Droploud: gate did not report hydration; continuing.');
		}
	}

	private async handleRevealStep(page: Page) {
		const before = await this.paneSignature(page);
		// Retry: a click that lands while React is still settling is ignored.
		for (let attempt = 0; attempt < 4; attempt++) {
			if (!(await this.clickPaneButton(page, /^free download$/i))) {
				const current = await this.paneSignature(page);
				if (current !== null && current !== before) return;
				throw new Error('Droploud Free download button is not available.');
			}
			if (await this.waitForPaneChange(page, before, 5_000)) return;
		}
		throw new Error('Droploud gate did not open after Free download.');
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
		const before = await this.paneSignature(page);

		// React can reset the field and box while it finishes hydrating, so
		// re-apply both until the submit button unlocks.
		let unlocked = false;
		for (let attempt = 0; attempt < 5 && !unlocked; attempt++) {
			await page.evaluate(
				(selectors, value) => {
					// React's own props show its state when the DOM is out of sync.
					const reactProps = (el: Element) => {
						const key = Object.keys(el).find((k) =>
							k.startsWith('__reactProps'),
						);
						return key
							? (
									el as unknown as Record<
										string,
										{ value?: unknown; checked?: unknown }
									>
								)[key]
							: undefined;
					};
					const input = document.querySelector<HTMLInputElement>(
						selectors.input,
					);
					if (input && (reactProps(input)?.value ?? input.value) !== value) {
						// React-controlled input needs the native value setter.
						const setter = Object.getOwnPropertyDescriptor(
							window.HTMLInputElement.prototype,
							'value',
						)?.set;
						setter?.call(input, value);
						input.dispatchEvent(new Event('input', { bubbles: true }));
					}
					const checkbox = document.querySelector<HTMLInputElement>(
						selectors.consent,
					);
					if (
						checkbox &&
						!(reactProps(checkbox)?.checked ?? checkbox.checked)
					) {
						// A box left ticked from before hydration must toggle on again.
						checkbox.checked = false;
						checkbox.click();
					}
				},
				{
					input: Selectors.DROPLOUD_EMAIL_INPUT,
					consent: Selectors.DROPLOUD_EMAIL_CONSENT,
				},
				email,
			);
			unlocked = await page
				.waitForFunction(
					(selector) => {
						const btn = document.querySelector<HTMLButtonElement>(selector);
						return !!btn && !btn.disabled;
					},
					{ timeout: 2_000 },
					Selectors.DROPLOUD_EMAIL_SUBMIT,
				)
				.then(
					() => true,
					() => false,
				);
		}
		if (!unlocked) {
			throw new Error(
				'Droploud email step stayed locked. Check that HYPEDDIT_EMAIL is a valid address.',
			);
		}

		await page.evaluate((selector) => {
			document.querySelector<HTMLButtonElement>(selector)?.click();
		}, Selectors.DROPLOUD_EMAIL_SUBMIT);

		const advanced = await this.waitForPaneChange(
			page,
			before,
			20_000,
			async () => {
				const error = await page.evaluate((selector) => {
					return document.querySelector(selector)?.textContent?.trim() || '';
				}, Selectors.DROPLOUD_EMAIL_ERROR);
				return error ? `Droploud rejected the email: ${error}` : null;
			},
		);
		if (!advanced) {
			throw new Error('Droploud email step did not complete.');
		}
	}

	private async handleDroploudFollowStep(page: Page) {
		await page.waitForSelector(Selectors.DROPLOUD_DLFOLLOW_WRAP, {
			timeout: 10_000,
		});
		const before = await this.paneSignature(page);

		const skipped = await page.evaluate((selector) => {
			const skip = document.querySelector<HTMLButtonElement>(selector);
			if (skip && !skip.disabled) {
				skip.click();
				return true;
			}
			return false;
		}, Selectors.DROPLOUD_DLFOLLOW_SKIP);

		if (
			!skipped &&
			!(await this.clickPaneButton(page, /^(skip|i.?m done, continue)$/i))
		) {
			throw new Error('Droploud follow skip/continue button not found.');
		}

		if (!(await this.waitForPaneChange(page, before, 20_000))) {
			throw new Error('Droploud follow step did not advance after skip.');
		}
	}

	private async handleDisclaimerStep(page: Page) {
		const before = await this.paneSignature(page);
		await page.evaluate((selector) => {
			const checkbox = document.querySelector<HTMLInputElement>(selector);
			if (checkbox && !checkbox.checked) {
				checkbox.click();
			}
		}, Selectors.DROPLOUD_DISCLAIMER_CHECK);

		const deadline = Date.now() + 10_000;
		while (!(await this.clickPaneButton(page, /^i confirm/i))) {
			if (Date.now() >= deadline) {
				throw new Error('Droploud disclaimer confirm button stayed disabled.');
			}
			await timeout(200);
		}

		if (!(await this.waitForPaneChange(page, before, 20_000))) {
			throw new Error('Droploud disclaimer step did not advance.');
		}
	}

	/**
	 * Honor-system link step (Instagram, YouTube, TikTok, Facebook, Spotify, …):
	 * open every link, close the popups, then press "I've done it".
	 */
	private async handleSocialOpenStep(page: Page) {
		const before = await this.paneSignature(page);
		const stepTitle = await this.paneTitle(page);
		console.log(`Droploud social open: ${stepTitle || 'untitled step'}`);

		for (let attempt = 0; attempt < 20; attempt++) {
			const pending = await page.evaluate((selector) => {
				const rows = Array.from(document.querySelectorAll(selector));
				const index = rows.findIndex(
					(row) =>
						!row.classList.contains('is-open') &&
						!row.classList.contains('is-done') &&
						!row.hasAttribute('data-honor-skipped'),
				);
				return {
					index,
					blocked: !!rows[index]?.classList.contains('is-blocked'),
				};
			}, Selectors.DROPLOUD_HONOR_ROW);

			if (pending.index < 0) break;
			if (pending.blocked) {
				throw new Error(
					`Droploud could not open a link popup (${stepTitle || 'unknown'}). Popups may be blocked.`,
				);
			}

			const rows = await page.$$(Selectors.DROPLOUD_HONOR_ROW);
			const button = await rows[pending.index]?.$(
				Selectors.DROPLOUD_HONOR_OPEN,
			);
			for (const row of rows) await row.dispose();
			if (!button) {
				throw new Error('Droploud open-link button disappeared mid-step.');
			}

			const pagesBefore = new Set(await this.browser.pages(true));
			// Trusted click — Droploud opens the link with window.open from the handler.
			await button.click({ delay: 40 });
			await button.dispose();

			try {
				await page.waitForFunction(
					(selector, index) => {
						const row = document.querySelectorAll(selector)[index];
						return (
							!row ||
							row.classList.contains('is-open') ||
							row.classList.contains('is-done') ||
							row.classList.contains('is-blocked')
						);
					},
					{ timeout: 8_000 },
					Selectors.DROPLOUD_HONOR_ROW,
					pending.index,
				);
			} catch {
				console.warn(
					`Droploud: link #${pending.index + 1} was not marked opened; retrying.`,
				);
			}

			const popup = await this.waitForNewPage(page, pagesBefore, 5_000);
			if (popup) {
				// Honor system: opening is enough. Let the page start loading first.
				await timeout(1_200);
				await this.closePage(popup);
			}
			await page.bringToFront().catch(() => {});
		}

		const deadline = Date.now() + 15_000;
		while (!(await this.clickPaneButton(page, /^i've done it$/i))) {
			if (!(await page.$(Selectors.DROPLOUD_HONOR_DONE))) {
				// Already confirmed; the next step is fading in.
				break;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Droploud social step still has unopened links (${stepTitle || 'unknown'}). Popups may be blocked.`,
				);
			}
			await timeout(250);
		}

		if (!(await this.waitForPaneChange(page, before, 45_000))) {
			throw new Error(
				`Droploud social step did not advance after confirm (${stepTitle || 'unknown'}). Try again or run non-headless.`,
			);
		}
	}

	/**
	 * Manual repost pane shown after connecting SoundCloud: open the track,
	 * repost it there, then let Droploud verify the repost.
	 */
	private async handleSoundcloudRepostStep(page: Page) {
		const before = await this.paneSignature(page);
		const stepTitle = await this.paneTitle(page);
		console.log(`Droploud SoundCloud step: ${stepTitle || 'untitled step'}`);

		let repostError: Error | null = null;
		this.repostSavedViaApi = false;
		const openLabel = /^open track on soundcloud$/i;
		if (await this.findPaneButton(page, openLabel)) {
			const pagesBefore = new Set(await this.browser.pages(true));
			await this.clickPaneButton(page, openLabel, true);
			const popup = await this.waitForNewPage(page, pagesBefore, 10_000);
			if (!popup) {
				throw new Error(
					'Droploud did not open the SoundCloud track. Popups may be blocked.',
				);
			}
			const firefox = firefoxRepostAvailable();
			if (firefox) {
				repostError = await this.repostInFirefox(firefox, popup);
			} else {
				repostError = await this.repostInPopup(popup);
			}
			await page.bringToFront().catch(() => {});
		}

		let verifyFound: boolean | null = null;
		// Droploud rate-limits repost scans ("Checked a moment ago. Try again in 105s").
		let cooldownUntil = 0;
		const onVerify = async (res: {
			url: () => string;
			text: () => Promise<string>;
		}) => {
			if (!res.url().includes('/soundcloud/verify-repost')) return;
			try {
				const body = JSON.parse(await res.text()) as {
					found?: boolean;
					retry_after_sec?: number;
				};
				verifyFound = body.found === true;
				if (typeof body.retry_after_sec === 'number') {
					cooldownUntil = Date.now() + (body.retry_after_sec + 1) * 1_000;
				}
			} catch {
				// ignore parse errors (e.g. the CORS preflight)
			}
		};
		page.on('response', onVerify);

		try {
			let verifyClicks = 0;
			let nextVerifyAt = 0;
			const deadline = Date.now() + 240_000;
			while (Date.now() < deadline) {
				const current = await this.paneSignature(page);
				if (current !== null && current !== before) {
					await timeout(300);
					return;
				}
				// Manual like mode: Droploud cannot see the like and offers Continue after 5 s.
				if (await this.clickPaneButton(page, /^continue$/i)) {
					console.log('Droploud: like not seen; continuing with the repost.');
				} else if (
					verifyClicks < 4 &&
					Date.now() >= Math.max(nextVerifyAt, cooldownUntil) &&
					(await this.clickPaneButton(page, /^verify( again)?$/i))
				) {
					verifyClicks++;
					nextVerifyAt = Date.now() + 15_000;
				} else if (
					verifyClicks >= 4 &&
					Date.now() >= nextVerifyAt &&
					(await this.clickPaneButton(page, /^continue anyway$/i))
				) {
					console.warn('Droploud: repost not verified; using Continue anyway.');
					nextVerifyAt = Date.now() + 15_000;
				}
				await timeout(500);
			}
		} finally {
			page.off('response', onVerify);
		}

		if (repostError) throw repostError;
		if (verifyFound === false) {
			throw new Error(
				'Droploud could not verify the SoundCloud repost. Make sure the SoundCloud account is logged in (Initialize Logins) and try again.',
			);
		}
		throw new Error(
			`Droploud SoundCloud step did not advance (${stepTitle || 'unknown'}). Try again or run non-headless.`,
		);
	}

	/** Waits for Droploud's popup to load the SoundCloud track; it can swap pages. */
	private async soundcloudPopupTrack(
		popup: Page,
	): Promise<{ page: Page; trackUrl: string }> {
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
		return { page, trackUrl };
	}

	/**
	 * Reposts in a plain Firefox, which SoundCloud's bot protection lets
	 * through where the automated browser gets a challenge. Returns the error
	 * to report if Droploud cannot verify the repost afterwards.
	 */
	private async repostInFirefox(
		firefox: string,
		popup: Page,
	): Promise<Error | null> {
		let trackUrl: string;
		try {
			({ trackUrl } = await this.soundcloudPopupTrack(popup));
		} finally {
			await this.closePage(popup);
		}
		this.emitProgress(
			'handling_gates',
			'Reposting on SoundCloud in Firefox...',
			50,
			{
				currentGate: 'sc',
				browserActive: true,
			},
		);
		console.log(`Droploud: reposting ${trackUrl} in Firefox…`);
		// SoundCloud's session from this browser; DataDome's cookie belongs to it.
		const cookies = (
			await this.browser.defaultBrowserContext().cookies()
		).filter(
			(cookie) =>
				/(^|\.)soundcloud\.com$/i.test(cookie.domain.replace(/^\./, '')) &&
				cookie.name !== 'datadome',
		);
		const soundcloud = hasSoundcloudLogin() ? new SoundcloudClient() : null;
		try {
			await repostInFirefox(firefox, trackUrl, cookies, {
				isReposted: soundcloud
					? () => soundcloud.isTrackReposted(trackUrl)
					: undefined,
				log: (line) => console.log(`Droploud: ${line}`),
			});
			return null;
		} catch (error) {
			if (error instanceof SoundcloudBlockedError) throw error;
			const repostError =
				error instanceof Error ? error : new Error(String(error));
			// Droploud's own Verify is the authority; report this only if it fails.
			console.warn(`Droploud: ${repostError.message}`);
			return repostError;
		}
	}

	/** Reposts in Droploud's popup of the automated browser. */
	private async repostInPopup(popup: Page): Promise<Error | null> {
		let blocked = false;
		let repostError: Error | null = null;
		// A rejected repost can also come back as a silent 403 with no block page.
		// It answers 403 with a slider challenge first; only the last answer
		// counts, after the challenge was solved and Repost clicked again.
		let lastRepostStatus: number | null = null;
		const onRepostResponse = (response: HTTPResponse) => {
			if (
				response.url().startsWith('https://graph.soundcloud.com/graphql') &&
				/ToggleTrackRepost/.test(response.request().postData() ?? '')
			)
				lastRepostStatus = response.status();
		};
		popup.on('response', onRepostResponse);
		try {
			await this.performSoundcloudManualActions(popup, { repost: true });
		} catch (error) {
			// Droploud's own Verify below is the authority; report this only if it fails.
			repostError = error instanceof Error ? error : new Error(String(error));
			console.warn(`Droploud: ${repostError.message}`);
		} finally {
			// The Repost button flips even when SoundCloud's anti-bot rejects the
			// request and swaps the track for a block page; nothing gets saved then.
			popup.off('response', onRepostResponse);
			const live = (await this.resolveSoundcloudPage(popup)) ?? popup;
			// The popup keeps showing the rejection even when the API fallback
			// saved the repost afterwards; then Droploud's Verify decides.
			blocked =
				!this.repostSavedViaApi &&
				((lastRepostStatus === 403 && repostError !== null) ||
					(await this.soundcloudBlocked(live)));
			await this.closePage(popup);
		}
		if (blocked) {
			throw new Error(
				'SoundCloud blocked this browser or network ("You have been blocked"), so the repost Droploud requires was not saved. Wait a while or use another network, then retry.',
			);
		}
		return repostError;
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

		const { page, trackUrl } = await this.soundcloudPopupTrack(popup);

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
					!/sign in or create an account|create an account or sign in/i.test(
						document.body?.innerText || '',
					),
			)
			.catch(() => false);
		if (!loggedIn) {
			console.warn(
				'Droploud: SoundCloud tab does not look logged in — GraphQL/UI repost will likely fail. Re-run Initialize Logins.',
			);
		}

		// A DataDome challenge can replace the popup before any repost request.
		// Clear it before trying GraphQL or the visible Repost control.
		await this.handlePossibleCaptcha(page);

		// Click Repost like a person. Hand-built GraphQL reposts get rejected
		// by SoundCloud's bot protection and get the browser blocked.
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
			this.repostSavedViaApi = true;
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

		if (this.config.browserMode === 'headed' && !closed && !page.isClosed()) {
			this.emitProgress(
				'handling_gates',
				'Complete the SoundCloud repost or captcha in the browser to continue...',
				50,
				{
					currentGate: 'soundcloud',
					browserActive: true,
					requiresAttention: true,
				},
			);
			console.log(
				'Droploud: waiting up to 2 minutes for manual Repost / captcha solve…',
			);
			const manualDeadline = Date.now() + 120_000;
			let nextApiCheck = 0;
			while (Date.now() < manualDeadline) {
				if (page.isClosed()) break;
				await this.handlePossibleCaptcha(page).catch(() => false);
				if (
					!page.isClosed() &&
					(await this.pageLooksReposted(page).catch(() => false))
				) {
					console.log(
						'Droploud: SoundCloud repost confirmed after manual UI (ui).',
					);
					return;
				}
				if (Date.now() >= nextApiCheck) {
					nextApiCheck = Date.now() + 15_000;
					try {
						if (await soundcloud.isTrackReposted(trackUrl)) {
							console.log(
								'Droploud: SoundCloud repost confirmed after manual UI (api).',
							);
							return;
						}
					} catch {
						// logged inside isTrackReposted
					}
				}
				const manualAction = await this.tryClickRepostButton(page).catch(
					() => null,
				);
				if (manualAction === 'clicked') {
					await timeout(800);
					await this.handlePossibleCaptcha(page).catch(() => false);
				}
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

	/** True when SoundCloud's anti-bot (DataDome) shows its block page in any frame. */
	private async soundcloudBlocked(page: Page): Promise<boolean> {
		if (page.isClosed()) return false;
		for (const frame of page.frames()) {
			if (frame.detached) continue;
			if (/captcha-delivery\.com\/.*[?&]t=bv\b/.test(frame.url())) return true;
			const text = await frame
				.evaluate(() => (document.body?.innerText || '').slice(0, 2_000))
				.catch(() => '');
			if (/you have been blocked/i.test(text)) return true;
		}
		return false;
	}

	/**
	 * Logged-in SoundCloud renders the track (and its Repost button) inside a
	 * same-origin "webi" iframe; logged-out and older pages use the top frame.
	 */
	private async soundcloudUiFrame(page: Page): Promise<Frame> {
		const handle = await page
			.$(Selectors.DROPLOUD_SC_WEBI_IFRAME)
			.catch(() => null);
		const frame = await handle?.contentFrame().catch(() => null);
		await handle?.dispose();
		return frame && !frame.detached ? frame : page.mainFrame();
	}

	/** Waits until the track's engagement controls are present in either frame. */
	private async waitForSoundcloudUi(
		page: Page,
		timeoutMs: number,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && !page.isClosed()) {
			const frame = await this.soundcloudUiFrame(page);
			const ready = await frame
				.evaluate(
					(selector) =>
						!!document.querySelector(selector) ||
						Array.from(
							document.querySelectorAll('button, [role="button"]'),
						).some((btn) =>
							/repost/i.test(
								`${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`,
							),
						),
					`${Selectors.SOUNDCLOUD_REPOST_BUTTON}, ${Selectors.SOUNDCLOUD_REPOST_BUTTON_MUI}, ${Selectors.SOUNDCLOUD_SOUND_ACTIONS}`,
				)
				.catch(() => false);
			if (ready) return true;
			await timeout(300);
		}
		return false;
	}

	private async pageLooksReposted(page: Page): Promise<boolean> {
		if (page.isClosed()) return false;
		const frame = await this.soundcloudUiFrame(page);
		return frame.evaluate(() => {
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
		const frame = await this.soundcloudUiFrame(page);

		const classicHandle = await frame.$(Selectors.SOUNDCLOUD_REPOST_BUTTON);
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
			const overlayClosed = await frame.evaluate(() => {
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

			await frame.evaluate(() => {
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

		return frame.evaluate(() => {
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
				// The redesigned track page relabels the button after reposting.
				if (/^(unpost|unrepost)\b|edit repost/i.test(aria || title)) {
					return 'already' as const;
				}
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
	/** The frame showing DataDome's challenge: the page or SoundCloud's track iframe. */
	private async captchaFrame(page: Page): Promise<Frame | null> {
		if (page.isClosed()) return null;
		const frames = [page.mainFrame()];
		const ui = await this.soundcloudUiFrame(page).catch(() => null);
		if (ui && ui !== page.mainFrame()) frames.push(ui);
		for (const frame of frames) {
			if (frame.detached) continue;
			const visible = await frame
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
			if (visible) return frame;
		}
		return null;
	}

	private async handlePossibleCaptcha(page: Page): Promise<boolean> {
		// Logged-in track pages raise the challenge inside the track iframe.
		const root = await this.captchaFrame(page);
		if (!root) return false;

		const captchaIframe = await root.$(Selectors.SOUNDCLOUD_CAPTCHA_IFRAME);
		if (!captchaIframe) {
			this.emitProgress(
				'handling_gates',
				'Solve the SoundCloud captcha in the browser to continue...',
				50,
				{
					currentGate: 'captcha',
					browserActive: true,
					requiresAttention: true,
				},
			);
			console.log(
				'Droploud: SoundCloud captcha visible; waiting for solve (no iframe yet)…',
			);
			await root
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
				this.emitProgress(
					'handling_gates',
					'Solve the SoundCloud captcha in the browser to continue...',
					50,
					{
						currentGate: 'captcha',
						browserActive: true,
						requiresAttention: true,
					},
				);
				await root
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
			const sliderBox = slider ? await slider.boundingBox() : null;
			const trackBox = sliderTrack ? await sliderTrack.boundingBox() : null;
			await slider?.dispose();
			await sliderTrack?.dispose();
			await captchaIframe.dispose();

			// Puppeteer reports boxes relative to the main page, also inside the
			// captcha iframe; adding the iframe offset missed the slider.
			if (sliderBox && trackBox) {
				const startX = sliderBox.x + sliderBox.width / 2;
				const startY = sliderBox.y + sliderBox.height / 2;
				const endX = trackBox.x + trackBox.width - sliderBox.width / 2;

				await page.mouse.move(startX, startY);
				await page.mouse.down();
				await page.mouse.move(endX, startY, { steps: 25 });
				await timeout(400);
				await page.mouse.up();
				console.log('Droploud: DataDome slider drag performed');
			}

			await root
				.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
					hidden: true,
					timeout: 5_000,
				})
				.catch(async () => {
					console.warn(
						'Droploud: captcha still visible after slider drag — solve it manually if needed.',
					);
					this.emitProgress(
						'handling_gates',
						'Solve the SoundCloud captcha in the browser to continue...',
						50,
						{
							currentGate: 'captcha',
							browserActive: true,
							requiresAttention: true,
						},
					);
					await root
						.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
							hidden: true,
							timeout: 55_000,
						})
						.catch(() => {});
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
		await this.waitForSoundcloudUi(page, 25_000);
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

		if (await this.waitForSoundcloudUi(page, 12_000)) return page;

		const url = page.url();
		if (url.includes('soundcloud.com')) {
			console.log('Droploud: engagement bar missing — reloading track page…');
			await page.goto(url, {
				waitUntil: 'domcontentloaded',
				timeout: 30_000,
			});
			await timeout(1_000);
			await this.dismissSoundcloudConsent(page);
			await this.waitForSoundcloudUi(page, 20_000);
		}
		return page;
	}

	/**
	 * Click Repost on the dedicated full-size track tab.
	 */
	private async repostTrackInBrowser(page: Page) {
		const started = Date.now();
		let ensured = false;
		let dwelled = false;
		// SoundCloud's answer to the Repost click; the button flips either way.
		// The popup closes after this step, which drops the listener.
		let repostStatus: number | null = null;
		page.on('response', (response) => {
			if (
				response.url().startsWith('https://graph.soundcloud.com/graphql') &&
				/ToggleTrackRepost/.test(response.request().postData() ?? '')
			)
				repostStatus = response.status();
		});

		// Leave time for someone to solve a challenge in the browser.
		while (Date.now() - started < 300_000) {
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
						}
					}
					await this.dismissSoundcloudConsent(page);
				}

				if (await this.pageLooksReposted(page)) {
					console.log('Droploud: track already looks reposted in the browser.');
					return;
				}

				// SoundCloud may insert DataDome immediately before the repost UI or
				// after the popup has been sitting open for a moment.
				await this.handlePossibleCaptcha(page);
				if (!dwelled) {
					// Its bot protection rejects a repost clicked the moment the page
					// loads, so stay on the track a few seconds first, like a listener.
					dwelled = true;
					await page
						.waitForNetworkIdle({ idleTime: 500, timeout: 15_000 })
						.catch(() => {});
					await timeout(4_000 + Math.random() * 4_000);
				}
				repostStatus = null;
				const action = await this.tryClickRepostButton(page);
				if (action === 'already') {
					console.log('Droploud: track already looks reposted in the browser.');
					return;
				}
				if (action === 'clicked') {
					console.log('Droploud: clicked SoundCloud Repost button');
					const answerDeadline = Date.now() + 8_000;
					while (repostStatus === null && Date.now() < answerDeadline)
						await timeout(250);
					if (repostStatus === 200) return;
					if (repostStatus === 403) {
						// A rejected repost brings up DataDome's slider a moment later.
						const challengeDeadline = Date.now() + 6_000;
						while (
							Date.now() < challengeDeadline &&
							!(await this.captchaFrame(page))
						)
							await timeout(300);
						if (!(await this.handlePossibleCaptcha(page))) {
							throw new Error(
								'SoundCloud rejected the repost without a challenge to solve.',
							);
						}
						// The challenge reloaded the track; click Repost again.
						repostStatus = null;
						continue;
					}
					if (await this.pageLooksReposted(page)) return;
					console.warn(
						'Droploud: browser Repost click did not confirm repost; retrying…',
					);
					await timeout(500);
					continue;
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

		const debugFrame = await this.soundcloudUiFrame(page).catch(() => null);
		const debug = await (debugFrame ?? page.mainFrame())
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
		const before = await this.paneSignature(page);
		const commentInput = await page.$(Selectors.DROPLOUD_SC_COMMENT_INPUT);
		if (commentInput) {
			await commentInput.dispose();
			const comment = this.config.comment.trim();
			// Droploud keeps Connect disabled while comment.trim().length < 2
			if (comment.length < 2) {
				throw new Error(
					'Droploud requires SC_COMMENT to be at least 2 characters (your .env value is too short).',
				);
			}

			// React-controlled input: native setter + input event enables Connect.
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
				Selectors.DROPLOUD_SC_COMMENT_INPUT,
				comment,
			);
		}

		try {
			await page.waitForFunction(
				(selector) => {
					const btn = document.querySelector<HTMLButtonElement>(selector);
					return !!btn && !btn.disabled;
				},
				{ timeout: 10_000 },
				Selectors.DROPLOUD_SC_CONNECT,
			);
		} catch {
			throw new Error(
				'Droploud Connect SoundCloud button stayed disabled. Set SC_COMMENT to at least 2 characters.',
			);
		}

		const pagesBefore = await this.browser.pages(true);

		// Trusted click so Droploud's window.open popup is not blocked.
		const connect = await page.$(Selectors.DROPLOUD_SC_CONNECT);
		if (!connect) {
			throw new Error('Droploud Connect SoundCloud button disappeared.');
		}
		await connect.click({ delay: 40 });
		await connect.dispose();

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

		// Droploud polls its gate status and then leaves the Connect pane.
		if (!(await this.waitForPaneChange(page, before, 90_000))) {
			throw new Error(
				'Droploud did not register the SoundCloud connection. Try again or run non-headless.',
			);
		}
	}

	private async completeSoundcloudOauth(oauthPage: Page) {
		await oauthPage.bringToFront();
		try {
			await oauthPage.setViewport({ width: 1920, height: 1080 });
		} catch {
			// popup may already be closing
		}

		let deadline = Date.now() + 90_000;
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
						const loginRe =
							/sign in or create an account|create an account or sign in/i;
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
					deadline = Date.now() + 90_000;
					continue;
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
		this.emitProgress('handling_gates', 'Preparing Droploud download...', 75);

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
			}, Selectors.DROPLOUD_PRIMARY_BUTTON);
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
