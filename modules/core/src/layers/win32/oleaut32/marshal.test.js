/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HKEY_CLASSES_ROOT, createHive } from '../advapi32/registry.js';
import { parseTypeLib } from './typelib.js';
import { createAutomationFunctions } from './functions.js';
import { guestOver } from '../common/guest.fixture.js';
import {
    IID_IDISPATCH, PARAMFLAG_FIN, PARAMFLAG_FOUT, argumentBytes, argumentSlots,
    createInterfaceCatalog, describeType, layoutOf, marshalReply, marshalRequest, sizeOf,
    unmarshalReply,
    unmarshalRequest, unsupportedAt,
} from './marshal.js';

const LIBRARY = parseTypeLib(new Uint8Array(
    readFileSync(new URL('./msft-typelib.bin', import.meta.url))));
const IID_ISETUPMEDIA = '{91814EBF-B5F0-11D2-80B9-00104B1F6CEA}';
const IID_ISETUPCABFILE = '{91814EC1-B5F0-11D2-80B9-00104B1F6CEA}';

/**
 * One process's memory: a byte array, a bump allocator that remembers what
 * is live, BSTRs with their length prefix, and interfaces that cross as
 * labelled references.
 *
 * @param {string} name
 */
function side(name){
    const bytes = new Uint8Array(0x20000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, number>} */
    const live = new Map();
    let next = 0x1000;
    /** @type {string[]} */
    const said = [];
    /** @param {number} size */
    const allocate = size=>{
        const at = next;
        next += (Math.max(size, 4) + 7) & ~7;
        live.set(at, size);
        return at;
    };
    const self = {
        name, bytes, live, said,
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} data */
        writeMemory: (at, data)=>bytes.set(data, at),
        allocate,
        /** @param {number} at */
        free: at=>{
            assert.ok(live.delete(at), `${name}: free of ${at.toString(16)}, which is not live`);
        },
        /** @param {Uint8Array} content */
        allocateBstr: content=>{
            const at = allocate(content.length + 6) + 4;
            view.setUint32(at - 4, content.length, true);
            bytes.set(content, at);
            return at;
        },
        /** @param {number} at */
        freeBstr: at=>self.free(at - 4),
        createSafeArray: ()=>0,
        destroySafeArray: ()=>{},
        /** @param {number} pointer @param {string} iid @param {boolean} transfer */
        exportInterface: async(pointer, iid, transfer)=>{
            said.push(`export ${pointer.toString(16)} ${transfer ? 'transfer' : 'hold'}`);
            return { from: name, pointer };
        },
        /** @param {any} reference @param {string} iid */
        importInterface: async(reference, iid)=>{
            said.push(`import ${reference.from}:${reference.pointer.toString(16)} ${iid}`);
            return 0xabc0;
        },
        /** @param {number} pointer */
        releaseInterface: async pointer=>{
            said.push(`release ${pointer.toString(16)}`);
        },
        /** @param {number} at */
        u32: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        put: (at, value)=>view.setUint32(at, value, true),
        /** @param {string} text */
        wide: text=>Uint8Array.from([...text].flatMap(c=>[c.charCodeAt(0), 0])),
    };
    return self;
}

/** A 32-bit frame's arguments, each a dword. @param {(number | bigint)[]} words */
const numbers = words=>words.map(Number);

/** @param {Uint8Array} data */
const text = data=>String.fromCharCode(...data.filter((_, index)=>index % 2 === 0));

test('an interface reads out of its library as calls the marshaler can carry', ()=>{
    const type = LIBRARY.typeInfos.find(candidate=>candidate.guid === IID_ISETUPMEDIA);
    const media = describeType(LIBRARY, /** @type {any} */ (type));
    assert.equal(media.name, 'ISetupMedia');
    assert.deepEqual(media.methods.slice(0, 3), [null, null, null], 'IUnknown is the proxy\'s own');
    const open = /** @type {any} */ (media.methods[4]);
    assert.equal(open.name, 'OpenCAB');
    assert.equal(open.unsupported, null);
    assert.deepEqual(open.parameters.map((/** @type {any} */ parameter)=>parameter.type.kind),
        ['bstr', 'pointer']);
    assert.deepEqual(open.parameters[1].type.to, { kind: 'interface', iid: IID_ISETUPCABFILE },
        'a pointer to an interface pointer, typed by the interface it names');

    const dual = LIBRARY.typeInfos.find(candidate=>candidate.name === 'ISetupCABFile');
    const cab = describeType(LIBRARY, /** @type {any} */ (dual));
    assert.equal(/** @type {any} */ (cab.methods[6]).name, 'Invoke', 'a dual starts as IDispatch');
    assert.equal(/** @type {any} */ (cab.methods[7]).name, 'Components');

    const provider = LIBRARY.typeInfos.find(candidate=>candidate.name === 'ISetupServiceProvider');
    const refused = describeType(LIBRARY, /** @type {any} */ (provider));
    assert.match(String(/** @type {any} */ (refused.methods[3]).unsupported), /untyped pointer/,
        'void** has no type to marshal it by');
});

