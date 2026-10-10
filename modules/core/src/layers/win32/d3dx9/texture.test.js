/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DX_DEFAULT, D3DX_FROM_FILE, createTextureLoader } from './texture.js';
import { FMT } from './pixels.js';
import { deviceRig } from './device.fixture.js';
import { writeDds } from './save-texture.js';

const D3DXERR_INVALIDDATA = 0x88760b59;

/**
 * Guest memory, a heap, and a device whose methods are reached the way a
 * program's are: through the vtable a pointer leads to, each slot a number
 * the fake bridge dispatches on.
 */
function rig(){
    const memory = new Uint8Array(1 << 20);
    const view = new DataView(memory.buffer);
    let next = 0x1000;
    const heap = {
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        free: ()=>{},
    };
    /** @type {any[]} */
    const calls = [];
    /** @type {Map<number, any>} */
    const textures = new Map();
    /** An object whose vtable's slot `n` holds the entry 0xE0000 + n. @param {any} state */
    const object = state=>{
        const at = heap.allocate(4);
        const vtable = heap.allocate(64 * 4);
        view.setUint32(at, vtable, true);
        for (let slot = 0; slot < 64; slot++)
        {
            view.setUint32(vtable + slot * 4, 0xe0000 + slot, true);
        }
        textures.set(at, state);
        return at;
    };
    const device = object({ device: true });
    // The bridge finds the stack for a call into the guest from the host call in
    // flight, which a handler's is only once it has returned its promise.
    let inHandler = false;
    const callGuest = async(/** @type {{ entry: number, args: number[] }} */ { entry, args })=>{
        if (inHandler)
        {
            throw new Error('a call into the guest before the handler returned');
        }
        const slot = entry - 0xe0000;
        const self = textures.get(args[0]);
        if (self.device && slot === 23)
        {
            const [, width, height, levels, usage, format, pool, out] = args;
            const texture = object({ width, height, levels, usage, format, pool, released: false,
                data: Array.from({ length: levels }, (_, level)=>heap.allocate(
                    Math.max(1, width >> level) * Math.max(1, height >> level) * 4)) });
            calls.push(['CreateTexture', width, height, levels, usage, format, pool]);
            view.setUint32(out, texture, true);
            return 0;
        }
        if (self.device && slot === 31)
        {
            const [, from, to] = args;
            calls.push(['UpdateTexture']);
            const source = textures.get(from);
            const target = textures.get(to);
            source.data.forEach((/** @type {number} */ at, /** @type {number} */ level)=>{
                memory.copyWithin(target.data[level], at, at + 4096);
            });
            return 0;
        }
        if (self.surface && slot === 12)
        {
            const [, desc] = args;
            [self.format, 1, 0, self.pool, 0, 0, self.width, self.height]
                .forEach((value, i)=>view.setUint32(desc + i * 4, value, true));
            return 0;
        }
        if (self.surface && slot === 13)
        {
            const [, locked, rect, flags] = args;
            calls.push(['LockRect', rect === 0 ? 'whole' : 'rect', flags]);
            if (self.pool === 0)
            {
                return 0x8876086c;
            }
            const left = rect === 0 ? 0 : view.getUint32(rect, true);
            const top = rect === 0 ? 0 : view.getUint32(rect + 4, true);
            view.setUint32(locked, self.width * 4, true);
            view.setUint32(locked + 4, self.data + top * self.width * 4 + left * 4, true);
            return 0;
        }
        if (self.surface && slot === 14)
        {
            calls.push(['UnlockRect']);
            return 0;
        }
        if (slot === 19)
        {
            const [, level, locked] = args;
            const pitch = Math.max(1, self.width >> level) * (self.format === FMT.DXT1 ? 2 : 4);
            view.setUint32(locked, pitch, true);
            view.setUint32(locked + 4, self.data[level], true);
            calls.push(['LockRect', level]);
            return 0;
        }
        if (slot === 20)
        {
            calls.push(['UnlockRect', args[1]]);
            return 0;
        }
        if (slot === 2)
        {
            self.released = true;
            calls.push(['Release']);
            return 0;
        }
        throw new Error(`unexpected slot ${slot}`);
    };
    /** @type {string[]} */
    const diverged = [];
    const created = createTextureLoader({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
        heap, callGuest,
    });
    const loader = {
        /** @param {number[]} args */
        fromMemory: args=>{
            inHandler = true;
            try
            {
                return created.fromMemory(args);
            }
            finally
            {
                inHandler = false;
            }
        },
        imageInfo: created.imageInfo,
        /** @param {number[]} args */
        loadSurfaceFromMemory: args=>{
            inHandler = true;
            try
            {
                return created.loadSurfaceFromMemory(args);
            }
            finally
            {
                inHandler = false;
            }
        },
        /** @param {number[]} args */
        loadSurface: args=>{
            inHandler = true;
            try
            {
                return created.loadSurface(args);
            }
            finally
            {
                inHandler = false;
            }
        },
    };
    /**
     * A surface of 32-bit texels.
     *
     * @param {number} width @param {number} height @param {number} format @param {number} pool
     */
    const surface = (width, height, format, pool = 1)=>object({ surface: true, width, height,
        format, pool, data: heap.allocate(width * height * 4) });
    /** @param {number[]} bytes */
    const place = bytes=>{
        const at = heap.allocate(bytes.length);
        memory.set(bytes, at);
        return at;
    };
    return { memory, view, heap, device, textures, calls, diverged, loader, place, surface };
}

