import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { lookpath } from 'find-bin';
import Soundcloud, {
	type SoundcloudPlaylist,
	type SoundcloudTrack,
	type SoundcloudUser,
} from 'soundcloud.ts';
import {
	extractCaptchaDeliveryUrl,
	extractGateUrl,
	loadCookies,
} from './utils';

interface SoundcloudCredentials {
	clientId: string;
	oauthToken: string;
}

interface SoundcloudClientOptions {
	credentials?: SoundcloudCredentials;
}

interface ManagedAccountExport {
	me: Record<string, unknown>;
	followedUsers: SoundcloudUser[];
	likedTracks: SoundcloudTrack[];
	repostedTracks: SoundcloudTrack[];
	ownedPlaylists: SoundcloudPlaylist[];
	repostedPlaylists: SoundcloudPlaylist[];
}

export class SoundcloudClient {
	private soundcloud: Soundcloud;

	constructor(options?: SoundcloudClientOptions) {
		const clientId = options?.credentials?.clientId ?? process.env.SC_CLIENT_ID;
		const oauthToken =
			options?.credentials?.oauthToken ?? process.env.SC_OAUTH_TOKEN;

		if (!clientId || !oauthToken) {
			throw new Error(
				'SC_CLIENT_ID and SC_OAUTH_TOKEN are required. Please set them in your .env file.',
			);
		}

		this.soundcloud = new Soundcloud(clientId, oauthToken);
	}

	async getTrack(url: string) {
		return await this.soundcloud.tracks.get(url);
	}

	/**
	 * Repost a track (PUT me/track_reposts/:id) using the same soundcloud.ts API
	 * path as deleteV2. DataDome protects this write; DELETE cleanup is not.
	 * Falls back to Chrome-TLS curl (+ optional residential proxy) when Bun is blocked.
	 */
	async repostTrack(trackUrlOrId: string): Promise<SoundcloudTrack> {
		const track = await this.getTrack(trackUrlOrId);
		const endpoint = `me/track_reposts/${track.id}`;

		try {
			await this.soundcloud.api.putV2(endpoint);
			return track;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/status code 403/i.test(message) && !/403/.test(message)) {
				// 422/409 from some gateways — treat as already reposted if we can detect
				if (/status code (422|409)/i.test(message)) return track;
				throw error;
			}
		}

		// Bun TLS is often flagged for engagement PUTs; mirror real Chrome via curl-impersonate.
		const chromeResult = await this.chromeTlsMutate('PUT', endpoint);
		if (
			chromeResult.status === 200 ||
			chromeResult.status === 201 ||
			chromeResult.status === 204 ||
			chromeResult.status === 422 ||
			chromeResult.status === 409
		) {
			return track;
		}

