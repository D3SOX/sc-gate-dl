import { runSpotifyImport } from './src/spotifyImport';

function usage(): never {
	console.log(`Usage:
  SPOTIFY_ACCESS_TOKEN=... bun run spotify-import [options]

Options:
  --liked                 Include Liked Songs
  --playlists             Include every playlist returned by /me/playlists
  --playlist <id-or-url>  Include one playlist (repeatable)
  --download              Download only creator-enabled originals after a high-confidence match
  --min-score <0..1>      Match threshold (default: 0.86)
  --candidates <n>        SoundCloud candidates per track (default: 20)
  --help                  Show this help

If no source flag is supplied, --liked and --playlists are both enabled.
Spotify scopes: user-library-read, playlist-read-private, playlist-read-collaborative.
`);
	process.exit(0);
}

const args = process.argv.slice(2);
let includeLiked = false;
let includeAllPlaylists = false;
let sourceFlagSeen = false;
let autoDownload = false;
let matchThreshold: number | undefined;
let candidateLimit: number | undefined;
const playlistIds: string[] = [];

for (let index = 0; index < args.length; index++) {
	const arg = args[index];
	if (arg === '--help' || arg === '-h') usage();
	if (arg === '--liked') {
		includeLiked = true;
		sourceFlagSeen = true;
		continue;
	}
	if (arg === '--playlists') {
		includeAllPlaylists = true;
		sourceFlagSeen = true;
		continue;
	}
	if (arg === '--download') {
		autoDownload = true;
		continue;
	}
	if (arg === '--playlist') {
		const value = args[++index];
		if (!value) throw new Error('--playlist requires an ID or URL');
		playlistIds.push(value);
		sourceFlagSeen = true;
		continue;
	}
	if (arg === '--min-score') {
		const value = Number(args[++index]);
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			throw new Error('--min-score must be between 0 and 1');
		}
		matchThreshold = value;
		continue;
	}
	if (arg === '--candidates') {
		const value = Number(args[++index]);
		if (!Number.isInteger(value) || value < 1 || value > 50) {
			throw new Error('--candidates must be an integer between 1 and 50');
		}
		candidateLimit = value;
		continue;
	}
	throw new Error(`Unknown option: ${arg}`);
}

if (!sourceFlagSeen) {
	includeLiked = true;
	includeAllPlaylists = true;
}

const spotifyAccessToken = process.env.SPOTIFY_ACCESS_TOKEN?.trim();
if (!spotifyAccessToken) {
	throw new Error(
		'SPOTIFY_ACCESS_TOKEN is required. Use a user OAuth token with user-library-read and playlist read scopes.',
	);
}

const { reportPath, results } = await runSpotifyImport({
	spotifyAccessToken,
	includeLiked,
	includeAllPlaylists,
	playlistIds,
	autoDownload,
	matchThreshold,
	candidateLimit,
});

const downloaded = results.filter((result) => result.status === 'downloaded').length;
const matched = results.filter((result) => result.status === 'matched').length;
const local = results.filter((result) => result.status === 'local').length;
const unresolved = results.length - downloaded - matched - local;

console.log('');
console.log(`Report: ${reportPath}`);
console.log(
	`Total: ${results.length} | downloaded: ${downloaded} | matched: ${matched} | local: ${local} | unresolved: ${unresolved}`,
);
