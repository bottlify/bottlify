/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// Where a case mirrors ole32's conformance test of the clipboard
// (dlls/ole32/tests/clipboard.c), its expectation is Windows' answer as
// that test records it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardFunctions } from './clipboard.js';
import { E_INVALIDARG, S_FALSE, S_OK, oleProcess } from './ole2.fixture.js';

const E_FAIL = 0x80004005 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const CO_E_NOTINITIALIZED = 0x800401f0 | 0;
const CLIPBRD_E_CANT_OPEN = 0x800401d0 | 0;
const DV_E_FORMATETC = 0x80040064 | 0;
const DV_E_LINDEX = 0x80040068 | 0;
const DV_E_TYMED = 0x80040069 | 0;
const DV_E_CLIPFORMAT = 0x8004006a | 0;
const OLE_E_ADVISENOTSUPPORTED = 0x80040003 | 0;
const DATA_S_SAMEFORMATETC = 0x00040130;
const CF_TEXT = 1;
const CF_UNICODETEXT = 13;
const TYMED_HGLOBAL = 1;
const TYMED_ISTREAM = 4;

/** IDataObject's slots. */
const D = Object.freeze({ GET: 3, GET_HERE: 4, QUERY: 5, CANONICAL: 6, SET: 7, ENUM: 8,
    DADVISE: 9 });

/**
 * A data object of the program's offering text in global memory: the bytes
 * of `text`, and how many times it was asked.
 *
 * @param {ReturnType<typeof oleProcess>} p @param {string} text
 * @param {{ released?: number }} [options]  A pUnkForRelease to hand with the data.
 */
function source(p, text, options = {}){
    const counts = { get: 0 };
    const formats = [[CF_TEXT, TYMED_HGLOBAL], [0xc100, TYMED_ISTREAM]];
    const object = p.guestObject([], {
        3: ([format, medium])=>{
            counts.get++;
            if (p.u16(format) !== CF_TEXT)
            {
                return DV_E_FORMATETC;
            }
            const block = p.heap.allocate(text.length + 1);
            p.bytes.set([...text, '\0'].map(c=>c.charCodeAt(0)), block);
            p.put(medium, TYMED_HGLOBAL);
            p.put(medium + 4, block);
            p.put(medium + 8, options.released ?? 0);
            return S_OK;
        },
        8: ([, out])=>{
            let at = 0;
            const enumerator = p.guestObject([], {
                3: ([celt, rgelt, fetched])=>{
                    const count = Math.min(celt, formats.length - at);
                    for (let index = 0; index < count; index++)
                    {
                        const [format, tymed] = formats[at + index];
                        [format, 0, 1, -1, tymed].forEach((word, field)=>
                            p.put(rgelt + index * 20 + field * 4, word));
                    }
                    at += count;
                    p.put(fetched, count);
                    return count === celt ? S_OK : S_FALSE;
                },
            });
            p.put(out, enumerator.pointer);
            return S_OK;
        },
    });
    return { object, counts };
}

/** @param {{ system?: boolean }} [options] */
function setup(options){
    const p = oleProcess(options);
    const { table, uninitialize } = createClipboardFunctions(p.env);
    const fns = /** @type {Record<string, { argBytes: number, handler: Function }>} */ (table);
    /** @param {string} name @param {number[]} args */
    const run = async(name, args)=>(await fns[name].handler(args)) | 0;
    /** The clipboard's data object, as OleGetClipboard hands it out. */
    const get = async()=>{
        const out = p.out();
        assert.equal(await run('OleGetClipboard', [out]), S_OK);
        return p.u32(out);
    };
    /** A FORMATETC. @param {number} format @param {number} [tymed] */
    const formatEtc = (format, tymed = TYMED_HGLOBAL, aspect = 1, lindex = -1)=>{
        const at = p.out(0, 20);
        [format, 0, aspect, lindex, tymed].forEach((word, field)=>p.put(at + field * 4, word));
        return at;
    };
    return { p, fns, run, get, formatEtc, uninitialize };
}

