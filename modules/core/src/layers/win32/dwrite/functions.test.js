/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IID, bitsOf, createDwriteFunctions, f32 } from './functions.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const E_NOINTERFACE = 0x80004002;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a;
const DWRITE_E_NOFONT = 0x88985002;
const DWRITE_E_FILENOTFOUND = 0x88985003;
const DWRITE_E_UNSUPPORTEDOPERATION = 0x88985009;
const IID_TEXT_ANALYZER = '{B7E6163E-7F46-43B4-84B3-E4E6249C365D}';
const IID_GLYPH_RUN_ANALYSIS = '{7D97DBF7-E085-42D4-81E3-6A883BDED118}';
const IID_RENDERING_PARAMS = '{2F0DA53A-2ADD-47CD-82EE-D9EC34688E75}';

/**
 * Guest memory, a heap, published interfaces as pointers, and a program's
 * own COM objects as tables of JS functions.
 *
 * @param {{ measure?: any, files?: Record<string, Uint8Array> }} [options]
 */
function harness(options = {}){
    const memory = new Uint8Array(1 << 24);
    const view = new DataView(memory.buffer);
    let next = 0x100000;
    /** @type {Map<number, { object: any, iid: string }>} */
    const pointers = new Map();
    /** @type {Map<any, Map<string, number>>} */
    const published = new Map();
    /** @type {Map<number, (args: number[]) => number | Promise<number>>} */
    const entries = new Map();
    /** @type {{ api: string, detail: string, kind?: string }[]} */
    const said = [];
    let result = 0;
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>memory.set(bytes, at),
        heap: {
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += (bytes + 15) & ~15;
                return at;
            },
            free: ()=>0,
        },
        vtables: {
            publish: (/** @type {any} */ object, /** @type {string} */ iid)=>{
                const record = object.interfaceFor(iid);
                if (!record)
                {
                    return 0;
                }
                let byIid = published.get(object);
                if (!byIid)
                {
                    byIid = new Map();
                    published.set(object, byIid);
                }
                let pointer = byIid.get(record.id);
                if (!pointer)
                {
                    pointer = next;
                    next += 16;
                    byIid.set(record.id, pointer);
                    pointers.set(pointer, { object, iid: record.id });
                }
                return pointer;
            },
        },
        objectAt: (/** @type {number} */ pointer)=>pointers.get(pointer)?.object ?? null,
        callGuest: async(/** @type {{ entry: number, args: number[] }} */ call)=>{
            const fn = entries.get(call.entry);
            if (!fn)
            {
                throw new Error(`no guest function at ${call.entry}`);
            }
            return fn(call.args);
        },
        currentThread: ()=>undefined,
        readFile: (/** @type {string} */ path)=>options.files?.[path] ?? null,
        fpu: { setResult: (/** @type {number} */ value)=>{
            result = value;
        } },
        divergence: (/** @type {string} */ api, /** @type {string} */ detail,
            /** @type {string} */ kind)=>said.push({ api, detail, kind }),
        measure: options.measure ?? { metrics: ()=>null, textWidth: ()=>null, glyph: ()=>null },
    };
    const fns = createDwriteFunctions(/** @type {any} */ (host));
    const alloc = (/** @type {number} */ bytes)=>host.heap.allocate(bytes);
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    /** @param {string} text */
    const wide = text=>{
        const at = alloc((text.length + 1) * 2);
        [...text].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
        return at;
    };
    /**
     * A method of a published interface, by name.
     *
     * @param {number} pointer @param {string} name @param {...number} args
     */
    const call = async(pointer, name, ...args)=>{
        const { object, iid } = /** @type {{ object: any, iid: string }} */ (pointers.get(pointer));
        const method = object.interfaceFor(iid).methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(method, `${name} on ${iid}`);
        assert.equal(method.argBytes, 4 + args.length * 4, `${name}: ${args.length} arguments`);
        return (await method.invoke(object, args)) >>> 0;
    };
    /** A program's COM object: a vtable of functions, IUnknown's first. @param {Function[]} methods */
    const guestObject = methods=>{
        const object = alloc(8);
        const table = alloc(4 * (3 + methods.length));
        view.setUint32(object, table, true);
        [()=>E_NOINTERFACE, ()=>2, ()=>1, ...methods].forEach((fn, slot)=>{
            const entry = 0x7000000 + entries.size;
            entries.set(entry, args=>fn(...args.slice(1)));
            view.setUint32(table + slot * 4, entry, true);
        });
        return object;
    };
    /** @param {string} iid */
    const guid = iid=>{
        const at = alloc(16);
        const hex = iid.replace(/[{}-]/g, '');
        view.setUint32(at, parseInt(hex.slice(0, 8), 16), true);
        view.setUint16(at + 4, parseInt(hex.slice(8, 12), 16), true);
        view.setUint16(at + 6, parseInt(hex.slice(12, 16), 16), true);
        for (let i = 0; i < 8; i++)
        {
            memory[at + 8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
        }
        return at;
    };
    /** A LOGFONTW's face name. @param {number} logfont @param {string} name */
    const faceName = (logfont, name)=>[...`${name}\0`].forEach((c, i)=>
        view.setUint16(logfont + 28 + i * 2, c.charCodeAt(0), true));
    const factory = async(type = 0)=>{
        const out = alloc(4);
        assert.equal(fns.DWriteCreateFactory.handler([type, guid(IID.FACTORY), out]) >>> 0, S_OK);
        return u32(out);
    };
    return { memory, view, host, fns, alloc, u32, wide, call, guestObject, guid, factory, said,
        faceName,
        result: ()=>result, pointers };
}

