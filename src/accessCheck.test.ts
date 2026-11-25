import { describe, expect, test } from 'bun:test';
import { checkSoundcloudAccess } from './accessCheck';

const jwt = (expSeconds: number) =>
	`h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;

const NOW = 1_800_000_000_000;
const fresh = jwt(NOW / 1000 + 86_400);

function client(
	over: Partial<Parameters<typeof checkSoundcloudAccess>[0]> = {},
) {
	return {
		clientId: 'cid',
		oauthToken: fresh,
		refreshToken: 'r',
		now: () => NOW,
		fetchMe: async () => ({ ok: true as const, status: 200 }),
		refresh: async () => fresh,
		...over,
	};
}

describe('checkSoundcloudAccess', () => {
	test('valid when the token is accepted', async () => {
		expect((await checkSoundcloudAccess(client())).state).toBe('valid');
	});

	test('missing when there is no client id or no token at all', async () => {
		expect((await checkSoundcloudAccess(client({ clientId: '' }))).state).toBe(
			'missing',
		);
		expect(
			(
				await checkSoundcloudAccess(
					client({ oauthToken: '', refreshToken: '' }),
				)
			).state,
		).toBe('missing');
	});

	test('expired when the token is past its expiry and cannot be renewed', async () => {
		const result = await checkSoundcloudAccess(
			client({
				oauthToken: jwt(NOW / 1000 - 10),
				refresh: async () => {
					throw new Error('refresh failed with HTTP 400');
				},
			}),
		);
		expect(result.state).toBe('expired');
		expect(result.action).toContain('log in');
	});

	test('an expired token is renewed when the refresh works', async () => {
		const result = await checkSoundcloudAccess(
			client({ oauthToken: jwt(NOW / 1000 - 10) }),
		);
		expect(result.state).toBe('valid');
		expect(result.renewed).toBe(true);
	});

	test('invalid when the provider rejects the token with 401', async () => {
		const result = await checkSoundcloudAccess(
			client({ fetchMe: async () => ({ ok: false as const, status: 401 }) }),
		);
		expect(result.state).toBe('invalid');
	});

	test('unverifiable on a network error or a rate limit, never invalid', async () => {
		expect(
			(
				await checkSoundcloudAccess(
					client({
						fetchMe: async () => {
							throw new Error('ECONNREFUSED');
						},
					}),
				)
			).state,
		).toBe('unverifiable');
		expect(
			(
				await checkSoundcloudAccess(
					client({
						fetchMe: async () => ({ ok: false as const, status: 429 }),
					}),
				)
			).state,
		).toBe('unverifiable');
	});

	test('the result never contains a token', async () => {
		const result = await checkSoundcloudAccess(
			client({
				oauthToken: 'SECRET-TOKEN-VALUE',
				refreshToken: 'SECRET-REFRESH',
				fetchMe: async () => ({ ok: false as const, status: 401 }),
			}),
		);
		expect(JSON.stringify(result)).not.toContain('SECRET');
	});
});
