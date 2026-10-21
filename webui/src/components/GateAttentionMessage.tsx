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
			<strong>The gate needs your help</strong>
			<span>{attention.message}</span>
			{onShowBrowser && (
				<button type="button" onClick={onShowBrowser}>
					Open the browser
				</button>
			)}
		</div>
	);
}
