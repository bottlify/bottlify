/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The constant table a compiled shader carries: the CTAB comment that tells a
 * program which register holds which name, written so that `constants.js`
 * reads it back.
 *
 * The layout is the one `constants.js` documents -- a header, the constants'
 * records, a type record for each (a structure's followed by its members'),
 * then the strings and the default values -- with every offset counted from the
 * start of the header. A constant's default is the register data a program
 * writes with SetDefaults: four floats a register.
 */

import { RS, registersOf } from './hlsl-ir.js';
import { float32Bits } from './hlsl-math.js';

/** @typedef {import('./hlsl-ir.js').Const} Const */
/** @typedef {import('./hlsl-ir.js').CtabType} CtabType */

const HEADER = 28;
const CONSTANT_INFO = 20;
const TYPE_INFO = 16;
const MEMBER_INFO = 8;

/** The D3DXREGISTER_SET a constant's `set` letter names. @type {Record<string, number>} */
const SET = { f: RS.FLOAT4, i: RS.INT4, b: RS.BOOL, s: RS.SAMPLER };

/**
 * @typedef {Object} ConstantTableOptions
 * @property {Const[]} constants   Registers assigned, in the order the table lists them.
 * @property {string} creator
 * @property {string} target       'ps_2_0' and the like.
 * @property {number} version      The shader's version token.
 * @property {number} [flags]
 */

/**
 * The CTAB block, from its header, padded to a whole number of DWORDs.
 *
 * @param {ConstantTableOptions} options
 * @returns {Uint8Array}
 */
export function buildConstantTable(options){
    const { constants } = options;
    /** @type {Map<string, number>} */
    const strings = new Map();
    /** @type {{ offset: number, bytes: number[] }[]} */
    const pending = [];
    let size = HEADER + constants.length * CONSTANT_INFO;

    /** The type records of a type and, after them, those of its members. */
    /** @type {Map<CtabType, number>} */
    const typeAt = new Map();
    /** @type {Map<CtabType, number>} */
    const membersAt = new Map();
    /** @param {CtabType} type */
    const layoutType = type=>{
        typeAt.set(type, size);
        size += TYPE_INFO;
        if (type.members && type.members.length > 0)
        {
            membersAt.set(type, size);
            size += type.members.length * MEMBER_INFO;
            for (const member of type.members)
            {
                layoutType(member.type);
            }
        }
    };
    for (const constant of constants)
    {
        layoutType(constant.type);
    }

    /** @param {string} text */
    const stringAt = text=>{
        const known = strings.get(text);
        if (known !== undefined)
        {
            return known;
        }
        const offset = size;
        strings.set(text, offset);
        const bytes = [...text].map(c=>c.charCodeAt(0) & 0xff);
        bytes.push(0);
        pending.push({ offset, bytes });
        size += bytes.length;
        return offset;
    };

    // The strings and defaults take their offsets in the order they are asked
    // for below, which is the order the records are written.
    /** @type {{ info: number, name: number, type: number, defaults: number }[]} */
    const records = [];
    /** @type {{ at: number, name: number, type: number }[]} */
    const memberRecords = [];
    const creator = stringAt(options.creator);
    const target = stringAt(options.target);
    /** @type {{ offset: number, values: number[] }[]} */
    const defaultBlocks = [];
    for (const constant of constants)
    {
        const name = stringAt(constant.name);
        let defaults = 0;
        if (constant.defaults && constant.defaults.length > 0)
        {
            size = (size + 3) & ~3;
            defaults = size;
            defaultBlocks.push({ offset: size, values: constant.defaults });
            size += constant.defaults.length * 4;
        }
        records.push({ info: 0, name, type: typeAt.get(constant.type) ?? 0, defaults });
    }
    /** @param {CtabType} type */
    const nameMembers = type=>{
        if (!type.members || type.members.length === 0)
        {
            return;
        }
        const base = membersAt.get(type) ?? 0;
        type.members.forEach((member, m)=>{
            memberRecords.push({ at: base + m * MEMBER_INFO, name: stringAt(member.name),
                type: typeAt.get(member.type) ?? 0 });
            nameMembers(member.type);
        });
    };
    for (const constant of constants)
    {
        nameMembers(constant.type);
    }

    const total = (size + 3) & ~3;
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, HEADER, true);
    view.setUint32(4, creator, true);
    view.setUint32(8, options.version >>> 0, true);
    view.setUint32(12, constants.length, true);
    view.setUint32(16, constants.length > 0 ? HEADER : 0, true);
    view.setUint32(20, options.flags ?? 0, true);
    view.setUint32(24, target, true);
    constants.forEach((constant, c)=>{
        const at = HEADER + c * CONSTANT_INFO;
        const record = records[c];
        view.setUint32(at, record.name, true);
        view.setUint16(at + 4, SET[constant.set], true);
        view.setUint16(at + 6, constant.index ?? 0, true);
        view.setUint16(at + 8, constant.set === 's' ? Math.max(1, constant.type.elements)
            : registersOf(constant.type), true);
        view.setUint16(at + 10, 0, true);
        view.setUint32(at + 12, record.type, true);
        view.setUint32(at + 16, record.defaults, true);
    });
    for (const [type, at] of typeAt)
    {
        view.setUint16(at, type.cls, true);
        view.setUint16(at + 2, type.type, true);
        view.setUint16(at + 4, type.rows, true);
        view.setUint16(at + 6, type.cols, true);
        view.setUint16(at + 8, Math.max(type.elements, 1), true);
        view.setUint16(at + 10, type.members?.length ?? 0, true);
        view.setUint32(at + 12, membersAt.get(type) ?? 0, true);
    }
    for (const member of memberRecords)
    {
        view.setUint32(member.at, member.name, true);
        view.setUint32(member.at + 4, member.type, true);
    }
    for (const { offset, bytes: text } of pending)
    {
        bytes.set(text, offset);
    }
    for (const block of defaultBlocks)
    {
        block.values.forEach((value, i)=>
            view.setUint32(block.offset + i * 4, float32Bits(value), true));
    }
    return bytes;
}

/**
 * The CTAB comment's tokens: the comment token, 'CTAB', the block.
 *
 * @param {ConstantTableOptions} options
 * @returns {number[]}
 */
export function constantTableComment(options){
    const block = buildConstantTable(options);
    const words = new Uint32Array(block.buffer, block.byteOffset, block.byteLength / 4);
    return [(0xfffe | (1 + words.length) << 16) >>> 0, 0x42415443, ...words];
}
