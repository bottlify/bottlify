/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loaderModule } from './module.js';
import { bridgeModule } from '../bridge/module.js';
import { parseHexBytes } from './internal/hooks.js';

const IMAGE = {
    name: 'program.exe', base: 0x400000, sizeOfImage: 0x271f000, timeDateStamp: 0x414221a3,
};
const SLOT_RVA = 0x303190;
const TARGET_RVA = 0x24e450;

/** @type {import('./internal/hooks.js').HookEntry} */
const GOOD_HOOK = {
    image: 'program.exe',
    check: { timeDateStamp: '0x414221a3', sizeOfImage: '0x271f000' },
    slot: { rva: `0x${SLOT_RVA.toString(16)}` },
    target: { rva: `0x${TARGET_RVA.toString(16)}` },
    kernel: 'vector.dot',
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

    assert.deepEqual(bound, ['vector.dot']);
    assert.deepEqual(refused, []);
    assert.equal(registered.length, 1);
    const { name, argBytes, target } = registered[0];
    assert.deepEqual(
        { name, argBytes, target },
        { name: 'vector.dot', argBytes: 20, target: IMAGE.base + TARGET_RVA });
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
    assert.deepEqual(refused, ['vector.dot: no stub address was registered']);
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

test('a slot rva nothing backs is refused by name rather than throwing out of bindHooks',
    async()=>{
        const memory = {
            /** @param {number} address */
            readU32: address=>{
                throw new Error(`Unmapped read at 0x${(address >>> 0).toString(16)}`);
            },
            writeU32: ()=>{},
        };
        const host = /** @type {any} */ ({
            requireApi: /** @param {string} name */ name=>({ memory })[name],
        });
        const loader = await loaderModule.create({}, host);
        const { bound, refused } = loader.bindHooks(
            { hooks: [GOOD_HOOK] }, IMAGE, ()=>0x00900010, ()=>()=>true);
        assert.deepEqual(bound, []);
        assert.equal(refused.length, 1);
        assert.match(refused[0], /vector\.dot: Unmapped read/);
    });

test('an entry for another image is pending, then bound when that image is placed', async()=>{
    const { host } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);
    const spec = { hooks: [{ ...GOOD_HOOK, image: 'other.dll' }] };
    const first = loader.bindHooks(spec, IMAGE, ()=>0x00900010, ()=>()=>true);
    assert.deepEqual(first.bound, []);
    assert.deepEqual(first.refused, []);
    assert.deepEqual(first.pending, ['vector.dot'], 'neither bound nor refused: waiting');
    assert.deepEqual(loaderModule.diagnostics().metrics?.hooksPending, ['vector.dot']);

    // The library is placed at the same address this fixture's image sits
    // at, so the slot and target the entry names hold what they must.
    const second = loader.bindHooks(spec, { ...IMAGE, name: 'other.dll' },
        ()=>0x00900010, ()=>()=>true);
    assert.deepEqual(second.bound, ['vector.dot']);
    assert.deepEqual(second.pending, [], 'bound now, so no longer pending');
    assert.deepEqual(loaderModule.diagnostics().metrics?.hooksBound, ['vector.dot'],
        'the results accumulate across images');
});

test('a kernel nothing provides is refused by name, after the sidecar checks pass', async()=>{
    const { host } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);
    const { bound, refused } = loader.bindHooks(
        { hooks: [GOOD_HOOK] }, IMAGE, ()=>0x00900010, ()=>null);
    assert.deepEqual(bound, []);
    assert.deepEqual(refused, ['vector.dot: no kernel provides it']);
});

