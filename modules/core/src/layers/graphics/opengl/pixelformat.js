/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Pixel formats: the structure, the list we advertise, and the choosing rule.
 *
 * The structure's offsets are spelled out because a PIXELFORMATDESCRIPTOR is
 * not a run of DWORDs -- two WORDs, then twenty single bytes with no padding
 * between them, then three DWORDs -- and a field read one byte out of place is
 * a plausible colour depth rather than a fault.
 *
 * The choosing rule is the part that surprises. Three properties of it were
 * established by measurement and none of them follow from the documentation:
 *
 * - **Only flags filter; every number is a preference.** Asking for an
 *   auxiliary buffer nobody offers still returns a format, and so does asking
 *   for a pixel type that does not exist -- the answer is then RGBA.
 * - **Depth is preferred large, not close.** Asking for no depth at all does
 *   not get a format without one; it gets the deepest on offer. The only way
 *   to ask for no depth buffer is PFD_DEPTH_DONTCARE, which inverts the
 *   preference.
 * - **Stencil outranks depth.** With PFD_DEPTH_DONTCARE and a stencil request,
 *   a format with both is a better answer than one with neither, so stencil
 *   has to be compared before depth rather than after it.
 *
 * Double buffering and stereo are the two flags that filter in both
 * directions: not asking for them excludes the formats that have them, unless
 * the matching DONTCARE bit says otherwise. Every other flag is a requirement
 * when set and says nothing when clear.
 */

import { PFD } from './constants.js';

/**
 * PIXELFORMATDESCRIPTOR. Twenty consecutive BYTEs sit between the header and
 * the three layer masks, which is why the offsets past 8 advance by one.
 */
export const PIXELFORMATDESCRIPTOR = Object.freeze({
    nSize: 0,
    nVersion: 2,
    dwFlags: 4,
    iPixelType: 8,
    cColorBits: 9,
    cRedBits: 10,
    cRedShift: 11,
    cGreenBits: 12,
    cGreenShift: 13,
    cBlueBits: 14,
    cBlueShift: 15,
    cAlphaBits: 16,
    cAlphaShift: 17,
    cAccumBits: 18,
    cAccumRedBits: 19,
    cAccumGreenBits: 20,
    cAccumBlueBits: 21,
    cAccumAlphaBits: 22,
    cDepthBits: 23,
    cStencilBits: 24,
    cAuxBuffers: 25,
    iLayerType: 26,
    bReserved: 27,
    dwLayerMask: 28,
    dwVisibleMask: 32,
    dwDamageMask: 36,
    SIZE: 40,
});

/** The fields at byte offsets 8 through 27, in layout order. */
const BYTE_FIELDS = Object.freeze([
    'iPixelType', 'cColorBits', 'cRedBits', 'cRedShift', 'cGreenBits', 'cGreenShift',
    'cBlueBits', 'cBlueShift', 'cAlphaBits', 'cAlphaShift', 'cAccumBits', 'cAccumRedBits',
    'cAccumGreenBits', 'cAccumBlueBits', 'cAccumAlphaBits', 'cDepthBits', 'cStencilBits',
    'cAuxBuffers', 'iLayerType', 'bReserved',
]);

/** The fields at DWORD offsets, in layout order. */
const DWORD_FIELDS = Object.freeze(['dwLayerMask', 'dwVisibleMask', 'dwDamageMask']);

/**
 * @typedef {Object} PixelFormat
 * @property {number} nSize
 * @property {number} nVersion
 * @property {number} dwFlags
 * @property {number} iPixelType
 * @property {number} cColorBits
 * @property {number} cRedBits
 * @property {number} cRedShift
 * @property {number} cGreenBits
 * @property {number} cGreenShift
 * @property {number} cBlueBits
 * @property {number} cBlueShift
 * @property {number} cAlphaBits
 * @property {number} cAlphaShift
 * @property {number} cAccumBits
 * @property {number} cAccumRedBits
 * @property {number} cAccumGreenBits
 * @property {number} cAccumBlueBits
 * @property {number} cAccumAlphaBits
 * @property {number} cDepthBits
 * @property {number} cStencilBits
 * @property {number} cAuxBuffers
 * @property {number} iLayerType
 * @property {number} bReserved
 * @property {number} dwLayerMask
 * @property {number} dwVisibleMask
 * @property {number} dwDamageMask
 */

