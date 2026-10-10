/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    assemble, decode, disassemble, execute, MAX_IF_NESTING, MAX_LOOP_NESTING, VERSION_LIMITS,
} from './d3d9-machine.fixture.js';

/** @typedef {import('./d3d9-machine.fixture.js').MachineIO} MachineIO */

const f32 = Math.fround;

/** Every source this file assembles, for the round trip that closes it. */
const SOURCES = new Set();

/** @param {string} text */
function asm(text){
    SOURCES.add(text);
    return assemble(text);
}

/** @param {number} x */
function num(x){
    if (Object.is(x, -0))
    {
        return '-0';
    }
    if (Number.isNaN(x))
    {
        return 'nan';
    }
    return x === Infinity ? 'inf' : x === -Infinity ? '-inf' : String(x);
}

/** @param {number[][]} consts */
function defs(consts){
    return consts.map((c, i)=>`def c${i}, ${[...c, 0, 0, 0].slice(0, 4).map(num).join(', ')}`)
        .join('\n');
}

/**
 * Assembles and runs a shader.
 * @param {string} text
 * @param {import('./d3d9-machine.fixture.js').MachineIO} io
 */
function go(text, io){
    return execute(asm(text), io);
}

/**
 * Runs one instruction in a pixel shader whose constants are def'd and whose
 * result goes to oC0.
 * @param {string} instruction
 * @param {number[][]} consts
 * @param {string} [version]
 */
function runPs(instruction, consts, version = 'ps_2_0'){
    const r = go(`${version}\n${defs(consts)}\n${instruction}\n`, {});
    return r.outputs.oC0;
}

/**
 * @param {number[]} actual
 * @param {number[]} expected
 * @param {number} [tolerance]
 */
function close(actual, expected, tolerance = 2e-7){
    assert.equal(actual.length, expected.length);
    expected.forEach((e, i)=>{
        const a = actual[i];
        if (Number.isNaN(e))
        {
            assert.ok(Number.isNaN(a), `component ${i}: ${a} is not NaN`);
        }
        else if (!Number.isFinite(e))
        {
            assert.equal(a, e);
        }
        else
        {
            assert.ok(Math.abs(a - e) <= tolerance * Math.max(1, Math.abs(e)),
                `component ${i}: ${a} is not within ${tolerance} of ${e}`);
        }
    });
}

/**
 * @param {() => unknown} fn
 * @param {RegExp} pattern
 */
function rejects(fn, pattern){
    assert.throws(fn, error=>{
        assert.ok(error instanceof Error);
        assert.match(error.message, pattern);
        return true;
    });
}

const NaN4 = [NaN, NaN, NaN, NaN];

test('arithmetic instructions, with exact results', ()=>{
    const A = [1, 2, 3, 4];
    const B = [0.5, 0.25, -1, 10];
    const C = [2, 2, 2, 2];
    /** @type {[string, number[][], number[]][]} */
    const cases = [
        ['mov oC0, c0', [A], A],
        ['add oC0, c0, c1', [A, B], [1.5, 2.25, 2, 14]],
        ['sub oC0, c0, c1', [A, B], [0.5, 1.75, 4, -6]],
        ['mul oC0, c0, c1', [A, B], [0.5, 0.5, -3, 40]],
        ['mad oC0, c0, c1, c2', [A, B, C], [2.5, 2.5, -1, 42]],
        ['min oC0, c0, c1', [A, B], [0.5, 0.25, -1, 4]],
        ['max oC0, c0, c1', [A, B], [1, 2, 3, 10]],
        ['slt oC0, c0, c1', [A, B], [0, 0, 0, 1]],
        ['sge oC0, c0, c1', [A, B], [1, 1, 1, 0]],
        ['dp3 oC0, c0, c1', [A, B], [-2, -2, -2, -2]],
        ['dp4 oC0, c0, c1', [A, B], [38, 38, 38, 38]],
        ['dp2add oC0, c0, c1, c2', [A, B, C], [3, 3, 3, 3]],
        ['lrp oC0, c0, c1, c2', [[0, 1, 0.5, 0.25], [10, 20, 30, 40], [2, 4, 6, 8]],
            [2, 20, 18, 16]],
        ['frc oC0, c0', [[1.25, -0.75, 3, -0.5]], [0.25, 0.25, 0, 0.5]],
        ['abs oC0, c0', [[-1, 2, -3, 0]], [1, 2, 3, 0]],
        ['cmp oC0, c0, c1, c2', [[-1, 0, 1, -0], [1, 2, 3, 4], [5, 6, 7, 8]], [5, 2, 3, 4]],
        ['cmp oC0, c0, c1, c2', [[NaN, -0.5, 0.5, -Infinity], [1, 2, 3, 4], [5, 6, 7, 8]],
            [5, 6, 3, 8]],
        ['mov oC0, -c0', [A], [-1, -2, -3, -4]],
        ['mov oC0, c0.wzyx', [A], [4, 3, 2, 1]],
        ['mov oC0, c0.yx', [A], [2, 1, 1, 1]],
        ['mov oC0, c0.xyz', [A], [1, 2, 3, 3]],
        ['mov oC0, c0.zzxy', [A], [3, 3, 1, 2]],
        ['add oC0, c0.x, c1', [A, B], [1.5, 1.25, 0, 11]],
        ['mul oC0, c0.wzyx, c1.yyyy', [A, B], [1, 0.75, 0.5, 0.25]],
        ['max oC0, -c0, c1', [A, B], [0.5, 0.25, -1, 10]],
        ['mov_sat oC0, c0', [[-1, 0.5, 2, NaN]], [0, 0.5, 1, 0]],
        ['add_sat oC0, c0, c1', [[0.75, 0.25, -3, 0.5], [0.5, 0.5, 1, 0.25]], [1, 0.75, 0, 0.75]],
        ['mov_pp oC0, c0', [A], A],
    ];
    for (const [instruction, consts, want] of cases)
    {
        assert.deepEqual(runPs(instruction, consts), want, instruction);
    }
});

test('products are rounded before they are added, in single precision', ()=>{
    const a = f32(1 + 2 ** -12);
    const out = runPs('mad oC0, c0, c0, c1', [[a, a, a, a], [-1, -1, -1, -1]]);
    // a*a = 1 + 2^-11 + 2^-24 rounds to 1 + 2^-11 in single precision.
    assert.deepEqual(out, [2 ** -11, 2 ** -11, 2 ** -11, 2 ** -11]);
    const sum = runPs('dp3 oC0, c0, c1', [[1e8, 1, -1e8, 0], [1, 1, 1, 0]]);
    assert.deepEqual(sum, [0, 0, 0, 0]);
    const big = runPs('mul oC0, c0, c1', [[3e38, 1, 1, 1], [10, 1, 1, 1]]);
    assert.equal(big[0], Infinity);
});

test('min and max pick the second source when the comparison fails', ()=>{
    assert.deepEqual(runPs('min oC0, c0, c1', [[NaN, 1, 1, 0], [2, NaN, 1, -0]]),
        [2, NaN, 1, -0]);
    assert.deepEqual(runPs('max oC0, c0, c1', [[NaN, 1, 1, 0], [2, NaN, 1, -0]]),
        [2, NaN, 1, 0]);
});

test('write masks leave components unwritten and report them', ()=>{
    const r = go('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0.xz, c0\n', {});
    assert.deepEqual(r.outputs.oC0, [1, NaN, 3, NaN]);
    assert.equal(r.written.oC0, 0b0101);
    const r2 = go('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0.yw, c0.wzyx\nmov oC0.x, c0.w\n',
        {});
    assert.deepEqual(r2.outputs.oC0, [4, 3, NaN, 1]);
    assert.equal(r2.written.oC0, 0b1011);
    const r3 = go('ps_2_0\ndef c0, 1, 2, 3, 4\nmov r0.yz, c0\nmov oC0, r0.yyzz\n', {});
    assert.deepEqual(r3.outputs.oC0, [2, 2, 3, 3]);
});

test('sources are read before any result is stored', ()=>{
    const r = go('ps_2_0\ndef c0, 1, 2, 3, 4\nmov r0, c0\nmov r0.xy, r0.yx\nmov oC0, r0\n', {});
    assert.deepEqual(r.outputs.oC0, [2, 1, 3, 4]);
    const r2 = go('ps_2_0\ndef c0, 1, 2, 3, 4\nmov r0, c0\nadd r0.xyz, r0.yzx, r0\nmov oC0, r0\n',
        {});
    assert.deepEqual(r2.outputs.oC0, [3, 5, 4, 4]);
});

test('scalar instructions', ()=>{
    /** @type {[string, number[], number][]} */
    const cases = [
        ['rcp', [4, 0, 0, 0], 0.25],
        ['rcp', [-8, 0, 0, 0], -0.125],
        ['rcp', [0, 0, 0, 0], Infinity],
        ['rcp', [-0, 0, 0, 0], Infinity],
        ['rsq', [16, 0, 0, 0], 0.25],
        ['rsq', [-16, 0, 0, 0], 0.25],
        ['rsq', [0, 0, 0, 0], Infinity],
        ['rsq', [-0, 0, 0, 0], Infinity],
        ['exp', [3, 0, 0, 0], 8],
        ['exp', [-1, 0, 0, 0], 0.5],
        ['exp', [0, 0, 0, 0], 1],
        ['exp', [200, 0, 0, 0], Infinity],
        ['log', [8, 0, 0, 0], 3],
        ['log', [-8, 0, 0, 0], 3],
        ['log', [0.5, 0, 0, 0], -1],
        ['log', [0, 0, 0, 0], -Infinity],
    ];
    for (const [name, c0, want] of cases)
    {
        assert.deepEqual(runPs(`${name} oC0, c0.x`, [c0]), [want, want, want, want],
            `${name} ${c0[0]}`);
        assert.deepEqual(runPs(`${name} oC0.yz, c0.x`, [c0]), [NaN, want, want, NaN]);
    }
    assert.deepEqual(runPs('rcp oC0, c0.y', [[1, 5, 1, 1]]), [0.2, 0.2, 0.2, 0.2].map(f32));
    assert.deepEqual(runPs('pow oC0, c0.x, c1.x', [[-2], [3]]), [8, 8, 8, 8]);
    assert.deepEqual(runPs('pow oC0, c0.x, c1.x', [[2], [0.5]]), Array(4).fill(f32(Math.SQRT2)));
    assert.deepEqual(runPs('pow oC0, c0.x, c1.x', [[0], [0]]), [1, 1, 1, 1]);
    assert.deepEqual(runPs('pow oC0, c0.x, c1.x', [[0], [3]]), [0, 0, 0, 0]);
    assert.deepEqual(runPs('pow oC0, c0.x, c1.x', [[1], [Infinity]]), [1, 1, 1, 1]);
    assert.deepEqual(runPs('pow oC0, c0.x, c1.y', [[4], [9, 0.5]]), [2, 2, 2, 2]);
});

