/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Painting, and the device contexts a window is painted through.
 *
 * The update region is the whole of why these calls exist as a set rather than
 * as convenience wrappers. A window becomes dirty, WM_PAINT is delivered
 * because it is dirty, and BeginPaint is what makes it clean again. A program
 * that never reaches BeginPaint, or one whose BeginPaint does not clear the
 * region, gets WM_PAINT for as long as it runs -- the loop looks like a hang
 * and has nothing to do with drawing.
 *
 * An update region is the window's own: invalidating one window never marks
 * another, apart from its children by the RedrawWindow rules (RDW_ALLCHILDREN,
 * or a parent without WS_CLIPCHILDREN). Every window paints through a context
 * clipped to what of it is seen, so a window below repainting cannot reach the
 * one above it, and nothing above has to paint again after it. The region is
 * kept as rectangles that do not overlap, in client coordinates (`updateArea`),
 * with their bounding rectangle beside it (`updateRect`) for GetUpdateRect,
 * rcPaint and the many places that only ask whether there is anything to paint.
 *
 * Where the pixels go is not decided here. A DC comes from whoever owns them,
 * handed in as a service, because this layer may not reach the graphics layer:
 * `graphics` declares `win32` in its requires, so an import the other way would
 * close a cycle the boundary check refuses. Without that service a DC cannot be
 * made, and these calls say so by failing rather than by handing back a handle
 * that draws nowhere.
 */

import { PAINTSTRUCT, RECT, readRect, writeRect, writeU32s } from './structs.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { readText } from './unicode.js';
import { boundsOf, intersectArea, subtractFromArea } from '../gdi32/rects.js';
import { areaOf } from '../gdi32/regions.js';

/** DrawText's flags. */
const DT_CENTER = 0x0001;
const DT_RIGHT = 0x0002;
const DT_VCENTER = 0x0004;
const DT_BOTTOM = 0x0008;
const DT_WORDBREAK = 0x0010;
const DT_SINGLELINE = 0x0020;
const DT_CALCRECT = 0x0400;
const DT_NOPREFIX = 0x0800;

/** RedrawWindow's flags, the ones with an effect on an update region. */
const RDW_NOCHILDREN = 0x0040;
const RDW_ALLCHILDREN = 0x0080;
const RDW_INVALIDATE = 0x0001;
const RDW_ERASE = 0x0004;
const RDW_VALIDATE = 0x0008;
const RDW_UPDATENOW = 0x0100;
const RDW_FRAME = 0x0400;
const RDW_INTERNALPAINT = 0x0002;
const RDW_NOINTERNALPAINT = 0x0010;
const RDW_NOERASE = 0x0020;
const RDW_ERASENOW = 0x0200;
const RDW_NOFRAME = 0x0800;

/** The styles that decide what a window's painting covers. */
const WS_CLIPCHILDREN = 0x02000000;
const WS_EX_TRANSPARENT = 0x00000020;

/** What BeginPaint sends before the program draws. */
const WM_NCPAINT = 0x0085;
const WM_ERASEBKGND = 0x0014;

/** DrawEdge's edges and borders, and the system colours they are drawn in. */
const BDR_RAISEDOUTER = 0x1;
const BDR_SUNKENOUTER = 0x2;
const BDR_RAISEDINNER = 0x4;
const BDR_SUNKENINNER = 0x8;
const EDGE_RAISED = BDR_RAISEDOUTER | BDR_RAISEDINNER;
const EDGE_SUNKEN = BDR_SUNKENOUTER | BDR_SUNKENINNER;
const BF_LEFT = 0x1;
const BF_TOP = 0x2;
const BF_RIGHT = 0x4;
const BF_BOTTOM = 0x8;
const BF_RECT = BF_LEFT | BF_TOP | BF_RIGHT | BF_BOTTOM;
const BF_MIDDLE = 0x800;
const BF_ADJUST = 0x2000;
const COLOR_WINDOW = 5;
const COLOR_WINDOWTEXT = 8;
const COLOR_3DFACE = 15;
const COLOR_3DSHADOW = 16;
const COLOR_GRAYTEXT = 17;
const COLOR_3DHILIGHT = 20;
const COLOR_3DDKSHADOW = 21;

/**
 * The check mark, the radio dot and the radio ring as pixel rows: what the
 * classic controls draw, at the size they draw it. Data rather than geometry
 * because a thirteen-pixel circle is not a circle by any formula.
 */
export const CHECK_MARK = [
    '......#',
    '.....##',
    '#...###',
    '##.###.',
    '#####..',
    '.###...',
    '..#....',
];
export const RADIO_RING_DARK = [
    '....####....',
    '..##....##..',
    '.#........#.',
    '.#..........',
    '#...........',
    '#...........',
    '#...........',
    '#...........',
    '.#..........',
    '.#..........',
    '............',
    '............',
];
export const RADIO_RING_LIGHT = [
    '............',
    '............',
    '..........#.',
    '..........#.',
    '...........#',
    '...........#',
    '...........#',
    '...........#',
    '..........#.',
    '.#........#.',
    '..##....##..',
    '....####....',
];
export const RADIO_DOT = [
    '.##.',
    '####',
    '####',
    '.##.',
];

/** A tab with no stops given is this many average characters. */
const TAB_CHARACTERS = 8;
/** The most tab stops read out of a caller's array. */
const MAX_TAB_STOPS = 1024;

/** What a character cell measures when nothing better is known. */
const ESTIMATED_CHAR_WIDTH = 8;
const ESTIMATED_LINE_HEIGHT = 16;
const ERROR_INVALID_HANDLE = 6;
/** Class styles: each window a context of its own, or the class one for all its windows. */
const CS_OWNDC = 0x0020;
const CS_CLASSDC = 0x0040;
/** GetDCEx: a context from the cache whatever the class says; and its region's two uses. */
const DCX_CACHE = 0x0002;
const DCX_EXCLUDERGN = 0x0040;
const DCX_INTERSECTRGN = 0x0080;

/** @typedef {{ hdc: number, rect: Rect, erase: boolean }} PaintStarted */

/**
 * @typedef {Object} HeldContext
 * @property {any} record  The window it is on.
 * @property {boolean} whole  The whole window's, frame included.
 * @property {Rect[] | null} limit  The part a paint limits it to.
 * @property {number} revision  The layout revision its clip was worked out under.
 * @property {'cache' | 'own' | 'class'} kind  Made for one GetDC, or kept.
 * @property {{ handle: number, exclude: boolean } | null} region
 *           GetDCEx's region, taken out of what it draws in or kept to.
 */

/**
 * @typedef {Object} PaintHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} [setLastError]
 * @property {(region: number) => (Rect & { rects?: Rect[] }) | null} [regionBox]
 *           The rectangle a region object holds, and its rectangles when it is
 *           more than one; null for a handle that is not one: gdi32's, reached
 *           the same way `setRegion` is.
 * @property {(region: number) => void} [deleteRegion]
 *           Deletes a region the system took from GetDCEx, once the context
 *           it was given to is done with it.
 * @property {(region: number, rect: any) => void} [setRegion]
 *           Fills in a region object the caller owns. It belongs to gdi32's
 *           table, which this layer cannot reach, so it arrives as a service or
 *           not at all.
 * @property {() => any} [dc]
 *           The device-context service, when the build has one: `get(hwnd,
 *           bounds)` makes a DC for a window over the screen rectangle given,
 *           `release(hwnd, hdc)` gives it back. Absent in a build that cannot draw.
 * @property {any} [draw]
 *           The window manager's own drawing, over a DC: fills, text and the
 *           measure of the selected font. Absent with `dc`.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that answers other than Windows would says so.
 * @property {() => unknown} [callerThread]
 *           Whose call is being handled, read before anything is awaited.
 * @property {(handle: number) => import('./cursors.js').CursorPicture | null} [picture]
 *           The picture an icon handle stands for, or null for one that has
 *           none this build can read.
 */

/**
 * The cell text is laid out on, and the measure of a string in the same
 * font when the build has one: without it every character is one cell.
 *
 * @typedef {Object} TextCell
 * @property {number} cellWidth
 * @property {number} cellHeight
 * @property {(text: string) => number} [width]
 */

/**
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * @typedef {Object} LaidOutLine
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number | null} underline   The character to underline, for a mnemonic.
 */

/** @param {any} rect */
const isEmpty = rect=>rect.right <= rect.left || rect.bottom <= rect.top;

/**
 * Past this many rectangles an update region is kept as the one around them:
 * repainting a little more of the window's own area is a cost, while a region
 * that grew without bound would be paid for at every invalidation.
 */
const MOST_UPDATE_PIECES = 64;

/**
 * An area with a rectangle added, still in pieces that do not overlap: only
 * the part of the rectangle not already in it is added, so invalidating an
 * area already invalid -- a control made inside a dialog still to paint --
 * leaves the pieces as they were.
 *
 * @param {Rect[]} area @param {Rect} rect @returns {Rect[]}
 */
export const addToArea = (area, rect)=>(isEmpty(rect)
    ? area : [...area, ...area.reduce(subtractFromArea, [rect])]);

/** @param {Rect[]} area @param {Rect[]} more @returns {Rect[]} */
export const unionAreas = (area, more)=>more.reduce(addToArea, area);

/** @param {Rect[]} area @param {Rect[]} taken @returns {Rect[]} */
export const subtractAreas = (area, taken)=>taken.reduce(subtractFromArea, area);

/** @param {Rect[]} a @param {Rect[]} b @returns {Rect[]} the pixels in both */
export const intersectAreas = (a, b)=>a.flatMap(piece=>intersectArea(b, piece));

/** @param {Rect[]} area @param {number} dx @param {number} dy @returns {Rect[]} */
export const offsetArea = (area, dx, dy)=>area.map(piece=>({ left: piece.left + dx,
    top: piece.top + dy, right: piece.right + dx, bottom: piece.bottom + dy }));