/** A 2x2 TGA, 24 bits, top row first. @param {number[][]} texels  b, g, r each */
function tga(texels){
    const header = new Array(18).fill(0);
    header[2] = 2;
    header[12] = 2;
    header[14] = 2;
    header[16] = 24;
    header[17] = 0x20;
    return [...header, ...texels.flat()];
}

/** The Ex call's arguments. @param {Record<string, number>} a */
function exArgs(a){
    return [a.device, a.data, a.size, a.width ?? D3DX_DEFAULT, a.height ?? D3DX_DEFAULT,
        a.mips ?? D3DX_DEFAULT, a.usage ?? 0, a.format ?? 0, a.pool ?? 1, D3DX_DEFAULT,
        D3DX_DEFAULT, a.key ?? 0, a.info ?? 0, 0, a.out];
}

test('a TGA becomes a managed texture in its own format, with every level of the chain', async()=>{
    const { device, view, textures, calls, loader, place, heap, memory } = rig();
    const file = tga([[10, 20, 30], [30, 40, 50], [50, 60, 70], [70, 80, 90]]);
    const data = place(file);
    const out = heap.allocate(4);
    const info = heap.allocate(28);
    const answer = await loader.fromMemory(exArgs({ device, data, size: file.length, out, info }));
    assert.equal(answer, 0);
    const texture = textures.get(view.getUint32(out, true));
    assert.deepEqual(calls[0], ['CreateTexture', 2, 2, 2, 0, FMT.X8R8G8B8, 1]);
    assert.deepEqual([...memory.subarray(texture.data[0], texture.data[0] + 16)],
        [10, 20, 30, 255, 30, 40, 50, 255, 50, 60, 70, 255, 70, 80, 90, 255]);
    // The second level is the average of the four.
    assert.deepEqual([...memory.subarray(texture.data[1], texture.data[1] + 4)],
        [40, 50, 60, 255]);
    // D3DXIMAGE_INFO: 2x2, depth 1, one level, R8G8B8, a texture, a TGA.
    assert.deepEqual(Array.from({ length: 7 }, (_, i)=>view.getUint32(info + i * 4, true)),
        [2, 2, 1, 1, FMT.R8G8B8, 3, 2]);
});

