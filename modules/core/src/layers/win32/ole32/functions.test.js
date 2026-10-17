/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUID_NULL, GUID_SIZE, formatGuid, parseGuid } from './guid.js';
import { IID_IUNKNOWN, createComObject, createComRegistry } from './objects.js';
import { createOleFunctions, createTaskAllocator } from './functions.js';
import { HKEY_CLASSES_ROOT, createHive } from '../advapi32/registry.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const E_OUTOFMEMORY = 0x8007000e;
const E_INVALIDARG = 0x80070057;
const RPC_E_CHANGED_MODE = 0x80010106;
const CLASS_E_NOAGGREGATION = 0x80040110;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;
const REGDB_E_CLASSNOTREG = 0x80040154;
const CO_E_NOTINITIALIZED = 0x800401f0;
const CO_E_CLASSSTRING = 0x800401f3;

const COINIT_MULTITHREADED = 0x0;
const COINIT_APARTMENTTHREADED = 0x2;
const COINIT_DISABLE_OLE1DDE = 0x4;

const CLSID_TEST = '{11111111-2222-3333-4444-555555555555}';
const IID_TEST = '{6B29FC40-CA47-1067-B31D-00DD010662DA}';
const IID_ABSENT = '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}';

/** Guest addresses the fixtures use; far enough apart that nothing overlaps. */
const CLSID_ARG = 0x1000;
const IID_ARG = 0x1020;
const IID_OTHER_ARG = 0x1040;
const PPV = 0x1100;
const STRING_BUFFER = 0x1200;
const GUID_OUT = 0x1300;

/** Fills a buffer so that "wrote nothing" is distinguishable from "wrote zero". */
const UNTOUCHED = 0xa5a5a5a5;

/**
 * A first-fit allocator is already the kernel32 heap's job; task memory only
 * needs the four operations ole32 asks of one, and a bump allocator answers them
 * without dragging the real heap into this file's fixtures.
 *
 * @param {number} base
 */
function fakeHeap(base = 0x8000){
    /** @type {Map<number, { size: number, capacity: number }>} */
    const live = new Map();
    let next = base;
    const heap = {
        live,
        /** Set to fail every allocation, the way an exhausted arena would. */
        exhausted: false,
        /** @param {number} bytes */
        allocate(bytes){
            if (heap.exhausted)
            {
                return 0;
            }
            const address = next;
            const capacity = Math.max(8, bytes);
            next += capacity;
            live.set(address, { size: bytes, capacity });
            return address;
        },
        /** @param {number} address */
        free: address=>live.delete(address),
        /** @param {number} address */
        block: address=>live.get(address) ?? null,
        /** @param {number} address @param {number} bytes */
        resize(address, bytes){
            const block = live.get(address);
            if (!block || bytes > block.capacity)
            {
                return false;
            }
            block.size = bytes;
            return true;
        },
    };
    return heap;
}

function fakeHost(){
    const bytes = new Uint8Array(0x10000);
    /** Everything the host was told it accepted and did not honour. */
    /** @type {string[]} */
    const reported = [];
    const threads = {
        first: /** @type {any} */ ({ id: 0x100 }),
        second: /** @type {any} */ ({ id: 0x104 }),
    };
    /** @type {any} */
    let current = threads.first;

    /** Every address publish has handed out, keyed the way COM identity is. */
    const published = new Map();
    let nextVtable = 0x20000;

    const host = {
        bytes,
        threads,
        published,
        /** @type {{ pointer: () => number } | undefined} */
        taskAllocator: undefined,
        /** @type {{ load: (name: number) => number, free: (module: number) => number } | undefined} */
        libraries: undefined,
        /**
         * @type {{ root: (id: number) => any, open: (key: any, path: string) => any,
         *          getValue: (key: any, name: string) => { data: Uint8Array } | null }
         *        | undefined}
         */
        hive: undefined,
        /** @param {any} thread */
        run: thread=>{
            current = thread;
        },
        currentThread: ()=>current,
        callerThread: ()=>current,
        heap: fakeHeap(),
        registry: createComRegistry(),
        vtables: {
            /** @param {any} object @param {string} interfaceId */
            publish(object, interfaceId){
                if (host.vtables.exhausted)
                {
                    return 0;
                }
                const record = object.interfaceFor(interfaceId);
                if (!record)
                {
                    return 0;
                }
                // The real bridge answers with one address per interface record;
                // anything else breaks the identity comparison programs make.
                const existing = published.get(record);
                if (existing)
                {
                    return existing;
                }
                nextVtable += 0x100;
                published.set(record, nextVtable);
                return nextVtable;
            },
            exhausted: false,
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} value @param {number} length */
        fillMemory: (address, value, length)=>bytes.fill(value, address, address + length),
        /** @param {number} address */
        u32(address){
            return (bytes[address] | (bytes[address + 1] << 8)
                | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0;
        },
        /** @param {number} address @param {string} guid */
        putGuid(address, guid){
            bytes.set(/** @type {Uint8Array} */ (parseGuid(guid)), address);
            return address;
        },
        /** @param {number} address @param {string} text  Written as UTF-16. */
        putWide(address, text){
            for (let index = 0; index < text.length; index++)
            {
                bytes[address + index * 2] = text.charCodeAt(index) & 0xff;
                bytes[address + index * 2 + 1] = (text.charCodeAt(index) >>> 8) & 0xff;
            }
            bytes[address + text.length * 2] = 0;
            bytes[address + text.length * 2 + 1] = 0;
            return address;
        },
        /** @param {number} address @param {number} count */
        readWide(address, count){
            let text = '';
            for (let index = 0; index < count; index++)
            {
                text += String.fromCharCode(
                    bytes[address + index * 2] | (bytes[address + index * 2 + 1] << 8));
            }
            return text;
        },
        /** @param {number} address @param {number} count */
        reported,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),

        /** @param {number} address @param {number} count */
        fill(address, count){
            for (let index = 0; index < count; index++)
            {
                bytes[address + index * 4] = UNTOUCHED & 0xff;
                bytes[address + index * 4 + 1] = (UNTOUCHED >>> 8) & 0xff;
                bytes[address + index * 4 + 2] = (UNTOUCHED >>> 16) & 0xff;
                bytes[address + index * 4 + 3] = (UNTOUCHED >>> 24) & 0xff;
            }
        },
    };
    return host;
}

/**
 * @param {Object} [options]
 * @param {string[]} [options.interfaces]  Which IIDs the class answers to.
 * @param {boolean} [options.taskAllocator]  Whether the process has an IMalloc to give.
 */
function setup({ interfaces = [IID_TEST], taskAllocator = true } = {}){
    const host = fakeHost();
    if (taskAllocator)
    {
        host.taskAllocator = createTaskAllocator({
            heap: host.heap, registry: host.registry, vtables: host.vtables,
            readMemory: host.readMemory, writeMemory: host.writeMemory,
        });
    }
    /** @type {{ created: any[], destroyed: number }} */
    const log = { created: [], destroyed: 0 };
    host.registry.registerClass(CLSID_TEST, ()=>({
        interfaces: interfaces.map(id=>({
            id,
            methods: [{ name: 'Draw', argBytes: 8 }],
        })),
        destroy: ()=>{
            log.destroyed++;
        },
    }));
    // The factory has no way to report the object it made, so the publish hook
    // -- which every successful creation goes through -- records it instead.
    const publish = host.vtables.publish;
    host.vtables.publish = (object, interfaceId)=>{
        log.created.push(object);
        return publish(object, interfaceId);
    };

    const fns = createOleFunctions(host);
    host.putGuid(CLSID_ARG, CLSID_TEST);
    host.putGuid(IID_ARG, IID_TEST);
    host.putGuid(IID_OTHER_ARG, IID_ABSENT);
    host.fill(PPV, 1);
    return { host, fns, log };
}

/** @param {any} fns @param {number} mode */
const initialize = (fns, mode)=>fns.CoInitializeEx.handler([0, mode]);

/** @param {any} fns */
const createInstance = (fns, { clsid = CLSID_ARG, outer = 0, iid = IID_ARG, ppv = PPV } = {})=>
    fns.CoCreateInstance.handler([clsid, outer, 1, iid, ppv]);

test('CoGetCurrentLogicalThreadId writes a GUID of the calling thread\'s own', ()=>{
    // compobj.c test_CoGetCurrentLogicalThreadId: NULL is refused, and the
    // GUID is never GUID_NULL. It takes a pointer, which a stdcall pops.
    const { host, fns } = setup();
    const OUT = 0x7200;
    /** @returns {string} */
    const read = ()=>[...host.bytes.subarray(OUT, OUT + 16)]
        .map(byte=>byte.toString(16).padStart(2, '0')).join('');
    assert.equal(fns.CoGetCurrentLogicalThreadId.handler([0]), 0x80070057, 'E_INVALIDARG');
    assert.equal(fns.CoGetCurrentLogicalThreadId.handler([OUT]), S_OK);
    const first = read();
    assert.notEqual(first, '0'.repeat(32), 'never GUID_NULL');
    assert.equal(fns.CoGetCurrentLogicalThreadId.handler([OUT]), S_OK);
    assert.equal(read(), first, 'the same for the same thread');
    host.run(host.threads.second);
    fns.CoGetCurrentLogicalThreadId.handler([OUT]);
    assert.notEqual(read(), first, 'and another for another');
});

test('CoInitialize nests and only the matching CoUninitialize leaves', ()=>{
    const { host, fns } = setup();
    assert.equal(fns.CoInitialize.handler(), S_OK);
    assert.equal(host.threads.first.ole32.depth, 1);

    // The second call succeeds, and a program reading FAILED(hr) proceeds; the
    // S_FALSE is what tells it to still balance this one with an Uninitialize.
    assert.equal(fns.CoInitialize.handler(), S_FALSE);
    assert.equal(fns.CoInitialize.handler(), S_FALSE);
    assert.equal(host.threads.first.ole32.depth, 3);

    fns.CoUninitialize.handler();
    fns.CoUninitialize.handler();
    assert.equal(host.threads.first.ole32.depth, 1);
    assert.equal(createInstance(fns), S_OK);

    fns.CoUninitialize.handler();
    assert.equal(host.threads.first.ole32, null);
    assert.equal(createInstance(fns), CO_E_NOTINITIALIZED);
});

