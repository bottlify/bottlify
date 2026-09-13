/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInvoker, effectiveType } from './invoke.js';
import { parseTypeLib } from './typelib.js';

const library = parseTypeLib(
    new Uint8Array(readFileSync(new URL('./msft-typelib.bin', import.meta.url))));

/** Guest addresses the tests lay things out at. */
const INSTANCE = 0x1000;
const VTABLE = 0x1100;
const PARAMS = 0x1200;
const ARGS = 0x1300;
const RESULT = 0x1400;
const EXCEPINFO = 0x1500;
const ARGERR = 0x1600;

/** DISPATCH_* */
const METHOD = 1;
const PROPERTYGET = 2;
const PROPERTYPUT = 4;

function fakeHost(){
    const bytes = new Uint8Array(0x10000);
    /** @type {{ entry: number, args: number[] }[]} */
    const calls = [];
    /** @type {Map<number, string>} */
    const bstrs = new Map();
    /** @type {number[]} */
    const cleared = [];
    /** @type {string[]} */
    const reported = [];
    let nextBlock = 0x4000;
    const blocks = new Set();
    const host = {
        bytes, calls, bstrs, cleared, reported, blocks,
        /** What the fake method does when called: writes and an answer. */
        answer: /** @type {(entry: number, args: number[]) => number} */ (()=>0),
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        heap: {
            /** @param {number} size */
            allocate: size=>{
                const at = nextBlock;
                nextBlock += (size + 15) & ~15;
                blocks.add(at);
                return at;
            },
            /** @param {number} address */
            free: address=>blocks.delete(address),
        },
        /** @param {number} entry @param {number[]} args */
        call: (entry, args)=>{
            calls.push({ entry, args: [...args] });
            return Promise.resolve(host.answer(entry, args));
        },
        /** @param {number} pvar */
        clearVariant: pvar=>{
            cleared.push(pvar);
        },
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
        /** @param {number} address */
        u32: address=>(bytes[address] | (bytes[address + 1] << 8) | (bytes[address + 2] << 16)
            | (bytes[address + 3] << 24)) >>> 0,
        /** @param {number} address */
        u16: address=>bytes[address] | (bytes[address + 1] << 8),
        /** @param {number} address @param {number} value */
        putU32: (address, value)=>bytes.set([value & 0xff, (value >>> 8) & 0xff,
            (value >>> 16) & 0xff, (value >>> 24) & 0xff], address),
        /** @param {number} address @param {number} value */
        putU16: (address, value)=>bytes.set([value & 0xff, (value >>> 8) & 0xff], address),
        /**
         * A VARIANT at `at` of type `vt` holding a word.
         *
         * @param {number} at @param {number} vt @param {number} word
         */
        variant: (at, vt, word)=>{
            bytes.fill(0, at, at + 16);
            host.putU16(at, vt);
            host.putU32(at + 8, word);
        },
        /**
         * DISPPARAMS with `count` positional arguments at ARGS, last first.
         *
         * @param {number} count @param {number} [named]
         */
        params: (count, named = 0)=>{
            host.putU32(PARAMS, ARGS);
            host.putU32(PARAMS + 4, PARAMS + 16);
            host.putU32(PARAMS + 8, count);
            host.putU32(PARAMS + 12, named);
        },
    };
    // An instance whose vtable holds slot addresses of 0x5000 + slot.
    host.putU32(INSTANCE, VTABLE);
    for (let slot = 0; slot < 64; slot++)
    {
        host.putU32(VTABLE + slot * 4, 0x5000 + slot);
    }
    return host;
}

/** @param {string} typeName @param {string} member @param {number} kind */
const describe = (typeName, member, kind)=>{
    const type = library.typeInfos.find(entry=>entry.name === typeName);
    assert.ok(type);
    const fn = type.functions.find(entry=>entry.name === member && (entry.invokeKind & kind));
    assert.ok(fn, `${typeName}.${member}`);
    return { type, fn };
};

