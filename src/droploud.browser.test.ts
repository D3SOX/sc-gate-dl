import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { DroploudDownloader } from './droploud';
import { SoundcloudClient } from './soundcloud';
import * as utils from './utils';

let browser: Browser;
let page: Page;

beforeAll(async () => {
	browser = await launchAppBrowser({ headless: true, humanize: false });
	page = await browser.newPage();
});

afterAll(async () => {
	await browser?.close();
});

test('reposts the requested track, not an unrelated track embedded earlier in the page', async () => {
	const previousClient = process.env.SC_CLIENT_ID;
	const previousToken = process.env.SC_OAUTH_TOKEN;
	process.env.SC_CLIENT_ID = 'test-client';
	process.env.SC_OAUTH_TOKEN = 'test-token';
	const cookies = spyOn(utils, 'loadCookies').mockResolvedValue([]);
	const getTrack = spyOn(
		SoundcloudClient.prototype,
		'getTrack',
	).mockResolvedValue({ id: 222 } as Awaited<
		ReturnType<SoundcloudClient['getTrack']>
	>);
	try {
		await page.setContent(`
			<div>soundcloud:tracks:111</div><div>soundcloud:tracks:222</div>
			<script>
			Object.defineProperty(document, 'cookie', { get: () => '' });
			window.fetch = async (_url, options) => {
				window.requestedUrn = JSON.parse(options.body).variables.trackUrn;
				return { ok: true, status: 200, text: async () => JSON.stringify({ data: { repostTrack: { __typename: 'Repost' } } }) };
			};
			</script>
		`);
		const downloader = new DroploudDownloader({
			comment: 'test',
			browserMode: 'headless',
		});
		const gate = downloader as unknown as {
			repostViaPageFetch(page: Page, url: string): Promise<boolean>;
		};
		expect(
			await gate.repostViaPageFetch(
				page,
				'https://soundcloud.com/artist/requested',
			),
		).toBe(true);
		expect(
			await page.evaluate(
				() => (window as unknown as { requestedUrn: string }).requestedUrn,
			),
		).toBe('soundcloud:tracks:222');
	} finally {
		cookies.mockRestore();
		getTrack.mockRestore();
		if (previousClient === undefined) delete process.env.SC_CLIENT_ID;
		else process.env.SC_CLIENT_ID = previousClient;
		if (previousToken === undefined) delete process.env.SC_OAUTH_TOKEN;
		else process.env.SC_OAUTH_TOKEN = previousToken;
	}
});

test('does not repost an arbitrary page track when the requested URL cannot be resolved', async () => {
	const getTrack = spyOn(
		SoundcloudClient.prototype,
		'getTrack',
	).mockRejectedValue(new Error('resolve failed'));
	try {
		await page.setContent('<div>soundcloud:tracks:111</div>');
		const downloader = new DroploudDownloader({
			comment: 'test',
			browserMode: 'headless',
		});
		const gate = downloader as unknown as {
			repostViaPageFetch(page: Page, url: string): Promise<boolean>;
		};
		expect(
			await gate.repostViaPageFetch(
				page,
				'https://soundcloud.com/artist/requested',
			),
		).toBe(false);
	} finally {
		getTrack.mockRestore();
	}
});

test.each([
	['initial email form', 'ds-gate-pane', 'dltg-email', 'Free download'],
	['legacy email step', 'dtr-email-wrap', 'legacy-email', 'Continue'],
])(
	'submits the %s and waits for the next gate step',
	async (_name, wrapper, id, label) => {
		await page.setContent(`
		<form class="${wrapper}">
			<h2 class="ds-gate-t">Enter email</h2>
			<input type="email" id="${id}" name="email">
			<label><input type="checkbox" name="consent" required>Consent</label>
			<button type="submit" disabled>${label}</button>
		</form>
		<script>
		(() => {
			const form = document.querySelector('form');
			const email = form.querySelector('input[type=email]');
			const consent = form.querySelector('input[type=checkbox]');
			const button = form.querySelector('button');
			let acceptedEmail = '';
			const update = () => { button.disabled = !(acceptedEmail && consent.checked); };
			email.addEventListener('input', event => { if (event.isTrusted) { acceptedEmail = email.value; update(); } });
			consent.addEventListener('change', update);
			form.addEventListener('submit', event => {
				event.preventDefault();
				if (email.value !== 'listener@example.test' || !consent.checked) return;
				setTimeout(() => { form.outerHTML = '<div class="ds-gate-pane"><h2 class="ds-gate-t">Next step</h2></div>'; }, 100);
			});
		})();
		</script>
	`);
		const downloader = new DroploudDownloader({
			email: 'listener@example.test',
			comment: 'test',
			browserMode: 'headless',
		});
		const gate = downloader as unknown as {
			detectPaneKind(page: Page): Promise<string>;
			handleEmailStep(page: Page): Promise<void>;
		};
		expect(await gate.detectPaneKind(page)).toBe('email');
		await gate.handleEmailStep(page);
		expect(await page.$eval('.ds-gate-t', (el) => el.textContent)).toBe(
			'Next step',
		);
	},
	15_000,
);

