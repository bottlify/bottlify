/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What Shader Model 4 makes of the parts of a program the Direct3D 9 lowering leaves to its
 * target (`LowerTarget` in `win32/d3dx9/hlsl-lower.js`): where a uniform lives, what a texture
 * is, how a semantic becomes a signature element, and the functions of bits.
 *
 * Uniforms live in constant buffers: those the program declares, `$Globals` for the globals
 * outside any, `$Params` for the uniform parameters of the entry point. A buffer is laid out
 * as the packing rules of Direct3D 10 have it: a scalar or a vector does not cross a 16-byte
 * register, a matrix (a register a column, or a row for `row_major`), an array element and a
 * structure each begin a register, and `packoffset(cN.x)` places a variable where it says.
 *
 * A texture and a sampler are objects bound to t# and s#; a method of a texture is one
 * instruction (`sample`, `sample_l`, `ld`, `resinfo`, ...), its offset an immediate of the
 * instruction.
 */

import { baseOf, scalarCount, vectorOf } from '../../win32/d3dx9/hlsl-types.js';
import { TargetError4 } from './sm4-build.js';

/** @typedef {import('./sm4-ir.js').ConstantBuffer} ConstantBuffer */
/** @typedef {import('./sm4-ir.js').CbVariable} CbVariable */
/** @typedef {import('./sm4-ir.js').RdefType} RdefType */
/** @typedef {import('./sm4-ir.js').Resource} Resource */
/** @typedef {import('./sm4-ir.js').SamplerBinding} SamplerBinding */
/** @typedef {import('./sm4-ir.js').Input} Input */
/** @typedef {import('./sm4-ir.js').Output} Output */
/** @typedef {import('./sm4-ir.js').Profile4} Profile4 */
/** @typedef {import('./sm4-build.js').Vec} Vec */
/** @typedef {import('../../win32/d3dx9/hlsl-types.js').Type} Type */
/** @typedef {import('../../win32/d3dx9/hlsl-types.js').Symbol} Symbol */
/** @typedef {import('../../win32/d3dx9/hlsl-types.js').Module} Module */

/** D3D10_SHADER_VARIABLE_CLASS. */
export const SVC = Object.freeze({ SCALAR: 0, VECTOR: 1, MATRIX_ROWS: 2, MATRIX_COLUMNS: 3,
    OBJECT: 4, STRUCT: 5 });

/** D3D10_SHADER_VARIABLE_TYPE, the ones a constant buffer holds. */
export const SVT = Object.freeze({ VOID: 0, BOOL: 1, INT: 2, FLOAT: 3, UINT: 19 });

/** D3D_NAME: the system values of a signature. */
export const SV = Object.freeze({ UNDEFINED: 0, POSITION: 1, CLIP_DISTANCE: 2,
    CULL_DISTANCE: 3, RENDER_TARGET_ARRAY_INDEX: 4, VIEWPORT_ARRAY_INDEX: 5, VERTEX_ID: 6,
    PRIMITIVE_ID: 7, INSTANCE_ID: 8, IS_FRONT_FACE: 9, SAMPLE_INDEX: 10 });

/** A register, in bytes. */
const REGISTER = 16;

/** @param {number} n */
const align16 = n=>Math.ceil(n / REGISTER) * REGISTER;

/**
 * The bytes a type takes laid out from a register boundary, and its RDEF description.
 *
 * @param {Type} type @param {boolean} rowMajor
 * @returns {{ size: number, rdef: RdefType }}
 */
