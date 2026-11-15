/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The settings cork's code reads and the keys of its settings table (`SETTINGS`) are
 * the same set, both ways. A setting the code reads and the table lacks is one nobody
 * can find; a key nothing reads silently does nothing (`long` stayed a row a week
 * after the code that read it was gone, `interpretChunk` a typedef key long after
 * `createMachine` took a constant). That the docs and the core's `EngineConfig` are
 * the table's is tools/checks/check-cork-settings.mjs's to hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SETTINGS } from './runtime/settings.js';

const read = (/** @type {string} */ path)=>readFileSync(new URL(path, import.meta.url), 'utf8');

/** A setting's name: a word that may hold digits past its first letter (`x87Shapes`). */
const NAME = '[a-zA-Z][a-zA-Z0-9]*';

/**
 * The names a source reads off a config by one of the spellings given (`settings.`,
 * `corkConfig?.`): each spelling a pattern before the name.
 * @param {string} source @param {string[]} spellings
 */
const namesRead = (source, spellings)=>new Set(spellings.flatMap(spelling=>[
    ...source.matchAll(new RegExp(`${spelling}(${NAME})\\b`, 'g'))].map(match=>match[1])));

/** The runtime's own sources: its parts, not their tests, nor their imports or comments (a
 * `'./settings.js'` or a `settings.md` they name is no setting). */
const runtimeSources = ()=>readdirSync(new URL('./runtime/', import.meta.url))
    .filter(name=>name.endsWith('.js') && !/\.i?test\.js$/.test(name))
    .map(name=>read(`./runtime/${name}`).replace(/^import [^;]*;$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');

/** What the runtime reads off its settings or its config. */
const runtimeReads = ()=>namesRead(runtimeSources(),
    ['\\bsettings\\.', '\\bsettings\\?\\.', '\\bconfig\\.']);

/** What the core's host of cork reads of cork's config, and what `createMachine` does. */
function hostReads(){
    const host = read('../../core/src/layers/cpu/internal/cork-host.js')
        + read('../../core/src/layers/cpu/internal/executor.worker.js')
        + read('../../core/src/layers/cpu/internal/executor.js')
        + read('../../core/src/layers/cpu/module.js');
    return new Set([
        ...namesRead(host, ['\\bcorkConfig\\??\\.', '\\bconfig\\.cork\\??\\.',
            '\\bsettings\\.cork\\??\\.']),
        ...namesRead(read('./machine.js'), ['\\bconfig\\.']),
    ]);
}

const KEYS = new Set(Object.keys(SETTINGS));

test('the name pattern sees a setting with digits in it', ()=>{
    assert.ok(runtimeReads().has('x87Shapes'), 'x87Shapes among what the runtime reads');
});

test('every setting the runtime, the core\'s host or createMachine reads is in the table',
    ()=>{
        const runtime = [...runtimeReads()];
        const host = [...hostReads()];
        assert.ok(runtime.length > 40, `${runtime.length} settings the runtime reads`);
        assert.ok(host.length > 8, `${host.length} settings the host reads`);
        assert.deepEqual(runtime.filter(name=>!KEYS.has(name)), [], 'the runtime\'s');
        assert.deepEqual(host.filter(name=>!KEYS.has(name)), [], 'the host\'s');
    });

test('every setting the table names is one something reads', ()=>{
    const reads = new Set([...runtimeReads(), ...hostReads()]);
    assert.deepEqual([...KEYS].filter(name=>!reads.has(name)), [], 'in the table, read by nothing');
});
