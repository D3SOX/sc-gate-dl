/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { resolveApiBase } from './apiBase';

describe('resolveApiBase', () => {
	test('uses the host serving the Web UI', () => {
		expect(resolveApiBase({ origin: 'http://192.168.178.57:4321' })).toBe(
			'http://192.168.178.57:3000',
		);
	});

	test('supports an explicitly configured public API URL', () => {
		expect(
			resolveApiBase(
				{ origin: 'https://downloads.example.com' },
				'https://api.example.com/',
			),
		).toBe('https://api.example.com');
	});

	test('keeps localhost as the server-rendering fallback', () => {
		expect(resolveApiBase(undefined)).toBe('http://localhost:3000');
	});

	test('adds the API port when the Web UI origin omits one', () => {
		expect(resolveApiBase({ origin: 'https://downloads.example.com' })).toBe(
			'https://downloads.example.com:3000',
		);
	});

	test('ignores a blank configured API base', () => {
		expect(
			resolveApiBase({ origin: 'http://192.168.178.57:4321' }, '   '),
		).toBe('http://192.168.178.57:3000');
	});
});
