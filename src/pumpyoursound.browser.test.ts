import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, HTTPRequest, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { PumpyoursoundDownloader } from './pumpyoursound';

// Offline replay of the fangate markup from pumpyoursound.com/f/pys/…/239012
// (Facebook like modal + share) and …/198809 (Spotify follow + Facebook like
// via /auth/facebook-like/). The inline script stands in for the site's
// main.min.js handlers; external popups point at about:blank.
const ORIGIN = 'https://pumpyoursound.com';
const GATE_PATH = '/f/pys/fixture/1';

type Slot =
	| 'soundcloud'
	| 'youtube_follow'
	| 'spotify_follow'
	| 'facebook_follow'
	| 'facebook_share'
	| 'instagram_follow'
	| 'comment';

const stepMarkup: Record<Slot, (done: string) => string> = {
	soundcloud: (done) => `<li class="fanpageDownload__item">
  <div class="fangateStep fangateStep--soundcloud state ${done}">1</div>
  <div data-href="/auth/soundcloud-events/?fangateId=1&amp;accessToken=access_token" class="sn-connect-with-soundcloud socBtn socBtn__soundcloud">SoundCloud Follow</div>
</li>`,
	youtube_follow: (
		done,
	) => `<li id="youtube_follow" class="fanpageDownload__item">
  <div class="fangateStep fangateStep--youtube state ${done}">2</div>
  <a id="fangate-yt-sub-modal" class="socBtn socBtn__youtube" data-href="about:blank#youtube.com" data-toggle="modal" data-target="#youtube-subscribe-modal">Youtube subscribe</a>
</li>`,
	spotify_follow: (
		done,
	) => `<li id="spotify_follow" class="fanpageDownload__item">
  <div class="fangateStep fangateStep--spotify state ${done}">3</div>
  <a href="/auth/spotify-follow/?fangateId=1" rel="nofollow" class="socBtn socBtn__spotify">Spotify Follow</a>
</li>`,
	facebook_follow: (
		done,
	) => `<li id="facebook_follow" class="fanpageDownload__item">
  <div class="fangateStep fangateStep--facebook state ${done}">4</div>
  FACEBOOK_LIKE_BUTTON
</li>`,
	facebook_share: (
		done,
	) => `<li id="facebook_share" class="fanpageDownload__item">
  <div class="fangateStep fangateStep--facebook state ${done} pull-left">5</div>
  <div data-toggle="modal" data-target="#facebook-share-modal" class="socBtn socBtn__facebook">Share on Facebook</div>
</li>`,
	instagram_follow: (
		done,
	) => `<li id="instagram_follow" class="fanpageDownload__item">
  <div class="fangateStep fangateStep--instagram state ${done}">6</div>
  <a class="instagram_follow_box socBtn socBtn__instagram" href="javascript:void(window.open('about:blank#instagram.com','Pump - Instragram Follow','width=800,height=400'))" data-href="/auth/instagram-follow/?fangateId=1">Follow on Instagram</a>
</li>`,
	comment: (
		done,
	) => `<li class="fanpageDownload__item"><div class="fangateScComment">
  <div class="fangateStep fangateStep--comment state ${done}">7</div>
</div></li>`,
};

const likeButtons = {
	// 239012: the button opens a modal whose footer link marks the like.
	modal: `<a class="socBtn socBtn__facebook" rel="nofollow" data-toggle="modal" data-target=".facebook-like-channels" href="#">Like on Facebook</a>`,
	// 198809: the button itself sends /auth/facebook-like/.
	auth: `<a class="socBtn socBtn__facebook" rel="nofollow" href="javascript:void(window.open('about:blank#facebook.com','PYS - Facebook Like','width=800,height=400'))" data-href="/auth/facebook-like/?fangateId=1">Like on Facebook</a>`,
};

