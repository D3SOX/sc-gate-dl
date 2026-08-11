/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { isAllowedCorsOrigin } from './serverCors';

describe('isAllowedCorsOrigin', () => {
	test('allows a Web UI served from the API host', () => {
		expect(
			isAllowedCorsOrigin(
				'http://192.168.178.57:3000/api/capabilities',
				'http://192.168.178.57:4321',
			),
		).toBe(true);
	});

	test('rejects an unrelated network origin', () => {
		expect(
			isAllowedCorsOrigin(
				'http://192.168.178.57:3000/api/capabilities',
				'http://192.168.178.99:4321',
			),
		).toBe(false);
	});

	test('allows explicitly configured origins', () => {
		expect(
			isAllowedCorsOrigin(
				'https://api.example.com/api/capabilities',
				'https://downloads.example.com',
				'https://downloads.example.com',
			),
		).toBe(true);
	});
});
