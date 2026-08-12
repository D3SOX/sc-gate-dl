/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { createMobileRemoteControls } from './mobileRemoteControls';
import {
	browserPasswordStorageKey,
	browserRememberStorageKey,
	browserViewWebSocketUrl,
	markInternalRemotePointerRelease,
	normalizedRemotePointer,
	remotePointerClientPosition,
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

describe('remote pointer coordinates', () => {
	test('preserves the remote location after canvas pan and zoom', () => {
		const pointer = normalizedRemotePointer(
			{ x: 250, y: 150 },
			{ left: 50, top: 50, width: 400, height: 200 },
		);

		expect(pointer).toEqual({ x: 0.5, y: 0.5 });
		expect(
			remotePointerClientPosition(pointer, {
				left: -100,
				top: -50,
				width: 800,
				height: 400,
			}),
		).toEqual({ x: 300, y: 150 });
	});

	test('applies relative movement from the transformed pointer location', () => {
		const transformed = { left: -100, top: -50, width: 800, height: 400 };
		const current = remotePointerClientPosition(
			{ x: 0.5, y: 0.5 },
			transformed,
		);
		const moved = normalizedRemotePointer(
			{ x: current.x + 40, y: current.y - 20 },
			transformed,
		);

		expect(moved.x).toBeCloseTo(0.55, 2);
		expect(moved.y).toBeCloseTo(0.45, 2);
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
		const clicks: Array<0 | 2> = [];
		const pans: Array<[number, number]> = [];
		const panning: boolean[] = [];
		const zooms: Array<[number, number, number]> = [];
		const zooming: boolean[] = [];
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
			movePointerBy: (x, y) => pointerMoves.push([x, y]),
			click: (button) => clicks.push(button),
			panBy: (x, y) => pans.push([x, y]),
			setPanning: (active) => panning.push(active),
			zoomBy: (deltaY, x, y) => zooms.push([deltaY, x, y]),
			setZooming: (active) => zooming.push(active),
		});
		return {
			controls,
			pointerMoves,
			clicks,
			pans,
			panning,
			zooms,
			zooming,
			fireLongPress: () => longPress?.(),
		};
	}

	test('moves the pointer relatively with one finger without clicking', () => {
		const { controls, pointerMoves, clicks } = setup();
		controls.start([touch(1, 20, 30)]);
		controls.move([touch(1, 25, 35)]);
		controls.move([touch(1, 42, 55)]);
		controls.move([touch(1, 47, 61)]);
		controls.end([], [touch(1, 47, 61)]);

		expect(pointerMoves).toEqual([
			[22, 25],
			[5, 6],
		]);
		expect(clicks).toEqual([]);
	});

	test('clicks at the current pointer position without moving on tap or hold', () => {
		const tap = setup();
		tap.controls.start([touch(1, 20, 30)]);
		tap.controls.end([], [touch(1, 20, 30)]);
		expect(tap.pointerMoves).toEqual([]);
		expect(tap.clicks).toEqual([0]);

		const hold = setup();
		hold.controls.start([touch(1, 40, 50)]);
		hold.fireLongPress();
		expect(hold.clicks).toEqual([]);
		hold.controls.end([], [touch(1, 40, 50)]);
		expect(hold.pointerMoves).toEqual([]);
		expect(hold.clicks).toEqual([2]);
	});

	test('zooms vertically after holding without moving the pointer', () => {
		const { controls, fireLongPress, pointerMoves, clicks, zooms, zooming } =
			setup();
		controls.start([touch(1, 40, 50)]);
		fireLongPress();
		controls.move([touch(1, 40, 45)]);
		controls.move([touch(1, 40, 30)]);
		controls.move([touch(1, 40, 20)]);
		controls.end([], [touch(1, 40, 20)]);

		expect(zooms).toEqual([
			[20, 40, 50],
			[10, 40, 50],
		]);
		expect(zooming).toEqual([true, false]);
		expect(pointerMoves).toEqual([]);
		expect(clicks).toEqual([]);
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
		expect(pointerMoves).toEqual([[6, 8]]);
		expect(clicks).toEqual([]);
	});
});