test('a call crosses: [in] string over, [out] interface back, the stub\'s copies freed',
    async()=>{
        const type = LIBRARY.typeInfos.find(candidate=>candidate.guid === IID_ISETUPMEDIA);
        const open = /** @type {any} */ (describeType(LIBRARY, /** @type {any} */ (type)))
            .methods[4];
        const caller = side('caller');
        const callee = side('callee');
        const name = caller.allocateBstr(caller.wide('data1.cab'));
        const out = caller.allocate(4);
        caller.put(out, 0xdead);

        const request = await marshalRequest(caller, open, [name, out]);
        const call = await unmarshalRequest(callee, open, request);
        const [bstr, slot] = numbers(call.words);
        assert.equal(text(callee.readMemory(bstr, callee.u32(bstr - 4))), 'data1.cab');
        assert.equal(callee.u32(slot), 0, 'an [out] pointer starts zeroed');

        callee.put(slot, 0x5000);
        const reply = await marshalReply(callee, open, request, call);
        assert.deepEqual(callee.said, ['export 5000 transfer'], 'the callee\'s reference goes');
        assert.equal(callee.live.size, 0, 'the string and the slot are the stub\'s to free');

        await unmarshalReply(caller, open, [name, out], request, reply);
        assert.equal(caller.u32(out), 0xabc0);
        assert.deepEqual(caller.said, [`import callee:5000 ${IID_ISETUPCABFILE}`]);
    });

test('[in, out] strings and variants, and an Invoke whose by-reference argument comes back',
    async()=>{
        /** @type {any} */
        const method = { name: 'Swap', slot: 3, unsupported: null, parameters: [
            { name: 'value', flags: PARAMFLAG_FIN, type: { kind: 'variant' } },
            { name: 'text', flags: PARAMFLAG_FIN | PARAMFLAG_FOUT,
                type: { kind: 'pointer', to: { kind: 'bstr' } } },
        ] };
        const caller = side('caller');
        const callee = side('callee');
        const variant = caller.allocate(16);
        caller.writeMemory(variant, new Uint8Array(16));
        caller.bytes[variant] = 8;
        caller.put(variant + 8, caller.allocateBstr(caller.wide('in a variant')));
        const cell = caller.allocate(4);
        const old = caller.allocateBstr(caller.wide('before'));
        caller.put(cell, old);
        const words = [...new Uint32Array(caller.bytes.slice(variant, variant + 16).buffer), cell];

        const request = await marshalRequest(caller, method, words);
        const call = await unmarshalRequest(callee, method, request);
        const laidOut = numbers(call.words);
        assert.equal(laidOut.length, 5, 'a VARIANT is four words on the stack');
        assert.equal(text(callee.readMemory(laidOut[2], callee.u32(laidOut[2] - 4))),
            'in a variant');
        const slot = laidOut[4];
        const given = callee.u32(slot);
        assert.equal(text(callee.readMemory(given, callee.u32(given - 4))), 'before');
        callee.freeBstr(given);
        callee.put(slot, callee.allocateBstr(callee.wide('after')));
        const reply = await marshalReply(callee, method, request, call);
        assert.equal(callee.live.size, 0);

        await unmarshalReply(caller, method, words, request, reply);
        const now = caller.u32(cell);
        assert.equal(text(caller.readMemory(now, caller.u32(now - 4))), 'after');
        assert.ok(!caller.live.has(old - 4), 'the caller\'s old string was freed');

        const invoke = /** @type {any} */ ((await createInterfaceCatalog({ readFile: ()=>null })
            .describe(IID_IDISPATCH))?.methods[6]);
        const counter = caller.allocate(4);
        caller.put(counter, 41);
        const argument = caller.allocate(16);
        caller.writeMemory(argument, new Uint8Array(16));
        caller.bytes[argument] = 3;
        caller.bytes[argument + 1] = 0x40;
        caller.put(argument + 8, counter);
        const params = caller.allocate(16);
        caller.writeMemory(params, new Uint8Array(16));
        caller.put(params, argument);
        caller.put(params + 8, 1);
        const riid = caller.allocate(16);
        caller.writeMemory(riid, new Uint8Array(16));
        const result = caller.allocate(16);
        const invokeArgs = [7, riid, 0, 1, params, result, 0, 0];

        const sent = await marshalRequest(caller, invoke, invokeArgs);
        const laid = await unmarshalRequest(callee, invoke, sent);
        const theirs = callee.u32(numbers(laid.words)[4]);
        const referent = callee.u32(theirs + 8);
        assert.equal(callee.u32(referent), 41, 'the argument points at its own copy');
        callee.put(referent, 42);
        const resultSlot = numbers(laid.words)[5];
        callee.bytes[resultSlot] = 3;
        callee.put(resultSlot + 8, 99);
        const back = await marshalReply(callee, invoke, sent, laid);
        assert.equal(callee.live.size, 0, 'every block made for the call is back');
        await unmarshalReply(caller, invoke, invokeArgs, sent, back);
        assert.equal(caller.u32(counter), 42, 'the caller\'s variable holds what the callee left');
        assert.equal(caller.u32(result + 8), 99);
    });

