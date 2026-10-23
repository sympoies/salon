import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {formatActivityHeaderText} from '../src/sessionActivity.ts';
import {makeSession} from './support/fixtures.ts';


test('every card status header contains only compact elapsed time', () => {
  const now=Date.parse('2026-10-07T02:18:00Z');
  assert.equal(formatActivityHeaderText({kind:'waiting',primaryText:'Waiting 2h 18m',timerStartedAt:'2026-10-07T00:00:00Z',ripple:false},now),'2h18m');
  assert.equal(formatActivityHeaderText({kind:'unknown',primaryText:'State unknown',ripple:false},now),'');
});

test('card states distinguish work, human input, unread completion, failure and stale evidence', async () => {
  const {cardActivityPresentation, formatCardElapsedDuration} = await import('../src/sessionActivity.ts');
  const at = '2026-10-07T00:00:00Z';
  const session = makeSession({updated_at: at,activity_observed_at:at});
  const activity = (kind: import('../src/sessionActivity.ts').SessionActivityKind) => ({kind, primaryText: kind, timerStartedAt: at, ripple: false});
  assert.equal(cardActivityPresentation(activity('working'), session, true).state, 'working');
  assert.equal(cardActivityPresentation(activity('needs-input'), session, true).state, 'blocked', 'a pending request needs the human (#873)');
  assert.equal(cardActivityPresentation(activity('completed'), session, true).state, 'completed');
  assert.equal(cardActivityPresentation({...activity('needs-input'), attentionKind: 'approval'}, session, true).state, 'blocked');
  assert.equal(cardActivityPresentation({...activity('needs-input'), attentionKind: 'authentication'}, session, true).state, 'blocked');
  const unknown = cardActivityPresentation(activity('working'), session, false);
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.description, /spoke disconnected/);
  assert.equal(unknown.timerStartedAt, at);
  assert.match(cardActivityPresentation({...activity('working'), observationStale: true}, session, true).description, /expired/);
  assert.equal(cardActivityPresentation(activity('unknown'), makeSession({startup: {schema_version:'agent-session.startup.v1', state:'failed', stage:'runtime', started_at:at, occurred_at:at, failure_code:'provider-client-exited', message:'Provider failed', retry_safe:true}}), true).state, 'blocked');
  assert.equal(formatCardElapsedDuration(12 * 60_000), '12m');
  assert.equal(formatCardElapsedDuration(27 * 3600_000), '1d3h');
});



test('unsent prompts remain blocked until confirmed delivery and never leak into a new incarnation', async () => {
  const {notePromptDelivery, promptDeliveryFailure} = await import('../src/promptDelivery.ts');
  const {cardActivityPresentation} = await import('../src/sessionActivity.ts');
  const session = makeSession({id:'delivery-fixture'});
  const activity = {kind:'waiting' as const,primaryText:'Waiting',ripple:false};
  notePromptDelivery(session.machine,session.id,session.session_incarnation,{ok:false});
  assert.equal(cardActivityPresentation(activity,session,true,promptDeliveryFailure(session)).state,'blocked');
  assert.equal(promptDeliveryFailure({...session,session_incarnation:'new-incarnation'}),undefined);
  notePromptDelivery(session.machine,session.id,session.session_incarnation,{ok:false,outcomeUnknown:true});
  assert.match(cardActivityPresentation(activity,session,true,promptDeliveryFailure(session)).description,/not confirmed/);
  notePromptDelivery(session.machine,session.id,session.session_incarnation,{ok:true});
  assert.equal(promptDeliveryFailure(session),undefined);
});