test('sincos: cosine in x, sine in y, with both the 2.x and the 3.0 operand lists', ()=>{
    const angle = 1.25;
    const want = [f32(Math.cos(f32(angle))), f32(Math.sin(f32(angle)))];
    const a = runPs('sincos oC0.xy, c0.x, c1, c2', [[angle, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    assert.deepEqual(a.slice(0, 2), want);
    assert.ok(Number.isNaN(a[2]) && Number.isNaN(a[3]));
    const b = runPs('sincos oC0.xy, c0.x', [[angle, 0, 0, 0]], 'ps_3_0');
    assert.deepEqual(b.slice(0, 2), want);
    assert.deepEqual(runPs('sincos oC0.x, c0.x', [[0, 0, 0, 0]], 'ps_3_0').slice(0, 1), [1]);
    assert.deepEqual(runPs('sincos oC0.y, c0.x', [[0, 0, 0, 0]], 'ps_3_0')[1], 0);
    assert.deepEqual(runPs('sincos oC0.xy, c0.x', [[-Math.PI / 2, 0, 0, 0]], 'ps_3_0')[1], -1);
    const c = go('vs_2_x\ndef c0, 0.5, 0, 0, 0\nsincos oT0.xy, c0.x, c1, c2\nmov oPos, c0\n', {});
    assert.deepEqual(c.outputs.oT0.slice(0, 2), [f32(Math.cos(0.5)), f32(Math.sin(0.5))]);
});

test('nrm, crs, lit, dst and sgn', ()=>{
    close(runPs('nrm oC0.xyz, c0', [[3, 0, 4, 5]]), [0.6, 0, 0.8, NaN]);
    close(runPs('nrm oC0, c0', [[3, 0, 4, 5]]), [0.6, 0, 0.8, 1]);
    close(runPs('nrm oC0.xyz, c0.zyx', [[0, 0, 2, 7]]), [1, 0, 0, NaN]);
    assert.deepEqual(runPs('crs oC0.xyz, c0, c1', [[1, 0, 0, 9], [0, 1, 0, 9]]), [0, 0, 1, NaN]);
    assert.deepEqual(runPs('crs oC0.xyz, c0, c1', [[0, 1, 0, 9], [0, 0, 1, 9]]), [1, 0, 0, NaN]);
    assert.deepEqual(runPs('crs oC0.xyz, c0, c1', [[0, 0, 1, 9], [1, 0, 0, 9]]), [0, 1, 0, NaN]);
    assert.deepEqual(runPs('crs oC0.xyz, c0, c1', [[1, 2, 3, 0], [4, 5, 6, 0]]), [-3, 6, -3, NaN]);
    assert.deepEqual(runPs('crs oC0.xyz, c1, c0', [[1, 2, 3, 0], [4, 5, 6, 0]]), [3, -6, 3, NaN]);
    assert.deepEqual(runPs('crs oC0, c0, c1', [[1, 2, 3, 0], [4, 5, 6, 0]]), [-3, 6, -3, 0]);
    const vs = (/** @type {string} */ body, /** @type {number[][]} */ consts)=>execute(
        asm(`vs_2_0\n${defs(consts)}\n${body}\n`), {}).outputs.oPos;
    assert.deepEqual(vs('lit oPos, c0', [[0.5, 0.25, 9, 2]]), [1, 0.5, 0.0625, 1]);
    assert.deepEqual(vs('lit oPos, c0', [[-1, 0.25, 9, 2]]), [1, 0, 0, 1]);
    assert.deepEqual(vs('lit oPos, c0', [[0.5, -0.25, 9, 2]]), [1, 0.5, 0, 1]);
    assert.deepEqual(vs('lit oPos, c0', [[0.5, 0.5, 9, 0]]), [1, 0.5, 1, 1]);
    assert.deepEqual(vs('lit oPos.yz, c0', [[0.5, 0.5, 9, 3]]), [NaN, 0.5, 0.125, NaN]);
    assert.deepEqual(vs('lit oPos, c0', [[1, 0.5, 9, 1000]])[2], f32(Math.pow(0.5, 127.9961)));
    assert.deepEqual(vs('dst oPos, c0, c1', [[9, 2, 3, 9], [9, 5, 9, 7]]), [1, 10, 3, 7]);
    assert.deepEqual(vs('sgn oPos, c0, r0, r1', [[-3, 0, 2, -0.5]]), [-1, 0, 1, -1]);
    assert.deepEqual(vs('sgn oPos, c0', [[-3, 0, 2, -0.5]]), [-1, 0, 1, -1]);
    assert.deepEqual(vs('abs oPos, c0', [[-3, 0, 2, -0.5]]), [3, 0, 2, 0.5]);
});

test('matrix instructions take their rows from consecutive registers', ()=>{
    const rows = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]];
    const v = [1, 1, 2, 1];
    const run = (/** @type {string} */ instruction)=>go(
        `vs_2_0\n${defs([v, ...rows])}\n${instruction}\n`, {}).outputs.oPos;
    assert.deepEqual(run('m4x4 oPos, c0, c1'), [1 + 2 + 6 + 4, 5 + 6 + 14 + 8, 9 + 10 + 22 + 12,
        13 + 14 + 30 + 16]);
    assert.deepEqual(run('m4x3 oPos.xyz, c0, c1'), [13, 33, 53, NaN]);
    assert.deepEqual(run('m3x4 oPos, c0, c1'), [9, 25, 41, 57]);
    assert.deepEqual(run('m3x3 oPos.xyz, c0, c1'), [9, 25, 41, NaN]);
    assert.deepEqual(run('m3x2 oPos.xy, c0, c1'), [9, 25, NaN, NaN]);
    assert.deepEqual(run('m4x4 oPos.y, c0, c1'), [NaN, 33, NaN, NaN]);
    // c0.wzyx is (1, 2, 1, 1).
    assert.deepEqual(run('m4x4 oPos, c0.wzyx, c1'), [12, 32, 52, 72]);
    const psm = go(`ps_2_0\n${defs([v, ...rows])}\nm4x4 oC0, c0, c1\n`, {});
    assert.deepEqual(psm.outputs.oC0, [13, 33, 53, 73]);
    // The rows are read at the matrix register plus the row number, so a relative
    // address moves the whole matrix: a0 is 1, and the rows are c1 to c3.
    const rel = go(`vs_2_0\n${defs([v, ...rows])}\nmova a0.x, c0.x\n`
        + 'm4x3 oPos.xyz, c0, c[a0.x]\n', {});
    assert.deepEqual(rel.outputs.oPos, [13, 33, 53, NaN]);
});

test('source modifiers: negate everywhere, absolute value where the model has it', ()=>{
    assert.deepEqual(runPs('mov oC0, -c0', [[1, -2, 0, -0]]), [-1, 2, -0, 0]);
    assert.deepEqual(runPs('mov oC0, |c0|', [[-1, 2, -3, -0]], 'ps_3_0'), [1, 2, 3, 0]);
    assert.deepEqual(runPs('mov oC0, -|c0|', [[-1, 2, -3, 0]], 'ps_3_0'), [-1, -2, -3, -0]);
    assert.deepEqual(runPs('mov oC0, -|c0.wzyx|', [[-1, 2, -3, 4]], 'ps_3_0'), [-4, -3, -2, -1]);
    assert.deepEqual(runPs('add oC0, |c0|, -|c1|', [[-1, 2, -3, 4], [1, 1, -1, -1]], 'ps_3_0'),
        [0, 1, 2, 3]);
    const vs = go('vs_2_0\ndef c0, -1, 2, -3, 4\nmov oPos, -|c0.yx|\n', {});
    assert.deepEqual(vs.outputs.oPos, [-2, -1, -1, -1]);
    rejects(()=>asm('ps_2_0\ndef c0, 1, 1, 1, 1\nmov oC0, |c0|\n'),
        /modifier 11 is not available in ps_2_0/);
    rejects(()=>asm('vs_1_1\nmov oPos, |c0|\n'), /modifier 11 is not available in vs_1_1/);
});

test('saturate clamps to [0, 1] and turns NaN into 0', ()=>{
    assert.deepEqual(runPs('mov_sat oC0, c0', [[-5, 0, 1, 7]]), [0, 0, 1, 1]);
    assert.deepEqual(runPs('mov_sat oC0, c0', [[NaN, -0, 0.25, Infinity]]), [0, 0, 0.25, 1]);
    assert.deepEqual(runPs('mad_sat oC0.xyz, -c0.xyzw, c1.x, c2', [
        [1, 2, 3, 4], [0.25, 0, 0, 0], [0.5, 0.75, 1.5, 0]]), [0.25, 0.25, 0.75, NaN]);
    assert.deepEqual(runPs('rcp_sat oC0, c0.x', [[0.5]]), [1, 1, 1, 1]);
    assert.deepEqual(runPs('mov_sat_pp oC0, c0', [[2, 2, 2, 2]]), [1, 1, 1, 1]);
    rejects(()=>asm('vs_2_0\ndef c0, 1, 1, 1, 1\nmov_sat oPos, c0\n'),
        /_sat is not valid in a vertex shader/);
});

test('vertex shader 1.1: mov to a0 floors, relative addressing is implied a0.x', ()=>{
    const f = Float32Array.from([
        1, 1, 1, 1, 10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30, 40, 40, 40, 40]);
    const run = (/** @type {number} */ x, read = 'c[a0.x + 1]')=>go(
        `vs_1_1\nmov a0.x, v0.x\nmov oPos, ${read}\n`,
        { constants: { f }, inputs: { v: [[x, 0, 0, 0]] } }).outputs;
    assert.deepEqual(run(2.9).oPos, [30, 30, 30, 30]);
    assert.deepEqual(run(2.9, 'c[a0.x]').oPos, [20, 20, 20, 20]);
    assert.deepEqual(run(0).oPos, [10, 10, 10, 10]);
    assert.deepEqual(run(3).oPos, [40, 40, 40, 40]);
    // Floor, not truncation: -0.5 is -1, which reaches c0 through c[a0.x + 1].
    assert.deepEqual(run(-0.5).oPos, [1, 1, 1, 1]);
    rejects(()=>run(5), /read of unsupplied constant c6.x/);
    rejects(()=>run(300), /constant address c301 is outside the register file/);
    rejects(()=>asm('vs_2_0\nmov a0.x, c0\n'), /mov to a0 is not valid in vs_2_0; use mova/);
});

test('mova rounds to nearest, relative addressing with a0 and aL', ()=>{
    const f = new Float32Array(32);
    for (let i = 0; i < 8; i++)
    {
        f.fill(i * 10, i * 4, i * 4 + 4);
    }
    const run = (/** @type {number} */ x, /** @type {string} */ read = 'c[a0.x + 2]')=>execute(
        asm(`vs_2_0\ndcl_position v0\nmova a0.x, v0.x\nmov oPos, ${read}\n`),
        { constants: { f }, inputs: { v: [[x, 0, 0, 0]] } }).outputs.oPos[0];
    assert.equal(run(1.4), 30);
    assert.equal(run(1.6), 40);
    assert.equal(run(2.5), 50);
    assert.equal(run(-0.4), 20);
    assert.equal(run(-1.5), 10);
    assert.equal(run(0, 'c[a0.x]'), 0);
    assert.equal(run(3, 'c[a0.x + 0]'), 30);
    assert.equal(run(1, '-c[a0.x + 2].w'), -30);
    rejects(()=>run(-3), /outside the register file/);
    // From vs_2_0 the address register has four components, each addressing on its own:
    // fxc moves a whole vector into it (mova a0, r0.yxzw) and reads c[a0.y].
    const four = execute(asm('vs_2_0\ndcl_position v0\nmova a0, v0.yxzw\n'
        + 'mov oPos.x, c[a0.y + 1].x\nmov oPos.y, c[a0.x].x\nmov oPos.zw, c[a0.w].x\n'),
    { constants: { f }, inputs: { v: [[3, 1, 0, 2]] } }).outputs.oPos;
    assert.deepEqual([...four], [40, 10, 20, 20]);
    rejects(()=>asm('vs_1_1\nmov a0.y, c0\n'), /address register is written as a0.x/);
    rejects(()=>go('vs_2_0\nmov oPos, c[a0.x]\n', { constants: { f } }),
        /read of unwritten a0/);
});

test('loop, rep, break and aL', ()=>{
    const f = Float32Array.from({ length: 64 }, (_, i)=>i + 1);
    const io = { constants: { f } };
    const loop = go('vs_2_0\ndefi i0, 3, 1, 2, 0\nmov r0, c0\n'
        + 'loop aL, i0\nadd r0, r0, c[aL + 4]\nendloop\nmov oPos, r0\n', io);
    // c0 + c5 + c7 + c9 (aL = 1, 3, 5): (1, 2, 3, 4) + 4 * ... register k holds 4k+1..4k+4.
    assert.deepEqual(loop.outputs.oPos, [1 + 21 + 29 + 37, 2 + 22 + 30 + 38, 3 + 23 + 31 + 39,
        4 + 24 + 32 + 40]);
    const rep = go('vs_2_0\ndefi i0, 5, 0, 0, 0\nmov r0, c0\n'
        + 'rep i0\nadd r0, r0, c1\nendrep\nmov oPos, r0\n', io);
    assert.deepEqual(rep.outputs.oPos, [1 + 25, 2 + 30, 3 + 35, 4 + 40]);
    const none = go('vs_2_0\ndefi i0, 0, 0, 0, 0\nmov r0, c0\n'
        + 'rep i0\nadd r0, r0, c1\nendrep\nmov oPos, r0\n', io);
    assert.deepEqual(none.outputs.oPos, [1, 2, 3, 4]);
    const nested = go('vs_2_0\ndefi i0, 2, 0, 1, 0\ndefi i1, 3, 0, 0, 0\nmov r0, c0.x\n'
        + 'loop aL, i0\nrep i1\nadd r0.x, r0.x, c[aL + 1].x\nendrep\nendloop\nmov oPos, r0.x\n',
    io);
    // aL = 0, 1: three additions each of c1.x = 5 and of c2.x = 9.
    assert.deepEqual(nested.outputs.oPos, Array(4).fill(1 + 3 * 5 + 3 * 9));
    const supplied = go('vs_2_0\nmov r0, c0\nloop aL, i0\nadd r0, r0, c1\nendloop\n'
        + 'mov oPos, r0\n', { constants: { f, i: [4, 0, 1, 0] } });
    assert.deepEqual(supplied.outputs.oPos, [1 + 20, 2 + 24, 3 + 28, 4 + 32]);
    const brk = go('vs_2_x\ndefi i0, 10, 0, 1, 0\nmov r0, c0\nloop aL, i0\n'
        + 'break_ge r0.x, c3.x\nadd r0, r0, c1\nendloop\nmov oPos, r0\n', io);
    // c3.x is 13: r0.x goes 1, 6, 11, 16 and the fourth test leaves.
    assert.deepEqual(brk.outputs.oPos, [1 + 15, 2 + 18, 3 + 21, 4 + 24]);
    const plainBreak = go('vs_2_x\ndefi i0, 10, 0, 1, 0\nmov r0, c0\nrep i0\n'
        + 'add r0, r0, c1\nbreak\nadd r0, r0, c1\nendrep\nmov oPos, r0\n', io);
    assert.deepEqual(plainBreak.outputs.oPos, [1 + 5, 2 + 6, 3 + 7, 4 + 8]);
    // break leaves only the innermost loop.
    const inner = go('vs_2_x\ndefi i0, 3, 0, 1, 0\nmov r0, c0\nrep i0\nrep i0\n'
        + 'add r0.x, r0.x, c1.x\nbreak\nendrep\nadd r0.y, r0.y, c1.y\nendrep\nmov oPos, r0\n', io);
    assert.deepEqual(inner.outputs.oPos, [1 + 15, 2 + 18, 3, 4]);
    // break_cc inside an if inside the loop.
    const viaIf = go('vs_3_0\ndcl_position o0\ndefi i0, 10, 0, 1, 0\ndefb b0, true\n'
        + 'mov r0, c0\nloop aL, i0\nif b0\nbreak_gt r0.x, c2.x\nendif\nadd r0, r0, c1\nendloop\n'
        + 'mov o0, r0\n', io);
    assert.deepEqual(viaIf.outputs.o0, [1 + 5 * 2, 2 + 6 * 2, 3 + 7 * 2, 4 + 8 * 2]);
    // mov, loop, two full passes of if, break_gt, endif, add, then if and break_gt, mov.
    assert.equal(viaIf.instructionsExecuted, 1 + 1 + 5 + 5 + 2 + 1);
});

test('if, else, if_cc and nesting', ()=>{
    const run = (/** @type {string} */ body, /** @type {boolean[]} */ b,
        /** @type {number[]} */ f)=>
        go(`ps_3_0\ndcl_texcoord0 v0\n${body}\n`,
            { constants: { b, f: Float32Array.from(f) }, inputs: { v: [[0, 0, 0,
                0]] } }).outputs.oC0;
    const body = 'mov r0, c0\nif b0\nmov r0, c1\nelse\nmov r0, c2\nendif\nmov oC0, r0';
    const f = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3];
    assert.deepEqual(run(body, [true], f), [2, 2, 2, 2]);
    assert.deepEqual(run(body, [false], f), [3, 3, 3, 3]);
    const noElse = 'mov r0, c0\nif b0\nmov r0, c1\nendif\nmov oC0, r0';
    assert.deepEqual(run(noElse, [true], f), [2, 2, 2, 2]);
    assert.deepEqual(run(noElse, [false], f), [1, 1, 1, 1]);
    const nested = 'mov r0, c0\nif b0\nif b1\nmov r0, c1\nelse\nmov r0, c2\nendif\nelse\n'
        + 'mov r0.x, c2.x\nendif\nmov oC0, r0';
    assert.deepEqual(run(nested, [true, true], f), [2, 2, 2, 2]);
    assert.deepEqual(run(nested, [true, false], f), [3, 3, 3, 3]);
    assert.deepEqual(run(nested, [false, true], f), [3, 1, 1, 1]);
    for (const [cmp, a, b, want] of /** @type {[string, number, number, boolean][]} */ ([
        ['gt', 2, 1, true], ['gt', 1, 1, false], ['ge', 1, 1, true], ['ge', 0, 1, false],
        ['lt', 0, 1, true], ['lt', 1, 1, false], ['le', 1, 1, true], ['le', 2, 1, false],
        ['eq', 1, 1, true], ['eq', 1, 2, false], ['ne', 1, 2, true], ['ne', 1, 1, false],
        ['ne', NaN, NaN, true], ['eq', NaN, NaN, false], ['lt', NaN, 1, false],
    ]))
    {
        const out = run(`mov r0, c0.yyyy\nif_${cmp} c0.x, c1.x\nmov r0, c0.zzzz\nendif\n`
            + `mov oC0, r0`,
        [], [a, 7, 9, 0, b, 0, 0, 0]);
        assert.equal(out[0], want ? 9 : 7, `${cmp} ${a} ${b}`);
    }
    const swizzled = run('mov r0, c0.yyyy\nif_lt c0.w, c1.z\nmov r0, c0.zzzz\nendif\nmov oC0, r0',
        [], [0, 7, 9, 1, 0, 0, 5, 0]);
    assert.equal(swizzled[0], 9);
});

