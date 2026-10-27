/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { SHLWAPI_ORDINALS } from './forwards.js';
import { SHLWAPI_NAMED_ORDINALS } from './ordinals.js';
import { parseGuid } from '../ole32/guid.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const DISP_E_BADVARTYPE = 0x80020008 | 0;
const VT_I4 = 3;
const VT_BSTR = 8;
const VT_DISPATCH = 9;

/**
 * A machine whose other libraries are the handlers given, and whose calls
 * into the guest are JavaScript functions at made-up entry points.
 *
 * @param {Record<string, Record<string, (args: number[]) => any>>} [libraries]
 */
function machine(libraries = {}){
    /** @type {Map<number, (args: any[]) => number>} */
    const guest = new Map();
    const m = shlwapiMachine({
        library: name=>(libraries[name] ? Object.fromEntries(Object.entries(libraries[name])
            .map(([key, handler])=>[key, { handler }])) : undefined),
        drive: steps=>{
            let step = steps.next();
            while (!step.done)
            {
                const run = guest.get(step.value.entry);
                assert.ok(run, `a guest call to ${step.value.entry.toString(16)}`);
                step = steps.next(run(step.value.args) | 0);
            }
            return step.value;
        },
    });
    let nextEntry = 0x70000;
    /**
     * A guest object: a vtable of the methods given, in slot order.
     *
     * @param {((args: any[]) => number)[]} methods
     */
    const object = methods=>{
        const at = m.base.allocate(16);
        const table = m.base.allocate(methods.length * 4);
        methods.forEach((run, slot)=>{
            guest.set(nextEntry, run);
            m.view.setUint32(table + slot * 4, nextEntry, true);
            nextEntry += 16;
        });
        m.view.setUint32(at, table, true);
        return at;
    };
    /** @param {number} address */
    const guidAt = address=>Array.from(m.memory.subarray(address, address + 16));
    return { ...m, object, guidAt };
}

test('each numbered export has one number, and the loader is told every one', ()=>{
    const { fns } = machine();
    const numbers = new Set(SHLWAPI_NAMED_ORDINALS.map(([ordinal])=>ordinal));
    assert.equal(numbers.size, SHLWAPI_NAMED_ORDINALS.length);
    for (const [ordinal, name] of SHLWAPI_NAMED_ORDINALS)
    {
        assert.equal(SHLWAPI_ORDINALS[ordinal], name, `#${ordinal}`);
        assert.ok(fns[name], name);
        assert.equal(fns[name].argBytes % 4, 0, name);
    }
});

test('SHSearchMapInt answers the value beside the first key that matches', ()=>{
    // Wine's test_SHSearchMapInt.
    const m = machine();
    const packed = m.put('', false, 64);
    const packedValues = packed + 32;
    [99, 98, 99].forEach((key, i)=>m.view.setUint32(packed + i * 4, key, true));
    [101, 102, 103].forEach((value, i)=>m.view.setUint32(packedValues + i * 4, value, true));
    const call = m.fns.SHSearchMapInt.handler;
    assert.equal(call([packed, packedValues, 1, 99]), 101);
    assert.equal(call([packed, packedValues, 1, 100]), -1, 'not there');
    assert.equal(call([packed, packedValues, 0, 99]), -1, 'nothing to search');
    assert.equal(call([packed, packedValues, 1, 98]), -1, 'past the length');
    assert.equal(call([packed, packedValues, 2, 98]), 102);
    assert.equal(call([packed, packedValues, 3, 99]), 101, 'searched forward');
});

