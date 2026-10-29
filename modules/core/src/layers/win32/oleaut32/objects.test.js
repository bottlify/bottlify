/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IID_ITYPEINFO, IID_ITYPELIB, createAdapter, createTypeLibraryObjects } from './objects.js';
import { parseTypeLib } from './typelib.js';
import { IID_IUNKNOWN, IUNKNOWN_METHODS } from '../ole32/objects.js';
import { createVtables } from '../../bridge/internal/vtable.js';

const library = parseTypeLib(
    new Uint8Array(readFileSync(new URL('./msft-typelib.bin', import.meta.url))));

/** Where the tests put their arguments and out slots. */
const OUT = 0x100;
const OUT2 = 0x110;
const NAMES = 0x200;
const GUID = 0x300;

/**
 * Guest memory, a task heap over it, and a publisher that remembers what it
 * was given.
 */
function fakeHost(){
    const bytes = new Uint8Array(0x20000);
    /** @type {Map<number, number>} address -> size */
    const blocks = new Map();
    let nextBlock = 0x1000;
    let nextPointer = 0x10000;
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @type {string[]} */
    const reported = [];
    /** @type {Map<number, string>} */
    const bstrs = new Map();
    const host = {
        bytes,
        objects,
        reported,
        blocks,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        heap: {
            /** @param {number} size */
            allocate: size=>{
                const at = nextBlock;
                nextBlock += (size + 15) & ~15;
                blocks.set(at, size);
                return at;
            },
            /** @param {number} address */
            free: address=>blocks.delete(address),
        },
        /** @param {any} object @param {string} id */
        publish: (object, id)=>{
            const pointer = nextPointer;
            nextPointer += 16;
            objects.set(pointer, { object, id });
            return pointer;
        },
        call: ()=>Promise.resolve(0),
        clearVariant: ()=>{},
        /** @param {number} bstr */
        readBstr: bstr=>bstrs.get(bstr) ?? '',
        /** @param {string} text */
        allocateBstr: text=>{
            const at = host.heap.allocate(text.length * 2 + 6) + 4;
            bstrs.set(at, text);
            return at;
        },
        /** @param {number} bstr */
        freeBstr: bstr=>{
            bstrs.delete(bstr);
            host.heap.free(bstr - 4);
        },
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
        bstrs,
        /** @param {number} address */
        u32: address=>(bytes[address] | (bytes[address + 1] << 8) | (bytes[address + 2] << 16)
            | (bytes[address + 3] << 24)) >>> 0,
        /** @param {number} address */
        u16: address=>bytes[address] | (bytes[address + 1] << 8),
        /** @param {number} address @param {number} value */
        putU32: (address, value)=>host.writeMemory(address, Uint8Array.from([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])),
        /** @param {number} address @param {string} text */
        putWide: (address, text)=>{
            for (let at = 0; at < text.length; at++)
            {
                bytes[address + at * 2] = text.charCodeAt(at);
                bytes[address + at * 2 + 1] = 0;
            }
            bytes[address + text.length * 2] = 0;
            bytes[address + text.length * 2 + 1] = 0;
        },
        /**
         * Calls a method on a published pointer, the way the bridge would.
         *
         * @param {number} pointer @param {string} name @param {number[]} args
         */
        invoke: (pointer, name, args)=>{
            const entry = objects.get(pointer);
            const record = entry.object.interfaceFor(entry.id);
            const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method, `${name} is in the table`);
            return method.invoke(entry.object, args);
        },
    };
    return host;
}

function setup(){
    const host = fakeHost();
    const objects = createTypeLibraryObjects(host);
    const lib = objects.open(library, 'C:\\lib.tlb');
    assert.notEqual(lib, 0);
    return { host, objects, lib };
}