test('OleSetClipboard needs OleInitialize, then puts the source and its text there', async()=>{
    const { p, fns, run } = setup();
    assert.deepEqual(['OleSetClipboard', 'OleGetClipboard', 'OleFlushClipboard',
        'OleIsCurrentClipboard'].map(name=>fns[name].argBytes), [4, 4, 0, 4]);
    const first = source(p, 'one');
    const second = source(p, 'two');
    p.thread.ole32.oleDepth = 0;
    assert.equal(await run('OleSetClipboard', [first.object.pointer]), CO_E_NOTINITIALIZED);
    p.thread.ole32.oleDepth = 1;

    assert.equal(await run('OleSetClipboard', [first.object.pointer]), S_OK);
    assert.equal(first.object.refs, 2, 'held');
    const handle = /** @type {number} */ (p.user32.clipboard.get(CF_TEXT));
    assert.equal(p.bytes[handle], 'o'.charCodeAt(0), 'the text rendered for user32 readers');
    assert.equal(p.user32.clipboard.has(0xc100), false, 'a stream is not rendered');
    assert.equal(p.user32.open, false, 'closed again');
    assert.equal(await run('OleIsCurrentClipboard', [first.object.pointer]), S_OK);
    assert.equal(await run('OleIsCurrentClipboard', [second.object.pointer]), S_FALSE);
    assert.equal(await run('OleIsCurrentClipboard', [0]), S_FALSE);

    assert.equal(await run('OleSetClipboard', [second.object.pointer]), S_OK);
    assert.equal(first.object.refs, 1, 'the old source let go of');
    assert.equal(await run('OleIsCurrentClipboard', [first.object.pointer]), S_FALSE);
    assert.equal(await run('OleIsCurrentClipboard', [second.object.pointer]), S_OK);

    assert.equal(await run('OleSetClipboard', [0]), S_OK);
    assert.equal(second.object.refs, 1);
    assert.equal(p.user32.clipboard.size, 0, 'NULL empties it');

    p.user32.open = true;
    assert.equal(await run('OleSetClipboard', [first.object.pointer]), CLIPBRD_E_CANT_OPEN);
});

test('OleGetClipboard hands one object per clipboard state, reaching the source while it is there',
    async()=>{
        // clipboard.c test_consumer_refs.
        const { p, run, get, formatEtc } = setup();
        assert.equal(await run('OleGetClipboard', [0]), E_INVALIDARG);
        const src = source(p, 'data1');
        await run('OleSetClipboard', [src.object.pointer]);
        const get1 = await get();
        assert.equal(await get(), get1, 'the same object');
        assert.equal(await p.callMethod(get1, 2, []), 1);
        assert.equal(src.object.refs, 2, 'no reference taken for the asking');

        const medium = p.out(0, 12);
        const text = formatEtc(CF_TEXT);
        assert.equal(await p.callMethod(get1, D.GET, [text, medium]), S_OK);
        assert.equal(src.counts.get, 2, 'asked of the source: once rendering, once now');
        assert.equal(src.object.refs, 3, 'held from that call on');

        assert.equal(await run('OleFlushClipboard', []), S_OK);
        assert.equal(await run('OleIsCurrentClipboard', [src.object.pointer]), S_FALSE);
        assert.equal(await p.callMethod(get1, D.GET, [text, medium]), S_OK);
        assert.equal(src.counts.get, 3, 'the object that held it still asks it');
        const get2 = await get();
        assert.notEqual(get2, get1);
        assert.equal(await p.callMethod(get2, D.GET, [text, medium]), S_OK);
        assert.equal(src.counts.get, 3, 'after the flush, the clipboard itself answers');
        const copy = p.u32(medium + 4);
        assert.equal(p.u32(medium), TYMED_HGLOBAL);
        assert.equal(String.fromCharCode(...p.bytes.subarray(copy, copy + 5)), 'data1');
        assert.notEqual(copy, p.user32.clipboard.get(CF_TEXT), 'a copy of its own');
        assert.equal(await p.callMethod(get1, 2, []), 0);
        assert.equal(src.object.refs, 1, 'every reference given back');
        await p.callMethod(get2, 2, []);
    });

