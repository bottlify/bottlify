/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_ORDINALS, createUnknownFunctions } from './unknown.js';

const E_FAIL = 0x80004005 | 0;
const E_NOINTERFACE = 0x80004002 | 0;

/**
 * A guest with one object whose methods are host functions by their entry:
 * QueryInterface hands out a service provider for IID_IServiceProvider (or
 * refuses when `provides` is false), and QueryService writes 0x5150 into the
 * out-pointer it is given.
 *
 * @param {{ provides?: boolean }} [options]
 */
function machine({ provides = true } = {}){
    const memory = new Uint8Array(0x2000);
    const view = new DataView(memory.buffer);
    const OBJECT = 0x100, OBJECT_VTABLE = 0x120, PROVIDER = 0x200, PROVIDER_VTABLE = 0x220;
    view.setUint32(OBJECT, OBJECT_VTABLE, true);
    view.setUint32(PROVIDER, PROVIDER_VTABLE, true);
    // Entries are numbers the fake `call` dispatches on.
    [0xa0, 0xa1, 0xa2].forEach((entry, slot)=>
        view.setUint32(OBJECT_VTABLE + slot * 4, entry, true));
    [0xb0, 0xb1, 0xb2, 0xb3].forEach((entry, slot)=>
        view.setUint32(PROVIDER_VTABLE + slot * 4, entry, true));
    /** @type {string[]} */
    const calls = [];
    let next = 0x1000;
    /** @type {number[]} */
    const freed = [];
    const fns = createUnknownFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: bytes=>{
            const at = next;
            next += bytes + 15 & ~15;
            return at;
        },
        free: address=>freed.push(address),
        callerThread: ()=>'main',
        call: (entry, args, thread)=>{
            assert.equal(thread, 'main');
            switch (entry)
            {
                case 0xa0: {
                    const iid = [...memory.subarray(args[1], args[1] + 16)]
                        .map(byte=>byte.toString(16).padStart(2, '0')).join('');
                    calls.push(`QueryInterface ${iid}`);
                    if (!provides)
                    {
                        return E_NOINTERFACE;
                    }
                    view.setUint32(args[2], PROVIDER, true);
                    return 0;
                }
                case 0xb3:
                    calls.push(`QueryService ${args[1].toString(16)} ${args[2].toString(16)}`);
                    view.setUint32(args[3], 0x5150, true);
                    return 0;
                case 0xb2:
                    calls.push('Release');
                    return 0;
                default:
                    throw new Error(`unexpected entry ${entry}`);
            }
        },
    });
    return { memory, view, fns, calls, freed, OBJECT };
}

test('IUnknown_QueryService asks the object\'s service provider and lets it go', async()=>{
    // Wine's shlwapi ordinal test_IUnknown_QueryService: QueryInterface for
    // IServiceProvider, QueryService, Release, in that order.
    const { view, fns, calls, freed, OBJECT } = machine();
    assert.equal(UNKNOWN_ORDINALS[176], 'IUnknown_QueryService');
    assert.equal(fns.IUnknown_QueryService.argBytes, 16);
    view.setUint32(0x800, 0xdead, true);
    assert.equal(await fns.IUnknown_QueryService.handler([OBJECT, 0x700, 0x710, 0x800]), 0);
    assert.equal(view.getUint32(0x800, true), 0x5150);
    assert.deepEqual(calls, [
        'QueryInterface c140516d3674ce11803400aa006009fa',
        'QueryService 700 710',
        'Release',
    ]);
    assert.equal(freed.length, 1, 'its scratch memory given back');
});

