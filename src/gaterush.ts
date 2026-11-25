import { Presets, SingleBar } from 'cli-progress';
import type { Browser, HTTPRequest, HTTPResponse, Page } from 'puppeteer';
import {
	BandcampGateDownloader,
	type BandcampGateOptions,
} from './bandcampGate';
import { CancellableBrowserLaunch } from './browserLaunch';
import { DirectDownloader } from './directDownload';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import { visitSocialPopup } from './socialPopup';
import {
	isSoundcloudLoginPage,
	saveSoundcloudLogin,
	signInToSoundcloud,
	waitForSoundcloudLogin,
} from './soundcloudLogin';
import type { HypedditConfig } from './types';
import {
	isBandcampUrl,
	loadCookies,
	resolveGateUrlOrFollow,
	timeout,
} from './utils';

/** Spotify follow step: honor-system open + confirm, like Instagram. */
const GATERUSH_SPOTIFY_BUTTON =
	'#stepStage .list-btn.svc-spotify, #stepStage .btn-spotify[data-open]';

const FOLLOW_STEPS = {
	instagram: {
		label: 'Instagram',
		gate: 'ig',
		percent: 60,
		buttons: Selectors.GATERUSH_IG_ACCOUNT_BUTTON,
	},
	spotify: {
		label: 'Spotify',
		gate: 'sp',
		percent: 70,
		buttons: GATERUSH_SPOTIFY_BUTTON,
	},
} as const;

