/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dynamic_cast in the guest, against its x86: a hierarchy laid out as the
 * compiler lays it out (`class-graph.mjs`: a type descriptor per class, base
 * class descriptors, a hierarchy, a locator below each vtable), each cast made
 * through the JavaScript and through the compiled bytes on cork's test
 * machine, and the answer held to the base's address - the i386 over the
 * 32-bit layout, the x86-64 over the 64-bit one, whose words are offsets into
 * the image.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-rtti.x86.js';
import { COMPILED as LONG } from './inguest-rtti.x64.js';
import * as sources from './inguest-rtti.js';
import { DATA, equivalence } from '../../../../scripts/guest-code/equivalence.mjs';
import { classGraph } from '../../../../scripts/guest-code/class-graph.mjs';

const { same, sameAt64 } = equivalence(COMPILED, sources, undefined, LONG);

/** The hierarchy at DATA, with the long names. */
const hierarchy = ()=>classGraph(DATA, { long: true });

/** @param {ReturnType<typeof hierarchy>} graph @param {number[]} stack */
const cast = (graph, stack)=>same('__RTDynamicCast',
    { stack: [...stack, 0], memory: [[DATA, graph.image]] }).eax >>> 0;

/** @param {ReturnType<typeof hierarchy>} graph @param {number[]} stack */
const cast64 = (graph, stack)=>sameAt64('__RTDynamicCast',
    { stack: [...stack, 0], memory: [[DATA, graph.image]] }).eax >>> 0;

test('a cast finds the base and adds its offset, through x86 and JavaScript alike', ()=>{
    const graph = hierarchy();
    const object = graph.subobject(0);
    const { types } = graph;
    assert.equal(cast(graph, [object, 0, types.derived, types.base]), object, 'at offset zero');
    assert.equal(cast(graph, [object, 0, types.derived, types.second]), object + 8,
        'a base further in');
    assert.equal(cast(graph, [object, 0, types.derived, types.stranger]), 0,
        'no base of this object');
    assert.equal(cast(graph, [0, 0, types.derived, types.base]), 0, 'null stays null');
});

test('the locator\'s offset and the delta reach the complete object first', ()=>{
    const graph = hierarchy();
    const { types } = graph;
    graph.subobject(0);
    const second = graph.subobject(8);
    assert.equal(cast(graph, [second, 0, types.second, types.base]), second - 8,
        'from a subobject eight bytes in');
    assert.equal(cast(graph, [graph.complete + 4, 4, types.derived, types.second]),
        graph.complete + 8, 'a caller four bytes into its own subobject');
});

test('a virtual base through the object\'s table, and a type from another image by its name', ()=>{
    const graph = hierarchy();
    const object = graph.subobject(0);
    const { types } = graph;
    assert.equal(cast(graph, [object, 0, types.derived, types.virtual]),
        graph.complete + 16 + 24, 'pdisp to the table, the table\'s entry past it');
    assert.equal(cast(graph, [object, 0, types.derived, types.otherBase]), object,
        'the same decorated name at another address');
    assert.equal(cast(graph, [object, 0, types.derived, types.longOther]), object + 4,
        'names alike in the 512 bytes compared, unlike past them');
});

test('at 64 bits a cast reads the image-relative layout to the same answers', ()=>{
    const graph = classGraph(DATA, { bits: 64, long: true });
    const { types } = graph;
    const object = graph.subobject(0);
    const second = graph.subobject(8);
    assert.equal(cast64(graph, [object, 0, types.derived, types.base]), object, 'at offset zero');
    assert.equal(cast64(graph, [object, 0, types.derived, types.second]), object + 8,
        'a base further in');
    assert.equal(cast64(graph, [object, 0, types.derived, types.stranger]), 0,
        'no base of this object');
    assert.equal(cast64(graph, [0, 0, types.derived, types.base]), 0, 'null stays null');
    assert.equal(cast64(graph, [second, 0, types.second, types.base]), second - 8,
        'from a subobject eight bytes in');
    assert.equal(cast64(graph, [graph.complete + 4, 4, types.derived, types.second]),
        graph.complete + 8, 'a caller four bytes into its own subobject');
    assert.equal(cast64(graph, [object, 0, types.derived, types.virtual]),
        graph.complete + 16 + 24, 'pdisp to the table, the table\'s entry past it');
    assert.equal(cast64(graph, [object, 0, types.derived, types.otherBase]), object,
        'the same decorated name at another address');
    assert.equal(cast64(graph, [object, 0, types.derived, types.longOther]), object + 4,
        'names alike in the 512 bytes compared, unlike past them');
});
