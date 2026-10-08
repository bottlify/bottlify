/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every setting the runtime takes is a documented one: in the engine's
 * `EngineConfig` typedef and in the README's tables. A knob added to the
 * runtime and nowhere else is one nobody can find, and one documented and
 * gone is a setting that silently does nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ path)=>readFileSync(new URL(path, import.meta.url), 'utf8');

/** The keys of the runtime's `settings` object, its defaults. */
function runtimeSettings(){
    const source = read('./runtime/runtime.js');
    const from = source.indexOf('const settings = {');
    const to = source.indexOf('...config,', from);
    assert.ok(from > 0 && to > from, 'the settings object is where it was');
    return [...source.slice(from, to).matchAll(/^\s{8}([a-zA-Z]+):/gm)].map(match=>match[1]);
}

/** Settings set by a host or the runtime for its own wiring, not a person's. */
const WIRING = new Set(['sharedCode']);

test('every runtime setting is in EngineConfig and in the README', ()=>{
    const typedef = read('../../core/src/layers/cpu/engine.js');
    const readme = read('../README.md');
    const names = runtimeSettings().filter(name=>!WIRING.has(name));
    assert.ok(names.length > 40, `${names.length} settings found`);
    const untyped = names.filter(name=>!typedef.includes(`[${name}]`));
    const undocumented = names.filter(name=>!readme.includes(`\`${name}\``));
    assert.deepEqual({ untyped, undocumented }, { untyped: [], undocumented: [] });
});

test('every config the core\'s host reads is in EngineConfig and in the README', ()=>{
    const typedef = read('../../core/src/layers/cpu/engine.js');
    const readme = read('../README.md');
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
