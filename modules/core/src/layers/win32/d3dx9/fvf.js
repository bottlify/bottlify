/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex declarations and flexible vertex formats, both ways, as d3dx9mesh.h
 * and the D3DFVF and D3DDECLTYPE documentation define them: what a mesh made
 * with an FVF declares, and the FVF a declaration is when it is one.
 *
 * A declaration is D3DVERTEXELEMENT9s -- Stream and Offset (WORDs), Type,
 * Method, Usage, UsageIndex (BYTEs) -- ended by D3DDECL_END, at most
 * MAX_FVF_DECL_SIZE of them with the end.
 *
 * The FVF's parts are laid out in the order the documentation gives for a
 * flexible vertex: the position (and the blend weights after it), the
 * normal, the point size, the diffuse and specular colours, then each set
 * of texture coordinates. An FVF whose blend weights cannot be one element
 * -- five floats, with no indices among them -- has no declaration.
 */

/** MAX_FVF_DECL_SIZE: MAXD3DDECLLENGTH elements and the end. */
export const MAX_FVF_DECL_SIZE = 65;

/** D3DDECLTYPE. */
export const DECLTYPE = Object.freeze({ FLOAT1: 0, FLOAT2: 1, FLOAT3: 2, FLOAT4: 3,
    D3DCOLOR: 4, UBYTE4: 5, SHORT2: 6, SHORT4: 7, UBYTE4N: 8, SHORT2N: 9, SHORT4N: 10,
    USHORT2N: 11, USHORT4N: 12, UDEC3: 13, DEC3N: 14, FLOAT16_2: 15, FLOAT16_4: 16,
    UNUSED: 17 });

/** D3DDECLUSAGE. */
export const DECLUSAGE = Object.freeze({ POSITION: 0, BLENDWEIGHT: 1, BLENDINDICES: 2,
    NORMAL: 3, PSIZE: 4, TEXCOORD: 5, TANGENT: 6, BINORMAL: 7, TESSFACTOR: 8,
    POSITIONT: 9, COLOR: 10, FOG: 11, DEPTH: 12, SAMPLE: 13 });

/** The bytes each D3DDECLTYPE takes, by its value. */
const TYPE_BYTES = [4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 8, 4, 8, 4, 4, 4, 8, 0];

/** D3DFVF bits. */
const FVF = Object.freeze({ POSITION_MASK: 0x400e, XYZ: 0x2, XYZRHW: 0x4, XYZB5: 0xe,
    XYZW: 0x4002, NORMAL: 0x10, PSIZE: 0x20, DIFFUSE: 0x40, SPECULAR: 0x80,
    TEXCOUNT_MASK: 0xf00, LASTBETA_UBYTE4: 0x1000, LASTBETA_D3DCOLOR: 0x8000 });

/** A texture coordinate set's two format bits as the type it is: 2, 3, 4 floats, then 1. */
/** @type {number[]} */
const TEXCOORD_TYPES = [DECLTYPE.FLOAT2, DECLTYPE.FLOAT3, DECLTYPE.FLOAT4, DECLTYPE.FLOAT1];

/**
 * @typedef {Object} VertexElement
 * @property {number} stream
 * @property {number} offset
 * @property {number} type
 * @property {number} method
 * @property {number} usage
 * @property {number} usageIndex
 */

/** @param {number} type */
export const typeBytes = type=>TYPE_BYTES[type] ?? 0;

/**
 * The elements a flexible vertex format declares, in stream 0, or null for
 * a format that has no declaration.
 *
 * @param {number} fvf
 * @returns {VertexElement[] | null}
 */
