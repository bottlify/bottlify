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
    readBitmapInfoHeader,
    readLogBrush,
    readLogFont,
    readLogPalette,
    readLogPen,
    writePoint,
    writeSize,
    writeTextMetrics,
    writeU32s,
} from './structs.js';

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
const MM_TEXT = 1;
const MM_ISOTROPIC = 7;
const MM_ANISOTROPIC = 8;

/** The two modes in which the program, not the mode, decides the extents. */
const SCALABLE_MAP_MODES = new Set([MM_ISOTROPIC, MM_ANISOTROPIC]);

/** What a function that should have returned a COLORREF says when it failed. */
const CLR_INVALID = 0xffffffff;

const WHITE = 0x00ffffff;
const LTGRAY = 0x00c0c0c0;
const GRAY = 0x00808080;
const DKGRAY = 0x00404040;
const BLACK = 0x00000000;

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

/** Bit depths a bitmap can have. Anything else is not a format GDI knows. */
const BIT_COUNTS = new Set([1, 4, 8, 16, 24, 32]);

/** BITMAPINFOHEADER compressions a DIB section can be backed by plain memory. */
const BI_RGB = 0;
const BI_BITFIELDS = 3;

/**
 * Font metrics with no font engine behind them.
 *
 * These are estimates, and they stay estimates until there is a rasteriser to
 * measure a real face with. They are chosen so that the numbers a program
 * divides by are self-consistent -- ascent plus descent is the cell height, a
 * string is its length times the average width -- because a layout that adds up
 * is what code depends on, far more than the exact numbers. Every face is
 * treated as fixed-pitch for the same reason.
 */
const DEFAULT_EM_HEIGHT = 13;
const INTERNAL_LEADING_RATIO = 0.2;
const DESCENT_RATIO = 0.25;
const WIDTH_RATIO = 0.5;

/** FW_NORMAL, which a LOGFONT weight of zero means. */
const FW_NORMAL = 400;

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
     * @param {'window' | 'memory'} kind
     */
    const createContext = (window, kind)=>{
        const dc = {
            hdc: 0,
            window,
            kind,
            /** The bitmap a memory DC brought with it, and takes away again. */
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
        // The one-pixel bitmap a memory DC starts with is the DC's own, not the
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
            // a display DC already draws to the screen.
            if (dc.kind !== 'memory' || record.selectCount > 0)
            {
                return 0;
            }
        }
        const previous = dc[record.type];
        objects.retain(handle);
        objects.release(previous);
        dc[record.type] = handle;
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
     * The estimated metrics of a font. See the ratios above for what "estimated"
     * means here.
     *
     * @param {import('./structs.js').LogFontFields} font
     * @returns {import('./structs.js').TextMetricFields}
     */
    const metricsOf = font=>{
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
            charSet: font.charSet,
        };
    };

    /** @param {any} dc @returns {import('./structs.js').TextMetricFields} */
    const currentMetrics = dc=>{
        const font = objects.get(dc.font);
        return metricsOf(font ? font.attributes : logFont({}));
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

    const table = {
        ...createDrawingFunctions({ host, objects, dcOf, surfaceOf, currentMetrics }),

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
                dc.defaultBitmap = objects.create('bitmap', {
                    width: 1, height: 1, planes: 1, bitCount: 1, bits: 0, section: 0,
                });
                select(dc, dc.defaultBitmap);
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
                if (!dc || dc.kind !== 'memory')
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
                return objects.create('brush', fields);
            },
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
                // Documented exactly: a zero extent yields a one-pixel monochrome
                // bitmap rather than a failure.
                const empty = (cx | 0) <= 0 || (cy | 0) <= 0;
                return objects.create('bitmap', {
                    width: empty ? 1 : cx | 0,
                    height: empty ? 1 : cy | 0,
                    planes: 1,
                    bitCount: empty ? 1 : surfaceOf(dc).bitCount,
                    // The bits arrive with whoever draws into them; this half only
                    // decides what shape they have to be.
                    bits: 0,
                    section: 0,
                });
            },
        },

        /** HBITMAP CreateBitmap(int nWidth, int nHeight, UINT nPlanes, UINT nBitCount, const VOID *lpBits) */
        CreateBitmap: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([width, height, planes, bitCount, bits])=>{
                if ((width | 0) <= 0 || (height | 0) <= 0 || (planes >>> 0) === 0)
                {
                    return 0;
                }
                if (!BIT_COUNTS.has((planes >>> 0) * (bitCount >>> 0)))
                {
                    return 0;
                }
                return objects.create('bitmap', {
                    width: width | 0,
                    height: height | 0,
                    planes: planes >>> 0,
                    bitCount: bitCount >>> 0,
                    // The initial bits belong to the caller, who is free to reuse
                    // the buffer the moment this returns; nothing is read from it
                    // until there is something to read it into.
                    bits: bits >>> 0,
                    section: 0,
                });
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
            handler: ([, info, usage, bitsOut, section])=>{
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
                });
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
         * The mode is remembered, not applied: what a mapping mode does is turn
         * logical coordinates into device ones, and there is nothing here that
         * consumes a coordinate. The transform belongs with the drawing.
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

        /** int GetDeviceCaps(HDC hdc, int index) */
        GetDeviceCaps: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, index])=>{
                const dc = dcOf(handle);
                return dc ? deviceCaps(dc, index) : 0;
            },
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
         * The string is not read: every face is fixed-pitch here, so the extent
         * depends on how many characters there are and not on which ones.
         */
        GetTextExtentPoint32A: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, , count, out])=>{
                const dc = dcOf(handle);
                if (!dc || (count | 0) < 0)
                {
                    return 0;
                }
                const metrics = currentMetrics(dc);
                writeSize(host, out, {
                    cx: (count | 0) * metrics.aveCharWidth,
                    cy: metrics.height,
                });
                return 1;
            },
        },
    };

    return {
        table,

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
         *           bitCount: number, bits: number }} attributes
         * @returns {number} A device context handle, or zero.
         */
        createSurfaceDc(attributes){
            const { width, height, pitch, bitCount, bits } = attributes;
            if (!(width > 0) || !(height > 0) || (bits >>> 0) === 0
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
            });
            select(dc, dc.defaultBitmap);
            return dc.hdc;
        },

        /** @param {number} handle */
        deleteSurfaceDc(handle){
            return table.DeleteDC.handler([handle]) === 1;
        },
    };
}