test('an FDSA grows into a block of its own, and Destroy says so', async()=>{
    // Wine's test_fdsa.
    /** @type {number[]} */
    const freed = [];
    let heap = 0x60000;
    const m = machine({ 'KERNEL32.dll': {
        LocalAlloc: ([, bytes])=>{
            const at = heap;
            heap += bytes + 16;
            return at;
        },
        LocalFree: ([at])=>{
            freed.push(at);
            return 0;
        },
    } });
    const info = m.put('', false, 32);
    const mem = m.put('', false, 64);
    const { FDSA_Initialize: init, FDSA_InsertItem: insert, FDSA_DeleteItem: remove,
        FDSA_Destroy: destroy } = m.fns;
    assert.equal(init.handler([10, 2, info, mem, 4]), 1);
    assert.deepEqual([m.dwordAt(info), m.dwordAt(info + 4), m.dwordAt(info + 8)], [0, mem, 4]);
    assert.deepEqual(Array.from(m.memory.subarray(info + 12, info + 15)), [2, 10, 0]);
    for (const [where, text, at] of /** @type {[number, string, number][]} */ ([
        [1234, '1234567890', 0], [1234, 'abcdefghij', 1], [1, 'klmnopqrst', 1],
        [0, 'uvwxyzABCD', 0],
    ]))
    {
        assert.equal(await insert.handler([info, where, m.put(text)]), at, text);
    }
    assert.equal(m.dwordAt(info + 4), mem, 'still the caller\'s block while it fits');
    assert.equal(await insert.handler([info, 0, m.put('EFGHIJKLMN')]), 0);
    const grown = m.dwordAt(info + 4);
    assert.notEqual(grown, mem);
    assert.equal(m.dwordAt(info + 8), 6);
    assert.equal(m.memory[info + 14], 1, 'flagged as shlwapi\'s own');
    assert.equal(m.read(grown).slice(0, 50), 'EFGHIJKLMNuvwxyzABCD1234567890klmnopqrstabcdefghij');
    assert.equal(remove.handler([info, 2]), 1);
    assert.equal(m.read(grown).slice(0, 40), 'EFGHIJKLMNuvwxyzABCDklmnopqrstabcdefghij');
    assert.equal(remove.handler([info, 3]), 1);
    assert.equal(remove.handler([info, 4]), 0, 'past the last item');
    assert.equal(await destroy.handler([info]), 0, 'FALSE: it freed its own block');
    assert.deepEqual(freed, [grown]);
    assert.equal(init.handler([10, 0, info, mem, 4]), 1);
    assert.equal(m.memory[info + 12], 1, 'a step of 0 is 1');
    assert.equal(await destroy.handler([info]), 1);
});

test('SHPackDispParams puts the pairs in the variants last first', ()=>{
    // Wine's test_SHPackDispParams.
    const m = machine();
    const params = m.put('', false, 16);
    const vars = m.put('', false, 160);
    m.memory.fill(0xc0, params, params + 16);
    m.memory.fill(0xc0, vars, vars + 160);
    const call = m.fns.SHPackDispParams;
    assert.equal(/** @type {{ convention?: string }} */ (call).convention, 'cdecl');
    assert.equal(call.handler([params, vars, 4, VT_BSTR, 0xdeadbeef, 0, 10, VT_I4, 100,
        VT_DISPATCH, 0xdeadbeef]), S_OK);
    assert.deepEqual([m.dwordAt(params), m.dwordAt(params + 4), m.dwordAt(params + 8),
        m.dwordAt(params + 12)], [vars, 0, 4, 0]);
    const variant = (/** @type {number} */ i)=>[m.view.getUint16(vars + i * 16, true),
        m.dwordAt(vars + i * 16 + 8)];
    assert.deepEqual([variant(0), variant(1), variant(2), variant(3)],
        [[VT_DISPATCH, 0xdeadbeef], [VT_I4, 100], [VT_I4, 10], [VT_BSTR, 0xdeadbeef]],
        'an empty type packed as a 4-byte integer');
    assert.equal(call.handler([params, 0, 0]), S_OK);
    assert.deepEqual([m.dwordAt(params), m.dwordAt(params + 8)], [0, 0], 'no arguments, no array');
});

test('GUIDFromStringA reads a braced GUID and nothing else', ()=>{
    const m = machine();
    const out = m.put('', false, 16);
    const text = '{B196B284-BAB4-101A-B69C-00AA00341D07}';
    assert.equal(m.fns.GUIDFromStringA.handler([m.put(text), out]), 1);
    assert.deepEqual(m.guidAt(out), Array.from(/** @type {Uint8Array} */ (parseGuid(text))));
    assert.equal(m.fns.GUIDFromStringA.handler([m.put('B196B284-BAB4'), out]), 0);
    assert.equal(m.fns.GUIDFromStringA.handler([0, out]), 0);
});

