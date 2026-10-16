import './GateAttentionMessage.css';

type GateAttentionProps = {
	attention?: { id: string; message: string };
	onShowBrowser?: () => void;
};

export function GateAttentionMessage({
	attention,
	onShowBrowser,
}: GateAttentionProps) {
	if (!attention) return null;
	return (
		<div className="gate-attention-message" role="alert" aria-atomic="true">
			<strong>Gate needs your attention</strong>
			<span>{attention.message}</span>
			{onShowBrowser && (
				<button type="button" onClick={onShowBrowser}>
					Show browser
				</button>
			)}
		</div>
	);
}
