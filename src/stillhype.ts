import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Presets, SingleBar } from 'cli-progress';
import type { Browser, ElementHandle, HTTPResponse, Page } from 'puppeteer';
import { CancellableBrowserLaunch } from './browserLaunch';
import { filenameFromContentDisposition } from './contentDisposition';
import { DirectDownloader } from './directDownload';
import { reserveDownloadFilename } from './downloadRename';
import type { ProgressCallback } from './hypeddit';
import { safeFetch } from './safeOutboundUrl';
import Selectors from './selectors';
import { visitSocialPopup } from './socialPopup';
import { signInToSoundcloud, waitForSoundcloudLogin } from './soundcloudLogin';
import type { HypedditConfig } from './types';
import {
	loadCookies,
	resolveGateUrlOrFollow,
	safeDecodeURIComponent,
	sanitizeFilenamePart,
	timeout,
} from './utils';

const STILLHYPE_ORIGIN_RE = /stillhype\.io/i;
const SC_AUTHORIZE_RE = /secure\.soundcloud\.com\/authorize/i;
const SC_OAUTH_CALLBACK_RE = /\/api\/oauth\/soundcloud/i;
// Separate steps show their own label ("Follow Maяcek on SoundCloud"); a
// bundle shows "Connect" until the fan has a SoundCloud token.
const SC_STEP_BUTTON_RE =
	/^(Follow|Like|Repost|Comment)\b.*\bon SoundCloud$|^Connect$|^Tap to confirm\s*[—–-]\s*already connected$/i;
// instagram/tiktok/twitter/youtube_follow list one "Follow <account> ↗" button
// per account; website_visit shows "Visit website ↗". Both open a new tab.
// Done accounts keep their button with a check icon in front.
const SOCIAL_BUTTON_RE = /^(Follow .+|Visit website) ↗$/;
// With enhancedFollow a visit only unlocks a confirm form: after a countdown
// the fan types their own handle and presses "I've followed", which the
// server checks (/api/gate/mark-complete).
const HANDLE_INPUT = 'input[aria-label^="Your "][aria-label$=" handle"]';
const CONFIRM_FOLLOW_RE = /^I['’]ve followed$/i;
const UNLOCK_BUTTON_RE = /^(Unlock download|Download again)$/i;
const SKIP_EMAIL_RE = /^Skip for now$/i;
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export type SocialPlatform = 'instagram' | 'tiktok' | 'twitter' | 'youtube';
/** The fan's own accounts, which enhanced follow steps ask for. */
export type StillhypeSocialHandles = Partial<Record<SocialPlatform, string>>;

/** Account names from `.env`; unset ones are asked for in the remote browser. */
export function socialHandlesFromEnv(
	env: Record<string, string | undefined> = process.env,
): StillhypeSocialHandles {
	return {
		instagram: env.INSTAGRAM_HANDLE,
		tiktok: env.TIKTOK_HANDLE,
		twitter: env.X_HANDLE,
		youtube: env.YOUTUBE_HANDLE,
	};
}

const PLATFORM_BY_INPUT_NAME: Record<string, SocialPlatform> = {
	Instagram: 'instagram',
	TikTok: 'tiktok',
	X: 'twitter',
	YouTube: 'youtube',
};

function isNavigationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Execution context was destroyed|Cannot find context|frame was detached|Target closed|Session closed|Navigating frame/i.test(
		message,
	);
}

function safePageUrl(page: Page): string {
	try {
		if (page.isClosed()) return '';
		return page.url();
	} catch {
		return '';
	}
}

