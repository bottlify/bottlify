/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * check-catalog: each rule fails on a catalog that breaks it, and a whole one passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problems, render } from './check-catalog.mjs';

const entry = (over = {})=>({ path: 'tools/run/a.mjs', category: 'run', kind: 'instrument',
    browser: false, question: 'What?', command: 'node tools/run/a.mjs', tests: ['tools/run/a.test.js'],
    parts: ['tools/run/a/'], sample: 'out', source: 'node tools/run/a.mjs x', read: 'read it', ...over });
const files = ['tools/README.md', 'tools/catalog.json', 'tools/run/a.mjs', 'tools/run/a.test.js',
    'tools/run/a/data.bin'];
const check = (/** @type {any[]} */ tools, list = files, readme = render({ tools }))=>
    problems({ tools }, list, ()=>true, readme);

test('a catalog that covers every file, each in its folder, with its sample, passes', ()=>{
    assert.deepEqual(check([entry()]), []);
});

test('a file no entry covers, or one at the top of tools/, fails', ()=>{
    assert.deepEqual(check([entry()], [...files, 'tools/run/b.mjs', 'tools/c.mjs']),
        ['tools/run/b.mjs: no catalog entry covers it',
            'tools/c.mjs: at the top of tools/, which holds the catalog alone']);
});

test('an entry outside its folder, or whose file is gone, fails', ()=>{
    assert.deepEqual(check([entry({ category: 'live' })]).slice(0, 1),
        ['tools/run/a.mjs: tools/run/a.mjs is outside tools/live/']);
    assert.deepEqual(problems({ tools: [entry()] }, files, path=>path !== 'tools/run/a.test.js',
        render({ tools: [entry()] })), ['tools/run/a.mjs: tools/run/a.test.js is gone']);
});

test('an instrument that runs here without a sample fails; one needing a browser does not', ()=>{
    assert.deepEqual(check([entry({ sample: undefined })]),
        ['tools/run/a.mjs: an instrument that runs here has no real output sample']);
    assert.deepEqual(check([entry({ sample: undefined, browser: true })]), []);
});

test('a page other than the one the catalog makes fails', ()=>{
    assert.deepEqual(check([entry()], files, '# edited by hand\n'),
        ['tools/README.md: not what the catalog makes (node tools/checks/check-catalog.mjs --write)']);
});
