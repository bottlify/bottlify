/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A compiled effect (`fx_4_0`, `fx_4_1`) as data: what
 * `D3D10CreateEffectFromMemory` is handed.
 *
 * The effect arrives in a DXBC container whose `FX10` chunk holds it all. The
 * chunk opens with nineteen dwords of counts, then an unstructured block --
 * names, types, default values, string values and the shaders' own bytecode,
 * each found by its offset from the block's start -- and then the structured
 * part, read in order: the constant buffers with their variables, the object
 * variables, and the techniques with their passes. A name offset of zero is
 * a real offset, but a semantic, a default value or a shader at offset zero
 * means there is none: a compiler puts a name first.
 *
 * Every name and string is kept as its offset into the unstructured block,
 * because a program is handed pointers to them: the seam copies the block
 * into guest memory and adds the copy's address.
 *
 * What is read is not evaluated here. A state an object variable or a pass
 * assigns is kept as the assignment -- a constant, a variable named, an
 * element of one, a shader compiled in place -- for whoever applies it; the
 * two kinds that need the effect's expression machine (an index or a value
 * computed from variables) are kept as their bytes and said to be so.
 */

import { parseDxbc } from './dxbc.js';

/** The versions a Direct3D 10 effect may be: fx_4_0 and fx_4_1. */
export const FX_VERSION = Object.freeze({ FX_4_0: 0xfeff1001, FX_4_1: 0xfeff1011 });

/** D3D10_SHADER_VARIABLE_CLASS. */
export const D3D10_SVC = Object.freeze({
    SCALAR: 0, VECTOR: 1, MATRIX_ROWS: 2, MATRIX_COLUMNS: 3, OBJECT: 4, STRUCT: 5,
});

/** D3D10_SHADER_VARIABLE_TYPE, the ones an effect can hold. */
export const D3D10_SVT = Object.freeze({
    VOID: 0, BOOL: 1, INT: 2, FLOAT: 3, STRING: 4, TEXTURE: 5, TEXTURE1D: 6, TEXTURE2D: 7,
    TEXTURE3D: 8, TEXTURECUBE: 9, SAMPLER: 10, PIXELSHADER: 15, VERTEXSHADER: 16, UINT: 19,
    GEOMETRYSHADER: 21, RASTERIZER: 22, DEPTHSTENCIL: 23, BLEND: 24, BUFFER: 25, CBUFFER: 26,
    TBUFFER: 27, TEXTURE1DARRAY: 28, TEXTURE2DARRAY: 29, RENDERTARGETVIEW: 30,
    DEPTHSTENCILVIEW: 31, TEXTURE2DMS: 32, TEXTURE2DMSARRAY: 33, TEXTURECUBEARRAY: 34,
});

/**
 * The object kinds an effect's type names, by the number it stores, with the
 * shader variable type each is described as. A geometry shader built with
 * stream output is its own kind in the file and a geometry shader to a
 * program.
 *
 * @type {Readonly<Record<number, { kind: string, svt: number, streamOutput?: boolean }>>}
 */
export const FX_OBJECT = Object.freeze({
    1: { kind: 'string', svt: D3D10_SVT.STRING },
    2: { kind: 'blend', svt: D3D10_SVT.BLEND },
    3: { kind: 'depthstencil', svt: D3D10_SVT.DEPTHSTENCIL },
    4: { kind: 'rasterizer', svt: D3D10_SVT.RASTERIZER },
    5: { kind: 'pixelshader', svt: D3D10_SVT.PIXELSHADER },
    6: { kind: 'vertexshader', svt: D3D10_SVT.VERTEXSHADER },
    7: { kind: 'geometryshader', svt: D3D10_SVT.GEOMETRYSHADER },
    8: { kind: 'geometryshader', svt: D3D10_SVT.GEOMETRYSHADER, streamOutput: true },
    9: { kind: 'texture', svt: D3D10_SVT.TEXTURE },
    10: { kind: 'texture', svt: D3D10_SVT.TEXTURE1D },
    11: { kind: 'texture', svt: D3D10_SVT.TEXTURE1DARRAY },
    12: { kind: 'texture', svt: D3D10_SVT.TEXTURE2D },
    13: { kind: 'texture', svt: D3D10_SVT.TEXTURE2DARRAY },
    14: { kind: 'texture', svt: D3D10_SVT.TEXTURE2DMS },
    15: { kind: 'texture', svt: D3D10_SVT.TEXTURE2DMSARRAY },
    16: { kind: 'texture', svt: D3D10_SVT.TEXTURE3D },
    17: { kind: 'texture', svt: D3D10_SVT.TEXTURECUBE },
    19: { kind: 'rendertargetview', svt: D3D10_SVT.RENDERTARGETVIEW },
    20: { kind: 'depthstencilview', svt: D3D10_SVT.DEPTHSTENCILVIEW },
    21: { kind: 'sampler', svt: D3D10_SVT.SAMPLER },
    22: { kind: 'texture', svt: D3D10_SVT.BUFFER },
    23: { kind: 'texture', svt: D3D10_SVT.TEXTURECUBEARRAY },
});

