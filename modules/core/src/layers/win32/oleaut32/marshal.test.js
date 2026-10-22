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
import {
    IID_IDISPATCH, PARAMFLAG_FIN, PARAMFLAG_FOUT, createInterfaceCatalog, describeType,
    marshalReply, marshalRequest, unmarshalReply, unmarshalRequest,
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
        const [bstr, slot] = call.words;
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
        assert.equal(call.words.length, 5, 'a VARIANT is four words on the stack');
        assert.equal(text(callee.readMemory(call.words[2], callee.u32(call.words[2] - 4))),
            'in a variant');
        const slot = call.words[4];
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
        const theirs = callee.u32(laid.words[4]);
        const referent = callee.u32(theirs + 8);
        assert.equal(callee.u32(referent), 41, 'the argument points at its own copy');
        callee.put(referent, 42);
        const resultSlot = laid.words[5];
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
    const theirs = call.words[1];
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
    assert.equal(call.words[2], 2);
    const slots = call.words[4];
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
        const theirs = callee.u32(call.words[1]);
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
            const theirs = callee.u32(laid.words[4]);
            const referent = callee.u32(theirs + 8);
            return [referent, referent === 0 ? 0 : callee.u32(referent)];
        };
        const [cell, held] = await crossed(1);
        assert.notEqual(cell, 0, 'a cell of its own');
        assert.equal(held, 0, 'holding NULL');
        assert.equal((await crossed(0))[0], 0, 'no referent stays none');
    });
