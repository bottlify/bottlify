/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The differential gate of the Shader Model 4 compiler: one HLSL program down two paths.
 *
 * The tree interpreter (`win32/d3dx9/hlsl-eval.js`) runs the checked program; the compiler
 * writes a container, the machine (`sm4-machine.fixture.js`) runs it. Both get the same
 * inputs, the same uniforms - written into the constant buffers at the offsets the
 * container's RDEF gives, by the packing rules written out here a second time - the same
 * texture stand-in and derivative stand-in, and every component of every output is compared.
 * The container also goes through the translator to WGSL, which must take it.
 *
 * Nothing in the product reaches this file.
 */

import { parse } from '../../win32/d3dx9/hlsl-parser.js';
import { check } from '../../win32/d3dx9/hlsl-check.js';
import { createEvaluator } from '../../win32/d3dx9/hlsl-eval.js';
import { flattenValue } from '../../win32/d3dx9/hlsl-types.js';
import { parseDxbc } from '../d3d10/dxbc.js';
import { reflectShader } from '../d3d10/reflection.js';
import { translateShader } from '../d3d10/wgsl.js';
import { compileShader4 } from './compile.js';
import { asBits, asFloat, runSm4 } from './sm4-machine.fixture.js';

/** @typedef {import('../../win32/d3dx9/hlsl-types.js').Type} Type */

const f32 = Math.fround;

/** A seeded generator of numbers in [0, 1). @param {number} seed */
export function generator(seed){
    let state = (seed >>> 0) || 1;
    return ()=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        state ^= state >>> 15;
        return (state >>> 8) / (1 << 24);
    };
}

/** Distance in units in the last place. @param {number} a @param {number} b */
export function ulps(a, b){
    if (Number.isNaN(a) || Number.isNaN(b))
    {
        return Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity;
    }
    if (a === b)
    {
        return 0;
    }
    const order = (/** @type {number} */ x)=>{
        const word = asBits(x) | 0;
        return word < 0 ? -(word & 0x7fffffff) : word;
    };
    return Math.abs(order(a) - order(b));
}

/**
 * A random value of a type: floats in the range, small integers, whatever bools.
 * @param {Type} type @param {() => number} next @param {{ lo: number, hi: number }} range
 * @returns {any}
 */
function randomValue(type, next, range){
    const scalar = (/** @type {string} */ base)=>{
        if (base === 'bool')
        {
            return next() < 0.5 ? 0 : 1;
        }
        if (base === 'int')
        {
            return Math.floor(next() * 41) - 20;
        }
        if (base === 'uint')
        {
            return Math.floor(next() * 41);
        }
        return f32(range.lo + next() * (range.hi - range.lo));
    };
    switch (type.kind)
    {
        case 'scalar': return scalar(type.base);
        case 'vector': return Array.from({ length: type.n }, ()=>scalar(type.base));
        case 'matrix': return Array.from({ length: type.rows }, ()=>
            Array.from({ length: type.cols }, ()=>scalar(type.base)));
        case 'array': return Array.from({ length: type.length }, ()=>
            randomValue(type.elem, next, range));
        case 'struct': return Object.fromEntries(type.members.map(m=>
            [m.name, randomValue(m.type, next, range)]));
        default: return 0;
    }
}

/** The bits of a number of a base, as a register holds it. @param {number} x @param {string} base */
const bitsOf = (x, base)=>(base === 'float' ? asBits(x) : base === 'bool' ? (x ? 1 : 0)
    : x >>> 0);

/**
 * A value laid out into constant buffer dwords from `at` bytes: the packing rules again --
 * a matrix a register a column (or a row), an array element and a structure at a register.
 *
 * @param {Type} type @param {any} value @param {boolean} rowMajor @param {Uint32Array} data
 * @param {number} at
 * @returns {number} the bytes it took
 */