test('the catalog finds an interface through the registry and the library a file holds',
    async()=>{
        const hive = createHive();
        const root = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
        /** @param {string} path @param {string} name @param {string} value */
        const set = (path, name, value)=>hive.setValue(hive.create(root, path).key, name, 1,
            Uint8Array.from([...value, '\0'].map(c=>c.charCodeAt(0))));
        set(`Interface\\${IID_ISETUPMEDIA}\\ProxyStubClsid32`, '',
            '{00020424-0000-0000-C000-000000000046}');
        set(`Interface\\${IID_ISETUPMEDIA}\\TypeLib`, '', '{94636247-BC39-4B8B-A728-2D1FBEBFA76A}');
        set(`Interface\\${IID_ISETUPMEDIA}\\TypeLib`, 'Version', '1.0');
        set('TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0\\0\\win32', '', 'C:\\k.tlb');
        const bytes = readFileSync(new URL('./msft-typelib.bin', import.meta.url));
        /** @type {string[]} */
        const read = [];
        const catalog = createInterfaceCatalog({ hive, readFile: path=>{
            read.push(path);
            return path === 'C:\\k.tlb' ? Promise.resolve(new Uint8Array(bytes)) : null;
        } });
        const media = await catalog.describe(IID_ISETUPMEDIA);
        assert.equal(media?.name, 'ISetupMedia');
        assert.equal(await catalog.describe(IID_ISETUPMEDIA), media, 'described once');
        assert.deepEqual(read, ['C:\\k.tlb']);
        assert.equal(await catalog.describe('{AA7E2069-CB55-11D2-8094-00104B1F9838}'), null,
            'an interface nobody registered has no proxy');
    });

test('GetIDsOfNames: the names cross whole though their count comes after them, and the ids'
    + ' come back', async()=>{
    const method = /** @type {any} */ ((await createInterfaceCatalog({ readFile: ()=>null })
        .describe(IID_IDISPATCH))?.methods[5]);
    const caller = side('caller');
    const callee = side('callee');
    const riid = caller.allocate(16);
    caller.writeMemory(riid, new Uint8Array(16));
    const names = caller.allocate(8);
    for (const [index, name] of ['Quit', 'Run'].entries())
    {
        const at = caller.allocate(name.length * 2 + 2);
        caller.writeMemory(at, Uint8Array.from([...caller.wide(name), 0, 0]));
        caller.put(names + index * 4, at);
    }
    const ids = caller.allocate(8);
    const args = [riid, names, 2, 0x409, ids];

    const request = await marshalRequest(caller, method, args);
    const call = await unmarshalRequest(callee, method, request);
    const theirs = numbers(call.words)[1];
    /** @param {number} at */
    const wideAt = at=>{
        let end = at;
        while (callee.u32(end) & 0xffff)
        {
            end += 2;
        }
        return text(callee.readMemory(at, end - at));
    };
    assert.deepEqual([wideAt(callee.u32(theirs)), wideAt(callee.u32(theirs + 4))],
        ['Quit', 'Run']);
    assert.equal(numbers(call.words)[2], 2);
    const slots = numbers(call.words)[4];
    callee.put(slots, 11);
    callee.put(slots + 4, 12);
    const reply = await marshalReply(callee, method, request, call);
    assert.equal(callee.live.size, 0, 'the names and the ids are the stub\'s to free');
    await unmarshalReply(caller, method, args, request, reply);
    assert.deepEqual([caller.u32(ids), caller.u32(ids + 4)], [11, 12]);
});

test('GetIDsOfNames: a name ending just short of the end of its memory is not read past',
    async()=>{
        // Past the end lies another allocation, or nothing: memory refuses a read
        // that runs into it, as the memory layer refuses one past a region's end.
        const method = /** @type {any} */ ((await createInterfaceCatalog({ readFile: ()=>null })
            .describe(IID_IDISPATCH))?.methods[5]);
        const caller = side('caller');
        const callee = side('callee');
        const end = caller.bytes.length;
        const read = caller.readMemory;
        caller.readMemory = (at, length)=>{
            assert.ok(at + length <= end,
                `read of ${length} bytes at 0x${at.toString(16)} runs past the end of memory`);
            return read(at, length);
        };
        const riid = caller.allocate(16);
        caller.writeMemory(riid, new Uint8Array(16));
        const names = caller.allocate(4);
        const name = Uint8Array.from([...caller.wide('Quit'), 0, 0]);
        caller.writeMemory(end - 8 - name.length, name);
        caller.put(names, end - 8 - name.length);
        const request = await marshalRequest(caller, method, [riid, names, 1, 0x409,
            caller.allocate(4)]);
        const call = await unmarshalRequest(callee, method, request);
        const theirs = callee.u32(numbers(call.words)[1]);
        assert.equal(text(callee.readMemory(theirs, 8)), 'Quit');
        assert.equal(callee.u32(theirs + 8) & 0xffff, 0);
    });

