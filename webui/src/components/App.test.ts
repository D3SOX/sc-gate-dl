/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
	cleanMetadataFields,
	cleanPromoTags,
	shouldActivateBrowserView,
	shouldAutoCloseBrowserView,
	stripDuplicateArtistFromTitle,
} from './App';

describe('cleanPromoTags', () => {
	test('removes a bracketed premiere prefix', () => {
		expect(cleanPromoTags('[PREMIERE] Artist - Track')).toBe('Artist - Track');
		expect(cleanPromoTags('[PREMIERE]: Artist - Track')).toBe('Artist - Track');
	});
});

describe('metadata cleanup', () => {
	test('removes duplicated artist lists written with different separators', () => {
		expect(
			stripDuplicateArtistFromTitle(
				'Nite Sky (edit) - OSKAMAXX & ADEMES',
				'OSKAMAXX, ADEMES',
			),
		).toBe('Nite Sky (edit)');
	});

	test('matches reordered, differently cased artist credits', () => {
		expect(
			stripDuplicateArtistFromTitle(
				'ademes + oskamaxx — Nite Sky',
				'OSKAMAXX, ADEMES',
			),
		).toBe('Nite Sky');
	});

	test('keeps non-duplicate title credits intact', () => {
		expect(
			cleanMetadataFields({
				title: 'Nite Sky - Guest Remix',
				artist: 'OSKAMAXX, ADEMES',
			}),
		).toMatchObject({
			title: 'Nite Sky - Guest Remix',
			artist: 'OSKAMAXX, ADEMES',
		});
	});
});

describe('remote browser lifecycle', () => {
	test('only activates after a visible headed browser reports ready', () => {
		expect(
			shouldActivateBrowserView(
				'headed',
				{ browserActive: true },
				'http://pi:6080/vnc.html',
			),
		).toBeTrue();
		expect(
			shouldActivateBrowserView(
				'headed',
				{ browserActive: false },
				'http://pi:6080/vnc.html',
			),
		).toBeFalse();
		expect(
			shouldActivateBrowserView(
				'xvfb',
				{ browserActive: true },
				'http://pi:6080/vnc.html',
			),
		).toBeFalse();
	});

	test('auto-closes once when the file download begins', () => {
		expect(shouldAutoCloseBrowserView('handling_gates', false)).toBeFalse();
		expect(shouldAutoCloseBrowserView('downloading', false)).toBeTrue();
		expect(shouldAutoCloseBrowserView('downloading', true)).toBeFalse();
	});
});
