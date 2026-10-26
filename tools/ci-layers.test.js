/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importClosure, layersFor } from './ci-layers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** @param {string} path */
const read = path=>(existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : null);
const only = (/** @type {string[]} */ ...names)=>Object.fromEntries(
    ['cork', 'core', 'installer', 'networking'].map(name=>[name, names.includes(name)]));

test('a package alone is checked alone', ()=>{
    assert.deepEqual(layersFor(['modules/networking/src/server/cli.js'], read), only('networking'));
    assert.deepEqual(layersFor(['modules/installer/src/pack.js'], read), only('installer'));
});

test('core\'s engine is not the installer\'s; what the installer takes of core is', ()=>{
    assert.deepEqual(layersFor(['modules/core/src/app.js', 'modules/core/src/app.test.js'], read),
        only('core'));
    assert.deepEqual(layersFor(['modules/core/src/bundle.js'], read), only('core', 'installer'));
    assert.deepEqual(layersFor(['modules/core/src/layers/media/internal/jpeg.js'], read),
        only('core', 'installer'));
});

test('cork is core\'s, and a version that moved is its package\'s', ()=>{
    assert.deepEqual(layersFor(['modules/cork/src/emit/region.js'], read), only('cork', 'core'));
    assert.deepEqual(layersFor(['modules/networking/package.json'], read), only('networking'));
});

test('what every package shares runs them all, words alone run none', ()=>{
    const all = only('cork', 'core', 'installer', 'networking');
    assert.deepEqual(layersFor(['tools/play.mjs'], read), all);
    assert.deepEqual(layersFor(['package.json'], read), all);
    assert.deepEqual(layersFor(['docs/core/api.md', 'roadmap/x64.md'], read), only());
});

test('the closure follows relative imports and the packages\' exports', ()=>{
    const files = { 'a/x.js': 'import { y } from \'./y.js\';\nexport * from "@bottlify/p/sub";',
        'a/y.js': 'const z = await import(\'../b/z.js\');', 'b/z.js': '',
        'modules/p/package.json': '{"exports":{"./sub":"./src/sub.js"}}', 'modules/p/src/sub.js': '' };
    const fake = (/** @type {string} */ path)=>files[/** @type {keyof typeof files} */ (path)] ?? null;
    assert.deepEqual([...importClosure(['a/x.js'], fake)].sort(),
        ['a/x.js', 'a/y.js', 'b/z.js', 'modules/p/src/sub.js']);
});