test('call, callnz, label and ret', ()=>{
    const src = 'vs_2_x\ndef c0, 1, 2, 3, 4\ndefb b0, true\ndefb b1, false\nmov r0, c0\n'
        + 'call l0\ncallnz l1, b0\ncallnz l1, b1\nmov oPos, r0\nret\n'
        + 'label l0\nadd r0, r0, c0\nret\nlabel l1\nmul r0, r0, c0\nret\n';
    const r = go(src, {});
    assert.deepEqual(r.outputs.oPos, [2, 8, 18, 32]);
    const nestedCall = go('vs_2_x\ndef c0, 1, 2, 3, 4\nmov r0, c0\ncall l0\n'
        + 'mov oPos, r0\nret\nlabel l0\ncall l1\nadd r0, r0, c0\nret\nlabel l1\nmul r0, r0, r0\n'
            + 'ret\n', {});
    assert.deepEqual(nestedCall.outputs.oPos, [2, 6, 12, 20]);
    const looped = go('vs_2_x\ndefi i0, 3, 0, 1, 0\ndef c0, 1, 2, 3, 4\nmov r0, c0\n'
        + 'rep i0\ncall l0\nendrep\nmov oPos, r0\nret\nlabel l0\nadd r0, r0, c0\nret\n', {});
    assert.deepEqual(looped.outputs.oPos, [4, 8, 12, 16]);
    rejects(()=>go('vs_2_x\ncall l0\nret\nlabel l0\ncall l0\nret\n', {}), /call nesting/);
});

test('runaway shaders are stopped', ()=>{
    const src = 'vs_2_x\ndefi i0, 255, 0, 1, 0\nrep i0\nrep i0\nrep i0\nrep i0\nnop\n'
        + 'endrep\nendrep\nendrep\nendrep\n';
    rejects(()=>go(src, {}), /runaway shader/);
    const counted = go('vs_2_0\ndef c0, 1, 2, 3, 4\nmov r0, c0\nadd r0, r0, c0\n'
        + 'mov oPos, r0\n', {});
    assert.equal(counted.instructionsExecuted, 3);
});

test('inputs, the pixel position and the face register', ()=>{
    const vs = go('vs_2_0\ndcl_position v0\ndcl_color1 v3\nmov oPos, v0\nmov oD0, v3.zyxw\n',
        { inputs: { v: [[1, 2, 3, 4], [], [], [5, 6, 7, 8]] } });
    assert.deepEqual(vs.outputs.oPos, [1, 2, 3, 4]);
    assert.deepEqual(vs.outputs.oD0, [7, 6, 5, 8]);
    assert.equal(vs.written.oD0, 15);
    const p2 = go('ps_2_0\ndcl t0.xy\ndcl t2\ndcl v1\nmov r0, t0.yx\nmov r1, t2\n'
        + 'mad r0, v1, r1, r0\nmov oC0, r0\n',
    { inputs: { t: [[1, 2], [], [1, 2, 3, 4]], v: [[], [2, 2, 2, 2]] } });
    assert.deepEqual(p2.outputs.oC0, [2 * 1 + 2, 2 * 2 + 1, 2 * 3 + 1, 2 * 4 + 1]);
    const p3 = go('ps_3_0\ndcl vPos.xy\ndcl vFace\nmov oC0.xy, vPos\nmov oC0.zw, vFace.x\n',
        { position: [10.5, 20.5], frontFacing: true });
    assert.deepEqual(p3.outputs.oC0, [10.5, 20.5, 1, 1]);
    const back = go('ps_3_0\ndcl vFace\nmov oC0, vFace\n', { frontFacing: false });
    assert.deepEqual(back.outputs.oC0, [-1, -1, -1, -1]);
    const sel = go('ps_3_0\ndcl vFace\ndef c0, 1, 0, 0, 1\ndef c1, 0, 1, 0, 1\n'
        + 'cmp oC0, vFace, c0, c1\n', { frontFacing: false });
    assert.deepEqual(sel.outputs.oC0, [0, 1, 0, 1]);
    rejects(()=>go('ps_3_0\ndcl vPos.xy\nmov oC0, vPos\n', { position: [1, 2] }),
        /read of vPos.z, outside its declaration at instruction 0: mov oC0, vPos/);
    rejects(()=>go('ps_3_0\ndcl vPos\nmov oC0, vPos\n', { position: [1, 2] }),
        /read of undefined vPos.z at instruction 0: mov oC0, vPos/);
    rejects(()=>go('ps_3_0\ndcl vPos.xy\nmov oC0.xy, vPos\n', {}),
        /read of undefined vPos.x/);
    rejects(()=>go('ps_3_0\ndcl vFace\nmov oC0, vFace\n', {}), /vFace was not supplied/);
});

