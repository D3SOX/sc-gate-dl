import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
	createFangateApi,
	type FangateApi,
	type FangateSession,
	type FangateStep,
	fangateStepAction,
	gateSlugFromUrl,
	runFangateSession,
} from './fangate';
import fixture from './fixtures/fangate-session.json';

// Recorded from api.fangate.eu for a gate with an Instagram visit and SoundCloud OAuth.
const session = fixture as unknown as FangateSession;

const SOUNDCLOUD_OAUTH: FangateStep = {
	key: 'soundcloud_oauth',
	type: 'oauth',
	platform: 'soundcloud',
	skippable: false,
	completed: false,
};

describe('gateSlugFromUrl', () => {
	test('reads the slug from bare, app and www track URLs', () => {
		for (const host of ['fangate.eu', 'app.fangate.eu', 'www.fangate.eu']) {
			expect(
				gateSlugFromUrl(
					`https://${host}/tracks/user-2628-we-found-love-trance-edit`,
				),
			).toBe('user-2628-we-found-love-trance-edit');
		}
	});

	test('rejects other pages and lookalike hosts', () => {
		expect(gateSlugFromUrl('https://www.fangate.eu/')).toBeNull();
		expect(gateSlugFromUrl('https://notfangate.eu/tracks/song')).toBeNull();
		expect(
			gateSlugFromUrl('https://fangate.eu.example.com/tracks/song'),
		).toBeNull();
		expect(gateSlugFromUrl('not a url')).toBeNull();
	});
});

describe('fangateStepAction', () => {
	test('skips the recorded Instagram visit and runs SoundCloud OAuth', () => {
		expect(session.steps.map(fangateStepAction)).toEqual(['skip', 'oauth']);
	});

	test('an unsupported step fails naming the step', () => {
		expect(() =>
			fangateStepAction({ ...SOUNDCLOUD_OAUTH, platform: 'spotify' }),
		).toThrow('spotify');
		expect(() =>
			fangateStepAction({
				key: 'quiz',
				type: 'quiz',
				platform: 'other',
				skippable: true,
				completed: false,
			}),
		).toThrow('"quiz"');
	});
});

function fakeApi(
	options: { completeOnOauth?: string[]; addAfterOauth?: FangateStep[] } = {},
) {
	const calls: string[] = [];
	let current: FangateSession = structuredClone(session);
	const complete = (key: string) => {
		current = {
			...current,
			steps: current.steps.map((step) =>
				step.key === key ? { ...step, completed: true } : step,
			),
		};
	};
	const api: FangateApi = {
		createSession: async (slug) => {
			calls.push(`create:${slug}`);
			return current;
		},
		getSession: async () => current,
		logAction: async (_uid, key) => {
			calls.push(`log:${key}`);
			complete(key);
		},
		downloadLink: async () => {
			calls.push('link');
			return 'https://files.example/song.mp3';
		},
	};
	const oauth = async (uid: string) => {
		calls.push(`oauth:${uid}`);
		for (const key of options.completeOnOauth ?? ['soundcloud_oauth']) {
			complete(key);
		}
		current = {
			...current,
			steps: [...current.steps, ...(options.addAfterOauth ?? [])],
		};
	};
	return { api, oauth, calls };
}

describe('runFangateSession', () => {
	test('skips the visit, runs OAuth, then asks for the link', async () => {
		const fake = fakeApi();
		const url = await runFangateSession(
			fake.api,
			'user-2628-we-found-love-trance-edit',
			{ oauth: fake.oauth },
		);
		expect(url).toBe('https://files.example/song.mp3');
		expect(fake.calls).toEqual([
			'create:user-2628-we-found-love-trance-edit',
			'log:instagram_visit:28827',
			'oauth:fixture-session',
			'link',
		]);
	});

	test('fails when OAuth does not complete its step, and never asks for the link', async () => {
		const fake = fakeApi({ completeOnOauth: [] });
		await expect(
			runFangateSession(fake.api, 'slug', { oauth: fake.oauth }),
		).rejects.toThrow('soundcloud_oauth');
		expect(fake.calls).not.toContain('link');
	});

	test('handles a step that only appears after the SoundCloud login', async () => {
		const fake = fakeApi({
			addAfterOauth: [
				{
					key: 'spotify_visit:1',
					type: 'visit',
					platform: 'spotify',
					skippable: true,
					completed: false,
				},
			],
		});
		await runFangateSession(fake.api, 'slug', { oauth: fake.oauth });
		expect(fake.calls.slice(-2)).toEqual(['log:spotify_visit:1', 'link']);
	});

	test('stops at an unsupported step added after the login, naming it', async () => {
		const fake = fakeApi({
			addAfterOauth: [
				{ ...SOUNDCLOUD_OAUTH, key: 'spotify_oauth', platform: 'spotify' },
			],
		});
		await expect(
			runFangateSession(fake.api, 'slug', { oauth: fake.oauth }),
		).rejects.toThrow('spotify_oauth');
		expect(fake.calls).not.toContain('link');
	});

	test('does not log a skipped visit twice when the API keeps it open', async () => {
		const fake = fakeApi();
		fake.api.logAction = async (_uid, key) => {
			fake.calls.push(`log:${key}`);
		};
		await runFangateSession(fake.api, 'slug', { oauth: fake.oauth });
		expect(fake.calls.filter((call) => call.startsWith('log:')).length).toBe(1);
		expect(fake.calls.at(-1)).toBe('link');
	});
});

describe('createFangateApi', () => {
	afterEach(() => {
		(
			globalThis.fetch as unknown as { mockRestore?: () => void }
		).mockRestore?.();
	});

	test('creates a session for the slug and logs actions on it', async () => {
		const requests: { url: string; method?: string; body?: unknown }[] = [];
		spyOn(globalThis, 'fetch').mockImplementation((async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			requests.push({
				url: String(input),
				method: init?.method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return Response.json(
				String(input).endsWith('download_link/')
					? { url: 'https://files.example/a.wav' }
					: session,
			);
		}) as typeof fetch);

		const api = createFangateApi();
		await api.createSession('slug');
		await api.logAction('uid', 'instagram_visit:28827');
		expect(await api.downloadLink('uid')).toBe('https://files.example/a.wav');
		expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
			'POST https://api.fangate.eu/api/download_sessions/',
			'POST https://api.fangate.eu/api/download_sessions/uid/log_action/',
			'GET https://api.fangate.eu/api/download_sessions/uid/download_link/',
		]);
		expect(requests[0]?.body).toMatchObject({ download_gate_slug: 'slug' });
		expect(requests[1]?.body).toEqual({ action: 'instagram_visit:28827' });
	});

	test('an error answer names the endpoint and status', async () => {
		spyOn(globalThis, 'fetch').mockImplementation((async () =>
			Response.json(
				{ detail: 'Cannot download. Session is not completed.' },
				{ status: 400 },
			)) as unknown as typeof fetch);
		await expect(createFangateApi().downloadLink('uid')).rejects.toThrow(
			'HTTP 400: {"detail":"Cannot download. Session is not completed."}',
		);
	});

	test('a cancelled downloader aborts its requests', async () => {
		const controller = new AbortController();
		spyOn(globalThis, 'fetch').mockImplementation(
			((_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new Error('aborted')),
					);
				})) as typeof fetch,
		);
		const pending = createFangateApi(controller.signal).getSession('uid');
		controller.abort();
		await expect(pending).rejects.toThrow('aborted');
	});
});
