/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The std140 and std430 layouts of a uniform or buffer block, as the
 * OpenGL 4.6 specification lays them out (section 7.6.2.2, "Standard
 * Uniform Block Layout"): where each member lies in the buffer, with the
 * strides of its arrays and matrices. A program reads its blocks from bytes
 * the application wrote by these rules, so the rules are the contract and
 * nothing here is a choice.
 *
 * The rules, as the specification numbers them:
 *
 * 1. A scalar of N bytes (4, or 8 for a double) aligns to N.
 * 2. A two- or four-component vector aligns to 2N or 4N.
 * 3. A three-component vector aligns to 4N.
 * 4. An array of scalars or vectors aligns to its element, rounded up to a
 *    vec4's 16 bytes in std140; its stride is that alignment; its end is
 *    padded to it.
 * 5. A column-major matrix of C columns and R rows is an array of C vectors
 *    of R components.
 * 6. An array of S such matrices is an array of S * C vectors.
 * 7. A row-major matrix is an array of R vectors of C components.
 * 8. An array of row-major matrices is an array of S * R vectors.
 * 9. A structure aligns to its most aligned member, rounded up to 16 bytes
 *    in std140; its size is padded to its alignment.
 * 10. An array of structures aligns each element so.
 *
 * std430 (section 7.6.2.2 too) is std140 without the rounding of rules 4
 * and 9 up to a vec4. GLSL 4.40 added `offset` and `align` on members
 * (section 4.4.5 of the language): `align` raises a member's alignment,
 * `offset` places it, at a multiple of its alignment.
 */

/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {'std140' | 'std430'} Packing
 */

/**
 * Where a type lies: its alignment and its size, and for an array its
 * stride, for a matrix (or an array of them) the stride of its columns or
 * rows.
 *
 * @typedef {Object} TypeLayout
 * @property {number} align
 * @property {number} size  0 for a run-time sized array: its elements are the buffer's
 * @property {number} [arrayStride]
 * @property {number} [matrixStride]
 * @property {boolean} [rowMajor]
 */

/**
 * A member of a block, where it lies.
 *
 * @typedef {Object} MemberLayout
 * @property {string} name
 * @property {GlslType} type
 * @property {number} offset
 * @property {number} align
 * @property {number} size
 * @property {number} [arrayStride]
 * @property {number} [matrixStride]
 * @property {boolean} [rowMajor]
 */

/** @param {number} value @param {number} align */
const roundUp = (value, align)=>Math.ceil(value / align) * align;

/** @param {GlslType} type @returns {number} 4, or 8 for a double */
function scalarBytes(type){
    return 'base' in type && type.base === 'double' ? 8 : 4;
}

/**
 * The alignment of a vector of `size` components of `n` bytes (rules 1-3).
 *
 * @param {number} size @param {number} n
 */
const vectorAlign = (size, n)=>(size === 1 ? n : size === 2 ? 2 * n : 4 * n);

/**
 * Where a type lies under a packing.
 *
 * @param {GlslType} type
 * @param {Packing} packing
 * @param {boolean} [rowMajor]  for a matrix, or an array or struct holding them
 *     (a struct's members may say otherwise: `members`' own layouts)
 * @returns {TypeLayout}
 */
export function typeLayout(type, packing, rowMajor = false){
    const round = packing === 'std140';
    switch (type.kind)
    {
        case 'scalar':
            return { align: scalarBytes(type), size: scalarBytes(type) };
        case 'vector': {
            const n = scalarBytes(type);
            return { align: vectorAlign(type.size, n), size: type.size * n };
        }
        case 'matrix': {
            // Rules 5 and 7: an array of its columns, or of its rows.
            const n = scalarBytes(type);
            const count = rowMajor ? type.rows : type.cols;
            const components = rowMajor ? type.cols : type.rows;
            const align = round ? roundUp(vectorAlign(components, n), 16)
                : vectorAlign(components, n);
            return { align, size: count * align, matrixStride: align, rowMajor };
        }
        case 'array': {
            const element = typeLayout(type.element, packing, rowMajor);
            const align = round ? roundUp(element.align, 16) : element.align;
            const stride = roundUp(element.size, align);
            /** @type {TypeLayout} */
            const layout = { align, size: stride * type.length, arrayStride: stride };
            if (element.matrixStride !== undefined)
            {
                layout.matrixStride = element.matrixStride;
                layout.rowMajor = rowMajor;
            }
            return layout;
        }
        case 'struct': {
            const members = membersLayout(type.fields.map(f=>({ name: f.name, type: f.type,
                rowMajor })), packing);
            const most = Math.max(...members.map(m=>m.align), 1);
            const align = round ? roundUp(most, 16) : most;
            const end = members.reduce((at, m)=>Math.max(at, m.offset + m.size), 0);
            return { align, size: roundUp(end, align) };
        }
        default:
            throw new Error(`a ${type.kind} has no place in a block`);
    }
}

/**
 * Lays members out one after another (rules 1 to 10, and `offset` and
 * `align`).
 *
 * @param {{ name: string, type: GlslType, rowMajor?: boolean, offset?: number,
 *     align?: number }[]} members
 * @param {Packing} packing
 * @returns {MemberLayout[]}
 */
export function membersLayout(members, packing){
    /** @type {MemberLayout[]} */
    const out = [];
    let at = 0;
    for (const member of members)
    {
        const layout = typeLayout(member.type, packing, member.rowMajor ?? false);
        let align = layout.align;
        if (member.align !== undefined)
        {
            if (member.align <= 0 || (member.align & (member.align - 1)) !== 0)
            {
                throw new RangeError(`'align' : ${member.align} is not a power of two`);
            }
            align = Math.max(align, member.align);
        }
        if (member.offset !== undefined)
        {
            if (member.offset % layout.align !== 0)
            {
                throw new RangeError(`'offset' : ${member.offset} is not a multiple of`
                    + ` ${member.name}'s alignment ${layout.align}`);
            }
            if (member.offset < at)
            {
                throw new RangeError(`'offset' : ${member.name} at ${member.offset} overlaps the`
                    + ' member before it');
            }
            at = member.offset;
        }
        const offset = roundUp(at, align);
        out.push({ name: member.name, type: member.type, offset, align: layout.align,
            size: layout.size, ...layout.arrayStride !== undefined
                ? { arrayStride: layout.arrayStride } : {},
            ...layout.matrixStride !== undefined ? { matrixStride: layout.matrixStride,
                rowMajor: layout.rowMajor } : {} });
        at = offset + layout.size;
    }
    return out;
}

/**
 * A block's members laid out, and the bytes it takes: the end of its last
 * member padded to the block's alignment as a structure's is (rule 9).
 *
 * @param {{ name: string, type: GlslType, rowMajor?: boolean, offset?: number,
 *     align?: number }[]} members
 * @param {Packing} packing
 * @returns {{ members: MemberLayout[], size: number, align: number }}
 */
export function blockLayout(members, packing){
    const laid = membersLayout(members, packing);
    const most = Math.max(1, ...laid.map(m=>m.align));
    const align = packing === 'std140' ? roundUp(most, 16) : most;
    const end = laid.reduce((at, m)=>Math.max(at, m.offset + m.size), 0);
    return { members: laid, size: roundUp(end, align), align };
}

/**
 * A block's active variables as a program lists them (section 7.3.1.1): a
 * leaf of a structure by its path, an array of scalars, vectors or matrices
 * once as `name[0]` with its length, an array of structures by element.
 *
 * @param {{ members: MemberLayout[] }} block
 * @param {Packing} packing
 * @returns {{ name: string, type: GlslType, offset: number, arraySize: number,
 *     arrayStride: number, matrixStride: number, rowMajor: boolean }[]}
 */
export function blockVariables(block, packing){
    /** @type {{ name: string, type: GlslType, offset: number, arraySize: number,
     *     arrayStride: number, matrixStride: number, rowMajor: boolean }[]} */
    const out = [];
    /**
     * @param {string} name @param {GlslType} type @param {number} offset
     * @param {boolean} rowMajor
     */
    const visit = (name, type, offset, rowMajor)=>{
        if (type.kind === 'struct')
        {
            const laid = membersLayout(type.fields.map(f=>({ name: f.name, type: f.type,
                rowMajor })), packing);
            for (const m of laid)
            {
                visit(`${name}.${m.name}`, m.type, offset + m.offset, rowMajor);
            }
            return;
        }
        const layout = typeLayout(type, packing, rowMajor);
        if (type.kind === 'array' && (type.element.kind === 'struct'
            || type.element.kind === 'array'))
        {
            for (let k = 0; k < Math.max(type.length, 1); k++)
            {
                visit(`${name}[${k}]`, type.element, offset + k * (layout.arrayStride ?? 0),
                    rowMajor);
            }
            return;
        }
        const leaf = type.kind === 'array' ? type.element : type;
        out.push({ name: type.kind === 'array' ? `${name}[0]` : name, type: leaf, offset,
            arraySize: type.kind === 'array' ? type.length : 1,
            arrayStride: layout.arrayStride ?? 0, matrixStride: layout.matrixStride ?? 0,
            rowMajor: leaf.kind === 'matrix' && rowMajor });
    };
    for (const m of block.members)
    {
        visit(m.name, m.type, m.offset, m.rowMajor ?? false);
    }
    return out;
}