test('OleInitialize enters the same apartment as CoInitialize and OleUninitialize leaves it', ()=>{
    const { host, fns } = setup();
    assert.equal(fns.OleInitialize.handler(), S_OK);
    assert.equal(fns.CoInitialize.handler(), S_FALSE);
    assert.equal(host.threads.first.ole32.depth, 2);
    fns.OleUninitialize.handler();
    fns.CoUninitialize.handler();
    assert.equal(host.threads.first.ole32, null);
});

test('an unbalanced CoUninitialize does nothing', ()=>{
    const { host, fns } = setup();
    fns.CoUninitialize.handler();
    assert.equal(host.threads.first.ole32, undefined);
    assert.equal(fns.CoInitialize.handler(), S_OK);
});

test('a second CoInitializeEx with the other model is refused', ()=>{
    const { host, fns } = setup();
    assert.equal(initialize(fns, COINIT_APARTMENTTHREADED), S_OK);
    assert.equal(initialize(fns, COINIT_MULTITHREADED), RPC_E_CHANGED_MODE);
    // The refused call is not one the program will balance, so it must not have
    // counted: an off-by-one here tears the apartment down a call too late.
    assert.equal(host.threads.first.ole32.depth, 1);

    // Flags outside the model bit do not make it a different apartment.
    assert.equal(
        initialize(fns, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE), S_FALSE);
    assert.equal(host.threads.first.ole32.depth, 2);
});

test('the apartment belongs to the thread that entered it', ()=>{
    const { host, fns } = setup();
    assert.equal(initialize(fns, COINIT_APARTMENTTHREADED), S_OK);

    host.run(host.threads.second);
    assert.equal(createInstance(fns), CO_E_NOTINITIALIZED);
    // A different thread may pick a different model without disturbing the first.
    assert.equal(initialize(fns, COINIT_MULTITHREADED), S_OK);
    assert.equal(host.threads.second.ole32.model, COINIT_MULTITHREADED);
    assert.equal(host.threads.first.ole32.model, COINIT_APARTMENTTHREADED);
});

test('a thread that entered no apartment is in the multithreaded one while it exists', ()=>{
    // ole32's compobj tests: the implicit MTA. A thread that never called
    // CoInitialize makes an object while another thread is in the MTA.
    const { host, fns } = setup();
    assert.equal(initialize(fns, COINIT_MULTITHREADED), S_OK);
    host.run(host.threads.second);
    assert.equal(createInstance(fns), S_OK);

    host.run(host.threads.first);
    fns.CoUninitialize.handler();
    host.run(host.threads.second);
    assert.equal(createInstance(fns), CO_E_NOTINITIALIZED, 'and not once it is gone');
});

test('CoGetApartmentType names the apartment, and wants both pointers', ()=>{
    // ole32's compobj tests and every dsound test's apartment check.
    const { host, fns } = setup();
    const TYPE = 0x9000;
    const QUALIFIER = 0x9004;
    const answer = ()=>[fns.CoGetApartmentType.handler([TYPE, QUALIFIER]) >>> 0,
        host.u32(TYPE), host.u32(QUALIFIER)];

    host.bytes.fill(0xef, TYPE, TYPE + 8);
    assert.equal(fns.CoGetApartmentType.handler([TYPE, 0]) >>> 0, 0x80070057);
    assert.equal(fns.CoGetApartmentType.handler([0, QUALIFIER]) >>> 0, 0x80070057);
    assert.equal(host.u32(TYPE), 0xefefefef, 'nothing written for a call missing one');

    assert.deepEqual(answer(), [CO_E_NOTINITIALIZED, 0xffffffff, 0], 'APTTYPE_CURRENT');
    initialize(fns, COINIT_APARTMENTTHREADED);
    assert.deepEqual(answer(), [S_OK, 3, 0], 'the first STA is the main one');
    host.run(host.threads.second);
    initialize(fns, COINIT_APARTMENTTHREADED);
    assert.deepEqual(answer(), [S_OK, 0, 0], 'a second is an STA');
    fns.CoUninitialize.handler();
    host.run(host.threads.first);
    fns.CoUninitialize.handler();

    initialize(fns, COINIT_MULTITHREADED);
    assert.deepEqual(answer(), [S_OK, 1, 0], 'APTTYPE_MTA');
    host.run(host.threads.second);
    assert.deepEqual(answer(), [S_OK, 1, 1], 'APTTYPEQUALIFIER_IMPLICIT_MTA');
});

test('a usage of the multithreaded apartment puts a thread in no apartment in it implicitly', ()=>{
    // What CoIncrementMTAUsage does, and what DirectSound's worker threads do
    // (Wine's dsound tests' apartment checks).
    const { host, fns } = setup();
    const TYPE = 0x9000;
    const QUALIFIER = 0x9004;
    const COOKIE = 0x9008;
    const answer = ()=>[fns.CoGetApartmentType.handler([TYPE, QUALIFIER]) >>> 0,
        host.u32(TYPE), host.u32(QUALIFIER)];
    assert.deepEqual(answer(), [CO_E_NOTINITIALIZED, 0xffffffff, 0]);
    assert.equal(fns.CoIncrementMTAUsage.handler([COOKIE]), S_OK);
    assert.notEqual(host.u32(COOKIE), 0);
    assert.deepEqual(answer(), [S_OK, 1, 1], 'APTTYPEQUALIFIER_IMPLICIT_MTA');
    assert.equal(fns.CoDecrementMTAUsage.handler([host.u32(COOKIE)]), S_OK);
    assert.deepEqual(answer(), [CO_E_NOTINITIALIZED, 0xffffffff, 0]);
    host.registry.mtaUsage.enter();
    assert.deepEqual(answer(), [S_OK, 1, 1], 'held by a system object, as DirectSound holds it');
    host.registry.mtaUsage.leave();
});

test('the thread\'s block points at ole32\'s record, whose flags name the apartment', ()=>{
    // ole32's compobj tests read NtCurrentTeb()->ReservedForOle->flags.
    const { host, fns } = setup();
    const TEB = 0x8000;
    host.threads.first.tebAddress = TEB;
    const flags = ()=>host.u32(host.u32(TEB + 0xf80) + 12);

    initialize(fns, COINIT_APARTMENTTHREADED);
    assert.equal(flags(), 0x80, 'OLETLS_APARTMENTTHREADED');
    fns.CoUninitialize.handler();
    assert.equal(flags(), 0, 'cleared by the last CoUninitialize, the record kept');
    initialize(fns, COINIT_APARTMENTTHREADED | 0x4);
    assert.equal(flags(), 0x80 | 0x40, 'and OLETLS_DISABLE_OLE1DDE when asked');
    fns.CoUninitialize.handler();
    initialize(fns, COINIT_MULTITHREADED);
    assert.equal(flags(), 0x100 | 0x40, 'OLETLS_MULTITHREADED, with DDE disabled');
});

test('CoCreateInstance hands back one reference and an interface pointer', ()=>{
    const { host, fns, log } = setup();
    fns.CoInitialize.handler();
    assert.equal(createInstance(fns), S_OK);

    const pointer = host.u32(PPV);
    assert.notEqual(pointer, 0);
    assert.notEqual(pointer, UNTOUCHED);
    assert.equal(log.created.length, 1);
    assert.equal(log.created[0].refCount, 1);
    assert.equal(log.destroyed, 0);
    // The pointer is the one published for the interface that was asked for.
    assert.equal(host.published.get(log.created[0].interfaceFor(IID_TEST)), pointer);
});

test('an unregistered class and one that cannot be made fail differently', ()=>{
    const { host, fns } = setup();
    fns.CoInitialize.handler();
    host.putGuid(CLSID_ARG, IID_ABSENT);
    assert.equal(createInstance(fns), REGDB_E_CLASSNOTREG);
    assert.equal(host.u32(PPV), 0);

    host.registry.registerClass(IID_ABSENT, ()=>null);
    host.fill(PPV, 1);
    assert.equal(createInstance(fns), CLASS_E_CLASSNOTAVAILABLE);
    assert.equal(host.u32(PPV), 0);
});

test('a class this build does not have is named, not only refused', ()=>{
    // The code alone says "not registered" and nothing else, and which class a
    // program wanted is the difference between a component nobody has built and
    // a filter the game brought with it. A program that is refused takes a
    // different path, usually a quieter one.
    const { host, fns } = setup();
    fns.CoInitialize.handler();
    host.putGuid(CLSID_ARG, IID_ABSENT);

    assert.equal(createInstance(fns), REGDB_E_CLASSNOTREG);
    assert.ok(host.reported.some((/** @type {string} */ line)=>line.includes(IID_ABSENT)),
        'the report names the class that was asked for');
});

test('a class that does not support the interface releases what it made', ()=>{
    const { host, fns, log } = setup();
    fns.CoInitialize.handler();
    assert.equal(createInstance(fns, { iid: IID_OTHER_ARG }), E_NOINTERFACE);
    assert.equal(host.u32(PPV), 0);
    // The object was built and then thrown away; leaking it here would leak one
    // per failed query, which is a shape programs probe interfaces in.
    assert.equal(log.destroyed, 1);
});

test('CoCreateInstance zeroes the out pointer on every failure', ()=>{
    const { host, fns } = setup();
    /** @type {[string, () => number][]} */
    const cases = [
        ['not initialised', ()=>createInstance(fns)],
        ['null clsid', ()=>createInstance(fns, { clsid: 0 })],
        ['null iid', ()=>createInstance(fns, { iid: 0 })],
        ['aggregation', ()=>createInstance(fns, { outer: 0x4000 })],
    ];
    const expected = [CO_E_NOTINITIALIZED, E_INVALIDARG, E_INVALIDARG, CLASS_E_NOAGGREGATION];
    cases.forEach(([name, run], index)=>{
        if (index === 1)
        {
            fns.CoInitialize.handler();
        }
        host.fill(PPV, 1);
        assert.equal(run(), expected[index], name);
        assert.equal(host.u32(PPV), 0, name);
    });

    // With nowhere to write the pointer there is nothing to zero, and the
    // failure is about the argument rather than the state.
    assert.equal(createInstance(fns, { ppv: 0 }), E_POINTER);
});

