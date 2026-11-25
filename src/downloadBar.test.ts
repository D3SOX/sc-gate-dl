import { describe, expect, test } from 'bun:test';
import { createDownloadBar } from './downloadBar';

describe('createDownloadBar without a known size', () => {
	test('prints a throttled MB line and a final total', () => {
		const lines: string[] = [];
		let time = 10_000;
		const bar = createDownloadBar(
			0,
			(l) => lines.push(l),
			() => time,
		);
		bar.update(1024 * 1024);
		bar.update(2 * 1024 * 1024);
		expect(lines).toEqual(['Downloading... 1 MB']);
		time += 5_000;
		bar.update(3 * 1024 * 1024);
		bar.stop();
		expect(lines).toEqual([
			'Downloading... 1 MB',
			'Downloading... 3 MB',
			'Downloaded 3 MB',
		]);
	});

	test('stop prints once, and reports a failed download as stopped', () => {
		const lines: string[] = [];
		const bar = createDownloadBar(
			0,
			(l) => lines.push(l),
			() => 10_000,
		);
		bar.update(2 * 1024 * 1024);
		bar.stop(false);
		bar.stop();
		expect(lines).toEqual(['Downloading... 2 MB', 'Download stopped at 2 MB']);
	});
});
