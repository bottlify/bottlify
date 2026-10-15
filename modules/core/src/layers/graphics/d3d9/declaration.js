/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex declarations: what a vertex is made of, element by element.
 *
 * Direct3D 9 replaced the flexible vertex format with an array of elements,
 * each naming a stream, an offset, a type, a usage and a usage index, closed
 * by a sentinel. The old format is still accepted, and the two are
 * convertible in a way that programs observe: setting a format makes a
 * declaration a program can read back, and a declaration built by the program
 * that happens to describe a format is *not* reported as one. So both
 * directions of the conversion are here, and so is the fact that they are not
 * inverses.
 *
 * Validation is a table of ranges rather than a chain of conditions, because
 * that is what it is: a stream, a type, a method and a usage each have a last
 * legal value, an offset must be dword-aligned, and an element type that
 * means "unused" is only ever legal in the sentinel.
 */

import { D3DERR_INVALIDCALL, D3D_OK } from './constants.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { D3DDECL_END_STREAM } from './structs.js';

/** D3DDECLTYPE. */
export const D3DDECLTYPE = Object.freeze({
    FLOAT1: 0,
    FLOAT2: 1,
    FLOAT3: 2,
    FLOAT4: 3,
    D3DCOLOR: 4,
    UBYTE4: 5,
    SHORT2: 6,
    SHORT4: 7,
    UBYTE4N: 8,
    SHORT2N: 9,
    SHORT4N: 10,
    USHORT2N: 11,
    USHORT4N: 12,
    UDEC3: 13,
    DEC3N: 14,
    FLOAT16_2: 15,
    FLOAT16_4: 16,
    UNUSED: 17,
});

/** Bytes each type occupies in the stream, indexed by D3DDECLTYPE. */
export const DECLTYPE_BYTES = Object.freeze([4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 8, 4, 8, 4, 4, 4, 8]);

/** D3DDECLUSAGE. */
export const D3DDECLUSAGE = Object.freeze({
    POSITION: 0,
    BLENDWEIGHT: 1,
    BLENDINDICES: 2,
    NORMAL: 3,
    PSIZE: 4,
    TEXCOORD: 5,
    TANGENT: 6,
    BINORMAL: 7,
    TESSFACTOR: 8,
    POSITIONT: 9,
    COLOR: 10,
    FOG: 11,
    DEPTH: 12,
    SAMPLE: 13,
});

/** D3DDECLMETHOD. Only DEFAULT is drawn; the rest are tessellator inputs. */
export const D3DDECLMETHOD = Object.freeze({
    DEFAULT: 0,
    PARTIALU: 1,
    PARTIALV: 2,
    CROSSUV: 3,
    UV: 4,
    LOOKUP: 5,
    LOOKUPPRESAMPLED: 6,
});

/** MAXD3DDECLLENGTH: the most elements a declaration may hold, sentinel excluded. */
export const MAX_DECLARATION_LENGTH = 64;

/** The most streams a device has, which bounds an element's stream number. */
export const MAX_STREAMS = 16;

/**
 * @typedef {Object} VertexElement
 * @property {number} Stream
 * @property {number} Offset
 * @property {number} Type        D3DDECLTYPE
 * @property {number} Method      D3DDECLMETHOD
 * @property {number} Usage       D3DDECLUSAGE
 * @property {number} UsageIndex
 */

/** @returns {VertexElement} the sentinel that closes every declaration */
export function declarationEnd(){
    return {
        Stream: D3DDECL_END_STREAM, Offset: 0, Type: D3DDECLTYPE.UNUSED, Method: 0,
        Usage: 0, UsageIndex: 0,
    };
}

/** @param {VertexElement} element */
export function isDeclarationEnd(element){
    return element.Stream === D3DDECL_END_STREAM;
}