test('a vtable that cannot be published is out of memory, not a leak', ()=>{
    const { host, fns, log } = setup();
    fns.CoInitialize.handler();
    host.vtables.exhausted = true;
    assert.equal(createInstance(fns), E_OUTOFMEMORY);
    assert.equal(host.u32(PPV), 0);
    assert.equal(log.destroyed, 1);
});

test('one object publishes one IUnknown pointer through either interface', ()=>{
    const { host, fns, log } = setup({ interfaces: [IID_TEST, IID_ABSENT] });
    fns.CoInitialize.handler();
    assert.equal(createInstance(fns), S_OK);
    assert.equal(createInstance(fns, { iid: IID_OTHER_ARG, ppv: PPV + 4 }), S_OK);

    const [object, other] = log.created;
    assert.equal(host.u32(PPV), host.vtables.publish(object, IID_TEST));
    const first = object.interfaceFor(IID_TEST);
    const second = object.interfaceFor(IID_ABSENT);

    // Two interfaces are two pointers, and a program that compared those would
    // conclude they are different objects -- which is why it compares what
    // QueryInterface(IID_IUnknown) answers with instead, and that is one pointer.
    assert.notEqual(host.vtables.publish(first.object, IID_TEST),
        host.vtables.publish(second.object, IID_ABSENT));
    assert.equal(host.vtables.publish(first.object, IID_IUNKNOWN),
        host.vtables.publish(second.object, IID_IUNKNOWN));

    // A separately created object is a separate identity.
    assert.notEqual(host.vtables.publish(object, IID_IUNKNOWN),
        host.vtables.publish(other, IID_IUNKNOWN));
});

test('CoTaskMemAlloc, Free and Realloc behave the way the CRT wrappers expect', ()=>{
    const { host, fns } = setup();
    const first = fns.CoTaskMemAlloc.handler([16]);
    assert.notEqual(first, 0);
    // Zero bytes is still a pointer, because the caller tests it against NULL.
    assert.notEqual(fns.CoTaskMemAlloc.handler([0]), 0);

    host.writeMemory(first, Uint8Array.from([1, 2, 3, 4]));
    const grown = fns.CoTaskMemRealloc.handler([first, 64]);
    assert.notEqual(grown, 0);
    assert.deepEqual(host.readMemory(grown, 4), Uint8Array.from([1, 2, 3, 4]));

    // A NULL pointer makes it an allocation, and a zero size makes it a free.
    assert.notEqual(fns.CoTaskMemRealloc.handler([0, 8]), 0);
    assert.equal(fns.CoTaskMemRealloc.handler([grown, 0]), 0);
    assert.equal(host.heap.block(grown), null);

    fns.CoTaskMemFree.handler([0]);
    fns.CoTaskMemFree.handler([first]);
    assert.equal(host.heap.block(first), null);
});

test('a failed CoTaskMemRealloc leaves the original block alone', ()=>{
    const { host, fns } = setup();
    const address = fns.CoTaskMemAlloc.handler([8]);
    host.writeMemory(address, Uint8Array.from([9, 9, 9, 9]));
    host.heap.exhausted = true;
    assert.equal(fns.CoTaskMemRealloc.handler([address, 4096]), 0);
    assert.ok(host.heap.block(address));
    assert.deepEqual(host.readMemory(address, 4), Uint8Array.from([9, 9, 9, 9]));
});

test('the task allocator is one object over the task heap, and a Release never destroys it', ()=>{
    const { host, fns } = setup();
    const allocator = createTaskAllocator({
        heap: host.heap, registry: host.registry, vtables: host.vtables,
        readMemory: host.readMemory, writeMemory: host.writeMemory,
    });
    const pointer = allocator.pointer();
    assert.notEqual(pointer, 0);
    assert.equal(allocator.pointer(), pointer, 'the same pointer every time');

    const record = [...host.published.entries()].find(([, at])=>at === pointer)?.[0];
    assert.ok(record, 'published through the same vtables COM uses');
    // Two hand-outs, two references for the guest to give back, and the
    // process's own on top: releasing both leaves the object alive.
    assert.equal(record.object.refCount, 3);
    assert.equal(record.object.release(), 2);
    assert.equal(record.object.release(), 1);
    assert.equal(record.object.destroyed, false, 'the process still holds it');
    assert.equal(allocator.pointer(), pointer, 'and hands it out again');
    assert.equal(record.object.refCount, 2);
    const methods = record.methods.map((/** @type {any} */ m)=>m.name);
    assert.deepEqual(methods, ['QueryInterface', 'AddRef', 'Release',
        'Alloc', 'Realloc', 'Free', 'GetSize', 'DidAlloc', 'HeapMinimize']);
    const invoke = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        // As the bridge calls it: the interface pointer already stripped.
        record.methods.find((/** @type {any} */ m)=>m.name === name).invoke(record.object, args);

    // Memory taken through the interface is CoTaskMem memory, and the other
    // way round.
    const block = invoke('Alloc', [16]);
    assert.notEqual(block, 0);
    assert.equal(invoke('GetSize', [block]), 16);
    assert.equal(invoke('DidAlloc', [block]), 1);
    fns.CoTaskMemFree.handler([block]);
    assert.equal(invoke('DidAlloc', [block]), 0);
    const other = fns.CoTaskMemAlloc.handler([8]);
    host.writeMemory(other, Uint8Array.from([5, 6, 7, 8]));
    const grown = invoke('Realloc', [other, 64]);
    assert.deepEqual(host.readMemory(grown, 4), Uint8Array.from([5, 6, 7, 8]));
    assert.equal(invoke('Free', [grown]), 0);
    assert.equal(host.heap.block(grown), null);
    assert.equal(invoke('Free', [0]), 0, 'freeing NULL is nothing');

    // A program releases what SHGetMalloc gave it on the way out; the
    // allocator outlives that.
    const before = record.object.refCount;
    record.object.release();
    assert.equal(record.object.destroyed, false);
    assert.ok(before >= 1);
});

test('CoGetMalloc hands out the task allocator and refuses any other context', ()=>{
    const { host, fns } = setup();
    assert.equal(fns.CoGetMalloc.handler([1, PPV]), S_OK);
    assert.notEqual(host.u32(PPV), 0);
    assert.equal(fns.CoGetMalloc.handler([2, PPV]) | 0, E_INVALIDARG | 0);
    assert.equal(host.u32(PPV), 0);
    assert.equal(fns.CoGetMalloc.handler([1, 0]) | 0, E_INVALIDARG | 0);
});

test('without an allocator to give, CoGetMalloc fails as an allocation would', ()=>{
    const { host, fns } = setup({ taskAllocator: false });
    assert.equal(fns.CoGetMalloc.handler([1, PPV]), E_OUTOFMEMORY);
    assert.equal(host.u32(PPV), 0);
});

test('StringFromGUID2 counts the terminator it writes', ()=>{
    const { host, fns } = setup();
    host.putGuid(GUID_OUT, IID_TEST);
    assert.equal(fns.StringFromGUID2.handler([GUID_OUT, STRING_BUFFER, 39]), 39);
    assert.equal(host.readWide(STRING_BUFFER, 38), IID_TEST);
    assert.equal(host.readWide(STRING_BUFFER + 76, 1), '\0');
});

test('StringFromGUID2 writes nothing into a buffer one character short', ()=>{
    const { host, fns } = setup();
    host.putGuid(GUID_OUT, IID_TEST);
    host.fill(STRING_BUFFER, 20);
    // 38 is the string without its terminator, which is exactly the classic
    // one-off: the count includes it.
    assert.equal(fns.StringFromGUID2.handler([GUID_OUT, STRING_BUFFER, 38]), 0);
    assert.equal(host.u32(STRING_BUFFER), UNTOUCHED);

    assert.equal(fns.StringFromGUID2.handler([GUID_OUT, STRING_BUFFER, 0]), 0);
    assert.equal(fns.StringFromGUID2.handler([GUID_OUT, 0, 39]), 0);
    assert.equal(fns.StringFromGUID2.handler([0, STRING_BUFFER, 39]), 0);
    assert.equal(host.u32(STRING_BUFFER), UNTOUCHED);
});

test('CLSIDFromString and IIDFromString agree with StringFromGUID2', ()=>{
    const { host, fns } = setup();
    host.putWide(STRING_BUFFER, IID_TEST.toLowerCase());
    assert.equal(fns.CLSIDFromString.handler([STRING_BUFFER, GUID_OUT]), S_OK);
    assert.equal(formatGuid(host.readMemory(GUID_OUT, GUID_SIZE)), IID_TEST);

    assert.equal(fns.IIDFromString.handler([STRING_BUFFER, GUID_OUT]), S_OK);
    assert.equal(formatGuid(host.readMemory(GUID_OUT, GUID_SIZE)), IID_TEST);
});

test('a string that is not a GUID fails as the two entry points document', ()=>{
    const { host, fns } = setup();
    host.putWide(STRING_BUFFER, 'Bottlify.Application.1');
    host.putGuid(GUID_OUT, IID_TEST);
    // A ProgID is a CLSID string Windows would look up, so its failure is not an
    // invalid argument; an interface is never named that way, so its is.
    assert.equal(fns.CLSIDFromString.handler([STRING_BUFFER, GUID_OUT]), CO_E_CLASSSTRING);
    assert.equal(formatGuid(host.readMemory(GUID_OUT, GUID_SIZE)), GUID_NULL);

    host.putGuid(GUID_OUT, IID_TEST);
    assert.equal(fns.IIDFromString.handler([STRING_BUFFER, GUID_OUT]), E_INVALIDARG);
    assert.equal(formatGuid(host.readMemory(GUID_OUT, GUID_SIZE)), GUID_NULL);

    assert.equal(fns.CLSIDFromString.handler([STRING_BUFFER, 0]), E_INVALIDARG);
    assert.equal(fns.IIDFromString.handler([STRING_BUFFER, 0]), E_INVALIDARG);

    // A NULL string is the documented way to ask for CLSID_NULL.
    host.putGuid(GUID_OUT, IID_TEST);
    assert.equal(fns.CLSIDFromString.handler([0, GUID_OUT]), S_OK);
    assert.equal(formatGuid(host.readMemory(GUID_OUT, GUID_SIZE)), GUID_NULL);
});