function gateHtml(
	slots: Slot[],
	done: Set<string>,
	like: keyof typeof likeButtons,
) {
	const steps = slots
		.map((slot) =>
			stepMarkup[slot](done.has(slot) ? 'done' : '').replace(
				'FACEBOOK_LIKE_BUTTON',
				likeButtons[like],
			),
		)
		.join('\n');
	const likeModal =
		like === 'modal'
			? `<div class="modal fade facebook-like-channels" id="markFacebookStepAsComplete-modal">
  <a rel="nofollow" class="btn btn-primary ajax" data-ajax-off="history" id="markFacebookStepAsComplete" href="${GATE_PATH}?do=markFacebookStepAsComplete">Continue &amp; Close</a>
</div>`
			: '';
	return `<!doctype html><html><body>
${likeModal}
<div class="modal" id="facebook-share-modal">
  <a id="facebook-share-do-it-btn" href="about:blank#facebook.com/sharer" target="_blank" class="btn btn-info ajax">Share</a>
  <div id="facebook-share-confirm-btn" class="collapse">
    <a rel="nofollow" data-ajax-off="history" href="${GATE_PATH}?type=share&amp;do=markFacebookStepAsComplete" class="btn btn-success ajax">I shared that already</a>
  </div>
</div>
<div class="modal" id="youtube-subscribe-modal">
  <a rel="nofollow" data-ajax-off="history" href="/auth/youtube-follow/?fangateId=1" class="btn btn-primary ajax">I subscribed that already</a>
</div>
<form action="${GATE_PATH}" method="post" id="frm-freeDownloadForm">
  <ul id="steps" class="fanpageDownload__list">${steps}</ul>
</form>
<div id="preloader">Loading</div>
<script>
  // main.min.js arrives late through require.js: it binds the click handlers
  // and then hides #preloader, which nette shows again during each request.
  const preloader = document.querySelector('#preloader');
  setTimeout(() => {
    // $("#instagram_follow a, #facebook_follow a").click(→ $.ajax(data-href))
    for (const a of document.querySelectorAll('#instagram_follow a, #facebook_follow a')) {
      a.addEventListener('click', () => {
        const url = a.getAttribute('data-href');
        if (!url) return;
        fetch(url).then((r) => r.json()).then((e) => { if (e.redirect) location = e.redirect; });
      });
    }
    // nette.ajax for a.ajax links
    document.addEventListener('click', (event) => {
      const a = event.target.closest('a.ajax');
      if (!a) return;
      event.preventDefault();
      preloader.style.display = '';
      fetch(a.href, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then((r) => r.json())
        .then((p) => { if (p.redirect) location = p.redirect; })
        .finally(() => { preloader.style.display = 'none'; });
    });
    preloader.style.display = 'none';
  }, 500);
</script>
</body></html>`;
}

type SpotifyMode = 'consent' | 'authorized' | 'login';

