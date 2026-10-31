/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The settings cork takes and the tables of SETTINGS.md and SETTINGS.ru.md are
 * the same set, both ways. A setting the code reads and no table names is one
 * nobody can find; a row whose setting nothing reads silently does nothing
 * (`long` stayed a row a week after the code that read it was gone). The
 * default a table gives is the runtime's: `callWindow` and `callSitesKept`
 * had moved on and their rows had not. And every runtime setting a host may
 * pass is in the core's `EngineConfig` typedef.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ path)=>readFileSync(new URL(path, import.meta.url), 'utf8');

/** A setting's name: a word that may hold digits past its first letter (`x87Shapes`). */
const NAME = '[a-zA-Z][a-zA-Z0-9]*';

/**
 * The runtime's `settings` object, its defaults: each key with its value as
 * written, several to a line where they share one.
 * @returns {Map<string, string>}
 */
function runtimeDefaults(){
    const source = read('./runtime/runtime.js');
    const from = source.indexOf('const settings = {');
    const to = source.indexOf('...config,', from);
    assert.ok(from > 0 && to > from, 'the settings object is where it was');
    return new Map(source.slice(from, to).split('\n')
        .map(line=>line.replace(/\/\*.*?\*\//g, ''))
        .filter(line=>new RegExp(`^\\s{8}${NAME}:`).test(line))
        .flatMap(line=>[...line.matchAll(new RegExp(`(${NAME}): ([^,]+?)(?=,|$)`, 'g'))])
        .map(([, name, value])=>[name, value.trim()]));
}

/**
 * The names a source reads off a config by one of the spellings given (`settings.`,
 * `corkConfig?.`): each spelling a pattern before the name.
 * @param {string} source @param {string[]} spellings
 */
const namesRead = (source, spellings)=>new Set(spellings.flatMap(spelling=>[
    ...source.matchAll(new RegExp(`${spelling}(${NAME})\\b`, 'g'))].map(match=>match[1])));

/** What the runtime reads: its defaults' keys, and the keys it reads past them. */
function runtimeReads(){
    const source = read('./runtime/runtime.js');
    return new Set([...runtimeDefaults().keys(),
        ...namesRead(source, ['\\bsettings\\.', '\\bsettings\\?\\.', '\\bconfig\\.'])]);
}

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

/**
 * A default as the runtime writes it or a table gives it, as a value: a number
 * (`1 << 20`, `48 << 20`, `10_000`; `2^20`, `48 MiB`), a boolean; anything
 * else -- `unset`, `none`, a sentence -- is undefined, compared with nothing.
 * @param {string} text
 */
function valueOf(text){
    const plain = text.replace(/`/g, '').replace(/_/g, '').trim();
    const shift = /^(\d+) << (\d+)$/.exec(plain);
    const power = /^2\^(\d+)$/.exec(plain);
    const mebi = /^(\d+) (?:MiB|МиБ)$/.exec(plain);
    return plain === 'true' || plain === 'false' ? plain === 'true'
        : shift ? Number(shift[1]) * 2 ** Number(shift[2])
            : power ? 2 ** Number(power[1])
                : mebi ? Number(mebi[1]) * 2 ** 20
                    : /^\d+(\.\d+)?$/.test(plain) ? Number(plain) : undefined;
}

/**
 * The settings a settings table names, with their defaults: a row's names and its
 * defaults in the same order, or one default for all of them.
 * @param {string} doc
 * @returns {Map<string, string>}
 */
function documentedDefaults(doc){
    /** @type {Map<string, string>} */
    const found = new Map();
    for (const line of doc.split('\n').filter(row=>row.startsWith('| `')))
    {
        const [names, defaults] = line.slice(2).split(' | ');
        const keys = [...names.matchAll(new RegExp(`\`(${NAME})\``, 'g'))].map(match=>match[1]);
        const values = keys.length > 1 && defaults.includes(', ') ? defaults.split(', ')
            : keys.map(()=>defaults);
        keys.forEach((key, k)=>found.set(key, values[k] ?? ''));
    }
    return found;
}

const DOCS = ['../SETTINGS.md', '../SETTINGS.ru.md'];

/** Settings a host wires that EngineConfig does not carry: not a person's to pass. */
const WIRING = new Set(['sharedCode']);

test('the name pattern sees a setting with digits in it', ()=>{
    assert.ok(runtimeDefaults().has('x87Shapes'), 'x87Shapes among the runtime\'s defaults');
    assert.ok(documentedDefaults(read(DOCS[0])).has('x87Shapes'), 'and among the documented');
});

test('every setting the runtime reads is in both tables, and in EngineConfig but the wiring',
    ()=>{
        const typedef = read('../../core/src/layers/cpu/engine.js');
        const names = [...runtimeReads()];
        assert.ok(names.length > 40, `${names.length} settings found`);
        for (const doc of DOCS)
        {
            const documented = documentedDefaults(read(doc));
            assert.deepEqual(names.filter(name=>!documented.has(name)), [], `${doc}: undocumented`);
        }
        assert.deepEqual(names.filter(name=>!WIRING.has(name) && !typedef.includes(`[${name}]`)),
            [], 'not in EngineConfig');
    });

test('every config the core\'s host or createMachine reads is in both tables', ()=>{
    const names = [...hostReads()];
    assert.ok(names.length > 8, `${names.length} host settings found`);
    for (const doc of DOCS)
    {
        const documented = documentedDefaults(read(doc));
        assert.deepEqual(names.filter(name=>!documented.has(name)), [], `${doc}: undocumented`);
    }
});

test('every setting a table names is one something reads, and both tables name the same', ()=>{
    const reads = new Set([...runtimeReads(), ...hostReads()]);
    const [english, russian] = DOCS.map(doc=>[...documentedDefaults(read(doc)).keys()]);
    assert.ok(english.length > 40, `${english.length} settings documented`);
    assert.deepEqual(english.filter(name=>!reads.has(name)), [], 'documented, read by nothing');
    assert.deepEqual([...russian].sort(), [...english].sort(), 'the two tables name the same');
});

test('every default SETTINGS.md and SETTINGS.ru.md give for a runtime setting is the runtime\'s',
    ()=>{
        const runtime = runtimeDefaults();
        for (const doc of DOCS)
        {
            const documented = documentedDefaults(read(doc));
            const compared = [...documented].filter(([name, text])=>runtime.has(name)
                && valueOf(text) !== undefined);
            assert.ok(compared.length > 30, `${doc}: ${compared.length} defaults compared`);
            const wrong = compared.filter(([name, text])=>valueOf(text)
                !== valueOf(/** @type {string} */ (runtime.get(name))))
                .map(([name, text])=>`${name}: ${text}, the runtime's ${runtime.get(name)}`);
            assert.deepEqual(wrong, [], doc);
        }
    });
