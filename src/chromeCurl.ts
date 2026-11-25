import { readdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const CHROME_CURL = /^curl_chrome(\d+)$/;

/**
 * Returns the curl-impersonate wrapper for the newest Chrome version on PATH
 * (e.g. `curl_chrome150`), so the TLS fingerprint stays current as the
 * package updates. Skips variants such as `curl_chrome133a` and `_android`.
 */
export async function findNewestChromeCurl(
	path = process.env.PATH ?? '',
): Promise<string | undefined> {
	let best: { version: number; bin: string } | undefined;
	for (const dir of path.split(delimiter).filter(Boolean)) {
		const entries = await readdir(dir).catch(() => [] as string[]);
		for (const entry of entries) {
			const version = Number(CHROME_CURL.exec(entry)?.[1]);
			if (version > (best?.version ?? 0)) {
				best = { version, bin: join(dir, entry) };
			}
		}
	}
	return best?.bin;
}

let cached: Promise<string | undefined> | undefined;

export function chromeCurl(): Promise<string | undefined> {
	cached ??= findNewestChromeCurl();
	return cached;
}
