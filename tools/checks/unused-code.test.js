/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyse } from './unused-code.mjs';

/** A tree of files, written under a fresh folder. @param {Record<string, string>} files */
function tree(files){
    const root = mkdtempSync(join(tmpdir(), 'unused-code-'));
    for (const [path, text] of Object.entries(files))
    {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}

const FIXTURE = {
    'modules/a/package.json': JSON.stringify({ name: '@x/a', exports: { '.': './src/index.js' } }),
    'modules/a/src/index.js': [
        "import { used } from './used.js';",
        "/** @typedef {import('./shapes.js').Shape} Shape */",
        "/** @param {import('./types.js').Point} p */",
        'export const area = p=>used(p);',
        // A template whose expression comes after the query still names its file.
        `export const page = new URL(\`./page.worker.js?x=\${1}\`, import.meta.url);`,
    ].join('\n'),
    'modules/a/src/used.js': [
        'const helper = x=>x;',
        'export function used(x){ return helper(x) + inner(); }',
        'export function inner(){ return 1; }',
        'export function unusedFn(){ return 2; }',
        'export function testedOnly(){ return 3; }',
    ].join('\n'),
    'modules/a/src/types.js': '/** @typedef {{ x: number }} Point */\nexport {};\n',
    'modules/a/src/shapes.js': '/** @typedef {{ n: number }} Shape */\nexport const SIDES = 4;\n',
    'modules/a/src/page.worker.js': "import './deep.js';\n",
    'modules/a/src/deep.js': 'export {};\n',
    'modules/a/src/dead.js': "import './dead-too.js';\nexport const nothing = 0;\n",
    'modules/a/src/dead-too.js': 'export {};\n',
    'modules/a/src/helper.js': 'export const help = 1;\n',
    'modules/a/src/helper.test.js':
        "import { help } from './helper.js';\nimport { testedOnly } from './used.js';\n",
    'modules/a/src/math.js': 'export const f = 1;\n',
    'modules/a/src/math.x86.js': 'export const COMPILED = {};\n',
    'modules/a/src/math.x64.js': 'export const COMPILED = {};\n',
    'modules/a/src/math.test.js': "import { COMPILED } from './math.x64.js';\n",
    'modules/a/src/load.js':
        "import { COMPILED } from './math.x86.js';\nexport const at = n=>import(n);\n",
    'modules/a/src/index2.js': '',
    'modules/a/test/page/index.html': '<script type="module" src="./boot.js"></script>',
    'modules/a/test/page/boot.js': "import '../../src/deep.js';\n",
};
FIXTURE['modules/a/src/index.js'] += "\nimport { at } from './load.js';\nat;\n";

/** The fixture's report, its tree removed after. */
function report(){
    const root = tree(FIXTURE);
    try
    {
        return analyse(root);
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

const A = 'modules/a/src/';
/** @param {{ file: string }[]} rows */
const files = rows=>rows.map(row=>row.file.replace(A, '')).sort();
/** @param {{ file: string, notes: string[] }[]} rows @param {string} file */
const notes = (rows, file)=>rows.find(row=>row.file === A + file)?.notes;

test('a file nothing reaches, one types alone reach, one only tests reach, each said apart', ()=>{
    const { unreached, typesOnly, testOnly } = report();
    assert.deepEqual(files(unreached), ['dead-too.js', 'dead.js', 'index2.js']);
    assert.deepEqual(files(typesOnly), ['shapes.js', 'types.js'],
        'a JSDoc import keeps a file for the typecheck: not dead');
    assert.deepEqual(notes(typesOnly, 'types.js'), ['declares types alone']);
    assert.deepEqual(notes(typesOnly, 'shapes.js'), ['holds code nothing runs']);
    assert.deepEqual(files(testOnly), ['helper.js', 'math.x64.js']);
    assert.deepEqual(notes(testOnly, 'math.x64.js'), ['a width built, not wired: math.x86.js is']);
});

test('a worker named with a query, a page\'s script and a guest-code source are reached', ()=>{
    const { unreached, typesOnly, testOnly, unresolved } = report();
    const listed = [...unreached, ...typesOnly, ...testOnly].map(row=>row.file);
    for (const file of ['src/page.worker.js', 'src/deep.js', 'src/math.js', 'src/math.x86.js',
        'test/page/boot.js'])
    {
        assert.ok(!listed.includes(`modules/a/${file}`), `${file} is reached`);
    }
    assert.deepEqual(unresolved.map(u=>`${u.file}:${u.line} ${u.what}`),
        [`${A}load.js:2 import(n)`], 'what a run names by a value it cannot see');
});

test('an export nobody takes, used in its file or not; one only tests take; a type is a use', ()=>{
    const { exports } = report();
    const of = (/** @type {string} */ file)=>exports.filter(e=>e.file === A + file)
        .map(e=>`${e.name} ${e.takers} ${e.inside ? 'inside' : 'nowhere'}`).sort();
    assert.deepEqual(of('used.js'),
        ['inner nobody inside', 'testedOnly tests nowhere', 'unusedFn nobody nowhere']);
    assert.deepEqual(of('shapes.js'), ['SIDES nobody nowhere'],
        'a typedef is no export; the constant beside it is one nobody takes');
    assert.deepEqual(of('types.js'), []);
    assert.deepEqual(of('dead.js'), [], 'a dead file\'s exports are the file\'s, not listed again');
});