test('an ITypeLib answers its count, attributes and documentation, and frees what it gave', ()=>{
    const { host, objects, lib } = setup();
    assert.equal(objects.libraryAt(lib)?.path, 'C:\\lib.tlb');
    assert.equal(host.invoke(lib, 'GetTypeInfoCount', []), 162);

    assert.equal(host.invoke(lib, 'GetLibAttr', [OUT]), 0);
    const attr = host.u32(OUT);
    assert.equal(host.blocks.get(attr), 32, 'a TLIBATTR in task memory');
    assert.equal(host.u32(attr), 0x94636247, 'the GUID first');
    assert.equal(host.u32(attr + 16), 1033, 'lcid');
    assert.equal(host.u32(attr + 20), 1, 'SYS_WIN32');
    assert.deepEqual([host.u16(attr + 24), host.u16(attr + 26), host.u16(attr + 28)], [1, 0, 0]);
    host.invoke(lib, 'ReleaseTLibAttr', [attr]);
    assert.equal(host.blocks.has(attr), false);

    host.putU32(OUT, 0);
    host.putU32(OUT2, 0);
    assert.equal(host.invoke(lib, 'GetDocumentation', [-1, OUT, OUT2, 0, 0]), 0);
    assert.equal(host.bstrs.get(host.u32(OUT)), 'ProEngine');
    assert.equal(host.bstrs.get(host.u32(OUT2)), 'InstallShield Professional Setup Kernel 7.0');
    assert.equal(host.invoke(lib, 'GetDocumentation', [10, OUT, 0, 0, 0]), 0);
    assert.equal(host.bstrs.get(host.u32(OUT)), 'ISetupBasicFeature');
    assert.equal(host.invoke(lib, 'GetDocumentation', [500, OUT, 0, 0, 0]) >>> 0, 0x8002802b);

    assert.equal(host.invoke(lib, 'GetTypeInfoType', [27, OUT]), 0);
    assert.equal(host.u32(OUT), 5, 'TKIND_COCLASS');
    host.putU32(OUT, 0xdeadbeef);
    assert.equal(host.invoke(lib, 'GetTypeComp', [OUT]) >>> 0, 0x80004001);
    assert.equal(host.u32(OUT), 0);
});

test('a type is one object however it is reached, and keeps the library alive', ()=>{
    const { host, lib } = setup();
    assert.equal(host.invoke(lib, 'GetTypeInfo', [10, OUT]), 0);
    const info = host.u32(OUT);
    const entry = host.objects.get(info);
    assert.equal(entry.id, IID_ITYPEINFO);
    assert.ok(entry.object.interfaceFor(IID_IUNKNOWN));
    assert.equal(entry.object.interfaceFor('{00020412-0000-0000-C000-000000000046}'), null,
        'no ITypeInfo2');

    host.writeMemory(GUID, Uint8Array.from([0x70, 0x61, 0x09, 0xcc, 0xcb, 0xe2, 0xd2, 0x11,
        0x80, 0xc8, 0x00, 0x10, 0x4b, 0x1f, 0x6c, 0xea]));
    assert.equal(host.invoke(lib, 'GetTypeInfoOfGuid', [GUID, OUT2]), 0);
    assert.equal(host.u32(OUT2), info, 'the same pointer for the same type');
    assert.equal(entry.object.release(), 1, 'two hand-outs, two references');
    const libEntry = host.objects.get(lib);
    assert.equal(libEntry.object.release(), 1, 'the type holds the library');
    assert.equal(entry.object.release(), 0);
    assert.equal(host.invoke(lib, 'GetTypeInfo', [999, OUT]) >>> 0, 0x8002802b);
    assert.equal(host.u32(OUT), 0);
});

