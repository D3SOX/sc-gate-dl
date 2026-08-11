/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
	browserPasswordStorageKey,
	browserRememberStorageKey,
	browserViewWebSocketUrl,
	markInternalRemotePointerRelease,
	shouldBlockRemoteMouseEvent,
} from './remoteBrowser';

const panelSource = await Bun.file(
	new URL('./RemoteBrowserPanel.tsx', import.meta.url),
).text();

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

describe('remote pointer release', () => {
	test('lets the internal release reach noVNC during local viewport gestures', () => {
		const release = markInternalRemotePointerRelease(new Event('mouseup'));
		expect(shouldBlockRemoteMouseEvent(release, true, true)).toBeFalse();
		expect(
			shouldBlockRemoteMouseEvent(new Event('mouseup'), true, true),
		).toBeTrue();
	});
});

describe('mobile remote controls', () => {
	test('owns touch events before noVNC and maps the requested gestures', () => {
		expect(panelSource).toContain("screen.addEventListener('touchstart'");
		expect(panelSource).toContain("dispatchRemoteMouse('mousemove'");
		expect(panelSource).toContain(
			'clickRemote(session.lastX, session.lastY, 2)',
		);
		expect(panelSource).toContain(
			'screen.scrollLeft -= nextCenter.x - panCenter.x',
		);
	});

	test('does not reuse the touch pointer while a local viewport gesture runs', () => {
		expect(panelSource).toContain("event.pointerType === 'touch'");
		expect(panelSource).toContain('viewportInteractionRef.current ||');
		expect(panelSource).not.toContain('beginViewportZoom(event, true)');
	});
});
