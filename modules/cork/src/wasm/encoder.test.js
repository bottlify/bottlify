/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body, EMPTY, ModuleBuilder, ValType, leb128s32, leb128s64, leb128u } from './encoder.js';
import { features } from './features.js';

/**
 * Instantiates a built module, saying why when the engine refuses it: a
 * `validate` that answers false names nothing, and the error from a
 * compile does.
 *
 * @param {ModuleBuilder} m @param {WebAssembly.Imports} [imports]
 */
function instantiate(m, imports = {}){
    const bytes = m.toBytes();
    if (!WebAssembly.validate(bytes))
    {
        // Throws with the engine's own message.
        new WebAssembly.Module(bytes);
    }
    return new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports;
}

test('LEB128 matches the format, negative constants included', ()=>{
    assert.deepEqual(leb128u(0), [0x00]);
    assert.deepEqual(leb128u(127), [0x7f]);
    assert.deepEqual(leb128u(128), [0x80, 0x01]);
    assert.deepEqual(leb128u(624485), [0xe5, 0x8e, 0x26]);
    assert.deepEqual(leb128u(0xffffffff), [0xff, 0xff, 0xff, 0xff, 0x0f]);
    assert.throws(()=>leb128u(-1), /not an unsigned/);
    assert.deepEqual(leb128s32(0), [0x00]);
    assert.deepEqual(leb128s32(-1), [0x7f]);
    assert.deepEqual(leb128s32(63), [0x3f]);
    assert.deepEqual(leb128s32(64), [0xc0, 0x00]);
    assert.deepEqual(leb128s32(-64), [0x40]);
    assert.deepEqual(leb128s32(-123456), [0xc0, 0xbb, 0x78]);
    assert.deepEqual(leb128s32(0x80000000), [0x80, 0x80, 0x80, 0x80, 0x78],
        'as its 32-bit pattern');
    assert.deepEqual(leb128s32(0xffffffff), [0x7f], 'the same pattern as -1');
    assert.deepEqual(leb128s64(-1n), [0x7f]);
    assert.deepEqual(leb128s64(0x7fffffffffffffffn),
        [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
});

test('a function adding two i32s validates, instantiates and runs', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [ValType.i32, ValType.i32], results: [ValType.i32] });
    m.function(type, [], new Body().localGet(0).localGet(1).op(0x6a).toBytes(),
        { exportAs: 'add' });
    const { add } = /** @type {any} */ (instantiate(m));
    assert.equal(add(2, 3), 5);
    assert.equal(add(0x7fffffff, 1) | 0, -0x80000000);
});

test('an imported memory is read through a load with an offset', ()=>{
    const memory = new WebAssembly.Memory({ initial: 1 });
    new DataView(memory.buffer).setUint32(8, 0x11223344, true);
    const m = new ModuleBuilder();
    m.importMemory('env', 'memory', { min: 1 });
    const type = m.type({ params: [], results: [ValType.i32] });
    m.function(type, [], new Body().i32const(0).load('i32', { offset: 8 }).toBytes(),
        { exportAs: 'read' });
    m.function(type, [], new Body().i32const(0).load('i32_8u', { offset: 11 }).toBytes(),
        { exportAs: 'readByte' });
    const { read, readByte } = /** @type {any} */ (instantiate(m, { env: { memory } }));
    assert.equal(read(), 0x11223344);
    assert.equal(readByte(), 0x11);
});

test('a store lands in the memory at the offset asked', ()=>{
    // An import that declares a maximum links only against a memory that has
    // one -- the reason the translator declares none against the emulator's.
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const m = new ModuleBuilder();
    m.importMemory('env', 'memory', { min: 1, max: 1 });
    const type = m.type({ params: [ValType.i32, ValType.i32], results: [] });
    m.function(type, [],
        new Body().localGet(0).localGet(1).store('i32_16', { offset: 0x100 }).toBytes(),
        { exportAs: 'store16' });
    const { store16 } = /** @type {any} */ (instantiate(m, { env: { memory } }));
    store16(4, 0xabcd);
    assert.equal(new DataView(memory.buffer).getUint16(0x104, true), 0xabcd);
    assert.equal(new DataView(memory.buffer).getUint16(0x106, true), 0, 'and only two bytes');
});

test('a global set inside a function reads back from JS, and an imported one is seen', ()=>{
    const m = new ModuleBuilder();
    const imported = m.importGlobal('env', 'base', ValType.i32, false);
    const counter = m.global(ValType.i32, true, 7);
    m.exportGlobal('counter', counter);
    const type = m.type({ params: [], results: [ValType.i32] });
    m.function(type, [],
        new Body().globalGet(counter).i32const(1).op(0x6a).globalSet(counter)
            .globalGet(counter).globalGet(imported).op(0x6a).toBytes(),
        { exportAs: 'bump' });
    const base = new WebAssembly.Global({ value: 'i32', mutable: false }, 100);
    const exports = /** @type {any} */ (instantiate(m, { env: { base } }));
    assert.equal(exports.bump(), 108);
    assert.equal(exports.counter.value, 8);
});

