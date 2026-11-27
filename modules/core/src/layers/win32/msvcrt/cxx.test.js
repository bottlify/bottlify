/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHKESP_CODE, createCxxFunctions, EH_PROLOG_CODE } from './cxx.js';
import { fakeMemory } from './harness.test.js';
import { guestWindow } from './guest-window.fixture.js';

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
            guest: memory.guest,
            abort: message=>aborted.push(message),
        })),
    };
};

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

test('raw_name is the decorated name inside the descriptor, and pops nothing', ()=>{
    // typeid(x) == typeid(y) is a strcmp of raw_name(): an answer of zero
    // there is a null pointer handed to strcmp. It is thiscall, with `this`
    // in ECX and nothing on the stack, so the stub must pop nothing.
    const { graph, memory, table } = build();
    const raw = table['?raw_name@type_info@@QBEPBDXZ'];
    assert.equal(memory.readCString(raw.handler([graph.types.derived]), 64), '.?AVDerived@@');
    assert.equal(raw.convention, 'thiscall');
    assert.equal(raw.argBytes, 4);
});

test('_EH_prolog is code of its own, not a variable: it lies in .text, apart from the data', ()=>{
    // A `data` export shares a page with the runtime's variables, which the
    // host writes; a translator drops code on a page the host writes to.
    const { table } = build();
    assert.equal(table._EH_prolog.data, undefined);
    assert.deepEqual(table._EH_prolog.code(), EH_PROLOG_CODE);
});

test('_chkesp is a bare ret in the guest: the checked result in EAX and the flags stay', ()=>{
    const { table } = build();
    assert.equal(table._chkesp.data, undefined);
    assert.equal(table._chkesp.handler, undefined, 'no host crossing to answer in EAX');
    assert.deepEqual([...table._chkesp.code()], [0xc3]);
    assert.equal(CHKESP_CODE, table._chkesp.code());
});

test('at 64 bits past 4 GiB: the locator a whole pointer below the vtable, its type an offset'
    + ' from the image', ()=>{
    // MSVC's x64 RTTICompleteObjectLocator: signature 1, offset, cdOffset,
    // then the type descriptor, the hierarchy and the locator itself as
    // offsets from the image's base (pSelf); a type descriptor is two
    // pointers and then the decorated name.
    const image = 0x140000000;
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    /** @param {number} at @param {number} value */
    const quad = (at, value)=>{
        view.setUint32(at, value % 2 ** 32, true);
        view.setUint32(at + 4, Math.floor(value / 2 ** 32), true);
    };
    const TYPE = 0x2000;
    bytes.set([...'.?AVDerived@@\0'].map(c=>c.charCodeAt(0)), TYPE + 16);
    const LOCATOR = 0x2100;
    view.setUint32(LOCATOR, 1, true);
    view.setUint32(LOCATOR + 4, 16, true);
    view.setUint32(LOCATOR + 12, TYPE, true);
    view.setUint32(LOCATOR + 20, LOCATOR, true);
    const VTABLE = 0x2208;
    quad(VTABLE - 8, image + LOCATOR);
    const OBJECT = 0x3000;
    quad(OBJECT + 16, image + VTABLE);
    const table = /** @type {Record<string, any>} */ (createCxxFunctions({
        guest: guestWindow(bytes, { base: image, pointerSize: 8 }) }));
    const subobject = image + OBJECT + 16;
    assert.equal(table.__RTtypeid.handler([subobject]), image + TYPE);
    assert.equal(table.__RTCastToVoid.handler([subobject]), image + OBJECT);
    const raw = table['?raw_name@type_info@@QEBAPEBDXZ'];
    assert.equal(raw.handler([image + TYPE]), image + TYPE + 16, 'past the two pointers');
});