function place(type, value, rowMajor, data, at){
    switch (type.kind)
    {
        case 'scalar': data[at / 4] = bitsOf(value, type.base); return 4;
        case 'vector':
            value.forEach((/** @type {number} */ x, /** @type {number} */ i)=>{
                data[at / 4 + i] = bitsOf(x, type.base);
            });
            return 4 * type.n;
        case 'matrix':
            for (let r = 0; r < type.rows; r++)
            {
                for (let c = 0; c < type.cols; c++)
                {
                    data[(rowMajor ? at + r * 16 + c * 4 : at + c * 16 + r * 4) / 4]
                        = bitsOf(value[r][c], type.base);
                }
            }
            return rowMajor ? (type.rows - 1) * 16 + type.cols * 4 : (type.cols - 1) * 16
                + type.rows * 4;
        case 'array': {
            let size = 0;
            value.forEach((/** @type {any} */ v, /** @type {number} */ i)=>{
                const one = place(type.elem, v, rowMajor, data, at + i * Math.ceil(size / 16) * 16);
                if (i === 0)
                {
                    size = one;
                }
            });
            return Math.ceil(size / 16) * 16 * (type.length - 1) + size;
        }
        case 'struct': {
            let offset = 0;
            for (const m of type.members)
            {
                const probe = new Uint32Array(1024);
                const size = place(m.type, value[m.name], m.rowMajor ?? rowMajor, probe, 0);
                const fits = (m.type.kind === 'scalar' || m.type.kind === 'vector')
                    && (offset % 16) + size <= 16;
                offset = fits ? offset : Math.ceil(offset / 16) * 16;
                place(m.type, value[m.name], m.rowMajor ?? rowMajor, data, at + offset);
                offset += size;
            }
            return offset;
        }
        default: return 0;
    }
}

/**
 * The stand-in of every texture: a texel computed from the coordinate, the same on both paths.
 *
 * @param {string} op @param {number} key @param {number[]} coordinate floats or ints
 * @param {number} extra   A level, a bias, a reference.
 * @returns {number[]} four numbers
 */
function texel(op, key, coordinate, extra){
    const [x = 0, y = 0, z = 0] = coordinate;
    const a = f32(f32(x * 0.5) + f32(y * 0.25));
    const b = f32(f32(z + key) - f32(x * y));
    return [a, b, f32(extra + key * 0.125), f32(f32(a * b) + 1)];
}

/** A texture's size and levels, the stand-in's: width, height, depth or slices, levels. */
const sizeOf = (/** @type {number} */ key)=>[8 + key, 4 + key, 2, 3];

/** @param {number} x */
const derivativeOf = (x, /** @type {'x' | 'y'} */ axis)=>f32(x * (axis === 'x' ? 0.375 : -0.25));

/**
 * The flattened leaves of a value by semantic, for comparison.
 * @param {Type} type @param {any} value @param {string | null} semantic
 * @param {{ key: string, flat: number[], base: string }[]} out
 */
function leaves(type, value, semantic, out){
    if (type.kind === 'struct')
    {
        type.members.forEach(m=>leaves(m.type, value[m.name], m.semantic ?? semantic, out));
        return;
    }
    if (!semantic || type.kind === 'void')
    {
        return;
    }
    out.push({ key: semantic.toUpperCase().replace(/(\D)$/, '$10'), flat: flattenValue(value, type),
        base: /** @type {any} */ (type).base ?? 'float' });
}

/**
 * Runs a program down both paths and throws on a difference.
 *
 * @param {string} source
 * @param {string} profileName
 * @param {{ trials?: number, seed?: number, ulp?: number, absolute?: number,
 *     relative?: number, range?: { lo: number, hi: number }, flags?: number }} [options]
 * @returns {Promise<{ bytes: Uint8Array }>}
 */
