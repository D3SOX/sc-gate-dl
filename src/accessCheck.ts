import { tokenExpiresAt } from './soundcloudAuth';

export type AccessState =
	| 'valid'
	| 'missing'
	| 'expired'
	| 'invalid'
	| 'unverifiable';

export interface AccessResult {
	state: AccessState;
	renewed: boolean;
	/** What the user has to do, or null when nothing is needed. Never a secret. */
	action: string | null;
}

export interface SoundcloudAccessInput {
	clientId: string;
	oauthToken: string;
	refreshToken: string;
	now: () => number;
	/** One cheap authenticated read, for example `GET /me`. */
	fetchMe: (token: string) => Promise<{ ok: boolean; status: number }>;
	/** Exchanges the refresh token for a new access token. */
	refresh: () => Promise<string>;
}

const LOGIN_ACTION =
	'Please log in to SoundCloud again and set SC_REFRESH_TOKEN (and SC_OAUTH_TOKEN) in .env.';

/**
 * Classify the SoundCloud login without exposing it. A network error or a rate
 * limit is `unverifiable`, never `invalid`, so a bad connection cannot make the
 * caller discard a working login.
 */
export async function checkSoundcloudAccess(
	input: SoundcloudAccessInput,
): Promise<AccessResult> {
	if (!input.clientId || (!input.oauthToken && !input.refreshToken)) {
		return {
			state: 'missing',
			renewed: false,
			action: 'Set SC_CLIENT_ID and SC_REFRESH_TOKEN in .env.',
		};
	}

	let token = input.oauthToken;
	let renewed = false;
	const expiresAt = token ? tokenExpiresAt(token) : null;
	if (!token || (expiresAt !== null && expiresAt <= input.now())) {
		if (!input.refreshToken) {
			return { state: 'expired', renewed: false, action: LOGIN_ACTION };
		}
		try {
			token = await input.refresh();
			renewed = true;
		} catch {
			return { state: 'expired', renewed: false, action: LOGIN_ACTION };
		}
	}

	try {
		const response = await input.fetchMe(token);
		if (response.ok) return { state: 'valid', renewed, action: null };
		if (response.status === 401 || response.status === 403) {
			return { state: 'invalid', renewed, action: LOGIN_ACTION };
		}
		return {
			state: 'unverifiable',
			renewed,
			action: 'SoundCloud could not be checked right now. Try again later.',
		};
	} catch {
		return {
			state: 'unverifiable',
			renewed,
			action:
				'SoundCloud could not be reached. Check the network and try again.',
		};
	}
}
