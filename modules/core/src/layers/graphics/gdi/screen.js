/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The screen as the desktop window manager composes it: the desktop's
 * background, and every top-level window on a surface of its own over it,
 * bottom to top. No window draws on another's pixels, so a window that goes,
 * moves or is covered leaves nothing behind and needs no other window to
 * paint for it to look right.
 *
 * A window's context draws on its top-level window's surface, at its place
 * in it; the background's context on the background; a screen context on the
 * screen as shown, which stays until the screen is composed again -- when a
 * window or the background drew, or a window moved, appeared or went.
 *
 * The surfaces are 32 bits a pixel, top-down, in memory the caller allocates
 * -- guest memory in the engine, so the presenter reads the screen the way it
 * reads a DirectDraw primary. They are made on the first context rather than
 * at start-up, so a program that draws only through a device never pays for
 * them.
 */

import { createSurface, dibPitch, intersectRect, isEmptyRect, viewOf } from './surface.js';

/**
 * @typedef {import('./contract.js').Rect} Rect
 * @typedef {{ buffer: number, pitch: number, bitCount: number, palette: null,
 *     width: number, height: number, surface: import('./contract.js').Surface }} HeldSurface
 * @typedef {{ hwnd: number, rect: Rect, shown: boolean, shape: Rect[] }} ComposedWindow
 */

/**
 * @param {Object} options
 * @param {(bytes: number) => number} options.allocate  An address, or zero.
 * @param {(address: number) => void} [options.free]
 * @param {(address: number, length: number) => Uint8Array} options.bytesAt
 *        A view of the memory at an address; empty once the memory has grown
 *        under it, when it is asked for again.
 * @param {() => { width: number, height: number }} options.size  The display's.
 * @param {(hwnd: number) => { hwnd: number, rect: Rect } | null} [options.surfaceOf]
 *        The top-level window whose surface a window draws on, and where it is.
 * @param {() => ComposedWindow[]} [options.windows]  The top-level windows, bottom to top.
 */
