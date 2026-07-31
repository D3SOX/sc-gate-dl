// Login preparation
const SOUNDCLOUD_LIBRARY_LINK = 'a[href="/you/library"]';
const SOUNDCLOUD_CAPTCHA_CONTAINER = 'div[id*="ddChallengeContainer"]';
const SOUNDCLOUD_CAPTCHA_IFRAME = `iframe[src^="https://geo.captcha-delivery.com/captcha/"]`;
const SOUNDCLOUD_CAPTCHA_SLIDER = '.slider';
const SOUNDCLOUD_CAPTCHA_TRACK = '.sliderText';

const SPOTIFY_ACCOUNT_SETTINGS_LINK = '#account-settings-link';

// Hypeddit smart link selection page (shown when the URL is a multi-platform smart link)
const HYPEDDIT_SMART_LINK_SECTION = '.hype-smart-link-list-section';
const HYPEDDIT_SMART_LINK_HYPEDDIT_ANCHOR = `${HYPEDDIT_SMART_LINK_SECTION} a.smartlink-click-button[data-type="hypeddit"]`;

// Hypeddit gate fetching
const DOWNLOAD_PROCESS_BUTTON = '#downloadProcess';
const ALL_STEPS_CONTAINER = '#all_steps';
const ALL_STEPS_CHILD_DIVS = `${ALL_STEPS_CONTAINER} > div`;

// Email gate
const EMAIL_NAME_INPUT = '#email_name';
const EMAIL_ADDRESS_INPUT = '#email_address';
const EMAIL_NEXT_BUTTON = '#email_to_downloads_next';

// SoundCloud gate
const SC_SKIPPER_BUTTON = '#skipper_sc';
const SC_STATUS_BUTTON = '#soundcloud_status .hype-btn-soundcloud';
const SC_STATUS_UNDONE_BUTTON =
	'#soundcloud_status .hype-btn-soundcloud.undone';
const SC_NEXT_BUTTON = '#skipper_sc_next';
// Legacy SoundCloud gate (OAuth connect flow)
const SC_COMMENT_TEXT_INPUT = '#sc_comment_text';
const SC_LOGIN_BUTTON = '#login_to_sc';
const SC_SUBMIT_APPROVAL_BUTTON = '#submit_approval';

// Instagram gate
const IG_SKIPPER_BUTTON = '#skipper_ig';
const IG_STATUS_BUTTON = '#instagram_status .hype-btn-instagram';
const IG_STATUS_UNDONE_BUTTON = '#instagram_status .hype-btn-instagram.undone';
const IG_NEXT_BUTTON = '#skipper_ig_next';

// TikTok gate
const TK_SKIPPER_BUTTON = '#skipper_tk';
const TK_STATUS_BUTTON = '#tiktok_status .hype-btn-tiktok';
const TK_STATUS_UNDONE_BUTTON = '#tiktok_status .hype-btn-tiktok.undone';
const TK_NEXT_BUTTON = '#skipper_tk_next';

// YouTube gate
const YT_SKIPPER_BUTTON = '#skipper_yt';
const YT_STATUS_BUTTON = '#youtube_status .hype-btn-youtube';
const YT_STATUS_UNDONE_BUTTON = '#youtube_status .hype-btn-youtube.undone';
const YT_NEXT_BUTTON = '#skipper_yt_next';

// Facebook gate
const FB_NEXT_BUTTON = '#fbCarouselSocialSection';

// Spotify gate
const SP_SKIPPER_BUTTON = '#skipper_sp';
const SP_OPT_IN_SECTION = '#optInSectionSpotify';
const SP_OPT_OUT_OPTION = 'a.optOutOption';
const SP_LOGIN_BUTTON = '#login_to_sp';
const SP_AUTH_ACCEPT_BUTTON = '[data-testid="auth-accept"]';

// Download gate
const DW_DOWNLOAD_BUTTON = '#gateDownloadButton';

// Droploud gate
const DROPLOUD_FREE_DOWNLOAD_BUTTON = '.ds-free-dl.dtr-card-cta';
const DROPLOUD_STEP_PANE = '.dtr-card-pane-step';
const DROPLOUD_OPEN_LINK_BUTTONS = '.dtr-open-grid .ds-btn';
const DROPLOUD_CONFIRM_BUTTON = 'button.dtr-confirm-btn';
const DROPLOUD_SC_COMMENT_INPUT = '#dtr-sc-comment-input';
const DROPLOUD_UNLOCKED_TITLE = '.dtr-card-title';
const DROPLOUD_DOWNLOAD_BUTTON = '.ds-free-dl.dtr-card-cta';
const DROPLOUD_EMAIL_WRAP = '.dtr-email-wrap';
const DROPLOUD_EMAIL_INPUT = '.dtr-email-wrap input[type="email"]';
const DROPLOUD_EMAIL_CONSENT = '.dtr-email-wrap input[type="checkbox"]';
const DROPLOUD_DLFOLLOW_WRAP = '.dtr-dlfollow-wrap';
const DROPLOUD_DLFOLLOW_SKIP = 'button.dtr-dlfollow-skip';
const DROPLOUD_DISCLAIMER_CHECK = '.dtr-social-wrap input[type="checkbox"]';