test('an unterminated string cannot be read past a GUID in length', ()=>{
    const { host, fns } = setup();
    for (let index = 0; index < 200; index++)
    {
        host.bytes[STRING_BUFFER + index] = 0x41;
    }
    assert.equal(fns.IIDFromString.handler([STRING_BUFFER, GUID_OUT]), E_INVALIDARG);
});

test('CoCreateGuid makes a version 4 GUID and reports it', ()=>{
    const { host, fns } = setup();
    assert.equal(fns.CoCreateGuid.handler([GUID_OUT]), S_OK);
    const first = host.readMemory(GUID_OUT, GUID_SIZE).slice();
    assert.equal(first[7] & 0xf0, 0x40);
    assert.equal(first[8] & 0xc0, 0x80);

    assert.equal(fns.CoCreateGuid.handler([GUID_OUT]), S_OK);
    assert.notDeepEqual(host.readMemory(GUID_OUT, GUID_SIZE), first);
    assert.equal(fns.CoCreateGuid.handler([0]), E_INVALIDARG);
});

test('IsEqualGUID compares the bytes, not the pointers', ()=>{
    const { host, fns } = setup();
    host.putGuid(GUID_OUT, IID_TEST);
    assert.equal(fns.IsEqualGUID.handler([IID_ARG, GUID_OUT]), 1);
    assert.equal(fns.IsEqualGUID.handler([IID_ARG, IID_ARG]), 1);
    assert.equal(fns.IsEqualGUID.handler([IID_ARG, IID_OTHER_ARG]), 0);
    assert.equal(fns.IsEqualGUID.handler([0, IID_ARG]), 0);
    assert.equal(fns.IsEqualGUID.handler([IID_ARG, 0]), 0);
});

test('CoLoadLibrary and CoFreeLibrary are LoadLibraryW and FreeLibrary under other names', ()=>{
    const { host } = setup();
    /** @type {string[]} */
    const asked = [];
    host.libraries = {
        load: (/** @type {number} */ name)=>{
            asked.push(`load ${name}`);
            return 0x10000000;
        },
        free: (/** @type {number} */ module)=>{
            asked.push(`free ${module}`);
            return 1;
        },
    };
    const fns = createOleFunctions(host);
    assert.equal(fns.CoLoadLibrary.handler([0x1234, 1]), 0x10000000);
    fns.CoFreeLibrary.handler([0x10000000]);
    assert.deepEqual(asked, ['load 4660', 'free 268435456']);

    const without = setup().fns;
    assert.equal(without.CoLoadLibrary.handler([0x1234, 1]), 0, 'nothing to load through');
});

test('StringFromCLSID hands out the string in task memory', ()=>{
    const { host, fns } = setup();
    host.fill(PPV, 1);
    assert.equal(fns.StringFromCLSID.handler([CLSID_ARG, PPV]), 0, 'S_OK');
    const block = host.u32(PPV);
    assert.notEqual(block, 0);
    assert.ok(host.heap.block(block), 'CoTaskMem memory, freed with CoTaskMemFree');
    let text = '';
    for (let at = 0;; at += 2)
    {
        const unit = host.bytes[block + at] | (host.bytes[block + at + 1] << 8);
        if (unit === 0)
        {
            break;
        }
        text += String.fromCharCode(unit);
    }
    assert.equal(text, CLSID_TEST);
    assert.equal(fns.StringFromIID.handler([CLSID_ARG, 0]) >>> 0, 0x80070057, 'E_INVALIDARG');
});

test('ProgIDFromCLSID reads the class key, and an unregistered class has none', ()=>{
    const { host, fns } = setup();
    host.fill(PPV, 1);
    assert.equal(fns.ProgIDFromCLSID.handler([CLSID_ARG, PPV]) >>> 0, 0x80040154,
        'REGDB_E_CLASSNOTREG');
    assert.equal(host.u32(PPV), 0);

    const progId = Uint8Array.from([...'Test.Class.1'].map(c=>c.charCodeAt(0)));
    host.hive = {
        root: ()=>({}),
        open: (key, path)=>(path === `CLSID\\${CLSID_TEST}\\ProgID` ? { progId } : null),
        getValue: key=>({ data: key.progId }),
    };
    const withHive = createOleFunctions(host);
    assert.equal(withHive.ProgIDFromCLSID.handler([CLSID_ARG, PPV]), 0);
    const block = host.u32(PPV);
    assert.ok(host.heap.block(block), 'task memory');
    const units = new Uint16Array(host.bytes.slice(block, block + 24).buffer);
    assert.equal(String.fromCharCode(...units), 'Test.Class.1');
});

test('ProgIDFromCLSID widens the registry\'s bytes as the ANSI page reads them', ()=>{
    // The registry keeps a string in the ANSI page, where 0x80 is the euro
    // sign and 0x99 the trade mark, and the wide ProgID is what
    // MultiByteToWideChar(CP_ACP) makes of those bytes.
    const { host } = setup();
    const progId = Uint8Array.of(0x41, 0x80, 0x99, 0);
    host.hive = {
        root: ()=>({}),
        open: (key, path)=>(path === `CLSID\\${CLSID_TEST}\\ProgID` ? { progId } : null),
        getValue: key=>({ data: key.progId }),
    };
    const fns = createOleFunctions(host);
    assert.equal(fns.ProgIDFromCLSID.handler([CLSID_ARG, PPV]), 0);
    const block = host.u32(PPV);
    assert.equal(String.fromCharCode(...new Uint16Array(host.bytes.slice(block, block + 6).buffer)),
        'A€™');
});

test('CLSIDFromProgID reads the ProgID key, and an unknown ProgID is not a class', ()=>{
    const { host, fns } = setup();
    host.putWide(STRING_BUFFER, 'Test.Class.1');
    host.fill(GUID_OUT, 4);
    assert.equal(fns.CLSIDFromProgID.handler([STRING_BUFFER, GUID_OUT]) >>> 0, CO_E_CLASSSTRING);
    assert.equal(formatGuid(host.bytes.subarray(GUID_OUT, GUID_OUT + GUID_SIZE)), GUID_NULL);

    const clsid = Uint8Array.from([...CLSID_TEST].map(c=>c.charCodeAt(0)));
    host.hive = {
        root: ()=>({}),
        open: (key, path)=>(path === 'Test.Class.1\\CLSID' ? { clsid } : null),
        getValue: key=>({ data: key.clsid }),
    };
    const withHive = createOleFunctions(host);
    assert.equal(withHive.CLSIDFromProgID.handler([STRING_BUFFER, GUID_OUT]), S_OK);
    assert.equal(formatGuid(host.bytes.subarray(GUID_OUT, GUID_OUT + GUID_SIZE)), CLSID_TEST);
    assert.equal(withHive.CLSIDFromProgID.handler([0, GUID_OUT]), E_INVALIDARG);

    assert.equal(withHive.CoReleaseMarshalData.handler([0]), E_INVALIDARG);
    assert.equal(withHive.GetRunningObjectTable.handler([0, PPV]), S_OK);
    const table = host.u32(PPV);
    assert.notEqual(table, 0, 'the running object table');
    assert.equal(withHive.GetRunningObjectTable.handler([0, PPV]), S_OK);
    assert.equal(host.u32(PPV), table, 'one for the process, whoever asks');
    assert.equal(withHive.GetRunningObjectTable.handler([1, PPV]) >>> 0, 0x8000ffff,
        'a reserved word that is not zero is E_UNEXPECTED');
    assert.equal(withHive.CoGetObject.handler([0, 0, 0, 0]), E_POINTER);
});

