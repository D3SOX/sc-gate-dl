import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setEnvValues } from './envFile';
import { SoundcloudTokenRefresher } from './soundcloudAuth';

test('a rotated pair lands in the env file and the token file together', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'sc-gate-mirror-'));
	try {
		const env = join(dir, '.env');
		await writeFile(env, '# mine\nSC_COMMENT=hello\nSC_REFRESH_TOKEN=seed\n');
		const refresher = new SoundcloudTokenRefresher({
			clientId: 'cid',
			refreshToken: 'seed',
			file: join(dir, 'token.json'),
			onRefreshed: (pair) =>
				setEnvValues(env, {
					SC_OAUTH_TOKEN: pair.accessToken,
					SC_REFRESH_TOKEN: pair.refreshToken,
				}),
			fetch: async () =>
				new Response(
					JSON.stringify({ access_token: 'acc-1', refresh_token: 'ref-1' }),
					{ status: 200 },
				),
		});
		await refresher.accessToken();
		const text = await readFile(env, 'utf8');
		expect(text).toBe(
			'# mine\nSC_COMMENT=hello\nSC_REFRESH_TOKEN=ref-1\nSC_OAUTH_TOKEN=acc-1\n',
		);
		const saved = JSON.parse(await readFile(join(dir, 'token.json'), 'utf8'));
		expect(saved.refreshToken).toBe('ref-1');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
