import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function loadClient(source) {
  let row;
  runInNewContext(source, { window: { __ModuleLoader__: { load: (entry) => { row = entry; } } } });
  return row;
}
const client = loadClient(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
assert.equal(client.id, '@onlyfeng/dsh-forge-gitlab');
const { apply } = client.factory();

const id = 'zh-x-forge';
const label = '在代码托管平台查看';
const keys = ['thread.openOnHost', 'thread.openAll'];

function mount(locale) {
  const disposers = [];
  apply({ locale, effect: (setup) => disposers.push(setup()) });
  return () => { while (disposers.length) disposers.pop()(); };
}

test('skips hosts without the external-language APIs', () => {
  for (const locale of [undefined, {}, { register() {} }, { addLanguage() {} }]) {
    apply({ locale, effect() { assert.fail('registered on an incompatible host'); } });
  }
});

test('registers only the two host-link keys under an optional language and releases both registrations', () => {
  const calls = [];
  const released = [];
  const dispose = mount({
    register(...args) { calls.push(args); return () => released.push('dictionary'); },
    addLanguage(...args) { calls.push(args); return () => released.push('language'); },
  });
  assert.deepEqual(structuredClone(calls), [
    ['forgePanel', id, { 'thread.openOnHost': label, 'thread.openAll': label }],
    [{ id, label: '中文（代码托管平台）', fallback: 'zh' }],
  ]);
  dispose();
  assert.deepEqual(released, ['language', 'dictionary']);
});

// Run this test file directly with Desktop's Electron in Node mode to exercise the shipped registry.
const installed = process.versions.electron && process.env.DSH_INSTALL_DIR;
test('rc.5 LocaleRuntime switches on selection, falls back per key, and unloads cleanly', {
  skip: !installed && 'requires DSH desktop Electron in Node mode',
}, (t) => {
  const resolve = createRequire(join(installed, 'package.json')).resolve;
  const name = '@deepseek-ai/dsh-client-locale';
  const manifest = JSON.parse(readFileSync(resolve(`${name}/package.json`), 'utf8'));
  if (manifest.version !== '0.2.2-rc.5') return t.skip('targets the rc.5 dictionary contract');
  let plugin;
  runInNewContext(readFileSync(resolve(`${name}/client`), 'utf8'), {
    window: { __ModuleLoader__: { load: (row) => { plugin = row; } } },
  });
  assert.equal(plugin.id, name);
  // LocaleRuntime is the compiled package export. View modules are not mounted in this service test.
  const { LocaleRuntime } = plugin.factory(() => ({}));
  const locale = new LocaleRuntime({ emit() {} }, undefined, { languages: ['zh-CN'], preference: null });
  locale.register('forgePanel', 'zh', { 'thread.openOnHost': '在 GitHub 中查看', 'thread.openAll': '在 GitHub 中查看', 'thread.resolve': '解决讨论' });
  locale.register('forgePanel', 'en', { 'thread.openOnHost': 'View on GitHub' });
  const translate = locale.bind('forgePanel');
  const dispose = mount(locale);
  assert.equal(locale.getLocale().active, 'zh');
  assert.equal(translate(keys[0]), '在 GitHub 中查看');
  locale.setLocale(id);
  for (const key of keys) assert.equal(translate(key), label);
  assert.equal(translate('thread.resolve'), '解决讨论');
  locale.setLocale('en');
  assert.equal(translate(keys[0]), 'View on GitHub');
  locale.setLocale(id);
  dispose();
  assert.equal(locale.getLocale().active, 'zh');
  assert.equal(locale.getLocale().locales.some((language) => language.id === id), false);
  assert.equal(translate(keys[1]), '在 GitHub 中查看');
  const disposeAgain = mount(locale);
  assert.equal(locale.getLocale().active, id); // The user's explicit preference survives plugin reload.
  assert.equal(translate(keys[1]), label);
  disposeAgain();
});
