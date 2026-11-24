import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { StillhypeDownloader, type StillhypeSocialHandles } from './stillhype';

const GATE_URL = 'https://www.stillhype.io/g/fixture';
const FILE_URL = 'https://files.example.test/track.wav';

interface Step {
	id: string;
	type: string;
	label: string;
	required: boolean;
	target_user_id?: string;
	follow_accounts?: { url: string; username: string }[];
}

// The gate's step list reduced to plain DOM code, following the live bundle
// (/_next/static/chunks/7070-*.js): steps unlock in order and only the active
// one renders controls; follow and website buttons open a noopener tab; with
// enhancedFollow a follow needs a countdown, the fan's own handle and
// "I've followed" (POST /api/gate/mark-complete), which rejects the artist's
// own account. Finishing every step POSTs /api/gate/unlock.
function gatePage(steps: Step[], enhanced: boolean) {
	return `<div id="app"></div>
<script>
const steps = ${JSON.stringify(steps)};
const enhanced = ${enhanced};
const names = { instagram_follow: 'Instagram', tiktok_follow: 'TikTok', twitter_follow: 'X', youtube_follow: 'YouTube' };
const done = new Set();
const pending = {};
let handle = '';
let error = '';
const units = (s) => s.follow_accounts?.length > 1 ? s.follow_accounts.map((a) => s.id + ':' + encodeURIComponent(a.url)) : [s.id];
const stepDone = (s) => units(s).every((u) => done.has(u));
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function el(tag, text, props = {}) { const e = document.createElement(tag); if (text) e.textContent = text; Object.assign(e, props); return e; }
function visit(url) { window.open(url, '_blank', 'noopener,noreferrer'); }
// Without enhancedFollow a click alone completes the unit.
function clicked(unit) { post('/api/gate/mark-complete', { unit_id: unit }); complete(unit); }
async function complete(...ids) {
  for (const id of ids) { done.add(id); delete pending[id]; }
  render();
  if (!steps.every(stepDone)) return;
  const response = await post('/api/gate/unlock', { completed_steps: [...done] });
  document.body.dataset.unlocked = (await response.json()).download_url;
}
function render() {
  const app = document.querySelector('#app');
  app.replaceChildren(el('span', steps.filter(stepDone).length + ' of ' + steps.length + ' done'));
  const active = steps.find((s) => !stepDone(s));
  for (const s of steps) {
    const card = el('div');
    card.append(el('p', s.label));
    if (s === active) controls(s, card);
    else card.append(el('span', stepDone(s) ? 'Done' : 'Locked'));
    app.append(card);
  }
}
function controls(s, card) {
  if (s.type === 'email_capture') {
    card.append(el('input', '', { type: 'text', placeholder: 'Your name' }), el('input', '', { type: 'email', placeholder: 'your@email.com' }), el('button', 'Continue'));
  } else if (s.type === 'website_visit') {
    card.append(el('button', 'Visit website ↗', { onclick: () => { visit(s.target_user_id); clicked(s.id); } }));
  } else {
    const name = names[s.type];
    s.follow_accounts.forEach((account, i) => {
      const unit = units(s)[i];
      if (done.has(unit)) {
        if (enhanced) return card.append(el('div', '✓ Followed ' + account.username));
        const again = el('button', ' Follow ' + account.username + ' ↗', { onclick: () => visit(account.url) });
        again.prepend(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
        return card.append(again);
      }
      if (!enhanced || pending[unit] === undefined)
        return card.append(el('button', 'Follow ' + account.username + ' ↗', { onclick: () => {
          visit(account.url);
          if (!enhanced) return clicked(unit);
          pending[unit] = Date.now() + 1500;
          post('/api/gate/social-click', { unit_id: unit });
          render();
        } }));
      const left = Math.max(0, Math.ceil((pending[unit] - Date.now()) / 1000));
      const input = el('input', '', { type: 'text', value: handle, oninput: (e) => { handle = e.target.value; error = ''; render(); } });
      input.setAttribute('aria-label', 'Your ' + name + ' handle');
      card.append(input);
      if (error) card.append(el('p', error, { role: 'alert' }));
      const ready = left === 0 && handle !== '';
      card.append(el('button', left > 0 ? 'Confirm in ' + left + 's' : handle ? "I've followed" : 'Enter your ' + name + ' handle above', { disabled: !ready, onclick: async () => {
        await post('/api/gate/mark-complete', { unit_id: unit, handle });
        if (handle === account.username) { error = "That's " + account.username + "'s own account. Enter your own " + name + ' handle.'; render(); return; }
        complete(unit);
      } }));
    });
  }
  if (!s.required) card.append(el('button', 'Skip for now', { onclick: () => complete(...units(s)) }));
}
setInterval(() => { if (Object.keys(pending).length) render(); }, 250);
render();
</script>`;
}

