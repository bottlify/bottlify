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
 * For the tests: no part of the product.
 */

import { DATA } from './equivalence.mjs';
import { classGraph } from './class-graph.mjs';

/**
 * @typedef {(next: () => number) =>
 *     { stack: number[], memory: [number, Uint8Array][], bounds: [number, number] }} ShapedInput
 */

const graph = classGraph(DATA, { bits: 64, long: true });
/** The subobjects a caller holds, each with the delta it passes. */
const holders = [[graph.subobject(0), 0], [graph.subobject(8), 0], [graph.complete + 4, 4]];
const types = Object.values(graph.types);

/** @type {Record<string, Record<string, ShapedInput>>} */
export const SHAPED_INPUTS = {
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
};
