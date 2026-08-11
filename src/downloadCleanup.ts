import { basename, join } from 'node:path';

const INCOMPLETE_SUFFIXES = ['.crdownload', '.part'] as const;

function isIncompleteDownloadName(name: string): boolean {
	return INCOMPLETE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Only allow plain downloads/ basenames (no path separators / traversal). */
export function safeDownloadBasename(name: string): string | null {
	const base = basename(name);
	if (!base || base !== name || base === '.' || base === '..') return null;
	return base;
}

/** Remove a downloads/ entry and ignore missing/busy files. */
async function removeDownloadEntry(
	downloadsDir: string,
	name: string,
): Promise<boolean> {
	const base = safeDownloadBasename(name);
	if (!base) return false;
	const path = join(downloadsDir, base);
	try {
		await Bun.file(path).delete();
		return true;
	} catch {
		return false;
	}
}

/**
 * Drop files left behind when a job is cancelled mid-download.
 * Removes known job outputs plus Chromium/yt-dlp incomplete temps
 * (`.crdownload`, `.part`). Safe while downloads are serialized.
 */
export async function cleanupCancelledDownloadArtifacts(options: {
	downloadsDir?: string;
	filenames?: Array<string | null | undefined>;
	sweepIncomplete?: boolean;
}): Promise<string[]> {
	const downloadsDir = options.downloadsDir ?? './downloads';
	const removed: string[] = [];

	const known = new Set<string>();
	for (const filename of options.filenames ?? []) {
		if (!filename) continue;
		const base = safeDownloadBasename(filename);
		if (!base) continue;
		known.add(base);
		known.add(`${base}.crdownload`);
		known.add(`${base}.part`);
	}

	for (const name of known) {
		if (await removeDownloadEntry(downloadsDir, name)) {
			removed.push(name);
		}
	}

	if (options.sweepIncomplete === false) return removed;

	try {
		for await (const entry of new Bun.Glob('*').scan({
			cwd: downloadsDir,
			onlyFiles: true,
		})) {
			if (!isIncompleteDownloadName(entry)) continue;
			if (known.has(entry)) continue;
			if (await removeDownloadEntry(downloadsDir, entry)) {
				removed.push(entry);
			}
		}
	} catch {
		return removed;
	}

	return removed;
}