export function createScreen(options){
    const free = options.free ?? (()=>{});
    const DETACHED = new Uint8Array(0);

    /**
     * @param {number} buffer @param {number} pitch
     * @param {number} width @param {number} height
     */
    const viewOfBuffer = (buffer, pitch, width, height)=>createSurface({
        width, height, pitch, bytes: options.bytesAt(buffer, pitch * height),
    });
    /** @param {number} width @param {number} height @returns {HeldSurface | null} */
    const allocate = (width, height)=>{
        const pitch = dibPitch(width, 32);
        const buffer = options.allocate(pitch * height) >>> 0;
        if (buffer === 0)
        {
            return null;
        }
        const surface = viewOfBuffer(buffer, pitch, width, height);
        surface.bytes.fill(0);
        return { buffer, pitch, bitCount: 32, palette: null, width, height, surface };
    };
    /**
     * The surface, its view taken again when the memory grew: every view of
     * the old buffer went with it, and the pixels are still at the same address.
     *
     * @template {HeldSurface} T @param {T} held @returns {T}
     */
    const fresh = held=>{
        if (held.surface.bytes.length === 0)
        {
            held.surface = viewOfBuffer(held.buffer, held.pitch, held.width, held.height);
        }
        return held;
    };
    /** @param {HeldSurface | null} held @returns {HeldSurface | null} it at the display's size */
    const displaySized = held=>{
        const size = options.size();
        if (held && (held.width !== size.width || held.height !== size.height))
        {
            free(held.buffer);
            held = null;
        }
        return held ? fresh(held) : allocate(size.width, size.height);
    };
    /**
     * Copies a rectangle between two surfaces, a row at a time.
     *
     * @param {HeldSurface} from @param {number} fromX @param {number} fromY
     * @param {HeldSurface} to @param {number} toX @param {number} toY
     * @param {number} width @param {number} height
     */
    const copyRows = (from, fromX, fromY, to, toX, toY, width, height)=>{
        const source = from.surface.bytes;
        const target = to.surface.bytes;
        for (let y = 0; y < height; y++)
        {
            const at = (fromY + y) * from.pitch + fromX * 4;
            target.set(source.subarray(at, at + width * 4), (toY + y) * to.pitch + toX * 4);
        }
    };

    /** @type {HeldSurface | null} the desktop's background, under every window */
    let background = null;
    /** @type {HeldSurface | null} the screen: the background and the windows over it */
    let shown = null;
    const backgroundSurface = ()=>(background = displaySized(background));
    const screenSurface = ()=>(shown = displaySized(shown));

    /**
     * Each top-level window's surface, its whole rectangle, by handle.
     * `retired` is set when it is given up -- the window resized or gone --
     * and every view of it then reads as detached, which has a context bound
     * to it take a view again before its next draw.
     *
     * @type {Map<number, HeldSurface & { retired: boolean }>}
     */
    const windows = new Map();
    /** @param {HeldSurface & { retired: boolean }} held */
    const retire = held=>{
        held.retired = true;
        free(held.buffer);
    };
    /**
     * A top-level window's surface at its size now. Resized, what it showed
     * stays at its corner and the rest is the window's to paint, as user32
     * marks it.
     *
     * @param {number} hwnd @param {Rect} rect
     */
    const windowSurface = (hwnd, rect)=>{
        const width = Math.max(1, rect.right - rect.left);
        const height = Math.max(1, rect.bottom - rect.top);
        const held = windows.get(hwnd);
        if (held && held.width === width && held.height === height)
        {
            return fresh(held);
        }
        const made = allocate(width, height);
        if (!made)
        {
            return null;
        }
        const next = { ...made, retired: false };
        if (held)
        {
            copyRows(fresh(held), 0, 0, next, 0, 0,
                Math.min(width, held.width), Math.min(height, held.height));
            retire(held);
        }
        windows.set(hwnd, next);
        return next;
    };

    /** Whether a window's or the background's pixels may have changed since it was composed. */
    let stale = true;
    /** The windows' places and the screen's buffer when it was composed. */
    let layout = '';

    /**
     * The screen's pixels now: the background, then each shown top-level
     * window's surface where its region keeps it, bottom to top -- composed
     * again only when something changed. The surfaces of windows that are
     * gone are given up here.
     *
     * @returns {HeldSurface | null}
     */
    const compose = ()=>{
        const target = screenSurface();
        if (!target)
        {
            return null;
        }
        const listed = options.windows?.() ?? [];
        const live = new Set(listed.map(each=>each.hwnd));
        for (const [hwnd, held] of windows)
        {
            if (!live.has(hwnd))
            {
                retire(held);
                windows.delete(hwnd);
            }
        }
        const now = [target.buffer, ...listed.map(each=>[each.hwnd, ...each.shape.flatMap(
            piece=>[piece.left, piece.top, piece.right, piece.bottom])].join(','))].join('|');
        if (!stale && now === layout)
        {
            return target;
        }
        stale = false;
        layout = now;
        const base = backgroundSurface();
        if (base)
        {
            target.surface.bytes.set(base.surface.bytes.subarray(0, base.pitch * base.height));
        }
        const screen = { left: 0, top: 0, right: target.width, bottom: target.height };
        for (const each of listed)
        {
            const held = each.shown ? windows.get(each.hwnd) : undefined;
            if (!held)
            {
                continue;
            }
            fresh(held);
            const rect = each.rect;
            const inside = { left: rect.left, top: rect.top,
                right: rect.left + Math.min(held.width, rect.right - rect.left),
                bottom: rect.top + Math.min(held.height, rect.bottom - rect.top) };
            for (const piece of each.shape)
            {
                const cut = intersectRect(intersectRect(piece, inside), screen);
                if (!isEmptyRect(cut))
                {
                    copyRows(held, cut.left - rect.left, cut.top - rect.top, target,
                        cut.left, cut.top, cut.right - cut.left, cut.bottom - cut.top);
                }
            }
        }
        return target;
    };

    /**
     * The view a window context draws through: its top-level window's
     * surface, at the context's place in it; null for a context on no window.
     *
     * @param {{ window?: number, bounds?: Rect | null }} dc
     */
    const windowView = dc=>{
        const owner = dc.window ? options.surfaceOf?.(dc.window) ?? null : null;
        const held = owner ? windowSurface(owner.hwnd, owner.rect) : null;
        if (!owner || !held)
        {
            return null;
        }
        const bounds = dc.bounds ?? owner.rect;
        const view = viewOf(held.surface, {
            left: bounds.left - owner.rect.left, top: bounds.top - owner.rect.top,
            right: bounds.right - owner.rect.left, bottom: bounds.bottom - owner.rect.top,
        });
        const bytes = view.bytes;
        Object.defineProperty(view, 'bytes', { get: ()=>(held.retired ? DETACHED : bytes) });
        return view;
    };

    return {
        background: backgroundSurface,
        /** The screen's surface, as last composed. */
        screen: screenSurface,
        compose,
        windowSurface,
        copyRows,
        /** The next composition is a whole one: something changed under the screen. */
        invalidate(){
            stale = true;
        },
        /**
         * A draw through a context was shown: one on a window or the background
         * has the screen composed again; one on the screen itself is shown as
         * drawn. Without a context, anything may have changed.
         *
         * @param {{ window?: number, background?: boolean }} [dc]
         */
        drawnOn(dc){
            if (!dc || dc.background || (dc.window && options.surfaceOf?.(dc.window)))
            {
                stale = true;
            }
        },
        /**
         * The pixels a window, background or screen context draws on.
         *
         * @param {{ window?: number, background?: boolean, bounds?: Rect | null }} dc
         */
        surfaceFor(dc){
            const onWindow = dc.background ? null : windowView(dc);
            if (onWindow)
            {
                return onWindow;
            }
            // A screen context draws over what is shown now.
            const held = dc.background ? backgroundSurface() : compose();
            if (!held)
            {
                return null;
            }
            return viewOf(held.surface, dc.bounds
                ?? { left: 0, top: 0, right: held.width, bottom: held.height });
        },
    };
}