test('a by-reference variant at a NULL string crosses as a cell holding NULL, and none as none',
    async()=>{
        // An installer's progress object is set a status text through
        // Invoke, the argument a BSTR* whose string is still NULL. Crossed as
        // no referent, the callee's ITypeInfo::Invoke could not read it and
        // the property put failed with DISP_E_TYPEMISMATCH.
        const invoke = /** @type {any} */ ((await createInterfaceCatalog({ readFile: ()=>null })
            .describe(IID_IDISPATCH))?.methods[6]);
        /** @param {number} reference @returns {Promise<number[]>} the callee's referent, and what it holds */
        const crossed = async reference=>{
            const caller = side('caller');
            const callee = side('callee');
            const argument = caller.allocate(16);
            caller.writeMemory(argument, new Uint8Array(16));
            caller.bytes[argument] = 8;
            caller.bytes[argument + 1] = 0x40;
            caller.put(argument + 8, reference === 0 ? 0 : caller.allocate(4));
            if (reference !== 0)
            {
                caller.put(caller.u32(argument + 8), 0);
            }
            const params = caller.allocate(16);
            caller.writeMemory(params, new Uint8Array(16));
            caller.put(params, argument);
            caller.put(params + 8, 1);
            const riid = caller.allocate(16);
            caller.writeMemory(riid, new Uint8Array(16));
            const sent = await marshalRequest(caller, invoke, [2, riid, 0, 4, params, 0, 0, 0]);
            const laid = await unmarshalRequest(callee, invoke, sent);
            const theirs = callee.u32(numbers(laid.words)[4]);
            const referent = callee.u32(theirs + 8);
            return [referent, referent === 0 ? 0 : callee.u32(referent)];
        };
        const [cell, held] = await crossed(1);
        assert.notEqual(cell, 0, 'a cell of its own');
        assert.equal(held, 0, 'holding NULL');
        assert.equal((await crossed(0))[0], 0, 'no referent stays none');
    });

test('IOleWindow and IOleClientSite cross apartments with no library, as ole32 marshals them',
    async()=>{
        const catalog = createInterfaceCatalog({ readFile: ()=>null });
        const window = await catalog.describe('{00000114-0000-0000-C000-000000000046}');
        assert.deepEqual(window?.methods.slice(3).map(method=>method?.name),
            ['GetWindow', 'ContextSensitiveHelp']);
        const site = await catalog.describe('{00000118-0000-0000-C000-000000000046}');
        assert.deepEqual(site?.methods.slice(3).map(method=>method?.name), ['SaveObject',
            'GetMoniker', 'GetContainer', 'ShowObject', 'OnShowWindow', 'RequestNewObjectLayout']);
        assert.equal(site?.methods[4]?.parameters[2].type.kind, 'pointer',
            'GetMoniker hands a moniker out');
    });

/**
 * One 64-bit process's memory, as `side` makes a 32-bit one's: its pointers
 * quadwords, in memory and in each slot of a call's frame.
 *
 * @param {string} name
 */
function longSide(name){
    const self = side(name);
    const view = new DataView(self.bytes.buffer);
    /** @type {Map<number, number>} */
    const arrays = new Map();
    return Object.assign(self, {
        pointerSize: /** @type {8} */ (8),
        // SAFEARRAY at 64 bits: cDims, fFeatures, cbElements, cLocks, pvData at 16,
        // rgsabound at 24. Of dwords alone, which is all a test here sends.
        /** @param {number} _vt @param {{ elements: number, lower: number }[]} bounds */
        createSafeArray: (_vt, bounds)=>{
            const head = self.allocate(24 + 8 * bounds.length);
            const count = bounds.reduce((product, bound)=>product * bound.elements, 1);
            const data = self.allocate(count * 4);
            self.writeMemory(head, new Uint8Array(24 + 8 * bounds.length));
            view.setUint16(head, bounds.length, true);
            view.setUint32(head + 4, 4, true);
            view.setBigUint64(head + 16, BigInt(data), true);
            bounds.forEach((bound, index)=>{
                view.setUint32(head + 24 + index * 8, bound.elements, true);
                view.setInt32(head + 28 + index * 8, bound.lower, true);
            });
            arrays.set(head, data);
            return head;
        },
        /** @param {number} head */
        destroySafeArray: head=>{
            self.free(/** @type {number} */ (arrays.get(head)));
            arrays.delete(head);
            self.free(head);
        },
        /** @param {number} at */
        pointer: at=>Number(view.getBigUint64(at, true)),
        /** @param {number} at @param {number} value */
        putPointer: (at, value)=>view.setBigUint64(at, BigInt(value), true),
    });
}

/**
 * A 64-bit call's arguments after `this` as the bridge hands them over when
 * each is declared a quadword: the low and the high dword of each slot.
 *
 * @param {number[]} slots
 */
const longFrame = slots=>slots.flatMap(value=>[value % 2 ** 32, Math.floor(value / 2 ** 32)]);