test('a TYPEATTR and a FUNCDESC are laid out as the headers say, and released whole', ()=>{
    const { host, lib } = setup();
    host.invoke(lib, 'GetTypeInfo', [10, OUT]);
    const info = host.u32(OUT);

    assert.equal(host.invoke(info, 'GetTypeAttr', [OUT]), 0);
    const attr = host.u32(OUT);
    assert.equal(host.blocks.get(attr), 76);
    assert.equal(host.u32(attr), 0xcc096170, 'guid');
    assert.equal(host.u32(attr + 16), 1033, 'lcid');
    assert.equal(host.u32(attr + 24) | 0, -1, 'memidConstructor');
    assert.equal(host.u32(attr + 36), 4, 'cbSizeInstance');
    assert.equal(host.u32(attr + 40), 3, 'TKIND_INTERFACE');
    assert.equal(host.u16(attr + 44), 28, 'cFuncs');
    assert.equal(host.u16(attr + 46), 0, 'cVars');
    assert.equal(host.u16(attr + 48), 1, 'cImplTypes');
    assert.equal(host.u16(attr + 50), 140, 'cbSizeVft');
    assert.equal(host.u16(attr + 52), 4, 'cbAlignment');
    assert.equal(host.u16(attr + 54), 0x1190, 'wTypeFlags');
    host.invoke(info, 'ReleaseTypeAttr', [attr]);
    assert.equal(host.blocks.has(attr), false);

    assert.equal(host.invoke(info, 'GetFuncDesc', [10, OUT]), 0);
    const desc = host.u32(OUT);
    assert.equal(host.u32(desc), 7, 'memid of Log');
    assert.equal(host.u32(desc + 12), 1, 'FUNC_PUREVIRTUAL');
    assert.equal(host.u32(desc + 16), 2, 'INVOKE_PROPERTYGET');
    assert.equal(host.u32(desc + 20), 4, 'CC_STDCALL');
    assert.equal(host.u16(desc + 24), 1, 'cParams');
    assert.equal(host.u16(desc + 28), 68, 'oVft');
    assert.equal(host.u16(desc + 32 + 4), 25, 'elemdescFunc: VT_HRESULT');
    const params = host.u32(desc + 8);
    const size = host.blocks.get(desc) ?? 0;
    assert.ok(params > desc && params < desc + size, 'params inside the block');
    assert.equal(host.u16(params + 4), 26, 'VT_PTR');
    assert.equal(host.u16(params + 12), 0xa, 'wParamFlags: out, retval');
    const inner = host.u32(params);
    assert.equal(host.u16(inner + 4), 26, 'to a VT_PTR');
    const innermost = host.u32(inner);
    assert.equal(host.u16(innermost + 4), 29, 'to a VT_USERDEFINED');
    assert.equal(host.u32(innermost), 12 * 0x64, 'the hreftype of ISetupFeatureLog');
    host.invoke(info, 'ReleaseFuncDesc', [desc]);
    assert.equal(host.blocks.size, 0, 'one block, freed');
    assert.equal(host.invoke(info, 'GetFuncDesc', [28, OUT]) >>> 0, 0x8002802b);
});

test('a dispinterface counts and answers the seven IDispatch methods first', ()=>{
    const { host, lib } = setup();
    host.invoke(lib, 'GetTypeInfo', [33, OUT]);
    const info = host.u32(OUT);
    host.invoke(info, 'GetTypeAttr', [OUT]);
    const attr = host.u32(OUT);
    assert.equal(host.u32(attr + 40), 4, 'TKIND_DISPATCH');
    assert.equal(host.u16(attr + 44), 11, '7 inherited and 4 own');
    assert.equal(host.u16(attr + 50), 28, 'cbSizeVft is IDispatch\'s');
    assert.equal(host.u16(attr + 54) & 0x100, 0, 'FOLEAUTOMATION dropped');

    host.invoke(info, 'GetFuncDesc', [6, OUT]);
    const invoke = host.u32(OUT);
    assert.equal(host.u32(invoke) | 0, 0x60010003, 'IDispatch::Invoke');
    assert.equal(host.u32(invoke + 12), 4, 'FUNC_DISPATCH');
    assert.equal(host.u16(invoke + 24), 8, 'eight parameters');
    host.invoke(info, 'GetFuncDesc', [7, OUT]);
    const count = host.u32(OUT);
    assert.equal(host.u32(count), 1, 'then the type\'s own Count');
    assert.equal(host.u16(count + 28), 0, 'oVft is 0 on a dispinterface');

    assert.equal(host.invoke(info, 'GetDocumentation', [0x60010003, OUT, 0, 0, 0]), 0);
    assert.equal(host.bstrs.get(host.u32(OUT)), 'Invoke');
    assert.equal(host.invoke(info, 'GetDocumentation', [-4, OUT, 0, 0, 0]), 0);
    assert.equal(host.bstrs.get(host.u32(OUT)), '_NewEnum');
    assert.equal(host.invoke(info, 'GetDocumentation', [-1, OUT, OUT2, 0, 0]), 0);
    assert.equal(host.bstrs.get(host.u32(OUT)), 'ISetupObjects');
});

