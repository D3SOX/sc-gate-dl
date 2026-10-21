import { type CSSProperties, useEffect, useRef } from 'react';
import './RecordSleeve.css';

/** 33⅓ rpm: one revolution every 1.8 seconds. */
const REVOLUTION_MS = 1800;
const GROOVE_RADII = Array.from({ length: 24 }, (_, index) => 45 + index * 2.2);
const TRACK_GAP_RADII = [55, 66, 77, 88];

type RecordSleeveProps = {
	/** How far the record has left the sleeve, from 0 (inside) to 1 (out). */
	out: number;
	spinning: boolean;
	artworkUrl: string | null;
	title: string;
	artist: string;
	catalogNumber: string | null;
};

export function RecordSleeve({
	out,
	spinning,
	artworkUrl,
	title,
	artist,
	catalogNumber,
}: RecordSleeveProps) {
	const discRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const disc = discRef.current;
		if (!disc || !spinning || typeof disc.animate !== 'function') return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		const spin = disc.animate(
			[{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }],
			{ duration: REVOLUTION_MS, iterations: Number.POSITIVE_INFINITY },
		);
		return () => {
			// Spin down to the next upright position so the label stays readable.
			const elapsed =
				typeof spin.currentTime === 'number' ? spin.currentTime : 0;
			const turn = (elapsed % REVOLUTION_MS) / REVOLUTION_MS;
			spin.cancel();
			disc.animate(
				[{ transform: `rotate(${turn}turn)` }, { transform: 'rotate(1turn)' }],
				{
					duration: Math.min(2400, Math.max(700, (1 - turn) * 3600)),
					easing: 'cubic-bezier(0.25, 0.6, 0.3, 1)',
				},
			);
		};
	}, [spinning]);

	return (
		<figure
			className="sleeve-object"
			aria-hidden="true"
			style={{ '--out': Math.min(1, Math.max(0, out)) } as CSSProperties}
		>
			<div className="record">
				<div className="record-disc" ref={discRef}>
					<svg
						className="record-grooves"
						viewBox="0 0 200 200"
						aria-hidden="true"
					>
						<circle className="record-vinyl" cx="100" cy="100" r="100" />
						{GROOVE_RADII.map((radius) => (
							<circle
								key={radius}
								className="record-groove"
								cx="100"
								cy="100"
								r={radius}
							/>
						))}
						{TRACK_GAP_RADII.map((radius) => (
							<circle
								key={radius}
								className="record-track-gap"
								cx="100"
								cy="100"
								r={radius}
							/>
						))}
						<circle className="record-rim" cx="100" cy="100" r="98.6" />
					</svg>
					<div className="record-label">
						<span className="record-label-imprint">sc-gate-dl</span>
						{catalogNumber ? (
							<span className="record-label-catalog">{catalogNumber}</span>
						) : null}
						<span className="record-label-side">Side A</span>
						<span className="record-label-speed">
							33<span className="record-label-fraction">1⁄3</span>
						</span>
						<span className="record-label-hole" />
						<span className="record-label-credits">
							<span className="record-label-title">{title}</span>
							<span className="record-label-artist">{artist}</span>
						</span>
					</div>
				</div>
				<div className="record-sheen" />
			</div>
			<div className="sleeve">
				<div className={`sleeve-face${artworkUrl ? ' has-artwork' : ''}`}>
					{artworkUrl ? (
						<img src={artworkUrl} alt="" />
					) : (
						<span className="sleeve-wordmark">sc-gate-dl</span>
					)}
				</div>
			</div>
		</figure>
	);
}
