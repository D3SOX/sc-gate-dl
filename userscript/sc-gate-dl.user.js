// ==UserScript==
// @name         sc-gate-dl
// @namespace    https://github.com/D3SOX/sc-gate-dl
// @version      1.7.0
// @description  Open the sc-gate-dl Web UI in a floating panel next to SoundCloud store/buy links
// @author       D3SOX
// @match        https://soundcloud.com/*
// @match        https://www.soundcloud.com/*
// @icon         https://soundcloud.com/favicon.ico
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// @homepageURL  https://github.com/D3SOX/sc-gate-dl
// @supportURL   https://github.com/D3SOX/sc-gate-dl/issues
// @downloadURL  https://raw.githubusercontent.com/D3SOX/sc-gate-dl/main/userscript/sc-gate-dl.user.js
// @updateURL    https://raw.githubusercontent.com/D3SOX/sc-gate-dl/main/userscript/sc-gate-dl.user.js
// ==/UserScript==

(() => {
	'use strict';

	const WEBUI_BASE_KEY = 'sc-gate-dl-webui-base';
	const API_BASE_KEY = 'sc-gate-dl-api-base';
	const PANEL_GEOM_KEY = 'sc-gate-dl-panel-geom';
	const QUEUE_GEOM_KEY = 'sc-gate-dl-queue-geom';
	const OUTPUT_FORMAT_KEY = 'sc-gate-dl-output-format';
	const AUTO_CLOSE_KEY = 'sc-gate-dl-auto-close';
	const DEFAULT_WEBUI_BASE = 'http://localhost:4321';
	const BUTTON_ATTR = 'data-sc-gate-dl-btn';
	const WRAP_ATTR = 'data-sc-gate-dl-wrap';
	const PANEL_ID = 'sc-gate-dl-panel';
	const QUEUE_ID = 'sc-gate-dl-queue';
	const STYLE_ID = 'sc-gate-dl-styles';
	const TOOLTIP_ID = 'sc-gate-dl-tooltip';
	const TOOLTIP_LABEL = 'Download with sc-gate-dl';
	const MIN_PANEL_W = 280;
	const MIN_PANEL_H = 240;

	const DEFAULT_GEOM = {
		width: 400,
		height: 0, // filled from viewport
		right: 12,
		top: 72,
	};

	const DEFAULT_QUEUE_GEOM = {
		width: 280,
		left: 12,
		top: 12,
	};

	/** @type {{ url: string, label: string }[]} */
	const downloadQueue = [];

	const RESERVED_FIRST = new Set([
		'you',
		'discover',
		'stream',
		'library',
		'messages',
		'notifications',
		'settings',
		'pages',
		'charts',
		'jobs',
		'pro',
		'upload',
		'search',
		'login',
		'signup',
		'about',
		'stations',
		'feed',
	]);

	const TRAILING_SEGMENTS = new Set([
		'likes',
		'reposts',
		'comments',
		'recommended',
		'sets',
		'popular-tracks',
		'albums',
		'tracks',
		'followers',
		'following',
	]);

	const DOWNLOAD_ICON_16 = `
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="16" height="16">
  <path fill="currentColor" d="M8 1.25a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V2A.75.75 0 0 1 8 1.25Z"/>
  <path fill="currentColor" d="M2.5 11.25a.75.75 0 0 1 .75.75v1.25h9.5V12a.75.75 0 0 1 1.5 0v1.5A1.25 1.25 0 0 1 13 14.75H3A1.25 1.25 0 0 1 1.75 13.5V12a.75.75 0 0 1 .75-.75Z"/>
</svg>`;

	const DOWNLOAD_ICON_24 = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="24" height="24">
  <path fill="currentColor" d="M12 3.25a.75.75 0 0 1 .75.75v9.19l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.22 3.22V4A.75.75 0 0 1 12 3.25Z"/>
  <path fill="currentColor" d="M4.5 15.25a.75.75 0 0 1 .75.75v2.25h13.5V16a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 18.5 20.25h-13A1.75 1.75 0 0 1 3.75 18.5V16a.75.75 0 0 1 .75-.75Z"/>
</svg>`;

	function getAutoClose() {
		try {
			if (typeof GM_getValue === 'function') {
				const gm = GM_getValue(AUTO_CLOSE_KEY, null);
				if (typeof gm === 'boolean') return gm;
			}
		} catch {
			// ignore
		}
		try {
			const v = localStorage.getItem(AUTO_CLOSE_KEY);
			if (v === '0' || v === 'false') return false;
			if (v === '1' || v === 'true') return true;
		} catch {
			// ignore
		}
		return true; // default on
	}

	function setAutoClose(value) {
		const on = Boolean(value);
		try {
			if (typeof GM_setValue === 'function') GM_setValue(AUTO_CLOSE_KEY, on);
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(AUTO_CLOSE_KEY, on ? '1' : '0');
		} catch {
			// ignore
		}
	}

	function getOutputFormat() {
		try {
			if (typeof GM_getValue === 'function') {
				const gm = GM_getValue(OUTPUT_FORMAT_KEY, null);
				if (gm === 'original' || gm === 'mp3-320') return gm;
			}
		} catch {
			// ignore
		}
		try {
			const v = localStorage.getItem(OUTPUT_FORMAT_KEY);
			if (v === 'original' || v === 'mp3-320') return v;
		} catch {
			// ignore
		}
		return 'mp3-320';
	}

	function syncFormatSelect(value) {
		const select = document.querySelector(`#${PANEL_ID} .sc-gate-dl-format`);
		if (select instanceof HTMLSelectElement) select.value = value;
	}

	function setOutputFormat(value) {
		if (value !== 'original' && value !== 'mp3-320') return;
		try {
			if (typeof GM_setValue === 'function') GM_setValue(OUTPUT_FORMAT_KEY, value);
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(OUTPUT_FORMAT_KEY, value);
		} catch {
			// ignore
		}
		syncFormatSelect(value);
		const panel = document.getElementById(PANEL_ID);
		if (panel && !panel.hidden && panel.dataset.trackUrl) {
			loadTrackIntoPanel(panel, panel.dataset.trackUrl);
		}
	}

	let autoCloseMenuId;

	function refreshAutoCloseMenu() {
		if (typeof GM_registerMenuCommand !== 'function') return;
		if (
			typeof GM_unregisterMenuCommand === 'function' &&
			autoCloseMenuId != null
		) {
			try {
				GM_unregisterMenuCommand(autoCloseMenuId);
			} catch {
				// ignore
			}
		}
		const on = getAutoClose();
		autoCloseMenuId = GM_registerMenuCommand(
			`Auto-close after browser download: ${on ? 'ON' : 'OFF'}`,
			() => {
				setAutoClose(!getAutoClose());
				refreshAutoCloseMenu();
			},
		);
	}

	function registerMenuCommands() {
		if (typeof GM_registerMenuCommand !== 'function') return;
		GM_registerMenuCommand('Choose output format…', () => {
			openFormatDialog();
		});
		refreshAutoCloseMenu();
	}

	function currentHref() {
		try {
			// document.location is the browsing document (reliable with GM sandbox)
			return document.location.href;
		} catch {
			try {
				return window.location.href;
			} catch {
				return document.URL || '';
			}
		}
	}

	function normalizeTrackUrl(href) {
		try {
			const url = new URL(href, currentHref() || 'https://soundcloud.com/');
			const host = url.hostname.replace(/^www\./i, '').toLowerCase();
			if (
				host !== 'soundcloud.com' &&
				host !== 'm.soundcloud.com' &&
				host !== 'on.soundcloud.com'
			) {
				return null;
			}
			let parts = url.pathname.split('/').filter(Boolean);
			// New logged-in listen layout uses /n/artist/track
			if (parts[0]?.toLowerCase() === 'n' && parts.length >= 3) {
				parts = parts.slice(1);
			}
			while (
				parts.length > 2 &&
				TRAILING_SEGMENTS.has(parts[parts.length - 1].toLowerCase())
			) {
				parts = parts.slice(0, -1);
			}
			if (parts.length === 3 && parts[2].toLowerCase().startsWith('s-')) {
				parts = parts.slice(0, 2);
			}
			if (parts.length < 2) return null;
			if (RESERVED_FIRST.has(parts[0].toLowerCase())) return null;
			// Playlists / albums: /artist/sets/slug — not a single track
			if (parts[1].toLowerCase() === 'sets') return null;
			if (TRAILING_SEGMENTS.has(parts[1].toLowerCase())) return null;
			return `https://soundcloud.com/${parts[0]}/${parts[1]}`;
		} catch {
			return null;
		}
	}

	function pageTrackUrl() {
		// Only the real page location — meta tags / embeds can be /n/... or wrong
		const href = currentHref();
		if (href) {
			const normalized = normalizeTrackUrl(href);
			if (normalized) return normalized;
		}
		try {
			const pathUrl = `https://soundcloud.com${document.location.pathname}`;
			return normalizeTrackUrl(pathUrl);
		} catch {
			return null;
		}
	}

	/** Feed/search cards only — track pages use the current URL. */
	function trackUrlFromCard(el) {
		const sound = el?.closest?.(
			'.sound, .soundList__item, .searchItem__trackItem, .listenContext',
		);
		if (!sound) return null;
		const titleLink = sound.querySelector(
			'a.soundTitle__title, a[href][class*="soundTitle"]',
		);
		if (titleLink?.href) {
			const fromTitle = normalizeTrackUrl(titleLink.href);
			if (fromTitle) return fromTitle;
		}
		for (const a of sound.querySelectorAll('a[href]')) {
			const fromA = normalizeTrackUrl(a.href);
			if (fromA) return fromA;
		}
		return null;
	}

	function resolveTrackUrl(el) {
		// Listen page (classic or MUI): always prefer the address bar URL
		const fromPage = pageTrackUrl();
		if (fromPage) return fromPage;
		return trackUrlFromCard(el);
	}

	/** Playlists/albums aren't single-track downloads — skip injection there. */
	function isPlaylistOrAlbumContext(el) {
		if (!(el instanceof Element)) return false;
		if (el.closest('.sound.playlist')) return true;
		if (
			el.closest(
				'.l-listen-hero.playlist, .fullHero.playlist, .listenContext.playlist',
			)
		) {
			return true;
		}
		const sound = el.closest(
			'.sound, .soundList__item, .activity, [role="group"]',
		);
		if (sound?.classList?.contains('playlist')) return true;
		if (
			sound?.querySelector(
				'a.soundTitle__title[href*="/sets/"], a.sound__coverArt[href*="/sets/"]',
			)
		) {
			return true;
		}
		const buy =
			(el.closest('.purchaseLink__container') || el).querySelector?.(
				'a[aria-label], a[title]',
			) || el;
		const label = (
			buy.getAttribute?.('aria-label') ||
			buy.getAttribute?.('title') ||
			''
		).toLowerCase();
		if (/\bbuy all\b/.test(label)) return true;
		return false;
	}

	function getWebuiBase() {
		try {
			return (
				localStorage.getItem(WEBUI_BASE_KEY)?.replace(/\/$/, '') ||
				DEFAULT_WEBUI_BASE
			);
		} catch {
			return DEFAULT_WEBUI_BASE;
		}
	}

	function loadGeom() {
		try {
			const raw = localStorage.getItem(PANEL_GEOM_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (
				typeof parsed?.width === 'number' &&
				typeof parsed?.height === 'number' &&
				typeof parsed?.left === 'number' &&
				typeof parsed?.top === 'number'
			) {
				return parsed;
			}
		} catch {
			// ignore
		}
		return null;
	}

	function saveGeom(panel) {
		try {
			const rect = panel.getBoundingClientRect();
			localStorage.setItem(
				PANEL_GEOM_KEY,
				JSON.stringify({
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					left: Math.round(rect.left),
					top: Math.round(rect.top),
				}),
			);
		} catch {
			// ignore
		}
	}

	function loadQueueGeom() {
		try {
			const raw = localStorage.getItem(QUEUE_GEOM_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (
				typeof parsed?.left === 'number' &&
				typeof parsed?.top === 'number' &&
				typeof parsed?.width === 'number'
			) {
				return parsed;
			}
		} catch {
			// ignore
		}
		return null;
	}

	function saveQueueGeom(el) {
		try {
			const rect = el.getBoundingClientRect();
			localStorage.setItem(
				QUEUE_GEOM_KEY,
				JSON.stringify({
					width: Math.round(rect.width),
					left: Math.round(rect.left),
					top: Math.round(rect.top),
				}),
			);
		} catch {
			// ignore
		}
	}

	function trackLabelFromUrl(url) {
		try {
			const parts = new URL(url).pathname.split('/').filter(Boolean);
			if (parts.length >= 2) {
				const artist = decodeURIComponent(parts[0]).replace(/-/g, ' ');
				const track = decodeURIComponent(parts[1]).replace(/-/g, ' ');
				return `${artist} — ${track}`;
			}
		} catch {
			// ignore
		}
		return url;
	}

	function isPanelBusy() {
		const panel = document.getElementById(PANEL_ID);
		return Boolean(panel && !panel.hidden);
	}

	function hideTooltip() {
		document.getElementById(TOOLTIP_ID)?.remove();
	}

	function showTooltip(anchor) {
		hideTooltip();
		const tip = document.createElement('div');
		tip.id = TOOLTIP_ID;
		tip.setAttribute('role', 'tooltip');
		tip.innerHTML = `<div class="sc-gate-dl-tip-arrow"></div><div class="sc-gate-dl-tip-content"></div>`;
		const content = tip.querySelector('.sc-gate-dl-tip-content');
		if (content) content.textContent = TOOLTIP_LABEL;
		document.documentElement.appendChild(tip);

		// Anchor to the visible icon button, not a wide wrapper
		const icon =
			anchor.querySelector?.(`[${BUTTON_ATTR}]`) ||
			(anchor.hasAttribute?.(BUTTON_ATTR) ? anchor : null) ||
			anchor;
		const ar = icon.getBoundingClientRect();
		const tr = tip.getBoundingClientRect();
		let top = ar.top - tr.height - 8;
		let left = ar.left + ar.width / 2 - tr.width / 2;
		if (top < 4) top = ar.bottom + 8;
		left = Math.min(Math.max(8, left), window.innerWidth - tr.width - 8);
		tip.style.top = `${Math.round(top)}px`;
		tip.style.left = `${Math.round(left)}px`;
		const arrow = tip.querySelector('.sc-gate-dl-tip-arrow');
		if (arrow instanceof HTMLElement) {
			const tipRect = tip.getBoundingClientRect();
			const arrowLeft = ar.left + ar.width / 2 - tipRect.left - 5;
			arrow.style.left = `${Math.round(Math.min(Math.max(6, arrowLeft), tipRect.width - 14))}px`;
			if (top > ar.top) tip.classList.add('sc-gate-dl-tip-below');
		}
	}

	function openFormatDialog() {
		ensureStyles();
		document.getElementById('sc-gate-dl-format-dialog')?.remove();
		const current = getOutputFormat();
		const dialog = document.createElement('div');
		dialog.id = 'sc-gate-dl-format-dialog';
		dialog.innerHTML = `
			<div class="sc-gate-dl-format-card" role="dialog" aria-label="Output format">
				<div class="sc-gate-dl-format-title">Output format</div>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-fmt" value="mp3-320"${current === 'mp3-320' ? ' checked' : ''}/>
					<span>MP3 320kbps</span>
				</label>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-fmt" value="original"${current === 'original' ? ' checked' : ''}/>
					<span>Original file</span>
				</label>
				<div class="sc-gate-dl-format-actions">
					<button type="button" class="sc-gate-dl-format-cancel">Cancel</button>
					<button type="button" class="sc-gate-dl-format-save">Save</button>
				</div>
			</div>
		`;
		const close = () => dialog.remove();
		dialog.addEventListener('click', (e) => {
			if (e.target === dialog) close();
		});
		dialog.querySelector('.sc-gate-dl-format-cancel')?.addEventListener('click', close);
		dialog.querySelector('.sc-gate-dl-format-save')?.addEventListener('click', () => {
			const selected = dialog.querySelector(
				'input[name="sc-gate-dl-fmt"]:checked',
			);
			if (selected instanceof HTMLInputElement) setOutputFormat(selected.value);
			close();
		});
		document.documentElement.appendChild(dialog);
	}

	function bindTooltip(anchor) {
		let showTimer = 0;
		const onEnter = () => {
			window.clearTimeout(showTimer);
			showTimer = window.setTimeout(() => showTooltip(anchor), 60);
		};
		const onLeave = () => {
			window.clearTimeout(showTimer);
			hideTooltip();
		};
		anchor.addEventListener('mouseenter', onEnter);
		anchor.addEventListener('mouseleave', onLeave);
		anchor.addEventListener('focus', onEnter);
		anchor.addEventListener('blur', onLeave);
	}

	function isOurNode(el) {
		return (
			el instanceof Element &&
			(el.hasAttribute(BUTTON_ATTR) ||
				el.hasAttribute(WRAP_ATTR) ||
				!!el.closest(`[${BUTTON_ATTR}], [${WRAP_ATTR}], #${PANEL_ID}`) )
		);
	}

	function alreadyInjectedNear(anchorPoint) {
		if (!anchorPoint) return true;
		const scope =
			anchorPoint.closest('.soundActions, .sound__soundActions') ||
			anchorPoint.parentElement;
		if (scope?.querySelector(`[${WRAP_ATTR}]`)) return true;
		const next = anchorPoint.nextElementSibling;
		return !!(
			next?.hasAttribute?.(WRAP_ATTR) || next?.hasAttribute?.(BUTTON_ATTR)
		);
	}

	function ensureStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
#${PANEL_ID} {
	position: fixed;
	z-index: 2147483646;
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	min-width: ${MIN_PANEL_W}px;
	min-height: ${MIN_PANEL_H}px;
	max-width: calc(100vw - 8px);
	max-height: calc(100vh - 8px);
	background: #0f0f12;
	border-radius: 10px;
	overflow: hidden;
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
	border: 1px solid rgba(255, 255, 255, 0.12);
}
#${PANEL_ID}[hidden] { display: none !important; }
#${PANEL_ID} .sc-gate-dl-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 6px 8px 6px 10px;
	background: #16161c;
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	color: #eee;
	font: 600 12px/1.2 Interstate, "Lucida Grande", Arial, sans-serif;
	cursor: move;
	user-select: none;
	flex-shrink: 0;
	touch-action: none;
}
#${PANEL_ID} .sc-gate-dl-toolbar a {
	color: #f50;
	text-decoration: none;
	cursor: pointer;
}
#${PANEL_ID} .sc-gate-dl-toolbar .sc-gate-dl-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}
#${PANEL_ID} .sc-gate-dl-format {
	appearance: none;
	background: #0f0f12;
	color: #ddd;
	border: 1px solid rgba(255,255,255,0.14);
	border-radius: 6px;
	font: 500 11px/1.2 Interstate, "Lucida Grande", Arial, sans-serif;
	padding: 4px 6px;
	cursor: pointer;
	max-width: 118px;
}
#${PANEL_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close {
	appearance: none;
	border: 0;
	background: transparent;
	color: #ccc;
	font-size: 18px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 6px;
}
#${PANEL_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close:hover { color: #fff; }
#${PANEL_ID} iframe {
	flex: 1;
	width: 100%;
	border: 0;
	background: #0f0f12;
	min-height: 0;
}