test('SHSetWindowBits sets the masked bits and answers the long as it was', async()=>{
    // Wine's test_SHSetWindowBits.
    let style = 0x10000000;
    /** @type {number[][]} */
    const sets = [];
    const m = machine({ 'USER32.dll': {
        GetWindowLongA: ([hwnd])=>(hwnd ? style : 0),
        SetWindowLongA: ([, , value])=>{
            sets.push([value]);
            const old = style;
            style = value;
            return old;
        },
    } });
    const call = m.fns.SHSetWindowBits.handler;
    assert.equal(await call([0, -16, 0, 0]), 0, 'no window');
    assert.equal(await call([1, -16, 0, 0]), 0x10000000);
    assert.equal(sets.length, 0, 'nothing to change, nothing written');
    assert.equal(await call([1, -16, 0x10000000, 0]), 0x10000000);
    assert.equal(style, 0);
    assert.equal(await call([1, -16, 0, 0x10000000]), 0, 'flags outside the mask are ignored');
    assert.equal(style, 0);
    assert.equal(await call([1, -16, 0x10000000, 0x10000000]), 0);
    assert.equal(style, 0x10000000);
});

test('GetAcceptLanguages reads the user\'s value, else the locale\'s language', async()=>{
    // Wine's test_GetAcceptLanguagesA, as Windows 7 answers.
    /** @type {string | null} */
    let stored = 'de,en;q=0.3';
    /** @type {any} */
    let m = null;
    m = machine({
        'ADVAPI32.dll': {
            RegOpenKeyExA: ([, , , , out])=>{
                m.view.setUint32(out, 0x1234, true);
                return 0;
            },
            RegQueryValueExA: ([, , , , data])=>{
                if (stored === null)
                {
                    return 2;
                }
                m.memory.set(new TextEncoder().encode(`${stored}\0`), data);
                return 0;
            },
            RegCloseKey: ()=>0,
        },
        'KERNEL32.dll': {
            GetLocaleInfoA: ([, type, out])=>{
                m.memory.set(new TextEncoder().encode(type === 0x59 ? 'en\0' : 'US\0'), out);
                return 3;
            },
        },
    });
    const call = m.fns.GetAcceptLanguagesA.handler;
    const buffer = m.put('', false, 64);
    let count = m.count(62);
    assert.equal(await call([buffer, count]), S_OK);
    assert.equal(m.read(buffer), 'de,en;q=0.3');
    assert.equal(m.dwordAt(count), 11);
    count = m.count(11);
    assert.equal(await call([buffer, count]), E_NOT_SUFFICIENT_BUFFER,
        'no room for the terminator');
    assert.equal(m.dwordAt(count), 0);
    count = m.count(62);
    assert.equal(await call([0, count]), S_OK);
    assert.equal(m.dwordAt(count), 11, 'a null buffer is the length needed');
    stored = null;
    count = m.count(62);
    assert.equal(await call([buffer, count]), S_OK);
    assert.equal(m.read(buffer), 'en-US');
    assert.equal(await call([buffer, m.count(0)]), E_INVALIDARG);
    assert.equal(await call([buffer, 0]), E_INVALIDARG);
    assert.equal(await call([0, 0]), E_INVALIDARG);
});

test('SHFormatDateTime prints the local date, a space, then the time the flags ask for', async()=>{
    // Wine's test_SHFormatDateTimeA: GetDateFormat's text, then GetTimeFormat's.
    /** @type {(string | number)[][]} */
    const asked = [];
    /** @type {any} */
    let m = null;
    const wideAt = (/** @type {number} */ at, /** @type {string} */ text)=>
        [...text, '\0'].forEach((c, i)=>m.view.setUint16(at + i * 2, c.charCodeAt(0), true));
    m = machine({ 'KERNEL32.dll': {
        FileTimeToLocalFileTime: ()=>1,
        FileTimeToSystemTime: ()=>1,
        GetDateFormatW: ([, flags, , , out])=>{
            asked.push(['date', flags]);
            wideAt(out, flags === 2 ? 'Tuesday, March 3, 2026' : '3/3/2026');
            return 1;
        },
        GetTimeFormatW: ([, flags, , , out])=>{
            asked.push(['time', flags]);
            wideAt(out, flags === 2 ? '9:05 AM' : '9:05:07 AM');
            return 1;
        },
    } });
    const time = m.put('', false, 8);
    const buffer = m.put('', false, 100);
    const call = m.fns.SHFormatDateTimeA.handler;
    assert.equal(await call([time, 0, buffer, 100]), '3/3/2026 9:05 AM'.length + 1);
    assert.equal(m.read(buffer), '3/3/2026 9:05 AM', 'short date and short time by default');
    assert.equal(await call([time, m.count(0x400 | 0x4 | 0x8), buffer, 100]),
        'Tuesday, March 3, 2026 9:05:07 AM'.length + 1);
    assert.equal(m.read(buffer), 'Tuesday, March 3, 2026 9:05:07 AM');
    assert.equal(await call([time, m.count(0x1 | 0x8), buffer, 100]), '9:05:07 AM'.length + 1,
        'the long time wins');
    assert.equal(await call([time, m.count(0x2 | 0x4), buffer, 100]),
        'Tuesday, March 3, 2026'.length + 1, 'the long date wins');
    asked.length = 0;
    assert.equal(await call([time, 0, buffer, 0]), 0, 'no room');
    assert.equal(await call([time, 0, 0, 0]), 0);
    assert.equal(asked.length, 0);
    const wide = m.put('', true, 200);
    assert.equal(await m.fns.SHFormatDateTimeW.handler([time, m.count(0x1), wide, 100]), 8);
    assert.equal(m.read(wide, true), '9:05 AM');
});