/**
 * A rectangle a program passed with its corners swapped, put the right way
 * round, as RedrawWindow and InvalidateRect take it (user32's msg.c,
 * test_paint_messages: {21,12,7,30} invalidates {7,12,21,30}).
 *
 * @param {Rect} rect @returns {Rect}
 */
export const ordered = rect=>({ left: Math.min(rect.left, rect.right),
    top: Math.min(rect.top, rect.bottom), right: Math.max(rect.left, rect.right),
    bottom: Math.max(rect.top, rect.bottom) });

/**
 * Where DrawText puts each line of a string.
 *
 * The mnemonic prefix is taken out unless DT_NOPREFIX: `&x` is `x` with an
 * underline to draw, `&&` is one ampersand. Lines break at a line feed, and
 * with DT_WORDBREAK at the last space that fits; DT_SINGLELINE takes the
 * whole string as one line, which is also the only case the vertical flags
 * apply to, as documented. A string is as wide as the metrics measure it,
 * or one cell per character when they cannot.
 *
 * @param {string} text
 * @param {Rect} rect
 * @param {number} format
 * @param {TextCell} metrics
 * @returns {LaidOutLine[]}
 */
export function layoutText(text, rect, format, metrics){
    const widthOf = metrics.width ?? ((/** @type {string} */ piece)=>piece.length * metrics.cellWidth);
    /** @type {number | null} */
    let mnemonic = null;
    let plain = text;
    if ((format & DT_NOPREFIX) === 0)
    {
        plain = '';
        for (let index = 0; index < text.length; index++)
        {
            if (text[index] === '&' && index + 1 < text.length)
            {
                index++;
                if (text[index] !== '&' && mnemonic === null)
                {
                    mnemonic = plain.length;
                }
            }
            plain += text[index];
        }
    }
    const width = rect.right - rect.left;
    /**
     * The end of the longest piece from `from` that fits the width, and at
     * least one character, so a rectangle narrower than a glyph still moves
     * on. Bisected, because a measure is a sum of cached advances and the
     * pieces are short.
     *
     * @param {string} paragraph @param {number} from
     */
    const fitting = (paragraph, from)=>{
        let low = from + 1;
        let high = paragraph.length;
        while (low < high)
        {
            const middle = (low + high + 1) >> 1;
            if (widthOf(paragraph.slice(from, middle)) <= width)
            {
                low = middle;
            }
            else
            {
                high = middle - 1;
            }
        }
        return low;
    };
    /** @type {{ text: string, start: number }[]} */
    const lines = [];
    if ((format & DT_SINGLELINE) !== 0)
    {
        lines.push({ text: plain.replace(/\r?\n/g, ' '), start: 0 });
    }
    else
    {
        let at = 0;
        for (const paragraph of plain.split(/\r\n|\n|\r/))
        {
            const start = at;
            at += paragraph.length + 1;
            if ((format & DT_WORDBREAK) === 0 || widthOf(paragraph) <= width)
            {
                lines.push({ text: paragraph, start });
                continue;
            }
            let from = 0;
            // Until the text is used up as well as fits: in a rectangle of
            // negative width even nothing is too wide.
            while (from < paragraph.length && widthOf(paragraph.slice(from)) > width)
            {
                const end = fitting(paragraph, from);
                let cut = paragraph.lastIndexOf(' ', end);
                // A line takes one character at least, however narrow the
                // rectangle: a launcher's DrawText into a rectangle left of
                // its own left edge made empty lines until the array of them
                // broke.
                cut = cut <= from ? Math.max(end, from + 1) : cut + 1;
                lines.push({ text: paragraph.slice(from, cut), start: start + from });
                from = cut;
            }
            // A cut that took the whole paragraph leaves no line to add; an
            // empty paragraph is still one line.
            if (from < paragraph.length || from === 0)
            {
                lines.push({ text: paragraph.slice(from), start: start + from });
            }
        }
    }
    const height = lines.length * metrics.cellHeight;
    let top = rect.top;
    if ((format & DT_SINGLELINE) !== 0)
    {
        if ((format & DT_VCENTER) !== 0)
        {
            top = rect.top + Math.floor((rect.bottom - rect.top - height) / 2);
        }
        else if ((format & DT_BOTTOM) !== 0)
        {
            top = rect.bottom - height;
        }
    }
    return lines.map((line, index)=>{
        const lineWidth = widthOf(line.text);
        const x = (format & DT_CENTER) !== 0
            ? rect.left + Math.floor((width - lineWidth) / 2)
            : (format & DT_RIGHT) !== 0 ? rect.right - lineWidth : rect.left;
        const underline = mnemonic !== null && mnemonic >= line.start
            && mnemonic < line.start + line.text.length
            ? mnemonic - line.start
            : null;
        return { text: line.text, x, y: top + index * metrics.cellHeight, underline };
    });
}

/**
 * Where a line with tabs in it ends, laid out as TabbedTextOut lays it: each
 * tab moves on to the first stop past where the text has reached. A stop
 * given as a negative number is that far but right-aligned -- the text up to
 * the next tab ends at it, and the stop is taken only if that text then
 * starts past where the line has reached. One stop alone is an interval that
 * repeats, its sign still the alignment; with none, or past the last of
 * several, the stops are `interval` apart. Every comparison is strict, which
 * is what user32's text tests pin down: text that ends exactly on a stop
 * moves on to the next one.
 *
 * @param {string} text
 * @param {(piece: string) => number} widthOf
 * @param {number[]} stops   Positions from where the line starts.
 * @param {number} interval  Eight average characters, the default.
 * @returns {number} the width of the line
 */
export function tabbedWidth(text, widthOf, stops, interval){
    const [first, ...rest] = text.split('\t');
    let x = widthOf(first);
    for (const segment of rest)
    {
        const width = widthOf(segment);
        if (stops.length === 1 && stops[0] !== 0)
        {
            const step = Math.abs(stops[0]);
            x = stops[0] < 0
                ? (Math.floor((x + width) / step) + 1) * step
                : (Math.floor(x / step) + 1) * step + width;
            continue;
        }
        const stop = stops.find(at=>(at < 0 ? -at - width > x : at > x));
        x = stop === undefined
            ? (Math.floor(x / interval) + 1) * interval + width
            : stop < 0 ? -stop : stop + width;
    }
    return x;
}

/**
 * Builds the painting half of user32, over the window records the bookkeeping
 * half already keeps.
 *
 * @param {Object} options
 * @param {PaintHost} options.host
 * @param {(hwnd: number) => any | null} options.live  A window, if it still is one.
 * @param {number} options.WM_PAINT
 * @param {{ clientSize: (record: any) => { width: number, height: number },
 *     clientRect: (record: any) => Rect, windowRect: (record: any) => Rect,
 *     visibleClientRect: (record: any) => Rect,
 *     visibleWindowRect: (record: any) => Rect }} options.geometry
 * @param {(hwnd: number, message: number, wParam: number, lParam: number,
 *     thread?: unknown) => number | Promise<number>} options.send
 * @param {(record: any) => void} options.invalidated
 *        A window's update area grew: its thread has a paint to look for.
 * @param {(record: any) => any[]} [options.children]
 *        A window's own children, which an invalidation of it reaches by the
 *        RedrawWindow rules.
 * @param {(record: any) => any | null} [options.parentOf]
 *        A child window's parent; null for a top-level window.
 * @param {() => void} options.painted   Something reached the screen.
 * @param {(record: any) => any[]} [options.descendants]
 *        A window's descendants, parents before their children: the order
 *        RDW_ALLCHILDREN paints them in.
 * @param {(record: any) => boolean} [options.shown]
 *        Whether a window is on the screen: it and every parent WS_VISIBLE.
 * @param {() => number} [options.desktop]
 *        The desktop window, which the screen's context GetDC(NULL) answers
 *        belongs to.
 * @param {(record: any) => Rect[]} [options.covering]
 *        The rectangles, in screen coordinates, of the windows over a window:
 *        what its visible region leaves out.
 * @param {() => number} [options.layoutRevision]
 *        A count that moves whenever any window's place, size, style,
 *        parent or stacking changes: a context held across one is brought up
 *        to date before it draws.
 * @param {(record: any) => boolean} [options.frozen]
 *        Whether a window is held as it is, being dragged: it draws nowhere.
 * @param {(hwnd: number) => boolean} [options.isWindow]
 *        Whether a handle names a window, of this process or another.
 * @param {(record: any) => ({ style: number, keptContext?: number } | null)} [options.classOf]
 *        A window's class, whose style says whose its context is, and which
 *        keeps the one context of a CS_CLASSDC class.
 * @param {{ paintStarts: (record: any) => void, paintEnds: (record: any) => void }}
 *        [options.caret]  The caret, taken off a window while it paints and
 *        put back after, as BeginPaint and EndPaint hide and show it.
 */