test('a 64-bit call crosses in quadword slots: a VARIANT by value is passed by reference, and'
    + ' an Invoke\'s DISPPARAMS, VARIANTs and EXCEPINFO are laid out at 64 bits', async()=>{
    /** @type {any} */
    const method = { name: 'Swap', slot: 3, unsupported: null, parameters: [
        { name: 'value', flags: PARAMFLAG_FIN, type: { kind: 'variant' } },
        { name: 'text', flags: PARAMFLAG_FIN | PARAMFLAG_FOUT,
            type: { kind: 'pointer', to: { kind: 'bstr' } } },
    ] };
    const long = layoutOf(8);
    assert.equal(argumentBytes(method, long), 4 + 16, 'two slots after this');
    assert.deepEqual(argumentSlots(method, long), { quadwords: [1, 3] });
    assert.deepEqual(argumentSlots(method, layoutOf(4)), {});

    const caller = longSide('caller');
    const callee = longSide('callee');
    // The caller's VARIANT, 24 bytes, a BSTR at 8; the slot holds its address.
    const variant = caller.allocate(24);
    caller.writeMemory(variant, new Uint8Array(24).fill(0xee));
    caller.bytes.set([8, 0], variant);
    caller.putPointer(variant + 8, caller.allocateBstr(caller.wide('in a variant')));
    const cell = caller.allocate(8);
    const old = caller.allocateBstr(caller.wide('before'));
    caller.putPointer(cell, old);
    const args = longFrame([variant, cell]);

    const request = await marshalRequest(caller, method, args);
    const call = await unmarshalRequest(callee, method, request);
    assert.equal(call.words.length, 2, 'one slot each');
    const copy = Number(call.words[0]);
    assert.equal(callee.u32(copy) & 0xffff, 8, 'the VARIANT is a copy the slot points at');
    const inside = callee.pointer(copy + 8);
    assert.equal(text(callee.readMemory(inside, callee.u32(inside - 4))), 'in a variant');
    const slot = Number(call.words[1]);
    const given = callee.pointer(slot);
    assert.equal(text(callee.readMemory(given, callee.u32(given - 4))), 'before');
    callee.freeBstr(given);
    callee.putPointer(slot, callee.allocateBstr(callee.wide('after')));
    const reply = await marshalReply(callee, method, request, call);
    assert.equal(callee.live.size, 0, 'the copy, the string and the slot are given back');
    await unmarshalReply(caller, method, args, request, reply);
    const now = caller.pointer(cell);
    assert.equal(text(caller.readMemory(now, caller.u32(now - 4))), 'after');
    assert.ok(!caller.live.has(old - 4), 'the caller\'s old string was freed');

    const invoke = /** @type {any} */ ((await createInterfaceCatalog({ readFile: ()=>null })
        .describe(IID_IDISPATCH))?.methods[6]);
    const counter = caller.allocate(4);
    caller.put(counter, 41);
    // VT_I4 | VT_BYREF, its referent's pointer at 8.
    const argument = caller.allocate(24);
    caller.writeMemory(argument, new Uint8Array(24));
    caller.bytes.set([3, 0x40], argument);
    caller.putPointer(argument + 8, counter);
    // A second argument, VT_I4 5, the next VARIANT 24 bytes on.
    const second = caller.allocate(24);
    caller.writeMemory(second, new Uint8Array(24));
    caller.bytes[second] = 3;
    caller.put(second + 8, 5);
    const both = caller.allocate(48);
    caller.writeMemory(both, Uint8Array.of(...caller.readMemory(argument, 24),
        ...caller.readMemory(second, 24)));
    // DISPPARAMS: rgvarg, rgdispidNamedArgs, cArgs at 16, cNamedArgs at 20.
    const params = caller.allocate(24);
    caller.writeMemory(params, new Uint8Array(24));
    caller.putPointer(params, both);
    caller.put(params + 16, 2);
    const riid = caller.allocate(16);
    caller.writeMemory(riid, new Uint8Array(16));
    const result = caller.allocate(24);
    const exception = caller.allocate(64);
    caller.writeMemory(exception, new Uint8Array(64));
    const invokeArgs = longFrame([7, riid, 0, 1, params, result, exception, 0]);

    const sent = await marshalRequest(caller, invoke, invokeArgs);
    const laid = await unmarshalRequest(callee, invoke, sent);
    const theirs = callee.pointer(Number(laid.words[4]));
    assert.equal(callee.u32(Number(laid.words[4]) + 16), 2, 'their cArgs, at 16');
    assert.equal(callee.u32(theirs + 24 + 8), 5, 'the second VARIANT, 24 bytes on');
    const referent = callee.pointer(theirs + 8);
    assert.equal(callee.u32(referent), 41, 'the argument points at its own copy');
    callee.put(referent, 42);
    const resultSlot = Number(laid.words[5]);
    callee.bytes[resultSlot] = 3;
    callee.put(resultSlot + 8, 99);
    // EXCEPINFO: bstrDescription at 16.
    callee.putPointer(Number(laid.words[6]) + 16, callee.allocateBstr(callee.wide('it failed')));
    const back = await marshalReply(callee, invoke, sent, laid);
    assert.equal(callee.live.size, 0, 'every block made for the call is back');
    await unmarshalReply(caller, invoke, invokeArgs, sent, back);
    assert.equal(caller.u32(counter), 42, 'the caller\'s variable holds what the callee left');
    assert.equal(caller.u32(result + 8), 99);
    const description = caller.pointer(exception + 16);
    assert.equal(text(caller.readMemory(description, caller.u32(description - 4))), 'it failed');
});