test('a property get: the retval slot is passed, read back, and put in the result', async()=>{
    const host = fakeHost();
    const invoker = createInvoker(host);
    const { type, fn } = describe('ISetupBasicFeature', 'Name', PROPERTYGET);
    host.params(0);
    const bstr = host.allocateBstr('a name');
    host.answer = (entry, [, slot])=>{
        host.putU32(slot, bstr);
        return 0;
    };
    host.putU32(RESULT, 0xdeadbeef);
    const hr = await invoker.invoke(library, type, fn, INSTANCE, PROPERTYGET, PARAMS, RESULT,
        EXCEPINFO, ARGERR);
    assert.equal(hr, 0);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].entry, 0x5000 + 7, 'slot 7: the first after IDispatch');
    assert.equal(host.calls[0].args[0], INSTANCE, 'the interface pointer first');
    assert.equal(host.calls[0].args.length, 2);
    assert.deepEqual(host.cleared, [RESULT], 'the result is cleared before it is written');
    assert.equal(host.u16(RESULT), 8, 'VT_BSTR');
    assert.equal(host.u32(RESULT + 8), bstr, 'owned by the result now');
    assert.equal(host.blocks.size, 1, 'the slots are freed, the string is not');
});

test('a method with arguments: variants become the declared types, in declaration order',
    async()=>{
        const host = fakeHost();
        const invoker = createInvoker(host);
        // Add(BSTR Name, ISetupObject *Object)
        const { type, fn } = describe('ISetupObjects', 'Add', METHOD);
        host.params(2);
        // The last argument comes first: an unknown pointer, then a long
        // where a BSTR is wanted.
        host.variant(ARGS, 13, 0x7770);
        host.variant(ARGS + 16, 3, 42);
        /** @type {string | undefined} */
        let spelled;
        host.answer = (entry, args)=>{
            spelled = host.bstrs.get(args[1]);
            return 0;
        };
        const hr = await invoker.invoke(library, type, fn, INSTANCE, METHOD, PARAMS, 0, 0, 0);
        assert.equal(hr, 0);
        const { entry, args } = host.calls[0];
        assert.equal(entry, 0x5000 + 10);
        assert.equal(args.length, 3);
        assert.equal(spelled, '42', 'the number spelled as a BSTR for the call');
        assert.equal(args[2], 0x7770, 'the interface pointer as it is');
        assert.equal(host.bstrs.size, 0, 'the temporary string is freed after the call');
        assert.equal(host.blocks.size, 0);
    });

test('a property put takes its value from the named argument, which sits first', async()=>{
    const host = fakeHost();
    const invoker = createInvoker(host);
    const { type, fn } = describe('ISetupBasicFeature', 'DisplayName', PROPERTYPUT);
    host.params(1, 1);
    host.putU32(PARAMS + 16, -3 >>> 0); // DISPID_PROPERTYPUT
    const bstr = host.allocateBstr('shown');
    host.variant(ARGS, 8, bstr);
    const hr = await invoker.invoke(library, type, fn, INSTANCE, PROPERTYPUT, PARAMS, 0, 0, 0);
    assert.equal(hr, 0);
    assert.deepEqual(host.calls[0].args, [INSTANCE, bstr], 'the caller\'s BSTR, not a copy');
    assert.equal(host.bstrs.get(bstr), 'shown', 'and not freed');

    host.putU32(PARAMS + 16, 5);
    assert.equal(await invoker.invoke(library, type, fn, INSTANCE, PROPERTYPUT, PARAMS, 0, 0, 0)
        >>> 0, 0x80020007, 'DISP_E_NONAMEDARGS for any other name');
});

test('a wrong count, a bad conversion, and a failing method are reported as documented',
    async()=>{
        const host = fakeHost();
        const invoker = createInvoker(host);
        const { type, fn } = describe('ISetupObjects', 'Add', METHOD);
        host.params(1);
        assert.equal(await invoker.invoke(library, type, fn, INSTANCE, METHOD, PARAMS, 0, 0, 0)
            >>> 0, 0x8002000e, 'DISP_E_BADPARAMCOUNT');

        host.params(2);
        host.variant(ARGS, 8, host.allocateBstr('not an object'));
        host.variant(ARGS + 16, 8, host.allocateBstr('name'));
        host.putU32(ARGERR, 99);
        assert.equal(await invoker.invoke(library, type, fn, INSTANCE, METHOD, PARAMS, 0, 0, ARGERR)
            >>> 0, 0x80020005, 'DISP_E_TYPEMISMATCH');
        assert.equal(host.u32(ARGERR), 1, 'the second argument');
        assert.equal(host.calls.length, 0);
        assert.equal(host.blocks.size, 2, 'only the caller\'s two strings remain');

        host.variant(ARGS, 13, 0x7770);
        host.answer = ()=>0x80004005 | 0;
        assert.equal(await invoker.invoke(library, type, fn, INSTANCE, METHOD, PARAMS, 0, 0, 0)
            >>> 0, 0x80004005, 'E_FAIL through, with no EXCEPINFO to fill');
        assert.equal(await invoker.invoke(library, type, fn, INSTANCE, METHOD, PARAMS, 0,
            EXCEPINFO, 0) >>> 0, 0x80020009, 'DISP_E_EXCEPTION with one');
        assert.equal(host.u32(EXCEPINFO + 28), 0x80004005, 'scode');
        assert.equal(host.blocks.size, 2);
    });

