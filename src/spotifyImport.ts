import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SoundcloudTrack } from 'soundcloud.ts';
import {
	canAccessSoundcloudOriginalDownload,
	YtDlpDownloader,
} from './ytdlp';

const SPOTIFY_API = 'https://api.spotify.com/v1';
const SOUNDCLOUD_API = 'https://api-v2.soundcloud.com';
const DEFAULT_MATCH_THRESHOLD = 0.86;
const DEFAULT_CANDIDATE_LIMIT = 20;

export type SpotifyImportTrack = {
	spotifyId: string | null;
	uri: string;
	title: string;
	artists: string[];
	album?: string;
	durationMs: number;
	isLocal: boolean;
	playlists: string[];
	liked: boolean;
};

export type MatchCandidate = {
	url: string;
	title: string;
	artist: string;
	durationMs: number;
	score: number;
	downloadable: boolean;
	hasDownloadsLeft: boolean;
};

export type ImportResult = {
	track: SpotifyImportTrack;
	status:
		| 'local'
		| 'matched'
		| 'downloaded'
		| 'no-match'
		| 'download-unavailable'
		| 'download-failed';
	match?: MatchCandidate;
	candidates?: MatchCandidate[];
	filename?: string;
	error?: string;
};

type SpotifyArtist = { name?: string };
type SpotifyAlbum = { name?: string };
type SpotifyTrackObject = {
	id?: string | null;
	uri?: string;
	name?: string;
	duration_ms?: number;
	is_local?: boolean;
	artists?: SpotifyArtist[];
	album?: SpotifyAlbum;
	type?: string;
};

type SpotifyPage<T> = {
	items?: T[];
	next?: string | null;
};

type SpotifyPlaylist = {
	id?: string;
	name?: string;
	owner?: { id?: string };
	collaborative?: boolean;
};

type SoundcloudSearchResponse = {
	collection?: SoundcloudTrack[];
};

type SpotifyImportOptions = {
	spotifyAccessToken: string;
	includeLiked?: boolean;
	includeAllPlaylists?: boolean;
	playlistIds?: string[];
	autoDownload?: boolean;
	matchThreshold?: number;
	candidateLimit?: number;
};

type SpotifyCollectionError = {
	source: string;
	error: string;
};

function normalize(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function tokenScore(a: string, b: string): number {
	const left = normalize(a);
	const right = normalize(b);
	if (!left || !right) return 0;
	if (left === right) return 1;
	if (left.includes(right) || right.includes(left)) return 0.92;

	const leftTokens = new Set(left.split(' '));
	const rightTokens = new Set(right.split(' '));
	let intersection = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) intersection += 1;
	}
	const union = leftTokens.size + rightTokens.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function candidateTitleScore(candidate: string, wanted: string): number {
	const parts = candidate
		.split(/\s[-–—]\s/)
		.map((part) => part.trim())
		.filter(Boolean);
	let best = tokenScore(candidate, wanted);
	for (const part of parts) {
		best = Math.max(best, tokenScore(part, wanted));
	}
	return best;
}

const VERSION_MARKERS = [
	'live',
	'remix',
	'edit',
	'bootleg',
	'mashup',
	'cover',
	'karaoke',
	'instrumental',
	'acapella',
	'acoustic',
	'slowed',
	'sped up',
	'nightcore',
];

function variantPenalty(candidateTitle: string, wantedTitle: string): number {
	const candidate = normalize(candidateTitle);
	const wanted = normalize(wantedTitle);
	let penalty = 0;
	for (const marker of VERSION_MARKERS) {
		const normalizedMarker = normalize(marker);
		if (
			candidate.includes(normalizedMarker) &&
			!wanted.includes(normalizedMarker)
		) {
			penalty += 0.12;
		}
	}
	return Math.min(0.36, penalty);
}

function durationScore(candidateMs: number, wantedMs: number): number {
	if (!candidateMs || !wantedMs) return 0.5;
	const delta = Math.abs(candidateMs - wantedMs);
	if (delta <= 2_000) return 1;
	if (delta <= 5_000) return 0.9;
	if (delta <= 10_000) return 0.7;
	if (delta <= 20_000) return 0.35;
	return 0;
}

type MatchableSoundcloudTrack = {
	title?: string | null;
	duration?: number | null;
	publisher_metadata?: { artist?: string | null } | null;
	user?: {
		full_name?: string | null;
		username?: string | null;
	} | null;
};

function candidateArtist(track: MatchableSoundcloudTrack): string {
	return (
		track.publisher_metadata?.artist ||
		track.user?.full_name ||
		track.user?.username ||
		''
	);
}

export function scoreSoundcloudCandidate(
	wanted: SpotifyImportTrack,
	candidate: MatchableSoundcloudTrack,
): number {
	const title = candidateTitleScore(candidate.title || '', wanted.title);
	const artist = tokenScore(candidateArtist(candidate), wanted.artists.join(' '));
	const duration = durationScore(candidate.duration || 0, wanted.durationMs);
	const score = title * 0.5 + artist * 0.3 + duration * 0.2;
	return Math.max(
		0,
		Math.min(1, score - variantPenalty(candidate.title || '', wanted.title)),
	);
}

