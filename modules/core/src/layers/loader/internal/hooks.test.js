/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHexBytes, planHook, planSiteHook } from './hooks.js';

const IMAGE = {
    name: 'program.exe', base: 0x400000, sizeOfImage: 0x271f000, timeDateStamp: 0x414221a3,
};

/** @type {import('./hooks.js').HookEntry} */
const ENTRY = {
    image: 'program.exe',
    check: { timeDateStamp: '0x414221a3', sizeOfImage: '0x271f000' },
    slot: { rva: '0x303190' },
    target: { rva: '0x24e450' },
    kernel: 'vector.dot',
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
    const plan = planHook({ ...ENTRY, image: 'other.exe' }, IMAGE, IMAGE.base + 0x24e450);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /for other\.exe, not program\.exe/);
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

// A real fixture, not synthesised: the site's own eight bytes are three
// `mov`s (no branch among them), the resume point six bytes, the function
// start eight -- a real disassembly's bytes, from a build this layer never
// names.
/** @type {import('./hooks.js').SiteHookEntry} */
const SITE_ENTRY = {
    image: 'program.exe',
    check: { timeDateStamp: '0x414221a3', sizeOfImage: '0x271f000' },
    site: { rva: '0x73676', bytes: '8b 57 04 8b 07 8b 4b 30', lengths: [3, 2, 3] },
    resume: { rva: '0x737a3', bytes: '8b 0d d8 82 a5 02', stackAdjust: 8 },
    function: { rva: '0x734f0', bytes: '83 ec 3c 8b 15 40 0e 2e' },
    kernel: 'loop.faces',
    mode: 'replace',
};

const SITE_READS = {
    siteBytes: parseHexBytes(SITE_ENTRY.site.bytes),
    resumeBytes: parseHexBytes(SITE_ENTRY.resume.bytes),
    functionBytes: parseHexBytes(SITE_ENTRY.function.bytes),
};

test('a good site entry resolves the site and resume addresses against the base actually loaded',
    ()=>{
        const plan = planSiteHook(SITE_ENTRY, IMAGE, SITE_READS);
        assert.deepEqual(plan, {
            ok: true,
            siteAddress: IMAGE.base + 0x73676,
            resumeAddress: IMAGE.base + 0x737a3,
            displacedLength: 8,
            stackAdjust: 8,
        });
    });

test('a site entry for a different image is refused without touching the byte pins', ()=>{
    const plan = planSiteHook({ ...SITE_ENTRY, image: 'other.exe' }, IMAGE, SITE_READS);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /for other\.exe, not program\.exe/);
});

test('a stale build is refused before any byte pin is even read', ()=>{
    const stale = { ...IMAGE, timeDateStamp: 0xdeadbeef };
    const plan = planSiteHook(SITE_ENTRY, stale, SITE_READS);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /image check failed/);
});

test('a site that does not hold the bytes the sidecar disassembled is refused, named', ()=>{
    const plan = planSiteHook(SITE_ENTRY, IMAGE,
        { ...SITE_READS, siteBytes: parseHexBytes('90 90 90 90 90 90 90 90') });
    assert.equal(plan.ok, false);
    assert.match(plan.reason,
        /loop\.faces: site holds 90 90 90 90 90 90 90 90, expected 8b 57/);
});

test('a resume point that does not hold the pinned bytes is refused, named', ()=>{
    const plan = planSiteHook(SITE_ENTRY, IMAGE,
        { ...SITE_READS, resumeBytes: parseHexBytes('90 90 90 90 90 90') });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /loop\.faces: resume point holds 90/);
});

test('a function start that does not hold the pinned bytes is refused, named', ()=>{
    const plan = planSiteHook(SITE_ENTRY, IMAGE,
        { ...SITE_READS, functionBytes: parseHexBytes('90 90 90 90 90 90 90 90') });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /loop\.faces: function start holds 90/);
});

test('lengths that do not sum to the site bytes are refused', ()=>{
    const plan = planSiteHook(
        { ...SITE_ENTRY, site: { ...SITE_ENTRY.site, lengths: [3, 2, 2] } }, IMAGE, SITE_READS);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /site\.lengths sums to 7, must equal the 8 site bytes/);
});

test('a lengths sum under five bytes is refused even when it matches the site', ()=>{
    const shortEntry = {
        ...SITE_ENTRY,
        site: { rva: '0x73676', bytes: '8b 57 04', lengths: [3] },
    };
    const plan = planSiteHook(shortEntry, IMAGE,
        { ...SITE_READS, siteBytes: parseHexBytes('8b 57 04') });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /must equal the 3 site bytes and be at least 5/);
});

test('a relative branch among the displaced instructions is refused', ()=>{
    // `e9` is a near jump; if the sidecar mis-measured the second instruction's
    // length and it starts with one, the bytes can no longer be moved to a
    // trampoline.
    const branching = {
        ...SITE_ENTRY,
        site: { rva: '0x73676', bytes: '8b 57 04 e9 00 00 00 00', lengths: [3, 2, 3] },
    };
    const plan = planSiteHook(branching, IMAGE,
        { ...SITE_READS, siteBytes: parseHexBytes('8b 57 04 e9 00 00 00 00') });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /relative branch/);
});

test('parseHexBytes reads a space-separated hex string in order', ()=>{
    assert.deepEqual(parseHexBytes('8b 57 04 8b 07 8b 4b 30'),
        [0x8b, 0x57, 0x04, 0x8b, 0x07, 0x8b, 0x4b, 0x30]);
});
