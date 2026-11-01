/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
	isAllowedCorsOrigin,
	isForbiddenCrossOriginRequest,
} from './serverCors';

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

describe('isForbiddenCrossOriginRequest', () => {
	const url = 'http://localhost:3000/api/soundcloud/cleanup';
	const request = (method: string, origin?: string) =>
		new Request(url, {
			method,
			headers: origin ? { Origin: origin } : {},
		});

	test('rejects a POST from an unrelated website', () => {
		expect(
			isForbiddenCrossOriginRequest(request('POST', 'https://evil.example')),
		).toBe(true);
		expect(isForbiddenCrossOriginRequest(request('POST', 'null'))).toBe(true);
	});

	test('allows allowlisted origins, safe methods and non-browser clients', () => {
		expect(
			isForbiddenCrossOriginRequest(request('POST', 'http://localhost:4321')),
		).toBe(false);
		expect(
			isForbiddenCrossOriginRequest(request('GET', 'https://evil.example')),
		).toBe(false);
		expect(isForbiddenCrossOriginRequest(request('POST'))).toBe(false);
	});
});