/**
 * @typedef {Object} PixelFormatMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {PixelFormatMemory} memory
 * @param {number} address
 * @returns {PixelFormat}
 */
export function readPixelFormatDescriptor(memory, address){
    return decodePixelFormat(memory.readMemory(address, PIXELFORMATDESCRIPTOR.SIZE));
}

/**
 * @param {Uint8Array} bytes  at least PIXELFORMATDESCRIPTOR.SIZE of them
 * @returns {PixelFormat}
 */
export function decodePixelFormat(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /** @type {any} */
    const format = {
        nSize: view.getUint16(PIXELFORMATDESCRIPTOR.nSize, true),
        nVersion: view.getUint16(PIXELFORMATDESCRIPTOR.nVersion, true),
        dwFlags: view.getUint32(PIXELFORMATDESCRIPTOR.dwFlags, true) >>> 0,
    };
    BYTE_FIELDS.forEach((name, index)=>{
        format[name] = bytes[PIXELFORMATDESCRIPTOR.iPixelType + index];
    });
    DWORD_FIELDS.forEach((name, index)=>{
        format[name] = view.getUint32(PIXELFORMATDESCRIPTOR.dwLayerMask + index * 4, true) >>> 0;
    });
    return format;
}

/**
 * Writes as much of a format as the caller said it had room for. A program
 * that passes a smaller size gets a truncated structure rather than a
 * corrupted stack, which is the whole reason DescribePixelFormat takes one.
 *
 * @param {PixelFormatMemory} memory
 * @param {number} address
 * @param {PixelFormat} format
 * @param {number} bytesAvailable
 */
export function writePixelFormatDescriptor(memory, address, format, bytesAvailable){
    const bytes = encodePixelFormat(format);
    const length = Math.min(bytesAvailable, PIXELFORMATDESCRIPTOR.SIZE);
    if (length > 0)
    {
        memory.writeMemory(address, bytes.subarray(0, length));
    }
}

/**
 * @param {PixelFormat} format
 * @returns {Uint8Array} PIXELFORMATDESCRIPTOR.SIZE bytes
 */
