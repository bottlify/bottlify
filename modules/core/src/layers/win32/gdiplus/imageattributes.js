/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s image attributes: how an image's colours are adjusted as it is
 * drawn - a colour key, a remap table, a colour matrix, gamma, a threshold,
 * or nothing at all - each set for a kind of drawing (ColorAdjustType) or
 * for every kind at once (Default), and the wrap a drawn image's edge takes.
 * Drawing an image adjusts by the bitmap kind's settings, the default
 * kind's where the bitmap kind has none, in GDI+'s order: key, remap,
 * matrix, gamma, threshold.
 */

import { Status, fn } from './kit.js';

/** ColorAdjustType. */
const ColorAdjustTypeDefault = 0;
const ColorAdjustTypeBitmap = 1;
const ColorAdjustTypeCount = 5;
/** ColorMatrixFlags. */
const ColorMatrixFlagsSkipGrays = 1;
const ColorMatrixFlagsAltGray = 2;

/**
 * @typedef {Object} Adjustment
 * @property {boolean} noop
 * @property {{ color: number[], gray: number[] | null, flags: number } | null} matrix
 * @property {number | null} threshold @property {number | null} gamma
 * @property {[number, number] | null} key  low and high ARGB
 * @property {Map<number, number> | null} remap
 * @property {number | null} channel
 *
 * @typedef {{ kinds: Adjustment[], wrap: number, colour: number, clamp: boolean }} Attributes
 */

/** @returns {Adjustment} */
const none = ()=>({ noop: false, matrix: null, threshold: null, gamma: null, key: null,
    remap: null, channel: null });
/** @param {Adjustment} a */
const isSet = a=>a.noop || a.matrix !== null || a.threshold !== null || a.gamma !== null
    || a.key !== null || a.remap !== null || a.channel !== null;

/**
 * A colour through an adjustment, [b, g, r, a] numbers 0 to 255.
 *
 * @param {Adjustment} a @param {number[]} colour
 * @returns {number[]}
 */
export function adjust(a, colour){
    if (a.noop)
    {
        return colour;
    }
    let [b, g, r, alpha] = colour;
    if (a.key)
    {
        const [low, high] = a.key;
        /** @param {number} v @param {number} shift */
        const within = (v, shift)=>v >= (low >>> shift & 0xff) && v <= (high >>> shift & 0xff);
        if (within(r, 16) && within(g, 8) && within(b, 0))
        {
            return [0, 0, 0, 0];
        }
    }
    if (a.remap)
    {
        const mapped = a.remap.get((alpha << 24 | r << 16 | g << 8 | b) >>> 0);
        if (mapped !== undefined)
        {
            [b, g, r, alpha] = [mapped & 0xff, mapped >>> 8 & 0xff, mapped >>> 16 & 0xff,
                mapped >>> 24];
        }
    }
    if (a.matrix)
    {
        const grey = r === g && g === b;
        const { color, gray, flags } = a.matrix;
        if (!(grey && flags === ColorMatrixFlagsSkipGrays))
        {
            const m = grey && flags === ColorMatrixFlagsAltGray && gray ? gray : color;
            const input = [r / 255, g / 255, b / 255, alpha / 255, 1];
            const out = [0, 1, 2, 3].map(c=>input.reduce((sum, v, row)=>sum + v * m[row * 5 + c],
                0));
            [r, g, b, alpha] = out.map(v=>Math.round(Math.max(0, Math.min(1, v)) * 255));
        }
    }
    if (a.gamma !== null)
    {
        const gamma = a.gamma;
        [r, g, b] = [r, g, b].map(v=>Math.round(255 * (v / 255) ** gamma));
    }
    if (a.threshold !== null)
    {
        const t = a.threshold * 255;
        [r, g, b] = [r, g, b].map(v=>(v > t ? 255 : 0));
    }
    return [b, g, r, alpha];
}