test('bindHooks wired to the real bridge.hook writes the address the bridge actually '
    + 'answers, not a mock shaped to fit', async()=>{
    // The slot-zero fault was exactly a return-shape mismatch between what
    // `bridge.hook` answers and what a mock stood in for it; this seam --
    // `app.js`'s `hookOptions=>bridge.hook(hookOptions.name, hookOptions)` --
    // stayed typed `any`, so only the real modules on both sides catch a
    // future divergence of the same class.
    const { host, memory } = machine(IMAGE.base + TARGET_RVA);
    const loader = await loaderModule.create({}, host);

    let nextTrap = 1;
    /** @type {any} */
    const bridgeApis = {
        cpu: {
            readReg32: ()=>0,
            writeReg32: ()=>{},
            registerTrap: ()=>{
                const id = nextTrap++;
                return { id, address: 0x00900000 + id * 16 };
            },
            onTrap: ()=>{},
        },
        kernel: {
            currentThread: ()=>({ name: 'main' }),
            threads: ()=>[],
            holdThread: ()=>{},
            parkThread: ()=>{},
            scheduleResume: ()=>{},
        },
        memory,
        log: { begin: ()=>{}, end: ()=>{} },
    };
    const bridge = await bridgeModule.create({}, /** @type {any} */ ({
        /** @param {string} name */ requireApi: name=>bridgeApis[name],
    }));

    /** @type {number[]} */
    const answered = [];
    const { bound, refused } = loader.bindHooks(
        { hooks: [GOOD_HOOK] }, IMAGE,
        /** @param {any} options */ options=>{
            const address = bridge.hook(options.name, options);
            answered.push(address);
            return address;
        },
        /** @param {any} entry */ entry=>()=>{
            void entry;
            return true;
        });

    assert.deepEqual(refused, []);
    assert.deepEqual(bound, ['vector.dot']);
    assert.equal(answered.length, 1);
    assert.notEqual(answered[0], 0, 'the bridge placed a real stub');
    assert.equal(memory.readU32(IMAGE.base + SLOT_RVA), answered[0],
        'the slot holds exactly the address the bridge itself answered');

    await bridgeModule.dispose();
});

// A real fixture, not synthesised: the site's own eight bytes are three
// `mov`s (no branch among them), the resume point six bytes, the function
// start eight -- a real disassembly's bytes, from a build this layer never
// names.
/** @type {import('./internal/hooks.js').SiteHookEntry} */
const SITE_ENTRY = {
    image: 'program.exe',
    check: { timeDateStamp: '0x414221a3', sizeOfImage: '0x271f000' },
    site: { rva: '0x73676', bytes: '8b 57 04 8b 07 8b 4b 30', lengths: [3, 2, 3] },
    resume: { rva: '0x737a3', bytes: '8b 0d d8 82 a5 02', stackAdjust: 8 },
    function: { rva: '0x734f0', bytes: '83 ec 3c 8b 15 40 0e 2e' },
    kernel: 'loop.faces',
    mode: 'replace',
};

/**
 * A stub memory layer that backs a site hook's bind: bytes at the site,
 * resume and function RVAs (real, unless a test corrupts one), plus a scratch
 * heap `allocate` carves a trampoline from.
 *
 * @param {{ site?: number[], resume?: number[], function?: number[] }} [corrupt]
 *     Bytes to write over the real ones, keyed the same as `SITE_ENTRY`.
 */
function siteMachine(corrupt = {}){
    /** @type {Map<number, number>} */
    const bytes = new Map();
    const seed = (/** @type {number} */ address, /** @type {number[]} */ values)=>
        values.forEach((value, i)=>bytes.set(address + i, value));
    seed(IMAGE.base + Number(SITE_ENTRY.site.rva), parseHexBytes(SITE_ENTRY.site.bytes));
    seed(IMAGE.base + Number(SITE_ENTRY.resume.rva), parseHexBytes(SITE_ENTRY.resume.bytes));
    seed(IMAGE.base + Number(SITE_ENTRY.function.rva), parseHexBytes(SITE_ENTRY.function.bytes));
    if (corrupt.site)
    {
        seed(IMAGE.base + Number(SITE_ENTRY.site.rva), corrupt.site);
    }
    if (corrupt.resume)
    {
        seed(IMAGE.base + Number(SITE_ENTRY.resume.rva), corrupt.resume);
    }
    if (corrupt.function)
    {
        seed(IMAGE.base + Number(SITE_ENTRY.function.rva), corrupt.function);
    }

    let scratch = 0x0c000000;
    /** @type {{ name: string, access: string }[]} */
    const protects = [];
    const memory = {
        /** @param {number} address @param {number} length */
        readBytes: (address, length)=>Uint8Array.from(
            { length }, (_, i)=>bytes.get(address + i) ?? 0),
        /** @param {number} address @param {Uint8Array} data */
        writeBytes: (address, data)=>data.forEach((value, i)=>bytes.set(address + i, value)),
        /** @param {number} address */
        find: address=>(address >= IMAGE.base && address < IMAGE.base + IMAGE.sizeOfImage
            ? { name: 'image', access: 'rwx' } : undefined),
        /** @param {string} name @param {string} access */
        protect: (name, access)=>protects.push({ name, access }),
        Access: { READ_WRITE_EXECUTE: 'rwx' },
    };
    /** @param {number} size */
    const allocate = size=>{
        const at = scratch;
        scratch += size;
        return at;
    };
    const host = /** @type {any} */ ({ requireApi: /** @param {string} name */ name=>({ memory })[name] });
    return { memory, host, allocate, bytes, protects };
}

