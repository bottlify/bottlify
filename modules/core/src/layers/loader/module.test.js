/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loaderModule } from './module.js';

const IMAGE = {
    name: 'Doom3.exe', base: 0x400000, sizeOfImage: 0x271f000, timeDateStamp: 0x414221a3,
};
const SLOT_RVA = 0x303190;
const TARGET_RVA = 0x24e450;

/** @type {import('./internal/hooks.js').HookEntry} */
const GOOD_HOOK = {
    image: 'Doom3.exe',
    check: { timeDateStamp: '0x414221a3', sizeOfImage: '0x271f000' },
    slot: { rva: `0x${SLOT_RVA.toString(16)}` },
    target: { rva: `0x${TARGET_RVA.toString(16)}` },
    kernel: 'idSIMD.dotPlaneDrawVert',
    convention: { registers: ['ecx', 'edx'], stackArgs: 3, cleanup: 12 },
    mode: 'oracle',
};

/**
 * A stub memory layer holding just the one word a hook needs: the slot.
 *
 * @param {number} slotValue  What is at `IMAGE.base + SLOT_RVA` to start with.
 */
function machine(slotValue){
    /** @type {Map<number, number>} */
    const cells = new Map([[IMAGE.base + SLOT_RVA, slotValue]]);
    const memory = {
        /** @param {number} address */
        readU32: address=>cells.get(address >>> 0) ?? 0,
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>cells.set(address >>> 0, value >>> 0),
    };
    const host = /** @type {any} */ ({ requireApi: /** @param {string} name */ name=>({ memory })[name] });
    return { memory, host };
}

test('a good sidecar entry writes the registered stub address into the slot', async()=>{
    const { host, memory } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);
    /** @type {any[]} */
    const registered = [];
    const { bound, refused } = loader.bindHooks(
        { hooks: [GOOD_HOOK] }, IMAGE,
        // Answers the way `bridge.hook` does: the stub's guest address as a
        // number, nothing wrapped around it. A stub here shaped any other way
        // would pass a slot write the real bridge never makes.
        /** @param {any} options */ options=>{
            registered.push(options);
            return 0x00900010;
        },
        /** @param {any} entry */ entry=>()=>{
            void entry;
            return true;
        });

    assert.deepEqual(bound, ['idSIMD.dotPlaneDrawVert']);
    assert.deepEqual(refused, []);
    assert.equal(registered.length, 1);
    const { name, argBytes, target } = registered[0];
    assert.deepEqual(
        { name, argBytes, target },
        { name: 'idSIMD.dotPlaneDrawVert', argBytes: 20, target: IMAGE.base + TARGET_RVA });
    assert.equal(memory.readU32(IMAGE.base + SLOT_RVA), 0x00900010,
        'the slot now points at the registered stub, not the original function');
});

test('a registration that yields no address is refused and the slot stays as it was', async()=>{
    // `bridge.hook` answers 0 once the bridge is disposed; written into the
    // slot, 0 sends every caller of the hooked function into address zero,
    // which is exactly the fault a slot must never be able to cause.
    const { host, memory } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);
    const { bound, refused } = loader.bindHooks(
        { hooks: [GOOD_HOOK] }, IMAGE, ()=>0, ()=>()=>true);
    assert.deepEqual(bound, []);
    assert.deepEqual(refused, ['idSIMD.dotPlaneDrawVert: no stub address was registered']);
    assert.equal(memory.readU32(IMAGE.base + SLOT_RVA), IMAGE.base + TARGET_RVA,
        'the slot still points at the guest function');
});

test('a check mismatch is refused and counted, and nothing is registered', async()=>{
    const { host, memory } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);
    const stale = { ...GOOD_HOOK, check: { timeDateStamp: '0xbad', sizeOfImage: '0xbad' } };
    let registrations = 0;
    const { bound, refused } = loader.bindHooks(
        { hooks: [stale] }, IMAGE, ()=>{
            registrations++;
            return 0x00900010;
        }, ()=>()=>true);

    assert.deepEqual(bound, []);
    assert.equal(refused.length, 1);
    assert.match(refused[0], /image check failed/);
    assert.equal(registrations, 0);
    assert.equal(memory.readU32(IMAGE.base + SLOT_RVA), IMAGE.base + TARGET_RVA,
        'the slot is untouched');
});

test('a slot not pointing at the target is refused and counted', async()=>{
    // Something else already changed it, or it never held the target.
    const { host } = machine(0xdeadbeef);
    const loader = await loaderModule.create({}, host);
    let registrations = 0;
    const { bound, refused } = loader.bindHooks(
        { hooks: [GOOD_HOOK] }, IMAGE, ()=>{
            registrations++;
            return 0x00900010;
        }, ()=>()=>true);

    assert.deepEqual(bound, []);
    assert.equal(refused.length, 1);
    assert.match(refused[0], /slot holds 0xdeadbeef/);
    assert.equal(registrations, 0);
});

test('an entry for another image is silently not this image\'s business', async()=>{
    const { host } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);
    const { bound, refused } = loader.bindHooks(
        { hooks: [{ ...GOOD_HOOK, image: 'Quake3.exe' }] }, IMAGE,
        ()=>0x00900010, ()=>()=>true);
    assert.deepEqual(bound, []);
    assert.deepEqual(refused, [], 'not refused -- just not addressed to this image');
});

test('a kernel nothing provides is refused by name, after the sidecar checks pass', async()=>{
    const { host } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);
    const { bound, refused } = loader.bindHooks(
        { hooks: [GOOD_HOOK] }, IMAGE, ()=>0x00900010, ()=>null);
    assert.deepEqual(bound, []);
    assert.deepEqual(refused, ['idSIMD.dotPlaneDrawVert: no kernel provides it']);
});
