/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compiled effects for tests, laid out as a compiler lays them out.
 *
 * A test of the effect framework needs an effect, and one from a compiler is
 * opaque: which variable a test is about cannot be read off its bytes. So
 * the tests describe an effect -- its buffers, variables, techniques and
 * passes -- and this writes the `FX10` chunk: the nineteen-dword header, the
 * unstructured block of names, types, values and shader bytecode, and the
 * structured part in the order the reader walks it. The reader was checked
 * against effects a real compiler produced; this is the same layout written
 * the other way round.
 *
 * Nothing in this file is reached by the product; it is a fixture.
 */

import { container } from './shader-fixtures.js';
import { FX_VERSION } from './effect.js';

/**
 * @typedef {Object} FixtureNumeric
 * @property {'scalar' | 'vector' | 'matrix'} layout
 * @property {'float' | 'int' | 'uint' | 'bool'} base
 * @property {number} [rows]
 * @property {number} [columns]
 * @property {boolean} [rowMajor]  A matrix is column-major unless it says.
 */

/**
 * @typedef {Object} FixtureEffectType
 * @property {string} name
 * @property {FixtureNumeric} [numeric]
 * @property {number} [object]   The file's object kind number.
 * @property {{ name: string, semantic?: string, offset: number,
 *              type: FixtureEffectType }[]} [members]
 * @property {number} [elements]
 * @property {number} [packedSize]    Given for a structure; worked out otherwise.
 * @property {number} [unpackedSize]
 * @property {number} [stride]
 */

/**
 * @typedef {Object} FixtureAnnotation
 * @property {string} name
 * @property {FixtureEffectType} type
 * @property {string[]} [strings]
 * @property {number[]} [value]   Packed dwords.
 */

/**
 * @typedef {Object} FixtureAssignment
 * @property {number} state
 * @property {number} [index]
 * @property {[number, number][]} [constant]  Pairs of type and dword.
 * @property {string} [variable]
 * @property {number} [element]
 * @property {Uint8Array | null} [shader]      A shader compiled in place.
 * @property {string} [streamOutput]
 * @property {number} [kind]                   An expression's kind, with `bytes`.
 * @property {Uint8Array} [bytes]
 */

/**
 * @typedef {Object} FixtureEffect
 * @property {number} [version]
 * @property {{ name: string, size: number, textureBuffer?: boolean, bindPoint?: number,
 *              annotations?: FixtureAnnotation[],
 *              variables: { name: string, type: FixtureEffectType, offset: number,
 *                           semantic?: string, defaultValue?: number[], flags?: number,
 *                           annotations?: FixtureAnnotation[] }[] }[]} [buffers]
 * @property {{ name: string, type: FixtureEffectType, semantic?: string, bindPoint?: number,
 *              annotations?: FixtureAnnotation[],
 *              elements?: { string?: string, shader?: Uint8Array | null,
 *                           streamOutput?: string,
 *                           assignments?: FixtureAssignment[] }[] }[]} [objects]
 * @property {{ name: string, annotations?: FixtureAnnotation[],
 *              passes: { name: string, annotations?: FixtureAnnotation[],
 *                        assignments?: FixtureAssignment[] }[] }[]} [techniques]
 */

/** The numeric type's sizes, laid out in 16-byte registers as a constant buffer is. */
function numericSizes(/** @type {FixtureEffectType} */ type){
    const numeric = /** @type {FixtureNumeric} */ (type.numeric);
    const rows = numeric.rows ?? 1;
    const columns = numeric.columns ?? 1;
    const count = Math.max(1, type.elements ?? 0);
    let registers = 1;
    let perRegister = columns;
    if (numeric.layout === 'matrix')
    {
        registers = numeric.rowMajor ? rows : columns;
        perRegister = numeric.rowMajor ? columns : rows;
    }
    const one = (registers - 1) * 16 + perRegister * 4;
    const stride = Math.ceil(one / 16) * 16;
    return {
        packedSize: rows * columns * 4 * count,
        unpackedSize: stride * (count - 1) + one,
        stride,
    };
}