test('a good site entry allocates a trampoline and patches the site to jump into the stub, '
    + 'and nothing outside the patched eight bytes changes', async()=>{
    const { host, memory, allocate, bytes, protects } = siteMachine();
    const loader = await loaderModule.create({}, host);
    const siteAddress = IMAGE.base + 0x73676;
    // A window well past the eight bytes on either side, snapshotted before
    // `bindHooks` runs: the brief's own check ("writes the jmp stub at the
    // site and nothing else in the image changes") is a before/after
    // comparison, not just a read of what the write itself produced.
    const windowStart = siteAddress - 0x20;
    const windowLength = 0x48;
    const before = [...memory.readBytes(windowStart, windowLength)];
    /** @type {any[]} */
    const registered = [];
    const { bound, refused } = loader.bindHooks(
        { hooks: [SITE_ENTRY] }, IMAGE,
        /** @param {any} options */ options=>{
            registered.push(options);
            return 0x00900010;
        },
        /** @param {any} entry */ entry=>()=>{
            void entry;
            return true;
        },
        allocate);

    assert.deepEqual(bound, ['loop.faces']);
    assert.deepEqual(refused, []);
    assert.equal(registered.length, 1);
    const { name, site, resume, stackAdjust, trampoline } = registered[0];
    assert.deepEqual(
        { name, site, resume, stackAdjust },
        {
            name: 'loop.faces', site: true,
            resume: IMAGE.base + 0x737a3, stackAdjust: 8,
        });

    // The trampoline: the eight displaced bytes, then a jump back to the
    // site's own instruction right after them.
    const displaced = [...memory.readBytes(trampoline, 8)];
    assert.deepEqual(displaced, parseHexBytes(SITE_ENTRY.site.bytes));
    const tail = [...memory.readBytes(trampoline + 8, 5)];
    assert.equal(tail[0], 0xe9, 'a near jump');
    const rel = new DataView(Uint8Array.from(tail.slice(1)).buffer).getInt32(0, true);
    assert.equal(trampoline + 8 + 5 + rel, IMAGE.base + 0x73676 + 8,
        'lands right after the eight displaced bytes at the real site');

    // The site itself: patched to jump into the registered stub, the rest
    // padded with nop so nothing partial is ever executed.
    const patched = [...memory.readBytes(siteAddress, 8)];
    assert.equal(patched[0], 0xe9);
    const siteRel = new DataView(Uint8Array.from(patched.slice(1, 5)).buffer).getInt32(0, true);
    assert.equal(siteAddress + 5 + siteRel, 0x00900010,
        'the patch jumps to exactly the address the caller registered');
    assert.deepEqual(patched.slice(5), [0x90, 0x90, 0x90], 'padded with nop, not left partial');

    const after = [...memory.readBytes(windowStart, windowLength)];
    for (let i = 0; i < windowLength; i++)
    {
        const address = windowStart + i;
        if (address >= siteAddress && address < siteAddress + 8)
        {
            continue;
        }
        assert.equal(after[i], before[i],
            `byte at 0x${address.toString(16)}, outside the patched span, changed`);
    }

    // The protect/write/protect discipline: back to `rwx`, exactly as it was.
    assert.deepEqual(protects, [
        { name: 'image', access: 'rwx' },
        { name: 'image', access: 'rwx' },
    ]);
    void bytes;
});

test('a site rva nothing backs is refused by name rather than throwing out of bindHooks',
    async()=>{
        const memory = {
            /** @param {number} address @param {number} length */
            readBytes: (address, length)=>{
                throw new Error(`Unmapped read at 0x${(address >>> 0).toString(16)}, `
                    + `length ${length}`);
            },
            writeBytes: ()=>{},
            find: ()=>undefined,
            protect: ()=>{},
            Access: { READ_WRITE_EXECUTE: 'rwx' },
        };
        const host = /** @type {any} */ ({
            requireApi: /** @param {string} name */ name=>({ memory })[name],
        });
        const loader = await loaderModule.create({}, host);
        const pastImage = {
            ...SITE_ENTRY,
            site: { ...SITE_ENTRY.site, rva: `0x${(IMAGE.sizeOfImage + 0x1000).toString(16)}` },
        };
        const { bound, refused } = loader.bindHooks(
            { hooks: [pastImage] }, IMAGE, ()=>0x00900010, ()=>()=>true,
            /** @param {number} size */ size=>size);
        assert.deepEqual(bound, []);
        assert.equal(refused.length, 1);
        assert.match(refused[0], /loop\.faces: Unmapped read/);
    });

