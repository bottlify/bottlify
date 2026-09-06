/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DCUBEMAP_FACE, D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK,
} from './constants.js';
import { createDirect3D9 } from './device.js';

const SIZE = 128;
const BYTES_PER_PIXEL = 4;
const PITCH = SIZE * BYTES_PER_PIXEL;

/** A rectangle wholly inside the surface, and one that does not overlap it. */
const RECT = { left: 60, top: 60, right: 68, bottom: 68 };
const OTHER_RECT = { left: 0, top: 0, right: 8, bottom: 8 };

/** Sentinels: a failed lock must leave the caller's record exactly as it was. */
const SENTINEL_BITS = 0xdeadbeef;
const SENTINEL_PITCH = 1;

function createDevice(){
    const d3d = createDirect3D9();
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD }, out), D3D_OK);
    return out.device;
}

/**
 * @param {any} device
 */
function assertFullyReleased(device){
    assert.equal(device.release(), 0, 'the device reached a reference count of zero');
}

/**
 * The three ways to arrive at a surface. They differ in exactly one observable
 * way -- what a second unlock answers -- so every lock test walks all three.
 *
 * @param {any} device
 * @param {number} pool
 */
function surfaceSources(device, pool){
    /** @type {{ surface?: any }} */
    const plain = {};
    assert.equal(
        device.CreateOffscreenPlainSurface(SIZE, SIZE, D3DFMT.A8R8G8B8, pool, plain), D3D_OK);

    /** @type {{ texture?: any }} */
    const texture = {};
    assert.equal(
        device.CreateTexture(SIZE, SIZE, 1, 0, D3DFMT.A8R8G8B8, pool, texture), D3D_OK);
    /** @type {{ surface?: any }} */
    const level = {};
    assert.equal(texture.texture.GetSurfaceLevel(0, level), D3D_OK);

    /** @type {{ texture?: any }} */
    const cube = {};
    assert.equal(device.CreateCubeTexture(SIZE, 1, 0, D3DFMT.A8R8G8B8, pool, cube), D3D_OK);
    /** @type {{ surface?: any }} */
    const face = {};
    assert.equal(
        cube.texture.GetCubeMapSurface(D3DCUBEMAP_FACE.NEGATIVE_X, 0, face), D3D_OK);

    return [
        {
            name: 'offscreen plain surface',
            surface: plain.surface,
            forgivesDoubleUnlock: false,
            release: ()=>plain.surface.release(),
        },
        {
            name: 'surface level of a texture',
            surface: level.surface,
            forgivesDoubleUnlock: true,
            release: ()=>{
                level.surface.release();
                texture.texture.release();
            },
        },
        {
            name: 'face of a cube texture',
            surface: face.surface,
            forgivesDoubleUnlock: false,
            release: ()=>{
                face.surface.release();
                cube.texture.release();
            },
        },
    ];
}

test('a second lock fails and leaves the caller\'s record untouched', ()=>{
    const device = createDevice();

    for (const source of surfaceSources(device, D3DPOOL.SYSTEMMEM))
    {
        const locked = { pBits: 0, Pitch: 0 };
        assert.equal(source.surface.LockRect(locked, null, 0), D3D_OK, source.name);

        const second = { pBits: SENTINEL_BITS, Pitch: SENTINEL_PITCH };
        assert.equal(source.surface.LockRect(second, null, 0), D3DERR_INVALIDCALL, source.name);
        assert.equal(second.pBits, SENTINEL_BITS, source.name);
        assert.equal(second.Pitch, SENTINEL_PITCH, source.name);

        assert.equal(source.surface.UnlockRect(), D3D_OK, source.name);
        source.release();
    }

    assertFullyReleased(device);
});

test('a second lock of a rectangle that overlaps nothing fails too', ()=>{
    const device = createDevice();

    for (const source of surfaceSources(device, D3DPOOL.SYSTEMMEM))
    {
        const first = { pBits: 0, Pitch: 0 };
        assert.equal(source.surface.LockRect(first, RECT, 0), D3D_OK, source.name);

        const second = { pBits: SENTINEL_BITS, Pitch: SENTINEL_PITCH };
        // The lock is on the surface, not on the area: the two rectangles being
        // disjoint buys nothing.
        assert.equal(
            source.surface.LockRect(second, OTHER_RECT, 0), D3DERR_INVALIDCALL, source.name);
        assert.equal(second.pBits, SENTINEL_BITS, source.name);

        assert.equal(source.surface.UnlockRect(), D3D_OK, source.name);
        source.release();
    }

    assertFullyReleased(device);
});

test('an unlock owed nothing fails, in every pool', ()=>{
    const device = createDevice();

    for (const pool of [D3DPOOL.DEFAULT, D3DPOOL.SCRATCH, D3DPOOL.SYSTEMMEM])
    {
        /** @type {{ surface?: any }} */
        const out = {};
        assert.equal(
            device.CreateOffscreenPlainSurface(64, 64, D3DFMT.X8R8G8B8, pool, out), D3D_OK);

        assert.equal(out.surface.UnlockRect(), D3DERR_INVALIDCALL, `pool ${pool}`);

        const locked = { pBits: 0, Pitch: 0 };
        assert.equal(out.surface.LockRect(locked, null, 0), D3D_OK, `pool ${pool}`);
        assert.equal(out.surface.UnlockRect(), D3D_OK, `pool ${pool}`);
        assert.equal(out.surface.UnlockRect(), D3DERR_INVALIDCALL, `pool ${pool}`);

        out.surface.release();
    }

    assertFullyReleased(device);
});