test('a default-pool texture is filled through a system-memory copy and UpdateTexture', async()=>{
    const { device, view, textures, calls, loader, place, heap, memory } = rig();
    const file = tga([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]);
    const data = place(file);
    const out = heap.allocate(4);
    const answer = await loader.fromMemory(exArgs({ device, data, size: file.length, out,
        pool: 0, mips: 1, format: FMT.A8R8G8B8 }));
    assert.equal(answer, 0);
    assert.deepEqual(calls.map(c=>c[0]), ['CreateTexture', 'LockRect', 'UnlockRect',
        'CreateTexture', 'UpdateTexture', 'Release']);
    assert.deepEqual(calls[0].slice(4), [0, FMT.A8R8G8B8, 2], 'the copy in system memory');
    assert.deepEqual(calls[3].slice(4), [0, FMT.A8R8G8B8, 0], 'the texture where asked');
    const placed = textures.get(view.getUint32(out, true));
    assert.equal(placed.pool, 0);
    assert.equal(placed.released, false);
    assert.deepEqual([...memory.subarray(placed.data[0], placed.data[0] + 4)], [1, 2, 3, 255]);
});

test('a DXT1 file goes into a DXT1 texture block for block, its levels from the file',
    async()=>{
        const { device, view, textures, calls, loader, place, heap, memory } = rig();
        const header = new Array(128).fill(0);
        header.splice(0, 4, 0x44, 0x44, 0x53, 0x20);
        const u32 = (/** @type {number} */ at, /** @type {number} */ v)=>{
            for (let k = 0; k < 4; k++)
            {
                header[at + k] = v >>> (k * 8) & 0xff;
            }
        };
        u32(4, 124);
        u32(8, 0x21007);
        u32(12, 4);
        u32(16, 4);
        u32(28, 1);
        u32(76, 32);
        u32(80, 4);
        u32(84, FMT.DXT1);
        const block = [0x1f, 0x00, 0x00, 0xf8, 0x1b, 0x2c, 0x3d, 0x4e];
        const file = [...header, ...block];
        const data = place(file);
        const out = heap.allocate(4);
        assert.equal(await loader.fromMemory(exArgs({ device, data, size: file.length, out,
            mips: D3DX_FROM_FILE })), 0);
        assert.deepEqual(calls[0], ['CreateTexture', 4, 4, 1, 0, FMT.DXT1, 1]);
        const texture = textures.get(view.getUint32(out, true));
        assert.deepEqual([...memory.subarray(texture.data[0], texture.data[0] + 8)], block);
    });

test('a colour key clears its texels; an unreadable file is refused and said', async()=>{
    const { device, view, textures, loader, place, heap, memory, diverged } = rig();
    const file = tga([[0, 0, 255], [1, 2, 3], [0, 0, 255], [4, 5, 6]]);
    const data = place(file);
    const out = heap.allocate(4);
    assert.equal(await loader.fromMemory(exArgs({ device, data, size: file.length, out, mips: 1,
        format: FMT.A8R8G8B8, key: 0xffff0000 })), 0);
    const texture = textures.get(view.getUint32(out, true));
    assert.deepEqual([...memory.subarray(texture.data[0], texture.data[0] + 8)],
        [0, 0, 0, 0, 1, 2, 3, 255]);

    const junk = place([0xff, 0xd8, 0xff, 0xe0]);
    view.setUint32(out, 0xaaaaaaaa, true);
    assert.equal(await loader.fromMemory(exArgs({ device, data: junk, size: 4, out })) >>> 0,
        D3DXERR_INVALIDDATA);
    assert.equal(view.getUint32(out, true), 0);
    assert.match(diverged.join('\n'), /D3DXCreateTextureFromFileInMemoryEx: answered D3DXERR_INVALIDDATA: a JPEG/);

    const info = heap.allocate(28);
    assert.equal(loader.imageInfo([data, file.length, info]), 0);
    assert.deepEqual([view.getUint32(info, true), view.getUint32(info + 24, true)], [2, 2]);
});