test('IUnknown_QueryService answers QueryInterface\'s refusal, and E_FAIL for nothing', async()=>{
    const { view, fns, calls, OBJECT } = machine({ provides: false });
    view.setUint32(0x800, 0xdead, true);
    assert.equal(await fns.IUnknown_QueryService.handler([OBJECT, 0x700, 0x710, 0x800]),
        E_NOINTERFACE);
    assert.equal(view.getUint32(0x800, true), 0, 'NULL written first');
    assert.equal(calls.length, 1);
    view.setUint32(0x800, 0xdead, true);
    assert.equal(await fns.IUnknown_QueryService.handler([0, 0x700, 0x710, 0x800]), E_FAIL);
    assert.equal(view.getUint32(0x800, true), 0);
    assert.equal(await fns.IUnknown_QueryService.handler([OBJECT, 0x700, 0x710, 0]), E_FAIL);
});

/**
 * A guest object whose AddRef and Release are counted, for the references
 * a thread and the process hold, and the slot helpers.
 */
function counted(){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    const OBJECT = 0x100, VTABLE = 0x120;
    view.setUint32(OBJECT, VTABLE, true);
    [0xa0, 0xa1, 0xa2].forEach((entry, slot)=>view.setUint32(VTABLE + slot * 4, entry, true));
    /** @type {string[]} */
    const calls = [];
    let thread = 'main';
    /** @type {any[]} */
    const published = [];
    const fns = createUnknownFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: ()=>0x800,
        free: ()=>{},
        callerThread: ()=>thread,
        call: entry=>{
            calls.push(entry === 0xa1 ? 'AddRef' : entry === 0xa2 ? 'Release' : `${entry}`);
            return 1;
        },
        publish: object=>{
            published.push(object);
            return 0x700;
        },
    });
    return { memory, view, fns: /** @type {any} */ (fns), calls, published, OBJECT,
        /** @param {string} name */
        on: name=>{
            thread = name;
        } };
}

test('a thread\'s reference: kept as given, handed out with one more, then released', async()=>{
    const m = counted();
    assert.equal(await m.fns.SHGetThreadRef.handler([0x40]), E_NOINTERFACE, 'none held');
    assert.equal(m.view.getUint32(0x40, true), 0);
    assert.equal(m.fns.SHSetThreadRef.handler([m.OBJECT]), 0);
    assert.deepEqual(m.calls, [], 'set adds no reference');
    assert.equal(await m.fns.SHGetThreadRef.handler([0x40]), 0);
    assert.equal(m.view.getUint32(0x40, true), m.OBJECT);
    assert.deepEqual(m.calls, ['AddRef']);
    m.on('worker');
    assert.equal(await m.fns.SHGetThreadRef.handler([0x40]), E_NOINTERFACE, 'each thread its own');
    m.on('main');
    assert.equal(await m.fns.SHReleaseThreadRef.handler([]), 0);
    assert.deepEqual(m.calls, ['AddRef', 'Release']);
    assert.equal(await m.fns.SHReleaseThreadRef.handler([]), E_FAIL, 'nothing left to release');
});

test('a thread reference object counts in the caller\'s LONG and answers it', ()=>{
    const m = counted();
    assert.equal(m.fns.SHCreateThreadRef.handler([0x40, 0x44]), 0);
    assert.equal(m.view.getInt32(0x40, true), 1, 'one to start with');
    assert.equal(m.view.getUint32(0x44, true), 0x700);
    const [object] = m.published;
    assert.equal(object.addRef(), 2);
    assert.equal(m.view.getInt32(0x40, true), 2);
    assert.equal(object.release(), 1);
    assert.equal(object.release(), 0);
    assert.equal(object.destroyed, true, 'the last holder let go');
    assert.ok(object.interfaceFor('{00000000-0000-0000-C000-000000000046}'));
    assert.equal(m.fns.SHCreateThreadRef.handler([0, 0x44]), 0x80070057 | 0, 'no LONG');
});

test('the process\'s reference: E_FAIL until set, then handed out with one more', async()=>{
    const m = counted();
    assert.equal(await m.fns.GetProcessReference.handler([0x40]), E_FAIL);
    m.fns.SetProcessReference.handler([m.OBJECT]);
    assert.equal(await m.fns.GetProcessReference.handler([0x40]), 0);
    assert.equal(m.view.getUint32(0x40, true), m.OBJECT);
    assert.deepEqual(m.calls, ['AddRef']);
});

