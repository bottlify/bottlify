/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Random shaders through the differential gate. The programs are made of a
 * fixed set of operations on a handful of inputs and locals, with branches and
 * loops thrown in; a generator seeded by the test's number makes each one, so
 * a failure names a shader that can be made again.
 *
 * One family uses only operations that both paths compute identically -- sums,
 * products, selections, rounding, comparisons, dot products -- and so has to
 * agree to the last bit. The other adds the operations whose compiled form is
 * an approximation (division, roots, powers, trigonometry) and is compared with
 * a tolerance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, generator } from './hlsl-gate.fixture.js';
import { parseShader } from '../../graphics/d3d9/shader.js';
import { translateShader } from '../../graphics/d3d9/wgsl.js';

/**
 * @param {number} seed
 * @param {boolean} approximate
 * @param {'ps' | 'vs'} kind
 */
function program(seed, approximate, kind){
    const next = generator(seed * 104729 + 7);
    /** @param {number} n @returns {number} */
    const pick = n=>Math.floor(next() * n);
    /** @template T @param {T[]} list @returns {T} */
    const choose = list=>list[pick(list.length)];
    /** @type {{ name: string, size: number }[]} */
    const scope = [{ name: 'a', size: 4 }, { name: 'b', size: 4 }, { name: 'c', size: 4 },
        { name: 'u0', size: 4 }, { name: 'u1', size: 4 }, { name: 'k', size: 1 }];
    const lanes = 'xyzw';
    /** @param {number} n @returns {string} */
    const literal = n=>{
        const one = ()=>choose(['0.5', '2.0', '-1.5', '0.25', '3.0', '-0.75', '1.0']);
        return n === 1 ? one() : `float${n}(${Array.from({ length: n }, one).join(', ')})`;
    };
    /** A reference of a given size, from a variable at least that big. @param {number} n */
    const leaf = n=>{
        if (next() < 0.15)
        {
            return literal(n);
        }
        const options = scope.filter(v=>v.size >= n);
        const v = choose(options);
        if (v.size === n)
        {
            return next() < 0.5 ? v.name : `${v.name}.${[...lanes.slice(0, n)]
                .sort(()=>next() - 0.5).join('')}`;
        }
        const picked = Array.from({ length: n }, ()=>lanes[pick(v.size)]).join('');
        return `${v.name}.${picked}`;
    };
    /** @param {number} n @param {number} depth @returns {string} */
    const expr = (n, depth)=>{
        if (depth <= 0)
        {
            return leaf(n);
        }
        const d = depth - 1;
        const kinds = ['bin', 'bin', 'bin', 'unary', 'minmax', 'lerp', 'select', 'step', 'mad'];
        if (n === 1)
        {
            kinds.push('dot', 'dot', 'cmp');
        }
        if (n > 1)
        {
            kinds.push('build');
        }
        if (approximate)
        {
            kinds.push('approx', 'approx', 'approx');
        }
        switch (choose(kinds))
        {
            case 'bin': {
                const scalar = n > 1 && next() < 0.3;
                return `(${expr(n, d)} ${choose(['+', '-', '*'])} ${expr(scalar ? 1 : n, d)})`;
            }
            case 'unary': {
                const f = choose(['-', 'abs', 'saturate', 'frac', 'floor', 'trunc', 'ceil']);
                return f === '-' ? `(-(${expr(n, d)}))` : `${f}(${expr(n, d)})`;
            }
            case 'minmax': return `${choose(['min', 'max'])}(${expr(n, d)}, ${expr(n, d)})`;
            case 'lerp': return `lerp(${expr(n, d)}, ${expr(n, d)}, ${expr(next() < 0.5 ? 1 : n,
                d)})`;
            case 'select': return `(${expr(1, d)} ${choose(['<', '>', '<=', '>=', '!='])} `
                + `${expr(1, d)} ? ${expr(n, d)} : ${expr(n, d)})`;
            case 'step': return `step(${expr(n, d)}, ${expr(n, d)})`;
            case 'mad': return `(${expr(n, d)} * ${expr(n, d)} + ${expr(n, d)})`;
            case 'dot': {
                const k = 2 + pick(3);
                return `dot(${expr(k, d)}, ${expr(k, d)})`;
            }
            case 'cmp': return `((float)(${expr(1, d)} ${choose(['<', '>', '==', '!='])} `
                + `${expr(1, d)}) + (float)(${expr(1, d)} >= ${expr(1, d)}))`;
            case 'build': {
                const first = 1 + pick(n - 1);
                return `float${n}(${expr(first, d)}, ${expr(n - first, d)})`;
            }
            default: {
                // Operations whose compiled form is an approximation.
                const x = expr(n, d);
                switch (pick(6))
                {
                    case 0: return `(${x} / (abs(${expr(1, d)}) + 0.5))`;
                    case 1: return `sqrt(abs(${x}) + 0.25)`;
                    case 2: return `rsqrt(abs(${x}) + 0.25)`;
                    case 3: return `pow(abs(${x}) + 0.25, 1.5)`;
                    case 4: return `sin(${x} * 0.5)`;
                    default: return `exp2(saturate(${x}) * 2)`;
                }
            }
        }
    };
    /** @type {string[]} */
    const lines = [];
    let count = 0;
    /** @param {number} indent @param {number} budget */
    const statements = (indent, budget)=>{
        const pad = ' '.repeat(indent);
        for (let i = 0; i < budget; i++)
        {
            const roll = next();
            if (roll < 0.15 && indent < 12)
            {
                lines.push(`${pad}if (${expr(1, 1)} ${choose(['<', '>'])} ${expr(1, 1)})`);
                const mark = scope.length;
                lines.push(`${pad}{`);
                statements(indent + 4, 2);
                scope.length = mark;
                lines.push(`${pad}}`);
                lines.push(`${pad}else`);
                lines.push(`${pad}{`);
                statements(indent + 4, 1);
                scope.length = mark;
                lines.push(`${pad}}`);
            }
            else if (roll < 0.25 && indent < 8)
            {
                const n = 2 + pick(3);
                lines.push(`${pad}for (int j${count} = 0; j${count} < ${n}; j${count}++)`);
                lines.push(`${pad}{`);
                const mark = scope.length;
                scope.push({ name: `j${count}`, size: 1 });
                count++;
                statements(indent + 4, 2);
                scope.length = mark;
                lines.push(`${pad}}`);
            }
            else
            {
                const existing = scope.filter(v=>/^v\d+$/.test(v.name));
                if (existing.length > 0 && next() < 0.4)
                {
                    const v = choose(existing);
                    const lane = v.size > 1 && next() < 0.4 ? `.${lanes[pick(v.size)]}` : '';
                    lines.push(`${pad}${v.name}${lane} ${choose(['=', '+=', '-=', '*='])} `
                        + `${expr(lane ? 1 : v.size, 2)};`);
                }
                else
                {
                    const size = 1 + pick(4);
                    const name = `v${count++}`;
                    lines.push(`${pad}float${size === 1 ? '' : size} ${name} = ${expr(size, 3)};`);
                    scope.push({ name, size });
                }
            }
        }
    };
    statements(4, 6 + pick(5));
    const locals = scope.filter(v=>/^v\d+$/.test(v.name));
    const combine = ()=>{
        const parts = locals.slice(-4).map(v=>(v.size === 1 ? v.name : `${v.name}.x`));
        while (parts.length < 4)
        {
            parts.push('0');
        }
        return `float4(${parts.join(', ')})`;
    };
    const head = 'float4 u0; float4 u1; float k;';
    if (kind === 'ps')
    {
        return `${head}
float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1, float4 c : COLOR0) : COLOR0
{
${lines.join('\n')}
    return ${combine()};
}`;
    }
    return `${head}
struct O { float4 pos : POSITION; float4 o0 : TEXCOORD0; float4 col : COLOR0; };
O main(float4 p : POSITION, float4 a : TEXCOORD0, float4 b : TEXCOORD1, float4 c : COLOR0)
{
${lines.join('\n')}
    O o;
    o.pos = p; o.o0 = ${combine()}; o.col = ${combine()}.wzyx;
    return o;
}`;
}

