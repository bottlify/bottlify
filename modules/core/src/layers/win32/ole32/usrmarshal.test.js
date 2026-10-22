/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// The expectations are those of Wine's conformance tests
// (dlls/ole32/tests/usrmarshal.c), which say what Windows writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeObjref, encodeObjref } from './objref.js';
import { parseGuid } from './guid.js';
import { createUserMarshalFunctions } from './usrmarshal.js';

const WDT_INPROC_CALL = 0x48746457;
const WDT_REMOTE_CALL = 0x52746457;
const USER_MARSHAL_PTR_PREFIX = 0x72657355;
const NDR_LOCAL_DATA_REPRESENTATION = 0x10;

const MSHCTX_LOCAL = 0;
const MSHCTX_DIFFERENTMACHINE = 2;
const MSHCTX_INPROC = 3;

const RPC_S_INVALID_TAG = 1733;
const RPC_S_INVALID_BOUND = 1734;
const RPC_X_BAD_STUB_DATA = 1783;
const DV_E_TYMED = 0x80040069;
const DV_E_CLIPFORMAT = 0x8004006a;
const E_NOINTERFACE = 0x80004002 | 0;

const TYMED_NULL = 0;
const TYMED_HGLOBAL = 1;
const TYMED_FILE = 2;
const TYMED_ISTREAM = 4;
const TYMED_GDI = 16;

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_ISTREAM = '{0000000C-0000-0000-C000-000000000046}';

/** Guest addresses the fixtures use. */
const UMCB = 0x1000;
const STUB_MESSAGE = 0x1100;
const SLOT = 0x1400;
const SLOT2 = 0x1410;
const MEDIUM = 0x1500;
const MEDIUM2 = 0x1520;
const RIID_UNKNOWN = 0x1600;
const RIID_STREAM = 0x1610;
const STRINGS = 0x1800;
const VTABLE = 0x1f00;
const BUFFER = 0x10000;
const EXPECT = 0x20000;
const HEAP = 0x40000;

/** Fake entry points the guest's vtables and stub message name. */
const QUERY_INTERFACE = 0xf0000;
const ADD_REF = 0xf0004;
const RELEASE = 0xf0008;
const STUB_ALLOCATE = 0xf000c;
const STUB_FREE = 0xf0010;

class Raised extends Error {
    /** @param {number} code @param {boolean} later */
    constructor(code, later){
        super(`raised 0x${(code >>> 0).toString(16)}`);
        this.code = code >>> 0;
        this.later = later;
    }
}

/**
 * A process: its memory and heap, guest COM objects counting references, a
 * marshaler that makes an OBJREF whose reference is the object's own, and
 * gdi32 and user32 as far as these routines lean on them. `end` is where an
 * allocation ends and nothing may lie past it: memory refuses a read across it.
 *
 * @param {{ gdi?: boolean, clipboard?: boolean, call?: boolean, end?: number }} [options]
 */
