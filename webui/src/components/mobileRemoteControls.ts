export type MobileTouch = {
	identifier: number;
	clientX: number;
	clientY: number;
};

type MobileRemoteControlOptions = {
	getZoom: () => number;
	moveTolerance: number;
	longPressMs: number;
	schedule: (callback: () => void, delay: number) => () => void;
	movePointer: (clientX: number, clientY: number) => void;
	click: (clientX: number, clientY: number, button: 0 | 2) => void;
	panBy: (deltaX: number, deltaY: number) => void;
	setPanning: (active: boolean) => void;
};

type TouchSession = {
	identifier: number;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	moved: boolean;
	longPressed: boolean;
	multiple: boolean;
	cancelHold: (() => void) | null;
};

const centerOfFirstTwoTouches = (touches: readonly MobileTouch[]) => {
	if (touches.length < 2) return null;
	return {
		x: (touches[0].clientX + touches[1].clientX) / 2,
		y: (touches[0].clientY + touches[1].clientY) / 2,
	};
};

export function createMobileRemoteControls({
	getZoom,
	moveTolerance,
	longPressMs,
	schedule,
	movePointer,
	click,
	panBy,
	setPanning,
}: MobileRemoteControlOptions) {
	let session: TouchSession | null = null;
	let panCenter: { x: number; y: number } | null = null;

	const cancelHold = () => {
		session?.cancelHold?.();
		if (session) session.cancelHold = null;
	};

	const finishPan = () => {
		panCenter = null;
		setPanning(false);
	};

	const startSingleTouch = (touch: MobileTouch, moved = false) => {
		session = {
			identifier: touch.identifier,
			startX: touch.clientX,
			startY: touch.clientY,
			lastX: touch.clientX,
			lastY: touch.clientY,
			moved,
			longPressed: false,
			multiple: false,
			cancelHold: null,
		};
		if (moved) return;
		session.cancelHold = schedule(() => {
			if (!session || session.moved || session.multiple) return;
			session.longPressed = true;
			click(session.lastX, session.lastY, 2);
		}, longPressMs);
	};

	return {
		start(touches: readonly MobileTouch[]) {
			if (touches.length >= 2) {
				if (session) session.multiple = true;
				cancelHold();
				panCenter = centerOfFirstTwoTouches(touches);
				setPanning(getZoom() > 1);
				return;
			}
			if (touches[0]) startSingleTouch(touches[0]);
		},

		move(touches: readonly MobileTouch[]) {
			if (touches.length >= 2) {
				if (session) session.multiple = true;
				cancelHold();
				const nextCenter = centerOfFirstTwoTouches(touches);
				if (getZoom() > 1 && panCenter && nextCenter) {
					panBy(nextCenter.x - panCenter.x, nextCenter.y - panCenter.y);
				}
				panCenter = nextCenter;
				return;
			}

			if (!session || session.multiple) return;
			const touch = touches.find(
				(candidate) => candidate.identifier === session?.identifier,
			);
			if (!touch) return;
			session.lastX = touch.clientX;
			session.lastY = touch.clientY;
			if (
				Math.hypot(
					touch.clientX - session.startX,
					touch.clientY - session.startY,
				) > moveTolerance
			) {
				session.moved = true;
				cancelHold();
			}
			if (session.moved) movePointer(touch.clientX, touch.clientY);
		},

		end(
			touches: readonly MobileTouch[],
			changedTouches: readonly MobileTouch[],
		) {
			if (touches.length > 0) {
				if (touches.length < 2) {
					finishPan();
					if (touches[0]) {
						startSingleTouch(touches[0], true);
					}
				}
				return;
			}

			cancelHold();
			finishPan();
			if (
				session &&
				!session.moved &&
				!session.longPressed &&
				!session.multiple
			) {
				const touch = changedTouches.find(
					(candidate) => candidate.identifier === session?.identifier,
				);
				click(
					touch?.clientX ?? session.lastX,
					touch?.clientY ?? session.lastY,
					0,
				);
			}
			session = null;
		},

		cancel() {
			cancelHold();
			finishPan();
			session = null;
		},
	};
}