test('br_table dispatches to the case asked and to the fallback beyond them', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
    // block $out (result i32)
    //   block $fb block $c2 block $c1 block $c0  (local 0) br_table $c0 $c1 $c2 $fb  end
    //   i32.const 10 br $out end  i32.const 20 br $out end  i32.const 30 br $out end
    //   i32.const 99 end
    // Every label of a br_table must have the same arity, so the fallback is
    // a block of its own rather than the outer one that carries the result.
    const b = new Body();
    b.block(ValType.i32);
    b.block(EMPTY).block(EMPTY).block(EMPTY).block(EMPTY);
    b.localGet(0).brTable([0, 1, 2], 3);
    b.end().i32const(10).br(3);
    b.end().i32const(20).br(2);
    b.end().i32const(30).br(1);
    b.end().i32const(99).br(0);
    b.end();
    m.function(type, [], b.toBytes(), { exportAs: 'pick' });
    const { pick } = /** @type {any} */ (instantiate(m));
    assert.deepEqual([pick(0), pick(1), pick(2), pick(3), pick(-1)], [10, 20, 30, 99, 99]);
});

test('a loop with locals counts down and returns', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
    // local 1 = sum; loop: sum += n; n -= 1; br_if n != 0; end; return sum
    const b = new Body();
    b.loop(EMPTY);
    b.localGet(1).localGet(0).op(0x6a).localSet(1);
    b.localGet(0).i32const(1).op(0x6b).localTee(0);
    b.brIf(0);
    b.end();
    b.localGet(1);
    m.function(type, [ValType.i32], b.toBytes(), { exportAs: 'sum' });
    const { sum } = /** @type {any} */ (instantiate(m));
    assert.equal(sum(100), 5050);
});

test('a v128 add of four floats stores the lanes', { skip: !features().simd && 'no simd' }, ()=>{
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(memory.buffer);
    [1, 2, 3, 4].forEach((lane, i)=>view.setFloat32(i * 4, lane, true));
    [10, 20, 30, 40].forEach((lane, i)=>view.setFloat32(16 + i * 4, lane, true));
    const m = new ModuleBuilder();
    m.importMemory('env', 'memory', { min: 1 });
    const type = m.type({ params: [], results: [] });
    // f32x4.add is SIMD opcode 228
    m.function(type, [],
        new Body().i32const(32).i32const(0).loadV128().i32const(16).loadV128().simd(228)
            .storeV128().toBytes(),
        { exportAs: 'add4' });
    /** @type {any} */ (instantiate(m, { env: { memory } })).add4();
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(32 + i * 4, true)), [11, 22, 33, 44]);
});

test('a tail call to a sibling through the table',
    { skip: !features().tailCalls && 'no tail calls' }, ()=>{
        const m = new ModuleBuilder();
        const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
        m.table(2);
        const doubler = m.function(type, [], new Body().localGet(0).i32const(2).op(0x6c).toBytes());
        // f(x) = return_call doubler(x + 1); g(x) = return_call_indirect table[1](x)
        m.function(type, [],
            new Body().localGet(0).i32const(1).op(0x6a).returnCall(doubler).toBytes(),
            { exportAs: 'f' });
        m.function(type, [], new Body().localGet(0).i32const(0).returnCallIndirect(type).toBytes(),
            { exportAs: 'g' });
        m.element(0, [doubler, doubler]);
        const { f, g } = /** @type {any} */ (instantiate(m));
        assert.equal(f(20), 42);
        assert.equal(g(21), 42);
    });

test('a named function is in the name section a profiler reads', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [], results: [ValType.i32] });
    const index = m.function(type, [], new Body().i32const(7).toBytes(), { exportAs: 'f' });
    m.nameFunction(index, 'r00401000');
    const bytes = m.toBytes();
    assert.ok(WebAssembly.validate(bytes), 'valid with the section');
    const module = new WebAssembly.Module(bytes);
    const [section] = WebAssembly.Module.customSections(module, 'name');
    assert.ok(section, 'a name section');
    assert.ok(new TextDecoder().decode(section).includes('r00401000'));
    assert.equal(/** @type {any} */ (new WebAssembly.Instance(module).exports).f(), 7);
});

