import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpatial, DS3DLISTENER, DS3DBUFFER } from './spatial.js';

const DSERR_INVALIDPARAM = 0x80070057 | 0;

function fixture(){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    const memory = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} data */
        writeMemory: (at, data)=>bytes.set(data, at),
    };
    /** @param {number} value */
    const bits = value=>{
        const scratch = new DataView(new ArrayBuffer(4));
        scratch.setFloat32(0, value, true);
        return scratch.getUint32(0, true);
    };
    /** @param {number} at */
    const f32 = at=>view.getFloat32(at, true);
    return { ...createSpatial({ memory }), view, bits, f32 };
}

test('the listener starts where Windows puts it, facing ahead with its head up', ()=>{
    const f = fixture();
    const primary = {};
    assert.equal(f.listenerMethods.GetOrientation(primary, [0x100, 0x200]), 0);
    assert.deepEqual([f.f32(0x100), f.f32(0x104), f.f32(0x108)], [0, 0, 1]);
    assert.deepEqual([f.f32(0x200), f.f32(0x204), f.f32(0x208)], [0, 1, 0]);
    assert.equal(f.listenerMethods.GetAllParameters(primary, [0x300]), DSERR_INVALIDPARAM,
        'a structure that does not say its size');
    f.view.setUint32(0x300, DS3DLISTENER.SIZE, true);
    assert.equal(f.listenerMethods.GetAllParameters(primary, [0x300]), 0);
    assert.equal(f.f32(0x300 + DS3DLISTENER.flDopplerFactor), 1);
});

test('an orientation with a NaN, an empty vector or the two vectors parallel is refused', ()=>{
    // Wine's ds3d.c check_doppler.
    const f = fixture();
    const primary = {};
    const orient = (/** @type {number[]} */ values)=>f.listenerMethods.SetOrientation(primary,
        [...values.map(f.bits), 1]);
    assert.equal(orient([NaN, 0, 0, 0, 1, 0]), DSERR_INVALIDPARAM);
    assert.equal(orient([0, 0, 0, 0, 0, 0]), DSERR_INVALIDPARAM);
    assert.equal(orient([0, 1, 0, 0, 1, 0]), DSERR_INVALIDPARAM);
    assert.equal(orient([1, 1, 1, 1, 1, 1]), DSERR_INVALIDPARAM);
    assert.equal(orient([1, 0, 0, 2, 1, 1]), 0);
    // A NaN position is taken, and read back as one.
    assert.equal(f.listenerMethods.SetPosition(primary, [NaN, NaN, NaN].map(f.bits)), 0);
    f.listenerMethods.GetPosition(primary, [0x100]);
    assert.ok(Number.isNaN(f.f32(0x100)));
});

test('a 3D buffer keeps what it is told, deferred or not, and refuses what cannot be', ()=>{
    const f = fixture();
    const buffer = {};
    assert.equal(f.bufferMethods.SetPosition(buffer, [...[1, 2, 3].map(f.bits), 1]), 0);
    f.bufferMethods.GetPosition(buffer, [0x100]);
    assert.deepEqual([f.f32(0x100), f.f32(0x104), f.f32(0x108)], [1, 2, 3],
        'a deferred change is read back at once');
    assert.equal(f.bufferMethods.SetConeAngles(buffer, [361, 0, 0]), DSERR_INVALIDPARAM);
    assert.equal(f.bufferMethods.SetMode(buffer, [3, 0]), DSERR_INVALIDPARAM);
    f.view.setUint32(0x200, DS3DBUFFER.SIZE, true);
    assert.equal(f.bufferMethods.GetAllParameters(buffer, [0x200]), 0);
    assert.equal(f.view.getUint32(0x200 + DS3DBUFFER.dwInsideConeAngle, true), 360);
    assert.equal(f.f32(0x200 + DS3DBUFFER.flMaxDistance), 1e9);
    assert.equal(f.bufferMethods.GetAllParameters(buffer, [0]), DSERR_INVALIDPARAM);
});
