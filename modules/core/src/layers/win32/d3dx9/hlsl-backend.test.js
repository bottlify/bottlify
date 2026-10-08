/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from './hlsl-backend.js';
import { PC, PT, USAGE, profileOf } from './hlsl-ir.js';
import { findConstantTable, parseConstantTable } from './constants.js';
import { parseShader } from '../../graphics/d3d9/shader.js';
import { translateShader } from '../../graphics/d3d9/wgsl.js';

/** @typedef {import('./hlsl-ir.js').IrProgram} IrProgram */

/** @param {string} name @returns {IrProgram} */
function program(name){
    return { profile: /** @type {any} */ (profileOf(name)), instrs: [], inputs: [], outputs: [],
        constants: [], vregCount: 0 };
}

/** @param {IrProgram} ir @param {number} width */
function vreg(ir, width){
    return { id: ir.vregCount++, width };
}

/** A float4x4 packed by column, which is how a shader reads it. */
const MATRIX = { cls: PC.MATRIX_COLUMNS, type: PT.FLOAT, rows: 4, cols: 4, elements: 1 };
const VECTOR4 = { cls: PC.VECTOR, type: PT.FLOAT, rows: 1, cols: 4, elements: 1 };

/** @param {Uint32Array} tokens */
function disassembled(tokens){
    const parsed = parseShader(tokens);
    assert.equal(parsed.error, null);
    return parsed.instructions.map(i=>i.name);
}

/**
 * The common vertex shader: position through a matrix, a colour passed on.
 *
 * @param {string} profile
 */
function transform(profile){
    const ir = program(profile);
    const position = { usage: USAGE.POSITION, index: 0, width: 4 };
    const colour = { usage: USAGE.COLOR, index: 0, width: 4 };
    ir.inputs.push(position, colour);
    const oPos = { usage: USAGE.POSITION, index: 0, width: 4 };
    const oColor = { usage: USAGE.COLOR, index: 0, width: 4 };
    ir.outputs.push(oPos, oColor);
    const world = { name: 'WorldViewProj', set: /** @type {'f'} */ ('f'), type: MATRIX };
    const tint = { name: 'Tint', set: /** @type {'f'} */ ('f'), type: VECTOR4,
        defaults: [1, 0.5, 0.25, 1] };
    ir.constants.push(world, tint);
    for (let row = 0; row < 4; row++)
    {
        ir.instrs.push({ op: 'dp4', dest: { kind: 'out', out: oPos, mask: 1 << row }, srcs: [
            { kind: 'input', input: position, swz: [0, 1, 2, 3] },
            { kind: 'const', cst: world, offset: row, swz: [0, 1, 2, 3] }] });
    }
    const t = vreg(ir, 4);
    ir.instrs.push({ op: 'mul', dest: { kind: 'reg', reg: t, mask: 15 }, srcs: [
        { kind: 'input', input: colour, swz: [0, 1, 2, 3] },
        { kind: 'const', cst: tint, offset: 0, swz: [0, 1, 2, 3] }] });
    ir.instrs.push({ op: 'mov', dest: { kind: 'out', out: oColor, mask: 15 },
        srcs: [{ kind: 'reg', reg: t, swz: [0, 1, 2, 3] }] });
    return ir;
}

test('a vertex shader assembles to a stream the translator\'s parser reads', ()=>{
    for (const name of ['vs_1_1', 'vs_2_0', 'vs_3_0'])
    {
        const result = assemble(transform(name));
        assert.deepEqual(result.diagnostics, [], name);
        const tokens = /** @type {Uint32Array} */ (result.tokens);
        const names = disassembled(tokens);
        assert.deepEqual(names.filter(n=>n !== 'dcl'), ['dp4', 'dp4', 'dp4', 'dp4', 'mul'],
            name);
        assert.equal(names.filter(n=>n === 'dcl').length, name === 'vs_3_0' ? 4 : 2, name);
        assert.equal(parseShader(tokens).version.major, Number(name[3]));
    }
});

test('the constant table in the stream names the constants and keeps a default', ()=>{
    const result = assemble(transform('vs_2_0'));
    const tokens = /** @type {Uint32Array} */ (result.tokens);
    const bytes = new Uint8Array(tokens.buffer);
    const found = findConstantTable(at=>new DataView(tokens.buffer).getUint32(at, true), 0);
    assert.ok(found, 'a CTAB comment');
    const block = bytes.slice(found.at, found.at + found.size);
    const table = parseConstantTable(new DataView(block.buffer), 0);
    assert.deepEqual(table.constants.map(c=>[c.name, c.set, c.index, c.count, c.cls, c.type,
        c.rows, c.columns]), [['WorldViewProj', 2, 0, 4, PC.MATRIX_COLUMNS, PT.FLOAT, 4, 4],
        ['Tint', 2, 4, 1, PC.VECTOR, PT.FLOAT, 1, 4]]);
    const tint = table.constants[1];
    const view = new DataView(block.buffer);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(tint.defaultAt + i * 4, true)),
        [1, 0.5, 0.25, 1]);
    assert.equal(table.constants[0].defaultAt, 0);
});

test('the translator accepts what the back half writes', ()=>{
    for (const name of ['vs_1_1', 'vs_2_0', 'vs_3_0'])
    {
        const tokens = /** @type {Uint32Array} */ (assemble(transform(name)).tokens);
        const translated = translateShader(parseShader(tokens));
        assert.equal(translated.error, null, name);
    }
});