test('shader model 3.0 declarations, semantics and relative input addressing', ()=>{
    const vs = go('vs_3_0\ndcl_position v0\ndcl_texcoord1 v1\ndcl_position o0\n'
        + 'dcl_texcoord1 o3.xy\ndcl_color o5\nmov o0, v0\nmov o3.xy, v1\nmov o5, c0.x\n'
            + 'def c0, 1, 2, 3, 4\n',
    { inputs: { v: [[1, 2, 3, 4], [5, 6, 7, 8]] } });
    assert.deepEqual(vs.outputs.o0, [1, 2, 3, 4]);
    assert.deepEqual(vs.outputs.o3, [5, 6, NaN, NaN]);
    assert.deepEqual(vs.outputs.o5, [1, 1, 1, 1]);
    assert.deepEqual(vs.written, { o0: 15, o3: 3, o5: 15 });
    assert.deepEqual(vs.semantics, {
        v0: { usage: 'position', index: 0 }, v1: { usage: 'texcoord', index: 1 },
        o0: { usage: 'position', index: 0 }, o3: { usage: 'texcoord', index: 1 },
        o5: { usage: 'color', index: 0 },
    });
    const declaredOnly = go('vs_3_0\ndcl_position v0\ndcl_position o0\ndcl_fog o4.x\nmov o0, v0\n',
        { inputs: { v: [[1, 2, 3, 4]] } });
    assert.deepEqual(declaredOnly.outputs.o4, NaN4);
    assert.equal(declaredOnly.written.o4, 0);
    const ps = go('ps_3_0\ndcl_texcoord0 v0\ndcl_texcoord1 v1\ndcl_color0_centroid v2\n'
        + 'defi i0, 3, 0, 1, 0\nmov r0, c9\nloop aL, i0\nadd r0, r0, v[aL]\nendloop\nmov oC0, r0\n'
            + 'def c9, 0, 0, 0, 0\n',
    { inputs: { v: [[1, 2, 3, 4], [10, 20, 30, 40], [100, 200, 300, 400]] } });
    assert.deepEqual(ps.outputs.oC0, [111, 222, 333, 444]);
    const shifted = go('ps_3_0\ndcl_texcoord0 v0\ndcl_texcoord1 v1\ndefi i0, 1, 0, 1, 0\n'
        + 'loop aL, i0\nmov oC0, v[aL + 1]\nendloop\n', { inputs: { v: [[1, 2, 3, 4], [10, 20, 30,
        40]] } });
    assert.deepEqual(shifted.outputs.oC0, [10, 20, 30, 40]);
    rejects(()=>go('ps_3_0\ndcl_texcoord0 v0\ndefi i0, 1, 0, 2, 0\n'
        + 'loop aL, i0\nmov oC0, v[aL + 1]\nendloop\n', { inputs: { v: [[1, 2, 3, 4]] } }),
    /read of undeclared v1/);
    rejects(()=>go('ps_3_0\ndcl_texcoord0 v0.xy\nmov oC0, v0\n', { inputs: { v: [[1, 2, 3,
        4]] } }),
    /read of v0.z, outside its declaration/);
});

test('texture sampling goes through io.sample', ()=>{
    /** @type {{ sampler: number, dimension: string, coord: number[], mode: object }[]} */
    const calls = [];
    /** @type {NonNullable<MachineIO['sample']>} */
    const sample = (sampler, dimension, coord, mode)=>{
        calls.push({ sampler, dimension, coord, mode });
        return [0.1, 0.2, 0.3, 0.4].map(f32);
    };
    const hdr = 'ps_3_0\ndcl_texcoord0 v0\ndcl_2d s0\ndcl_cube s1\ndcl_volume s2\n';
    const io = { sample, inputs: { v: [[0.25, 0.5, 0.75, 2]] } };
    const run = (/** @type {string} */ body, extra = {})=>{
        calls.length = 0;
        return go(`${hdr}${body}\n`, { ...io, ...extra }).outputs.oC0;
    };
    assert.deepEqual(run('texld oC0, v0, s0'), [0.1, 0.2, 0.3, 0.4].map(f32));
    assert.deepEqual(calls, [{ sampler: 0, dimension: '2d', coord: [0.25, 0.5, 0, 0],
        mode: { kind: 'plain' } }]);
    run('texld oC0, v0, s1');
    assert.deepEqual(calls[0], { sampler: 1, dimension: 'cube', coord: [0.25, 0.5, 0.75, 0],
        mode: { kind: 'plain' } });
    run('texld oC0, v0, s2');
    assert.equal(calls[0].dimension, 'volume');
    assert.deepEqual(calls[0].coord, [0.25, 0.5, 0.75, 0]);
    run('texldp oC0, v0, s0');
    assert.deepEqual(calls[0], { sampler: 0, dimension: '2d', coord: [0.125, 0.25, 0, 2],
        mode: { kind: 'plain' } });
    run('texldp oC0, v0, s1');
    assert.deepEqual(calls[0].coord, [0.125, 0.25, 0.375, 2]);
    run('texldb oC0, v0, s0');
    assert.deepEqual(calls[0], {
        sampler: 0, dimension: '2d', coord: [0.25, 0.5, 0, 2], mode: { kind: 'bias', value: 2 } });
    run('texldl oC0, v0, s0');
    assert.deepEqual(calls[0].mode, { kind: 'lod', value: 2 });
    run('def c0, 1, 2, 3, 4\ndef c1, 5, 6, 7, 8\ntexldd oC0, v0, s0, c0, c1');
    assert.deepEqual(calls[0].mode, { kind: 'grad', ddx: [1, 2, 0, 0], ddy: [5, 6, 0, 0] });
    run('def c0, 1, 2, 3, 4\ndef c1, 5, 6, 7, 8\ntexldd oC0, v0, s2, c0, c1');
    assert.deepEqual(calls[0].mode, { kind: 'grad', ddx: [1, 2, 3, 0], ddy: [5, 6, 7, 0] });
    assert.deepEqual(run('texld oC0.xz, v0.yxzw, s0'), [0.1, NaN, 0.3, NaN].map(f32));
    assert.deepEqual(calls[0].coord, [0.5, 0.25, 0, 0]);
    assert.deepEqual(run('texld oC0.w, v0, s0').slice(3), [f32(0.4)]);
    run('texld_pp oC0, -v0, s0');
    assert.deepEqual(calls[0].coord, [-0.25, -0.5, 0, 0]);
    assert.deepEqual(run('texld_sat oC0, v0, s0'), [0.1, 0.2, 0.3, 0.4].map(f32));
    // The sampler's declared type decides which coordinate components are read.
    const r = go('ps_2_0\ndcl t0.xy\ndcl_2d s0\ntexld r0, t0, s0\nmov oC0, r0\n',
        { sample, inputs: { t: [[0.5, 0.25]] } });
    assert.deepEqual(r.outputs.oC0, [0.1, 0.2, 0.3, 0.4].map(f32));
    rejects(()=>go('ps_2_0\ndcl t0.xy\ndcl_cube s0\ntexld r0, t0, s0\nmov oC0, r0\n',
        { sample, inputs: { t: [[0.5, 0.25]] } }), /read of t0.z, outside its declaration/);
    rejects(()=>go('ps_2_0\ndcl t0.xy\ndcl_2d s0\ntexldp r0, t0, s0\nmov oC0, r0\n',
        { sample, inputs: { t: [[0.5, 0.25]] } }), /read of t0.w, outside its declaration/);
    rejects(()=>run('texld oC0, v0, s0', { sample: undefined }), /texld needs io.sample/);
    rejects(()=>run('texld oC0, v0, s0', { sample: ()=>[1] }), /four components/);
    const vs = go('vs_3_0\ndcl_position o0\ndcl_2d s0\ndef c0, 0.5, 0.5, 0, 3\ntexldl r0, c0, s0\n'
        + 'mov o0, r0\n',
    { sample });
    assert.deepEqual(vs.outputs.o0, [0.1, 0.2, 0.3, 0.4].map(f32));
    assert.deepEqual(calls[0].mode, { kind: 'lod', value: 3 });
});

test('texkill and derivatives', ()=>{
    const hdr = 'ps_2_0\ndcl t0\ndef c0, 1, 1, 1, 1\n';
    const kill = (/** @type {number[]} */ t, body = 'texkill t0')=>execute(
        asm(`${hdr}${body}\nmov oC0, c0\n`), { inputs: { t: [t] } });
    assert.equal(kill([1, 1, 1, 1]).killed, false);
    assert.equal(kill([-1, 1, 1, 1]).killed, true);
    assert.equal(kill([1, -1, 1, 1]).killed, true);
    assert.equal(kill([1, 1, -0.5, 1]).killed, true);
    assert.equal(kill([1, 1, 1, -1]).killed, false);
    assert.equal(kill([0, -0, 0, 0]).killed, false);
    assert.deepEqual(kill([-1, 1, 1, 1]).outputs.oC0, [1, 1, 1, 1]);
    assert.equal(go('ps_2_0\ndef c0, 1, 1, -1, 1\nmov r0, c0\ntexkill r0\nmov oC0, c0\n',
        {}).killed, true);
    assert.equal(go('ps_2_0\ndef c0, 1, 1, 1, -1\nmov r0, c0\ntexkill r0\nmov oC0, c0\n',
        {}).killed, false);
    rejects(()=>go('ps_2_0\nmov r0.xy, c0\ntexkill r0\n', { constants: { f: [1, 2, 3,
        4] } }),
    /read of unwritten r0.z at instruction 1: texkill r0/);
    /** @type {[string, number[]][]} */
    const seen = [];
    const derivative = (/** @type {'x'|'y'} */ axis, /** @type {number[]} */ value)=>{
        seen.push([axis, value]);
        return value.map(x=>axis === 'x' ? x * 2 : -x);
    };
    const d = go('ps_3_0\ndef c0, 1, 2, 3, 4\ndsx r0, c0\ndsy r1.yz, -c0\nadd oC0.yz, r0, r1\n',
        { derivative });
    assert.deepEqual(seen, [['x', [1, 2, 3, 4]], ['y', [0, -2, -3, 0]]]);
    assert.deepEqual(d.outputs.oC0, [NaN, 4 + 2, 6 + 3, NaN]);
    const d2 = go('ps_3_0\ndef c0, 1, 2, 3, 4\ndsx r0, c0\ndsy r1, c0.wzyx\nadd oC0, r0, r1\n',
        { derivative });
    assert.deepEqual(d2.outputs.oC0, [2 - 4, 4 - 3, 6 - 2, 8 - 1]);
    rejects(()=>go('ps_3_0\ndef c0, 1, 2, 3, 4\ndsx oC0, c0\n', {}),
        /dsx needs io.derivative/);
});

