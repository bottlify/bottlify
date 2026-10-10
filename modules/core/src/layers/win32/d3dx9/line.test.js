/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLines } from './line.js';
import { deviceRig } from './device.fixture.js';

const D3DERR_INVALIDCALL = 0x8876086c;

/** @param {number} value */
const bits = value=>new Uint32Array(Float32Array.of(value).buffer)[0];

function setup(){
    const r = deviceRig();
    const lines = createLines(r.host);
    const out = r.heap.allocate(4);
    assert.equal(r.call({ handler: lines.create }, [r.device, out]), 0);
    const object = lines.objectAt(r.view.getUint32(out, true));
    /** @param {string} name @param {number[]} args */
    const invoke = (name, args = [])=>r.invoke(lines.line, name, object, args);
    /** The vertices of each DrawPrimitiveUP: x, y, z, rhw, colour. */
    const draws = ()=>r.calls.filter(c=>c[0] === 'DrawPrimitiveUP').map(([, type, count, at])=>({
        type, count, vertices: Array.from({ length: type === 2 ? count * 2 : count * 3 }, (_, k)=>
            [...r.floats(at + k * 20, 4), r.view.getUint32(at + k * 20 + 16, true)]) }));
    return { r, lines, object, invoke, draws };
}

/** @param {ReturnType<typeof deviceRig>} r @param {number[]} values */
function floatsAt(r, values){
    const at = r.heap.allocate(values.length * 4);
    r.putFloats(at, values);
    return at;
}

test('D3DXCreateLine refuses a null device or out-pointer and starts thin and solid', ()=>{
    const r = deviceRig();
    const lines = createLines(r.host);
    const out = r.heap.allocate(4);
    r.view.setUint32(out, 0xdead, true);
    assert.equal(r.call({ handler: lines.create }, [0, out]), D3DERR_INVALIDCALL);
    assert.equal(r.view.getUint32(out, true), 0, 'the out-pointer cleared');
    assert.equal(r.call({ handler: lines.create }, [r.device, 0]), D3DERR_INVALIDCALL);
    const { invoke } = setup();
    assert.equal(invoke('GetWidth'), bits(1));
    assert.equal(invoke('GetPatternScale'), bits(1));
    assert.equal(invoke('GetPattern'), 0xffffffff);
    assert.equal(invoke('GetAntialias'), 0);
    assert.equal(invoke('GetGLLines'), 0);
});

test('the setters keep what they are given; a width of zero or less is refused', ()=>{
    const { invoke } = setup();
    assert.equal(invoke('SetWidth', [bits(0)]), D3DERR_INVALIDCALL);
    assert.equal(invoke('SetWidth', [bits(-2)]), D3DERR_INVALIDCALL);
    assert.equal(invoke('SetWidth', [bits(2.5)]), 0);
    assert.equal(invoke('GetWidth'), bits(2.5));
    invoke('SetPattern', [0xf0f0f0f0]);
    invoke('SetPatternScale', [bits(4)]);
    invoke('SetAntialias', [7]);
    invoke('SetGLLines', [1]);
    assert.deepEqual([invoke('GetPattern'), invoke('GetPatternScale'), invoke('GetAntialias'),
        invoke('GetGLLines')], [0xf0f0f0f0, bits(4), 1, 1]);
});

test('Begin and End pair: a second Begin and an unpaired End are refused', async()=>{
    const { r, invoke } = setup();
    assert.equal(await invoke('Begin'), 0);
    assert.equal(invoke('Begin'), D3DERR_INVALIDCALL);
    assert.equal(await invoke('End'), 0);
    assert.equal(invoke('End'), D3DERR_INVALIDCALL);
    assert.deepEqual(r.calls[0], ['CreateStateBlock', 1, r.calls[0][2]]);
    assert.ok(r.calls.some(c=>c[0] === 'SetFVF' && c[1] === 0x44));
    assert.deepEqual(r.calls.slice(-2).map(c=>c[0]), ['Apply', 'Release'],
        'the state put back, the block let go');
});

