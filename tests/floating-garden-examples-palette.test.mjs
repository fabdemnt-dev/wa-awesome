import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMatchRules, renderMatchSetup } from '../floating-garden/match-view.js';
import { OBJECTIVE_VERSION } from '../floating-garden/engine.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const css = read('floating-garden/match-style.css');
const marker = '/* Solo-only entrance palette.';
const palette = css.slice(css.indexOf(marker));

test('new solo rules opt into all four illustrated goals, while legacy saved matches keep the old examples', () => {
  for (const html of [renderMatchSetup(), renderMatchRules({id:'flow-chain', version:OBJECTIVE_VERSION}, true)]) {
    for (const id of ['corners','terrain-cluster','flow-chain','diverse-line']) assert.ok(html.includes(`id="rule-example-${id}"`));
    assert.equal((html.match(/class="rule-objective-example-case"/g) || []).length, 13);
    assert.match(html, /選ばれた1題だけ/);
    assert.match(html, /達成した人それぞれに1回だけ4点/);
  }
  const legacy = renderMatchRules(undefined, true);
  assert.equal((legacy.match(/class="rule-example"/g) || []).length, 6);
  assert.doesNotMatch(legacy, /rule-objective-example-case|id="rule-example-terrain-cluster"/);
  assert.match(legacy, /この旧ルールの保存では、四隅のお題/);
});

test('solo palette is opt-in and preserves the original shared stylesheet and every layout declaration', () => {
  assert.match(read('floating-garden/match.html'), /<body class="solo-entrance-palette">/);
  assert.match(read('floating-garden/match.html'), /name="theme-color" content="#10203e"/);
  assert.doesNotMatch(read('floating-garden/play/index.html'), /solo-entrance-palette/);
  assert.doesNotMatch(read('floating-garden/index.html'), /solo-entrance-palette/);
  const old = read('lab/floating-garden/match-style.css');
  assert.equal(css.slice(0, css.indexOf('\n/* Objective teaching cases')), old);
  assert.ok(css.includes(marker));
  const allowed = new Set(['background','background-color','border-color','color','outline-color','box-shadow']);
  const blocks = [...palette.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  assert.ok(blocks.length > 20);
  for (const [,selectors,body] of blocks) {
    for (const selector of selectors.split(',')) assert.match(selector.trim(), /^(?:body)?\.solo-entrance-palette(?:\s|$)/);
    for (const declaration of body.split(';').filter((item) => item.trim())) {
      const name = declaration.split(':')[0].trim();
      assert.ok(name.startsWith('--') || allowed.has(name), `not a palette property: ${name}`);
    }
  }
  assert.doesNotMatch(palette, /\.terrain-(?:cloud|lake|forest|crystal|magic)\b|\.flow-line\b|\.stone-badge\b/);
  assert.match(palette, /button:where\(:not\(\.cell\):not\(\[class\*="terrain-"\]\)\)/);
  assert.match(palette, /\.mini-board\s*\{ box-shadow: none;/);
});

function luminance(hex) {
  const rgb = hex.replace('#','').match(/../g).map((part) => parseInt(part,16)/255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126*rgb[0] + .7152*rgb[1] + .0722*rgb[2];
}
function contrast(a,b) { const values=[luminance(a),luminance(b)].sort((x,y)=>y-x); return (values[0]+.05)/(values[1]+.05); }

test('palette adopts actual entrance colors and sampled text/control pairs remain legible', () => {
  const entrance = read('floating-garden/entrance.css');
  for (const color of ['#10203e','#172e4d','#f4eee1','#bac9df','#d9c695','#243e65','#0b1931','#2e4865']) {
    assert.ok(entrance.includes(color), color); assert.ok(palette.includes(color), color);
  }
  for (const [foreground,background] of [
    ['#f4eee1','#172e4d'], ['#bac9df','#243e65'], ['#d9c695','#172e4d'],
    ['#f4eee1','#2e4865'], ['#f4eee1','#395672'], ['#cad8e9','#203b5b'],
    ['#cad8e9','#2e4865'], ['#accbea','#263f60'], ['#bac9df','#132742'],
  ]) assert.ok(contrast(foreground,background) >= 4.5, `${foreground}/${background}: ${contrast(foreground,background)}`);
  for (const [foreground,background] of [['#d7c18d','#2e4865'],['#92a7c6','#182c48'],['#7895b5','#132742']])
    assert.ok(contrast(foreground,background) >= 3, `${foreground}/${background}`);
});

test('HTML and the changed UI import chain use the refreshed cache tags without altering game dependencies', () => {
  const html = read('floating-garden/match.html');
  assert.match(html, /match-app\.js\?v=20261023-rule-examples-1/);
  assert.match(html, /match-style\.css\?v=20261023-rule-examples-1/);
  assert.match(read('floating-garden/match-app.js'), /match-view\.js\?v=20261023-rule-examples-1/);
  assert.match(read('floating-garden/match-view.js'), /match-rule-examples\.js\?v=20261023-rule-examples-1/);
  assert.match(read('floating-garden/match-app.js'), /match-engine\.js\?v=20261023-solo-objectives-1/);
});
