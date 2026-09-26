/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a window is: the frame its styles give it, the client area inside the
 * frame, and both of them in screen coordinates.
 *
 * A window record keeps the rectangle CreateWindowEx was given, which is the
 * outside of the frame, relative to the parent's client area for a child.
 * Everything else -- what GetClientRect answers, where a device context on
 * the window draws, which window a point on the screen falls in -- is derived
 * here, from one set of metrics, so that AdjustWindowRect and GetClientRect
 * cannot disagree about how wide a border is.
 */

/** Window styles that decide how much frame a window has. */
export const WS_BORDER = 0x00800000;
export const WS_DLGFRAME = 0x00400000;
export const WS_THICKFRAME = 0x00040000;
export const WS_CAPTION = WS_BORDER | WS_DLGFRAME;
export const WS_VSCROLL = 0x00200000;
export const WS_HSCROLL = 0x00100000;
export const WS_CHILD = 0x40000000;
export const WS_VISIBLE = 0x10000000;
export const WS_DISABLED = 0x08000000;

/**
 * Extended styles that add frame of their own. A client rectangle grown
 * without them comes out short by the edge on every side.
 */
export const WS_EX_DLGMODALFRAME = 0x00000001;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_WINDOWEDGE = 0x00000100;
export const WS_EX_CLIENTEDGE = 0x00000200;
export const WS_EX_STATICEDGE = 0x00020000;

/**
 * The classic non-client metrics: a border line, a caption, the frame a
 * sizing window carries (a two-pixel outer edge, the sizing border and the
 * border line) and a dialog frame (the outer edge and the border line).
 */
export const BORDER = 1;
export const CAPTION_HEIGHT = 19;
export const SIZE_FRAME = 4;
export const DIALOG_FRAME = 3;
export const SCROLLBAR = 16;
/** A tool window's caption is shorter than an ordinary one's. */
export const TOOL_CAPTION_HEIGHT = 12;

/**
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * @typedef {Object} Frame
 * @property {number} left     Pixels of frame on the left.
 * @property {number} top      On the top, the caption included.
 * @property {number} right    On the right, a vertical scroll bar included.
 * @property {number} bottom   On the bottom, a horizontal one included.
 * @property {number} edge     The border alone, without caption or bars.
 * @property {number} caption  The caption's height, or zero without one.
 */

/**
 * How much frame a window's styles give it.
 *
 * The edges add up rather than replace one another: a dialog or sizing
 * frame's outer edge, the sizing border inside it, a border line, and a
 * client edge inside all of them. WS_EX_WINDOWEDGE is the look of the outer
 * edge a dialog or sizing frame already has, not width of its own.
 *
 * @param {number} style @param {number} [exStyle]
 * @returns {Frame}
 */
export function frameOf(style, exStyle = 0){
    const thick = (style & WS_THICKFRAME) !== 0;
    const border = (style & (WS_BORDER | WS_DLGFRAME)) !== 0;
    const modal = (exStyle & WS_EX_DLGMODALFRAME) !== 0;
    const clientEdge = (exStyle & WS_EX_CLIENTEDGE) !== 0;
    const staticEdge = (exStyle & WS_EX_STATICEDGE) !== 0;

    // A static edge on its own is a one-pixel outer edge; a dialog or sizing
    // frame's is two.
    let edge = staticEdge && !modal ? BORDER
        : modal || thick || (style & WS_DLGFRAME) !== 0 ? 2 * BORDER : 0;
    edge += thick ? BORDER : 0;
    edge += border || modal ? BORDER : 0;
    edge += clientEdge ? 2 * BORDER : 0;

    const captioned = (style & WS_CAPTION) === WS_CAPTION;
    const caption = captioned
        ? ((exStyle & WS_EX_TOOLWINDOW) !== 0 ? TOOL_CAPTION_HEIGHT : CAPTION_HEIGHT)
        : 0;
    return {
        left: edge,
        top: edge + caption,
        right: edge + ((style & WS_VSCROLL) !== 0 ? SCROLLBAR : 0),
        bottom: edge + ((style & WS_HSCROLL) !== 0 ? SCROLLBAR : 0),
        edge,
        caption,
    };
}

/** No frame at all: what a window covering the display is given. */
const NO_FRAME = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0, edge: 0, caption: 0 });