async function spotifyFetch<T>(
	url: string,
	accessToken: string,
): Promise<T> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
			signal: AbortSignal.timeout(30_000),
		});

		if (response.status === 429 && attempt < 3) {
			const retryAfter = Number(response.headers.get('retry-after') || '1');
			await Bun.sleep(Math.max(1, retryAfter) * 1000);
			continue;
		}

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(
				`Spotify API ${response.status} for ${url}: ${body.slice(0, 300)}`,
			);
		}
		return (await response.json()) as T;
	}
	throw new Error(`Spotify API retry limit reached for ${url}`);
}

async function spotifyPages<T>(
	url: string,
	accessToken: string,
): Promise<T[]> {
	const items: T[] = [];
	let next: string | null = url;
	while (next) {
		const page: SpotifyPage<T> = await spotifyFetch<SpotifyPage<T>>(
			next,
			accessToken,
		);
		items.push(...(page.items ?? []));
		next = page.next ?? null;
	}
	return items;
}

function parseSpotifyTrack(
	track: SpotifyTrackObject | null | undefined,
	source: { playlist?: string; liked?: boolean },
): SpotifyImportTrack | null {
	if (!track || track.type === 'episode') return null;
	const title = track.name?.trim();
	const uri = track.uri?.trim();
	if (!title || !uri) return null;

	return {
		spotifyId: track.id ?? null,
		uri,
		title,
		artists: (track.artists ?? [])
			.map((artist) => artist.name?.trim())
			.filter((name): name is string => Boolean(name)),
		album: track.album?.name?.trim() || undefined,
		durationMs: track.duration_ms ?? 0,
		isLocal: Boolean(track.is_local || uri.startsWith('spotify:local:')),
		playlists: source.playlist ? [source.playlist] : [],
		liked: Boolean(source.liked),
	};
}

function mergeTrack(
	map: Map<string, SpotifyImportTrack>,
	track: SpotifyImportTrack,
): void {
	const key = track.isLocal
		? `local:${normalize(track.artists.join(' '))}:${normalize(track.title)}:${track.durationMs}`
		: track.uri;
	const existing = map.get(key);
	if (!existing) {
		map.set(key, track);
		return;
	}
	existing.liked ||= track.liked;
	for (const playlist of track.playlists) {
		if (!existing.playlists.includes(playlist)) existing.playlists.push(playlist);
	}
}

