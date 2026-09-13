/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUID_NULL, GUID_SIZE, formatGuid, parseGuid } from './guid.js';
import { IID_IUNKNOWN, createComRegistry } from './objects.js';
import { createOleFunctions, createTaskAllocator } from './functions.js';

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
    assert.equal(initialize(fns, COINIT_MULTITHREADED), S_OK);

    host.run(host.threads.second);
    assert.equal(createInstance(fns), CO_E_NOTINITIALIZED);
    // A different thread may pick a different model without disturbing the first.
    assert.equal(initialize(fns, COINIT_APARTMENTTHREADED), S_OK);
    assert.equal(host.threads.second.ole32.model, COINIT_APARTMENTTHREADED);
    assert.equal(host.threads.first.ole32.model, COINIT_MULTITHREADED);
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

    assert.equal(withHive.CoReleaseMarshalData.handler(), S_OK);
    host.fill(PPV, 1);
    assert.equal(withHive.GetRunningObjectTable.handler([0, PPV]), E_OUTOFMEMORY);
    assert.equal(host.u32(PPV), 0);
    assert.equal(withHive.CreateItemMoniker.handler([0, 0, PPV]), E_OUTOFMEMORY);
    assert.ok(host.reported.some(text=>text.includes('CreateItemMoniker')));
});

test('the table declares stdcall argument sizes and nothing else', ()=>{
    const table = /** @type {Record<string, any>} */ (setup().fns);
    const expected = {
        CoInitialize: 4,
        CoInitializeEx: 8,
        CoUninitialize: 0,
        OleInitialize: 4,
        OleUninitialize: 0,
        CreateStreamOnHGlobal: 12,
        CoFreeUnusedLibraries: 0,
        CoLoadLibrary: 8,
        CoFreeLibrary: 4,
        CoCreateInstance: 20,
        CoCreateGuid: 4,
        CoTaskMemAlloc: 4,
        CoTaskMemFree: 4,
        CoTaskMemRealloc: 8,
        CoGetMalloc: 8,
        StringFromGUID2: 12,
        ProgIDFromCLSID: 8,
        StgCreateDocfile: 16,
        StgOpenStorage: 24,
        StgIsStorageFile: 4,
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
        GetRunningObjectTable: 8,
        CreateItemMoniker: 12,
        StringFromCLSID: 8,
        StringFromIID: 8,
        CLSIDFromString: 8,
        IIDFromString: 8,
        IsEqualGUID: 8,
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