test('the COM helpers call the program\'s objects in the order Windows does', ()=>{
    // Wine's test_IUnknown_QueryServiceExec, test_IUnknown_ProfferService and
    // test_IUnknown_GetClassID, by their traces.
    const m = machine();
    /** @type {string[]} */
    const trace = [];
    /**
     * IUnknown's three, Release traced.
     *
     * @param {string} name @param {(args: any[]) => number} query
     * @returns {((args: any[]) => number)[]}
     */
    const unknown = (name, query)=>
        [query, ()=>1, ()=>{
            trace.push(`${name}.Release`);
            return 0;
        }];
    const target = m.object([...unknown('target', ()=>0), ()=>0, ([, group, id, options, input,
        output])=>{
        trace.push(`Exec ${group ? 'group' : ''} ${id} ${options} ${input} ${output}`);
        return 0x1234;
    }]);
    const provider = m.object([...unknown('provider', ([, , out])=>{
        trace.push('QI provider');
        m.view.setUint32(out, provider, true);
        return S_OK;
    }), ([, , , out])=>{
        trace.push('QueryService');
        m.view.setUint32(out, target, true);
        return S_OK;
    }]);
    const group = m.put('', false, 16);
    assert.equal(m.fns.IUnknown_QueryServiceExec.handler([0, 0, group, 1, 2, 3, 4]), E_FAIL);
    assert.equal(m.fns.IUnknown_QueryServiceExec.handler([provider, 0, group, 1, 2, 3, 4]), 0x1234);
    assert.deepEqual(trace, ['QI provider', 'QueryService', 'provider.Release',
        'Exec group 1 2 3 4', 'target.Release']);

    const persist = m.object([...unknown('persist', ([, iid, out])=>{
        // IPersist refused, IPersistFolder taken: the second one asked for.
        if (m.memory[iid] === 0x0c)
        {
            return 0x80004002 | 0;
        }
        m.view.setUint32(out, persist, true);
        return S_OK;
    }), ([, clsid])=>{
        m.memory.fill(0xab, clsid, clsid + 16);
        return 0x8fff2222 | 0;
    }]);
    const clsid = m.put('', false, 16);
    assert.equal(m.fns.IUnknown_GetClassID.handler([persist, clsid]), 0x8fff2222 | 0);
    assert.deepEqual(m.guidAt(clsid), new Array(16).fill(0xab));
    m.memory.fill(0xcc, clsid, clsid + 16);
    assert.equal(m.fns.IUnknown_GetClassID.handler([0, clsid]), E_FAIL);
    assert.deepEqual(m.guidAt(clsid), new Array(16).fill(0), 'CLSID_NULL for no object');
});