/**
 * Whether an array of elements is a declaration a device accepts.
 *
 * The sentinel is not part of what is checked: it is the array's end, and a
 * caller passing one without it is passing a declaration with no end, which
 * the reader stops at anyway. What is refused is a stream past the last one,
 * a type past the last named or the unused one in a real element, a method
 * or usage past its last value, an offset not a multiple of four, the same
 * usage and index twice, and more elements than a declaration may hold.
 *
 * @param {readonly VertexElement[]} elements  Without the sentinel.
 * @returns {number} D3D_OK or D3DERR_INVALIDCALL
 */
export function validateElements(elements){
    if (elements.length > MAX_DECLARATION_LENGTH)
    {
        return D3DERR_INVALIDCALL;
    }
    /** @type {Set<number>} */
    const seen = new Set();
    for (const element of elements)
    {
        if (element.Stream >= MAX_STREAMS
            || element.Type >= D3DDECLTYPE.UNUSED
            || element.Method > D3DDECLMETHOD.LOOKUPPRESAMPLED
            || element.Usage > D3DDECLUSAGE.SAMPLE
            || (element.Offset & 3) !== 0)
        {
            return D3DERR_INVALIDCALL;
        }
        const key = (element.Usage << 8) | element.UsageIndex;
        if (seen.has(key))
        {
            return D3DERR_INVALIDCALL;
        }
        seen.add(key);
    }
    return D3D_OK;
}

/**
 * The bytes between one vertex and the next in a stream, as the elements
 * describing that stream imply: the end of the element that reaches furthest.
 *
 * @param {readonly VertexElement[]} elements
 * @param {number} stream
 */
export function strideOf(elements, stream){
    let stride = 0;
    for (const element of elements)
    {
        if (element.Stream === stream)
        {
            stride = Math.max(stride, element.Offset + DECLTYPE_BYTES[element.Type]);
        }
    }
    return stride;
}

/**
 * The two bits from bit 16 up that give a coordinate set's size, as a type.
 *
 * @type {readonly number[]}
 */
const TEXCOORD_TYPES = Object.freeze([
    D3DDECLTYPE.FLOAT2, D3DDECLTYPE.FLOAT3, D3DDECLTYPE.FLOAT4, D3DDECLTYPE.FLOAT1,
]);

const FVF_XYZW = 0x4002;
const FVF_LASTBETA_UBYTE4 = 0x1000;
const FVF_LASTBETA_D3DCOLOR = 0x8000;
const FVF_POSITION_MASK = 0x00e;

/**
 * The elements a flexible vertex format stands for, in the order the format
 * lays them out: position and its blend weights, the normal, the point size,
 * the two colours, then each coordinate set. Every element is in stream zero
 * at the offset the previous ones add up to, which is how the format defines
 * its vertex.
 *
 * @param {number} fvf
 * @returns {VertexElement[] | null} null when the format is not one
 */
