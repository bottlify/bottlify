/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every setting the runtime takes is a documented one: in the engine's
 * `EngineConfig` typedef and in the tables of SETTINGS.md. A knob added to the
 * runtime and nowhere else is one nobody can find, and one documented and
 * gone is a setting that silently does nothing. And the default the tables
 * give is the runtime's: `callWindow` and `callSitesKept` had moved on and
 * their rows had not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ path)=>readFileSync(new URL(path, import.meta.url), 'utf8');

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
    return new Map(source.slice(from, to).split('\n').filter(line=>/^\s{8}[a-zA-Z]+:/.test(line))
        .flatMap(line=>[...line.replace(/\/\*.*?\*\//g, '')
            .matchAll(/([a-zA-Z]+): ([^,]+?)(?=,|$)/g)])
        .map(([, name, value])=>[name, value.trim()]));
}

/** The keys of the runtime's `settings` object. */
const runtimeSettings = ()=>[...runtimeDefaults().keys()];

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
 * The defaults a settings table gives, by setting: a row's names and its
 * defaults in the same order, or one default for all of them (`4096 each`).
 * @param {string} doc
 * @returns {Map<string, string>}
 */
function documentedDefaults(doc){
    /** @type {Map<string, string>} */
    const found = new Map();
    for (const line of doc.split('\n').filter(row=>row.startsWith('| `')))
    {
        const [names, defaults] = line.split(' | ');
        const keys = [...names.matchAll(/`([a-zA-Z]+)`/g)].map(match=>match[1]);
        const each = /^(?:по )?(\S+?)(?: each)?$/.exec(defaults.trim());
        const values = keys.length > 1 && defaults.includes(', ') ? defaults.split(', ')
            : keys.map(()=>each?.[1] ?? defaults);
        keys.forEach((key, k)=>found.set(key, values[k] ?? ''));
    }
    return found;
}

/** Settings set by a host or the runtime for its own wiring, not a person's. */
const WIRING = new Set(['sharedCode']);

test('every runtime setting is in EngineConfig and in SETTINGS.md', ()=>{
    const typedef = read('../../core/src/layers/cpu/engine.js');
    const readme = read('../SETTINGS.md');
    const names = runtimeSettings().filter(name=>!WIRING.has(name));
    assert.ok(names.length > 40, `${names.length} settings found`);
    const untyped = names.filter(name=>!typedef.includes(`[${name}]`));
    const undocumented = names.filter(name=>!readme.includes(`\`${name}\``));
    assert.deepEqual({ untyped, undocumented }, { untyped: [], undocumented: [] });
});

test('every config the core\'s host reads is in EngineConfig and in SETTINGS.md', ()=>{
    const typedef = read('../../core/src/layers/cpu/engine.js');
    const readme = read('../SETTINGS.md');
    const host = read('../../core/src/layers/cpu/internal/cork-host.js')
        + read('../../core/src/layers/cpu/internal/executor.worker.js')
        + read('../../core/src/layers/cpu/internal/executor.js');
    const names = [...new Set([...host.matchAll(/(?:corkConfig|config\.cork)\?\.([a-zA-Z]+)/g)]
        .map(match=>match[1]))];
    assert.ok(names.length > 8, `${names.length} host settings found`);
    const untyped = names.filter(name=>!typedef.includes(`[${name}]`));
    const undocumented = names.filter(name=>!readme.includes(`\`${name}\``));
    assert.deepEqual({ untyped, undocumented }, { untyped: [], undocumented: [] });
});

test('every default SETTINGS.md and SETTINGS.ru.md give for a runtime setting is the runtime\'s',
    ()=>{
        const runtime = runtimeDefaults();
        for (const doc of ['../SETTINGS.md', '../SETTINGS.ru.md'])
        {
            const documented = documentedDefaults(read(doc));
            const compared = [...documented].filter(([name, text])=>runtime.has(name)
                && valueOf(text) !== undefined);
            assert.ok(compared.length > 40, `${doc}: ${compared.length} defaults compared`);
            const wrong = compared.filter(([name, text])=>valueOf(text)
                !== valueOf(/** @type {string} */ (runtime.get(name))))
                .map(([name, text])=>`${name}: ${text}, the runtime's ${runtime.get(name)}`);
            assert.deepEqual(wrong, [], doc);
        }
    });