test('strictness: reading what was never written throws, naming register and instruction', ()=>{
    rejects(()=>go('ps_2_0\ndef c1, 1, 1, 1, 1\nmul r0, r3, c1\nmov oC0, r0\n', {}),
        /^read of unwritten r3\.x at instruction 0: mul r0, r3, c1$/);
    rejects(()=>go('ps_2_0\ndef c1, 1, 1, 1, 1\nmov r3.xzw, c1\nmul r0, r3, c1\nmov oC0, r0\n', {}),
        /^read of unwritten r3\.y at instruction 1: mul r0, r3, c1$/);
    // Only the components the instruction reads count.
    const ok = go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r3.y, c1\nmov r0.x, r3.y\nmov oC0.x, r0.x\n',
        {});
    assert.deepEqual(ok.outputs.oC0, [2, NaN, NaN, NaN]);
    const swz = go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r3.yz, c1\nmov r0.xy, r3.zy\nmov oC0.xy, r0\n',
        {});
    assert.deepEqual(swz.outputs.oC0.slice(0, 2), [3, 2]);
    rejects(()=>go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r3.yz, c1\nmov r0.xy, r3.zx\n', {}),
        /read of unwritten r3\.x at instruction 1: mov r0.xy, r3.zx/);
    rejects(()=>go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r3.xy, c1\nmov r0, r3.xyz\n', {}),
        /read of unwritten r3\.z at instruction 1: mov r0, r3.xyz/);
    go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r3.xy, c1\nmov r0, r3.xy\nmov oC0, r0\n', {});
    // dp3 reads xyz, dp4 xyzw, dp2add xy and src2.x.
    const dpHeader = 'ps_2_0\ndef c1, 1, 2, 3, 4\nmov r1.xyz, c1\n';
    go(`${dpHeader}dp3 r0, r1, r1\nmov oC0, r0\n`, {});
    rejects(()=>go(`${dpHeader}dp4 r0, r1, r1\n`, {}),
        /read of unwritten r1\.w at instruction 1: dp4 r0, r1, r1/);
    go(`${dpHeader}dp2add r0, r1, r1, r1\nmov oC0, r0\n`, {});
    rejects(()=>go(`${dpHeader}dp2add r0, r1, r1, r1.w\n`, {}),
        /read of unwritten r1\.w/);
    // Scalar instructions read the one component their swizzle names.
    go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r1.z, c1\nrcp r0, r1.z\nmov oC0, r0\n', {});
    rejects(()=>go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r1.z, c1\nrcp r0, r1.y\n', {}),
        /read of unwritten r1\.y at instruction 1: rcp r0, r1.y/);
    rejects(()=>go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r1.z, c1\nsincos r0.y, r1.x, c2, c3\n', {}),
        /read of unwritten r1\.x/);
    rejects(()=>go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r1.xy, c1\nnrm r0.xyz, r1\n', {}),
        /read of unwritten r1\.z/);
    rejects(()=>go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r1.xy, c1\ncrs r0.x, r1, r1\n', {}),
        /read of unwritten r1\.z/);
    rejects(()=>go('ps_2_0\ndef c1, 1, 2, 3, 4\nmov r1.xy, c1\nmov r2, c1\n'
        + 'mad r0.z, r2, r2, r1.xxwx\n', {}),
    /read of unwritten r1\.w/);
    // A texture instruction reads the coordinate components its dimension needs.
    const sample = ()=>[0, 0, 0, 0];
    go('ps_2_0\ndcl_2d s0\ndef c1, 1, 2, 3, 4\nmov r1.xy, c1\ntexld r0, r1, s0\nmov oC0, r0\n',
        { sample });
    rejects(()=>go('ps_2_0\ndcl_2d s0\ndef c1, 1, 2, 3, 4\nmov r1.xy, c1\ntexldp r0, r1, s0\n',
        { sample }),
    /read of unwritten r1\.w at instruction 1: texldp r0, r1, s0/);
    rejects(()=>go('ps_2_0\ndcl_cube s0\ndef c1, 1, 2, 3, 4\nmov r1.xy, c1\ntexld r0, r1, s0\n',
        { sample }),
    /read of unwritten r1\.z/);
    rejects(()=>go('ps_2_0\ndcl_2d s0\ndef c1, 1, 2, 3, 4\nmov r1.xyz, c1\ntexldb r0, r1, s0\n',
        { sample }),
    /read of unwritten r1\.w/);
    // Registers an if or loop leaves unwritten are caught as well.
    rejects(()=>go('ps_3_0\ndef c1, 1, 2, 3, 4\nif b0\nmov r0, c1\nendif\nmov oC0, r0\n',
        { constants: { b: [false] } }), /read of unwritten r0\.x at instruction 3: mov oC0, r0/);
});

test('strictness: constants and inputs the caller did not supply throw, def and defi/defb fill in',
    ()=>{
        rejects(()=>go('ps_2_0\nmov oC0, c3\n', {}),
            /read of unsupplied constant c3\.x at instruction 0/);
        rejects(()=>go('ps_2_0\nmov oC0, c1\n', { constants: { f: [1, 2, 3, 4] } }),
            /read of unsupplied constant c1\.x/);
        rejects(()=>go('ps_2_0\nmov oC0, c0\n', { constants: { f: [1, 2, 3] } }),
            /read of unsupplied constant c0\.w/);
        const supplied = go('ps_2_0\nmov oC0, c1\n', { constants: { f: Float32Array.from([0,
            0, 0, 0, 5, 6, 7, 8]) } });
        assert.deepEqual(supplied.outputs.oC0, [5, 6, 7, 8]);
        const overridden = go('ps_2_0\ndef c1, 9, 9, 9, 9\nmov oC0, c1\n',
            { constants: { f: [0, 0, 0, 0, 5, 6, 7, 8] } });
        assert.deepEqual(overridden.outputs.oC0, [9, 9, 9, 9]);
        const rounded = go('ps_2_0\nmov oC0, c0\n', { constants: { f: [0.1, 0.2, 0.3,
            0.4] } });
        assert.deepEqual(rounded.outputs.oC0, [0.1, 0.2, 0.3, 0.4].map(f32));
        rejects(()=>go('ps_3_0\nrep i0\nnop\nendrep\n', {}),
            /unsupplied integer constant i0/);
        rejects(()=>go('ps_3_0\nif b2\nnop\nendif\n', { constants: { b: [true] } }),
            /unsupplied boolean constant b2/);
        rejects(()=>go('ps_3_0\ndcl_texcoord0 v0\nmov oC0, v0\n', {}),
            /input v0\.x was not supplied/);
        rejects(()=>go('ps_3_0\ndcl_texcoord0 v0\nmov oC0, v0\n', { inputs: { v: [[1, 2,
            3]] } }),
        /input v0\.w was not supplied/);
        rejects(()=>go('ps_2_0\ndcl t1\nmov oC0, t1\n', { inputs: { t: [[1, 2, 3, 4]] } }),
            /input t1\.x was not supplied/);
        rejects(()=>go('vs_2_0\ndcl_position v2\nmov oPos, v2\n', { inputs: { v: [[1, 2, 3,
            4]] } }),
        /input v2\.x was not supplied/);
        const defb = go('ps_3_0\ndefb b0, true\ndefi i0, 2, 0, 1, 0\ndef c0, 1, 1, 1, 1\n'
        + 'mov r0, c0\nrep i0\nadd r0, r0, c0\nendrep\nif b0\nadd r0, r0, c0\nendif\nmov oC0, r0\n',
        {});
        assert.deepEqual(defb.outputs.oC0, [4, 4, 4, 4]);
        const flags = go('ps_3_0\ndef c0, 1, 1, 1, 1\nif b3\nmov oC0, c0\nelse\nmov oC0, -c0\n'
            + 'endif\n',
        { constants: { b: [0, 0, 0, 1] } });
        assert.deepEqual(flags.outputs.oC0, [1, 1, 1, 1]);
    });

test('decode returns the program', ()=>{
    const tokens = asm('ps_2_x\ndcl t0.xy\ndcl_2d s3\ndef c4, 1, 0.5, -0, 1e-3\n'
        + 'defi i1, 1, -2, 3, 4\ndefb b2, true\n'
        + 'texld r0, t0, s3\nmov oC0, r0\n');
    const p = decode(tokens);
    assert.equal(p.kind, 'pixel');
    assert.equal(p.major, 2);
    assert.equal(p.minor, 1);
    assert.equal(p.constantTable, null);
    assert.deepEqual([...p.defs.f.get(4) ?? []], [1, 0.5, -0, f32(1e-3)]);
    assert.deepEqual(p.defs.i.get(1), [1, -2, 3, 4]);
    assert.equal(p.defs.b.get(2), true);
    assert.equal(p.samplers.get(3), '2d');
    assert.equal(p.declarations.length, 2);
    assert.equal(p.declarations[0].mask, 3);
    assert.equal(p.instructions.filter(i=>!i.decl).length, 2);
    const t2 = asm('vs_3_0\ndcl_position v0\ndcl_position o0\nmov o0, v0\n');
    const q = decode(t2);
    assert.equal(q.kind, 'vertex');
    assert.equal(q.version, 'vs_3_0');
    assert.deepEqual(q.declarations.map(d=>d.register), ['v0', 'o0']);
    // execute takes tokens as well as a decoded program.
    assert.deepEqual(execute(t2, { inputs: { v: [[1, 2, 3, 4]] } }).outputs.o0, [1, 2, 3, 4]);
    assert.deepEqual(execute(q, { inputs: { v: [[4, 3, 2, 1]] } }).outputs.o0, [4, 3, 2, 1]);
    assert.deepEqual(execute(q, { inputs: { v: [[5, 5, 5, 5]] } }).outputs.o0, [5, 5, 5, 5]);
});

test('comments are skipped and the constant table is kept', ()=>{
    const plain = asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0\n');
    const ctab = [0x42415443, 0x1c, 0x23, 0x12345678];
    const comment = [0xfffe | (ctab.length << 16), ...ctab];
    const other = [0xfffe | (2 << 16), 0x41424344, 0x45464748];
    const tokens = Uint32Array.from([plain[0], ...other, ...comment, ...plain.subarray(1)]);
    const p = decode(tokens);
    assert.ok(p.constantTable instanceof Uint8Array);
    assert.deepEqual([...p.constantTable ?? []].slice(0, 8), [0x43, 0x54, 0x41, 0x42, 0x1c, 0, 0,
        0]);
    assert.equal(p.constantTable?.length, 16);
    assert.equal(disassemble(tokens), disassemble(plain));
    assert.deepEqual(execute(tokens, {}).outputs.oC0, [1, 2, 3, 4]);
    rejects(()=>decode(Uint32Array.from([plain[0], 0xfffe | (9 << 16), 1, 0x0000ffff])),
        /comment .* runs past the end/);
});

