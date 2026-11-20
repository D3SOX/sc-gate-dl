export type DroploudSocialCard =
	| { kind: 'open'; label: string; done: boolean }
	| { kind: 'verify'; label: string; enabled: boolean };

export type DroploudSocialAction =
	| { type: 'open'; index: number }
	| { type: 'verify'; index: number }
	| { type: 'done' };

/** Pick the next social step from the current cards, independent of their order. */
export function nextDroploudSocialAction(
	cards: DroploudSocialCard[],
): DroploudSocialAction {
	const verifyIndex = cards.findIndex(
		(card) => card.kind === 'verify' && card.enabled,
	);
	if (verifyIndex >= 0) return { type: 'verify', index: verifyIndex };

	const openIndex = cards.findIndex(
		(card) => card.kind === 'open' && !card.done,
	);
	if (openIndex >= 0) return { type: 'open', index: openIndex };

	return { type: 'done' };
}
