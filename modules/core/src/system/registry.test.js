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

test('disabled modules are excluded unless required', ()=>{
    const registry = new ModuleRegistry([defn('top', ['mid']), defn('mid'), defn('side')]);
    const plan = registry.resolve({ mid: false, side: false });
    const names = plan.map(entry=>entry.name);
    assert.ok(names.includes('top'), 'enabled module stays');
    assert.ok(names.includes('mid'), 'required-but-disabled stays');
    assert.ok(!names.includes('side'), 'disabled leaf is dropped');
    const mid = plan.find(entry=>entry.name === 'mid');
    assert.ok(mid);
    assert.equal(mid.module.diagnostics().status, 'stub');
    assert.equal(mid.config, null);
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
