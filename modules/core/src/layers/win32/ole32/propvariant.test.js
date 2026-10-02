/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PropVariantCopy and PropVariantClear against ole32's propvariant tests
 * (test_validtypes, test_copy) and the documented contract: which types a
 * PROPVARIANT may hold, what each copy owns, and what a clear lets go of.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPropVariantFunctions } from './propvariant.js';

const S_OK = 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const DISP_E_BADVARTYPE = 0x80020008 | 0;
const STG_E_INVALIDPARAMETER = 0x80030057 | 0;

const VT_BSTR = 8;
const VT_UNKNOWN = 13;
const VT_UI1 = 17;
const VT_LPSTR = 30;
const VT_LPWSTR = 31;
const VT_RECORD = 36;
const VT_BLOB = 65;
const VT_BLOB_OBJECT = 70;
const VT_CF = 71;
const VT_CLSID = 72;
const VT_VARIANT = 12;
const VT_VECTOR = 0x1000;
const VT_ARRAY = 0x2000;
const VT_BYREF = 0x4000;

/**
 * The types test_validtypes holds valid, by form. Everything else is refused:
 * DISP_E_BADVARTYPE by the copy, STG_E_INVALIDPARAMETER by the clear.
 */
const VALID = {
    simple: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23,
        30, 31, 36, 64, 65, 66, 67, 68, 69, 70, 71],
    array: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 36],
    vector: [2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 16, 17, 18, 19, 20, 21, 30, 31, 64, 71],
    byref: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 36],
};

/** Guest memory, a task heap that counts what it holds, and objects that count references. */
function build({ calls = true, slowDestroy = false } = {}){
    const bytes = new Uint8Array(0x40000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, number>} */
    const live = new Map();
    let next = 0x10000;
    const heap = {
        live,
        exhausted: false,
        /** @param {number} size */
        allocate(size){
            if (heap.exhausted)
            {
                return 0;
            }
            const at = next;
            next += (Math.max(size, 1) + 7) & ~7;
            live.set(at, size);
            return at;
        },
        /** @param {number} at */
        free: at=>live.delete(at),
    };
    /** Objects by address: their reference counts, and the thread each call came on. */
    /** @type {Map<number, number>} */
    const references = new Map();
    /** @type {unknown[]} */
    const threads = [];
    const VTABLE = 0x3000;
    const ADD_REF = 0x5010;
    const RELEASE = 0x5020;
    view.setUint32(VTABLE + 4, ADD_REF, true);
    view.setUint32(VTABLE + 8, RELEASE, true);
    /** An object of the program's at `at`, holding `count` references. @param {number} at */
    const object = (at, count = 1)=>{
        view.setUint32(at, VTABLE, true);
        references.set(at, count);
        return at;
    };
    /** oleaut32's strings: a length prefix, and SysAllocString's copy up to a NUL. */
    const bstr = {
        /** @param {string} text @param {number} [units] */
        make(text, units = text.length){
            const block = heap.allocate(4 + units * 2 + 2);
            view.setUint32(block, units * 2, true);
            for (let index = 0; index < units; index++)
            {
                view.setUint16(block + 4 + index * 2, index < text.length
                    ? text.charCodeAt(index) : 0, true);
            }
            view.setUint16(block + 4 + units * 2, 0, true);
            return block + 4;
        },
        /** @param {number} source */
        copy(source){
            let units = 0;
            while (view.getUint16(source + units * 2, true) !== 0)
            {
                units++;
            }
            return bstr.make(String.fromCharCode(
                ...new Uint16Array(bytes.slice(source, source + units * 2).buffer)));
        },
        /** @param {number} at */
        free(at){
            heap.free(at - 4);
        },
        /** @param {number} at */
        length: at=>view.getUint32(at - 4, true) / 2,
    };
    /** @type {string[]} */
    const arrays = [];
    const safeArray = {
        /** @param {number} psa @param {number} out @returns {number | Promise<number>} */
        copy(psa, out){
            arrays.push(`copy ${psa}`);
            const made = heap.allocate(24);
            view.setUint32(out, made, true);
            return slowDestroy ? new Promise(resolve=>{
                setImmediate(()=>{
                    arrays.push(`copied ${psa}`);
                    resolve(S_OK);
                });
            }) : S_OK;
        },
        /** @param {number} psa @returns {number | Promise<number>} */
        destroy(psa){
            arrays.push(`destroy ${psa}`);
            heap.free(psa);
            // As oleaut32's answers once it has released what the array held,
            // a call into the program.
            return slowDestroy ? new Promise(resolve=>{
                setImmediate(()=>{
                    arrays.push(`destroyed ${psa}`);
                    resolve(S_OK);
                });
            }) : S_OK;
        },
    };
    /** @type {string[]} */
    const reported = [];
    const fns = /** @type {any} */ (createPropVariantFunctions({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        heap,
        bstr,
        safeArray,
        callerThread: ()=>'the caller',
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
        ...(calls ? {
            /** @param {number} entry @param {number[]} args @param {unknown} [thread] */
            call: async(entry, [self], thread)=>{
                threads.push(thread);
                const count = (references.get(self) ?? 0) + (entry === ADD_REF ? 1 : -1);
                references.set(self, count);
                return count;
            },
        } : {}),
    }));
    /** @param {number} at @param {string} text */
    const ansi = (at, text)=>{
        bytes.set([...text, '\0'].map(c=>c.charCodeAt(0)), at);
        return at;
    };
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text, '\0'].forEach((c, index)=>view.setUint16(at + index * 2, c.charCodeAt(0), true));
        return at;
    };
    /** @param {number} at */
    const ansiAt = at=>String.fromCharCode(...bytes.subarray(at, bytes.indexOf(0, at)));
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let unit = at; view.getUint16(unit, true) !== 0; unit += 2)
        {
            text += String.fromCharCode(view.getUint16(unit, true));
        }
        return text;
    };
    /** A PROPVARIANT's type and the two dwords of its value. @param {number} at */
    const read = at=>[view.getUint16(at, true), view.getUint32(at + 8, true),
        view.getUint32(at + 12, true)];
    /** @param {number} at @param {number} vt @param {number} low @param {number} [high] */
    const set = (at, vt, low, high = 0)=>{
        view.setUint16(at, vt, true);
        view.setUint32(at + 8, low >>> 0, true);
        view.setUint32(at + 12, high >>> 0, true);
        return at;
    };
    return { bytes, view, heap, references, threads, bstr, arrays, reported, fns, object, ansi,
        wide, ansiAt, wideAt, read, set };
}