/** How an assignment says where its value comes from. */
export const ASSIGNMENT = Object.freeze({
    CONSTANT: 1,
    VARIABLE: 2,
    CONSTANT_INDEX: 3,
    VARIABLE_INDEX: 4,
    INDEX_EXPRESSION: 5,
    VALUE_EXPRESSION: 6,
    ANONYMOUS_SHADER: 7,
});

/** The type a constant in an assignment is stored as. */
export const CONSTANT_TYPE = Object.freeze({ FLOAT: 1, INT: 2, UINT: 3, BOOL: 4 });

/**
 * A numeric type's base type as the file stores it, and as a program is told it.
 *
 * @type {Readonly<Record<number, number>>}
 */
const NUMERIC_BASE = Object.freeze({
    1: D3D10_SVT.FLOAT, 2: D3D10_SVT.INT, 3: D3D10_SVT.UINT, 4: D3D10_SVT.BOOL,
});

/** The file's numeric layouts: scalar, vector, matrix. */
const LAYOUT = Object.freeze({ SCALAR: 1, VECTOR: 2, MATRIX: 3 });

/** The header's counts, in the order the file keeps them. */
const HEADER = Object.freeze([
    'version', 'buffers', 'numericVariables', 'objectVariables', 'sharedBuffers',
    'sharedNumericVariables', 'sharedObjectVariables', 'techniques', 'unstructuredSize',
    'strings', 'shaderResources', 'depthStencilStates', 'blendStates', 'rasterizerStates',
    'samplers', 'renderTargetViews', 'depthStencilViews', 'shaders', 'inlineShaders',
]);

/**
 * @typedef {Object} FxMember
 * @property {string} name
 * @property {number} nameAt
 * @property {string | null} semantic
 * @property {number} semanticAt   -1 for none.
 * @property {number} bufferOffset  From the start of the structure.
 * @property {FxType} type
 */

/**
 * @typedef {Object} FxType
 * @property {string} name
 * @property {number} nameAt
 * @property {'numeric' | 'object' | 'struct'} kind
 * @property {number} elements     Zero for a type that is not an array.
 * @property {number} unpackedSize As laid out in a constant buffer, registers padded.
 * @property {number} stride       From one element to the next.
 * @property {number} packedSize   With no padding, as default values are stored.
 * @property {number} svc          D3D10_SHADER_VARIABLE_CLASS.
 * @property {number} svt          D3D10_SHADER_VARIABLE_TYPE.
 * @property {number} rows
 * @property {number} columns
 * @property {string | null} object  The object kind, for an object type.
 * @property {boolean} streamOutput  A geometry shader built with stream output.
 * @property {FxMember[]} members
 */

/**
 * @typedef {Object} FxAnnotation
 * @property {string} name
 * @property {number} nameAt
 * @property {FxType} type
 * @property {number[]} strings     Each element's string offset, for a string.
 * @property {Uint8Array | null} value  Packed, for a number.
 */

/**
 * @typedef {Object} FxShader
 * @property {number} at             Where its bytecode sits in the unstructured block.
 * @property {Uint8Array} bytecode
 * @property {string | null} streamOutput  The declaration, for a geometry shader with one.
 * @property {number} streamOutputAt -1 for none.
 */

/**
 * @typedef {Object} FxConstant
 * @property {number} type   CONSTANT_TYPE.
 * @property {number} bits   The value's dword.
 */

/**
 * @typedef {Object} FxAssignment
 * @property {number} state   The state's id.
 * @property {number} index   Which element of a state that has several.
 * @property {number} kind    ASSIGNMENT.
 * @property {FxConstant[]} [constants]
 * @property {string} [variable]  The variable named.
 * @property {number} [element]   The constant index into it.
 * @property {FxShader | null} [shader]  A shader compiled in place, or null.
 */

/**
 * @typedef {Object} FxNumericVariable
 * @property {string} name
 * @property {number} nameAt
 * @property {string | null} semantic
 * @property {number} semanticAt
 * @property {number} bufferOffset
 * @property {number} flags
 * @property {FxType} type
 * @property {Uint8Array | null} defaultValue  Packed.
 * @property {FxAnnotation[]} annotations
 */

