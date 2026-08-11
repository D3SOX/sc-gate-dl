/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { createMobileRemoteControls } from './mobileRemoteControls';
import {
	browserPasswordStorageKey,
	browserRememberStorageKey,
	browserViewWebSocketUrl,
	markInternalRemotePointerRelease,
	shouldBlockRemoteMouseEvent,
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
	const touch = (identifier: number, clientX: number, clientY: number) => ({
		identifier,
		clientX,
		clientY,
	});

	function setup(zoom = 2) {
		const pointerMoves: Array<[number, number]> = [];
		const clicks: Array<[number, number, 0 | 2]> = [];
		const pans: Array<[number, number]> = [];
		const panning: boolean[] = [];
		let longPress: (() => void) | null = null;
		const controls = createMobileRemoteControls({
			getZoom: () => zoom,
			moveTolerance: 10,
			longPressMs: 550,
			schedule: (callback) => {
				longPress = callback;
				return () => {
					longPress = null;
				};
			},
			movePointer: (x, y) => pointerMoves.push([x, y]),
			click: (x, y, button) => clicks.push([x, y, button]),
			panBy: (x, y) => pans.push([x, y]),
			setPanning: (active) => panning.push(active),
		});
		return {
			controls,
			pointerMoves,
			clicks,
			pans,
			panning,
			fireLongPress: () => longPress?.(),
		};
	}

	test('moves the pointer with one finger without clicking after a drag', () => {
		const { controls, pointerMoves, clicks } = setup();
		controls.start([touch(1, 20, 30)]);
		controls.move([touch(1, 42, 55)]);
		controls.end([], [touch(1, 42, 55)]);

		expect(pointerMoves).toEqual([[42, 55]]);
		expect(clicks).toEqual([]);
	});

	test('maps a tap to left-click and a stationary hold to right-click', () => {
		const tap = setup();
		tap.controls.start([touch(1, 20, 30)]);
		tap.controls.end([], [touch(1, 20, 30)]);
		expect(tap.clicks).toEqual([[20, 30, 0]]);

		const hold = setup();
		hold.controls.start([touch(1, 40, 50)]);
		hold.fireLongPress();
		hold.controls.end([], [touch(1, 40, 50)]);
		expect(hold.clicks).toEqual([[40, 50, 2]]);
	});

	test('pans with two fingers and resumes pointer movement with the remainder', () => {
		const { controls, pans, panning, pointerMoves, clicks } = setup();
		const first = touch(1, 20, 30);
		const second = touch(2, 60, 70);
		controls.start([first]);
		controls.start([first, second]);
		controls.move([touch(1, 30, 45), touch(2, 70, 85)]);
		controls.end([touch(1, 30, 45)], [touch(2, 70, 85)]);
		controls.move([touch(1, 36, 53)]);
		controls.end([], [touch(1, 36, 53)]);

		expect(pans).toEqual([[10, 15]]);
		expect(panning).toContain(true);
		expect(pointerMoves).toEqual([[36, 53]]);
		expect(clicks).toEqual([]);
	});
});