const SOURCE = 0x1000;
const DEST = 0x1100;

test('the types a PROPVARIANT may hold copy and clear, and the rest are refused', async()=>{
    // propvariant.c test_validtypes: each type simple, as an array, as a
    // vector and by reference, from a record of 0x55 with a null value.
    const m = build();
    const uninitialised = new Uint8Array(16).fill(0x77);
    for (const [form, flag] of /** @type {const} */ ([['simple', 0], ['array', VT_ARRAY],
        ['vector', VT_VECTOR], ['byref', VT_BYREF]]))
    {
        for (let type = 0; type <= VT_CF; type++)
        {
            const vt = type | flag;
            m.bytes.fill(0x55, SOURCE, SOURCE + 16);
            if (form === 'vector' || type === VT_BLOB || type === VT_BLOB_OBJECT)
            {
                m.view.setUint32(SOURCE + 8, 0, true);
                m.view.setUint32(SOURCE + 12, 0, true);
            }
            else if (form === 'simple' && type === VT_RECORD)
            {
                m.bytes.fill(0, SOURCE, SOURCE + 16);
            }
            else
            {
                m.view.setUint32(SOURCE + 8, 0, true);
            }
            m.view.setUint16(SOURCE, vt, true);
            const source = m.bytes.slice(SOURCE, SOURCE + 16);
            m.bytes.fill(0x77, DEST, DEST + 16);
            const valid = VALID[form].includes(type);
            const label = `${form} ${type}`;

            const copied = await m.fns.PropVariantCopy.handler([DEST, SOURCE]);
            assert.equal(copied, valid ? S_OK : DISP_E_BADVARTYPE, `copy ${label}`);
            if (!valid)
            {
                assert.deepEqual(m.bytes.slice(DEST, DEST + 16), uninitialised,
                    `a refused copy leaves the destination alone: ${label}`);
            }
            else if (form === 'vector')
            {
                assert.deepEqual(m.read(DEST), [vt, 0, 0], label);
            }
            else if (form === 'array')
            {
                assert.deepEqual(m.read(DEST), [vt, 0, 0], `no array is copied as none: ${label}`);
            }
            else
            {
                assert.deepEqual(m.bytes.slice(DEST + 8, DEST + 16), source.slice(8), label);
                assert.equal(m.view.getUint16(DEST, true), vt);
            }
            if (valid)
            {
                assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);
            }

            const cleared = await m.fns.PropVariantClear.handler([SOURCE]);
            assert.equal(cleared, valid ? S_OK : STG_E_INVALIDPARAMETER, `clear ${label}`);
            assert.deepEqual([...m.bytes.subarray(SOURCE, SOURCE + 16)], new Array(16).fill(0),
                `cleared, whatever the type: ${label}`);
        }
    }
    assert.equal(m.heap.live.size, 0, 'nothing is left allocated');

    // A record of nothing but 0x55 has no type at all.
    m.bytes.fill(0x55, SOURCE, SOURCE + 16);
    assert.equal(await m.fns.PropVariantClear.handler([SOURCE]), STG_E_INVALIDPARAMETER);
    assert.deepEqual(m.read(SOURCE), [0, 0, 0]);
    assert.equal(await m.fns.PropVariantClear.handler([0]), S_OK, 'NULL is nothing to clear');
    assert.deepEqual([m.fns.PropVariantCopy.argBytes, m.fns.PropVariantClear.argBytes], [8, 4]);
});