		const captchaUrl = extractCaptchaDeliveryUrl(chromeResult.body);
		const hardBlocked = /you have been blocked|unusual activity/i.test(
			chromeResult.body,
		);
		const proxyHint =
			' Engagement PUTs are DataDome-protected (DELETE cleanup is not). Set SC_API_PROXY or CLOAKBROWSER_PROXY to a residential proxy and retry.';
		const error = new Error(
			hardBlocked
				? `Failed to repost SoundCloud track ${track.id}: DataDome hard-blocked this IP.${proxyHint}`
				: `Failed to repost SoundCloud track ${track.id}: HTTP ${chromeResult.status}${chromeResult.body ? ` ${chromeResult.body.slice(0, 200)}` : ''}.${proxyHint}`,
		) as Error & { captchaUrl?: string; status?: number };
		error.status = chromeResult.status;
		if (captchaUrl) error.captchaUrl = captchaUrl;
		throw error;
	}

	/**
	 * Chrome-TLS PUT/DELETE via curl_chrome* / curl-impersonate (same OAuth query
	 * params as soundcloud.ts fetchRequest). Optional SC_API_PROXY / CLOAKBROWSER_PROXY / PROXY_URL.
	 */
	private async chromeTlsMutate(
		method: 'PUT' | 'DELETE',
		endpoint: string,
	): Promise<{ status: number; body: string }> {
		const curlBin =
			(await lookpath('curl_chrome131')) ||
			(await lookpath('curl_chrome116')) ||
			(await lookpath('curl-impersonate'));
		if (!curlBin) {
			// Fall back to Bun with the exact same headers/query as putV2.
			return this.bunMutate(method, endpoint);
		}

		const clientId =
			this.soundcloud.api.clientId ?? process.env.SC_CLIENT_ID ?? '';
		const oauthToken =
			this.soundcloud.api.oauthToken ?? process.env.SC_OAUTH_TOKEN ?? '';
		const path = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
		const url = new URL(`https://api-v2.soundcloud.com/${path}`);
		url.searchParams.set('client_id', clientId);
		url.searchParams.set('oauth_token', oauthToken);

		const headers = { ...this.soundcloud.api.headers };
		const escapeCurlConfig = (value: string) =>
			value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		// Keep OAuth out of argv (visible in `ps`); pass via curl --config stdin.
		const configLines = [
			`url = "${escapeCurlConfig(url.toString())}"`,
			`header = "Authorization: OAuth ${escapeCurlConfig(oauthToken)}"`,
		];

		const args = [
			'-sS',
			'-w',
			'\n__STATUS__:%{http_code}',
			'-X',
			method,
			'-H',
			`Origin: ${headers.Origin ?? 'https://soundcloud.com'}`,
			'-H',
			`Referer: ${headers.Referer ?? 'https://soundcloud.com/'}`,
			'-H',
			`User-Agent: ${headers['User-Agent'] ?? 'Mozilla/5.0'}`,
			'-H',
			'Accept: application/json, text/javascript, */*; q=0.01',
		];

		try {
			const cookies = await loadCookies('soundcloud-cookies.json');
			const datadome = cookies.find((c) => c.name === 'datadome')?.value;
			if (cookies.length) {
				args.push(
					'-H',
					`Cookie: ${cookies.map((c) => `${c.name}=${c.value}`).join('; ')}`,
				);
			}
			if (datadome) {
				args.push('-H', `x-datadome-clientid: ${datadome}`);
			}
		} catch {
			// optional
		}

		const proxy =
			process.env.SC_API_PROXY?.trim() ||
			process.env.CLOAKBROWSER_PROXY?.trim() ||
			process.env.PROXY_URL?.trim();
		if (proxy) {
			args.push('-x', proxy);
		}

		args.push('--config', '-');

		const result = await execa(curlBin, args, {
			input: `${configLines.join('\n')}\n`,
			reject: false,
		});
		const output = `${result.stdout}${result.stderr}`;
		const statusMatch = output.match(/__STATUS__:(\d+)\s*$/);
		const status = statusMatch ? Number(statusMatch[1]) : 0;
		const body = output.replace(/\n__STATUS__:\d+\s*$/, '');
		return { status, body };
	}

	private async bunMutate(
		method: 'PUT' | 'DELETE',
		endpoint: string,
	): Promise<{ status: number; body: string }> {
		const clientId =
			this.soundcloud.api.clientId ?? process.env.SC_CLIENT_ID ?? '';
		const oauthToken =
			this.soundcloud.api.oauthToken ?? process.env.SC_OAUTH_TOKEN ?? '';
		const path = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
		const url = new URL(`https://api-v2.soundcloud.com/${path}`);
		url.searchParams.set('client_id', clientId);
		url.searchParams.set('oauth_token', oauthToken);
		const response = await fetch(url, {
			method,
			headers: { ...this.soundcloud.api.headers },
			signal: AbortSignal.timeout(30_000),
		});
		return {
			status: response.status,
			body: await response.text().catch(() => ''),
		};
	}

	async getMe(): Promise<Record<string, unknown>> {
		return await this.soundcloud.api.getV2('me');
	}

	async getGateURL(track: SoundcloudTrack) {
		const gate = extractGateUrl(track);
		if (!gate) {
			return null;
		}
		const providerLabel =
			gate.provider === 'droploud'
				? 'Droploud'
				: gate.provider === 'gaterush'
					? 'GateRush'
					: gate.provider === 'downloadgater'
						? 'DownloadGater'
						: 'Hypeddit';
		const sourceLabel =
			gate.type === 'purchase_url' ? 'purchase URL' : 'description';
		console.log(
			`Found ${providerLabel} URL from SoundCloud track ${sourceLabel}:`,
			gate.url,
		);
		return gate;
	}

	/** @deprecated Prefer getGateURL */
	async getHypedditURL(track: SoundcloudTrack) {
		const gate = await this.getGateURL(track);
		return gate?.provider === 'hypeddit' ? gate.url : null;
	}

	getArtworkUrl(track: SoundcloudTrack): string {
		if (track.artwork_url) {
			return track.artwork_url;
		}
		console.log("Track has no artwork, falling back to uploader's avatar...");
		return track.user.avatar_url;
	}

	async fetchArtwork(
		artworkUrl: string,
	): Promise<{ buffer: ArrayBuffer; fileName: string }> {
		const originalArtworkUrl = artworkUrl.replace('large', 'original');
		const fileName = originalArtworkUrl.split('/').pop() || 'artwork.jpg';
		if (await Bun.file(join('./downloads', fileName)).exists()) {
			console.log(`✓ Found artwork in downloads folder: ${fileName}`);
			return {
				buffer: await Bun.file(join('./downloads', fileName)).arrayBuffer(),
				fileName,
			};
		}
		const response = await fetch(originalArtworkUrl);
		if (!response.ok) {
			throw new Error(`Failed to fetch artwork: ${response.statusText}`);
		}
		const buffer = await response.arrayBuffer();
		return { buffer, fileName };
	}

	async cleanup(prompt = true): Promise<
		| {
				unfollowed: number;
				unliked: number;
				deletedComments: number;
				deletedReposts: number;
		  }
		| undefined
	> {
		if (prompt) {
			const cleanupSoundcloudConfirm = await confirm({
				message:
					'Do you want to cleanup your SoundCloud account (unfollow all users, unlike all tracks, delete all comments and reposts)?',
				default: true,
			});

			if (!cleanupSoundcloudConfirm) {
				return;
			}
		}

		const me = await this.getMe();
		if (!me) {
			throw new Error(
				'Failed to fetch your SoundCloud account. Please check your SoundCloud credentials.',
			);
		}
		const meId = this.getMeId(me);

		const unfollowed = await this.unfollowAllUsers(meId);
		const unliked = await this.unlikeAllTracks(meId);
		const deletedComments = await this.deleteAllComments(meId);
		const deletedReposts = await this.deleteAllReposts();

		return {
			unfollowed,
			unliked,
			deletedComments,
			deletedReposts,
		};
	}

	private async unfollowAllUsers(meId: string): Promise<number> {
		const { collection: following } = await this.soundcloud.api.getV2(
			`users/${meId}/followings`,
		);
		if (!following?.length) {
			console.log('No users to unfollow');
			return 0;
		}
		console.log(`Found ${following.length} users to unfollow`);

		let count = 0;
		for (const user of following) {
			try {
				await this.soundcloud.api.deleteV2(`me/followings/${user.id}`);
				console.log(`✓ Unfollowed ${user.username} (${user.id})`);
				count++;
			} catch (error) {
				console.error(
					`✗ Failed to unfollow ${user.username} (${user.id}):`,
					error,
				);
			}
		}
		return count;
	}

	private async unlikeAllTracks(meId: string): Promise<number> {
		const { collection: likes } = await this.soundcloud.api.getV2(
			`users/${meId}/likes`,
		);
		if (!likes?.length) {
			console.log('No tracks to unlike');
			return 0;
		}
		console.log(`Found ${likes.length} tracks to unlike`);

		let count = 0;
		for (const like of likes) {
			try {
				await this.soundcloud.api.deleteV2(
					`users/${meId}/track_likes/${like.track.id}`,
				);
				console.log(`✓ Unliked ${like.track.title} (${like.track.id})`);
				count++;
			} catch (error) {
				console.error(
					`✗ Failed to unlike ${like.track.title} (${like.track.id}):`,
					error,
				);
			}
		}
		return count;
	}

	private async deleteAllComments(meId: string): Promise<number> {
		const { collection: comments } = await this.soundcloud.api.getV2(
			`users/${meId}/comments`,
		);
		if (!comments?.length) {
			console.log('No comments to delete');
			return 0;
		}
		console.log(`Found ${comments.length} comments to delete`);

		let count = 0;
		for (const comment of comments) {
			try {
				await this.soundcloud.api.deleteV2(`comments/${comment.id}`);
				console.log(`✓ Deleted comment ${comment.id}`);
				count++;
			} catch (error) {
				console.error(`✗ Failed to delete comment ${comment.id}:`, error);
			}
		}
		return count;
	}

	private async deleteAllReposts(): Promise<number> {
		const { collection: reposts } = await this.soundcloud.api.getV2(
			`me/track_reposts/ids`,
			{ limit: 200 },
		);
		if (!reposts?.length) {
			console.log('No reposts to delete');
			return 0;
		}
		console.log(`Found ${reposts.length} reposts to delete`);

		let count = 0;
		for (const repost of reposts) {
			try {
				await this.soundcloud.api.deleteV2(`me/track_reposts/${repost}`);
				console.log(`✓ Deleted repost ${repost}`);
				count++;
			} catch (error) {
				console.error(`✗ Failed to delete repost ${repost}:`, error);
			}
		}
		return count;
	}

	async exportManagedAccountData(): Promise<ManagedAccountExport> {
		const me = await this.getMe();
		const meId = this.getMeId(me);

		const [
			followedUsers,
			likedTracks,
			repostedTracks,
			ownedPlaylists,
			repostedPlaylists,
		] = await Promise.all([
			this.getAllFollowedUsers(meId),
			this.getAllLikedTracks(meId),
			this.getRepostedTracks(),
			this.getOwnedPlaylists(meId),
			this.getRepostedPlaylists(),
		]);

		return {
			me,
			followedUsers,
			likedTracks,
			repostedTracks,
			ownedPlaylists,
			repostedPlaylists,
		};
	}

	private getMeId(me: Record<string, unknown>): string {
		const meId = me.id;
		if (typeof meId !== 'number' && typeof meId !== 'string') {
			throw new Error(
				'Failed to determine the SoundCloud account id from the API response.',
			);
		}
		return String(meId);
	}

	private async getAllFollowedUsers(meId: string): Promise<SoundcloudUser[]> {
		return await this.paginateCollection<SoundcloudUser>(
			`users/${meId}/followings`,
			{ limit: 50, offset: 0 },
		);
	}

	private async getAllLikedTracks(meId: string): Promise<SoundcloudTrack[]> {
		const likes = await this.paginateCollection<{ track?: SoundcloudTrack }>(
			`users/${meId}/likes`,
			{ limit: 50, offset: 0 },
		);
		return likes.flatMap((like) => (like.track ? [like.track] : []));
	}

	private async getRepostedTracks(): Promise<SoundcloudTrack[]> {
		const trackIds = await this.paginateCollection<number>(
			'me/track_reposts/ids',
			{
				limit: 200,
				offset: 0,
			},
		);

		if (!trackIds.length) {
			return [];
		}

		return await this.soundcloud.tracks.getArray(trackIds, true);
	}

	private async getOwnedPlaylists(meId: string): Promise<SoundcloudPlaylist[]> {
		const playlists = await this.paginateCollection<SoundcloudPlaylist>(
			`users/${meId}/playlists`,
			{ limit: 50, offset: 0 },
		);

		if (!playlists.length) {
			return [];
		}

		return await Promise.all(
			playlists.map((playlist) => this.soundcloud.playlists.get(playlist.id)),
		);
	}

	private async getRepostedPlaylists(): Promise<SoundcloudPlaylist[]> {
		const playlistIds = await this.paginateCollection<number>(
			'me/playlist_reposts/ids',
			{ limit: 200, offset: 0 },
		);

		if (!playlistIds.length) {
			return [];
		}

		return await Promise.all(
			playlistIds.map((playlistId) =>
				this.soundcloud.playlists.get(playlistId),
			),
		);
	}

	private async paginateCollection<T>(
		endpoint: string,
		params: Record<string, string | number>,
	): Promise<T[]> {
		const response = await this.soundcloud.api.getV2(endpoint, params);
		const collection = Array.isArray(response?.collection)
			? [...response.collection]
			: [];
		let nextHref = response?.next_href as string | null | undefined;
		const seen = new Set<string>();
		const maxPages = 500;
		let pages = 0;

		while (nextHref) {
			if (seen.has(nextHref) || ++pages > maxPages) {
				console.warn(
					`Stopped paginating ${endpoint} after ${pages} pages (repeated or excessive cursor).`,
				);
				break;
			}
			seen.add(nextHref);
			const url = new URL(nextHref);
			const nextParams: Record<string, string> = {};
			for (const [key, value] of url.searchParams.entries()) {
				nextParams[key] = value;
			}

			const nextPage = await this.soundcloud.api.getURL(
				`${url.origin}${url.pathname}`,
				nextParams,
			);
			if (Array.isArray(nextPage?.collection)) {
				collection.push(...nextPage.collection);
			}
			nextHref = nextPage?.next_href as string | null | undefined;
		}

		return collection as T[];
	}
}
