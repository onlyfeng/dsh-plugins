/**
 * Synthetic tests for the browser half of @onlyfeng/dsh-forge-gitlab-project.
 *
 * Nothing here reaches GitLab, a Host, a browser, or a real DSH runtime: the module is loaded
 * through a stubbed module loader with a stubbed React, and the Host command Remote is a function
 * that answers with recorded envelopes. Run with `node --test tests/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** Load client.js once and return the plugin the factory builds. */
async function loadPlugin() {
  let row;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useReducer: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  globalThis.window = { __ModuleLoader__: { load: (value) => { row = value; } } };
  const path = join(import.meta.dirname, '..', 'client.js');
  await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  assert.equal(row.id, '@onlyfeng/dsh-forge-gitlab-project', 'module id must equal the package name');
  const plugin = row.factory((name) => {
    assert.equal(name, 'react', 'the module must request only react');
    return React;
  });
  return plugin;
}

const plugin = await loadPlugin();
const {
  clampPage, initialState, rowOf, parseListing, reduce, canTrack, trackControl, errorText,
  createTransport, zh, en, KIND, ID, FIRST_PAGE, LAST_PAGE,
} = plugin.__internals;

/** Translator standing in for the locale service: renders the key and its parameters. */
const t = (key, params) => (params === undefined
  ? key
  : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`);

/** One listing payload as the Host serves it. */
function payload(overrides = {}) {
  return JSON.stringify({
    projectPath: 'group/sub/project',
    page: 1,
    perPage: 25,
    hasMore: false,
    scope: 'a'.repeat(32),
    items: [{
      iid: 7, title: 'Add a thing', author: 'tak', sourceBranch: 'feature/thing',
      targetBranch: 'main', webUrl: 'https://gitlab.com/group/sub/project/-/merge_requests/7',
      updatedAt: '2026-11-19T00:00:00Z', draft: false, tracked: false,
    }],
    ...overrides,
  });
}

/** A Remote stub whose `execute` answers from a script and records every line it received. */
function remote(answer) {
  const lines = [];
  return {
    lines,
    ctx: {
      remote: {
        commands: {
          execute: async (sessionId, line, attachments, signal) => {
            lines.push({ sessionId, line, attachments, signal });
            return typeof answer === 'function' ? answer(line) : answer;
          },
        },
      },
    },
  };
}

/** Wrap a command result the way the Client Remote does. */
const ok = (result) => ({ ok: true, value: { commandId: 'c1', result } });
const success = (text) => ok({ kind: 'success', text });

test('clampPage keeps every request inside the pages the Host serves', () => {
  assert.equal(clampPage(1), 1);
  assert.equal(clampPage(20), 20);
  assert.equal(clampPage(0), FIRST_PAGE);
  assert.equal(clampPage(-5), FIRST_PAGE);
  assert.equal(clampPage(21), LAST_PAGE);
  assert.equal(clampPage(2.7), 2);
  assert.equal(clampPage('3'), 3);
  assert.equal(clampPage(undefined), FIRST_PAGE);
  assert.equal(clampPage(Number.NaN), FIRST_PAGE);
  assert.equal(clampPage('nonsense'), FIRST_PAGE);
});

test('rowOf keeps a usable row and refuses one without an identity', () => {
  assert.equal(rowOf({ iid: 0 }), undefined);
  assert.equal(rowOf({ iid: -1 }), undefined);
  assert.equal(rowOf({}), undefined);
  assert.equal(rowOf(null), undefined);
  assert.equal(rowOf('x'), undefined);
  const row = rowOf({ iid: 4, title: '', draft: true, tracked: true });
  assert.equal(row.iid, 4);
  assert.equal(row.title, '!4', 'an empty title falls back to the number');
  assert.equal(row.draft, true);
  assert.equal(row.tracked, true);
  assert.equal(row.author, null);
  assert.equal(row.webUrl, null);
});

test('parseListing reads a full payload', () => {
  const parsed = parseListing(payload());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.project, 'group/sub/project');
  assert.equal(parsed.value.scope, 'a'.repeat(32));
  assert.equal(parsed.value.items.length, 1);
  assert.equal(parsed.value.items[0].title, 'Add a thing');
});

test('parseListing treats an empty success body as an empty project', () => {
  for (const text of ['', '   ', undefined, null]) {
    const parsed = parseListing(text);
    assert.equal(parsed.ok, true, `expected ${JSON.stringify(text)} to read as empty`);
    assert.deepEqual(parsed.value.items, []);
    assert.equal(parsed.value.scope, null);
  }
});

test('parseListing refuses a body it cannot read', () => {
  assert.equal(parseListing('{ not json').ok, false);
  assert.equal(parseListing('"a string"').ok, false);
  assert.equal(parseListing('[1,2]').ok, false);
  assert.equal(parseListing('{"items":"nope"}').ok, false);
  assert.equal(parseListing('null').ok, false);
});

test('parseListing drops a scope that is not a 32-digit token', () => {
  for (const scope of ['short', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 42, null]) {
    const parsed = parseListing(payload({ scope }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.scope, null, `expected ${String(scope)} to be refused as a scope`);
  }
});

test('parseListing keeps the readable rows of a partly broken page', () => {
  const parsed = parseListing(payload({ items: [{ iid: 1, title: 'ok' }, { title: 'no iid' }, null, { iid: 2 }] }));
  assert.deepEqual(parsed.value.items.map((item) => item.iid), [1, 2]);
});

test('parseListing clamps a page the Host reported out of range', () => {
  assert.equal(parseListing(payload({ page: 99 })).value.page, LAST_PAGE);
  assert.equal(parseListing(payload({ page: 0 })).value.page, FIRST_PAGE);
});

test('a new read supersedes the answers still in flight', () => {
  const start = { ...initialState(1), status: 'ready', scope: 'a'.repeat(32), items: [{ iid: 1 }] };
  const loading = reduce(start, { type: 'load', page: 2 });
  assert.equal(loading.status, 'loading');
  assert.equal(loading.page, 2);
  assert.equal(loading.scope, null, 'the previous scope must not survive a new read');
  assert.equal(loading.epoch, start.epoch + 1);

  // The answer to the superseded read must change nothing.
  const late = reduce(loading, { type: 'listed', epoch: start.epoch, listing: parseListing(payload()).value });
  assert.equal(late, loading, 'a stale answer must be ignored by reference');

  const fresh = reduce(loading, { type: 'listed', epoch: loading.epoch, listing: parseListing(payload()).value });
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.items.length, 1);
});

test('a stale failure and a stale track answer are both ignored', () => {
  const state = { ...initialState(1), epoch: 5 };
  assert.equal(reduce(state, { type: 'failed', epoch: 4, kind: 'refused', text: 'x' }), state);
  assert.equal(reduce(state, { type: 'track', epoch: 4, iid: 1 }), state);
  assert.equal(reduce(state, { type: 'tracked', epoch: 4, iid: 1 }), state);
  assert.equal(reduce(state, { type: 'trackFailed', epoch: 4, iid: 1, text: 'x' }), state);
});

test('a failure clears the rows and the scope so nothing stale stays trackable', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload()).value });
  const failed = reduce(ready, { type: 'failed', epoch: 1, kind: 'refused', text: '404 Project Not Found' });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.items, []);
  assert.equal(failed.scope, null);
  assert.deepEqual(failed.error, { kind: 'refused', text: '404 Project Not Found' });
});

test('switching Session discards the previous Session rows, scope, and page', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload({ page: 3, hasMore: true })).value });
  assert.equal(ready.items.length, 1);
  const switched = reduce(ready, { type: 'session' });
  assert.equal(switched.status, 'loading');
  assert.deepEqual(switched.items, [], 'another Session must not see these rows');
  assert.equal(switched.scope, null, 'another Session must not reuse this scope');
  assert.equal(switched.page, FIRST_PAGE);
  assert.equal(switched.project, null);
  assert.deepEqual(switched.tracking, {});
  assert.ok(switched.epoch > ready.epoch, 'the in-flight read must be superseded');
});

test('an unknown event leaves the state untouched', () => {
  const state = initialState(1);
  assert.equal(reduce(state, { type: 'nothing-like-this' }), state);
});

test('tracking a row moves it from pending to tracked', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload()).value });
  const pending = reduce(ready, { type: 'track', epoch: 1, iid: 7 });
  assert.equal(pending.tracking[7].status, 'pending');
  const done = reduce(pending, { type: 'tracked', epoch: 1, iid: 7 });
  assert.equal(done.tracking[7].status, 'done');
  assert.equal(done.items[0].tracked, true, 'the row itself must read as tracked');
});

test('a row cannot be tracked twice, and an in-flight row cannot be pressed again', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload()).value });
  const item = ready.items[0];
  assert.equal(canTrack(ready, item), true);

  const pending = reduce(ready, { type: 'track', epoch: 1, iid: 7 });
  assert.equal(canTrack(pending, item), false, 'an in-flight track must not be repeatable');
  assert.equal(trackControl(pending, item, t).disabled, true);
  assert.equal(trackControl(pending, item, t).label, 'action.tracking');

  const done = reduce(pending, { type: 'tracked', epoch: 1, iid: 7 });
  assert.equal(canTrack(done, done.items[0]), false, 'a tracked row must not be trackable again');
  assert.equal(trackControl(done, done.items[0], t).label, 'action.tracked');
  assert.equal(trackControl(done, done.items[0], t).disabled, true);
});

test('a row the Host already reported as tracked is not offered again', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload({
      items: [{ iid: 9, title: 'Known', tracked: true }],
    })).value });
  const control = trackControl(ready, ready.items[0], t);
  assert.equal(control.label, 'action.tracked');
  assert.equal(control.disabled, true);
  assert.equal(canTrack(ready, ready.items[0]), false);
});

test('a failed track reports its reason and stays retryable', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload()).value });
  const failed = reduce(reduce(ready, { type: 'track', epoch: 1, iid: 7 }),
    { type: 'trackFailed', epoch: 1, iid: 7, text: 'insufficient permission' });
  const control = trackControl(failed, failed.items[0], t);
  assert.equal(control.label, 'action.track');
  assert.equal(control.disabled, false, 'a failed track must be retryable');
  assert.match(control.failure, /insufficient permission/);
  assert.equal(failed.items[0].tracked, undefined === failed.items[0].tracked ? undefined : false);
});

test('a failed track without a reason still reports something readable', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload()).value });
  const failed = reduce(ready, { type: 'trackFailed', epoch: 1, iid: 7, text: null });
  assert.match(trackControl(failed, failed.items[0], t).failure, /error\.unexpected/);
});

test('nothing is trackable while the listing carried no scope', () => {
  const ready = reduce({ ...initialState(1), epoch: 1 },
    { type: 'listed', epoch: 1, listing: parseListing(payload({ scope: 'bad' })).value });
  assert.equal(ready.scope, null);
  assert.equal(canTrack(ready, ready.items[0]), false, 'without a scope the Host call cannot be addressed');
  assert.equal(trackControl(ready, ready.items[0], t).disabled, true);
});

test('nothing is trackable while the panel is loading or failed', () => {
  const item = { iid: 7, tracked: false };
  assert.equal(canTrack({ ...initialState(1), status: 'loading', scope: 'a'.repeat(32), tracking: {} }, item), false);
  assert.equal(canTrack({ ...initialState(1), status: 'failed', scope: 'a'.repeat(32), tracking: {} }, item), false);
});

test('errorText shows a Host refusal verbatim and localizes the rest', () => {
  assert.equal(errorText({ kind: 'refused', text: '403 Forbidden' }, t), '403 Forbidden');
  assert.equal(errorText({ kind: 'refused', text: '' }, t), 'error.unexpected');
  assert.equal(errorText({ kind: 'refused', text: null }, t), 'error.unexpected');
  assert.equal(errorText({ kind: 'unavailable', text: null }, t), 'error.unavailable');
  assert.equal(errorText({ kind: 'unexpected', text: null }, t), 'error.unexpected');
});

test('the list command sends the documented line with a clamped page', async () => {
  const { ctx, lines } = remote(success(payload()));
  const transport = createTransport(ctx);
  const answer = await transport.listMergeRequests('session-1', 99, undefined);
  assert.equal(answer.kind, 'listed');
  assert.equal(answer.listing.items[0].iid, 7);
  assert.equal(lines[0].line, `/gitlab-project list ${LAST_PAGE}`);
  assert.equal(lines[0].sessionId, 'session-1', 'the first argument is the SessionId');
  assert.deepEqual(lines[0].attachments, [], 'a plain invocation carries no attachments');
});

test('the track command names the scope of the current listing and the merge request', async () => {
  const scope = 'b'.repeat(32);
  const { ctx, lines } = remote(success(JSON.stringify({ bound: true, alreadyBound: false, webUrl: 'https://x' })));
  const answer = await createTransport(ctx).trackMergeRequest('session-1', scope, 7);
  assert.equal(answer.kind, 'tracked');
  assert.equal(lines[0].line, `/gitlab-project track ${scope} 7`);
});

test('an already bound merge request reads as tracked, not as a failure', async () => {
  const { ctx } = remote(success(JSON.stringify({ bound: true, alreadyBound: true, webUrl: 'https://x' })));
  assert.equal((await createTransport(ctx).trackMergeRequest('s', 'c'.repeat(32), 7)).kind, 'tracked');
});

test('an unresolved command name reads as unavailable', async () => {
  const { ctx } = remote({ ok: true, value: undefined });
  assert.equal((await createTransport(ctx).listMergeRequests('s', 1)).kind, 'unavailable');
  assert.equal((await createTransport(ctx).trackMergeRequest('s', 'd'.repeat(32), 1)).kind, 'unavailable');
});

test("a refused Remote call reports the Remote's own message", async () => {
  const { ctx } = remote({ ok: false, error: { code: 'DENIED', message: 'not allowed to run commands' } });
  const answer = await createTransport(ctx).listMergeRequests('s', 1);
  assert.equal(answer.kind, 'refused');
  assert.equal(answer.text, 'not allowed to run commands');
});

test('a command error reports its text for the panel to show verbatim', async () => {
  const { ctx } = remote(ok({ kind: 'error', text: 'glab is not signed in to gitlab.com' }));
  const answer = await createTransport(ctx).listMergeRequests('s', 1);
  assert.equal(answer.kind, 'refused');
  assert.equal(answer.text, 'glab is not signed in to gitlab.com');
});

test('a thrown transport failure becomes a refusal instead of escaping the panel', async () => {
  const ctx = { remote: { commands: { execute: async () => { throw new Error('connection lost'); } } } };
  const answer = await createTransport(ctx).listMergeRequests('s', 1);
  assert.equal(answer.kind, 'refused');
  assert.equal(answer.text, 'connection lost');
});

test('an unreadable success body becomes an unexpected-result failure', async () => {
  const { ctx } = remote(success('{ broken'));
  assert.equal((await createTransport(ctx).listMergeRequests('s', 1)).kind, 'unexpected');
});

test('an answer that is not a result envelope becomes an unexpected-result failure', async () => {
  for (const answer of [undefined, null, 'text', ok(null), ok('text'), ok({ kind: 'other' })]) {
    const { ctx } = remote(answer);
    const outcome = await createTransport(ctx).listMergeRequests('s', 1);
    assert.equal(outcome.kind, 'unexpected', `expected ${JSON.stringify(answer)} to be unexpected`);
  }
});

test('the cancellation signal is forwarded to the Host call', async () => {
  const controller = new AbortController();
  const { ctx, lines } = remote(success(payload()));
  await createTransport(ctx).listMergeRequests('s', 1, controller.signal);
  assert.equal(lines[0].signal, controller.signal);
});

test('apply registers the locale, the tab type with its guide entry, and the tab body', () => {
  const registered = { locales: [], types: [], slots: [], injected: [], effects: [] };
  const ctx = {
    locale: {
      bind: (ns) => { registered.boundNamespace = ns; return t; },
      register: (ns, dictionaries) => { registered.locales.push({ ns, dictionaries }); return () => {}; },
    },
    sidebarRightTabs: { register: (definition) => { registered.types.push(definition); return () => {}; } },
    slots: {
      inject: (name, install) => { registered.injected.push(name); install(); return () => {}; },
      register: (declaration, Component) => { registered.slots.push({ declaration, Component }); return () => {}; },
    },
    remote: { commands: { execute: async () => undefined } },
    effect: (install, label) => { registered.effects.push(label); return install(); },
  };

  plugin.apply(ctx);

  assert.deepEqual(registered.locales.map((entry) => entry.ns), ['forgeGitlabProject']);
  assert.deepEqual(Object.keys(registered.locales[0].dictionaries).sort(), ['en', 'zh']);

  assert.equal(registered.types.length, 1);
  const definition = registered.types[0];
  assert.equal(definition.id, ID);
  assert.equal(definition.kind, KIND);
  assert.equal(definition.priority, 'extension', 'a third-party type uses the extension band');
  assert.equal(definition.title(), 'type.label');
  assert.equal(definition.guide.length, 1, 'one guide entry gives the feature its own way in');
  assert.equal(definition.guide[0].title(), 'guide.title');
  assert.equal(definition.guide[0].description(), 'guide.description');
  assert.ok(typeof definition.guide[0].id === 'string' && definition.guide[0].id.length > 0);

  assert.deepEqual(registered.injected, ['sidebar.right.pane.tab'], 'the body waits for the seat declaration');
  assert.equal(registered.slots.length, 1);
  assert.equal(registered.slots[0].declaration.name, 'sidebar.right.pane.tab');
  assert.equal(registered.slots[0].declaration.key, ID, 'the body registers under the type id');
  assert.equal(typeof registered.slots[0].Component, 'function');

  // Every registration is an owned effect, so unloading the plugin removes all of it.
  assert.equal(registered.effects.length, 3);
  for (const label of registered.effects) assert.match(label, /^forge-gitlab-project\./);
});

test('the injected transport exposes exactly the two Host calls the body uses', () => {
  let injected;
  const ctx = {
    locale: { bind: () => t, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (_name, install) => { install(); return () => {}; },
      register: (declaration) => { injected = declaration.inject(); return () => {}; },
    },
    remote: { commands: { execute: async () => undefined } },
    effect: (install) => install(),
  };
  plugin.apply(ctx);
  assert.deepEqual(Object.keys(injected).sort(), ['listMergeRequests', 'trackMergeRequest']);
  for (const value of Object.values(injected)) assert.equal(typeof value, 'function');
});

test('the plugin injects the services it uses and nothing more', () => {
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.commands']);
});

test('both shipped locales cover exactly the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.length > 0, `zh.${key} must not be empty`);
    assert.ok(en[key].length > 0, `en.${key} must not be empty`);
  }
});

test('every placeholder a locale uses appears in both languages', () => {
  const placeholders = (text) => (text.match(/\{[a-z]+\}/gi) ?? []).sort();
  for (const key of Object.keys(zh)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('every key the module draws exists in both dictionaries', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const used = new Set();
  for (const match of source.matchAll(/\bt\('([a-zA-Z.]+)'/g)) used.add(match[1]);
  assert.ok(used.size >= 10, 'expected the panel to draw a number of localized strings');
  for (const key of used) {
    assert.ok(key in zh, `zh is missing ${key}`);
    assert.ok(key in en, `en is missing ${key}`);
  }
});

test('the module imports no Harness Client package and writes no global UI', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  for (const forbidden of ['@deepseek-ai/dsh-client-ui-primitives', 'document.body', 'innerHTML']) {
    assert.ok(!source.includes(forbidden), `the module must not use ${forbidden}`);
  }
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requires)], ['react'], 'react is the only module request');
});

test('styles reference only theme tokens, never literal colours', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const styles = source.slice(source.indexOf('const css = `'), source.indexOf('`;', source.indexOf('const css = `')));
  assert.ok(styles.includes('--dsw-alias-'), 'the panel inherits the host theme');
  assert.equal(styles.match(/#[0-9a-f]{3,8}\b/gi), null, 'no literal hex colour belongs in panel styles');
  assert.equal(styles.match(/\brgba?\(/gi), null, 'no literal rgb colour belongs in panel styles');
});
