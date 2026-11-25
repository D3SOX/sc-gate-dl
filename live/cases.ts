import type { GateProvider } from '../src/utils';

export interface LiveCase {
	/** Test title. Keep it unique; `-t` filters on it. */
	name: string;
	/** What the app receives: a gate, smart link, Bandcamp, direct or SoundCloud URL. */
	url: string;
	/** Provider `resolveGateUrlOrFollow` must pick for `url`. */
	provider: GateProvider;
	/** Steps and code paths the link exercises, so a failure points somewhere. */
	covers: string;
	/** Final URL after smart-link resolution, when it differs from `url`. */
	resolvesTo?: string | RegExp;
	/** Only check resolution; the download path is covered by another case. */
	resolveOnly?: boolean;
	/** SoundCloud track whose purchase URL or description must resolve to `provider`. */
	soundcloud?: string;
	/** SoundCloud title used to pick the track on a Bandcamp album. */
	matchTitle?: string;
	/** Hypeddit: the download must succeed without the browser. */
	browserless?: boolean;
	/** Skipped unless these `.env` variables are set. */
	requiresEnv?: string[];
	/** Known unsupported. Runs only with `--todo`; the reason says what's missing. */
	todo?: string;
}

/**
 * Real, public links, picked so that each platform's gate steps are covered
 * at least once. When a link dies or its gate changes, replace it with one
 * covering the same steps instead of deleting the case.
 */
