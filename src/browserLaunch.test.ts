import { describe, expect, test } from 'bun:test';
import {
	buildXvfbBrowserEnv,
	createXvfbManager,
	isXvfbSupported,
	readXvfbDisplay,
	type XvfbSession,
} from './browserLaunch';

const streamOf = (text: string) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});

const fakeSession = (display: string, kill: () => void): XvfbSession => ({
	display,
	users: 0,
	process: {
		stdout: streamOf(''),
		stderr: streamOf(''),
		exited: new Promise<number>(() => {}),
		kill,
	},
});

describe('readXvfbDisplay', () => {
	test('parses the display number written by -displayfd', async () => {
		expect(await readXvfbDisplay(streamOf('99\n'))).toBe(':99');
	});

	test('rejects invalid or empty output', async () => {
		await expect(readXvfbDisplay(streamOf('nope\n'))).rejects.toThrow(
			'invalid display number',
		);
		await expect(readXvfbDisplay(streamOf(''))).rejects.toThrow(
			'invalid display number',
		);
	});
});

describe('createXvfbManager', () => {
	test('kills the shared process only after the final release', async () => {
		let kills = 0;
		const acquire = createXvfbManager(async () =>
			fakeSession(':1', () => {
				kills += 1;
			}),
		);
		const first = await acquire();
		const second = await acquire();

		first.release();
		expect(kills).toBe(0);
		second.release();
		second.release();
		expect(kills).toBe(1);
	});

	test('retries when the active session is released during acquire', async () => {
		const kills = [0, 0];
		let starts = 0;
		const acquire = createXvfbManager(async () => {
			const index = starts++;
			return fakeSession(`:${index + 1}`, () => {
				kills[index] = (kills[index] ?? 0) + 1;
			});
		});
		const first = await acquire();
		const pendingSecond = acquire();
		first.release();

		const second = await pendingSecond;
		expect(second.display).toBe(':2');
		expect(kills).toEqual([1, 0]);
		second.release();
		expect(kills).toEqual([1, 1]);
	});
});

describe('buildXvfbBrowserEnv', () => {
	test('forces X11 and removes the inherited Wayland display', () => {
		expect(
			buildXvfbBrowserEnv(':99', {
				DISPLAY: ':0',
				WAYLAND_DISPLAY: 'wayland-0',
				XDG_SESSION_TYPE: 'wayland',
				PATH: '/usr/bin',
			}),
		).toEqual({
			DISPLAY: ':99',
			XDG_SESSION_TYPE: 'x11',
			OZONE_PLATFORM: 'x11',
			PATH: '/usr/bin',
		});
	});
});

describe('isXvfbSupported', () => {
	test('only enables Xvfb on Linux', () => {
		expect(isXvfbSupported('linux')).toBeTrue();
		expect(isXvfbSupported('darwin')).toBeFalse();
		expect(isXvfbSupported('win32')).toBeFalse();
	});
});
