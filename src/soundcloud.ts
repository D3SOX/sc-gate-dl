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
	extractAndResolveGateUrl,
	extractCaptchaDeliveryUrl,
	type GateProvider,
	loadCookies,
} from './utils';

const GATE_PROVIDER_LABELS: Record<GateProvider, string> = {
	droploud: 'Droploud',
	gaterush: 'GateRush',
	downloadgater: 'DownloadGater',
	stillhype: 'StillHype',
	direct: 'direct download',
	bandcamp: 'Bandcamp',
	soundcloud: 'SoundCloud',
	hypeddit: 'Hypeddit',
};

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
	 * True if this track is already in the account's reposts (GET, not DataDome PUT).
	 */
	async isTrackReposted(trackUrlOrId: string): Promise<boolean> {
		const track = await this.getTrack(trackUrlOrId);
		const trackId = Number(track.id);
		try {
			const reposts = await this.paginateCollection<
				number | { id?: number | string }
			>('me/track_reposts/ids', { limit: 200, offset: 0 });
			return reposts.some((entry) => {
				const id = typeof entry === 'number' ? entry : Number(entry?.id);
				return id === trackId;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`SoundCloud isTrackReposted check failed for ${trackId}: ${message.slice(0, 160)}`,
			);
			throw error;
		}
	}

	/**
	 * Webi/MUI SoundCloud uses GraphQL `RepostTrack` (not classic PUT
	 * me/track_reposts). Prefer that; fall back to PUT + Chrome-TLS curl.
	 */
	async repostTrack(trackUrlOrId: string): Promise<SoundcloudTrack> {
		const track = await this.getTrack(trackUrlOrId);

		const gql = await this.repostTrackViaGraphql(track);
		if (gql.ok) return track;

		// Bun/fetch GraphQL is often DataDome 403; retry with Chrome TLS.
		if (gql.status === 403 || /captcha-delivery/i.test(gql.body)) {
			const chromeGql = await this.chromeTlsGraphqlRepost(track);
			if (chromeGql.ok) return track;
			gql.status = chromeGql.status;
			gql.reason = chromeGql.reason;
			gql.body = chromeGql.body;
		}

		const endpoint = `me/track_reposts/${track.id}`;
		try {
			await this.soundcloud.api.putV2(endpoint);
			return track;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/status code 403/i.test(message) && !/403/.test(message)) {
				if (/status code (422|409)/i.test(message)) return track;
				throw error;
			}
		}

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

		const captchaUrl =
			extractCaptchaDeliveryUrl(chromeResult.body) ||
			extractCaptchaDeliveryUrl(gql.body);
		const hardBlocked = /you have been blocked|unusual activity/i.test(
			`${chromeResult.body}\n${gql.body}`,
		);
		const proxyHint =
			' Engagement writes are DataDome-protected. Set SC_API_PROXY or CLOAKBROWSER_PROXY to a residential proxy and retry.';
		const error = new Error(
			hardBlocked
				? `Failed to repost SoundCloud track ${track.id}: DataDome hard-blocked this IP.${proxyHint}`
				: `Failed to repost SoundCloud track ${track.id}: GraphQL ${gql.status}/${gql.reason}; PUT HTTP ${chromeResult.status}${chromeResult.body ? ` ${chromeResult.body.slice(0, 160)}` : ''}.${proxyHint}`,
		) as Error & { captchaUrl?: string; status?: number };
		error.status = chromeResult.status || gql.status;
		if (captchaUrl) error.captchaUrl = captchaUrl;
		throw error;
	}

	/**
	 * Same mutation the webi player fires on Repost
	 * (apollographql-client-name: webi).
	 */
	async repostTrackViaGraphql(
		track: SoundcloudTrack | string,
	): Promise<{ ok: boolean; status: number; reason: string; body: string }> {
		const resolved =
			typeof track === 'string' ? await this.getTrack(track) : track;
		const trackUrn = `soundcloud:tracks:${resolved.id}`;
		const clientId =
			this.soundcloud.api.clientId ?? process.env.SC_CLIENT_ID ?? '';
		const oauthToken =
			this.soundcloud.api.oauthToken ?? process.env.SC_OAUTH_TOKEN ?? '';

		const url = new URL('https://graph.soundcloud.com/graphql');
		url.searchParams.set('client_id', clientId);

		const query = `
    mutation RepostTrack($trackUrn: ID!) {
  repostTrack(trackRepost: {urn: $trackUrn}) {
    __typename
    ... on Repost {
      caption
    }
    ... on TrackRepostFailedError {
      errorMessage
    }
    ... on TrackRepostCaptionFailedError {
      errorMessage
    }
  }
}
    `;

		const headers: Record<string, string> = {
			accept: '*/*',
			'content-type': 'application/json',
			origin: 'https://soundcloud.com',
			referer: 'https://soundcloud.com/',
			'apollographql-client-name': 'webi',
			'apollographql-client-version': '0.1.0',
			'app-locale': 'en',
			Authorization: `OAuth ${oauthToken}`,
		};

		try {
			const cookies = await loadCookies('soundcloud-cookies.json');
			const datadome = cookies.find((c) => c.name === 'datadome')?.value;
			if (cookies.length) {
				headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
			}
			if (datadome) headers['x-datadome-clientid'] = datadome;
		} catch {
			// optional
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					query,
					variables: { trackUrn },
				}),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				status: 0,
				reason: `fetch-failed:${message.slice(0, 80)}`,
				body: '',
			};
		}
		const body = await response.text().catch(() => '');

		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				reason: `http-${response.status}`,
				body,
			};
		}

		try {
			const json = JSON.parse(body) as {
				data?: {
					repostTrack?: {
						__typename?: string;
						errorMessage?: string;
					};
				};
				errors?: { message?: string }[];
			};
			const result = json.data?.repostTrack;
			const typename = result?.__typename || '';
			if (typename === 'Repost') {
				return { ok: true, status: 200, reason: 'repost', body };
			}
			if (/FailedError$/i.test(typename)) {
				return {
					ok: false,
					status: 200,
					reason: result?.errorMessage || typename,
					body,
				};
			}
			if (json.errors?.length) {
				return {
					ok: false,
					status: 200,
					reason: json.errors[0]?.message || 'graphql-errors',
					body,
				};
			}
			// Already reposted often still returns a Repost-like payload; accept empty ok typename edge cases via ids check later
			if (typename) {
				return { ok: true, status: 200, reason: typename, body };
			}
		} catch {
			// fall through
		}

		return { ok: false, status: response.status, reason: 'parse-failed', body };
	}

	private async chromeTlsGraphqlRepost(
		track: SoundcloudTrack,
	): Promise<{ ok: boolean; status: number; reason: string; body: string }> {
		const curlBin =
			(await lookpath('curl_chrome131')) ||
			(await lookpath('curl_chrome116')) ||
			(await lookpath('curl-impersonate'));
		if (!curlBin) {
			return {
				ok: false,
				status: 0,
				reason: 'no-curl-chrome',
				body: '',
			};
		}

		const clientId =
			this.soundcloud.api.clientId ?? process.env.SC_CLIENT_ID ?? '';
		const oauthToken =
			this.soundcloud.api.oauthToken ?? process.env.SC_OAUTH_TOKEN ?? '';
		const trackUrn = `soundcloud:tracks:${track.id}`;
		const url = `https://graph.soundcloud.com/graphql?client_id=${encodeURIComponent(clientId)}`;
		const payload = JSON.stringify({
			query: `
    mutation RepostTrack($trackUrn: ID!) {
  repostTrack(trackRepost: {urn: $trackUrn}) {
    __typename
    ... on Repost {
      caption
    }
    ... on TrackRepostFailedError {
      errorMessage
    }
    ... on TrackRepostCaptionFailedError {
      errorMessage
    }
  }
}
    `,
			variables: { trackUrn },
		});

		const escapeCurlConfig = (value: string) =>
			value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		const configLines = [
			`url = "${escapeCurlConfig(url)}"`,
			`header = "Authorization: OAuth ${escapeCurlConfig(oauthToken)}"`,
		];
		const args = [
			'-sS',
			'-w',
			'\n__STATUS__:%{http_code}',
			'-X',
			'POST',
			'-H',
			'Origin: https://soundcloud.com',
			'-H',
			'Referer: https://soundcloud.com/',
			'-H',
			'content-type: application/json',
			'-H',
			'apollographql-client-name: webi',
			'-H',
			'apollographql-client-version: 0.1.0',
			'-H',
			'app-locale: en',
			'-H',
			'accept: */*',
			'--data-binary',
			payload,
		];

		try {
			const cookies = await loadCookies('soundcloud-cookies.json');
			const datadome = cookies.find((c) => c.name === 'datadome')?.value;
			if (cookies.length) {
				const cookieHeader = cookies
					.map((c) => `${c.name}=${c.value}`)
					.join('; ');
				configLines.push(
					`header = "Cookie: ${escapeCurlConfig(cookieHeader)}"`,
				);
			}
			if (datadome) {
				configLines.push(
					`header = "x-datadome-clientid: ${escapeCurlConfig(datadome)}"`,
				);
			}
		} catch {
			// optional
		}

		const proxy =
			process.env.SC_API_PROXY?.trim() ||
			process.env.CLOAKBROWSER_PROXY?.trim() ||
			process.env.PROXY_URL?.trim();
		if (proxy) args.push('-x', proxy);
		args.push('--config', '-');

		const result = await execa(curlBin, args, {
			input: `${configLines.join('\n')}\n`,
			reject: false,
		});
		const output = `${result.stdout}${result.stderr}`;
		const statusMatch = output.match(/__STATUS__:(\d+)\s*$/);
		const status = statusMatch ? Number(statusMatch[1]) : 0;
		const body = output.replace(/\n__STATUS__:\d+\s*$/, '');

		if (status < 200 || status >= 300) {
			return { ok: false, status, reason: `http-${status}`, body };
		}
		try {
			const json = JSON.parse(body) as {
				data?: { repostTrack?: { __typename?: string; errorMessage?: string } };
			};
			const typename = json.data?.repostTrack?.__typename || '';
			if (
				typename === 'Repost' ||
				(!!typename && !/FailedError$/i.test(typename))
			) {
				return { ok: true, status, reason: typename || 'ok', body };
			}
			return {
				ok: false,
				status,
				reason: json.data?.repostTrack?.errorMessage || typename || 'failed',
				body,
			};
		} catch {
			return { ok: false, status, reason: 'parse-failed', body };
		}
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
				const cookieHeader = cookies
					.map((c) => `${c.name}=${c.value}`)
					.join('; ');
				configLines.push(
					`header = "Cookie: ${escapeCurlConfig(cookieHeader)}"`,
				);
			}
			if (datadome) {
				configLines.push(
					`header = "x-datadome-clientid: ${escapeCurlConfig(datadome)}"`,
				);
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
		const gate = await extractAndResolveGateUrl(track);
		if (!gate) {
			return null;
		}
		const providerLabel = GATE_PROVIDER_LABELS[gate.provider];
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