export function elementsOfFvf(fvf){
    /** @type {VertexElement[]} */
    const elements = [];
    let offset = 0;
    /**
     * @param {number} type @param {number} usage @param {number} usageIndex
     */
    const push = (type, usage, usageIndex)=>{
        elements.push({
            Stream: 0, Offset: offset, Type: type, Method: D3DDECLMETHOD.DEFAULT,
            Usage: usage, UsageIndex: usageIndex,
        });
        offset += DECLTYPE_BYTES[type];
    };

    const position = fvf & FVF_POSITION_MASK;
    if ((fvf & FVF_XYZW) === FVF_XYZW)
    {
        push(D3DDECLTYPE.FLOAT4, D3DDECLUSAGE.POSITION, 0);
    }
    else if (position === FVF.XYZRHW)
    {
        push(D3DDECLTYPE.FLOAT4, D3DDECLUSAGE.POSITIONT, 0);
    }
    else if (position === FVF.XYZ)
    {
        push(D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.POSITION, 0);
    }
    else if (position >= FVF.XYZB1 && position <= FVF.XYZB5)
    {
        push(D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.POSITION, 0);
        // The beta count, and whether the last one is really a set of indices.
        let betas = ((position - FVF.XYZB1) >>> 1) + 1;
        const lastIsIndices = (fvf & (FVF_LASTBETA_UBYTE4 | FVF_LASTBETA_D3DCOLOR)) !== 0;
        if (lastIsIndices)
        {
            betas--;
        }
        if (betas > 0)
        {
            push(D3DDECLTYPE.FLOAT1 + betas - 1, D3DDECLUSAGE.BLENDWEIGHT, 0);
        }
        if (lastIsIndices)
        {
            push((fvf & FVF_LASTBETA_UBYTE4) !== 0 ? D3DDECLTYPE.UBYTE4 : D3DDECLTYPE.D3DCOLOR,
                D3DDECLUSAGE.BLENDINDICES, 0);
        }
    }
    else if (position !== 0)
    {
        return null;
    }
    if ((fvf & FVF.NORMAL) !== 0)
    {
        push(D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.NORMAL, 0);
    }
    if ((fvf & FVF.PSIZE) !== 0)
    {
        push(D3DDECLTYPE.FLOAT1, D3DDECLUSAGE.PSIZE, 0);
    }
    if ((fvf & FVF.DIFFUSE) !== 0)
    {
        push(D3DDECLTYPE.D3DCOLOR, D3DDECLUSAGE.COLOR, 0);
    }
    if ((fvf & FVF.SPECULAR) !== 0)
    {
        push(D3DDECLTYPE.D3DCOLOR, D3DDECLUSAGE.COLOR, 1);
    }
    const sets = (fvf & FVF.TEXCOUNT_MASK) >>> FVF.TEXCOUNT_SHIFT;
    if (sets > 8)
    {
        return null;
    }
    for (let set = 0; set < sets; set++)
    {
        push(TEXCOORD_TYPES[(fvf >>> (16 + set * 2)) & 3], D3DDECLUSAGE.TEXCOORD, set);
    }
    return elements;
}

/** @param {VertexElement} a @param {VertexElement} b */
const sameElement = (a, b)=>a.Stream === b.Stream && a.Offset === b.Offset && a.Type === b.Type
    && a.Method === b.Method && a.Usage === b.Usage && a.UsageIndex === b.UsageIndex;

/**
 * The flexible vertex format an array of elements is the layout of, or zero.
 *
 * A format is only recovered when the elements are exactly what
 * `elementsOfFvf` would produce for it: the same members, in the format's
 * order, at the format's offsets. Anything else -- a second stream, a gap, a
 * tangent, a coordinate set out of order -- has no format, and a draw that
 * needs one cannot be given it.
 *
 * @param {readonly VertexElement[]} elements  Without the sentinel.
 * @returns {number}
 */
export function fvfOfElements(elements){
    let fvf = 0;
    let coordinateSets = 0;
    for (const element of elements)
    {
        switch (element.Usage)
        {
            case D3DDECLUSAGE.POSITION:
                fvf |= element.Type === D3DDECLTYPE.FLOAT4 ? FVF_XYZW : FVF.XYZ;
                break;
            case D3DDECLUSAGE.POSITIONT:
                fvf |= FVF.XYZRHW;
                break;
            case D3DDECLUSAGE.BLENDWEIGHT:
                // The count of weights is folded into the position field.
                fvf = (fvf & ~FVF_POSITION_MASK)
                    | (FVF.XYZB1 + ((element.Type - D3DDECLTYPE.FLOAT1) << 1));
                break;
            case D3DDECLUSAGE.BLENDINDICES:
                fvf |= element.Type === D3DDECLTYPE.UBYTE4
                    ? FVF_LASTBETA_UBYTE4
                    : FVF_LASTBETA_D3DCOLOR;
                // Indices take one more beta than the weights alone.
                fvf = (fvf & ~FVF_POSITION_MASK)
                    | Math.min(FVF.XYZB5, ((fvf & FVF_POSITION_MASK) || FVF.XYZ) + 2);
                break;
            case D3DDECLUSAGE.NORMAL:
                fvf |= FVF.NORMAL;
                break;
            case D3DDECLUSAGE.PSIZE:
                fvf |= FVF.PSIZE;
                break;
            case D3DDECLUSAGE.COLOR:
                fvf |= element.UsageIndex === 0 ? FVF.DIFFUSE : FVF.SPECULAR;
                break;
            case D3DDECLUSAGE.TEXCOORD: {
                const size = TEXCOORD_TYPES.indexOf(element.Type);
                if (size < 0)
                {
                    return 0;
                }
                coordinateSets = Math.max(coordinateSets, element.UsageIndex + 1);
                fvf |= size << (16 + element.UsageIndex * 2);
                break;
            }
            default:
                return 0;
        }
    }
    fvf |= coordinateSets << FVF.TEXCOUNT_SHIFT;
    const canonical = elementsOfFvf(fvf >>> 0);
    if (!canonical || canonical.length !== elements.length
        || !canonical.every((element, index)=>sameElement(element, elements[index])))
    {
        return 0;
    }
    return fvf >>> 0;
}