test('does not mistake an unrelated email field for a Droploud email step', async () => {
	await page.setContent(
		'<input type="email"><div class="ds-gate-pane"><h2 class="ds-gate-t">Other step</h2></div>',
	);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	expect(
		await (
			downloader as unknown as { detectPaneKind(page: Page): Promise<string> }
		).detectPaneKind(page),
	).toBe('unknown');
});

test('opens each Instagram link once before confirming a multi-account step', async () => {
	await page.setContent(`
		<div class="ds-gate-pane">
			<h2 class="ds-gate-t">Follow 3 accounts on Instagram</h2>
			<button data-open="0">Open Instagram, @one</button>
			<button data-open="1">Open Instagram, @two</button>
			<button data-open="2">Open Instagram, @three</button>
			<button data-confirm class="ds-disabled" aria-disabled="true">I've done it</button>
		</div>
		<script>
		(() => {
			const seen = [];
			window.openedAccounts = seen;
			document.querySelectorAll('[data-open]').forEach(button => {
				button.onclick = () => {
					seen.push(button.dataset.open);
					if (new Set(seen).size === 3) {
						const confirm = document.querySelector('[data-confirm]');
						confirm.classList.remove('ds-disabled');
						confirm.setAttribute('aria-disabled', 'false');
					}
				};
			});
			document.querySelector('[data-confirm]').onclick = () => {
				document.querySelector('.ds-gate-pane').innerHTML = '<h2 class="ds-gate-t">Next step</h2>';
			};
		})();
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, {
		browser,
		closeSocialPopup: async () => {},
	});
	await (
		downloader as unknown as { handleSocialCards(page: Page): Promise<void> }
	).handleSocialCards(page);
	expect(
		await page.evaluate(
			() => (window as unknown as { openedAccounts: string[] }).openedAccounts,
		),
	).toEqual(['0', '1', '2']);
	expect(await page.$eval('.ds-gate-t', (element) => element.textContent)).toBe(
		'Next step',
	);
}, 15_000);

test('opens each card again when the next social step reuses labels', async () => {
	await page.setContent(`
		<div class="ds-gate-pane"></div>
		<script>
		(() => {
			const pane = document.querySelector('.ds-gate-pane');
			window.openedAccounts = [];
			function render(step) {
				pane.innerHTML = '<h2 class="ds-gate-t">Spotify step ' + step + '</h2>' +
					'<button data-open="0">Open Spotify</button>' +
					'<button data-open="1">Open Spotify, Spotify 2</button>' +
					'<button data-confirm disabled>I&#39;ve done it</button>';
				const opened = new Set();
				pane.querySelectorAll('[data-open]').forEach(button => {
					button.onclick = () => {
						window.openedAccounts.push(step + ':' + button.dataset.open);
						opened.add(button.dataset.open);
						if (opened.size === 2) pane.querySelector('[data-confirm]').disabled = false;
					};
				});
				pane.querySelector('[data-confirm]').onclick = () => {
					if (step === 1) render(2);
					else pane.innerHTML = '<h2 class="ds-gate-t">Next step</h2>';
				};
			}
			render(1);
		})();
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, { browser, closeSocialPopup: async () => {} });
	await (
		downloader as unknown as { handleSocialCards(page: Page): Promise<void> }
	).handleSocialCards(page);
	expect(
		await page.evaluate(
			() => (window as unknown as { openedAccounts: string[] }).openedAccounts,
		),
	).toEqual(['1:0', '1:1', '2:0', '2:1']);
	expect(await page.$eval('.ds-gate-t', (element) => element.textContent)).toBe(
		'Next step',
	);
}, 20_000);

