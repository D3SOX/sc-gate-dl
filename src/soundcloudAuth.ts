import { readFile, rename, rm, writeFile } from 'node:fs/promises';

const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
export const SOUNDCLOUD_TOKEN_FILE = 'soundcloud-token.json';
/** Refresh an hour early so a long cleanup never runs into the expiry. */
const REFRESH_MARGIN_MS = 60 * 60_000;

interface StoredTokens {
	accessToken: string;
	refreshToken: string;
	/** The SC_REFRESH_TOKEN this chain started from; a new one replaces the file. */
	seed: string;
}

export interface SoundcloudTokenRefresherOptions {
	clientId: string;
	refreshToken: string;
	accessToken?: string;
	file?: string;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
}

/** A refresh SoundCloud answered with an error status. */
export class SoundcloudTokenRefreshError extends Error {
	constructor(readonly status: number) {
		super(
			`SoundCloud token refresh failed with HTTP ${status}. Log in again with \`bun start --login\`.`,
		);
		this.name = 'SoundcloudTokenRefreshError';
	}
}

/** Expiry of a JWT access token in ms, or null for classic `2-…` tokens. */
export function tokenExpiresAt(token: string): number | null {
	const payload = token.split('.')[1];
	if (!payload) return null;
	try {
		const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
		return typeof exp === 'number' ? exp * 1000 : null;
	} catch {
		return null;
	}
}

/**
 * Keeps a SoundCloud web login alive. Its JWT access tokens last 24 hours and
 * every refresh replaces the refresh token, so the latest pair is saved to a
 * file. The file also lets other processes in the same folder reuse it.
 */
export class SoundcloudTokenRefresher {
	private tokens: StoredTokens | null = null;
	private refreshing: Promise<string> | null = null;
	private readonly file: string;
	private readonly fetch: NonNullable<SoundcloudTokenRefresherOptions['fetch']>;
	private readonly now: () => number;

	constructor(private readonly options: SoundcloudTokenRefresherOptions) {
		this.file = options.file ?? SOUNDCLOUD_TOKEN_FILE;
		this.fetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	async accessToken(): Promise<string> {
		if (this.tokens && this.isFresh(this.tokens.accessToken)) {
			return this.tokens.accessToken;
		}
		this.refreshing ??= this.loadOrRefresh().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private isFresh(token: string): boolean {
		if (!token) return false;
		const expiresAt = tokenExpiresAt(token);
		return expiresAt === null || expiresAt - this.now() > REFRESH_MARGIN_MS;
	}

	private async loadOrRefresh(): Promise<string> {
		// Another process may have refreshed since this one last looked.
		this.tokens = await this.load();
		if (this.isFresh(this.tokens.accessToken)) return this.tokens.accessToken;

		const response = await this.fetch(TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
				Origin: 'https://soundcloud.com',
				Referer: 'https://soundcloud.com/',
			},
			body: new URLSearchParams({
				client_id: this.options.clientId,
				grant_type: 'refresh_token',
				refresh_token: this.tokens.refreshToken,
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			throw new SoundcloudTokenRefreshError(response.status);
		}
		const body = (await response.json()) as {
			access_token?: unknown;
			refresh_token?: unknown;
		};
		if (typeof body.access_token !== 'string') {
			throw new Error('SoundCloud token refresh returned no access token.');
		}
		this.tokens = {
			accessToken: body.access_token,
			refreshToken:
				typeof body.refresh_token === 'string'
					? body.refresh_token
					: this.tokens.refreshToken,
			seed: this.tokens.seed,
		};
		await this.save(this.tokens);
		return this.tokens.accessToken;
	}

	private async load(): Promise<StoredTokens> {
		const seed = this.options.refreshToken;
		try {
			const stored = JSON.parse(
				await readFile(this.file, 'utf8'),
			) as Partial<StoredTokens>;
			if (
				stored.seed === seed &&
				typeof stored.accessToken === 'string' &&
				typeof stored.refreshToken === 'string'
			) {
				return stored as StoredTokens;
			}
		} catch {
			// No saved chain yet.
		}
		return {
			accessToken: this.options.accessToken ?? '',
			refreshToken: seed,
			seed,
		};
	}

	private async save(tokens: StoredTokens): Promise<void> {
		const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, {
				mode: 0o600,
			});
			await rename(temporary, this.file);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}
}
