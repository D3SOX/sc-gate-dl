import { expect, spyOn, test } from 'bun:test';
import {
	HypedditHttpDownloader,
	parseStepGroups,
	planBrowserlessGate,
} from './hypedditHttp';

// Hidden inputs as Hypeddit renders them (copied from live gates).
function gate(nwSteps: string, stepsSelect: string, extra = ''): string {
	return `<meta name="csrf-token" content="token">
<input type="hidden" name="is_skippable" id="is_skippable"  value="0"/>
<input type="hidden" name="nwSteps" id="nwSteps"  value="${nwSteps}"/>
<input type="hidden" name="current_download_file_listner" id="current_download_file_listner" value="8wjvox" />
<input type="hidden" name="duration" id="duration" value="202000" />
<input type="hidden" name="wrndk" id="wrndk"  value="1462576x2376583"/>
<input type="hidden" id="gvt" value="2Omx1v92owTqiFS505DqxbT9QB2EodY8"/>
<input type="hidden" class="form-control" name="fan_gate_id" id="fan_gate_id" value='1462576'>
<input type="hidden" name="steps_select" id="steps_select" value='${stepsSelect}'>
${extra}`;
}

test('either-or groups come from #steps_select, not the flat #nwSteps', () => {
	expect(
		parseStepGroups(
			gate('email,sc,yt,sp,ig', 'dw,email,sc|yt|sp,ig'), // lexaraballo
		),
	).toEqual([['email'], ['sc', 'yt', 'sp'], ['ig']]);
	expect(parseStepGroups(gate('yt,sp,sc,ap', 'dw,yt|sp|sc|ap'))).toEqual([
		['yt', 'sp', 'sc', 'ap'],
	]);
	// Without #steps_select every step is its own group.
	expect(parseStepGroups('<input id="nwSteps" value="sc,ig,dn"/>')).toEqual([
		['sc'],
		['ig'],
		['dn'],
	]);
});

test('browserless plans mirror what the page collects in skip_gate_steps[]', () => {
	// Donation's "Skip donation" link only advances the slide.
	expect(planBrowserlessGate(gate('sc,ig,dn', 'dw,sc,ig,dn'))).toEqual({
		chosen: ['sc', 'ig', 'dn'],
		skipGateSteps: ['sc', 'ig'],
	});
	// jumpGate() declares the alternatives not taken; email is never skipped.
	expect(
		planBrowserlessGate(gate('email,sc,yt,sp,ig', 'dw,email,sc|yt|sp,ig')),
	).toEqual({
		chosen: ['email', 'sc', 'ig'],
		skipGateSteps: ['sc', 'yt', 'sp', 'ig'],
	});
	expect(planBrowserlessGate(gate('yt,sp,sc,ap', 'dw,yt|sp|sc|ap'))).toEqual({
		chosen: ['yt'],
		skipGateSteps: ['yt', 'sp', 'sc', 'ap'],
	});
	// Email is the last resort inside a group.
	expect(planBrowserlessGate(gate('email,sc', 'dw,email|sc'))).toEqual({
		chosen: ['sc'],
		skipGateSteps: ['email', 'sc'],
	});
});

test('groups without a browserless alternative fall back to the browser', () => {
	expect(
		planBrowserlessGate(gate('sp,ap,email,sc,ig', 'dw,sp|ap,email,sc,ig')),
	).toEqual({ unsupported: ['sp|ap'] });
	// X/Twitter as OAuth connect (djmanjit) is verified by Twitter.
	const oauth = `<div id="step_tw"><a id="login_to_tw" data-type="twitterweb"></a></div>`;
	expect(
		planBrowserlessGate(gate('tw,ig,tk,bc', 'dw,tw,ig,tk|bc', oauth)),
	).toEqual({ unsupported: ['tw'] });
	// Per-account X visit buttons are client-side like Instagram.
	const buttons = `<span id ="twitter_status"><a class="undone"></a></span>
<button type="button" data-step="tw" id="skipper_tw_next" class="hide">Next</button>`;
	expect(
		planBrowserlessGate(gate('tw,ig,tk,bc', 'dw,tw,ig,tk|bc', buttons)),
	).toEqual({
		chosen: ['tw', 'ig', 'tk'],
		skipGateSteps: ['tw', 'ig', 'tk', 'bc'],
	});
});

test('the download request sends the plan, and email only when it was chosen', async () => {
	const posts = new Map<string, URLSearchParams>();
	const fetchMock = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://hypeddit.com/gate')
				return new Response(gate('sc,yt,dn', 'dw,sc|yt,dn'));
			if (init?.method === 'POST')
				posts.set(
					new URL(url).pathname,
					new URLSearchParams(String(init.body)),
				);
			if (url.endsWith('/gate/download/ul'))
				return Response.json({ download_status: false });
			return Response.json({});
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
	const downloader = new HypedditHttpDownloader({
		comment: '',
		browserMode: 'headless',
		email: 'fan@example.test',
	});
	try {
		expect(
			await downloader.tryDownload('https://hypeddit.com/gate'),
		).toBeNull();
		expect([...posts.keys()]).toEqual(['/gate/ge', '/gate/download/ul']);
		const body = posts.get('/gate/download/ul');
		expect(body?.get('steps')).toBe('sc,yt,dn');
		expect(body?.getAll('skip_gate_steps[]')).toEqual(['sc', 'yt']);
		expect(body?.get('email')).toBe('');
	} finally {
		await downloader.close();
		fetch.mockRestore();
	}
});