/**
 * @typedef {Object} PlacedWindow
 * @property {number} hwnd
 * @property {number} parent
 * @property {number} style
 * @property {number} exStyle
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {boolean} [frameless]
 *           A window a fullscreen device took over: it covers the display,
 *           and the frame its style describes is not drawn and takes no room.
 */

/**
 * Answers about where windows are, over whatever holds the records.
 *
 * @param {(hwnd: number) => PlacedWindow | null} windowOf
 *        A window by handle, live or not; null for a handle that is no window.
 */
export function createGeometry(windowOf){
    /** @param {PlacedWindow} record @returns {Frame} */
    const frame = record=>(record.frameless ? NO_FRAME : frameOf(record.style, record.exStyle));

    /**
     * The window a child is placed inside. An owned top-level window names
     * its owner in the same field and is placed on the screen regardless:
     * only WS_CHILD makes the position relative.
     *
     * @param {PlacedWindow} record
     */
    const container = record=>((record.style & WS_CHILD) !== 0 && record.parent
        ? windowOf(record.parent)
        : null);

    /**
     * The client area's size: the window less its frame, never negative.
     *
     * @param {PlacedWindow} record
     */
    const clientSize = record=>{
        const edges = frame(record);
        return {
            width: Math.max(0, record.width - edges.left - edges.right),
            height: Math.max(0, record.height - edges.top - edges.bottom),
        };
    };

    /**
     * Where the window's own rectangle begins on the screen. A child's
     * position is relative to its parent's client area, so the parents are
     * walked up to the top.
     *
     * @param {PlacedWindow} record
     * @returns {{ x: number, y: number }}
     */
    const windowOrigin = record=>{
        const parent = container(record);
        if (!parent)
        {
            return { x: record.x, y: record.y };
        }
        const origin = clientOrigin(parent);
        return { x: origin.x + record.x, y: origin.y + record.y };
    };

    /**
     * Where the client area begins on the screen.
     *
     * @param {PlacedWindow} record
     * @returns {{ x: number, y: number }}
     */
    const clientOrigin = record=>{
        const origin = windowOrigin(record);
        const edges = frame(record);
        return { x: origin.x + edges.left, y: origin.y + edges.top };
    };

    /** @param {PlacedWindow} record @returns {Rect} the window on the screen */
    const windowRect = record=>{
        const origin = windowOrigin(record);
        return {
            left: origin.x,
            top: origin.y,
            right: origin.x + record.width,
            bottom: origin.y + record.height,
        };
    };

    /** @param {PlacedWindow} record @returns {Rect} the client area on the screen */
    const clientRect = record=>{
        const origin = clientOrigin(record);
        const size = clientSize(record);
        return {
            left: origin.x,
            top: origin.y,
            right: origin.x + size.width,
            bottom: origin.y + size.height,
        };
    };

    /**
     * The part of the client area a window may actually draw in: its own
     * client rectangle, cut down by every ancestor's. A child that hangs out
     * of its parent is clipped there, as it is on the screen.
     *
     * @param {PlacedWindow} record
     * @returns {Rect}
     */
    const visibleClientRect = record=>{
        let rect = clientRect(record);
        for (let parent = container(record); parent; parent = container(parent))
        {
            rect = intersect(rect, clientRect(parent));
        }
        return rect;
    };

    /**
     * The window's whole rectangle, frame included, cut down the same way:
     * what a context on the window rather than its client area covers.
     *
     * @param {PlacedWindow} record
     * @returns {Rect}
     */
    const visibleWindowRect = record=>{
        let rect = windowRect(record);
        for (let parent = container(record); parent; parent = container(parent))
        {
            rect = intersect(rect, clientRect(parent));
        }
        return rect;
    };

    return {
        frame, container, clientSize, windowOrigin, clientOrigin, windowRect, clientRect,
        visibleClientRect, visibleWindowRect,
    };
}

/** @param {Rect} a @param {Rect} b @returns {Rect} the overlap, possibly empty */
export function intersect(a, b){
    return {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };
}

/** @param {Rect} rect */
export function isEmpty(rect){
    return rect.right <= rect.left || rect.bottom <= rect.top;
}

/** @param {Rect} rect @param {number} x @param {number} y */
export function contains(rect, x, y){
    return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}
