/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate for the interpreter's steps-free paths: seeded random programs
 * run once with them and once through the generator evaluator alone, and
 * everything a program can observe -- every variable's type and text, the
 * order an object's valueOf ran in, the value of the program and the error
 * it ended with -- has to be the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJScriptEngine } from './engine.js';

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

const NAMES = ['a', 'b', 'c', 'd'];
/** Primitives, which the steps-free paths take, and objects, which send them back. */
const PRIMITIVES = ['0', '1', '-3', '2.5', '1e21', 'NaN', '"1"', '"x"', '""', '" 7 "', '"0x10"',
    'true', 'false', 'null', 'undefined'];
const OBJECTS = ['[2]', '[]', '{ valueOf: function(){ log += "v"; return 4 } }',
    '{ toString: function(){ log += "s"; return "t" } }', 'new Number(6)', 'new String("9")'];
const BINARY = ['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '!=', '===', '!==', '&',
    '|', '^', '<<', '>>', '>>>', '&&', '||'];
const ASSIGN = ['=', '+=', '-=', '*=', '|=', '<<='];

/** @param {() => number} random */
function generator(random){
    /** @template T @param {T[]} list @returns {T} */
    const pick = list=>list[Math.floor(random() * list.length)];
    const value = ()=>(random() < 0.85 ? pick(PRIMITIVES) : pick(OBJECTS));
    /** @param {number} depth @returns {string} */
    const expression = depth=>{
        const roll = random();
        if (depth <= 0 || roll < 0.3)
        {
            return random() < 0.5 ? pick(NAMES) : value();
        }
        if (roll < 0.7)
        {
            return `(${expression(depth - 1)} ${pick(BINARY)} ${expression(depth - 1)})`;
        }
        if (roll < 0.8)
        {
            return `(${pick(['-', '!', '~', 'typeof '])}${expression(depth - 1)})`;
        }
        if (roll < 0.87)
        {
            return `(${pick(NAMES)} ${pick(ASSIGN)} ${expression(depth - 1)})`;
        }
        if (roll < 0.93)
        {
            return random() < 0.5 ? `${pick(NAMES)}++` : `--${pick(NAMES)}`;
        }
        return `(${expression(depth - 1)} ? ${expression(depth - 1)} : ${expression(depth - 1)})`;
    };
    // Each statement leaves what it did in the log, so that a value a later
    // one would hide is seen.
    const trace = 'log += ";" + typeof a + a + typeof b + b + typeof c + c + typeof d + d;';
    /** @param {number} depth @returns {string} */
    const statement = depth=>{
        const roll = random();
        if (depth <= 0 || roll < 0.45)
        {
            return `${pick(NAMES)} ${pick(ASSIGN)} ${expression(3)}; ${trace}`;
        }
        if (roll < 0.6)
        {
            return `${pick(NAMES)}${pick(['++', '--'])}; ${trace}`;
        }
        if (roll < 0.65)
        {
            return `(${expression(3)}); ${trace}`;
        }
        if (roll < 0.72)
        {
            // A statement's own value, which only eval shows.
            const inner = random() < 0.5 ? `${pick(NAMES)}${pick(['++', '--'])};`
                : `${pick(NAMES)} ${pick(ASSIGN)} ${expression(2)};`;
            return `log += ";" + eval('${inner}'); ${trace}`;
        }
        if (roll < 0.85)
        {
            return `if (${expression(2)}) { ${statement(depth - 1)} }`
                + ` else { ${statement(depth - 1)} }`;
        }
        return `for (var i${depth} = 0; i${depth} < ${1 + Math.floor(random() * 4)}; i${depth}++)`
            + ` { ${statement(depth - 1)} ${statement(depth - 1)} }`;
    };
    return ()=>{
        const setup = NAMES.map(name=>`var ${name} = ${value()};`).join(' ');
        const body = Array.from({ length: 6 }, ()=>statement(2)).join('\n');
        return `var log = ""; ${setup}\nvar result;\n`
            + `try { result = (function(){ ${body}\nreturn ${expression(3)}; })(); }`
            + ' catch (e) { result = "error " + e.number; }\n'
            + `${NAMES.map(name=>`typeof ${name} + ":" + String(${name})`).join(' + "|" + ')}`
            + ' + "|" + log + "|" + typeof result + ":" + String(result)';
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
            const engine = createJScriptEngine({ fastPaths, now: ()=>0, localOffset: ()=>0 });
            try
            {
                return await engine.run(text);
            }
            catch (e){
                return `failed ${/** @type {any} */ (e).number}`;
            }
        };
        assert.deepEqual(await outcome(true), await outcome(false), text);
    }
});

test('the gate\'s programs reach the paths it compares', async()=>{
    // A program the fast paths take whole, and its result through both.
    const text = 'var n = 0, s = ""; for (var i = 0; i < 5; i++) { n += i; s += i; } n + s';
    for (const fastPaths of [true, false])
    {
        assert.equal(await createJScriptEngine({ fastPaths }).run(text), '1001234');
    }
});