test('the values that cross know no width: a 32-bit caller reaches a 64-bit callee', async()=>{
    const type = LIBRARY.typeInfos.find(candidate=>candidate.guid === IID_ISETUPMEDIA);
    const open = /** @type {any} */ (describeType(LIBRARY, /** @type {any} */ (type))).methods[4];
    const caller = side('caller');
    const callee = longSide('callee');
    const name = caller.allocateBstr(caller.wide('data1.cab'));
    const out = caller.allocate(4);
    const request = await marshalRequest(caller, open, [name, out]);
    const call = await unmarshalRequest(callee, open, request);
    const [bstr, slot] = call.words.map(Number);
    assert.equal(text(callee.readMemory(bstr, callee.u32(bstr - 4))), 'data1.cab');
    assert.equal(callee.pointer(slot), 0);
    callee.putPointer(slot, 0x5000);
    const reply = await marshalReply(callee, open, request, call);
    assert.equal(callee.live.size, 0);
    await unmarshalReply(caller, open, [name, out], request, reply);
    assert.equal(caller.u32(out), 0xabc0);
});

test('a 64-bit library counts its vtable in quadwords, and a float among a 64-bit call\'s'
    + ' first arguments is said not to cross', ()=>{
    const long = /** @type {any} */ ({ ...LIBRARY, sysKind: 3, typeInfos: LIBRARY.typeInfos.map(
        info=>({ ...info, functions: info.functions.map(fn=>({ ...fn,
            vtableOffset: fn.vtableOffset * 2 })) })) });
    const type = long.typeInfos.find((/** @type {any} */ candidate)=>
        candidate.guid === IID_ISETUPMEDIA);
    assert.equal(/** @type {any} */ (describeType(long, type).methods[4])?.name, 'OpenCAB');

    /** @type {any} */
    const scale = { name: 'Scale', slot: 3, unsupported: null, parameters: [
        { name: 'factor', flags: PARAMFLAG_FIN, type: { kind: 'word', bytes: 8, float: true } },
    ] };
    assert.match(String(unsupportedAt(scale, layoutOf(8))), /factor: a floating-point argument/);
    assert.equal(unsupportedAt(scale, layoutOf(4)), null, 'a 32-bit stack holds it as any other');
});

test('a 64-bit process loads the library registered for 64-bit Windows, a 32-bit one the'
    + ' 32-bit one', async()=>{
    const hive = createHive();
    const root = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
    /** @param {string} path @param {string} name @param {string} value */
    const set = (path, name, value)=>hive.setValue(hive.create(root, path).key, name, 1,
        Uint8Array.from([...value, '\0'].map(c=>c.charCodeAt(0))));
    set(`Interface\\${IID_ISETUPMEDIA}\\ProxyStubClsid32`, '',
        '{00020424-0000-0000-C000-000000000046}');
    set(`Interface\\${IID_ISETUPMEDIA}\\TypeLib`, '', '{94636247-BC39-4B8B-A728-2D1FBEBFA76A}');
    set('TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0\\0\\win32', '', 'C:\\x86.tlb');
    set('TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0\\0\\win64', '', 'C:\\x64.tlb');
    const bytes = readFileSync(new URL('./msft-typelib.bin', import.meta.url));
    /** @param {4 | 8} pointerSize */
    const readBy = async pointerSize=>{
        /** @type {string[]} */
        const read = [];
        await createInterfaceCatalog({ hive, pointerSize, readFile: path=>{
            read.push(path);
            return Promise.resolve(new Uint8Array(bytes));
        } }).describe(IID_ISETUPMEDIA);
        return read;
    };
    assert.deepEqual(await readBy(8), ['C:\\x64.tlb']);
    assert.deepEqual(await readBy(4), ['C:\\x86.tlb']);
});

test('a SAFEARRAY crosses between 64-bit processes in its 64-bit layout', async()=>{
    /** @type {any} */
    const method = { name: 'Sum', slot: 3, unsupported: null, parameters: [
        { name: 'values', flags: PARAMFLAG_FIN, type: { kind: 'safearray' } },
    ] };
    const caller = longSide('caller');
    const callee = longSide('callee');
    // The two heaps apart, so nothing the callee reads lies where the caller's did.
    callee.free(callee.allocate(0x800));
    const array = caller.createSafeArray(3, [{ elements: 3, lower: 0 }]);
    const data = caller.pointer(array + 16);
    [10, 20, 30].forEach((value, index)=>caller.put(data + index * 4, value));
    const request = await marshalRequest(caller, method, longFrame([array]));
    const call = await unmarshalRequest(callee, method, request);
    const theirs = Number(call.words[0]);
    assert.equal(callee.u32(theirs + 24), 3, 'three elements, their bound at 24');
    const values = callee.pointer(theirs + 16);
    assert.deepEqual([0, 1, 2].map(index=>callee.u32(values + index * 4)), [10, 20, 30]);
    await marshalReply(callee, method, request, call);
    assert.equal(callee.live.size, 0, 'the stub\'s array is destroyed');
});