test('DWriteCreateFactory: one shared factory, isolated ones of their own', async()=>{
    const h = harness();
    const shared = await h.factory(0);
    assert.equal(await h.factory(0), shared);
    assert.notEqual(await h.factory(1), await h.factory(1));
    const out = h.alloc(4);
    assert.equal(h.fns.DWriteCreateFactory.handler([2, h.guid(IID.FACTORY), out]) >>> 0,
        E_INVALIDARG);
    assert.equal(h.fns.DWriteCreateFactory.handler([0, h.guid(IID.FONT), out]) >>> 0,
        E_NOINTERFACE);
    assert.equal(h.u32(out), 0);
});

test('the system collection: families, the nearest font, its face', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const out = h.alloc(16);
    assert.equal(await h.call(factory, 'GetSystemFontCollection', out, 0), S_OK);
    const collection = h.u32(out);
    assert.equal(await h.call(factory, 'GetSystemFontCollection', out + 4, 0), S_OK);
    assert.equal(h.u32(out + 4), collection, 'the same collection each time');
    assert.equal(await h.call(collection, 'FindFamilyName', h.wide('tahoma'), out, out + 4), S_OK);
    assert.equal(h.u32(out + 4), 1, 'found, whatever the case');
    const index = h.u32(out);
    assert.equal(await h.call(collection, 'GetFontFamily', index, out + 8), S_OK);
    const family = h.u32(out + 8);
    assert.equal(await h.call(family, 'GetFontCount'), 2, 'Tahoma has no italics');
    assert.equal(await h.call(family, 'GetFirstMatchingFont', 400, 5, 2, out + 12), S_OK);
    const font = h.u32(out + 12);
    assert.equal(await h.call(font, 'GetStyle'), 1, 'an italic asked of Tahoma is oblique');
    assert.equal(await h.call(font, 'GetSimulations'), 2);
    assert.equal(await h.call(font, 'HasCharacter', 0xd800, out), S_OK);
    assert.equal(h.u32(out), 0);
    assert.equal(await h.call(font, 'CreateFontFace', out), S_OK);
    const face = h.u32(out);
    assert.equal(await h.call(face, 'GetSimulations'), 2);
    const codes = h.alloc(8);
    h.view.setUint32(codes, 0x41, true);
    h.view.setUint32(codes + 4, 0x10000, true);
    const glyphs = h.alloc(4);
    assert.equal(await h.call(face, 'GetGlyphIndices', codes, 2, glyphs), S_OK);
    assert.deepEqual([h.view.getUint16(glyphs, true), h.view.getUint16(glyphs + 2, true)],
        [0x41, 0]);
    const metrics = h.alloc(20);
    await h.call(face, 'GetMetrics', metrics);
    assert.equal(h.view.getUint16(metrics, true), 2048);
    const table = h.alloc(16);
    assert.equal(await h.call(face, 'TryGetFontTable', 0x70616d63 /* 'cmap' */, table,
        table + 4, table + 8, table + 12), S_OK);
    assert.equal(h.u32(table + 12), 1);
    assert.equal(h.view.getUint16(h.u32(table) + 2, false), 1, 'the cmap table, in guest memory');
});