/**
 * @typedef {Object} FixedFunctionLayout
 * @property {number} id           The declaration's, so two layouts are told apart.
 * @property {{ name: string, offset: number, format: string, bytes: number,
 *     stream: number }[]} attributes
 * @property {boolean} preTransformed
 * @property {number} texCoordSets
 * @property {number[]} streams    The streams past zero it reads, in order.
 */

/**
 * What the fixed-function vertex stage reads each coordinate type as.
 *
 * @type {Readonly<Record<number, string>>}
 */
const TEXCOORD_FORMATS = Object.freeze({
    [D3DDECLTYPE.FLOAT1]: 'float32',
    [D3DDECLTYPE.FLOAT2]: 'float32x2',
    [D3DDECLTYPE.FLOAT3]: 'float32x3',
    [D3DDECLTYPE.FLOAT4]: 'float32x4',
    [D3DDECLTYPE.FLOAT16_2]: 'float16x2',
    [D3DDECLTYPE.FLOAT16_4]: 'float16x4',
});

/**
 * Usages the fixed-function pipeline has no use for, and ignores.
 *
 * @type {ReadonlySet<number>}
 */
const IGNORED_BY_FIXED_FUNCTION = new Set([
    D3DDECLUSAGE.TANGENT, D3DDECLUSAGE.BINORMAL, D3DDECLUSAGE.TESSFACTOR,
    D3DDECLUSAGE.FOG, D3DDECLUSAGE.DEPTH, D3DDECLUSAGE.SAMPLE,
]);

/**
 * The layout the fixed-function pipeline reads a declaration through when no
 * vertex format spells it -- members in another order, at other offsets, in
 * other streams, or beside ones only a shader reads -- or null when it reads
 * something this stage cannot: a tessellator method, blend weights, a colour
 * that is not a D3DCOLOR, a position of another type, or coordinate sets with
 * a gap.
 *
 * The names are the ones a decoded vertex format gives, so the stage that
 * reads a format reads this the same way.
 *
 * @param {{ id: number, elements: readonly VertexElement[] }} declaration
 * @returns {FixedFunctionLayout | null}
 */
