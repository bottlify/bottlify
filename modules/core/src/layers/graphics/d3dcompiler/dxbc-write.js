/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writing a DXBC container: the header with its checksum, and the chunks a compiler puts in
 * one - the resource definitions (RDEF), the signatures (ISGN, OSGN), the program (SHDR or
 * SHEX) and the statistics (STAT).
 *
 * The checksum is the runtime's: MD5's rounds over everything after the checksum field,
 * with MD5's padding laid out differently - the length in bits in the first dword of the
 * last block rather than the last two, and `(bits >> 2) | 1` in its last dword. Direct3D
 * refuses a container whose sum does not match, so a program that hands one of these to a
 * real runtime (or checks it itself) is given one that does.
 */

/** @typedef {import('./sm4-ir.js').RdefType} RdefType */

/** MD5's per-round shifts and its table of sines (RFC 1321), written out. */
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const SINES = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/**
 * One block of MD5 into the state.
 * @param {Uint32Array} state @param {Uint32Array} block   Sixteen dwords.
 */
function md5Block(state, block){
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++)
    {
        let f;
        let g;
        if (i < 16)
        {
            f = (b & c) | (~b & d);
            g = i;
        }
        else if (i < 32)
        {
            f = (d & b) | (~d & c);
            g = (5 * i + 1) % 16;
        }
        else if (i < 48)
        {
            f = b ^ c ^ d;
            g = (3 * i + 5) % 16;
        }
        else
        {
            f = c ^ (b | ~d);
            g = (7 * i) % 16;
        }
        const shift = SHIFTS[(i >> 4) * 4 + (i & 3)];
        const sum = (a + f + SINES[i] + block[g]) >>> 0;
        a = d;
        d = c;
        c = b;
        b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
}

/**
 * The checksum of a container: four dwords over its bytes from offset 20.
 *
 * @param {Uint8Array} container
 * @returns {Uint32Array}
 */