export function layoutOf(type, rowMajor){
    /** @param {string} base */
    const svt = base=>(base === 'bool' ? SVT.BOOL : base === 'int' ? SVT.INT : base === 'uint'
        ? SVT.UINT : SVT.FLOAT);
    switch (type.kind)
    {
        case 'scalar': return { size: 4, rdef: { cls: SVC.SCALAR, type: svt(type.base), rows: 1,
            cols: 1, elements: 0, members: [] } };
        case 'vector': return { size: 4 * type.n, rdef: { cls: SVC.VECTOR, type: svt(type.base),
            rows: 1, cols: type.n, elements: 0, members: [] } };
        case 'matrix': {
            const registers = rowMajor ? type.rows : type.cols;
            const lanes = rowMajor ? type.cols : type.rows;
            return { size: (registers - 1) * REGISTER + lanes * 4, rdef: {
                cls: rowMajor ? SVC.MATRIX_ROWS : SVC.MATRIX_COLUMNS, type: svt(type.base),
                rows: type.rows, cols: type.cols, elements: 0, members: [] } };
        }
        case 'array': {
            const one = layoutOf(type.elem, rowMajor);
            const stride = align16(one.size);
            return { size: stride * (type.length - 1) + one.size,
                rdef: { ...one.rdef, elements: type.length * Math.max(one.rdef.elements, 1) } };
        }
        case 'struct': {
            let at = 0;
            /** @type {{ name: string, offset: number, type: RdefType }[]} */
            const members = [];
            for (const m of type.members)
            {
                const inner = layoutOf(m.type, m.rowMajor ?? rowMajor);
                at = placed(at, m.type, inner.size);
                members.push({ name: m.name, offset: at, type: inner.rdef });
                at += inner.size;
            }
            return { size: at, rdef: { cls: SVC.STRUCT, type: SVT.VOID, rows: 1,
                cols: members.reduce((n, m)=>n + rdefComponents(m.type), 0), elements: 0,
                members } };
        }
        default: return { size: 0, rdef: { cls: SVC.SCALAR, type: SVT.VOID, rows: 0, cols: 0,
            elements: 0, members: [] } };
    }
}

/** The components a structure's columns count of a member. @param {RdefType} t @returns {number} */
function rdefComponents(t){
    const each = t.cls === SVC.STRUCT ? t.cols : t.rows * t.cols;
    return each * Math.max(t.elements, 1);
}

/**
 * Where a variable of `size` bytes goes from `at`: a scalar or vector where it fits in the
 * register, anything else at the next register.
 *
 * @param {number} at @param {Type} type @param {number} size
 */
function placed(at, type, size){
    if (type.kind === 'scalar' || type.kind === 'vector')
    {
        return (at % REGISTER) + size > REGISTER ? align16(at) : at;
    }
    return align16(at);
}

/**
 * A value's dwords as a constant buffer holds them, laid out by the packing rules.
 *
 * @param {Type} type @param {any} value @param {boolean} rowMajor @param {number[]} out
 * @param {number} at   Bytes.
 */
function defaultWords(type, value, rowMajor, out, at){
    const put = (/** @type {number} */ offset, /** @type {number} */ x, /** @type {string} */ base)=>{
        out[offset / 4] = base === 'float' ? floatWord(x) : base === 'bool' ? (x ? 1 : 0)
            : x >>> 0;
    };
    switch (type.kind)
    {
        case 'scalar': put(at, value, type.base); return;
        case 'vector': value.forEach((/** @type {number} */ x, /** @type {number} */ i)=>put(at + 4 * i,
            x, type.base)); return;
        case 'matrix':
            for (let r = 0; r < type.rows; r++)
            {
                for (let c = 0; c < type.cols; c++)
                {
                    put(rowMajor ? at + r * REGISTER + c * 4 : at + c * REGISTER + r * 4,
                        value[r][c], type.base);
                }
            }
            return;
        case 'array': {
            const stride = align16(layoutOf(type.elem, rowMajor).size);
            value.forEach((/** @type {any} */ v, /** @type {number} */ i)=>defaultWords(type.elem, v,
                rowMajor, out, at + i * stride));
            return;
        }
        case 'struct': {
            const { rdef } = layoutOf(type, rowMajor);
            type.members.forEach((m, i)=>defaultWords(m.type, value[m.name], m.rowMajor ?? rowMajor,
                out, at + rdef.members[i].offset));
            return;
        }
        default:
    }
}

const wordScratch = new DataView(new ArrayBuffer(4));
/** @param {number} x */
function floatWord(x){
    wordScratch.setFloat32(0, x, true);
    return wordScratch.getUint32(0, true);
}

/**
 * The constant buffers, textures and samplers of a checked program, laid out.
 *
 * @param {import('../../win32/d3dx9/hlsl-parser.js').Program} program
 * @param {Module} module
 * @param {import('../../win32/d3dx9/hlsl-types.js').FunctionSymbol | null} entry
 * @param {(code: string, message: string, pos: any) => never} fail
 */
