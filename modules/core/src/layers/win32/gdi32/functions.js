/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gdi32 surface a drawing program sets up before it draws anything.
 *
 * This is the bookkeeping half: device contexts, the objects selected into
 * them, and the metrics a program asks about while laying its window out.
 * Nothing here touches a pixel -- blitting, filling and text output need a
 * surface to write to, which is the graphics layer's, not this one's. What this
 * half owns is the state that layer will draw from, and it owns it completely:
 * by the time a rectangle is filled, which brush fills it was decided here.
 *
 * The rules that cost programs their sanity are the object-lifetime ones, and
 * they live in `objects.js`. What is left here is translation: a guest
 * structure into attributes, an index into a device metric, a LOGFONT into the
 * numbers a layout loop divides by.
 */

import { createGdiObjects } from './objects.js';
import { createDrawingFunctions } from './drawing.js';
import {
    BITMAPINFOHEADER,
    ddbStride,
    dibStride,
    readBitmapInfoHeader,
    readLogBrush,
    readLogFont,
    readLogFontW,
    readLogPalette,
    readLogPen,
    readU32,
    paletteEntryToPixel,
    writePoint,
    writeSize,
    writeTextMetrics,
    writeTextMetricsW,
    writeU32s,
} from './structs.js';

/** ABC: the three widths of one character, A and C the bearings either side of B. */
const ABC_SIZE = 12;

/** Stock object indices, in the order wingdi.h numbers them. */
const WHITE_BRUSH = 0;
const LTGRAY_BRUSH = 1;
const GRAY_BRUSH = 2;
const DKGRAY_BRUSH = 3;
const BLACK_BRUSH = 4;
const NULL_BRUSH = 5;
const WHITE_PEN = 6;
const BLACK_PEN = 7;
const NULL_PEN = 8;
const SYSTEM_FONT = 13;
const DEVICE_DEFAULT_FONT = 14;
const DEFAULT_PALETTE = 15;
const SYSTEM_FIXED_FONT = 16;
const DEFAULT_GUI_FONT = 17;

/** GetCurrentObject's uObjectType. Only the selectable ones are answered. */
const OBJ_PEN = 1;
const OBJ_BRUSH = 2;
const OBJ_PAL = 5;
const OBJ_FONT = 6;
const OBJ_BITMAP = 7;

/** Brush styles. BS_PATTERN's hatch field is a bitmap handle instead of an index. */
const BS_SOLID = 0;
const BS_NULL = 1;
const BS_HATCHED = 2;
const BS_PATTERN = 3;
const BRUSH_STYLES = new Set([BS_SOLID, BS_NULL, BS_HATCHED, BS_PATTERN]);

/** Pen styles, PS_SOLID through PS_INSIDEFRAME. */
const PS_NULL = 5;
const PS_INSIDEFRAME = 6;

/** Background modes. */
const TRANSPARENT = 1;
const OPAQUE = 2;

/** Binary raster operations: R2_BLACK through R2_WHITE. */
const R2_BLACK = 1;
const R2_COPYPEN = 13;
const R2_WHITE = 16;

/** Mapping modes: MM_TEXT through MM_ANISOTROPIC. */
/** What a region query answers: an error, or a region that is one rectangle. */
const REGION_ERROR = 0;
const SIMPLE_REGION = 2;

const MM_TEXT = 1;
const MM_ISOTROPIC = 7;
const MM_ANISOTROPIC = 8;

/** The two modes in which the program, not the mode, decides the extents. */
const SCALABLE_MAP_MODES = new Set([MM_ISOTROPIC, MM_ANISOTROPIC]);

/**
 * The fixed modes, by how many logical units make an inch: MM_LOMETRIC's
 * tenths of a millimetre through MM_TWIPS. Each maps that many logical units
 * onto the device's inch with y growing upwards, which is what sets them apart
 * from MM_TEXT's pixels growing down.
 */
const UNITS_PER_INCH = new Map([[2, 254], [3, 2540], [4, 100], [5, 1000], [6, 1440]]);
/** MM_ISOTROPIC starts from MM_LOMETRIC's extents, as Windows starts it. */
const MM_LOMETRIC = 2;

/** What a function that should have returned a COLORREF says when it failed. */
const CLR_INVALID = 0xffffffff;

const WHITE = 0x00ffffff;
const LTGRAY = 0x00c0c0c0;
const GRAY = 0x00808080;
const DKGRAY = 0x00404040;
const BLACK = 0x00000000;

/** ExtTextOut's clip flag, and the plain copy a bitmap is drawn with. */
const ETO_CLIPPED = 0x0004;
const SRCCOPY = 0x00cc0020;

/** GetDeviceCaps indices this layer has an answer for. */
const DRIVERVERSION = 0;
const TECHNOLOGY = 2;
const HORZSIZE = 4;
const VERTSIZE = 6;
const HORZRES = 8;
const VERTRES = 10;
const BITSPIXEL = 12;
const PLANES = 14;
const NUMCOLORS = 24;
const LOGPIXELSX = 88;
const LOGPIXELSY = 90;
const SIZEPALETTE = 104;
const COLORRES = 108;

/** DT_RASDISPLAY: the device is a raster display, not a plotter or a printer. */
const DT_RASDISPLAY = 1;

/** A palette device is one with 256 colours or fewer; nothing here is one. */
const PALETTE_DEPTH = 8;

/**
 * The screen this process believes it has, until something that owns a real one
 * says otherwise. It matches the size user32 gives a window whose position the
 * system chose, so a program that sizes itself to the desktop gets a consistent
 * answer from both.
 */
const DEFAULT_SCREEN = Object.freeze({ width: 640, height: 480, bitsPerPixel: 32 });

/** Pixels per logical inch. 96 is what a Windows display reports at 100% scale. */
const LOGICAL_DPI = 96;

/** Millimetres per inch, for the two metrics that are asked in millimetres. */
const MM_PER_INCH = 25.4;
/** Typographic points per inch, for a font asked for by point size. */
const POINTS_PER_INCH = 72;

/**
 * What the dialog manager averages a font's character width over: both
 * cases of the alphabet, so a face whose capitals are wide is laid out
 * wider than one whose lower case is.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Bit depths a bitmap can have. Anything else is not a format GDI knows. */
const BIT_COUNTS = new Set([1, 4, 8, 16, 24, 32]);

/**
 * Depths a device context over somebody else's surface can be made at.
 * A palettised primary is the common one for a program of this era, which is
 * why eight is here at all; the drawing half has no path for the rest.
 */
const SURFACE_DC_DEPTHS = new Set([8, 16, 32]);

/** BITMAPINFOHEADER compressions a DIB section can be backed by plain memory. */
const BI_RGB = 0;
const BI_BITFIELDS = 3;

/** iUsage: the colour table is palette indices, not colours. */
const DIB_PAL_COLORS = 1;

/** Entries an indexed DIB's colour table holds, by depth. */
const colorTableSize = (/** @type {number} */ bitCount)=>1 << bitCount;

/**
 * Font metrics with no font engine behind them.
 *
 * These are estimates, used when the build has no rasteriser to measure a
 * real face with. They are chosen so that the numbers a program divides by
 * are self-consistent -- ascent plus descent is the cell height, a string is
 * its length times the average width -- because a layout that adds up is what
 * code depends on, far more than the exact numbers. Every face is treated as
 * fixed-pitch for the same reason. With an engine, its measurements overlay
 * these field for field, and a string is as wide as the engine draws it.
 */
const DEFAULT_EM_HEIGHT = 13;
const INTERNAL_LEADING_RATIO = 0.2;
const DESCENT_RATIO = 0.25;
const WIDTH_RATIO = 0.5;

/** FW_NORMAL, which a LOGFONT weight of zero means. */
const FW_NORMAL = 400;

/**
 * Character sets. DEFAULT_CHARSET is a request, never a font's own: a font
 * asked for with it is realised in the ANSI set, which is Windows-1252 here,
 * the code page the font engine draws a program's bytes in.
 */
const ANSI_CHARSET = 0;
const DEFAULT_CHARSET = 1;
const HEBREW_CHARSET = 177;
const ARABIC_CHARSET = 178;
/** SHIFTJIS, HANGUL, JOHAB, GB2312 and CHINESEBIG5: the double-byte sets. */
const DBCS_CHARSETS = new Set([128, 129, 130, 134, 136]);

/** GetFontLanguageInfo's answers. */
const GCP_DBCS = 0x0001;
const GCP_REORDER = 0x0002;
const GCP_ERROR = 0x8000;

/** FONTSIGNATURE: four DWORDs of Unicode subranges, two of code pages. */
const FONTSIGNATURE_SIZE = 24;

/**
 * TMPF_FIXED_PITCH, whose name is the opposite of its meaning: the bit is set
 * for a variable-pitch font and clear for a fixed-pitch one.
 */
const TMPF_FIXED_PITCH = 0x01;

/** The character range a metric describes, and the two special characters in it. */
const FIRST_CHAR = 0x20;
const LAST_CHAR = 0xff;
const DEFAULT_CHAR = 0x1f;
const BREAK_CHAR = 0x20;

/** Nothing bounds a face name but the field it came out of. */
const MAX_FACE_NAME = 64;

/**
 * @typedef {Object} GdiHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {{ open: (type: string, object: any) => number,
 *              close: (handle: number) => any }} handles
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => void }} surfaces
 *           Where the bits of a DIB section come from. This layer decides how
 *           many bytes a format needs; it never decides where they live.
 * @property {{ width: number, height: number, bitsPerPixel: number }} [screen]
 *           What GetDeviceCaps reports for a display DC.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that does less than the real one says so.
 * @property {import('./drawing.js').DrawingServices} [graphics]
 *           Where pixels go. Absent in a build that cannot draw, and every
 *           entry point that needs it then fails truthfully.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against. All
 * of gdi32 is stdcall, the bridge's default, so none of them says so.
 *
 * @param {GdiHost} host
 */