test('a hinted branch past an import names its function by index and its offset in the body', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
    m.importFunction('env', 'ignored', type);
    // f(x) = x ? 2 : 3, the if hinted unlikely; a register load put in ahead
    // of it afterwards, as the region emitter's deferred loads are.
    const b = new Body().localGet(0).unlikely().if(ValType.i32).i32const(2).else().i32const(3)
        .end();
    const at = b.hints[0];
    b.insert(0, new Body().i32const(0).localSet(1));
    assert.equal(b.hints[0], at + 4, 'moved with the bytes put in ahead of it');
    const bytes = b.toBytes();
    assert.equal(bytes[b.hints[0]], 0x04, 'the hint names the if');
    m.function(type, [ValType.i32, ValType.i32], bytes, { exportAs: 'f', hints: b.hints });
    const built = m.toBytes();
    assert.ok(WebAssembly.validate(built));
    const module = new WebAssembly.Module(built);
    const [section] = WebAssembly.Module.customSections(module, 'metadata.code.branch_hint');
    // One function (index 1, after the import) with one hint: its offset
    // from the body's start -- the local declarations (one entry: 2 × i32,
    // three bytes with its count) before the instructions -- a size of 1
    // and 0, unlikely.
    assert.deepEqual([...new Uint8Array(section)], [1, 1, 1, 3 + b.hints[0], 1, 0]);
    const { f } = /** @type {any} */ (new WebAssembly.Instance(module,
        { env: { ignored: ()=>0 } }).exports);
    assert.equal(f(1), 2);
    assert.equal(f(0), 3);
});

test('a branch marked unlikely is named in the branch-hint section, at its offset past the locals',
    ()=>{
        // (x) => x ? 7 : 5, its `if` marked unlikely and code put in before it afterwards,
        // as a region's register loads are.
        const m = new ModuleBuilder();
        const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
        const b = new Body().i32const(5).localSet(1);
        const at = b.length;
        b.localGet(0).unlikely().if(EMPTY).i32const(7).localSet(1).end().localGet(1);
        b.insert(at, new Body().i32const(0).drop());
        const body = b.toBytes();
        m.function(type, [ValType.i32], body, { exportAs: 'f', hints: b.hints });
        const bytes = m.toBytes();
        const module = new WebAssembly.Module(bytes);
        const [section] = WebAssembly.Module.customSections(module, 'metadata.code.branch_hint');
        // One function (index 0) with one hint: its offset, a size of 1, and 0 for unlikely.
        const [functions, index, hints, offset, size, value] = new Uint8Array(section);
        assert.deepEqual([functions, index, hints, size, value], [1, 0, 1, 1, 0]);
        // The offset counts the local declarations: one run, of one i32.
        assert.equal(body[offset - 3], 0x04, 'an if');
        const { f } = /** @type {any} */ (new WebAssembly.Instance(module).exports);
        assert.deepEqual([f(0), f(1)], [5, 7]);
    });

test('a body with a block left open is refused with its depth', ()=>{
    const b = new Body().block(EMPTY).i32const(1).drop();
    assert.throws(()=>b.toBytes(), { message: 'encoder: block left open (1 deep)' });
    assert.throws(()=>new Body().end(), { message: 'encoder: end with no block open' });
    assert.throws(()=>new Body().else(), { message: 'encoder: else outside any if' });
    assert.throws(()=>new Body().v128const([1, 2, 3]), /sixteen bytes/);
});

test('imports index before functions, and the builder refuses the other order', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [], results: [] });
    m.function(type, [], new Body().toBytes());
    assert.throws(()=>m.importFunction('env', 'late', type), /imports come before functions/);

    const ordered = new ModuleBuilder();
    const t = ordered.type({ params: [], results: [ValType.i32] });
    const imported = ordered.importFunction('env', 'seven', t);
    assert.equal(imported, 0);
    const own = ordered.function(t, [], new Body().call(imported).i32const(1).op(0x6a).toBytes(),
        { exportAs: 'eight' });
    assert.equal(own, 1);
    const { eight } = /** @type {any} */ (instantiate(ordered, { env: { seven: ()=>7 } }));
    assert.equal(eight(), 8);
    assert.equal(ordered.type({ params: [], results: [ValType.i32] }), t, 'a type is deduplicated');
});

test('an imported table is called through, with a tail call where the engine has them', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
    m.importTable('env', 'table', 0);
    // f(x) = table[x](x + 1), as a tail call when possible.
    const body = new Body().localGet(0).i32const(1).op(0x6a).localGet(0);
    if (features().tailCalls)
    {
        body.returnCallIndirect(type, 0);
    }
    else
    {
        body.callIndirect(type, 0);
    }
    m.function(type, [], body.toBytes(), { exportAs: 'f' });
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
    const instance = new WebAssembly.Instance(new WebAssembly.Module(m.toBytes()),
        { env: { table } });
    const { f } = /** @type {any} */ (instance.exports);
    const doubler = new WebAssembly.Instance(new WebAssembly.Module(
        (()=>{
            const d = new ModuleBuilder();
            const t = d.type({ params: [ValType.i32], results: [ValType.i32] });
            d.function(t, [], new Body().localGet(0).i32const(2).op(0x6c).toBytes(),
                { exportAs: 'g' });
            return d.toBytes();
        })()), {}).exports.g;
    table.set(0, doubler);
    table.set(1, doubler);
    assert.equal(f(0), 2, 'table[0](1)');
    assert.equal(f(1), 4, 'table[1](2)');
    assert.throws(()=>m.table(1), /one table/);
    assert.throws(()=>new Body().op(/** @type {any} */ (undefined)), /no such opcode/);
});
