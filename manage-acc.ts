import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SoundcloudClient } from './src/soundcloud.ts';

const clientId = process.env.MANAGED_SC_CLIENT_ID;
const oauthToken = process.env.MANAGED_SC_OAUTH_TOKEN;

if (!clientId || !oauthToken) {
	throw new Error(
		'MANAGED_SC_CLIENT_ID and MANAGED_SC_OAUTH_TOKEN are required. Please set them in your .env file.',
	);
}

const client = new SoundcloudClient({
	credentials: {
		clientId,
		oauthToken,
	},
});

const exportData = await client.exportManagedAccountData();
const me = exportData.me;
console.log(
	`Using managed SoundCloud account: ${getString(me.username) ?? getString(me.id) ?? 'unknown'}`,
);
const accountSlug = sanitizePathSegment(
	getString(me.permalink) ??
		getString(me.username) ??
		getString(me.id) ??
		'managed-account',
);
const timestamp = new Date().toISOString().replaceAll(':', '-');
const exportDir = join('exports', `${accountSlug}-${timestamp}`);

await mkdir(exportDir, { recursive: true });

await Promise.all([
	writeJson(join(exportDir, 'account.json'), exportData.me),
	writeJson(join(exportDir, 'followed-users.json'), exportData.followedUsers),
	writeJson(join(exportDir, 'liked-tracks.json'), exportData.likedTracks),
	writeJson(join(exportDir, 'reposted-tracks.json'), exportData.repostedTracks),
	writeJson(join(exportDir, 'playlists.json'), exportData.ownedPlaylists),
	writeJson(
		join(exportDir, 'reposted-playlists.json'),
		exportData.repostedPlaylists,
	),
	writeJson(join(exportDir, 'summary.json'), {
		exportedAt: new Date().toISOString(),
		credentialsSource: 'MANAGED_SC_CLIENT_ID / MANAGED_SC_OAUTH_TOKEN',
		account: {
			id: getString(me.id),
			username: getString(me.username),
			permalink: getString(me.permalink),
			permalinkUrl: getString(me.permalink_url),
		},
		counts: {
			followedUsers: exportData.followedUsers.length,
			likedTracks: exportData.likedTracks.length,
			repostedTracks: exportData.repostedTracks.length,
			playlists: exportData.ownedPlaylists.length,
			repostedPlaylists: exportData.repostedPlaylists.length,
		},
	}),
]);

console.log(`Managed account export written to ${exportDir}`);
console.log(`- followed users: ${exportData.followedUsers.length}`);
console.log(`- liked tracks: ${exportData.likedTracks.length}`);
console.log(`- reposted tracks: ${exportData.repostedTracks.length}`);
console.log(`- playlists: ${exportData.ownedPlaylists.length}`);
console.log(`- reposted playlists: ${exportData.repostedPlaylists.length}`);

async function writeJson(path: string, data: unknown) {
	await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
}

function getString(value: unknown): string | undefined {
	if (typeof value === 'string' || typeof value === 'number') {
		return String(value);
	}
	return undefined;
}

function sanitizePathSegment(value: string): string {
	return value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}