test('waits for a delayed social confirmation after opening all links', async () => {
	await page.setContent(`
		<div class="ds-gate-pane">
			<h2 class="ds-gate-t">Follow on Instagram</h2>
			<button data-open>Open Instagram, @one</button>
			<button data-confirm class="ds-disabled" aria-disabled="true">I've done it</button>
		</div>
		<script>
		(() => {
			document.querySelector('[data-open]').onclick = () => {
				setTimeout(() => {
					const confirm = document.querySelector('[data-confirm]');
					confirm.classList.remove('ds-disabled');
					confirm.setAttribute('aria-disabled', 'false');
				}, 500);
			};
			document.querySelector('[data-confirm]').onclick = () => {
				document.querySelector('.ds-gate-pane').innerHTML = '<h2 class="ds-gate-t">Next step</h2>';
			};
		})();
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, { browser, closeSocialPopup: async () => {} });
	await (
		downloader as unknown as { handleSocialCards(page: Page): Promise<void> }
	).handleSocialCards(page);
	expect(await page.$eval('.ds-gate-t', (element) => element.textContent)).toBe(
		'Next step',
	);
}, 15_000);

test('recognizes and verifies a repost step after SoundCloud authorization', async () => {
	await page.setContent(`
		<section class="ds-gate-card"><div class="ds-gate-pane">
			<h2 class="ds-gate-t">Repost the track</h2>
			<button id="verify">Verify</button>
			<button>Back to SoundCloud</button>
		</div></section>
		<script>
			document.getElementById('verify').onclick = () => {
				document.querySelector('.ds-gate-pane').innerHTML = '<h2 class="ds-gate-t">Email</h2>';
			};
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, { ensureRepostBeforeVerify: async () => {} });
	const gate = downloader as unknown as {
		detectPaneKind(page: Page): Promise<string>;
		handleRepostVerify(page: Page, trackUrl: string): Promise<void>;
	};
	expect(await gate.detectPaneKind(page)).toBe('repost_verify');
	await gate.handleRepostVerify(page, 'https://soundcloud.com/artist/track');
	expect(await page.$eval('.ds-gate-t', (element) => element.textContent)).toBe(
		'Email',
	);
});

test('recognizes a repost verification step before any social cards', async () => {
	await page.setContent(`
		<div class="ds-gate-pane">
			<h2 class="ds-gate-t">Repost the track</h2>
			<button>Verify</button>
			<button>Back to SoundCloud</button>
		</div>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	expect(
		await (
			downloader as unknown as { detectPaneKind(page: Page): Promise<string> }
		).detectPaneKind(page),
	).toBe('repost_verify');
});

test('recognizes the redesigned unlocked download button', async () => {
	await page.setContent(`
		<section class="ds-gate-card"><div class="ds-gate-pane">
			<h2 class="ds-gate-t">Download unlocked</h2>
			<button class="ds-btn ds-h40 ds-solid ds-gate-wide">Download</button>
		</div></section>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	const gate = downloader as unknown as {
		detectPaneKind(page: Page): Promise<string>;
	};
	expect(await gate.detectPaneKind(page)).toBe('unlocked');
});

test('does not classify a disabled download button as unlocked', async () => {
	await page.setContent(`
		<div class="ds-gate-pane">
			<h2 class="ds-gate-t">Processing download</h2>
			<button disabled>Download</button>
		</div>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	const gate = downloader as unknown as {
		detectPaneKind(page: Page): Promise<string>;
	};
	expect(await gate.detectPaneKind(page)).toBe('unknown');
});

test('starts the browser download from the redesigned unlocked button', async () => {
	await page.setContent(`
		<section class="ds-gate-card"><div class="ds-gate-pane">
			<h2 class="ds-gate-t">Download unlocked</h2>
			<button class="ds-btn ds-h40 ds-solid ds-gate-wide">Download</button>
		</div></section>
		<script>
			document.querySelector('button').onclick = () => {
				const file = new Blob(['test audio'], { type: 'audio/mpeg' });
				const link = document.createElement('a');
				link.href = URL.createObjectURL(file);
				link.download = 'fixture.mp3';
				link.click();
			};
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	await (
		downloader as unknown as { handleDownload(page: Page): Promise<void> }
	).handleDownload(page);
}, 15_000);

test('repost verification fails visibly when the gate stays on the same step', async () => {
	await page.setContent(
		'<div class="ds-gate-pane"><h2 class="ds-gate-t">Repost the track</h2><button>Verify</button></div>',
	);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, { ensureRepostBeforeVerify: async () => {} });
	const gate = downloader as unknown as {
		handleRepostVerify(page: Page, trackUrl: string): Promise<void>;
	};
	const wait = page.waitForFunction;
	page.waitForFunction = (() =>
		Promise.reject(new Error('Timed out'))) as typeof page.waitForFunction;
	try {
		await expect(
			gate.handleRepostVerify(page, 'https://soundcloud.com/artist/track'),
		).rejects.toThrow('Timed out');
	} finally {
		page.waitForFunction = wait;
	}
});

test('reports a rejected repost verification without waiting for the full timeout', async () => {
	await page.setContent(`
		<div class="ds-gate-pane"><h2 class="ds-gate-t">Repost the track</h2>
		<p>Connected as @example</p><button id="verify">Verify</button></div>
		<script>
			document.getElementById('verify').onclick = () => {
				document.getElementById('verify').textContent = 'Verify again';
			};
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, { ensureRepostBeforeVerify: async () => {} });
	const gate = downloader as unknown as {
		handleRepostVerify(page: Page, trackUrl: string): Promise<void>;
	};
	await expect(
		gate.handleRepostVerify(page, 'https://soundcloud.com/artist/track'),
	).rejects.toThrow('could not verify');
}, 8_000);
