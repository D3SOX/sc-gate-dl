/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { previewProcessedFilename } from '../../../src/utils';
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

describe('processed filename preview', () => {
	test('previews an m4a name for a probed lossless source, and keeps lossy names', () => {
		const base = {
			nameAsArtistTitle: false,
			outputFormat: 'm4a-aac' as const,
		};
		expect(
			previewProcessedFilename('song.wav', { ...base, sourceIsLossless: true }),
		).toBe('song.m4a');
		expect(
			previewProcessedFilename('song.mp3', {
				...base,
				sourceIsLossless: false,
			}),
		).toBe('song.mp3');
	});

	test('previews Artist - Title with an m4a extension for lossless m4a-aac output', () => {
		expect(
			previewProcessedFilename('song.wav', {
				nameAsArtistTitle: true,
				artist: 'Artist',
				title: 'Song',
				outputFormat: 'm4a-aac',
				sourceIsLossless: true,
			}),
		).toBe('Artist - Song.m4a');
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