test('a second unlock is forgiven only through a texture', ()=>{
    const device = createDevice();

    // System memory, because an offscreen plain surface cannot live in the
    // managed pool at all and the three sources have to be comparable.
    for (const source of surfaceSources(device, D3DPOOL.SYSTEMMEM))
    {
        const locked = { pBits: 0, Pitch: 0 };
        assert.equal(source.surface.LockRect(locked, null, 0), D3D_OK, source.name);
        assert.equal(source.surface.UnlockRect(), D3D_OK, source.name);

        const expected = source.forgivesDoubleUnlock ? D3D_OK : D3DERR_INVALIDCALL;
        assert.equal(source.surface.UnlockRect(), expected, source.name);

        source.release();
    }

    assertFullyReleased(device);
});

test('a partial lock reports the pixel it names, at an unchanged pitch', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};
    assert.equal(
        device.CreateOffscreenPlainSurface(SIZE, SIZE, D3DFMT.A8R8G8B8, D3DPOOL.SCRATCH, out),
        D3D_OK);

    const whole = { pBits: 0, Pitch: 0 };
    assert.equal(out.surface.LockRect(whole, null, 0), D3D_OK);
    assert.equal(whole.Pitch, PITCH);
    const base = whole.pBits;
    assert.equal(out.surface.UnlockRect(), D3D_OK);

    const part = { pBits: 0, Pitch: 0 };
    assert.equal(out.surface.LockRect(part, RECT, 0), D3D_OK);
    assert.equal(part.pBits - base, (RECT.top * PITCH) + (RECT.left * BYTES_PER_PIXEL));
    assert.equal(part.Pitch, PITCH, 'a sub-rectangle does not change the row stride');
    assert.equal(out.surface.UnlockRect(), D3D_OK);

    out.surface.release();
    assertFullyReleased(device);
});

test('a malformed lock rectangle is accepted, and still reports where it points', ()=>{
    /**
     * Shapes a later Windows rejected and an earlier one did not. Programs were
     * written against the lenient one, so the lenient one is what we implement.
     */
    const malformed = [
        { left: 60, top: 60, right: 60, bottom: 68 },
        { left: 60, top: 60, right: 68, bottom: 60 },
        { left: 68, top: 60, right: 60, bottom: 68 },
        { left: 60, top: 68, right: 68, bottom: 60 },
        { left: -8, top: 60, right: 0, bottom: 68 },
        { left: 60, top: -8, right: 68, bottom: 0 },
        { left: 60, top: 60, right: 136, bottom: 68 },
        { left: 60, top: 136, right: 68, bottom: 144 },
    ];
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};
    assert.equal(
        device.CreateOffscreenPlainSurface(SIZE, SIZE, D3DFMT.A8R8G8B8, D3DPOOL.SCRATCH, out),
        D3D_OK);
    const base = out.surface.base;

    for (const rect of malformed)
    {
        const locked = { pBits: 0, Pitch: 0 };
        const label = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
        assert.equal(out.surface.LockRect(locked, rect, 0), D3D_OK, label);
        assert.equal(locked.pBits - base, (rect.top * PITCH) + (rect.left * BYTES_PER_PIXEL),
            label);
        assert.equal(locked.Pitch, PITCH, label);
        assert.equal(out.surface.UnlockRect(), D3D_OK, label);
    }

    out.surface.release();
    assertFullyReleased(device);
});

test('locking a texture level and locking its surface are one lock', ()=>{
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const texture = {};
    assert.equal(
        device.CreateTexture(SIZE, SIZE, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture), D3D_OK);
    /** @type {{ surface?: any }} */
    const level = {};
    assert.equal(texture.texture.GetSurfaceLevel(0, level), D3D_OK);

    const locked = { pBits: 0, Pitch: 0 };
    assert.equal(texture.texture.LockRect(0, locked, null, 0), D3D_OK);

    const second = { pBits: SENTINEL_BITS, Pitch: SENTINEL_PITCH };
    assert.equal(level.surface.LockRect(second, null, 0), D3DERR_INVALIDCALL);
    assert.equal(second.pBits, SENTINEL_BITS);

    assert.equal(texture.texture.UnlockRect(0), D3D_OK);

    level.surface.release();
    texture.texture.release();
    assertFullyReleased(device);
});

test('a lock keeps the flags it was given, so a backend can honour them', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};
    assert.equal(
        device.CreateOffscreenPlainSurface(64, 64, D3DFMT.A8R8G8B8, D3DPOOL.SCRATCH, out), D3D_OK);

    const locked = { pBits: 0, Pitch: 0 };
    assert.equal(out.surface.LockRect(locked, null, 0x2000), D3D_OK);
    assert.equal(out.surface.lockFlags, 0x2000, 'lock flags are a contract, not decoration');
    assert.equal(out.surface.UnlockRect(), D3D_OK);

    out.surface.release();
    assertFullyReleased(device);
});
