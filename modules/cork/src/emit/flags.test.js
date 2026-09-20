/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body, ModuleBuilder, ValType } from '../wasm/encoder.js';
import { Kind, addMaterialiseHelper, emitCondition, emitFlag, kindOf } from './flags.js';
import { addFlags, condition, logicFlags, subFlags } from '../ir.js';
import { CF, OF, PF, SF, ZF, AF } from '../decode/table.js';

const ARITH = CF | PF | AF | ZF | SF | OF;

/**
 * A module with the helper and two exported probes: `word` runs the helper
 * on a record, `flag` and `cond` compute one flag or one condition from a
 * record of a statically known kind, the way a region does inline.
 */
function probes(){
    const m = new ModuleBuilder();
    const helper = addMaterialiseHelper(m);
    const six = [ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32];
    const type = m.type({ params: six, results: [ValType.i32] });
    const b = new Body();
    for (let i = 0; i < 6; i++)
    {
        b.localGet(i);
    }
    m.function(type, [], b.call(helper).toBytes(), { exportAs: 'word' });
    const locals = { kind: 0, res: 1, op1: 2, op2: 3, cin: 4, flags: 5 };
    /** @type {Record<string, (kind: number, width: number, what: number) => string>} */
    const built = {};
    for (const kind of Object.values(Kind))
    {
        for (let width = 0; width < 3; width++)
        {
            for (const flag of [CF, PF, AF, ZF, SF, OF])
            {
                const body = new Body();
                emitFlag(body, locals, kind, width, flag);
                built[`flag_${kind}_${width}_${flag}`] = ()=>'';
                m.function(type, [], body.toBytes(), { exportAs: `flag_${kind}_${width}_${flag}` });
            }
            for (let cc = 0; cc < 16; cc++)
            {
                const body = new Body();
                emitCondition(body, locals, kind, width, cc);
                m.function(type, [], body.toBytes(), { exportAs: `cond_${kind}_${width}_${cc}` });
            }
        }
    }
    const bytes = m.toBytes();
    if (!WebAssembly.validate(bytes))
    {
        new WebAssembly.Module(bytes);
    }
    return /** @type {any} */ (new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports);
}

/** A deterministic sequence, so a failure reproduces. */
function* values(){
    let x = 0x2545f491;
    for (;;)
    {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        yield x >>> 0;
    }
}

/**
 * The model's record and flags for one operation.
 *
 * @param {number} kind @param {number} size @param {number} a @param {number} b @param {number} cin
 * @param {number} eager  CF for INC/DEC, CF|OF for SHIFT, as the word would hold
 */
function expected(kind, size, a, b, cin, eager){
    switch (kind)
    {
        case Kind.ADD: return { ...addFlags(a, b, 0, size), op1: a, op2: b };
        case Kind.ADC: return { ...addFlags(a, b, cin, size), op1: a, op2: b };
        case Kind.SUB: return { ...subFlags(a, b, 0, size), op1: a, op2: b };
        case Kind.SBB: return { ...subFlags(a, b, cin, size), op1: a, op2: b };
        case Kind.LOGIC:
            return { result: (a & b) >>> 0, flags: logicFlags(a & b, size), op1: a, op2: b };
        case Kind.INC:
        {
            const r = addFlags(a, 1, 0, size);
            return { result: r.result, flags: (r.flags & ~CF) | (eager & CF), op1: a, op2: 1 };
        }
        case Kind.DEC:
        {
            const r = subFlags(a, 1, 0, size);
            return { result: r.result, flags: (r.flags & ~CF) | (eager & CF), op1: a, op2: 1 };
        }
        case Kind.NEG: return { ...subFlags(0, a, 0, size), op1: 0, op2: a };
        default: // SHIFT: ZF SF PF from the result, CF and OF from the word, AF clear
        {
            const r = logicFlags(a, size);
            return { result: a, flags: (r & ~(CF | OF)) | (eager & (CF | OF)), op1: a, op2: 0 };
        }
    }
}

test('the helper\'s word and the inline flag and condition formulas agree with the model', ()=>{
    const p = probes();
    const random = values();
    let checked = 0;
    for (let round = 0; round < 3000; round++)
    {
        const size = [1, 2, 4][round % 3];
        const width = round % 3;
        const mask = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
        const a = (/** @type {number} */ (random.next().value) & mask) >>> 0;
        const b = (/** @type {number} */ (random.next().value) & mask) >>> 0;
        const cin = round & 1;
        const eager = (round >> 1) & (CF | OF);
        for (const kind of [Kind.ADD, Kind.ADC, Kind.SUB, Kind.SBB, Kind.LOGIC, Kind.INC, Kind.DEC,
            Kind.NEG, Kind.SHIFT])
        {
            const want = expected(kind, size, a, b, cin, eager);
            const record = [kindOf(kind, size), want.result, want.op1, want.op2, cin, eager];
            const word = p.word(...record) & ARITH;
            assert.equal(word, want.flags & ARITH,
                `word: kind ${kind} size ${size} a=${a.toString(16)} b=${b.toString(16)}`
                + ` cin=${cin}`);
            for (const flag of [CF, PF, AF, ZF, SF, OF])
            {
                const got = p[`flag_${kind}_${width}_${flag}`](...record);
                assert.equal(got, (want.flags & flag) !== 0 ? 1 : 0,
                    `flag ${flag}: kind ${kind} size ${size} a=${a.toString(16)}`
                    + ` b=${b.toString(16)}`);
            }
            for (let cc = 0; cc < 16; cc++)
            {
                const got = p[`cond_${kind}_${width}_${cc}`](...record);
                assert.equal(got, condition(cc, want.flags) ? 1 : 0,
                    `cc ${cc}: kind ${kind} size ${size} a=${a.toString(16)} b=${b.toString(16)}`);
            }
            checked++;
        }
    }
    assert.ok(checked > 20000);
});

test('an EAGER record answers the word as it is', ()=>{
    const p = probes();
    assert.equal(p.word(0, 0, 0, 0, 0, 0x8d5) & ARITH, ARITH);
    assert.equal(p.word(0, 0, 0, 0, 0, 0x246) & ARITH, ZF | PF);
    assert.equal(p[`flag_0_2_${ZF}`](0, 0, 0, 0, 0, ZF), 1);
    assert.equal(p[`cond_0_2_${4}`](0, 0, 0, 0, 0, 0), 0);
});