test('the table declares stdcall argument sizes and nothing else', ()=>{
    const table = /** @type {Record<string, any>} */ (setup().fns);
    const expected = {
        CoInitialize: 4,
        CoInitializeEx: 8,
        CoGetApartmentType: 8,
        CoIncrementMTAUsage: 4,
        CoDecrementMTAUsage: 4,
        CoGetCurrentLogicalThreadId: 4,
        CoGetObjectContext: 8,
        CoGetContextToken: 4,
        CoGetDefaultContext: 12,
        CreateBindCtx: 8,
        CreateItemMoniker: 12,
        CreateFileMoniker: 8,
        CreateClassMoniker: 8,
        CreatePointerMoniker: 8,
        CreateAntiMoniker: 4,
        CreateGenericComposite: 12,
        MkParseDisplayName: 16,
        BindMoniker: 16,
        MonikerCommonPrefixWith: 12,
        MonikerRelativePathTo: 16,
        GetClassFile: 8,
        CoGetInstanceFromFile: 32,
        CoInitializeSecurity: 36,
        CoUninitialize: 0,
        OleInitialize: 4,
        OleUninitialize: 0,
        CreateStreamOnHGlobal: 12,
        CoFreeUnusedLibraries: 0,
        CoFreeAllLibraries: 0,
        CoLoadLibrary: 8,
        CoFreeLibrary: 4,
        CoCreateInstance: 20,
        CoGetClassObject: 20,
        CoRegisterClassObject: 20,
        CoRevokeClassObject: 4,
        CoResumeClassObjects: 0,
        CoSuspendClassObjects: 0,
        CoAddRefServerProcess: 0,
        CoReleaseServerProcess: 0,
        CoLockObjectExternal: 12,
        CoDisconnectObject: 8,
        CoIsHandlerConnected: 4,
        CoGetCurrentProcess: 0,
        CoGetCallContext: 8,
        CoImpersonateClient: 0,
        CoRevertToSelf: 0,
        CoQueryClientBlanket: 28,
        CoQueryProxyBlanket: 32,
        CoCopyProxy: 8,
        CoGetCallerTID: 4,
        CoEnableCallCancellation: 4,
        CoDisableCallCancellation: 4,
        CoRegisterChannelHook: 8,
        CoMarshalHresult: 8,
        CoUnmarshalHresult: 8,
        CoWaitForMultipleHandles: 20,
        CoGetStandardMarshal: 24,
        CoCreateFreeThreadedMarshaler: 8,
        RegisterActiveObject: 16,
        RevokeActiveObject: 8,
        GetActiveObject: 12,
        CLIPFORMAT_UserSize: 12,
        CLIPFORMAT_UserMarshal: 12,
        CLIPFORMAT_UserUnmarshal: 12,
        CLIPFORMAT_UserFree: 8,
        HWND_UserSize: 12,
        HWND_UserMarshal: 12,
        HWND_UserUnmarshal: 12,
        HWND_UserFree: 8,
        HMENU_UserSize: 12,
        HMENU_UserMarshal: 12,
        HMENU_UserUnmarshal: 12,
        HMENU_UserFree: 8,
        HACCEL_UserSize: 12,
        HACCEL_UserMarshal: 12,
        HACCEL_UserUnmarshal: 12,
        HACCEL_UserFree: 8,
        HICON_UserSize: 12,
        HICON_UserMarshal: 12,
        HICON_UserUnmarshal: 12,
        HICON_UserFree: 8,
        HBRUSH_UserSize: 12,
        HBRUSH_UserMarshal: 12,
        HBRUSH_UserUnmarshal: 12,
        HBRUSH_UserFree: 8,
        HDC_UserSize: 12,
        HDC_UserMarshal: 12,
        HDC_UserUnmarshal: 12,
        HDC_UserFree: 8,
        HPALETTE_UserSize: 12,
        HPALETTE_UserMarshal: 12,
        HPALETTE_UserUnmarshal: 12,
        HPALETTE_UserFree: 8,
        HGLOBAL_UserSize: 12,
        HGLOBAL_UserMarshal: 12,
        HGLOBAL_UserUnmarshal: 12,
        HGLOBAL_UserFree: 8,
        HBITMAP_UserSize: 12,
        HBITMAP_UserMarshal: 12,
        HBITMAP_UserUnmarshal: 12,
        HBITMAP_UserFree: 8,
        HENHMETAFILE_UserSize: 12,
        HENHMETAFILE_UserMarshal: 12,
        HENHMETAFILE_UserUnmarshal: 12,
        HENHMETAFILE_UserFree: 8,
        HMETAFILE_UserSize: 12,
        HMETAFILE_UserMarshal: 12,
        HMETAFILE_UserUnmarshal: 12,
        HMETAFILE_UserFree: 8,
        HMETAFILEPICT_UserSize: 12,
        HMETAFILEPICT_UserMarshal: 12,
        HMETAFILEPICT_UserUnmarshal: 12,
        HMETAFILEPICT_UserFree: 8,
        SNB_UserSize: 12,
        SNB_UserMarshal: 12,
        SNB_UserUnmarshal: 12,
        SNB_UserFree: 8,
        STGMEDIUM_UserSize: 12,
        STGMEDIUM_UserMarshal: 12,
        STGMEDIUM_UserUnmarshal: 12,
        STGMEDIUM_UserFree: 8,
        WdtpInterfacePointer_UserSize: 20,
        WdtpInterfacePointer_UserMarshal: 20,
        WdtpInterfacePointer_UserUnmarshal: 16,
        WdtpInterfacePointer_UserFree: 4,
        CoSetProxyBlanket: 32,
        CoCreateGuid: 4,
        CoTaskMemAlloc: 4,
        CoTaskMemFree: 4,
        CoTaskMemRealloc: 8,
        CoGetMalloc: 8,
        StringFromGUID2: 12,
        CoTreatAsClass: 8,
        ProgIDFromCLSID: 8,
        StgCreateDocfile: 16,
        StgOpenStorage: 24,
        StgIsStorageFile: 4,
        StgIsStorageILockBytes: 4,
        StgCreateStorageEx: 32,
        CreateILockBytesOnHGlobal: 12,
        GetHGlobalFromILockBytes: 8,
        StgCreateDocfileOnILockBytes: 16,
        StgOpenStorageOnILockBytes: 24,
        GetHGlobalFromStream: 8,
        CoMarshalInterThreadInterfaceInStream: 12,
        CoGetInterfaceAndReleaseStream: 12,
        WriteClassStm: 8,
        ReadClassStm: 8,
        WriteClassStg: 8,
        ReadClassStg: 8,
        OleLoadFromStream: 12,
        OleSaveToStream: 8,
        CLSIDFromProgID: 8,
        CoReleaseMarshalData: 4,
        CoMarshalInterface: 24,
        CoUnmarshalInterface: 12,
        CoGetMarshalSizeMax: 24,
        CoGetPSClsid: 8,
        CoRegisterPSClsid: 8,
        GetRunningObjectTable: 8,
        CoGetObject: 16,
        StringFromCLSID: 8,
        StringFromIID: 8,
        CLSIDFromString: 8,
        IIDFromString: 8,
        IsEqualGUID: 8,
        RegisterDragDrop: 8,
        RevokeDragDrop: 4,
        OleFlushClipboard: 0,
        OleIsCurrentClipboard: 4,
        OleSetMenuDescriptor: 20,
        FreePropVariantArray: 8,
        ReleaseStgMedium: 4,
        StgOpenStorageEx: 32,
        CLSIDFromProgIDEx: 8,
        CoIsOle1Class: 4,
        CoFileTimeNow: 4,
        CoAllowSetForegroundWindow: 8,
        CoSetState: 4,
        CoGetState: 4,
        CoSwitchCallContext: 8,
        OleRun: 4,
        OleIsRunning: 4,
        OleLockRunning: 12,
        OleSetContainedObject: 8,
        OleDraw: 16,
        OleSave: 12,
        OleCreate: 28,
        OleLoad: 16,
        OleRegGetUserType: 12,
        OleRegGetMiscStatus: 12,
        OleRegEnumVerbs: 8,
        OleGetAutoConvert: 8,
        OleDoAutoConvert: 8,
        WriteFmtUserTypeStg: 12,
        ReadFmtUserTypeStg: 12,
        SetConvertStg: 8,
        GetConvertStg: 4,
        IsAccelerator: 16,
        OleTranslateAccelerator: 12,
        OleCreateMenuDescriptor: 8,
        OleDestroyMenuDescriptor: 4,
        DoDragDrop: 16,
        OleQueryCreateFromData: 4,
        OleQueryLinkFromData: 4,
        OleCreateFromData: 28,
        OleCreateLinkFromData: 28,
        OleCreateStaticFromData: 28,
        OleDuplicateData: 12,
        OleCreateFromFile: 32,
        OleCreateLinkToFile: 28,
        OleCreateLink: 28,
        CreateDataCache: 16,
        OleGetIconOfClass: 12,
        OleConvertIStorageToOLESTREAM: 8,
        OleConvertOLESTREAMToIStorage: 12,
        CreateDataAdviseHolder: 4,
        CreateOleAdviseHolder: 4,
        OleSetClipboard: 4,
        OleGetClipboard: 4,
        CoCreateInstanceEx: 24,
        CoRegisterMessageFilter: 8,
        PropVariantCopy: 8,
        PropVariantClear: 4,
    };
    assert.deepEqual(Object.keys(table).sort(), Object.keys(expected).sort());
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(table[name].argBytes, argBytes, name);
        // stdcall is the bridge's default; naming it here would be the one place
        // it could disagree with the stub the bridge emits.
        assert.equal('convention' in table[name], false, name);
    }
});

// --- class objects ---

const CLSID_GUEST = '{12345678-0000-0000-0000-00000000C0DE}';
const GUEST_CLSID_ARG = 0x1060;
/** A guest object: its vtable pointer, and a vtable whose slots are addresses by slot. */
const GUEST_OBJECT = 0x3000;
const GUEST_VTABLE = 0x3100;
const METHOD_BASE = 0x5000;
const CREATED = 0x4444;

/**
 * A host whose guest calls are recorded: each method of the guest object is
 * named by its slot, and CreateInstance answers with CREATED.
 *
 * @param {Parameters<typeof setup>[0]} [options]
 */
function withGuestCalls(options){
    const context = setup(options);
    const { host } = context;
    host.putGuid(GUEST_CLSID_ARG, CLSID_GUEST);
    const view = new DataView(host.bytes.buffer);
    view.setUint32(GUEST_OBJECT, GUEST_VTABLE, true);
    for (let slot = 0; slot < 5; slot++)
    {
        view.setUint32(GUEST_VTABLE + slot * 4, METHOD_BASE + slot * 0x10, true);
    }
    /** @type {{ slot: number, args: number[] }[]} */
    const calls = [];
    /** @param {number} entry @param {number[]} args */
    const answer = async(entry, args)=>{
        const slot = (entry - METHOD_BASE) / 0x10;
        calls.push({ slot, args });
        if (slot === 3)
        {
            view.setUint32(args[3], CREATED, true);
        }
        return 0;
    };
    /** @type {any} */ (host).call = answer;
    const fns = createOleFunctions(/** @type {any} */ (host));
    initialize(fns, COINIT_APARTMENTTHREADED);
    return { ...context, fns, calls, view };
}

test('a class object the program registers is what CoCreateInstance asks, outer and all', async()=>{
    const { fns, host, calls } = withGuestCalls();
    const COOKIE = 0x1400;

    assert.equal(await fns.CoRegisterClassObject.handler(
        [GUEST_CLSID_ARG, GUEST_OBJECT, 1, 0, COOKIE]), S_OK);
    assert.deepEqual(calls.map(call=>call.slot), [1], 'the registration holds a reference');
    const cookie = host.u32(COOKIE);

    const OUTER = 0x6000;
    assert.equal(await fns.CoCreateInstance.handler([GUEST_CLSID_ARG, OUTER, 1, IID_ARG, PPV]),
        S_OK);
    assert.deepEqual(calls[1], { slot: 3, args: [GUEST_OBJECT, OUTER, IID_ARG, PPV] },
        'its own CreateInstance, with the outer unknown: aggregation is the class\'s to allow');
    assert.equal(host.u32(PPV), CREATED);

    assert.equal(await fns.CoRevokeClassObject.handler([cookie]), S_OK);
    assert.equal(calls[2].slot, 2, 'revoking releases what the registration held');
    assert.equal(await fns.CoRevokeClassObject.handler([cookie]), 0x800401fb, 'CO_E_OBJNOTREG');
    assert.equal(fns.CoCreateInstance.handler([GUEST_CLSID_ARG, 0, 1, IID_ARG, PPV]),
        REGDB_E_CLASSNOTREG);
});