/**
 * A 64-bit process whose arrays and strings are oleaut32's own, as the stub
 * a server runs makes them: SafeArrayCreate's layout, not one a test wrote.
 *
 * @param {string} name
 */
function automatedSide(name){
    const self = longSide(name);
    const automation = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        createAutomationFunctions({ guest: guestOver(self.bytes, 8),
            heap: { allocate: self.allocate, free: at=>{
                self.free(at);
                return true;
            } } }));
    /** @param {string} export_ @param {number[]} args */
    const call = (export_, args)=>Number(automation[export_].handler(args)) >>> 0;
    const bounds = self.allocate(64);
    return Object.assign(self, {
        call,
        /** @param {Uint8Array} content */
        allocateBstr: content=>{
            const source = self.allocate(content.length + 2);
            self.writeMemory(source, Uint8Array.of(...content, 0, 0));
            const made = call('SysAllocStringByteLen', [source, content.length]);
            self.free(source);
            return made;
        },
        /** @param {number} at */
        freeBstr: at=>call('SysFreeString', [at]),
        /** @param {number} vt @param {{ elements: number, lower: number }[]} given */
        createSafeArray: (vt, given)=>{
            given.forEach((bound, index)=>{
                self.put(bounds + index * 8, bound.elements);
                self.put(bounds + index * 8 + 4, bound.lower);
            });
            return call('SafeArrayCreate', [vt, given.length, bounds]);
        },
        /** @param {number} array */
        destroySafeArray: array=>call('SafeArrayDestroy', [array]),
    });
}

test('a SAFEARRAY of strings oleaut32 made crosses between 64-bit processes, element by'
    + ' element', async()=>{
    // As ICorSvcWorker::OptimizeAssembly sends its load lists.
    /** @type {any} */
    const method = { name: 'Optimize', slot: 4, unsupported: null, parameters: [
        { name: 'name', flags: PARAMFLAG_FIN, type: { kind: 'bstr' } },
        { name: 'list', flags: PARAMFLAG_FIN, type: { kind: 'safearray' } },
    ] };
    const caller = automatedSide('caller');
    const callee = automatedSide('callee');
    callee.free(callee.allocate(0x800));
    const index = caller.allocate(4);
    const list = caller.call('SafeArrayCreateVector', [8, 0, 2]);
    for (const [at, word] of /** @type {[number, string][]} */ ([[0, 'mscorlib'], [1, 'System']]))
    {
        caller.put(index, at);
        const made = caller.allocateBstr(caller.wide(word));
        assert.equal(caller.call('SafeArrayPutElement', [list, index, made]), 0);
        caller.freeBstr(made);
    }
    const name = caller.allocateBstr(caller.wide('System.Core'));
    const request = await marshalRequest(caller, method, longFrame([name, list]));
    const call = await unmarshalRequest(callee, method, request);
    const [given, theirs] = call.words.map(Number);
    assert.equal(text(callee.readMemory(given, callee.u32(given - 4))), 'System.Core');
    const slot = callee.allocate(8);
    const position = callee.allocate(4);
    const read = [];
    for (let at = 0; at < 2; at++)
    {
        callee.put(position, at);
        assert.equal(callee.call('SafeArrayGetElement', [theirs, position, slot]), 0);
        const element = callee.pointer(slot);
        read.push(text(callee.readMemory(element, callee.u32(element - 4))));
        callee.freeBstr(element);
    }
    assert.deepEqual(read, ['mscorlib', 'System'], 'each string whole, a quadword apart');
    callee.free(slot);
    callee.free(position);
    const before = callee.live.size;
    await marshalReply(callee, method, request, call);
    assert.equal(before - callee.live.size, 5,
        'the stub\'s name, its array\'s descriptor and data and both strings given back');
});

