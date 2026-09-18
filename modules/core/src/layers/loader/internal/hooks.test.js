/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHook } from './hooks.js';

const IMAGE = {
    name: 'Doom3.exe', base: 0x400000, sizeOfImage: 0x271f000, timeDateStamp: 0x414221a3,
};

/** @type {import('./hooks.js').HookEntry} */
const ENTRY = {
    image: 'Doom3.exe',
    check: { timeDateStamp: '0x414221a3', sizeOfImage: '0x271f000' },
    slot: { rva: '0x303190' },
    target: { rva: '0x24e450' },
    kernel: 'idSIMD.dotPlaneDrawVert',
    convention: { registers: ['ecx', 'edx'], stackArgs: 3, cleanup: 12 },
    mode: 'oracle',
};

test('a good entry resolves the slot and target against the base actually loaded', ()=>{
    const targetAddress = IMAGE.base + 0x24e450;
    const plan = planHook(ENTRY, IMAGE, targetAddress);
    assert.deepEqual(plan, {
        ok: true,
        slotAddress: IMAGE.base + 0x303190,
        targetAddress,
        argBytes: 20, // this + dst (registers) + plane, verts, count (stack)
    });
});

test('an entry for a different image is refused without touching the check', ()=>{
    const plan = planHook({ ...ENTRY, image: 'Quake3.exe' }, IMAGE, IMAGE.base + 0x24e450);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /for Quake3\.exe, not Doom3\.exe/);
});

test('a stale build is refused rather than patching bytes it has not seen', ()=>{
    const stale = { ...IMAGE, timeDateStamp: 0xdeadbeef };
    const plan = planHook(ENTRY, stale, IMAGE.base + 0x24e450);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /image check failed/);

    const resized = { ...IMAGE, sizeOfImage: IMAGE.sizeOfImage + 0x1000 };
    assert.equal(planHook(ENTRY, resized, IMAGE.base + 0x24e450).ok, false);
});

test('a slot that does not currently hold the target is refused', ()=>{
    const plan = planHook(ENTRY, IMAGE, IMAGE.base + 0x1234);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /slot holds 0x[0-9a-f]+, expected the target/);
});

test('a convention this layer cannot marshal is refused by name', ()=>{
    const plan = planHook(
        { ...ENTRY, convention: { registers: ['ecx'], stackArgs: 4 } },
        IMAGE, IMAGE.base + 0x24e450);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /FASTCALL/);
});
