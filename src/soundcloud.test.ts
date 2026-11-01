import { describe, expect, test } from 'bun:test';
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
