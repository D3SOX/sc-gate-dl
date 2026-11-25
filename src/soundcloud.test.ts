import { describe, expect, spyOn, test } from 'bun:test';
import { SoundcloudClient } from './soundcloud';

type Page = { collection: unknown[]; next_href?: string | null };

describe('SoundcloudClient.cleanup', () => {
	test('removes activity from every page, not just the first', async () => {
		const firstPages: Record<string, Page> = {
			'users/1/followings': {
				collection: [{ id: 10, username: 'a' }],
				next_href: 'https://api-v2.soundcloud.com/users/1/followings?cursor=2',
			},
			'users/1/likes': {
				collection: [{ track: { id: 20, title: 'a' } }],
				next_href: 'https://api-v2.soundcloud.com/users/1/likes?cursor=2',
			},
			'users/1/comments': {
				collection: [{ id: 30 }],
				next_href: 'https://api-v2.soundcloud.com/users/1/comments?cursor=2',
			},
			'me/track_reposts/ids': {
				collection: [40],
				next_href:
					'https://api-v2.soundcloud.com/me/track_reposts/ids?cursor=2',
			},
		};
		const secondPages: Record<string, Page> = {
			'/users/1/followings': { collection: [{ id: 11, username: 'b' }] },
			'/users/1/likes': { collection: [{ track: { id: 21, title: 'b' } }] },
			'/users/1/comments': { collection: [{ id: 31 }] },
			'/me/track_reposts/ids': { collection: [41] },
		};
		const deleted: string[] = [];
		const api = {
			getV2: async (endpoint: string) =>
				endpoint === 'me' ? { id: 1 } : firstPages[endpoint],
			getURL: async (url: string, params: Record<string, string>) =>
				params.cursor === '2' ? secondPages[new URL(url).pathname] : undefined,
			deleteV2: async (endpoint: string) => {
				deleted.push(endpoint);
				return {};
			},
		};
		const client = new SoundcloudClient({
			credentials: { clientId: 'id', oauthToken: 'token' },
		});
		(client as unknown as { soundcloud: { api: typeof api } }).soundcloud = {
			api,
		};

		const originalLog = console.log;
		console.log = () => {};
		try {
			expect(await client.cleanup(false)).toEqual({
				unfollowed: 2,
				unliked: 2,
				deletedComments: 2,
				deletedReposts: 2,
			});
		} finally {
			console.log = originalLog;
		}
		expect(deleted).toEqual([
			'me/followings/10',
			'me/followings/11',
			'users/1/track_likes/20',
			'users/1/track_likes/21',
			'comments/30',
			'comments/31',
			'me/track_reposts/40',
			'me/track_reposts/41',
		]);
	});
});

describe('SoundcloudClient.searchTracks', () => {
	test('sends only the client ID, so an expired login cannot break search', async () => {
		let request: Request | undefined;
		const fetch = spyOn(globalThis, 'fetch').mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					request = new Request(input, init);
					return Response.json({ collection: [], next_href: null });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		try {
			const client = new SoundcloudClient({
				credentials: { clientId: 'client', oauthToken: 'expired' },
			});
			await client.searchTracks('flickermood', 5, 10);
		} finally {
			fetch.mockRestore();
		}

		const url = new URL(request?.url ?? '');
		expect(url.pathname).toBe('/search/tracks');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			q: 'flickermood',
			limit: '5',
			offset: '10',
			client_id: 'client',
		});
		expect(request?.headers.get('Authorization')).toBeNull();
	});
});

describe('SoundcloudClient.checkLogin', () => {
	function mockFetch(respond: (url: URL) => Response | Promise<Response>) {
		const requests: Request[] = [];
		const fetch = spyOn(globalThis, 'fetch').mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const request = new Request(input, init);
					requests.push(request);
					return respond(new URL(request.url));
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		return { requests, restore: () => fetch.mockRestore() };
	}

	async function check(respond: (url: URL) => Response | Promise<Response>) {
		const fetch = mockFetch(respond);
		try {
			const state = await new SoundcloudClient({
				credentials: { clientId: 'client', oauthToken: 'token' },
			}).checkLogin();
			return { state, requests: fetch.requests };
		} finally {
			fetch.restore();
		}
	}

	test('reads /me once with the account token', async () => {
		const { state, requests } = await check(() => Response.json({ id: 1 }));
		expect(state).toBe('valid');
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			'https://api-v2.soundcloud.com/me?client_id=client',
		);
		expect(requests[0]?.headers.get('Authorization')).toBe('OAuth token');
	});

	test('only a rejection makes the login invalid', async () => {
		for (const [status, expected] of [
			[401, 'invalid'],
			[403, 'invalid'],
			[429, 'unverifiable'],
			[500, 'unverifiable'],
			[503, 'unverifiable'],
		] as const) {
			expect((await check(() => new Response('{}', { status }))).state).toBe(
				expected,
			);
		}
		expect(
			(
				await check(() => {
					throw new TypeError('fetch failed');
				})
			).state,
		).toBe('unverifiable');
	});

	test('a rejected refresh token is invalid, a failing token server is not', async () => {
		const saved = {
			SC_CLIENT_ID: process.env.SC_CLIENT_ID,
			SC_OAUTH_TOKEN: process.env.SC_OAUTH_TOKEN,
			SC_REFRESH_TOKEN: process.env.SC_REFRESH_TOKEN,
		};
		try {
			for (const [status, expected] of [
				[400, 'invalid'],
				[401, 'invalid'],
				[429, 'unverifiable'],
				[502, 'unverifiable'],
			] as const) {
				Object.assign(process.env, {
					SC_CLIENT_ID: 'client',
					SC_OAUTH_TOKEN: '',
					// A new seed per case, so each one gets a fresh refresher.
					SC_REFRESH_TOKEN: `check-login-${status}`,
				});
				const fetch = mockFetch(() => new Response('{}', { status }));
				try {
					expect(await new SoundcloudClient().checkLogin()).toBe(expected);
					expect(fetch.requests.map((r) => new URL(r.url).host)).toEqual([
						'secure.soundcloud.com',
					]);
				} finally {
					fetch.restore();
				}
			}
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
