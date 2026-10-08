/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate for VBScript's fast paths, both of them.
 *
 * - The operators: Integer, Long and Double sums, differences, products and
 *   comparisons worked out directly (`values.js` FAST) against the
 *   automation operator tables alone (EXACT), over seeded random operands
 *   of every subtype -- the answer's subtype and value, or the error.
 * - The evaluator: seeded random programs run once with the steps-free
 *   paths and once through the generator evaluator alone, and everything a
 *   program can observe -- every variable's subtype and text after every
 *   statement, the error each statement ended with, the order an object's
 *   default property was read in -- has to be the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVBScriptEngine } from './engine.js';
import { VBRuntimeError } from './errors.js';
import {
    EXACT, FAST, byte, currency, date, integer, long, single, typeName, toStr,
} from './values.js';

/** @param {number} seed @returns {() => number} */
function mulberry32(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** @param {() => number} random */
function operands(random){
    /** @template T @param {T[]} list @returns {T} */
    const pick = list=>list[Math.floor(random() * list.length)];
    const edgeInt = ()=>pick([0, 1, -1, 2, 32767, -32768, 32766, -32767, 181, 182, 255]);
    const edgeLong = ()=>pick([0, 1, -1, 2147483647, -2147483648, 65536, 46340, 46341,
        2147483646]);
    const any = ()=>Math.floor((random() - 0.5) * 2 ** (1 + random() * 34));
    return ()=>{
        switch (Math.floor(random() * 12))
        {
            case 0: return integer(random() < 0.5 ? edgeInt()
                : Math.max(-32768, Math.min(32767, any())));
            case 1: return long(random() < 0.5 ? edgeLong()
                : Math.max(-2147483648, Math.min(2147483647, any())));
            case 2: return pick([0, -0, 1.5, -2.25, 1e308, -1e308, 2 ** 53, 0.1, 3]);
            case 3: return any() / 7;
            case 4: return integer(Math.max(-32768, Math.min(32767, any())));
            case 5: return long(Math.max(-2147483648, Math.min(2147483647, any())));
            case 6: return pick(['1', 'x', '', ' 7 ', '&H10']);
            case 7: return pick([true, false, undefined, null]);
            case 8: return byte(Math.floor(random() * 256));
            case 9: return single(any() / 3);
            case 10: return currency(any() / 100);
            default: return date(37623.25 + Math.floor(any() / 1000));
        }
    };
}

/**
 * An operation's answer as a script can see it: the subtype and the text,
 * or the error number.
 *
 * @param {(a: any, b: any) => any} operation @param {any} a @param {any} b
 */
function observe(operation, a, b){
    try
    {
        const value = operation(a, b);
        if (typeof value === 'number')
        {
            return `Double:${toStr(value)}:${Object.is(value, -0)}`;
        }
        return value === null ? 'Null' : `${typeName(value)}:${toStr(value)}`;
    }
    catch (e){
        if (e instanceof VBRuntimeError)
        {
            return `error ${e.number}`;
        }
        throw e;
    }
}

test('the fast operators answer as the automation tables do', ()=>{
    const random = mulberry32(0xb5c0);
    const next = operands(random);
    const runs = 200000;
    for (let run = 0; run < runs; run++)
    {
        const a = next();
        const b = next();
        for (const op of /** @type {const} */ (['add', 'sub', 'mul', 'compare']))
        {
            assert.equal(observe(FAST[op], a, b), observe(EXACT[op], a, b),
                `${op}(${observe(x=>x, a, null)}, ${observe(x=>x, b, null)})`);
        }
    }
});

const NAMES = ['a', 'b', 'c', 'd'];
/** Scalars of every subtype, which the steps-free paths take, and objects, which they do not. */
const SCALARS = ['0', '1', '-3', '32767', '-32768', '2147483647', '2.5', '1E+300', '0.1',
    'CByte(200)', 'CSng(1.5)', 'CCur(2.25)', 'CLng(5)', '"1"', '"x"', '""', '" 7 "', 'True',
    'False', 'Null', 'Empty', '#1/2/2003#'];
const OBJECTS = ['New Box', 'Nothing'];
const BINARY = ['+', '-', '*', '/', '\\', 'Mod', '^', '&', '=', '<>', '<', '>', '<=', '>=',
    'And', 'Or', 'Xor', 'Eqv', 'Imp'];

/** @param {() => number} random */
function generator(random){
    /** @template T @param {T[]} list @returns {T} */
    const pick = list=>list[Math.floor(random() * list.length)];
    const value = ()=>(random() < 0.9 ? pick(SCALARS) : pick(OBJECTS));
    /** @param {number} depth @returns {string} */
    const expression = depth=>{
        const roll = random();
        if (depth <= 0 || roll < 0.3)
        {
            return random() < 0.5 ? pick(NAMES) : value();
        }
        if (roll < 0.8)
        {
            return `(${expression(depth - 1)} ${pick(BINARY)} ${expression(depth - 1)})`;
        }
        return `(${pick(['-', 'Not '])}${expression(depth - 1)})`;
    };
    // Each statement leaves what it did in the log, so that a value a later
    // one would hide is seen.
    const trace = 'log = log & ";" & Err.Number & Show(a) & Show(b) & Show(c) & Show(d): Err.Clear';
    /** @param {number} depth @returns {string} */
    const statement = depth=>{
        const roll = random();
        const name = pick(NAMES);
        if (depth <= 0 || roll < 0.5)
        {
            const rhs = expression(3);
            return /^New |^Nothing$/.test(rhs) ? `Set ${name} = ${rhs}\n${trace}`
                : `${name} = ${rhs}\n${trace}`;
        }
        if (roll < 0.7)
        {
            return `If ${expression(2)} Then\n${statement(depth - 1)}\nElse\n`
                + `${statement(depth - 1)}\nEnd If\n${trace}`;
        }
        if (roll < 0.85)
        {
            return `For i${depth} = 1 To ${1 + Math.floor(random() * 3)}\n${statement(depth - 1)}\n`
                + `${statement(depth - 1)}\nNext\n${trace}`;
        }
        // The loop's own condition never fails: a failing one is true under
        // On Error Resume Next, and would loop for ever.
        const n = `n${depth}`;
        return `Do While ${n} < 3\n${n} = ${n} + 1\nIf ${expression(1)} Then\n`
            + `${statement(depth - 1)}\nEnd If\nLoop\n${n} = 0\n${trace}`;
    };
    return ()=>{
        const setup = NAMES.map(name=>{
            const v = value();
            return /^New |^Nothing$/.test(v) ? `Set ${name} = ${v}` : `${name} = ${v}`;
        }).join('\n');
        const body = Array.from({ length: 6 }, ()=>statement(2)).join('\n');
        return `Class Box
    Public Default Property Get Value
        log = log & "v"
        Value = 4
    End Property
End Class
Function Show(v)
    If IsObject(v) Then
        Show = "|obj"
    ElseIf IsNull(v) Then
        Show = "|null"
    Else
        Show = "|" & TypeName(v) & ":" & CStr(v)
    End If
End Function
On Error Resume Next
Dim log
${setup}
${body}`;
    };
}

test('the steps-free paths answer as the generator evaluator does', async()=>{
    const random = mulberry32(0x5eed);
    const program = generator(random);
    const runs = 1500;
    for (let run = 0; run < runs; run++)
    {
        const text = program();
        /** @param {boolean} fastPaths */
        const outcome = async fastPaths=>{
            const engine = createVBScriptEngine({ fastPaths, now: ()=>0, localOffset: ()=>0 });
            try
            {
                await engine.run(text);
                return engine.getGlobal('log');
            }
            catch (e){
                return `failed ${/** @type {any} */ (e).number}`;
            }
        };
        assert.equal(await outcome(true), await outcome(false), text);
    }
});

test('the gate\'s programs reach the paths it compares', async()=>{
    // A program the fast paths take whole, and its result through both.
    const text = 'n = 0: s = ""\nFor i = 1 To 5: n = n + i: s = s & i: Next\n'
        + 'out = n & s & TypeName(n)';
    for (const fastPaths of [true, false])
    {
        const engine = createVBScriptEngine({ fastPaths });
        await engine.run(text);
        assert.equal(engine.getGlobal('out'), '1512345Integer');
    }
});