test('GDI interop: a LOGFONT to a font and back', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const out = h.alloc(8);
    assert.equal(await h.call(factory, 'GetGdiInterop', out), S_OK);
    const interop = h.u32(out);
    assert.equal(await h.call(factory, 'GetGdiInterop', out + 4), S_OK);
    assert.equal(h.u32(out + 4), interop);
    const logfont = h.alloc(92);
    h.view.setInt32(logfont + 16, 700, true);
    h.faceName(logfont, 'Arial');
    assert.equal(await h.call(interop, 'CreateFontFromLOGFONT', logfont, out), S_OK);
    const font = h.u32(out);
    assert.equal(await h.call(font, 'GetWeight'), 700);
    const back = h.alloc(92);
    assert.equal(await h.call(interop, 'ConvertFontToLOGFONT', font, back, out + 4), S_OK);
    assert.equal(h.view.getInt32(back + 16, true), 700);
    assert.equal(h.memory[back + 24], 8, 'OUT_OUTLINE_PRECIS');
    assert.equal(h.u32(out + 4), 1, 'a system font');
    h.faceName(logfont, 'Nowhere');
    assert.equal(await h.call(interop, 'CreateFontFromLOGFONT', logfont, out), DWRITE_E_NOFONT);
    assert.equal(h.u32(out), 0);
});

test('rendering parameters are checked and kept', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const out = h.alloc(4);
    const make = (/** @type {number[]} */ values)=>h.call(factory, 'CreateCustomRenderingParams',
        ...values.slice(0, 3).map(bitsOf), values[3], values[4], out);
    assert.equal(await make([0, 0, 0, 0, 4]), E_INVALIDARG, 'gamma 0');
    assert.equal(await make([1, -0.1, 0, 0, 4]), E_INVALIDARG);
    assert.equal(await make([1, 0, 0, 3, 4]), E_INVALIDARG, 'pixel geometry past BGR');
    assert.equal(await make([1, 0, 0, 2, 7]), E_INVALIDARG, 'mode past outline');
    assert.equal(await make([0.9, 0.3, 2, 2, 4]), S_OK, 'a ClearType level past 1');
    const params = h.u32(out);
    await h.call(params, 'GetGamma');
    assert.equal(h.result(), f32(bitsOf(0.9)));
    assert.equal(await h.call(params, 'GetRenderingMode'), 4);
});

test('a font file the program names: a local one, or not found', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const out = h.alloc(4);
    assert.equal(await h.call(factory, 'CreateFontFileReference', h.wide('C:\\none.ttf'), 0, out),
        DWRITE_E_FILENOTFOUND);
    const time = h.alloc(8);
    h.view.setUint32(time, 0x89abcdef, true);
    h.view.setUint32(time + 4, 0x01234567, true);
    assert.equal(await h.call(factory, 'CreateFontFileReference', h.wide('C:\\none.ttf'), time,
        out), S_OK, 'a file named with its time need not exist');
    const file = h.u32(out);
    const key = h.alloc(8);
    assert.equal(await h.call(file, 'GetReferenceKey', key, key + 4), S_OK);
    assert.equal(h.u32(h.u32(key)), 0x89abcdef, 'the key starts with the last write');
    assert.equal(h.u32(h.u32(key) + 4), 0x01234567);
    assert.equal(await h.call(file, 'Analyze', out, out, out, out), DWRITE_E_FILENOTFOUND);
});

