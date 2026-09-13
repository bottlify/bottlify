/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCxxFunctions } from './cxx.js';
import { fakeMemory } from './harness.test.js';

/**
 * Builds the RTTI graph a compiler emits for one class, laid out exactly as
 * `dynamic_cast` expects to find it.
 *
 * The shape under test is a class Derived with two non-virtual bases, Base at
 * offset 0 and Second at offset 8 -- the arrangement where a cast that ignores
 * the offset returns a plausible pointer to the wrong subobject.
 */
/** @param {any} memory */
function buildHierarchy(memory){
    /** @param {string} name */
    const typeDescriptor = name=>{
        const at = memory.allocate(16 + name.length);
        memory.setU32(at, 0);
        memory.writeMemory(at + 8, new Uint8Array(
            [...name].map(character=>character.charCodeAt(0)).concat(0)));
        return at;
    };

    const types = {
        derived: typeDescriptor('.?AVDerived@@'),
        base: typeDescriptor('.?AVBase@@'),
        second: typeDescriptor('.?AVSecond@@'),
        stranger: typeDescriptor('.?AVStranger@@'),
    };

    /** @param {number} type @param {number} mdisp */
    const baseDescriptor = (type, mdisp)=>{
        const at = memory.allocate(24);
        memory.setU32(at, type);
        memory.setU32(at + 4, 0);
        memory.setU32(at + 8, mdisp);
        memory.setU32(at + 12, 0xffffffff); // pdisp: not a virtual base
        memory.setU32(at + 16, 0);
        return at;
    };

    const descriptors = [
        baseDescriptor(types.derived, 0),
        baseDescriptor(types.base, 0),
        baseDescriptor(types.second, 8),
    ];
    const array = memory.allocate(descriptors.length * 4);
    descriptors.forEach((descriptor, index)=>memory.setU32(array + index * 4, descriptor));

    const hierarchy = memory.allocate(16);
    memory.setU32(hierarchy + 8, descriptors.length);
    memory.setU32(hierarchy + 12, array);

    /**
     * A complete object with a vtable whose slot -1 points at the locator.
     *
     * @param {number} offset  Where this subobject sits inside the object.
     */
    const object = offset=>{
        const locator = memory.allocate(20);
        memory.setU32(locator + 4, offset);
        memory.setU32(locator + 12, types.derived);
        memory.setU32(locator + 16, hierarchy);

        const vtable = memory.allocate(16);
        memory.setU32(vtable, locator);
        const instance = memory.allocate(32);
        memory.setU32(instance, vtable + 4);
        return instance;
    };

    return { types, object };
}

const build = ()=>{
    const memory = fakeMemory();
    /** @type {string[]} */
    const aborted = [];
    return {
        memory,
        aborted,
        graph: buildHierarchy(memory),
        table: /** @type {Record<string, any>} */ (createCxxFunctions({
            readMemory: memory.readMemory,
            readCString: memory.readCString,
            abort: message=>aborted.push(message),
        })),
    };
};

test('a cast to a base at offset zero answers the same address', ()=>{
    const { graph, table } = build();
    const instance = graph.object(0);
    assert.equal(table.__RTDynamicCast.handler(
        [instance, 0, graph.types.derived, graph.types.base, 0]), instance);
});

test('a cast to a base further in adds that base\'s offset', ()=>{
    const { graph, table } = build();
    const instance = graph.object(0);
    assert.equal(table.__RTDynamicCast.handler(
        [instance, 0, graph.types.derived, graph.types.second, 0]), instance + 8);
});

test('a type that is not a base of this object casts to null', ()=>{
    const { graph, table } = build();
    const instance = graph.object(0);
    assert.equal(table.__RTDynamicCast.handler(
        [instance, 0, graph.types.derived, graph.types.stranger, 0]), 0);
});

test('casting null is null rather than a read through zero', ()=>{
    const { graph, table } = build();
    assert.equal(table.__RTDynamicCast.handler(
        [0, 0, graph.types.derived, graph.types.base, 0]), 0);
});

test('the locator\'s offset reaches the complete object from a subobject', ()=>{
    const { graph, table } = build();
    // A pointer to the Second subobject: its locator records that it sits
    // eight bytes into the complete object.
    const subobject = graph.object(8);
    assert.equal(table.__RTDynamicCast.handler(
        [subobject, 0, graph.types.second, graph.types.base, 0]), subobject - 8);
});

test('the delta argument is subtracted before anything else is read', ()=>{
    const { graph, table } = build();
    const instance = graph.object(0);
    // A caller holding a pointer four bytes into its own subobject.
    assert.equal(table.__RTDynamicCast.handler(
        [instance + 4, 4, graph.types.derived, graph.types.second, 0]), instance + 8);
});

test('two descriptors for one type match by name across images', ()=>{
    const { memory, graph, table } = build();
    const instance = graph.object(0);
    // A second image's descriptor for the same class: a different address,
    // the same decorated name.
    const elsewhere = memory.allocate(32);
    memory.writeMemory(elsewhere + 8, new Uint8Array(
        [...'.?AVSecond@@'].map(character=>character.charCodeAt(0)).concat(0)));
    assert.equal(table.__RTDynamicCast.handler(
        [instance, 0, graph.types.derived, elsewhere, 0]), instance + 8);
});

test('__RTtypeid answers the complete object\'s own type descriptor', ()=>{
    const { graph, table } = build();
    assert.equal(table.__RTtypeid.handler([graph.object(0)]), graph.types.derived);
    assert.equal(table.__RTtypeid.handler([0]), 0);
});

test('__RTCastToVoid yields the complete object, whichever subobject it started from', ()=>{
    const { graph, table } = build();
    const subobject = graph.object(8);
    assert.equal(table.__RTCastToVoid.handler([subobject]), subobject - 8);
});

test('a pure virtual call stops the program rather than returning', ()=>{
    const { aborted, table } = build();
    table._purecall.handler([]);
    assert.deepEqual(aborted, ['pure virtual function call']);
});

test('terminate stops it too, by the decorated name a compiler emits', ()=>{
    const { aborted, table } = build();
    table['?terminate@@YAXXZ'].handler([]);
    assert.deepEqual(aborted, ['terminate']);
});

test('raw_name is the decorated name inside the descriptor; the destructor pops nothing', ()=>{
    // typeid(x) == typeid(y) is a strcmp of raw_name(): an answer of zero
    // there is a null pointer handed to strcmp. Both are thiscall, with `this`
    // in ECX and nothing on the stack, so the stub must pop nothing.
    const { graph, memory, table } = build();
    const raw = table['?raw_name@type_info@@QBEPBDXZ'];
    assert.equal(memory.readCString(raw.handler([graph.types.derived]), 64), '.?AVDerived@@');
    assert.equal(raw.convention, 'thiscall');
    assert.equal(raw.argBytes, 4);
    const destructor = table['??1type_info@@UAE@XZ'];
    assert.equal(destructor.handler([graph.types.derived]), 0);
    assert.equal(destructor.convention, 'thiscall');
    assert.equal(destructor.argBytes, 4);
});
