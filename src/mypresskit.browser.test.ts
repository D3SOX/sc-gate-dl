import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, HTTPRequest, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { MypresskitDownloader } from './mypresskit';

// Offline replay of a MyPressKit gate (www.mypresskit.info/gate/<handle>):
// the gate config sits in the escaped Next.js flight data, and the API routes
// mirror what the gate page bundle calls (verify-step, track-step, email,
// oauth/spotify/start → accounts.spotify.com → oauth/spotify/callback).
const ORIGIN = 'https://www.mypresskit.info';
const GATE_ID = 17;
const API = `/api/download-gates/${GATE_ID}`;

type Step = { type: string; required?: boolean };

function gateHtml(steps: Step[], availability: string, combine: boolean) {
	const gate = {
		id: GATE_ID,
		handle: 'fixture',
		title: 'Fixture',
		stepsLogic: 'and',
		combineSoundCloudSteps: combine,
		availability: { state: availability },
		gateSteps: steps.map((step, index) => ({
			index,
			type: step.type,
			label: null,
			targetUrl: step.type === 'email-capture' ? null : 'https://example.com/',
			required: step.required ?? true,
		})),
	};
	const flight = `3:["$","main",null,{"gate":${JSON.stringify(gate)},"providers":{"soundcloudOAuth":true,"spotifyOAuth":true}}]`;
	return `<!doctype html><html><body>
<audio src="${API}/stream"></audio>
<input type="email">
${combine ? '<button type="button">Folgen, Reposten &amp; Kommentieren auf SoundCloud</button>' : ''}
<script>
  // Hands popups to the test so they load through its offline routes.
  window.open = (url) => { fetch('/__fixture-popup?url=' + encodeURIComponent(url)); return {}; };
</script>
<script>self.__next_f = self.__next_f || []; self.__next_f.push([1, ${JSON.stringify(flight)}]);</script>
</body></html>`;
}