test('strings are copied into memory of their own, and a BSTR up to its first NUL', async()=>{
    // propvariant.c test_copy.
    const m = build();
    const baseline = m.heap.live.size;
    m.set(SOURCE, VT_BSTR, m.bstr.make('Test String'));
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    const copy = m.read(DEST)[1];
    assert.notEqual(copy, m.read(SOURCE)[1]);
    assert.equal(m.wideAt(copy), 'Test String');
    assert.equal(await m.fns.PropVariantClear.handler([SOURCE]), S_OK);
    assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);

    m.set(SOURCE, VT_BSTR, m.bstr.make('Test Str\0ing', 12));
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    assert.equal(m.bstr.length(m.read(DEST)[1]), 8, 'an embedded NUL ends the copy');
    assert.equal(m.bstr.length(m.read(SOURCE)[1]), 12);
    await m.fns.PropVariantClear.handler([SOURCE]);
    await m.fns.PropVariantClear.handler([DEST]);

    m.set(SOURCE, VT_LPWSTR, m.wide(0x2000, 'Test String'));
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    assert.notEqual(m.read(DEST)[1], 0x2000);
    assert.equal(m.wideAt(m.read(DEST)[1]), 'Test String');
    assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);

    m.set(SOURCE, VT_LPSTR, m.ansi(0x2000, 'Test String'));
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    assert.notEqual(m.read(DEST)[1], 0x2000);
    assert.equal(m.ansiAt(m.read(DEST)[1]), 'Test String');
    assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);
    assert.equal(m.heap.live.size, baseline, 'every copy and every string is let go');
});

test('an interface is copied with a reference of its own, and let go of by the clear', async()=>{
    // propvariant.c test_copy: VT_UNKNOWN, and a VT_ARRAY | VT_UNKNOWN, which
    // goes through oleaut32's SafeArrayCopy and SafeArrayDestroy.
    const m = build();
    const unknown = m.object(0x2800);
    m.set(SOURCE, VT_UNKNOWN, unknown);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    assert.equal(m.read(DEST)[1], unknown, 'the same pointer');
    assert.equal(m.references.get(unknown), 2);
    assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);
    assert.equal(m.references.get(unknown), 1);
    assert.deepEqual(m.threads, ['the caller', 'the caller']);

    const array = m.heap.allocate(24);
    m.set(SOURCE, VT_ARRAY | VT_UNKNOWN, array);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    const copied = m.read(DEST)[1];
    assert.ok(copied !== 0 && copied !== array);
    assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);
    assert.equal(await m.fns.PropVariantClear.handler([SOURCE]), S_OK);
    assert.deepEqual(m.arrays, [`copy ${array}`, `destroy ${copied}`, `destroy ${array}`]);
    assert.equal(m.heap.live.size, 0);
});

