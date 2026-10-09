/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DXGetShaderInputSemantics and D3DXGetShaderOutputSemantics: the usages a
 * shader's bytecode reads and writes, as D3DXSEMANTIC { UINT Usage; UINT
 * UsageIndex; } -- what a program builds the vertex declaration a vertex
 * shader is drawn with from.
 *
 * What Windows answers (Wine's conformance test says it) comes two ways. Where
 * the shader declares what it means -- a vertex shader's inputs, its outputs
 * from model 3, a pixel shader's inputs from model 2 -- each `dcl` of the kind
 * asked is one semantic, in the order declared; a pixel shader of model 2
 * declares only registers, a colour for `v#` and a texture coordinate for `t#`.
 * Elsewhere every register an instruction names counts, read or written, and
 * the answer is sorted by kind: texture coordinates, colours, then oPos, oFog
 * and oPts, then depth, each kind by number. A pixel shader's colour inputs
 * count among its outputs too: that is what Windows answers for one that
 * writes oC# from v#.
 *
 * The token layout is the documented one (shader-asm.js says it in full): an
 * instruction token has bit 31 clear, its parameters set; from model 2 bits 24
 * to 27 count the tokens that follow. Before model 2 the count is the run of
 * parameter tokens, but for `def`, `defi` and `defb`, whose literals are bare.
 */

const END_TOKEN = 0x0000ffff;
const COMMENT_OP = 0xfffe;
const OP_DCL = 31;
const OP_DEFB = 47;
const OP_DEFI = 48;
const OP_DEF = 81;

/** D3DSHADER_PARAM_REGISTER_TYPE, the kinds a semantic comes from. */
const REG = { TEMP: 0, INPUT: 1, TEXTURE: 3, RASTOUT: 4, ATTROUT: 5, OUTPUT: 6, DEPTHOUT: 9 };

/** D3DDECLUSAGE. */
export const USAGE = { POSITION: 0, PSIZE: 4, TEXCOORD: 5, COLOR: 10, FOG: 11, DEPTH: 12 };

/** oPos, oFog, oPts: the RASTOUT registers by number. */
const RASTOUT_USAGE = [USAGE.POSITION, USAGE.FOG, USAGE.PSIZE];

/** The most tokens a walk reads: a pointer to anything but a shader ends here. */
const MOST_TOKENS = 1 << 18;

/** @param {number} token */
const registerType = token=>((token >>> 28) & 7) | ((token >>> 8) & 0x18);

/**
 * The tokens after an instruction token.
 *
 * @param {(index: number) => number} token @param {number} at @param {number} major
 */
function lengthAt(token, at, major){
    const instruction = token(at);
    const opcode = instruction & 0xffff;
    if (opcode === COMMENT_OP)
    {
        return (instruction >>> 16) & 0x7fff;
    }
    if (major >= 2)
    {
        return (instruction >>> 24) & 0xf;
    }
    if (opcode === OP_DEF || opcode === OP_DEFI)
    {
        return 5;
    }
    if (opcode === OP_DEFB)
    {
        return 2;
    }
    let length = 0;
    while (at + 1 + length < MOST_TOKENS && (token(at + 1 + length) & 0x80000000) !== 0)
    {
        length++;
    }
    return length;
}

/**
 * The semantics of a shader's bytecode, in the order Windows gives them.
 *
 * @param {(index: number) => number} token  the bytecode's dword at an index, unsigned
 * @param {boolean} output  the semantics it writes, rather than those it reads
 * @returns {{ usage: number, index: number }[] | null}  null for a stream that is no shader
 */
export function shaderSemantics(token, output){
    const version = token(0);
    const kind = version >>> 16;
    if (kind !== 0xfffe && kind !== 0xffff)
    {
        return null;
    }
    const pixel = kind === 0xffff;
    const major = (version >>> 8) & 0xff;
    const declared = pixel ? !output && major >= 2 : !output || major === 3;
    /** @type {{ usage: number, index: number }[]} */
    const found = [];
    /** Registers named, by kind, where nothing is declared. */
    const texcoords = new Set();
    const colors = new Set();
    const rastout = new Set();
    let depth = false;
    let at = 1;
    while (at < MOST_TOKENS && token(at) !== END_TOKEN)
    {
        const instruction = token(at);
        const opcode = instruction & 0xffff;
        if (declared && opcode === OP_DCL)
        {
            const usageToken = token(at + 1);
            const param = token(at + 2);
            const type = registerType(param);
            if (pixel && major === 2)
            {
                // Model 2 declares registers only; a sampler is no semantic.
                if (type === REG.INPUT || type === REG.TEXTURE)
                {
                    found.push({ usage: type === REG.INPUT ? USAGE.COLOR : USAGE.TEXCOORD,
                        index: param & 0x7ff });
                }
            }
            else if (type === (output ? REG.OUTPUT : REG.INPUT))
            {
                found.push({ usage: usageToken & 0x1f, index: (usageToken >>> 16) & 0xf });
            }
            at += 3;
            continue;
        }
        const length = lengthAt(token, at, major);
        const defines = opcode === COMMENT_OP || opcode === OP_DEF || opcode === OP_DEFI
            || opcode === OP_DEFB;
        for (let p = 1; p <= (declared || defines ? 0 : length); p++)
        {
            const param = token(at + p);
            const type = registerType(param);
            const number = param & 0x7ff;
            if (type === REG.RASTOUT)
            {
                rastout.add(number);
            }
            else if (type === REG.DEPTHOUT)
            {
                depth = true;
            }
            else if (type === REG.OUTPUT || (type === REG.TEXTURE && pixel && !output))
            {
                texcoords.add(number);
            }
            // r0 is a model 1 pixel shader's colour out.
            else if (type === REG.ATTROUT || (pixel && (type === REG.INPUT
                || (type === REG.TEMP && major === 1 && number === 0))))
            {
                colors.add(number);
            }
        }
        at += 1 + length;
    }
    if (!declared)
    {
        const sorted = (/** @type {Set<number>} */ set)=>[...set].sort((a, b)=>a - b);
        for (const index of sorted(texcoords))
        {
            found.push({ usage: USAGE.TEXCOORD, index });
        }
        for (const index of sorted(colors))
        {
            found.push({ usage: USAGE.COLOR, index });
        }
        for (const number of sorted(rastout))
        {
            found.push({ usage: RASTOUT_USAGE[number] ?? USAGE.POSITION, index: 0 });
        }
        if (depth)
        {
            found.push({ usage: USAGE.DEPTH, index: 0 });
        }
    }
    return found;
}

/**
 * The two exports over guest memory.
 *
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} host
 */
export function createShaderSemantics(host){
    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;
    const D3DXERR_INVALIDDATA = 0x88760b59;
    /** @param {number} at */
    const readU32 = at=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /**
     * @param {boolean} output
     * @returns {{ argBytes: number, handler: (args: number[]) => number }}
     */
    const entry = output=>({
        argBytes: 12,
        handler: ([code, semantics, count])=>{
            if ((code >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const found = shaderSemantics(index=>readU32((code >>> 0) + index * 4), output);
            if (found === null)
            {
                return D3DXERR_INVALIDDATA;
            }
            if ((semantics >>> 0) !== 0)
            {
                const bytes = new Uint8Array(found.length * 8);
                const view = new DataView(bytes.buffer);
                found.forEach(({ usage, index }, i)=>{
                    view.setUint32(i * 8, usage, true);
                    view.setUint32(i * 8 + 4, index, true);
                });
                host.writeMemory(semantics >>> 0, bytes);
            }
            if ((count >>> 0) !== 0)
            {
                host.writeMemory(count >>> 0, Uint8Array.of(found.length, 0, 0, 0));
            }
            return D3D_OK;
        },
    });
    return {
        /**
         * HRESULT D3DXGetShaderInputSemantics(const DWORD *pFunction,
         *     D3DXSEMANTIC *pSemantics, UINT *pCount)
         */
        D3DXGetShaderInputSemantics: entry(false),
        /**
         * HRESULT D3DXGetShaderOutputSemantics(const DWORD *pFunction,
         *     D3DXSEMANTIC *pSemantics, UINT *pCount)
         */
        D3DXGetShaderOutputSemantics: entry(true),
    };
}