test('a program\'s loader streams a file it keys', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const arial = h.alloc(4);
    {
        const out = h.alloc(4);
        await h.call(factory, 'CreateFontFileReference', h.wide('C:\\WINDOWS\\Fonts\\arial.ttf'), 0,
            out);
        const face = h.alloc(4);
        await h.call(factory, 'CreateFontFace', 1, 1, out, 0, 0, face);
        const files = h.alloc(4);
        const count = h.alloc(4);
        h.view.setUint32(count, 1, true);
        await h.call(h.u32(face), 'GetFiles', count, files);
        const stream = h.alloc(4);
        const loader = h.alloc(4);
        await h.call(h.u32(files), 'GetLoader', loader);
        const keyOut = h.alloc(8);
        await h.call(h.u32(files), 'GetReferenceKey', keyOut, keyOut + 4);
        assert.equal(await h.call(h.u32(loader), 'CreateStreamFromKey', h.u32(keyOut),
            h.u32(keyOut + 4), stream), S_OK);
        h.view.setUint32(arial, h.u32(stream), true);
    }
    // The program's stream hands back the system face's bytes as its own font.
    const size = h.alloc(8);
    await h.call(h.u32(arial), 'GetFileSize', size);
    const fragment = h.alloc(8);
    await h.call(h.u32(arial), 'ReadFileFragment', fragment, 0, 0, h.u32(size), 0, fragment + 4);
    const data = h.u32(fragment);
    const length = h.u32(size);
    const stream = h.guestObject([
        /** @param {number} start @param {number} offset @param {number} _high
         *  @param {number} bytes @param {number} _bytesHigh @param {number} context */
        (start, offset, _high, bytes, _bytesHigh, context)=>
        {
            h.view.setUint32(start, data + offset, true);
            h.view.setUint32(context, 0, true);
            return offset + bytes <= length ? S_OK : 0x80004005;
        },
        ()=>0,
        (/** @type {number} */ out)=>(h.view.setUint32(out, length, true), h.view.setUint32(out + 4,
            0, true), S_OK),
        ()=>0x80004001,
    ]);
    /** @type {number[]} */
    const keys = [];
    const loader = h.guestObject([
        (/** @type {number} */ key, /** @type {number} */ bytes, /** @type {number} */ out)=>{
            keys.push(...h.memory.subarray(key, key + bytes));
            h.view.setUint32(out, stream, true);
            return S_OK;
        },
    ]);
    const out = h.alloc(4);
    const key = h.alloc(4);
    h.view.setUint32(key, 0x5a5a, true);
    assert.equal(await h.call(factory, 'CreateCustomFontFileReference', key, 4, loader, out),
        E_INVALIDARG, 'not registered');
    assert.equal(await h.call(factory, 'RegisterFontFileLoader', loader), S_OK);
    assert.equal(await h.call(factory, 'RegisterFontFileLoader', loader), 0x88985006);
    assert.equal(await h.call(factory, 'CreateCustomFontFileReference', key, 4, loader, out), S_OK);
    const kind = h.alloc(16);
    assert.equal(await h.call(h.u32(out), 'Analyze', kind, kind + 4, kind + 8, kind + 12), S_OK);
    assert.deepEqual([h.u32(kind), h.u32(kind + 4), h.u32(kind + 8), h.u32(kind + 12)],
        [1, 2, 1, 1], 'a TrueType file of one face');
    assert.deepEqual(keys, [0x5a, 0x5a, 0, 0], 'the loader was handed the key');
    const face = h.alloc(4);
    assert.equal(await h.call(factory, 'CreateFontFace', 0, 1, out, 0, 0, face), 0x88985000,
        'a CFF face asked of a TrueType file');
    assert.equal(await h.call(factory, 'CreateFontFace', 7, 1, out, 0, 0, face),
        DWRITE_E_UNSUPPORTEDOPERATION);
    assert.equal(await h.call(factory, 'CreateFontFace', 6, 1, out, 0, 0, face), S_OK,
        'an unknown type takes the file\'s');
    assert.equal(await h.call(h.u32(face), 'GetType'), 1);
});