test('names go both ways: GetNames, GetIDsOfNames, FindName and IsName', ()=>{
    const { host, lib } = setup();
    host.invoke(lib, 'GetTypeInfo', [33, OUT]);
    const info = host.u32(OUT);

    assert.equal(host.invoke(info, 'GetNames', [20, NAMES, 8, OUT]), 0);
    assert.equal(host.u32(OUT), 3, 'the method and its two parameters');
    assert.deepEqual([0, 1, 2].map(i=>host.bstrs.get(host.u32(NAMES + i * 4))),
        ['Add', 'Name', 'Object']);
    assert.equal(host.invoke(info, 'GetNames', [20, NAMES, 1, OUT]), 0);
    assert.equal(host.u32(OUT), 1, 'as many as there is room for');
    assert.equal(host.invoke(info, 'GetNames', [77, NAMES, 1, OUT]) >>> 0, 0x8002802b);

    host.putWide(0x400, 'add');
    host.putWide(0x420, 'object');
    host.putWide(0x440, 'nothing');
    host.putU32(NAMES, 0x400);
    host.putU32(NAMES + 4, 0x420);
    host.putU32(NAMES + 8, 0x440);
    assert.equal(host.invoke(info, 'GetIDsOfNames', [NAMES, 2, OUT]), 0);
    assert.deepEqual([host.u32(OUT), host.u32(OUT + 4)], [20, 1], 'member, then position');
    assert.equal(host.invoke(info, 'GetIDsOfNames', [NAMES, 3, OUT]) >>> 0, 0x80020006);
    assert.equal(host.u32(OUT + 8) | 0, -1, 'the unknown one is MEMBERID_NIL');
    host.putU32(NAMES, 0x440);
    assert.equal(host.invoke(info, 'GetIDsOfNames', [NAMES, 1, OUT]) >>> 0, 0x80020006);

    host.putWide(0x400, 'isetupobjects');
    assert.equal(host.invoke(lib, 'IsName', [0x400, 0, OUT]), 0);
    assert.equal(host.u32(OUT), 1);
    host.writeMemory(OUT2, Uint8Array.from([4, 0]));
    assert.equal(host.invoke(lib, 'FindName', [0x400, 0, NAMES, 0x500, OUT2]), 0);
    assert.equal(host.u16(OUT2), 1, 'one type found');
    assert.equal(host.u32(NAMES), info, 'the type, by its one pointer');
    assert.equal(host.u32(0x500) | 0, -1, 'MEMBERID_NIL for a type');
});

test('a name a derived dispinterface inherits is found, as its base would find it', ()=>{
    // ISetupOpSequence2 adds two methods to ISetupOpSequence; a program that
    // asks it for "Count" is asking for the base's member.
    const { host, lib } = setup();
    host.invoke(lib, 'GetTypeInfo', [26, OUT]);
    const info = host.u32(OUT);
    host.putWide(0x400, 'count');
    host.putU32(NAMES, 0x400);
    assert.equal(host.invoke(info, 'GetIDsOfNames', [NAMES, 1, OUT]), 0);
    assert.equal(host.u32(OUT), 1);
    host.putWide(0x400, 'getlast');
    assert.equal(host.invoke(info, 'GetIDsOfNames', [NAMES, 1, OUT]), 0);
    assert.equal(host.u32(OUT), 6, 'its own still come first');
    host.putWide(0x400, 'mainlog');
    assert.equal(host.invoke(info, 'GetIDsOfNames', [NAMES, 1, OUT]) >>> 0, 0x80020006,
        'a member of another type is still unknown');
});

