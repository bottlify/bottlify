/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The differential gate of the HLSL compiler, as a library for the tests that
 * use it.
 *
 * One shader is run down two paths that share nothing but the source: the
 * interpreter of the checked tree (`hlsl-eval.js`), which knows no register,
 * and the machine that executes the bytecode the compiler wrote
 * (`d3d9-machine.fixture.js`), which knows no HLSL. Both are given the same
 * random inputs, the same uniforms -- the machine's laid out through the constant
 * table the compiler wrote, with the same routine D3DX's setters use -- and the
 * same stand-in for a texture and for a derivative, and every component they
 * produce is compared in units in the last place.
 */

import { parse } from './hlsl-parser.js';
import { check } from './hlsl-check.js';
import { createEvaluator } from './hlsl-eval.js';
import { compileShader } from './hlsl-compile.js';
import { parseSemantic } from './hlsl-lower.js';
import { USAGE } from './hlsl-ir.js';
import { execute, disassemble } from './d3d9-machine.fixture.js';
import { parseConstantTable, registerValues } from './constants.js';
import { flattenValue } from './hlsl-types.js';

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

const bits = new DataView(new ArrayBuffer(4));

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
        bits.setFloat32(0, x);
        const word = bits.getInt32(0);
        return word < 0 ? -(word & 0x7fffffff) : word;
    };
    return Math.abs(order(a) - order(b));
}

/**
 * A random value of a type.
 *
 * @param {import('./hlsl-types.js').Type} type
 * @param {() => number} next
 * @param {{ lo: number, hi: number }} range
 * @returns {any}
 */
