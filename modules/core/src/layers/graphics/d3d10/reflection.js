/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a compiled shader says about itself: `D3D10ReflectShader`, the
 * signature-blob exports and `ID3D10Blob`.
 *
 * The device reads three chunks of a DXBC container and skips the rest; the
 * reflection reads two of the skipped ones. `RDEF` is where the compiler
 * recorded the constant buffers and the resources the program binds, and the
 * string naming the compiler; `STAT` is the compiler's own count of what it
 * emitted. Neither is worked out from the program here: a count the compiler
 * wrote is reported as written, and a chunk stripped from the blob reads as
 * zeros, as it does to the runtime. The one exception is a geometry shader's
 * output topology and vertex count, which the program itself declares and are
 * read from its declarations.
 *
 * Every string a reflection hands out is a pointer into the program's memory,
 * so each name is kept as an offset from the start of the container, and the
 * seam, which copies the container into guest memory, adds the copy's address.
 */

import { attachCom } from './com.js';
import { parseDxbc } from './dxbc.js';
import { E_FAIL, E_INVALIDARG, IID, S_OK } from './constants.js';
import { OPCODE, decodeSm4 } from './sm4.js';

/** D3DERR_INVALIDCALL, which the blob functions answer for a missing argument. */
export const D3DERR_INVALIDCALL = 0x8876086c;

/**
 * The profile each stage compiles for on a Direct3D 10.0 device, which is
 * every device made here.
 */
export const SHADER_PROFILE = Object.freeze({
    VERTEX: 'vs_4_0',
    PIXEL: 'ps_4_0',
    GEOMETRY: 'gs_4_0',
});

/**
 * The statistics a `STAT` chunk holds, by position, named after the fields of
 * D3D10_SHADER_DESC they fill. Positions past these hold counts the Direct3D
 * 10 description has no field for.
 */
const STATISTICS = Object.freeze([
    'InstructionCount', 'TempRegisterCount', 'DefCount', 'DclCount', 'FloatInstructionCount',
    'IntInstructionCount', 'UintInstructionCount', 'StaticFlowControlCount',
    'DynamicFlowControlCount', 'MacroInstructionCount', 'TempArrayCount',
    'ArrayInstructionCount', 'CutInstructionCount', 'EmitInstructionCount',
    'TextureNormalInstructions', 'TextureLoadInstructions', 'TextureCompInstructions',
    'TextureBiasInstructions', 'TextureGradientInstructions',
]);

/**
 * D3D10_SHADER_DESC, one dword per field in declaration order. `Creator` is a
 * pointer, and the only field not a count or a code.
 */
export const SHADER_DESC_FIELDS = Object.freeze([
    'Version', 'Creator', 'Flags', 'ConstantBuffers', 'BoundResources', 'InputParameters',
    'OutputParameters', 'InstructionCount', 'TempRegisterCount', 'TempArrayCount', 'DefCount',
    'DclCount', 'TextureNormalInstructions', 'TextureLoadInstructions',
    'TextureCompInstructions', 'TextureBiasInstructions', 'TextureGradientInstructions',
    'FloatInstructionCount', 'IntInstructionCount', 'UintInstructionCount',
    'StaticFlowControlCount', 'DynamicFlowControlCount', 'MacroInstructionCount',
    'ArrayInstructionCount', 'CutInstructionCount', 'EmitInstructionCount', 'GSOutputTopology',
    'GSMaxOutputVertexCount',
]);

/**
 * @typedef {Object} ReflectedBinding
 * @property {string} name
 * @property {number} nameAt       From the start of the container.
 * @property {number} type         D3D10_SHADER_INPUT_TYPE.
 * @property {number} returnType   D3D10_RESOURCE_RETURN_TYPE.
 * @property {number} dimension    D3D10_SRV_DIMENSION.
 * @property {number} sampleCount
 * @property {number} bindPoint
 * @property {number} bindCount
 * @property {number} flags
 */

/**
 * @typedef {Object} ReflectedConstantBuffer
 * @property {string} name
 * @property {number} nameAt
 * @property {number} variables
 * @property {number} size
 * @property {number} flags
 * @property {number} type         D3D10_CBUFFER_TYPE.
 */

/**
 * @typedef {import('./dxbc.js').SignatureElement & { nameAt: number }} ReflectedParameter
 */

/**
 * @typedef {Object} ShaderReflection
 * @property {Record<string, number>} desc  D3D10_SHADER_DESC by field name, with
 *     `Creator` an offset from the start of the container, or -1 for none.
 * @property {ReflectedConstantBuffer[]} constantBuffers
 * @property {ReflectedBinding[]} bindings
 * @property {ReflectedParameter[]} inputs
 * @property {ReflectedParameter[]} outputs
 */

