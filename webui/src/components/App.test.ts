/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { cleanPromoTags } from './App';

describe('cleanPromoTags', () => {
	test('removes a bracketed premiere prefix', () => {
		expect(cleanPromoTags('[PREMIERE] Artist - Track')).toBe(
			'Artist - Track',
		);
		expect(cleanPromoTags('[PREMIERE]: Artist - Track')).toBe(
			'Artist - Track',
		);
	});
});