test('a record passed by value crosses between 64-bit processes by the reference its slot holds,'
    + ' its string whole', async()=>{
    // ICorSvcSetPrivateAttributes::SetNGenPrivateAttributes(NGenPrivateAttributes): Flags,
    // ZapStats, then a BSTR at 8; sixteen bytes, so a 64-bit caller's slot holds its address.
    /** @type {any} */
    const method = { name: 'SetNGenPrivateAttributes', slot: 3, unsupported: null, parameters: [
        { name: 'attributes', flags: PARAMFLAG_FIN, type: { kind: 'record', bytes: 16,
            fields: [{ offset: 8, type: { kind: 'bstr' } }] } },
    ] };
    const caller = automatedSide('caller');
    const callee = automatedSide('callee');
    callee.free(callee.allocate(0x800));
    const record = caller.allocate(16);
    caller.put(record, 0x11);
    caller.put(record + 4, 0x22);
    caller.putPointer(record + 8, caller.allocateBstr(caller.wide('C:\\dbg')));
    const request = await marshalRequest(caller, method, longFrame([record]));
    const call = await unmarshalRequest(callee, method, request);
    const theirs = Number(call.words[0]);
    assert.deepEqual([callee.u32(theirs), callee.u32(theirs + 4)], [0x11, 0x22]);
    const path = callee.pointer(theirs + 8);
    assert.equal(text(callee.readMemory(path, callee.u32(path - 4))), 'C:\\dbg');
    const before = callee.live.size;
    await marshalReply(callee, method, request, call);
    assert.ok(callee.live.size < before, 'the stub\'s copy and its string given back');
});

/**
 * A library of `sysKind` holding ICorSvcSetPrivateAttributes and the record it
 * takes by value, NGenPrivateAttributes: two DWORDs and a BSTR, laid out as a
 * library of that width stores it.
 *
 * @param {1 | 3} sysKind  SYS_WIN32 or SYS_WIN64.
 */
const privateAttributesLibrary = sysKind=>{
    const wide = sysKind === 3;
    const word = (/** @type {string} */ name, /** @type {number} */ offset)=>({ name, offset,
        type: { vt: 19 } });
    return /** @type {any} */ ({ sysKind, imports: [], typeInfos: [
        { name: 'ICorSvcSetPrivateAttributes', guid: '{B18E0B40-C089-4350-8328-066C668BCCC2}',
            kind: 3, flags: 0, implementedTypes: [], variables: [], functions: [
                { name: 'SetNGenPrivateAttributes', vtableOffset: 3 * (wide ? 8 : 4),
                    callingConvention: 4, parameters: [
                        { name: 'attributes', flags: 1, type: { vt: 29, hreftype: 0x64 } }] }] },
        { name: 'NGenPrivateAttributes', kind: 1, instanceSize: wide ? 16 : 12,
            alignment: wide ? 8 : 4, implementedTypes: [], functions: [], variables: [
                word('Flags', 0), word('ZapStats', 4),
                { name: 'DbgDir', offset: 8, type: { vt: 8 } }] },
    ] });
};

test('a record a library of the other width describes is laid out for the process: a 64-bit'
    + ' one\'s from a 32-bit library has its string at 8 and is 16 bytes', async()=>{
    for (const sysKind of /** @type {(1 | 3)[]} */ ([1, 3]))
    {
        const library = privateAttributesLibrary(sysKind);
        const method = /** @type {any} */ (describeType(library, library.typeInfos[0]).methods[3]);
        const type = method.parameters[0].type;
        assert.deepEqual([sizeOf(type, layoutOf(4)), sizeOf(type, layoutOf(8))], [12, 16],
            `sysKind ${sysKind}: 12 bytes at 32 bits, 16 at 64`);
        const caller = automatedSide('caller');
        const callee = automatedSide('callee');
        callee.free(callee.allocate(0x800));
        const record = caller.allocate(16);
        caller.put(record, 0x11);
        caller.put(record + 4, 0x22);
        caller.putPointer(record + 8, caller.allocateBstr(caller.wide('C:\\dbg')));
        const request = await marshalRequest(caller, method, longFrame([record]));
        const call = await unmarshalRequest(callee, method, request);
        const theirs = Number(call.words[0]);
        assert.deepEqual([callee.u32(theirs), callee.u32(theirs + 4)], [0x11, 0x22]);
        const path = callee.pointer(theirs + 8);
        assert.equal(text(callee.readMemory(path, callee.u32(path - 4))), 'C:\\dbg',
            `sysKind ${sysKind}: the string whole, at 8`);
        await marshalReply(callee, method, request, call);
    }
});

test('VARIANT, DISPPARAMS and SAFEARRAY have the SDK\'s sizes and offsets at both widths', ()=>{
    // oaidl.h: a VARIANT is its VARTYPE and three reserved WORDs, then a
    // union as large as a record's two pointers; a DISPPARAMS two pointers and
    // two UINTs; a SAFEARRAY two USHORTs, two ULONGs, pvData, then its bounds.
    assert.equal(layoutOf(4).variant, 16);
    assert.equal(layoutOf(8).variant, 24);
    assert.deepEqual({ ...layoutOf(4).dispParams },
        { named: 4, count: 8, namedCount: 12, size: 16 });
    assert.deepEqual({ ...layoutOf(8).dispParams },
        { named: 8, count: 16, namedCount: 20, size: 24 });
    assert.deepEqual([layoutOf(4).safeArray.DATA, layoutOf(4).safeArray.BOUNDS], [12, 16]);
    assert.deepEqual([layoutOf(8).safeArray.DATA, layoutOf(8).safeArray.BOUNDS], [16, 24]);
    assert.equal(layoutOf(8).safeArray.LOCKS, 8);
});