/** @param {Uint8Array} bytes @param {number} at */
function u32(bytes, at){
    return at + 4 > bytes.length
        ? 0
        : (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** @param {Uint8Array} bytes @param {number} at @returns {string} up to the NUL */
function cString(bytes, at){
    let end = at;
    while (end < bytes.length && bytes[end] !== 0)
    {
        end++;
    }
    return String.fromCharCode(...bytes.subarray(at, end));
}

/**
 * Where a chunk's data starts in the container it was cut from.
 *
 * @param {Uint8Array} container
 * @param {Uint8Array} chunk  A view `parseDxbc` made of the same bytes.
 */
function offsetIn(container, chunk){
    return chunk.byteOffset - container.byteOffset;
}

/**
 * A signature's elements with where each name sits in the container.
 *
 * @param {Uint8Array} bytes
 * @param {Uint8Array | undefined} chunk
 * @param {import('./dxbc.js').SignatureElement[]} elements
 * @returns {ReflectedParameter[]}
 */
function located(bytes, chunk, elements){
    if (!chunk)
    {
        return [];
    }
    const rows = u32(chunk, 4);
    const base = offsetIn(bytes, chunk);
    return elements.map((element, index)=>({
        ...element, nameAt: base + u32(chunk, rows + index * 24),
    }));
}

/**
 * The resource definitions: a header of counts and offsets, the constant
 * buffers at 24 bytes each, the bound resources at 32, and the strings they
 * name, all offsets counted from the start of the chunk.
 *
 * @param {Uint8Array} bytes
 * @param {Uint8Array} chunk
 */
function readDefinitions(bytes, chunk){
    const base = offsetIn(bytes, chunk);
    const bufferCount = u32(chunk, 0);
    const buffersAt = u32(chunk, 4);
    const bindingCount = u32(chunk, 8);
    const bindingsAt = u32(chunk, 12);
    const creatorAt = u32(chunk, 24);
    /** @type {ReflectedConstantBuffer[]} */
    const constantBuffers = [];
    for (let index = 0; index < bufferCount && buffersAt + (index + 1) * 24 <= chunk.length;
        index++)
    {
        const at = buffersAt + index * 24;
        constantBuffers.push({
            name: cString(chunk, u32(chunk, at)),
            nameAt: base + u32(chunk, at),
            variables: u32(chunk, at + 4),
            size: u32(chunk, at + 12),
            flags: u32(chunk, at + 16),
            type: u32(chunk, at + 20),
        });
    }
    /** @type {ReflectedBinding[]} */
    const bindings = [];
    for (let index = 0; index < bindingCount && bindingsAt + (index + 1) * 32 <= chunk.length;
        index++)
    {
        const at = bindingsAt + index * 32;
        bindings.push({
            name: cString(chunk, u32(chunk, at)),
            nameAt: base + u32(chunk, at),
            type: u32(chunk, at + 4),
            returnType: u32(chunk, at + 8),
            dimension: u32(chunk, at + 12),
            sampleCount: u32(chunk, at + 16),
            bindPoint: u32(chunk, at + 20),
            bindCount: u32(chunk, at + 24),
            flags: u32(chunk, at + 28),
        });
    }
    return {
        flags: u32(chunk, 20),
        creator: creatorAt > 0 && creatorAt < chunk.length ? base + creatorAt : -1,
        constantBuffers,
        bindings,
    };
}

/**
 * A geometry shader's declared output topology and vertex count.
 *
 * @param {import('./dxbc.js').ShaderProgram} program
 */
function geometryOutput(program){
    let topology = 0;
    let vertices = 0;
    for (const instruction of decodeSm4(program.tokens))
    {
        if (instruction.opcode === OPCODE.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY)
        {
            topology = instruction.control & 0x7f;
        }
        else if (instruction.opcode === OPCODE.DCL_MAX_OUTPUT_VERTEX_COUNT)
        {
            vertices = instruction.extra[0] ?? 0;
        }
    }
    return { topology, vertices };
}

/**
 * @param {Uint8Array} bytes  A DXBC container.
 * @returns {ShaderReflection | null} null when the bytes are not a container
 */
export function reflectShader(bytes){
    const container = parseDxbc(bytes);
    if (!container)
    {
        return null;
    }
    const definitions = container.chunks.has('RDEF')
        ? readDefinitions(bytes, /** @type {Uint8Array} */ (container.chunks.get('RDEF')))
        : { flags: 0, creator: -1, constantBuffers: [], bindings: [] };
    const statistics = container.chunks.get('STAT') ?? new Uint8Array(0);
    const programChunk = container.chunks.get('SHDR') ?? container.chunks.get('SHEX');
    const program = container.shader;
    const geometry = program ? geometryOutput(program) : { topology: 0, vertices: 0 };

    /** @type {Record<string, number>} */
    const desc = {
        Version: programChunk ? u32(programChunk, 0) : 0,
        Creator: definitions.creator,
        Flags: definitions.flags,
        ConstantBuffers: definitions.constantBuffers.length,
        BoundResources: definitions.bindings.length,
        InputParameters: container.inputs.length,
        OutputParameters: container.outputs.length,
        GSOutputTopology: geometry.topology,
        GSMaxOutputVertexCount: geometry.vertices,
    };
    STATISTICS.forEach((field, index)=>{
        desc[field] = u32(statistics, index * 4);
    });
    return {
        desc,
        constantBuffers: definitions.constantBuffers,
        bindings: definitions.bindings,
        inputs: located(bytes, container.chunks.get('ISGN'), container.inputs),
        outputs: located(bytes, container.chunks.get('OSGN'), container.outputs),
    };
}

/**
 * A container of the named chunks alone, in the order named: what
 * `D3D10GetInputSignatureBlob` and its two companions answer. The header's
 * checksum is left zero; nothing that reads a container here checks it.
 *
 * @param {Uint8Array} bytes
 * @param {string[]} names
 * @returns {Uint8Array | null} null when the bytes are not a container or lack a chunk
 */
export function containerOf(bytes, names){
    const container = parseDxbc(bytes);
    if (!container || names.some(name=>!container.chunks.has(name)))
    {
        return null;
    }
    const chunks = names.map(name=>/** @type {Uint8Array} */ (container.chunks.get(name)));
    let total = 32 + chunks.length * 4;
    /** @type {number[]} */
    const offsets = [];
    for (const chunk of chunks)
    {
        offsets.push(total);
        total += 8 + chunk.length;
    }
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set([0x44, 0x58, 0x42, 0x43], 0);
    view.setUint32(20, 1, true);
    view.setUint32(24, total, true);
    view.setUint32(28, chunks.length, true);
    chunks.forEach((chunk, index)=>{
        const at = offsets[index];
        view.setUint32(32 + index * 4, at, true);
        for (let char = 0; char < 4; char++)
        {
            out[at + char] = names[index].charCodeAt(char);
        }
        view.setUint32(at + 4, chunk.length, true);
        out.set(chunk, at + 8);
    });
    return out;
}

/**
 * The debug information a compiler embedded, as the chunk's own bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array | null}
 */
export function debugInfoOf(bytes){
    return parseDxbc(bytes)?.chunks.get('SDBG')?.slice() ?? null;
}

/**
 * An ID3D10Blob: a block of the program's memory and its length. The block
 * is the caller's to write -- a program fills a blob it created -- so it lives
 * where the program can reach it, and goes when the last reference does.
 *
 * @param {number} address
 * @param {number} size
 * @param {() => void} [onLastRef]
 */
export function createBlob(address, size, onLastRef){
    return attachCom({
        GetBufferPointer: ()=>address,
        GetBufferSize: ()=>size,
    }, { interfaces: [IID.ID3D10Blob], onLastRef });
}

/**
 * An ID3D10ShaderReflection over a parsed container. Out-of-range indices and
 * missing structures are the caller's error, answered as the runtime answers
 * them; a description with nowhere to go is E_FAIL, the others E_INVALIDARG.
 *
 * @param {ShaderReflection} reflection
 * @param {() => void} [onLastRef]
 */
export function createShaderReflection(reflection, onLastRef){
    /**
     * @template T
     * @param {T[]} list
     * @param {number} index
     * @param {{ entry?: T } | null} out
     */
    const entryOf = (list, index, out)=>{
        if (!out || index >= list.length)
        {
            return E_INVALIDARG;
        }
        out.entry = list[index];
        return S_OK;
    };
    return attachCom({
        reflection,
        /** @param {{ desc?: Record<string, number> } | null} out */
        GetDesc(out){
            if (!out)
            {
                return E_FAIL;
            }
            out.desc = { ...reflection.desc };
            return S_OK;
        },
        /** @param {number} index @param {{ entry?: ReflectedBinding } | null} out */
        GetResourceBindingDesc: (index, out)=>entryOf(reflection.bindings, index, out ?? null),
        /** @param {number} index @param {{ entry?: ReflectedParameter } | null} out */
        GetInputParameterDesc: (index, out)=>entryOf(reflection.inputs, index, out ?? null),
        /** @param {number} index @param {{ entry?: ReflectedParameter } | null} out */
        GetOutputParameterDesc: (index, out)=>entryOf(reflection.outputs, index, out ?? null),
    }, { interfaces: [IID.ID3D10ShaderReflection], onLastRef });
}