/**
 * @param {number} count @param {boolean} approximate @param {'ps' | 'vs'} kind
 * @param {string[]} profiles
 */
function family(count, approximate, kind, profiles){
    for (let seed = 1; seed <= count; seed++)
    {
        for (const profile of profiles)
        {
            const source = program(seed + (approximate ? 1000 : 0) + (kind === 'vs' ? 500 : 0),
                approximate, kind);
            test(`random ${kind} ${approximate ? 'approximate ' : ''}#${seed} (${profile})`,
                async()=>{
                    try
                    {
                        const result = await runGate(source, profile, {
                            trials: 6, seed, ulp: approximate ? 0 : 0,
                            ...(approximate ? { absolute: 2e-3, relative: 2e-5 } : {}),
                            range: { lo: -2, hi: 2 },
                        });
                        const parsed = parseShader(result.tokens);
                        assert.equal(translateShader(parsed).error, null);
                    }
                    catch (e){
                        // A target that cannot hold the program says so; no wrong answer.
                        if (/did not compile:\n.*error X56/.test(/** @type {Error} */ (e).message))
                        {
                            return;
                        }
                        throw new Error(`${/** @type {Error} */ (e).message}\n--- source:\n${
                            source}`, { cause: e });
                    }
                });
        }
    }
}

// More programs than the suite carries by default can be asked for to hunt a rare fault.
const MORE = Number(process.env.HLSL_FUZZ ?? 1);
family(40 * MORE, false, 'ps', ['ps_2_b', 'ps_3_0']);
family(40 * MORE, false, 'vs', ['vs_2_0', 'vs_3_0']);
family(25 * MORE, true, 'ps', ['ps_2_b', 'ps_3_0']);
family(25 * MORE, true, 'vs', ['vs_2_0', 'vs_3_0']);