test('the analyzer reads the program\'s source and answers its sink', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const out = h.alloc(4);
    assert.equal(await h.call(factory, 'CreateTextAnalyzer', out), S_OK);
    const analyzer = h.u32(out);
    assert.equal(h.pointers.get(analyzer)?.iid, IID_TEXT_ANALYZER);
    const text = 'ab \u0645\u0646';
    const textAt = h.wide(text);
    /** @type {number[][]} */
    const runs = [];
    /** @type {number[][]} */
    const levels = [];
    /** @type {number[]} */
    let breaks = [];
    const source = h.guestObject([
        (/** @type {number} */ position, /** @type {number} */ to, /** @type {number} */ length)=>{
            h.view.setUint32(to, position < text.length ? textAt + position * 2 : 0, true);
            h.view.setUint32(length, Math.max(0, text.length - position), true);
            return S_OK;
        },
        ()=>0x80004001, ()=>0, ()=>0x80004001, ()=>0x80004001,
    ]);
    const sink = h.guestObject([
        (/** @type {number} */ at, /** @type {number} */ length, /** @type {number} */ sa)=>
            (runs.push([at, length, h.view.getUint16(sa, true), h.u32(sa + 4)]), S_OK),
        (/** @type {number} */ at, /** @type {number} */ length, /** @type {number} */ points)=>
            (breaks = [...h.memory.subarray(points, points + length)], S_OK),
        (/** @type {number} */ at, /** @type {number} */ length, /** @type {number} */ explicit,
            /** @type {number} */ resolved)=>(levels.push([at, length, explicit, resolved]), S_OK),
        ()=>S_OK,
    ]);
    assert.equal(await h.call(analyzer, 'AnalyzeScript', source, 0, text.length, sink), S_OK);
    assert.deepEqual(runs, [[0, 3, 49, 0], [3, 2, 3, 0]], 'Latin, then Arabic');
    assert.equal(await h.call(analyzer, 'AnalyzeBidi', source, 0, text.length, sink), S_OK);
    assert.deepEqual(levels, [[0, 3, 0, 0], [3, 2, 0, 1]]);
    assert.equal(await h.call(analyzer, 'AnalyzeLineBreakpoints', source, 0, text.length, sink),
        S_OK);
    assert.equal(breaks.length, 5);
    assert.equal(breaks[2] & 0x10, 0x10, 'the space is white space');
});

test('glyphs and placements: a glyph a character, advances at the size', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const out = h.alloc(4);
    await h.call(factory, 'CreateTextAnalyzer', out);
    const analyzer = h.u32(out);
    await h.call(factory, 'GetGdiInterop', out);
    const logfont = h.alloc(92);
    h.faceName(logfont, 'Arial');
    await h.call(h.u32(out), 'CreateFontFromLOGFONT', logfont, out);
    await h.call(h.u32(out), 'CreateFontFace', out);
    const face = h.u32(out);
    const sa = h.alloc(8);
    h.view.setUint16(sa, 49, true);
    const cluster = h.alloc(16);
    const textProps = h.alloc(16);
    const glyphs = h.alloc(16);
    const glyphProps = h.alloc(16);
    const count = h.alloc(4);
    const text = h.wide('a b(');
    const getGlyphs = (/** @type {number} */ rtl, /** @type {number} */ max)=>h.call(analyzer,
        'GetGlyphs', text, 4, face, 0, rtl, sa, 0, 0, 0, 0, 0, max, cluster, textProps, glyphs,
        glyphProps, count);
    assert.equal(await getGlyphs(0, 3), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(await getGlyphs(1, 8), S_OK);
    assert.equal(h.u32(count), 4);
    assert.equal(h.view.getUint16(glyphs + 6, true), 0x29, 'mirrored in a right to left run');
    assert.deepEqual([0, 1, 2, 3].map(i=>h.view.getUint16(cluster + i * 2, true)), [0, 1, 2, 3]);
    assert.equal(h.view.getUint16(glyphProps + 2, true) & 0x1f, 0x10 | 4, 'a cluster start, blank');
    const advances = h.alloc(16);
    const offsets = h.alloc(32);
    assert.equal(await h.call(analyzer, 'GetGlyphPlacements', text, cluster, textProps, 4, glyphs,
        glyphProps, 4, face, bitsOf(20.48), 0, 0, sa, 0, 0, 0, 0, advances, offsets), S_OK);
    const designs = h.alloc(28 * 4);
    await h.call(face, 'GetDesignGlyphMetrics', glyphs, 4, designs, 0);
    for (let i = 0; i < 4; i++)
    {
        const design = h.u32(designs + i * 28 + 4);
        assert.ok(Math.abs(f32(h.u32(advances + i * 4)) - design / 100) < 1e-3);
    }
});