/** @param {import('./kit.js').Kit} kit */
export function createImageAttributesFunctions(kit){
    const { Ok, InvalidParameter } = Status;
    /** @param {number} at @returns {Attributes | undefined} */
    const get = at=>kit.get(at, 'attributes');
    /**
     * A setter for one kind of adjustment: `type` checked, `enable` false
     * clears what `clear` names.
     *
     * @param {number} argBytes
     * @param {(a: Adjustment, args: number[]) => number} set
     * @param {(a: Adjustment) => void} clear
     */
    const setting = (argBytes, set, clear)=>fn(argBytes, ([at, type, enable, ...rest])=>{
        const attributes = get(at);
        if (!attributes || (type >>> 0) >= ColorAdjustTypeCount)
        {
            return InvalidParameter;
        }
        const a = attributes.kinds[type >>> 0];
        if (enable === 0)
        {
            clear(a);
            return Ok;
        }
        return set(a, rest);
    });

    const functions = {
        /** Status GdipCreateImageAttributes(GpImageAttributes **attributes) */
        GdipCreateImageAttributes: fn(4, ([out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.add('attributes', /** @type {Attributes} */ ({ kinds: Array.from(
                { length: ColorAdjustTypeCount }, none), wrap: 4, colour: 0, clamp: false }), out);
            return Ok;
        }),
        /**
         * Status GdipCloneImageAttributes(GpImageAttributes *attributes, GpImageAttributes **clone)
         */
        GdipCloneImageAttributes: fn(8, ([at, out])=>{
            const attributes = get(at);
            if (!attributes || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.add('attributes', { ...attributes, kinds: attributes.kinds.map(a=>({ ...a,
                remap: a.remap && new Map(a.remap) })) }, out);
            return Ok;
        }),
        /** Status GdipDisposeImageAttributes(GpImageAttributes *attributes) */
        GdipDisposeImageAttributes: fn(4, ([at])=>(kit.remove(at, 'attributes') ? Ok
            : InvalidParameter)),
        /**
         * Status GdipSetImageAttributesColorMatrix(GpImageAttributes *attributes,
         *   ColorAdjustType type, BOOL enable, const ColorMatrix *color,
         *   const ColorMatrix *gray, ColorMatrixFlags flags)
         */
        GdipSetImageAttributesColorMatrix: setting(24, (a, [color, gray, flags])=>{
            if ((color >>> 0) === 0 || (flags >>> 0) > ColorMatrixFlagsAltGray
                || ((flags >>> 0) === ColorMatrixFlagsAltGray && (gray >>> 0) === 0))
            {
                return InvalidParameter;
            }
            a.matrix = { color: kit.f32s(color, 25), gray: (gray >>> 0) === 0 ? null
                : kit.f32s(gray, 25), flags: flags >>> 0 };
            return Ok;
        }, a=>{
            a.matrix = null;
        }),
        /**
         * Status GdipSetImageAttributesThreshold(GpImageAttributes *, ColorAdjustType,
         *     ColorAdjustTyp BOOL, ColorAdjustTyp REAL)
         */
        GdipSetImageAttributesThreshold: setting(16, (a, [threshold])=>{
            a.threshold = kit.real(threshold);
            return Ok;
        }, a=>{
            a.threshold = null;
        }),
        /**
         * Status GdipSetImageAttributesGamma(GpImageAttributes *, ColorAdjustType,
         *     ColorAdjustTyp BOOL, ColorAdjustTyp REAL)
         */
        GdipSetImageAttributesGamma: setting(16, (a, [gamma])=>{
            const value = kit.real(gamma);
            if (!(value > 0))
            {
                return InvalidParameter;
            }
            a.gamma = value;
            return Ok;
        }, a=>{
            a.gamma = null;
        }),
        /** Status GdipSetImageAttributesNoOp(GpImageAttributes *, ColorAdjustType, BOOL enable) */
        GdipSetImageAttributesNoOp: setting(12, a=>{
            a.noop = true;
            return Ok;
        }, a=>{
            a.noop = false;
        }),
        /**
         * Status GdipSetImageAttributesColorKeys(GpImageAttributes *, ColorAdjustType, BOOL,
         *   ARGB low, ARGB high)
         */
        GdipSetImageAttributesColorKeys: setting(20, (a, [low, high])=>{
            a.key = [low >>> 0, high >>> 0];
            return Ok;
        }, a=>{
            a.key = null;
        }),
        /**
         * Status GdipSetImageAttributesOutputChannel(GpImageAttributes *, ColorAdjustType,
         *   BOOL, ColorChannelFlags)
         */
        GdipSetImageAttributesOutputChannel: setting(16, (a, [channel])=>{
            if ((channel >>> 0) > 3)
            {
                return InvalidParameter;
            }
            a.channel = channel >>> 0;
            return Ok;
        }, a=>{
            a.channel = null;
        }),
        /**
         * Status GdipSetImageAttributesOutputChannelColorProfile(GpImageAttributes *,
         *   ColorAdjustType, BOOL, const WCHAR *profile): a CMYK profile is not applied.
         */
        GdipSetImageAttributesOutputChannelColorProfile: setting(16, ()=>Ok, ()=>{}),
        /**
         * Status GdipSetImageAttributesRemapTable(GpImageAttributes *, ColorAdjustType, BOOL,
         *   UINT size, const ColorMap *map)
         */
        GdipSetImageAttributesRemapTable: setting(20, (a, [size, map])=>{
            if ((map >>> 0) === 0 || (size >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const values = kit.i32s(map, (size >>> 0) * 2);
            a.remap = new Map(Array.from({ length: size >>> 0 }, (_, i)=>[values[i * 2] >>> 0,
                values[i * 2 + 1] >>> 0]));
            return Ok;
        }, a=>{
            a.remap = null;
        }),
        /**
         * Status GdipSetImageAttributesWrapMode(GpImageAttributes *attributes, WrapMode wrap,
         *   ARGB colour, BOOL clamp)
         */
        GdipSetImageAttributesWrapMode: fn(16, ([at, wrap, colour, clamp])=>{
            const attributes = get(at);
            if (!attributes || (wrap >>> 0) > 4)
            {
                return InvalidParameter;
            }
            attributes.wrap = wrap >>> 0;
            attributes.colour = colour >>> 0;
            attributes.clamp = clamp !== 0;
            return Ok;
        }),
        /** Status GdipSetImageAttributesCachedBackground(GpImageAttributes *, BOOL enable) */
        GdipSetImageAttributesCachedBackground: fn(8, ([at])=>(get(at) ? Ok : InvalidParameter)),
        /** Status GdipSetImageAttributesToIdentity(GpImageAttributes *, ColorAdjustType type) */
        GdipSetImageAttributesToIdentity: fn(8, ([at, type])=>{
            const attributes = get(at);
            if (!attributes || (type >>> 0) >= ColorAdjustTypeCount)
            {
                return InvalidParameter;
            }
            attributes.kinds[type >>> 0] = none();
            return Ok;
        }),
        /** Status GdipResetImageAttributes(GpImageAttributes *, ColorAdjustType type) */
        GdipResetImageAttributes: fn(8, ([at, type])=>{
            const attributes = get(at);
            if (!attributes || (type >>> 0) >= ColorAdjustTypeCount)
            {
                return InvalidParameter;
            }
            attributes.kinds[type >>> 0] = none();
            return Ok;
        }),
        /**
         * Status GdipGetImageAttributesAdjustedPalette(GpImageAttributes *attributes,
         *   ColorPalette *palette, ColorAdjustType type)
         *
         * The palette's colours through one kind's adjustment, in place.
         */
        GdipGetImageAttributesAdjustedPalette: fn(12, ([at, palette, type])=>{
            const attributes = get(at);
            if (!attributes || (palette >>> 0) === 0 || (type >>> 0) >= ColorAdjustTypeCount
                || (type >>> 0) === ColorAdjustTypeDefault)
            {
                return InvalidParameter;
            }
            const count = kit.u32(palette + 4);
            if (count === 0)
            {
                return InvalidParameter;
            }
            const a = attributes.kinds[type >>> 0];
            const entries = kit.i32s(palette + 8, count).map(c=>{
                const [b, g, r, alpha] = adjust(a, [c & 0xff, c >>> 8 & 0xff, c >>> 16 & 0xff,
                    c >>> 24 & 0xff]);
                return (alpha << 24 | r << 16 | g << 8 | b) >>> 0;
            });
            kit.write(palette + 8, new Uint8Array(Uint32Array.from(entries).buffer));
            return Ok;
        }),
    };
    return {
        functions,
        /**
         * How drawing an image adjusts its colours by these attributes: the
         * bitmap kind's settings, else the default kind's; null for none.
         *
         * @param {number} at
         */
        forImages: at=>{
            const attributes = get(at);
            if (!attributes)
            {
                return null;
            }
            const own = attributes.kinds[ColorAdjustTypeBitmap];
            const a = isSet(own) ? own : attributes.kinds[ColorAdjustTypeDefault];
            return isSet(a) ? (/** @type {number[]} */ colour)=>adjust(a, colour) : null;
        },
    };
}