test('known state timers use semantic duration and only unknown uses successful observation age', async () => {
  const {cardActivityPresentation} = await import('../src/sessionActivity.ts');
  const {withDashboardActivityObservation} = await import('../src/dashboardSessions.ts');
  const observed = '2026-10-07T02:06:00Z';
  const semantic = '2026-10-07T00:00:00Z';
  const now = Date.parse('2026-10-07T02:18:00Z');
  const session = withDashboardActivityObservation(makeSession(), {daemonObservedAt:observed,receivedMonotonicMs:0,transport:'poll'});
  for (const kind of ['working','waiting','needs-input','completed'] as const) {
    const activity = {kind,primaryText:kind,timerStartedAt:semantic,ripple:false};
    const presentation = cardActivityPresentation(activity,session,true);
    assert.equal(formatActivityHeaderText({...activity,timerStartedAt:presentation.timerStartedAt},now),'2h18m',kind);
  }
  const approval = {kind:'needs-input' as const,primaryText:'Approval',attentionKind:'approval' as const,timerStartedAt:semantic,ripple:false};
  assert.equal(cardActivityPresentation(approval,session,true).timerStartedAt,semantic);
  const unknown = cardActivityPresentation(approval,session,false);
  assert.equal(unknown.timerStartedAt,observed);
  assert.equal(formatActivityHeaderText({...approval,timerStartedAt:unknown.timerStartedAt},now),'12m');
  assert.equal(cardActivityPresentation(approval,session,true,{at:semantic,unknown:false}).timerStartedAt,semantic);
  assert.equal(cardActivityPresentation(approval,session,true,{at:semantic,unknown:true}).timerStartedAt,observed);
});

test('healthy stopped or resumable sessions never claim provider or permission failure', async () => {
  const {cardActivityPresentation} = await import('../src/sessionActivity.ts');
  for (const kind of ['stopped','resumable'] as const) {
    const presentation = cardActivityPresentation({kind,primaryText:kind,ripple:false},makeSession({status:'stopped'}),true);
    assert.equal(presentation.state,'stopped');
    assert.equal(presentation.group,'stopped');
    assert.match(presentation.description,/stopped/);
  }
});

test('card status groups use the same classifier as header counts', async () => {
  const {cardActivityPresentation} = await import('../src/sessionActivity.ts');
  const sessionWithPhase = (phase: string) => makeSession({status:'running',turn_state:{schema_version:'agent-session.turn-state.v1',phase:phase as never,phase_changed_at:'2026-10-07T00:00:00Z',revision:1,source:{kind:'runtime',confidence:'authoritative'},...(['idle','waiting'].includes(phase) ? {last_turn:{completed_at:'2026-10-07T00:00:00Z',outcome:'completed' as const}} : {}),...(phase === 'working' ? {current_turn:{started_at:'2026-10-07T00:00:00Z'}} : {}),...(phase === 'needs_input' ? {current_turn:{started_at:'2026-10-07T00:00:00Z',attention:{kind:'clarification' as const,requested_at:'2026-10-07T00:00:00Z',pending_count:1,certainty:'exact' as const}}} : {})}});
  assert.equal(cardActivityPresentation({kind:'working',primaryText:'Working',ripple:false},sessionWithPhase('working'),true).group,'working');
  for (const phase of ['idle','waiting']) {
    assert.equal(cardActivityPresentation({kind:'waiting',primaryText:'Waiting',ripple:false},sessionWithPhase(phase),true).group,'waiting');
  }
  assert.equal(cardActivityPresentation({kind:'needs-input',primaryText:'Needs input',ripple:false},sessionWithPhase('needs_input'),true).group,'attention');
  const starting = cardActivityPresentation(
    {kind:'unknown',primaryText:'State unknown',ripple:false},
    makeSession({status:'running',turn_state:{schema_version:'agent-session.turn-state.v1',phase:'starting',phase_changed_at:'2026-10-07T00:00:00Z',revision:1,source:{kind:'runtime',confidence:'authoritative'}}}),
    true,
  );
  assert.equal(starting.group,'attention');
  assert.equal(cardActivityPresentation({kind:'unknown',primaryText:'Unknown',ripple:false},sessionWithPhase('future-phase'),true).group,'unknown');
});

test('failed waiting turns use Attention for the card status group', async () => {
  const {cardActivityPresentation} = await import('../src/sessionActivity.ts');
  const at = '2026-10-07T00:00:00Z';
  const session = makeSession({status:'running',turn_state:{
    schema_version:'agent-session.turn-state.v1',phase:'waiting',phase_changed_at:at,revision:2,
    source:{kind:'runtime',confidence:'authoritative'},
    last_turn:{completed_at:at,outcome:'failed'},
  }});
  const presentation = cardActivityPresentation({kind:'waiting',primaryText:'Waiting',ripple:false},session,true);
  assert.equal(presentation.state,'blocked');
  assert.equal(presentation.group,'attention');
});