export function declaratorFromFvf(fvf){
    /** @type {VertexElement[]} */
    const elements = [];
    let offset = 0;
    /** @param {number} type @param {number} usage @param {number} [usageIndex] */
    const add = (type, usage, usageIndex = 0)=>{
        elements.push({ stream: 0, offset, type, method: 0, usage, usageIndex });
        offset += TYPE_BYTES[type];
    };
    const position = fvf & FVF.POSITION_MASK;
    if (position === FVF.XYZRHW)
    {
        add(DECLTYPE.FLOAT4, DECLUSAGE.POSITIONT);
    }
    else if (position === FVF.XYZW)
    {
        add(DECLTYPE.FLOAT4, DECLUSAGE.POSITION);
    }
    else if (position !== 0)
    {
        if (position > FVF.XYZB5)
        {
            return null;
        }
        add(DECLTYPE.FLOAT3, DECLUSAGE.POSITION);
        // XYZB1 (6) to XYZB5 (14) carry one to five betas; with a LASTBETA flag
        // the last is the indices.
        const betas = position === FVF.XYZ ? 0 : (position - FVF.XYZRHW) / 2;
        const indices = fvf & FVF.LASTBETA_UBYTE4 ? DECLTYPE.UBYTE4
            : fvf & FVF.LASTBETA_D3DCOLOR ? DECLTYPE.D3DCOLOR : null;
        const weights = indices === null ? betas : betas - 1;
        if (weights > 4)
        {
            return null;
        }
        if (weights > 0)
        {
            add(DECLTYPE.FLOAT1 + weights - 1, DECLUSAGE.BLENDWEIGHT);
        }
        if (indices !== null && betas > 0)
        {
            add(indices, DECLUSAGE.BLENDINDICES);
        }
    }
    if (fvf & FVF.NORMAL)
    {
        add(DECLTYPE.FLOAT3, DECLUSAGE.NORMAL);
    }
    if (fvf & FVF.PSIZE)
    {
        add(DECLTYPE.FLOAT1, DECLUSAGE.PSIZE);
    }
    if (fvf & FVF.DIFFUSE)
    {
        add(DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR, 0);
    }
    if (fvf & FVF.SPECULAR)
    {
        add(DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR, 1);
    }
    const sets = (fvf & FVF.TEXCOUNT_MASK) >>> 8;
    if (sets > 8)
    {
        return null;
    }
    for (let set = 0; set < sets; set++)
    {
        add(TEXCOORD_TYPES[(fvf >>> (16 + set * 2)) & 3], DECLUSAGE.TEXCOORD, set);
    }
    return elements;
}

/** @param {VertexElement} a @param {VertexElement} b */
const sameElement = (a, b)=>a.stream === b.stream && a.offset === b.offset && a.type === b.type
    && a.method === b.method && a.usage === b.usage && a.usageIndex === b.usageIndex;

/**
 * The flexible vertex format a declaration is, or null for one no FVF lays
 * out the same: the FVF its elements name, held to giving back exactly
 * those elements.
 *
 * @param {VertexElement[]} elements  Without the end.
 * @returns {number | null}
 */
export function fvfFromDeclarator(elements){
    let fvf = 0;
    let weights = 0;
    let indices = 0;
    let sets = 0;
    for (const { type, usage, usageIndex } of elements)
    {
        if (usage === DECLUSAGE.POSITIONT && type === DECLTYPE.FLOAT4)
        {
            fvf |= FVF.XYZRHW;
        }
        else if (usage === DECLUSAGE.POSITION)
        {
            fvf |= type === DECLTYPE.FLOAT4 ? FVF.XYZW : FVF.XYZ;
        }
        else if (usage === DECLUSAGE.BLENDWEIGHT && type <= DECLTYPE.FLOAT4)
        {
            weights = type - DECLTYPE.FLOAT1 + 1;
        }
        else if (usage === DECLUSAGE.BLENDINDICES)
        {
            indices = type === DECLTYPE.UBYTE4 ? FVF.LASTBETA_UBYTE4 : FVF.LASTBETA_D3DCOLOR;
        }
        else if (usage === DECLUSAGE.NORMAL)
        {
            fvf |= FVF.NORMAL;
        }
        else if (usage === DECLUSAGE.PSIZE)
        {
            fvf |= FVF.PSIZE;
        }
        else if (usage === DECLUSAGE.COLOR)
        {
            fvf |= usageIndex === 0 ? FVF.DIFFUSE : FVF.SPECULAR;
        }
        else if (usage === DECLUSAGE.TEXCOORD && type <= DECLTYPE.FLOAT4 && usageIndex < 8)
        {
            sets = Math.max(sets, usageIndex + 1);
            fvf |= ((TEXCOORD_TYPES.indexOf(type) & 3) << (16 + usageIndex * 2)) >>> 0;
        }
        else
        {
            return null;
        }
    }
    const betas = weights + (indices ? 1 : 0);
    if (betas > 0 && (fvf & FVF.POSITION_MASK) === FVF.XYZ)
    {
        fvf = (fvf & ~FVF.POSITION_MASK) | (FVF.XYZRHW + betas * 2) | indices;
    }
    fvf = (fvf | sets << 8) >>> 0;
    const back = declaratorFromFvf(fvf);
    return back && back.length === elements.length
        && back.every((element, i)=>sameElement(element, elements[i])) ? fvf : null;
}