test('literals share registers: scalars pack four to a def, a vector rides with its own', ()=>{
    const ir = program('ps_2_0');
    const out = { usage: USAGE.COLOR, index: 0, width: 4 };
    ir.outputs.push(out);
    const a = vreg(ir, 4);
    ir.instrs.push({ op: 'mov', dest: { kind: 'reg', reg: a, mask: 15 },
        srcs: [{ kind: 'imm', values: [0.25, 0.5, 0.75, 1] }] });
    const b = vreg(ir, 1);
    ir.instrs.push({ op: 'mul', dest: { kind: 'reg', reg: b, mask: 1 }, srcs: [
        { kind: 'reg', reg: a, swz: [0] }, { kind: 'imm', values: [0.5] }] });
    const c = vreg(ir, 1);
    ir.instrs.push({ op: 'add', dest: { kind: 'reg', reg: c, mask: 1 }, srcs: [
        { kind: 'reg', reg: b, swz: [0] }, { kind: 'imm', values: [1] }] });
    ir.instrs.push({ op: 'mov', dest: { kind: 'out', out, mask: 15 },
        srcs: [{ kind: 'reg', reg: c, swz: [0, 0, 0, 0] }] });
    const result = assemble(ir);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.stats.defs, 1);
    const parsed = parseShader(/** @type {Uint32Array} */ (result.tokens));
    const def = parsed.instructions.find(i=>i.name === 'def');
    assert.ok(def);
    const values = new Float32Array(Uint32Array.from(def.literals ?? []).buffer);
    assert.deepEqual([...values].sort(), [0.25, 0.5, 0.75, 1]);
});

test('a result nobody reads is not written', ()=>{
    const ir = program('ps_2_0');
    const out = { usage: USAGE.COLOR, index: 0, width: 4 };
    ir.outputs.push(out);
    const dead = vreg(ir, 4);
    ir.instrs.push({ op: 'mov', dest: { kind: 'reg', reg: dead, mask: 15 },
        srcs: [{ kind: 'imm', values: [1, 2, 3, 4] }] });
    ir.instrs.push({ op: 'mov', dest: { kind: 'out', out, mask: 15 },
        srcs: [{ kind: 'imm', values: [0, 0, 0, 1] }] });
    const result = assemble(ir);
    assert.deepEqual(disassembled(/** @type {Uint32Array} */ (result.tokens))
        .filter(n=>n !== 'def'), ['mov']);
    assert.equal(result.stats.defs, 1);
});

test('temporaries share a register by component and by lifetime', ()=>{
    const ir = program('ps_2_0');
    const out = { usage: USAGE.COLOR, index: 0, width: 4 };
    ir.outputs.push(out);
    const input = { usage: USAGE.TEXCOORD, index: 0, width: 4 };
    ir.inputs.push(input);
    // Four scalars alive together, then a vector after they die: one register.
    const scalars = [0, 1, 2, 3].map(()=>vreg(ir, 1));
    scalars.forEach((s, i)=>ir.instrs.push({ op: 'mov', dest: { kind: 'reg', reg: s, mask: 1 },
        srcs: [{ kind: 'input', input, swz: [i] }] }));
    const sum = vreg(ir, 1);
    ir.instrs.push({ op: 'add', dest: { kind: 'reg', reg: sum, mask: 1 }, srcs: [
        { kind: 'reg', reg: scalars[0], swz: [0] }, { kind: 'reg', reg: scalars[1], swz: [0] }] });
    const rest = vreg(ir, 1);
    ir.instrs.push({ op: 'add', dest: { kind: 'reg', reg: rest, mask: 1 }, srcs: [
        { kind: 'reg', reg: scalars[2], swz: [0] }, { kind: 'reg', reg: scalars[3], swz: [0] }] });
    const total = vreg(ir, 1);
    ir.instrs.push({ op: 'add', dest: { kind: 'reg', reg: total, mask: 1 }, srcs: [
        { kind: 'reg', reg: sum, swz: [0] }, { kind: 'reg', reg: rest, swz: [0] }] });
    ir.instrs.push({ op: 'mov', dest: { kind: 'out', out, mask: 15 },
        srcs: [{ kind: 'reg', reg: total, swz: [0, 0, 0, 0] }] });
    const result = assemble(ir);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.stats.temps, 1);
});

test('a limit the target has is reported with the numbers, as a warning', ()=>{
    const ir = program('ps_2_0');
    const out = { usage: USAGE.COLOR, index: 0, width: 4 };
    ir.outputs.push(out);
    const input = { usage: USAGE.TEXCOORD, index: 0, width: 4 };
    ir.inputs.push(input);
    let last = vreg(ir, 4);
    ir.instrs.push({ op: 'mov', dest: { kind: 'reg', reg: last, mask: 15 },
        srcs: [{ kind: 'input', input, swz: [0, 1, 2, 3] }] });
    for (let i = 0; i < 70; i++)
    {
        const next = vreg(ir, 4);
        ir.instrs.push({ op: 'add', dest: { kind: 'reg', reg: next, mask: 15 }, srcs: [
            { kind: 'reg', reg: last, swz: [0, 1, 2, 3] },
            { kind: 'input', input, swz: [3, 2, 1, 0] }] });
        last = next;
    }
    ir.instrs.push({ op: 'mov', dest: { kind: 'out', out, mask: 15 },
        srcs: [{ kind: 'reg', reg: last, swz: [0, 1, 2, 3] }] });
    // A warning: the program is still given, since it runs as WGSL, which holds it.
    const result = assemble(ir);
    assert.ok(result.tokens);
    assert.equal(result.diagnostics[0].severity, 'warning');
    assert.match(result.diagnostics[0].message,
        /too many arithmetic instruction slots \(71\)\. Max\. allowed by the target \(ps_2_0\) is 64/);
    assert.equal(result.diagnostics[0].code, 'X5608');
});
