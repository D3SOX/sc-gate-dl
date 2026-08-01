import { describe, expect, test } from 'bun:test';
import { shouldAutoStartDeepLink } from '../webui/src/components/deepLink';
import { isBrowserMode } from './types';

describe('deep-link browser mode hydration', () => {
	test('waits until a stored Xvfb mode has been applied', () => {
		const queryUrl = 'https://soundcloud.com/artist/track';
		expect(shouldAutoStartDeepLink(false, false, queryUrl)).toBeFalse();

		const storedMode = 'xvfb';
		expect(isBrowserMode(storedMode)).toBeTrue();
		expect(shouldAutoStartDeepLink(true, false, queryUrl)).toBeTrue();
	});
});