// GateRush gate
const GATERUSH_COOKIE_ACCEPT = '#acceptAllBtn';
const GATERUSH_EMAIL_FORM = '#emailForm';
const GATERUSH_NAME_INPUT = '#nameInput';
const GATERUSH_EMAIL_INPUT = '#emailInput';
const GATERUSH_EMAIL_SUBMIT = '#btnSaveEmail';
const GATERUSH_COMMENT_FORM = '#commentForm';
const GATERUSH_COMMENT_INPUT = '#commentInput';
const GATERUSH_SC_CONNECT = '#btnSoundCloudConnect';
const GATERUSH_IG_ACCOUNT_BUTTON = '.btnIgAccount';
const GATERUSH_DOWNLOAD_BUTTON = '#btnDownload';
const GATERUSH_PROGRESS_STEP = '.progress-step';

// DownloadGater gate
const DOWNLOADGATER_FREE_DOWNLOAD = 'button.download-button';
const DOWNLOADGATER_DOWNLOAD_FILE = 'button.download-button';

export default {
	SOUNDCLOUD_LIBRARY_LINK,
	SOUNDCLOUD_CAPTCHA_CONTAINER,
	SOUNDCLOUD_CAPTCHA_IFRAME,
	SOUNDCLOUD_CAPTCHA_SLIDER,
	SOUNDCLOUD_CAPTCHA_TRACK,
	SPOTIFY_ACCOUNT_SETTINGS_LINK,
	HYPEDDIT_SMART_LINK_SECTION,
	HYPEDDIT_SMART_LINK_HYPEDDIT_ANCHOR,
	DOWNLOAD_PROCESS_BUTTON,
	ALL_STEPS_CONTAINER,
	ALL_STEPS_CHILD_DIVS,
	EMAIL_NAME_INPUT,
	EMAIL_ADDRESS_INPUT,
	EMAIL_NEXT_BUTTON,
	SC_SKIPPER_BUTTON,
	SC_STATUS_BUTTON,
	SC_STATUS_UNDONE_BUTTON,
	SC_NEXT_BUTTON,
	SC_COMMENT_TEXT_INPUT,
	SC_LOGIN_BUTTON,
	SC_SUBMIT_APPROVAL_BUTTON,
	IG_SKIPPER_BUTTON,
	IG_STATUS_BUTTON,
	IG_STATUS_UNDONE_BUTTON,
	IG_NEXT_BUTTON,
	TK_SKIPPER_BUTTON,
	TK_STATUS_BUTTON,
	TK_STATUS_UNDONE_BUTTON,
	TK_NEXT_BUTTON,
	YT_SKIPPER_BUTTON,
	YT_STATUS_BUTTON,
	YT_STATUS_UNDONE_BUTTON,
	YT_NEXT_BUTTON,
	FB_NEXT_BUTTON,
	SP_SKIPPER_BUTTON,
	SP_OPT_IN_SECTION,
	SP_OPT_OUT_OPTION,
	SP_LOGIN_BUTTON,
	SP_AUTH_ACCEPT_BUTTON,
	DW_DOWNLOAD_BUTTON,
	DROPLOUD_FREE_DOWNLOAD_BUTTON,
	DROPLOUD_STEP_PANE,
	DROPLOUD_OPEN_LINK_BUTTONS,
	DROPLOUD_CONFIRM_BUTTON,
	DROPLOUD_SC_COMMENT_INPUT,
	DROPLOUD_UNLOCKED_TITLE,
	DROPLOUD_DOWNLOAD_BUTTON,
	DROPLOUD_EMAIL_WRAP,
	DROPLOUD_EMAIL_INPUT,
	DROPLOUD_EMAIL_CONSENT,
	DROPLOUD_DLFOLLOW_WRAP,
	DROPLOUD_DLFOLLOW_SKIP,
	DROPLOUD_DISCLAIMER_CHECK,
	GATERUSH_COOKIE_ACCEPT,
	GATERUSH_EMAIL_FORM,
	GATERUSH_NAME_INPUT,
	GATERUSH_EMAIL_INPUT,
	GATERUSH_EMAIL_SUBMIT,
	GATERUSH_COMMENT_FORM,
	GATERUSH_COMMENT_INPUT,
	GATERUSH_SC_CONNECT,
	GATERUSH_IG_ACCOUNT_BUTTON,
	GATERUSH_DOWNLOAD_BUTTON,
	GATERUSH_PROGRESS_STEP,
	DOWNLOADGATER_FREE_DOWNLOAD,
	DOWNLOADGATER_DOWNLOAD_FILE,
} as const;
