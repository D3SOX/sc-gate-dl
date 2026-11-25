import { describe, expect, test } from 'bun:test';
import { apiPortFromEnv } from './apiPort';

describe('apiPortFromEnv', () => {
	test('defaults to 3000 when unset or blank', () => {
		expect(apiPortFromEnv(undefined)).toBe(3000);
		expect(apiPortFromEnv(' ')).toBe(3000);
	});

	test('accepts a valid port', () => {
		expect(apiPortFromEnv(' 8080 ')).toBe(8080);
	});

	test.each(['0', '65536', '-1', '3.5', 'abc'])('rejects %p', (value) => {
		expect(() => apiPortFromEnv(value)).toThrow('SC_GATE_DL_PORT');
	});
});
