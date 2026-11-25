import { readFile } from 'node:fs/promises';
import { type AccessResult, checkSoundcloudAccess } from './accessCheck';
import { setEnvValues } from './envFile';

export interface EnsureSoundcloudInput {
	envPath: string;
	clientId: string;
	oauthToken: string;
	refreshToken: string;
	now: () => number;
	interactive: boolean;
	log: (line: string) => void;
	fetchMe: (token: string) => Promise<{ ok: boolean; status: number }>;
	/** Exchanges the refresh token. SoundCloud rotates it on every call. */
	refresh: () => Promise<{ accessToken: string; refreshToken: string }>;
}

/**
 * Check the SoundCloud login at startup and renew it when that is possible.
 * A renewed pair is written to `.env` at once, because SoundCloud rotates the
 * refresh token and the old one stops working. Never throws and never logs a
 * token value.
 */
export async function ensureSoundcloudAccess(
	input: EnsureSoundcloudInput,
): Promise<AccessResult> {
	let renewedPair: { accessToken: string; refreshToken: string } | null = null;
	const result = await checkSoundcloudAccess({
		clientId: input.clientId,
		oauthToken: input.oauthToken,
		refreshToken: input.refreshToken,
		now: input.now,
		fetchMe: input.fetchMe,
		refresh: async () => {
			renewedPair = await input.refresh();
			return renewedPair.accessToken;
		},
	});

	if (renewedPair) {
		const pair = renewedPair as { accessToken: string; refreshToken: string };
		try {
			await setEnvValues(input.envPath, {
				SC_OAUTH_TOKEN: pair.accessToken,
				SC_REFRESH_TOKEN: pair.refreshToken,
			});
		} catch {
			input.log(
				'SoundCloud login was renewed but could not be saved to .env. It is used for this run only; log in again if the next start fails.',
			);
		}
	}
	if (result.action) input.log(result.action);
	return result;
}

export interface SpotifyCookieStatus {
	state: 'present' | 'missing' | 'invalid';
	/** Spotify is only needed by some gates, so it never blocks a download. */
	required: false;
}

export async function checkSpotifyCookies(
	path = 'spotify-cookies.json',
): Promise<SpotifyCookieStatus> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch {
		return { state: 'missing', required: false };
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return {
			state: Array.isArray(parsed) && parsed.length > 0 ? 'present' : 'invalid',
			required: false,
		};
	} catch {
		return { state: 'invalid', required: false };
	}
}