test('a copy or a clear of an array answers once the array has its references settled',
    async()=>{
        // Answered at once, the release ran after the program had gone on --
        // with no host call of its thread to run on, which stopped the engine.
        const m = build({ slowDestroy: true });
        const array = m.heap.allocate(24);
        m.set(SOURCE, VT_ARRAY | VT_UNKNOWN, array);
        const copied = m.fns.PropVariantCopy.handler([DEST, SOURCE]);
        assert.equal(typeof copied?.then, 'function', 'and a copy waits on the references');
        assert.equal(await copied, S_OK);
        const copy = m.read(DEST)[1];
        assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);
        const answer = m.fns.PropVariantClear.handler([SOURCE]);
        assert.equal(typeof answer?.then, 'function', 'the call waits on the destruction');
        assert.equal(await answer, S_OK);
        assert.deepEqual(m.arrays, [`copy ${array}`, `copied ${array}`, `destroy ${copy}`,
            `destroyed ${copy}`, `destroy ${array}`, `destroyed ${array}`]);
    });

test('a vector is copied element by element, a variant vector to any depth', async()=>{
    const m = build();
    const unknown = m.object(0x2800);

    // Four bytes, copied as they are.
    const bytes = m.heap.allocate(4);
    m.bytes.set([1, 2, 3, 4], bytes);
    m.set(SOURCE, VT_VECTOR | VT_UI1, 4, bytes);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    const [, count, elements] = m.read(DEST);
    assert.equal(count, 4);
    assert.notEqual(elements, bytes);
    assert.deepEqual([...m.bytes.subarray(elements, elements + 4)], [1, 2, 3, 4]);
    await m.fns.PropVariantClear.handler([DEST]);
    await m.fns.PropVariantClear.handler([SOURCE]);

    // Strings, each copied.
    const names = m.heap.allocate(8);
    const first = m.ansi(m.heap.allocate(8), 'one');
    const second = m.ansi(m.heap.allocate(8), 'two');
    m.view.setUint32(names, first, true);
    m.view.setUint32(names + 4, second, true);
    m.set(SOURCE, VT_VECTOR | VT_LPSTR, 2, names);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    const copiedNames = m.read(DEST)[2];
    const copies = [m.view.getUint32(copiedNames, true), m.view.getUint32(copiedNames + 4, true)];
    assert.ok(!copies.includes(first) && !copies.includes(second));
    assert.deepEqual(copies.map(m.ansiAt), ['one', 'two']);
    await m.fns.PropVariantClear.handler([DEST]);
    await m.fns.PropVariantClear.handler([SOURCE]);

    // PROPVARIANTs: a BSTR, an interface, and a vector of wide strings.
    const inner = m.heap.allocate(4);
    m.view.setUint32(inner, m.wide(m.heap.allocate(16), 'deep'), true);
    const variants = m.heap.allocate(48);
    m.set(variants, VT_BSTR, m.bstr.make('text'));
    m.set(variants + 16, VT_UNKNOWN, unknown);
    m.set(variants + 32, VT_VECTOR | VT_LPWSTR, 1, inner);
    m.set(SOURCE, VT_VECTOR | VT_VARIANT, 3, variants);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    const copiedVariants = m.read(DEST)[2];
    assert.equal(m.wideAt(m.read(copiedVariants)[1]), 'text');
    assert.notEqual(m.read(copiedVariants)[1], m.read(variants)[1]);
    assert.deepEqual(m.read(copiedVariants + 16), [VT_UNKNOWN, unknown, 0]);
    assert.equal(m.references.get(unknown), 2);
    const innerCopy = m.read(copiedVariants + 32)[2];
    assert.notEqual(innerCopy, inner);
    assert.equal(m.wideAt(m.view.getUint32(innerCopy, true)), 'deep');
    assert.equal(await m.fns.PropVariantClear.handler([DEST]), S_OK);
    assert.equal(m.references.get(unknown), 1);
    assert.equal(await m.fns.PropVariantClear.handler([SOURCE]), S_OK);
    assert.equal(m.references.get(unknown), 0);
    assert.equal(m.heap.live.size, 0, 'the clears let go of every level');
});