test('a site the region map does not recognise is refused rather than throwing on .access',
    async()=>{
        // The one path `bindSiteHook` cannot reach today -- the three byte
        // pins above already prove the site is mapped -- guarded anyway
        // against a future reordering.
        /** @type {Map<number, number>} */
        const bytes = new Map();
        const seed = (/** @type {number} */ address, /** @type {number[]} */ values)=>
            values.forEach((value, i)=>bytes.set(address + i, value));
        seed(IMAGE.base + Number(SITE_ENTRY.site.rva), parseHexBytes(SITE_ENTRY.site.bytes));
        seed(IMAGE.base + Number(SITE_ENTRY.resume.rva), parseHexBytes(SITE_ENTRY.resume.bytes));
        seed(IMAGE.base + Number(SITE_ENTRY.function.rva),
            parseHexBytes(SITE_ENTRY.function.bytes));
        const memory = {
            /** @param {number} address @param {number} length */
            readBytes: (address, length)=>Uint8Array.from(
                { length }, (_, i)=>bytes.get(address + i) ?? 0),
            /** @param {number} address @param {Uint8Array} data */
            writeBytes: (address, data)=>data.forEach((value, i)=>bytes.set(address + i, value)),
            find: ()=>undefined,
            protect: ()=>{},
            Access: { READ_WRITE_EXECUTE: 'rwx' },
        };
        const host = /** @type {any} */ ({
            requireApi: /** @param {string} name */ name=>({ memory })[name],
        });
        const loader = await loaderModule.create({}, host);
        const { bound, refused } = loader.bindHooks(
            { hooks: [SITE_ENTRY] }, IMAGE, ()=>0x00900010, ()=>()=>true,
            /** @param {number} size */ size=>size);
        assert.deepEqual(bound, []);
        assert.equal(refused.length, 1);
        assert.match(refused[0], /loop\.faces: nothing is mapped at the site/);
    });

test('a site entry whose bytes do not match the build is refused, and the site is untouched',
    async()=>{
        const { host, memory } = siteMachine({ site: parseHexBytes('90 90 90 90 90 90 90 90') });
        const loader = await loaderModule.create({}, host);
        let registrations = 0;
        const { bound, refused } = loader.bindHooks(
            { hooks: [SITE_ENTRY] }, IMAGE,
            ()=>{
                registrations++;
                return 0x00900010;
            },
            ()=>()=>true,
            /** @param {number} size */ size=>size);

        assert.deepEqual(bound, []);
        assert.equal(refused.length, 1);
        assert.match(refused[0], /loop\.faces: site holds 90 90/);
        assert.equal(registrations, 0);
        assert.deepEqual([...memory.readBytes(IMAGE.base + 0x73676, 8)],
            parseHexBytes('90 90 90 90 90 90 90 90'), 'left exactly as it was read');
    });

test('a site kernel nothing provides is refused by name, after the byte pins pass', async()=>{
    const { host, allocate } = siteMachine();
    const loader = await loaderModule.create({}, host);
    const { bound, refused } = loader.bindHooks(
        { hooks: [SITE_ENTRY] }, IMAGE, ()=>0x00900010, ()=>null, allocate);
    assert.deepEqual(bound, []);
    assert.deepEqual(refused, ['loop.faces: no kernel provides it']);
});

test('a site entry with no allocator is refused by name, rather than throwing', async()=>{
    const { host } = siteMachine();
    const loader = await loaderModule.create({}, host);
    // The fourth argument, `allocate`, is simply omitted -- exactly what a
    // caller with nothing but slot entries in its spec already does today.
    const { bound, refused } = loader.bindHooks(
        { hooks: [SITE_ENTRY] }, IMAGE, ()=>0x00900010, ()=>()=>true);
    assert.deepEqual(bound, []);
    assert.deepEqual(refused,
        ['loop.faces: no allocator provided for a site hook']);
});