// #873: one status rule for every view and harness. A pending request needs the
// human; an unobservable state is "State unknown", explained, and never counted
// as Attention; failed turns stay Attention.
test('header count, filter and card agree for every harness and turn state (#873)', async () => {
  const {cardActivityPresentation, selectSessionActivity} = await import('../src/sessionActivity.ts');
  const {countSessionStatuses, sessionStatusEvidence} = await import('../src/sessionStatusGroups.ts');
  const {filterRecords, CLEAR_SESSION_FILTERS} = await import('../src/sessionFilters.ts');
  const at = '2026-10-22T08:00:00Z', progress = '2026-10-22T08:05:00Z', read = '2026-10-22T08:20:00Z';
  const nowMs = Date.parse('2026-10-22T08:21:00Z');
  const base = {schema_version:'agent-session.turn-state.v1' as const, phase_changed_at:at, revision:3};
  const fixtures = {
    pending: {expected:'attention', state:'blocked', turn:(certainty: 'exact' | 'conservative') => ({...base, phase:'needs_input' as const,
      source:{kind:'provider_hook' as const, confidence:'authoritative' as const},
      current_turn:{started_at:at, attention:{kind:'clarification' as const, requested_at:at, pending_count:1, certainty}}})},
    warned: {expected:'waiting', state:'completed', turn:() => ({...base, phase:'waiting' as const,
      source:{kind:'provider_hook' as const, confidence:'authoritative' as const},
      diagnostic:{reason:'attention_authority_mismatch' as const}, last_turn:{completed_at:at, outcome:'completed' as const}})},
    unknown: {expected:'unknown', state:'unknown', turn:() => ({...base, phase:'unknown' as const,
      source:{kind:'provider_hook' as const, confidence:'inferred' as const},
      diagnostic:{reason:'completion_evidence_pending' as const}, current_turn:{started_at:at, last_progress_at:progress}})},
    failed: {expected:'attention', state:'blocked', turn:() => ({...base, phase:'waiting' as const,
      source:{kind:'provider_hook' as const, confidence:'authoritative' as const},
      last_turn:{completed_at:at, outcome:'failed' as const}})},
  } as const;
  for (const agent of ['codex', 'claude', 'dsh']) {
    for (const [name, fixture] of Object.entries(fixtures)) {
      for (const certainty of name === 'pending' ? ['exact', 'conservative'] as const : ['exact'] as const) {
        const label = `${agent} ${name}${name === 'pending' ? ` (${certainty})` : ''}`;
        const session = makeSession({agent, status:'running', activity_observed_at:read, turn_state:fixture.turn(certainty) as never});
        const counts = countSessionStatuses([session], sessionStatusEvidence);
        assert.equal((counts as Record<string, number>)[fixture.expected], 1, `${label}: header count`);
        const record = {...session, session_id:session.id, provider:session.agent};
        assert.equal(filterRecords([record], {...CLEAR_SESSION_FILTERS, statusGroup:fixture.expected as never}).length, 1, `${label}: filter`);
        const activity = selectSessionActivity({session, machineReachable:true, focused:false, nowMs});
        const card = cardActivityPresentation(activity, session, true);
        assert.equal(card.group, fixture.expected, `${label}: card group`);
        assert.equal(card.state, fixture.state, `${label}: card state`);
        if (name === 'pending') {
          assert.match(card.description, /clarification/, `${label}: names the request kind`);
          assert.equal(card.timerStartedAt, at, `${label}: timed from the request`);
        }
        if (name === 'unknown') {
          assert.match(card.description, /completion evidence pending/, `${label}: explains why`);
          const quiet = {...session, turn_state:{...fixture.turn(certainty), diagnostic:{reason:'codex_progress_quiet'}} as never};
          assert.match(cardActivityPresentation(selectSessionActivity({session:quiet, machineReachable:true, focused:false, nowMs}), quiet, true).description,
            /codex progress quiet/, `${label}: names the board's quiet reason`);
          assert.equal(card.timerStartedAt, progress, `${label}: timed from the last evidence, not the daemon read`);
        }
      }
    }
  }
});