/* Download queue — smaller floating window (default top-left) */
#${QUEUE_ID} {
	position: fixed;
	z-index: 2147483645;
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	width: ${DEFAULT_QUEUE_GEOM.width}px;
	max-width: calc(100vw - 16px);
	max-height: min(360px, calc(100vh - 24px));
	background: #0f0f12;
	border-radius: 8px;
	overflow: hidden;
	box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
	border: 1px solid rgba(255, 255, 255, 0.12);
}
#${QUEUE_ID}[hidden] { display: none !important; }
#${QUEUE_ID} .sc-gate-dl-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 5px 6px 5px 10px;
	background: #16161c;
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	color: #eee;
	font: 600 11px/1.2 Interstate, "Lucida Grande", Arial, sans-serif;
	cursor: move;
	user-select: none;
	flex-shrink: 0;
	touch-action: none;
}
#${QUEUE_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close {
	appearance: none;
	border: 0;
	background: transparent;
	color: #ccc;
	font-size: 16px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 6px;
}
#${QUEUE_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close:hover { color: #fff; }
#${QUEUE_ID} .sc-gate-dl-queue-list {
	list-style: none;
	margin: 0;
	padding: 4px 0;
	overflow-y: auto;
	flex: 1;
	min-height: 0;
}
#${QUEUE_ID} .sc-gate-dl-queue-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 8px 6px 10px;
	color: #ddd;
	font: 500 11px/1.3 Interstate, "Lucida Grande", Arial, sans-serif;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
