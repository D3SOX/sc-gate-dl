/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
	browserPasswordStorageKey,
	browserRememberStorageKey,
	browserViewWebSocketUrl,
} from './remoteBrowser';

describe('browserViewWebSocketUrl', () => {
	test('converts a noVNC page URL to its WebSocket endpoint', () => {
		expect(
			browserViewWebSocketUrl(
				'http://192.168.178.57:6080/vnc.html?autoconnect=true&resize=scale',
			),
		).toBe('ws://192.168.178.57:6080/websockify');
	});

	test('preserves a reverse-proxy base path and supports wss', () => {
		expect(
			browserViewWebSocketUrl(
				'https://downloads.example.com/novnc/vnc.html?path=socket',
			),
		).toBe('wss://downloads.example.com/novnc/socket');
	});
});

describe('browserPasswordStorageKey', () => {
	test('scopes remembered credentials to the viewer endpoint', () => {
		expect(browserPasswordStorageKey('http://pi:6080/vnc.html')).toBe(
			'sc-gate-dl-vnc-password:ws://pi:6080/websockify',
		);
	});
});

describe('browserRememberStorageKey', () => {
	test('scopes the remember preference beside the viewer password', () => {
		expect(browserRememberStorageKey('http://pi:6080/vnc.html')).toBe(
			'sc-gate-dl-vnc-password:ws://pi:6080/websockify:remember',
		);
	});
});