export function layoutProgram(program, module, entry, fail){
    /** @type {ConstantBuffer[]} */
    const buffers = [];
    /** @type {Resource[]} */
    const resources = [];
    /** @type {SamplerBinding[]} */
    const samplers = [];
    /** Where each uniform lives. @type {Map<Symbol, { buffer: ConstantBuffer, variable: CbVariable }>} */
    const places = new Map();
    /** @type {Map<Symbol, Resource>} */
    const textureOf = new Map();
    /** @type {Map<Symbol, SamplerBinding>} */
    const samplerOf = new Map();
    const byDecl = new Map(module.globals.map(g=>[g.decl, g]));
    let order = 0;

    /** @param {string} name @param {import('../../win32/d3dx9/hlsl-parser.js').Register | null} register @param {0 | 1} kind */
    const newBuffer = (name, register, kind)=>{
        /** @type {ConstantBuffer} */
        const buffer = { name, slot: -1, explicit: register && /^b\d+$/i.test(register.name)
            ? Number(register.name.slice(1)) : null, size: 0, variables: [], used: false, kind,
        order: order++ };
        buffers.push(buffer);
        return buffer;
    };

    /**
     * @param {ConstantBuffer} buffer @param {Symbol} sym @param {{ at: number }} cursor
     */
    const addVariable = (buffer, sym, cursor)=>{
        const rowMajor = sym.rowMajor ?? module.rowMajor;
        const { size, rdef } = layoutOf(sym.type, rowMajor);
        const pack = sym.decl.packoffset;
        let at;
        if (pack)
        {
            const register = Number(/^c(\d+)$/i.exec(pack.register)?.[1] ?? NaN);
            if (Number.isNaN(register))
            {
                fail('X3530', `invalid packoffset '${pack.register}'`, sym.decl.pos);
            }
            at = register * REGISTER + 'xyzw'.indexOf((pack.component || 'x').toLowerCase()) * 4;
        }
        else
        {
            at = placed(cursor.at, sym.type, size);
        }
        cursor.at = Math.max(cursor.at, at + size);
        /** @type {number[] | null} */
        let defaults = null;
        const initial = sym.init ? module.evaluateConstant(sym.init) : undefined;
        if (initial !== undefined)
        {
            defaults = new Array(Math.ceil(size / 4)).fill(0);
            defaultWords(sym.type, initial, rowMajor, defaults, 0);
        }
        /** @type {CbVariable} */
        const variable = { name: sym.kind === 'param' ? sym.name : sym.name, offset: at, size,
            type: rdef, used: false, defaults };
        buffer.variables.push(variable);
        places.set(sym, { buffer, variable });
    };

    /** @param {Symbol} sym */
    const addObject = sym=>{
        let inner = sym.type;
        let count = 1;
        while (inner.kind === 'array')
        {
            count *= inner.length;
            inner = inner.elem;
        }
        const register = sym.register?.name ?? '';
        if (inner.kind === 'texture')
        {
            const elem = inner.elem ?? vectorOf('float', 4);
            const base = baseOf(elem) ?? 'float';
            /** @type {Resource} */
            const resource = { name: sym.name, slot: -1, explicit: /^t\d+$/i.test(register)
                ? Number(register.slice(1)) : null, count, dim: inner.dim === 'any' ? '2d'
                : inner.dim, kind: base === 'int' ? 'i' : base === 'uint' || base === 'bool' ? 'u'
                : 'f', components: scalarCount(elem), samples: inner.samples ?? 0, used: false,
            order: order++ };
            resources.push(resource);
            textureOf.set(sym, resource);
            return;
        }
        if (inner.kind === 'sampler')
        {
            /** @type {SamplerBinding} */
            const sampler = { name: sym.name, slot: -1, explicit: /^s\d+$/i.test(register)
                ? Number(register.slice(1)) : null, count, comparison: inner.dim === 'comparison',
            used: false, order: order++ };
            samplers.push(sampler);
            samplerOf.set(sym, sampler);
        }
    };

    /** @param {Type} t */
    const isObject = t=>{
        let inner = t;
        while (inner.kind === 'array')
        {
            inner = inner.elem;
        }
        return inner.kind === 'texture' || inner.kind === 'sampler';
    };
    /** @param {Type} t */
    const isData = t=>{
        let inner = t;
        while (inner.kind === 'array')
        {
            inner = inner.elem;
        }
        return inner.kind === 'scalar' || inner.kind === 'vector' || inner.kind === 'matrix'
            || inner.kind === 'struct';
    };

    /** @type {ConstantBuffer | null} */
    let globals = null;
    const globalCursor = { at: 0 };
    for (const decl of program.decls)
    {
        if (decl.kind === 'cbuffer')
        {
            const buffer = newBuffer(decl.name, decl.register, 0);
            const cursor = { at: 0 };
            for (const member of decl.members)
            {
                const sym = byDecl.get(member);
                if (!sym)
                {
                    continue;
                }
                if (isObject(sym.type))
                {
                    addObject(sym);
                }
                else if (isData(sym.type))
                {
                    addVariable(buffer, sym, cursor);
                }
            }
            buffer.size = align16(cursor.at);
            continue;
        }
        if (decl.kind !== 'var')
        {
            continue;
        }
        const sym = byDecl.get(decl);
        if (!sym || sym.isStatic || !sym.isUniform)
        {
            continue;
        }
        if (isObject(sym.type))
        {
            addObject(sym);
        }
        else if (isData(sym.type) && !sym.mods.includes('groupshared'))
        {
            globals ??= newBuffer('$Globals', null, 0);
            addVariable(globals, sym, globalCursor);
            globals.size = align16(globalCursor.at);
        }
    }
    // $Globals goes first, whatever was declared before it.
    if (globals)
    {
        globals.order = -1;
    }
    if (entry)
    {
        const cursor = { at: 0 };
        /** @type {ConstantBuffer | null} */
        let params = null;
        for (const p of entry.params)
        {
            if (!p.isUniform)
            {
                continue;
            }
            if (isObject(p.type))
            {
                addObject(p);
            }
            else if (isData(p.type))
            {
                params ??= newBuffer('$Params', null, 0);
                addVariable(params, p, cursor);
                params.size = align16(cursor.at);
            }
        }
    }
    return { buffers, resources, samplers, places, textureOf, samplerOf };
}

