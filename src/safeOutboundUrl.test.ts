import { describe, expect, test } from 'bun:test';
import { resolveSafeConnectTarget } from './safeOutboundUrl';

describe('resolveSafeConnectTarget', () => {
	test.each([
		'http://127.0.0.1/x.mp3',
		'http://10.1.2.3/',
		'http://192.168.1.1/',
		'http://198.18.0.1/',
		'http://224.0.0.1/',
		'http://255.255.255.255/',
		'http://[::1]/',
		'http://[fd00::1]/',
		'http://[::ffff:127.0.0.1]:3000/x.mp3',
		'http://[::ffff:192.168.1.1]/',
		'http://[::127.0.0.1]/',
		'http://[64:ff9b::127.0.0.1]/',
		'http://[64:ff9b::10.0.0.1]/',
		'http://[64:ff9b:1::1]/x.mp3',
	])('rejects %s', async (url) => {
		await expect(resolveSafeConnectTarget(url)).rejects.toThrow(
			/^Refusing to fetch/,
		);
	});

	test.each([
		'https://8.8.8.8/',
		'http://[::ffff:8.8.8.8]/',
		'http://[64:ff9b::8.8.8.8]/',
		'http://[2606:4700:4700::1111]/',
	])('allows %s', async (url) => {
		await expect(resolveSafeConnectTarget(url)).resolves.toMatchObject({
			url: new URL(url),
		});
	});
});