test('a glyph run analysis: bounds from the boxes, a texture of the asked type', async()=>{
    /** @type {any[]} */
    const drawn = [];
    const h = harness({ measure: {
        metrics: ()=>({ ascent: 20, descent: 5, externalLeading: 0, aveCharWidth: 10,
            maxCharWidth: 20 }),
        textWidth: ()=>12,
        glyph: (/** @type {number} */ code, /** @type {any} */ font)=>(drawn.push([code, font.height]),
        { advance: 12, left: 0, top: 4, width: 10, height: 16,
            coverage: new Uint8Array(160).fill(255) }),
    } });
    const factory = await h.factory(1);
    const out = h.alloc(4);
    await h.call(factory, 'GetGdiInterop', out);
    const logfont = h.alloc(92);
    h.faceName(logfont, 'Arial');
    await h.call(h.u32(out), 'CreateFontFromLOGFONT', logfont, out);
    await h.call(h.u32(out), 'CreateFontFace', out);
    const face = h.u32(out);
    const glyph = h.alloc(4);
    h.view.setUint16(glyph, 0x41, true);
    const run = h.alloc(32);
    h.view.setUint32(run, face, true);
    h.view.setFloat32(run + 4, 32, true);
    h.view.setUint32(run + 8, 1, true);
    h.view.setUint32(run + 12, glyph, true);
    const make = (/** @type {number} */ mode, /** @type {number} */ ppd)=>h.call(factory,
        'CreateGlyphRunAnalysis', run, bitsOf(ppd), 0, mode, 0, 0, 0, out);
    assert.equal(await make(0, 1), E_INVALIDARG, 'the default mode is not one');
    assert.equal(await make(6, 1), E_INVALIDARG, 'nor are outlines');
    assert.equal(await make(1, 0), E_INVALIDARG);
    assert.equal(await make(1, 1), S_OK);
    const analysis = h.u32(out);
    assert.equal(h.pointers.get(analysis)?.iid, IID_GLYPH_RUN_ANALYSIS);
    const rect = h.alloc(16);
    assert.equal(await h.call(analysis, 'GetAlphaTextureBounds', 1, rect), S_OK);
    assert.deepEqual([0, 4, 8, 12].map(i=>h.u32(rect + i)), [0, 0, 0, 0], 'no ClearType texture');
    assert.equal(await h.call(analysis, 'GetAlphaTextureBounds', 0, rect), S_OK);
    const [left, top, right, bottom] = [0, 4, 8, 12].map(i=>h.view.getInt32(rect + i, true));
    assert.ok(right > left && bottom > top && top < 0 && bottom <= 0 + 1, 'above the baseline');
    const size = (right - left) * (bottom - top);
    const buffer = h.alloc(size * 3);
    assert.equal(await h.call(analysis, 'CreateAlphaTexture', 0, rect, buffer, size - 1),
        E_NOT_SUFFICIENT_BUFFER);
    assert.equal(await h.call(analysis, 'CreateAlphaTexture', 1, rect, buffer, size * 3),
        DWRITE_E_UNSUPPORTEDOPERATION);
    assert.equal(await h.call(analysis, 'CreateAlphaTexture', 0, rect, buffer, size), S_OK);
    assert.ok(h.memory.subarray(buffer, buffer + size).includes(255), 'the glyph is drawn');
    assert.deepEqual(drawn.at(-1), [0x41, -32], 'at the run\'s size in pixels');
    await h.call(factory, 'CreateRenderingParams', out);
    const params = h.u32(out);
    assert.equal(h.pointers.get(params)?.iid, IID_RENDERING_PARAMS);
    const blend = h.alloc(12);
    assert.equal(await h.call(analysis, 'GetAlphaBlendParams', params, blend, blend + 4, blend + 8),
        S_OK);
    assert.equal(f32(h.u32(blend)), f32(bitsOf(1.8)));
});

test('text formats and layouts are refused, and said', async()=>{
    const h = harness();
    const factory = await h.factory(1);
    const out = h.alloc(4);
    h.view.setUint32(out, 0xdeadbeef, true);
    assert.equal(await h.call(factory, 'CreateTextFormat', 0, 0, 400, 0, 5, 0, 0, out), 0x80004001);
    assert.equal(h.u32(out), 0);
    assert.ok(h.said.some(entry=>entry.api === 'IDWriteFactory::CreateTextFormat'));
});