function setup(options = {}){
    const memory = new Uint8Array(0x100000);
    const view = new DataView(memory.buffer);
    /** @type {Map<number, number>} */
    const heapBlocks = new Map();
    let next = HEAP;
    const heap = {
        /** @param {number} bytes */
        allocate(bytes){
            const address = next;
            next += Math.max(bytes, 4) + 12 & ~3;
            heapBlocks.set(address, bytes);
            return address;
        },
        /** @param {number} address */
        free: address=>heapBlocks.delete(address),
        /** @param {number} address */
        block: address=>(heapBlocks.has(address)
            ? { size: /** @type {number} */ (heapBlocks.get(address)) }
            : null),
    };
    /** @type {Map<number, { refs: number, iids: string[] }>} */
    const objects = new Map();
    /** @param {number} address @param {string[]} iids */
    const object = (address, iids)=>{
        view.setUint32(address, VTABLE, true);
        const state = { refs: 1, iids };
        objects.set(address, state);
        return state;
    };
    view.setUint32(VTABLE, QUERY_INTERFACE, true);
    view.setUint32(VTABLE + 4, ADD_REF, true);
    view.setUint32(VTABLE + 8, RELEASE, true);
    memory.set(/** @type {Uint8Array} */ (parseGuid(IID_IUNKNOWN)), RIID_UNKNOWN);
    memory.set(/** @type {Uint8Array} */ (parseGuid(IID_ISTREAM)), RIID_STREAM);

    const readGuidAt = (/** @type {number} */ address)=>[...memory.subarray(address, address + 16)]
        .map(byte=>byte.toString(16).padStart(2, '0')).join('');
    const guidHex = (/** @type {string} */ guid)=>[.../** @type {Uint8Array} */ (parseGuid(guid))]
        .map(byte=>byte.toString(16).padStart(2, '0')).join('');

    const calls = { allocate: 0, free: 0 };
    /** @type {Map<number, (...args: number[]) => number>} */
    const entries = new Map([
        [QUERY_INTERFACE, (self, riid, out)=>{
            const state = /** @type {{ refs: number, iids: string[] }} */ (objects.get(self));
            if (state.iids.some(iid=>guidHex(iid) === readGuidAt(riid)))
            {
                state.refs++;
                view.setUint32(out, self, true);
                return 0;
            }
            view.setUint32(out, 0, true);
            return E_NOINTERFACE;
        }],
        [ADD_REF, self=>++(/** @type {{ refs: number }} */ (objects.get(self))).refs],
        [RELEASE, self=>--(/** @type {{ refs: number }} */ (objects.get(self))).refs],
        [STUB_ALLOCATE, bytes=>{
            calls.allocate++;
            return heap.allocate(bytes);
        }],
        [STUB_FREE, address=>{
            calls.free++;
            heap.free(address);
            return 0;
        }],
    ]);

    /** @type {Map<number, Uint8Array>} */
    const metafiles = new Map();
    /** @type {Map<number, { header: Uint8Array, bits: Uint8Array }>} */
    const bitmaps = new Map();
    let nextHandle = 0x5000;
    /** @param {Uint8Array} bits */
    const keep = bits=>{
        const handle = nextHandle;
        nextHandle += 4;
        metafiles.set(handle, bits);
        return handle;
    };
    /** @type {Map<number, string>} */
    const formats = new Map([[0xc123, 'MyFormat']]);
    /** @type {string[]} */
    const divergences = [];

    /** @type {import('./usrmarshal.js').UserMarshalHost} */
    const host = {
        readMemory: (address, length)=>{
            const end = options.end ?? 0;
            assert.ok(address >= end || address + length <= end, `read of ${length} bytes at`
                + ` 0x${address.toString(16)} runs past the end of an allocation`);
            return memory.subarray(address, address + length);
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        heap,
        raise: code=>{
            throw new Raised(code, false);
        },
        raiseLater: async code=>{
            throw new Raised(code, true);
        },
        call: options.call === false ? undefined : async(entry, args)=>{
            const run = entries.get(entry);
            assert.ok(run, `no guest routine at 0x${entry.toString(16)}`);
            return run(...args);
        },
        callerThread: ()=>'caller',
        marshaler: ()=>({
            async marshal(pointer, iid){
                const state = objects.get(pointer);
                if (!state)
                {
                    return { hr: 0x80070057 | 0, objref: null };
                }
                state.refs++;
                const bytes = /** @type {Uint8Array} */ (parseGuid(iid));
                return { hr: 0, objref: encodeObjref(bytes, { endpoint: 7, object: pointer }) };
            },
            async unmarshal(objref){
                const decoded = decodeObjref(objref);
                return decoded ? { hr: 0, pointer: decoded.reference.object }
                    : { hr: 0x8001011d | 0, pointer: 0 };
            },
        }),
        clipboardFormats: options.clipboard === false ? undefined : {
            name: format=>formats.get(format) ?? null,
            register(name){
                for (const [format, known] of formats)
                {
                    if (known === name)
                    {
                        return format;
                    }
                }
                const format = 0xc000 + formats.size + 0x200;
                formats.set(format, name);
                return format;
            },
        },
        gdi: options.gdi === false ? undefined : {
            bitmap: handle=>bitmaps.get(handle) ?? null,
            createBitmap: (header, bits)=>{
                const handle = nextHandle;
                nextHandle += 4;
                bitmaps.set(handle, { header, bits });
                return handle;
            },
            deleteObject: handle=>bitmaps.delete(handle),
            enhMetaFileBits: handle=>metafiles.get(handle) ?? null,
            createEnhMetaFile: keep,
            deleteEnhMetaFile: handle=>metafiles.delete(handle),
            metaFileBits: handle=>metafiles.get(handle) ?? null,
            createMetaFile: keep,
            deleteMetaFile: handle=>metafiles.delete(handle),
        },
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    };
    const fns = createUserMarshalFunctions(host);

    /**
     * A USER_MARSHAL_CB for `context`, as the NDR engine hands one in.
     *
     * @param {number} context
     */
    const umcb = context=>{
        view.setUint32(UMCB, (NDR_LOCAL_DATA_REPRESENTATION << 16 | context) >>> 0, true);
        view.setUint32(UMCB + 4, STUB_MESSAGE, true);
        view.setUint32(UMCB + 12, 0x55535243, true);
        view.setUint32(STUB_MESSAGE + 0x48, STUB_ALLOCATE, true);
        view.setUint32(STUB_MESSAGE + 0x4c, STUB_FREE, true);
        return UMCB;
    };
    /** @param {string} name @param {number[]} args */
    const run = (name, args)=>{
        const fn = fns[name];
        assert.ok(fn, `${name} is exported`);
        return fn.handler(args);
    };
    return {
        memory, view, heap, heapBlocks, objects, object, metafiles, bitmaps, keep, formats,
        divergences, calls, fns, umcb, run,
        /** @param {number} address */
        u32: address=>view.getUint32(address, true),
        /** @param {number} address */
        u16: address=>view.getUint16(address, true),
        /** @param {number} address @param {number} value */
        set32: (address, value)=>view.setUint32(address, value >>> 0, true),
        /** @param {number} address @param {number} length @param {number} value */
        fill: (address, length, value)=>memory.fill(value, address, address + length),
    };
}

test('every export of the spec is there, with its argument bytes', ()=>{
    const { fns } = setup();
    const types = ['CLIPFORMAT', 'HACCEL', 'HBITMAP', 'HBRUSH', 'HDC', 'HENHMETAFILE', 'HGLOBAL',
        'HICON', 'HMENU', 'HMETAFILEPICT', 'HMETAFILE', 'HPALETTE', 'HWND', 'SNB', 'STGMEDIUM'];
    /** @type {Record<string, number>} */
    const expected = {
        WdtpInterfacePointer_UserSize: 20,
        WdtpInterfacePointer_UserMarshal: 20,
        WdtpInterfacePointer_UserUnmarshal: 16,
        WdtpInterfacePointer_UserFree: 4,
        ReleaseStgMedium: 4,
    };
    for (const type of types)
    {
        expected[`${type}_UserSize`] = 12;
        expected[`${type}_UserMarshal`] = 12;
        expected[`${type}_UserUnmarshal`] = 12;
        expected[`${type}_UserFree`] = 8;
    }
    assert.deepEqual(Object.keys(fns).sort(), Object.keys(expected).sort());
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fns[name].argBytes, argBytes, name);
    }
});