function playlistIdFromValue(value: string): string {
	const trimmed = value.trim();
	if (/^[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
	try {
		const url = new URL(trimmed);
		const parts = url.pathname.split('/').filter(Boolean);
		const playlistIndex = parts.indexOf('playlist');
		if (playlistIndex >= 0 && parts[playlistIndex + 1]) {
			return parts[playlistIndex + 1];
		}
	} catch {
		// handled below
	}
	throw new Error(`Invalid Spotify playlist ID or URL: ${value}`);
}

async function collectPlaylist(
	playlistId: string,
	accessToken: string,
	target: Map<string, SpotifyImportTrack>,
): Promise<void> {
	const metadata = await spotifyFetch<SpotifyPlaylist>(
		`${SPOTIFY_API}/playlists/${encodeURIComponent(playlistId)}`,
		accessToken,
	);
	const playlistName = metadata.name?.trim() || playlistId;
	const items = await spotifyPages<{ item?: SpotifyTrackObject | null }>(
		`${SPOTIFY_API}/playlists/${encodeURIComponent(playlistId)}/items?limit=100`,
		accessToken,
	);
	for (const entry of items) {
		const parsed = parseSpotifyTrack(entry.item, { playlist: playlistName });
		if (parsed) mergeTrack(target, parsed);
	}
}

async function collectSpotifyLibrary(options: SpotifyImportOptions): Promise<{
	tracks: SpotifyImportTrack[];
	errors: SpotifyCollectionError[];
}> {
	const tracks = new Map<string, SpotifyImportTrack>();
	const errors: SpotifyCollectionError[] = [];

	if (options.includeLiked) {
		const items = await spotifyPages<{ track?: SpotifyTrackObject | null }>(
			`${SPOTIFY_API}/me/tracks?limit=50`,
			options.spotifyAccessToken,
		);
		for (const entry of items) {
			const parsed = parseSpotifyTrack(entry.track, { liked: true });
			if (parsed) mergeTrack(tracks, parsed);
		}
	}

	const playlistIds = new Set(
		(options.playlistIds ?? []).map(playlistIdFromValue),
	);

	if (options.includeAllPlaylists) {
		const playlists = await spotifyPages<SpotifyPlaylist>(
			`${SPOTIFY_API}/me/playlists?limit=50`,
			options.spotifyAccessToken,
		);
		for (const playlist of playlists) {
			if (playlist.id) playlistIds.add(playlist.id);
		}
	}

	for (const playlistId of playlistIds) {
		try {
			await collectPlaylist(playlistId, options.spotifyAccessToken, tracks);
		} catch (error) {
			errors.push({
				source: `playlist:${playlistId}`,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { tracks: [...tracks.values()], errors };
}

async function searchSoundcloud(
	wanted: SpotifyImportTrack,
	limit: number,
): Promise<SoundcloudTrack[]> {
	const clientId = process.env.SC_CLIENT_ID?.trim();
	const oauthToken = process.env.SC_OAUTH_TOKEN?.trim();
	if (!clientId || !oauthToken) {
		throw new Error(
			'SC_CLIENT_ID and SC_OAUTH_TOKEN are required for SoundCloud search.',
		);
	}

	const query = [wanted.artists.join(' '), wanted.title].filter(Boolean).join(' ');
	const url = new URL(`${SOUNDCLOUD_API}/search/tracks`);
	url.searchParams.set('q', query);
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('offset', '0');
	url.searchParams.set('linked_partitioning', '1');
	url.searchParams.set('client_id', clientId);

	const response = await fetch(url, {
		headers: {
			Authorization: `OAuth ${oauthToken}`,
			Accept: 'application/json',
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(
			`SoundCloud search failed with ${response.status}: ${body.slice(0, 300)}`,
		);
	}
	const payload = (await response.json()) as SoundcloudSearchResponse;
	return payload.collection ?? [];
}

function toCandidate(
	wanted: SpotifyImportTrack,
	track: SoundcloudTrack,
): MatchCandidate | null {
	const url = track.permalink_url;
	if (!url) return null;
	return {
		url,
		title: track.title || '',
		artist: candidateArtist(track),
		durationMs: track.duration || 0,
		score: scoreSoundcloudCandidate(wanted, track),
		downloadable: Boolean(track.downloadable),
		hasDownloadsLeft: Boolean(track.has_downloads_left),
	};
}

function timestampForPath(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function runSpotifyImport(
	options: SpotifyImportOptions,
): Promise<{ reportPath: string; results: ImportResult[] }> {
	const threshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
	const candidateLimit = Math.min(
		50,
		Math.max(1, options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT),
	);
	const { tracks, errors: collectionErrors } =
		await collectSpotifyLibrary(options);
	const results: ImportResult[] = [];

	for (const [index, wanted] of tracks.entries()) {
		console.log(
			`[${index + 1}/${tracks.length}] ${wanted.artists.join(', ')} - ${wanted.title}`,
		);

		if (wanted.isLocal) {
			results.push({ track: wanted, status: 'local' });
			continue;
		}

		try {
			const found = await searchSoundcloud(wanted, candidateLimit);
			const candidates = found
				.map((track) => toCandidate(wanted, track))
				.filter((candidate): candidate is MatchCandidate => Boolean(candidate))
				.sort((a, b) => b.score - a.score);
			const best = candidates[0];

			if (!best || best.score < threshold) {
				results.push({
					track: wanted,
					status: 'no-match',
					candidates: candidates.slice(0, 5),
				});
				continue;
			}

			if (!options.autoDownload) {
				results.push({
					track: wanted,
					status: 'matched',
					match: best,
					candidates: candidates.slice(0, 5),
				});
				continue;
			}

			if (!(best.downloadable && best.hasDownloadsLeft)) {
				results.push({
					track: wanted,
					status: 'download-unavailable',
					match: best,
					candidates: candidates.slice(0, 5),
				});
				continue;
			}

			const canDownloadOriginal =
				await canAccessSoundcloudOriginalDownload(best.url);
			if (!canDownloadOriginal) {
				results.push({
					track: wanted,
					status: 'download-unavailable',
					match: best,
					candidates: candidates.slice(0, 5),
					error:
						'Creator download is exposed by SoundCloud, but the authenticated original-download format was not accessible.',
				});
				continue;
			}

			try {
				const downloader = new YtDlpDownloader('SoundCloud');
				const filename = await downloader.downloadAudio(best.url, {
					matchTitle: wanted.title,
				});
				results.push({
					track: wanted,
					status: 'downloaded',
					match: best,
					candidates: candidates.slice(0, 5),
					filename,
				});
			} catch (error) {
				results.push({
					track: wanted,
					status: 'download-failed',
					match: best,
					candidates: candidates.slice(0, 5),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} catch (error) {
			results.push({
				track: wanted,
				status: 'no-match',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	await mkdir('./exports', { recursive: true });
	const reportPath = join(
		'./exports',
		`spotify-soundcloud-import-${timestampForPath()}.json`,
	);
	await writeFile(
		reportPath,
		JSON.stringify(
			{
				createdAt: new Date().toISOString(),
				matchThreshold: threshold,
				autoDownload: Boolean(options.autoDownload),
				collectionErrors,
				summary: {
					total: results.length,
					local: results.filter((result) => result.status === 'local').length,
					matched: results.filter((result) => result.status === 'matched').length,
					downloaded: results.filter((result) => result.status === 'downloaded')
						.length,
					noMatch: results.filter((result) => result.status === 'no-match')
						.length,
					downloadUnavailable: results.filter(
						(result) => result.status === 'download-unavailable',
					).length,
					downloadFailed: results.filter(
						(result) => result.status === 'download-failed',
					).length,
				},
				results,
			},
			null,
			2,
		),
		'utf8',
	);

	return { reportPath, results };
}