#${QUEUE_ID} .sc-gate-dl-queue-item:last-child { border-bottom: 0; }
#${QUEUE_ID} .sc-gate-dl-queue-label {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	appearance: none;
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
	padding: 0;
}
#${QUEUE_ID} .sc-gate-dl-queue-label:hover { color: #f50; }
#${QUEUE_ID} .sc-gate-dl-queue-remove {
	appearance: none;
	border: 0;
	background: transparent;
	color: #888;
	font-size: 14px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 4px;
	flex-shrink: 0;
}
#${QUEUE_ID} .sc-gate-dl-queue-remove:hover { color: #fff; }

/* Resize handles — all edges + corners */
#${PANEL_ID} .sc-gate-dl-rh {
	position: absolute;
	z-index: 3;
	background: transparent;
}
#${PANEL_ID} .sc-gate-dl-rh[data-dir="n"] { top: 0; left: 8px; right: 8px; height: 6px; cursor: n-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="s"] { bottom: 0; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="e"] { top: 8px; right: 0; bottom: 8px; width: 6px; cursor: e-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="w"] { top: 8px; left: 0; bottom: 8px; width: 6px; cursor: w-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="ne"] { top: 0; right: 0; width: 10px; height: 10px; cursor: ne-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="nw"] { top: 0; left: 0; width: 10px; height: 10px; cursor: nw-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="se"] { bottom: 0; right: 0; width: 10px; height: 10px; cursor: se-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="sw"] { bottom: 0; left: 0; width: 10px; height: 10px; cursor: sw-resize; }