test('a thin Draw outside Begin is a list of segments in its own Begin and End', async()=>{
    const { r, invoke, draws } = setup();
    const points = floatsAt(r, [10, 20, 30, 20, 30, 50]);
    assert.equal(await invoke('Draw', [points, 3, 0xff00ff00]), 0);
    assert.deepEqual(draws(), [{ type: 2, count: 2, vertices: [[10, 20, 0, 1, 0xff00ff00],
        [30, 20, 0, 1, 0xff00ff00], [30, 20, 0, 1, 0xff00ff00], [30, 50, 0, 1, 0xff00ff00]] }]);
    assert.equal(r.calls[0][0], 'CreateStateBlock');
    assert.deepEqual(r.calls.slice(-2).map(c=>c[0]), ['Apply', 'Release']);
    assert.equal(invoke('Draw', [0, 3, 0]), D3DERR_INVALIDCALL);
});

test('a wide line is a quad along each segment, half the width to each side', async()=>{
    const { r, invoke, draws } = setup();
    invoke('SetWidth', [bits(4)]);
    await invoke('Begin');
    const points = floatsAt(r, [0, 0, 10, 0, 10, 0]);
    assert.equal(await invoke('Draw', [points, 3, 0x80ffffff]), 0);
    await invoke('End');
    const [one] = draws();
    assert.equal(one.type, 4);
    assert.equal(one.count, 2, 'the zero-length segment adds nothing');
    assert.deepEqual(one.vertices.map(v=>v.slice(0, 2)), [[0, 2], [10, 2], [0, -2], [10, 2],
        [10, -2], [0, -2]]);
    assert.equal(r.calls.filter(c=>c[0] === 'CreateStateBlock').length, 1,
        'inside the program\'s Begin, no Begin of its own');
});

test('DrawTransform projects through the matrix into the viewport', async()=>{
    const { r, invoke, draws } = setup();
    const identity = floatsAt(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const points = floatsAt(r, [0, 0, 0.5, 1, 1, 0]);
    assert.equal(await invoke('DrawTransform', [points, 2, identity, 0xffffffff]), 0);
    assert.deepEqual(draws()[0].vertices.map(v=>v.slice(0, 4)), [[320, 240, 0.5, 1],
        [640, 0, 0, 1]]);
    // w = z: a vertex at z = 0 is at the eye and its segment is not drawn.
    const perspective = floatsAt(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
    const behind = floatsAt(r, [0, 0, 2, 2, 0, 4, 0, 0, 0]);
    r.calls.length = 0;
    assert.equal(await invoke('DrawTransform', [behind, 3, perspective, 0]), 0);
    assert.deepEqual(draws().map(d=>d.count), [1]);
    assert.deepEqual(draws()[0].vertices.map(v=>v.slice(0, 4)), [[320, 240, 1, 0.5],
        [480, 240, 1, 0.25]]);
    assert.equal(invoke('DrawTransform', [points, 2, 0, 0]), D3DERR_INVALIDCALL);
});

test('a pattern and OpenGL-style lines are told, and the line drawn solid', async()=>{
    const { r, invoke, draws } = setup();
    invoke('SetPattern', [0x0f0f0f0f]);
    invoke('SetGLLines', [1]);
    invoke('SetWidth', [bits(3)]);
    await invoke('Draw', [floatsAt(r, [0, 0, 5, 5]), 2, 0]);
    assert.equal(draws().length, 1);
    assert.deepEqual(r.diverged.map(d=>d[0]), ['ID3DXLine::Draw', 'ID3DXLine::Draw']);
});

test('GetWidth and GetPatternScale load their answer into ST0 in guest code', ()=>{
    const { r, lines } = setup();
    const method = /** @type {any} */ (lines.line.methods.find(m=>m.name === 'GetWidth'));
    const at = method.guest({ trap: 0x7000, register: ()=>0 });
    assert.deepEqual([...r.memory.subarray(at, at + 17)], [0xff, 0x74, 0x24, 0x04, 0xe8,
        ...new Uint8Array(Int32Array.of(0x7000 - (at + 9)).buffer), 0x50, 0xd9, 0x04, 0x24,
        0x58, 0xc2, 0x04, 0x00]);
    assert.equal(method.guest({ trap: 0x8000, register: ()=>0 }), at, 'placed once');
    assert.equal(lines.floatSlot('GetWidth'), at);
    const other = /** @type {any} */ (lines.line.methods.find(m=>m.name
        === 'GetPatternScale'));
    assert.notEqual(other.guest({ trap: 0x9000, register: ()=>0 }), at, 'each its own trap');
});
