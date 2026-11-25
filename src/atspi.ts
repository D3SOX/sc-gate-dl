import { CString, dlopen, FFIType, type Pointer, read } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { exportToNativeEnv } from './x11Input';

/**
 * Reads what a running app shows through the Linux accessibility bus
 * (AT-SPI), the interface screen readers use. A page cannot tell it is being
 * read this way, unlike browser automation or developer tools.
 */

export interface AccessibleNode {
	role: string;
	name: string;
	/** Screen coordinates. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Index of the document (page or frame) the node belongs to. */
	doc: number;
}

type Atspi = ReturnType<typeof loadAtspi>;

function loadAtspi() {
	const { symbols } = dlopen('libatspi.so.0', {
		atspi_init: { args: [], returns: FFIType.i32 },
		atspi_get_desktop: { args: [FFIType.i32], returns: FFIType.ptr },
		atspi_accessible_get_child_count: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		atspi_accessible_get_child_at_index: {
			args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
			returns: FFIType.ptr,
		},
		atspi_accessible_get_role_name: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.ptr,
		},
		atspi_accessible_get_name: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.ptr,
		},
		atspi_accessible_get_process_id: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.u32,
		},
		atspi_accessible_clear_cache: {
			args: [FFIType.ptr],
			returns: FFIType.void,
		},
		atspi_accessible_get_component_iface: {
			args: [FFIType.ptr],
			returns: FFIType.ptr,
		},
		atspi_component_get_extents: {
			args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
			returns: FFIType.ptr,
		},
		g_free: { args: [FFIType.ptr], returns: FFIType.void },
		g_object_unref: { args: [FFIType.ptr], returns: FFIType.void },
	});
	exportToNativeEnv('DBUS_SESSION_BUS_ADDRESS');
	symbols.atspi_init();
	return symbols;
}

let atspi: Atspi | null | undefined;

function atspiLibrary(): Atspi | null {
	if (atspi === undefined) {
		try {
			atspi = process.platform === 'linux' ? loadAtspi() : null;
		} catch {
			atspi = null;
		}
	}
	return atspi;
}

export function atspiAvailable(): boolean {
	return atspiLibrary() !== null;
}

const ATSPI_COORD_TYPE_SCREEN = 0;
// Browser UI outside the pages that never matters here but can be large.
const SKIPPED_ROLES = new Set(['menu', 'menu bar', 'tool bar']);

// Bun types pointer results as `Pointer | bigint`; these are always pointers.
const asPointer = (value: unknown) => (value || null) as Pointer | null;

function takeString(lib: Atspi, result: unknown): string {
	const value = asPointer(result);
	if (!value) return '';
	const text = new CString(value).toString();
	lib.g_free(value);
	return text;
}

function extents(
	lib: Atspi,
	node: Pointer,
): Pick<AccessibleNode, 'x' | 'y' | 'width' | 'height'> | null {
	const component = lib.atspi_accessible_get_component_iface(node);
	if (!component) return null;
	const rect = lib.atspi_component_get_extents(
		component,
		ATSPI_COORD_TYPE_SCREEN,
		null,
	);
	lib.g_object_unref(component);
	if (!rect) return null;
	const box = {
		x: read.i32(rect, 0),
		y: read.i32(rect, 4),
		width: read.i32(rect, 8),
		height: read.i32(rect, 12),
	};
	lib.g_free(rect);
	return box;
}

/** `pid` and its descendants, so a launcher that forks still matches. */
function processTree(pid: number): Set<number> {
	const pids = new Set([pid]);
	const pending = [pid];
	while (pending.length > 0) {
		const next = pending.pop() as number;
		let children = '';
		try {
			children = readFileSync(`/proc/${next}/task/${next}/children`, 'utf8');
		} catch {
			continue;
		}
		for (const child of children.split(/\s+/).filter(Boolean).map(Number)) {
			if (!pids.has(child)) {
				pids.add(child);
				pending.push(child);
			}
		}
	}
	return pids;
}

/**
 * Every node of the app started as `pid`, with its role, name and position
 * on screen. Empty while the app has not shown up on the bus yet.
 */
export function accessibleNodes(pid: number): AccessibleNode[] {
	const lib = atspiLibrary();
	if (!lib) return [];
	const pids = processTree(pid);
	const nodes: AccessibleNode[] = [];
	let docs = 0;
	const walk = (node: Pointer, doc: number) => {
		const role = takeString(
			lib,
			lib.atspi_accessible_get_role_name(node, null),
		);
		if (doc === 0 && SKIPPED_ROLES.has(role)) return;
		const own = role === 'document web' ? ++docs : doc;
		const box = extents(lib, node);
		if (box) {
			nodes.push({
				role,
				name: takeString(lib, lib.atspi_accessible_get_name(node, null)),
				...box,
				doc: own,
			});
		}
		const count = lib.atspi_accessible_get_child_count(node, null);
		for (let i = 0; i < count; i++) {
			const child = asPointer(
				lib.atspi_accessible_get_child_at_index(node, i, null),
			);
			if (!child) continue;
			walk(child, own);
			lib.g_object_unref(child);
		}
	};

	const desktop = asPointer(lib.atspi_get_desktop(0));
	if (!desktop) return [];
	try {
		const apps = lib.atspi_accessible_get_child_count(desktop, null);
		for (let i = 0; i < apps; i++) {
			const app = asPointer(
				lib.atspi_accessible_get_child_at_index(desktop, i, null),
			);
			if (!app) continue;
			if (pids.has(lib.atspi_accessible_get_process_id(app, null))) {
				// Read the current page, not what an earlier walk cached.
				lib.atspi_accessible_clear_cache(app);
				walk(app, 0);
			}
			lib.g_object_unref(app);
		}
	} finally {
		lib.g_object_unref(desktop);
	}
	return nodes;
}