/* Match SoundCloud .tooltip (rgb(48,48,48) / #303030) */
#${TOOLTIP_ID} {
	position: fixed !important;
	z-index: 2147483647 !important;
	pointer-events: none;
	background: #303030;
	color: #fff;
	border-radius: 4px;
	padding: 4px 8px;
	font: 500 12px/1.3 Söhne, Interstate, "Lucida Grande", Arial, sans-serif;
	box-shadow: none;
	border: 0;
	white-space: nowrap;
	max-width: min(280px, calc(100vw - 16px));
}
#${TOOLTIP_ID} .sc-gate-dl-tip-content { position: relative; z-index: 1; }
#${TOOLTIP_ID} .sc-gate-dl-tip-arrow {
	position: absolute;
	bottom: -5px;
	width: 10px;
	height: 10px;
	background: #303030;
	border: 0;
	transform: rotate(45deg);
}
#${TOOLTIP_ID}.sc-gate-dl-tip-below .sc-gate-dl-tip-arrow {
	bottom: auto;
	top: -5px;
}

/* Format chooser (Violentmonkey menu) */
#sc-gate-dl-format-dialog {
	position: fixed;
	inset: 0;
	z-index: 2147483647;
	display: flex;
	align-items: flex-start;
	justify-content: flex-end;
	padding: 72px 16px 16px;
	pointer-events: none;
}
#sc-gate-dl-format-dialog .sc-gate-dl-format-card {
	pointer-events: auto;
	width: min(280px, calc(100vw - 32px));
	background: #16161c;
	color: #eee;
	border: 1px solid rgba(255,255,255,0.12);
	border-radius: 10px;
	box-shadow: 0 12px 40px rgba(0,0,0,0.45);
	padding: 14px;
	font: 500 13px/1.35 Interstate, "Lucida Grande", Arial, sans-serif;
}
#sc-gate-dl-format-dialog .sc-gate-dl-format-title {
	font-weight: 700;
	margin-bottom: 10px;
}
#sc-gate-dl-format-dialog .sc-gate-dl-format-option {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 4px;
	cursor: pointer;
}
#sc-gate-dl-format-dialog .sc-gate-dl-format-actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 12px;
}
#sc-gate-dl-format-dialog button {
	appearance: none;
	border: 1px solid rgba(255,255,255,0.14);
	background: #0f0f12;
	color: #ddd;
	border-radius: 6px;
	padding: 6px 10px;
	cursor: pointer;
	font: inherit;
}
#sc-gate-dl-format-dialog .sc-gate-dl-format-save {
	background: #f50;
	border-color: #f50;
	color: #fff;
}