test('decode rejects what the version does not have', ()=>{
    const bad = (/** @type {string} */ text, /** @type {RegExp} */ pattern)=>
        rejects(()=>assemble(text), pattern);
    bad('ps_2_0\nlit oC0, c0\n', /lit is not available in ps_2_0/);
    bad('ps_2_0\ndst oC0, c0, c1\n', /dst is not available in ps_2_0/);
    bad('vs_2_0\ncmp r0, c0, c1, c2\n', /cmp is not available in vs_2_0/);
    bad('vs_2_0\ndp2add r0, c0, c1, c2\n', /dp2add is not available in vs_2_0/);
    bad('vs_3_0\ndcl_2d s0\ndcl_position o0\ntexld r0, c0, s0\n',
        /texld is not available in vs_3_0/);
    bad('vs_2_0\ntexldl r0, c0, s0\n', /texldl is not available in vs_2_0/);
    bad('ps_2_0\ntexldl r0, c0, s0\n', /texldl is not available in ps_2_0/);
    bad('ps_2_x\ntexldl r0, c0, s0\n', /texldl is not available in ps_2_x/);
    bad('ps_2_0\ntexldd r0, c0, s0, c1, c2\n', /texldd is not available in ps_2_0/);
    bad('vs_3_0\ntexldd r0, c0, s0, c1, c2\n', /texldd is not available/);
    bad('vs_1_1\nlrp r0, c0, c1, c2\n', /lrp is not available in vs_1_1/);
    bad('vs_1_1\nabs r0, c0\n', /abs is not available in vs_1_1/);
    bad('vs_1_1\nsincos r0, c0\n', /sincos is not available in vs_1_1/);
    bad('vs_1_1\nif b0\nendif\n', /if is not available in vs_1_1/);
    asm('vs_1_1\ndcl_position v0\nmov oPos, v0\n');
    bad('vs_1_1\nmova a0.x, c0\n', /mova is not available in vs_1_1/);
    bad('vs_2_0\nmova a0.x, c0\nmov r0, c[a0.x]\nbreak\n', /break is not available in vs_2_0/);
    bad('vs_2_0\nifc b0, b1\n', /unknown instruction "ifc"/);
    bad('vs_2_0\nif_lt r0.x, r1.x\nendif\n', /ifc is not available in vs_2_0/);
    bad('ps_2_0\nif b0\nendif\n', /if is not available in ps_2_0/);
    bad('ps_2_0\nrep i0\nendrep\n', /rep is not available in ps_2_0/);
    bad('ps_2_0\ndsx r0, c0\n', /dsx is not available in ps_2_0/);
    bad('ps_2_0\nexpp r0, c0.x\n', /expp is not available in ps_2_0/);
    bad('ps_3_0\nmova a0.x, c0\n', /bad register "a0.x"/);
    bad('ps_2_0\nmov oC0, c0.x\nmov oPos, c0\n',
        /oPos does not exist in ps_2_0|unknown register|cannot be written/);
    bad('vs_2_0\nmov oC0, c0\n', /oC0 does not exist in vs_2_0/);
    bad('vs_2_0\nmov oDepth, c0\n', /oDepth does not exist in vs_2_0/);
    bad('vs_3_0\nmov oPos, c0\n', /does not exist in vs_3_0|bad register|cannot/);
    bad('vs_2_0\nmov r0, oPos\n', /cannot be a source/);
    bad('ps_2_0\nmov r0, oC0\n', /cannot be a source/);
    bad('ps_2_0\nmov r0, i0\n', /not available|beyond the 0 registers|cannot be a source/);
    bad('ps_2_0\nmov t0, c0\n', /cannot be written/);
    bad('vs_2_0\nmov a0, c0\n', /mov to a0 is not valid in vs_2_0; use mova/);
    bad('vs_1_1\nmov a0.xy, c0\n', /address register is written as a0.x only in vs_1_1/);
    bad('vs_2_0\nadd a0.x, c0, c1\n', /add cannot write the address register/);
    bad('vs_2_0\nsincos r0.z, c0.x, c1, c2\n', /sincos writes x \(cosine\) and y \(sine\) only/);
    bad('vs_2_0\nsincos r0.xy, c0.x\n', /truncated source 1 at token/);
    bad('vs_3_0\ndcl_position o0\nsincos o0.xy, c0.x, c1, c2\n',
        /sincos takes 1 sources in vs_3_0|length/);
    bad('vs_2_0\nrcp r0, c0\n', /rcp needs a replicate swizzle on source 0/);
    bad('vs_2_0\nrcp r0, c0.xy\n', /rcp needs a replicate swizzle/);
    bad('vs_2_0\npow r0, c0.x, c0\n', /pow needs a replicate swizzle on source 1/);
    bad('vs_2_x\nif_lt r0, c0.x\nendif\n', /ifc needs replicate swizzles/);
    bad('vs_2_0\nm4x3 r0.w, c0, c1\n', /m4x3 writes x, y and z only/);
    bad('vs_2_0\nm3x2 r0.z, c0, c1\n', /m3x2 writes x and y only/);
    bad('vs_2_0\nsgn r0, c0, c1\n', /truncated source 2 at token/);
    bad('vs_2_0\nsgn r0, c0, c1, c2\n', /sgn scratch operand 1 must be/);
    bad('ps_2_0\ntexld r0, c0, s0\n', /missing dcl for sampler s0/);
    bad('ps_2_0\ndcl_2d s0\ntexld r0, c0, r1\n', /r1 is not a sampler register/);
    bad('ps_2_0\ndcl_2d s0\ntexld r0, c0, s0.yx\n', /swizzle on sampler s0 is not supported/);
    bad('ps_2_0\nmov_x2 r0, c0\n', /unknown instruction/);
    bad('vs_2_0\nmov r0.x, c0\nmov oPos, r0\nsetp_lt p0, c0, c1\n',
        /unknown instruction|predicate|setp/);
    bad('vs_2_0\nmov p0, c0\n', /mov cannot write p0/);
    bad('vs_2_0\nmov r0, c0\nendif\n', /endif without if/);
    bad('vs_2_0\nif b0\nmov r0, c0\n', /if at token \d+ is never closed/);
    bad('vs_2_0\nif b0\nelse\nelse\nendif\n', /else without if/);
    bad('vs_2_0\nrep i0\nendloop\n', /endloop without loop/);
    bad('vs_2_0\nloop aL, i0\nendrep\n', /endrep without rep/);
    bad('vs_2_x\nbreak\n', /break outside a loop/);
    bad('vs_2_0\ncall l3\n', /call of undefined label l3/);
    bad('vs_2_0\nlabel l1\nlabel l1\n', /label l1 is defined twice/);
    bad('vs_2_0\nif b0\nlabel l0\nendif\n', /label inside control flow/);
    bad('ps_3_0\nmov oC0, c0\nloop aL, c0\nendloop\n', /c0 is not an integer constant/);
    bad('ps_3_0\nif c0\nendif\n', /c0 is not a boolean constant/);
    bad('ps_3_0\nloop r0, i0\nendloop\n', /r0 is not the loop counter/);
});

test('decode rejects registers beyond the version\'s files', ()=>{
    const ok = (/** @type {string} */ text)=>assemble(text);
    const bad = (/** @type {string} */ text,
        /** @type {RegExp} */ pattern)=>rejects(()=>assemble(text), pattern);
    const L = VERSION_LIMITS;
    assert.equal(L.vs_1_1.floatConsts, 256);
    assert.equal(L.ps_3_0.floatConsts, 224);
    ok('vs_1_1\nmov r11, c255\nmov oPos, r11\n');
    bad('vs_1_1\nmov r12, c0\n', /register r12 is beyond the 12 registers/);
    bad('vs_1_1\nmov r0, c256\n', /register c256 is beyond the 256 registers/);
    bad('vs_1_1\nmov r0, v16\n', /register v16 is beyond the 16/);
    bad('vs_1_1\nmov oT8, c0\n', /register oT8 is beyond the 8/);
    bad('vs_1_1\nmov oD2, c0\n', /register oD2 is beyond the 2/);
    ok('vs_2_0\nmov r11, c255\nmov oPos, r11\n');
    bad('vs_2_0\nmov r12, c0\n', /register r12 is beyond the 12/);
    bad('vs_2_x\nmov r12, c0\n', /register r12 is beyond the 12/);
    bad('vs_2_0\nmov r0, c256\n', /register c256 is beyond the 256/);
    bad('vs_2_0\nrep i16\nendrep\n', /register i16 is beyond the 16/);
    bad('vs_2_0\nif b16\nendif\n', /register b16 is beyond the 16/);
    bad('vs_2_0\ndefi i16, 1, 2, 3, 4\n', /defi of i16 is not a register of vs_2_0/);
    bad('vs_2_0\ndefb b16, true\n', /defb of b16/);
    bad('vs_2_0\ndef c256, 1, 2, 3, 4\n', /def of c256 is not a register of vs_2_0/);
    bad('vs_1_1\ndef c256, 1, 2, 3, 4\n', /def of c256/);
    ok('vs_3_0\ndcl_position o0\nmov r31, c255\nmov o0, r31\n');
    bad('vs_3_0\ndcl_position o0\nmov r32, c0\n', /register r32 is beyond the 32/);
    bad('vs_3_0\ndcl_position o12\n', /o12 is beyond its register file/);
    bad('vs_3_0\ndcl_position v16\n', /v16 is beyond its register file/);
    bad('vs_3_0\ndcl_2d s4\n', /sampler s4 is beyond the 4/);
    ok('ps_2_0\ndcl t7\nmov r11, c31\nmov oC0, r11\n');
    bad('ps_2_0\nmov r12, c0\n', /register r12 is beyond the 12/);
    bad('ps_2_0\nmov r0, c32\n', /register c32 is beyond the 32/);
    bad('ps_2_0\ndcl t8\n', /t8 is beyond its register file/);
    bad('ps_2_0\ndcl v2\n', /v2 is beyond its register file/);
    bad('ps_2_0\ndcl_2d s16\n', /sampler s16 is beyond the 16/);
    bad('ps_2_0\nmov oC4, c0\n', /register oC4 is beyond the 4/);
    ok('ps_2_x\nmov r31, c31\nmov oC0, r31\n');
    bad('ps_2_x\nmov r32, c0\n', /register r32 is beyond the 32/);
    bad('ps_2_x\nmov r0, c32\n', /register c32 is beyond the 32/);
    ok('ps_3_0\nmov r31, c223\nmov oC0, r31\n');
    bad('ps_3_0\nmov r0, c224\n', /register c224 is beyond the 224/);
    bad('ps_3_0\ndcl_texcoord10 v10\n', /v10 is beyond its register file/);
    ok('ps_3_0\ndcl_texcoord0 v9\nmov oC0, v9\nmov oDepth.x, v9.x\n');
    bad('ps_3_0\nmov oDepth, c0\nmov oDepth1, c0\n', /bad register|oDepth/);
    bad('ps_3_0\ndcl vPos\ndcl vFace\ndcl vPos\n', /vPos is declared twice/);
    bad('ps_3_0\nmov oC0, vFace\n', /missing dcl for vFace/);
    bad('ps_2_0\nmov oC0, t0\n', /missing dcl for t0/);
    bad('ps_2_0\nmov oC0, v1\n', /missing dcl for v1/);
    bad('vs_2_0\nmov oPos, v0\n', /missing dcl for v0/);
    bad('ps_3_0\nmov oC0, v0\n', /missing dcl for v0/);
    bad('vs_3_0\ndcl_position v0\nmov o0, v0\n', /missing dcl for o0/);
    bad('vs_3_0\ndcl_position v0\ndcl_position o0.xy\nmov o0, v0\n', /outside its declared mask/);
    bad('ps_3_0\ndcl_texcoord0 v0\ndcl_color0 v0\n', /v0 is declared twice/);
    bad('ps_2_0\ndcl_texcoord0 v0\n', /unknown instruction|takes no usage/);
    bad('ps_3_0\ndcl t0\n', /t0 cannot be declared in ps_3_0/);
    bad('vs_2_0\ndcl_position r0\n', /r0 cannot be declared in vs_2_0/);
    bad('vs_2_0\ndcl_position c0\n', /c0 cannot be declared/);
    bad('ps_3_0\nmov oC0, t0\n', /bad register|cannot be read/);
    bad('vs_2_0\nmov r0, c[a0.x + 256]\n', /beyond the 256/);
    bad('vs_2_0\nmov r0, v[a0.x]\n',
        /inputs are addressed relatively only through aL|only a0 can address constants/);
    bad('vs_2_0\nmov r0, r[aL]\n', /only c and v can be addressed relatively|bad/);
    bad('ps_2_x\nmov r0, c[aL]\n', /aL cannot address c0 in ps_2_x/);
    bad('vs_1_1\nmov r0, c[aL]\n', /addresses relatively through a0.x only/);
    bad('ps_3_0\nmov r0, c[a0.x]\n', /bad register|only a0 can address constants/);
});