/**
 * @typedef {Object} FxBuffer
 * @property {string} name
 * @property {number} nameAt
 * @property {number} size
 * @property {boolean} textureBuffer
 * @property {number} bindPoint    -1 for none given.
 * @property {FxAnnotation[]} annotations
 * @property {FxNumericVariable[]} variables
 */

/**
 * One element of an object variable: its string, its shader, or the
 * assignments of its state block. A texture or a view has nothing stored.
 *
 * @typedef {Object} FxObjectElement
 * @property {number} [stringAt]
 * @property {FxShader | null} [shader]
 * @property {FxAssignment[]} [assignments]
 */

/**
 * @typedef {Object} FxObjectVariable
 * @property {string} name
 * @property {number} nameAt
 * @property {string | null} semantic
 * @property {number} semanticAt
 * @property {number} bindPoint
 * @property {FxType} type
 * @property {FxAnnotation[]} annotations
 * @property {FxObjectElement[]} elements  One, or one per array element.
 */

/**
 * @typedef {Object} FxPass
 * @property {string} name
 * @property {number} nameAt
 * @property {FxAnnotation[]} annotations
 * @property {FxAssignment[]} assignments
 */

/**
 * @typedef {Object} FxTechnique
 * @property {string} name
 * @property {number} nameAt
 * @property {FxAnnotation[]} annotations
 * @property {FxPass[]} passes
 */

/**
 * @typedef {Object} EffectData
 * @property {number} version
 * @property {Record<string, number>} counts  The header's counts by name.
 * @property {Uint8Array} unstructured
 * @property {FxBuffer[]} buffers
 * @property {FxObjectVariable[]} objects
 * @property {FxTechnique[]} techniques
 */

/** A reason the bytes are not an effect this runtime reads. */
class NotAnEffect extends Error {}

/**
 * @param {Uint8Array} bytes  What a program handed D3D10CreateEffectFromMemory.
 * @returns {{ effect: EffectData } | { error: string }}
 */
export function parseEffect(bytes){
    const container = parseDxbc(bytes);
    const chunk = container?.chunks.get('FX10');
    if (!chunk)
    {
        return { error: 'not a container with an FX10 chunk' };
    }
    try
    {
        return { effect: readEffect(chunk) };
    }
    catch (e){
        if (e instanceof NotAnEffect)
        {
            return { error: e.message };
        }
        throw e;
    }
}