/**
 * The hooks of the lowering for one entry point.
 *
 * @param {ReturnType<typeof import('./sm4-build.js').createSm4Builder>} b
 * @param {Profile4} profile
 * @param {ReturnType<typeof layoutProgram>} layout
 * @param {Module} module
 * @param {(code: string, message: string, pos: any) => never} fail
 * @returns {import('../../win32/d3dx9/hlsl-lower.js').LowerTarget}
 */
export function createTarget(b, profile, layout, module, fail){
    /** @param {string | undefined | null} base @returns {'f' | 'i' | 'u' | 'b'} */
    const kindOf = base=>(base === 'int' ? 'i' : base === 'uint' ? 'u' : base === 'bool' ? 'b'
        : 'f');

    /**
     * The value of a type held in a constant buffer from `at` bytes, whose registers may be
     * counted on from a register `rel` holds.
     *
     * @param {Type} type @param {ConstantBuffer} buffer @param {CbVariable} variable
     * @param {number} at @param {boolean} rowMajor @param {any} rel
     * @returns {any}
     */
    const cbValue = (type, buffer, variable, at, rowMajor, rel)=>{
        /** @param {number} offset @param {number} width @param {string} base @returns {Vec} */
        const register = (offset, width, base)=>{
            const first = (offset % REGISTER) / 4;
            const kind = kindOf(base);
            const v = b.vec({ kind: 'cb', buffer, variable, row: Math.floor(offset / REGISTER),
                swz: Array.from({ length: width }, (_, i)=>first + i), ...(rel ? { rel } : {}) },
            kind === 'b' ? 'u' : kind);
            // A bool in a buffer is any 32 bits, true when not zero.
            return kind === 'b' ? b.as(v, 'b') : v;
        };
        switch (type.kind)
        {
            case 'scalar': return { k: 'vec', v: register(at, 1, type.base) };
            case 'vector': return { k: 'vec', v: register(at, type.n, type.base) };
            case 'matrix':
                return rowMajor
                    ? { k: 'mat', rows: type.rows, cols: type.cols, colV: null,
                        rowV: Array.from({ length: type.rows }, (_, r)=>register(at + r * REGISTER,
                            type.cols, type.base)) }
                    : { k: 'mat', rows: type.rows, cols: type.cols, rowV: null,
                        colV: Array.from({ length: type.cols }, (_, c)=>register(at + c * REGISTER,
                            type.rows, type.base)) };
            case 'array': {
                const stride = align16(layoutOf(type.elem, rowMajor).size);
                return { k: 'arr', elems: Array.from({ length: type.length }, (_, i)=>
                    cbValue(type.elem, buffer, variable, at + i * stride, rowMajor, rel)),
                uniform: rel ? undefined : { buffer, variable, base: at, stride,
                    elem: type.elem, rowMajor } };
            }
            case 'struct': {
                const { rdef } = layoutOf(type, rowMajor);
                return { k: 'struct', fields: type.members.map((m, i)=>cbValue(m.type, buffer,
                    variable, at + rdef.members[i].offset, m.rowMajor ?? rowMajor, rel)) };
            }
            default: return { k: 'void' };
        }
    };

    /**
     * @param {Symbol} sym
     * @returns {any}
     */
    const uniform = sym=>{
        const place = layout.places.get(sym);
        if (place)
        {
            return cbValue(sym.type, place.buffer, place.variable, place.variable.offset,
                sym.rowMajor ?? module.rowMajor, null);
        }
        const resource = layout.textureOf.get(sym);
        const sampler = layout.samplerOf.get(sym);
        if (!resource && !sampler)
        {
            return fail('X3000', `'${sym.name}': a uniform this compiler cannot place`,
                sym.decl.pos);
        }
        /** @param {Type} type @param {number} first @returns {any} */
        const nest = (type, first)=>{
            if (type.kind !== 'array')
            {
                return resource ? { k: 'texture', resource, element: first }
                    : { k: 'samplerstate', sampler, element: first };
            }
            const each = scalarSlots(type.elem);
            return { k: 'arr', elems: Array.from({ length: type.length }, (_, i)=>
                nest(type.elem, first + i * each)), uniform: { object: true, name: sym.name } };
        };
        return nest(sym.type, 0);
    };

    /** How many objects an array of them (or one) holds. @param {Type} type @returns {number} */
    const scalarSlots = type=>(type.kind === 'array' ? type.length * scalarSlots(type.elem) : 1);

    /**
     * An element of a uniform array at an index not known: its registers are read relative
     * to a temporary holding the index (times the registers an element takes).
     *
     * @param {any} array @param {Vec} index @param {any} ctx
     */
    const relative = (array, index, ctx)=>{
        if (array.object)
        {
            return ctx.fail('X3512', `'${array.name}': sampler and texture arrays must be `
                + 'indexed by a literal expression', null);
        }
        const rows = array.stride / REGISTER;
        let at = b.as(index, 'i');
        if (rows !== 1)
        {
            at = b.mul(at, b.num(rows, 1, 'i'));
        }
        if (at.src.kind !== 'reg')
        {
            at = b.copy(at);
        }
        if (at.src.kind !== 'reg')
        {
            // A literal index after all.
            return cbValue(array.elem, array.buffer, array.variable,
                array.base + /** @type {number[]} */ (b.literal(at))[0] * REGISTER, array.rowMajor,
                null);
        }
        return cbValue(array.elem, array.buffer, array.variable, array.base, array.rowMajor,
            at.src);
    };

    /** @param {string} semantic */
    const split = semantic=>{
        const match = /^(.*?)(\d*)$/.exec(semantic);
        const stem = match ? match[1] : semantic;
        return { stem, upper: stem.toUpperCase(),
            index: match && match[2] !== '' ? Number(match[2]) : 0 };
    };

    /** @param {Type} type */
    const widthOf = type=>(type.kind === 'vector' ? type.n : 1);

    /** The system values an input may be, by stage. */
    const INPUTS = /** @type {Record<string, Record<string, [number, 'f' | 'u', string?]>>} */ ({
        vs: { SV_VERTEXID: [SV.VERTEX_ID, 'u'], SV_INSTANCEID: [SV.INSTANCE_ID, 'u'] },
        ps: { SV_POSITION: [SV.POSITION, 'f', 'noperspective'],
            SV_ISFRONTFACE: [SV.IS_FRONT_FACE, 'u', 'constant'],
            SV_PRIMITIVEID: [SV.PRIMITIVE_ID, 'u', 'constant'],
            SV_SAMPLEINDEX: [SV.SAMPLE_INDEX, 'u', 'constant'],
            SV_CLIPDISTANCE: [SV.CLIP_DISTANCE, 'f'], SV_CULLDISTANCE: [SV.CULL_DISTANCE, 'f'],
            SV_RENDERTARGETARRAYINDEX: [SV.RENDER_TARGET_ARRAY_INDEX, 'u', 'constant'],
            SV_VIEWPORTARRAYINDEX: [SV.VIEWPORT_ARRAY_INDEX, 'u', 'constant'] },
    });

    /** @param {Type} type @param {string} semantic @param {string} name @param {any} pos */
    const input = (type, semantic, name, pos)=>{
        const { stem, upper, index } = split(semantic);
        const base = baseOf(type) ?? 'float';
        const system = INPUTS[profile.kind]?.[upper];
        if (upper.startsWith('SV_') && !system && !(profile.kind === 'vs'))
        {
            return fail('X4502', `invalid ${profile.name} input semantic '${semantic}'`, pos);
        }
        const kind = system ? system[1] : base === 'int' ? 'i' : base === 'float' ? 'f' : 'u';
        let found = b.inputs.find(i=>i.name.toUpperCase() === upper && i.index === index);
        if (!found)
        {
            found = { name: stem, index, width: 0, kind, sv: system ? system[0] : SV.UNDEFINED,
                interpolation: /** @type {any} */ (system?.[2] ?? (kind === 'f' ? 'linear'
                    : 'constant')) };
            b.inputs.push(found);
        }
        const width = widthOf(type);
        found.width = Math.max(found.width, width);
        const v = b.vec({ kind: 'input', input: found, swz: Array.from({ length: width },
            (_, i)=>i) }, kind);
        if (base === 'bool')
        {
            return upper === 'SV_ISFRONTFACE' ? b.retag(v, 'b') : b.as(v, 'b');
        }
        return b.as(v, kindOf(base));
    };

    /**
     * @param {Vec} value @param {Type} type @param {string} semantic @param {string} name
     * @param {any} pos
     */
    const output = (value, type, semantic, name, pos)=>{
        const { stem, upper, index } = split(semantic);
        const base = baseOf(type) ?? 'float';
        const kind = base === 'int' ? 'i' : base === 'float' ? 'f' : 'u';
        /** @type {Partial<Output>} */
        let shape = { sv: SV.UNDEFINED };
        if (profile.kind === 'ps')
        {
            if (upper === 'SV_TARGET')
            {
                if (index > 7)
                {
                    return fail('X4503', `invalid ${profile.name} output semantic '${semantic}'`,
                        pos);
                }
                shape = { sv: SV.UNDEFINED, target: index };
            }
            else if (upper === 'SV_DEPTH')
            {
                shape = { sv: SV.UNDEFINED, depth: true };
            }
            else
            {
                return fail('X4503', `invalid ${profile.name} output semantic '${semantic}'`,
                    pos);
            }
        }
        else if (upper === 'SV_POSITION')
        {
            shape = { sv: SV.POSITION };
        }
        else if (upper === 'SV_CLIPDISTANCE' || upper === 'SV_CULLDISTANCE')
        {
            shape = { sv: upper === 'SV_CLIPDISTANCE' ? SV.CLIP_DISTANCE : SV.CULL_DISTANCE };
        }
        else if (upper.startsWith('SV_'))
        {
            return fail('X4503', `invalid ${profile.name} output semantic '${semantic}'`, pos);
        }
        let found = b.outputs.find(o=>o.name.toUpperCase() === upper && o.index === index);
        if (!found)
        {
            found = { name: stem, index, width: 0, kind: kind === 'f' || !shape.depth ? kind : 'f',
                first: 0, sv: SV.UNDEFINED, ...shape };
            b.outputs.push(found);
        }
        found.width = Math.max(found.width, value.w);
        b.write(found, value);
    };

    /**
     * A texture method, as one instruction.
     *
     * @param {any} e @param {{ texture: any, sampler: any, args: any[] }} operands
     * @param {any} st @param {any} ctx
     */
    const texop = (e, operands, st, ctx)=>{
        const texture = operands.texture;
        if (texture?.k !== 'texture')
        {
            return fail('X3500', 'a texture method on what is not a texture', e.pos);
        }
        /** @type {Resource} */
        const resource = texture.resource;
        const resourceSrc = /** @type {any} */ ({ kind: 'resource', resource,
            element: texture.element });
        const sampler = operands.sampler;
        if (e.sampler && sampler?.k !== 'samplerstate')
        {
            return fail('X3500', 'a texture method whose sampler is not a sampler state', e.pos);
        }
        const samplerSrc = sampler ? /** @type {any} */ ({ kind: 'sampler',
            sampler: sampler.sampler, element: sampler.element }) : null;
        const args = operands.args.map(a=>ctx.vecOf(a));
        const method = e.method;
        const lanes = scalarCount(e.type);
        const kind = resource.kind;
        /** An immediate offset, which the instruction holds. @param {Vec | undefined} v */
        const offsetOf = v=>{
            if (!v)
            {
                return undefined;
            }
            const values = b.literal(v);
            if (!values)
            {
                return fail('X3500', `'${method}': an offset must be an immediate value`, e.pos);
            }
            if (values.some(x=>x < -8 || x > 7))
            {
                return fail('X3500', `'${method}': an offset must be between -8 and 7`, e.pos);
            }
            return values.map(x=>x | 0);
        };
        /** @param {string} op @param {any[]} srcs @param {number[] | undefined} offset @param {'f' | 'i' | 'u'} t */
        const read = (op, srcs, offset, t)=>{
            const result = b.emit(op, lanes === 1 && (op === 'sample_c' || op === 'sample_c_lz')
                ? 1 : 4, srcs, t, { positional: true, extra: offset ? { offset } : undefined });
            return b.swizzle(result, Array.from({ length: lanes }, (_, i)=>i));
        };
        const f = (/** @type {Vec} */ v)=>b.as(v, 'f');
        switch (method)
        {
            case 'Sample':
                return ctx.vec(read('sample', [f(args[0]).src, resourceSrc, samplerSrc],
                    offsetOf(args[1]), kind));
            case 'SampleLevel':
                return ctx.vec(read('sample_l', [f(args[0]).src, resourceSrc, samplerSrc,
                    f(args[1]).src], offsetOf(args[2]), kind));
            case 'SampleBias':
                return ctx.vec(read('sample_b', [f(args[0]).src, resourceSrc, samplerSrc,
                    f(args[1]).src], offsetOf(args[2]), kind));
            case 'SampleGrad':
                return ctx.vec(read('sample_d', [f(args[0]).src, resourceSrc, samplerSrc,
                    f(args[1]).src, f(args[2]).src], offsetOf(args[3]), kind));
            case 'SampleCmp':
            case 'SampleCmpLevelZero':
                return ctx.vec(read(method === 'SampleCmp' ? 'sample_c' : 'sample_c_lz',
                    [f(args[0]).src, resourceSrc, samplerSrc, f(args[1]).src],
                    offsetOf(args[2]), 'f'));
            case 'Gather':
                if (profile.major === 4 && profile.minor === 0)
                {
                    return fail('X3500', `'Gather' is not available in ${profile.name}`, e.pos);
                }
                return ctx.vec(read('gather4', [f(args[0]).src, resourceSrc, samplerSrc],
                    offsetOf(args[1]), kind));
            case 'Load':
            case 'Index': {
                const ms = resource.dim === '2dms' || resource.dim === '2dmsarray';
                let coord = b.as(args[0], 'i');
                if (method === 'Index' && resource.dim !== 'buffer' && !ms)
                {
                    // tex[i] is level 0.
                    coord = b.cat([coord, b.num(0, 1, 'i')]);
                }
                if (ms)
                {
                    const sample = method === 'Index' ? b.num(0, 1, 'i') : b.as(args[1], 'i');
                    return ctx.vec(read('ld_ms', [coord.src, resourceSrc, sample.src],
                        offsetOf(args[2]), kind));
                }
                return ctx.vec(read('ld', [coord.src, resourceSrc], method === 'Index'
                    ? undefined : offsetOf(args[1]), kind));
            }
            case 'GetDimensions':
                return dimensions(e, resource, resourceSrc, args, st, ctx);
            default:
                return fail('X3018', `invalid subscript '${method}'`, e.pos);
        }
    };

    /**
     * GetDimensions: resinfo, each out the component of it that the dimension puts there.
     *
     * @param {any} e @param {Resource} resource @param {any} resourceSrc @param {Vec[]} args
     * @param {any} st @param {any} ctx
     */
    const dimensions = (e, resource, resourceSrc, args, st, ctx)=>{
        if (resource.dim === 'buffer' || resource.dim === '2dms' || resource.dim === '2dmsarray')
        {
            return fail('X3500', `'GetDimensions' of a ${resource.dim === 'buffer' ? 'buffer'
                : 'multisampled texture'} is not available in ${profile.name}`, e.pos);
        }
        // Which component of resinfo each out reads: width, height or elements, depth, and
        // the level count in w.
        const lanes = /** @type {Record<string, number[]>} */ ({ '1d': [0], '1darray': [0, 1],
            '2d': [0, 1], '2darray': [0, 1, 2], '3d': [0, 1, 2], cube: [0, 1],
            cubearray: [0, 1, 2] })[resource.dim] ?? [0, 1];
        const level = e.levels ? b.as(args[0], 'u') : b.num(0, 1, 'u');
        const asFloat = e.outs.some((/** @type {any} */ o)=>baseOf(o.type) === 'float');
        const info = b.emit('resinfo', 4, [level.src, resourceSrc], asFloat ? 'f' : 'u',
            { positional: true, extra: asFloat ? undefined : { uint: true } });
        const picks = e.levels ? [...lanes, 3] : lanes;
        e.outs.forEach((/** @type {any} */ out, /** @type {number} */ i)=>{
            const one = b.lane(info, picks[i]);
            ctx.store(out, ctx.vec(b.as(one, kindOf(baseOf(out.type)) === 'b' ? 'u'
                : /** @type {any} */ (kindOf(baseOf(out.type))))), st);
        });
        return { k: 'void' };
    };

    /**
     * The functions of Shader Model 4 the common library has none of.
     *
     * @param {any} ctx @param {string} name @param {any[]} args @param {Type} result
     * @param {any} e
     * @returns {any}
     */
    const intrinsic = (ctx, name, args, result, e)=>{
        const one = ()=>ctx.vecOf(args[0].value);
        const base = baseOf(args[0]?.type ?? result);
        const model5 = (/** @type {string} */ op)=>{
            if (profile.major < 5)
            {
                fail('X3004', `'${name}' is not available in ${profile.name}`, e.pos);
            }
            return op;
        };
        switch (name)
        {
            case 'asuint':
            case 'asint':
            case 'asfloat': {
                const v = one();
                const from = base === 'bool' ? b.as(v, 'u') : v;
                return ctx.vec(b.bitcast(from, name === 'asuint' ? 'u' : name === 'asint'
                    ? 'i' : 'f'));
            }
            case 'isnan': return ctx.vec(b.ne(one(), one()));
            case 'isinf': return ctx.vec(b.eq(b.abs(one()), b.num(Infinity, one().w)));
            case 'isfinite': return ctx.vec(b.lt(b.abs(one()), b.num(Infinity, one().w)));
            case 'countbits':
                return ctx.vec(b.lanewise(model5('countbits'), [one()], 'u', 'u'));
            case 'reversebits':
                return ctx.vec(b.lanewise(model5('bfrev'), [one()], 'u', 'u'));
            case 'firstbithigh': {
                // The instruction counts from the top; the function from the bottom.
                const kind = base === 'int' ? 'i' : 'u';
                const fromTop = b.lanewise(model5(base === 'int' ? 'firstbit_shi' : 'firstbit_hi'),
                    [one()], kind, 'i');
                const none = b.eq(fromTop, b.num(-1, 1, 'i'));
                return ctx.vec(b.retag(b.select(none, fromTop, b.sub(b.num(31, 1, 'i'), fromTop)),
                    kind));
            }
            case 'firstbitlow':
                return ctx.vec(b.lanewise(model5('firstbit_lo'), [one()], 'u',
                    base === 'int' ? 'i' : 'u'));
            case 'f32tof16':
                return ctx.vec(b.lanewise(model5('f32tof16'), [one()], 'f', 'u'));
            case 'f16tof32':
                return ctx.vec(b.lanewise(model5('f16tof32'), [one()], 'u', 'f'));
            case 'abs':
            case 'min':
            case 'max':
            case 'clamp':
            case 'sign':
                return null;
            default:
                if (name.startsWith('tex'))
                {
                    throw new TargetError4('X3500', `'${name}' is not available in ${profile.name}`
                        + ': read a texture through its methods (tex.Sample)');
                }
                return null;
        }
    };

    return { builder: b, uniform, texop, input, output, relative, intrinsic };
}