test('decode rejects malformed token streams', ()=>{
    const good = asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0\n');
    assert.deepEqual([...good].slice(-1), [0xffff]);
    rejects(()=>decode(good.subarray(0, good.length - 1)), /missing END token/);
    rejects(()=>decode(Uint32Array.from([good[0]])), /shader too short/);
    rejects(()=>decode([]), /shader too short/);
    rejects(()=>decode(Uint32Array.from([good[0], 0xffff, 0xffff])), /tokens after END/);
    // Cut an instruction short: the length field promises more than the shader holds.
    for (let cut = 2; cut < good.length - 1; cut++)
    {
        if (cut === 7)
        {
            // Between the def and the mov: a shorter, complete shader.
            continue;
        }
        const truncated = Uint32Array.from([...good.subarray(0, cut), 0xffff]);
        rejects(()=>decode(truncated),
            /truncated|malformed|has a length field|is a parameter token|needs 4 literal|unknown opcode|not available|missing END/);
    }
    rejects(()=>decode(Uint32Array.from([0x12345678, 0xffff])), /not a shader version token/);
    rejects(()=>decode(Uint32Array.from([0xffff0100, 0xffff])),
        /unsupported shader version ps_1_0/);
    rejects(()=>decode(Uint32Array.from([0xffff0105, 0xffff])),
        /unsupported shader version ps_1_5/);
    rejects(()=>decode(Uint32Array.from([0xfffe0200 | 0xff, 0xffff])),
        /unsupported shader version vs_2_255/);
    rejects(()=>decode(Uint32Array.from([0xfffe0100, 0xffff])),
        /unsupported shader version vs_1_0/);
    rejects(()=>decode(Uint32Array.from([0xfffe0400, 0xffff])),
        /unsupported shader version vs_4_0/);
    const movToken = (/** @type {number} */ extra)=>Uint32Array.from([
        0xffff0200, (1 | (2 << 24) | extra) >>> 0, 0x800f0800, 0xa0e40000, 0xffff]);
    decode(movToken(0));
    // D3DSI_COISSUE is bit 30 and D3DSHADER_INSTRUCTION_PREDICATED bit 28.
    rejects(()=>decode(movToken(1 << 30)), /co-issued/);
    rejects(()=>decode(movToken(1 << 28)), /predication does not exist in ps_2_0/);
    rejects(()=>decode(movToken(1 << 16)), /unexpected control bits/);
    rejects(()=>decode(Uint32Array.from([0xffff0200, 0x00000063, 0xffff])), /unknown opcode 99/);
    rejects(()=>decode(Uint32Array.from([0xffff0200, 0xfffd, 0xffff])), /phase marker/);
    rejects(()=>decode(Uint32Array.from([0xffff0200, 0x800f0800, 0xffff])), /parameter token/);
    // A destination without the parameter marker bit.
    rejects(()=>decode(Uint32Array.from([0xffff0200, 1 | (2 << 24), 0x000f0800, 0xa0e40000,
        0xffff])),
    /malformed destination/);
    // The length field disagrees with the operands.
    rejects(()=>decode(Uint32Array.from([0xffff0200, 1 | (3 << 24), 0x800f0800, 0xa0e40000,
        0xa0e40000, 0xffff])),
    /length field of 3 but its operands take 2/);
    rejects(()=>decode(Uint32Array.from([0xffff0200, 1 | (1 << 24), 0x800f0800, 0xa0e40000,
        0xffff])),
    /truncated source 0|length field/);
    // Register types beyond the model.
    const typed = (/** @type {number} */ type)=>Uint32Array.from([
        0xfffe0200, 1 | (2 << 24), 0x800f0000,
        (0x80e40000 | ((type & 7) << 28) | ((type & 0x18) << 8)) >>> 0, 0xffff]);
    rejects(()=>decode(typed(11)), /constant register beyond c255/);
    rejects(()=>decode(typed(16)), /half-precision/);
    rejects(()=>decode(typed(19)), /predicate|p0/);
    rejects(()=>decode(typed(13)), /constant register beyond/);
    rejects(()=>decode(typed(20)), /cannot be a source/);
    // A relative destination.
    rejects(()=>decode(Uint32Array.from([0xfffe0200, 1 | (3 << 24), 0x800f0000 | (1 << 13),
        0xb0000000, 0x80e40000, 0xffff])),
    /relative addressing of a destination/);
    // Source modifiers other than the ones this machine implements.
    rejects(()=>decode(Uint32Array.from([0xfffe0200, 1 | (2 << 24), 0x800f0000,
        (0x80e40000 | (2 << 24)) >>> 0, 0xffff])),
    /source modifier 2 is not available/);
    rejects(()=>decode(Uint32Array.from([0xffff0200, 1 | (2 << 24), 0x800f0800,
        (0xa0e40000 | (13 << 24)) >>> 0, 0xffff])),
    /source modifier 13/);
    // Destination bits that do not exist.
    rejects(()=>decode(Uint32Array.from([0xffff0200, 1 | (2 << 24), 0x800f0800 | (8 << 20),
        0xa0e40000, 0xffff])),
    /reserved destination modifier/);
    rejects(()=>decode(Uint32Array.from([0xffff0200, 1 | (2 << 24), 0x80000800, 0xa0e40000,
        0xffff])),
    /empty write mask/);
    rejects(()=>decode(Uint32Array.from([0xffff0200, 1 | (2 << 24), 0x800f0800 | (1 << 24),
        0xa0e40000, 0xffff])),
    /destination shift scale/);
    // A dcl with a texture type that does not exist.
    rejects(()=>decode(Uint32Array.from([0xffff0200, 31 | (2 << 24), 0x80000000 | (5 << 27),
        0xa00f0802, 0xffff])),
    /texture type 5/);
    rejects(()=>decode(Uint32Array.from([0xffff0300, 31 | (2 << 24), 0x80000000 | 20, 0x900f0000,
        0xffff])),
    /unknown usage 20/);
});

test('decode enforces the nesting limits', ()=>{
    const deep = (/** @type {string} */ open, /** @type {string} */ end, /** @type {number} */ n)=>
        `vs_3_0\ndcl_position o0\n${open.repeat(n)}${end.repeat(n)}mov o0, c0\n`;
    assemble(deep('rep i0\n', 'endrep\n', MAX_LOOP_NESTING));
    rejects(()=>assemble(deep('rep i0\n', 'endrep\n', MAX_LOOP_NESTING + 1)),
        /loop\/rep nesting deeper than 4/);
    assemble(deep('loop aL, i0\n', 'endloop\n', MAX_LOOP_NESTING));
    rejects(()=>assemble(deep('loop aL, i0\n', 'endloop\n', MAX_LOOP_NESTING + 1)),
        /nesting deeper than 4/);
    assemble(deep('if b0\n', 'endif\n', MAX_IF_NESTING));
    rejects(()=>assemble(deep('if b0\n', 'endif\n', MAX_IF_NESTING + 1)),
        /if nesting deeper than 24/);
    assemble(deep('if_lt c0.x, c1.x\n', 'endif\n', MAX_IF_NESTING));
    assert.equal(MAX_LOOP_NESTING, 4);
    assert.equal(MAX_IF_NESTING, 24);
});