test('the clipboard\'s object checks a format as clipboard.c test_get_clipboard does',
    async()=>{
        const { p, run, get, formatEtc } = setup();
        const src = source(p, 'x');
        await run('OleSetClipboard', [src.object.pointer]);
        const data = await get();
        /** @param {number} format */
        const query = format=>p.callMethod(data, D.QUERY, [format]);
        assert.equal(await query(formatEtc(CF_TEXT)), S_OK);
        assert.equal(await query(formatEtc(CF_UNICODETEXT)), DV_E_FORMATETC);
        assert.equal(await query(formatEtc(0)), DV_E_CLIPFORMAT);
        assert.equal(await query(formatEtc(CF_TEXT, TYMED_HGLOBAL, 2)), DV_E_FORMATETC);
        assert.equal(await query(formatEtc(CF_TEXT, TYMED_HGLOBAL, 1, 0)), DV_E_LINDEX);
        assert.equal(await query(formatEtc(CF_TEXT, TYMED_ISTREAM)), DV_E_TYMED);
        assert.equal(await query(0), E_INVALIDARG);

        const enumOut = p.out();
        assert.equal(await p.callMethod(data, D.ENUM, [2, enumOut]), E_NOTIMPL, 'DATADIR_SET');
        assert.equal(await p.callMethod(data, D.ENUM, [1, enumOut]), S_OK);
        const formats = p.out(0, 60);
        const fetched = p.out();
        assert.equal(await p.callMethod(p.u32(enumOut), 3, [3, formats, fetched]), S_FALSE);
        assert.equal(p.u32(fetched), 2);
        assert.deepEqual([p.u32(formats), p.u32(formats + 16), p.u32(formats + 20),
            p.u32(formats + 36)], [CF_TEXT, TYMED_HGLOBAL, 0xc100, TYMED_ISTREAM]);
        await p.callMethod(p.u32(enumOut), 2, []);

        const canonical = p.out(0, 20);
        assert.equal(await p.callMethod(data, D.CANONICAL, [formatEtc(CF_TEXT), canonical]),
            DATA_S_SAMEFORMATETC);
        assert.equal(p.u32(canonical), CF_TEXT);
        assert.equal(await p.callMethod(data, D.SET, [0, 0, 0]), E_NOTIMPL);
        assert.equal(await p.callMethod(data, D.DADVISE, [0, 0, 0, 0]), OLE_E_ADVISENOTSUPPORTED);
    });

test('what user32\'s clipboard holds is read through the object, by copy and in place',
    async()=>{
        const { p, get, formatEtc } = setup();
        const block = p.heap.allocate(3);
        p.bytes.set([0x41, 0x42, 0], block);
        p.user32.clipboard.set(CF_TEXT, block);
        const data = await get();
        const medium = p.out(0, 12);
        assert.equal(await p.callMethod(data, D.GET, [formatEtc(CF_TEXT), medium]), S_OK);
        assert.deepEqual([...p.bytes.subarray(p.u32(medium + 4), p.u32(medium + 4) + 3)],
            [0x41, 0x42, 0]);
        assert.equal(await p.callMethod(data, D.GET, [formatEtc(CF_UNICODETEXT), medium]),
            DV_E_FORMATETC);

        const target = p.heap.allocate(8);
        p.put(medium, TYMED_HGLOBAL);
        p.put(medium + 4, target);
        assert.equal(await p.callMethod(data, D.GET_HERE, [formatEtc(CF_TEXT), medium]), S_OK);
        assert.equal(p.bytes[target + 1], 0x42);
        p.put(medium + 4, p.heap.allocate(1));
        assert.equal(await p.callMethod(data, D.GET_HERE, [formatEtc(CF_TEXT), medium]),
            0x80030070 | 0, 'STG_E_MEDIUMFULL');
    });

test('OleFlushClipboard needs an apartment; OleGetClipboard does not', async()=>{
    // clipboard.c test_get_clipboard_uninitialized.
    const { p, run, get } = setup();
    p.thread.ole32 = null;
    assert.notEqual(await get(), 0);
    assert.equal(await run('OleFlushClipboard', []), E_FAIL);
});

test('a source\'s medium released by another is copied onto the clipboard', async()=>{
    const { p, run } = setup();
    const owner = p.guestObject([], {});
    const src = source(p, 'held', { released: owner.pointer });
    assert.equal(await run('OleSetClipboard', [src.object.pointer]), S_OK);
    assert.ok(p.user32.clipboard.get(CF_TEXT));
    assert.deepEqual(p.releasedMedia.length, 1, 'the medium given back to its owner');
});

test('the last OleUninitialize of the source\'s thread takes it off the clipboard', async()=>{
    const { p, run, uninitialize } = setup();
    const src = source(p, 'gone');
    await run('OleSetClipboard', [src.object.pointer]);
    assert.equal(uninitialize({ another: true }), null, 'another thread\'s leaves it');
    await uninitialize(p.thread);
    assert.equal(src.object.refs, 1);
    assert.equal(await run('OleIsCurrentClipboard', [src.object.pointer]), S_FALSE);
    assert.ok(p.user32.clipboard.get(CF_TEXT), 'what was rendered stays');
});

test('with no user32 the OLE clipboard is the process\'s own, and that is said', async()=>{
    const { p, run, get, formatEtc } = setup({ system: false });
    const src = source(p, 'x');
    assert.equal(await run('OleSetClipboard', [src.object.pointer]), S_OK);
    assert.equal(p.reported.length, 1);
    assert.equal(await run('OleIsCurrentClipboard', [src.object.pointer]), S_OK);
    const data = await get();
    const medium = p.out(0, 12);
    assert.equal(await p.callMethod(data, D.GET, [formatEtc(CF_TEXT), medium]), S_OK);
    assert.equal(src.counts.get, 1, 'asked of the source, nothing having been rendered');
});