export function createPaintFunctions(options){
    const { host, live, WM_PAINT, geometry, send, invalidated, painted, descendants } = options;
    const shown = options.shown ?? (()=>true);
    let iconDivergenceSaid = false;
    /** @type {Set<string>} what a drawing call has said it leaves out */
    const toldOnce = new Set();
    /** @param {string} api @param {string} detail */
    const tellOnce = (api, detail)=>{
        if (!toldOnce.has(detail))
        {
            toldOnce.add(detail);
            host.divergence?.(api, detail);
        }
    };

    /** @param {any} record @returns {Rect} */
    const clientArea = record=>{
        const size = geometry.clientSize(record);
        return { left: 0, top: 0, right: size.width, bottom: size.height };
    };

    /** The window LockWindowUpdate holds, or 0. */
    let lockedWindow = 0;

    /**
     * The update area a window now has, and the rectangle around it; nothing
     * left is no update area at all, which is also no erase still owed and
     * no frame -- what RDW_VALIDATE leaves (msg.c test_paint_messages: a
     * window validated whole is sent nothing by RDW_ERASENOW).
     *
     * @param {any} record @param {Rect[] | null} area
     */
    const setUpdate = (record, area)=>{
        const pieces = area && area.length > MOST_UPDATE_PIECES ? [boundsOf(area)] : area;
        if (!pieces || pieces.length === 0)
        {
            record.updateArea = null;
            record.updateRect = null;
            record.erase = false;
            record.ncDirty = false;
            return;
        }
        record.updateArea = pieces;
        record.updateRect = boundsOf(pieces);
    };

    /** @param {any} record @returns {Rect[]} its update area, client coordinates */
    const updateOf = record=>record.updateArea
        ?? (record.updateRect ? [record.updateRect] : []);

    /**
     * Whether RedrawWindow's rules carry a change of a window's update area
     * on to its children: never with RDW_NOCHILDREN, always with
     * RDW_ALLCHILDREN, and otherwise when the window does not clip them --
     * then what it paints covers them, and they paint again after it
     * (msg.c test_paint_messages, WmInvalidateParentChild).
     *
     * @param {any} record @param {'auto' | 'all' | 'none'} children
     */
    const reachesChildren = (record, children)=>children === 'all'
        || (children === 'auto' && (record.style & WS_CLIPCHILDREN) === 0);

    /**
     * The part of an area, in a window's client coordinates, over each of its
     * shown children, in each child's client coordinates; and whether it
     * reaches the child's frame.
     *
     * @param {any} record @param {Rect[]} area
     * @returns {{ child: any, area: Rect[], frame: boolean }[]}
     */
    const overChildren = (record, area)=>{
        const origin = geometry.clientRect(record);
        const onScreen = offsetArea(area, origin.left, origin.top);
        return (options.children?.(record) ?? []).flatMap(child=>{
            if (!shown(child))
            {
                return [];
            }
            const over = intersectArea(onScreen, geometry.windowRect(child));
            if (over.length === 0)
            {
                return [];
            }
            const client = geometry.clientRect(child);
            const inside = intersectArea(over, client);
            return [{ child, area: offsetArea(inside, -client.left, -client.top),
                frame: subtractFromArea(over, client).length > 0 }];
        });
    };

    /**
     * Adds an area to a window's update region, cropped to its client area
     * as Windows crops it (msg.c: "GetUpdateRgn clips to client area"), and
     * marks it to be erased when asked. Its children that the RedrawWindow
     * rules reach are invalidated under it too, always to be erased and with
     * their frames where it covers them: the parent's paint goes over all of
     * them (msg.c, "no RDW_ERASE in parent still causes RDW_ERASE and
     * RDW_FRAME in child"). No other window is touched -- not the windows
     * over it, which its context leaves out, and not its parent.
     *
     * @param {any} record
     * @param {Rect | Rect[]} given  In client coordinates.
     * @param {boolean} [erase]
     * @param {'auto' | 'all' | 'none'} [children]
     */
    const invalidate = (record, given, erase = false, children = 'auto')=>{
        const area = intersectArea(Array.isArray(given) ? given : [given], clientArea(record));
        if (area.length === 0)
        {
            return;
        }
        setUpdate(record, unionAreas(updateOf(record), area));
        record.erase = record.erase || erase;
        invalidated(record);
        if (!reachesChildren(record, children))
        {
            return;
        }
        for (const { child, area: under, frame } of overChildren(record, area))
        {
            child.ncDirty = child.ncDirty || frame;
            invalidate(child, under, true, children);
            if (frame && under.length === 0)
            {
                invalidated(child);
            }
        }
    };

    /**
     * Takes an area out of a window's update region; the whole of it when no
     * area is named. The children the RedrawWindow rules reach are validated
     * under it the same way.
     *
     * @param {any} record @param {Rect[] | null} area  In client coordinates.
     * @param {'auto' | 'all' | 'none'} [children]
     */
    const validate = (record, area, children = 'auto')=>{
        setUpdate(record, area ? subtractAreas(updateOf(record), area) : null);
        if (!reachesChildren(record, children))
        {
            return;
        }
        for (const { child, area: under } of overChildren(record, area ?? [clientArea(record)]))
        {
            validate(child, under, children);
        }
    };

    /**
     * The area a region names, in the window's client coordinates: its
     * rectangles, or the whole client area for no region -- or for one that
     * cannot be read, since repainting more than asked is the safe side.
     *
     * @param {any} record @param {number} region
     * @returns {Rect[]}
     */
    const regionArea = (record, region)=>{
        const held = (region >>> 0) === 0 ? null : host.regionBox?.(region >>> 0) ?? null;
        if (!held)
        {
            return [clientArea(record)];
        }
        return Array.isArray(held.rects) ? held.rects : [held];
    };

    /**
     * Whether a window has anything to paint: an update area, or only its
     * frame, which is a WM_PAINT too (msg.c: "GetUpdateRgn must return empty
     * region since only nonclient area is invalidated"), or a paint asked
     * for with RDW_INTERNALPAINT and nothing to paint.
     *
     * @param {any} record
     */
    const owesPaint = record=>Boolean(record.updateRect) || record.ncDirty === true
        || record.internalPaint === true;

    /**
     * WM_PAINT sent now, the window procedure run before the caller goes on,
     * when the window has anything to paint: what UpdateWindow and
     * RDW_UPDATENOW do. A procedure that paints clears the area through
     * BeginPaint; one that does not is sent it once, not in a loop.
     *
     * @param {any} record
     * @param {unknown} [thread]  Whose call it is: the caller's when it named
     *        one, as a control painting itself does from a dialog's loop.
     * @returns {number | Promise<number>}
     */
    const paintNow = (record, thread)=>{
        if (!owesPaint(record))
        {
            return 1;
        }
        const over = paintsOver(record);
        // Sent once for an internal paint, as UpdateWindow sends it.
        record.internalPaint = false;
        return after(send(record.hwnd, WM_PAINT, 0, 0, thread ?? host.callerThread?.()), ()=>{
            if (over)
            {
                validate(over.parent, over.area, 'none');
            }
            return 1;
        });
    };

    /**
     * What a child sent WM_PAINT now, by RDW_UPDATENOW, paints of a parent
     * that does not clip its children: its update region, and its frame
     * when that is to be drawn, in the parent's client coordinates. That
     * part of the parent's update region is validated, the child having
     * painted it (msg.c test_paint_messages: "RDW_UPDATENOW on child without
     * WS_CLIPCHILDREN will validate corresponding parent area"). A
     * transparent child shows the parent through it, and leaves the parent
     * its paint.
     *
     * @param {any} record
     * @returns {{ parent: any, area: Rect[] } | null}
     */
    const paintsOver = record=>{
        const parent = options.parentOf?.(record) ?? null;
        if (!parent || !parent.updateRect || (parent.style & WS_CLIPCHILDREN) !== 0
            || (record.exStyle & WS_EX_TRANSPARENT) !== 0)
        {
            return null;
        }
        const origin = geometry.clientRect(parent);
        const client = geometry.clientRect(record);
        const frame = record.ncDirty === true
            ? subtractFromArea([geometry.windowRect(record)], client) : [];
        const area = [...offsetArea(updateOf(record), client.left, client.top), ...frame];
        return { parent, area: offsetArea(area, -origin.left, -origin.top) };
    };

    /**
     * WM_PAINT sent now to a window and, with `children`, to each of its
     * descendants after it, one before the next: a parent paints under its
     * children, as the screen shows them. RDW_UPDATENOW, with or without
     * RDW_ALLCHILDREN.
     *
     * Only the window and its descendants: an ancestor with an area still
     * to paint is not painted first (msg.c, WmInvalidateErasePaint2 -- the
     * child alone).
     *
     * @param {any} record @param {boolean} children @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const updateNow = (record, children, thread)=>{
        // Named once, here: past the first window's paint the thread on the
        // processor may be any other.
        const on = thread ?? host.callerThread?.();
        const order = children ? [record, ...(descendants?.(record) ?? [])] : [record];
        /** @param {number} index @returns {number | Promise<number>} */
        const next = index=>(index >= order.length
            ? 1
            : after(paintNow(order[index], on), ()=>next(index + 1)));
        return next(0);
    };

    /**
     * A window's frame and background painted now, its client left to its
     * WM_PAINT: what RDW_ERASENOW does, and what Windows XP's SetWindowPos
     * does for a window it shows. A program that shows a window and goes on
     * without looking at its queue has it framed and erased on the screen,
     * not the pixels of whatever was there before.
     *
     * @param {any} record
     * @param {unknown} thread  Whose call showed it, named by the caller: after
     *        an await the thread on the processor may be another.
     * @returns {number | Promise<number>}
     */
    const eraseNow = (record, thread)=>{
        const frame = record.ncDirty === true;
        const erase = record.erase === true && Boolean(record.updateRect);
        // Erased only in its update region: the rest of it still shows what
        // it painted, and its WM_PAINT is to come.
        const area = updateOf(record);
        record.ncDirty = false;
        record.erase = false;
        return after(frame ? send(record.hwnd, WM_NCPAINT, 1, 0, thread) : 0, ()=>{
            const hdc = erase ? contextOn(record) : 0;
            if (hdc === 0)
            {
                return 1;
            }
            limitContext(hdc, area);
            // Shown only when it erased, which the answer says: a window
            // with no background leaves the screen as it was, and that is
            // not a picture to present.
            return after(send(record.hwnd, WM_ERASEBKGND, hdc, 0, thread), erased=>{
                finishContext(record, hdc);
                if ((erased | 0) !== 0)
                {
                    painted();
                }
                return 1;
            });
        });
    };

    /** The DC service, or null in a build that cannot make one. */
    const contexts = ()=>host.dc?.() ?? null;

    /**
     * The window each context a program was handed is on, for WindowFromDC,
     * until the program hands it back. Only the contexts the guest is given
     * are here: the ones this layer takes to draw a frame or a control are
     * never seen by a program.
     *
     * @type {Map<number, number>}
     */
    const owners = new Map();

    /** @param {number} hwnd @param {number} hdc */
    const handedOut = (hwnd, hdc)=>{
        if (hdc !== 0)
        {
            owners.set(hdc, hwnd >>> 0);
        }
        return hdc;
    };

    /**
     * The window contexts out now, each with what its origin and clip are
     * worked out from: its window, whether it is the whole window's, the
     * part a paint limits it to, in its own coordinates, and the layout
     * revision they were worked out under; whose it is -- the cache's, made
     * for one GetDC, or a window's own or its class's, kept -- and the
     * region GetDCEx gave it, in screen coordinates, which the system owns
     * from then on.
     *
     * @type {Map<number, HeldContext>}
     */
    const held = new Map();

    /**
     * What a context draws in: its window's visible region, with the region
     * GetDCEx gave it taken in or out, and during a paint the part the
     * paint is of.
     *
     * @param {number} hdc @param {HeldContext} entry
     */
    const clipHeld = (hdc, entry)=>{
        const area = entry.whole
            ? geometry.windowRect(entry.record) : geometry.clientRect(entry.record);
        let visible = visibleArea(entry.record, entry.whole, area);
        if (entry.region)
        {
            const box = host.regionBox?.(entry.region.handle) ?? null;
            const pieces = offsetArea(box?.rects ?? (box && !isEmpty(box) ? [box] : []),
                -area.left, -area.top);
            visible = entry.region.exclude ? subtractAreas(visible, pieces)
                : intersectAreas(visible, pieces);
        }
        host.draw?.clip?.(hdc, entry.limit ? intersectAreas(visible, entry.limit) : visible);
    };

    /**
     * Whose a window's client context is: its own with CS_OWNDC, its
     * class's with CS_CLASSDC, made once and handed out again with what was
     * selected into it; the cache's otherwise, and always for the whole
     * window or when DCX_CACHE asks (dce.c test_dc_attributes).
     *
     * @param {any} record @param {boolean} whole @param {number} flags
     * @returns {'cache' | 'own' | 'class'}
     */
    const kindOf = (record, whole, flags)=>{
        if (whole || (flags & DCX_CACHE) !== 0)
        {
            return 'cache';
        }
        const style = options.classOf?.(record)?.style ?? 0;
        return (style & CS_OWNDC) !== 0 ? 'own' : (style & CS_CLASSDC) !== 0 ? 'class' : 'cache';
    };

    /**
     * A device context on a window's client area, or on the whole window:
     * its origin at the area's corner, and clipped to the part of it that
     * is on the screen and inside every ancestor. A window's own context and
     * its class's are the same handle each time, moved to the window that
     * asks; DCX_INTERSECTRGN or DCX_EXCLUDERGN hands it a region, the
     * system's from then on: a cache context's goes when it is released, a
     * kept one's when another takes its place (dce.c test_dc_visrgn).
     *
     * @param {any} record @param {boolean} [whole] @param {number} [flags]  GetDCEx's.
     * @param {number} [region]  GetDCEx's hrgnClip.
     * @returns {number} the handle, or zero
     */
    const contextOn = (record, whole = false, flags = 0, region = 0)=>{
        const kind = kindOf(record, whole, flags);
        const owner = kind === 'own' ? record : kind === 'class' ? options.classOf?.(record) : null;
        const area = whole ? geometry.windowRect(record) : geometry.clientRect(record);
        let hdc = owner?.keptContext ?? 0;
        let entry = held.get(hdc);
        if (entry)
        {
            if (entry.record !== record)
            {
                // A class's context moves to the window that asks for it,
                // leaving the region it had where it was.
                entry.record = record;
                entry.region = null;
                entry.limit = null;
            }
            contexts()?.rebind?.(hdc, area);
        }
        else
        {
            hdc = contexts()?.get(record.hwnd, area) ?? 0;
            if (hdc === 0)
            {
                return 0;
            }
            entry = { record, whole, limit: null, revision: 0, kind, region: null };
            held.set(hdc, entry);
            if (owner)
            {
                owner.keptContext = hdc;
            }
        }
        entry.revision = options.layoutRevision?.() ?? 0;
        if ((flags & (DCX_INTERSECTRGN | DCX_EXCLUDERGN)) !== 0)
        {
            const given = region >>> 0;
            if (entry.region && entry.region.handle !== given)
            {
                host.deleteRegion?.(entry.region.handle);
            }
            entry.region = given === 0 ? null
                : { handle: given, exclude: (flags & DCX_EXCLUDERGN) !== 0 };
        }
        clipHeld(hdc, entry);
        return hdc;
    };

    /**
     * Clips a context to its window's visible region and, during a paint,
     * to the part the paint is of; the limit is kept, so a later refresh
     * keeps it too.
     *
     * @param {number} hdc @param {Rect[]} limit
     */
    const limitContext = (hdc, limit)=>{
        const entry = held.get(hdc);
        if (!entry)
        {
            return;
        }
        entry.limit = limit;
        clipHeld(hdc, entry);
    };

    /**
     * ReleaseDC: a cache context goes back, with the region it was given,
     * and is no longer brought up to date; a window's own context or its
     * class's stays as it is, and the call succeeds whichever window it
     * names (dce.c test_parameters).
     *
     * @param {number} hwnd @param {number} hdc
     */
    const releaseContext = (hwnd, hdc)=>{
        const entry = held.get(hdc >>> 0);
        if (entry && entry.kind !== 'cache')
        {
            return 1;
        }
        held.delete(hdc >>> 0);
        if (entry?.region)
        {
            host.deleteRegion?.(entry.region.handle);
        }
        return contexts()?.release(entry ? entry.record.hwnd : hwnd >>> 0, hdc >>> 0) ?? 0;
    };

    /**
     * The end of a paint or an erase on a context: released when it is the
     * cache's; a kept one stays out, no longer limited to the paint.
     *
     * @param {any} record @param {number} hdc
     */
    const finishContext = (record, hdc)=>{
        const entry = held.get(hdc >>> 0);
        if (entry && entry.kind !== 'cache')
        {
            entry.limit = null;
            clipHeld(hdc >>> 0, entry);
            return;
        }
        releaseContext(record.hwnd, hdc);
    };

    /**
     * A window is gone: its own context with it, and every cache context
     * out on it. Its class's stays, for the next window of the class to ask.
     *
     * @param {any} record
     */
    const forgetContexts = record=>{
        for (const [hdc, entry] of [...held])
        {
            if (entry.record !== record)
            {
                continue;
            }
            owners.delete(hdc);
            // A cache context out on it is released, and names nothing
            // after (dce.c test_destroyed_window); the class's is still the
            // class's, for the next window that asks.
            if (entry.kind !== 'class')
            {
                entry.kind = 'cache';
                releaseContext(record.hwnd, hdc);
            }
        }
        record.keptContext = 0;
    };

    /**
     * Whether a handle a context is asked for names no window: one destroyed,
     * or never one. The screen's context, asked for with none, is not.
     *
     * @param {number} hwnd
     */
    const noWindow = hwnd=>(hwnd >>> 0) !== 0 && !live(hwnd)
        && options.isWindow?.(hwnd >>> 0) === false;

    /**
     * Brings a context out since before the windows last changed up to
     * where its window is now and what of it shows now: a program that took
     * a DC once and draws through it every frame must neither draw over a
     * dialog opened since nor at the place its window has left (MSDN
     * GetDC; Wine's dce.c test_dc_visrgn).
     *
     * @param {number} hdc
     */
    const refreshContext = hdc=>{
        const entry = held.get(hdc >>> 0);
        const revision = options.layoutRevision?.() ?? 0;
        if (!entry || entry.revision === revision || entry.record.destroyed)
        {
            return;
        }
        // Set first: re-clipping draws nothing, but it reaches the drawing
        // layer, which asks again.
        entry.revision = revision;
        const area = entry.whole
            ? geometry.windowRect(entry.record) : geometry.clientRect(entry.record);
        contexts()?.rebind?.(hdc >>> 0, area);
        clipHeld(hdc >>> 0, entry);
    };

    /**
     * A window's visible region, in the coordinates of a context whose
     * origin is `origin`'s corner: the part of its client area, or of its
     * whole rectangle, that is on the screen, inside every ancestor and under
     * no other window. A window that is hidden, or inside one that is, has
     * none, and what it draws reaches nothing -- not the rectangle it would
     * have if it were shown.
     *
     * @param {any} record @param {boolean} whole @param {Rect} origin
     * @returns {Rect[]}
     */
    const visibleArea = (record, whole, origin)=>{
        if (!shown(record) || options.frozen?.(record))
        {
            return [];
        }
        const visible = whole
            ? geometry.visibleWindowRect(record) : geometry.visibleClientRect(record);
        const covers = options.covering?.(record) ?? [];
        return covers.reduce((area, cover)=>subtractFromArea(area, cover),
            isEmpty(visible) ? [] : [visible])
            .map(piece=>({ left: piece.left - origin.left, top: piece.top - origin.top,
                right: piece.right - origin.left, bottom: piece.bottom - origin.top }));
    };

    /** @param {any} value @param {(answer: any) => any} then */
    const after = (value, then)=>(typeof value?.then === 'function'
        ? value.then(then)
        : then(value));

    /**
     * A device context on a window's client area, the update area cleared
     * and, in that order, the frame and the background painted through the
     * window's own procedure -- which is what makes BeginPaint the moment a
     * window's frame appears. Only measuring leaves the update area alone.
     *
     * `erase` is what PAINTSTRUCT's fErase says: the background is still
     * the program's to erase.
     *
     * @param {any} record @param {boolean} [measuring]
     * @returns {PaintStarted | Promise<PaintStarted>}
     */
    const beginPaint = (record, measuring = false)=>{
        const hdc = contextOn(record);
        if (measuring)
        {
            return { hdc, rect: clientArea(record), erase: false };
        }
        // With nothing to paint, the paint is of nothing: rcPaint empty and
        // every pixel clipped, as Windows clips to an empty update region. A
        // skin that paints in its own WM_PAINT and then hands the message to
        // the procedure it subclassed has that procedure's BeginPaint find
        // the window clean; drawing everywhere, it painted over the skin.
        const dirty = record.updateRect ?? { left: 0, top: 0, right: 0, bottom: 0 };
        const area = updateOf(record);
        const erase = record.erase === true;
        const frame = record.ncDirty === true;
        // Cleared before the guest paints, not after: a program that
        // invalidates from inside its own WM_PAINT expects that request to
        // survive, and clearing afterwards would swallow it.
        setUpdate(record, null);
        record.internalPaint = false;
        record.painting = hdc;
        if (hdc !== 0)
        {
            options.caret?.paintStarts(record);
            // rcPaint is the rectangle around the region; the clip is the
            // region itself, so two far corners do not paint the span between.
            limitContext(hdc, area);
        }
        if (hdc === 0)
        {
            return { hdc, rect: dirty, erase };
        }
        // Named before the first send: the second one may follow an await,
        // after which the thread on the processor may be another.
        const thread = host.callerThread?.();
        // A background the procedure did not erase -- it answered zero --
        // is still to be erased, by the program: fErase (MSDN WM_ERASEBKGND).
        return after(frame ? send(record.hwnd, WM_NCPAINT, 1, 0, thread) : 0,
            ()=>after(erase ? send(record.hwnd, WM_ERASEBKGND, hdc, 0, thread) : 1,
                erased=>({ hdc, rect: dirty, erase: (erased | 0) === 0 })));
    };

    /** @param {any} record @param {number} hdc */
    const endPaint = (record, hdc)=>{
        if (hdc !== 0)
        {
            finishContext(record, hdc);
            painted();
        }
        if (record.painting === hdc)
        {
            record.painting = 0;
            options.caret?.paintEnds(record);
        }
    };

    /**
     * An icon's picture drawn at a point, at its own size for a width of 0;
     * one that cannot be drawn is said once and left out.
     *
     * @param {number} hdc @param {number} x @param {number} y @param {number} icon
     * @param {number} width @param {number} height
     */
    const drawIcon = (hdc, x, y, icon, width, height)=>{
        const picture = host.picture?.(icon >>> 0) ?? null;
        if (picture && host.draw?.picture?.(hdc >>> 0, x | 0, y | 0, picture,
            width || picture.width, height || picture.height))
        {
            return;
        }
        if (!iconDivergenceSaid)
        {
            iconDivergenceSaid = true;
            host.divergence?.('DrawIcon', 'an icon without a picture this build can read is'
                + ' left out; the call succeeds');
        }
    };

    /**
     * The rings DrawEdge draws, outer then inner, on the sides `flags` names;
     * answers the rectangle left inside them.
     *
     * @param {number} hdc @param {Rect} rect @param {number} edge @param {number} flags
     * @returns {Rect}
     */
    const drawEdges = (hdc, rect, edge, flags)=>{
        const draw = host.draw;
        let area = rect;
        /** @param {number} topLeft @param {number} bottomRight */
        const ring = (topLeft, bottomRight)=>{
            if ((flags & BF_TOP) !== 0)
            {
                draw.fill(hdc, { ...area, bottom: area.top + 1, right: area.right - 1 },
                    draw.sysColor(topLeft));
            }
            if ((flags & BF_LEFT) !== 0)
            {
                draw.fill(hdc, { ...area, right: area.left + 1, bottom: area.bottom - 1 },
                    draw.sysColor(topLeft));
            }
            if ((flags & BF_BOTTOM) !== 0)
            {
                draw.fill(hdc, { ...area, top: area.bottom - 1 }, draw.sysColor(bottomRight));
            }
            if ((flags & BF_RIGHT) !== 0)
            {
                draw.fill(hdc, { ...area, left: area.right - 1 }, draw.sysColor(bottomRight));
            }
            area = {
                left: area.left + ((flags & BF_LEFT) !== 0 ? 1 : 0),
                top: area.top + ((flags & BF_TOP) !== 0 ? 1 : 0),
                right: area.right - ((flags & BF_RIGHT) !== 0 ? 1 : 0),
                bottom: area.bottom - ((flags & BF_BOTTOM) !== 0 ? 1 : 0),
            };
        };
        if ((edge & BDR_RAISEDOUTER) !== 0)
        {
            ring(COLOR_3DHILIGHT, COLOR_3DDKSHADOW);
        }
        else if ((edge & BDR_SUNKENOUTER) !== 0)
        {
            ring(COLOR_3DSHADOW, COLOR_3DHILIGHT);
        }
        if ((edge & BDR_RAISEDINNER) !== 0)
        {
            ring(COLOR_3DFACE, COLOR_3DSHADOW);
        }
        else if ((edge & BDR_SUNKENINNER) !== 0)
        {
            ring(COLOR_3DDKSHADOW, COLOR_3DFACE);
        }
        return area;
    };

    /**
     * A pixel-row picture put down in a colour, centred in a rectangle.
     *
     * @param {number} hdc @param {string[]} rows @param {Rect} box @param {number} rgb
     */
    const glyph = (hdc, rows, box, rgb)=>{
        const x = box.left + ((box.right - box.left - rows[0].length) >> 1);
        const y = box.top + ((box.bottom - box.top - rows.length) >> 1);
        rows.forEach((row, dy)=>{
            for (let dx = 0; dx < row.length; dx++)
            {
                if (row[dx] === '#')
                {
                    host.draw.fill(hdc, { left: x + dx, top: y + dy, right: x + dx + 1,
                        bottom: y + dy + 1 }, rgb);
                }
            }
        });
    };

    /**
     * `count` characters of either kind at an address, terminated or not.
     *
     * @param {number} address @param {number} count @param {boolean} wide
     */
    const readCounted = (address, count, wide)=>(wide
        ? String.fromCharCode(...new Uint16Array(
            host.readMemory(address >>> 0, count * 2).slice().buffer))
        : decodeAnsi(host.readMemory(address >>> 0, count)));

    /**
     * DrawState of either kind of text: text, an icon or a bitmap at a
     * point. Disabled text is embossed -- the highlight colour a pixel down
     * and to the right, the shadow colour over it -- and DSS_UNION text is
     * grey rather than dithered. An icon or a bitmap keeps its own colours in
     * either state, and what a program's own procedure would draw
     * (DST_COMPLEX, into a memory context this layer cannot make) is left
     * out; each is said once and the call succeeds.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const drawState = ([hdc, brush, proc, data, length, x, y, cx, cy, flags], wide)=>{
        void brush;
        void proc;
        const DST_TEXT = 1;
        const DST_PREFIXTEXT = 2;
        const DST_ICON = 3;
        const DST_BITMAP = 4;
        const DSS_UNION = 0x10;
        const DSS_DISABLED = 0x20;
        const draw = host.draw;
        const h = hdc >>> 0;
        const kind = flags & 0xf;
        if (!draw || h === 0)
        {
            return 0;
        }
        if (kind === DST_TEXT || kind === DST_PREFIXTEXT)
        {
            // No text is a failure, not a read of address zero.
            if ((data >>> 0) === 0)
            {
                return 0;
            }
            // A length of 0 is a terminated string.
            const string = (length | 0) > 0
                ? readCounted(data, length | 0, wide)
                : readText(host, data >>> 0, wide, 0x10000);
            const sized = (cx | 0) > 0 && (cy | 0) > 0;
            const bounds = { left: x | 0, top: y | 0,
                right: sized ? (x | 0) + (cx | 0) : 0x7fff,
                bottom: sized ? (y | 0) + (cy | 0) : 0x7fff };
            const lines = layoutText(string, bounds,
                DT_SINGLELINE | (kind === DST_TEXT ? DT_NOPREFIX : 0), cellOf(h));
            /** @param {number} by @param {number | undefined} color */
            const put = (by, color)=>lines.every(line=>draw.text(h, line.x + by, line.y + by,
                line.text, { color, clip: sized ? bounds : null, transparent: true }));
            if ((flags & DSS_DISABLED) !== 0)
            {
                return put(1, draw.sysColor(COLOR_3DHILIGHT))
                    && put(0, draw.sysColor(COLOR_3DSHADOW)) ? 1 : 0;
            }
            if ((flags & DSS_UNION) !== 0)
            {
                tellOnce('DrawState', 'DSS_UNION text is grey rather than dithered');
            }
            return put(0, (flags & DSS_UNION) !== 0 ? draw.sysColor(COLOR_GRAYTEXT) : undefined)
                ? 1 : 0;
        }
        if (kind === DST_ICON)
        {
            drawIcon(h, x, y, data, cx | 0, cy | 0);
        }
        else if (kind === DST_BITMAP)
        {
            draw.bitmap(h, x | 0, y | 0, data >>> 0);
        }
        else
        {
            tellOnce('DrawState', 'what a DST_COMPLEX procedure would draw is left out');
        }
        if ((kind === DST_ICON || kind === DST_BITMAP)
            && (flags & (DSS_UNION | DSS_DISABLED)) !== 0)
        {
            tellOnce('DrawState', 'a disabled icon or bitmap keeps its own colours');
        }
        return 1;
    };

    /**
     * The character cell of a context's font, for laying text out, and the
     * measure of a string in it; the estimate when the build cannot measure.
     *
     * @param {number} hdc
     * @returns {TextCell & { ascent: number }}
     */
    const cellOf = hdc=>{
        const draw = host.draw;
        const measured = (hdc >>> 0) !== 0 ? draw?.measure?.(hdc >>> 0, 'M') : null;
        return measured && draw
            ? { cellWidth: measured.width, cellHeight: measured.height, ascent: measured.ascent,
                width: text=>draw.measure(hdc >>> 0, text).width }
            : { cellWidth: ESTIMATED_CHAR_WIDTH, cellHeight: ESTIMATED_LINE_HEIGHT,
                ascent: ESTIMATED_LINE_HEIGHT - 4 };
    };

    /**
     * DrawText and DrawTextEx without its parameter block, of either kind of
     * text. DT_CALCRECT measures and writes the rectangle back; anything else
     * draws each line where the layout put it, in the context's own colour and
     * mode.
     *
     * @param {number[]} args @param {boolean} [wide]  UTF-16 text, as the W calls take.
     */
    const drawText = ([hdc, text, count, rect, format], wide = false)=>{
        // No context, and the text and the rectangle are not looked at:
        // Windows answers zero before reading either, the UTF-16 form
        // without a word in the last error.
        if (host.draw?.isContext && !host.draw.isContext(hdc >>> 0))
        {
            if (!wide)
            {
                host.setLastError?.(ERROR_INVALID_HANDLE);
            }
            return 0;
        }
        // A count of -1 means a terminated string; any other count is the
        // string's length, and the text need not be terminated at all -- a
        // caller drawing part of a buffer passes exactly that part.
        const string = (text >>> 0) === 0 || (count | 0) === 0
            ? ''
            : (count | 0) < 0
                ? readText(host, text >>> 0, wide, 0x10000)
                : readCounted(text, count | 0, wide);
        const bounds = (rect >>> 0) === 0
            ? { left: 0, top: 0, right: 0x7fff, bottom: 0x7fff }
            : readRect(host, rect);
        const cell = cellOf(hdc);
        // Measured against an unbounded width when the rectangle is empty,
        // which is how a program asks how wide a string would be.
        const lines = layoutText(string, (format & DT_CALCRECT) !== 0 && isEmpty(bounds)
            ? { ...bounds, right: bounds.left + 0x7fff }
            : bounds, format, cell);
        const widthOf = cell.width ?? ((/** @type {string} */ piece)=>piece.length * cell.cellWidth);
        const widest = lines.reduce((most, line)=>Math.max(most, widthOf(line.text)), 0);
        const height = Math.max(lines.length, 1) * cell.cellHeight;

        if ((format & DT_CALCRECT) !== 0)
        {
            if ((rect >>> 0) !== 0)
            {
                writeRect(host, rect, {
                    left: bounds.left,
                    top: bounds.top,
                    right: (format & DT_WORDBREAK) !== 0 && !isEmpty(bounds)
                        ? bounds.right
                        : bounds.left + widest,
                    bottom: bounds.top + height,
                });
            }
            return height;
        }
        if ((hdc >>> 0) === 0 || !host.draw)
        {
            return 0;
        }
        for (const line of lines)
        {
            host.draw.text(hdc >>> 0, line.x, line.y, line.text, {
                clip: (rect >>> 0) === 0 ? null : bounds, transparent: false,
            });
            if (line.underline !== null)
            {
                const at = line.x + widthOf(line.text.slice(0, line.underline));
                host.draw.fill(hdc >>> 0, { left: at, top: line.y + cell.ascent,
                    right: at + widthOf(line.text[line.underline]),
                    bottom: line.y + cell.ascent + 1 },
                host.draw.textColor?.(hdc >>> 0) ?? 0);
            }
        }
        return height;
    };

    /**
     * GetTabbedTextExtent of either kind of text.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const tabbedExtent = ([hdc, text, count, positions, stops], wide)=>{
        if ((text >>> 0) === 0 || (count | 0) <= 0)
        {
            return 0;
        }
        const string = readCounted(text, count | 0, wide);
        const cell = cellOf(hdc);
        const widthOf = cell.width ?? ((/** @type {string} */ piece)=>piece.length * cell.cellWidth);
        const given = (stops >>> 0) === 0 ? 0 : Math.min(Math.max(positions | 0, 0), MAX_TAB_STOPS);
        const bytes = host.readMemory(stops >>> 0, given * 4);
        const list = Array.from({ length: given }, (_, index)=>
            bytes[index * 4] | bytes[index * 4 + 1] << 8 | bytes[index * 4 + 2] << 16
            | bytes[index * 4 + 3] << 24);
        // An x is as wide as the font's average character, near enough.
        const width = tabbedWidth(string, widthOf, list, TAB_CHARACTERS * widthOf('x'));
        return ((cell.cellHeight & 0xffff) << 16 | width & 0xffff) >>> 0;
    };

    const table = {
        /** HDC GetDC(HWND hWnd) */
        GetDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                if (noWindow(hwnd))
                {
                    return 0;
                }
                return handedOut(hwnd,
                    record ? contextOn(record) : contexts()?.get(hwnd >>> 0, null) ?? 0);
            },
        },

        /** int ReleaseDC(HWND hWnd, HDC hDC) */
        ReleaseDC: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, hdc])=>{
                if (noWindow(hwnd))
                {
                    return 0;
                }
                // A kept context is still its window's after it goes back.
                const kept = (held.get(hdc >>> 0)?.kind ?? 'cache') !== 'cache';
                const released = releaseContext(hwnd, hdc);
                if (released && !kept)
                {
                    owners.delete(hdc >>> 0);
                }
                if (released)
                {
                    painted();
                }
                return released;
            },
        },

        /**
         * HDC BeginPaint(HWND hWnd, LPPAINTSTRUCT lpPaint)
         *
         * Clearing the update region is the load-bearing part, not the DC.
         * The frame and the background go through the window procedure
         * first, which means guest code may run before this returns.
         */
        BeginPaint: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, paintStruct])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                return after(beginPaint(record), ({ hdc, rect, erase })=>{
                    writeU32s(host, paintStruct + PAINTSTRUCT.hdc, [hdc, erase ? 1 : 0]);
                    writeRect(host, paintStruct + PAINTSTRUCT.rcPaint, rect);
                    writeU32s(host, paintStruct + PAINTSTRUCT.fRestore, [0, 0]);
                    return handedOut(record.hwnd, hdc);
                });
            },
        },

        /** BOOL EndPaint(HWND hWnd, const PAINTSTRUCT *lpPaint) */
        EndPaint: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, paintStruct])=>{
                const record = live(hwnd);
                const hdc = host.readMemory(paintStruct + PAINTSTRUCT.hdc, 4);
                const handle = (hdc[0] | hdc[1] << 8 | hdc[2] << 16 | hdc[3] << 24) >>> 0;
                // A kept context is still its window's after the paint.
                if ((held.get(handle)?.kind ?? 'cache') === 'cache')
                {
                    owners.delete(handle);
                }
                if (record)
                {
                    endPaint(record, handle);
                }
                else if (handle !== 0)
                {
                    releaseContext(hwnd, handle);
                }
                return 1;
            },
        },

        /**
         * BOOL InvalidateRect(HWND hWnd, const RECT *lpRect, BOOL bErase)
         *
         * A null rectangle means the whole client area, which is not the same as
         * an empty one: the first repaints everything and the second nothing.
         */
        InvalidateRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, rect, erase])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                invalidate(record,
                    (rect >>> 0) === 0 ? clientArea(record) : ordered(readRect(host, rect)),
                    (erase >>> 0) !== 0);
                return 1;
            },
        },

        /**
         * BOOL InvalidateRgn(HWND hWnd, HRGN hRgn, BOOL bErase)
         *
         * The region's rectangles join the update region; a null region is
         * the whole client area.
         */
        InvalidateRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, region, erase])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                invalidate(record, regionArea(record, region), (erase >>> 0) !== 0);
                return 1;
            },
        },

        /**
         * BOOL RedrawWindow(HWND hWnd, const RECT *lprcUpdate, HRGN hrgnUpdate,
         *                   UINT flags)
         *
         * The two halves a program combines: RDW_INVALIDATE is InvalidateRect
         * or InvalidateRgn, RDW_VALIDATE is ValidateRect or ValidateRgn, and
         * RDW_UPDATENOW is UpdateWindow -- the window's own, and with
         * RDW_ALLCHILDREN its descendants' after it. RDW_ERASE marks the
         * background for erasing, as bErase does, and RDW_FRAME the frame
         * where the area reaches past the client area. RDW_ALLCHILDREN and
         * RDW_NOCHILDREN decide which children the change reaches.
         */
        RedrawWindow: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, rect, region, flags])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const whole = (region >>> 0) === 0 && (rect >>> 0) === 0;
                const area = (region >>> 0) !== 0 || whole
                    ? regionArea(record, region) : [ordered(readRect(host, rect))];
                const children = (flags & RDW_NOCHILDREN) !== 0 ? 'none'
                    : (flags & RDW_ALLCHILDREN) !== 0 ? 'all' : 'auto';
                if ((flags & RDW_INVALIDATE) !== 0)
                {
                    const client = clientArea(record);
                    if ((flags & RDW_FRAME) !== 0 && (whole
                        || area.some(piece=>!isEmpty(piece)
                            && subtractFromArea([piece], client).length > 0)))
                    {
                        record.ncDirty = true;
                        invalidated(record);
                    }
                    invalidate(record, area, (flags & RDW_ERASE) !== 0, children);
                }
                else if ((flags & RDW_VALIDATE) !== 0)
                {
                    validate(record, whole ? null : area, children);
                }
                // What is owed besides the area: a paint with nothing to
                // paint, given or taken back, and the background and the
                // frame no longer to be drawn -- for the window and the
                // children the flags reach (msg.c test_paint_messages).
                const reached = [record,
                    ...reachesChildren(record, children) ? descendants?.(record) ?? [] : []];
                for (const each of reached)
                {
                    if ((flags & RDW_INTERNALPAINT) !== 0)
                    {
                        each.internalPaint = true;
                        invalidated(each);
                    }
                    else if ((flags & RDW_NOINTERNALPAINT) !== 0)
                    {
                        each.internalPaint = false;
                    }
                    if ((flags & RDW_NOERASE) !== 0)
                    {
                        each.erase = false;
                    }
                    if ((flags & RDW_NOFRAME) !== 0)
                    {
                        each.ncDirty = false;
                    }
                }
                const thread = host.callerThread?.();
                const erased = (flags & RDW_ERASENOW) === 0 || (flags & RDW_UPDATENOW) !== 0 ? 1
                    : reached.filter(each=>shown(each)).reduce(
                        (/** @type {number | Promise<number>} */ chain, each)=>
                            after(chain, ()=>eraseNow(each, thread)), 1);
                return after(erased, ()=>((flags & RDW_UPDATENOW) === 0
                    ? 1 : updateNow(record, (flags & RDW_ALLCHILDREN) !== 0, thread)));
            },
        },

        /**
         * BOOL UpdateWindow(HWND hWnd)
         *
         * WM_PAINT is sent, not posted: the window procedure has painted by
         * the time this returns. A program that creates its window, calls
         * UpdateWindow and then goes straight to drawing its first frame --
         * or to a long load with no pump -- relies on it: a posted paint
         * lands after the frame, over it, or not until the load is done.
         * Its children paint too, after it: it is
         * RedrawWindow(RDW_UPDATENOW | RDW_ALLCHILDREN), and a dialog shown
         * and updated before a job that never pumps has its controls drawn.
         * Nothing to paint is success with nothing sent.
         */
        UpdateWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                return record ? updateNow(record, true) : 0;
            },
        },

        /**
         * BOOL GetUpdateRect(HWND hWnd, LPRECT lpRect, BOOL bErase)
         *
         * Answers whether there is anything to paint, which is what a program
         * checks before deciding to -- the frame alone counts -- and the
         * rectangle is the one around the update region. With bErase, what is
         * owed of the frame and the background is painted first, as
         * DispatchMessage would before WM_PAINT: the frame is then no longer
         * owed (msg.c test_paint_messages, WmGetUpdateRect).
         */
        GetUpdateRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, rect, erase])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const answer = ()=>{
                    if ((rect >>> 0) !== 0)
                    {
                        writeRect(host, rect,
                            record.updateRect ?? { left: 0, top: 0, right: 0, bottom: 0 });
                    }
                    return owesPaint(record) ? 1 : 0;
                };
                return (erase | 0) !== 0 ? after(eraseNow(record, host.callerThread?.()), answer)
                    : answer();
            },
        },

        /**
         * int DrawTextA(HDC hdc, LPCSTR lpchText, int cchText, LPRECT lprc, UINT format)
         *
         * DT_CALCRECT measures instead of drawing and writes the rectangle back,
         * which is what a program uses to lay itself out -- so this has to answer
         * even in a build with nothing to draw on.
         */
        DrawTextA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>drawText(args),
        },

        /**
         * int DrawTextExA(HDC, LPSTR, int, LPRECT, UINT, LPDRAWTEXTPARAMS)
         *
         * DrawTextA with a parameter block on the end -- margins and a tab
         * width -- which the layout above does not use.
         */
        DrawTextExA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>drawText(args.slice(0, 5)),
        },

        /**
         * int DrawTextW(HDC, LPCWSTR, int cchText, LPRECT, UINT)
         * int DrawTextExW(HDC, LPWSTR, int cchText, LPRECT, UINT, LPDRAWTEXTPARAMS)
         *
         * The same in UTF-16, the count in characters.
         */
        DrawTextW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>drawText(args, true),
        },

        DrawTextExW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>drawText(args.slice(0, 5), true),
        },

        /**
         * DWORD GetTabbedTextExtentA(HDC hDC, LPCSTR lpString, int chCount,
         *                            int nTabPositions, const INT *lpnTabStopPositions)
         * DWORD GetTabbedTextExtentW(HDC hDC, LPCWSTR lpString, int chCount,
         *                            int nTabPositions, const INT *lpnTabStopPositions)
         *
         * The width in the low word and the height in the high, the tabs
         * expanded as `tabbedWidth` lays them out; zero for no text.
         */
        GetTabbedTextExtentA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>tabbedExtent(args, false),
        },
        GetTabbedTextExtentW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>tabbedExtent(args, true),
        },

        /**
         * HWND WindowFromDC(HDC hDC)
         *
         * The window a context from GetDC, GetDCEx, GetWindowDC or BeginPaint
         * is on, until it is released; the screen's context is the desktop's.
         * Null for any other context -- one in memory, one released, one on a
         * window that has since been destroyed.
         */
        WindowFromDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hdc])=>{
                const owner = owners.get(hdc >>> 0);
                if (owner === undefined)
                {
                    return 0;
                }
                return owner === 0 ? options.desktop?.() ?? 0 : live(owner)?.hwnd ?? 0;
            },
        },

        /**
         * int FillRect(HDC hDC, const RECT *lprc, HBRUSH hbr)
         *
         * The brush is a handle the program owns, or a system colour plus
         * one, which is the convention a class background uses too. With
         * nowhere to draw the three rectangle fills report failure, so a
         * program is not told a fill happened that did not.
         */
        FillRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, rect, brush])=>{
                const draw = host.draw;
                if (!draw)
                {
                    return 0;
                }
                const handle = brush >>> 0;
                const area = readRect(host, rect);
                if (handle >= 1 && handle <= SYS_COLOR_BRUSH_LIMIT)
                {
                    return draw.fill(hdc >>> 0, area, draw.sysColor(handle - 1)) ? 1 : 0;
                }
                return draw.fillWith(hdc >>> 0, area, handle) ? 1 : 0;
            },
        },

        /** BOOL InvertRect(HDC hDC, const RECT *lprc) */
        InvertRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, rect])=>(host.draw?.invert(hdc >>> 0, readRect(host, rect)) ? 1 : 0),
        },

        /** BOOL FrameRect(HDC hDC, const RECT *lprc, HBRUSH hbr) */
        FrameRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, rect, brush])=>(host.draw?.frame(hdc >>> 0, readRect(host, rect),
                brush >>> 0) ? 1 : 0),
        },

        /**
         * HDC GetDCEx(HWND hWnd, HRGN hrgnClip, DWORD flags)
         *
         * The flags select whether the non-client area is included --
         * DCX_WINDOW, so a program that paints its own frame draws on it --
         * whether the class's context is passed over for the cache's, and
         * the region the context is kept to or kept out of, which is the
         * system's from then on.
         */
        GetDCEx: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, region, flags])=>{
                const DCX_WINDOW = 0x1;
                const record = live(hwnd);
                if (noWindow(hwnd))
                {
                    return 0;
                }
                return handedOut(hwnd, record
                    ? contextOn(record, (flags & DCX_WINDOW) !== 0, flags >>> 0, region >>> 0)
                    : contexts()?.get(hwnd >>> 0, null) ?? 0);
            },
        },

        /**
         * HDC GetWindowDC(HWND hWnd)
         *
         * The whole window, frame included: what a program that paints its
         * own caption draws on. The origin is the window's corner.
         */
        GetWindowDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                if (noWindow(hwnd))
                {
                    return 0;
                }
                return handedOut(hwnd,
                    record ? contextOn(record, true) : contexts()?.get(hwnd >>> 0, null) ?? 0);
            },
        },

        /**
         * int GetUpdateRgn(HWND hWnd, HRGN hRgn, BOOL bErase)
         *
         * The caller supplies the region and this fills it in, which needs the
         * object table those regions live in -- gdi32's, which user32 cannot
         * reach. Without the service that bridges them the honest answer is
         * ERROR: reporting a complexity for a region left holding whatever it
         * held before would have the caller clip to the wrong shape. The
         * region is filled with the update area's own pieces, and the answer
         * says what it then holds.
         */
        GetUpdateRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, region, erase])=>{
                const ERROR = 0;
                const NULLREGION = 1;
                const SIMPLEREGION = 2;
                const COMPLEXREGION = 3;
                const record = live(hwnd);
                const setRegion = host.setRegion;
                if (!record || !setRegion)
                {
                    return ERROR;
                }
                const answer = ()=>{
                    const area = areaOf(updateOf(record));
                    setRegion(region >>> 0, area);
                    return area.length === 0 ? NULLREGION
                        : area.length === 1 ? SIMPLEREGION : COMPLEXREGION;
                };
                // With bErase, the frame and the background first, as
                // DispatchMessage paints them (msg.c WmDispatchPaint).
                return (erase | 0) !== 0 ? after(eraseNow(record, host.callerThread?.()), answer)
                    : answer();
            },
        },

        /**
         * BOOL DrawEdge(HDC hdc, LPRECT qrc, UINT edge, UINT grfFlags)
         *
         * The four edge styles are two rings of shaded lines each; the
         * border flags choose which sides, and BF_ADJUST shrinks the
         * rectangle by what was drawn, for a caller laying content inside.
         */
        DrawEdge: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hdc, rect, edge, flags])=>{
                const draw = host.draw;
                if (!draw || (rect >>> 0) === 0)
                {
                    return 0;
                }
                const area = drawEdges(hdc >>> 0, readRect(host, rect), edge, flags);
                if ((flags & BF_MIDDLE) !== 0)
                {
                    draw.fill(hdc >>> 0, area, draw.sysColor(COLOR_3DFACE));
                }
                if ((flags & BF_ADJUST) !== 0)
                {
                    writeRect(host, rect, area);
                }
                return 1;
            },
        },

        /**
         * BOOL DrawFrameControl(HDC hdc, LPRECT lprc, UINT uType, UINT uState)
         *
         * A button drawn the way the button control draws its own: a push
         * button raised, or sunken when pushed, DFCS_ADJUSTRECT leaving the
         * rectangle as what is inside its edge; a check box's sunken square
         * or a radio button's ring, centred in the rectangle, with the mark
         * when checked. A menu's check mark or bullet is black on white, the
         * way a program takes it for a mask. A caption or scroll button, or a
         * menu's arrow, is drawn without its picture, said once.
         */
        DrawFrameControl: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hdc, rect, type, state])=>{
                const DFC_CAPTION = 1;
                const DFC_MENU = 2;
                const DFC_BUTTON = 4;
                const DFC_POPUPMENU = 5;
                const DFCS_MENUCHECK = 0x1;
                const DFCS_MENUBULLET = 0x2;
                const DFCS_BUTTONRADIOIMAGE = 0x1;
                const DFCS_BUTTONRADIOMASK = 0x2;
                const DFCS_BUTTONRADIO = 0x4;
                const DFCS_BUTTON3STATE = 0x8;
                const DFCS_BUTTONPUSH = 0x10;
                const DFCS_INACTIVE = 0x100;
                const DFCS_PUSHED = 0x200;
                const DFCS_CHECKED = 0x400;
                const DFCS_ADJUSTRECT = 0x2000;
                const DFCS_FLAT = 0x4000;
                const draw = host.draw;
                if (!draw || (rect >>> 0) === 0 || type < DFC_CAPTION || type > DFC_POPUPMENU)
                {
                    return 0;
                }
                const h = hdc >>> 0;
                const area = readRect(host, rect);
                const pushed = (state & DFCS_PUSHED) !== 0;
                const flat = (state & DFCS_FLAT) !== 0;
                if (type === DFC_MENU || type === DFC_POPUPMENU)
                {
                    const kind = state & 0xff;
                    const picture = kind === DFCS_MENUCHECK ? CHECK_MARK
                        : kind === DFCS_MENUBULLET ? RADIO_DOT : null;
                    draw.fill(h, area, 0xffffff);
                    if (picture)
                    {
                        glyph(h, picture, area, 0);
                    }
                    else
                    {
                        tellOnce('DrawFrameControl', 'a menu arrow is left out');
                    }
                    return 1;
                }
                if (type === DFC_BUTTON && (state & DFCS_BUTTONPUSH) === 0)
                {
                    const side = Math.max(0,
                        Math.min(area.right - area.left, area.bottom - area.top));
                    const left = area.left + ((area.right - area.left - side) >> 1);
                    const top = area.top + ((area.bottom - area.top - side) >> 1);
                    const box = { left, top, right: left + side, bottom: top + side };
                    const checked = (state & DFCS_CHECKED) !== 0;
                    const radio = (state & (DFCS_BUTTONRADIO | DFCS_BUTTONRADIOIMAGE
                        | DFCS_BUTTONRADIOMASK)) !== 0;
                    const grey = (state & DFCS_INACTIVE) !== 0 || pushed
                        || (checked && (state & DFCS_BUTTON3STATE) !== 0);
                    const face = draw.sysColor(grey ? COLOR_3DFACE : COLOR_WINDOW);
                    const ink = draw.sysColor((state & DFCS_INACTIVE) !== 0
                        ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT);
                    if (radio)
                    {
                        glyph(h, RADIO_RING_DARK, box, draw.sysColor(COLOR_3DSHADOW));
                        glyph(h, RADIO_RING_LIGHT, box, draw.sysColor(COLOR_3DHILIGHT));
                        const ring = (side - RADIO_RING_DARK.length) >> 1;
                        draw.fill(h, { left: left + ring + 2, top: top + ring + 2,
                            right: left + ring + 10, bottom: top + ring + 10 }, face);
                    }
                    else
                    {
                        draw.fill(h,
                            drawEdges(h, box, flat ? BDR_SUNKENOUTER : EDGE_SUNKEN, BF_RECT), face);
                    }
                    if (checked)
                    {
                        glyph(h, radio ? RADIO_DOT : CHECK_MARK, box, ink);
                    }
                    return 1;
                }
                draw.fill(h, area, draw.sysColor(COLOR_3DFACE));
                const inside = drawEdges(h, area, flat
                    ? (pushed ? BDR_SUNKENOUTER : BDR_RAISEDOUTER)
                    : (pushed ? EDGE_SUNKEN : EDGE_RAISED), BF_RECT);
                if (type !== DFC_BUTTON)
                {
                    tellOnce('DrawFrameControl', 'a caption or scroll button is drawn without its'
                        + ' picture');
                }
                if ((state & DFCS_ADJUSTRECT) !== 0)
                {
                    writeRect(host, rect, inside);
                }
                return 1;
            },
        },

        /**
         * BOOL DrawState(HDC hdc, HBRUSH hbrFore, DRAWSTATEPROC qfnCallBack,
         *   LPARAM lData, WPARAM wData, int x, int y, int cx, int cy, UINT uFlags)
         */
        DrawStateA: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: args=>drawState(args, false),
        },

        /** DrawStateA with UTF-16 text. */
        DrawStateW: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: args=>drawState(args, true),
        },

        /**
         * BOOL DrawIcon(HDC hDC, int X, int Y, HICON hIcon)
         *
         * The icon at its own size, its transparent pixels leaving what is
         * under them. One whose picture cannot be read -- a standard icon, a
         * form the decoder does not take -- is left out and the call still
         * succeeds, because a program draws an icon for decoration and stops
         * for nothing if the decoration is refused. Said once per run, since a
         * progress display draws its icon on every tick.
         */
        DrawIcon: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hdc, x, y, icon])=>{
                drawIcon(hdc, x, y, icon, 0, 0);
                return 1;
            },
        },

        /**
         * BOOL DrawIconEx(HDC hdc, int xLeft, int yTop, HICON hIcon, int cxWidth,
         *   int cyWidth, UINT istepIfAniCur, HBRUSH hbrFlickerFreeDraw, UINT diFlags)
         *
         * DrawIcon at the size asked for: a width or height of zero is the
         * icon's own, or the system's icon size with DI_DEFAULTSIZE. A brush
         * fills the rectangle first, as the flicker-free form draws over it;
         * flags asking for neither the image nor the mask draw nothing.
         */
        DrawIconEx: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([hdc, x, y, icon, width, height, step, brush, flags])=>{
                void step;
                const DI_NORMAL = 0x0003;
                const DI_DEFAULTSIZE = 0x0008;
                const SYSTEM_ICON = 32;
                if ((flags & DI_NORMAL) === 0)
                {
                    return 0;
                }
                const size = (/** @type {number} */ asked, /** @type {number} */ own)=>((asked | 0) > 0
                    ? asked | 0 : (flags & DI_DEFAULTSIZE) !== 0 ? SYSTEM_ICON : own);
                const picture = host.picture?.(icon >>> 0) ?? null;
                const w = size(width, picture?.width ?? SYSTEM_ICON);
                const h = size(height, picture?.height ?? SYSTEM_ICON);
                if ((brush >>> 0) !== 0)
                {
                    host.draw?.fillWith?.(hdc >>> 0,
                        { left: x | 0, top: y | 0, right: (x | 0) + w, bottom: (y | 0) + h },
                        brush >>> 0);
                }
                drawIcon(hdc, x, y, icon, w, h);
                return 1;
            },
        },

        /**
         * BOOL DrawFocusRect(HDC hDC, const RECT *lprc)
         *
         * The focus rectangle is drawn by inverting, which is what makes
         * drawing it twice erase it -- a one-pixel border inverted through the
         * system's gray brush, so every other pixel: dotted, over whatever a
         * skin painted. Without somewhere to invert, failing is the only
         * answer that does not leave a program believing it has a rectangle
         * it must later remove.
         */
        DrawFocusRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, rect])=>{
                const draw = host.draw;
                if (!draw)
                {
                    return 0;
                }
                const area = readRect(host, rect);
                const h = hdc >>> 0;
                return draw.invert(h, { ...area, bottom: area.top + 1 }, true)
                    && draw.invert(h, { ...area, top: area.bottom - 1 }, true)
                    && draw.invert(h, { ...area, top: area.top + 1, bottom: area.bottom - 1,
                        right: area.left + 1 }, true)
                    && draw.invert(h, { ...area, top: area.top + 1, bottom: area.bottom - 1,
                        left: area.right - 1 }, true) ? 1 : 0;
            },
        },

        /**
         * BOOL ValidateRect(HWND hWnd, const RECT *lpRect)
         *
         * A null rectangle validates everything. Otherwise the rectangle is
         * taken out of the update region, so a program that paints a strip
         * itself and validates it is not sent a WM_PAINT for that strip.
         */
        ValidateRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, rect])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                validate(record, (rect >>> 0) === 0 ? null : [ordered(readRect(host, rect))]);
                return 1;
            },
        },

        /**
         * BOOL LockWindowUpdate(HWND hWndLock)
         *
         * One window at a time: while one is locked, locking any fails, and a
         * null window unlocks. Drawing into the locked window is not held
         * back -- a program locks one against flicker while it changes it, and
         * the picture it ends with is the same.
         */
        LockWindowUpdate: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const window = hwnd >>> 0;
                if (window === 0)
                {
                    lockedWindow = 0;
                    return 1;
                }
                if (lockedWindow !== 0 || !live(window))
                {
                    return 0;
                }
                lockedWindow = window;
                host.divergence?.('LockWindowUpdate', 'drawing is not held back while locked');
                return 1;
            },
        },

        /** BOOL ValidateRgn(HWND hWnd, HRGN hRgn) */
        ValidateRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, region])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                // A region that cannot be read validates everything, as no
                // region does: what it names cannot be told apart.
                const readable = (region >>> 0) !== 0 && host.regionBox?.(region >>> 0);
                validate(record, readable ? regionArea(record, region) : null);
                return 1;
            },
        },

        /**
         * int ExcludeUpdateRgn(HDC hDC, HWND hWnd)
         *
         * A context on the window's client area made to leave alone what is
         * still to be repainted: a program drawing outside WM_PAINT keeps off
         * the area its paint will cover anyway. Answers the kind of region
         * left to draw in -- none, one rectangle or more -- or ERROR for no
         * window.
         */
        ExcludeUpdateRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, hwnd])=>{
                const ERROR = 0;
                const NULLREGION = 1;
                const SIMPLEREGION = 2;
                const COMPLEXREGION = 3;
                const record = live(hwnd);
                if (!record || (hdc >>> 0) === 0)
                {
                    return ERROR;
                }
                const visible = visibleArea(record, false, geometry.clientRect(record));
                const area = subtractAreas(visible, updateOf(record));
                host.draw?.clip?.(hdc >>> 0, area);
                return area.length === 0 ? NULLREGION
                    : area.length === 1 ? SIMPLEREGION : COMPLEXREGION;
            },
        },
    };

    return { table, beginPaint, endPaint, invalidate, validate, updateNow, eraseNow, clientArea,
        cellOf, contextOn, owesPaint, updateOf, refreshContext, forgetContexts };
}

/** A brush argument up to this is a system colour index plus one. */
const SYS_COLOR_BRUSH_LIMIT = 31;

/** The offsets a test asserts against, so a change to the layout is visible. */
export const PAINT_LAYOUT = Object.freeze({ PAINTSTRUCT, RECT });
