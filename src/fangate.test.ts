import { describe, expect, test } from 'bun:test';
import {
	type FangateSession,
	gateSlugFromUrl,
	planFangateSteps,
	runFangateSession,
	sessionUidFromUrl,
} from './fangate';
import fixture from './fixtures/fangate-session.json';

const session = fixture as unknown as FangateSession;

describe('sessionUidFromUrl', () => {
	test('reads the uid from a download page URL', () => {
		expect(
			sessionUidFromUrl(
				'https://www.fangate.eu/download/e2cb2e85-3224-47bf-bed1-491885bdfdc0',
			),
		).toBe('e2cb2e85-3224-47bf-bed1-491885bdfdc0');
	});

	test('returns null for a track page', () => {
		expect(
			sessionUidFromUrl('https://app.fangate.eu/tracks/user-2628-song'),
		).toBeNull();
	});
});

describe('planFangateSteps', () => {
	test('plans the recorded gate: skip the Instagram visit, do SoundCloud OAuth', () => {
		const plan = planFangateSteps(session);
		expect(plan.map((step) => [step.platform, step.action])).toEqual([
			['instagram', 'skip'],
			['soundcloud', 'oauth'],
		]);
	});

	test('a step that is already completed is not planned again', () => {
		const done = {
			...session,
			steps: session.steps.map((step, index) =>
				index === 0 ? { ...step, completed: true } : step,
			),
		};
		expect(planFangateSteps(done).map((step) => step.platform)).toEqual([
			'soundcloud',
		]);
	});

	test('an unskippable step of an unsupported platform fails naming the step', () => {
		const odd = {
			...session,
			steps: [
				{
					key: 'spotify_oauth',
					type: 'oauth',
					platform: 'spotify',
					skippable: false,
					completed: false,
				},
			],
		};
		expect(() => planFangateSteps(odd as unknown as FangateSession)).toThrow(
			'spotify',
		);
	});

	test('an unknown step type is never skipped silently', () => {
		const odd = {
			...session,
			steps: [
				{
					key: 'quiz',
					type: 'quiz',
					platform: 'other',
					skippable: false,
					completed: false,
				},
			],
		};
		expect(() => planFangateSteps(odd as unknown as FangateSession)).toThrow(
			'quiz',
		);
	});
});

describe('runFangateSession', () => {
	function fakeApi(opts: { completeAfter: string[] }) {
		const calls: string[] = [];
		let current = structuredClone(session);
		return {
			calls,
			api: {
				createSession: async (slug: string) => {
					calls.push(`create:${slug}`);
					return current;
				},
				getSession: async () => current,
				logAction: async (_uid: string, key: string) => {
					calls.push(`log:${key}`);
					current = {
						...current,
						steps: current.steps.map((step) =>
							step.key === key ? { ...step, completed: true } : step,
						),
					};
				},
				downloadLink: async () => {
					calls.push('link');
					if (!current.steps.every((step) => step.completed)) {
						throw new Error('Cannot download. Session is not completed.');
					}
					return 'https://files.example/song.mp3';
				},
			},
			oauth: async (uid: string) => {
				calls.push(`oauth:${uid}`);
				for (const key of opts.completeAfter) {
					current = {
						...current,
						steps: current.steps.map((step) =>
							step.key === key ? { ...step, completed: true } : step,
						),
					};
				}
			},
		};
	}

	test('skips the visit, runs OAuth, then asks for the link', async () => {
		const fake = fakeApi({ completeAfter: ['soundcloud_oauth'] });
		const url = await runFangateSession(
			fake.api,
			fake.oauth,
			'user-2628-we-found-love-trance-edit',
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
		const fake = fakeApi({ completeAfter: [] });
		await expect(
			runFangateSession(fake.api, fake.oauth, 'slug'),
		).rejects.toThrow('soundcloud_oauth');
		expect(fake.calls).not.toContain('link');
	});
});

describe('gateSlugFromUrl', () => {
	test('reads the slug from app and www track URLs', () => {
		expect(
			gateSlugFromUrl('https://app.fangate.eu/tracks/user-2628-we-found-love'),
		).toBe('user-2628-we-found-love');
		expect(gateSlugFromUrl('https://www.fangate.eu/tracks/abc_1-2')).toBe(
			'abc_1-2',
		);
	});

	test('returns null for a URL that is not a track page', () => {
		expect(gateSlugFromUrl('https://www.fangate.eu/')).toBeNull();
	});
});

describe('the server and the CLI both reach the fangate.eu downloader', () => {
	test('the server maps the provider to FangateDownloader', async () => {
		const source = await Bun.file(
			new URL('./server.ts', import.meta.url),
		).text();
		expect(source).toContain("fangate: ['fangate.eu', FangateDownloader]");
	});
});