test('a site registration that yields no address leaves the site unpatched', async()=>{
    const { host, memory, allocate } = siteMachine();
    const loader = await loaderModule.create({}, host);
    const before = [...memory.readBytes(IMAGE.base + 0x73676, 8)];
    const { bound, refused } = loader.bindHooks(
        { hooks: [SITE_ENTRY] }, IMAGE, ()=>0, ()=>()=>true, allocate);
    assert.deepEqual(bound, []);
    assert.deepEqual(refused, ['loop.faces: no stub address was registered']);
    assert.deepEqual([...memory.readBytes(IMAGE.base + 0x73676, 8)], before,
        'the site still runs the guest\'s own code');
});

test('bindHooks wired to the real bridge.siteHook writes a stub address the bridge itself '
    + 'answered', async()=>{
    const { host, memory, allocate } = siteMachine();
    const loader = await loaderModule.create({}, host);

    let nextTrap = 1;
    /** @type {any} */
    const bridgeApis = {
        cpu: {
            readReg32: ()=>0,
            writeReg32: ()=>{},
            registerTrap: ()=>{
                const id = nextTrap++;
                return { id, address: 0x00900000 + id * 16 };
            },
            forwardSave: 32,
            onTrap: ()=>{},
        },
        kernel: {
            currentThread: ()=>({ name: 'main' }),
            threads: ()=>[],
            holdThread: ()=>{},
            parkThread: ()=>{},
            scheduleResume: ()=>{},
        },
        memory,
        log: { begin: ()=>{}, end: ()=>{} },
    };
    const bridge = await bridgeModule.create({}, /** @type {any} */ ({
        /** @param {string} name */ requireApi: name=>bridgeApis[name],
    }));

    /** @type {number[]} */
    const answered = [];
    const { bound, refused } = loader.bindHooks(
        { hooks: [SITE_ENTRY] }, IMAGE,
        /** @param {any} options */ options=>{
            const address = bridge.siteHook(options.name, options);
            answered.push(address);
            return address;
        },
        /** @param {any} entry */ entry=>()=>{
            void entry;
            return true;
        },
        allocate);

    assert.deepEqual(refused, []);
    assert.deepEqual(bound, ['loop.faces']);
    assert.equal(answered.length, 1);
    assert.notEqual(answered[0], 0, 'the bridge placed a real stub');
    const patched = [...memory.readBytes(IMAGE.base + 0x73676, 5)];
    const rel = new DataView(Uint8Array.from(patched.slice(1)).buffer).getInt32(0, true);
    assert.equal(IMAGE.base + 0x73676 + 5 + rel, answered[0],
        'the site jumps to exactly the address the bridge itself answered');

    await bridgeModule.dispose();
});

test('a synthesised module\'s variables are a writable region beside its read-only code',
    async()=>{
        // The runtime writes its own variables -- a standard stream's flags --
        // through the checked host path, which refuses a write to code.
        /** @type {{ name: string, base: number, size: number, access: string }[]} */
        const regions = [];
        const memory = {
            /** @param {any} region */
            register: region=>regions.push({ ...region }),
            writeBytes: ()=>{},
            /** @param {string} name @param {string} access */
            protect(name, access){
                const region = regions.find(entry=>entry.name === name);
                if (region)
                {
                    region.access = access;
                }
            },
            RegionKind: { IMAGE: 'image' },
            Access: { READ_WRITE_EXECUTE: 'rwx', READ_EXECUTE: 'rx', READ_WRITE: 'rw' },
        };
        const host = /** @type {any} */ ({
            requireApi: /** @param {string} name */ name=>({ memory })[name],
        });
        const loader = await loaderModule.create({}, host);
        const base = 0x70000000;
        const placed = loader.synthesise({ name: 'MSVCRT.dll', base, exports: [
            { name: 'exit', target: 0x2000 }, { name: '_iob', data: new Uint8Array(640) }] });

        assert.deepEqual(regions.map(({ name, access })=>({ name, access })), [
            { name: 'MSVCRT.dll', access: 'rx' },
            { name: 'MSVCRT.dll .data', access: 'rw' },
        ]);
        const data = regions[1];
        const iob = /** @type {number} */ (placed.addressOf('_iob'));
        assert.ok(iob >= data.base && iob + 640 <= data.base + data.size);
        assert.equal(regions[0].base + regions[0].size, data.base, 'the two are one image');
        assert.equal(data.base + data.size, base + placed.size);
    });
