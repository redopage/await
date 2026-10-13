import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/app/theme.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseTheme, resolveTheme, THEME_PALETTES } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('saved preferences preserve valid fields and recover from invalid browser storage', () => {
  assert.deepEqual(parseTheme('{"mode":"dark","accent":"ocean"}'), { mode: 'dark', accent: 'ocean' });
  assert.deepEqual(parseTheme('{"mode":"invalid","accent":"plum"}'), { mode: 'system', accent: 'plum' });
  for (const value of [null, '', 'malformed', 'null', '[]', 'true', '{"mode":1,"accent":{}}']) {
    assert.deepEqual(parseTheme(value), { mode: 'system', accent: 'forest' });
  }
});

test('system mode follows the device while explicit modes override it', () => {
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('the pre-render theme matches runtime preferences, including unavailable storage', () => {
  for (const value of [null, 'malformed', 'null', 'true', '{"mode":"bad","accent":"plum"}', ...['light', 'dark', 'system'].flatMap(mode => THEME_PALETTES.map(({ value: accent }) => JSON.stringify({ mode, accent })))]) {
    for (const systemDark of [true, false]) {
      const dataset = {};
      runInNewContext(bootstrap, { document: { documentElement: { dataset } }, localStorage: { getItem: () => value }, matchMedia: () => ({ matches: systemDark }) });
      const preference = parseTheme(value);
      assert.deepEqual(dataset, { theme: resolveTheme(preference.mode, systemDark), accent: preference.accent });
    }
  }
  const dataset = {};
  runInNewContext(bootstrap, { document: { documentElement: { dataset } }, localStorage: { getItem: () => { throw new Error('Storage denied'); } }, matchMedia: () => ({ matches: true }) });
  assert.deepEqual(dataset, { theme: 'dark', accent: 'forest' });
});

const css = await readFile(new URL('../src/app/theme.css', import.meta.url), 'utf8');
function paletteTokens(mode, accent) {
  const tokens = {};
  for (const [, selector, declarations] of css.matchAll(/(:is\(:root, \.theme-sample\)[^{]*)\{([^}]+)\}/g)) {
    const themeMatch = selector.match(/\[data-theme=(\w+)\]/);
    const accentMatch = selector.match(/\[data-accent=(\w+)\]/);
    if (themeMatch && themeMatch[1] !== mode || accentMatch && accentMatch[1] !== accent) continue;
    for (const [, name, value] of declarations.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[name] = value.trim();
  }
  const resolve = name => tokens[name].startsWith('var(') ? resolve(tokens[name].slice(4, -1)) : tokens[name];
  return resolve;
}
function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const rgb = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
for (const mode of ['light', 'dark']) {
  for (const { value: accent } of THEME_PALETTES) {
    test(`${accent} ${mode} keeps text, actions, and status labels readable`, () => {
      const token = paletteTokens(mode, accent);
      const pairs = ['--text', '--text-muted', '--text-faint'].flatMap(fg => ['--canvas', '--surface', '--surface-subtle', '--surface-raised', '--surface-hover', '--accent-soft'].map(bg => [fg, bg]));
      pairs.push(['--accent', '--surface'], ['--accent', '--accent-soft'], ['--danger', '--danger-soft'], ['--warning', '--warning-soft'], ['--sidebar-text', '--sidebar'], ['--sidebar-muted', '--sidebar'], ['--sidebar-selected-text', '--sidebar-selected']);
      for (const [fg, bg] of pairs) {
        const ratio = contrast(token(fg), token(bg));
        assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1, needs 4.5:1`);
      }
      for (const bg of ['--accent-solid', '--accent-hover']) assert.ok(contrast('#ffffff', token(bg)) >= 4.5, `White action text on ${bg}`);
      for (const bg of ['--surface', '--surface-subtle']) assert.ok(contrast(token('--accent-focus'), token(bg)) >= 3, `Focus outline on ${bg}`);
    });
  }
}
test('dark palettes use near-black neutral surfaces with distinct accents and native dark controls', () => {
  for (const { value } of THEME_PALETTES) {
    const token = paletteTokens('dark', value);
    for (const name of ['--canvas', '--surface', '--surface-subtle', '--surface-raised']) {
      const channels = token(name).slice(1).match(/../g).map(channel => parseInt(channel, 16));
      assert.ok(Math.max(...channels) <= 27, `${value} ${name} should stay close to black`);
      assert.equal(new Set(channels).size, 1, `${value} ${name} should remain neutral`);
    }
  }
  assert.equal(new Set(THEME_PALETTES.map(({ value }) => paletteTokens('dark', value)('--accent'))).size, THEME_PALETTES.length);
  assert.match(css, /color-scheme: dark/);
});