describe('MyPressKit gate steps', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function runGate({
		steps,
		availability = 'available',
		spotifyTrackStep = 'ok',
		spotifyAuthorized = false,
		spotifyCookies = true,
		rejectHonor = false,
		combine = false,
	}: {
		steps: Step[];
		availability?: string;
		/** ok: counts; ignored: 200 but not completed; rejected: 403 */
		spotifyTrackStep?: 'ok' | 'ignored' | 'rejected';
		spotifyAuthorized?: boolean;
		spotifyCookies?: boolean;
		rejectHonor?: boolean;
		combine?: boolean;
	}) {
		const completed = new Set<number>();
		const calls: string[] = [];
		const context = await browser.createBrowserContext();
		const page = await context.newPage();

		const route = (request: HTTPRequest) => {
			const url = new URL(request.url());
			const json = (body: unknown, status = 200) =>
				request.respond({
					status,
					contentType: 'application/json',
					body: JSON.stringify(body),
				});
			const html = (body: string) =>
				request.respond({ status: 200, contentType: 'text/html', body });
			const redirect = (location: string) =>
				request.respond({ status: 307, headers: { location }, body: '' });
			const stepIndex = () =>
				Number(JSON.parse(request.postData() || '{}').stepIndex);
			const callback = (step: string) =>
				`${ORIGIN}/api/download-gates/oauth/spotify/callback?code=fixture&state=${step}`;

			if (url.hostname === 'secure.soundcloud.com') {
				const state = url.searchParams.get('state') ?? '';
				const back = `${ORIGIN}/api/download-gates/oauth/soundcloud/callback?code=fixture&state=${state}`;
				return html(
					`<button id="submit_approval">Allow</button><script>document.querySelector('button').onclick = () => { location.href = ${JSON.stringify(back)}; };</script>`,
				);
			}
			if (url.hostname === 'accounts.spotify.com') {
				calls.push(`spotify ${url.pathname}`);
				return html(
					`<button data-testid="auth-accept">Agree</button><script>document.querySelector('button').onclick = () => { location.href = ${JSON.stringify(callback(url.searchParams.get('state') ?? ''))}; };</script>`,
				);
			}
			if (url.origin !== ORIGIN) {
				return request.respond({ status: 404, body: '' });
			}
			switch (url.pathname) {
				case '/__fixture-popup':
					void openPopup(url.searchParams.get('url') ?? '');
					return request.respond({ status: 204, body: '' });
				case '/gate/fixture':
					return html(gateHtml(steps, availability, combine));
				case `${API}/verify-step`: {
					const remaining = steps
						.map((s, i) => ({ s, i }))
						.filter(({ s, i }) => (s.required ?? true) && !completed.has(i))
						.map(({ i }) => i);
					const unlocked = remaining.length === 0;
					return json({
						unlockState: { unlocked, remaining, total: steps.length },
						completedStepIndexes: [...completed],
						downloadToken: unlocked ? 'token-fixture' : null,
						capturedEmail: null,
					});
				}
				case `${API}/track-step`: {
					const index = stepIndex();
					const type = steps[index]?.type ?? '';
					calls.push(`track ${type}`);
					if (type.startsWith('spotify-')) {
						if (spotifyTrackStep === 'rejected') {
							return json({ error: 'Spotify needs OAuth' }, 403);
						}
						if (spotifyTrackStep === 'ignored') return json({ ok: true });
					} else if (rejectHonor) {
						return json({ error: 'nope' }, 400);
					}
					completed.add(index);
					return json({ ok: true });
				}
				case `${API}/email`: {
					const body = JSON.parse(request.postData() || '{}');
					calls.push(`email ${body.email}`);
					completed.add(Number(body.stepIndex));
					return json({ ok: true });
				}
				case '/api/download-gates/oauth/spotify/start': {
					const step = url.searchParams.get('step') ?? '';
					calls.push(`oauth ${steps[Number(step)]?.type}`);
					expect(url.searchParams.get('gate')).toBe(String(GATE_ID));
					return redirect(
						spotifyAuthorized
							? callback(step)
							: `https://accounts.spotify.com/authorize?client_id=x&response_type=code&state=${step}`,
					);
				}
				case '/api/download-gates/oauth/soundcloud/start': {
					const step = url.searchParams.get('step') ?? '';
					const comment = url.searchParams.get('comment');
					calls.push(
						`soundcloud ${steps[Number(step)]?.type}${comment ? ` "${comment}"` : ''}${url.searchParams.has('combo') ? ' combo' : ''}`,
					);
					return redirect(
						`https://secure.soundcloud.com/authorize?client_id=x&response_type=code&state=${step}`,
					);
				}
				case '/api/download-gates/oauth/soundcloud/callback':
					completed.add(Number(url.searchParams.get('state')));
					return html('<p>Done</p>');
				case '/api/download-gates/oauth/spotify/callback':
					completed.add(Number(url.searchParams.get('state')));
					return html('<p>Done</p>');
			}
			return request.respond({ status: 404, body: '' });
		};

		const intercept = async (target: Page) => {
			await target.setRequestInterception(true);
			target.on('request', (request) => void route(request));
		};
		const openPopup = async (path: string) => {
			const popup = await context.newPage();
			await intercept(popup);
			await popup.goto(new URL(path, ORIGIN).href).catch(() => {});
		};
		await intercept(page);
		const downloader = new MypresskitDownloader({
			browserMode: 'headless',
			comment: 'Test comment',
			email: 'listener@example.com',
		});
		let downloadedWith = null as string | null;
		Object.assign(downloader, {
			browser: {
				newPage: async () => page,
				pages: () => context.pages(),
				on: context.on.bind(context),
				off: context.off.bind(context),
			},
			spotifyCookiesLoaded: spotifyCookies,
			downloadWithToken: async (_page: Page, _id: string, token: string) => {
				downloadedWith = token;
				return 'fixture.wav';
			},
		});
		try {
			const file = await downloader.downloadAudio(`${ORIGIN}/gate/fixture`);
			expect(file).toBe('fixture.wav');
			expect(downloadedWith).toBe('token-fixture');
			return calls;
		} finally {
			await context.close();
		}
	}

	test('records honor-system steps, email and Spotify like the gate UI', async () => {
		const calls = await runGate({
			steps: [
				{ type: 'instagram-follow' },
				{ type: 'facebook-follow' },
				{ type: 'tiktok-follow' },
				{ type: 'twitter-follow' },
				{ type: 'youtube-subscribe' },
				{ type: 'youtube-like' },
				{ type: 'email-capture' },
				{ type: 'spotify-follow' },
				{ type: 'instagram-follow', required: false },
			],
		});
		expect(calls).toEqual([
			'track instagram-follow',
			'track facebook-follow',
			'track tiktok-follow',
			'track twitter-follow',
			'track youtube-subscribe',
			'track youtube-like',
			'email listener@example.com',
			'track spotify-follow',
		]);
	}, 60_000);

	test('authorizes each combined SoundCloud step on its own', async () => {
		const calls = await runGate({
			steps: [
				{ type: 'soundcloud-follow' },
				{ type: 'soundcloud-repost' },
				{ type: 'soundcloud-comment' },
				{ type: 'instagram-follow' },
			],
			combine: true,
		});
		expect(calls).toEqual([
			'soundcloud soundcloud-follow',
			'soundcloud soundcloud-repost',
			'soundcloud soundcloud-comment "Test comment"',
			'track instagram-follow',
		]);
	}, 60_000);

	test('falls back to Spotify OAuth and agrees on the consent page', async () => {
		const calls = await runGate({
			steps: [
				{ type: 'spotify-follow' },
				{ type: 'spotify-save' },
				{ type: 'spotify-presave' },
			],
			spotifyTrackStep: 'rejected',
		});
		for (const type of ['spotify-follow', 'spotify-save', 'spotify-presave']) {
			expect(calls).toContain(`oauth ${type}`);
		}
		expect(calls.filter((c) => c === 'spotify /authorize')).toHaveLength(3);
	}, 60_000);

	test('finishes when Spotify redirects straight back to the callback', async () => {
		const calls = await runGate({
			steps: [{ type: 'spotify-save' }],
			spotifyTrackStep: 'ignored',
			spotifyAuthorized: true,
		});
		expect(calls).toEqual(['track spotify-save', 'oauth spotify-save']);
	}, 60_000);

	test('fails clearly for missing Spotify cookies, rejected steps and closed gates', async () => {
		await expect(
			runGate({
				steps: [{ type: 'spotify-follow' }],
				spotifyTrackStep: 'rejected',
				spotifyCookies: false,
			}),
		).rejects.toThrow('spotify-cookies.json');
		await expect(
			runGate({ steps: [{ type: 'tiktok-follow' }], rejectHonor: true }),
		).rejects.toThrow('MyPressKit rejected tiktok-follow step 0 (400)');
		await expect(
			runGate({
				steps: [{ type: 'instagram-follow' }],
				availability: 'paused',
			}),
		).rejects.toThrow('MyPressKit gate is paused');
	}, 90_000);
});