export function fixedFunctionLayoutOf(declaration){
    /** @type {FixedFunctionLayout['attributes']} */
    const attributes = [];
    /** @type {Set<number>} */
    const sets = new Set();
    let preTransformed = false;
    let position = false;
    for (const element of declaration.elements)
    {
        if (IGNORED_BY_FIXED_FUNCTION.has(element.Usage))
        {
            continue;
        }
        if (element.Method !== D3DDECLMETHOD.DEFAULT)
        {
            return null;
        }
        const bytes = DECLTYPE_BYTES[element.Type];
        /** @param {string} name @param {string} format */
        const add = (name, format)=>attributes.push(
            { name, offset: element.Offset, format, bytes, stream: element.Stream });
        switch (element.Usage)
        {
            case D3DDECLUSAGE.POSITION:
            case D3DDECLUSAGE.POSITIONT: {
                const transformed = element.Usage === D3DDECLUSAGE.POSITIONT;
                if (position || element.UsageIndex !== 0 || element.Type
                    !== (transformed ? D3DDECLTYPE.FLOAT4 : D3DDECLTYPE.FLOAT3))
                {
                    return null;
                }
                position = true;
                preTransformed = transformed;
                add('position', transformed ? 'float32x4' : 'float32x3');
                break;
            }
            case D3DDECLUSAGE.NORMAL:
                if (element.UsageIndex !== 0 || element.Type !== D3DDECLTYPE.FLOAT3)
                {
                    return null;
                }
                add('normal', 'float32x3');
                break;
            case D3DDECLUSAGE.PSIZE:
                if (element.Type !== D3DDECLTYPE.FLOAT1)
                {
                    return null;
                }
                add('pointSize', 'float32');
                break;
            case D3DDECLUSAGE.COLOR:
                // B, G, R, A bytes, which is what the stage swizzles a
                // format's colours from; a UBYTE4N colour is R, G, B, A.
                if (element.UsageIndex > 1 || element.Type !== D3DDECLTYPE.D3DCOLOR)
                {
                    return null;
                }
                add(element.UsageIndex === 0 ? 'diffuse' : 'specular', 'unorm8x4');
                break;
            case D3DDECLUSAGE.TEXCOORD: {
                const format = TEXCOORD_FORMATS[element.Type];
                if (format === undefined || element.UsageIndex > 7 || sets.has(element.UsageIndex))
                {
                    return null;
                }
                sets.add(element.UsageIndex);
                add(`texCoord${element.UsageIndex}`, format);
                break;
            }
            default:
                return null;
        }
    }
    const texCoordSets = sets.size;
    if (!position || [...sets].some(set=>set >= texCoordSets))
    {
        return null;
    }
    const streams = [...new Set(attributes.map(attribute=>attribute.stream))]
        .filter(stream=>stream !== 0)
        .sort((left, right)=>left - right);
    return { id: declaration.id, attributes, preTransformed, texCoordSets, streams };
}

/**
 * @typedef {Object} VertexDeclaration
 * @property {number} id   Distinct per declaration, for a pipeline key.
 * @property {readonly VertexElement[]} elements  Without the sentinel.
 * @property {number} fvf   The format this was made from, or zero when it was
 *                          made by the program -- even when the elements
 *                          happen to describe one.
 * @property {number} refCount
 * @property {boolean} destroyed  whether its last reference has gone for good
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {(out: { elements?: VertexElement[], count?: number }, copy?: boolean)
 *            => number} GetDeclaration
 */

/** Declaration ids are never reused: a pipeline keyed by one must not find another. */
let lastDeclarationId = 0;

/**
 * @param {Object} options
 * @param {readonly VertexElement[]} options.elements  Without the sentinel.
 * @param {number} [options.fvf]
 * @param {import('./resources.js').ReferenceCount} options.count
 * @returns {VertexDeclaration}
 */
export function createVertexDeclaration(options){
    const elements = Object.freeze(options.elements.map(element=>({ ...element })));
    return {
        id: ++lastDeclarationId,
        elements,
        fvf: options.fvf ?? 0,
        get refCount(){
            return options.count.value;
        },
        get destroyed(){
            return options.count.destroyed;
        },
        addRef: ()=>options.count.addRef(),
        release: ()=>options.count.release(),

        /**
         * The elements, sentinel included, and how many that is; `copy` false
         * for a caller only asking how many. The count a caller passes in is
         * not read: Windows writes the whole declaration whatever it says
         * (Wine's d3d9 test_get_declaration passes 0x1337c0de), and a program
         * that leaves it unset expects the elements.
         *
         * @param {{ elements?: VertexElement[], count?: number }} out
         * @param {boolean} [copy]
         */
        GetDeclaration(out, copy = false){
            const all = [...elements, declarationEnd()];
            out.count = all.length;
            if (copy)
            {
                out.elements = all;
            }
            return D3D_OK;
        },
    };
}