test('IUnknown_AtomicRelease clears the slot before the release; IUnknown_Set swaps', async()=>{
    const m = counted();
    m.view.setUint32(0x40, m.OBJECT, true);
    await m.fns.IUnknown_AtomicRelease.handler([0x40]);
    assert.equal(m.view.getUint32(0x40, true), 0);
    assert.deepEqual(m.calls, ['Release']);
    await m.fns.IUnknown_AtomicRelease.handler([0x40]);
    assert.deepEqual(m.calls, ['Release'], 'an empty slot is left alone');
    await m.fns.IUnknown_Set.handler([0x40, m.OBJECT]);
    assert.equal(m.view.getUint32(0x40, true), m.OBJECT);
    assert.deepEqual(m.calls, ['Release', 'AddRef']);
    await m.fns.IUnknown_Set.handler([0x40, 0]);
    assert.equal(m.view.getUint32(0x40, true), 0);
    assert.deepEqual(m.calls, ['Release', 'AddRef', 'Release']);
    assert.deepEqual([UNKNOWN_ORDINALS[169], UNKNOWN_ORDINALS[199]],
        ['IUnknown_AtomicRelease', 'IUnknown_Set']);
});

/**
 * A guest object of 16 method slots that answers QueryInterface for the
 * interfaces whose first DWORD is in `knows` with itself, and records every
 * method called by its slot; method 3 writes 0x4444 through its first
 * argument when that is a pointer.
 *
 * @param {number[]} knows  the first DWORD of each IID it has
 */
function comObject(knows){
    const memory = new Uint8Array(0x4000);
    const view = new DataView(memory.buffer);
    const OBJECT = 0x100;
    const VTABLE = 0x140;
    view.setUint32(OBJECT, VTABLE, true);
    for (let slot = 0; slot < 16; slot++)
    {
        view.setUint32(VTABLE + slot * 4, 0xc00 + slot, true);
    }
    /** @type {string[]} */
    const calls = [];
    /** @type {string[]} */
    const said = [];
    let next = 0x2000;
    const fns = createUnknownFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: bytes=>{
            const at = next;
            next += bytes + 15 & ~15;
            return at;
        },
        free: ()=>{},
        callerThread: ()=>'main',
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        library: name=>(name === 'KERNEL32.dll' ? {
            CreateThread: { handler: (/** @type {number[]} */ args)=>{
                calls.push(`CreateThread ${args[2].toString(16)} ${args[3].toString(16)}`);
                return 0x77;
            } },
            CloseHandle: { handler: ()=>1 },
        } : undefined),
        call: (entry, args)=>{
            const slot = entry - 0xc00;
            if (entry < 0xc00)
            {
                calls.push(`guest ${entry.toString(16)}(${args.join(',')})`);
                return 0;
            }
            if (slot === 0)
            {
                const first = view.getUint32(args[1], true);
                calls.push(`QI ${first.toString(16)}`);
                if (!knows.includes(first))
                {
                    view.setUint32(args[2], 0, true);
                    return E_NOINTERFACE;
                }
                view.setUint32(args[2], OBJECT, true);
                return 0;
            }
            calls.push(`${slot}(${args.slice(1).join(',')})`);
            if (slot === 3 && args[1] >= 0x2000)
            {
                view.setUint32(args[1], 0x4444, true);
            }
            return 0;
        },
    });
    return { memory, view, fns, calls, said, OBJECT };
}

