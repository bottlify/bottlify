/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Enhanced metafiles recorded, read, written and played; the Windows
 * metafile played, and the two converted into each other.
 *
 * **Recording.** A DC CreateEnhMetaFile makes draws -- into a pixel of its
 * own, so that everything a program reads back answers as it would -- and
 * every call made on it that a metafile has a record for is written down as
 * that record, before it runs: the state it sets, the objects it selects
 * (each written the first time it is selected, under the next free index of
 * the metafile's own handle table), the figures, text and pictures it draws.
 * The points are the program's logical ones; the bounds in the header are
 * the device's, gathered as the records go. A call that draws and has no
 * record here is reported, once, and leaves nothing in the picture.
 *
 * **Playing.** A record is played by making the call it records, through the
 * same entry points a program calls, with its arguments where they would be:
 * the metafile is copied into guest memory and every pointer a call is given
 * points into that copy. The picture is fitted to the rectangle it is played
 * into by a world transform on the DC, and the metafile's own mapping mode,
 * window, viewport and world transform are followed by recomputing that
 * transform, so they never touch the DC's page; its state is saved before
 * and restored after, and the objects the metafile made are deleted.
 *
 * **Converting.** GetWinMetaFileBits writes the EMF out as a WMF (`emfToWmf`),
 * the EMF itself inside; SetWinMetaFileBits gives that EMF back when it is
 * there, and otherwise records a new one by playing the WMF onto an enhanced
 * metafile DC whose viewport is the picture's -- the conversion Windows makes.
 */

import {
    EMR, ETO_CLIPPED, ETO_OPAQUE, IDENTITY, META, MM_ANISOTROPIC, MM_ISOTROPIC, blankWmf,
    buildEmf, compose, createPage, embeddedEmf, emfPalette, emfRecord, emfRecords, emfRefusal,
    emfToWmf, isWmf, pointsIn, readEmfHeader, viewOf, wmfRecords,
} from './emf.js';
import { logFontBytes } from './structs.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_DATA = 13;
const ERROR_NOT_SUPPORTED = 50;
const GDI_ERROR = 0xffffffff;

/** The graphics mode whose world transform the drawing follows. */
const GM_ADVANCED = 2;
const RGN_AND = 1;
const RGN_COPY = 5;
const FLOODFILLBORDER = 0;
/** A stock object in a metafile's handle table: the index, with the top bit. */
const STOCK = 0x80000000;
const DEFAULT_PALETTE = 15;
/** Brush styles a LOGBRUSH can carry whole. */
const BS_SOLID = 0;
const BS_NULL = 1;
const BS_HATCHED = 2;
const DIB_PAL_COLORS = 1;
const BI_BITFIELDS = 3;
const RGNDATAHEADER_SIZE = 32;
const PS_STYLE_MASK = 0x0f;
const GM_COMPATIBLE = 1;
/** The lowest mapping mode, MM_TEXT. */
const MM_TEXT_MODE = 1;
/** The raster operations a fill and an inversion are. */
const PATCOPY = 0x00f00021;
const DSTINVERT = 0x00550009;
const TRANSPARENT = 1;

/** The calls that draw and that no record here keeps: reported on a metafile DC. */
const UNRECORDED = Object.freeze(['MaskBlt', 'PlgBlt', 'GdiAlphaBlend', 'GdiTransparentBlt',
    'GdiGradientFill']);

/** The records whose bounds field is the device rectangle the record draws in. */
const BOUNDED = new Set(/** @type {number[]} */ ([EMR.FILLPATH, EMR.STROKEANDFILLPATH,
    EMR.STROKEPATH]));

/**
 * @typedef {Object} MetafileContext
 * @property {any} host  The GDI host: memory, the guest heap, last error, divergence.
 * @property {any} objects  The GDI object table.
 * @property {(handle: number) => any | null} dcOf
 * @property {(name: string, args: number[]) => any} call  An entry point of this library.
 * @property {(dc: any, point: { x: number, y: number }, toDevice: boolean)
 *     => { x: number, y: number }} transform  LPtoDP, or DPtoLP.
 * @property {() => { device: { cx: number, cy: number },
 *     millimeters: { cx: number, cy: number } }} reference
 *     The display a metafile is recorded against: its pixels and millimetres.
 * @property {(handle: number) => number | null} stockIndexOf  A stock object's index.
 * @property {(dc: any, text: string) => { cx: number, cy: number }} textExtent
 *     How large text is in the DC's font, in logical units.
 */

/** @param {MetafileContext} context */
export function createMetafileFunctions({ host, objects, dcOf, call, transform, reference,
    stockIndexOf, textExtent })
{
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>{
        if (!said.has(api))
        {
            said.add(api);
            host.divergence?.(api, detail);
        }
    };
    /** @param {number} code */
    const refuse = code=>{
        host.setLastError?.(code);
        return 0;
    };

    /** The DCs recording now, for DeleteObject, which names no DC. @type {Set<any>} */
    const recording = new Set();

    /**
     * Guest memory for the length of `use`: what a played record's
     * arguments point into.
     *
     * @template T
     * @param {number} size @param {(address: number) => T} use
     * @returns {T}
     */
    const borrowed = (size, use)=>{
        const address = host.surfaces.allocate(Math.max(16, size));
        if (!address)
        {
            throw new Error('no guest memory for a metafile record');
        }
        try
        {
            return use(address);
        }
        finally
        {
            host.surfaces.free(address);
        }
    };

    // --- recording ---

    /**
     * @typedef {Object} Recorder
     * @property {Uint8Array[]} records
     * @property {{ left: number, top: number, right: number, bottom: number } | null} bounds
     * @property {any} frame  The picture frame the program gave, or null.
     * @property {string} description
     * @property {Map<number, number>} handles  An object's index in the table.
     * @property {Set<number>} free  Indices given back by a delete.
     * @property {number} next  The next index never used.
     * @property {number} depth  How deep the calls on the DC are nested.
     */

    /**
     * Starts recording what is drawn on a DC.
     *
     * @param {any} dc @param {{ frame?: any, description?: string }} [options]
     */
    const startRecording = (dc, { frame = null, description = '' } = {})=>{
        /** @type {Recorder} */
        const recorder = { records: [], bounds: null, frame, description,
            handles: new Map(), free: new Set(), next: 1, depth: 0 };
        dc.recorder = recorder;
        recording.add(dc);
    };

    /**
     * Ends the recording, and answers the EMF.
     *
     * @param {any} dc
     * @returns {Uint8Array}
     */
    const finishRecording = dc=>{
        /** @type {Recorder} */
        const recorder = dc.recorder;
        recording.delete(dc);
        dc.recorder = null;
        const { device, millimeters } = reference();
        return buildEmf(recorder.records, { bounds: recorder.bounds, frame: recorder.frame,
            device, millimeters, handles: recorder.next, description: recorder.description });
    };

    /**
     * Widens the picture's bounds by device points.
     *
     * @param {any} dc @param {{ x: number, y: number }[]} points  Logical.
     * @returns {{ left: number, top: number, right: number, bottom: number }}
     *     the points' own device box, inclusive
     */
    const include = (dc, points)=>{
        const mapped = points.map(point=>transform(dc, point, true));
        const box = mapped.reduce((into, point)=>({
            left: Math.min(into.left, point.x), top: Math.min(into.top, point.y),
            right: Math.max(into.right, point.x), bottom: Math.max(into.bottom, point.y),
        }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
        if (mapped.length === 0)
        {
            return { left: 0, top: 0, right: -1, bottom: -1 };
        }
        const recorder = dc.recorder;
        recorder.bounds = recorder.bounds ? {
            left: Math.min(recorder.bounds.left, box.left),
            top: Math.min(recorder.bounds.top, box.top),
            right: Math.max(recorder.bounds.right, box.right),
            bottom: Math.max(recorder.bounds.bottom, box.bottom),
        } : box;
        return box;
    };

    /**
     * A box's corners as the figure covers them: its far edges left out.
     *
     * @param {number} left @param {number} top @param {number} right @param {number} bottom
     */
    const boxCorners = (left, top, right, bottom)=>[
        { x: Math.min(left, right), y: Math.min(top, bottom) },
        { x: Math.max(left, right) - 1, y: Math.max(top, bottom) - 1 },
    ];

    /**
     * Appends a record of DWORD fields.
     *
     * @param {any} dc @param {number} type @param {number[]} fields  After the type and size.
     */
    const put = (dc, type, fields)=>{
        const record = emfRecord(type, 8 + fields.length * 4);
        fields.forEach((value, index)=>record.view.setUint32(8 + index * 4, value >>> 0, true));
        dc.recorder.records.push(record.bytes);
    };

    /** @param {{ left: number, top: number, right: number, bottom: number }} box */
    const rectFields = box=>[box.left, box.top, box.right, box.bottom];

    /**
     * The metafile's index for an object, writing the record that makes it
     * the first time; null for an object a metafile cannot hold.
     *
     * @param {any} dc @param {number} handle
     * @returns {number | null}
     */
    const indexOf = (dc, handle)=>{
        const stock = stockIndexOf(handle >>> 0);
        if (stock !== null)
        {
            return (STOCK | stock) >>> 0;
        }
        /** @type {Recorder} */
        const recorder = dc.recorder;
        const known = recorder.handles.get(handle >>> 0);
        if (known !== undefined)
        {
            return known;
        }
        const object = objects.get(handle);
        if (!object || !['pen', 'brush', 'font', 'palette'].includes(object.type))
        {
            return null;
        }
        const reused = [...recorder.free].sort((a, b)=>a - b)[0];
        const index = reused ?? recorder.next++;
        recorder.free.delete(index);
        recorder.handles.set(handle >>> 0, index);
        const attributes = object.attributes;
        if (object.type === 'pen')
        {
            put(dc, EMR.CREATEPEN, [index, attributes.style & PS_STYLE_MASK, attributes.width | 0,
                0, attributes.color]);
        }
        else if (object.type === 'brush')
        {
            const whole = [BS_SOLID, BS_NULL, BS_HATCHED].includes(attributes.style);
            if (!whole)
            {
                diverge('CreateEnhMetaFile', 'a pattern brush is recorded as a solid one');
            }
            put(dc, EMR.CREATEBRUSHINDIRECT, [index, whole ? attributes.style : BS_SOLID,
                attributes.color, whole ? attributes.hatch | 0 : 0]);
        }
        else if (object.type === 'font')
        {
            const font = logFontBytes(attributes, true);
            const record = emfRecord(EMR.EXTCREATEFONTINDIRECTW, 12 + font.length);
            record.view.setUint32(8, index, true);
            record.bytes.set(font, 12);
            recorder.records.push(record.bytes);
        }
        else
        {
            const entries = attributes.entries;
            const record = emfRecord(EMR.CREATEPALETTE, 16 + entries.length * 4);
            record.view.setUint32(8, index, true);
            record.view.setUint16(12, 0x300, true);
            record.view.setUint16(14, entries.length, true);
            entries.forEach((/** @type {number} */ entry, /** @type {number} */ at)=>
                record.view.setUint32(16 + at * 4, entry, true));
            recorder.records.push(record.bytes);
        }
        return index;
    };

    /** @param {number} address @param {number} count */
    const pointsAt = (address, count)=>{
        const bytes = host.readMemory(address >>> 0, Math.max(0, count) * 8);
        return pointsIn(viewOf(bytes), 0, Math.floor(bytes.length / 8), false);
    };

    /**
     * A record of points, in sixteen bits when every one fits, as Windows
     * writes them: the bounds, the count, and the points.
     *
     * @param {any} dc @param {number} wide @param {number} narrow  The two record types.
     * @param {{ x: number, y: number }[]} points
     * @param {number[]} [counts]  For the poly-poly records, each figure's length.
     * @param {Uint8Array} [types]  For PolyDraw, each point's type.
     */
    const putPoints = (dc, wide, narrow, points, counts, types)=>{
        const short = points.every(point=>point.x === (point.x << 16 >> 16)
            && point.y === (point.y << 16 >> 16));
        const box = include(dc, points);
        const head = counts ? 32 + counts.length * 4 : 28;
        const record = emfRecord(short ? narrow : wide, head + points.length * (short ? 4 : 8)
            + (types?.length ?? 0));
        const { view } = record;
        rectFields(box).forEach((value, index)=>view.setInt32(8 + index * 4, value, true));
        if (counts)
        {
            view.setUint32(24, counts.length, true);
            view.setUint32(28, points.length, true);
            counts.forEach((count, index)=>view.setUint32(32 + index * 4, count, true));
        }
        else
        {
            view.setUint32(24, points.length, true);
        }
        points.forEach((point, index)=>{
            if (short)
            {
                view.setInt16(head + index * 4, point.x, true);
                view.setInt16(head + index * 4 + 2, point.y, true);
            }
            else
            {
                view.setInt32(head + index * 8, point.x, true);
                view.setInt32(head + index * 8 + 4, point.y, true);
            }
        });
        if (types)
        {
            record.bytes.set(types, head + points.length * (short ? 4 : 8));
        }
        dc.recorder.records.push(record.bytes);
    };

    /**
     * A region's RGNDATA, read through GetRegionData.
     *
     * @param {number} region
     * @returns {Uint8Array | null}
     */
    const regionData = region=>{
        const size = call('GetRegionData', [region, 0, 0]);
        if (!size)
        {
            return null;
        }
        return borrowed(size, address=>(call('GetRegionData', [region, size, address]) === size
            ? host.readMemory(address, size) : null));
    };

    /**
     * A region record: its bounds, the data's size, the fields between, and
     * the data.
     *
     * @param {any} dc @param {number} type @param {number} region @param {number[]} fields
     */
    const putRegion = (dc, type, region, fields)=>{
        const data = regionData(region);
        if (!data)
        {
            return;
        }
        const view = viewOf(data);
        const box = { left: view.getInt32(16, true), top: view.getInt32(20, true),
            right: view.getInt32(24, true), bottom: view.getInt32(28, true) };
        const bounds = include(dc, boxCorners(box.left, box.top, box.right, box.bottom));
        const head = 28 + fields.length * 4;
        const record = emfRecord(type, head + data.length);
        rectFields(bounds).forEach((value, index)=>record.view.setInt32(8 + index * 4, value,
            true));
        record.view.setUint32(24, data.length, true);
        fields.forEach((value, index)=>record.view.setUint32(28 + index * 4, value >>> 0, true));
        record.bytes.set(data, head);
        dc.recorder.records.push(record.bytes);
    };

    /**
     * The size of a DIB's BITMAPINFO -- header, masks and colour table -- and
     * of its bits, as the calls that draw one read them.
     *
     * @param {Uint8Array} header  At least the BITMAPINFOHEADER.
     * @param {number} usage @param {number} [lines]  The rows given, when fewer than all.
     */
    const dibSizes = (header, usage, lines)=>{
        const view = viewOf(header);
        const size = view.getUint32(0, true);
        const core = size === 12;
        const width = core ? view.getUint16(4, true) : view.getInt32(4, true);
        const height = core ? view.getUint16(6, true) : view.getInt32(8, true);
        const bitCount = core ? view.getUint16(10, true) : view.getUint16(14, true);
        const compression = core ? 0 : view.getUint32(16, true);
        const sizeImage = core ? 0 : view.getUint32(20, true);
        const used = core ? 0 : view.getUint32(32, true);
        const entries = bitCount <= 8 ? (used || 1 << bitCount) : 0;
        const masks = compression === BI_BITFIELDS && size === 40 ? 12 : 0;
        const table = entries * (usage === DIB_PAL_COLORS ? 2 : core ? 3 : 4);
        const stride = ((Math.abs(width) * bitCount + 31) >> 5) * 4;
        const rows = lines ?? Math.abs(height);
        const rle = compression === 1 || compression === 2;
        return { info: (size + masks + table + 3) & ~3, bits: rle ? sizeImage : stride * rows };
    };

    /**
     * A record that carries a DIB: the fixed fields, then the BITMAPINFO,
     * then the bits, each found by an offset and a size the caller places.
     *
     * @param {number} type @param {number} head  Where the BITMAPINFO goes.
     * @param {Uint8Array} info @param {Uint8Array} bits
     */
    const dibRecord = (type, head, info, bits)=>{
        const record = emfRecord(type, head + info.length + bits.length);
        record.bytes.set(info, head);
        record.bytes.set(bits, head + info.length);
        return record;
    };

    /**
     * A device context's pixels in a rectangle as a top-down 32-bit DIB, read
     * through GetPixel: what BitBlt and StretchBlt record of their source.
     *
     * @param {number} source @param {number} x @param {number} y
     * @param {number} width @param {number} height
     */
    const pictureOf = (source, x, y, width, height)=>{
        const w = Math.abs(width);
        const h = Math.abs(height);
        const info = new Uint8Array(40);
        const view = viewOf(info);
        view.setUint32(0, 40, true);
        view.setInt32(4, w, true);
        view.setInt32(8, -h, true);
        view.setUint16(12, 1, true);
        view.setUint16(14, 32, true);
        view.setUint32(20, w * h * 4, true);
        const bits = new Uint8Array(w * h * 4);
        const pixels = viewOf(bits);
        const left = Math.min(x, x + width);
        const top = Math.min(y, y + height);
        for (let row = 0; row < h; row++)
        {
            for (let column = 0; column < w; column++)
            {
                const color = call('GetPixel', [source, left + column, top + row]) >>> 0;
                const pixel = color === GDI_ERROR ? 0
                    : ((color & 0xff) << 16 | (color & 0xff00) | (color >>> 16) & 0xff);
                pixels.setUint32((row * w + column) * 4, pixel, true);
            }
        }
        return { info, bits };
    };

    /**
     * Text as ExtTextOutW records it, whichever call drew it.
     *
     * @param {any} dc @param {number} x @param {number} y @param {number} options
     * @param {any} rect  A RECT's four fields, or null.
     * @param {string} text @param {number[] | null} advances
     */
    const putText = (dc, x, y, options, rect, text, advances)=>{
        const extent = textExtent(dc, text);
        const bounds = include(dc, [{ x, y }, { x: x + extent.cx, y: y + extent.cy }]);
        const stringAt = 76;
        const stringBytes = (text.length * 2 + 3) & ~3;
        const dxAt = advances ? stringAt + stringBytes : 0;
        const record = emfRecord(EMR.EXTTEXTOUTW, stringAt + stringBytes
            + (advances ? text.length * 4 : 0));
        const { view } = record;
        rectFields(bounds).forEach((value, index)=>view.setInt32(8 + index * 4, value, true));
        view.setUint32(24, GM_COMPATIBLE, true);
        view.setInt32(36, x, true);
        view.setInt32(40, y, true);
        view.setUint32(44, text.length, true);
        view.setUint32(48, stringAt, true);
        view.setUint32(52, options, true);
        rectFields(rect ?? { left: 0, top: 0, right: -1, bottom: -1 }).forEach((value, index)=>
            view.setInt32(56 + index * 4, value, true));
        view.setUint32(72, dxAt, true);
        for (let index = 0; index < text.length; index++)
        {
            view.setUint16(stringAt + index * 2, text.charCodeAt(index), true);
        }
        advances?.forEach((advance, index)=>view.setInt32(dxAt + index * 4, advance, true));
        dc.recorder.records.push(record.bytes);
    };

    /**
     * ExtTextOut's arguments as text, read once for the record.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const textOf = ([, , , , , string, count, dx], wide)=>{
        const length = count >>> 0;
        const bytes = (string >>> 0) === 0 || length === 0 ? new Uint8Array(0)
            : host.readMemory(string >>> 0, wide ? length * 2 : length);
        const text = wide
            ? String.fromCharCode(...Array.from({ length: Math.floor(bytes.length / 2) },
                (_, index)=>bytes[index * 2] | bytes[index * 2 + 1] << 8))
            : decodeAnsi(bytes);
        const advances = (dx >>> 0) === 0 || length === 0 ? null
            : Array.from({ length }, (_, index)=>viewOf(host.readMemory((dx >>> 0) + index * 4,
                4)).getInt32(0, true));
        return { text, advances };
    };

    /** @param {number} address */
    const rectAt = address=>{
        const view = viewOf(host.readMemory(address >>> 0, 16));
        return { left: view.getInt32(0, true), top: view.getInt32(4, true),
            right: view.getInt32(8, true), bottom: view.getInt32(12, true) };
    };

    /** @param {number} type */
    const simple = type=>(/** @type {any} */ dc, /** @type {number[]} */ args)=>
        put(dc, type, args.slice(1, 2));
    /** @param {number} type */
    const pair = type=>(/** @type {any} */ dc, /** @type {number[]} */ args)=>
        put(dc, type, args.slice(1, 3));
    /** @param {number} type */
    const box = type=>(/** @type {any} */ dc, /** @type {number[]} */ [, l, t, r, b, ...rest])=>{
        include(dc, boxCorners(l | 0, t | 0, r | 0, b | 0));
        put(dc, type, [l, t, r, b, ...rest]);
    };
    /** @param {number} wide @param {number} narrow */
    const poly = (wide, narrow)=>(/** @type {any} */ dc, /** @type {number[]} */ args)=>{
        const [, points, count] = args;
        if ((points >>> 0) !== 0 && (count | 0) > 0)
        {
            putPoints(dc, wide, narrow, pointsAt(points, count | 0));
        }
    };
    /** @param {number} wide @param {number} narrow */
    const polyPoly = (wide, narrow)=>(/** @type {any} */ dc, /** @type {number[]} */ args)=>{
        const [, points, counts, many] = args;
        if ((points >>> 0) === 0 || (counts >>> 0) === 0 || (many >>> 0) === 0
            || (many >>> 0) > 0x10000)
        {
            return;
        }
        const sizes = Array.from(new Uint32Array(host.readMemory(counts >>> 0, (many >>> 0) * 4)
            .slice().buffer));
        putPoints(dc, wide, narrow, pointsAt(points, sizes.reduce((sum, size)=>sum + size, 0)),
            sizes);
    };
    /** @param {number} type */
    const bare = type=>(/** @type {any} */ dc)=>put(dc, type, []);
    /** @param {number} type */
    const pathDrawn = type=>(/** @type {any} */ dc)=>{
        put(dc, type, BOUNDED.has(type) ? [0, 0, -1, -1] : []);
    };

    /** @param {number} type  A record whose fields are Arc's: the box, then the radials. */
    const arcLike = type=>(/** @type {any} */ dc, /** @type {number[]} */ args)=>{
        const [, l, t, r, b] = args;
        include(dc, boxCorners(l | 0, t | 0, r | 0, b | 0));
        put(dc, type, args.slice(1, 9));
    };

    /** @type {Record<string, (dc: any, args: number[]) => void>} */
    const hooks = {
        SetTextColor: simple(EMR.SETTEXTCOLOR),
        SetBkColor: simple(EMR.SETBKCOLOR),
        SetBkMode: simple(EMR.SETBKMODE),
        SetPolyFillMode: simple(EMR.SETPOLYFILLMODE),
        SetROP2: simple(EMR.SETROP2),
        SetStretchBltMode: simple(EMR.SETSTRETCHBLTMODE),
        SetTextAlign: simple(EMR.SETTEXTALIGN),
        SetMapperFlags: simple(EMR.SETMAPPERFLAGS),
        SetMapMode: simple(EMR.SETMAPMODE),
        SetArcDirection: simple(EMR.SETARCDIRECTION),
        SetLayout: simple(EMR.SETLAYOUT),
        SetMiterLimit: simple(EMR.SETMITERLIMIT),
        RestoreDC: simple(EMR.RESTOREDC),
        SelectClipPath: simple(EMR.SELECTCLIPPATH),
        SetWindowExtEx: pair(EMR.SETWINDOWEXTEX),
        SetWindowOrgEx: pair(EMR.SETWINDOWORGEX),
        SetViewportExtEx: pair(EMR.SETVIEWPORTEXTEX),
        SetViewportOrgEx: pair(EMR.SETVIEWPORTORGEX),
        SetBrushOrgEx: pair(EMR.SETBRUSHORGEX),
        MoveToEx: pair(EMR.MOVETOEX),
        OffsetClipRgn: pair(EMR.OFFSETCLIPRGN),
        // There is no record for moving an origin by an amount: Windows
        // records where it ends up.
        OffsetWindowOrgEx: (dc, [, x, y])=>put(dc, EMR.SETWINDOWORGEX,
            [(dc.windowOrg.x | 0) + (x | 0), (dc.windowOrg.y | 0) + (y | 0)]),
        OffsetViewportOrgEx: (dc, [, x, y])=>put(dc, EMR.SETVIEWPORTORGEX,
            [(dc.viewportOrg.x | 0) + (x | 0), (dc.viewportOrg.y | 0) + (y | 0)]),
        ScaleViewportExtEx: (dc, args)=>put(dc, EMR.SCALEVIEWPORTEXTEX, args.slice(1, 5)),
        ScaleWindowExtEx: (dc, args)=>put(dc, EMR.SCALEWINDOWEXTEX, args.slice(1, 5)),
        SetWorldTransform: (dc, [, xform])=>{
            if ((xform >>> 0) !== 0)
            {
                put(dc, EMR.SETWORLDTRANSFORM, Array.from(new Uint32Array(
                    host.readMemory(xform >>> 0, 24).slice().buffer)));
            }
        },
        ModifyWorldTransform: (dc, [, xform, mode])=>put(dc, EMR.MODIFYWORLDTRANSFORM, [
            ...((xform >>> 0) === 0 ? new Array(6).fill(0)
                : Array.from(new Uint32Array(host.readMemory(xform >>> 0, 24).slice().buffer))),
            mode]),
        SaveDC: bare(EMR.SAVEDC),
        BeginPath: bare(EMR.BEGINPATH),
        EndPath: bare(EMR.ENDPATH),
        CloseFigure: bare(EMR.CLOSEFIGURE),
        FlattenPath: bare(EMR.FLATTENPATH),
        WidenPath: bare(EMR.WIDENPATH),
        AbortPath: bare(EMR.ABORTPATH),
        RealizePalette: bare(EMR.REALIZEPALETTE),
        FillPath: pathDrawn(EMR.FILLPATH),
        StrokePath: pathDrawn(EMR.STROKEPATH),
        StrokeAndFillPath: pathDrawn(EMR.STROKEANDFILLPATH),
        IntersectClipRect: box(EMR.INTERSECTCLIPRECT),
        ExcludeClipRect: box(EMR.EXCLUDECLIPRECT),
        Rectangle: box(EMR.RECTANGLE),
        Ellipse: box(EMR.ELLIPSE),
        RoundRect: box(EMR.ROUNDRECT),
        Arc: arcLike(EMR.ARC),
        ArcTo: arcLike(EMR.ARCTO),
        Chord: arcLike(EMR.CHORD),
        Pie: arcLike(EMR.PIE),
        AngleArc: (dc, [, x, y, radius, start, sweep])=>{
            include(dc, [{ x: (x | 0) - (radius | 0), y: (y | 0) - (radius | 0) },
                { x: (x | 0) + (radius | 0), y: (y | 0) + (radius | 0) }]);
            put(dc, EMR.ANGLEARC, [x, y, radius, start, sweep]);
        },
        LineTo: (dc, [, x, y])=>{
            include(dc, [dc.position, { x: x | 0, y: y | 0 }]);
            put(dc, EMR.LINETO, [x, y]);
        },
        SetPixel: (dc, [, x, y, color])=>{
            include(dc, [{ x: x | 0, y: y | 0 }]);
            put(dc, EMR.SETPIXELV, [x, y, color]);
        },
        SetPixelV: (dc, [, x, y, color])=>{
            include(dc, [{ x: x | 0, y: y | 0 }]);
            put(dc, EMR.SETPIXELV, [x, y, color]);
        },
        ExtFloodFill: (dc, [, x, y, color, type])=>put(dc, EMR.EXTFLOODFILL, [x, y, color, type]),
        FloodFill: (dc, [, x, y, color])=>put(dc, EMR.EXTFLOODFILL,
            [x, y, color, FLOODFILLBORDER]),
        Polygon: poly(EMR.POLYGON, EMR.POLYGON16),
        Polyline: poly(EMR.POLYLINE, EMR.POLYLINE16),
        PolyBezier: poly(EMR.POLYBEZIER, EMR.POLYBEZIER16),
        PolyBezierTo: poly(EMR.POLYBEZIERTO, EMR.POLYBEZIERTO16),
        PolylineTo: poly(EMR.POLYLINETO, EMR.POLYLINETO16),
        PolyPolygon: polyPoly(EMR.POLYPOLYGON, EMR.POLYPOLYGON16),
        PolyPolyline: polyPoly(EMR.POLYPOLYLINE, EMR.POLYPOLYLINE16),
        PolyDraw: (dc, [, points, types, count])=>{
            if ((points >>> 0) !== 0 && (types >>> 0) !== 0 && (count | 0) > 0)
            {
                putPoints(dc, EMR.POLYDRAW, EMR.POLYDRAW16, pointsAt(points, count | 0),
                    undefined, host.readMemory(types >>> 0, count | 0));
            }
        },
        SelectObject: (dc, [, handle])=>{
            // A region selected is the clip: SelectClipRgn's record.
            if (objects.get(handle)?.type === 'region')
            {
                hooks.ExtSelectClipRgn(dc, [0, handle, RGN_COPY]);
                return;
            }
            const index = indexOf(dc, handle);
            if (index !== null)
            {
                put(dc, EMR.SELECTOBJECT, [index]);
            }
        },
        SelectPalette: (dc, [, handle])=>{
            const index = indexOf(dc, handle);
            if (index !== null)
            {
                put(dc, EMR.SELECTPALETTE, [index]);
            }
        },
        SelectClipRgn: (dc, [, region])=>{
            if ((region >>> 0) === 0)
            {
                const record = emfRecord(EMR.EXTSELECTCLIPRGN, 16);
                record.view.setUint32(12, RGN_COPY, true);
                dc.recorder.records.push(record.bytes);
                return;
            }
            hooks.ExtSelectClipRgn(dc, [0, region, RGN_COPY]);
        },
        ExtSelectClipRgn: (dc, [, region, mode])=>{
            const data = (region >>> 0) === 0 ? new Uint8Array(0) : regionData(region);
            if (!data)
            {
                return;
            }
            const record = emfRecord(EMR.EXTSELECTCLIPRGN, 16 + data.length);
            record.view.setUint32(8, data.length, true);
            record.view.setUint32(12, mode, true);
            record.bytes.set(data, 16);
            dc.recorder.records.push(record.bytes);
        },
        FillRgn: (dc, [, region, brush])=>{
            const index = indexOf(dc, brush);
            if (index !== null)
            {
                putRegion(dc, EMR.FILLRGN, region, [index]);
            }
        },
        FrameRgn: (dc, [, region, brush, width, height])=>{
            const index = indexOf(dc, brush);
            if (index !== null)
            {
                putRegion(dc, EMR.FRAMERGN, region, [index, width, height]);
            }
        },
        PaintRgn: (dc, [, region])=>putRegion(dc, EMR.PAINTRGN, region, []),
        InvertRgn: (dc, [, region])=>putRegion(dc, EMR.INVERTRGN, region, []),
        GdiComment: (dc, [, size, data])=>{
            const bytes = (size >>> 0) === 0 ? new Uint8Array(0)
                : host.readMemory(data >>> 0, size >>> 0);
            const record = emfRecord(EMR.GDICOMMENT, 12 + bytes.length);
            record.view.setUint32(8, bytes.length, true);
            record.bytes.set(bytes, 12);
            dc.recorder.records.push(record.bytes);
        },
        TextOutA: (dc, [, x, y, string, count])=>{
            const { text } = textOf([0, 0, 0, 0, 0, string, count, 0], false);
            putText(dc, x | 0, y | 0, 0, null, text, null);
        },
        TextOutW: (dc, [, x, y, string, count])=>{
            const { text } = textOf([0, 0, 0, 0, 0, string, count, 0], true);
            putText(dc, x | 0, y | 0, 0, null, text, null);
        },
        ExtTextOutA: (dc, args)=>{
            const { text, advances } = textOf(args, false);
            putText(dc, args[1] | 0, args[2] | 0, args[3] >>> 0,
                (args[4] >>> 0) === 0 ? null : rectAt(args[4]), text, advances);
        },
        ExtTextOutW: (dc, args)=>{
            const { text, advances } = textOf(args, true);
            putText(dc, args[1] | 0, args[2] | 0, args[3] >>> 0,
                (args[4] >>> 0) === 0 ? null : rectAt(args[4]), text, advances);
        },
        PatBlt: (dc, [, x, y, width, height, rop])=>{
            const bounds = include(dc, [{ x: x | 0, y: y | 0 },
                { x: (x | 0) + (width | 0) - 1, y: (y | 0) + (height | 0) - 1 }]);
            const record = emfRecord(EMR.BITBLT, 100);
            rectFields(bounds).forEach((value, index)=>record.view.setInt32(8 + index * 4, value,
                true));
            [x, y, width, height, rop].forEach((value, index)=>
                record.view.setUint32(24 + index * 4, value >>> 0, true));
            IDENTITY.forEach((value, index)=>record.view.setFloat32(52 + index * 4, value, true));
            dc.recorder.records.push(record.bytes);
        },
        BitBlt: (dc, [, x, y, width, height, source, xSrc, ySrc, rop])=>{
            if ((source >>> 0) === 0 || !dcOf(source))
            {
                hooks.PatBlt(dc, [0, x, y, width, height, rop]);
                return;
            }
            putBlit(dc, EMR.BITBLT, [x | 0, y | 0, width | 0, height | 0], source,
                [xSrc | 0, ySrc | 0, width | 0, height | 0], rop);
        },
        StretchBlt: (dc, [, x, y, width, height, source, xSrc, ySrc, wSrc, hSrc, rop])=>{
            if ((source >>> 0) === 0 || !dcOf(source))
            {
                hooks.PatBlt(dc, [0, x, y, width, height, rop]);
                return;
            }
            putBlit(dc, EMR.STRETCHBLT, [x | 0, y | 0, width | 0, height | 0], source,
                [xSrc | 0, ySrc | 0, wSrc | 0, hSrc | 0], rop);
        },
        StretchDIBits: (dc, [, xd, yd, wd, hd, xs, ys, ws, hs, bits, info, usage, rop])=>{
            if ((info >>> 0) === 0)
            {
                return;
            }
            const sizes = dibSizes(host.readMemory(info >>> 0, 40), usage >>> 0);
            const record = dibRecord(EMR.STRETCHDIBITS, 80, host.readMemory(info >>> 0,
                sizes.info), (bits >>> 0) === 0 ? new Uint8Array(0)
                : host.readMemory(bits >>> 0, sizes.bits));
            const bounds = include(dc, [{ x: xd | 0, y: yd | 0 },
                { x: (xd | 0) + (wd | 0) - 1, y: (yd | 0) + (hd | 0) - 1 }]);
            const { view } = record;
            rectFields(bounds).forEach((value, index)=>view.setInt32(8 + index * 4, value, true));
            [xd, yd, xs, ys, ws, hs, 80, sizes.info, 80 + sizes.info, sizes.bits, usage, rop, wd,
                hd].forEach((value, index)=>view.setUint32(24 + index * 4, value >>> 0, true));
            dc.recorder.records.push(record.bytes);
        },
        SetDIBitsToDevice: (dc, [, xd, yd, w, h, xs, ys, start, lines, bits, info, usage])=>{
            if ((info >>> 0) === 0)
            {
                return;
            }
            const sizes = dibSizes(host.readMemory(info >>> 0, 40), usage >>> 0, lines >>> 0);
            const record = dibRecord(EMR.SETDIBITSTODEVICE, 76, host.readMemory(info >>> 0,
                sizes.info), (bits >>> 0) === 0 ? new Uint8Array(0)
                : host.readMemory(bits >>> 0, sizes.bits));
            const bounds = include(dc, [{ x: xd | 0, y: yd | 0 },
                { x: (xd | 0) + (w | 0) - 1, y: (yd | 0) + (h | 0) - 1 }]);
            const { view } = record;
            rectFields(bounds).forEach((value, index)=>view.setInt32(8 + index * 4, value, true));
            [xd, yd, xs, ys, w, h, 76, sizes.info, 76 + sizes.info, sizes.bits, usage, start,
                lines].forEach((value, index)=>view.setUint32(24 + index * 4, value >>> 0, true));
            dc.recorder.records.push(record.bytes);
        },
    };

    for (const name of UNRECORDED)
    {
        hooks[name] = ()=>diverge(name, 'drawn on an enhanced metafile DC, it is not recorded');
    }

    /**
     * BitBlt's and StretchBlt's record: the destination, the operation, and
     * the source's pixels in its rectangle as a DIB of their own, which the
     * record's source position is then the corner of.
     *
     * @param {any} dc @param {number} type @param {number[]} dest  x, y, width, height.
     * @param {number} source @param {number[]} from  x, y, width, height in the source.
     * @param {number} rop
     */
    const putBlit = (dc, type, dest, source, from, rop)=>{
        const { info, bits } = pictureOf(source, from[0], from[1], from[2], from[3]);
        const head = type === EMR.STRETCHBLT ? 108 : 100;
        const record = dibRecord(type, head, info, bits);
        const { view } = record;
        const bounds = include(dc, [{ x: dest[0], y: dest[1] },
            { x: dest[0] + dest[2] - 1, y: dest[1] + dest[3] - 1 }]);
        rectFields(bounds).forEach((value, index)=>view.setInt32(8 + index * 4, value, true));
        [...dest, rop, 0, 0].forEach((value, index)=>view.setUint32(24 + index * 4, value >>> 0,
            true));
        IDENTITY.forEach((value, index)=>view.setFloat32(52 + index * 4, value, true));
        view.setUint32(76, call('GetBkColor', [source]) >>> 0, true);
        [0, head, info.length, head + info.length, bits.length].forEach((value, index)=>
            view.setUint32(80 + index * 4, value, true));
        if (type === EMR.STRETCHBLT)
        {
            view.setInt32(100, Math.abs(from[2]), true);
            view.setInt32(104, Math.abs(from[3]), true);
        }
        dc.recorder.records.push(record.bytes);
    };

    /**
     * Records a call before it runs, when its DC is recording and the call is
     * not one made from inside another on the same DC: PaintRgn fills
     * through FillRgn, and only PaintRgn is the program's.
     *
     * @param {string} name @param {(args: number[]) => any} handler
     * @returns {(args: number[]) => any}
     */
    const wrap = (name, handler)=>args=>{
        const dc = dcOf(args[0]);
        const recorder = dc?.recorder;
        if (!recorder)
        {
            return handler(args);
        }
        if (recorder.depth === 0)
        {
            try
            {
                hooks[name](dc, args);
            }
            catch (e){
                // A record that cannot be read leaves the picture without it;
                // the call itself is the program's, and it still runs.
                diverge(name, `not recorded: ${/** @type {Error} */ (e).message}`);
            }
        }
        recorder.depth++;
        try
        {
            return handler(args);
        }
        finally
        {
            recorder.depth--;
        }
    };

    /**
     * DeleteObject names no DC: an object a recording DC wrote into its
     * table is deleted from it too, and its index is free again.
     *
     * @param {(args: number[]) => any} handler
     * @returns {(args: number[]) => any}
     */
    const wrapDelete = handler=>args=>{
        for (const dc of recording)
        {
            const index = dc.recorder.handles.get(args[0] >>> 0);
            if (index !== undefined)
            {
                put(dc, EMR.DELETEOBJECT, [index]);
                dc.recorder.handles.delete(args[0] >>> 0);
                dc.recorder.free.add(index);
            }
        }
        return handler(args);
    };

    /**
     * What the window manager draws on a DC through the library's drawing
     * interface rather than its entry points -- FillRect, FrameRect,
     * InvertRect, DrawText -- recorded as Windows records the calls those
     * make: a pattern blit with the brush selected for the length of it, and
     * text in the colour and mode it was drawn in.
     */
    const drawn = {
        /**
         * @param {number} hdc @param {{ left: number, top: number, right: number,
         *     bottom: number }} rect @param {number} brush
         * @param {number} [rop]
         */
        fill(hdc, rect, brush, rop = PATCOPY){
            const dc = dcOf(hdc);
            if (!dc?.recorder || dc.recorder.depth > 0)
            {
                return;
            }
            const before = dc.brush;
            hooks.SelectObject(dc, [hdc, brush]);
            hooks.PatBlt(dc, [hdc, rect.left, rect.top, rect.right - rect.left,
                rect.bottom - rect.top, rop]);
            hooks.SelectObject(dc, [hdc, before]);
        },
        /**
         * @param {number} hdc @param {{ left: number, top: number, right: number,
         *     bottom: number }} rect @param {number} brush
         */
        frame(hdc, rect, brush){
            for (const edge of [{ ...rect, bottom: rect.top + 1 },
                { ...rect, top: rect.bottom - 1 }, { ...rect, right: rect.left + 1 },
                { ...rect, left: rect.right - 1 }])
            {
                drawn.fill(hdc, edge, brush);
            }
        },
        /**
         * @param {number} hdc @param {{ left: number, top: number, right: number,
         *     bottom: number }} rect
         */
        invert(hdc, rect){
            const dc = dcOf(hdc);
            if (dc?.recorder && dc.recorder.depth === 0)
            {
                hooks.PatBlt(dc, [hdc, rect.left, rect.top, rect.right - rect.left,
                    rect.bottom - rect.top, DSTINVERT]);
            }
        },
        /**
         * @param {number} hdc @param {number} x @param {number} y @param {string} text
         * @param {{ color?: number, clip?: any, transparent?: boolean }} options
         */
        text(hdc, x, y, text, options){
            const dc = dcOf(hdc);
            if (!dc?.recorder || dc.recorder.depth > 0)
            {
                return;
            }
            const color = (options.color ?? dc.textColor) >>> 0;
            const mode = options.transparent === false ? dc.bkMode : TRANSPARENT;
            put(dc, EMR.SETTEXTCOLOR, [color]);
            put(dc, EMR.SETBKMODE, [mode]);
            put(dc, EMR.SETTEXTALIGN, [0]);
            putText(dc, x | 0, y | 0, options.clip ? ETO_CLIPPED : 0, options.clip ?? null, text,
                null);
            put(dc, EMR.SETTEXTCOLOR, [dc.textColor]);
            put(dc, EMR.SETBKMODE, [dc.bkMode]);
            put(dc, EMR.SETTEXTALIGN, [dc.textAlign]);
        },
    };

    /**
     * The library's entry points, each that records wrapped in place.
     *
     * @param {Record<string, { handler: (args: number[]) => any }>} table
     */
    const install = table=>{
        for (const name of Object.keys(hooks))
        {
            const entry = table[name];
            if (entry)
            {
                entry.handler = wrap(name, entry.handler);
            }
        }
        if (table.DeleteObject)
        {
            table.DeleteObject.handler = wrapDelete(table.DeleteObject.handler);
        }
    };

    // --- playing an EMF ---

    /**
     * Plays an EMF's records on a DC, the picture fitted to `rect`, a
     * rectangle in the DC's logical units: see the header.
     *
     * @param {number} handle @param {Uint8Array} bits @param {any} rect
     * @returns {number} TRUE, or FALSE for a DC there is not
     */
    const playEmf = (handle, bits, rect)=>{
        const dc = dcOf(handle);
        if (!dc)
        {
            return refuse(ERROR_INVALID_HANDLE);
        }
        if (!host.surfaces)
        {
            diverge('PlayEnhMetaFile', 'no guest memory to play a record from');
            return 0;
        }
        const header = readEmfHeader(bits);
        const view = viewOf(bits);
        const frame = header.frame;
        const pixels = {
            left: frame.left * header.device.cx / (header.millimeters.cx * 100 || 1),
            top: frame.top * header.device.cy / (header.millimeters.cy * 100 || 1),
            right: frame.right * header.device.cx / (header.millimeters.cx * 100 || 1),
            bottom: frame.bottom * header.device.cy / (header.millimeters.cy * 100 || 1),
        };
        const across = pixels.right - pixels.left;
        const down = pixels.bottom - pixels.top;
        const sx = across === 0 ? 1 : (rect.right - rect.left) / across;
        const sy = down === 0 ? 1 : (rect.bottom - rect.top) / down;
        /** The reference device's pixels to the rectangle. */
        const fit = [sx, 0, 0, sy, rect.left - pixels.left * sx, rect.top - pixels.top * sy];
        const page = createPage(header.device, header.millimeters);
        const world = dc.world ?? null;
        const mode = dc.graphicsMode;
        const level = call('SaveDC', [handle]);
        const startClip = call('CreateRectRgn', [0, 0, 0, 0]);
        const clipped = call('GetClipRgn', [handle, startClip]) === 1;
        /** @type {number[]} */
        const made = new Array(Math.max(1, header.handles)).fill(0);
        let depth = 0;
        // A logical point of the metafile goes through its own page to the
        // reference device, through the fit to the DC's logical space, and
        // through the DC's own world transform after that.
        const follow = ()=>{
            dc.world = compose(compose(page.transform(), fit), world ?? IDENTITY);
            dc.graphicsMode = GM_ADVANCED;
        };
        /** A point in the reference device's pixels to the DC's device. @param {any} point */
        const referenceToDevice = point=>{
            const kept = dc.world;
            dc.world = compose(fit, world ?? IDENTITY);
            try
            {
                return transform(dc, point, true);
            }
            finally
            {
                dc.world = kept;
            }
        };
        follow();
        try
        {
            borrowed(bits.length, base=>{
                host.writeMemory(base, bits);
                for (const record of emfRecords(bits))
                {
                    if (page.take(record.type, view, record.offset))
                    {
                        follow();
                        if (record.type === EMR.SAVEDC)
                        {
                            call('SaveDC', [handle]);
                            depth++;
                        }
                        else if (record.type === EMR.RESTOREDC)
                        {
                            const back = view.getInt32(record.offset + 8, true);
                            if (back < 0 && depth + back >= 0)
                            {
                                call('RestoreDC', [handle, back]);
                                depth += back;
                            }
                        }
                        continue;
                    }
                    playRecord({ handle, dc, bits, view, base, record, made, referenceToDevice,
                        startClip: clipped ? startClip : 0 });
                }
            });
        }
        finally
        {
            call('RestoreDC', [handle, level]);
            dc.world = world;
            dc.graphicsMode = mode;
            for (const object of [...made, startClip])
            {
                if (object)
                {
                    call('DeleteObject', [object]);
                }
            }
        }
        return 1;
    };

    /**
     * @typedef {Object} Playing
     * @property {number} handle @property {any} dc
     * @property {Uint8Array} bits @property {DataView} view
     * @property {number} base  Where the EMF's copy starts in guest memory.
     * @property {{ type: number, offset: number, size: number }} record
     * @property {number[]} made  The metafile's handle table.
     * @property {(point: { x: number, y: number }) => { x: number, y: number }} referenceToDevice
     * @property {number} startClip  The DC's own clip when the play began, or zero.
     */

    /**
     * Plays one record: the call it records, its pointers into the copy.
     *
     * @param {Playing} playing
     */
    const playRecord = playing=>{
        const { handle, view, base, record, made } = playing;
        const at = record.offset;
        const address = base + at;
        /** @param {number} delta */
        const u32 = delta=>view.getUint32(at + delta, true);
        /** @param {number} delta */
        const i32 = delta=>view.getInt32(at + delta, true);
        /** @param {number} index */
        const objectAt = index=>((index & STOCK) !== 0
            ? call('GetStockObject', [index & 0x7fffffff]) : made[index] ?? 0);
        /** @param {number} index @param {number} object */
        const keep = (index, object)=>{
            if (index > 0 && index < made.length)
            {
                if (made[index])
                {
                    call('DeleteObject', [made[index]]);
                }
                made[index] = object;
            }
        };
        /**
         * POINTS from the copy as POINTLs in guest memory, for a call that reads POINTLs.
         *
         * @param {number} from @param {number} count
         * @param {(points: number) => void} use
         */
        const widened = (from, count, use)=>borrowed(count * 8, points=>{
            const list = pointsIn(view, at + from, count, true);
            const bytes = new Uint8Array(count * 8);
            const out = viewOf(bytes);
            list.forEach((point, index)=>{
                out.setInt32(index * 8, point.x, true);
                out.setInt32(index * 8 + 4, point.y, true);
            });
            host.writeMemory(points, bytes);
            use(points);
        });
        const [x, y] = [i32(8), i32(12)];
        switch (record.type){
            case EMR.SETTEXTCOLOR: call('SetTextColor', [handle, u32(8)]); break;
            case EMR.SETBKCOLOR: call('SetBkColor', [handle, u32(8)]); break;
            case EMR.SETBKMODE: call('SetBkMode', [handle, u32(8)]); break;
            case EMR.SETPOLYFILLMODE: call('SetPolyFillMode', [handle, u32(8)]); break;
            case EMR.SETROP2: call('SetROP2', [handle, u32(8)]); break;
            case EMR.SETSTRETCHBLTMODE: call('SetStretchBltMode', [handle, u32(8)]); break;
            case EMR.SETTEXTALIGN: call('SetTextAlign', [handle, u32(8)]); break;
            case EMR.SETMAPPERFLAGS: call('SetMapperFlags', [handle, u32(8)]); break;
            case EMR.SETARCDIRECTION: call('SetArcDirection', [handle, u32(8)]); break;
            case EMR.SETLAYOUT: call('SetLayout', [handle, u32(8)]); break;
            case EMR.SETMITERLIMIT: call('SetMiterLimit', [handle, u32(8), 0]); break;
            case EMR.SETBRUSHORGEX: call('SetBrushOrgEx', [handle, x, y, 0]); break;
            case EMR.MOVETOEX: call('MoveToEx', [handle, x, y, 0]); break;
            case EMR.LINETO: call('LineTo', [handle, x, y]); break;
            case EMR.SETPIXELV: call('SetPixelV', [handle, x, y, u32(16)]); break;
            case EMR.EXTFLOODFILL: call('ExtFloodFill', [handle, x, y, u32(16), u32(20)]); break;
            case EMR.RECTANGLE: call('Rectangle', [handle, x, y, i32(16), i32(20)]); break;
            case EMR.ELLIPSE: call('Ellipse', [handle, x, y, i32(16), i32(20)]); break;
            case EMR.ROUNDRECT:
                call('RoundRect', [handle, x, y, i32(16), i32(20), i32(24), i32(28)]);
                break;
            case EMR.ARC: case EMR.ARCTO: case EMR.CHORD: case EMR.PIE:
                call(({ [EMR.ARC]: 'Arc', [EMR.ARCTO]: 'ArcTo', [EMR.CHORD]: 'Chord',
                    [EMR.PIE]: 'Pie' })[record.type], [handle, x, y, i32(16), i32(20), i32(24),
                    i32(28), i32(32), i32(36)]);
                break;
            case EMR.ANGLEARC:
                call('AngleArc', [handle, x, y, u32(16), u32(20), u32(24)]);
                break;
            case EMR.INTERSECTCLIPRECT:
                call('IntersectClipRect', [handle, x, y, i32(16), i32(20)]);
                break;
            case EMR.EXCLUDECLIPRECT:
                call('ExcludeClipRect', [handle, x, y, i32(16), i32(20)]);
                break;
            case EMR.OFFSETCLIPRGN:
            {
                // The offset is logical; the clip is the device's.
                const origin = transform(playing.dc, { x: 0, y: 0 }, true);
                const moved = transform(playing.dc, { x, y }, true);
                call('OffsetClipRgn', [handle, moved.x - origin.x, moved.y - origin.y]);
                break;
            }
            case EMR.POLYGON: case EMR.POLYLINE: case EMR.POLYBEZIER: case EMR.POLYBEZIERTO:
            case EMR.POLYLINETO:
                call(polyName(record.type), [handle, address + 28, u32(24)]);
                break;
            case EMR.POLYGON16: case EMR.POLYLINE16: case EMR.POLYBEZIER16:
            case EMR.POLYBEZIERTO16: case EMR.POLYLINETO16:
                widened(28, u32(24), points=>call(polyName(record.type), [handle, points,
                    u32(24)]));
                break;
            case EMR.POLYPOLYGON: case EMR.POLYPOLYLINE:
                call(record.type === EMR.POLYPOLYGON ? 'PolyPolygon' : 'PolyPolyline',
                    [handle, address + 32 + u32(24) * 4, address + 32, u32(24)]);
                break;
            case EMR.POLYPOLYGON16: case EMR.POLYPOLYLINE16:
                widened(32 + u32(24) * 4, u32(28), points=>call(record.type
                    === EMR.POLYPOLYGON16 ? 'PolyPolygon' : 'PolyPolyline',
                [handle, points, address + 32, u32(24)]));
                break;
            case EMR.POLYDRAW:
                call('PolyDraw', [handle, address + 28, address + 28 + u32(24) * 8, u32(24)]);
                break;
            case EMR.POLYDRAW16:
                widened(28, u32(24), points=>call('PolyDraw', [handle, points,
                    address + 28 + u32(24) * 4, u32(24)]));
                break;
            case EMR.BEGINPATH: call('BeginPath', [handle]); break;
            case EMR.ENDPATH: call('EndPath', [handle]); break;
            case EMR.CLOSEFIGURE: call('CloseFigure', [handle]); break;
            case EMR.FILLPATH: call('FillPath', [handle]); break;
            case EMR.STROKEPATH: call('StrokePath', [handle]); break;
            case EMR.STROKEANDFILLPATH: call('StrokeAndFillPath', [handle]); break;
            case EMR.FLATTENPATH: call('FlattenPath', [handle]); break;
            case EMR.WIDENPATH: call('WidenPath', [handle]); break;
            case EMR.ABORTPATH: call('AbortPath', [handle]); break;
            case EMR.SELECTCLIPPATH: call('SelectClipPath', [handle, u32(8)]); break;
            case EMR.REALIZEPALETTE: call('RealizePalette', [handle]); break;
            case EMR.CREATEPEN: keep(u32(8), call('CreatePenIndirect', [address + 12])); break;
            case EMR.EXTCREATEPEN:
            {
                const count = u32(48);
                keep(u32(8), call('ExtCreatePen', [u32(28), u32(32), address + 36, count,
                    count ? address + 52 : 0]) || call('CreatePen', [u32(28) & PS_STYLE_MASK,
                    u32(32), u32(40)]));
                break;
            }
            case EMR.CREATEBRUSHINDIRECT:
                keep(u32(8), call('CreateBrushIndirect', [address + 12])
                    || call('CreateSolidBrush', [u32(16)]));
                break;
            case EMR.CREATEDIBPATTERNBRUSHPT: case EMR.CREATEMONOBRUSH:
                keep(u32(8), call('CreateDIBPatternBrushPt', [address + u32(16), u32(12)]));
                break;
            case EMR.EXTCREATEFONTINDIRECTW:
                keep(u32(8), call('CreateFontIndirectW', [address + 12]));
                break;
            case EMR.CREATEPALETTE: keep(u32(8), call('CreatePalette', [address + 12])); break;
            case EMR.SELECTOBJECT:
            {
                const object = objectAt(u32(8));
                if (object && objects.get(object)?.type === 'palette')
                {
                    call('SelectPalette', [handle, object, 0]);
                }
                else if (object)
                {
                    call('SelectObject', [handle, object]);
                }
                break;
            }
            case EMR.SELECTPALETTE:
            {
                const object = (u32(8) & STOCK) !== 0
                    ? call('GetStockObject', [DEFAULT_PALETTE]) : made[u32(8)];
                if (object)
                {
                    call('SelectPalette', [handle, object, 0]);
                }
                break;
            }
            case EMR.DELETEOBJECT:
                if (made[u32(8)])
                {
                    call('DeleteObject', [made[u32(8)]]);
                    made[u32(8)] = 0;
                }
                break;
            case EMR.EXTTEXTOUTW: case EMR.EXTTEXTOUTA:
            {
                const options = u32(52);
                call(record.type === EMR.EXTTEXTOUTW ? 'ExtTextOutW' : 'ExtTextOutA', [handle,
                    i32(36), i32(40), options,
                    (options & (ETO_OPAQUE | ETO_CLIPPED)) !== 0 ? address + 56 : 0,
                    address + u32(48), u32(44), u32(72) ? address + u32(72) : 0]);
                break;
            }
            case EMR.STRETCHDIBITS:
                call('StretchDIBits', [handle, i32(24), i32(28), i32(72), i32(76), i32(32), i32(36),
                    i32(40), i32(44), address + u32(56), address + u32(48), u32(64), u32(68)]);
                break;
            case EMR.SETDIBITSTODEVICE:
                call('SetDIBitsToDevice', [handle, i32(24), i32(28), i32(40), i32(44), i32(32),
                    i32(36), u32(68), u32(72), address + u32(56), address + u32(48), u32(64)]);
                break;
            case EMR.BITBLT: case EMR.STRETCHBLT:
                playBlit(playing);
                break;
            case EMR.FILLRGN: case EMR.FRAMERGN: case EMR.PAINTRGN: case EMR.INVERTRGN:
            {
                const dataAt = record.type === EMR.FILLRGN ? 32 : record.type === EMR.FRAMERGN
                    ? 40 : 28;
                const region = call('ExtCreateRegion', [0, u32(24), address + dataAt]);
                if (!region)
                {
                    break;
                }
                if (record.type === EMR.FILLRGN)
                {
                    call('FillRgn', [handle, region, objectAt(u32(28))]);
                }
                else if (record.type === EMR.FRAMERGN)
                {
                    call('FrameRgn', [handle, region, objectAt(u32(28)), i32(32), i32(36)]);
                }
                else
                {
                    call(record.type === EMR.PAINTRGN ? 'PaintRgn' : 'InvertRgn', [handle,
                        region]);
                }
                call('DeleteObject', [region]);
                break;
            }
            case EMR.EXTSELECTCLIPRGN:
                playClip(playing);
                break;
            default:
                break;
        }
    };

    /** @param {number} type */
    const polyName = type=>({
        [EMR.POLYGON]: 'Polygon', [EMR.POLYGON16]: 'Polygon',
        [EMR.POLYLINE]: 'Polyline', [EMR.POLYLINE16]: 'Polyline',
        [EMR.POLYBEZIER]: 'PolyBezier', [EMR.POLYBEZIER16]: 'PolyBezier',
        [EMR.POLYBEZIERTO]: 'PolyBezierTo', [EMR.POLYBEZIERTO16]: 'PolyBezierTo',
        [EMR.POLYLINETO]: 'PolylineTo', [EMR.POLYLINETO16]: 'PolylineTo',
    })[type] ?? 'Polyline';

    /**
     * EMR_BITBLT and EMR_STRETCHBLT: a pattern operation when the record
     * carries no bitmap, and otherwise its bitmap drawn as StretchDIBits
     * draws one. The source position is a corner inside the bitmap when the
     * bitmap reaches that far, and the bitmap's own corner when it is only
     * as large as the rectangle it was taken from.
     *
     * @param {Playing} playing
     */
    const playBlit = playing=>{
        const { handle, view, base, record } = playing;
        const at = record.offset;
        /** @param {number} delta */
        const i32 = delta=>view.getInt32(at + delta, true);
        /** @param {number} delta */
        const u32 = delta=>view.getUint32(at + delta, true);
        const [x, y, width, height, rop] = [i32(24), i32(28), i32(32), i32(36), u32(40)];
        if (u32(88) === 0)
        {
            call('PatBlt', [handle, x, y, width, height, rop]);
            return;
        }
        const stretch = record.type === EMR.STRETCHBLT;
        const srcWidth = stretch ? i32(100) : width;
        const srcHeight = stretch ? i32(104) : height;
        const info = at + u32(84);
        const dibWidth = view.getInt32(info + 4, true);
        const dibHeight = view.getInt32(info + 8, true);
        const rows = Math.abs(dibHeight);
        const fits = i32(44) + Math.abs(srcWidth) <= dibWidth
            && i32(48) + Math.abs(srcHeight) <= rows;
        const xSrc = fits ? i32(44) : 0;
        const top = fits ? i32(48) : 0;
        // StretchDIBits counts a bottom-up bitmap's rows from the bottom.
        const ySrc = dibHeight > 0 ? rows - top - Math.abs(srcHeight) : top;
        call('StretchDIBits', [handle, x, y, width, height, xSrc, ySrc, srcWidth, srcHeight,
            base + at + u32(92), base + info, u32(80), rop]);
    };

    /**
     * EMR_EXTSELECTCLIPRGN: the region is in the recording device's pixels,
     * which go through the fit to the rectangle, and not through the
     * metafile's own page. A copy of a region is never more than the DC's own
     * clip let the picture draw in.
     *
     * @param {Playing} playing
     */
    const playClip = playing=>{
        const { handle, view, record, referenceToDevice, startClip } = playing;
        const at = record.offset;
        const size = view.getUint32(at + 8, true);
        const mode = view.getUint32(at + 12, true);
        if (size < RGNDATAHEADER_SIZE)
        {
            if (mode === RGN_COPY)
            {
                call('SelectClipRgn', [handle, startClip]);
            }
            return;
        }
        const count = Math.min(view.getUint32(at + 24, true),
            Math.floor((size - RGNDATAHEADER_SIZE) / 16));
        const data = new Uint8Array(RGNDATAHEADER_SIZE + count * 16);
        const out = viewOf(data);
        out.setUint32(0, RGNDATAHEADER_SIZE, true);
        out.setUint32(4, 1, true);
        out.setUint32(8, count, true);
        for (let index = 0; index < count; index++)
        {
            const from = at + 16 + RGNDATAHEADER_SIZE + index * 16;
            const a = referenceToDevice({ x: view.getInt32(from, true),
                y: view.getInt32(from + 4, true) });
            const b = referenceToDevice({ x: view.getInt32(from + 8, true),
                y: view.getInt32(from + 12, true) });
            [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
                .forEach((value, field)=>out.setInt32(RGNDATAHEADER_SIZE + index * 16 + field * 4,
                    value, true));
        }
        const region = borrowed(data.length, address=>{
            host.writeMemory(address, data);
            return call('ExtCreateRegion', [0, data.length, address]);
        });
        if (!region)
        {
            return;
        }
        call('ExtSelectClipRgn', [handle, region, mode]);
        if (mode === RGN_COPY && startClip)
        {
            call('ExtSelectClipRgn', [handle, startClip, RGN_AND]);
        }
        call('DeleteObject', [region]);
    };

    // --- playing a WMF ---

    /**
     * Plays a WMF's records on a DC, as PlayMetaFile does: each record the
     * call it records, in the DC's own mapping -- a WMF's window and mapping
     * records set the DC's, which is how a program that set the viewport
     * scales the picture. The objects the metafile made are deleted at the
     * end, and the ones the DC had selected before are selected again.
     *
     * @param {number} handle @param {Uint8Array} bits
     */
    const playWmf = (handle, bits)=>{
        const dc = dcOf(handle);
        if (!dc)
        {
            return refuse(ERROR_INVALID_HANDLE);
        }
        const view = viewOf(bits);
        const before = ['pen', 'brush', 'font'].map(slot=>dc[slot]);
        const palette = dc.palette;
        /** @type {number[]} */
        const slots = [];
        borrowed(bits.length, base=>{
            host.writeMemory(base, bits);
            for (const record of wmfRecords(bits))
            {
                playWmfRecord({ handle, view, base, record, slots });
            }
        });
        for (const object of before)
        {
            call('SelectObject', [handle, object]);
        }
        call('SelectPalette', [handle, palette, 0]);
        for (const object of slots)
        {
            if (object)
            {
                call('DeleteObject', [object]);
            }
        }
        return 1;
    };

    /**
     * Plays one WMF record. Its parameters are words, most of them in the
     * reverse of the order the call takes them: y before x, bottom before top.
     *
     * @param {{ handle: number, view: DataView, base: number,
     *     record: { func: number, offset: number, size: number }, slots: number[] }} playing
     */
    const playWmfRecord = ({ handle, view, base, record, slots })=>{
        const at = record.offset + 6;
        const words = (record.size - 6) >> 1;
        /** @param {number} index */
        const p = index=>(index < words ? view.getInt16(at + index * 2, true) : 0);
        /** @param {number} index */
        const u = index=>(index < words ? view.getUint16(at + index * 2, true) : 0);
        /** @param {number} index */
        const dword = index=>(u(index) | u(index + 1) << 16) >>> 0;
        /** @param {number} object */
        const claim = object=>{
            const free = slots.indexOf(0);
            if (free >= 0)
            {
                slots[free] = object;
            }
            else
            {
                slots.push(object);
            }
        };
        /**
         * Words as DWORDs in guest memory, for a call that reads 32-bit
         * fields: points, a rectangle, a count, advances.
         *
         * @param {number[]} values @param {(address: number) => any} use
         */
        const asDwords = (values, use)=>borrowed(values.length * 4, address=>{
            const bytes = new Uint8Array(values.length * 4);
            const out = viewOf(bytes);
            values.forEach((value, index)=>out.setInt32(index * 4, value, true));
            host.writeMemory(address, bytes);
            return use(address);
        });
        /** @param {number} from @param {number} count */
        const pointWords = (from, count)=>Array.from({ length: count * 2 }, (_, index)=>
            p(from + index));
        /**
         * A bitmap a record carries, drawn as StretchDIBits draws one; its
         * source rows counted from the top, as the record counts them.
         *
         * @param {number} dib  Where it starts in the copy.
         * @param {number[]} fields  x, y, width and height on the DC, then in the bitmap.
         * @param {number} rop
         */
        const playDib = (dib, fields, rop)=>{
            const [x, y, width, height, xSrc, ySrc, srcWidth, srcHeight] = fields;
            const sizes = dibSizes(new Uint8Array(view.buffer, view.byteOffset + dib, 40), 0);
            const rows = view.getInt32(dib + 8, true);
            const fromBottom = rows > 0 ? rows - ySrc - Math.abs(srcHeight) : ySrc;
            call('StretchDIBits', [handle, x, y, width, height, xSrc, fromBottom, srcWidth,
                srcHeight, base + dib + sizes.info, base + dib, 0, rop]);
        };
        switch (record.func){
            case META.SETBKCOLOR: call('SetBkColor', [handle, dword(0)]); break;
            case META.SETTEXTCOLOR: call('SetTextColor', [handle, dword(0)]); break;
            case META.SETBKMODE: call('SetBkMode', [handle, u(0)]); break;
            case META.SETMAPMODE: call('SetMapMode', [handle, u(0)]); break;
            case META.SETROP2: call('SetROP2', [handle, u(0)]); break;
            case META.SETPOLYFILLMODE: call('SetPolyFillMode', [handle, u(0)]); break;
            case META.SETSTRETCHBLTMODE: call('SetStretchBltMode', [handle, u(0)]); break;
            case META.SETTEXTALIGN: call('SetTextAlign', [handle, u(0)]); break;
            case META.SETWINDOWORG: call('SetWindowOrgEx', [handle, p(1), p(0), 0]); break;
            case META.SETWINDOWEXT: call('SetWindowExtEx', [handle, p(1), p(0), 0]); break;
            case META.SETVIEWPORTORG: call('SetViewportOrgEx', [handle, p(1), p(0), 0]); break;
            case META.SETVIEWPORTEXT: call('SetViewportExtEx', [handle, p(1), p(0), 0]); break;
            case META.OFFSETCLIPRGN: call('OffsetClipRgn', [handle, p(1), p(0)]); break;
            case META.SAVEDC: call('SaveDC', [handle]); break;
            case META.RESTOREDC: call('RestoreDC', [handle, p(0)]); break;
            case META.REALIZEPALETTE: call('RealizePalette', [handle]); break;
            case META.MOVETO: call('MoveToEx', [handle, p(1), p(0), 0]); break;
            case META.LINETO: call('LineTo', [handle, p(1), p(0)]); break;
            case META.RECTANGLE: call('Rectangle', [handle, p(3), p(2), p(1), p(0)]); break;
            case META.ELLIPSE: call('Ellipse', [handle, p(3), p(2), p(1), p(0)]); break;
            case META.INTERSECTCLIPRECT:
                call('IntersectClipRect', [handle, p(3), p(2), p(1), p(0)]);
                break;
            case META.EXCLUDECLIPRECT:
                call('ExcludeClipRect', [handle, p(3), p(2), p(1), p(0)]);
                break;
            case META.ROUNDRECT:
                call('RoundRect', [handle, p(5), p(4), p(3), p(2), p(1), p(0)]);
                break;
            case META.ARC: case META.PIE: case META.CHORD:
                call(record.func === META.ARC ? 'Arc' : record.func === META.PIE ? 'Pie' : 'Chord',
                    [handle, p(7), p(6), p(5), p(4), p(3), p(2), p(1), p(0)]);
                break;
            case META.SETPIXEL: call('SetPixelV', [handle, p(3), p(2), dword(0)]); break;
            case META.PATBLT: call('PatBlt', [handle, p(5), p(4), p(3), p(2), dword(0)]); break;
            case META.POLYGON: case META.POLYLINE:
                asDwords(pointWords(1, u(0)), points=>call(record.func === META.POLYGON
                    ? 'Polygon' : 'Polyline', [handle, points, u(0)]));
                break;
            case META.POLYPOLYGON:
            {
                const count = u(0);
                const counts = Array.from({ length: count }, (_, index)=>u(1 + index));
                const total = counts.reduce((sum, value)=>sum + value, 0);
                asDwords([...counts, ...pointWords(1 + count, total)], address=>call('PolyPolygon',
                    [handle, address + count * 4, address, count]));
                break;
            }
            case META.TEXTOUT:
            {
                const count = u(0);
                const after = 1 + ((count + 1) >> 1);
                call('TextOutA', [handle, p(after + 1), p(after), base + at + 2, count]);
                break;
            }
            case META.EXTTEXTOUT:
            {
                const count = u(2);
                const options = u(3);
                const boxed = (options & (ETO_OPAQUE | ETO_CLIPPED)) !== 0;
                const stringAt = boxed ? 8 : 4;
                const dxAt = stringAt + ((count + 1) >> 1);
                const advances = dxAt + count <= words
                    ? Array.from({ length: count }, (_, index)=>p(dxAt + index)) : [];
                asDwords([p(4), p(5), p(6), p(7), ...advances], address=>call('ExtTextOutA',
                    [handle, p(1), p(0), options, boxed ? address : 0, base + at + stringAt * 2,
                        count, advances.length > 0 ? address + 16 : 0]));
                break;
            }
            case META.CREATEPENINDIRECT:
                claim(call('CreatePen', [u(0), p(1), dword(3)]));
                break;
            case META.CREATEBRUSHINDIRECT:
                claim(asDwords([u(0), dword(1), u(3)], brush=>call('CreateBrushIndirect', [brush]))
                    || call('CreateSolidBrush', [dword(1)]));
                break;
            case META.CREATEFONTINDIRECT:
            {
                const font = new Uint8Array(60);
                const out = viewOf(font);
                for (let index = 0; index < 5; index++)
                {
                    out.setInt32(index * 4, p(index), true);
                }
                font.set(new Uint8Array(view.buffer, view.byteOffset + at + 10,
                    Math.min(8 + 32, record.size - 16)), 20);
                font[59] = 0;
                claim(borrowed(font.length, address=>{
                    host.writeMemory(address, font);
                    return call('CreateFontIndirectA', [address]);
                }));
                break;
            }
            case META.DIBCREATEPATTERNBRUSH:
                claim(call('CreateDIBPatternBrushPt', [base + at + 4, u(1)]));
                break;
            case META.CREATEPALETTE:
                claim(call('CreatePalette', [base + at]));
                break;
            case META.SELECTOBJECT: case META.SELECTPALETTE:
            {
                const object = slots[u(0)];
                if (object)
                {
                    const palette = objects.get(object)?.type === 'palette';
                    call(palette ? 'SelectPalette' : 'SelectObject', palette ? [handle, object, 0]
                        : [handle, object]);
                }
                break;
            }
            case META.DELETEOBJECT:
                if (slots[u(0)])
                {
                    call('DeleteObject', [slots[u(0)]]);
                    slots[u(0)] = 0;
                }
                break;
            case META.STRETCHDIB:
            {
                const dib = at + 22;
                const sizes = dibSizes(new Uint8Array(view.buffer, view.byteOffset + dib, 40),
                    u(2));
                call('StretchDIBits', [handle, p(10), p(9), p(8), p(7), p(6), p(5), p(4), p(3),
                    base + dib + sizes.info, base + dib, u(2), dword(0)]);
                break;
            }
            case META.DIBBITBLT:
            {
                // Without a bitmap the record is the pattern operation, its
                // fields one word further on for the reserved one.
                if (words === (record.func >> 8))
                {
                    call('PatBlt', [handle, p(8), p(7), p(6), p(5), dword(0)]);
                    break;
                }
                playDib(at + 16, [p(7), p(6), p(5), p(4), p(3), p(2), p(5), p(4)], dword(0));
                break;
            }
            case META.DIBSTRETCHBLT:
            {
                if (words === (record.func >> 8))
                {
                    call('PatBlt', [handle, p(10), p(9), p(8), p(7), dword(0)]);
                    break;
                }
                playDib(at + 20, [p(9), p(8), p(7), p(6), p(5), p(4), p(3), p(2)], dword(0));
                break;
            }
            default:
                break;
        }
    };

    // --- the entry points ---

    /** @param {number} handle */
    const enhanced = handle=>{
        const record = objects.get(handle);
        return record?.type === 'enhmetafile' ? /** @type {Uint8Array} */ (record.attributes.bits)
            : null;
    };

    /**
     * Copies part of a buffer out to the program, as the Get*Bits calls do:
     * a null buffer asks the size, and a short one takes what fits.
     *
     * @param {Uint8Array} bytes @param {number} room @param {number} out
     */
    const handOut = (bytes, room, out)=>{
        if ((out >>> 0) === 0)
        {
            return bytes.length;
        }
        const copied = bytes.subarray(0, Math.min(bytes.length, room >>> 0));
        host.writeMemory(out >>> 0, copied);
        return copied.length;
    };

    /**
     * CopyEnhMetaFileA and W: a copy in memory, or a file, which this build
     * does not write: refused as a metafile on disk is everywhere here.
     *
     * @param {number[]} args @param {string} api
     */
    const copyEnhMetaFile = ([source, file], api)=>{
        const bits = enhanced(source);
        if (!bits)
        {
            return refuse(ERROR_INVALID_HANDLE);
        }
        if ((file >>> 0) !== 0)
        {
            diverge(api, 'a metafile on disk is not written; refused');
            return refuse(ERROR_NOT_SUPPORTED);
        }
        return objects.create('enhmetafile', { bits: bits.slice() });
    };

    /**
     * An EMF made from a WMF by playing it onto an enhanced metafile DC: the
     * picture's frame and the viewport the WMF's window is mapped to, as
     * SetWinMetaFileBits sets them up -- the size a METAFILEPICT gives for the
     * two modes a program scales, and otherwise the whole screen, the frame
     * then worked out from what was drawn (Wine's test_SetWinMetaFileBits).
     *
     * @param {Uint8Array} wmf @param {number} referenceDc  A DC, or zero for the screen.
     * @param {{ mm: number, xExt: number, yExt: number } | null} picture
     */
    const recordWmf = (wmf, referenceDc, picture)=>{
        const { device, millimeters } = reference();
        const mm = picture?.mm ?? MM_ANISOTROPIC;
        const scalable = mm === MM_ANISOTROPIC || mm === MM_ISOTROPIC;
        const sized = scalable && picture !== null && picture.xExt > 0 && picture.yExt > 0;
        const frame = sized ? [0, 0, picture.xExt, picture.yExt] : null;
        return borrowed(16, frameAt=>{
            if (frame)
            {
                host.writeMemory(frameAt, new Uint8Array(new Int32Array(frame).buffer));
            }
            const hdc = call('CreateEnhMetaFileW', [referenceDc, 0, frame ? frameAt : 0, 0]);
            if (!hdc)
            {
                return 0;
            }
            call('SetMapMode', [hdc, mm]);
            if (scalable)
            {
                const extent = sized
                    ? [Math.round(picture.xExt * device.cx / (millimeters.cx * 100)),
                        Math.round(picture.yExt * device.cy / (millimeters.cy * 100))]
                    : [device.cx, device.cy];
                call('SetViewportExtEx', [hdc, extent[0], extent[1], 0]);
            }
            playWmf(hdc, wmf);
            return call('CloseEnhMetaFile', [hdc]);
        });
    };

    const functions = {
        /**
         * BOOL PlayEnhMetaFile(HDC hdc, HENHMETAFILE hmf, const RECT *lprect)
         *
         * The picture drawn into the rectangle: see the header. No rectangle
         * is ERROR_INVALID_PARAMETER.
         */
        PlayEnhMetaFile: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, metafile, rect])=>{
                const bits = enhanced(metafile);
                if (!bits)
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                if ((rect >>> 0) === 0)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                return playEmf(hdc, bits, rectAt(rect));
            },
        },

        /** HENHMETAFILE CopyEnhMetaFileA(HENHMETAFILE hEnh, LPCSTR lpFileName) */
        CopyEnhMetaFileA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>copyEnhMetaFile(args, 'CopyEnhMetaFileA'),
        },
        /** HENHMETAFILE CopyEnhMetaFileW(HENHMETAFILE hEnh, LPCWSTR lpFileName) */
        CopyEnhMetaFileW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>copyEnhMetaFile(args, 'CopyEnhMetaFileW'),
        },

        /**
         * UINT GetEnhMetaFileBits(HENHMETAFILE hEMF, UINT nSize, LPBYTE lpData)
         *
         * The EMF's bytes; a null buffer asks how many there are, and a short
         * one takes as many as fit. Zero for a handle that is no EMF (Wine's
         * test_enhmetafile_file).
         */
        GetEnhMetaFileBits: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([metafile, size, out])=>{
                const bits = enhanced(metafile);
                return bits ? handOut(bits, size, out) : refuse(ERROR_INVALID_HANDLE);
            },
        },

        /**
         * HENHMETAFILE SetEnhMetaFileBits(UINT nSize, const BYTE *pb)
         *
         * An EMF of the bytes given, nBytes of them, once `emfRefusal` takes
         * them.
         */
        SetEnhMetaFileBits: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, data])=>{
                if ((data >>> 0) === 0 || (size >>> 0) === 0)
                {
                    return refuse(ERROR_INVALID_DATA);
                }
                const bytes = host.readMemory(data >>> 0, Math.min(size >>> 0, 0x10000000));
                const refusal = emfRefusal(bytes);
                if (refusal)
                {
                    return refusal === 'invalid-data' ? refuse(ERROR_INVALID_DATA) : 0;
                }
                return objects.create('enhmetafile',
                    { bits: bytes.slice(0, viewOf(bytes).getUint32(48, true)) });
            },
        },

        /**
         * UINT GetEnhMetaFileHeader(HENHMETAFILE hemf, UINT nSize,
         *                           LPENHMETAHEADER lpEnhMetaHeader)
         *
         * The header record as the EMF holds it; a null buffer asks its size,
         * and a short one takes as much as fits.
         */
        GetEnhMetaFileHeader: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([metafile, size, out])=>{
                const bits = enhanced(metafile);
                if (!bits)
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                return handOut(bits.subarray(0, readEmfHeader(bits).size), size, out);
            },
        },

        /**
         * UINT GetEnhMetaFilePaletteEntries(HENHMETAFILE hemf, UINT nNumEntries,
         *                                   LPPALETTEENTRY lpPaletteEntries)
         *
         * The palette the EMF carries in its last record: how many entries,
         * for a null buffer, and otherwise as many as were asked for. An EMF
         * with none answers zero; a handle that is no EMF, GDI_ERROR.
         */
        GetEnhMetaFilePaletteEntries: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([metafile, count, out])=>{
                const bits = enhanced(metafile);
                if (!bits)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return GDI_ERROR;
                }
                const entries = emfPalette(bits);
                if ((out >>> 0) === 0 || entries.length === 0)
                {
                    return entries.length;
                }
                const copied = entries.slice(0, count >>> 0);
                host.writeMemory(out >>> 0, new Uint8Array(new Uint32Array(copied).buffer));
                return copied.length;
            },
        },

        /**
         * UINT GetWinMetaFileBits(HENHMETAFILE hemf, UINT cbData16, LPBYTE pData16,
         *                         INT iMapMode, HDC hdcRef)
         *
         * The EMF as a WMF in the mapping mode asked for: see `emfToWmf`. A
         * null buffer asks the size; one too small for the whole gets
         * nothing, since half a WMF is no WMF.
         */
        GetWinMetaFileBits: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([metafile, size, out, mapMode])=>{
                const bits = enhanced(metafile);
                if (!bits)
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                if ((mapMode | 0) < MM_TEXT_MODE || (mapMode | 0) > MM_ANISOTROPIC)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const wmf = emfToWmf(bits, mapMode | 0, encodeAnsi);
                if ((out >>> 0) !== 0 && (size >>> 0) < wmf.length)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                return handOut(wmf, size, out);
            },
        },

        /**
         * HENHMETAFILE SetWinMetaFileBits(UINT nSize, const BYTE *lpMeta16Data,
         *                                 HDC hdcRef, const METAFILEPICT *lpMFP)
         *
         * A WMF as an EMF: the EMF it carries when GetWinMetaFileBits made it
         * -- exactly that one, whatever the METAFILEPICT says (Wine's
         * getwinmetafilebits) -- and otherwise a new one recorded from it
         * (`recordWmf`). Bytes that are no WMF are ERROR_INVALID_DATA.
         */
        SetWinMetaFileBits: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([size, data, referenceDc, picture])=>{
                if ((data >>> 0) === 0 || (size >>> 0) === 0)
                {
                    return refuse(ERROR_INVALID_DATA);
                }
                const wmf = host.readMemory(data >>> 0, Math.min(size >>> 0, 0x10000000));
                if (!isWmf(wmf))
                {
                    return refuse(ERROR_INVALID_DATA);
                }
                const inner = embeddedEmf(wmf);
                if (inner && !emfRefusal(inner))
                {
                    return objects.create('enhmetafile', { bits: inner });
                }
                const pict = (picture >>> 0) === 0 ? null : (()=>{
                    const fields = viewOf(host.readMemory(picture >>> 0, 12));
                    return { mm: fields.getInt32(0, true), xExt: fields.getInt32(4, true),
                        yExt: fields.getInt32(8, true) };
                })();
                return recordWmf(wmf, dcOf(referenceDc) ? referenceDc >>> 0 : 0, pict);
            },
        },

        /**
         * UINT GetMetaFileBitsEx(HMETAFILE hMF, UINT cbBuffer, LPVOID lpData)
         *
         * The WMF's bytes; a null buffer asks the size, a short one takes
         * what fits. Zero for a handle that is no WMF (Wine's
         * test_metafile_file).
         */
        GetMetaFileBitsEx: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([metafile, size, out])=>{
                const record = objects.get(metafile);
                if (record?.type !== 'metafile')
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                return handOut(record.attributes.bits ?? blankWmf(), size, out);
            },
        },

        /**
         * BOOL PlayMetaFile(HDC hdc, HMETAFILE hmf)
         *
         * The WMF's records played on the DC: see `playWmf`.
         */
        PlayMetaFile: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, metafile])=>{
                const record = objects.get(metafile);
                if (record?.type !== 'metafile')
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                return playWmf(hdc, record.attributes.bits ?? blankWmf());
            },
        },
    };

    return { functions, install, drawn, startRecording, finishRecording, blankWmf };
}