test('D3DXLoadSurfaceFromSurface copies a whole surface into a rectangle of another, in its'
    + ' format; a surface that will not lock is answered as its lock was, and said', async()=>{
    const { textures, calls, diverged, loader, place, surface, memory } = rig();
    const source = surface(2, 2, FMT.X8R8G8B8);
    const dest = surface(4, 2, FMT.A8R8G8B8);
    memory.set([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0], textures.get(source).data);
    const rect = place([2, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0]);
    // dest, its palette and rectangle, source, its palette and rectangle, FILTER_NONE, no key
    assert.equal(await loader.loadSurface([dest, 0, rect, source, 0, 0, 1, 0]), 0);
    const at = textures.get(dest).data;
    assert.deepEqual([...memory.subarray(at, at + 32)], [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 255, 4, 5, 6, 255,
        0, 0, 0, 0, 0, 0, 0, 0, 7, 8, 9, 255, 10, 11, 12, 255,
    ], 'X8R8G8B8 read as opaque, written at the rectangle');
    assert.deepEqual(calls, [['LockRect', 'whole', 0x10], ['UnlockRect'], ['LockRect', 'rect', 0],
        ['UnlockRect']]);

    const target = surface(2, 2, FMT.A8R8G8B8, 0);
    assert.equal(await loader.loadSurface([dest, 0, 0, target, 0, 0, 1, 0]), 0x8876086c);
    assert.match(diverged.join(' | '), /D3DXLoadSurfaceFromSurface: the source would not lock/);
});

test('D3DXLoadSurfaceFromMemory reads the source rectangle of an image at its pitch into a'
    + ' surface, in its format; a null source rectangle is refused', async()=>{
    const { textures, calls, loader, place, surface, memory } = rig();
    const dest = surface(2, 1, FMT.A8R8G8B8);
    // A 3x2 X8R8G8B8 image, rows 16 bytes apart (4 bytes of padding each).
    const image = place([
        1, 1, 1, 0, 2, 2, 2, 0, 3, 3, 3, 0, 9, 9, 9, 9,
        4, 4, 4, 0, 5, 5, 5, 0, 6, 6, 6, 0, 9, 9, 9, 9,
    ]);
    const rect = place([1, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0]);
    // dest, its palette and rectangle, memory, format, pitch, palette, rectangle, FILTER_NONE, key
    assert.equal(await loader.loadSurfaceFromMemory([dest, 0, 0, image, FMT.X8R8G8B8, 16, 0, rect,
        1, 0]), 0);
    const at = textures.get(dest).data;
    assert.deepEqual([...memory.subarray(at, at + 8)], [5, 5, 5, 255, 6, 6, 6, 255],
        'the second row from its second texel, made opaque');
    assert.deepEqual(calls, [['LockRect', 'whole', 0], ['UnlockRect']]);

    assert.equal(loader.loadSurfaceFromMemory([dest, 0, 0, image, FMT.X8R8G8B8, 16, 0, 0, 1, 0]),
        0x8876086c);
});

/**
 * The loaders as functions.js exports them, on the device rig, with files and
 * resources the test names.
 *
 * @param {{ files?: Record<string, number[] | Uint8Array>,
 *     resources?: Record<string, number[] | Uint8Array> }} given
 *     Resources by `type:name`.
 */