export function createGdiFunctions(host){
    const objects = createGdiObjects(host.handles);
    const screen = host.screen ?? DEFAULT_SCREEN;
    /** @type {Map<number, any>} */
    const contexts = new Map();

    /** @param {number} handle @returns {any | null} */
    const dcOf = handle=>contexts.get(handle >>> 0) ?? null;

    /**
     * The colour table that follows an indexed DIB's header, as the colours
     * the drawing layer indexes by: 0x00RRGGBB, live for the bitmap's life.
     *
     * A palette-relative table (DIB_PAL_COLORS) holds indices into the
     * palette the device has selected, and those are resolved now: the
     * bitmap keeps colours, not a reference to a palette that may change.
     *
     * @param {number} at @param {number} count @param {number} usage @param {any} dc
     * @returns {number[]}
     */
    const readColorTable = (at, count, usage, dc)=>{
        const colors = [];
        if (usage === DIB_PAL_COLORS)
        {
            const record = objects.get(dc?.palette ?? 0);
            const entries = record?.attributes.entries ?? [];
            const raw = host.readMemory(at, count * 2);
            /** @type {number[]} */
            const indices = [];
            for (let index = 0; index < count; index++)
            {
                const entry = raw[index * 2] | (raw[index * 2 + 1] << 8);
                indices.push(entry);
                colors.push(paletteEntryToPixel(entries[entry] ?? 0));
            }
            // A palette-relative table holds indices, not colours: the program
            // fills the palette after the bitmap exists (CreatePalette, then
            // SetPaletteEntries), and the bitmap has to show the palette as it
            // is now, not as it was when the bitmap was made. So the resolved
            // array is kept alive on the palette and refreshed in place -- the
            // same array the surface already holds a reference to.
            if (record && record.type === 'palette')
            {
                (record.attributes.dependents ??= []).push({ indices, table: colors });
            }
            return colors;
        }
        const quads = host.readMemory(at, count * 4);
        for (let index = 0; index < count; index++)
        {
            colors.push((quads[index * 4] | quads[index * 4 + 1] << 8
                | quads[index * 4 + 2] << 16) >>> 0);
        }
        return colors;
    };

    /**
     * The colour table of the DIB section selected into a DC, or null when
     * what is selected has none: only an indexed DIB section carries one.
     *
     * @param {number} hdc
     * @returns {number[] | null}
     */
    const colorTableOf = hdc=>{
        const dc = dcOf(hdc);
        const bitmap = dc ? objects.get(dc.bitmap) : null;
        return bitmap && bitmap.attributes.section && bitmap.attributes.palette
            ? bitmap.attributes.palette
            : null;
    };

    /**
     * The stock objects, created once and handed back by index forever. They are
     * built lazily so that a process that never asks for one never has one.
     *
     * @type {Map<number, number>}
     */
    const stock = new Map();

    /** @param {number} index @returns {{ type: any, attributes: any } | null} */
    const stockDefinition = index=>{
        switch (index){
            case WHITE_BRUSH:
                return { type: 'brush', attributes: { style: BS_SOLID, color: WHITE, hatch: 0 } };
            case LTGRAY_BRUSH:
                return { type: 'brush', attributes: { style: BS_SOLID, color: LTGRAY, hatch: 0 } };
            case GRAY_BRUSH:
                return { type: 'brush', attributes: { style: BS_SOLID, color: GRAY, hatch: 0 } };
            case DKGRAY_BRUSH:
                return { type: 'brush', attributes: { style: BS_SOLID, color: DKGRAY, hatch: 0 } };
            case BLACK_BRUSH:
                return { type: 'brush', attributes: { style: BS_SOLID, color: BLACK, hatch: 0 } };
            case NULL_BRUSH:
                return { type: 'brush', attributes: { style: BS_NULL, color: 0, hatch: 0 } };
            case WHITE_PEN:
                return { type: 'pen', attributes: { style: 0, width: 1, color: WHITE } };
            case BLACK_PEN:
                return { type: 'pen', attributes: { style: 0, width: 1, color: BLACK } };
            case NULL_PEN:
                return { type: 'pen', attributes: { style: PS_NULL, width: 1, color: BLACK } };
            case SYSTEM_FONT:
            case DEVICE_DEFAULT_FONT:
                return { type: 'font', attributes: logFont({ height: 16, weight: 700 }) };
            case SYSTEM_FIXED_FONT:
                return { type: 'font', attributes: logFont({ height: 16, pitchAndFamily: 1 }) };
            case DEFAULT_GUI_FONT:
                return { type: 'font', attributes: logFont({ height: -11 }) };
            case DEFAULT_PALETTE:
                return { type: 'palette', attributes: { version: 0x300, entries: [] } };
            default:
                return null;
        }
    };

    /**
     * A LOGFONT with everything the guest did not say filled in. The stock fonts
     * are described the same way a created one is, so that one estimator covers
     * both.
     *
     * @param {Partial<import('./structs.js').LogFontFields>} fields
     * @returns {import('./structs.js').LogFontFields}
     */
    function logFont(fields){
        return {
            height: 0, width: 0, escapement: 0, orientation: 0, weight: 0,
            italic: 0, underline: 0, strikeOut: 0, charSet: 0, outPrecision: 0,
            clipPrecision: 0, quality: 0, pitchAndFamily: 0, faceName: '',
            ...fields,
        };
    }

    /** @param {number} index @returns {number} the stock handle, or zero */
    const stockObject = index=>{
        const existing = stock.get(index);
        if (existing !== undefined)
        {
            return existing;
        }
        const definition = stockDefinition(index);
        if (!definition)
        {
            return 0;
        }
        const handle = objects.defineStock(definition.type, definition.attributes);
        stock.set(index, handle);
        return handle;
    };

    /**
     * The slots a DC selects objects into, in the order a snapshot lists them.
     * A GDI object's type is also the name of the slot it goes in, which is what
     * makes SelectObject one line rather than a switch.
     */
    const SLOTS = ['pen', 'brush', 'font', 'bitmap', 'palette'];

    /** @param {any} dc @param {(handle: number) => void} action */
    const forEachSelection = (dc, action)=>SLOTS.forEach(slot=>action(dc[slot]));

    /**
     * What a DC draws onto: the screen for a display DC, the selected bitmap for
     * a memory one. It is what the device metrics describe and what a compatible
     * bitmap is compatible with.
     *
     * @param {any} dc
     * @returns {{ width: number, height: number, bitCount: number }}
     */
    const surfaceOf = dc=>{
        if (dc.kind !== 'memory')
        {
            return { width: screen.width, height: screen.height, bitCount: screen.bitsPerPixel };
        }
        const bitmap = objects.get(dc.bitmap);
        return bitmap
            ? bitmap.attributes
            : { width: 1, height: 1, bitCount: 1 };
    };

    /**
     * @param {number} window  Zero for the screen, which is a window like any other here.
     * @param {'window' | 'memory' | 'display'} kind
     */
    const createContext = (window, kind)=>{
        const dc = {
            hdc: 0,
            window,
            kind,
            /**
             * Where on the screen a window context draws, or null for all of
             * it. The drawing layer binds the context to that view.
             *
             * @type {{ left: number, top: number, right: number, bottom: number } | null}
             */
            bounds: null,
            /** The bitmap a surface's DC brought with it, and takes away again. */
            defaultBitmap: 0,
            pen: stockObject(BLACK_PEN),
            brush: stockObject(WHITE_BRUSH),
            font: stockObject(SYSTEM_FONT),
            bitmap: 0,
            palette: stockObject(DEFAULT_PALETTE),
            textColor: BLACK,
            bkColor: WHITE,
            bkMode: OPAQUE,
            rop2: R2_COPYPEN,
            textAlign: 0,
            mapMode: MM_TEXT,
            viewportOrg: { x: 0, y: 0 },
            windowOrg: { x: 0, y: 0 },
            viewportExt: { cx: 1, cy: 1 },
            windowExt: { cx: 1, cy: 1 },
            position: { x: 0, y: 0 },
            /** @type {any[]} */
            saved: [],
        };
        dc.hdc = host.handles.open('dc', dc);
        forEachSelection(dc, handle=>objects.retain(handle));
        contexts.set(dc.hdc, dc);
        return dc;
    };

    /**
     * Ends a DC: its selections and every state it still had saved let go of
     * whatever they were holding, so that objects the program created become
     * deletable again.
     *
     * @param {any} dc
     */
    const destroyContext = dc=>{
        forEachSelection(dc, handle=>objects.release(handle));
        for (const state of dc.saved)
        {
            forEachSelection(state, handle=>objects.release(handle));
        }
        dc.saved.length = 0;
        // The bitmap over somebody else's surface is the DC's own, not the
        // program's: nobody else can have a handle to delete it.
        objects.remove(dc.defaultBitmap);
        contexts.delete(dc.hdc);
        host.handles.close(dc.hdc);
    };

    /** @param {any} dc @returns {any} a copy of everything SaveDC remembers */
    const snapshot = dc=>({
        pen: dc.pen,
        brush: dc.brush,
        font: dc.font,
        bitmap: dc.bitmap,
        palette: dc.palette,
        textColor: dc.textColor,
        bkColor: dc.bkColor,
        bkMode: dc.bkMode,
        rop2: dc.rop2,
        textAlign: dc.textAlign,
        mapMode: dc.mapMode,
        viewportOrg: { ...dc.viewportOrg },
        windowOrg: { ...dc.windowOrg },
        viewportExt: { ...dc.viewportExt },
        windowExt: { ...dc.windowExt },
        position: { ...dc.position },
    });

    /**
     * @param {any} dc
     * @param {number} handle
     * @returns {number} what SelectObject reports
     */
    const select = (dc, handle)=>{
        const record = objects.get(handle);
        if (!record || !SLOTS.includes(record.type))
        {
            return 0;
        }
        if (record.type === 'palette')
        {
            // A palette is selected by SelectPalette, which realises it against
            // the device; SelectObject is documented to fail on one.
            return 0;
        }
        if (record.type === 'bitmap' && dc[record.type] !== handle)
        {
            // Two DCs sharing one bitmap means two sets of drawing state writing
            // the same pixels, so Windows lets exactly one of them have it -- and
            // a display DC already draws to the screen. The stock pixel every
            // memory DC starts with is the one bitmap in all of them at once.
            if (dc.kind !== 'memory' || (record.selectCount > 0 && !record.stock))
            {
                return 0;
            }
        }
        const previous = dc[record.type];
        objects.retain(handle);
        objects.release(previous);
        dc[record.type] = handle;
        if (record.type === 'bitmap')
        {
            // The pixels the context was drawing into were the old bitmap's;
            // the next draw binds it to the new one's.
            dc.boundSurface = null;
        }
        return previous;
    };

    /**
     * @param {any} dc
     * @param {any} state
     */
    const applyState = (dc, state)=>{
        for (const slot of SLOTS)
        {
            objects.release(dc[slot]);
            dc[slot] = state[slot];
        }
        dc.textColor = state.textColor;
        dc.bkColor = state.bkColor;
        dc.bkMode = state.bkMode;
        dc.rop2 = state.rop2;
        dc.mapMode = state.mapMode;
        dc.viewportOrg = state.viewportOrg;
        dc.windowOrg = state.windowOrg;
        dc.viewportExt = state.viewportExt;
        dc.windowExt = state.windowExt;
        dc.position = state.position;
    };

    /**
     * Sets one of the DC's points and reports the previous value through the out
     * parameter every one of these calls carries. The current position is one of
     * them: MoveToEx differs from SetViewportOrgEx only in which point it moves.
     *
     * @param {number[]} args  hdc, then the two coordinates, then the out pointer.
     * @param {'viewportOrg' | 'windowOrg' | 'position'} field
     */
    const setOrigin = (args, field)=>{
        const [handle, x, y, out] = args;
        const dc = dcOf(handle);
        if (!dc)
        {
            return 0;
        }
        if ((out >>> 0) !== 0)
        {
            writePoint(host, out, dc[field]);
        }
        dc[field] = { x: x | 0, y: y | 0 };
        return 1;
    };

    /**
     * @param {number[]} args  hdc, then the two extents, then the out pointer.
     * @param {'viewportExt' | 'windowExt'} field
     */
    const setExtent = (args, field)=>{
        const [handle, cx, cy, out] = args;
        const dc = dcOf(handle);
        if (!dc)
        {
            return 0;
        }
        if ((out >>> 0) !== 0)
        {
            writeSize(host, out, dc[field]);
        }
        // Every other mapping mode fixes its own extents; the call still
        // succeeds and still reports the previous pair, it just changes nothing.
        if (SCALABLE_MAP_MODES.has(dc.mapMode))
        {
            dc[field] = { cx: cx | 0, cy: cy | 0 };
        }
        return 1;
    };

    /**
     * A UTF-16 string out of guest memory: `count` code units when `counted`,
     * as the text calls take them unterminated, else up to a terminator
     * within that many.
     *
     * @param {number} address @param {number} count @param {boolean} [counted]
     */
    const wideText = (address, count, counted = false)=>{
        const bytes = host.readMemory(address >>> 0, Math.max(0, count) * 2);
        let text = '';
        for (let at = 0; at * 2 + 1 < bytes.length; at++)
        {
            const unit = bytes[at * 2] | bytes[at * 2 + 1] << 8;
            if (unit === 0 && !counted)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /**
     * One record per character of a range, each made from that character's
     * advance in the context's font: GetCharWidth's INTs and
     * GetCharABCWidths' ABCs alike.
     *
     * @param {number} handle @param {number} first @param {number} last
     * @param {number} out @param {number} stride
     * @param {(width: number) => number[]} record
     * @param {number} mask  What of a code is a character: a byte for the A
     *        spellings, a code unit for the W ones.
     */
    const writeWidths = (handle, first, last, out, stride, record, mask)=>{
        const dc = dcOf(handle);
        if (!dc || (out >>> 0) === 0 || last < first)
        {
            return 0;
        }
        for (let code = first; code <= last; code++)
        {
            writeU32s(host, (out >>> 0) + (code - first) * stride,
                record(widthOf(dc, String.fromCharCode(code & mask))));
        }
        return 1;
    };

    /**
     * The extents a mapping mode fixes, or null for MM_ANISOTROPIC, which
     * keeps whatever the DC had.
     *
     * @param {number} mode
     * @returns {{ windowExt: { cx: number, cy: number },
     *             viewportExt: { cx: number, cy: number } } | null}
     */
    const extentsOf = mode=>{
        if (mode === MM_TEXT)
        {
            return { windowExt: { cx: 1, cy: 1 }, viewportExt: { cx: 1, cy: 1 } };
        }
        const units = UNITS_PER_INCH.get(mode === MM_ISOTROPIC ? MM_LOMETRIC : mode);
        return units === undefined
            ? null
            : { windowExt: { cx: units, cy: units },
                viewportExt: { cx: LOGICAL_DPI, cy: -LOGICAL_DPI } };
    };

    /**
     * One coordinate through the window-to-viewport mapping, either way,
     * rounded to the nearest device unit as GDI rounds it.
     *
     * @param {number} value @param {number} from @param {number} to
     * @param {number} fromExt @param {number} toExt
     */
    const mapped = (value, from, to, fromExt, toExt)=>(fromExt === 0
        ? to
        : Math.round((value - from) * toExt / fromExt) + to);

    /**
     * A logical point as the device sees it, or a device point as the
     * program's logical space names it: what LPtoDP and DPtoLP answer.
     *
     * @param {any} dc @param {{ x: number, y: number }} point
     * @param {boolean} toDevice
     */
    const transform = (dc, point, toDevice)=>{
        const [from, to, fromExt, toExt] = toDevice
            ? [dc.windowOrg, dc.viewportOrg, dc.windowExt, dc.viewportExt]
            : [dc.viewportOrg, dc.windowOrg, dc.viewportExt, dc.windowExt];
        return {
            x: mapped(point.x, from.x, to.x, fromExt.cx, toExt.cx),
            y: mapped(point.y, from.y, to.y, fromExt.cy, toExt.cy),
        };
    };

    /**
     * LPtoDP and DPtoLP: every point of the array converted in place.
     *
     * @param {number[]} args @param {boolean} toDevice
     */
    const convertPoints = ([handle, points, count], toDevice)=>{
        const dc = dcOf(handle);
        if (!dc || (points >>> 0) === 0 || (count | 0) < 0)
        {
            return 0;
        }
        const bytes = host.readMemory(points >>> 0, (count | 0) * 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < (count | 0); index++)
        {
            const point = transform(dc, {
                x: view.getInt32(index * 8, true), y: view.getInt32(index * 8 + 4, true),
            }, toDevice);
            writePoint(host, (points >>> 0) + index * 8, point);
        }
        return 1;
    };

    /**
     * The estimated metrics of a font. See the ratios above for what "estimated"
     * means here.
     *
     * @param {import('./structs.js').LogFontFields} font
     * @returns {import('./structs.js').TextMetricFields}
     */
    const metricsOf = font=>{
        const measured = host.graphics?.fontMetrics?.(font);
        // lfHeight is three different requests in one field: a cell height when
        // positive, a character height when negative, and "you choose" at zero.
        const requested = font.height | 0;
        const em = requested < 0
            ? -requested
            : (requested > 0
                ? Math.max(1, Math.round(requested / (1 + INTERNAL_LEADING_RATIO)))
                : DEFAULT_EM_HEIGHT);
        const leading = requested > 0
            ? requested - em
            : Math.round(em * INTERNAL_LEADING_RATIO);
        const height = em + leading;
        const descent = Math.round(em * DESCENT_RATIO);
        const width = font.width !== 0
            ? Math.abs(font.width | 0)
            : Math.max(1, Math.round(em * WIDTH_RATIO));
        return {
            height,
            ascent: height - descent,
            descent,
            internalLeading: leading,
            externalLeading: 0,
            aveCharWidth: width,
            maxCharWidth: width,
            weight: font.weight || FW_NORMAL,
            digitizedAspectX: LOGICAL_DPI,
            digitizedAspectY: LOGICAL_DPI,
            firstChar: FIRST_CHAR,
            lastChar: LAST_CHAR,
            defaultChar: DEFAULT_CHAR,
            breakChar: BREAK_CHAR,
            italic: font.italic ? 1 : 0,
            underlined: font.underline ? 1 : 0,
            struckOut: font.strikeOut ? 1 : 0,
            // The family nibble travels through unchanged; the pitch bits do not,
            // because there is only one pitch here and it is not the one the
            // constant is named after.
            pitchAndFamily: (font.pitchAndFamily & 0xf0) & ~TMPF_FIXED_PITCH,
            charSet: font.charSet === DEFAULT_CHARSET ? ANSI_CHARSET : font.charSet,
            ...measured,
        };
    };

    /** @param {any} dc @returns {import('./structs.js').LogFontFields} */
    const currentFont = dc=>objects.get(dc.font)?.attributes ?? logFont({});

    /** @param {any} dc @returns {import('./structs.js').TextMetricFields} */
    const currentMetrics = dc=>metricsOf(currentFont(dc));

    /**
     * How wide a string is in a context's font: what the engine draws, or
     * the estimate's fixed pitch without one.
     *
     * @param {any} dc @param {string} text
     * @returns {number}
     */
    const widthOf = (dc, text)=>{
        const font = currentFont(dc);
        return host.graphics?.textWidth?.(font, text) ?? text.length * metricsOf(font).aveCharWidth;
    };

    /**
     * @param {any} dc
     * @param {number} index
     * @returns {number}
     */
    const deviceCaps = (dc, index)=>{
        const surface = surfaceOf(dc);
        const depth = surface.bitCount;
        switch (index | 0){
            case DRIVERVERSION:
                return 0;
            case TECHNOLOGY:
                return DT_RASDISPLAY;
            case HORZSIZE:
                return Math.round((surface.width * MM_PER_INCH) / LOGICAL_DPI);
            case VERTSIZE:
                return Math.round((surface.height * MM_PER_INCH) / LOGICAL_DPI);
            case HORZRES:
                return surface.width;
            case VERTRES:
                return surface.height;
            case BITSPIXEL:
                return depth;
            case PLANES:
                return 1;
            case NUMCOLORS:
                // Documented as -1 for a device with more colours than a palette
                // can hold, which is every device deeper than 8 bits.
                return depth > PALETTE_DEPTH ? -1 : 1 << depth;
            case LOGPIXELSX:
            case LOGPIXELSY:
                return LOGICAL_DPI;
            case SIZEPALETTE:
                return depth === PALETTE_DEPTH ? 1 << depth : 0;
            case COLORRES:
                return depth;
            default:
                // An index with no answer reads as zero rather than as a
                // plausible number from a neighbouring capability.
                return 0;
        }
    };

    /**
     * How many bytes a DIB of this format occupies. Rows are padded to a DWORD,
     * which is the difference between a DIB loop that works at every width and
     * one that shears the image at some of them.
     *
     * @param {number} width
     * @param {number} height
     * @param {number} bitCount
     */
    const dibSize = (width, height, bitCount)=>
        (((((width * bitCount) + 31) / 32) | 0) * 4) * Math.abs(height);

    /**
     * A device-dependent bitmap's attributes, its bits among them: rows
     * top-down and WORD-padded, the layout CreateBitmap's lpBits and
     * GetBitmapBits' buffer are in, zeroed. Windows keeps these bits where
     * the program has no address for them -- GetObject's bmBits is NULL --
     * so they are memory of their own here too, not the guest's: a buffer
     * the program passed in is copied and is the program's to reuse.
     *
     * Null when the bits cannot be had, which the caller reports as the
     * failure it is.
     *
     * @param {number} width @param {number} height @param {number} bitCount
     * @param {number} [planes]
     */
    const deviceBitmap = (width, height, bitCount, planes = 1)=>{
        let pixels;
        try
        {
            pixels = new Uint8Array(ddbStride(width, bitCount) * height);
        }
        catch {
            return null;
        }
        return { width, height, planes, bitCount, bits: 0, section: 0, pixels };
    };

    /** @type {number} */
    let stockBitmap = 0;
    /**
     * The 1-by-1 monochrome bitmap: what CreateBitmap and CreateCompatibleBitmap
     * answer for a zero width or height, and what every memory DC has selected
     * before the program selects anything -- one stock object, the same handle
     * for all of them (Wine's test_CreateBitmap).
     */
    const defaultBitmap = ()=>{
        stockBitmap ||= objects.defineStock('bitmap', deviceBitmap(1, 1, 1));
        return stockBitmap;
    };

    /**
     * A bitmap's bits as GetBitmapBits and SetBitmapBits exchange them, or
     * null for a handle that is not a bitmap with bits.
     *
     * @param {number} handle
     * @returns {{ size: number, read: () => Uint8Array,
     *             write: (bytes: Uint8Array) => void } | null}
     */
    const bitsOf = handle=>{
        const record = objects.get(handle);
        const attributes = record?.type === 'bitmap' ? record.attributes : null;
        if (!attributes)
        {
            return null;
        }
        const stride = ddbStride(attributes.width, attributes.bitCount);
        const size = stride * attributes.height;
        if (attributes.pixels)
        {
            const pixels = /** @type {Uint8Array} */ (attributes.pixels);
            return { size, read: ()=>pixels, write: bytes=>pixels.set(bytes) };
        }
        if ((attributes.section >>> 0) === 0)
        {
            return null;
        }
        const pitch = dibStride(attributes.width, attributes.bitCount);
        /** @param {number} y */
        const rowAt = y=>attributes.section + pitch
            * (attributes.topDown ? y : attributes.height - 1 - y);
        return {
            size,
            read(){
                const bytes = new Uint8Array(size);
                for (let y = 0; y < attributes.height; y++)
                {
                    bytes.set(host.readMemory(rowAt(y), stride), y * stride);
                }
                return bytes;
            },
            write(bytes){
                for (let y = 0; y * stride < bytes.length; y++)
                {
                    host.writeMemory(rowAt(y), bytes.subarray(y * stride, (y + 1) * stride));
                }
            },
        };
    };

    /**
     * A pattern brush over a bitmap, or zero for a handle that is not one.
     *
     * The brush keeps a copy of the bitmap's bits, taken now: Windows paints
     * with the bitmap as it was when the brush was made, and goes on painting
     * with it once the bitmap is deleted (Wine's brush tests). The copy is in
     * the layout GetBitmapBits hands out, with what a DIB section's values
     * mean carried alongside; LOGBRUSH still names the bitmap and no colour.
     *
     * @param {number} handle
     */
    const patternBrush = handle=>{
        const bits = bitsOf(handle);
        if (!bits)
        {
            return 0;
        }
        const shape = /** @type {import('./objects.js').GdiObject} */ (
            objects.get(handle)).attributes;
        return objects.create('brush', {
            style: BS_PATTERN,
            color: 0,
            hatch: handle >>> 0,
            pattern: {
                width: shape.width,
                height: shape.height,
                bitCount: shape.bitCount,
                pixels: bits.read().slice(),
                dib: (shape.section >>> 0) !== 0,
                palette: shape.palette ? [...shape.palette] : undefined,
                format: shape.format,
                compression: shape.compression,
                bitfields: shape.bitfields,
            },
        });
    };

    /**
     * Runs `action` over a memory context of this layer's own with `bitmap`
     * in it, whether or not a program has the bitmap selected somewhere: a
     * bitmap read back or drawn for the window manager is not a selection,
     * and the rule that a bitmap is in one DC at a time is the program's.
     *
     * @template T
     * @param {number} bitmap @param {(hdc: number) => T} action
     * @returns {T}
     */
    const lend = (bitmap, action)=>{
        const dc = createContext(0, 'memory');
        objects.retain(bitmap);
        dc.bitmap = bitmap >>> 0;
        try
        {
            return action(dc.hdc);
        }
        finally
        {
            objects.release(dc.bitmap);
            dc.bitmap = 0;
            destroyContext(dc);
        }
    };

    const drawing = createDrawingFunctions({
        host, objects, dcOf, surfaceOf, currentMetrics, lend,
    });

    /**
     * Solid brushes by colour, for the window manager's own painting and for
     * GetSysColorBrush. Stock, because the handle is handed out again and
     * again and a program may not delete it.
     *
     * @type {Map<number, number>}
     */
    const solidBrushes = new Map();
    /** @param {number} color  A COLORREF. */
    const solidBrush = color=>{
        const key = color >>> 0;
        let handle = solidBrushes.get(key);
        if (handle === undefined)
        {
            handle = objects.defineStock('brush', { style: BS_SOLID, color: key, hatch: 0 });
            solidBrushes.set(key, handle);
        }
        return handle;
    };

    const table = {
        ...drawing.functions,

        /** HDC GetDC(HWND hWnd) */
        GetDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>createContext(hwnd >>> 0, 'window').hdc,
        },

        /**
         * HDC GetWindowDC(HWND hWnd)
         *
         * The difference from GetDC is the non-client area, which nothing models
         * yet: a window is its client area until there is a frame around it.
         */
        GetWindowDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>createContext(hwnd >>> 0, 'window').hdc,
        },

        /** int ReleaseDC(HWND hWnd, HDC hDC) */
        ReleaseDC: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, handle])=>{
                const dc = dcOf(handle);
                // A DC belongs to the window it was fetched for, and releasing it
                // against another window is the bug that leaks the cache entry.
                if (!dc || dc.kind !== 'window' || dc.window !== (hwnd >>> 0))
                {
                    return 0;
                }
                destroyContext(dc);
                return 1;
            },
        },

        /**
         * HDC CreateDCA(LPCSTR pwszDriver, LPCSTR pwszDevice, LPCSTR pszPort,
         *               const DEVMODEA *pdm)
         *
         * A DC on the display, owned by the caller rather than borrowed from
         * a window, so it goes back through DeleteDC. The display is the only
         * device there is: a printer or a named device has nothing behind it.
         */
        CreateDCA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([driver, device])=>{
                const named = (driver >>> 0) !== 0 ? host.readCString(driver >>> 0, 32)
                    : (device >>> 0) !== 0 ? host.readCString(device >>> 0, 32) : '';
                if (named.toUpperCase() !== 'DISPLAY')
                {
                    return 0;
                }
                return createContext(0, 'display').hdc;
            },
        },

        /** HDC CreateCompatibleDC(HDC hdc) */
        CreateCompatibleDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                // A null HDC means "compatible with the screen", which is what a
                // display DC is compatible with anyway.
                const source = (handle >>> 0) === 0 ? null : dcOf(handle);
                if ((handle >>> 0) !== 0 && !source)
                {
                    return 0;
                }
                // Documented exactly: a memory DC starts out one monochrome pixel
                // wide and one pixel high, so that it always has a surface.
                const dc = createContext(0, 'memory');
                select(dc, defaultBitmap());
                return dc.hdc;
            },
        },

        /** BOOL DeleteDC(HDC hdc) */
        DeleteDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                // A DC that came from GetDC goes back through ReleaseDC: it is
                // the window's, borrowed, and deleting it loses the loan.
                if (!dc || dc.kind === 'window')
                {
                    return 0;
                }
                destroyContext(dc);
                return 1;
            },
        },

        /** int SaveDC(HDC hdc) */
        SaveDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                const state = snapshot(dc);
                // The saved state points at the same objects the DC does, and a
                // restore will put them back -- so it holds its own reference and
                // they cannot be deleted in the meantime.
                forEachSelection(state, object=>objects.retain(object));
                dc.saved.push(state);
                return dc.saved.length;
            },
        },

        /** BOOL RestoreDC(HDC hdc, int nSavedDC) */
        RestoreDC: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, saved])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                // A negative level counts back from the top, so -1 is the state
                // saved most recently; a positive one names an absolute level.
                const level = (saved | 0) < 0
                    ? dc.saved.length + (saved | 0) + 1
                    : (saved | 0);
                if (level < 1 || level > dc.saved.length)
                {
                    return 0;
                }
                // Everything saved after the level being restored is discarded,
                // which is what makes SaveDC/RestoreDC a stack rather than a set.
                while (dc.saved.length > level)
                {
                    const discarded = dc.saved.pop();
                    forEachSelection(discarded, object=>objects.release(object));
                }
                applyState(dc, dc.saved.pop());
                return 1;
            },
        },

        /** HGDIOBJ GetStockObject(int i) */
        GetStockObject: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>stockObject(index | 0),
        },

        /** BOOL DeleteObject(HGDIOBJ ho) */
        DeleteObject: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const record = objects.get(handle);
                const dib = record?.type === 'bitmap' ? record.attributes.section ?? 0 : 0;
                if (!objects.remove(handle))
                {
                    return 0;
                }
                if (dib !== 0)
                {
                    host.surfaces.free(dib);
                }
                return 1;
            },
        },

        /** HGDIOBJ SelectObject(HDC hdc, HGDIOBJ h) */
        SelectObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, object])=>{
                const dc = dcOf(handle);
                return dc ? select(dc, object) : 0;
            },
        },

        /** HGDIOBJ GetCurrentObject(HDC hdc, UINT type) */
        GetCurrentObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, type])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                switch (type >>> 0){
                    case OBJ_PEN:
                        return dc.pen;
                    case OBJ_BRUSH:
                        return dc.brush;
                    case OBJ_PAL:
                        return dc.palette;
                    case OBJ_FONT:
                        return dc.font;
                    case OBJ_BITMAP:
                        return dc.bitmap;
                    default:
                        return 0;
                }
            },
        },

        /** HPEN CreatePen(int iStyle, int cWidth, COLORREF color) */
        CreatePen: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([style, width, color])=>{
                if ((style | 0) < 0 || (style | 0) > PS_INSIDEFRAME)
                {
                    return 0;
                }
                return objects.create('pen', {
                    style: style | 0, width: width | 0, color: color >>> 0,
                });
            },
        },

        /** HPEN CreatePenIndirect(const LOGPEN *plpen) */
        CreatePenIndirect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([logpen])=>{
                const fields = readLogPen(host, logpen);
                if (fields.style > PS_INSIDEFRAME)
                {
                    return 0;
                }
                return objects.create('pen', fields);
            },
        },

        /** HBRUSH CreateSolidBrush(COLORREF color) */
        CreateSolidBrush: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([color])=>objects.create('brush', {
                style: BS_SOLID, color: color >>> 0, hatch: 0,
            }),
        },

        /** HBRUSH CreateBrushIndirect(const LOGBRUSH *plbrush) */
        CreateBrushIndirect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([logbrush])=>{
                const fields = readLogBrush(host, logbrush);
                if (!BRUSH_STYLES.has(fields.style))
                {
                    return 0;
                }
                return fields.style === BS_PATTERN
                    ? patternBrush(fields.hatch)
                    : objects.create('brush', fields);
            },
        },

        /**
         * HBRUSH CreatePatternBrush(HBITMAP hbm)
         *
         * A brush over a bitmap, which is what the BS_PATTERN form of a
         * LOGBRUSH describes with its hatch field holding the handle. A handle
         * that is not a bitmap makes no brush.
         */
        CreatePatternBrush: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([bitmap])=>patternBrush(bitmap),
        },

        /** HBRUSH CreateHatchBrush(int iHatch, COLORREF color) */
        CreateHatchBrush: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hatch, color])=>objects.create('brush', {
                style: BS_HATCHED, color: color >>> 0, hatch: hatch | 0,
            }),
        },

        /**
         * HFONT CreateFontA(int cHeight, int cWidth, int cEscapement, int cOrientation,
         *   int cWeight, DWORD bItalic, DWORD bUnderline, DWORD bStrikeOut, DWORD iCharSet,
         *   DWORD iOutPrecision, DWORD iClipPrecision, DWORD iQuality, DWORD iPitchAndFamily,
         *   LPCSTR pszFaceName)
         */
        CreateFontA: {
            argBytes: 56,
            /** @param {number[]} args */
            handler: args=>objects.create('font', logFont({
                height: args[0] | 0,
                width: args[1] | 0,
                escapement: args[2] | 0,
                orientation: args[3] | 0,
                weight: args[4] | 0,
                italic: args[5] & 0xff,
                underline: args[6] & 0xff,
                strikeOut: args[7] & 0xff,
                charSet: args[8] & 0xff,
                outPrecision: args[9] & 0xff,
                clipPrecision: args[10] & 0xff,
                quality: args[11] & 0xff,
                pitchAndFamily: args[12] & 0xff,
                faceName: (args[13] >>> 0) === 0
                    ? ''
                    : host.readCString(args[13], MAX_FACE_NAME),
            })),
        },

        /** HFONT CreateFontIndirectA(const LOGFONTA *lplf) */
        CreateFontIndirectA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([logfont])=>objects.create('font', readLogFont(host, logfont)),
        },

        /** HFONT CreateFontIndirectW(const LOGFONTW *lplf) */
        CreateFontIndirectW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([logfont])=>((logfont >>> 0) === 0
                ? 0
                : objects.create('font', readLogFontW(host, logfont))),
        },

        /** HFONT CreateFontW(..., LPCWSTR pszFaceName): CreateFontA with the face name wide. */
        CreateFontW: {
            argBytes: 56,
            /** @param {number[]} args */
            handler: args=>objects.create('font', logFont({
                height: args[0] | 0,
                width: args[1] | 0,
                escapement: args[2] | 0,
                orientation: args[3] | 0,
                weight: args[4] | 0,
                italic: args[5] & 0xff,
                underline: args[6] & 0xff,
                strikeOut: args[7] & 0xff,
                charSet: args[8] & 0xff,
                outPrecision: args[9] & 0xff,
                clipPrecision: args[10] & 0xff,
                quality: args[11] & 0xff,
                pitchAndFamily: args[12] & 0xff,
                faceName: (args[13] >>> 0) === 0 ? '' : wideText(args[13], MAX_FACE_NAME),
            })),
        },

        /** HBITMAP CreateCompatibleBitmap(HDC hdc, int cx, int cy) */
        CreateCompatibleBitmap: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, cx, cy])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                // Documented exactly: a zero extent yields the one-pixel
                // monochrome bitmap rather than a failure.
                if ((cx | 0) <= 0 || (cy | 0) <= 0)
                {
                    return defaultBitmap();
                }
                const attributes = deviceBitmap(cx | 0, cy | 0, surfaceOf(dc).bitCount);
                return attributes ? objects.create('bitmap', attributes) : 0;
            },
        },

        /**
         * HBITMAP CreateBitmap(int nWidth, int nHeight, UINT nPlanes, UINT nBitCount,
         *                      const VOID *lpBits)
         *
         * lpBits, when there are any, is the whole image in the bitmap's own
         * layout, and it is copied: the buffer is the caller's, free to be
         * reused or freed the moment this returns. A zero width or height is
         * the one-pixel monochrome bitmap, whatever the rest says.
         */
        CreateBitmap: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([width, height, planes, bitCount, bits])=>{
                if ((width | 0) === 0 || (height | 0) === 0)
                {
                    return defaultBitmap();
                }
                if ((width | 0) < 0 || (height | 0) < 0 || (planes >>> 0) === 0)
                {
                    return 0;
                }
                // A depth between two a bitmap can have is rounded up to the
                // next, as Windows rounds it: three bits is four, and only
                // past 32 is there none.
                const depth = [...BIT_COUNTS].find(known=>known >= (bitCount >>> 0));
                if ((bitCount >>> 0) === 0 || depth === undefined
                    || !BIT_COUNTS.has((planes >>> 0) * depth))
                {
                    return 0;
                }
                const attributes = deviceBitmap(width | 0, height | 0, depth, planes >>> 0);
                if (!attributes)
                {
                    return 0;
                }
                if ((bits >>> 0) !== 0)
                {
                    attributes.pixels.set(host.readMemory(bits >>> 0, attributes.pixels.length));
                }
                return objects.create('bitmap', attributes);
            },
        },

        /**
         * LONG GetBitmapBits(HBITMAP hbit, LONG cb, LPVOID lpvBits)
         * LONG SetBitmapBits(HBITMAP hbm, DWORD cb, const VOID *pvBits)
         *
         * A bitmap's bits in the device-dependent layout, rows top-down and
         * each padded to a WORD, whatever the bitmap is: a DIB section's
         * DWORD-padded rows, bottom-up or not, are converted on the way. A
         * null buffer asks for the size, and GetBitmapBits reads a negative
         * count as all of it, as Windows does. Each answers with how many
         * bytes it moved.
         */
        GetBitmapBits: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, count, out])=>{
                const bits = bitsOf(handle);
                if (!bits)
                {
                    return 0;
                }
                if ((out >>> 0) === 0)
                {
                    return bits.size;
                }
                const wanted = (count | 0) < 0 ? bits.size : Math.min(count | 0, bits.size);
                host.writeMemory(out >>> 0, bits.read().subarray(0, wanted));
                return wanted;
            },
        },

        SetBitmapBits: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, count, source])=>{
                const bits = bitsOf(handle);
                if (!bits || (source >>> 0) === 0)
                {
                    return 0;
                }
                const wanted = Math.min(count >>> 0, bits.size);
                bits.write(host.readMemory(source >>> 0, wanted).slice());
                return wanted;
            },
        },

        /**
         * HBITMAP CreateDIBSection(HDC hdc, const BITMAPINFO *pbmi, UINT usage,
         *   VOID **ppvBits, HANDLE hSection, DWORD offset)
         *
         * A null ppvBits is not refused: the section is created and the pointer
         * simply goes nowhere. The documentation does not say what happens, and
         * a program that asks for a surface it cannot address has not failed at
         * this call.
         */
        CreateDIBSection: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([hdc, info, usage, bitsOut, section])=>{
                const header = readBitmapInfoHeader(host, info);
                if (header.size < 40)
                {
                    // Anything smaller is a BITMAPCOREHEADER, whose fields are at
                    // different offsets and are not the ones read above.
                    return 0;
                }
                if (header.compression !== BI_RGB && header.compression !== BI_BITFIELDS)
                {
                    // A run-length encoded DIB has no addressable rows, so there
                    // is no pointer to hand back.
                    return 0;
                }
                if (!BIT_COUNTS.has(header.bitCount) || header.width <= 0 || header.height === 0)
                {
                    return 0;
                }
                if ((section >>> 0) !== 0)
                {
                    // Backing a section with a file mapping needs a filesystem
                    // that can map one; failing is better than silently handing
                    // back memory that is not the file.
                    return 0;
                }
                const bytes = dibSize(header.width, header.height, header.bitCount);
                const address = host.surfaces.allocate(bytes);
                if ((bitsOut >>> 0) !== 0)
                {
                    writeU32s(host, bitsOut, [address]);
                }
                // An indexed section's colours are its own, read from the
                // table behind the header and kept where SetDIBColorTable
                // can change them and a blit can read them. The table is
                // always full-sized: entries the caller left out are black,
                // and an index past a shorter table would be no colour at all.
                const palette = header.bitCount <= 8
                    ? readColorTable(info + header.size,
                        Math.min(header.clrUsed || colorTableSize(header.bitCount),
                            colorTableSize(header.bitCount)),
                        usage >>> 0, dcOf(hdc))
                    : undefined;
                if (palette)
                {
                    palette.push(...new Array(colorTableSize(header.bitCount) - palette.length)
                        .fill(0));
                }
                return objects.create('bitmap', {
                    width: header.width,
                    height: Math.abs(header.height),
                    planes: 1,
                    bitCount: header.bitCount,
                    // A negative height means the rows run top-down, which is the
                    // one thing about a DIB that a blitter cannot guess.
                    topDown: header.height < 0,
                    usage: usage >>> 0,
                    bits: address,
                    section: address,
                    palette,
                    // What GetObject hands back of the header the section was
                    // made from. BI_BITFIELDS' masks sit right after the
                    // original forty bytes, which in a V4 or V5 header is
                    // inside the header rather than after it.
                    compression: header.compression,
                    bitfields: header.compression === BI_BITFIELDS
                        ? [0, 4, 8].map(at=>readU32(host, info + BITMAPINFOHEADER.SIZE + at))
                        : [0, 0, 0],
                    pelsPerMeter: [header.xPelsPerMeter ?? 0, header.yPelsPerMeter ?? 0],
                });
            },
        },

        /**
         * UINT SetDIBColorTable(HDC hdc, UINT iStart, UINT cEntries,
         *                       const RGBQUAD *prgbq)
         * UINT GetDIBColorTable(HDC hdc, UINT iStart, UINT cEntries, RGBQUAD *prgbq)
         *
         * The colour table of the DIB section selected into the DC, changed in
         * place: a program draws with indices and sets what they mean later,
         * and what it sets is what its next blit shows. Both answer how many
         * entries they touched, which is none for a DC over anything else.
         */
        SetDIBColorTable: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hdc, start, count, quads])=>{
                const colors = colorTableOf(hdc);
                if (!colors || (quads >>> 0) === 0)
                {
                    return 0;
                }
                const first = start >>> 0;
                const wanted = Math.min(count >>> 0, Math.max(0, colors.length - first));
                readColorTable(quads >>> 0, wanted, 0, null).forEach((color, index)=>{
                    colors[first + index] = color;
                });
                return wanted;
            },
        },

        GetDIBColorTable: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hdc, start, count, quads])=>{
                const colors = colorTableOf(hdc);
                if (!colors || (quads >>> 0) === 0)
                {
                    return 0;
                }
                const first = start >>> 0;
                const wanted = Math.min(count >>> 0, Math.max(0, colors.length - first));
                const bytes = new Uint8Array(wanted * 4);
                for (let index = 0; index < wanted; index++)
                {
                    const color = colors[first + index];
                    bytes[index * 4] = color & 0xff;
                    bytes[index * 4 + 1] = (color >>> 8) & 0xff;
                    bytes[index * 4 + 2] = (color >>> 16) & 0xff;
                }
                host.writeMemory(quads >>> 0, bytes);
                return wanted;
            },
        },

        /**
         * HBITMAP CreateDIBitmap(HDC hdc, const BITMAPINFOHEADER *pbmih,
         *   DWORD flInit, const VOID *pjBits, const BITMAPINFO *pbmi, UINT iUsage)
         *
         * The bitmap it produces is device-dependent by name and a DIB by
         * construction, exactly as CreateDIBSection's is: one storage format
         * downstream means one code path, and a program cannot observe the
         * difference through any call this library offers.
         *
         * CBM_INIT copies the caller's rows in as they are, which is only
         * correct because the two formats are the same one -- the header the
         * bits were described by is the header the bitmap is created with.
         */
        CreateDIBitmap: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, infoHeader, init, bits])=>{
                const CBM_INIT = 4;
                const header = readBitmapInfoHeader(host, infoHeader);
                if (header.size < BITMAPINFOHEADER.SIZE
                    || (header.compression !== BI_RGB && header.compression !== BI_BITFIELDS)
                    || !BIT_COUNTS.has(header.bitCount)
                    || header.width <= 0 || header.height === 0)
                {
                    return 0;
                }
                const bytes = dibSize(header.width, header.height, header.bitCount);
                const address = host.surfaces.allocate(bytes);
                if ((init & CBM_INIT) !== 0 && (bits >>> 0) !== 0)
                {
                    host.writeMemory(address, host.readMemory(bits >>> 0, bytes));
                }
                return objects.create('bitmap', {
                    width: header.width,
                    height: Math.abs(header.height),
                    planes: 1,
                    bitCount: header.bitCount,
                    topDown: header.height < 0,
                    bits: address,
                    section: address,
                });
            },
        },

        /** HPALETTE CreatePalette(const LOGPALETTE *plpal) */
        CreatePalette: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([logpalette])=>{
                const palette = readLogPalette(host, logpalette);
                return palette.entries.length === 0 ? 0 : objects.create('palette', palette);
            },
        },

        /** COLORREF SetTextColor(HDC hdc, COLORREF color) */
        SetTextColor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, color])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return CLR_INVALID;
                }
                const previous = dc.textColor;
                dc.textColor = color >>> 0;
                return previous;
            },
        },

        /** COLORREF GetTextColor(HDC hdc) */
        GetTextColor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>dcOf(handle)?.textColor ?? CLR_INVALID,
        },

        /** COLORREF SetBkColor(HDC hdc, COLORREF color) */
        SetBkColor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, color])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return CLR_INVALID;
                }
                const previous = dc.bkColor;
                dc.bkColor = color >>> 0;
                return previous;
            },
        },

        /** COLORREF GetBkColor(HDC hdc) */
        GetBkColor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>dcOf(handle)?.bkColor ?? CLR_INVALID,
        },

        /** int SetBkMode(HDC hdc, int mode) */
        SetBkMode: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, mode])=>{
                const dc = dcOf(handle);
                if (!dc || ((mode | 0) !== TRANSPARENT && (mode | 0) !== OPAQUE))
                {
                    return 0;
                }
                const previous = dc.bkMode;
                dc.bkMode = mode | 0;
                return previous;
            },
        },

        /** int GetBkMode(HDC hdc) */
        GetBkMode: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>dcOf(handle)?.bkMode ?? 0,
        },

        /** int SetROP2(HDC hdc, int rop2) */
        SetROP2: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, rop2])=>{
                const dc = dcOf(handle);
                if (!dc || (rop2 | 0) < R2_BLACK || (rop2 | 0) > R2_WHITE)
                {
                    return 0;
                }
                const previous = dc.rop2;
                dc.rop2 = rop2 | 0;
                return previous;
            },
        },

        /** int GetROP2(HDC hdc) */
        GetROP2: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>dcOf(handle)?.rop2 ?? 0,
        },

        /**
         * int SetMapMode(HDC hdc, int iMode)
         *
         * The mode sets the extents it fixes -- one to one for MM_TEXT, the
         * device's inch against the mode's units for the fixed ones, with y
         * turned upwards; MM_ISOTROPIC starts from MM_LOMETRIC's and
         * MM_ANISOTROPIC keeps what was there -- so LPtoDP, DPtoLP and the
         * extent getters answer as the mode says. Drawing does not go through
         * the mapping yet: it draws in device units whatever the mode.
         */
        SetMapMode: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, mode])=>{
                const dc = dcOf(handle);
                if (!dc || (mode | 0) < MM_TEXT || (mode | 0) > MM_ANISOTROPIC)
                {
                    return 0;
                }
                const previous = dc.mapMode;
                dc.mapMode = mode | 0;
                const extents = extentsOf(mode | 0);
                if (extents)
                {
                    dc.windowExt = extents.windowExt;
                    dc.viewportExt = extents.viewportExt;
                }
                return previous;
            },
        },

        /** int GetMapMode(HDC hdc) */
        GetMapMode: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>dcOf(handle)?.mapMode ?? 0,
        },

        /** BOOL SetViewportOrgEx(HDC hdc, int x, int y, LPPOINT lppt) */
        SetViewportOrgEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>setOrigin(args, 'viewportOrg'),
        },

        /** BOOL LPtoDP(HDC hdc, LPPOINT lppt, int c) */
        LPtoDP: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: args=>convertPoints(args, true),
        },

        /** BOOL DPtoLP(HDC hdc, LPPOINT lppt, int c) */
        DPtoLP: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: args=>convertPoints(args, false),
        },

        /** BOOL OffsetWindowOrgEx(HDC hdc, int x, int y, LPPOINT lppt) */
        OffsetWindowOrgEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, x, y, out])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                if ((out >>> 0) !== 0)
                {
                    writePoint(host, out, dc.windowOrg);
                }
                dc.windowOrg = {
                    x: (dc.windowOrg.x | 0) + (x | 0), y: (dc.windowOrg.y | 0) + (y | 0),
                };
                return 1;
            },
        },

        /** BOOL SetWindowOrgEx(HDC hdc, int x, int y, LPPOINT lppt) */
        SetWindowOrgEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>setOrigin(args, 'windowOrg'),
        },

        /** BOOL SetViewportExtEx(HDC hdc, int x, int y, LPSIZE lpsz) */
        SetViewportExtEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>setExtent(args, 'viewportExt'),
        },

        /** BOOL SetWindowExtEx(HDC hdc, int x, int y, LPSIZE lpsz) */
        SetWindowExtEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>setExtent(args, 'windowExt'),
        },

        /** BOOL MoveToEx(HDC hdc, int x, int y, LPPOINT lppt) */
        MoveToEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>setOrigin(args, 'position'),
        },

        /**
         * Clipping and scaling a framework's device-context class wraps,
         * whether or not the program draws. A point is always visible and
         * the clip box is the whole surface (RectVisible, which reads the
         * clip, is with the drawing half); the scaled extents are the plain
         * ones, since the transform is not applied to anything; an escape is
         * a printer's, and there is no printer.
         *
         * BOOL PtVisible(HDC, int x, int y)
         * int GetClipBox(HDC, LPRECT)
         * BOOL ScaleViewportExtEx(HDC, int, int, int, int, LPSIZE)
         * BOOL ScaleWindowExtEx(HDC, int, int, int, int, LPSIZE)
         * int Escape(HDC, int, int, LPCSTR, LPVOID)
         */
        PtVisible: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle])=>(dcOf(handle) ? 1 : 0),
        },

        GetClipBox: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, rect])=>{
                const dc = dcOf(handle);
                if (!dc || (rect >>> 0) === 0)
                {
                    return REGION_ERROR;
                }
                const surface = surfaceOf(dc);
                writeU32s(host, rect >>> 0, [0, 0, surface.width, surface.height]);
                return SIMPLE_REGION;
            },
        },

        /**
         * BOOL GetViewportExtEx(HDC hdc, LPSIZE lpsize)
         * BOOL GetWindowExtEx(HDC hdc, LPSIZE lpsize)
         */
        GetViewportExtEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc || (out >>> 0) === 0)
                {
                    return 0;
                }
                writeSize(host, out >>> 0, dc.viewportExt);
                return 1;
            },
        },

        GetWindowExtEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc || (out >>> 0) === 0)
                {
                    return 0;
                }
                writeSize(host, out >>> 0, dc.windowExt);
                return 1;
            },
        },

        /**
         * A Windows metafile is a picture kept as recorded GDI calls, which a
         * program plays back to show a logo. Nothing here records or replays
         * one, so the handle is refused and the play fails: the caller draws
         * without the picture rather than with a handle that means nothing.
         *
         * HMETAFILE SetMetaFileBitsEx(UINT cbBuffer, const BYTE *lpData)
         * BOOL PlayMetaFile(HDC hdc, HMETAFILE hmf)
         * BOOL DeleteMetaFile(HMETAFILE hmf)
         */
        SetMetaFileBitsEx: {
            argBytes: 8,
            handler: ()=>0,
        },

        PlayMetaFile: {
            argBytes: 8,
            handler: ()=>0,
        },

        DeleteMetaFile: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * The font table here is fixed: a font file cannot be added to it,
         * and a scalable font resource cannot be written for one. Zero is the
         * documented failure of each, which an installer notes and moves on
         * from -- the file itself was already copied. Every spelling answers
         * the same way, the private and in-memory ones included, and nothing
         * can be removed that was never added.
         *
         * int AddFontResourceA(LPCSTR lpszFilename)
         * int AddFontResourceW(LPCWSTR lpszFilename)
         * int AddFontResourceExA(LPCSTR name, DWORD fl, PVOID res)
         * int AddFontResourceExW(LPCWSTR name, DWORD fl, PVOID res)
         * HANDLE AddFontMemResourceEx(PVOID pFileView, DWORD cjSize, PVOID pvResrved,
         *                             DWORD *pNumFonts)
         * BOOL RemoveFontResourceA(LPCSTR lpFileName)
         * BOOL RemoveFontResourceW(LPCWSTR lpFileName)
         * BOOL RemoveFontResourceExA(LPCSTR name, DWORD fl, PVOID pdv)
         * BOOL RemoveFontResourceExW(LPCWSTR name, DWORD fl, PVOID pdv)
         * BOOL RemoveFontMemResourceEx(HANDLE h)
         * BOOL CreateScalableFontResourceA(DWORD fdwHidden, LPCSTR lpszFontRes,
         *                                  LPCSTR lpszFontFile, LPCSTR lpszCurrentPath)
         */
        AddFontResourceA: { argBytes: 4, handler: ()=>0 },
        AddFontResourceW: { argBytes: 4, handler: ()=>0 },
        AddFontResourceExA: { argBytes: 12, handler: ()=>0 },
        AddFontResourceExW: { argBytes: 12, handler: ()=>0 },
        AddFontMemResourceEx: { argBytes: 16, handler: ()=>0 },
        RemoveFontResourceA: { argBytes: 4, handler: ()=>0 },
        RemoveFontResourceW: { argBytes: 4, handler: ()=>0 },
        RemoveFontResourceExA: { argBytes: 12, handler: ()=>0 },
        RemoveFontResourceExW: { argBytes: 12, handler: ()=>0 },
        RemoveFontMemResourceEx: { argBytes: 4, handler: ()=>0 },

        CreateScalableFontResourceA: {
            argBytes: 16,
            handler: ()=>0,
        },

        /**
         * UINT GetTextCharset(HDC hdc)
         * UINT GetTextCharsetInfo(HDC hdc, LPFONTSIGNATURE lpSig, DWORD dwFlags)
         *
         * The character set of the font the DC has selected, as its
         * TEXTMETRIC reports it, and DEFAULT_CHARSET for a handle that is
         * not a DC, which is the documented failure. A signature is asked
         * for only of a TrueType font; these faces are not ones a program can
         * read tables out of, and TEXTMETRIC says as much, so the signature
         * is the zeros the documentation gives any other font.
         */
        GetTextCharset: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                return dc ? currentMetrics(dc).charSet : DEFAULT_CHARSET;
            },
        },

        GetTextCharsetInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, signature])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return DEFAULT_CHARSET;
                }
                if ((signature >>> 0) !== 0)
                {
                    host.writeMemory(signature >>> 0, new Uint8Array(FONTSIGNATURE_SIZE));
                }
                return currentMetrics(dc).charSet;
            },
        },

        /**
         * DWORD GetFontLanguageInfo(HDC hdc)
         *
         * Zero, a font "treated as a simple Latin font", unless its character
         * set says otherwise: a double-byte set is GCP_DBCS, and Hebrew and
         * Arabic are read in an order that GCP_REORDER announces. No kerning
         * table or extra glyph tables are exposed here, so nothing claims
         * them. GCP_ERROR for a handle that is not a DC.
         */
        GetFontLanguageInfo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return GCP_ERROR;
                }
                const charSet = currentMetrics(dc).charSet;
                if (DBCS_CHARSETS.has(charSet))
                {
                    return GCP_DBCS;
                }
                return charSet === HEBREW_CHARSET || charSet === ARABIC_CHARSET ? GCP_REORDER : 0;
            },
        },

        ScaleViewportExtEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, , , , , out])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                if ((out >>> 0) !== 0)
                {
                    writeSize(host, out >>> 0, dc.viewportExt);
                }
                return 1;
            },
        },

        ScaleWindowExtEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, , , , , out])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                if ((out >>> 0) !== 0)
                {
                    writeSize(host, out >>> 0, dc.windowExt);
                }
                return 1;
            },
        },

        Escape: { argBytes: 20, handler: ()=>0 },

        /** int GetDeviceCaps(HDC hdc, int index) */
        GetDeviceCaps: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, index])=>{
                const dc = dcOf(handle);
                return dc ? deviceCaps(dc, index) : 0;
            },
        },

        /** BOOL GetTextMetricsW(HDC hdc, LPTEXTMETRICW lptm) */
        GetTextMetricsW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc || (out >>> 0) === 0)
                {
                    return 0;
                }
                writeTextMetricsW(host, out, currentMetrics(dc));
                return 1;
            },
        },

        /** BOOL GetTextExtentPoint32W(HDC hdc, LPCWSTR lpString, int c, LPSIZE psizl) */
        GetTextExtentPoint32W: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, string, count, out])=>{
                const dc = dcOf(handle);
                if (!dc || (count | 0) < 0)
                {
                    return 0;
                }
                const text = (string >>> 0) === 0 ? '' : wideText(string, count | 0, true);
                writeSize(host, out, { cx: widthOf(dc, text), cy: currentMetrics(dc).height });
                return 1;
            },
        },

        /** BOOL GetCharWidth32W(HDC hdc, UINT iFirst, UINT iLast, LPINT lpBuffer) */
        GetCharWidth32W: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, first, last, out])=>
                writeWidths(handle, first >>> 0, last >>> 0, out, 4, width=>[width], 0xffff),
        },

        /**
         * BOOL GetCharABCWidthsA(HDC hdc, UINT wFirst, UINT wLast, LPABC lpABC)
         *
         * Each character's own advance, measured as GetCharWidth measures it,
         * as the black box, with no bearing either side: real bearings need
         * a rasterised glyph, and text laid out against these widths stays
         * consistent with what is drawn and with every other measurement.
         */
        GetCharABCWidthsA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, first, last, out])=>
                writeWidths(handle, first >>> 0, last >>> 0, out, ABC_SIZE,
                    width=>[0, width, 0], 0xff),
        },

        /** BOOL GetCharABCWidthsW(HDC hdc, UINT wFirst, UINT wLast, LPABC lpABC) */
        GetCharABCWidthsW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, first, last, out])=>
                writeWidths(handle, first >>> 0, last >>> 0, out, ABC_SIZE,
                    width=>[0, width, 0], 0xffff),
        },

        /** BOOL GetTextMetricsA(HDC hdc, LPTEXTMETRICA lptm) */
        GetTextMetricsA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                writeTextMetrics(host, out, currentMetrics(dc));
                return 1;
            },
        },

        /**
         * BOOL GetTextExtentPoint32A(HDC hdc, LPCSTR lpString, int c, LPSIZE psizl)
         *
         * The count is authoritative and the string need not be terminated,
         * as with TextOut.
         */
        GetTextExtentPoint32A: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, string, count, out])=>{
                const dc = dcOf(handle);
                if (!dc || (count | 0) < 0)
                {
                    return 0;
                }
                const text = (string >>> 0) === 0 || (count | 0) === 0
                    ? ''
                    : String.fromCharCode(...host.readMemory(string >>> 0, count | 0));
                writeSize(host, out, { cx: widthOf(dc, text), cy: currentMetrics(dc).height });
                return 1;
            },
        },

        /**
         * BOOL GetCharWidth32A(HDC hdc, UINT iFirst, UINT iLast, LPINT lpBuffer)
         *
         * One advance per character of the range, in the context's font.
         * GetCharWidthA is the same call under its older name.
         */
        GetCharWidth32A: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, first, last, out])=>
                writeWidths(handle, first >>> 0, last >>> 0, out, 4, width=>[width], 0xff),
        },
    };

    // The older name for the same call: the same arguments, the same
    // SIZE written, and an installer's engine measures with it.
    const aliased = {
        ...table,
        GetTextExtentPointA: table.GetTextExtentPoint32A,
        GetCharWidthA: table.GetCharWidth32A,
        GetTextExtentPointW: table.GetTextExtentPoint32W,
        GetCharWidthW: table.GetCharWidth32W,
    };

    /**
     * The character cell dialogs are laid out against in a font: the
     * average width of the alphabet in both cases, as the dialog manager
     * measures it, and the font's height. Null without an engine, when the
     * layout keeps the cell its estimate was made for, and for a handle
     * that is not a font.
     *
     * @param {number} handle
     * @returns {{ width: number, height: number } | null}
     */
    const fontUnitsOf = handle=>{
        const record = objects.get(handle);
        if (record?.type !== 'font')
        {
            return null;
        }
        const measured = host.graphics?.fontMetrics?.(record.attributes);
        if (!measured)
        {
            return null;
        }
        const alphabet = host.graphics?.textWidth?.(record.attributes, ALPHABET)
            ?? ALPHABET.length * measured.aveCharWidth;
        return {
            width: Math.floor((Math.floor(alphabet / 26) + 1) / 2),
            height: measured.height,
        };
    };

    return {
        table: aliased,

        /**
         * The rectangle a region object holds, or null for a handle that is
         * not a region: what user32 reads when a program names an area to
         * repaint by a region rather than by a rectangle.
         *
         * @param {number} handle
         * @returns {{ left: number, top: number, right: number, bottom: number } | null}
         */
        regionBox(handle){
            const record = objects.get(handle >>> 0);
            return record && record.type === 'region' ? { ...record.attributes } : null;
        },

        /**
         * Makes a region object the caller owns hold a rectangle, as
         * GetUpdateRgn fills in the region it is handed.
         *
         * @param {number} handle
         * @param {{ left: number, top: number, right: number, bottom: number }} rect
         * @returns {boolean} false for a handle that is not a region
         */
        setRegion(handle, rect){
            const record = objects.get(handle >>> 0);
            if (!record || record.type !== 'region')
            {
                return false;
            }
            record.attributes = { left: rect.left, top: rect.top, right: rect.right,
                bottom: rect.bottom };
            return true;
        },

        /**
         * A device context over a window, told where on the screen the window's
         * client area is. That rectangle is what the context is bound to when
         * it first draws; a context made without one draws on the whole screen,
         * which is what GetDC(NULL) means.
         *
         * @param {number} hwnd
         * @param {{ left: number, top: number, right: number, bottom: number } | null} bounds
         * @returns {number} A device context handle.
         */
        windowContext(hwnd, bounds){
            const dc = createContext(hwnd >>> 0, 'window');
            dc.bounds = bounds;
            return dc.hdc;
        },

        /**
         * Drawing for the window manager: the frames, captions and controls
         * it paints itself, through the same engine and the same contexts a
         * program draws with, and with strings that never lived in guest
         * memory. Every call answers false when the context has no pixels.
         */
        draw: {
            solidBrush,

            /**
             * @param {number} hdc
             * @param {{ left: number, top: number, right: number, bottom: number }} rect
             * @param {number} color  A COLORREF.
             */
            fill: (hdc, rect, color)=>
                drawing.bound(hdc)?.fillRect(hdc >>> 0, rect, solidBrush(color)) === true,

            /**
             * A fill of the window manager's own background: the screen's
             * desktop colour, laid down before any window is on it.
             *
             * Painted and not shown. A draw the program makes is a frame, and
             * a draw the manager makes of its own background is not: showing
             * it handed a display a blank screen as if it were the program's
             * first frame, which is the frame a launcher stops waiting on.
             *
             * @param {number} hdc
             * @param {{ left: number, top: number, right: number, bottom: number }} rect
             * @param {number} color  A COLORREF.
             */
            fillBackground: (hdc, rect, color)=>
                drawing.bound(hdc, false)?.fillRect(hdc >>> 0, rect, solidBrush(color)) === true,

            /**
             * @param {number} hdc
             * @param {{ left: number, top: number, right: number, bottom: number }} rect
             * @param {number} brush  A brush handle the program owns.
             */
            fillWith: (hdc, rect, brush)=>
                drawing.bound(hdc)?.fillRect(hdc >>> 0, rect, brush >>> 0) === true,

            /**
             * @param {number} hdc
             * @param {{ left: number, top: number, right: number, bottom: number }} rect
             * @param {number} brush
             */
            frame: (hdc, rect, brush)=>
                drawing.bound(hdc)?.frameRect(hdc >>> 0, rect, brush >>> 0) === true,

            /**
             * @param {number} hdc
             * @param {{ left: number, top: number, right: number, bottom: number }} rect
             */
            invert: (hdc, rect)=>drawing.bound(hdc)?.invertRect(hdc >>> 0, rect) === true,

            /**
             * Narrows what a context draws in to a rectangle, in its own
             * coordinates: the update area a paint is limited to.
             *
             * @param {number} hdc
             * @param {{ left: number, top: number, right: number, bottom: number }} rect
             */
            clip(hdc, rect){
                const dc = dcOf(hdc);
                if (!dc)
                {
                    return false;
                }
                dc.clip = { ...rect };
                return drawing.bound(hdc)?.setClipRect(hdc >>> 0, rect) === true;
            },

            /** The colour a context draws text in. @param {number} hdc */
            textColor: hdc=>(dcOf(hdc)?.textColor ?? 0) >>> 0,

            /**
             * Whether a context's text is drawn over its background colour,
             * OPAQUE, or over what is there, TRANSPARENT: what a parent left
             * with SetBkMode on WM_CTLCOLOR*. A new context's is OPAQUE.
             *
             * @param {number} hdc
             */
            bkMode: hdc=>dcOf(hdc)?.bkMode ?? OPAQUE,

            /** The colour a context's text is drawn over. @param {number} hdc */
            bkColor: hdc=>(dcOf(hdc)?.bkColor ?? WHITE) >>> 0,

            /**
             * The colours the default procedure gives a control's context,
             * as SetTextColor and SetBkColor would: each answers the colour
             * it replaced.
             *
             * @param {number} hdc @param {number} color
             */
            setTextColor: (hdc, color)=>table.SetTextColor.handler([hdc, color]),

            /** @param {number} hdc @param {number} color */
            setBkColor: (hdc, color)=>table.SetBkColor.handler([hdc, color]),

            /**
             * Text at a point, over whatever is there, clipped to a rectangle
             * when one is given. The context's own colour and mode are put
             * back afterwards: this is the window manager drawing, not the
             * program changing its context. A program's own DrawText keeps
             * the mode the program set.
             *
             * @param {number} hdc @param {number} x @param {number} y @param {string} text
             * @param {{ color?: number, clip?: { left: number, top: number,
             *     right: number, bottom: number } | null, transparent?: boolean }} [options]
             */
            text(hdc, x, y, text, options = {}){
                const dc = dcOf(hdc);
                const interfaces = drawing.bound(hdc);
                if (!dc || !interfaces)
                {
                    return false;
                }
                const { textColor, bkMode, textAlign } = dc;
                dc.textColor = (options.color ?? dc.textColor) >>> 0;
                dc.bkMode = options.transparent === false ? bkMode : TRANSPARENT;
                dc.textAlign = 0;
                interfaces.setTextAlign(hdc >>> 0, 0);
                const drawn = interfaces.extTextOutA(hdc >>> 0, x | 0, y | 0,
                    options.clip ? ETO_CLIPPED : 0, options.clip ?? null, text);
                dc.textColor = textColor;
                dc.bkMode = bkMode;
                dc.textAlign = textAlign;
                interfaces.setTextAlign(hdc >>> 0, textAlign);
                return drawn;
            },

            /**
             * How much room a string takes in the context's font.
             *
             * @param {number} hdc @param {string} text
             * @returns {{ width: number, height: number, ascent: number }}
             */
            measure(hdc, text){
                const dc = dcOf(hdc) ?? { font: 0 };
                const metrics = currentMetrics(dc);
                return { width: widthOf(dc, text), height: metrics.height, ascent: metrics.ascent };
            },

            /**
             * The character cell dialogs are laid out against: the system
             * font's average width and height, as the font engine measures
             * them. Null without an engine, when the layout keeps the cell
             * its estimate was made for.
             *
             * @returns {{ width: number, height: number } | null}
             */
            baseUnits: ()=>fontUnitsOf(stockObject(SYSTEM_FONT)),

            /**
             * The character cell a dialog set in a font is laid out
             * against. Null without an engine or for a handle that is not a
             * font.
             *
             * @param {number} handle
             */
            fontUnits: handle=>fontUnitsOf(handle),

            /**
             * A font of the window manager's own -- a dialog's -- from the
             * point size and face a template names: the point size becomes
             * a character height at the display's logical resolution.
             *
             * @param {{ pointSize: number, faceName: string, weight: number,
             *     italic: number, charSet: number }} fields
             * @returns {number} the handle
             */
            createFont: fields=>objects.create('font', logFont({
                height: -Math.round(fields.pointSize * LOGICAL_DPI / POINTS_PER_INCH),
                weight: fields.weight | 0,
                italic: fields.italic & 0xff,
                charSet: fields.charSet & 0xff,
                faceName: fields.faceName,
            })),

            /** @param {number} handle */
            deleteFont: handle=>table.DeleteObject.handler([handle]) === 1,

            /**
             * Selects a font into a context, as a control does before it
             * paints in the font it was given.
             *
             * @param {number} hdc @param {number} font
             */
            selectFont(hdc, font){
                const dc = dcOf(hdc);
                return dc ? select(dc, font >>> 0) !== 0 : false;
            },

            /**
             * A bitmap the program owns, drawn at a point, or nothing when it
             * has no pixels this layer can reach.
             *
             * @param {number} hdc @param {number} x @param {number} y @param {number} bitmap
             */
            bitmap(hdc, x, y, bitmap){
                const record = objects.get(bitmap);
                const shape = record?.type === 'bitmap' ? record.attributes : null;
                if (!shape || (!shape.bits && !shape.pixels))
                {
                    return false;
                }
                return lend(bitmap, source=>table.BitBlt.handler([hdc >>> 0, x | 0, y | 0,
                    shape.width | 0, shape.height | 0, source, 0, 0, SRCCOPY]) === 1);
            },
        },

        /**
         * A device context over memory somebody else owns.
         *
         * This is how a drawing surface that is not GDI's own becomes something
         * GDI can draw into: the caller says where the pixels are in guest
         * memory and how they are laid out, and gets back a memory DC whose
         * selected bitmap addresses exactly those bytes. Every subsequent draw
         * lands in the caller's surface rather than in a copy of it -- which is
         * the whole point, because a program gets a DC on a surface, draws with
         * GDI, and expects to see the result when it presents.
         *
         * Refused rather than approximated when the row stride is not the one
         * GDI would compute for that width and depth: drawing with the wrong
         * stride shears the picture by a pixel per row, which reads as a
         * corrupted image rather than as a rejected call.
         *
         * @param {{ width: number, height: number, pitch: number,
         *           bitCount: number, bits: number, palette?: number[] | null,
         *           format?: string }} attributes
         * @returns {number} A device context handle, or zero.
         */
        createSurfaceDc(attributes){
            const { width, height, pitch, bitCount, bits, palette, format } = attributes;
            // An indexed surface without its palette has no colours at all, and
            // a drawing routine given one would have to invent them. The three
            // depths are what a surface of this era actually is.
            if (!(width > 0) || !(height > 0) || (bits >>> 0) === 0
                || !SURFACE_DC_DEPTHS.has(bitCount)
                || (bitCount === 8 && !palette)
                || pitch !== dibSize(width, 1, bitCount))
            {
                return 0;
            }
            const dc = createContext(0, 'memory');
            dc.defaultBitmap = objects.create('bitmap', {
                width,
                height,
                planes: 1,
                bitCount,
                // Top-down, because a surface's first row is its top one.
                // A DIB counted the other way would draw the image inverted.
                topDown: true,
                bits: bits >>> 0,
                section: bits >>> 0,
                palette,
                format,
            });
            select(dc, dc.defaultBitmap);
            return dc.hdc;
        },

        /** @param {number} handle */
        deleteSurfaceDc(handle){
            return table.DeleteDC.handler([handle]) === 1;
        },

        /**
         * What a device context draws on, for the pixel-format negotiation
         * that OPENGL32 keeps. A window's contexts all name the window, so a
         * format set on one DC is found by the next DC of the same window --
         * which is where Windows keeps it, and how a program that releases
         * and reacquires its DC still has its format. Any other context is
         * its own drawable.
         *
         * @param {number} hdc
         * @returns {{ key: string, width: number, height: number } | null}
         */
        describeDrawable(hdc){
            const dc = contexts.get(hdc >>> 0);
            if (!dc)
            {
                return null;
            }
            const bounds = dc.bounds;
            const size = bounds
                ? { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }
                : surfaceOf(dc);
            const own = dc.kind === 'window' && dc.window !== 0;
            return {
                key: own ? `window:${dc.window}` : `dc:${dc.hdc}`,
                width: size.width,
                height: size.height,
            };
        },
    };
}