describe('PumpYourSound gate steps', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function runGate({
		slots,
		like = 'modal',
		spotify = 'consent',
		spotifyCookies = true,
		facebookLogin = false,
	}: {
		slots: Slot[];
		like?: keyof typeof likeButtons;
		spotify?: SpotifyMode;
		spotifyCookies?: boolean;
		facebookLogin?: boolean;
	}) {
		const done = new Set<string>(['soundcloud', 'comment']);
		const requests: string[] = [];
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		await page.setRequestInterception(true);

		const route = (request: HTTPRequest) => {
			const url = new URL(request.url());
			const json = (body: unknown) =>
				request.respond({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(body),
				});
			const redirect = (location: string) =>
				request.respond({ status: 302, headers: { location }, body: '' });
			const html = (body: string) =>
				request.respond({ status: 200, contentType: 'text/html', body });
			const backToGate = { redirect: `${ORIGIN}${GATE_PATH}` };

			if (url.hostname === 'accounts.spotify.com') {
				requests.push(url.pathname);
				const callback = `${ORIGIN}/auth/spotify-connect?code=fixture&state=${encodeURIComponent(GATE_PATH)}`;
				if (url.pathname === '/authorize' && spotify === 'authorized') {
					return redirect(callback);
				}
				if (url.pathname === '/authorize' && spotify === 'login') {
					return redirect('https://accounts.spotify.com/login?continue=x');
				}
				return html(
					`<button data-testid="auth-accept">Agree</button><script>document.querySelector('button').onclick = () => { location.href = ${JSON.stringify(callback)}; };</script>`,
				);
			}
			if (url.hostname.endsWith('facebook.com')) {
				return html('<form id="login_form">Log in to Facebook</form>');
			}
			if (url.hostname !== 'pumpyoursound.com') {
				return request.respond({ status: 404, body: '' });
			}
			if (url.pathname.startsWith('/auth/') || url.searchParams.has('do')) {
				requests.push(`${url.pathname}${url.search}`);
			}
			const action = url.searchParams.get('do');
			if (
				url.pathname === GATE_PATH &&
				action === 'markFacebookStepAsComplete'
			) {
				done.add(
					url.searchParams.get('type') === 'share'
						? 'facebook_share'
						: 'facebook_follow',
				);
				return json(backToGate);
			}
			if (url.pathname === GATE_PATH) {
				return html(gateHtml(slots, done, like));
			}
			switch (url.pathname) {
				case '/auth/instagram-follow/':
					done.add('instagram_follow');
					return json(backToGate);
				case '/auth/youtube-follow/':
					done.add('youtube_follow');
					return json(backToGate);
				case '/auth/facebook-like/':
					if (facebookLogin) {
						return json({
							redirect: 'https://www.facebook.com/login.php?next=fixture',
						});
					}
					done.add('facebook_follow');
					return json(backToGate);
				case '/auth/spotify-follow/':
					return redirect(
						`https://accounts.spotify.com/authorize?client_id=x&redirect_uri=${encodeURIComponent(`${ORIGIN}/auth/spotify-connect`)}&response_type=code`,
					);
				case '/auth/spotify-connect':
					done.add('spotify_follow');
					return redirect(`${ORIGIN}${GATE_PATH}`);
			}
			return request.respond({ status: 404, body: '' });
		};
		page.on('request', (request) => void route(request));

		const downloader = new PumpyoursoundDownloader({
			browserMode: 'headless',
			comment: 'Test comment',
		});
		Object.assign(downloader, {
			browser: { pages: () => context.pages() },
			spotifyCookiesLoaded: spotifyCookies,
		});
		const completeGateSteps = (
			downloader as unknown as {
				completeGateSteps(page: Page): Promise<void>;
			}
		).completeGateSteps.bind(downloader);
		try {
			await page.goto(`${ORIGIN}${GATE_PATH}`);
			await completeGateSteps(page);
			const pages = await context.pages();
			return {
				done,
				requests,
				leftoverPopups: pages.filter((p) => p !== page).length,
			};
		} finally {
			await context.close();
		}
	}

	test('marks Facebook like and share with their own confirm links', async () => {
		const { done, requests, leftoverPopups } = await runGate({
			slots: [
				'soundcloud',
				'youtube_follow',
				'facebook_follow',
				'facebook_share',
				'instagram_follow',
				'comment',
			],
		});
		expect([...done].sort()).toEqual(
			[
				'comment',
				'facebook_follow',
				'facebook_share',
				'instagram_follow',
				'soundcloud',
				'youtube_follow',
			].sort(),
		);
		expect(requests).toEqual([
			'/auth/youtube-follow/?fangateId=1',
			`${GATE_PATH}?do=markFacebookStepAsComplete`,
			`${GATE_PATH}?type=share&do=markFacebookStepAsComplete`,
			'/auth/instagram-follow/?fangateId=1',
		]);
		expect(leftoverPopups).toBe(0);
	}, 30_000);

	test('follows on Spotify via consent and likes via /auth/facebook-like/', async () => {
		const { done, requests } = await runGate({
			slots: [
				'soundcloud',
				'spotify_follow',
				'facebook_follow',
				'instagram_follow',
				'comment',
			],
			like: 'auth',
		});
		// The consent fixture only reaches the callback through its Agree button.
		expect(requests).toContain('/authorize');
		expect(done.has('spotify_follow')).toBeTrue();
		expect(done.has('facebook_follow')).toBeTrue();
		// The always-present share confirm link must stay untouched.
		expect(requests.some((r) => r.includes('type=share'))).toBeFalse();
		expect(requests).toContain(
			'/auth/spotify-connect?code=fixture&state=%2Ff%2Fpys%2Ffixture%2F1',
		);
	}, 30_000);

	test('returns from Spotify when the app is already authorized', async () => {
		const { done } = await runGate({
			slots: ['soundcloud', 'spotify_follow'],
			spotify: 'authorized',
		});
		expect(done.has('spotify_follow')).toBeTrue();
	}, 30_000);

	test('fails clearly without Spotify cookies or a Spotify session', async () => {
		await expect(
			runGate({ slots: ['spotify_follow'], spotifyCookies: false }),
		).rejects.toThrow('spotify-cookies.json');
		await expect(
			runGate({ slots: ['spotify_follow'], spotify: 'login' }),
		).rejects.toThrow('Spotify asked to sign in');
	}, 30_000);

	test('fails clearly when the Facebook like asks for a Facebook sign-in', async () => {
		await expect(
			runGate({
				slots: ['facebook_follow'],
				like: 'auth',
				facebookLogin: true,
			}),
		).rejects.toThrow('redirected to Facebook sign-in');
	}, 30_000);
});
