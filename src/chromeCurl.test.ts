import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findNewestChromeCurl } from './chromeCurl';

describe('findNewestChromeCurl', () => {
	test('picks the highest plain Chrome version across PATH', async () => {
		const a = await mkdtemp(join(tmpdir(), 'chrome-curl-'));
		const b = await mkdtemp(join(tmpdir(), 'chrome-curl-'));
		try {
			for (const name of [
				'curl_chrome99',
				'curl_chrome131',
				'curl_chrome200_android',
				'curl_chrome300a',
				'curl_firefox400',
			]) {
				await writeFile(join(a, name), '');
			}
			await writeFile(join(b, 'curl_chrome150'), '');
			const path = [join(a, 'missing'), a, b].join(delimiter);
			expect(await findNewestChromeCurl(path)).toBe(join(b, 'curl_chrome150'));
		} finally {
			await rm(a, { recursive: true });
			await rm(b, { recursive: true });
		}
	});

	test('returns undefined without a Chrome wrapper', async () => {
		expect(await findNewestChromeCurl('')).toBeUndefined();
	});
});