export function randomValue(type, next, range){
    const scalar = (/** @type {string} */ base)=>{
        if (base === 'bool')
        {
            return next() < 0.5 ? 0 : 1;
        }
        if (base === 'int')
        {
            return Math.floor(next() * 7) - 3;
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

/** @param {string} sampler @param {string} dimension @param {number[]} c */
function texel(sampler, dimension, c, value = 0, gradient = 0){
    let key = 0;
    for (const ch of sampler)
    {
        key = (key * 31 + ch.charCodeAt(0)) % 97;
    }
    const used = dimension === '2d' ? 2 : 3;
    return [0, 1, 2, 3].map(k=>{
        let phase = key * 0.37 + value * 0.15 + gradient * 0.1 + used;
        for (let j = 0; j < used; j++)
        {
            phase += (k + 1 + j * 0.6) * 0.55 * (c[j] ?? 0);
        }
        return f32(0.5 + 0.5 * Math.sin(phase));
    });
}

/** @param {any} v @param {number} s @returns {any} */
const scaled = (v, s)=>(Array.isArray(v) ? v.map(x=>scaled(x, s)) : f32(v * s));

/**
 * The key a semantic is known by on both paths.
 * @param {string} semantic
 */
function semanticKey(semantic){
    const parsed = parseSemantic(semantic);
    if (!parsed)
    {
        throw new Error(`no semantic '${semantic}'`);
    }
    return 'special' in parsed ? parsed.special : `${parsed.usage}:${parsed.index}`;
}

/**
 * The scalar and vector leaves of a value, each under its semantic.
 *
 * @param {import('./hlsl-types.js').Type} type @param {any} value @param {string | null} semantic
 * @param {{ key: string, flat: number[] }[]} out
 */
function leaves(type, value, semantic, out){
    if (type.kind === 'struct')
    {
        for (const m of type.members)
        {
            leaves(m.type, value[m.name], m.semantic ?? semantic, out);
        }
    }
    else if (type.kind === 'scalar' || type.kind === 'vector')
    {
        if (semantic)
        {
            out.push({ key: semanticKey(semantic), flat: flattenValue(value, type) });
        }
    }
}

/** The machine's name for an output register. @param {any} info @param {any} out */
function machineOutput(info, out){
    const { profile } = info;
    if (profile.kind === 'ps')
    {
        return out.usage === USAGE.DEPTH ? 'oDepth' : `oC${out.index}`;
    }
    if (profile.major >= 3)
    {
        return `o${out.reg}`;
    }
    switch (out.usage)
    {
        case USAGE.POSITION: return 'oPos';
        case USAGE.FOG: return 'oFog';
        case USAGE.PSIZE: return 'oPts';
        case USAGE.COLOR: return `oD${out.index}`;
        default: return `oT${out.index}`;
    }
}

/**
 * @typedef {Object} GateOptions
 * @property {string} [entry]
 * @property {number} [trials]
 * @property {number} [seed]
 * @property {number} [ulp]          Largest distance, in units in the last place.
 * @property {number} [absolute]     Or an absolute difference.
 * @property {{ lo: number, hi: number }} [range]   Range of the random floats.
 * @property {boolean} [rowMajor]
 */

/**
 * Compiles a shader and compares the two paths over random trials.
 *
 * @param {string} source @param {string} profileName @param {GateOptions} [options]
 * @returns {Promise<{ trials: number, killed: number, text: string }>}
 */
export async function runGate(source, profileName, options = {}){
    const entryName = options.entry ?? 'main';
    const compiled = await compileShader(source, { profile: profileName, entry: entryName,
        flags: options.rowMajor ? 8 : 0 });
    if (!compiled.ok || !compiled.tokens || !compiled.info || !compiled.constantTable)
    {
        throw new Error(`${profileName} did not compile:\n${compiled.messages}`);
    }
    const text = disassemble(compiled.tokens);
    const { info } = compiled;
    const checked = check(parse(source), { entry: entryName, rowMajor: options.rowMajor });
    const entry = checked.module.findFunction(entryName);
    if (!entry)
    {
        throw new Error('no entry');
    }
    const table = parseConstantTable(
        new DataView(compiled.constantTable.buffer, compiled.constantTable.byteOffset,
            compiled.constantTable.byteLength), 0);
    const range = options.range ?? { lo: -2, hi: 2 };
    const next = generator((options.seed ?? 1) * 7919 + profileName.length);
    let killedCount = 0;
    const trials = options.trials ?? 12;
    for (let trial = 0; trial < trials; trial++)
    {
        // One scenario: values for the uniforms and the inputs.
        /** @type {Map<string, any>} */
        const uniforms = new Map();
        for (const sym of checked.module.reachableGlobals(entry).filter(g=>!g.isStatic))
        {
            if (sym.type.kind !== 'sampler' && sym.type.kind !== 'texture')
            {
                uniforms.set(sym.name, randomValue(sym.type, next, range));
            }
        }
        for (const p of entry.params.filter(q=>q.isUniform))
        {
            uniforms.set(p.name, randomValue(p.type, next, range));
        }
        /** @type {Record<string, any>} */
        const args = {};
        /** @type {{ key: string, flat: number[] }[]} */
        const inputLeaves = [];
        const position = [Math.floor(next() * 640), Math.floor(next() * 480)];
        const front = next() < 0.5;
        for (const p of entry.params.filter(q=>!q.isUniform))
        {
            if ((p.dir ?? 'in') === 'out')
            {
                continue;
            }
            let value;
            if (p.semantic && /^vpos$/i.test(p.semantic))
            {
                value = position.slice(0, p.type.kind === 'vector' ? p.type.n : 2);
            }
            else if (p.semantic && /^vface$/i.test(p.semantic))
            {
                value = front ? 1 : -1;
            }
            else
            {
                value = randomValue(p.type, next, range);
            }
            args[p.name] = value;
            leaves(p.type, value, p.semantic, inputLeaves);
        }
        const sampleSeed = next();

        // Path one: the tree.
        /** @type {Map<string, number>} */
        const samplerIndex = new Map(table.constants.filter(c=>c.set === 3)
            .map(c=>[c.name, c.index]));
        const evaluator = createEvaluator(checked.module, {
            uniform: sym=>{
                const value = uniforms.get(sym.name);
                if (value === undefined)
                {
                    throw new Error(`no uniform ${sym.name}`);
                }
                return value;
            },
            sample: (sampler, op, mode, coords, extra)=>texel(
                `${/** @type {any} */ (sampler).name}${sampleSeed}`,
                op === 'tex3D' || op === 'texCUBE' ? 'volume' : '2d', coords, extra.value ?? 0,
                (extra.ddx?.[0] ?? 0) + (extra.ddy?.[0] ?? 0)),
            derivative: (axis, value)=>scaled(value, axis === 'x' ? 0.37 : -0.21),
        });
        const reference = evaluator.call(entry, args);
        /** @type {{ key: string, flat: number[] }[]} */
        const expected = [];
        leaves(entry.returnType, reference.result, entry.semantic, expected);
        entry.params.forEach((p, i)=>{
            if ((p.dir ?? 'in') !== 'in')
            {
                leaves(p.type, reference.outs.get(i), p.semantic, expected);
            }
        });

        // Path two: the bytecode.
        /** @type {number[]} */
        const f = [];
        for (const c of table.constants)
        {
            if (c.set !== 2)
            {
                continue;
            }
            const sym = checked.module.globals.find(g=>g.name === c.name)
                ?? entry.params.find(g=>g.name === c.name);
            if (!sym)
            {
                continue;
            }
            const value = uniforms.get(c.name);
            const fill = (/** @type {any} */ constant, /** @type {any} */ v, /** @type {any} */ t)=>{
                if (constant.cls === 5)
                {
                    constant.members.forEach((/** @type {any} */ member, /** @type {number} */ k)=>{
                        fill(member, v[t.members[k].name], t.members[k].type);
                    });
                    return;
                }
                const { registers, count } = registerValues(constant, flattenValue(v, t));
                for (let i = 0; i < count * 4; i++)
                {
                    f[constant.index * 4 + i] = registers[i];
                }
            };
            fill(c, value, sym.type);
        }
        for (let i = 0; i < f.length; i++)
        {
            f[i] ??= 0;
        }
        /** @type {Record<string, number[][]>} */
        const registers = { v: [], t: [] };
        for (const input of info.inputs)
        {
            const key = `${input.usage}:${input.index}`;
            const leaf = inputLeaves.find(l=>l.key === key);
            if (!leaf)
            {
                throw new Error(`no value for input ${key}`);
            }
            const lanes = [0, 0, 0, 0];
            leaf.flat.forEach((x, i)=>{
                lanes[i] = x;
            });
            registers[input.file ?? 'v'][input.reg ?? 0] = lanes;
        }
        let answer;
        try
        {
            answer = execute(compiled.tokens, {
                constants: { f },
                inputs: registers,
                position: /** @type {[number, number]} */ (position),
                frontFacing: front,
                sample: (sampler, dimension, coord, mode)=>{
                    const name = [...samplerIndex].find(([, index])=>index === sampler)?.[0] ?? '';
                    return texel(`${name}${sampleSeed}`, dimension, coord,
                        mode.kind === 'bias' || mode.kind === 'lod' ? mode.value ?? 0 : 0,
                        mode.kind === 'grad' ? (mode.ddx?.[0] ?? 0) + (mode.ddy?.[0] ?? 0) : 0);
                },
                derivative: (axis, value)=>scaled(value, axis === 'x' ? 0.37 : -0.21),
            });
        }
        catch (e){
            throw new Error(`${profileName}: ${/** @type {Error} */ (e).message}\n${text}`,
                { cause: e });
        }
        if (reference.killed || answer.killed)
        {
            assertEqual(reference.killed, answer.killed, `${profileName} killed\n${text}`);
            killedCount++;
            continue;
        }
        const ulp = options.ulp ?? 2;
        for (const want of expected)
        {
            const out = info.outputs.find(o=>`${o.usage}:${o.index}` === want.key);
            if (!out)
            {
                throw new Error(`the shader has no output ${want.key}\n${text}`);
            }
            const got = answer.outputs[machineOutput(info, out)];
            want.flat.forEach((x, i)=>{
                const close = ulps(got[i], f32(x)) <= ulp
                    || Math.abs(got[i] - x) <= (options.absolute ?? 0);
                if (!close)
                {
                    throw new Error(`${profileName} trial ${trial}: output ${want.key} lane ${i}: `
                        + `machine ${got[i]}, tree ${x}\n`
                        + `uniforms ${JSON.stringify([...uniforms])}\n`
                        + `inputs ${JSON.stringify(args)}\n${text}`);
                }
            });
        }
    }
    return { trials, killed: killedCount, text };
}

/** @param {any} a @param {any} b @param {string} message */
function assertEqual(a, b, message){
    if (a !== b)
    {
        throw new Error(`${message}: ${a} != ${b}`);
    }
}