export class StillhypeDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private readonly socialHandles: StillhypeSocialHandles;
	private progressCallback: ProgressCallback | null = null;
	private cancelPendingDownloadWait: (() => void) | null = null;
	private readonly downloadAbortController = new AbortController();
	/** The gate unlocks the artist's own link instead of a StillHype file. */
	private externalDownload = false;
	private directDownloader: DirectDownloader | null = null;

	constructor(
		config: HypedditConfig,
		socialHandles: StillhypeSocialHandles = socialHandlesFromEnv(),
	) {
		this.config = config;
		this.socialHandles = socialHandles;
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

	async prepareLogins() {
		await signInToSoundcloud(this.browser);
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to StillHype gate...');
		this.emitProgress('handling_gates', 'Navigating to StillHype gate...', 25);

		let page = await this.browser.newPage();
		let unlockUrl: string | null = null;
		const onUnlockResponse = async (response: HTTPResponse) => {
			try {
				if (!/\/api\/gate\/unlock/i.test(response.url()) || !response.ok()) {
					return;
				}
				const json = (await response.json()) as { download_url?: unknown };
				if (typeof json.download_url === 'string' && json.download_url) {
					unlockUrl = json.download_url;
					console.log('StillHype: unlock API returned download URL');
				}
			} catch {
				// ignore parse errors
			}
		};

		try {
			await page.setViewport({ width: 1920, height: 1080 });
			page.on('response', onUnlockResponse);
			await page.goto(url, { waitUntil: 'domcontentloaded' });
			try {
				await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
			} catch {
				// continue
			}

			await this.waitForGateReady(page);
			this.externalDownload = /is_external_download\\?"\s*:\s*true/.test(
				await page.content().catch(() => ''),
			);

			let deadline = Date.now() + 240_000;
			let lastActionAt = 0;
			let lastActionLabel = '';
			let repeats = 0;
			let oauthCompleted = false;
			let verifyingSince: number | null = null;
			let lastStatusLog = 0;
			// Visit buttons share one label, so count retries only while the
			// gate's "N OF M DONE" progress stays the same.
			let lastSocialKey = '';
			let socialRepeats = 0;

			while (Date.now() < deadline) {
				if (unlockUrl) {
					page.off('response', onUnlockResponse);
					return await this.saveUnlockedFile(unlockUrl);
				}

				page = await this.resolveLivePage(page, url);
				// Re-attach listener if we switched pages.
				page.off('response', onUnlockResponse);
				page.on('response', onUnlockResponse);

				const pageUrl = safePageUrl(page);

				// Same-tab OAuth / callback — never evaluate gate DOM here.
				if (SC_AUTHORIZE_RE.test(pageUrl)) {
					console.log('StillHype: on SoundCloud authorize…');
					await this.completeSoundcloudOauth(page);
					oauthCompleted = true;
					verifyingSince = null;
					await timeout(800);
					continue;
				}
				if (SC_OAUTH_CALLBACK_RE.test(pageUrl)) {
					await timeout(400);
					continue;
				}
				if (!STILLHYPE_ORIGIN_RE.test(pageUrl)) {
					const oauthTab = await this.findSoundcloudOauthPage();
					if (oauthTab) {
						await this.completeSoundcloudOauth(oauthTab);
						oauthCompleted = true;
						verifyingSince = null;
						await timeout(800);
						continue;
					}
					await timeout(400);
					continue;
				}

				if (await this.hasUnlockOrSuccess(page)) {
					page.off('response', onUnlockResponse);
					return await this.handleUnlock(page, unlockUrl);
				}

				await this.handleEmailStepIfPresent(page);
				await this.clickRetryIfPresent(page);

				const verifying = await this.isVerifying(page);
				if (verifying) {
					verifyingSince ??= Date.now();
					if (Date.now() - verifyingSince < 25_000) {
						await timeout(500);
						continue;
					}
					console.log(
						'StillHype: Verifying… stuck — retrying the current step',
					);
					verifyingSince = null;
				} else {
					verifyingSince = null;
				}

				if (Date.now() - lastStatusLog > 8_000) {
					const status = await this.readGateStatus(page);
					console.log('StillHype status:', status);
					lastStatusLog = Date.now();
				}

				const social = await this.handleSocialStep(page);
				if (social) {
					console.log(`StillHype step: ${social}`);
					const progress = (await this.readGateStatus(page)).split(' | ')[0];
					const key = `${social}@${progress}`;
					socialRepeats = key === lastSocialKey ? socialRepeats + 1 : 1;
					lastSocialKey = key;
					if (socialRepeats > 5)
						throw new Error(`StillHype stalled retrying “${social}”.`);
					// Waiting for a handle typed in the remote browser counts as progress.
					deadline = Math.max(deadline, Date.now() + 120_000);
					continue;
				}

				await this.fillCommentIfNeeded(page);

				const clicked = await this.clickNextSoundcloudStep(page);
				if (!clicked) {
					await timeout(500);
					continue;
				}

				console.log(`StillHype step: ${clicked}`);
				this.emitProgress('handling_gates', `StillHype: ${clicked}...`, 45, {
					currentGate: 'sc',
				});
				if (clicked === lastActionLabel && Date.now() - lastActionAt < 8_000) {
					repeats += 1;
				} else {
					repeats = 0;
				}
				lastActionLabel = clicked;
				lastActionAt = Date.now();
				if (repeats >= 6) {
					throw new Error(
						`StillHype stalled retrying “${clicked}”. Check SoundCloud login / Allow OAuth.`,
					);
				}

				// Wait for either Verifying… (token already present) or same-tab OAuth.
				const next = await this.waitForStepNavigation(page);
				if (next === 'oauth') {
					page = await this.resolveLivePage(page, url);
					await this.completeSoundcloudOauth(page);
					oauthCompleted = true;
					await timeout(800);
				} else if (next === 'verifying') {
					if (!oauthCompleted) {
						const lateOauth = await this.waitForLateOauth(page, 5_000);
						if (lateOauth) {
							page = await this.resolveLivePage(page, url);
							await this.completeSoundcloudOauth(page);
							oauthCompleted = true;
						}
					}
					verifyingSince = Date.now();
					await this.waitWhileVerifying(page);
					verifyingSince = null;
				}
			}

			if (unlockUrl) {
				page.off('response', onUnlockResponse);
				return await this.saveUnlockedFile(unlockUrl);
			}

			throw new Error(
				'StillHype download never unlocked after completing gate steps.',
			);
		} finally {
			page.off('response', onUnlockResponse);
			if (!page.isClosed()) {
				await page.close().catch(() => {});
			}
		}
	}

	async close() {
		this.cancelPendingDownloadWait?.();
		this.cancelPendingDownloadWait = null;
		this.downloadAbortController.abort();
		await this.directDownloader?.close();
		await this.browserLaunch.close();
	}

	private async safeEvaluate<T>(
		page: Page,
		fn: (...args: never[]) => T | Promise<T>,
		...args: unknown[]
	): Promise<T | null> {
		if (page.isClosed()) return null;
		try {
			return (await page.evaluate(
				fn as Parameters<Page['evaluate']>[0],
				...(args as never[]),
			)) as T;
		} catch (error) {
			if (isNavigationError(error)) return null;
			throw error;
		}
	}

	private async waitForGateReady(page: Page) {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const ready = await this.safeEvaluate(
				page,
				(stepRe: string, unlockRe: string) => {
					const stepPattern = new RegExp(stepRe, 'i');
					const unlockPattern = new RegExp(unlockRe, 'i');
					// The steps list counts "0 OF 3 DONE" (CSS uppercases it). A
					// required email step shows no button the patterns know.
					if (/\d+\s+of\s+\d+\s+done/i.test(document.body?.innerText ?? ''))
						return true;
					return Array.from(document.querySelectorAll('button')).some((btn) => {
						const text = (btn.textContent || '').trim();
						return (
							stepPattern.test(text) ||
							unlockPattern.test(text) ||
							/^Skip for now$/i.test(text)
						);
					});
				},
				SC_STEP_BUTTON_RE.source,
				UNLOCK_BUTTON_RE.source,
			);
			if (ready) return;
			await timeout(250);
		}
		throw new Error('StillHype gate UI did not become ready in time.');
	}

	/**
	 * Prefer the live tab that currently owns the gate / OAuth flow.
	 * Same-tab OAuth keeps the same Page handle through SoundCloud → callback → gate.
	 */
	private async resolveLivePage(current: Page, gateUrl: string): Promise<Page> {
		const pages = (await this.browser.pages(true)).filter((p) => !p.isClosed());

		const authorize = pages.find((p) => SC_AUTHORIZE_RE.test(safePageUrl(p)));
		if (authorize) return authorize;

		const callback = pages.find((p) =>
			SC_OAUTH_CALLBACK_RE.test(safePageUrl(p)),
		);
		if (callback) return callback;

		if (!current.isClosed() && STILLHYPE_ORIGIN_RE.test(safePageUrl(current))) {
			return current;
		}

		const stillhype = pages.find((p) =>
			STILLHYPE_ORIGIN_RE.test(safePageUrl(p)),
		);
		if (stillhype) return stillhype;

		if (!current.isClosed()) return current;

		const page = await this.browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto(gateUrl, { waitUntil: 'domcontentloaded' });
		return page;
	}

	private async hasUnlockOrSuccess(page: Page): Promise<boolean> {
		const result = await this.safeEvaluate(
			page,
			(pattern: string) => {
				const unlockPattern = new RegExp(pattern, 'i');
				const body = document.body?.innerText || '';
				if (/you'?re in/i.test(body) || /download has started/i.test(body)) {
					return true;
				}
				if (
					Array.from(document.querySelectorAll('button')).some(
						(btn) =>
							unlockPattern.test((btn.textContent || '').trim()) &&
							!(btn as HTMLButtonElement).disabled,
					)
				) {
					return true;
				}
				return Array.from(document.querySelectorAll('a')).some((a) =>
					unlockPattern.test((a.textContent || '').trim()),
				);
			},
			UNLOCK_BUTTON_RE.source,
		);
		return result === true;
	}

	/** @deprecated use hasUnlockOrSuccess */
	private async hasUnlockButton(page: Page): Promise<boolean> {
		return this.hasUnlockOrSuccess(page);
	}

	private async isVerifying(page: Page): Promise<boolean> {
		const result = await this.safeEvaluate(page, () =>
			Array.from(document.querySelectorAll('button')).some((btn) =>
				/^Verifying/i.test((btn.textContent || '').trim()),
			),
		);
		return result === true;
	}

	private async readGateStatus(page: Page): Promise<string> {
		const status = await this.safeEvaluate(page, () => {
			const buttons = Array.from(document.querySelectorAll('button'))
				.map(
					(b) => `${(b.textContent || '').trim()}${b.disabled ? '(dis)' : ''}`,
				)
				.filter(Boolean)
				.slice(0, 8);
			const progress =
				document.body?.innerText?.match(/\d+\s+OF\s+\d+\s+DONE/i)?.[0] ?? '?';
			return `${progress} | ${buttons.join(' · ')}`;
		});
		return status ?? '(unavailable)';
	}

	private async clickRetryIfPresent(page: Page): Promise<boolean> {
		const clicked = await this.safeEvaluate(page, () => {
			const btn = Array.from(document.querySelectorAll('button')).find(
				(el) =>
					/^(try again|retry|follow again|do it again)$/i.test(
						(el.textContent || '').trim(),
					) && !(el as HTMLButtonElement).disabled,
			) as HTMLButtonElement | undefined;
			if (!btn) return false;
			btn.click();
			return true;
		});
		if (clicked) {
			console.log('StillHype: clicked retry');
			await timeout(600);
			return true;
		}
		return false;
	}

	private async waitWhileVerifying(page: Page) {
		const deadline = Date.now() + 25_000;
		while (Date.now() < deadline) {
			const url = safePageUrl(page);
			if (SC_AUTHORIZE_RE.test(url) || SC_OAUTH_CALLBACK_RE.test(url)) return;
			if (!(await this.isVerifying(page))) return;
			await timeout(400);
		}
	}

	private async handleEmailStepIfPresent(page: Page) {
		const emailState = await this.safeEvaluate(
			page,
			(skipPattern: string) => {
				const skipRe = new RegExp(skipPattern, 'i');
				const skip = Array.from(document.querySelectorAll('button')).find(
					(btn) =>
						skipRe.test((btn.textContent || '').trim()) &&
						!(btn as HTMLButtonElement).disabled,
				) as HTMLButtonElement | undefined;
				if (skip) {
					skip.click();
					return 'skipped' as const;
				}
				const nameInput = document.querySelector<HTMLInputElement>(
					'input[placeholder="Your name"]',
				);
				const emailInput = document.querySelector<HTMLInputElement>(
					'input[type="email"]',
				);
				if (nameInput || emailInput) return 'form' as const;
				return null;
			},
			SKIP_EMAIL_RE.source,
		);

		if (emailState === 'skipped') {
			await timeout(500);
			return;
		}
		if (emailState !== 'form') return;

		if (!this.config.email) {
			throw new Error(
				'This StillHype gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
			);
		}

		await this.safeEvaluate(
			page,
			(name: string, email: string) => {
				const fill = (el: HTMLInputElement | null, value: string) => {
					if (!el) return;
					const setter = Object.getOwnPropertyDescriptor(
						window.HTMLInputElement.prototype,
						'value',
					)?.set;
					setter?.call(el, value);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				};
				fill(
					document.querySelector<HTMLInputElement>(
						'input[placeholder="Your name"]',
					),
					name,
				);
				fill(
					document.querySelector<HTMLInputElement>('input[type="email"]'),
					email,
				);
				const submit = Array.from(document.querySelectorAll('button')).find(
					(btn) =>
						/^(continue|submit|unlock|join)/i.test(
							(btn.textContent || '').trim(),
						) && !(btn as HTMLButtonElement).disabled,
				) as HTMLButtonElement | undefined;
				submit?.click();
			},
			this.config.name ?? '',
			this.config.email,
		);
		this.emitProgress('handling_gates', 'Submitting StillHype email...', 35, {
			currentGate: 'email',
		});
		await timeout(800);
	}

	/**
	 * Visit the active social or website step's next account. Only the active
	 * step renders its buttons, so this never jumps ahead of a locked step.
	 */
	private async handleSocialStep(page: Page): Promise<string | null> {
		if (page.isClosed()) return null;
		try {
			if (await this.hasFollowConfirm(page)) {
				await this.confirmSocialFollow(page);
				return 'confirm follow';
			}
			const found = await page.evaluateHandle((pattern: string) => {
				const socialPattern = new RegExp(pattern);
				return (
					Array.from(document.querySelectorAll('button')).find(
						(button) =>
							socialPattern.test((button.textContent || '').trim()) &&
							!button.disabled &&
							!button.querySelector('svg') &&
							button.checkVisibility(),
					) ?? null
				);
			}, SOCIAL_BUTTON_RE.source);
			const button = found.asElement() as ElementHandle<Element> | null;
			if (!button) {
				await found.dispose();
				return null;
			}
			let label: string;
			try {
				label = await button.evaluate((el) => (el.textContent || '').trim());
				this.emitProgress('handling_gates', `StillHype: ${label}`, 45, {
					currentGate: 'social',
				});
				// The site counts the click; the tab it opens only needs closing.
				await visitSocialPopup(page, button);
			} finally {
				await button.dispose();
			}
			const confirm = await page
				.waitForSelector(HANDLE_INPUT, { visible: true, timeout: 2_000 })
				.catch(() => null);
			if (confirm) {
				await confirm.dispose();
				await this.confirmSocialFollow(page);
			}
			return label;
		} catch (error) {
			if (isNavigationError(error)) return null;
			throw error;
		}
	}

	private async hasFollowConfirm(page: Page): Promise<boolean> {
		const visible = await this.safeEvaluate(
			page,
			(selector: string) =>
				Array.from(document.querySelectorAll<HTMLElement>(selector)).some(
					(input) => input.checkVisibility(),
				),
			HANDLE_INPUT,
		);
		return visible === true;
	}

	private async confirmSocialFollow(page: Page) {
		const inputName =
			(await this.safeEvaluate(
				page,
				(selector: string) =>
					document
						.querySelector(selector)
						?.getAttribute('aria-label')
						?.replace(/^Your | handle$/g, '') ?? '',
				HANDLE_INPUT,
			)) ?? '';
		const platform = PLATFORM_BY_INPUT_NAME[inputName];
		const handle = platform ? this.socialHandles[platform]?.trim() : undefined;
		if (!handle) {
			await this.waitForManualFollowConfirm(page, inputName || 'social');
			return;
		}

		await this.safeEvaluate(
			page,
			(selector: string, value: string) => {
				const setter = Object.getOwnPropertyDescriptor(
					window.HTMLInputElement.prototype,
					'value',
				)?.set;
				for (const input of document.querySelectorAll<HTMLInputElement>(
					selector,
				)) {
					if (input.value === value) continue;
					setter?.call(input, value);
					input.dispatchEvent(new Event('input', { bubbles: true }));
				}
			},
			HANDLE_INPUT,
			handle,
		);

		// The button counts down first and restarts it when the server says
		// "too soon"; a rejected handle shows an alert.
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const state = await this.safeEvaluate(
				page,
				(selector: string, confirmRe: string) => {
					const pending = Array.from(
						document.querySelectorAll<HTMLElement>(selector),
					).some((input) => input.checkVisibility());
					if (!pending) return 'done';
					const alert = Array.from(
						document.querySelectorAll<HTMLElement>('[role="alert"]'),
					).find((el) => el.checkVisibility() && el.textContent?.trim());
					if (alert) return `error:${alert.textContent?.trim()}`;
					const confirmPattern = new RegExp(confirmRe, 'i');
					const button = Array.from(document.querySelectorAll('button')).find(
						(el) =>
							confirmPattern.test((el.textContent || '').trim()) &&
							!el.disabled,
					);
					button?.click();
					return button ? 'clicked' : 'waiting';
				},
				HANDLE_INPUT,
				CONFIRM_FOLLOW_RE.source,
			);
			if (state === 'done') return;
			if (state?.startsWith('error:'))
				throw new Error(
					`StillHype did not accept your ${inputName} handle: ${state.slice(6)}`,
				);
			await timeout(state === 'clicked' ? 1_000 : 300);
		}
		throw new Error(
			`StillHype did not confirm the ${inputName} follow in time.`,
		);
	}

	private async waitForManualFollowConfirm(page: Page, platform: string) {
		await page.bringToFront().catch(() => {});
		this.emitProgress(
			'handling_gates',
			`Type your own ${platform} handle in the remote browser and confirm the follow to continue.`,
			50,
			{ currentGate: 'social', browserActive: true, requiresAttention: true },
		);
		const deadline = Date.now() + 5 * 60_000;
		while (await this.hasFollowConfirm(page)) {
			if (Date.now() > deadline)
				throw new Error(
					`Confirm the ${platform} follow in the remote browser, then retry the gate download.`,
				);
			await timeout(500);
		}
		this.emitProgress('handling_gates', `${platform} follow confirmed.`, 50, {
			currentGate: 'social',
			browserActive: true,
			requiresAttention: false,
		});
	}

	private async fillCommentIfNeeded(page: Page) {
		const needsComment = await this.safeEvaluate(page, () => {
			// Comment step shows a textarea; post-OAuth CTA is "Tap to confirm…".
			return Boolean(
				document.querySelector('textarea[placeholder*="comment" i]'),
			);
		});
		if (!needsComment) return;

		const comment = this.config.comment.trim();
		if (!comment) {
			throw new Error(
				'This StillHype gate requires SC_COMMENT before commenting on SoundCloud.',
			);
		}

		await this.safeEvaluate(
			page,
			(value: string) => {
				const el = document.querySelector<HTMLTextAreaElement>(
					'textarea[placeholder*="comment" i]',
				);
				if (!el) return;
				const setter = Object.getOwnPropertyDescriptor(
					window.HTMLTextAreaElement.prototype,
					'value',
				)?.set;
				setter?.call(el, value);
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			},
			comment,
		);
		await timeout(200);
	}

	private async clickNextSoundcloudStep(page: Page): Promise<string | null> {
		return this.safeEvaluate(
			page,
			(pattern: string) => {
				const stepPattern = new RegExp(pattern, 'i');
				const btn = Array.from(document.querySelectorAll('button')).find(
					(el) =>
						stepPattern.test((el.textContent || '').trim()) &&
						!(el as HTMLButtonElement).disabled,
				) as HTMLButtonElement | undefined;
				if (!btn) return null;
				const label = (btn.textContent || '').trim();
				btn.click();
				return label;
			},
			SC_STEP_BUTTON_RE.source,
		);
	}

	/**
	 * After a step click: either Verifying… (already authed) or same-tab OAuth.
	 * Avoid evaluate while the document is navigating away.
	 */
	private async waitForStepNavigation(
		page: Page,
	): Promise<'oauth' | 'verifying' | 'timeout'> {
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline) {
			const url = safePageUrl(page);
			if (SC_AUTHORIZE_RE.test(url) || SC_OAUTH_CALLBACK_RE.test(url)) {
				return 'oauth';
			}
			const oauthTab = await this.findSoundcloudOauthPage();
			if (oauthTab && oauthTab !== page) return 'oauth';

			if (STILLHYPE_ORIGIN_RE.test(url)) {
				if (await this.isVerifying(page)) return 'verifying';
				if (await this.hasUnlockButton(page)) return 'verifying';
			}
			await timeout(200);
		}
		return 'timeout';
	}

	private async waitForLateOauth(page: Page, ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const url = safePageUrl(page);
			if (SC_AUTHORIZE_RE.test(url) || SC_OAUTH_CALLBACK_RE.test(url)) {
				return true;
			}
			if (await this.findSoundcloudOauthPage()) return true;
			await timeout(200);
		}
		return false;
	}

	/** Allow on authorize, then wait until we're back on stillhype.io/g/. */
	private async completeSoundcloudOauth(startPage: Page) {
		const hardDeadline = Date.now() + 12 * 60_000;
		let deadline = Date.now() + 120_000;
		let lastAllowAt = 0;
		let lastLog = 0;
		let sawAuthorize = false;
		let allowClicks = 0;

		while (Date.now() < deadline) {
			const oauthPage =
				(await this.findSoundcloudOauthPage()) ??
				(SC_AUTHORIZE_RE.test(safePageUrl(startPage)) && !startPage.isClosed()
					? startPage
					: null) ??
				(await this.findPageWithApprovalButton());

			if (oauthPage && !oauthPage.isClosed()) {
				sawAuthorize = true;
				const canRetry = Date.now() - lastAllowAt > 3_000;
				if (lastAllowAt === 0 || canRetry) {
					const allowed = await this.clickSoundcloudOauthAllow(oauthPage);
					if (allowed) {
						deadline = Math.min(
							hardDeadline,
							Math.max(deadline, Date.now() + 120_000),
						);
						allowClicks += 1;
						lastAllowAt = Date.now();
						console.log(`StillHype: SoundCloud Allow clicked (${allowClicks})`);
						const left = await this.waitUntilLeftAuthorize(oauthPage, 8_000);
						if (left) {
							console.log('StillHype: left authorize after Allow');
						} else {
							console.log(
								'StillHype: still on authorize after Allow — will retry',
							);
						}
						continue;
					}
				}
				await timeout(400);
				continue;
			}

			const live =
				(await this.findStillhypeGatePage()) ??
				(!startPage.isClosed() ? startPage : null);

			if (live) {
				const url = safePageUrl(live);
				if (SC_OAUTH_CALLBACK_RE.test(url)) {
					await timeout(300);
					continue;
				}
				if (/stillhype\.io\/g\//i.test(url) && sawAuthorize) {
					console.log('StillHype: returned from SoundCloud OAuth');
					await timeout(1_500);
					return;
				}
			}

			if (Date.now() - lastLog > 5_000) {
				const urls = (await this.browser.pages(true)).map((p) =>
					p.isClosed() ? '(closed)' : safePageUrl(p) || '(empty)',
				);
				console.log('StillHype OAuth waiting…', urls.join(' | '));
				lastLog = Date.now();
			}

			await timeout(400);
		}

		throw new Error(
			'Timed out waiting for SoundCloud OAuth Allow / StillHype callback.',
		);
	}

	private async waitUntilLeftAuthorize(
		page: Page,
		ms: number,
	): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (page.isClosed()) return true;
			const url = safePageUrl(page);
			if (!SC_AUTHORIZE_RE.test(url)) return true;
			await timeout(200);
		}
		return false;
	}

	private async findStillhypeGatePage(): Promise<Page | null> {
		for (const candidate of await this.browser.pages(true)) {
			if (candidate.isClosed()) continue;
			if (/stillhype\.io\/g\//i.test(safePageUrl(candidate))) return candidate;
		}
		return null;
	}

	private async findSoundcloudOauthPage(): Promise<Page | null> {
		for (const candidate of await this.browser.pages(true)) {
			if (candidate.isClosed()) continue;
			if (SC_AUTHORIZE_RE.test(safePageUrl(candidate))) return candidate;
		}
		return null;
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

	private async clickSoundcloudOauthAllow(oauthPage: Page): Promise<boolean> {
		try {
			await oauthPage.bringToFront();
		} catch {
			// tab may be navigating
		}

		const ready = await oauthPage
			.waitForFunction(
				() => {
					const text = document.body?.innerText || '';
					if (/sign in or create an account/i.test(text)) return 'login';
					if (document.querySelector('#submit_approval')) return 'submit';
					if (
						Array.from(document.querySelectorAll('button')).some((btn) =>
							/^(allow|connect|authorize|accept)$/i.test(
								(btn.textContent || '').trim(),
							),
						)
					) {
						return 'allow';
					}
					return false;
				},
				{ timeout: 20_000 },
			)
			.then(async (handle) => {
				const value = await handle.jsonValue();
				await handle.dispose().catch(() => {});
				return value as string;
			})
			.catch(() => null);

		if (ready === 'login') {
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

		if (ready !== 'submit' && ready !== 'allow') {
			return false;
		}

		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (submit) {
					await submit.click({ delay: 40 });
					await submit.dispose().catch(() => {});
					return true;
				}
			} catch {
				// frame detached
			}
		}

		// Newer authorize UI: plain "Allow" button (no #submit_approval).
		// CloakBrowser ignores synthetic DOM click() — use a trusted pointer click.
		try {
			const handle = await oauthPage.evaluateHandle(() => {
				const btn = Array.from(document.querySelectorAll('button')).find(
					(el) =>
						/^(allow|connect|authorize|accept)$/i.test(
							(el.textContent || '').trim(),
						) && !(el as HTMLButtonElement).disabled,
				);
				return btn ?? null;
			});
			const element = handle.asElement();
			if (element) {
				const button = await element.toElement('button');
				await button.click({ delay: 40 });
				await handle.dispose().catch(() => {});
				return true;
			}
			await handle.dispose().catch(() => {});
		} catch {
			// navigating
		}

		try {
			const box = await oauthPage.evaluate(() => {
				const btn = Array.from(document.querySelectorAll('button')).find(
					(el) =>
						/^(allow|connect|authorize|accept)$/i.test(
							(el.textContent || '').trim(),
						) && !(el as HTMLButtonElement).disabled,
				);
				if (!btn) return null;
				const rect = btn.getBoundingClientRect();
				return {
					x: rect.x + rect.width / 2,
					y: rect.y + rect.height / 2,
				};
			});
			if (box) {
				await oauthPage.mouse.click(box.x, box.y, { delay: 40 });
				return true;
			}
		} catch {
			// navigating
		}

		return false;
	}

	/**
	 * Prefer a URL already captured from `/api/gate/unlock` (auto-fires when all
	 * steps complete). Otherwise click Unlock / Download again and capture.
	 */
	private async handleUnlock(
		page: Page,
		knownUnlockUrl: string | null = null,
	): Promise<string> {
		this.emitProgress('handling_gates', 'Unlocking StillHype download...', 75);

		if (knownUnlockUrl) {
			return await this.saveUnlockedFile(knownUnlockUrl);
		}

		let unlockUrl: string | null = null;
		const onResponse = async (response: HTTPResponse) => {
			try {
				if (!/\/api\/gate\/unlock/i.test(response.url()) || !response.ok()) {
					return;
				}
				const json = (await response.json()) as { download_url?: unknown };
				if (typeof json.download_url === 'string' && json.download_url) {
					unlockUrl = json.download_url;
				}
			} catch {
				// ignore parse errors
			}
		};
		page.on('response', onResponse);

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
		// Abandoned when the unlock URL path returns first.
		downloadCompletePromise.catch(() => {});
		const downloadTimer = setTimeout(
			() =>
				downloadCompleteReject(
					new Error('StillHype download did not complete in time'),
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

		const clickUnlock = async () => {
			const clicked = await this.safeEvaluate(
				page,
				(pattern: string) => {
					const unlockPattern = new RegExp(pattern, 'i');
					const btn = Array.from(document.querySelectorAll('button')).find(
						(el) =>
							unlockPattern.test((el.textContent || '').trim()) &&
							!(el as HTMLButtonElement).disabled,
					) as HTMLButtonElement | undefined;
					if (btn) {
						btn.click();
						return 'button';
					}
					const link = Array.from(document.querySelectorAll('a')).find((el) =>
						unlockPattern.test((el.textContent || '').trim()),
					) as HTMLAnchorElement | undefined;
					if (link) {
						// Prefer fetching href directly when present (signed R2 URL).
						if (link.href && /^https?:/i.test(link.href)) {
							(window as unknown as { __shDl?: string }).__shDl = link.href;
						}
						link.click();
						return 'link';
					}
					return null;
				},
				UNLOCK_BUTTON_RE.source,
			);

			const href = await this.safeEvaluate(
				page,
				() => (window as unknown as { __shDl?: string }).__shDl ?? null,
			);
			if (typeof href === 'string' && href) {
				unlockUrl = href;
			}
			if (!clicked && !unlockUrl) {
				throw new Error('StillHype Unlock / Download again control not found.');
			}
		};

		try {
			await clickUnlock();

			const apiDeadline = Date.now() + 30_000;
			while (!unlockUrl && Date.now() < apiDeadline) {
				if (downloadGuid) break;
				await timeout(200);
			}

			if (unlockUrl) {
				const fileUrl = unlockUrl;
				clearTimeout(downloadTimer);
				pBar.stop();
				page.off('response', onResponse);
				await client.detach().catch(() => {});
				return await this.saveUnlockedFile(fileUrl);
			}

			return await downloadCompletePromise;
		} finally {
			if (this.cancelPendingDownloadWait === cancelPendingDownloadWait) {
				this.cancelPendingDownloadWait = null;
			}
			clearTimeout(downloadTimer);
			pBar.stop();
			page.off('response', onResponse);
			await client.detach().catch(() => {});
		}
	}

	/**
	 * External-download gates unlock the artist's own link (Drive, Dropbox, …),
	 * which the site just opens; fetch it like any other direct link.
	 */
	private async saveUnlockedFile(url: string): Promise<string> {
		if (!this.externalDownload) return this.saveFileFromUrl(url);
		const destination = await resolveGateUrlOrFollow(url).catch(() => null);
		// close() can't reach a downloader that doesn't exist yet.
		if (this.downloadAbortController.signal.aborted)
			throw new Error('Download cancelled');
		if (destination?.provider === 'direct') {
			const direct = new DirectDownloader();
			this.directDownloader = direct;
			// The gate used the browser and SoundCloud; keep offering cleanup.
			const progress = this.progressCallback;
			if (progress)
				direct.setProgressCallback((stage, message, percent, extra) =>
					progress(stage, message, percent, { ...extra, browserless: false }),
				);
			this.downloadFilename = await direct.downloadAudio(destination.url);
			return this.downloadFilename;
		}
		if (destination)
			throw new Error(
				`StillHype unlocked an external ${destination.provider} link (${destination.url}). Download that link as its own job.`,
			);
		return this.saveFileFromUrl(url);
	}

	private async saveFileFromUrl(downloadUrl: string): Promise<string> {
		await mkdir('./downloads', { recursive: true });
		this.emitProgress('downloading', 'Downloading StillHype file...', 0);

		let current = downloadUrl;
		let response: Response | null = null;
		let finalUrl = current;
		const maxRedirects = 10;

		for (let hop = 0; hop < maxRedirects; hop++) {
			const result = await safeFetch(current, {
				headers: { 'User-Agent': USER_AGENT },
				signal: AbortSignal.any([
					this.downloadAbortController.signal,
					AbortSignal.timeout(60_000),
				]),
			});
			finalUrl = result.url;
			response = result.response;
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				await response.body?.cancel().catch(() => {});
				if (!location) {
					throw new Error(
						`StillHype file redirect missing Location from ${current}`,
					);
				}
				current = new URL(location, current).toString();
				continue;
			}
			break;
		}

		if (!response) {
			throw new Error(`StillHype file download failed for ${downloadUrl}`);
		}
		if (response.status >= 300 && response.status < 400) {
			throw new Error(
				`StillHype file download exceeded ${maxRedirects} redirects`,
			);
		}
		if (!response.ok || !response.body) {
			throw new Error(
				`StillHype file download failed (${response.status} ${response.statusText})`,
			);
		}
		// A file host's preview page must not end up saved as audio.
		if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
			await response.body.cancel().catch(() => {});
			throw new Error(
				`StillHype download returned a web page instead of a file: ${finalUrl}`,
			);
		}

		const fromHeader = filenameFromContentDisposition(
			response.headers.get('content-disposition'),
		);
		let suggested =
			sanitizeFilenamePart(basename(fromHeader || '')) ||
			sanitizeFilenamePart(
				safeDecodeURIComponent(basename(new URL(finalUrl).pathname)),
			) ||
			'stillhype-download';
		if (!/\.[a-z0-9]{2,5}$/i.test(suggested)) {
			suggested = `${suggested}.wav`;
		}
		suggested = await reserveDownloadFilename('./downloads', suggested);

		const target = join('./downloads', suggested);
		const totalBytes = Number(response.headers.get('content-length')) || 0;
		const writer = Bun.file(target).writer();
		const reader = response.body.getReader();
		let received = 0;
		let completed = false;
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

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > MAX_DOWNLOAD_BYTES) {
					await reader.cancel();
					throw new Error(
						`StillHype download too large (${received} bytes; max ${MAX_DOWNLOAD_BYTES})`,
					);
				}
				writer.write(value);
				if (totalBytes > 0) {
					if (pBar.isActive) {
						pBar.update(received, {
							total_mb: Number((totalBytes / 1024 / 1024).toFixed(2)),
							current_mb: Number((received / 1024 / 1024).toFixed(2)),
						});
					} else {
						pBar.start(totalBytes, received, { prefix: 'Downloading' });
					}
					this.emitProgress(
						'downloading',
						`Downloading... ${(received / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
						0,
						{ downloadBytes: received, totalBytes },
					);
				}
			}
			await writer.end();
			completed = true;
		} finally {
			pBar.stop();
			if (!completed) {
				try {
					await writer.end();
				} catch {
					// Preserve the download error while cleaning up the partial file.
				}
				await rm(target, { force: true }).catch(() => {});
			}
		}

		this.downloadFilename = suggested;
		console.log('Download completed:', suggested);
		this.emitProgress('downloading', 'Download complete', 100);
		return suggested;
	}
}