test('assembler syntax', ()=>{
    const lower = disassemble(asm('// a comment\nPS_2_0 ; trailing\n\n  DEF c0, 1, 2, 3, 4\n'
        + '\tMOV oC0 , c0.xyzw ; copy\n'));
    assert.equal(lower, 'ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0\n');
    assert.equal(disassemble(asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0.xyzw, c0.xyzw\n')),
        'ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0\n');
    assert.deepEqual([...asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0.x\n')],
        [...asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0.xxxx\n')]);
    assert.deepEqual([...asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0.xy\n')],
        [...asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov oC0, c0.xyyy\n')]);
    assert.deepEqual([...asm('vs_2_0\nmova a0.x, c0\nmov oPos, c[a0.x+3]\n')],
        [...asm('vs_2_0\nmova a0.x, c0\nmov oPos, c[ a0.x + 3 ]\n')]);
    assert.equal(disassemble(asm('vs_2_0\nmova a0.x, c0\nmov oPos, c[a0.x + 0]\n')),
        'vs_2_0\nmova a0.x, c0\nmov oPos, c[a0.x]\n');
    assert.equal(asm('vs_2_x')[0], 0xfffe0201);
    assert.equal(asm('vs_1_1')[0], 0xfffe0101);
    assert.equal(asm('ps_3_0')[0], 0xffff0300);
    assert.equal(asm('ps_2_x')[0], 0xffff0201);
    assert.equal(asm('vs_3_0')[0], 0xfffe0300);
    // Exact token values: add r0.xy, -c1.wzyx, |r2.x|
    assert.deepEqual([...asm('ps_3_0\nmov r2, c0\nadd r0.xy, -c1.wzyx, |r2.x|\n')].slice(4, 8),
        [(2 | (3 << 24)) >>> 0, 0x80030000, (0xa0000000 | 1 | (0x1b << 16) | (1 << 24)) >>> 0,
            (0x80000000 | 2 | (0 << 16) | (11 << 24)) >>> 0]);
    // dcl tokens: dcl_texcoord3 v1 and dcl_cube s2.
    assert.deepEqual([...asm('ps_3_0\ndcl_texcoord3 v1\ndcl_cube s2\n')].slice(1, 7),
        [(31 | (2 << 24)) >>> 0, (0x80000000 | 5 | (3 << 16)) >>> 0, 0x900f0001,
            (31 | (2 << 24)) >>> 0, (0x80000000 | (3 << 27)) >>> 0, 0xa00f0802]);
    // Relative addressing in model 1 sets only the bit; in model 2 it adds a token.
    assert.deepEqual([...asm('vs_1_1\nmov oPos, c[a0.x + 5]\n')].slice(1),
        [1, 0xc00f0000, (0x80e40000 | 0x20000000 | (1 << 13) | 5) >>> 0, 0xffff]);
    assert.deepEqual([...asm('vs_2_0\nmova a0.x, c0\nmov oPos, c[aL + 5]\n')].slice(4),
        [(1 | (3 << 24)) >>> 0, 0xc00f0000, (0x80e40000 | 0x20000000 | (1 << 13) | 5) >>> 0,
            0xf0000800, 0xffff]);
    // Texld variants share an opcode and differ in the control bits.
    const modes = ['texld', 'texldp',
        'texldb'].map(m=>asm(`ps_2_0\ndcl t0\ndcl_2d s0\n${m} r0, t0, s0\n`)[7]);
    assert.deepEqual(modes.map(t=>(t >>> 16) & 0xff), [0, 1, 2]);
    assert.deepEqual(modes.map(t=>t & 0xffff), [66, 66, 66]);
    const cmp = asm('ps_3_0\nif_ge c0.x, c0.y\nendif\n')[1];
    assert.equal((cmp >>> 16) & 0xff, 3);
    assert.equal(cmp & 0xffff, 41);
    // Errors carry the line.
    rejects(()=>assemble('ps_2_0\nmov oC0, c0\nfrobnicate r0\n'),
        /^assemble: line 3: unknown instruction "frobnicate"/);
    rejects(()=>assemble('mov r0, c0\n'), /line 1: the first statement must be the shader version/);
    rejects(()=>assemble(''), /no version statement/);
    rejects(()=>assemble('ps_2_0\nmov r0.yx, c0\n'),
        /write mask ".yx" must list x, y, z, w in order/);
    rejects(()=>assemble('ps_2_0\nmov r0.q, c0\n'), /bad destination|bad write mask/);
    rejects(()=>assemble('ps_2_0\nmov r0, c0.xyzwx\n'), /bad swizzle ".xyzwx"/);
    rejects(()=>assemble('ps_2_0\nmov r0, \n'), /bad source|line 2/);
    rejects(()=>assemble('ps_2_0\nmov\n'), /needs a destination/);
    rejects(()=>assemble('ps_2_0\nmov r0 c0\n'), /bad destination|bad source/);
    rejects(()=>assemble('ps_2_0\ndef c0, 1, 2, 3\n'), /def takes a register and 4 values/);
    rejects(()=>assemble('ps_2_0\ndef c0, 1, 2, 3, x\n'), /bad number "x"/);
    rejects(()=>assemble('ps_3_0\ndefi i0, 1.5, 2, 3, 4\n'), /bad integer "1.5"/);
    rejects(()=>assemble('ps_2_0\nmov r0, |c0\n'), /bad source/);
    rejects(()=>assemble('ps_2_0\nmov r0.x_sat, c0\n'), /bad|unknown/);
    rejects(()=>assemble('ps_2_0\nmov_foo r0, c0\n'), /unknown instruction "mov_foo"/);
    rejects(()=>assemble('ps_2_0\ndcl_bogus v0\n'), /bad dcl usage "bogus"/);
    rejects(()=>assemble('ps_2_0\ndcl_2d_sat s0\n'), /bad dcl modifier/);
    rejects(()=>assemble('ps_2_0\nif_zz r0.x, c0.x\n'), /unknown instruction/);
    rejects(()=>assemble('ps_2_0\nmov oC0, c[a0.x]\n'), /bad register|only a0.x/);
    rejects(()=>assemble('vs_1_1\nmov oPos, c[aL]\n'), /through a0.x only/);
    rejects(()=>assemble('vs_2_0\nmov oPos, r[a0.x]\n'),
        /only c and v can be addressed relatively/);
    rejects(()=>assemble('vs_2_0\nmov oPos, c9999\n'), /register index too large/);
    // validate: false produces what decode then refuses.
    const raw = assemble('ps_2_0\nlit oC0, c0\n', { validate: false });
    assert.equal(raw.length, 5);
    rejects(()=>decode(raw), /lit is not available/);
});

test('disassembly formats', ()=>{
    const text = [
        'vs_3_0',
        'dcl_position v0',
        'dcl_texcoord1 v1',
        'dcl_blendindices v2',
        'dcl_position o0',
        'dcl_texcoord2 o1.xy',
        'dcl_2d s0',
        'def c0, 1, 0, 0.5, 2',
        'def c1, -0, 1e-20, 16777216, 0.1',
        'defi i0, 4, -1, 0, 1',
        'defb b0, true',
        'defb b1, false',
        'mad r0.xyz, -r1, c2.x, r3',
        'mul r0, |r1.wzyx|, -|c[a0.x + 3].yz|',
        'add r0.w, v[aL + 2], c[aL]',
        'mova a0.x, r0',
        'texldl r0, r1, s0',
        'if b0',
        'else',
        'endif',
        'if_lt r0.x, c1.x',
        'endif',
        'loop aL, i0',
        'break_ge r0.x, c1.y',
        'break',
        'endloop',
        'rep i0',
        'endrep',
        'call l0',
        'callnz l1, b0',
        'ret',
        'label l0',
        'nop',
        'ret',
        'label l1',
        'ret',
        'sincos r0.xy, r1.x',
        'sgn r0, r1',
        'mov o0, r0',
        '',
    ].join('\n');
    // The text is canonical, so it comes back as it went in.
    assert.equal(disassemble(assemble(text)), text);
    const ps = [
        'ps_2_0',
        'dcl t0.xy',
        'dcl t1',
        'dcl v0',
        'dcl_2d s0',
        'dcl_cube s1',
        'dcl_volume s2',
        'texld r0, t0, s0',
        'texldp r1, t1, s1',
        'texldb r2, t1, s2',
        'mad_sat_pp r0.xyz, -r1, c2.x, r3',
        'texkill t1',
        'texkill r0',
        'mov oC0, r0',
        'mov oDepth.x, r0.x',
        '',
    ].join('\n');
    assert.equal(disassemble(assemble(ps)), ps);
    const ps3 = ['ps_3_0', 'dcl_color_centroid v0', 'dcl vPos.xy', 'dcl vFace', 'dcl_texcoord v1',
        'mov oC0, v0', 'mov oC1.xy, vPos', 'mov oC2.x, vFace.x', 'mov oC3, v1', ''].join('\n');
    assert.equal(disassemble(assemble(ps3)), ps3);
    assert.equal(disassemble(assemble('vs_2_0\nmov oFog, c0.x\nmov oPts, c0.x\nmov oD1, c0\n'
        + 'mov oT7, c0\n')),
    'vs_2_0\nmov oFog, c0.x\nmov oPts, c0.x\nmov oD1, c0\nmov oT7, c0\n');
    // The shortest decimal that reads back as the same float.
    const wide = 'ps_2_0\ndef c0, 0.1, 0.30000001192092896, 1e10, 3.4028235e38\nmov oC0, c0\n';
    assert.equal(disassemble(assemble(wide)),
        'ps_2_0\ndef c0, 0.1, 0.3, 10000000000, 3.4028235e+38\nmov oC0, c0\n');
    assert.equal(disassemble(assemble('ps_2_0\ndef c0, inf, -inf, nan, 0x3f800001\nmov oC0, c0\n')),
        'ps_2_0\ndef c0, 0x7f800000, 0xff800000, 0x7fc00000, 1.0000001\nmov oC0, c0\n');
    const tiny = decode(assemble('ps_2_0\ndef c0, 2.5, 0.1, 1e-45, 0\nmov oC0, c0\n'));
    assert.deepEqual(tiny.defs.f.get(0), [2.5, f32(0.1), f32(1e-45), 0]);
});

test('aL as a value, negative counts and steps, loops inside subroutines', ()=>{
    const f = Float32Array.from({ length: 64 }, (_, i)=>i + 1);
    const io = { constants: { f } };
    const down = go('vs_2_x\ndefi i0, 3, 8, -2, 0\nmov r0, c0\nloop aL, i0\n'
        + 'add r0.x, r0.x, c[aL].x\nmov r1.x, aL\nendloop\nmov oPos.x, r0.x\nmov oPos.y, r1.x\n',
    io);
    // aL = 8, 6, 4: c8.x, c6.x, c4.x are 33, 25, 17.
    assert.deepEqual(down.outputs.oPos.slice(0, 2), [1 + 33 + 25 + 17, 4]);
    const negative = go('vs_2_x\ndefi i0, -3, 0, 1, 0\nmov r0, c0\nrep i0\n'
        + 'add r0, r0, c1\nendrep\nmov oPos, r0\n', io);
    assert.deepEqual(negative.outputs.oPos, [1, 2, 3, 4]);
    const sub = go('vs_2_x\ndefi i0, 2, 1, 1, 0\nmov r0, c0\ncall l0\nmov oPos, r0\nret\n'
        + 'label l0\nloop aL, i0\nadd r0, r0, c[aL]\nendloop\nret\n', io);
    // aL = 1, 2: c1 is (5, 6, 7, 8) and c2 is (9, 10, 11, 12).
    assert.deepEqual(sub.outputs.oPos, [15, 18, 21, 24]);
    const ps = go('ps_3_0\ndefi i0, 2, 0, 3, 0\nmov r0, c0\nloop aL, i0\n'
        + 'add r0, r0, c[aL + 1]\nendloop\nmov oC0, r0\n', io);
    // aL = 0, 3: c1 and c4, which are (5, 6, 7, 8) and (17, 18, 19, 20).
    assert.deepEqual(ps.outputs.oC0, [23, 26, 29, 32]);
    rejects(()=>go('ps_3_0\nmov oC0, c[aL]\n', io), /read of aL outside a loop/);
    rejects(()=>go('ps_3_0\nmov r0, aL\nmov oC0, r0\n', io), /read of aL outside a loop/);
});

test('programs keep no state between runs', ()=>{
    const program = decode(asm('ps_2_0\ndef c0, 1, 2, 3, 4\ncmp r0.x, c0, c0, c0\nmov r1, c0\n'
        + 'add oC0, r0.x, r1\n'));
    const first = execute(program, {});
    assert.deepEqual(first.outputs.oC0, [2, 3, 4, 5]);
    assert.deepEqual(execute(program, {}).outputs.oC0, [2, 3, 4, 5]);
    const reader = decode(asm('ps_2_0\nmov oC0, r0\n'));
    rejects(()=>execute(reader, {}), /read of unwritten r0.x/);
    const writer = decode(asm('ps_2_0\ndef c0, 1, 2, 3, 4\nmov r0, c0\nmov oC0, r0\n'));
    execute(writer, {});
    rejects(()=>execute(reader, {}), /read of unwritten r0.x/);
});

test('predication: setp writes p0 through its mask, a predicated write keeps the rest', ()=>{
    const result = execute(assemble([
        'vs_3_0', 'dcl_position o0', 'dcl_texcoord o1', 'defb b0, true', 'defi i0, 3, 0, 0, 0',
        'def c0, 1, 2, 3, 4', 'def c1, 2, 2, 2, 2', 'def c2, 9, 9, 9, 9',
        'setp_gt p0, c0, c1',
        'mov o0, c0',
        '(p0) mov o0, c2',
        'mov o1, c0',
        '(!p0.x) mov o1.xy, c2',
        'mov r0, c0',
        'rep i0', 'add r0, r0, c1', 'breakp p0.w', 'endrep',
        'if p0.y', 'mov r0.x, c2.x', 'endif',
    ].join('\n')), {});
    assert.deepEqual([...result.outputs.o0], [1, 2, 9, 9], 'z and w were greater');
    assert.deepEqual([...result.outputs.o1], [9, 9, 3, 4], 'x was not, so !p0.x held for both');
    // breakp left the repeat after one pass; p0.y was false.
    assert.equal(Math.fround(execute(assemble([
        'vs_3_0', 'dcl_position o0', 'def c0, 1, 2, 3, 4', 'def c1, 2, 2, 2, 2',
        'defi i0, 3, 0, 0, 0', 'setp_gt p0, c0, c1', 'mov r0, c0',
        'rep i0', 'add r0, r0, c1', 'breakp p0.w', 'endrep', 'mov o0, r0',
    ].join('\n')), {}).outputs.o0[0]), 3);
    rejects(()=>execute(assemble('vs_3_0\ndcl_position o0\nif p0.x\nendif\nmov o0, c0\n'),
        { constants: { f: [0, 0, 0, 0] } }), /p0.x is read before setp wrote it/);
    rejects(()=>assemble('vs_2_0\nsetp_lt p0, c0, c1\n'), /not available in vs_2_0|predication/);
});

test('the limits are the documented ones', ()=>{
    const want = {
        vs_1_1: [12, 256, 0, 0, 16], vs_2_0: [12, 256, 16, 16, 16], vs_2_x: [12, 256, 16, 16, 16],
        vs_3_0: [32, 256, 16, 16, 16], ps_2_0: [12, 32, 0, 0, 2], ps_2_x: [32, 32, 16, 16, 2],
        ps_3_0: [32, 224, 16, 16, 10],
    };
    for (const [name, [temps, floats, ints, bools, inputs]] of Object.entries(want))
    {
        const l = /** @type {Record<string, Record<string, number>>} */ (VERSION_LIMITS)[name];
        assert.deepEqual([l.temps, l.floatConsts, l.intConsts, l.boolConsts, l.inputs],
            [temps, floats, ints, bools, inputs], name);
    }
    assert.equal(VERSION_LIMITS.vs_3_0.outputs, 12);
    assert.equal(VERSION_LIMITS.ps_2_0.texcoords, 8);
    assert.equal(VERSION_LIMITS.ps_3_0.samplers, 16);
    assert.equal(VERSION_LIMITS.vs_3_0.samplers, 4);
});

test('every assembled shader survives assemble, disassemble, assemble', ()=>{
    assert.ok(SOURCES.size > 100, `only ${SOURCES.size} shaders collected`);
    let checked = 0;
    for (const source of SOURCES)
    {
        const tokens = assemble(source, { validate: false });
        let invalid = null;
        try
        {
            decode(tokens);
        }
        catch (e){
            invalid = e;
        }
        if (invalid)
        {
            continue;
        }
        const text = disassemble(tokens);
        const again = assemble(text);
        assert.deepEqual([...again], [...tokens], source);
        assert.equal(disassemble(again), text, source);
        checked++;
    }
    assert.ok(checked > 100, `only ${checked} shaders round-tripped`);
});

test('before ps_1_4 arithmetic writes a texture register its stage has filled', ()=>{
    // fxc does when the two temporaries are taken: mov_sat t0.w, v0.w.
    const out = go('ps_1_1\ntex t0\nmov_sat t0.a, v0\nmul r0, t0, v0\n', {
        inputs: { v: [[0.5, 0.5, 0.5, 0.5]], t: [[0, 0, 0, 0]] },
        sample: ()=>[0.25, 0.5, 0.75, 1] }).outputs.oC0;
    assert.deepEqual([...out], [0.125, 0.25, 0.375, 0.25]);
    assert.throws(()=>asm('ps_1_4\ntexld r0, t0\nmov t0, r0\n'), /writes a r# register/);
});

test('a model 1 co-issued pair may write alpha first', ()=>{
    // fxc writes ps_1_1 pairs that way: mul t0.w, r1.w, t0.w + lrp t0.xyz, ...
    const out = go('ps_1_1\nmov r0.a, v0\n+ mov r0.rgb, v1\n', {
        inputs: { v: [[0.1, 0.2, 0.3, 0.4], [0.5, 0.6, 0.7, 0.8]], t: [] } }).outputs.oC0;
    assert.deepEqual([...out].map(x=>Math.round(x * 10) / 10), [0.5, 0.6, 0.7, 0.4]);
    assert.throws(()=>asm('ps_1_1\nmov r0.a, v0\n+ mov r0.a, v1\n'), /co-issued pair/);
});
