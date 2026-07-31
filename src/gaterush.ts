import { Presets, SingleBar } from 'cli-progress';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import type { HypedditConfig } from './types';
import { loadCookies, timeout } from './utils';

export class GaterushDownloader {
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
				'GateRush: SoundCloud captcha present during login warm-up; solve it in the browser window if needed.',
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
		console.log('Navigating to GateRush gate...');
		this.emitProgress('handling_gates', 'Navigating to GateRush gate...', 25);

		const page = await this.browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		try {
			await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
		} catch {
			// continue
		}

		await this.dismissCookieBanner(page);

		if (await page.$(Selectors.GATERUSH_EMAIL_FORM)) {
			this.emitProgress('handling_gates', 'Submitting GateRush email...', 30, {
				currentGate: 'email',
			});
			await this.handleEmail(page);
		}

		if (await page.$(Selectors.GATERUSH_SC_CONNECT)) {
			this.emitProgress(
				'handling_gates',
				'Connecting SoundCloud on GateRush...',
				45,
				{ currentGate: 'sc' },
			);
			await this.handleSoundcloudConnect(page);
		}

		if (await page.$(Selectors.GATERUSH_IG_ACCOUNT_BUTTON)) {
			this.emitProgress(
				'handling_gates',
				'Handling GateRush Instagram follows...',
				60,
				{ currentGate: 'ig' },
			);
			await this.handleInstagram(page);
		}

		await page.waitForFunction(
			(selector) => {
				const btn = document.querySelector<HTMLButtonElement>(selector);
				return !!btn && !btn.disabled;
			},
			{ timeout: 60_000 },
			Selectors.GATERUSH_DOWNLOAD_BUTTON,
		);

		await this.handleDownload(page);
		await page.close();
		return this.downloadFilename;
	}

	async close() {
		await this.browser?.close();
	}

	private async dismissCookieBanner(page: Page) {
		const accepted = await page.evaluate((selector) => {
			const btn = document.querySelector<HTMLButtonElement>(selector);
			if (!btn) return false;
			btn.click();
			return true;
		}, Selectors.GATERUSH_COOKIE_ACCEPT);
		if (accepted) {
			await timeout(500);
		}
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

		await page.click(Selectors.GATERUSH_EMAIL_SUBMIT);

		await page.waitForFunction(
			(selector) => {
				const step = document.querySelector(
					`.progress-step[data-action="email"]`,
				);
				if (step?.classList.contains('completed')) return true;
				const btn = document.querySelector<HTMLButtonElement>(selector);
				return !!btn && btn.textContent === 'SUBMIT' && !btn.disabled;
			},
			{ timeout: 30_000 },
			Selectors.GATERUSH_EMAIL_SUBMIT,
		);

		const emailDone = await page.evaluate(
			() =>
				document
					.querySelector('.progress-step[data-action="email"]')
					?.classList.contains('completed') === true,
		);
		if (!emailDone) {
			// SUBMIT returned to idle without completing — likely validation/API error
			await timeout(1_000);
			const stillIncomplete = await page.evaluate(
				() =>
					document
						.querySelector('.progress-step[data-action="email"]')
						?.classList.contains('completed') !== true,
			);
			if (stillIncomplete) {
				throw new Error('GateRush email step did not complete');
			}
		}
	}

	private async handleSoundcloudConnect(page: Page) {
		const commentForm = await page.$(Selectors.GATERUSH_COMMENT_FORM);
		const commentInput = await page.$(Selectors.GATERUSH_COMMENT_INPUT);
		if (commentForm && commentInput) {
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

		await page.waitForFunction(
			() => {
				const step = document.querySelector(
					'.progress-step[data-action="soundcloud"]',
				);
				if (step?.classList.contains('completed')) return true;
				const download =
					document.querySelector<HTMLButtonElement>('#btnDownload');
				return !!download && !download.disabled;
			},
			{ timeout: 90_000 },
		);
		await timeout(800);
	}

	/**
	 * Wait for SoundCloud authorize + #submit_approval, approve it, then wait for
	 * GateRush to mark the SoundCloud step complete. Never force-closes Allow.
	 */
	private async completeSoundcloudOauth(gatePage: Page) {
		const deadline = Date.now() + 120_000;
		let lastLog = 0;
		let lastAllowAt = 0;

		while (Date.now() < deadline) {
			if (!gatePage.isClosed()) {
				const gateDone = await gatePage
					.evaluate(() => {
						const step = document.querySelector(
							'.progress-step[data-action="soundcloud"]',
						);
						return step?.classList.contains('completed') === true;
					})
					.catch(() => false);
				if (gateDone) {
					console.log('GateRush: SoundCloud step marked completed.');
					return;
				}
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

	private async handleInstagram(page: Page) {
		const deadline = Date.now() + 120_000;
		let previousIndex = -1;
		let repeats = 0;
		while (Date.now() < deadline) {
			const nextIndex = await page.evaluate((selector) => {
				const buttons = Array.from(
					document.querySelectorAll<HTMLButtonElement>(selector),
				);
				return buttons.findIndex(
					(btn) => !btn.disabled && !/opened|✓/i.test(btn.textContent || ''),
				);
			}, Selectors.GATERUSH_IG_ACCOUNT_BUTTON);

			if (nextIndex < 0) {
				break;
			}

			repeats = nextIndex === previousIndex ? repeats + 1 : 0;
			previousIndex = nextIndex;
			if (repeats >= 3) {
				throw new Error(
					`GateRush Instagram step stalled on account button ${nextIndex}`,
				);
			}

			const pagesBefore = new Set(await this.browser.pages(true));

			await page.evaluate(
				(selector, index) => {
					const buttons = Array.from(
						document.querySelectorAll<HTMLButtonElement>(selector),
					);
					buttons[index]?.click();
				},
				Selectors.GATERUSH_IG_ACCOUNT_BUTTON,
				nextIndex,
			);

			let popup: Page | undefined;
			const started = Date.now();
			while (!popup && Date.now() - started < 5_000) {
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
							!candidate.url().includes('gaterush.me') &&
							candidate.url() !== 'about:blank',
					);
				}
				if (!popup) await timeout(200);
			}

			if (popup && !popup.isClosed()) {
				try {
					await popup.close();
				} catch {
					// already closed
				}
			}

			await timeout(500);
		}

		if (Date.now() >= deadline) {
			throw new Error('GateRush Instagram step timed out');
		}

		// Wait for IG step completion (server-side gate-step POST)
		await page.waitForFunction(
			() => {
				const step = document.querySelector(
					'.progress-step[data-action="instagram"]',
				);
				if (!step) return true;
				return step.classList.contains('completed');
			},
			{ timeout: 30_000 },
		);
		await timeout(500);
	}

	private async handleDownload(page: Page) {
		this.emitProgress('downloading', 'Preparing GateRush download...', 75);

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
			await page.click(Selectors.GATERUSH_DOWNLOAD_BUTTON);
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