export function dxbcChecksum(container){
    const data = container.subarray(20);
    const state = Uint32Array.from([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    const block = new Uint32Array(16);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const whole = data.length - (data.length % 64);
    for (let at = 0; at < whole; at += 64)
    {
        for (let i = 0; i < 16; i++)
        {
            block[i] = view.getUint32(at + i * 4, true);
        }
        md5Block(state, block);
    }
    const rest = data.subarray(whole);
    const bits = (data.length * 8) >>> 0;
    const tail = new Uint8Array(64);
    const tailWords = new DataView(tail.buffer);
    if (rest.length >= 56)
    {
        // The rest and its 0x80 fill one block; the length goes in a block of its own.
        tail.set(rest);
        tail[rest.length] = 0x80;
        for (let i = 0; i < 16; i++)
        {
            block[i] = tailWords.getUint32(i * 4, true);
        }
        md5Block(state, block);
        tail.fill(0);
    }
    else
    {
        tail.set(rest, 4);
        tail[4 + rest.length] = 0x80;
    }
    tailWords.setUint32(0, bits, true);
    tailWords.setUint32(60, ((bits >>> 2) | 1) >>> 0, true);
    for (let i = 0; i < 16; i++)
    {
        block[i] = tailWords.getUint32(i * 4, true);
    }
    md5Block(state, block);
    return state;
}

/**
 * A container of chunks, its checksum filled in.
 *
 * @param {{ name: string, bytes: Uint8Array }[]} chunks
 * @returns {Uint8Array}
 */
export function writeContainer(chunks){
    const headerSize = 32 + chunks.length * 4;
    let total = headerSize;
    /** @type {number[]} */
    const offsets = [];
    for (const chunk of chunks)
    {
        offsets.push(total);
        total += 8 + ((chunk.bytes.length + 3) & ~3);
    }
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    bytes.set([0x44, 0x58, 0x42, 0x43], 0);
    view.setUint32(20, 1, true);
    view.setUint32(24, total, true);
    view.setUint32(28, chunks.length, true);
    chunks.forEach((chunk, index)=>{
        const at = offsets[index];
        view.setUint32(32 + index * 4, at, true);
        for (let char = 0; char < 4; char++)
        {
            bytes[at + char] = chunk.name.charCodeAt(char);
        }
        view.setUint32(at + 4, (chunk.bytes.length + 3) & ~3, true);
        bytes.set(chunk.bytes, at + 8);
    });
    const sum = dxbcChecksum(bytes);
    sum.forEach((word, i)=>view.setUint32(4 + i * 4, word, true));
    return bytes;
}

/** A growing little-endian byte buffer with a table of strings at its end. */
export class ChunkWriter {
    constructor(){
        /** @type {number[]} */
        this.bytes = [];
    }

    get length(){
        return this.bytes.length;
    }

    /** @param {number} value */
    u32(value){
        const v = value >>> 0;
        this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
        return this;
    }

    /** @param {number} value */
    u16(value){
        this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
        return this;
    }

    /** @param {number} at @param {number} value */
    setU32(at, value){
        const v = value >>> 0;
        this.bytes[at] = v & 0xff;
        this.bytes[at + 1] = (v >>> 8) & 0xff;
        this.bytes[at + 2] = (v >>> 16) & 0xff;
        this.bytes[at + 3] = v >>> 24;
    }

    /** A NUL-terminated string here. @param {string} text @returns {number} where */
    string(text){
        const at = this.bytes.length;
        for (const char of text)
        {
            this.bytes.push(char.charCodeAt(0) & 0xff);
        }
        this.bytes.push(0);
        return at;
    }

    /** Pads to a dword with fxc's 0xab. */
    align(){
        while (this.bytes.length % 4 !== 0)
        {
            this.bytes.push(0xab);
        }
        return this;
    }

    finish(){
        this.align();
        return Uint8Array.from(this.bytes);
    }
}

/**
 * @typedef {Object} SignatureRow
 * @property {string} name
 * @property {number} index
 * @property {number} sv
 * @property {number} componentType   1 uint, 2 sint, 3 float.
 * @property {number} register
 * @property {number} mask
 * @property {number} rwMask   Inputs: the components read. Outputs: those never written.
 */

/**
 * ISGN or OSGN: a count, the rows at 24 bytes each, then the names.
 *
 * @param {SignatureRow[]} rows
 * @returns {Uint8Array}
 */
export function writeSignature(rows){
    const w = new ChunkWriter();
    w.u32(rows.length).u32(8);
    /** @type {number[]} */
    const nameFields = [];
    for (const row of rows)
    {
        nameFields.push(w.length);
        w.u32(0).u32(row.index).u32(row.sv).u32(row.componentType).u32(row.register)
            .u32((row.mask & 0xff) | ((row.rwMask & 0xff) << 8));
    }
    /** @type {Map<string, number>} */
    const names = new Map();
    rows.forEach((row, i)=>{
        let at = names.get(row.name);
        if (at === undefined)
        {
            at = w.string(row.name);
            names.set(row.name, at);
        }
        w.setU32(nameFields[i], at);
    });
    return w.finish();
}

/**
 * @typedef {Object} RdefBuffer
 * @property {string} name
 * @property {number} size
 * @property {number} flags
 * @property {number} type        0 cbuffer, 1 tbuffer.
 * @property {{ name: string, offset: number, size: number, flags: number, type: RdefType,
 *     defaults: number[] | null }[]} variables
 */

/**
 * @typedef {Object} RdefBinding
 * @property {string} name
 * @property {number} type        D3D10_SHADER_INPUT_TYPE.
 * @property {number} returnType
 * @property {number} dimension
 * @property {number} samples
 * @property {number} bindPoint
 * @property {number} bindCount
 * @property {number} flags
 */

/** The name of an RDEF type, which model 5's type entries carry. @param {RdefType} t */
function typeName(t){
    const base = /** @type {Record<number, string>} */ ({ 1: 'bool', 2: 'int', 3: 'float',
        19: 'uint' })[t.type] ?? 'void';
    switch (t.cls)
    {
        case 0: return base;
        case 1: return `${base}${t.cols}`;
        case 2:
        case 3: return `${base}${t.rows}x${t.cols}`;
        default: return 'struct';
    }
}

/**
 * RDEF: the constant buffers with their variables and types, the bound resources, the
 * creator; a model 5 header after the first (RD11) and the longer entries it announces.
 *
 * @param {{ buffers: RdefBuffer[], bindings: RdefBinding[], version: number, flags: number,
 *     creator: string, model5: boolean }} spec
 * @returns {Uint8Array}
 */
export function writeResourceDefinitions(spec){
    const w = new ChunkWriter();
    const { model5 } = spec;
    w.u32(spec.buffers.length);
    const buffersAtField = w.length;
    w.u32(0);
    w.u32(spec.bindings.length);
    const bindingsAtField = w.length;
    w.u32(0);
    w.u32(spec.version);
    w.u32(spec.flags);
    const creatorField = w.length;
    w.u32(0);
    if (model5)
    {
        w.u32(0x31314452).u32(60).u32(24).u32(32).u32(40).u32(36).u32(12).u32(0);
    }
    /** @type {{ at: number, text: string }[]} */
    const strings = [];
    /** @param {number} at @param {string} text */
    const nameAt = (at, text)=>strings.push({ at, text });

    // The bindings first, as fxc lays them out.
    w.setU32(bindingsAtField, spec.bindings.length > 0 ? w.length : 0);
    for (const binding of spec.bindings)
    {
        nameAt(w.length, binding.name);
        w.u32(0).u32(binding.type).u32(binding.returnType).u32(binding.dimension)
            .u32(binding.samples).u32(binding.bindPoint).u32(binding.bindCount).u32(binding.flags);
    }
    w.setU32(buffersAtField, spec.buffers.length > 0 ? w.length : 0);
    /** @type {{ at: number, buffer: RdefBuffer }[]} */
    const bufferFields = [];
    for (const buffer of spec.buffers)
    {
        nameAt(w.length, buffer.name);
        bufferFields.push({ at: w.length, buffer });
        w.u32(0).u32(buffer.variables.length).u32(0).u32(buffer.size).u32(buffer.flags)
            .u32(buffer.type);
    }
    /** @type {{ at: number, type: RdefType }[]} */
    const typeFields = [];
    /** @type {{ at: number, words: number[] }[]} */
    const defaultFields = [];
    for (const { at, buffer } of bufferFields)
    {
        w.setU32(at + 8, buffer.variables.length > 0 ? w.length : 0);
        for (const variable of buffer.variables)
        {
            nameAt(w.length, variable.name);
            w.u32(0).u32(variable.offset).u32(variable.size).u32(variable.flags);
            typeFields.push({ at: w.length, type: variable.type });
            w.u32(0);
            if (variable.defaults)
            {
                defaultFields.push({ at: w.length, words: variable.defaults });
            }
            w.u32(0);
            if (model5)
            {
                w.u32(0xffffffff).u32(0).u32(0xffffffff).u32(0);
            }
        }
    }
    for (const field of defaultFields)
    {
        w.setU32(field.at, w.length);
        for (const word of field.words)
        {
            w.u32(word);
        }
    }
    /** Types written so far by shape, so a type used twice is written once. */
    /** @type {Map<string, number>} */
    const written = new Map();
    /** @param {RdefType} type @returns {number} where */
    const writeType = type=>{
        const key = JSON.stringify(type);
        const known = written.get(key);
        if (known !== undefined)
        {
            return known;
        }
        const memberAts = type.members.map(m=>writeType(m.type));
        let membersAt = 0;
        if (type.members.length > 0)
        {
            membersAt = w.length;
            type.members.forEach((m, i)=>{
                nameAt(w.length, m.name);
                w.u32(0).u32(memberAts[i]).u32(m.offset);
            });
        }
        const at = w.length;
        w.u16(type.cls).u16(type.type).u16(type.rows).u16(type.cols).u16(type.elements)
            .u16(type.members.length).u32(membersAt);
        if (model5)
        {
            w.u32(0).u32(0).u32(0).u32(0);
            nameAt(w.length, typeName(type));
            w.u32(0);
        }
        written.set(key, at);
        return at;
    };
    for (const field of typeFields)
    {
        w.setU32(field.at, writeType(field.type));
    }
    w.setU32(creatorField, w.length);
    w.string(spec.creator);
    /** @type {Map<string, number>} */
    const pool = new Map();
    for (const { at, text } of strings)
    {
        let where = pool.get(text);
        if (where === undefined)
        {
            where = w.string(text);
            pool.set(text, where);
        }
        w.setU32(at, where);
    }
    return w.finish();
}