/**
 * The bytes a vertex of one stream takes: the end of its furthest element.
 *
 * @param {VertexElement[]} elements @param {number} stream
 */
export function declVertexSize(elements, stream){
    return elements.reduce((size, element)=>(element.stream === stream
        ? Math.max(size, element.offset + typeBytes(element.type)) : size), 0);
}

/**
 * A declaration in guest memory, up to its end, at most MAX_FVF_DECL_SIZE
 * elements; null when no end is found among them.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory @param {number} at
 * @returns {VertexElement[] | null}
 */
export function readDeclaration(readMemory, at){
    const bytes = readMemory(at >>> 0, MAX_FVF_DECL_SIZE * 8).slice();
    const view = new DataView(bytes.buffer);
    /** @type {VertexElement[]} */
    const elements = [];
    for (let i = 0; i * 8 + 8 <= bytes.length; i++)
    {
        const stream = view.getUint16(i * 8, true);
        const type = bytes[i * 8 + 4];
        if (stream === 0xff && type === DECLTYPE.UNUSED)
        {
            return elements;
        }
        elements.push({ stream, offset: view.getUint16(i * 8 + 2, true), type,
            method: bytes[i * 8 + 5], usage: bytes[i * 8 + 6], usageIndex: bytes[i * 8 + 7] });
    }
    return null;
}

/**
 * A declaration's bytes, its end after it.
 *
 * @param {VertexElement[]} elements
 * @returns {Uint8Array}
 */
export function declarationBytes(elements){
    const bytes = new Uint8Array((elements.length + 1) * 8);
    const view = new DataView(bytes.buffer);
    [...elements, { stream: 0xff, offset: 0, type: DECLTYPE.UNUSED, method: 0, usage: 0,
        usageIndex: 0 }].forEach((element, i)=>{
        view.setUint16(i * 8, element.stream, true);
        view.setUint16(i * 8 + 2, element.offset, true);
        bytes.set([element.type, element.method, element.usage, element.usageIndex], i * 8 + 4);
    });
    return bytes;
}

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

/**
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} host
 */
export function createDeclarationFunctions(host){
    return {
        /**
         * HRESULT D3DXDeclaratorFromFVF(DWORD FVF,
         *     D3DVERTEXELEMENT9 pDeclaration[MAX_FVF_DECL_SIZE])
         */
        D3DXDeclaratorFromFVF: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([fvf, out])=>{
                const elements = declaratorFromFvf(fvf >>> 0);
                if (!elements || (out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                host.writeMemory(out >>> 0, declarationBytes(elements));
                return D3D_OK;
            },
        },
        /** HRESULT D3DXFVFFromDeclarator(const D3DVERTEXELEMENT9 *pDeclaration, DWORD *pFVF) */
        D3DXFVFFromDeclarator: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([declaration, out])=>{
                if ((declaration >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const elements = readDeclaration(host.readMemory, declaration);
                const fvf = elements && fvfFromDeclarator(elements);
                if (fvf === null || fvf === undefined)
                {
                    return D3DERR_INVALIDCALL;
                }
                host.writeMemory(out >>> 0, new Uint8Array(Uint32Array.of(fvf).buffer));
                return D3D_OK;
            },
        },
        /** UINT D3DXGetDeclVertexSize(const D3DVERTEXELEMENT9 *pDecl, DWORD Stream) */
        D3DXGetDeclVertexSize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([declaration, stream])=>((declaration >>> 0) === 0 ? 0
                : declVertexSize(readDeclaration(host.readMemory, declaration) ?? [],
                    stream >>> 0)),
        },
        /** UINT D3DXGetDeclLength(const D3DVERTEXELEMENT9 *pDecl) -- the elements before the end. */
        D3DXGetDeclLength: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([declaration])=>((declaration >>> 0) === 0 ? 0
                : readDeclaration(host.readMemory, declaration)?.length ?? MAX_FVF_DECL_SIZE),
        },
    };
}