export const LIVE_CASES: Record<string, LiveCase[]> = {
	Hypeddit: [
		{
			name: 'browserless email, SoundCloud, Instagram and TikTok',
			url: 'https://hypeddit.com/karodj/notlikeuskarodj',
			provider: 'hypeddit',
			covers: 'nwSteps sc,ig,email,tk via HTTP',
			browserless: true,
			soundcloud: 'https://soundcloud.com/karodecks/not-like-us-karo-dj-remix',
		},
		{
			name: 'browserless Facebook on a legacy /track/sc/ URL',
			url: 'http://hypeddit.com/track/sc/qhay5q',
			provider: 'hypeddit',
			covers: 'nwSteps fb,sc via HTTP, http:// legacy URL',
			browserless: true,
			soundcloud: 'https://soundcloud.com/chunkydipbootlegs/mambo',
		},
		{
			name: 'browserless YouTube',
			url: 'https://hypeddit.com/track/4xzegg',
			provider: 'hypeddit',
			covers: 'nwSteps yt via HTTP',
			browserless: true,
		},
		{
			name: 'browser Spotify with email, SoundCloud and Instagram',
			url: 'https://hypeddit.com/space92/cirezdonoffspace92edit',
			provider: 'hypeddit',
			covers:
				'nwSteps email,sc,ig,sp; HTTP falls back to the browser, needs spotify-cookies.json',
			soundcloud: 'https://soundcloud.com/space92/cirez-d-on-off-space-92-edit',
		},
		{
			name: 'browser Bandcamp step',
			url: 'https://hypeddit.com/transition/trsn005onlywithyoucomeon',
			provider: 'hypeddit',
			covers: 'nwSteps email,sc,bc; BandcampGateDownloader',
			soundcloud:
				'https://soundcloud.com/transition_ofc/trsn005-onlywithyou-come-on',
		},
		{
			name: 'link gate unlocking a destination',
			url: 'https://hypeddit.com/djlubs/kulosa-amapiano-remix',
			provider: 'hypeddit',
			covers:
				'nwSteps sc,ig with data-type="linkGate"; custom_redirection_url handoff',
			soundcloud: 'https://soundcloud.com/djlubs1/ku-lo-sa-amapiano-remix',
		},
		{
			name: 'smart link selection page with a hypeddit anchor',
			url: 'https://hypeddit.com/thefinesttechno/tft0089gt',
			provider: 'hypeddit',
			covers:
				'redirect to a selection page, data-type="hypeddit" anchor, second redirect to the gate',
			soundcloud:
				'https://soundcloud.com/thefinesttechno/free-download-otak-the-sound-tft089gt',
		},
		{
			name: 'smart link with a custom download anchor',
			url: 'https://hypeddit.com/woodpop/higherorder',
			provider: 'hypeddit',
			covers: 'selection page whose download anchor is data-type="custom"',
		},
		{
			name: 'donation step',
			url: 'https://hypeddit.com/itsnudge/tinashenastynajclubedit',
			provider: 'hypeddit',
			covers: 'nwSteps sc,ig,dn',
			browserless: true,
		},
		{
			name: 'donation step with YouTube',
			url: 'https://hypeddit.com/shaggy/boombasticneffabootleg',
			provider: 'hypeddit',
			covers: 'nwSteps sc,yt,dn',
			browserless: true,
		},
		{
			name: 'either-or group with email',
			url: 'https://hypeddit.com/lexaraballo/lexaraballosilenceafrohouseremix',
			provider: 'hypeddit',
			covers: 'steps_select email, sc|yt|sp, ig via HTTP',
			browserless: true,
		},
		{
			name: 'Twitter step',
			url: 'https://hypeddit.com/djmanjit/tangledjourneyfreedownloadviahypeddit',
			provider: 'hypeddit',
			covers: 'nwSteps tw,ig,tk,bc with a tk|bc group',
			todo: 'this gate uses the X sign-in variant, which needs a person at the remote browser',
		},
		{
			name: 'either-or group satisfiable without the browser',
			url: 'https://hypeddit.com/track/sbsw60',
			provider: 'hypeddit',
			covers: 'nwSteps yt,sp,sc,ap shown as one group yt|sp|sc|ap via HTTP',
			browserless: true,
		},
	],
	Droploud: [
		{
			name: 'email, socials, full SoundCloud and Droploud follow',
			url: 'https://droploud.com/track/9ad17c6f-40ee-412f-9eb6-c2a32e3cb70a',
			provider: 'droploud',
			covers:
				'email, Instagram, YouTube and Spotify social_open, SoundCloud follow/like/repost/comment connect, droploud_follow',
			soundcloud:
				'https://soundcloud.com/latinhousegangmusic/karol-g-judeline-rusowsky-1',
			todo: 'SoundCloud blocks the repost Droploud enforces here in CloakBrowser; only the plain Firefox repost on Linux with X11 gets it through',
		},
		{
			name: 'SoundCloud without comment on a legacy /gate/ URL',
			url: 'https://droploud.com/gate/10bad7c3-07a6-4a35-ad00-2f131b6d7dcf',
			provider: 'droploud',
			covers:
				'/gate/ redirect, SoundCloud follow/like/repost without comment box, droploud_follow',
			soundcloud: 'https://soundcloud.com/hecki_music/ein-kompliment',
		},
	],
	GateRush: [
		{
			name: 'email with name, full SoundCloud and Instagram',
			url: 'https://gaterush.me/5QGh1L',
			provider: 'gaterush',
			covers:
				'email + name, SoundCloud like/repost/comment/follow/playlist follow, Instagram',
		},
		{
			name: 'email without name, Spotify step',
			url: 'https://gaterush.me/fRA4a3',
			provider: 'gaterush',
			covers:
				'email without name field, SoundCloud, Instagram, Spotify open + confirm',
			soundcloud: 'https://soundcloud.com/inarushhhh/the-doll',
		},
		{
			name: 'skippable email and Instagram',
			url: 'https://gaterush.me/asf9kp',
			provider: 'gaterush',
			covers: 'skippable email + name, SoundCloud, skippable Instagram',
			soundcloud: 'https://soundcloud.com/cheikh123/cheikh-north-1',
		},
		{
			name: 'Spotify step',
			url: 'https://gaterush.me/J2-xKQ',
			provider: 'gaterush',
			covers: 'email + name, SoundCloud, Instagram, Spotify',
			soundcloud:
				'https://soundcloud.com/the-radical-one/so-anxious-soulchata-edition',
		},
		{
			name: 'link reward',
			url: 'https://gaterush.me/V75KVk',
			provider: 'gaterush',
			covers:
				'rewardIsLink: true, unlocked link handed to the direct downloader',
			soundcloud:
				'https://soundcloud.com/karyomusic/karyo-blaiz-fayah-beenie-man',
		},
	],
	DownloadGater: [
		{
			name: 'SoundCloud follows, repost and comment',
			url: 'https://downloadgater.com/g/noise-mafia-nueva-yol-02024',
			provider: 'downloadgater',
			covers: 'FREE DOWNLOAD, SoundCloud follow x5/repost/comment connect',
			soundcloud: 'https://soundcloud.com/noisemafia/noise-mafia-nueva-yol',
		},
		{
			name: 'Instagram and SoundCloud without comment',
			url: 'https://downloadgater.com/g/shades-mix-it-up-44294',
			provider: 'downloadgater',
			covers: 'Instagram, SoundCloud follow/repost without comment box',
		},
		{
			name: 'email capture and Spotify visit',
			url: 'https://downloadgater.com/g/henk-get-ready-for-this-remix-44544',
			provider: 'downloadgater',
			covers:
				'emailCapture required, Instagram, Spotify follow (visit), SoundCloud',
		},
		{
			name: 'Spotify OAuth and YouTube subscribe',
			url: 'https://downloadgater.com/g/wherehaveyoubeenrisedit-79076',
			provider: 'downloadgater',
			covers:
				'email, Instagram, Spotify follow (OAuth), YouTube subscribe, SoundCloud',
		},
	],
	StillHype: [
		{
			name: 'SoundCloud bundle only',
			url: 'https://www.stillhype.io/g/swing-v4itbz',
			provider: 'stillhype',
			covers: 'soundcloud_bundle (like, repost, comment, follow) via OAuth',
			soundcloud: 'https://soundcloud.com/peyruis/swing',
		},
		{
			name: 'separate SoundCloud steps with artist follow',
			url: 'https://www.stillhype.io/g/ma-cek-formula-one-new-glam-YbxXU1',
			provider: 'stillhype',
			covers:
				'separate soundcloud_follow/like/repost/comment, soundcloud_follow_artist',
			soundcloud:
				'https://soundcloud.com/newglam/free-download-mayacek-formula',
		},
		{
			name: 'external download',
			url: 'https://www.stillhype.io/g/nachtwasser-schnelle-beats-SfVzxR',
			provider: 'stillhype',
			covers: 'separate SoundCloud steps, is_external_download: true',
		},
		{
			name: 'email and social steps',
			url: 'https://www.stillhype.io/g/daft-punk-one-more-time-vip-jamieson-free-download-qkkz71',
			provider: 'stillhype',
			covers:
				'email_capture required, bundle, enhancedFollow instagram/twitter/youtube/tiktok',
			soundcloud:
				'https://soundcloud.com/jamieson-ree/daft-punk-one-more-time-vip',
			requiresEnv: [
				'INSTAGRAM_HANDLE',
				'X_HANDLE',
				'YOUTUBE_HANDLE',
				'TIKTOK_HANDLE',
			],
		},
		{
			name: 'optional email and Instagram follow with handle check',
			url: 'https://www.stillhype.io/g/three8-DOYW1L',
			provider: 'stillhype',
			covers:
				'optional email_capture (Skip for now), bundle, enhancedFollow instagram',
			soundcloud: 'https://soundcloud.com/dedmandnb/dedman-three8',
			requiresEnv: ['INSTAGRAM_HANDLE'],
		},
		{
			name: 'email and website visit',
			url: 'https://www.stillhype.io/g/boticka-raw-power-free-dl-IHB10y',
			provider: 'stillhype',
			covers: 'email_capture, bundle following 2 accounts, website_visit',
		},
	],
	PumpYourSound: [
		{
			name: 'SoundCloud follow, Instagram and comment',
			url: 'https://pumpyoursound.com/f/larrylars/aguanile-remix/224680',
			provider: 'pumpyoursound',
			covers: 'fangateStep soundcloud, instagram, comment',
			soundcloud:
				'https://soundcloud.com/larry-lars-328906221/aguanile-groove-hector-lavoe',
		},
		{
			name: 'Bandcamp album handoff',
			url: 'https://pumpyoursound.com/f/pys/latina-ep/200904',
			provider: 'pumpyoursound',
			covers:
				'SoundCloud follow, comment, download link to a Bandcamp album matched by title',
			matchTitle: 'Linapary, Don Amor - LATINA (Guaracha) - FREE DONWLOAD',
			soundcloud: 'https://soundcloud.com/linapary/linapary-don-amor-latina',
		},
		{
			name: 'email, YouTube and Facebook like and share',
			url: 'https://pumpyoursound.com/f/pys/con-vie-la-lan-juongb-x-j-bae/239012',
			provider: 'pumpyoursound',
			covers:
				'SoundCloud follow, youtube, Facebook like + share (markFacebookStepAsComplete), instagram, comment, email',
			soundcloud:
				'https://soundcloud.com/juongbofficial/congvienlamlang-juongbxjbae',
		},
		{
			name: 'every honor-system step with a MediaFire link',
			url: 'https://pumpyoursound.com/f/pys/este-o-este-remix-perreo-dj-mendes/181617',
			provider: 'pumpyoursound',
			covers:
				'SoundCloud follow, instagram, youtube, Facebook like via /auth/facebook-like/, comment, MediaFire download link',
		},
		{
			name: 'Spotify step',
			url: 'https://pumpyoursound.com/f/pys/barudak-phonk-terror/198809',
			provider: 'pumpyoursound',
			covers: 'spotify follow, Facebook like via /auth/facebook-like/',
		},
	],
	MyPressKit: [
		{
			name: 'separate SoundCloud steps with a second follow',
			url: 'https://www.mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit',
			provider: 'mypresskit',
			covers: 'soundcloud-follow x2, repost, like, comment via OAuth',
			soundcloud:
				'https://soundcloud.com/dj-felge/rihanna-umbrella-dj-felge-x-kluge-edit',
		},
		{
			name: 'combined SoundCloud steps and required Instagram',
			url: 'https://www.mypresskit.info/gate/timon-djsarin-alien-tears',
			provider: 'mypresskit',
			covers: 'combineSoundCloudSteps, 2 required instagram-follow',
			soundcloud:
				'https://soundcloud.com/notpumbaa/timon-tnoproject-alien-tears',
		},
		{
			name: 'optional Instagram',
			url: 'https://www.mypresskit.info/gate/rasanton-wano-kuni',
			provider: 'mypresskit',
			covers: 'combined SoundCloud steps, optional instagram-follow',
			soundcloud: 'https://soundcloud.com/rasanton/wanokuni',
		},
		{
			name: 'email and Spotify steps',
			url: 'https://www.mypresskit.info/gate/rasanton-overcharged',
			provider: 'mypresskit',
			covers:
				'SoundCloud steps on a secret-link track, instagram, email-capture, spotify-follow/save',
		},
	],
	Fangate: [
		{
			name: 'Instagram visit and SoundCloud OAuth',
			url: 'https://app.fangate.eu/tracks/user-2628-we-found-love-trance-edit',
			provider: 'fangate',
			covers:
				'session API, skippable instagram visit, soundcloud OAuth (follow, like, repost)',
		},
	],
	Bandcamp: [
		{
			name: 'name-your-price track',
			url: 'https://alanjperezmexa.bandcamp.com/track/beat-20000',
			provider: 'bandcamp',
			covers: 'yt-dlp track download',
			soundcloud:
				'https://soundcloud.com/underbeats-2/20000-plays-free-beat-name-your-price-mexa-on-the-beat',
		},
		{
			name: 'album with title match',
			url: 'https://ukhunrecords.bandcamp.com/album/u-k-hun-digital-002-arfa-con-rw',
			provider: 'bandcamp',
			covers: 'yt-dlp album listing, titleMatchScore picks /track/on-you',
			matchTitle: 'Arfa - On You (Free Download on Bandcamp)',
			soundcloud: 'https://soundcloud.com/ukhunlondon/on-u-mm-master',
		},
	],
	Direct: [
		{
			name: 'Dropbox legacy /s/ link with dl=0',
			url: 'https://www.dropbox.com/s/08mj5wodn2622si/Going%20Low%20On%20Corneria.mp3?dl=0',
			provider: 'direct',
			covers: 'dl=1 rewrite, redirect to scl/fi and dropboxusercontent',
			soundcloud: 'https://soundcloud.com/c0bb/going-low-on-corneria',
		},
		{
			name: 'Dropbox scl/fi link with rlkey',
			url: 'https://www.dropbox.com/scl/fi/vbj78u75oul819ouj768w/QWER-Fake-Idol-Jack-Euro-Remix.mp3?rlkey=tt44adq0sglwtlnogfqv2xjij&st=5fhhgmgj&dl=0',
			provider: 'direct',
			covers: 'scl/fi with rlkey and st, link in the description',
			soundcloud:
				'https://soundcloud.com/itsjackeuro/qwer-fake-idol-jack-euro-remix',
		},
		{
			name: 'Google Drive /file/d/ view link',
			url: 'https://drive.google.com/file/d/12P4JEdeKZ97NjRDpN7DuTeuJp95KL4y9/view?usp=sharing',
			provider: 'direct',
			covers: 'Drive file ID rewrite to a download URL',
			soundcloud:
				'https://soundcloud.com/enkovine/xxulligan-massvvna-enkovine-remix',
		},
		{
			name: 'Google Drive open?id= link',
			url: 'https://drive.google.com/open?id=12VRdsNhcRNql8C3GYHkvBZ6o8XnnuDqu',
			provider: 'direct',
			covers: 'Drive ?id= form',
			soundcloud: 'https://soundcloud.com/greengaomusic/green-gao-waiting',
		},
		{
			name: 'MediaFire file page',
			url: 'https://www.mediafire.com/file/mimzs3ws3t3uekt/Dj_Tura_e_Puto_Cossa_-_TEM_PROBLEMA_NE.mp3/file',
			provider: 'direct',
			covers: 'HTML scan finds the per-session download URL',
			resolvesTo: /^https:\/\/download\d*\.mediafire\.com\//,
		},
	],
	SoundCloud: [
		{
			name: 'creator-enabled original download',
			url: 'https://soundcloud.com/pintiman/drum-loop',
			provider: 'soundcloud',
			covers:
				'downloadable track, original file via soundcloud-cookies.json (stream without them)',
		},
		{
			name: 'stream of a non-downloadable track',
			url: 'https://soundcloud.com/underbeats-2/20000-plays-free-beat-name-your-price-mexa-on-the-beat',
			provider: 'soundcloud',
			covers: 'yt-dlp 128k stream fallback',
		},
	],
	'Smart links': [
		{
			name: 'tr.ee to Linktree to Hypeddit',
			url: 'https://tr.ee/qU2QJs',
			provider: 'hypeddit',
			covers: 'redirect chain, gate URL in Linktree HTML',
			resolvesTo: 'https://hypeddit.com/2i6542',
			resolveOnly: true,
		},
		{
			name: 'bit.ly to Dropbox',
			url: 'https://bit.ly/2Xbw7RY',
			provider: 'direct',
			covers: 'redirect to a Dropbox file',
			resolvesTo:
				'https://www.dropbox.com/s/h3o2rixcx7jrphn/Uptempo%20Kicks%201.rar?dl=1',
			resolveOnly: true,
		},
		{
			name: 'fanlink.tv to Droploud',
			url: 'https://fanlink.tv/nueqemptyspace',
			provider: 'droploud',
			covers: 'gate URL in smart-link HTML',
			resolvesTo:
				'https://droploud.com/track/7abcfbd5-fa3d-4fa4-bf10-fc0ae10d743d',
			resolveOnly: true,
			soundcloud:
				'https://soundcloud.com/sinfulmaze/nueq-empty-space-feat-tali',
		},
		{
			name: 'fanlink.tv to Hypeddit',
			url: 'https://fanlink.tv/anbhb',
			provider: 'hypeddit',
			covers: 'gate URL in smart-link HTML',
			resolvesTo: 'https://hypeddit.com/track/bimzvo',
			resolveOnly: true,
		},
		{
			name: 'lnk.to to Bandcamp album',
			url: 'https://BlackOutRecords.lnk.to/aknf',
			provider: 'bandcamp',
			covers: 'Bandcamp album URL in smart-link HTML',
			resolvesTo: 'https://blackoutrec.bandcamp.com/album/all-killer-no-filler',
			resolveOnly: true,
		},
		{
			name: 'streamlink.to preloadLink to Bandcamp album',
			url: 'https://streamlink.to/UZS11',
			provider: 'bandcamp',
			covers: 'window.preloadLink Bandcamp page',
			resolvesTo: 'https://underzoneco.bandcamp.com/album/uz-singles-xi-2',
			resolveOnly: true,
		},
		{
			name: 'lnk.to to Bandcamp track',
			url: 'https://BlackOutRecords.lnk.to/1up',
			provider: 'bandcamp',
			covers: 'Bandcamp track URL in smart-link HTML',
			resolvesTo: 'https://blackoutrec.bandcamp.com/track/1up-free-download',
			resolveOnly: true,
			todo: 'findKnownGateInHtml drops Bandcamp track links when given a base URL',
		},
	],
};