test('CoCreateInstanceEx makes the object once and asks it for every interface in the array',
    async()=>{
        // compobj.c test_CoCreateInstanceEx: each MULTI_QI told its own answer.
        const { fns, host, view } = withGuestCalls();
        await fns.CoRegisterClassObject.handler([GUEST_CLSID_ARG, GUEST_OBJECT, 1, 0, 0x1400]);
        view.setUint32(CREATED, GUEST_VTABLE, true);
        /** @type {number[][]} */
        const asked = [];
        /** @param {number} entry @param {number[]} args */
        const call = async(entry, args)=>{
            const slot = (entry - METHOD_BASE) / 0x10;
            if (slot === 3)
            {
                view.setUint32(args[3], CREATED, true);
                return S_OK;
            }
            if (slot === 0)
            {
                asked.push(args.slice(1));
                if (args[1] === IID_OTHER_ARG)
                {
                    return 0x80004002;
                }
                view.setUint32(args[2], CREATED, true);
            }
            return S_OK;
        };
        /** @type {any} */ (host).call = call;
        const RESULTS = 0x7000;
        [IID_ARG, IID_OTHER_ARG, IID_ARG].forEach((iid, index)=>{
            view.setUint32(RESULTS + index * 12, iid, true);
            view.setUint32(RESULTS + index * 12 + 4, 0xdead, true);
            view.setUint32(RESULTS + index * 12 + 8, 0xbeef, true);
        });
        assert.equal(fns.CoCreateInstanceEx.handler([GUEST_CLSID_ARG, 0, 1, 0, 0, RESULTS]),
            0x80070057, 'E_INVALIDARG for an empty array');
        assert.equal(await fns.CoCreateInstanceEx.handler([GUEST_CLSID_ARG, 0, 1, 0, 3,
            RESULTS]), 0x00080012, 'CO_S_NOTALLINTERFACES');
        assert.deepEqual([0, 1, 2].map(index=>[host.u32(RESULTS + index * 12 + 4),
            host.u32(RESULTS + index * 12 + 8)]),
        [[CREATED, S_OK], [0, 0x80004002], [CREATED, S_OK]]);
        assert.deepEqual(asked, [[IID_OTHER_ARG, RESULTS + 16], [IID_ARG, RESULTS + 28]],
            'the first interface is the one it was made with, the rest asked of it');
    });

test('a single-threaded apartment keeps one message filter and hands back the one replaced',
    async()=>{
        // compobj.c test_CoRegisterMessageFilter.
        const { fns, host, calls, view } = withGuestCalls();
        const PREVIOUS = 0x7100;
        host.currentThread().ole32 = null;
        assert.equal(fns.CoRegisterMessageFilter.handler([GUEST_OBJECT, PREVIOUS]), 0x80004021,
            'no apartment, no filter: CO_E_NOT_SUPPORTED');
        initialize(fns, 0);
        assert.equal(fns.CoRegisterMessageFilter.handler([GUEST_OBJECT, PREVIOUS]), 0x80004021,
            'nor in the multithreaded apartment');
        await fns.CoUninitialize.handler();
        initialize(fns, COINIT_APARTMENTTHREADED);
        calls.length = 0;
        view.setUint32(PREVIOUS, 0xdead, true);
        assert.equal(await fns.CoRegisterMessageFilter.handler([0, PREVIOUS]), S_OK);
        assert.equal(host.u32(PREVIOUS), 0, 'there was none before');
        assert.equal(await fns.CoRegisterMessageFilter.handler([GUEST_OBJECT, PREVIOUS]), S_OK);
        assert.equal(host.u32(PREVIOUS), 0);
        assert.deepEqual(calls.map(call=>call.slot), [1], 'the filter is held');
        assert.equal(await fns.CoRegisterMessageFilter.handler([0, 0]), S_OK);
        assert.deepEqual(calls.map(call=>call.slot), [1, 2],
            'and let go of when the caller does not take it back');
    });

test('the last CoUninitialize revokes the class objects its apartment registered', async()=>{
    const { fns, calls } = withGuestCalls();
    await fns.CoRegisterClassObject.handler([GUEST_CLSID_ARG, GUEST_OBJECT, 1, 0, 0x1400]);

    await fns.CoUninitialize.handler();

    assert.deepEqual(calls.map(call=>call.slot), [1, 2]);
    initialize(fns, COINIT_APARTMENTTHREADED);
    assert.equal(fns.CoCreateInstance.handler([GUEST_CLSID_ARG, 0, 1, IID_ARG, PPV]),
        REGDB_E_CLASSNOTREG, 'and it is gone');
});

test('CoGetClassObject hands out a class factory over a class built in here', ()=>{
    const { fns, host, log } = setup();
    initialize(fns, COINIT_APARTMENTTHREADED);
    host.putGuid(0x1080, '{00000001-0000-0000-C000-000000000046}');
    /** @type {any} */ (host).makeObject = createComObject;
    const factoryFns = createOleFunctions(/** @type {any} */ (host));
    initialize(factoryFns, COINIT_APARTMENTTHREADED);

    assert.equal(factoryFns.CoGetClassObject.handler([CLSID_ARG, 1, 0, 0x1080, PPV]), S_OK);
    assert.notEqual(host.u32(PPV), 0);
    const factory = log.created.at(-1);
    const method = factory.interfaceFor('{00000001-0000-0000-C000-000000000046}').methods[3];
    const INTO = 0x1500;
    assert.equal(method.invoke(factory, [0, IID_ARG, INTO]), S_OK);
    assert.notEqual(host.u32(INTO), 0, 'an object of the class');
    assert.equal(method.invoke(factory, [0x6000, IID_ARG, INTO]), CLASS_E_NOAGGREGATION,
        'and a built-in class still refuses to be aggregated');
    void fns;
});

test('a class the registry names an InprocServer32 for is made by the server\'s class object',
    async()=>{
        const { fns, host, calls, view } = withGuestCalls();
        const MODULE = 0x7000000;
        const DLL_GET_CLASS_OBJECT = METHOD_BASE + 0x100;
        const path = 'C:\\GAME\\FILTER.DLL';
        /** @type {string[]} */
        const loaded = [];
        /** @type {any} */ (host).hive = {
            root: ()=>'HKCR',
            /** @param {any} _root @param {string} key */
            open: (_root, key)=>(key.toUpperCase() === `CLSID\\${CLSID_GUEST}\\INPROCSERVER32`
                ? key : null),
            getValue: ()=>({
                data: Uint8Array.from([...path].map(c=>c.charCodeAt(0)).concat([0])),
            }),
        };
        /** @param {number} address */
        const text = address=>{
            let read = '';
            for (let at = address; host.bytes[at] !== 0; at++)
            {
                read += String.fromCharCode(host.bytes[at]);
            }
            return read;
        };
        /** @type {any} */ (host).libraries = {
            load: ()=>0,
            free: ()=>0,
            /** @param {number} name */
            loadAnsi: name=>{
                loaded.push(text(name));
                return MODULE;
            },
            /** @param {number} module @param {number} name */
            procAddress: (module, name)=>(module === MODULE && text(name) === 'DllGetClassObject'
                ? DLL_GET_CLASS_OBJECT : 0),
        };
        const methods = /** @type {any} */ (host).call;
        /** @param {number} entry @param {number[]} args */
        const serve = async(entry, args)=>{
            if (entry === DLL_GET_CLASS_OBJECT)
            {
                calls.push({ slot: -1, args });
                view.setUint32(args[2], GUEST_OBJECT, true);
                return 0;
            }
            return methods(entry, args);
        };
        /** @type {any} */ (host).call = serve;
        const served = createOleFunctions(/** @type {any} */ (host));
        initialize(served, COINIT_APARTMENTTHREADED);

        assert.equal(await served.CoCreateInstance.handler([GUEST_CLSID_ARG, 0, 1, IID_ARG, PPV]),
            S_OK);
        assert.deepEqual(loaded, [path]);
        assert.equal(calls[0].args[0], GUEST_CLSID_ARG,
            'DllGetClassObject gets the program\'s CLSID');
        assert.deepEqual(calls.slice(1).map(made=>made.slot), [3, 2],
            'then CreateInstance on the class object, which is let go');
        assert.equal(host.u32(PPV), CREATED);
        void fns;
    });

test('a server path written REG_EXPAND_SZ is loaded with its variables expanded', async()=>{
    // msxml4 registers %SystemRoot%\system32\msxml4.dll; loaded as written, no
    // such file exists and the class is never made.
    const { host, view } = withGuestCalls();
    const MODULE = 0x7000000;
    const DLL_GET_CLASS_OBJECT = METHOD_BASE + 0x100;
    const path = '%systemroot%\\system32\\msxml4.dll %UNSET%';
    /** @type {string[]} */
    const loaded = [];
    /** @type {any} */ (host).environment = ()=>({ SystemRoot: 'C:\\WINDOWS' });
    /** @type {any} */ (host).hive = {
        root: ()=>'HKCR',
        /** @param {any} _root @param {string} key */
        open: (_root, key)=>(key.toUpperCase() === `CLSID\\${CLSID_GUEST}\\INPROCSERVER32`
            ? key : null),
        getValue: ()=>({ type: 2,
            data: Uint8Array.from([...path].map(c=>c.charCodeAt(0)).concat([0])) }),
    };
    /** @param {number} address */
    const text = address=>{
        let read = '';
        for (let at = address; host.bytes[at] !== 0; at++)
        {
            read += String.fromCharCode(host.bytes[at]);
        }
        return read;
    };
    /** @type {any} */ (host).libraries = {
        load: ()=>0,
        free: ()=>0,
        /** @param {number} name */
        loadAnsi: name=>{
            loaded.push(text(name));
            return MODULE;
        },
        /** @param {number} module @param {number} name */
        procAddress: (module, name)=>(module === MODULE && text(name) === 'DllGetClassObject'
            ? DLL_GET_CLASS_OBJECT : 0),
    };
    const methods = /** @type {any} */ (host).call;
    /** @type {any} */ (host).call = async(/** @type {number} */ entry, /** @type {number[]} */ args)=>{
        if (entry === DLL_GET_CLASS_OBJECT)
        {
            view.setUint32(args[2], GUEST_OBJECT, true);
            return 0;
        }
        return methods(entry, args);
    };
    const served = createOleFunctions(/** @type {any} */ (host));
    initialize(served, COINIT_APARTMENTTHREADED);
    await served.CoCreateInstance.handler([GUEST_CLSID_ARG, 0, 1, IID_ARG, PPV]);
    assert.deepEqual(loaded, ['C:\\WINDOWS\\system32\\msxml4.dll %UNSET%'],
        'any case of the name; one with no variable is left as written');
});