const LAYOUT_CODE = { scalar: 1, vector: 2, matrix: 3 };
const BASE_CODE = { float: 1, int: 2, uint: 3, bool: 4 };

/**
 * @param {FixtureEffect} spec
 * @returns {Uint8Array} a DXBC container holding the effect
 */
export function effectBinary(spec){
    /** @type {number[]} */
    const block = [0, 0, 0, 0];
    /** @type {Map<string, number>} */
    const strings = new Map();
    /** @param {number} value */
    const pushWord = value=>{
        block.push(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff);
    };
    /** @param {string} text */
    const stringAt = text=>{
        const known = strings.get(text);
        if (known !== undefined)
        {
            return known;
        }
        const at = block.length;
        block.push(...[...text].map(char=>char.charCodeAt(0)), 0);
        strings.set(text, at);
        return at;
    };
    /** @param {number[]} words */
    const wordsAt = words=>{
        const at = block.length;
        words.forEach(pushWord);
        return at;
    };
    /** @type {Map<FixtureEffectType, number>} */
    const types = new Map();
    /** @param {FixtureEffectType} type @returns {number} */
    const typeAt = type=>{
        const known = types.get(type);
        if (known !== undefined)
        {
            return known;
        }
        const members = (type.members ?? []).map(member=>[stringAt(member.name),
            member.semantic ? stringAt(member.semantic) : 0, member.offset, typeAt(member.type)]);
        const name = stringAt(type.name);
        const sizes = type.numeric
            ? numericSizes(type)
            : { packedSize: type.packedSize ?? 0, unpackedSize: type.unpackedSize ?? 0,
                stride: type.stride ?? 0 };
        const at = block.length;
        const kind = type.numeric ? 1 : type.object !== undefined ? 2 : 3;
        [name, kind, type.elements ?? 0, sizes.unpackedSize, sizes.stride, sizes.packedSize]
            .forEach(pushWord);
        if (type.numeric)
        {
            const numeric = type.numeric;
            pushWord(LAYOUT_CODE[numeric.layout] | (BASE_CODE[numeric.base] << 3)
                | ((numeric.rows ?? 1) << 8) | ((numeric.columns ?? 1) << 11)
                | (numeric.layout === 'matrix' && !numeric.rowMajor ? 0x4000 : 0));
        }
        else if (kind === 2)
        {
            pushWord(/** @type {number} */ (type.object));
        }
        else
        {
            pushWord(members.length);
            members.flat().forEach(pushWord);
        }
        types.set(type, at);
        return at;
    };
    /** @param {Uint8Array | null | undefined} bytes */
    const shaderAt = bytes=>{
        if (!bytes)
        {
            return 0;
        }
        const at = wordsAt([bytes.length]);
        block.push(...bytes);
        while (block.length % 4 !== 0)
        {
            block.push(0);
        }
        return at;
    };

    /** @type {number[]} */
    const structured = [];
    /** @param {number[]} words */
    const put = words=>structured.push(...words);
    /** @param {FixtureAnnotation[] | undefined} annotations */
    const putAnnotations = (annotations = [])=>{
        put([annotations.length]);
        for (const annotation of annotations)
        {
            put([stringAt(annotation.name), typeAt(annotation.type)]);
            if (annotation.strings)
            {
                put(annotation.strings.map(stringAt));
            }
            else
            {
                put([wordsAt(annotation.value ?? [])]);
            }
        }
    };
    /** @param {FixtureAssignment[] | undefined} assignments */
    const putAssignments = (assignments = [])=>{
        for (const assignment of assignments)
        {
            let kind;
            let data;
            if (assignment.constant)
            {
                kind = 1;
                data = wordsAt([assignment.constant.length, ...assignment.constant.flat()]);
            }
            else if (assignment.variable !== undefined && assignment.element !== undefined)
            {
                kind = 3;
                data = wordsAt([stringAt(assignment.variable), assignment.element]);
            }
            else if (assignment.variable !== undefined)
            {
                kind = 2;
                data = stringAt(assignment.variable);
            }
            else if (assignment.kind !== undefined)
            {
                kind = assignment.kind;
                data = shaderAt(assignment.bytes ?? new Uint8Array(4));
            }
            else
            {
                kind = 7;
                const shader = shaderAt(assignment.shader);
                const streamOutput = assignment.streamOutput
                    ? stringAt(assignment.streamOutput)
                    : 0;
                data = wordsAt([shader, streamOutput]);
            }
            put([assignment.state, assignment.index ?? 0, kind, data]);
        }
    };

    const buffers = spec.buffers ?? [];
    const objects = spec.objects ?? [];
    const techniques = spec.techniques ?? [];
    let numericVariables = 0;
    for (const buffer of buffers)
    {
        put([stringAt(buffer.name), buffer.size, buffer.textureBuffer ? 1 : 0,
            buffer.variables.length, buffer.bindPoint ?? 0xffffffff]);
        putAnnotations(buffer.annotations);
        for (const variable of buffer.variables)
        {
            numericVariables++;
            put([stringAt(variable.name), typeAt(variable.type),
                variable.semantic ? stringAt(variable.semantic) : 0, variable.offset,
                variable.defaultValue ? wordsAt(variable.defaultValue) : 0, variable.flags ?? 0]);
            putAnnotations(variable.annotations);
        }
    }
    for (const object of objects)
    {
        put([stringAt(object.name), typeAt(object.type),
            object.semantic ? stringAt(object.semantic) : 0, object.bindPoint ?? 0xffffffff]);
        const count = Math.max(1, object.type.elements ?? 0);
        for (let index = 0; index < count; index++)
        {
            const element = object.elements?.[index] ?? {};
            switch (object.type.object)
            {
                case 1:
                    put([stringAt(element.string ?? '')]);
                    break;
                case 5: case 6: case 7:
                    put([shaderAt(element.shader)]);
                    break;
                case 8:
                    put([shaderAt(element.shader),
                        element.streamOutput ? stringAt(element.streamOutput) : 0]);
                    break;
                case 2: case 3: case 4: case 21:
                    put([(element.assignments ?? []).length]);
                    putAssignments(element.assignments);
                    break;
                default:
            }
        }
        putAnnotations(object.annotations);
    }
    for (const technique of techniques)
    {
        put([stringAt(technique.name), technique.passes.length]);
        putAnnotations(technique.annotations);
        for (const pass of technique.passes)
        {
            put([stringAt(pass.name), (pass.assignments ?? []).length]);
            putAnnotations(pass.annotations);
            putAssignments(pass.assignments);
        }
    }
    while (block.length % 4 !== 0)
    {
        block.push(0);
    }

    const header = [spec.version ?? FX_VERSION.FX_4_0, buffers.length, numericVariables,
        objects.length, 0, 0, 0, techniques.length, block.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const words = [...header];
    const bytes = new Uint8Array(words.length * 4 + block.length + structured.length * 4);
    const view = new DataView(bytes.buffer);
    words.forEach((value, index)=>view.setUint32(index * 4, value, true));
    bytes.set(block, words.length * 4);
    structured.forEach((value, index)=>view.setUint32(words.length * 4 + block.length
        + index * 4, value >>> 0, true));
    return container([{ name: 'FX10', bytes }]);
}

/** The file's object kind numbers, for fixtures. */
export const FX_KIND = Object.freeze({
    STRING: 1, BLEND: 2, DEPTHSTENCIL: 3, RASTERIZER: 4, PIXELSHADER: 5, VERTEXSHADER: 6,
    GEOMETRYSHADER: 7, GEOMETRYSHADER_SO: 8, TEXTURE: 9, TEXTURE1D: 10, TEXTURE1DARRAY: 11,
    TEXTURE2D: 12, TEXTURE2DARRAY: 13, TEXTURE2DMS: 14, TEXTURE2DMSARRAY: 15, TEXTURE3D: 16,
    TEXTURECUBE: 17, RENDERTARGETVIEW: 19, DEPTHSTENCILVIEW: 20, SAMPLER: 21,
});