export class GaterushDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;
	private cancelPendingDownloadWait: (() => void) | null = null;
	private destinationDownloader:
		| BandcampGateDownloader
		| DirectDownloader
		| null = null;
	private downloadOptions: BandcampGateOptions = {};

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

	async prepareLogins() {
		await signInToSoundcloud(this.browser);
	}

	async downloadAudio(
		url: string,
		options: BandcampGateOptions = {},
	): Promise<string | null> {
		this.downloadOptions = options;
		console.log('Navigating to GateRush gate...');
		this.emitProgress('handling_gates', 'Navigating to GateRush gate...', 25);

		const page = await this.browser.newPage();
		this.downloadFilename = null;
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(url, { waitUntil: 'domcontentloaded' });
			await page.waitForSelector(Selectors.GATERUSH_STEP);
			await this.dismissCookieBanner(page);

			while (true) {
				const next = await page.waitForFunction(
					(selectors) => {
						const download = document.querySelector<HTMLButtonElement>(
							selectors.GATERUSH_DOWNLOAD_BUTTON,
						);
						if (download && !download.disabled) return 'download';
						const step = document.querySelector(selectors.GATERUSH_STEP);
						if (!step || step.classList.contains('leaving')) return false;
						const skip = step.querySelector('[data-skip]');
						if (skip instanceof HTMLElement && skip.checkVisibility())
							return 'skip';
						if (step.querySelector(selectors.GATERUSH_EMAIL_INPUT))
							return 'email';
						if (document.querySelector(selectors.GATERUSH_SC_CONNECT))
							return 'soundcloud';
						if (document.querySelector(selectors.GATERUSH_IG_ACCOUNT_BUTTON))
							return 'instagram';
						if (document.querySelector(selectors.spotify)) return 'spotify';
						return 'unsupported';
					},
					{ timeout: 60_000 },
					{ ...Selectors, spotify: GATERUSH_SPOTIFY_BUTTON },
				);
				const step = await next.jsonValue();
				await next.dispose();
				if (step === 'download') break;

				if (step === 'skip') {
					await this.skipStep(page);
				} else if (step === 'email') {
					this.emitProgress(
						'handling_gates',
						'Submitting GateRush email...',
						30,
						{
							currentGate: 'email',
						},
					);
					await this.handleEmail(page);
				} else if (step === 'soundcloud') {
					this.emitProgress(
						'handling_gates',
						'Connecting SoundCloud on GateRush...',
						45,
						{ currentGate: 'sc' },
					);
					await this.handleSoundcloudConnect(page);
				} else if (step === 'instagram' || step === 'spotify') {
					const { label, gate, percent } = FOLLOW_STEPS[step];
					this.emitProgress(
						'handling_gates',
						`Handling GateRush ${label} follows...`,
						percent,
						{ currentGate: gate },
					);
					await this.handleFollowStep(page, step);
				} else {
					const title = await page.$eval(
						`${Selectors.GATERUSH_STEP} .step-title`,
						(el) => el.textContent?.trim(),
					);
					throw new Error(`Unsupported GateRush step: ${title || 'unknown'}`);
				}
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
		await this.destinationDownloader?.close();
		await this.browserLaunch.close();
	}

	/** The gate owner allowed skipping this step; the server does not require it. */
	private async skipStep(page: Page) {
		const step = await page.$(Selectors.GATERUSH_STEP);
		if (!step) return;
		try {
			await page.$eval(Selectors.GATERUSH_SKIP_BUTTON, (button) =>
				(button as HTMLButtonElement).click(),
			);
			await page.waitForFunction(
				(element) =>
					!element.isConnected || element.classList.contains('leaving'),
				{ timeout: 10_000 },
				step,
			);
		} finally {
			await step.dispose();
		}
	}

	private async dismissCookieBanner(page: Page) {
		if (!(await page.$(Selectors.GATERUSH_COOKIE_REJECT))) return;
		const reloads = await page.$eval(
			'#cookieAdToggle',
			(el) => (el as HTMLInputElement).checked,
		);
		// Rejecting the default advertising consent reloads the gate.
		await Promise.all([
			reloads
				? page.waitForNavigation({ waitUntil: 'domcontentloaded' })
				: Promise.resolve(),
			page.$eval(Selectors.GATERUSH_COOKIE_REJECT, (el) =>
				(el as HTMLButtonElement).click(),
			),
		]);
		await page.waitForSelector(Selectors.GATERUSH_STEP);
	}

	private async handleEmail(page: Page) {
		const fillInput = async (selector: string, value: string) => {
			await page.evaluate(
				(sel, val) => {
					const el = document.querySelector<HTMLInputElement>(sel);
					if (!el) return;
					const setter = Object.getOwnPropertyDescriptor(
						window.HTMLInputElement.prototype,
						'value',
					)?.set;
					setter?.call(el, val);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				},
				selector,
				value,
			);
		};

		const nameInput = await page.$(Selectors.GATERUSH_NAME_INPUT);
		if (nameInput) {
			if (!this.config.name) {
				throw new Error(
					'This GateRush gate requires a name. Set HYPEDDIT_NAME in your .env file.',
				);
			}
			await fillInput(Selectors.GATERUSH_NAME_INPUT, this.config.name);
		}

		const emailInput = await page.$(Selectors.GATERUSH_EMAIL_INPUT);
		if (emailInput) {
			if (!this.config.email) {
				throw new Error(
					'This GateRush gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
				);
			}
			await fillInput(Selectors.GATERUSH_EMAIL_INPUT, this.config.email);
		}

		// Humanized pointer clicks can miss this button on the redesigned layout.
		await page.$eval(Selectors.GATERUSH_EMAIL_SUBMIT, (button) =>
			(button as HTMLButtonElement).click(),
		);

		await page.waitForFunction(
			(selector) => {
				const btn = document.querySelector<HTMLButtonElement>(selector);
				return (
					!btn?.disabled || btn.closest('.step')?.classList.contains('leaving')
				);
			},
			{ timeout: 30_000 },
			Selectors.GATERUSH_EMAIL_SUBMIT,
		);

		const failed = await page.evaluate((selector) => {
			const btn = document.querySelector(selector);
			return !!btn && !btn.closest('.step')?.classList.contains('leaving');
		}, Selectors.GATERUSH_EMAIL_SUBMIT);
		if (failed) {
			throw new Error('GateRush email step did not complete');
		}
		await page.waitForSelector(Selectors.GATERUSH_EMAIL_INPUT, {
			hidden: true,
		});
	}

	private async handleSoundcloudConnect(page: Page) {
		const commentInput = await page.$(Selectors.GATERUSH_COMMENT_INPUT);
		if (commentInput) {
			if (!this.config.comment.trim()) {
				throw new Error(
					'SC_COMMENT is required for GateRush SoundCloud connect.',
				);
			}
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
				Selectors.GATERUSH_COMMENT_INPUT,
				this.config.comment,
			);
			await timeout(200);
		}

		await page.waitForFunction(
			(selector) => {
				const btn = document.querySelector<HTMLButtonElement>(selector);
				return !!btn && !btn.disabled;
			},
			{},
			Selectors.GATERUSH_SC_CONNECT,
		);

		// Single DOM click — page.click() can double-fire under CloakBrowser humanize.
		await page.evaluate((selector) => {
			document.querySelector<HTMLButtonElement>(selector)?.click();
		}, Selectors.GATERUSH_SC_CONNECT);

		await this.completeSoundcloudOauth(page);

		if (!page.url().includes('gaterush.me')) {
			throw new Error(
				'GateRush redirected this tab for SoundCloud OAuth (popup blocked). Re-run with popups allowed or non-headless.',
			);
		}

		await page.waitForSelector(Selectors.GATERUSH_SC_CONNECT, {
			hidden: true,
			timeout: 90_000,
		});
	}

	/**
	 * Wait for SoundCloud authorize + #submit_approval, approve it, then wait for
	 * GateRush to mark the SoundCloud step complete. Never force-closes Allow.
	 */
	private async completeSoundcloudOauth(gatePage: Page) {
		const startedAt = Date.now();
		let deadline = Date.now() + 120_000;
		let lastLog = 0;
		let lastAllowAt = 0;
		let retryAfterLogin = false;
		let retriedAfterLogin = false;

		while (Date.now() < deadline) {
			if (!gatePage.isClosed()) {
				const gateDone = await gatePage
					.evaluate((selectors) => {
						const step = document.querySelector(selectors.GATERUSH_STEP);
						return (
							!!step && !document.querySelector(selectors.GATERUSH_SC_CONNECT)
						);
					}, Selectors)
					.catch(() => false);
				if (gateDone) {
					await saveSoundcloudLogin(gatePage.browserContext());
					console.log('GateRush: SoundCloud step marked completed.');
					return;
				}
			}

			for (const candidate of await this.browser.pages(true)) {
				if (!(await isSoundcloudLoginPage(candidate))) continue;
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
				// GateRush stops watching its popup after 60 seconds, even while
				// the user is still signing in. Finish that popup before retrying.
				retryAfterLogin =
					!retriedAfterLogin && Date.now() - startedAt >= 60_000;
				deadline = Date.now() + 120_000;
				break;
			}

			const authorizePage = await this.findAuthorizePageWithAllow();
			if (authorizePage) {
				// Retry Allow if the form is still up after a previous attempt.
				const canRetry = Date.now() - lastAllowAt > 4_000;
				if (lastAllowAt === 0 || canRetry) {
					const method = await this.clickSoundcloudAllow(authorizePage);
					console.log(
						`GateRush: Allow → ${method} (${authorizePage.url().slice(0, 100)})`,
					);
					if (method !== 'miss') {
						lastAllowAt = Date.now();
						await timeout(2_000);
						continue;
					}
				}
			}

			if (retryAfterLogin) {
				const oauthOpen = (await this.browser.pages(true)).some((candidate) => {
					if (candidate.isClosed() || candidate === gatePage) return false;
					const url = new URL(candidate.url());
					return (
						url.hostname === 'secure.soundcloud.com' ||
						url.pathname === '/callback/soundcloud'
					);
				});
				if (!oauthOpen) {
					const retried = await gatePage.$$eval(
						Selectors.GATERUSH_SC_CONNECT,
						(buttons) => {
							const button = buttons[0] as HTMLButtonElement | undefined;
							if (!button) return false;
							button.click();
							return true;
						},
					);
					if (retried) {
						retryAfterLogin = false;
						retriedAfterLogin = true;
						lastAllowAt = 0;
						deadline = Date.now() + 120_000;
						continue;
					}
				}
			}

			if (Date.now() - lastLog > 5_000) {
				const urls = (await this.browser.pages(true)).map((p) =>
					p.isClosed() ? '(closed)' : p.url(),
				);
				console.log('GateRush OAuth waiting…', urls.join(' | '));
				lastLog = Date.now();
			}

			await timeout(400);
		}

		throw new Error(
			'Timed out waiting for SoundCloud OAuth Allow / GateRush callback.',
		);
	}

	/** Fresh handle for authorize tab that has visible #submit_approval. */
	private async findAuthorizePageWithAllow(): Promise<Page | null> {
		const pages = (await this.browser.pages(true)).filter((p) => !p.isClosed());

		for (const candidate of [...pages].reverse()) {
			if (!/secure\.soundcloud\.com\/authorize/i.test(candidate.url())) {
				continue;
			}
			try {
				for (const frame of candidate.frames()) {
					const hasAllow = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
					if (hasAllow) {
						await hasAllow.dispose().catch(() => {});
						return candidate;
					}
				}
			} catch {
				// detached / navigating
			}
		}

		return null;
	}

	/**
	 * Live authorize HTML:
	 * <form class="connect-form approve-authorize-form">
	 *   <button type="submit" id="submit_approval">Allow</button>
	 * </form>
	 * CloakBrowser ignores plain DOM click() — prefer Puppeteer pointer click.
	 */
	private async clickSoundcloudAllow(oauthPage: Page): Promise<string> {
		try {
			await oauthPage.bringToFront();
		} catch {
			// ignore
		}

		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (!submit) continue;
				await Promise.race([submit.click({ delay: 40 }), timeout(4_000)]);
				await submit.dispose().catch(() => {});
				return 'trusted-click';
			} catch {
				// frame detached / navigating
			}
		}

		for (const frame of oauthPage.frames()) {
			try {
				const method = await frame.evaluate((selector) => {
					const submit = document.querySelector(
						selector,
					) as HTMLButtonElement | null;
					if (!submit) return null;
					const form = submit.closest('form');
					if (form && typeof form.requestSubmit === 'function') {
						form.requestSubmit(submit);
						return 'requestSubmit';
					}
					submit.click();
					return 'dom-click';
				}, Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (method) return method;
			} catch {
				// frame detached / navigating
			}
		}

		return 'miss';
	}

	/**
	 * Instagram and Spotify steps open each profile in a popup, then enable a
	 * confirm control after a short delay; GateRush cannot verify either follow.
	 */
	private async handleFollowStep(page: Page, kind: keyof typeof FOLLOW_STEPS) {
		const {
			label,
			gate,
			percent,
			buttons: buttonSelector,
		} = FOLLOW_STEPS[kind];
		const step = await page.$(Selectors.GATERUSH_STEP);
		if (!step) throw new Error(`GateRush ${label} step was not found.`);
		try {
			const buttons = await page.$$(buttonSelector);
			let needsAttention = false;
			try {
				for (const button of buttons) {
					const pending = await button.evaluate(
						(element) =>
							element instanceof HTMLButtonElement &&
							element.checkVisibility() &&
							!element.disabled &&
							!element.classList.contains('done'),
					);
					if (!pending) continue;
					if (!(await visitSocialPopup(page, button))) {
						needsAttention = true;
						break;
					}
					try {
						await page.waitForFunction(
							(element) => {
								if (!element.isConnected) return true;
								const confirm = element.matches('[data-open]')
									? element
											.closest('.follow-pair')
											?.querySelector('[data-confirm]')
									: element;
								if (confirm?.classList.contains('done')) return true;
								if (
									!(confirm instanceof HTMLButtonElement) ||
									confirm.disabled ||
									!confirm.checkVisibility() ||
									!/^(done|i followed)$/i.test(
										confirm.textContent?.trim() ?? '',
									)
								)
									return false;
								confirm.click();
								return true;
							},
							{ timeout: 10_000 },
							button,
						);
					} catch {
						needsAttention = true;
						break; // Additional interaction is needed; surface the browser below.
					}
				}
			} finally {
				await Promise.all(buttons.map((button) => button.dispose()));
			}
			if (!needsAttention) {
				try {
					await page.waitForFunction(
						(element) =>
							!element.isConnected || element.classList.contains('leaving'),
						{ timeout: 5_000 },
						step,
					);
				} catch {
					needsAttention = true;
				}
			}
			if (needsAttention) {
				await page.bringToFront();
				this.emitProgress(
					'handling_gates',
					`Complete the ${label} follows and confirmations in the remote browser to continue.`,
					percent,
					{ currentGate: gate, browserActive: true, requiresAttention: true },
				);
			}
			// Wait for this step, even when the next step reuses the same selectors.
			await page.waitForFunction(
				(element) =>
					!element.isConnected || element.classList.contains('leaving'),
				{ timeout: 120_000 },
				step,
			);
			this.emitProgress(
				'handling_gates',
				`GateRush ${label} step completed.`,
				percent + 5,
				{
					currentGate: gate,
					browserActive: true,
					requiresAttention: false,
				},
			);
		} catch (cause) {
			throw new Error(
				`Complete the ${label} step in the remote browser, then retry the gate download.`,
				{ cause },
			);
		} finally {
			await step.dispose();
		}
	}

	private async handleDownload(page: Page) {
		this.emitProgress('handling_gates', 'Preparing GateRush download...', 75);

		const reward = await page.evaluate(() => {
			const gate = (
				window as { __GATE__?: { slug?: string; rewardIsLink?: boolean } }
			).__GATE__;
			return { slug: gate?.slug ?? '', isLink: !!gate?.rewardIsLink };
		});
		if (reward.isLink) {
			const destination = await this.readRewardLink(page, reward.slug);
			console.log(`GateRush link reward: ${destination}`);
			await this.downloadRewardLink(page, destination);
			return;
		}

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
					new Error('GateRush download did not complete in time'),
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
			await page.click(Selectors.GATERUSH_DOWNLOAD_BUTTON);
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

	/**
	 * GateRush answers `/download/:slug` for a link reward with a redirect to
	 * the artist's link (the Open button sends it to a new tab). Navigate the
	 * gate tab there and stop at the redirect so only its target is read.
	 */
	private async readRewardLink(page: Page, slug: string): Promise<string> {
		if (!slug) throw new Error('GateRush link reward is missing its gate id.');
		const downloadUrl = new URL(
			`/download/${encodeURIComponent(slug)}`,
			page.url(),
		).href;
		let resolveLink!: (url: string) => void;
		let rejectLink!: (error: Error) => void;
		const link = new Promise<string>((resolve, reject) => {
			resolveLink = resolve;
			rejectLink = reject;
		});
		// It can reject before it is awaited; `await link` still throws.
		link.catch(() => {});
		const onRequest = (request: HTTPRequest) => {
			if (request.isInterceptResolutionHandled()) return;
			if (request.redirectChain()[0]?.url() === downloadUrl) {
				resolveLink(request.url());
				void request.abort('aborted').catch(() => {});
				return;
			}
			void request.continue().catch(() => {});
		};
		const onResponse = (response: HTTPResponse) => {
			if (response.url() !== downloadUrl) return;
			const status = response.status();
			if (status < 300 || status >= 400)
				rejectLink(
					new Error(
						`GateRush did not unlock the link reward (HTTP ${status}). Review the gate in the remote browser.`,
					),
				);
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			timer = setTimeout(
				() => rejectLink(new Error('GateRush did not open the link reward.')),
				30_000,
			);
			await page.setRequestInterception(true);
			page.on('request', onRequest);
			page.on('response', onResponse);
			await page.evaluate((href) => window.location.assign(href), downloadUrl);
			const destination = await link;
			if (new URL(destination).hostname === new URL(downloadUrl).hostname) {
				throw new Error(
					'GateRush sent the link reward back to the gate. Review the gate in the remote browser.',
				);
			}
			return destination;
		} finally {
			clearTimeout(timer);
			page.off('request', onRequest);
			page.off('response', onResponse);
			await page.setRequestInterception(false).catch(() => {});
		}
	}

	/** Hand the unlocked link to the Bandcamp or direct-file downloader. */
	private async downloadRewardLink(page: Page, destination: string) {
		let target = destination;
		let recognized = isBandcampUrl(target);
		if (!recognized) {
			const resolved = await resolveGateUrlOrFollow(target);
			if (
				resolved?.provider === 'bandcamp' ||
				resolved?.provider === 'direct'
			) {
				target = resolved.url;
				recognized = true;
			} else if (resolved) {
				throw new Error(
					`GateRush unlocked a ${resolved.provider} link: ${resolved.url}. Download it from that URL instead.`,
				);
			}
		}

		if (isBandcampUrl(target)) {
			const bandcamp = new BandcampGateDownloader(
				page,
				this.progressCallback ?? undefined,
				this.config.browserMode === 'headed',
			);
			this.destinationDownloader = bandcamp;
			const result = await bandcamp.downloadAudio(target, this.downloadOptions);
			this.downloadFilename = result.filename;
			return;
		}

		await page.goto('about:blank');
		const direct = new DirectDownloader();
		this.destinationDownloader = direct;
		if (this.progressCallback)
			direct.setProgressCallback((stage, message, percent, extra) =>
				this.progressCallback?.(stage, message, percent, {
					...extra,
					browserless: false,
				}),
			);
		try {
			this.downloadFilename = await direct.downloadAudio(target);
		} catch (cause) {
			if (recognized || (cause instanceof Error && cause.name === 'AbortError'))
				throw cause;
			// e.g. a Laylo drop, which texts the file to fans who RSVP by phone.
			throw new Error(
				`GateRush unlocked ${destination}, which is neither a direct download nor a supported source. Open it in a browser to get the file.`,
				{ cause },
			);
		}
	}
}