test('a DLL a surrogate would serve as a local server is made in process, and said to be',
    async()=>{
        const { host, calls, view } = withGuestCalls();
        const MODULE = 0x7000000;
        const DLL_GET_CLASS_OBJECT = METHOD_BASE + 0x100;
        const APP_ID = '{0A0B0C0D-0000-0000-0000-0000000000A1}';
        /** @param {string} text */
        const ansi = text=>({
            data: Uint8Array.from([...text].map(c=>c.charCodeAt(0)).concat([0])),
        });
        /** @type {any} */ (host).hive = {
            root: ()=>'HKCR',
            /** @param {any} _root @param {string} key */
            open: (_root, key)=>([`CLSID\\${CLSID_GUEST}\\INPROCSERVER32`, `CLSID\\${CLSID_GUEST}`,
                `APPID\\${APP_ID}`].includes(key.toUpperCase()) ? key.toUpperCase() : null),
            /** @param {string} key @param {string} name */
            getValue: (key, name)=>(key.endsWith('INPROCSERVER32') ? ansi('C:\\FMSI.DLL')
                : name === 'AppID' ? ansi(APP_ID) : name === 'DllSurrogate' ? ansi('') : null),
        };
        /** @type {any} */ (host).libraries = {
            load: ()=>0,
            free: ()=>0,
            loadAnsi: ()=>MODULE,
            procAddress: ()=>DLL_GET_CLASS_OBJECT,
        };
        const methods = /** @type {any} */ (host).call;
        /** @param {number} entry @param {number[]} args */
        const serve = async(entry, args)=>{
            if (entry === DLL_GET_CLASS_OBJECT)
            {
                calls.push({ slot: -1, args });
                view.setUint32(args[2], GUEST_OBJECT, true);
                return 0;
            }
            return methods(entry, args);
        };
        /** @type {any} */ (host).call = serve;
        const served = createOleFunctions(/** @type {any} */ (host));
        initialize(served, COINIT_APARTMENTTHREADED);

        const CLSCTX_LOCAL_SERVER = 4;
        assert.equal(await served.CoCreateInstance.handler([GUEST_CLSID_ARG, 0, CLSCTX_LOCAL_SERVER,
            IID_ARG, PPV]), S_OK);
        assert.equal(host.u32(PPV), CREATED, 'made by the DLL\'s class object');
        assert.ok(host.reported.some(text=>text.includes('surrogate')));
        assert.equal(/** @type {any} */ (host).registry.mtaUsage?.users, 1,
            'the multithreaded apartment a surrogate runs its DLL in is open');
    });

// --- drag and drop, and the OLE clipboard ---

const E_FAIL = 0x80004005;
const DRAGDROP_E_NOTREGISTERED = 0x80040100;
const DRAGDROP_E_ALREADYREGISTERED = 0x80040101;
const DRAGDROP_E_INVALIDHWND = 0x80040102;
const WINDOW = 0x10040;

/**
 * The guest-call host with one live window, the way user32 would answer for
 * it, and the apartment left for the test to enter.
 */
function withWindow(){
    const context = withGuestCalls();
    const { host, calls } = context;
    const live = new Set([WINDOW]);
    /** @type {any} */ (host).isWindow = (/** @type {number} */ window)=>live.has(window);
    const fns = createOleFunctions(/** @type {any} */ (host));
    host.currentThread().ole32 = null;
    calls.length = 0;
    return { ...context, fns, live };
}

test('a menu descriptor taken off a frame, or put on one, is answered S_OK', ()=>{
    // compobj.c test_ole_menu: NULL removes the dispatching from a frame.
    const { fns } = withWindow();
    assert.equal(fns.OleSetMenuDescriptor.handler([0, WINDOW, 0, 0, 0]), S_OK);
    assert.equal(fns.OleSetMenuDescriptor.handler([0x1234, WINDOW, 0, 0, 0]), S_OK);
    assert.equal(fns.OleSetMenuDescriptor.handler([0x1234, 0xdeadbeef, 0, 0, 0]), E_INVALIDARG,
        'a composite menu needs a frame to hang on');
});

test('a drop target is registered once per window and holds a reference until revoked',
    async()=>{
        // dragdrop.c test_Register_Revoke.
        const { fns, calls, live } = withWindow();
        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]), E_OUTOFMEMORY,
            'OLE was never initialised in this process');
        assert.equal(fns.OleInitialize.handler(), S_OK);
        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, 0]), E_INVALIDARG);
        assert.equal(await fns.RegisterDragDrop.handler([0, GUEST_OBJECT]),
            DRAGDROP_E_INVALIDHWND);
        assert.equal(await fns.RegisterDragDrop.handler([0xdeadbeef, GUEST_OBJECT]),
            DRAGDROP_E_INVALIDHWND);
        assert.equal(calls.length, 0, 'no reference is taken by a refusal');

        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]), S_OK);
        assert.deepEqual(calls.map(call=>call.slot), [1], 'AddRef');
        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]),
            DRAGDROP_E_ALREADYREGISTERED);

        assert.equal(await fns.RevokeDragDrop.handler([WINDOW]), S_OK);
        assert.deepEqual(calls.map(call=>call.slot), [1, 2], 'Release');
        assert.equal(await fns.RevokeDragDrop.handler([WINDOW]), DRAGDROP_E_NOTREGISTERED);
        assert.equal(await fns.RevokeDragDrop.handler([0]), DRAGDROP_E_INVALIDHWND);

        // A window destroyed with its target still registered.
        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]), S_OK);
        live.delete(WINDOW);
        assert.equal(await fns.RevokeDragDrop.handler([WINDOW]), DRAGDROP_E_INVALIDHWND);
        live.add(WINDOW);
        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]), S_OK,
            'a new window with the same handle starts with nothing registered');
    });

test('a registered drop target is its window\'s OleDropTargetInterface property until revoked',
    async()=>{
        // dragdrop.c test_Register_Revoke: GetPropA(hwnd, "OleDropTargetInterface")
        // is the IDropTarget pointer RegisterDragDrop was given.
        const { fns, host } = withWindow();
        /** @type {Map<number, Map<string, number>>} */
        const properties = new Map();
        /** @param {number} at */
        const nameAt = at=>
            String.fromCharCode(...host.bytes.subarray(at, host.bytes.indexOf(0, at)));
        /** @param {number} window */
        const of = window=>properties.get(window) ?? properties.set(window, new Map()).get(window);
        /** @type {any} */ (host).windowProperty = {
            /** @param {number} window @param {number} name @param {number} value */
            set: (window, name, value)=>{
                /** @type {Map<string, number>} */ (of(window)).set(nameAt(name), value);
                return 1;
            },
            /** @param {number} window @param {number} name */
            remove: (window, name)=>{
                const held = of(window)?.get(nameAt(name)) ?? 0;
                of(window)?.delete(nameAt(name));
                return held;
            },
        };
        const OTHER_TARGET = GUEST_OBJECT + 0x40;
        assert.equal(fns.OleInitialize.handler(), S_OK);
        const blocks = host.heap.live.size;

        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]), S_OK);
        assert.equal(properties.get(WINDOW)?.get('OleDropTargetInterface'), GUEST_OBJECT);
        assert.equal(host.heap.live.size, blocks, 'the name is not kept in guest memory');
        assert.equal(await fns.RegisterDragDrop.handler([WINDOW, OTHER_TARGET]),
            DRAGDROP_E_ALREADYREGISTERED);
        assert.equal(properties.get(WINDOW)?.get('OleDropTargetInterface'), GUEST_OBJECT,
            'a refusal leaves it as it was');

        assert.equal(await fns.RevokeDragDrop.handler([WINDOW]), S_OK);
        assert.equal(properties.get(WINDOW)?.has('OleDropTargetInterface'), false,
            'and it goes with the target');
        assert.equal(host.heap.live.size, blocks);
    });

test('once OLE has run, a thread without an apartment is told it is not initialised', async()=>{
    // dragdrop.c test_mismatched_cleanup: OleInitialize, then CoUninitialize.
    const { fns } = withWindow();
    assert.equal(fns.OleInitialize.handler(), S_OK);
    await fns.CoUninitialize.handler();
    assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]), CO_E_NOTINITIALIZED);
    assert.equal(initialize(fns, COINIT_MULTITHREADED), S_OK);
    assert.equal(await fns.RegisterDragDrop.handler([WINDOW, GUEST_OBJECT]), S_OK,
        'any apartment will do');
});

test('flushing the OLE clipboard needs an apartment, and what was never set is not current',
    async()=>{
        // clipboard.c: OleFlushClipboard is E_FAIL before COM is initialised
        // and S_OK after, and OleIsCurrentClipboard is S_FALSE for what was
        // never set.
        const { fns } = withWindow();
        assert.equal((await fns.OleFlushClipboard.handler()) >>> 0, E_FAIL);
        assert.equal(fns.OleIsCurrentClipboard.handler([GUEST_OBJECT]), S_FALSE);
        assert.equal(fns.OleInitialize.handler(), S_OK);
        assert.equal(await fns.OleFlushClipboard.handler(), S_OK);
        assert.equal(fns.OleIsCurrentClipboard.handler([0]), S_FALSE);
    });

test('CoTreatAsClass writes the emulation into the registry, and GUID_NULL takes it away', ()=>{
    const { host } = setup();
    const hive = createHive();
    host.hive = hive;
    const fns = createOleFunctions(host);
    const NEW_ARG = 0x1040;
    const replacement = '{66666666-7777-8888-9999-AAAAAAAAAAAA}';
    host.bytes.set(/** @type {Uint8Array} */ (parseGuid(replacement)), NEW_ARG);
    assert.equal(fns.CoTreatAsClass.handler([CLSID_ARG, NEW_ARG]), 0);
    const root = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
    const path = `CLSID\\${CLSID_TEST}\\TreatAs`;
    const key = hive.open(root, path);
    assert.ok(key);
    const data = hive.getValue(key, '')?.data ?? new Uint8Array(0);
    const text = String.fromCharCode(...data.subarray(0, data.indexOf(0)));
    assert.equal(text, replacement);

    host.bytes.set(/** @type {Uint8Array} */ (parseGuid(GUID_NULL)), NEW_ARG);
    assert.equal(fns.CoTreatAsClass.handler([CLSID_ARG, NEW_ARG]), 0);
    assert.equal(hive.open(root, path), null, 'removed');
});