export async function runGate4(source, profileName, options = {}){
    const result = await compileShader4(source, { profile: profileName, flags: options.flags });
    if (!result.ok || !result.bytes)
    {
        throw new Error(`did not compile:\n${result.messages}`);
    }
    const bytes = result.bytes;
    const container = /** @type {import('../d3d10/dxbc.js').DxbcContainer} */ (parseDxbc(bytes));
    // Direct3D 10 takes model 4 alone; a model 5 program is for a device not made here.
    const translated = container.shader?.major === 4 ? translateShader(container) : null;
    if (translated?.unsupported && translated.unsupported.length > 0)
    {
        throw new Error(`the translator refused it: ${translated.unsupported.join('; ')}`);
    }
    const reflection = /** @type {NonNullable<ReturnType<typeof reflectShader>>} */ (
        reflectShader(bytes));
    const checked = check(parse(source), { entry: 'main', sm4: true });
    if (checked.diagnostics.some(d=>d.severity === 'error'))
    {
        throw new Error(`the checker refused it: ${checked.diagnostics.map(d=>d.message)}`);
    }
    const entry = /** @type {import('../../win32/d3dx9/hlsl-types.js').FunctionSymbol} */ (
        checked.module.findFunction('main'));
    const range = options.range ?? { lo: -2, hi: 2 };
    const next = generator((options.seed ?? 1) * 7919 + profileName.length);
    const trials = options.trials ?? 4;
    for (let trial = 0; trial < trials; trial++)
    {
        // Uniforms, by name, and the buffers they are written into.
        /** @type {Map<string, any>} */
        const uniforms = new Map();
        /** @type {Map<number, Uint32Array>} */
        const buffers = new Map();
        const globals = checked.module.globals.filter(g=>g.isUniform && !g.isStatic
            && (g.type.kind !== 'texture' && g.type.kind !== 'sampler'));
        for (const g of globals)
        {
            uniforms.set(g.name, randomValue(g.type, next, range));
        }
        for (const buffer of reflection.constantBuffers)
        {
            const binding = reflection.bindings.find(b=>b.name === buffer.name && b.type <= 1);
            const data = new Uint32Array(buffer.size / 4 + 4);
            for (const variable of buffer.variableList)
            {
                const g = globals.find(one=>one.name === variable.name);
                if (g)
                {
                    place(g.type, uniforms.get(g.name), g.rowMajor ?? false, data,
                        variable.startOffset);
                }
            }
            buffers.set(binding?.bindPoint ?? 0, data);
        }
        // Textures by name, keyed by their slot.
        const textureSlots = new Map(reflection.bindings.filter(b=>b.type === 2)
            .map(b=>[b.name, b.bindPoint]));
        /** @type {Record<string, any>} */
        const args = {};
        /** @type {Map<number, number[]>} */
        const inputs = new Map();
        for (const p of entry.params)
        {
            if (p.isUniform || (p.dir ?? 'in') === 'out')
            {
                continue;
            }
            const value = randomValue(p.type, next, range);
            args[p.name] = value;
            /** @type {{ key: string, flat: number[], base: string }[]} */
            const flat = [];
            leaves(p.type, value, p.semantic, flat);
            for (const leaf of flat)
            {
                const element = container.inputs.find(e=>`${e.name.toUpperCase()}${e.index}`
                    === leaf.key);
                if (!element)
                {
                    continue;
                }
                const reg = inputs.get(element.register) ?? [0, 0, 0, 0];
                leaf.flat.forEach((x, i)=>{
                    reg[i] = leaf.base === 'bool' ? (x ? 0xffffffff : 0) : bitsOf(x, leaf.base);
                });
                inputs.set(element.register, reg);
            }
        }
        const evaluator = createEvaluator(checked.module, {
            uniform: sym=>{
                if (!uniforms.has(sym.name))
                {
                    throw new Error(`no uniform ${sym.name}`);
                }
                return uniforms.get(sym.name);
            },
            texture: op=>{
                const key = (textureSlots.get(op.texture.name) ?? 0) + op.element;
                if (op.method === 'GetDimensions')
                {
                    // Width, then height or the slices of a 1D array, then depth or slices,
                    // and the levels last when a level was named.
                    const size = sizeOf(key);
                    const picks = /** @type {Record<string, number[]>} */ ({ '1d': [0],
                        '1darray': [0, 1], '2d': [0, 1], cube: [0, 1] })[op.dim] ?? [0, 1, 2];
                    return [...picks, ...(op.args.length > 0 ? [3] : [])].map(c=>size[c]);
                }
                const coordinate = op.args[0] ?? [];
                const extra = op.args[1]?.[0] ?? 0;
                const lanes = texel(op.method, key, coordinate, op.method === 'SampleLevel'
                    || op.method === 'SampleBias' || op.method.startsWith('SampleCmp')
                    ? extra : 0);
                return lanes;
            },
            derivative: (axis, value)=>{
                if (typeof value === 'number')
                {
                    return derivativeOf(value, axis);
                }
                return /** @type {any[]} */ (value).map(x=>(Array.isArray(x)
                    ? x.map(y=>derivativeOf(y, axis)) : derivativeOf(x, axis)));
            },
        });
        const reference = evaluator.call(entry, args);
        /** @type {{ key: string, flat: number[], base: string }[]} */
        const expected = [];
        leaves(entry.returnType, reference.result, entry.semantic, expected);
        entry.params.forEach((p, i)=>{
            if ((p.dir ?? 'in') !== 'in')
            {
                leaves(p.type, reference.outs.get(i), p.semantic, expected);
            }
        });
        const run = runSm4(bytes, {
            inputs,
            buffers,
            texture: (op, slot, sampler, operands)=>{
                if (op.startsWith('resinfo'))
                {
                    const size = sizeOf(slot);
                    return op === 'resinfo_uint' ? size : size.map(x=>asBits(x));
                }
                const integer = op === 'ld' || op === 'ld_ms';
                // The lanes the resource's dimension reads (and a level for ld), as the
                // hardware takes them; what the operand has past those is not the texture's.
                const dimension = reflection.bindings.find(b=>b.type === 2
                    && slot >= b.bindPoint && slot < b.bindPoint + b.bindCount)?.dimension ?? 4;
                const lanes = ({ 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 })[
                    dimension] ?? 2;
                const level = op === 'ld' && dimension !== 1 ? 1 : 0;
                const coordinate = operands[0].slice(0, lanes + level)
                    .map(x=>(integer ? x | 0 : asFloat(x)));
                const extra = ['sample_l', 'sample_b', 'sample_c', 'sample_c_lz'].includes(op)
                    ? asFloat(operands[1][0]) : 0;
                return texel(op, slot, coordinate, extra).map(asBits);
            },
            derivative: (axis, bits)=>asBits(derivativeOf(asFloat(bits), axis)),
        });
        if (run.killed !== Boolean(reference.killed))
        {
            throw new Error(`trial ${trial}: killed ${run.killed}, the tree ${reference.killed}`);
        }
        for (const leaf of expected)
        {
            const element = container.outputs.find(e=>`${e.name.toUpperCase()}${e.index}`
                === leaf.key);
            if (!element)
            {
                throw new Error(`no output ${leaf.key} in the signature`);
            }
            const got = element.register === 0xffffffff ? [run.depth]
                : run.outputs.get(element.register) ?? [];
            leaf.flat.forEach((want, c)=>{
                const bits = got[c];
                if (bits === undefined)
                {
                    throw new Error(`trial ${trial}: ${leaf.key}.${'xyzw'[c]} never written`);
                }
                const fine = (()=>{
                    if (leaf.base !== 'float')
                    {
                        return leaf.base === 'bool' ? (bits !== 0) === (want !== 0)
                            : (bits >>> 0) === (bitsOf(want, leaf.base) >>> 0);
                    }
                    const x = asFloat(bits);
                    if (ulps(x, want) <= (options.ulp ?? 0))
                    {
                        return true;
                    }
                    const tolerance = (options.absolute ?? 0) + Math.abs(want)
                        * (options.relative ?? 0);
                    return Math.abs(x - want) <= tolerance;
                })();
                if (!fine)
                {
                    throw new Error(`trial ${trial}: ${leaf.key}.${'xyzw'[c]} is ${leaf.base
                        === 'float' ? asFloat(bits) : bits >>> 0}, the tree says ${want}`);
                }
            });
        }
    }
    return { bytes };
}