describe('StillHype social and website steps', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function runGate(
		context: BrowserContext,
		steps: Step[],
		options: {
			enhanced: boolean;
			handles?: StillhypeSocialHandles;
			onAttention?: (page: Page) => Promise<void>;
		},
	) {
		const page = await context.newPage();
		const posts: { path: string; body: unknown }[] = [];
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const url = new URL(request.url());
			if (url.pathname.startsWith('/api/')) {
				posts.push({
					path: url.pathname,
					body: JSON.parse(request.postData() ?? '{}'),
				});
				void request.respond({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(
						url.pathname === '/api/gate/unlock'
							? { download_url: FILE_URL }
							: { ok: true },
					),
				});
				return;
			}
			void request.respond({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: gatePage(steps, options.enhanced),
			});
		});
		const downloader = new StillhypeDownloader(
			{ browserMode: 'headless', comment: '' },
			options.handles,
		);
		const attention: boolean[] = [];
		downloader.setProgressCallback((_stage, _message, _percent, extra) => {
			if (extra?.requiresAttention === undefined) return;
			attention.push(extra.requiresAttention);
			if (extra.requiresAttention) void options.onAttention?.(page);
		});
		let saved: string | null = null;
		Object.assign(downloader, {
			browser: {
				newPage: async () => page,
				pages: () => context.pages(),
			},
			saveFileFromUrl: async (url: string) => {
				saved = url;
				return 'track.wav';
			},
		});
		const run = downloader.downloadAudio(GATE_URL);
		return {
			run,
			page,
			posts,
			attention,
			saved: () => saved,
		};
	}

	const noVisitTabsLeft = async (context: BrowserContext) =>
		!(await context.pages()).some((p) => p.url().includes('-visit'));

	test('skips optional email, visits the website and each X account, then unlocks', async () => {
		const context = await browser.createBrowserContext();
		const unrelated = await context.newPage();
		await unrelated.goto('about:blank#x-visit-existing');
		try {
			const gate = await runGate(
				context,
				[
					{
						id: 'email',
						type: 'email_capture',
						label: 'Email',
						required: false,
					},
					{
						id: 'web',
						type: 'website_visit',
						label: 'Visit website',
						required: true,
						target_user_id: 'about:blank#website-visit',
					},
					{
						id: 'tw',
						type: 'twitter_follow',
						label: 'Follow on X / Twitter',
						required: true,
						follow_accounts: [
							{ url: 'about:blank#x1-visit', username: 'first' },
							{ url: 'about:blank#x2-visit', username: 'second' },
						],
					},
				],
				{ enhanced: false },
			);
			expect(await gate.run).toBe('track.wav');
			expect(gate.saved()).toBe(FILE_URL);
			expect(gate.posts).toEqual([
				{ path: '/api/gate/mark-complete', body: { unit_id: 'web' } },
				...['about:blank#x1-visit', 'about:blank#x2-visit'].map((url) => ({
					path: '/api/gate/mark-complete',
					body: { unit_id: `tw:${encodeURIComponent(url)}` },
				})),
				{
					path: '/api/gate/unlock',
					body: {
						completed_steps: [
							'email',
							'web',
							'tw:about%3Ablank%23x1-visit',
							'tw:about%3Ablank%23x2-visit',
						],
					},
				},
			]);
			expect(gate.attention).toEqual([]);
			expect(unrelated.isClosed()).toBeFalse();
			await unrelated.close();
			expect(await noVisitTabsLeft(context)).toBeTrue();
		} finally {
			await context.close();
		}
	}, 60_000);

	const instagram: Step = {
		id: 'ig',
		type: 'instagram_follow',
		label: 'Follow on Instagram',
		required: true,
		follow_accounts: [
			{ url: 'about:blank#ig-visit', username: 'dedmansounduk' },
		],
	};

	test('confirms an enhanced follow with the configured handle after the countdown', async () => {
		const context = await browser.createBrowserContext();
		try {
			const gate = await runGate(context, [instagram], {
				enhanced: true,
				handles: { instagram: 'fan.handle' },
			});
			expect(await gate.run).toBe('track.wav');
			expect(gate.attention).toEqual([]);
			expect(gate.posts.map((post) => post.path)).toEqual([
				'/api/gate/social-click',
				'/api/gate/mark-complete',
				'/api/gate/unlock',
			]);
			expect(gate.posts[1]?.body).toEqual({
				unit_id: 'ig',
				handle: 'fan.handle',
			});
			expect(await noVisitTabsLeft(context)).toBeTrue();
		} finally {
			await context.close();
		}
	}, 60_000);

	test('reports a handle the site rejects', async () => {
		const context = await browser.createBrowserContext();
		try {
			const gate = await runGate(context, [instagram], {
				enhanced: true,
				handles: { instagram: 'dedmansounduk' },
			});
			await expect(gate.run).rejects.toThrow(
				"StillHype did not accept your Instagram handle: That's dedmansounduk's own account.",
			);
		} finally {
			await context.close();
		}
	}, 60_000);

	test('without a handle it asks for the remote browser and waits for the confirmation', async () => {
		const context = await browser.createBrowserContext();
		try {
			const gate = await runGate(context, [instagram], {
				enhanced: true,
				// Without this, INSTAGRAM_HANDLE from .env would answer the form.
				handles: {},
				onAttention: async (page) => {
					const input = 'input[aria-label="Your Instagram handle"]';
					await page.$eval(input, (el) => {
						const field = el as HTMLInputElement;
						field.value = 'someone.else';
						field.dispatchEvent(new Event('input'));
					});
					await page.waitForFunction(
						() =>
							Array.from(document.querySelectorAll('button')).some(
								(button) =>
									button.textContent === "I've followed" && !button.disabled,
							),
						{ timeout: 10_000 },
					);
					await page.evaluate(() =>
						Array.from(document.querySelectorAll('button'))
							.find((button) => button.textContent === "I've followed")
							?.click(),
					);
				},
			});
			expect(await gate.run).toBe('track.wav');
			expect(gate.attention).toEqual([true, false]);
		} finally {
			await context.close();
		}
	}, 60_000);
});