/** @param {Uint8Array} chunk @returns {EffectData} */
function readEffect(chunk){
    if (chunk.length < HEADER.length * 4)
    {
        throw new NotAnEffect('the FX10 header is cut short');
    }
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    /** @type {Record<string, number>} */
    const counts = {};
    HEADER.forEach((name, index)=>{
        counts[name] = view.getUint32(index * 4, true);
    });
    if (counts.version !== FX_VERSION.FX_4_0 && counts.version !== FX_VERSION.FX_4_1)
    {
        throw new NotAnEffect(`effect version 0x${counts.version.toString(16)} is not fx_4_0 or`
            + ' fx_4_1');
    }
    if (counts.sharedBuffers || counts.sharedNumericVariables || counts.sharedObjectVariables)
    {
        throw new NotAnEffect('an effect that shares variables with a pool');
    }
    const base = HEADER.length * 4;
    if (base + counts.unstructuredSize > chunk.length)
    {
        throw new NotAnEffect('the unstructured block runs past the chunk');
    }
    const unstructured = chunk.subarray(base, base + counts.unstructuredSize);
    const blob = new DataView(unstructured.buffer, unstructured.byteOffset,
        unstructured.byteLength);
    let at = base + counts.unstructuredSize;

    const next = ()=>{
        if (at + 4 > chunk.length)
        {
            throw new NotAnEffect('the structured part is cut short');
        }
        const value = view.getUint32(at, true);
        at += 4;
        return value;
    };
    /** @param {number} offset */
    const word = offset=>{
        if (offset + 4 > unstructured.length)
        {
            throw new NotAnEffect(`an offset 0x${offset.toString(16)} past the unstructured block`);
        }
        return blob.getUint32(offset, true);
    };
    /** @param {number} offset @returns {string} */
    const string = offset=>{
        if (offset >= unstructured.length)
        {
            throw new NotAnEffect(`a string at 0x${offset.toString(16)} past the unstructured`
                + ' block');
        }
        let end = offset;
        while (end < unstructured.length && unstructured[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...unstructured.subarray(offset, end));
    };
    /** @param {number} offset @param {number} length */
    const bytesAt = (offset, length)=>{
        if (offset + length > unstructured.length)
        {
            throw new NotAnEffect('a value runs past the unstructured block');
        }
        return unstructured.slice(offset, offset + length);
    };

    /** @type {Map<number, FxType>} */
    const types = new Map();
    /** @param {number} offset @returns {FxType} */
    const readType = offset=>{
        const known = types.get(offset);
        if (known)
        {
            return known;
        }
        const kindCode = word(offset + 4);
        /** @type {FxType} */
        const type = {
            name: string(word(offset)),
            nameAt: word(offset),
            kind: kindCode === 1 ? 'numeric' : kindCode === 2 ? 'object' : 'struct',
            elements: word(offset + 8),
            unpackedSize: word(offset + 12),
            stride: word(offset + 16),
            packedSize: word(offset + 20),
            svc: D3D10_SVC.OBJECT,
            svt: D3D10_SVT.VOID,
            rows: 0,
            columns: 0,
            object: null,
            streamOutput: false,
            members: [],
        };
        types.set(offset, type);
        if (kindCode === 1)
        {
            const info = word(offset + 24);
            const layout = info & 0x7;
            type.svt = NUMERIC_BASE[(info >>> 3) & 0x1f] ?? D3D10_SVT.VOID;
            type.rows = (info >>> 8) & 0x7;
            type.columns = (info >>> 11) & 0x7;
            if (layout === LAYOUT.SCALAR)
            {
                type.svc = D3D10_SVC.SCALAR;
            }
            else if (layout === LAYOUT.VECTOR)
            {
                type.svc = D3D10_SVC.VECTOR;
            }
            else if (layout === LAYOUT.MATRIX)
            {
                type.svc = (info & 0x4000) ? D3D10_SVC.MATRIX_COLUMNS : D3D10_SVC.MATRIX_ROWS;
            }
            else
            {
                throw new NotAnEffect(`a numeric type of layout ${layout}`);
            }
        }
        else if (kindCode === 2)
        {
            const code = word(offset + 24);
            const object = FX_OBJECT[code];
            if (!object)
            {
                throw new NotAnEffect(`an object type ${code} this runtime does not know`);
            }
            type.object = object.kind;
            type.svt = object.svt;
            type.streamOutput = object.streamOutput === true;
        }
        else if (kindCode === 3)
        {
            type.svc = D3D10_SVC.STRUCT;
            const count = word(offset + 24);
            for (let index = 0; index < count; index++)
            {
                const entry = offset + 28 + index * 16;
                const semanticAt = word(entry + 4);
                type.members.push({
                    name: string(word(entry)),
                    nameAt: word(entry),
                    semantic: semanticAt ? string(semanticAt) : null,
                    semanticAt: semanticAt || -1,
                    bufferOffset: word(entry + 8),
                    type: readType(word(entry + 12)),
                });
            }
        }
        else
        {
            throw new NotAnEffect(`a type of class ${kindCode}`);
        }
        return type;
    };

    const readAnnotations = ()=>{
        /** @type {FxAnnotation[]} */
        const annotations = [];
        const count = next();
        for (let index = 0; index < count; index++)
        {
            const nameAt = next();
            const type = readType(next());
            /** @type {FxAnnotation} */
            const annotation = { name: string(nameAt), nameAt, type, strings: [], value: null };
            if (type.object === 'string')
            {
                for (let element = 0; element < Math.max(1, type.elements); element++)
                {
                    annotation.strings.push(next());
                }
            }
            else if (type.kind === 'numeric')
            {
                annotation.value = bytesAt(next(), type.packedSize);
            }
            else
            {
                throw new NotAnEffect(`an annotation of type ${type.name}`);
            }
            annotations.push(annotation);
        }
        return annotations;
    };

    /** @param {number} offset @param {number} streamOutputAt @returns {FxShader | null} */
    const readShader = (offset, streamOutputAt = 0)=>{
        if (offset === 0)
        {
            return null;
        }
        const size = word(offset);
        return {
            at: offset + 4,
            bytecode: bytesAt(offset + 4, size),
            streamOutput: streamOutputAt ? string(streamOutputAt) : null,
            streamOutputAt: streamOutputAt || -1,
        };
    };

    /** @param {number} count @returns {FxAssignment[]} */
    const readAssignments = count=>{
        /** @type {FxAssignment[]} */
        const assignments = [];
        for (let index = 0; index < count; index++)
        {
            const state = next();
            const element = next();
            const kind = next();
            const offset = next();
            /** @type {FxAssignment} */
            const assignment = { state, index: element, kind };
            switch (kind)
            {
                case ASSIGNMENT.CONSTANT: {
                    const values = word(offset);
                    assignment.constants = [];
                    for (let value = 0; value < values; value++)
                    {
                        assignment.constants.push({
                            type: word(offset + 4 + value * 8),
                            bits: word(offset + 8 + value * 8),
                        });
                    }
                    break;
                }
                case ASSIGNMENT.VARIABLE:
                    assignment.variable = string(offset);
                    break;
                case ASSIGNMENT.CONSTANT_INDEX:
                    assignment.variable = string(word(offset));
                    assignment.element = word(offset + 4);
                    break;
                case ASSIGNMENT.ANONYMOUS_SHADER:
                    assignment.shader = readShader(word(offset), word(offset + 4));
                    break;
                case ASSIGNMENT.VARIABLE_INDEX:
                case ASSIGNMENT.INDEX_EXPRESSION:
                case ASSIGNMENT.VALUE_EXPRESSION:
                    // Kept as what it is: evaluating it needs the effect's
                    // expression machine, which this runtime does not have.
                    break;
                default:
                    throw new NotAnEffect(`an assignment of kind ${kind}`);
            }
            assignments.push(assignment);
        }
        return assignments;
    };

    /** @type {FxBuffer[]} */
    const buffers = [];
    for (let index = 0; index < counts.buffers; index++)
    {
        const nameAt = next();
        const size = next();
        const flags = next();
        const variableCount = next();
        const bindPoint = next();
        /** @type {FxBuffer} */
        const buffer = {
            name: string(nameAt), nameAt, size, textureBuffer: (flags & 1) !== 0,
            bindPoint: bindPoint === 0xffffffff ? -1 : bindPoint,
            annotations: readAnnotations(),
            variables: [],
        };
        for (let variable = 0; variable < variableCount; variable++)
        {
            const variableNameAt = next();
            const type = readType(next());
            const semanticAt = next();
            const bufferOffset = next();
            const defaultAt = next();
            const variableFlags = next();
            buffer.variables.push({
                name: string(variableNameAt),
                nameAt: variableNameAt,
                semantic: semanticAt ? string(semanticAt) : null,
                semanticAt: semanticAt || -1,
                bufferOffset,
                flags: variableFlags,
                type,
                defaultValue: defaultAt ? bytesAt(defaultAt, type.packedSize) : null,
                annotations: readAnnotations(),
            });
        }
        buffers.push(buffer);
    }

    /** @type {FxObjectVariable[]} */
    const objects = [];
    for (let index = 0; index < counts.objectVariables; index++)
    {
        const nameAt = next();
        const type = readType(next());
        const semanticAt = next();
        const bindPoint = next();
        if (type.kind !== 'object')
        {
            throw new NotAnEffect(`an object variable of type ${type.name}`);
        }
        /** @type {FxObjectElement[]} */
        const elements = [];
        for (let element = 0; element < Math.max(1, type.elements); element++)
        {
            switch (type.object)
            {
                case 'string':
                    elements.push({ stringAt: next() });
                    break;
                case 'pixelshader':
                case 'vertexshader':
                case 'geometryshader':
                    elements.push({ shader: type.streamOutput
                        ? readShader(next(), next())
                        : readShader(next()) });
                    break;
                case 'blend':
                case 'depthstencil':
                case 'rasterizer':
                case 'sampler':
                    elements.push({ assignments: readAssignments(next()) });
                    break;
                default:
                    elements.push({});
            }
        }
        objects.push({
            name: string(nameAt), nameAt,
            semantic: semanticAt ? string(semanticAt) : null,
            semanticAt: semanticAt || -1,
            bindPoint: bindPoint === 0xffffffff ? -1 : bindPoint,
            type,
            elements,
            annotations: readAnnotations(),
        });
    }

    /** @type {FxTechnique[]} */
    const techniques = [];
    for (let index = 0; index < counts.techniques; index++)
    {
        const nameAt = next();
        const passCount = next();
        /** @type {FxTechnique} */
        const technique = { name: string(nameAt), nameAt, annotations: readAnnotations(),
            passes: [] };
        for (let pass = 0; pass < passCount; pass++)
        {
            const passNameAt = next();
            const assignmentCount = next();
            const annotations = readAnnotations();
            technique.passes.push({
                name: string(passNameAt), nameAt: passNameAt, annotations,
                assignments: readAssignments(assignmentCount),
            });
        }
        techniques.push(technique);
    }

    return { version: counts.version, counts, unstructured, buffers, objects, techniques };
}