test('CoGetPSClsid reads the proxy/stub class the registry names for an interface', ()=>{
    const { host } = setup();
    const hive = createHive();
    host.hive = hive;
    const fns = createOleFunctions(host);
    const OUT = 0x1040;
    const proxyStub = '{0A0B0C0D-0000-0000-0000-000000000001}';
    host.bytes.fill(0xcc, OUT, OUT + GUID_SIZE);
    assert.equal(fns.CoGetPSClsid.handler([IID_ARG, OUT]) >>> 0, 0x80040155,
        'REGDB_E_IIDNOTREG for an interface nothing registers');
    assert.equal(formatGuid(host.bytes.subarray(OUT, OUT + GUID_SIZE)), GUID_NULL);

    const root = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
    const key = hive.create(root, `Interface\\${IID_TEST}\\ProxyStubClsid32`).key;
    hive.setValue(key, '', 1, Uint8Array.from([...proxyStub, '\0'].map(c=>c.charCodeAt(0))));
    assert.equal(fns.CoGetPSClsid.handler([IID_ARG, OUT]), S_OK);
    assert.equal(formatGuid(host.bytes.subarray(OUT, OUT + GUID_SIZE)), proxyStub);
    assert.equal(fns.CoGetMarshalSizeMax.handler([OUT, IID_ARG, 0, 0, 0, 0]), S_OK);
    assert.equal(host.u32(OUT), 72, 'a standard OBJREF');

    // One the process registered for itself is answered ahead of the registry,
    // by an apartment (compobj.c test_CoRegisterPSClsid).
    const own = '{0A0B0C0D-0000-0000-0000-000000000002}';
    host.bytes.set(/** @type {Uint8Array} */ (parseGuid(own)), CLSID_ARG);
    assert.equal(fns.CoRegisterPSClsid.handler([IID_ARG, CLSID_ARG]) >>> 0, 0x800401f0,
        'CO_E_NOTINITIALIZED outside an apartment');
    initialize(fns, COINIT_APARTMENTTHREADED);
    assert.equal(fns.CoRegisterPSClsid.handler([IID_ARG, CLSID_ARG]), S_OK);
    assert.equal(fns.CoGetPSClsid.handler([IID_ARG, OUT]), S_OK);
    assert.equal(formatGuid(host.bytes.subarray(OUT, OUT + GUID_SIZE)), own);
    assert.equal(fns.CoRegisterPSClsid.handler([IID_ARG, 0]) >>> 0, 0x80070057, 'E_INVALIDARG');
});

test('CoSwitchCallContext sets what CoGetCallContext answers, without references',
    async()=>{
        // compobj.c test_CoGetCallContext.
        const { fns, calls, host } = withGuestCalls();
        const RPC_E_CALL_COMPLETE = 0x80010117;
        const OUT = 0x1600;
        assert.equal((await fns.CoGetCallContext.handler([IID_ARG, OUT])) >>> 0,
            RPC_E_CALL_COMPLETE);
        new DataView(host.bytes.buffer).setUint32(OUT, 0xdeadbeef, true);
        assert.equal(fns.CoSwitchCallContext.handler([GUEST_OBJECT, OUT]), S_OK);
        assert.equal(host.u32(OUT), 0, 'there was none');
        assert.equal(calls.length, 0, 'no reference taken');
        assert.equal(await fns.CoGetCallContext.handler([IID_ARG, OUT]), S_OK);
        assert.deepEqual(calls.map(call=>[call.slot, call.args[1]]), [[0, IID_ARG]],
            'asked of the context itself');
        assert.equal(fns.CoSwitchCallContext.handler([0, OUT]), S_OK);
        assert.equal(host.u32(OUT), GUEST_OBJECT, 'the previous one handed back');
        assert.equal((await fns.CoGetCallContext.handler([IID_ARG, OUT])) >>> 0,
            RPC_E_CALL_COMPLETE);
        assert.equal(fns.CoSwitchCallContext.handler([0, 0]) >>> 0, E_INVALIDARG);
    });

test('CoSetState holds one object per thread, which CoGetState hands out', async()=>{
    const { fns, calls, host } = withGuestCalls();
    const OUT = 0x1600;
    assert.equal(await fns.CoGetState.handler([OUT]), S_FALSE);
    assert.equal(host.u32(OUT), 0);
    assert.equal(await fns.CoSetState.handler([GUEST_OBJECT]), S_OK);
    assert.equal(await fns.CoGetState.handler([OUT]), S_OK);
    assert.equal(host.u32(OUT), GUEST_OBJECT);
    host.run(host.threads.second);
    assert.equal(await fns.CoGetState.handler([OUT]), S_FALSE, 'another thread has its own');
    host.run(host.threads.first);
    assert.equal(await fns.CoSetState.handler([0]), S_OK);
    assert.deepEqual(calls.map(call=>call.slot), [1, 1, 2], 'AddRef, AddRef, Release');
    assert.equal((await fns.CoGetState.handler([0])) >>> 0, E_INVALIDARG);
});

test('CoIsOle1Class, CoFileTimeNow and CLSIDFromProgIDEx answer as their documentation says',
    ()=>{
        const { fns, host } = setup();
        assert.equal(fns.CoIsOle1Class.handler(), 0);
        const OUT = 0x1600;
        const before = (BigInt(Date.now()) + 11644473600000n) * 10000n;
        assert.equal(fns.CoFileTimeNow.handler([OUT]), S_OK);
        const stamp = BigInt(host.u32(OUT)) | (BigInt(host.u32(OUT + 4)) << 32n);
        assert.ok(stamp >= before && stamp - before < 100000000n, 'now, in 100ns from 1601');
        assert.equal(fns.CoFileTimeNow.handler([0]) >>> 0, E_INVALIDARG);
        host.putWide(STRING_BUFFER, 'No.Such.Class');
        assert.equal(fns.CLSIDFromProgIDEx.handler([STRING_BUFFER, GUID_OUT]) >>> 0,
            CO_E_CLASSSTRING);
        assert.deepEqual([fns.CoIsOle1Class.argBytes, fns.CoFileTimeNow.argBytes,
            fns.CLSIDFromProgIDEx.argBytes], [4, 4, 8]);
    });

test('CoAllowSetForegroundWindow goes through IForegroundTransfer', async()=>{
    const { host } = setup();
    const view = new DataView(host.bytes.buffer);
    view.setUint32(GUEST_OBJECT, GUEST_VTABLE, true);
    for (let slot = 0; slot < 4; slot++)
    {
        view.setUint32(GUEST_VTABLE + slot * 4, METHOD_BASE + slot * 0x10, true);
    }
    let transfers = true;
    /** @type {number[]} */
    const slots = [];
    /** @param {number} entry @param {number[]} args */
    const call = async(entry, args)=>{
        const slot = (entry - METHOD_BASE) / 0x10;
        slots.push(slot);
        if (slot === 0)
        {
            view.setUint32(args[2], transfers ? GUEST_OBJECT : 0, true);
            return transfers ? S_OK : E_NOINTERFACE | 0;
        }
        return slot === 3 ? 0x1234 : 0;
    };
    /** @type {any} */ (host).call = call;
    const fns = createOleFunctions(host);
    assert.equal(fns.CoAllowSetForegroundWindow.argBytes, 8);
    assert.equal(await fns.CoAllowSetForegroundWindow.handler([GUEST_OBJECT, 0]), 0x1234,
        'AllowForegroundTransfer\'s answer');
    assert.deepEqual(slots, [0, 3, 2]);
    transfers = false;
    assert.equal((await fns.CoAllowSetForegroundWindow.handler([GUEST_OBJECT, 0])) >>> 0,
        E_NOINTERFACE);
    assert.equal((await fns.CoAllowSetForegroundWindow.handler([GUEST_OBJECT, 1])) >>> 0,
        E_INVALIDARG);
});

test('the clipboard needs OleInitialize, and the last OleUninitialize takes the source off',
    async()=>{
        // clipboard.c test_set_clipboard: CoInitialize is not enough.
        const { fns, calls, host } = withGuestCalls();
        assert.equal((await fns.OleSetClipboard.handler([GUEST_OBJECT])) >>> 0,
            CO_E_NOTINITIALIZED);
        assert.equal(fns.OleInitialize.handler(), S_FALSE);
        calls.length = 0;
        assert.equal(await fns.OleSetClipboard.handler([GUEST_OBJECT]), S_OK);
        assert.equal(fns.OleIsCurrentClipboard.handler([GUEST_OBJECT]), S_OK);
        assert.ok(host.reported.some(line=>line.startsWith('OleSetClipboard')),
            'no user32 clipboard here, and that is said');
        calls.length = 0;
        await fns.OleUninitialize.handler();
        assert.deepEqual(calls.map(call=>call.slot), [2], 'released');
        assert.equal(fns.OleIsCurrentClipboard.handler([GUEST_OBJECT]), S_FALSE);
    });

test('ReleaseStgMedium deletes a GDI object through gdi32 when ole32 can call it', async()=>{
    const { host } = setup();
    /** @type {string[]} */
    const called = [];
    /** @param {string} library @param {string} name @param {number[]} args */
    const system = (library, name, args)=>{
        called.push(`${library}!${name}(${args.join(',')})`);
        return 1;
    };
    /** @type {any} */ (host).system = system;
    const fns = /** @type {any} */ (createOleFunctions(host));
    const MEDIUM = 0x1700;
    const view = new DataView(host.bytes.buffer);
    view.setUint32(MEDIUM, 16, true);
    view.setUint32(MEDIUM + 4, 0x6000, true);
    view.setUint32(MEDIUM + 8, 0, true);
    await fns.ReleaseStgMedium.handler([MEDIUM]);
    view.setUint32(MEDIUM, 2, true);
    view.setUint32(MEDIUM + 4, host.heap.allocate(4), true);
    await fns.ReleaseStgMedium.handler([MEDIUM]);
    assert.equal(called[0], `GDI32.dll!DeleteObject(${0x6000})`);
    assert.match(called[1], /^KERNEL32\.dll!DeleteFileW\(/);
});
