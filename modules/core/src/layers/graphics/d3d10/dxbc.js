/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The DXBC container a compiled Shader Model 4 program arrives in.
 *
 * A program hands `CreateVertexShader` a blob and a length, and what is in the
 * blob is a small archive: a header, a table of chunk offsets, and chunks named
 * by four-character codes. Three of them matter here. `ISGN` and `OSGN` are the
 * input and output signatures -- which semantic lands in which register, and
 * how many of its components the program reads -- and `SHDR` is the instruction
 * stream. Everything else (the reflection chunk, the statistics chunk) is for
 * tools and is skipped by name.
 *
 * The signatures are not optional decoration. They are how the input layout
 * is matched to the vertex shader and how a vertex shader's outputs reach a
 * pixel shader: by semantic name and index, never by register number. Two
 * shaders compiled separately agree on nothing but those names.
 *
 * A blob that is not a container at all -- an older shader model's tokens, or
 * random bytes -- is answered with null, which the device turns into
 * `E_INVALIDARG`, the code the real runtime gives a Shader Model 2 blob.
 */

/** "DXBC", read as a little-endian dword. */
const MAGIC = 0x43425844;

/** The shader kinds a `SHDR` chunk's version dword can name. */
export const SHADER_KIND = Object.freeze({
    PIXEL: 0,
    VERTEX: 1,
    GEOMETRY: 2,
});

/** The component types a signature element declares. */
export const COMPONENT_TYPE = Object.freeze({
    UNKNOWN: 0,
    UINT: 1,
    SINT: 2,
    FLOAT: 3,
});

/** System values a signature element may be bound to (D3D_NAME). */
export const SYSTEM_VALUE = Object.freeze({
    UNDEFINED: 0,
    POSITION: 1,
    CLIP_DISTANCE: 2,
    CULL_DISTANCE: 3,
    RENDER_TARGET_ARRAY_INDEX: 4,
    VIEWPORT_ARRAY_INDEX: 5,
    VERTEX_ID: 6,
    PRIMITIVE_ID: 7,
    INSTANCE_ID: 8,
    IS_FRONT_FACE: 9,
    SAMPLE_INDEX: 10,
    TARGET: 64,
    DEPTH: 65,
});

/**
 * @typedef {Object} SignatureElement
 * @property {string} name          The semantic name, as written in the HLSL.
 * @property {number} index         The semantic index: `TEXCOORD3` is 3.
 * @property {number} systemValue   A SYSTEM_VALUE.
 * @property {number} componentType A COMPONENT_TYPE.
 * @property {number} register
 * @property {number} mask          Which components the element occupies.
 * @property {number} readWriteMask Which of them the program reads (inputs) or
 *                                  leaves unwritten (outputs).
 */

/**
 * @typedef {Object} ShaderProgram
 * @property {number} kind          A SHADER_KIND.
 * @property {number} major
 * @property {number} minor
 * @property {Uint32Array} tokens   The instruction stream after the two header dwords.
 */

/**
 * @typedef {Object} DxbcContainer
 * @property {Map<string, Uint8Array>} chunks
 * @property {SignatureElement[]} inputs
 * @property {SignatureElement[]} outputs
 * @property {ShaderProgram | null} shader
 */

/** @param {Uint8Array} bytes @param {number} at */
function u32(bytes, at){
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
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
 * A signature chunk: a count, a header size, then one 24-byte row per
 * element with the name stored as an offset into the chunk.
 *
 * @param {Uint8Array} chunk
 * @returns {SignatureElement[]}
 */
export function parseSignature(chunk){
    const count = u32(chunk, 0);
    const rows = u32(chunk, 4);
    /** @type {SignatureElement[]} */
    const elements = [];
    for (let index = 0; index < count; index++)
    {
        const at = rows + index * 24;
        if (at + 24 > chunk.length)
        {
            break;
        }
        const masks = u32(chunk, at + 20);
        elements.push({
            name: cString(chunk, u32(chunk, at)),
            index: u32(chunk, at + 4),
            systemValue: u32(chunk, at + 8),
            componentType: u32(chunk, at + 12),
            register: u32(chunk, at + 16),
            mask: masks & 0xff,
            readWriteMask: (masks >>> 8) & 0xff,
        });
    }
    return elements;
}

/**
 * @param {Uint8Array} chunk
 * @returns {ShaderProgram | null}
 */
function parseShader(chunk){
    if (chunk.length < 8)
    {
        return null;
    }
    const version = u32(chunk, 0);
    const length = u32(chunk, 4);
    // The length counts dwords including the two of the header; a stream that
    // claims more than the chunk holds is not one that can be decoded.
    if (length * 4 > chunk.length)
    {
        return null;
    }
    const words = new Uint32Array(length - 2);
    for (let index = 0; index < words.length; index++)
    {
        words[index] = u32(chunk, 8 + index * 4);
    }
    return {
        kind: version >>> 16,
        major: (version >>> 4) & 0xf,
        minor: version & 0xf,
        tokens: words,
    };
}

/**
 * @param {Uint8Array} bytes
 * @returns {DxbcContainer | null} null when the bytes are not a container
 */
export function parseDxbc(bytes){
    if (!bytes || bytes.length < 32 || u32(bytes, 0) !== MAGIC)
    {
        return null;
    }
    const total = u32(bytes, 24);
    const chunkCount = u32(bytes, 28);
    if (total > bytes.length || 32 + chunkCount * 4 > bytes.length)
    {
        return null;
    }
    /** @type {Map<string, Uint8Array>} */
    const chunks = new Map();
    for (let index = 0; index < chunkCount; index++)
    {
        const at = u32(bytes, 32 + index * 4);
        if (at + 8 > bytes.length)
        {
            return null;
        }
        const name = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
        const size = u32(bytes, at + 4);
        if (at + 8 + size > bytes.length)
        {
            return null;
        }
        chunks.set(name, bytes.subarray(at + 8, at + 8 + size));
    }
    const shaderChunk = chunks.get('SHDR') ?? chunks.get('SHEX') ?? null;
    return {
        chunks,
        inputs: chunks.has('ISGN') ? parseSignature(/** @type {Uint8Array} */ (chunks.get('ISGN'))) : [],
        outputs: chunks.has('OSGN')
            ? parseSignature(/** @type {Uint8Array} */ (chunks.get('OSGN')))
            : [],
        shader: shaderChunk ? parseShader(shaderChunk) : null,
    };
}

/**
 * The container a shader create accepts: one whose program is of the kind the
 * create makes. A pixel shader handed to `CreateVertexShader` is refused the
 * same way a blob that is no container at all is.
 *
 * @param {Uint8Array} bytes
 * @param {number} kind  A SHADER_KIND.
 * @returns {DxbcContainer | null}
 */
export function parseShaderOfKind(bytes, kind){
    const container = parseDxbc(bytes);
    if (!container || !container.shader || container.shader.kind !== kind
        || container.shader.major !== 4)
    {
        return null;
    }
    return container;
}
