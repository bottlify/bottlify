/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleRegistry } from './registry.js';

/**
 * Builds a minimal module definition for registry tests.
 *
 * @param {string} name
 * @param {readonly string[]} [requires]
 * @returns {import("./contract.js").BottlifyModule}
 */
function defn(name, requires = []){
    return {
        name,
        version: '1.0.0',
        requires,
        async create(){
            return { name };
        },
        diagnostics(){
            return { name, version: '1.0.0', status: 'ready' };
        },
        async dispose(){},
    };
}

test('creation order is topological with dependencies first', ()=>{
    const registry = new ModuleRegistry(
        [defn('top', ['mid']), defn('mid', ['base']), defn('base')]);
    const plan = registry.resolve({});
    assert.deepEqual(plan.map(entry=>entry.name), ['base', 'mid', 'top']);
});

test('a disabled module nobody requires is left out', ()=>{
    const registry = new ModuleRegistry([defn('top', ['mid']), defn('mid'), defn('side')]);
    assert.deepEqual(registry.resolve({ side: false }).map(entry=>entry.name), ['mid', 'top']);
});

test('a required module switched off fails the build, naming it and who needs it', ()=>{
    const registry = new ModuleRegistry(
        [defn('top', ['mid']), defn('mid', ['base']), defn('base')]);
    assert.throws(()=>registry.resolve({ mid: false }),
        /Module "mid" is required by "top" and is switched off/);
    assert.throws(()=>registry.resolve({ base: null }),
        /Module "base" is required by "mid" and is switched off/);
    assert.deepEqual(registry.resolve({ top: false, mid: false }).map(entry=>entry.name), ['base'],
        'switched off with everything that needs it, it is simply out');
});

test('dependency cycle is rejected', ()=>{
    const registry = new ModuleRegistry([defn('a', ['b']), defn('b', ['a'])]);
    assert.throws(()=>registry.resolve({}), /cycle/i);
});

test('unknown interface in requires is rejected', ()=>{
    assert.throws(()=>new ModuleRegistry([defn('a', ['ghost'])]), /unknown interface/i);
});

test('duplicate definition is rejected', ()=>{
    assert.throws(()=>new ModuleRegistry([defn('a'), defn('a')]), /Duplicate/);
});