export function encodePixelFormat(format){
    const bytes = new Uint8Array(PIXELFORMATDESCRIPTOR.SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint16(PIXELFORMATDESCRIPTOR.nSize, PIXELFORMATDESCRIPTOR.SIZE, true);
    view.setUint16(PIXELFORMATDESCRIPTOR.nVersion, format.nVersion, true);
    view.setUint32(PIXELFORMATDESCRIPTOR.dwFlags, format.dwFlags >>> 0, true);
    BYTE_FIELDS.forEach((name, index)=>{
        bytes[PIXELFORMATDESCRIPTOR.iPixelType + index] = /** @type {any} */ (format)[name] & 0xff;
    });
    DWORD_FIELDS.forEach((name, index)=>{
        const value = /** @type {any} */ (format)[name] >>> 0;
        view.setUint32(PIXELFORMATDESCRIPTOR.dwLayerMask + index * 4, value, true);
    });
    return bytes;
}

/**
 * @param {Partial<PixelFormat>} fields
 * @returns {PixelFormat}
 */
function pixelFormat(fields){
    return {
        nSize: PIXELFORMATDESCRIPTOR.SIZE,
        nVersion: 1,
        dwFlags: 0,
        iPixelType: PFD.TYPE_RGBA,
        cColorBits: 32,
        cRedBits: 8,
        cRedShift: 16,
        cGreenBits: 8,
        cGreenShift: 8,
        cBlueBits: 8,
        cBlueShift: 0,
        cAlphaBits: 8,
        cAlphaShift: 24,
        cAccumBits: 0,
        cAccumRedBits: 0,
        cAccumGreenBits: 0,
        cAccumBlueBits: 0,
        cAccumAlphaBits: 0,
        cDepthBits: 0,
        cStencilBits: 0,
        cAuxBuffers: 0,
        iLayerType: PFD.MAIN_PLANE,
        bReserved: 0,
        dwLayerMask: 0,
        dwVisibleMask: 0,
        dwDamageMask: 0,
        ...fields,
    };
}

/** Depth and stencil pairings, in the order the list offers them. */
const DEPTH_STENCIL = Object.freeze([[0, 0], [16, 0], [24, 0], [24, 8], [32, 8]]);

/**
 * The formats this implementation advertises, indexed from one.
 *
 * Only the combinations the backend can genuinely back are here: a format that
 * is offered and then fails to produce a context is worse than one that was
 * never offered, because a program picks on the strength of the offer and has
 * no second choice. The bitmap-capable ones carry SUPPORT_GDI and
 * GENERIC_FORMAT because they are exactly that -- the unaccelerated path onto
 * a DIB -- and they come last so that a request naming neither gets the
 * accelerated answer.
 *
 * @type {readonly PixelFormat[]}
 */
export const PIXEL_FORMATS = Object.freeze([
    ...DEPTH_STENCIL.map(([depth, stencil])=>pixelFormat({
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL,
        cDepthBits: depth,
        cStencilBits: stencil,
    })),
    ...DEPTH_STENCIL.map(([depth, stencil])=>pixelFormat({
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER | PFD.SWAP_EXCHANGE,
        cDepthBits: depth,
        cStencilBits: stencil,
    })),
    ...DEPTH_STENCIL.map(([depth, stencil])=>pixelFormat({
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.DRAW_TO_BITMAP | PFD.SUPPORT_OPENGL
            | PFD.SUPPORT_GDI | PFD.GENERIC_FORMAT,
        cDepthBits: depth,
        cStencilBits: stencil,
    })),
]);

/** The three request-only bits, which no described format ever carries. */
const DONTCARE_BITS = PFD.DEPTH_DONTCARE | PFD.DOUBLEBUFFER_DONTCARE | PFD.STEREO_DONTCARE;

/**
 * @param {PixelFormat} candidate
 * @param {PixelFormat} request
 * @returns {boolean}
 */
function flagsAccept(candidate, request){
    const required = (request.dwFlags & ~DONTCARE_BITS) >>> 0;
    if ((candidate.dwFlags & required) !== required)
    {
        return false;
    }
    /** @param {number} bit @param {number} dontCare */
    const matched = (bit, dontCare)=>(request.dwFlags & dontCare) !== 0
        || ((candidate.dwFlags & bit) !== 0) === ((request.dwFlags & bit) !== 0);
    return matched(PFD.DOUBLEBUFFER, PFD.DOUBLEBUFFER_DONTCARE)
        && matched(PFD.STEREO, PFD.STEREO_DONTCARE);
}

/**
 * The comparison vector, lowest wins, compared left to right. The order is the
 * specification: swapping stencil and depth changes which format a program
 * gets for a request that names both.
 *
 * @param {PixelFormat} candidate
 * @param {PixelFormat} request
 * @param {number} index
 * @returns {number[]}
 */
function matchCost(candidate, request, index){
    /**
     * A field that is satisfied by more and penalised heavily for less.
     *
     * @param {number} have
     * @param {number} want
     */
    const atLeast = (have, want)=>(have >= want ? have - want : (want - have) * 0x100);
    const depthDontCare = (request.dwFlags & PFD.DEPTH_DONTCARE) !== 0;
    return [
        candidate.iPixelType === request.iPixelType ? 0 : 1,
        atLeast(candidate.cColorBits, request.cColorBits),
        atLeast(candidate.cAlphaBits, request.cAlphaBits),
        Math.abs(candidate.cStencilBits - request.cStencilBits),
        depthDontCare ? candidate.cDepthBits : -candidate.cDepthBits,
        atLeast(candidate.cAccumBits, request.cAccumBits),
        atLeast(candidate.cAuxBuffers, request.cAuxBuffers),
        index,
    ];
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean} whether a is the better match
 */
function better(a, b){
    for (let i = 0; i < a.length; i++)
    {
        if (a[i] !== b[i])
        {
            return a[i] < b[i];
        }
    }
    return false;
}

/**
 * @param {PixelFormat} request
 * @param {readonly PixelFormat[]} [formats]
 * @returns {number} the one-based index of the best match, or zero
 */
export function choosePixelFormat(request, formats = PIXEL_FORMATS){
    let bestIndex = 0;
    /** @type {number[] | null} */
    let bestCost = null;
    formats.forEach((candidate, index)=>{
        if (!flagsAccept(candidate, request))
        {
            return;
        }
        const cost = matchCost(candidate, request, index);
        if (bestCost === null || better(cost, bestCost))
        {
            bestCost = cost;
            bestIndex = index + 1;
        }
    });
    return bestIndex;
}