test('a blob, clipboard data and a CLSID are copied, and a failed copy keeps nothing', async()=>{
    const m = build();
    const blob = m.heap.allocate(3);
    m.bytes.set([7, 8, 9], blob);
    m.set(SOURCE, VT_BLOB, 3, blob);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    assert.equal(m.read(DEST)[1], 3);
    assert.notEqual(m.read(DEST)[2], blob);
    assert.deepEqual([...m.bytes.subarray(m.read(DEST)[2], m.read(DEST)[2] + 3)], [7, 8, 9]);
    await m.fns.PropVariantClear.handler([DEST]);
    await m.fns.PropVariantClear.handler([SOURCE]);

    // CLIPDATA: its size counts the format, and its bytes follow.
    const clip = m.heap.allocate(12);
    const content = m.heap.allocate(2);
    m.bytes.set([0xaa, 0xbb], content);
    m.view.setUint32(clip, 2 + 4, true);
    m.view.setUint32(clip + 4, 14, true);
    m.view.setUint32(clip + 8, content, true);
    m.set(SOURCE, VT_CF, clip);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    const copiedClip = m.read(DEST)[1];
    assert.notEqual(copiedClip, clip);
    assert.deepEqual([m.view.getUint32(copiedClip, true), m.view.getUint32(copiedClip + 4, true)],
        [6, 14]);
    const copiedContent = m.view.getUint32(copiedClip + 8, true);
    assert.notEqual(copiedContent, content);
    assert.deepEqual([...m.bytes.subarray(copiedContent, copiedContent + 2)], [0xaa, 0xbb]);
    await m.fns.PropVariantClear.handler([DEST]);
    await m.fns.PropVariantClear.handler([SOURCE]);

    const clsid = m.heap.allocate(16);
    m.bytes.set(Array.from({ length: 16 }, (_, index)=>index), clsid);
    m.set(SOURCE, VT_CLSID, clsid);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
    const copiedClsid = m.read(DEST)[1];
    assert.notEqual(copiedClsid, clsid);
    assert.deepEqual(m.bytes.slice(copiedClsid, copiedClsid + 16),
        m.bytes.slice(clsid, clsid + 16));
    await m.fns.PropVariantClear.handler([DEST]);
    assert.equal(m.heap.live.size, 1, 'only the source\'s CLSID is left');

    // Out of memory half way through a vector: what was made goes, and the
    // destination is left as it was.
    const strings = m.heap.allocate(8);
    m.view.setUint32(strings, m.ansi(m.heap.allocate(4), 'a'), true);
    m.view.setUint32(strings + 4, m.ansi(m.heap.allocate(4), 'b'), true);
    m.set(SOURCE, VT_VECTOR | VT_LPSTR, 2, strings);
    const before = m.heap.live.size;
    let allowed = 2;
    const allocate = m.heap.allocate;
    m.heap.allocate = size=>(allowed-- > 0 ? allocate(size) : 0);
    m.bytes.fill(0x77, DEST, DEST + 16);
    assert.equal(await m.fns.PropVariantCopy.handler([DEST, SOURCE]), E_OUTOFMEMORY);
    assert.deepEqual([...m.bytes.subarray(DEST, DEST + 16)], new Array(16).fill(0x77));
    assert.equal(m.heap.live.size, before);
});

test('without calls into the program an interface is copied without its reference, and said so',
    async()=>{
        const m = build({ calls: false });
        const unknown = m.object(0x2800);
        m.set(SOURCE, VT_UNKNOWN, unknown);
        assert.equal(m.fns.PropVariantCopy.handler([DEST, SOURCE]), S_OK);
        assert.equal(m.read(DEST)[1], unknown);
        assert.equal(m.fns.PropVariantClear.handler([DEST]), S_OK);
        assert.equal(m.reported.length, 2);
    });
