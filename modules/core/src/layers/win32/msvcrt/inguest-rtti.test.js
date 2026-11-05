/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dynamic_cast in the guest, against its x86: a hierarchy laid out as the
 * compiler lays it out (a type descriptor per class, base class descriptors,
 * a hierarchy, a locator below each vtable), each cast made through the
 * JavaScript and through the compiled bytes on cork's test machine, and the
 * answer held to the base's address.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-rtti.x86.js';
import * as sources from './inguest-rtti.js';
import { DATA, equivalence } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

/**
 * A class Derived with bases Base at 0, Second at 8 and, through a virtual
 * base table, Virtual, and one whose name is 600 letters long; a type Stranger
 * that is no base of it; a second descriptor of Base, as another image has,
 * with the same name; and one named as the long base up to 512 bytes and not past.
 */
function hierarchy(){
    const image = new Uint8Array(0x2000);
    const view = new DataView(image.buffer);
    let next = 0;
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = next;
        next += (bytes + 15) & ~15;
        return at;
    };
    /** @param {number} at @param {number} value */
    const set = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {string} name */
    const type = name=>{
        const at = allocate(8 + name.length + 1);
        image.set([...name].map(character=>character.charCodeAt(0)), at + 8);
        return DATA + at;
    };
    const types = {
        derived: type('.?AVDerived@@'), base: type('.?AVBase@@'), second: type('.?AVSecond@@'),
        virtual: type('.?AVVirtual@@'), stranger: type('.?AVStranger@@'),
        otherBase: type('.?AVBase@@'), long: type(`.?AV${'L'.repeat(600)}@@`),
        longOther: type(`.?AV${'L'.repeat(600)}@@X`),
    };
    /** @param {number} of @param {number} mdisp @param {number} pdisp @param {number} vdisp */
    const base = (of, mdisp, pdisp = -1, vdisp = 0)=>{
        const at = allocate(28);
        set(at, of);
        set(at + 8, mdisp);
        set(at + 12, pdisp);
        set(at + 16, vdisp);
        return DATA + at;
    };
    const bases = [base(types.derived, 0), base(types.base, 0), base(types.second, 8),
        base(types.virtual, 0, 16, 4), base(types.long, 4)];
    const array = allocate(bases.length * 4);
    bases.forEach((descriptor, index)=>set(array + index * 4, descriptor));
    const chain = allocate(16);
    set(chain + 8, bases.length);
    set(chain + 12, DATA + array);
    // A complete object of 48 bytes whose virtual base table, at 16, says
    // the virtual base sits 24 bytes past it.
    const complete = allocate(48);
    const table = allocate(8);
    set(table + 4, 24);
    set(complete + 16, DATA + table);
    /** A vtable pointer at `offset` into the object, whose locator says so. @param {number} offset */
    const subobject = offset=>{
        const locator = allocate(20);
        set(locator + 4, offset);
        set(locator + 12, types.derived);
        set(locator + 16, DATA + chain);
        const vtable = allocate(8);
        set(vtable, DATA + locator);
        set(complete + offset, DATA + vtable + 4);
        return DATA + complete + offset;
    };
    return { image, types, subobject, complete: DATA + complete };
}

/** @param {ReturnType<typeof hierarchy>} graph @param {number[]} stack */
const cast = (graph, stack)=>same('__RTDynamicCast',
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