test('ConnectToConnectionPoint advises the sink, and SimpleInvoke calls every sink', ()=>{
    // Wine's test_IConnectionPoint: Invoke is never handed a null DISPPARAMS.
    const m = machine();
    /** @type {string[]} */
    const trace = [];
    let refs = 1;
    /** @type {number[]} */
    const sinks = [];
    const addRef = ()=>++refs;
    const releaseRef = ()=>--refs;
    /** @type {number[][]} */
    const invoked = [];
    const sink = m.object([([, , out])=>{
        m.view.setUint32(out, sink, true);
        addRef();
        return S_OK;
    }, addRef, releaseRef, ()=>0, ()=>0, ()=>0, ([, dispId, , lcid, flags, params])=>{
        invoked.push([dispId, lcid, flags, params === 0 ? -1 : m.dwordAt(params + 8)]);
        return S_OK;
    }]);
    let index = 0;
    const enumerator = m.object([()=>0, ()=>1, ()=>0, ([, , data])=>{
        if (index >= sinks.length)
        {
            return 1;
        }
        m.view.setUint32(data, sinks[index++], true);
        addRef();
        return S_OK;
    }]);
    const point = m.object([()=>0, ()=>1, ()=>{
        trace.push('point.Release');
        return 0;
    }, ()=>0, ()=>0, ([, given, cookie])=>{
        sinks.push(given);
        addRef();
        m.view.setUint32(cookie, sinks.length, true);
        return S_OK;
    }, ([, cookie])=>{
        trace.push(`Unadvise ${cookie}`);
        releaseRef();
        return S_OK;
    }, ([, out])=>{
        index = 0;
        m.view.setUint32(out, enumerator, true);
        return S_OK;
    }]);
    const container = m.object([([, , out])=>{
        m.view.setUint32(out, container, true);
        return S_OK;
    }, ()=>1, ()=>{
        trace.push('container.Release');
        return 0;
    }, ()=>0, ([, , out])=>{
        m.view.setUint32(out, point, true);
        return S_OK;
    }]);
    const cookie = m.count(0xffffffff);
    const pointOut = m.count(0);
    assert.equal(m.fns.ConnectToConnectionPoint.handler([sink, 0, 1, container, cookie, pointOut]),
        S_OK);
    assert.equal(m.dwordAt(pointOut), point);
    assert.equal(m.dwordAt(cookie), 1);
    assert.equal(refs, 2, 'the point holds the sink');
    assert.equal(m.fns.IConnectionPoint_SimpleInvoke.handler([point, 0xa0, 0]), S_OK);
    assert.deepEqual(invoked, [[0xa0, 0, 1, 0]], 'an empty DISPPARAMS, DISPATCH_METHOD, lcid 0');
    assert.equal(refs, 2, 'what the enumeration and the query took is given back');
    trace.length = 0;
    assert.equal(m.fns.ConnectToConnectionPoint.handler([0, 0, 0, container, cookie, 0]), S_OK);
    assert.deepEqual(trace, ['container.Release', 'Unadvise 1', 'point.Release']);
    assert.equal(refs, 1);
    assert.equal(m.fns.ConnectToConnectionPoint.handler([sink, 0, 1, 0, cookie, 0]), E_FAIL);
});

test('SHPropertyBag_ReadLONG takes only a VT_I4 the bag gives back', ()=>{
    // Wine's test_SHPropertyBag_ReadLONG: the bag answers a VT_BLOB by reference.
    const m = machine();
    let answer = { type: 0x4000 | 65, value: 0xdeadcafe };
    const bag = m.object([()=>0, ()=>1, ()=>0, ([, , variant])=>{
        m.view.setUint16(variant, answer.type, true);
        m.view.setUint32(variant + 8, answer.value, true);
        return S_OK;
    }]);
    const name = m.put('name1', true);
    const out = m.count(0xfeedface);
    const call = m.fns.SHPropertyBag_ReadLONG.handler;
    assert.equal(call([0, name, out]), E_INVALIDARG);
    assert.equal(call([bag, 0, out]), E_INVALIDARG);
    assert.equal(call([bag, name, 0]), E_INVALIDARG);
    assert.equal(call([bag, name, out]), DISP_E_BADVARTYPE);
    assert.equal(m.dwordAt(out), 0xfeedface, 'the value left alone');
    answer = { type: VT_I4, value: 42 };
    assert.equal(call([bag, name, out]), S_OK);
    assert.equal(m.dwordAt(out), 42);
});

test('without a way into the guest the COM helpers call nothing', ()=>{
    const m = shlwapiMachine();
    assert.equal(m.fns.IUnknown_GetClassID.handler([0x10000, 0x10010]), 0x80004001 | 0);
});