test('the IUnknown_ helpers ask for their interface, call its method and let it go', async()=>{
    // Wine's ordinal tests: IUnknown_SetSite through IObjectWithSite, and
    // through IInternetSecurityManager where there is none; E_FAIL for no object.
    const OBJECT_WITH_SITE = 0xfc4801a3;
    const SECURITY_MANAGER = 0x79eac9ee;
    const site = comObject([OBJECT_WITH_SITE]);
    assert.equal(await site.fns.IUnknown_SetSite.handler([site.OBJECT, 0x900]), 0);
    assert.deepEqual(site.calls, [`QI ${OBJECT_WITH_SITE.toString(16)}`, '3(2304)', '2()']);
    const security = comObject([SECURITY_MANAGER]);
    await security.fns.IUnknown_SetSite.handler([security.OBJECT, 0x900]);
    assert.deepEqual(security.calls, [`QI ${OBJECT_WITH_SITE.toString(16)}`,
        `QI ${SECURITY_MANAGER.toString(16)}`, '3(2304)', '2()']);
    assert.equal(await site.fns.IUnknown_SetSite.handler([0, 0x900]), E_FAIL);
    const none = comObject([]);
    assert.equal(await none.fns.IUnknown_SetSite.handler([none.OBJECT, 0x900]), E_FAIL);

    const window = comObject([0x114]);
    const out = 0x3000;
    window.view.setUint32(out, 0xdead, true);
    assert.equal(await window.fns.IUnknown_GetWindow.handler([window.OBJECT, out]), 0);
    assert.deepEqual(window.calls.slice(1), [`3(${out})`, '2()']);

    const command = comObject([0xb722bccb]);
    await command.fns.IUnknown_Exec.handler([command.OBJECT, 1, 2, 3, 4, 5]);
    assert.deepEqual(command.calls.slice(1), ['4(1,2,3,4,5)', '2()']);
    await command.fns.MayExecForward.handler([command.OBJECT, 9, 1, 2, 3, 4, 5]);
    assert.deepEqual(command.calls.slice(4), ['4(1,2,3,4,5)', '2()'], 'the reserved word dropped');
    const input = comObject([0x68284faa]);
    await input.fns.IUnknown_HasFocusIO.handler([input.OBJECT]);
    assert.deepEqual(input.calls.slice(1), ['4()', '2()']);
});

test('QISearch finds the interface in the program\'s table, IUnknown as its first entry', async()=>{
    const m = comObject([]);
    const iidA = 0x3100;
    const iidB = 0x3120;
    m.view.setUint32(iidA, 0x11111111, true);
    m.view.setUint32(iidB, 0x22222222, true);
    const table = 0x3200;
    [iidA, 0x0, iidB, 0x8, 0, 0].forEach((value, index)=>m.view.setUint32(table + index * 4,
        value, true));
    const out = 0x3300;
    const base = m.OBJECT;
    assert.equal(await m.fns.QISearch.handler([base, table, iidB, out]), 0);
    assert.equal(m.view.getUint32(out, true), base + 8);
    const unknown = 0x3140;
    m.memory.set([0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46], unknown);
    assert.equal(await m.fns.QISearch.handler([base, table, unknown, out]), 0);
    assert.equal(m.view.getUint32(out, true), base, 'IUnknown: the first entry');
    const other = 0x3160;
    m.view.setUint32(other, 0x33333333, true);
    assert.equal(await m.fns.QISearch.handler([base, table, other, out]), E_NOINTERFACE);
    assert.equal(m.view.getUint32(out, true), 0);
});

test('SHIsSameObject compares identities; SHCreateThread starts the routine on a thread', async()=>{
    const m = comObject([0]);
    assert.equal(await m.fns.SHIsSameObject.handler([m.OBJECT, m.OBJECT]), 1);
    assert.equal(await m.fns.SHIsSameObject.handler([m.OBJECT, 0]), 0);
    assert.equal(await m.fns.SHCreateThread.handler([0x500, 0x600, 0, 0]), 1);
    assert.ok(m.calls.includes('CreateThread 500 600'));
    assert.equal(m.said.length, 0, 'nothing short of Windows');
    await m.fns.SHCreateThread.handler([0x500, 0x600, 0, 0x510]);
    assert.ok(m.calls.includes('guest 510(1536)'), 'the callback, with the data');
    assert.equal(m.said.length, 1);
    assert.equal(UNKNOWN_ORDINALS[16], 'SHCreateThread');
    assert.equal(UNKNOWN_ORDINALS[219], 'QISearch');
});
