import { describe, expect, test } from 'bun:test';
import { buildXvfbBrowserEnv } from './browserLaunch';

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