function exported(given){
    const r = deviceRig();
    /** @type {any[][]} */
    const asked = [];
    const loader = createTextureLoader({ ...r.host,
        readFile: async path=>{
            asked.push(['file', path]);
            const bytes = given.files?.[path];
            return bytes ? Uint8Array.from(bytes) : null;
        },
        resource: (module, name, type)=>{
            asked.push(['resource', module, name, type]);
            const bytes = given.resources?.[`${type}:${name}`];
            return bytes ? Uint8Array.from(bytes) : null;
        } });
    /** @param {string} text @param {boolean} [wide] */
    const string = (text, wide = false)=>{
        const at = r.heap.allocate((text.length + 1) * 2);
        [...text, '\0'].forEach((c, i)=>(wide ? r.view.setUint16(at + i * 2, c.charCodeAt(0), true)
            : r.memory[at + i] = c.charCodeAt(0)));
        return at;
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>r.call(/** @type {any} */ (loader.exports[name]), args);
    /** A surface's texels, packed. @param {number} at */
    const texels = at=>{
        const surface = r.objects.get(at);
        return [...r.memory.subarray(surface.data, surface.data + surface.pitch * surface.height)];
    };
    return { r, loader, asked, string, call, texels };
}

/** An A8R8G8B8 DDS file of one level, or a cube map of six such faces. @param {number[][]} faces */
function dds(faces, edge = 2){
    const file = writeDds(FMT.A8R8G8B8, [{ width: edge, height: edge,
        bytes: Uint8Array.from(faces[0]) }]);
    if (faces.length === 1)
    {
        return file;
    }
    const cube = new Uint8Array(file.length + faces.slice(1).flat().length);
    cube.set(file);
    cube.set(faces.slice(1).flat(), file.length);
    new DataView(cube.buffer).setUint32(112, 0x200 | 0xfc00, true);
    return cube;
}

/** A face of 2x2 texels, each B, G, R, A the face's number. @param {number} n */
const face = n=>new Array(16).fill(n);

test('D3DXCreateTextureFromFile reads the file the program names and makes a managed texture of'
    + ' it; a file not there answers D3DXERR_INVALIDDATA, the texture null', async()=>{
    const pixels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const { r, asked, string, call, texels } = exported({ files: { 'art\\a.dds': dds([pixels]) } });
    const out = r.heap.allocate(4);
    assert.equal(await call('D3DXCreateTextureFromFileA', [r.device, string('art\\a.dds'), out]),
        0);
    const texture = r.objects.get(r.view.getUint32(out, true));
    assert.deepEqual([texture.width, texture.height, texture.format, texture.pool,
        texture.surfaces.length], [2, 2, FMT.A8R8G8B8, 1, 2], 'a full chain, managed');
    assert.deepEqual(texels(texture.surfaces[0]), pixels);
    assert.deepEqual(asked, [['file', 'art\\a.dds']]);

    r.view.setUint32(out, 0xaaaaaaaa, true);
    assert.equal(await call('D3DXCreateTextureFromFileW', [r.device, string('gone.dds', true),
        out]), D3DXERR_INVALIDDATA);
    assert.equal(r.view.getUint32(out, true), 0);
    assert.deepEqual(asked.at(-1), ['file', 'gone.dds'], 'the wide name read as wide');
    assert.equal(call('D3DXCreateTextureFromFileA', [r.device, 0, out]), 0x8876086c);
});

test('the Ex form makes what it is asked: size, levels, format, pool, and the image info',
    async()=>{
        const { r, string, call } = exported({ files: { 'a.dds': dds([face(9)]) } });
        const out = r.heap.allocate(4);
        const info = r.heap.allocate(28);
        // Width, Height, MipLevels, Usage, Format, Pool, Filter, MipFilter, ColorKey, info,
        // palette, out.
        assert.equal(await call('D3DXCreateTextureFromFileExA', [r.device, string('a.dds'), 4, 4,
            1, 0, FMT.X8R8G8B8, 2, D3DX_DEFAULT, D3DX_DEFAULT, 0, info, 0, out]), 0);
        const texture = r.objects.get(r.view.getUint32(out, true));
        assert.deepEqual([texture.width, texture.height, texture.format, texture.pool,
            texture.surfaces.length], [4, 4, FMT.X8R8G8B8, 2, 1]);
        assert.deepEqual(Array.from({ length: 7 }, (_, i)=>r.view.getUint32(info + i * 4, true)),
            [2, 2, 1, 1, FMT.A8R8G8B8, 3, 4], 'the file: 2x2, one level, a texture, a DDS');
    });

test('D3DXCreateTextureFromResource looks in RT_RCDATA, then RT_BITMAP, whose DIB is read as the'
    + ' bitmap file it would be', async()=>{
    // A 1x1 24-bit DIB: BITMAPINFOHEADER, one row of B, G, R and a byte of padding.
    const dib = new Array(40).fill(0);
    [40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0].forEach((v, i)=>(dib[i] = v));
    const { r, asked, string, call, texels } = exported({ resources: {
        '10:7': dds([face(5)]), '2:LOGO': [...dib, 30, 20, 10, 0] } });
    const out = r.heap.allocate(4);
    assert.equal(await call('D3DXCreateTextureFromResourceA', [r.device, 0x400000, 7, out]), 0);
    assert.deepEqual(asked, [['resource', 0x400000, 7, 10]], 'an ordinal, RT_RCDATA');
    assert.equal(await call('D3DXCreateTextureFromResourceW', [r.device, 0x400000,
        string('LOGO', true), out]), 0);
    assert.deepEqual(asked.slice(1), [['resource', 0x400000, 'LOGO', 10],
        ['resource', 0x400000, 'LOGO', 2]]);
    const texture = r.objects.get(r.view.getUint32(out, true));
    assert.equal(texture.format, FMT.X8R8G8B8);
    assert.deepEqual(texels(texture.surfaces[0]), [30, 20, 10, 255]);
    assert.equal(await call('D3DXCreateTextureFromResourceA', [r.device, 0, 99, out]),
        D3DXERR_INVALIDDATA);
});

test('a cube texture is made of a DDS cube map, face by face; a texture of it, or a cube of a'
    + ' flat image, is refused', async()=>{
    const faces = [0, 1, 2, 3, 4, 5].map(face);
    const cube = dds(faces);
    const flat = dds([face(7)]);
    const { r, string, call, texels, loader } = exported({ files: { 'sky.dds': cube,
        'flat.dds': flat } });
    const out = r.heap.allocate(4);
    assert.equal(await call('D3DXCreateCubeTextureFromFileA', [r.device, string('sky.dds'), out]),
        0);
    const made = r.objects.get(r.view.getUint32(out, true));
    assert.equal(made.kind, 'cube');
    assert.deepEqual([made.width, made.format, made.pool, made.faces[0].length],
        [2, FMT.A8R8G8B8, 1, 2]);
    made.faces.forEach((/** @type {number[]} */ levels, /** @type {number} */ n)=>{
        assert.deepEqual(texels(levels[0]), faces[n], `face ${n}`);
        assert.deepEqual(texels(levels[1]), [n, n, n, n], `face ${n}'s second level`);
    });
    assert.ok(r.calls.some(c=>c[0] === 'CreateCubeTexture' && c[1] === 2));

    const data = r.heap.allocate(cube.length);
    r.memory.set(cube, data);
    const info = r.heap.allocate(28);
    // Size, MipLevels, Usage, Format, Pool, Filter, MipFilter, ColorKey, info, palette, out.
    assert.equal(await call('D3DXCreateCubeTextureFromFileInMemoryEx', [r.device, data,
        cube.length, 4, 1, 0, 0, 1, D3DX_DEFAULT, D3DX_DEFAULT, 0, info, 0, out]), 0);
    assert.equal(r.objects.get(r.view.getUint32(out, true)).width, 4);
    assert.equal(r.view.getUint32(info + 20, true), 5, 'D3DRTYPE_CUBETEXTURE');
    assert.equal(loader.imageInfo([data, cube.length, info]), 0);
    assert.equal(r.view.getUint32(info + 20, true), 5);

    assert.equal(await call('D3DXCreateCubeTextureFromFileA', [r.device, string('flat.dds'),
        out]), D3DXERR_INVALIDDATA);
    assert.equal(r.view.getUint32(out, true), 0);
    assert.equal(await call('D3DXCreateTextureFromFileA', [r.device, string('sky.dds'), out]),
        D3DXERR_INVALIDDATA);
    assert.match(r.diverged.map(d=>d.join(': ')).join('\n'),
        /D3DXCreateCubeTextureFromFileA: answered D3DXERR_INVALIDDATA: the file is not a cube/);
});

test('D3DXGetImageInfoFromFile describes the file it names; D3DXLoadSurfaceFromFileInMemory puts'
    + ' a rectangle of an image into a surface', async()=>{
    const pixels = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
    const file = dds([pixels]);
    const { r, string, call, texels } = exported({ files: { 'b.dds': file } });
    const info = r.heap.allocate(28);
    assert.equal(await call('D3DXGetImageInfoFromFileA', [string('b.dds'), info]), 0);
    assert.deepEqual([r.view.getUint32(info, true), r.view.getUint32(info + 4, true)], [2, 2]);
    assert.equal(await call('D3DXGetImageInfoFromFileW', [string('none', true), info]),
        D3DXERR_INVALIDDATA);

    const data = r.heap.allocate(file.length);
    r.memory.set(file, data);
    const dest = r.surface({ width: 1, height: 2, format: FMT.A8R8G8B8, usage: 0, pool: 1 });
    const rect = r.heap.allocate(16);
    [1, 0, 2, 2].forEach((v, i)=>r.view.setUint32(rect + i * 4, v, true));
    assert.equal(await call('D3DXLoadSurfaceFromFileInMemory', [dest, 0, 0, data, file.length,
        rect, 1, 0, info]), 0);
    assert.deepEqual(texels(dest), [2, 2, 2, 2, 4, 4, 4, 4], 'the right-hand column');
    const wide = r.surface({ width: 2, height: 1, format: FMT.A8R8G8B8, usage: 0, pool: 1 });
    assert.equal(await call('D3DXLoadSurfaceFromFileA', [wide, 0, 0, string('b.dds'), 0, 1, 0,
        0]), 0);
    assert.deepEqual(texels(wide), [3, 3, 3, 3, 4, 4, 4, 4], 'the whole image, point sampled');
});

test('a palette-indexed DDS becomes A8R8G8B8, keeping the alpha its palette holds', async()=>{
    // P8's palette entries carry an alpha in peFlags; the nearest format with room for
    // it is A8R8G8B8, and D3DXIMAGE_INFO still names the file's own P8.
    const { device, view, textures, calls, loader, place, heap, memory } = rig();
    const header = new Array(128).fill(0);
    [0x44, 0x44, 0x53, 0x20].forEach((x, i)=>{
        header[i] = x;
    });
    const put = (/** @type {number} */ at, /** @type {number} */ value)=>{
        for (let k = 0; k < 4; k++)
        {
            header[at + k] = (value >>> (k * 8)) & 0xff;
        }
    };
    put(4, 124);
    put(8, 0x1007);
    put(12, 1);
    put(16, 1);
    put(76, 32);
    put(80, 0x20);
    put(88, 8);
    const palette = new Array(1024).fill(0);
    palette.splice(4, 4, 200, 100, 50, 128);
    const file = [...header, ...palette, 1];
    const data = place(file);
    const out = heap.allocate(4);
    const info = heap.allocate(28);
    assert.equal(await loader.fromMemory(exArgs({ device, data, size: file.length, mips: 1,
        out, info })), 0);
    assert.equal(calls[0][5], FMT.A8R8G8B8);
    const texture = textures.get(view.getUint32(out, true));
    assert.deepEqual([...memory.subarray(texture.data[0], texture.data[0] + 4)],
        [50, 100, 200, 128]);
    assert.equal(view.getUint32(info + 16, true), FMT.P8);
});