test('references: the base, the dual twin, the standard imports, and the container', ()=>{
    const { host, lib } = setup();
    host.invoke(lib, 'GetTypeInfo', [33, OUT]);
    const info = host.u32(OUT);
    assert.equal(host.invoke(info, 'GetRefTypeOfImplType', [0, OUT]), 0);
    assert.equal(host.u32(OUT), 13, 'IDispatch, an import');
    assert.equal(host.invoke(info, 'GetImplTypeFlags', [0, OUT]), 0);
    assert.equal(host.u32(OUT), 0);
    assert.equal(host.invoke(info, 'GetRefTypeOfImplType', [1, OUT]) >>> 0, 0x8002802b);
    assert.equal(host.invoke(info, 'GetRefTypeOfImplType', [-1, OUT]), 0);
    assert.equal(host.invoke(info, 'GetRefTypeInfo', [host.u32(OUT) | 0, OUT2]), 0);
    assert.equal(host.u32(OUT2), info, 'the dual\'s twin is itself');

    assert.equal(host.invoke(info, 'GetRefTypeInfo', [13, OUT]), 0);
    const dispatch = host.u32(OUT);
    host.invoke(dispatch, 'GetTypeAttr', [OUT]);
    assert.equal(host.u16(host.u32(OUT) + 44), 7, 'IDispatch has seven methods');
    assert.equal(host.invoke(dispatch, 'GetDocumentation', [-1, OUT, 0, 0, 0]), 0);
    assert.equal(host.bstrs.get(host.u32(OUT)), 'IDispatch');
    assert.equal(host.invoke(info, 'GetRefTypeInfo', [13, OUT]), 0);
    assert.equal(host.u32(OUT), dispatch, 'made once');
    assert.equal(host.invoke(info, 'GetRefTypeInfo', [25, OUT]) >>> 0, 0x80029c4a,
        'an import named only by index cannot be described');
    assert.equal(host.reported.length, 1);

    assert.equal(host.invoke(info, 'GetContainingTypeLib', [OUT, OUT2]), 0);
    assert.equal(host.u32(OUT), lib);
    assert.equal(host.u32(OUT2), 33);
    host.invoke(lib, 'GetTypeInfo', [27, OUT]);
    const coclass = host.u32(OUT);
    assert.equal(host.invoke(coclass, 'GetRefTypeOfImplType', [0, OUT]), 0);
    assert.equal(host.u32(OUT), 28 * 0x64);
    assert.equal(host.invoke(coclass, 'GetImplTypeFlags', [0, OUT]), 0);
    assert.equal(host.u32(OUT), 1, 'IMPLTYPEFLAG_FDEFAULT');
});

test('a VARDESC carries a constant as a VARIANT, and an alias its TYPEDESC', ()=>{
    const { host, lib } = setup();
    host.invoke(lib, 'GetTypeInfo', [1, OUT]);
    const info = host.u32(OUT);
    assert.equal(host.invoke(info, 'GetVarDesc', [0, OUT]), 0);
    const desc = host.u32(OUT);
    assert.equal(host.u32(desc), 0x40000000, 'memid');
    assert.equal(host.u32(desc + 32), 2, 'VAR_CONST');
    assert.equal(host.u16(desc + 12 + 4), 22, 'VT_INT');
    const variant = host.u32(desc + 8);
    assert.equal(host.u16(variant), 3, 'VT_I4');
    assert.equal(host.u32(variant + 8), 769);
    host.invoke(info, 'ReleaseVarDesc', [desc]);
    assert.equal(host.blocks.size, 0);
    assert.equal(host.invoke(info, 'GetVarDesc', [4, OUT]) >>> 0, 0x8002802b);

    host.invoke(lib, 'GetTypeInfo', [20, OUT]);
    const alias = host.u32(OUT);
    host.invoke(alias, 'GetTypeAttr', [OUT]);
    const attr = host.u32(OUT);
    assert.equal(host.u32(attr + 40), 6, 'TKIND_ALIAS');
    assert.equal(host.u16(attr + 64), 29, 'tdescAlias.vt: VT_USERDEFINED');
    assert.equal(host.u32(attr + 60), 21 * 0x64, 'tdescAlias.hreftype');
});