test('a retval of a user-defined type is an interface pointer of the right flavour',
    async()=>{
        const host = fakeHost();
        const invoker = createInvoker(host);
        // Log([out, retval] ISetupFeatureLog **pVal), a dispinterface
        const { type, fn } = describe('ISetupBasicFeature', 'Log', PROPERTYGET);
        host.params(0);
        host.answer = (entry, [, slot])=>{
            host.putU32(slot, 0x8880);
            return 0;
        };
        assert.equal(await invoker.invoke(library, type, fn, INSTANCE, PROPERTYGET, PARAMS,
            RESULT, 0, 0), 0);
        assert.equal(host.u16(RESULT), 9, 'VT_DISPATCH');
        assert.equal(host.u32(RESULT + 8), 0x8880);

        // _NewEnum([out, retval] IUnknown **pVal)
        const enumerator = describe('ISetupObjects', '_NewEnum', PROPERTYGET);
        assert.equal(await invoker.invoke(library, enumerator.type, enumerator.fn, INSTANCE,
            PROPERTYGET, PARAMS, RESULT, 0, 0), 0);
        assert.equal(host.u16(RESULT), 13, 'VT_UNKNOWN');

        // Nobody asked for the result: it is dropped and said so.
        assert.equal(await invoker.invoke(library, enumerator.type, enumerator.fn, INSTANCE,
            PROPERTYGET, PARAMS, 0, 0, 0), 0);
        assert.equal(host.reported.length, 1);
    });

test('a VARIANT parameter travels by value, and a pointer to one by address', async()=>{
    const host = fakeHost();
    const invoker = createInvoker(host);
    // Item(VARIANT Index, [out, retval] ISetupObject **pVal)
    const { type, fn } = describe('ISetupObjects', 'Item', PROPERTYGET);
    host.params(1);
    host.variant(ARGS, 3, 7);
    host.answer = (entry, args)=>{
        host.putU32(args[5], 0x9990);
        return 1;
    };
    assert.equal(await invoker.invoke(library, type, fn, INSTANCE, PROPERTYGET, PARAMS, RESULT,
        0, 0), 1, 'S_FALSE comes through as it is');
    const { args } = host.calls[0];
    assert.equal(args.length, 6, 'this, four words of VARIANT, the slot');
    assert.deepEqual(args.slice(1, 5), [3, 0, 7, 0]);
    assert.equal(host.u32(RESULT + 8), 0x9990);
});

test('what a described type is passed as', ()=>{
    /** @param {number} hreftype @returns {import('./typelib.js').TypeDescription} */
    const userDefined = hreftype=>({ vt: 29, element: null, hreftype, array: null });
    /** @param {import('./typelib.js').TypeDescription} element */
    const pointerTo = element=>({ vt: 26, element, hreftype: -1, array: null });
    assert.equal(effectiveType(library, userDefined(11 * 0x64)), 3, 'an enum is a long');
    assert.equal(effectiveType(library, userDefined(12 * 0x64)), 9,
        'a dispinterface is a dispatch pointer');
    assert.equal(effectiveType(library, userDefined(8 * 0x64)), 13,
        'a plain interface is an unknown pointer');
    assert.equal(effectiveType(library, userDefined(20 * 0x64)), 3, 'an alias of an enum');
    assert.equal(effectiveType(library, pointerTo(userDefined(12 * 0x64))), 9,
        'a pointer to an interface is the interface pointer');
    const bstr = { vt: 8, element: null, hreftype: -1, array: null };
    assert.equal(effectiveType(library, pointerTo(bstr)), 26,
        'a pointer to anything else is a pointer');
    assert.equal(effectiveType(library, { vt: 29, element: null, hreftype: 1, array: null }),
        13, 'an imported interface');
    assert.equal(effectiveType(library, { vt: 8, element: null, hreftype: -1, array: null }), 8);
});
