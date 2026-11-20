import { expect, test } from 'bun:test';
import { nextDroploudSocialAction } from './droploudSocial';

test('opens a pending social link before its verify button is enabled', () => {
	expect(
		nextDroploudSocialAction([
			{ kind: 'open', label: 'Open Instagram, @r3ckles.wav', done: false },
			{ kind: 'verify', label: "I've done it", enabled: false },
		]),
	).toEqual({ type: 'open', index: 0 });
});

test('confirms once the verify button is enabled', () => {
	expect(
		nextDroploudSocialAction([
			{ kind: 'open', label: 'Open Instagram, @r3ckles.wav', done: true },
			{ kind: 'verify', label: "I've done it", enabled: true },
		]),
	).toEqual({ type: 'verify', index: 1 });
});

test('handles the verify step before the open step', () => {
	expect(
		nextDroploudSocialAction([
			{ kind: 'verify', label: "I've done it", enabled: true },
			{ kind: 'open', label: 'Open Spotify', done: false },
		]),
	).toEqual({ type: 'verify', index: 0 });
});

test('reports done when nothing is pending', () => {
	expect(nextDroploudSocialAction([])).toEqual({ type: 'done' });
	expect(
		nextDroploudSocialAction([
			{ kind: 'open', label: 'Open Spotify', done: true },
		]),
	).toEqual({ type: 'done' });
});