test('what is not a module or a factory refuses the documented way', ()=>{
    const { host, lib } = setup();
    host.invoke(lib, 'GetTypeInfo', [10, OUT]);
    const info = host.u32(OUT);
    host.putU32(OUT, 1);
    assert.equal(host.invoke(info, 'AddressOfMember', [1, 2, OUT]) >>> 0, 0x80004001);
    assert.equal(host.u32(OUT), 0);
    host.putU32(OUT, 1);
    assert.equal(host.invoke(info, 'CreateInstance', [0, GUID, OUT]) >>> 0, 0x80004001);
    assert.equal(host.u32(OUT), 0);
    assert.equal(host.invoke(info, 'GetDllEntry', [1, 1, 0, 0, 0]) >>> 0, 0x80004001);
    assert.equal(host.invoke(info, 'GetMops', [1, OUT]), 0);
    assert.equal(host.u32(OUT), 0);
    assert.equal(host.invoke(info, 'Invoke', [0, 1, 2, 0, 0, 0, 0]) >>> 0, 0x80070057);
    assert.equal(host.invoke(info, 'Invoke', [0x2000, 999, 2, 0x2100, 0, 0, 0]) >>> 0, 0x80020003,
        'DISP_E_MEMBERNOTFOUND');
});

test('an adapter answers IUnknown and its own interfaces with one table each', ()=>{
    let destroyed = 0;
    const methods = Object.freeze([{ name: 'Only', argBytes: 4 }]);
    const adapter = createAdapter({ tag: 1 }, { [IID_ITYPELIB]: methods }, ()=>{
        destroyed++;
    });
    assert.equal(adapter.interfaceFor(IID_ITYPELIB)?.methods, methods);
    assert.equal(adapter.interfaceFor(IID_IUNKNOWN)?.id, IID_IUNKNOWN);
    assert.equal(adapter.interfaceFor(IID_ITYPEINFO), null);
    assert.equal(adapter.addRef(), 2);
    assert.equal(adapter.release(), 1);
    assert.equal(destroyed, 0);
    assert.equal(adapter.release(), 0);
    assert.equal(destroyed, 1);
    assert.equal(adapter.release(), 0, 'never below zero');
});

test('an adapter\'s last reference ends every interface it was published as', ()=>{
    // Its count is the object's, whichever interface a reference was taken
    // through, so the bridge forgets the ITypeLib and the IUnknown together.
    /** @type {Map<string, any>} */
    const handlers = new Map();
    let next = 0x2000;
    const vtables = createVtables({
        memory: { writeU32: ()=>{}, readBytes: (/** @type {number} */ at,
            /** @type {number} */ length)=>new Uint8Array(length) },
        register: (/** @type {string} */ name, /** @type {any} */ fn)=>{
            handlers.set(name, fn);
            return 0x1000 + handlers.size * 0x10;
        },
        heap: { allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        } },
    });
    const methods = Object.freeze([...IUNKNOWN_METHODS]);
    const adapter = createAdapter({}, { [IID_ITYPELIB]: methods });
    const typeLib = vtables.publish(adapter, IID_ITYPELIB);
    const unknown = vtables.publish(adapter, IID_IUNKNOWN);
    /** @param {string} id @param {string} name @param {number} pointer */
    const call = (id, name, pointer)=>handlers.get(`${id}::${name}`).handler([pointer]) >>> 0;

    assert.equal(adapter.destroyed, false);
    assert.equal(call(IID_IUNKNOWN, 'Release', unknown), 0);
    assert.equal(adapter.destroyed, true);
    assert.equal(call(IID_ITYPELIB, 'AddRef', typeLib), 0, 'no references: it is forgotten');
});
