import type { ReactNode, Ref } from 'react';
import './ConfirmDialog.css';

type ConfirmDialogProps = {
	ref: Ref<HTMLDialogElement>;
	title: string;
	children: ReactNode;
	confirmLabel: ReactNode;
	onConfirm: () => void;
};

/** A modal confirm prompt; open it with `ref.current.showModal()`. */
export function ConfirmDialog({
	ref,
	title,
	children,
	confirmLabel,
	onConfirm,
}: ConfirmDialogProps) {
	return (
		<dialog ref={ref} className="confirm-dialog" aria-label={title}>
			<form method="dialog">
				<h2 className="confirm-dialog-title">{title}</h2>
				<div className="confirm-dialog-body">{children}</div>
				<div className="confirm-dialog-actions">
					{/* First in the DOM, so showModal() focuses the safe choice. */}
					<button type="submit" className="btn-secondary">
						Cancel
					</button>
					<button type="submit" className="btn-primary" onClick={onConfirm}>
						{confirmLabel}
					</button>
				</div>
			</form>
		</dialog>
	);
}