test('CLIPFORMAT: a registered format goes to another machine by name', ()=>{
    const p = setup();
    const cfMarshaled = [9, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0,
        ...[...'MyFormat'].flatMap(c=>[c.charCodeAt(0), 0]), 0, 0];
    p.view.setUint16(SLOT, 0xc123, true);
    const size = p.run('CLIPFORMAT_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 1, SLOT]);
    assert.equal(size, 12 + cfMarshaled.length);
    p.fill(BUFFER, size + 8, 0xcc);
    const end = p.run('CLIPFORMAT_UserMarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT]);
    assert.equal(end, BUFFER + 12 + cfMarshaled.length);
    assert.equal(p.u32(BUFFER + 4), WDT_REMOTE_CALL);
    assert.equal(p.u32(BUFFER + 8), 0xc123);
    assert.deepEqual([...p.memory.subarray(BUFFER + 12, end)], cfMarshaled);
    assert.deepEqual([...p.memory.subarray(end, end + 8)], new Array(8).fill(0xcc));

    // The other side registers the name and gets its own number for it.
    p.formats.delete(0xc123);
    assert.equal(p.run('CLIPFORMAT_UserUnmarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT2]), end);
    assert.equal(p.formats.get(p.u16(SLOT2)), 'MyFormat');
    assert.equal(p.run('CLIPFORMAT_UserFree', [p.umcb(MSHCTX_DIFFERENTMACHINE), SLOT2]), 0);
});

test('CLIPFORMAT: the number alone for a predefined format or a nearer context', ()=>{
    const p = setup();
    for (const [context, format] of [[MSHCTX_DIFFERENTMACHINE, 1], [MSHCTX_LOCAL, 0xc123],
        [MSHCTX_INPROC, 0xc123]])
    {
        p.view.setUint16(SLOT, format, true);
        assert.equal(p.run('CLIPFORMAT_UserSize', [p.umcb(context), 1, SLOT]), 12);
        assert.equal(p.run('CLIPFORMAT_UserMarshal', [p.umcb(context), BUFFER + 1, SLOT]),
            BUFFER + 12);
        assert.equal(p.u32(BUFFER + 4), WDT_INPROC_CALL);
        assert.equal(p.u32(BUFFER + 8), format);
        p.view.setUint16(SLOT2, 0, true);
        assert.equal(p.run('CLIPFORMAT_UserUnmarshal', [p.umcb(context), BUFFER + 1, SLOT2]),
            BUFFER + 12);
        assert.equal(p.u16(SLOT2), format);
    }
});

test('CLIPFORMAT: what cannot be named or read is raised', ()=>{
    const p = setup();
    p.view.setUint16(SLOT, 0xc999, true);
    assert.throws(()=>p.run('CLIPFORMAT_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 0, SLOT]),
        { code: DV_E_CLIPFORMAT, later: false });
    p.set32(BUFFER, 0x12345678);
    assert.throws(()=>p.run('CLIPFORMAT_UserUnmarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER, SLOT]), { code: RPC_S_INVALID_TAG });
    // A name whose last character is not its terminator.
    for (const [index, word] of [WDT_REMOTE_CALL, 0xc123, 2, 0, 2, 0x00410041].entries())
    {
        p.set32(BUFFER + index * 4, word);
    }
    assert.throws(()=>p.run('CLIPFORMAT_UserUnmarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER, SLOT]), { code: RPC_S_INVALID_BOUND });
});

for (const type of ['HWND', 'HDC', 'HICON', 'HBRUSH', 'HMENU', 'HACCEL', 'HPALETTE'])
{
    test(`${type}: the handle itself within the machine`, ()=>{
        const p = setup();
        p.set32(SLOT, 0x10024);
        for (const context of [MSHCTX_LOCAL, MSHCTX_INPROC])
        {
            assert.equal(p.run(`${type}_UserSize`, [p.umcb(context), 1, SLOT]), 4 + 8);
            assert.equal(p.run(`${type}_UserMarshal`, [p.umcb(context), BUFFER + 1, SLOT]),
                BUFFER + 12);
            assert.equal(p.u32(BUFFER + 4), WDT_INPROC_CALL);
            assert.equal(p.u32(BUFFER + 8), 0x10024);
            p.set32(SLOT2, 0);
            assert.equal(p.run(`${type}_UserUnmarshal`, [p.umcb(context), BUFFER + 1, SLOT2]),
                BUFFER + 12);
            assert.equal(p.u32(SLOT2), 0x10024);
            assert.equal(p.run(`${type}_UserFree`, [p.umcb(context), SLOT2]), 0);
        }
    });

    test(`${type}: refused to another machine, and from anything but its own form`, ()=>{
        const p = setup();
        assert.throws(()=>p.run(`${type}_UserSize`, [p.umcb(MSHCTX_DIFFERENTMACHINE), 0, SLOT]),
            { code: RPC_S_INVALID_TAG, later: false });
        assert.throws(()=>p.run(`${type}_UserMarshal`,
            [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER, SLOT]), { code: RPC_S_INVALID_TAG });
        p.set32(BUFFER, WDT_REMOTE_CALL);
        assert.throws(()=>p.run(`${type}_UserUnmarshal`, [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT]),
            { code: RPC_X_BAD_STUB_DATA });
        assert.equal(p.divergences.length, type === 'HPALETTE' ? 2 : 0);
    });
}

test('HGLOBAL: NULL across processes is the tag and a zero handle', ()=>{
    const p = setup();
    p.set32(SLOT, 0);
    assert.equal(p.run('HGLOBAL_UserSize', [p.umcb(MSHCTX_LOCAL), 0, SLOT]), 8);
    assert.equal(p.run('HGLOBAL_UserMarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT]), BUFFER + 8);
    assert.equal(p.u32(BUFFER), WDT_REMOTE_CALL);
    assert.equal(p.u32(BUFFER + 4), 0);
    p.set32(SLOT2, 0x1234);
    assert.equal(p.run('HGLOBAL_UserUnmarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT2]),
        BUFFER + 8);
    assert.equal(p.u32(SLOT2), 0);
    p.run('HGLOBAL_UserFree', [p.umcb(MSHCTX_LOCAL), SLOT2]);
});

test('HGLOBAL: a block across processes goes with its bytes', ()=>{
    const p = setup();
    for (let blockSize = 0; blockSize <= 17; blockSize++)
    {
        const hglobal = p.heap.allocate(blockSize);
        for (let i = 0; i < blockSize; i++)
        {
            p.memory[hglobal + i] = i;
        }
        p.set32(SLOT, hglobal);
        const actual = /** @type {{ size: number }} */ (p.heap.block(hglobal)).size;
        const size = p.run('HGLOBAL_UserSize', [p.umcb(MSHCTX_LOCAL), 0, SLOT]);
        assert.equal(size, actual + 5 * 4, `block of ${blockSize}`);
        assert.equal(p.run('HGLOBAL_UserMarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT]),
            BUFFER + size);
        assert.deepEqual([0, 4, 8, 12, 16].map(at=>p.u32(BUFFER + at)),
            [WDT_REMOTE_CALL, hglobal, actual, hglobal, actual]);
        for (let i = 0; i < blockSize; i++)
        {
            assert.equal(p.memory[BUFFER + 20 + i], i);
        }

        p.set32(SLOT2, 0);
        assert.equal(p.run('HGLOBAL_UserUnmarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT2]),
            BUFFER + size);
        const copy = p.u32(SLOT2);
        assert.notEqual(copy, 0);
        assert.notEqual(copy, hglobal);
        assert.deepEqual([...p.memory.subarray(copy, copy + blockSize)],
            [...p.memory.subarray(hglobal, hglobal + blockSize)]);
        p.run('HGLOBAL_UserFree', [p.umcb(MSHCTX_LOCAL), SLOT2]);
        assert.equal(p.heap.block(copy), null, 'the copy is freed');
        assert.notEqual(p.heap.block(hglobal), null, 'the original is not');
    }
});

test('HGLOBAL: in-process it is the handle, and freeing it frees nothing', ()=>{
    const p = setup();
    const hglobal = p.heap.allocate(16);
    p.set32(SLOT, hglobal);
    assert.equal(p.run('HGLOBAL_UserSize', [p.umcb(MSHCTX_INPROC), 1, SLOT]), 12);
    assert.equal(p.run('HGLOBAL_UserMarshal', [p.umcb(MSHCTX_INPROC), BUFFER + 1, SLOT]),
        BUFFER + 12);
    assert.deepEqual([p.u32(BUFFER + 4), p.u32(BUFFER + 8)], [WDT_INPROC_CALL, hglobal]);
    assert.equal(p.run('HGLOBAL_UserUnmarshal', [p.umcb(MSHCTX_INPROC), BUFFER + 1, SLOT2]),
        BUFFER + 12);
    assert.equal(p.u32(SLOT2), hglobal);
    p.run('HGLOBAL_UserFree', [p.umcb(MSHCTX_INPROC), SLOT2]);
    assert.notEqual(p.heap.block(hglobal), null);
});

test('HGLOBAL: a wire form that contradicts itself is raised', ()=>{
    const p = setup();
    for (const [index, word] of [WDT_REMOTE_CALL, 0x4000, 4, 0x4004, 4].entries())
    {
        p.set32(BUFFER + index * 4, word);
    }
    assert.throws(()=>p.run('HGLOBAL_UserUnmarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT]),
        { code: RPC_X_BAD_STUB_DATA });
    p.set32(BUFFER, 0x11111111);
    assert.throws(()=>p.run('HGLOBAL_UserUnmarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT]),
        { code: RPC_S_INVALID_TAG });
});

/** An EMF's first record is EMR_HEADER (1); the rest is opaque here. */
const emfBits = ()=>Uint8Array.from({ length: 108 }, (_, i)=>(i === 0 ? 1 : i < 4 ? 0 : i & 0xff));
/** A WMF starts with mtType 1. */
const wmfBits = ()=>Uint8Array.from({ length: 50 }, (_, i)=>(i === 0 ? 1 : i < 2 ? 0 : i));

test('HENHMETAFILE: to another machine it goes with its bits', ()=>{
    const p = setup();
    const hemf = p.keep(emfBits());
    p.set32(SLOT, hemf);
    const size = p.run('HENHMETAFILE_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 1, SLOT]);
    assert.ok(size > 24);
    assert.equal(p.run('HENHMETAFILE_UserMarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT]), BUFFER + size);
    assert.deepEqual([4, 8, 12, 16, 20].map(at=>p.u32(BUFFER + at)),
        [WDT_REMOTE_CALL, hemf, size - 0x14, size - 0x14, 1]);

    assert.equal(p.run('HENHMETAFILE_UserUnmarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT2]), BUFFER + size);
    const copy = p.u32(SLOT2);
    assert.ok(copy !== 0 && copy !== hemf);
    assert.deepEqual(p.metafiles.get(copy), emfBits());
    p.run('HENHMETAFILE_UserFree', [p.umcb(MSHCTX_DIFFERENTMACHINE), SLOT2]);
    assert.equal(p.metafiles.has(copy), false);
    assert.equal(p.metafiles.has(hemf), true);

    p.set32(SLOT, 0);
    assert.equal(p.run('HENHMETAFILE_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 1, SLOT]), 12);
    assert.equal(p.run('HENHMETAFILE_UserMarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT]), BUFFER + 12);
    assert.deepEqual([p.u32(BUFFER + 4), p.u32(BUFFER + 8)], [WDT_REMOTE_CALL, 0]);
    p.set32(SLOT2, 0x77);
    assert.equal(p.run('HENHMETAFILE_UserUnmarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT2]), BUFFER + 12);
    assert.equal(p.u32(SLOT2), 0);
    assert.deepEqual(p.divergences, []);
});

test('HENHMETAFILE: with no gdi32 to copy it, the handle goes and the difference is said', ()=>{
    const p = setup({ gdi: false });
    p.set32(SLOT, 0x5000);
    assert.equal(p.run('HENHMETAFILE_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 1, SLOT]), 12);
    assert.equal(p.run('HENHMETAFILE_UserMarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT]), BUFFER + 12);
    assert.deepEqual([p.u32(BUFFER + 4), p.u32(BUFFER + 8)], [WDT_INPROC_CALL, 0x5000]);
    assert.equal(p.divergences.length, 1);
});

test('HMETAFILE: to another machine it goes with its bits', ()=>{
    const p = setup();
    const hmf = p.keep(wmfBits());
    p.set32(SLOT, hmf);
    const size = p.run('HMETAFILE_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 0, SLOT]);
    assert.ok(size > 20);
    assert.equal(p.run('HMETAFILE_UserMarshal', [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER, SLOT]),
        BUFFER + size);
    assert.deepEqual([0, 4, 8, 12].map(at=>p.u32(BUFFER + at)),
        [WDT_REMOTE_CALL, hmf, size - 0x10, size - 0x10]);
    assert.equal(p.u16(BUFFER + 16), 1);
    p.run('HMETAFILE_UserUnmarshal', [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER, SLOT2]);
    assert.deepEqual(p.metafiles.get(p.u32(SLOT2)), wmfBits());
    p.run('HMETAFILE_UserFree', [p.umcb(MSHCTX_DIFFERENTMACHINE), SLOT2]);
    assert.equal(p.metafiles.size, 1);

    p.set32(SLOT, 0);
    assert.equal(p.run('HMETAFILE_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 0, SLOT]), 8);
    p.run('HMETAFILE_UserMarshal', [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER, SLOT]);
    assert.deepEqual([p.u32(BUFFER), p.u32(BUFFER + 4)], [WDT_REMOTE_CALL, 0]);
    p.set32(SLOT2, 0x77);
    p.run('HMETAFILE_UserUnmarshal', [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER, SLOT2]);
    assert.equal(p.u32(SLOT2), 0);
});

test('HMETAFILEPICT: the picture, NDR\'s pointer mark, then its metafile', ()=>{
    const p = setup();
    const MM_ISOTROPIC = 7;
    const hmf = p.keep(wmfBits());
    const hmfp = p.heap.allocate(16);
    [MM_ISOTROPIC, 1, 2, hmf].forEach((word, index)=>p.set32(hmfp + index * 4, word));
    p.set32(SLOT, hmfp);
    const size = p.run('HMETAFILEPICT_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 1, SLOT]);
    assert.ok(size > 24);
    const end = p.run('HMETAFILEPICT_UserMarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT]);
    assert.equal(end, BUFFER + size);
    assert.deepEqual([4, 8, 0xc, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x28]
        .map(at=>p.u32(BUFFER + at)), [WDT_REMOTE_CALL, hmfp, MM_ISOTROPIC, 1, 2,
        USER_MARSHAL_PTR_PREFIX, WDT_REMOTE_CALL, hmf, end - BUFFER - 0x2c, end - BUFFER - 0x2c]);
    assert.equal(p.u16(BUFFER + 0x2c), 1);

    assert.equal(p.run('HMETAFILEPICT_UserUnmarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT2]), end);
    const copy = p.u32(SLOT2);
    assert.ok(copy !== 0 && copy !== hmfp);
    assert.deepEqual([0, 4, 8].map(at=>p.u32(copy + at)), [MM_ISOTROPIC, 1, 2]);
    const copiedMetafile = p.u32(copy + 12);
    assert.deepEqual(p.metafiles.get(copiedMetafile), wmfBits());
    p.run('HMETAFILEPICT_UserFree', [p.umcb(MSHCTX_DIFFERENTMACHINE), SLOT2]);
    assert.equal(p.heap.block(copy), null);
    assert.equal(p.metafiles.has(copiedMetafile), false);
    assert.equal(p.metafiles.has(hmf), true);

    p.set32(SLOT, 0);
    assert.equal(p.run('HMETAFILEPICT_UserSize', [p.umcb(MSHCTX_DIFFERENTMACHINE), 1, SLOT]), 12);
    assert.equal(p.run('HMETAFILEPICT_UserMarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT]), BUFFER + 12);
    assert.deepEqual([p.u32(BUFFER + 4), p.u32(BUFFER + 8)], [WDT_REMOTE_CALL, 0]);
    p.set32(SLOT2, 0x77);
    assert.equal(p.run('HMETAFILEPICT_UserUnmarshal',
        [p.umcb(MSHCTX_DIFFERENTMACHINE), BUFFER + 1, SLOT2]), BUFFER + 12);
    assert.equal(p.u32(SLOT2), 0);
});

test('HBITMAP: the handle in-process, the BITMAP and its bits out of it', ()=>{
    const p = setup();
    const header = Uint8Array.from([0, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0, 2, 0, 0, 0, 1, 0, 1, 0]);
    const bits = Uint8Array.from({ length: 32 }, (_, i)=>i * 3);
    const hbitmap = 0x6000;
    p.bitmaps.set(hbitmap, { header, bits });
    p.set32(SLOT, hbitmap);

    assert.equal(p.run('HBITMAP_UserSize', [p.umcb(MSHCTX_INPROC), 1, SLOT]), 0xc);
    assert.equal(p.run('HBITMAP_UserMarshal', [p.umcb(MSHCTX_INPROC), BUFFER + 1, SLOT]),
        BUFFER + 0xc);
    assert.deepEqual([p.u32(BUFFER + 4), p.u32(BUFFER + 8)], [WDT_INPROC_CALL, hbitmap]);
    p.run('HBITMAP_UserUnmarshal', [p.umcb(MSHCTX_INPROC), BUFFER + 1, SLOT2]);
    assert.equal(p.u32(SLOT2), hbitmap);
    p.run('HBITMAP_UserFree', [p.umcb(MSHCTX_INPROC), SLOT2]);
    assert.equal(p.bitmaps.has(hbitmap), true);

    const size = p.run('HBITMAP_UserSize', [p.umcb(MSHCTX_LOCAL), 1, SLOT]);
    assert.equal(size, 0x10 + header.length + bits.length);
    assert.equal(p.run('HBITMAP_UserMarshal', [p.umcb(MSHCTX_LOCAL), BUFFER + 1, SLOT]),
        BUFFER + 0x10 + header.length + bits.length);
    assert.deepEqual([4, 8, 0xc].map(at=>p.u32(BUFFER + at)),
        [WDT_REMOTE_CALL, hbitmap, bits.length]);
    assert.deepEqual(p.memory.subarray(BUFFER + 0x10, BUFFER + 0x10 + header.length), header);
    assert.deepEqual(p.memory.subarray(BUFFER + 0x10 + header.length, BUFFER + size), bits);
    p.run('HBITMAP_UserUnmarshal', [p.umcb(MSHCTX_LOCAL), BUFFER + 1, SLOT2]);
    const copy = p.u32(SLOT2);
    assert.ok(copy !== 0 && copy !== hbitmap);
    assert.deepEqual(p.bitmaps.get(copy), { header, bits });
    p.run('HBITMAP_UserFree', [p.umcb(MSHCTX_LOCAL), SLOT2]);
    assert.equal(p.bitmaps.has(copy), false);
});

test('WdtpInterfacePointer: NULL takes nothing at all', ()=>{
    const p = setup();
    assert.equal(p.run('WdtpInterfacePointer_UserSize',
        [p.umcb(MSHCTX_INPROC), MSHCTX_INPROC, 0, 0, RIID_UNKNOWN]), 0);
    assert.equal(p.run('WdtpInterfacePointer_UserSize',
        [p.umcb(MSHCTX_INPROC), MSHCTX_INPROC, 3, 0, RIID_UNKNOWN]), 3);
    assert.equal(p.run('WdtpInterfacePointer_UserMarshal',
        [p.umcb(MSHCTX_INPROC), MSHCTX_INPROC, BUFFER + 1, 0, RIID_UNKNOWN]), BUFFER + 1);
});

test('WdtpInterfacePointer: the OBJREF, its length twice ahead, read back for the old', async()=>{
    const combinations = [
        [MSHCTX_INPROC, MSHCTX_INPROC], [MSHCTX_DIFFERENTMACHINE, MSHCTX_INPROC],
        [MSHCTX_INPROC, (0xffff << 16 | MSHCTX_INPROC) >>> 0],
        [MSHCTX_INPROC, MSHCTX_DIFFERENTMACHINE],
        [MSHCTX_DIFFERENTMACHINE, MSHCTX_DIFFERENTMACHINE],
        [MSHCTX_INPROC, (0xffff << 16 | MSHCTX_DIFFERENTMACHINE) >>> 0],
    ];
    for (const [umcbContext, real] of combinations)
    {
        const p = setup();
        const UNKNOWN = 0x2000;
        const UNKNOWN2 = 0x2040;
        const unknown = p.object(UNKNOWN, [IID_IUNKNOWN]);
        const unknown2 = p.object(UNKNOWN2, [IID_IUNKNOWN]);
        const objref = encodeObjref(/** @type {Uint8Array} */ (parseGuid(IID_IUNKNOWN)),
            { endpoint: 7, object: UNKNOWN });

        const size = p.run('WdtpInterfacePointer_UserSize',
            [p.umcb(umcbContext), real, 0, UNKNOWN, RIID_UNKNOWN]);
        assert.ok(size >= objref.length + 8);
        const end = await p.run('WdtpInterfacePointer_UserMarshal',
            [p.umcb(umcbContext), real, BUFFER, UNKNOWN, RIID_UNKNOWN]);
        assert.equal(end, BUFFER + objref.length + 8);
        assert.deepEqual([p.u32(BUFFER), p.u32(BUFFER + 4)], [objref.length, objref.length]);
        assert.deepEqual(p.memory.subarray(BUFFER + 8, end), objref);
        assert.equal(unknown.refs, 2, 'the packet carries a reference');

        p.set32(SLOT, UNKNOWN2);
        assert.equal(await p.run('WdtpInterfacePointer_UserUnmarshal',
            [p.umcb(umcbContext), BUFFER, SLOT, RIID_UNKNOWN]), end);
        assert.equal(p.u32(SLOT), UNKNOWN);
        assert.equal(unknown.refs, 2, 'the reference it carried is the one handed over');
        assert.equal(unknown2.refs, 0, 'the pointer it replaced is released');
        assert.equal(await p.run('WdtpInterfacePointer_UserFree', [UNKNOWN]), 0);
        assert.equal(unknown.refs, 1);
    }
});

test('WdtpInterfacePointer: read back as another interface, the object is asked for it', async()=>{
    const p = setup();
    const STREAM = 0x2000;
    const stream = p.object(STREAM, [IID_IUNKNOWN, IID_ISTREAM]);
    await p.run('WdtpInterfacePointer_UserMarshal',
        [p.umcb(MSHCTX_LOCAL), MSHCTX_LOCAL, BUFFER, STREAM, RIID_UNKNOWN]);
    p.set32(SLOT, 0);
    await p.run('WdtpInterfacePointer_UserUnmarshal',
        [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT, RIID_STREAM]);
    assert.equal(p.u32(SLOT), STREAM);
    assert.equal(stream.refs, 2);

    const OTHER = 0x2040;
    p.object(OTHER, [IID_IUNKNOWN]);
    await p.run('WdtpInterfacePointer_UserMarshal',
        [p.umcb(MSHCTX_LOCAL), MSHCTX_LOCAL, BUFFER, OTHER, RIID_UNKNOWN]);
    await assert.rejects(p.run('WdtpInterfacePointer_UserUnmarshal',
        [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT, RIID_STREAM]),
    { code: E_NOINTERFACE >>> 0, later: true });
});

test('WdtpInterfacePointer: a length that disagrees with itself is raised', async()=>{
    const p = setup();
    p.set32(BUFFER, 72);
    p.set32(BUFFER + 4, 71);
    await assert.rejects(p.run('WdtpInterfacePointer_UserUnmarshal',
        [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT, RIID_UNKNOWN]),
    { code: RPC_X_BAD_STUB_DATA, later: true });
});

/** @param {ReturnType<typeof setup>} p @param {number} at @param {number[]} words */
const medium = (p, at, words)=>words.forEach((word, index)=>p.set32(at + index * 4, word));

test('STGMEDIUM: TYMED_NULL with pUnkForRelease', async()=>{
    const p = setup();
    const UNKNOWN = 0x2000;
    const UNKNOWN2 = 0x2040;
    const unknown = p.object(UNKNOWN, [IID_IUNKNOWN]);
    const flags = p.umcb(MSHCTX_DIFFERENTMACHINE);
    const expectSize = p.run('WdtpInterfacePointer_UserSize',
        [flags, p.u32(flags), 8, UNKNOWN, RIID_UNKNOWN]);
    p.set32(EXPECT, TYMED_NULL);
    p.set32(EXPECT + 4, 0xdeadbeef);
    const expectEnd = await p.run('WdtpInterfacePointer_UserMarshal',
        [flags, p.u32(flags), EXPECT + 8, UNKNOWN, RIID_UNKNOWN]);

    medium(p, MEDIUM, [TYMED_NULL, 0, UNKNOWN]);
    assert.equal(p.run('STGMEDIUM_UserSize', [flags, 0, MEDIUM]), expectSize);
    const end = await p.run('STGMEDIUM_UserMarshal', [flags, BUFFER, MEDIUM]);
    assert.equal(end - BUFFER, expectEnd - EXPECT);
    assert.equal(p.u32(BUFFER), TYMED_NULL);
    assert.notEqual(p.u32(BUFFER + 4), 0);
    assert.deepEqual(p.memory.subarray(BUFFER + 8, end), p.memory.subarray(EXPECT + 8, expectEnd));

    const unknown2 = p.object(UNKNOWN2, [IID_IUNKNOWN]);
    medium(p, MEDIUM2, [TYMED_NULL, 0, UNKNOWN2]);
    assert.equal(await p.run('STGMEDIUM_UserUnmarshal', [flags, BUFFER, MEDIUM2]), end);
    assert.equal(p.u32(MEDIUM2), TYMED_NULL);
    assert.notEqual(p.u32(MEDIUM2 + 8), 0);
    assert.equal(unknown2.refs, 0);
    await p.run('STGMEDIUM_UserFree', [flags, MEDIUM2]);

    medium(p, MEDIUM2, [TYMED_NULL, 0, 0]);
    await p.run('STGMEDIUM_UserUnmarshal', [flags, EXPECT, MEDIUM2]);
    await p.run('STGMEDIUM_UserFree', [flags, MEDIUM2]);
    assert.equal(unknown.refs, 1);
});

test('STGMEDIUM: TYMED_ISTREAM with pUnkForRelease', async()=>{
    const p = setup();
    const UNKNOWN = 0x2000;
    const UNKNOWN2 = 0x2040;
    const STREAM = 0x2080;
    const STREAM2 = 0x20c0;
    const unknown = p.object(UNKNOWN, [IID_IUNKNOWN]);
    const stream = p.object(STREAM, [IID_IUNKNOWN, IID_ISTREAM]);
    const flags = p.umcb(MSHCTX_DIFFERENTMACHINE);
    let expectSize = p.run('WdtpInterfacePointer_UserSize',
        [flags, p.u32(flags), 12, STREAM, RIID_STREAM]);
    expectSize = p.run('WdtpInterfacePointer_UserSize',
        [flags, p.u32(flags), expectSize, UNKNOWN, RIID_UNKNOWN]);
    p.fill(EXPECT, expectSize, 0xcc);
    medium(p, EXPECT, [TYMED_ISTREAM, 0xdeadbeef, 0xcafe]);
    let expectEnd = await p.run('WdtpInterfacePointer_UserMarshal',
        [flags, p.u32(flags), EXPECT + 12, STREAM, RIID_STREAM]);
    expectEnd = await p.run('WdtpInterfacePointer_UserMarshal',
        [flags, p.u32(flags), expectEnd, UNKNOWN, RIID_UNKNOWN]);

    medium(p, MEDIUM, [TYMED_ISTREAM, STREAM, UNKNOWN]);
    const size = p.run('STGMEDIUM_UserSize', [flags, 0, MEDIUM]);
    assert.equal(size, expectSize);
    p.fill(BUFFER, size, 0xcc);
    const end = await p.run('STGMEDIUM_UserMarshal', [flags, BUFFER, MEDIUM]);
    assert.equal(end - BUFFER, expectEnd - EXPECT);
    assert.equal(p.u32(BUFFER), TYMED_ISTREAM);
    assert.notEqual(p.u32(BUFFER + 4), 0);
    assert.notEqual(p.u32(BUFFER + 8), 0);
    assert.deepEqual(p.memory.subarray(BUFFER + 12, end),
        p.memory.subarray(EXPECT + 12, expectEnd));

    const stream2 = p.object(STREAM2, [IID_IUNKNOWN, IID_ISTREAM]);
    const unknown2 = p.object(UNKNOWN2, [IID_IUNKNOWN]);
    medium(p, MEDIUM2, [TYMED_ISTREAM, STREAM2, UNKNOWN2]);
    assert.equal(await p.run('STGMEDIUM_UserUnmarshal', [flags, BUFFER, MEDIUM2]), end);
    assert.deepEqual([0, 4, 8].map(at=>p.u32(MEDIUM2 + at)), [TYMED_ISTREAM, STREAM, UNKNOWN]);
    assert.equal(stream2.refs, 0);
    assert.equal(unknown2.refs, 0);
    await p.run('STGMEDIUM_UserFree', [flags, MEDIUM2]);

    medium(p, MEDIUM2, [TYMED_NULL, 0, 0]);
    await p.run('STGMEDIUM_UserUnmarshal', [flags, EXPECT, MEDIUM2]);
    await p.run('STGMEDIUM_UserFree', [flags, MEDIUM2]);
    assert.equal(unknown.refs, 1);
    assert.equal(stream.refs, 1);
});

test('STGMEDIUM: TYMED_ISTREAM of NULL with no pUnkForRelease', async()=>{
    const p = setup();
    const UNKNOWN2 = 0x2040;
    const STREAM2 = 0x20c0;
    const flags = p.umcb(MSHCTX_DIFFERENTMACHINE);
    medium(p, MEDIUM, [TYMED_ISTREAM, 0, 0]);
    assert.equal(p.run('STGMEDIUM_UserSize', [flags, 0, MEDIUM]), 12);
    p.fill(BUFFER, 12, 0xcc);
    assert.equal(p.run('STGMEDIUM_UserMarshal', [flags, BUFFER, MEDIUM]), BUFFER + 12);
    assert.deepEqual([0, 4, 8].map(at=>p.u32(BUFFER + at)), [TYMED_ISTREAM, 0, 0]);

    const stream2 = p.object(STREAM2, [IID_IUNKNOWN, IID_ISTREAM]);
    const unknown2 = p.object(UNKNOWN2, [IID_IUNKNOWN]);
    medium(p, MEDIUM2, [TYMED_ISTREAM, STREAM2, UNKNOWN2]);
    assert.equal(await p.run('STGMEDIUM_UserUnmarshal', [flags, BUFFER, MEDIUM2]), BUFFER + 12);
    assert.deepEqual([0, 4, 8].map(at=>p.u32(MEDIUM2 + at)), [TYMED_ISTREAM, 0, UNKNOWN2]);
    assert.equal(stream2.refs, 0);
    assert.equal(unknown2.refs, 1);
    await p.run('STGMEDIUM_UserFree', [flags, MEDIUM2]);
    assert.equal(unknown2.refs, 0);
});

test('STGMEDIUM: an HGLOBAL goes in its own wire form, and is freed with the medium', ()=>{
    const p = setup();
    const flags = p.umcb(MSHCTX_LOCAL);
    const hglobal = p.heap.allocate(6);
    p.memory.set([1, 2, 3, 4, 5, 6], hglobal);
    medium(p, MEDIUM, [TYMED_HGLOBAL, hglobal, 0]);
    const size = p.run('STGMEDIUM_UserSize', [flags, 0, MEDIUM]);
    assert.equal(size, 12 + 20 + 6);
    assert.equal(p.run('STGMEDIUM_UserMarshal', [flags, BUFFER, MEDIUM]), BUFFER + size);
    assert.deepEqual([0, 4, 8, 12, 16, 20, 24, 28].map(at=>p.u32(BUFFER + at)),
        [TYMED_HGLOBAL, hglobal, 0, WDT_REMOTE_CALL, hglobal, 6, hglobal, 6]);

    medium(p, MEDIUM2, [TYMED_NULL, 0, 0]);
    assert.equal(p.run('STGMEDIUM_UserUnmarshal', [flags, BUFFER, MEDIUM2]), BUFFER + size);
    const copy = p.u32(MEDIUM2 + 4);
    assert.equal(p.u32(MEDIUM2), TYMED_HGLOBAL);
    assert.deepEqual([...p.memory.subarray(copy, copy + 6)], [1, 2, 3, 4, 5, 6]);
    p.run('STGMEDIUM_UserFree', [flags, MEDIUM2]);
    assert.equal(p.heap.block(copy), null);
});

test('STGMEDIUM: a file name goes as a conformant string', ()=>{
    const p = setup();
    const flags = p.umcb(MSHCTX_LOCAL);
    const name = 'C:\\a.txt';
    p.memory.set([...name].flatMap(c=>[c.charCodeAt(0), 0]).concat(0, 0), STRINGS);
    medium(p, MEDIUM, [TYMED_FILE, STRINGS, 0]);
    const units = name.length + 1;
    const size = p.run('STGMEDIUM_UserSize', [flags, 0, MEDIUM]);
    assert.equal(size, 12 + 12 + units * 2);
    assert.equal(p.run('STGMEDIUM_UserMarshal', [flags, BUFFER, MEDIUM]), BUFFER + size);
    assert.deepEqual([12, 16, 20].map(at=>p.u32(BUFFER + at)), [units, 0, units]);
    medium(p, MEDIUM2, [TYMED_NULL, 0, 0]);
    assert.equal(p.run('STGMEDIUM_UserUnmarshal', [flags, BUFFER, MEDIUM2]), BUFFER + size);
    const copy = p.u32(MEDIUM2 + 4);
    assert.deepEqual(p.memory.subarray(copy, copy + units * 2),
        p.memory.subarray(STRINGS, STRINGS + units * 2));
    p.run('STGMEDIUM_UserFree', [flags, MEDIUM2]);
    assert.equal(p.heap.block(copy), null);
    assert.equal(p.divergences.length, 1, 'the file is not deleted, and that is said');
});

test('STGMEDIUM: a file name ending just short of the end of its memory is not read past', ()=>{
    const p = setup({ end: VTABLE });
    const flags = p.umcb(MSHCTX_LOCAL);
    const name = 'C:\\a.txt';
    const at = VTABLE - 8 - (name.length + 1) * 2;
    p.memory.set([...name].flatMap(c=>[c.charCodeAt(0), 0]).concat(0, 0), at);
    medium(p, MEDIUM, [TYMED_FILE, at, 0]);
    const units = name.length + 1;
    const size = p.run('STGMEDIUM_UserSize', [flags, 0, MEDIUM]);
    assert.equal(size, 12 + 12 + units * 2);
    assert.equal(p.run('STGMEDIUM_UserMarshal', [flags, BUFFER, MEDIUM]), BUFFER + size);
    assert.deepEqual([12, 16, 20].map(offset=>p.u32(BUFFER + offset)), [units, 0, units]);
});

test('STGMEDIUM: a medium with no wire form here is refused', ()=>{
    const p = setup();
    const flags = p.umcb(MSHCTX_LOCAL);
    medium(p, MEDIUM, [TYMED_GDI, 0x6000, 0]);
    assert.throws(()=>p.run('STGMEDIUM_UserSize', [flags, 0, MEDIUM]), { code: DV_E_TYMED });
    medium(p, MEDIUM, [0x80, 0x6000, 0]);
    assert.throws(()=>p.run('STGMEDIUM_UserMarshal', [flags, BUFFER, MEDIUM]),
        { code: DV_E_TYMED });
    p.set32(BUFFER, 0x80);
    assert.throws(()=>p.run('STGMEDIUM_UserUnmarshal', [flags, BUFFER, MEDIUM2]),
        { code: DV_E_TYMED });
});

test('SNB: the character count, the string count, the count again, the strings', async()=>{
    const p = setup();
    p.set32(SLOT, 0);
    assert.equal(p.run('SNB_UserSize', [p.umcb(MSHCTX_LOCAL), 3, SLOT]), 16);
    assert.equal(p.run('SNB_UserSize', [p.umcb(MSHCTX_LOCAL), 0, SLOT]), 12);
    p.fill(BUFFER, 12, 0xcc);
    assert.equal(p.run('SNB_UserMarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT]), BUFFER + 12);
    assert.deepEqual([0, 4, 8].map(at=>p.u32(BUFFER + at)), [0, 0, 0]);
    p.set32(SLOT2, 0x77);
    assert.equal(await p.run('SNB_UserUnmarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT2]),
        BUFFER + 12);
    assert.equal(p.u32(SLOT2), 0);
    assert.equal(await p.run('SNB_UserFree', [p.umcb(MSHCTX_LOCAL), SLOT2]), 0);
    assert.equal(p.calls.free, 0);

    // Three pointers -- two strings and NULL -- then the strings.
    const wide = (/** @type {string} */ text)=>[...text].flatMap(c=>[c.charCodeAt(0), 0])
        .concat(0, 0);
    const first = STRINGS + 12;
    const second = first + wide('string1').length;
    medium(p, STRINGS, [first, second, 0]);
    p.memory.set(wide('string1'), first);
    p.memory.set(wide('str2'), second);
    p.set32(SLOT, STRINGS);
    const size = p.run('SNB_UserSize', [p.umcb(MSHCTX_LOCAL), 0, SLOT]);
    assert.equal(size, 38);
    assert.equal(p.run('SNB_UserMarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT]), BUFFER + 38);
    assert.deepEqual([0, 4, 8].map(at=>p.u32(BUFFER + at)), [13, 2, 13]);
    assert.deepEqual([...p.memory.subarray(BUFFER + 12, BUFFER + 38)],
        [...wide('string1'), ...wide('str2')]);

    p.set32(SLOT2, 0);
    assert.equal(await p.run('SNB_UserUnmarshal', [p.umcb(MSHCTX_LOCAL), BUFFER, SLOT2]),
        BUFFER + 38);
    assert.equal(p.calls.allocate, 1, 'the block is the stub message allocator\'s');
    const snb = p.u32(SLOT2);
    const read = (/** @type {number} */ address)=>{
        let text = '';
        for (let at = address; p.u16(at) !== 0; at += 2)
        {
            text += String.fromCharCode(p.u16(at));
        }
        return text;
    };
    assert.equal(read(p.u32(snb)), 'string1');
    assert.equal(read(p.u32(snb + 4)), 'str2');
    assert.equal(p.u32(snb + 8), 0);
    await p.run('SNB_UserFree', [p.umcb(MSHCTX_LOCAL), SLOT2]);
    assert.equal(p.calls.free, 1);
    assert.equal(p.heap.block(snb), null);
});

test('SNB: with a bare flags word the block is task memory', ()=>{
    const p = setup();
    const wire = [8, 1, 8, ...'abcdefg'.split('').map(c=>c.charCodeAt(0))];
    p.memory.set(new Uint8Array(Uint32Array.from(wire.slice(0, 3)).buffer), BUFFER);
    p.memory.set(wire.slice(3).flatMap(c=>[c, 0]).concat(0, 0), BUFFER + 12);
    p.set32(SLOT, MSHCTX_LOCAL);
    assert.equal(p.run('SNB_UserUnmarshal', [SLOT, BUFFER, SLOT2]), BUFFER + 12 + 16);
    const snb = p.u32(SLOT2);
    assert.notEqual(p.heap.block(snb), null);
    assert.equal(p.calls.allocate, 0);
    assert.equal(p.u32(snb + 4), 0);
});

test('ReleaseStgMedium frees what nobody else releases, and always releases an interface',
    async()=>{
        // ole2.c test_ReleaseStgMedium: NULL is nothing. MSDN's table: with
        // pUnkForRelease NULL the value is freed as its tymed says; with one,
        // only an interface is released, then pUnkForRelease.
        const p = setup();
        assert.equal(p.run('ReleaseStgMedium', [0]), 0);

        const hglobal = p.heap.allocate(8);
        medium(p, MEDIUM, [TYMED_HGLOBAL, hglobal, 0]);
        p.run('ReleaseStgMedium', [MEDIUM]);
        assert.equal(p.heap.block(hglobal), null, 'GlobalFree');
        assert.deepEqual([0, 4, 8].map(at=>p.u32(MEDIUM + at)), [TYMED_NULL, 0, 0]);

        const UNKNOWN = 0x2000;
        const unknown = p.object(UNKNOWN, [IID_IUNKNOWN]);
        const kept = p.heap.allocate(8);
        medium(p, MEDIUM, [TYMED_HGLOBAL, kept, UNKNOWN]);
        await p.run('ReleaseStgMedium', [MEDIUM]);
        assert.notEqual(p.heap.block(kept), null, 'pUnkForRelease frees it, not this');
        assert.equal(unknown.refs, 0, 'pUnkForRelease released');

        const STREAM = 0x2080;
        const stream = p.object(STREAM, [IID_IUNKNOWN, IID_ISTREAM]);
        const unknown2 = p.object(0x2040, [IID_IUNKNOWN]);
        medium(p, MEDIUM, [TYMED_ISTREAM, STREAM, 0x2040]);
        await p.run('ReleaseStgMedium', [MEDIUM]);
        assert.deepEqual([stream.refs, unknown2.refs], [0, 0], 'both released');

        const bitmap = 0x5100;
        p.bitmaps.set(bitmap, { header: new Uint8Array(20), bits: new Uint8Array(0) });
        medium(p, MEDIUM, [TYMED_GDI, bitmap, 0]);
        p.run('ReleaseStgMedium', [MEDIUM]);
        assert.equal(p.bitmaps.has(bitmap), false, 'DeleteObject');

        const emf = p.keep(new Uint8Array(4));
        medium(p, MEDIUM, [64, emf, 0]);
        p.run('ReleaseStgMedium', [MEDIUM]);
        assert.equal(p.metafiles.has(emf), false, 'DeleteEnhMetaFile');

        const wmf = p.keep(new Uint8Array(4));
        const picture = p.heap.allocate(16);
        p.set32(picture + 12, wmf);
        medium(p, MEDIUM, [32, picture, 0]);
        p.run('ReleaseStgMedium', [MEDIUM]);
        assert.equal(p.metafiles.has(wmf), false, 'DeleteMetaFile of the picture\'s hMF');
        assert.equal(p.heap.block(picture), null, 'and GlobalFree of the picture');

        const name = p.heap.allocate(4);
        medium(p, MEDIUM, [TYMED_FILE, name, 0]);
        p.run('ReleaseStgMedium', [MEDIUM]);
        assert.equal(p.heap.block(name), null, 'the name is CoTaskMemFree\'d');
        assert.equal(p.divergences.length, 1, 'the file is not deleted with no DeleteFileW');
    });

test('ReleaseStgMedium with no gdi32 to delete through says the object is kept', ()=>{
    const p = setup({ gdi: false });
    medium(p, MEDIUM, [TYMED_GDI, 0x5100, 0]);
    p.run('ReleaseStgMedium', [MEDIUM]);
    assert.equal(p.divergences.length, 1);
    assert.equal(p.u32(MEDIUM), TYMED_NULL);
});
