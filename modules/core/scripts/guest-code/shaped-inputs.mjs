/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The inputs of the functions whose arguments only agree in a shape of their
 * own, for the gate of the x86-64 (`long.test.js`): an object and the offset
 * of the subobject it is held by, say, which no text, count or pointer taken
 * apart from the others meets - every such input is read out of bounds, and
 * the gate would hold the code to nothing. By the module's path under src/,
 * then the function's name.
 *
 * `__RTDynamicCast` reads a graph the compiler laid out and the object's own
 * vtable pointer: a class hierarchy laid out as the 64-bit compiler lays out
 * its RTTI (`class-graph.mjs`), each cast from one of the object's
 * subobjects with the delta that reaches it, to one of the hierarchy's types
 * or to a name that is none, or from null.
 *
 * `_atoi64` hands the host only a value past 64 bits, which random bytes
 * never spell: a decimal text after white space and a sign, as long as 22
 * digits, so the value passes 2^63 about one time in three.
 *
 * `_nextafter` hands the host only the step past the largest double, which
 * random bits never ask for: one input in four is that double, of either
 * sign, with a direction of either sign.
 *
 * For the tests: no part of the product.
 */

import { DATA, doubleWords } from './equivalence.mjs';
import { classGraph } from './class-graph.mjs';

/**
 * @typedef {(next: () => number) =>
 *     { stack: number[], memory: [number, Uint8Array][], bounds: [number, number] }} ShapedInput
 */

const graph = classGraph(DATA, { bits: 64, long: true });
/** The subobjects a caller holds, each with the delta it passes. */
const holders = [[graph.subobject(0), 0], [graph.subobject(8), 0], [graph.complete + 4, 4]];
const types = Object.values(graph.types);

/** The pages a conversion takes in the guest, and once in a while one it does not. */
const PAGES = [0, 1252, 65001];
/** A page the conversion is called with. @param {() => number} next */
const pageOf = next=>(next() % 8 === 0 ? 932 + next() % 4 : PAGES[next() % PAGES.length]);
/**
 * A text of `units` units of `size` bytes, ASCII but for one unit past 0x7f now
 * and then, and a NUL after it.
 *
 * @param {() => number} next @param {number} units @param {1 | 2} size
 */
const textOf = (next, units, size)=>{
    const bytes = new Uint8Array((units + 1) * size);
    for (let i = 0; i < units; i++)
    {
        bytes[i * size] = 0x20 + next() % 0x5f;
    }
    if (units > 0 && next() % 6 === 0)
    {
        bytes[(next() % units) * size] = 0x80 + next() % 0x7f;
    }
    return bytes;
};
/**
 * A conversion's lengths and buffers: the source a count of units, -1 (to its
 * NUL) or zero; the destination none (a size asked), room for all, or short.
 *
 * @param {() => number} next @param {1 | 2} from @param {1 | 2} to
 */
const conversion = (next, from, to)=>{
    const units = next() % 40;
    const source = textOf(next, units, from);
    const length = [units, units, -1, 0][next() % 4];
    const needed = length === -1 ? units + 1 : length;
    const room = [0, needed + next() % 4, Math.max(0, needed - 1 - next() % 3)][next() % 3];
    const at = DATA + ((source.length + 15) & -16);
    const destination = room === 0 && next() % 2 === 0 ? 0 : at;
    const end = at + room * to + 16;
    const memory = new Uint8Array(end - DATA);
    memory.set(source);
    return { length: length >>> 0, destination, room, memory, end };
};

/** @type {Record<string, Record<string, ShapedInput>>} */
export const SHAPED_INPUTS = {
    'layers/win32/kernel32/inguest.js': {
        MultiByteToWideChar: next=>{
            const c = conversion(next, 1, 2);
            const flags = next() % 6 === 0 ? 0x10 : [0, 1, 8][next() % 3];
            return { stack: [pageOf(next), flags, DATA, c.length, c.destination, c.room],
                memory: [[DATA, c.memory]], bounds: [DATA, c.end] };
        },
        WideCharToMultiByte: next=>{
            const c = conversion(next, 2, 1);
            const flags = next() % 6 === 0 ? 0x200 : 0;
            const used = next() % 3 === 0 ? c.end - 8 : 0;
            return { stack: [pageOf(next), flags, DATA, c.length, c.destination, c.room, 0, used],
                memory: [[DATA, c.memory]], bounds: [DATA, c.end] };
        },
    },
    'layers/win32/msvcrt/inguest-rtti.js': {
        __RTDynamicCast: next=>{
            const [object, delta] = next() % 16 === 0 ? [0, 0]
                : holders[next() % holders.length];
            // A type of the hierarchy, or a name in the graph that is none:
            // the middle of another's, which compares unlike it.
            const to = next() % 8 === 0 ? types[next() % types.length] + 1 + next() % 8
                : types[next() % types.length];
            return { stack: [object, delta, types[next() % types.length], to, 0],
                memory: [[DATA, graph.image]], bounds: [DATA, DATA + graph.image.length] };
        },
    },
    'layers/win32/msvcrt/inguest-float.js': {
        _nextafter: next=>{
            const some = ()=>[next(), next()];
            const largest = doubleWords(next() % 2 === 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
            const x = next() % 4 === 0 ? largest : some();
            const y = next() % 2 === 0 ? doubleWords(next() % 2 === 0 ? Infinity : -Infinity)
                : some();
            return { stack: [...x, ...y], memory: [], bounds: [DATA, DATA] };
        },
    },
    'layers/win32/msvcrt/inguest-int64.js': {
        _atoi64: next=>{
            const digits = Array.from({ length: next() % 23 }, ()=>0x30 + next() % 10);
            const space = [[], [0x20], [0x20, 0x09]][next() % 3];
            const text = Uint8Array.of(...space, ...[[], [0x2d], [0x2b]][next() % 3], ...digits, 0);
            return { stack: [DATA], memory: [[DATA, text]], bounds: [DATA, DATA + text.length] };
        },
    },
};
