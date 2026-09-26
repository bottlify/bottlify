/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DCUBEMAP_FACE, D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK, offsetOfRect,
    surfaceBytes, surfacePitch,
} from './constants.js';
import { createDirect3D9 } from './device.js';
import {
    createReferenceCount, createSurface, createTexture, packColour, writePixels,
} from './resources.js';
import { SURFACE_TYPE } from './validity.js';

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

test('a malformed lock rectangle is refused by this version, and the record left alone', ()=>{
    /**
     * Shapes the later runtime rejects: empty, inverted, off either edge. A
     * Direct3D 9 device refuses them before the lock is taken, so the caller's
     * record keeps whatever it held and no unlock is owed.
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

    for (const rect of malformed)
    {
        const locked = { pBits: 7, Pitch: 7 };
        const label = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
        assert.equal(out.surface.LockRect(locked, rect, 0), D3DERR_INVALIDCALL, label);
        assert.deepEqual(locked, { pBits: 7, Pitch: 7 }, label);
        assert.equal(out.surface.UnlockRect(), D3DERR_INVALIDCALL, `${label}: nothing to unlock`);
    }
    // A rectangle that is one is still located exactly.
    const locked = { pBits: 0, Pitch: 0 };
    assert.equal(out.surface.LockRect(locked, { left: 60, top: 60, right: 68, bottom: 68 }, 0),
        D3D_OK);
    assert.equal(locked.pBits - out.surface.base, (60 * PITCH) + (60 * BYTES_PER_PIXEL));
    assert.equal(out.surface.UnlockRect(), D3D_OK);

    out.surface.release();
    assertFullyReleased(device);
});

test('a surface made without the rule accepts a malformed rectangle, as the earlier runtime did',
    ()=>{
        const lenient = createSurface({
            type: SURFACE_TYPE.PLAIN, width: SIZE, height: SIZE, format: D3DFMT.A8R8G8B8,
            pool: D3DPOOL.SCRATCH, usage: 0, base: 0x1000, count: createReferenceCount(),
        });
        const locked = { pBits: 0, Pitch: 0 };
        assert.equal(lenient.LockRect(locked, { left: 68, top: 60, right: 60, bottom: 68 }, 0),
            D3D_OK);
        assert.equal(locked.pBits - 0x1000, (60 * PITCH) + (68 * BYTES_PER_PIXEL));
        assert.equal(lenient.UnlockRect(), D3D_OK);
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

/** A GDI that hands out numbered contexts and remembers what it was shown. */
function fakeGdi(){
    /** @type {any[]} */
    const made = [];
    /** @type {number[]} */
    const deleted = [];
    return {
        made,
        deleted,
        /** @param {any} attributes */
        createSurfaceDc: attributes=>{
            made.push(attributes);
            return 0x100 + made.length;
        },
        /** @param {number} handle */
        deleteSurfaceDc: handle=>{
            deleted.push(handle);
        },
    };
}

test('GetDC answers for the formats GDI draws into, and refuses the rest untouched', ()=>{
    // Wine's d3d9 test_getdc: supported for A8R8G8B8, X8R8G8B8, R5G6B5,
    // X1R5G5B5 and A1R5G5B5 among what is made here, and a failed call leaves
    // the handle.
    const device = createDevice();
    const gdi = fakeGdi();
    for (const [format, bitCount, layout] of /** @type {[number, number, string | null][]} */ ([
        [D3DFMT.A8R8G8B8, 32, null], [D3DFMT.X8R8G8B8, 32, null], [D3DFMT.R5G6B5, 16, '565'],
        [D3DFMT.X1R5G5B5, 16, '555'], [D3DFMT.A1R5G5B5, 16, '555'],
        [D3DFMT.A2R10G10B10, 0, null], [D3DFMT.L8, 0, null], [D3DFMT.DXT1, 0, null],
    ]))
    {
        /** @type {{ surface?: any }} */
        const plain = {};
        assert.equal(device.CreateOffscreenPlainSurface(64, 64, format, D3DPOOL.SYSTEMMEM, plain),
            D3D_OK);
        const surface = plain.surface;
        /** @type {{ dc?: number }} */
        const out = { dc: 0x1234 };
        if (bitCount === 0)
        {
            assert.equal(surface.GetDC(gdi, out), D3DERR_INVALIDCALL, `format ${format}`);
            assert.equal(out.dc, 0x1234);
        }
        else
        {
            assert.equal(surface.GetDC(gdi, out), D3D_OK, `format ${format}`);
            const shown = gdi.made[gdi.made.length - 1];
            assert.equal(out.dc, 0x100 + gdi.made.length);
            assert.deepEqual([shown.width, shown.height, shown.bitCount, shown.bits, shown.pitch],
                [64, 64, bitCount, surface.base, surfacePitch(format, 64)]);
            if (layout)
            {
                assert.equal(shown.format, layout);
            }
            assert.equal(surface.ReleaseDC(out.dc, gdi), D3D_OK);
            assert.equal(gdi.deleted[gdi.deleted.length - 1], out.dc);
        }
        surface.release();
    }
    assertFullyReleased(device);
});

test('a held context is the resource\'s one lock: no second, no lock, no other level\'s', ()=>{
    // Wine's d3d9 test_getdc, over two surfaces of one cube texture.
    const device = createDevice();
    const gdi = fakeGdi();
    /** @type {{ texture?: any }} */
    const cube = {};
    assert.equal(device.CreateCubeTexture(64, 3, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, cube),
        D3D_OK);
    /** @type {{ surface?: any }} */
    const first = {};
    /** @type {{ surface?: any }} */
    const second = {};
    assert.equal(cube.texture.GetCubeMapSurface(D3DCUBEMAP_FACE.POSITIVE_X, 0, first), D3D_OK);
    assert.equal(cube.texture.GetCubeMapSurface(D3DCUBEMAP_FACE.NEGATIVE_Y, 2, second), D3D_OK);
    const surface = first.surface;
    const other = second.surface;
    /** @type {{ dc?: number }} */
    const held = {};
    /** @type {{ dc?: number }} */
    const again = { dc: 0x1234 };
    const locked = { Pitch: 0, pBits: 0 };

    assert.equal(surface.GetDC(gdi, held), D3D_OK);
    assert.equal(surface.GetDC(gdi, again), D3DERR_INVALIDCALL);
    assert.equal(again.dc, 0x1234);
    assert.equal(other.GetDC(gdi, again), D3DERR_INVALIDCALL, 'nor another surface of it');
    assert.equal(surface.LockRect(locked, null, 0), D3DERR_INVALIDCALL);
    assert.equal(other.LockRect(locked, null, 0), D3DERR_INVALIDCALL);
    assert.equal(other.UnlockRect(), D3D_OK, 'the texture is locked, so an unlock is owed');
    assert.equal(other.ReleaseDC(held.dc, gdi), D3DERR_INVALIDCALL, 'not the holder');
    assert.equal(surface.ReleaseDC(held.dc, gdi), D3D_OK);
    assert.equal(surface.ReleaseDC(held.dc, gdi), D3DERR_INVALIDCALL, 'released once');
    assert.equal(other.UnlockRect(), D3DERR_INVALIDCALL);

    assert.equal(other.LockRect(locked, null, 0), D3D_OK);
    assert.equal(surface.GetDC(gdi, again), D3DERR_INVALIDCALL, 'a lock anywhere in it');
    assert.equal(surface.LockRect(locked, null, 0), D3D_OK, 'locks do not exclude each other');
    assert.equal(surface.UnlockRect(), D3D_OK);
    assert.equal(other.UnlockRect(), D3D_OK);
    assert.equal(surface.GetDC(gdi, again), D3D_OK);
    assert.equal(surface.ReleaseDC(again.dc, gdi), D3D_OK);

    first.surface.release();
    second.surface.release();
    cube.texture.release();
    assertFullyReleased(device);
});

test('releasing a context is an unlock after a write, so what GDI drew is taken up', ()=>{
    const device = createDevice();
    const gdi = fakeGdi();
    /** @type {{ texture?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture(8, 8, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, texture),
        D3D_OK);
    /** @type {{ surface?: any }} */
    const level = {};
    assert.equal(texture.texture.GetSurfaceLevel(0, level), D3D_OK);
    const surface = level.surface;
    let unlocks = 0;
    const unlock = surface.UnlockRect;
    // What a renderer tracking the level puts in place.
    surface.UnlockRect = ()=>{
        const hr = unlock();
        unlocks += hr === D3D_OK ? 1 : 0;
        return hr;
    };
    /** @type {{ dc?: number }} */
    const held = {};
    assert.equal(surface.GetDC(gdi, held), D3D_OK);
    assert.equal(unlocks, 0);
    assert.equal(surface.ReleaseDC(held.dc, gdi), D3D_OK);
    assert.equal(unlocks, 1);
    surface.release();
    texture.texture.release();
    assertFullyReleased(device);
});

test('a texture gives its storage back when the last reference goes', ()=>{
    // The arena a texture's pixels come out of is the one the program's own
    // allocator draws from, and GlobalMemoryStatus reports what is left of it.
    // Holding the pixels of a texture nobody references does not merely leak
    // address space -- it tells the program it is running out of memory, and a
    // program told that evicts its own assets and loads them again. Measured on
    // a real title's steady menu: a fifth of every guest instruction retired
    // was re-reading and re-decoding textures it already had.
    /** @type {number[]} */
    const freed = [];
    let next = 0x1000;
    const texture = createTexture({
        width: 8, height: 8, levels: 2, format: D3DFMT.A8R8G8B8,
        pool: D3DPOOL.MANAGED, usage: 0,
        count: createReferenceCount(),
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
        /** @param {number} address */
        free: address=>freed.push(address),
    });

    /** @type {{ surface?: any }} */
    const level0 = {};
    /** @type {{ surface?: any }} */
    const level1 = {};
    texture.GetSurfaceLevel(0, level0);
    texture.GetSurfaceLevel(1, level1);
    const taken = [level0.surface.base, level1.surface.base];
    assert.equal(freed.length, 0, 'nothing is given back while it is referenced');

    // A level handed out takes a reference of its own; the storage goes back
    // when the last of them does.
    while (texture.refCount > 0)
    {
        texture.release();
    }
    assert.deepEqual(freed.sort(), taken.sort(),
        'every level a program ever locked is handed back, not only the first');
});

// --- how a compressed level is measured ---

test('a compressed level is counted in whole blocks, not in pixels', ()=>{
    // DXT1 is eight bytes for each 4x4 block; DXT5 is sixteen.
    assert.equal(surfacePitch(D3DFMT.DXT1, 256), 64 * 8);
    assert.equal(surfaceBytes(D3DFMT.DXT1, 256, 256), 64 * 8 * 64);
    assert.equal(surfaceBytes(D3DFMT.DXT5, 256, 256), 64 * 16 * 64);
    // Four times less than the uncompressed surface the same art would need,
    // which is the whole reason a program keeps it compressed.
    assert.equal(surfaceBytes(D3DFMT.A8R8G8B8, 256, 256) / surfaceBytes(D3DFMT.DXT1, 256, 256), 8);
});

test('a level smaller than one block still costs a whole block', ()=>{
    // The tail of a mip chain, where counting by pixels leaves a level short of
    // its own last row and it samples as whatever lay after it.
    assert.equal(surfaceBytes(D3DFMT.DXT1, 1, 1), 8);
    assert.equal(surfaceBytes(D3DFMT.DXT1, 2, 2), 8);
    assert.equal(surfaceBytes(D3DFMT.DXT1, 5, 5), 4 * 8);
    assert.equal(surfaceBytes(D3DFMT.DXT5, 3, 9), 1 * 16 * 3);
});

test('an uncompressed format is measured exactly as it always was', ()=>{
    assert.equal(surfacePitch(D3DFMT.A8R8G8B8, 10), 40);
    assert.equal(surfaceBytes(D3DFMT.R5G6B5, 10, 4), 80);
    assert.equal(surfaceBytes(D3DFMT.A8, 7, 3), 21);
});

test('a rectangle into a compressed surface is addressed by block', ()=>{
    const pitch = surfacePitch(D3DFMT.DXT1, 256);
    assert.equal(offsetOfRect(D3DFMT.DXT1, pitch, { top: 0, left: 0 }), 0);
    // Row four of pixels is row one of blocks; column eight is block two.
    assert.equal(offsetOfRect(D3DFMT.DXT1, pitch, { top: 4, left: 8 }), pitch + 16);
    assert.equal(offsetOfRect(D3DFMT.A8R8G8B8, 1024, { top: 4, left: 8 }), 4096 + 32);
});

test('a write to a render target says the bytes are discarded, and a read says they are stale',
    ()=>{
        /** @type {string[]} */
        const said = [];
        /** @param {string} type */
        const target = type=>createSurface({
            type, width: SIZE, height: SIZE, format: D3DFMT.A8R8G8B8,
            pool: D3DPOOL.DEFAULT, usage: 0, base: 0x1000, lockable: true,
            count: createReferenceCount(),
            divergence: (_api, detail)=>said.push(detail),
        });
        const locked = { pBits: 0, Pitch: 0 };

        // Nothing uploads a standalone surface's bytes when the lock ends, so a
        // program drawing into one by hand loses what it drew -- and used to
        // lose it in silence, because only the read direction was reported.
        const written = target(SURFACE_TYPE.RENDER_TARGET);
        assert.equal(written.LockRect(locked, null, 0), D3D_OK);
        assert.equal(written.UnlockRect(), D3D_OK);
        assert.equal(said.length, 1);
        assert.match(said[0], /a write to a rendertarget surface/);
        assert.match(said[0], /discarded/);

        // A read-only lock discards nothing: reporting that it did would be a
        // false report of the worse fault.
        said.length = 0;
        const read = target(SURFACE_TYPE.RENDER_TARGET);
        assert.equal(read.LockRect(locked, null, 0x10), D3D_OK);
        assert.equal(said.length, 1);
        assert.match(said[0], /a read of a rendertarget surface/);
        assert.doesNotMatch(said[0], /discarded/);

        // A plain surface is not in this class at all: its bytes are read out of
        // guest memory by whatever copies from it, so a write into one arrives.
        said.length = 0;
        const plain = target(SURFACE_TYPE.PLAIN);
        assert.equal(plain.LockRect(locked, null, 0), D3D_OK);
        assert.equal(plain.UnlockRect(), D3D_OK);
        assert.deepEqual(said, []);
    });

test('a surface says its own length in bytes, for a caller that sizes a copy from it', ()=>{
    const surface = createSurface({
        type: SURFACE_TYPE.PLAIN, width: SIZE, height: SIZE, format: D3DFMT.A8R8G8B8,
        pool: D3DPOOL.SCRATCH, usage: 0, base: 0x1000, count: createReferenceCount(),
    });
    /** @type {{ desc?: any }} */
    const described = {};
    assert.equal(surface.GetDesc(described), D3D_OK);
    // D3D8's structure has a slot for this and D3D9 dropped it, so it is filled
    // whichever version asks: a field left unwritten is read back out of the
    // caller's own stack, and this is the one that decides a length.
    assert.equal(described.desc.Size, surfaceBytes(D3DFMT.A8R8G8B8, SIZE, SIZE));
    assert.equal(described.desc.Size, surfacePitch(D3DFMT.A8R8G8B8, SIZE) * SIZE);
    assert.equal(described.desc.MultiSampleType, 0);
    assert.equal(described.desc.MultiSampleQuality, 0);
});

test("packColour gives a pixel of a format's width, listed layout or not", ()=>{
    assert.deepEqual([...packColour(D3DFMT.X8R8G8B8, 0x00123456)], [0x56, 0x34, 0x12, 0x00]);
    assert.deepEqual([...packColour(D3DFMT.R5G6B5, 0xffff0000)], [0x00, 0xf8]);
    assert.deepEqual([...packColour(D3DFMT.L8, 0xff123456)], [0x12]);
    assert.equal(packColour(D3DFMT.D16, 0xff123456).length, 2, 'a two-byte format packColour'
        + ' has no layout for still packs to two bytes');
    assert.equal(packColour(D3DFMT.A2R10G10B10, 0xff123456).length, 4);
});

/**
 * A read-back's rows land in guest memory in the surface's own layout: the
 * four-byte case byte for byte as the GPU handed them over, the packed cases
 * one pixel at a time through the format's bit layout.
 */
for (const { format, name, pack } of [
    {
        format: D3DFMT.A8R8G8B8, name: 'A8R8G8B8',
        /** @param {number[]} bgra */
        pack: bgra=>bgra,
    },
    {
        format: D3DFMT.R5G6B5, name: 'R5G6B5',
        /** @param {number[]} bgra */
        pack: ([b, g, r])=>{
            const bits = ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3);
            return [bits & 0xff, bits >>> 8];
        },
    },
    {
        format: D3DFMT.A1R5G5B5, name: 'A1R5G5B5',
        /** @param {number[]} bgra */
        pack: ([b, g, r, a])=>{
            const bits = ((a >>> 7) << 15) | ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3);
            return [bits & 0xff, bits >>> 8];
        },
    },
])
{
    test(`writePixels lays a read-back out in guest memory as ${name}`, ()=>{
        const width = 5;
        const height = 3;
        const base = 0x4000;
        const surface = createSurface({
            type: SURFACE_TYPE.RENDER_TARGET, width, height, format,
            pool: D3DPOOL.DEFAULT, usage: 0, base, lockable: true,
            count: createReferenceCount(),
        });
        // Every channel distinct in every pixel, so a swapped byte or a row
        // written at the wrong pitch changes what arrives.
        const pixels = Uint8Array.from({ length: width * height * 4 },
            (_, i)=>(i * 37 + 11) & 0xff);
        /** @type {{ address: number, bytes: Uint8Array }[]} */
        const writes = [];
        writePixels(surface, pixels,
            (address, bytes)=>writes.push({ address, bytes: bytes.slice() }));

        const pitch = surfacePitch(format, width);
        const arrived = new Uint8Array(pitch * height);
        for (const { address, bytes } of writes)
        {
            arrived.set(bytes, address - base);
        }
        /** @type {number[]} */
        const expected = [];
        for (let y = 0; y < height; y++)
        {
            for (let x = 0; x < width; x++)
            {
                const at = (y * width + x) * 4;
                expected.push(...pack([...pixels.subarray(at, at + 4)]));
            }
        }
        assert.deepEqual([...arrived], expected);
    });
}

test('writePixels hands a four-byte read-back to guest memory whole, not a view per pixel', ()=>{
    const surface = createSurface({
        type: SURFACE_TYPE.RENDER_TARGET, width: 4, height: 2, format: D3DFMT.X8R8G8B8,
        pool: D3DPOOL.DEFAULT, usage: 0, base: 0x4000, lockable: true,
        count: createReferenceCount(),
    });
    const pixels = new Uint8Array(4 * 2 * 4);
    /** @type {Uint8Array[]} */
    const handed = [];
    writePixels(surface, pixels, (_address, bytes)=>handed.push(bytes));
    // The rows are contiguous at the surface's pitch, so the read-back is the
    // surface's bytes already: one write of it, and nothing copied in between.
    assert.equal(handed.length, 1);
    assert.equal(handed[0], pixels);
});