/* Classic SC — sibling of cart in .soundActions (cart wrapper is ~16px and clips) */
div[${WRAP_ATTR}="classic"] {
	display: inline-flex !important;
	align-items: center;
	justify-content: center;
	vertical-align: middle;
	margin-left: 2px !important;
	width: 32px;
	height: 32px;
	overflow: visible !important;
	line-height: 0;
	flex-shrink: 0;
}
a[${BUTTON_ATTR}="classic"] {
	display: inline-flex !important;
	align-items: center;
	justify-content: center;
	width: 32px !important;
	height: 32px !important;
	min-width: 32px !important;
	min-height: 32px !important;
	padding: 0 !important;
	box-sizing: border-box;
	vertical-align: middle;
	overflow: visible !important;
}
a[${BUTTON_ATTR}="classic"] .sc-button-label {
	display: flex !important;
	align-items: center;
	justify-content: center;
	padding: 0 !important;
	width: 100%;
}
a[${BUTTON_ATTR}="classic"] svg {
	display: block;
	width: 16px;
	height: 16px;
}

/* MUI listen page */
div[${WRAP_ATTR}="mui"] {
	display: inline-flex;
	vertical-align: middle;
}
button[${BUTTON_ATTR}="mui"] svg {
	display: block;
	width: 24px;
	height: 24px;
}
`;
		document.documentElement.appendChild(style);
	}

	function applyDefaultGeom(panel) {
		const saved = loadGeom();
		if (saved) {
			panel.style.width = `${saved.width}px`;
			panel.style.height = `${saved.height}px`;
			panel.style.left = `${saved.left}px`;
			panel.style.top = `${saved.top}px`;
			panel.style.right = 'auto';
			return;
		}
		const height = Math.min(
			Math.max(window.innerHeight - DEFAULT_GEOM.top - 12, 360),
			window.innerHeight - 24,
		);
		panel.style.width = `${DEFAULT_GEOM.width}px`;
		panel.style.height = `${height}px`;
		panel.style.top = `${DEFAULT_GEOM.top}px`;
		panel.style.right = `${DEFAULT_GEOM.right}px`;
		panel.style.left = 'auto';
	}

	function clampPanel(panel) {
		const rect = panel.getBoundingClientRect();
		const maxLeft = window.innerWidth - Math.min(rect.width, window.innerWidth);
		const maxTop = window.innerHeight - Math.min(rect.height, window.innerHeight);
		const left = Math.min(Math.max(0, rect.left), Math.max(0, maxLeft));
		const top = Math.min(Math.max(0, rect.top), Math.max(0, maxTop));
		panel.style.left = `${left}px`;
		panel.style.top = `${top}px`;
		panel.style.right = 'auto';
	}

	function enableDrag(panel) {
		const toolbar = panel.querySelector('.sc-gate-dl-toolbar');
		if (!toolbar || toolbar.dataset.dragBound) return;
		toolbar.dataset.dragBound = '1';

		let dragging = false;
		let startX = 0;
		let startY = 0;
		let origLeft = 0;
		let origTop = 0;

		toolbar.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			if (e.target.closest('a, button, select, label')) return;
			dragging = true;
			const rect = panel.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			origLeft = rect.left;
			origTop = rect.top;
			panel.style.left = `${origLeft}px`;
			panel.style.top = `${origTop}px`;
			panel.style.right = 'auto';
			toolbar.setPointerCapture(e.pointerId);
			e.preventDefault();
		});

		toolbar.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			panel.style.left = `${origLeft + (e.clientX - startX)}px`;
			panel.style.top = `${origTop + (e.clientY - startY)}px`;
		});

		const endDrag = (e) => {
			if (!dragging) return;
			dragging = false;
			try {
				toolbar.releasePointerCapture(e.pointerId);
			} catch {
				// ignore
			}
			clampPanel(panel);
			saveGeom(panel);
		};

		toolbar.addEventListener('pointerup', endDrag);
		toolbar.addEventListener('pointercancel', endDrag);
	}

	function enableEdgeResize(panel) {
		if (panel.dataset.resizeBound) return;
		panel.dataset.resizeBound = '1';

		for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
			const handle = document.createElement('div');
			handle.className = 'sc-gate-dl-rh';
			handle.dataset.dir = dir;
			panel.appendChild(handle);
		}

		let resizing = false;
		let dir = '';
		let startX = 0;
		let startY = 0;
		let startLeft = 0;
		let startTop = 0;
		let startW = 0;
		let startH = 0;

		panel.addEventListener('pointerdown', (e) => {
			const handle = e.target.closest?.('.sc-gate-dl-rh');
			if (!(handle instanceof HTMLElement) || e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			resizing = true;
			dir = handle.dataset.dir || '';
			const rect = panel.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			startLeft = rect.left;
			startTop = rect.top;
			startW = rect.width;
			startH = rect.height;
			panel.style.left = `${startLeft}px`;
			panel.style.top = `${startTop}px`;
			panel.style.right = 'auto';
			handle.setPointerCapture(e.pointerId);
		});

		panel.addEventListener('pointermove', (e) => {
			if (!resizing) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			let left = startLeft;
			let top = startTop;
			let width = startW;
			let height = startH;

			if (dir.includes('e')) width = startW + dx;
			if (dir.includes('s')) height = startH + dy;
			if (dir.includes('w')) {
				width = startW - dx;
				left = startLeft + dx;
			}
			if (dir.includes('n')) {
				height = startH - dy;
				top = startTop + dy;
			}

			if (width < MIN_PANEL_W) {
				if (dir.includes('w')) left = startLeft + startW - MIN_PANEL_W;
				width = MIN_PANEL_W;
			}
			if (height < MIN_PANEL_H) {
				if (dir.includes('n')) top = startTop + startH - MIN_PANEL_H;
				height = MIN_PANEL_H;
			}

			width = Math.min(width, window.innerWidth - 8);
			height = Math.min(height, window.innerHeight - 8);
			left = Math.min(Math.max(0, left), window.innerWidth - width);
			top = Math.min(Math.max(0, top), window.innerHeight - height);

			panel.style.left = `${left}px`;
			panel.style.top = `${top}px`;
			panel.style.width = `${width}px`;
			panel.style.height = `${height}px`;
		});

		const endResize = (e) => {
			if (!resizing) return;
			resizing = false;
			try {
				e.target.releasePointerCapture?.(e.pointerId);
			} catch {
				// ignore
			}
			clampPanel(panel);
			saveGeom(panel);
		};

		panel.addEventListener('pointerup', endResize);
		panel.addEventListener('pointercancel', endResize);
	}

	function buildWebuiSrc(trackUrl) {
		const params = new URLSearchParams({
			url: trackUrl,
			outputFormat: getOutputFormat(),
		});
		return `${getWebuiBase()}/?${params.toString()}`;
	}

	function loadTrackIntoPanel(panel, trackUrl) {
		// Switching tracks cancels any in-flight job for the previous one
		if (panel.dataset.jobId) {
			void cancelActiveJob(panel);
		}
		panel.dataset.trackUrl = trackUrl;
		const src = buildWebuiSrc(trackUrl);
		const iframe = panel.querySelector('iframe');
		const openTab = panel.querySelector('.sc-gate-dl-open-tab');
		if (iframe) iframe.src = src;
		if (openTab instanceof HTMLAnchorElement) openTab.href = src;
	}

	function getApiBase() {
		try {
			if (typeof GM_getValue === 'function') {
				const gm = GM_getValue(API_BASE_KEY, null);
				if (typeof gm === 'string' && gm.trim()) {
					return gm.replace(/\/$/, '');
				}
			}
		} catch {
			// ignore
		}
		try {
			const stored = localStorage.getItem(API_BASE_KEY)?.replace(/\/$/, '');
			if (stored) return stored;
		} catch {
			// ignore
		}
		try {
			const webui = getWebuiBase();
			const u = new URL(webui);
			if (u.port === '4321') u.port = '3000';
			return u.origin;
		} catch {
			return 'http://localhost:3000';
		}
	}

	async function cancelActiveJob(panel) {
		if (!panel) return;
		const jobId = panel.dataset.jobId;
		if (!jobId) return;

		const iframe = panel.querySelector('iframe');
		if (iframe?.contentWindow) {
			try {
				iframe.contentWindow.postMessage(
					{ source: 'sc-gate-dl-host', type: 'cancel' },
					new URL(getWebuiBase()).origin,
				);
			} catch {
				// ignore
			}
		}
		try {
			await fetch(`${getApiBase()}/api/job/${encodeURIComponent(jobId)}/cancel`, {
				method: 'POST',
			});
		} catch {
			// ignore — panel still closes
		}
		delete panel.dataset.jobId;
	}

	async function closePanel() {
		window.clearTimeout(autoCloseTimer);
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		await cancelActiveJob(panel);
		const iframe = panel.querySelector('iframe');
		if (iframe) iframe.src = 'about:blank';
		delete panel.dataset.trackUrl;
		panel.hidden = true;
	}

	function applyQueueGeom(el) {
		const saved = loadQueueGeom();
		if (saved) {
			el.style.width = `${saved.width}px`;
			el.style.left = `${saved.left}px`;
			el.style.top = `${saved.top}px`;
			return;
		}
		el.style.width = `${DEFAULT_QUEUE_GEOM.width}px`;
		el.style.left = `${DEFAULT_QUEUE_GEOM.left}px`;
		el.style.top = `${DEFAULT_QUEUE_GEOM.top}px`;
	}

	function clampQueue(el) {
		const rect = el.getBoundingClientRect();
		const maxLeft = window.innerWidth - Math.min(rect.width, window.innerWidth);
		const maxTop = window.innerHeight - Math.min(rect.height, window.innerHeight);
		const left = Math.min(Math.max(0, rect.left), Math.max(0, maxLeft));
		const top = Math.min(Math.max(0, rect.top), Math.max(0, maxTop));
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}

	function enableQueueDrag(el) {
		const toolbar = el.querySelector('.sc-gate-dl-toolbar');
		if (!toolbar || toolbar.dataset.dragBound) return;
		toolbar.dataset.dragBound = '1';

		let dragging = false;
		let startX = 0;
		let startY = 0;
		let origLeft = 0;
		let origTop = 0;

		toolbar.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			if (e.target.closest('button')) return;
			dragging = true;
			const rect = el.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			origLeft = rect.left;
			origTop = rect.top;
			toolbar.setPointerCapture(e.pointerId);
			e.preventDefault();
		});

		toolbar.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			el.style.left = `${origLeft + (e.clientX - startX)}px`;
			el.style.top = `${origTop + (e.clientY - startY)}px`;
		});

		const endDrag = (e) => {
			if (!dragging) return;
			dragging = false;
			try {
				toolbar.releasePointerCapture(e.pointerId);
			} catch {
				// ignore
			}
			clampQueue(el);
			saveQueueGeom(el);
		};

		toolbar.addEventListener('pointerup', endDrag);
		toolbar.addEventListener('pointercancel', endDrag);
	}

	function clearQueue() {
		downloadQueue.length = 0;
		renderQueue();
	}

	function removeFromQueue(index) {
		if (index < 0 || index >= downloadQueue.length) return;
		downloadQueue.splice(index, 1);
		renderQueue();
	}

	function enqueueDownload(trackUrl) {
		if (downloadQueue.some((item) => item.url === trackUrl)) return;
		const panel = document.getElementById(PANEL_ID);
		if (panel && !panel.hidden && panel.dataset.trackUrl === trackUrl) return;
		downloadQueue.push({
			url: trackUrl,
			label: trackLabelFromUrl(trackUrl),
		});
		renderQueue();
	}

	function startNextFromQueue() {
		window.clearTimeout(autoCloseTimer);
		const next = downloadQueue.shift();
		renderQueue();
		if (next) {
			openPanel(next.url);
			return true;
		}
		return false;
	}

	function startQueuedAt(index) {
		if (index < 0 || index >= downloadQueue.length) return;
		const [item] = downloadQueue.splice(index, 1);
		renderQueue();
		if (!item) return;
		const panel = document.getElementById(PANEL_ID);
		// Active job in progress — only promote to next in line
		if (panel && !panel.hidden && panel.dataset.jobId) {
			downloadQueue.unshift(item);
			renderQueue();
			return;
		}
		openPanel(item.url);
	}

	function renderQueue() {
		ensureStyles();
		let el = document.getElementById(QUEUE_ID);
		if (downloadQueue.length === 0) {
			if (el) el.hidden = true;
			return;
		}

		if (!el) {
			el = document.createElement('div');
			el.id = QUEUE_ID;
			el.setAttribute('role', 'dialog');
			el.setAttribute('aria-modal', 'false');
			el.setAttribute('aria-label', 'sc-gate-dl download queue');
			el.innerHTML = `
				<div class="sc-gate-dl-toolbar">
					<span class="sc-gate-dl-queue-title">Queue</span>
					<button type="button" class="sc-gate-dl-close" aria-label="Clear queue" title="Clear queue">×</button>
				</div>
				<ul class="sc-gate-dl-queue-list"></ul>
			`;
			el.querySelector('.sc-gate-dl-close')?.addEventListener('click', () => {
				clearQueue();
			});
			document.documentElement.appendChild(el);
			applyQueueGeom(el);
			enableQueueDrag(el);
		}

		const title = el.querySelector('.sc-gate-dl-queue-title');
		if (title) title.textContent = `Queue (${downloadQueue.length})`;

		const list = el.querySelector('.sc-gate-dl-queue-list');
		if (!(list instanceof HTMLElement)) return;
		list.replaceChildren();
		downloadQueue.forEach((item, index) => {
			const li = document.createElement('li');
			li.className = 'sc-gate-dl-queue-item';

			const labelBtn = document.createElement('button');
			labelBtn.type = 'button';
			labelBtn.className = 'sc-gate-dl-queue-label';
			labelBtn.title = item.url;
			labelBtn.textContent = item.label;
			labelBtn.addEventListener('click', () => startQueuedAt(index));

			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.className = 'sc-gate-dl-queue-remove';
			removeBtn.setAttribute('aria-label', 'Remove from queue');
			removeBtn.title = 'Remove';
			removeBtn.textContent = '×';
			removeBtn.addEventListener('click', () => removeFromQueue(index));

			li.append(labelBtn, removeBtn);
			list.appendChild(li);
		});

		el.hidden = false;
		clampQueue(el);
	}

	function requestDownload(trackUrl) {
		if (isPanelBusy()) {
			enqueueDownload(trackUrl);
			return;
		}
		openPanel(trackUrl);
	}

	function finishCurrentAndAdvance() {
		if (downloadQueue.length > 0) {
			startNextFromQueue();
			return;
		}
		void closePanel();
	}

	let autoCloseTimer = 0;

	window.addEventListener('message', (event) => {
		const data = event.data;
		if (!data || data.source !== 'sc-gate-dl') return;
		const panel = document.getElementById(PANEL_ID);
		let webuiOrigin;
		try {
			webuiOrigin = new URL(getWebuiBase()).origin;
		} catch {
			return;
		}
		if (event.origin !== webuiOrigin) return;
		if (event.source !== panel?.querySelector('iframe')?.contentWindow) return;

		if (data.type === 'job' && data.jobId && panel) {
			panel.dataset.jobId = String(data.jobId);
			return;
		}
		if ((data.type === 'cancelled' || data.type === 'ready') && panel) {
			delete panel.dataset.jobId;
			return;
		}

		if (data.type === 'file-download') {
			if (panel) delete panel.dataset.jobId;
			if (!getAutoClose()) return;
			window.clearTimeout(autoCloseTimer);
			autoCloseTimer = window.setTimeout(() => {
				finishCurrentAndAdvance();
			}, 600);
		} else if (data.type === 'new-download') {
			if (panel) delete panel.dataset.jobId;
			if (downloadQueue.length > 0) {
				startNextFromQueue();
				return;
			}
			if (getAutoClose()) void closePanel();
		}
	});

	function openPanel(trackUrl) {
		window.clearTimeout(autoCloseTimer);
		ensureStyles();
		let panel = document.getElementById(PANEL_ID);
		if (!panel) {
			panel = document.createElement('div');
			panel.id = PANEL_ID;
			panel.hidden = true;
			panel.setAttribute('role', 'dialog');
			panel.setAttribute('aria-modal', 'false');
			panel.setAttribute('aria-label', 'sc-gate-dl');
			const format = getOutputFormat();
			panel.innerHTML = `
				<div class="sc-gate-dl-toolbar">
					<span>sc-gate-dl · <a class="sc-gate-dl-open-tab" href="#" target="_blank" rel="noopener">open in tab</a></span>
					<span class="sc-gate-dl-actions">
						<label>
							<select class="sc-gate-dl-format" aria-label="Output format" title="Output format">
								<option value="mp3-320"${format === 'mp3-320' ? ' selected' : ''}>MP3 320</option>
								<option value="original"${format === 'original' ? ' selected' : ''}>Original</option>
							</select>
						</label>
						<button type="button" class="sc-gate-dl-close" aria-label="Close" title="Close">×</button>
					</span>
				</div>
				<iframe title="sc-gate-dl" allow="clipboard-read; clipboard-write"></iframe>
			`;
			panel
				.querySelector('.sc-gate-dl-close')
				?.addEventListener('click', () => {
					void closePanel();
				});
			panel
				.querySelector('.sc-gate-dl-format')
				?.addEventListener('change', (e) => {
					const select = e.target;
					if (!(select instanceof HTMLSelectElement)) return;
					setOutputFormat(select.value);
				});
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !panel.hidden) void closePanel();
			});
			document.documentElement.appendChild(panel);
			applyDefaultGeom(panel);
			enableDrag(panel);
			enableEdgeResize(panel);
		} else if (panel.hidden) {
			clampPanel(panel);
		}

		loadTrackIntoPanel(panel, trackUrl);
		panel.hidden = false;
		clampPanel(panel);
	}

	function bindClick(el, trackUrl) {
		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			hideTooltip();
			const url = resolveTrackUrl(el) || trackUrl;
			if (!url) {
				alert('sc-gate-dl: could not resolve a SoundCloud track URL here.');
				return;
			}
			requestDownload(url);
		});
	}

	function makeClassicControl(trackUrl) {
		// Mirror purchaseLink__container: SC tooltips key off aria-describedby + hover
		const wrap = document.createElement('div');
		wrap.setAttribute(WRAP_ATTR, 'classic');
		wrap.className = 'purchaseLink__container';
		wrap.setAttribute('aria-describedby', TOOLTIP_ID);
		wrap.setAttribute('aria-label', TOOLTIP_LABEL);

		const btn = document.createElement('a');
		btn.href = '#';
		btn.setAttribute(BUTTON_ATTR, 'classic');
		btn.className =
			'soundActions__purchaseLink sc-button sc-button-tertiary sc-button-responsive';
		btn.setAttribute('aria-label', TOOLTIP_LABEL);
		btn.setAttribute('aria-describedby', TOOLTIP_ID);
		btn.innerHTML = `<span class="sc-button-label"><div>${DOWNLOAD_ICON_16}</div></span>`;
		bindClick(btn, trackUrl);
		wrap.appendChild(btn);
		bindTooltip(wrap);
		return wrap;
	}

	function makeMuiControl(trackUrl, templateBtn) {
		const wrap = document.createElement('div');
		wrap.setAttribute(WRAP_ATTR, 'mui');
		wrap.className = 'MuiBox-root mui-0';
		wrap.setAttribute('aria-label', TOOLTIP_LABEL);

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.setAttribute(BUTTON_ATTR, 'mui');
		btn.setAttribute('aria-label', TOOLTIP_LABEL);
		btn.className =
			templateBtn?.className ||
			'MuiButtonBase-root MuiIconButton-root MuiIconButton-colorContrast MuiIconButton-sizeMedium';
		btn.innerHTML = DOWNLOAD_ICON_24;
		bindClick(btn, trackUrl);
		wrap.appendChild(btn);
		bindTooltip(wrap);
		return wrap;
	}

	/**
	 * Classic: cart sits in a 40px `.purchaseLink__container` inside an anonymous
	 * wrapper under `.soundActions` (flex row). Insert AFTER that wrapper.
	 */
	function classicAnchorPoint(el) {
		const container =
			el.closest?.('.purchaseLink__container') ||
			(el.classList?.contains('purchaseLink__container') ? el : null);
		if (!container) {
			return el.closest?.('a.soundActions__purchaseLink, a.sc-button-buy') || el;
		}
		const actions = container.closest('.soundActions');
		const wrap = container.parentElement;
		if (actions && wrap && wrap.parentElement === actions && wrap !== actions) {
			return wrap;
		}
		// Container is already a direct child of .soundActions
		if (actions && container.parentElement === actions) return container;
		return container;
	}

	function injectClassic(el) {
		if (isOurNode(el)) return;
		if (isPlaylistOrAlbumContext(el)) return;
		const trackUrl = resolveTrackUrl(el);
		// Insert as sibling AFTER the cart cluster inside .soundActions.
		// Do not append inside the cart wrapper — it is ~16px tall and clips the icon.
		const anchorPoint = classicAnchorPoint(el);
		if (isOurNode(anchorPoint) || alreadyInjectedNear(anchorPoint)) return;
		const actions = anchorPoint.closest?.('.soundActions') || anchorPoint.parentElement;
		if (actions instanceof HTMLElement) {
			actions.style.overflow = 'visible';
			actions.style.alignItems = 'center';
		}
		anchorPoint.insertAdjacentElement('afterend', makeClassicControl(trackUrl));
	}

	function isMuiBuyAnchor(el) {
		if (!(el instanceof HTMLAnchorElement)) return false;
		if (isOurNode(el)) return false;
		// Never treat classic SC purchase links as MUI (caused duplicate under-cart inject)
		if (el.closest('.purchaseLink__container, .soundActions, .sound__soundActions')) {
			return false;
		}
		if (el.classList.contains('soundActions__purchaseLink')) return false;
		const label = el.getAttribute('aria-label') || '';
		if (!/buy|store|purchase|free\s*download/i.test(label)) return false;
		return !!el.querySelector('button.MuiIconButton-root, svg');
	}

	function injectMui(buyAnchor) {
		if (!isMuiBuyAnchor(buyAnchor)) return;
		if (isPlaylistOrAlbumContext(buyAnchor)) return;
		if (alreadyInjectedNear(buyAnchor)) return;
		const templateBtn = buyAnchor.querySelector('button.MuiIconButton-root');
		const trackUrl = resolveTrackUrl(buyAnchor);
		buyAnchor.insertAdjacentElement(
			'afterend',
			makeMuiControl(trackUrl, templateBtn),
		);
	}

	function isClassicPurchase(el) {
		if (!(el instanceof Element) || isOurNode(el)) return false;
		if (el.classList.contains('purchaseLink__container')) return true;
		if (el.classList.contains('soundActions__purchaseLink')) return true;
		if (el.classList.contains('sc-button-buy')) return true;
		return false;
	}

	function scan(root = document) {
		const scope = root instanceof Element || root === document ? root : document;

		// Drop buttons that landed on playlist/album cards (e.g. before class hydrated)
		for (const wrap of scope.querySelectorAll?.(`[${WRAP_ATTR}]`) || []) {
			if (isPlaylistOrAlbumContext(wrap)) wrap.remove();
		}

		// Classic layout only — one control per purchaseLink__container
		const containers = scope.querySelectorAll?.('.purchaseLink__container') || [];
		for (const el of containers) {
			if (isOurNode(el)) continue;
			injectClassic(el);
		}
		// Orphan classic purchase anchors without container (rare)
		for (const el of scope.querySelectorAll?.(
			'a.soundActions__purchaseLink, a.sc-button-buy',
		) || []) {
			if (isOurNode(el)) continue;
			if (el.closest('.purchaseLink__container')) continue;
			if (isClassicPurchase(el)) injectClassic(el);
		}

		// MUI logged-in listen page only
		for (const el of scope.querySelectorAll?.(
			'a[aria-label="Buy This Track"], a[target="_blank"][aria-label]',
		) || []) {
			injectMui(el);
		}
	}

	ensureStyles();
	scan();

	const observer = new MutationObserver((mutations) => {
		let shouldScan = false;
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (!(node instanceof Element)) continue;
				if (isOurNode(node)) continue;
				shouldScan = true;
				break;
			}
			if (shouldScan) break;
		}
		if (shouldScan) scan();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });

	let lastHref = location.href;
	setInterval(() => {
		if (location.href !== lastHref) {
			lastHref = location.href;
			scan();
		}
	}, 1000);

	registerMenuCommands();

	console.info(
		`[sc-gate-dl] ready — Web UI: ${getWebuiBase()} (run \`bun webui\`). Override with localStorage key "${WEBUI_BASE_KEY}".`,
	);
})();
