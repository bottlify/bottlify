/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a frame of draws allocates on the JavaScript heap, and what it costs,
 * in node: a scene drives a graphics device over the recording GPU double --
 * its render passes recording nothing -- frame after frame, and three things
 * are measured over the frames after a warm-up --
 *
 *   - the bytes allocated, by the V8 sampling heap profiler with the objects
 *     both collectors reclaimed counted in (an estimate: one sample per
 *     `--interval` bytes), split into the engine's own code and the double's,
 *     and per draw as the difference between a run of N and one of 2N draws
 *     a frame, which takes out what a frame costs whatever it draws;
 *   - the time per draw, the same difference over a run without the profiler;
 *   - the collections that run took, by count and by pause.
 *
 *   node tools/draw-alloc-bench.mjs [--scene NAME] [--draws N] [--frames F]
 *       [--interval BYTES] [--top K] [--root DIR] [--json]
 *
 * Scenes:
 *
 *   d3d8-lit      Direct3D 8: indexed draws of a lit, textured cube, three
 *                 lights enabled, and before every draw a new world matrix, a
 *                 texture and a render state that alternate, and the same
 *                 light set again -- a program that sets its lights per model
 *   d3d8-moving   the same, with the light set before every draw in a new
 *                 place -- a light per model
 *   d3d9-lit, d3d9-moving   the same two through Direct3D 9
 *   d3d9-shader   Direct3D 9 through a vertex and a pixel shader, the matrix
 *                 constants set before every draw with the texture and the
 *                 cull mode
 *   ddraw-32, ddraw-8   DirectDraw: a back buffer filled, N sprites put on it
 *                 with BltFast and a colour key, copied to the primary and
 *                 presented, at 32 and 8 bits a pixel (a draw is a sprite)
 *
 * `--top K` prints the K functions of the engine's own code that allocated
 * the most, with the file and line each starts at. `--root DIR` measures the
 * engine of another checkout, for a tree before a change against one after.
 */

import { Session } from 'node:inspector/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootAt = process.argv.indexOf('--root');
const ROOT = rootAt > 0 ? resolve(process.argv[rootAt + 1]) : HERE;
const GRAPHICS = `${ROOT}/modules/core/src/layers/graphics`;

const {
    D3DFMT, D3DFMT_INDEX, D3DLIGHTTYPE, D3DPOOL, D3DPT, D3DRS, D3DSWAPEFFECT, D3DTS, D3DCLEAR,
    D3DCULL, D3D_OK,
} = await import(`${GRAPHICS}/d3d8/constants.js`);
const { createDirect3D8 } = await import(`${GRAPHICS}/d3d8/device.js`);
const { createDirect3D9 } = await import(`${GRAPHICS}/d3d9/device.js`);
const { D3DDECLTYPE, D3DDECLUSAGE } = await import(`${GRAPHICS}/d3d9/declaration.js`);
const { END_TOKEN, OPCODE, REGISTER, SHADER_KIND, versionToken } =
    await import(`${GRAPHICS}/d3d9/shader.js`);
const { createBackend } = await import(`${GRAPHICS}/webgpu/backend.js`);
const { createFakeDevice } = await import(`${GRAPHICS}/webgpu/internal/fake-device.js`);
const { FVF } = await import(`${GRAPHICS}/webgpu/internal/vertexformat.js`);
const { blt, bltFast } = await import(`${GRAPHICS}/ddraw/blit.js`);
const DDRAW = await import(`${GRAPHICS}/ddraw/constants.js`);
const { createPresenter } = await import(`${GRAPHICS}/webgpu/internal/presenter.js`);

/** @param {string[]} argv */
function parse(argv){
    const options = { scene: 'd3d8-lit', draws: 200, frames: 60, interval: 1024, top: 12,
        json: false };
    for (let index = 0; index < argv.length; index++)
    {
        const arg = argv[index];
        const value = ()=>argv[++index];
        if (arg === '--scene') options.scene = value();
        else if (arg === '--draws') options.draws = Number(value());
        else if (arg === '--frames') options.frames = Number(value());
        else if (arg === '--interval') options.interval = Number(value());
        else if (arg === '--top') options.top = Number(value());
        else if (arg === '--json') options.json = true;
        else if (arg === '--root') index++;
        else throw new Error(`unknown argument ${arg}`);
    }
    return options;
}

const RAM_BASE = 0x40000000;

/** @param {number} value @param {number} index */
const check = (value, index = 0)=>{
    if (value !== D3D_OK)
    {
        throw new Error(`call ${index} answered 0x${(value >>> 0).toString(16)}`);
    }
};

/**
 * @param {Partial<any>} over
 */
const light = (over = {})=>({
    Type: D3DLIGHTTYPE.DIRECTIONAL,
    Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 },
    Specular: { r: 0.5, g: 0.25, b: 0.125, a: 1 },
    Ambient: { r: 0.125, g: 0.0625, b: 0.03125, a: 1 },
    Position: { x: 1, y: 2, z: 3 },
    Direction: { x: 0, y: -1, z: 1 },
    Range: 50,
    Falloff: 1,
    Attenuation0: 1,
    Attenuation1: 0.1,
    Attenuation2: 0,
    Theta: 0.5,
    Phi: 1,
    ...over,
});

/**
 * The recording double with what its render passes record and its queue's
 * writes left out: a pass of it resolves every binding and keeps every call,
 * which is the double's work, and inlined into the backend's own calls the
 * profiler would put it to the engine's account.
 *
 * @param {any} gpu
 */
function quietPasses(gpu){
    const nothing = ()=>{};
    // Nor does its queue keep a copy of every write: a frame's uniform
    // blocks, copied twice, are external memory a browser's queue does not
    // put on the JavaScript heap, and which moved the collector here as it
    // would not there.
    gpu.queue.writeBuffer = nothing;
    const encoderFor = gpu.device.createCommandEncoder.bind(gpu.device);
    gpu.device.createCommandEncoder = (/** @type {any[]} */ ...args)=>{
        const encoder = encoderFor(...args);
        const open = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (/** @type {any} */ descriptor)=>{
            const pass = open(descriptor);
            for (const key of Object.keys(pass))
            {
                if (typeof pass[key] === 'function')
                {
                    pass[key] = nothing;
                }
            }
            return pass;
        };
        return encoder;
    };
    return gpu;
}

/** @param {number} type @param {number} index */
const dst = (type, index)=>(0x80000000 | ((type & 7) << 28) | ((type & 0x18) << 8) | (0xf << 16)
    | index) >>> 0;
/** @param {number} type @param {number} index */
const src = (type, index)=>(0x80000000 | ((type & 7) << 28) | ((type & 0x18) << 8) | (0xe4 << 16)
    | index) >>> 0;
/** @param {number} opcode @param {number} length */
const op = (opcode, length)=>((length << 24) | opcode) >>> 0;
/** @param {number} usage @param {number} register */
const dclInput = (usage, register)=>[
    op(OPCODE.DCL, 2), (0x80000000 | usage) >>> 0, dst(REGISTER.INPUT, register),
];

/** vs_2_0: the position through c0..c3, the coordinate set carried. */
const VERTEX_SHADER = [
    versionToken(SHADER_KIND.VERTEX, 2, 0),
    ...dclInput(D3DDECLUSAGE.POSITION, 0),
    ...dclInput(D3DDECLUSAGE.TEXCOORD, 1),
    op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), src(REGISTER.CONST, 0),
    op(OPCODE.MOV, 2), dst(REGISTER.TEXCRDOUT, 0), src(REGISTER.INPUT, 1),
    END_TOKEN,
];

/** ps_2_0: a texture sample offset by c2. */
const PIXEL_SHADER = [
    versionToken(SHADER_KIND.PIXEL, 2, 0),
    op(OPCODE.DCL, 2), (2 << 27) >>> 0, dst(REGISTER.SAMPLER, 0),
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.TEXTURE, 0),
    op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0), src(REGISTER.SAMPLER, 0),
    op(OPCODE.ADD, 3), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0), src(REGISTER.CONST, 2),
    END_TOKEN,
];

/** The cube's vertex as a declaration: position, normal, one coordinate set. */
const CUBE_ELEMENTS = [
    { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0, Usage: D3DDECLUSAGE.POSITION,
        UsageIndex: 0 },
    { Stream: 0, Offset: 12, Type: D3DDECLTYPE.FLOAT3, Method: 0, Usage: D3DDECLUSAGE.NORMAL,
        UsageIndex: 0 },
    { Stream: 0, Offset: 24, Type: D3DDECLTYPE.FLOAT2, Method: 0, Usage: D3DDECLUSAGE.TEXCOORD,
        UsageIndex: 0 },
];

/**
 * A Direct3D 8 or 9 device over the recording double, and a frame of
 * `draws` draws on it: fixed-function and lit, or through a shader pair whose
 * matrix constants are set before every draw.
 *
 * @param {{ version: 8 | 9, draws: number, moving?: boolean, shader?: boolean }} scene
 */
function directScene({ version, draws, moving = false, shader = false }){
    const nine = version === 9;
    const gpu = quietPasses(createFakeDevice());
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(8 << 20);
    let next = RAM_BASE + (4 << 20);
    const services = {
        backend,
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        windowMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.subarray(address - RAM_BASE, address - RAM_BASE + length),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        allocate: (/** @type {number} */ bytes)=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
    };
    const d3d = nine
        ? createDirect3D9({ ...services, vertexShaderVersion: { major: 2, minor: 0 },
            pixelShaderVersion: { major: 2, minor: 0 } })
        : createDirect3D8(services);
    /** @type {{ device?: any }} */
    const out = {};
    check(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out));
    const device = out.device;

    // A cube: 24 vertices of position, normal and one coordinate set, 36 indices.
    const fvf = FVF.XYZ | FVF.NORMAL | (1 << FVF.TEXCOUNT_SHIFT);
    const stride = 32;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    check(device.CreateVertexBuffer(24 * stride, 0, fvf, D3DPOOL.MANAGED, vertices));
    check(device.CreateIndexBuffer(36 * 2, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices));
    /** @type {{ pBits?: number }} */
    const locked = {};
    check(vertices.buffer.Lock(0, 0, locked, 0));
    const view = new DataView(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE,
        24 * stride);
    for (let face = 0; face < 6; face++)
    {
        const axis = face >> 1;
        const sign = face & 1 ? -1 : 1;
        for (let corner = 0; corner < 4; corner++)
        {
            const at = (face * 4 + corner) * stride;
            const p = [0, 0, 0];
            p[axis] = sign;
            p[(axis + 1) % 3] = corner & 1 ? 1 : -1;
            p[(axis + 2) % 3] = corner & 2 ? 1 : -1;
            const n = [0, 0, 0];
            n[axis] = sign;
            [...p, ...n, corner & 1, corner >> 1].forEach((value, index)=>
                view.setFloat32(at + index * 4, value, true));
        }
    }
    check(vertices.buffer.Unlock());
    check(indices.buffer.Lock(0, 0, locked, 0));
    const index16 = new Uint16Array(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE,
        36);
    for (let face = 0; face < 6; face++)
    {
        index16.set([0, 1, 2, 2, 1, 3].map(corner=>face * 4 + corner), face * 6);
    }
    check(indices.buffer.Unlock());

    /** @type {any[]} */
    const textures = [];
    for (let made = 0; made < 2; made++)
    {
        /** @type {{ texture?: any }} */
        const texture = {};
        check(device.CreateTexture(16, 16, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture));
        /** @type {{ pBits?: number }} */
        const rect = {};
        check(nine ? texture.texture.LockRect(0, rect)
            : texture.texture.LockRect(0, rect, null, 0));
        ram.fill(0x40 + made * 0x40, /** @type {number} */ (rect.pBits) - RAM_BASE,
            /** @type {number} */ (rect.pBits) - RAM_BASE + 16 * 16 * 4);
        check(texture.texture.UnlockRect(0));
        textures.push(texture.texture);
    }

    check(device.SetRenderState(D3DRS.LIGHTING, shader ? 0 : 1));
    check(device.SetRenderState(D3DRS.AMBIENT, 0xff202020));
    check(device.SetMaterial({
        Diffuse: { r: 1, g: 1, b: 1, a: 1 }, Ambient: { r: 1, g: 1, b: 1, a: 1 },
        Specular: { r: 0, g: 0, b: 0, a: 0 }, Emissive: { r: 0, g: 0, b: 0, a: 0 }, Power: 0,
    }));
    const lights = [
        light(),
        light({ Type: D3DLIGHTTYPE.POINT }),
        light({ Type: D3DLIGHTTYPE.SPOT, Direction: { x: 0, y: 0, z: 1 } }),
    ];
    lights.forEach((one, index)=>{
        check(device.SetLight(index, one));
        check(device.LightEnable(index, true));
    });
    if (shader)
    {
        /** @type {{ shader?: any, declaration?: any }} */
        const made = {};
        check(device.CreateVertexDeclaration(CUBE_ELEMENTS, made));
        check(device.SetVertexDeclaration(made.declaration));
        check(device.CreateVertexShader(VERTEX_SHADER, made));
        check(device.SetVertexShader(made.shader));
        check(device.CreatePixelShader(PIXEL_SHADER, made));
        check(device.SetPixelShader(made.shader));
        check(device.SetPixelShaderConstantF(2, [0.1, 0.2, 0.3, 0.4], 1));
    }
    // Made before the frames, so the scene's own arrays are not what is counted.
    const worlds = Array.from({ length: draws }, (_, index)=>{
        const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        matrix[0] = 1 + (index % 7) / 8;
        matrix[12] = index % 17 - 8;
        matrix[13] = (index >> 4) % 11 - 5;
        matrix[14] = 20 + (index % 5);
        return matrix;
    });
    const movingLights = Array.from({ length: draws }, (_, index)=>
        light({ Type: D3DLIGHTTYPE.POINT, Position: { x: index % 13, y: 2, z: index % 9 } }));
    const viewMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
    const projection = new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1.001, 1, 0, 0,
        -0.1, 0]);

    return {
        gpu,
        device,
        async frame(){
            check(device.BeginScene());
            check(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0));
            check(device.SetTransform(D3DTS.VIEW, viewMatrix));
            check(device.SetTransform(D3DTS.PROJECTION, projection));
            if (!shader)
            {
                check(nine ? device.SetFVF(fvf) : device.SetVertexShader(fvf));
            }
            check(nine ? device.SetStreamSource(0, vertices.buffer, 0, stride)
                : device.SetStreamSource(0, vertices.buffer, stride));
            check(nine ? device.SetIndices(indices.buffer) : device.SetIndices(indices.buffer, 0));
            for (let index = 0; index < draws; index++)
            {
                if (shader)
                {
                    check(device.SetVertexShaderConstantF(0, worlds[index], 4), index);
                }
                else
                {
                    check(device.SetTransform(D3DTS.WORLD, worlds[index]), index);
                    check(device.SetLight(1, moving ? movingLights[index] : lights[1]), index);
                    check(device.LightEnable(1, true), index);
                }
                check(device.SetTexture(0, textures[index & 1]), index);
                check(device.SetRenderState(D3DRS.CULLMODE,
                    index & 2 ? D3DCULL.CW : D3DCULL.CCW), index);
                check(nine ? device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 24, 0, 12)
                    : device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 24, 0, 12), index);
            }
            check(device.EndScene());
            check(device.Present());
            await device.idle();
            gpu.reset();
        },
    };
}

/**
 * DirectDraw as a sprite game draws: a 640x480 back buffer filled with one
 * Blt, `draws` 32x32 sprites put on it with BltFast and a source colour key,
 * the whole of it copied to the primary with one Blt, and the primary
 * presented -- read out of guest memory and uploaded, as a flip shows it --
 * through the graphics layer's services over a flat memory.
 *
 * @param {{ draws: number, depth: 8 | 16 | 32 }} scene
 */
function ddrawScene({ draws, depth }){
    const gpu = quietPasses(createFakeDevice());
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(8 << 20);
    const memory = {
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.slice(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            ram.set(bytes, address),
        windowMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.subarray(address, address + length),
    };
    /** @type {(() => void)[]} */
    const flushes = [];
    const presenter = createPresenter({ schedule: flush=>flushes.push(flush) });
    const shown = presenter.attach({ backend: ()=>backend, ...memory });
    const bpp = depth >>> 3;
    /** @param {number} buffer @param {number} width @param {number} height */
    const surface = (buffer, width, height)=>({ buffer, pitch: width * bpp, width, height,
        bytesPerPixel: bpp });
    const primary = surface(0x100000, 640, 480);
    const back = surface(0x200000, 640, 480);
    const sprite = surface(0x300000, 32, 32);
    for (let at = 0; at < 32 * 32 * bpp; at++)
    {
        ram[sprite.buffer + at] = (at * 7) % 5 === 0 ? 0 : (at * 13) & 0xff;
    }
    const palette = depth === 8 ? Array.from({ length: 256 }, (_, i)=>i * 0x010101) : null;
    const places = Array.from({ length: draws }, (_, index)=>({
        x: (index * 37) % (640 - 32), y: (index * 53) % (480 - 32),
    }));
    const key = { low: 0, high: 0 };
    const fillFx = { fillColor: 0x203040 };
    return {
        gpu,
        async frame(){
            blt({ memory, dest: back, flags: DDRAW.DDBLT_COLORFILL, fx: fillFx });
            for (let index = 0; index < draws; index++)
            {
                bltFast({ memory, dest: back, x: places[index].x, y: places[index].y, src: sprite,
                    flags: DDRAW.DDBLTFAST_SRCCOLORKEY, srcColorKey: key });
            }
            blt({ memory, dest: primary, src: back, flags: 0 });
            shown.present({ buffer: primary.buffer, width: 640, height: 480, pitch: primary.pitch,
                bitCount: depth, palette });
            flushes.splice(0).forEach(flush=>flush());
            gpu.reset();
        },
    };
}

/** @type {Record<string, (draws: number) => { frame: () => Promise<void> }>} */
const SCENES = {
    'ddraw-32': draws=>ddrawScene({ draws, depth: 32 }),
    'ddraw-8': draws=>ddrawScene({ draws, depth: 8 }),
    'd3d8-lit': draws=>directScene({ version: 8, draws }),
    'd3d8-moving': draws=>directScene({ version: 8, draws, moving: true }),
    'd3d9-lit': draws=>directScene({ version: 9, draws }),
    'd3d9-moving': draws=>directScene({ version: 9, draws, moving: true }),
    'd3d9-shader': draws=>directScene({ version: 9, draws, shader: true }),
};

/**
 * The sampled allocation profile's nodes flattened, each with the bytes it
 * allocated itself.
 *
 * @param {any} node @param {{ name: string, url: string, line: number, bytes: number }[]} into
 * @param {{ name: string, url: string, line: number } | null} caller
 */
function flatten(node, into = [], caller = null){
    const frame = node.callFrame;
    // A builtin (a join, an iterator's next) has no script of its own; its
    // allocations are its caller's, which is what can be changed.
    const own = frame.url ? { name: frame.functionName || '(anonymous)', url: frame.url,
        line: frame.lineNumber + 1 } : null;
    const at = own ?? caller;
    const self = node.selfSize ?? 0;
    if (self > 0)
    {
        into.push(own || !at
            ? { ...(at ?? { name: frame.functionName || '(root)', url: '', line: 0 }), bytes: self }
            : { ...at, name: `${frame.functionName} in ${at.name}`, bytes: self });
    }
    for (const child of node.children ?? [])
    {
        flatten(child, into, at);
    }
    return into;
}

/** @param {string} url */
const isDouble = url=>url.includes('fake-device.js') || url.includes('draw-alloc-bench');

/**
 * @param {{ frame: () => Promise<void> }} scene @param {number} frames
 * @param {number} interval
 */
async function allocationsOf(scene, frames, interval){
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
        samplingInterval: interval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
    });
    for (let frame = 0; frame < frames; frame++)
    {
        await scene.frame();
    }
    const { profile } = await session.post('HeapProfiler.stopSampling');
    await session.post('HeapProfiler.disable');
    session.disconnect();
    const nodes = flatten(profile.head);
    let engine = 0;
    let double = 0;
    /** @type {Map<string, { name: string, where: string, bytes: number }>} */
    const byFunction = new Map();
    for (const node of nodes)
    {
        if (isDouble(node.url))
        {
            double += node.bytes;
            continue;
        }
        engine += node.bytes;
        const where = node.url.startsWith('file:')
            ? `${relative(ROOT, fileURLToPath(node.url))}:${node.line}` : node.url;
        const key = `${node.name}@${where}`;
        const held = byFunction.get(key) ?? { name: node.name, where, bytes: 0 };
        held.bytes += node.bytes;
        byFunction.set(key, held);
    }
    return { engine, double, byFunction };
}

/** @param {{ frame: () => Promise<void> }} scene @param {number} frames */
async function timeOf(scene, frames){
    /** @type {number[]} */
    const pauses = [];
    const observer = new PerformanceObserver(list=>{
        for (const entry of list.getEntries())
        {
            pauses.push(entry.duration);
        }
    });
    observer.observe({ entryTypes: ['gc'] });
    const start = performance.now();
    for (let frame = 0; frame < frames; frame++)
    {
        await scene.frame();
    }
    const elapsed = performance.now() - start;
    // The observer is told after the fact; a turn of the loop lets it hear,
    // and what it has not been handed yet is taken.
    await new Promise(done=>setTimeout(done, 10));
    for (const entry of observer.takeRecords())
    {
        pauses.push(entry.duration);
    }
    observer.disconnect();
    return { elapsed, pauses };
}

async function main(){
    const options = parse(process.argv.slice(2));
    const make = SCENES[options.scene];
    if (!make)
    {
        throw new Error(`no scene ${options.scene}; there are ${Object.keys(SCENES).join(', ')}`);
    }
    const warm = Math.max(10, options.frames >> 2);
    /** @type {Record<string, any>} */
    const runs = {};
    for (const draws of [options.draws, options.draws * 2])
    {
        const scene = make(draws);
        for (let frame = 0; frame < warm; frame++)
        {
            await scene.frame();
        }
        const timed = await timeOf(scene, options.frames);
        const allocated = await allocationsOf(scene, options.frames, options.interval);
        runs[draws] = { timed, allocated };
    }
    const small = runs[options.draws];
    const large = runs[options.draws * 2];
    const drawn = options.draws * options.frames;
    const perDraw = (/** @type {number} */ a, /** @type {number} */ b)=>(b - a) / drawn;
    const pauses = large.timed.pauses;
    const result = {
        scene: options.scene,
        draws: options.draws,
        frames: options.frames,
        engineBytesPerDraw: perDraw(small.allocated.engine, large.allocated.engine),
        engineBytesPerFrame: large.allocated.engine / options.frames,
        doubleBytesPerFrame: large.allocated.double / options.frames,
        microsecondsPerDraw: perDraw(small.timed.elapsed, large.timed.elapsed) * 1000,
        millisecondsPerFrame: large.timed.elapsed / options.frames,
        collections: pauses.length,
        pauseTotalMs: pauses.reduce((sum, one)=>sum + one, 0),
        pauseLongestMs: pauses.reduce((most, one)=>Math.max(most, one), 0),
        top: [...large.allocated.byFunction.values()].sort((a, b)=>b.bytes - a.bytes)
            .slice(0, options.top)
            .map(entry=>({ ...entry, bytesPerDraw: entry.bytes / (options.draws * 2
                * options.frames) })),
    };
    if (options.json)
    {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    const round = (/** @type {number} */ value, digits = 1)=>value.toFixed(digits);
    console.log(`${result.scene}: ${result.draws} and ${result.draws * 2} draws a frame, `
        + `${result.frames} frames`);
    console.log(`  engine bytes a draw   ${round(result.engineBytesPerDraw)}`);
    console.log(`  engine bytes a frame  ${round(result.engineBytesPerFrame, 0)} `
        + `(${2 * result.draws} draws; the double's own ${round(result.doubleBytesPerFrame, 0)})`);
    console.log(`  us a draw             ${round(result.microsecondsPerDraw, 2)}`);
    console.log(`  ms a frame            ${round(result.millisecondsPerFrame, 2)}`);
    const pausedMs = round(result.pauseTotalMs, 2);
    const longestMs = round(result.pauseLongestMs, 2);
    console.log(`  collections           ${result.collections}, ${pausedMs} ms in all, `
        + `the longest ${longestMs} ms`);
    console.log('  the engine\'s allocations, bytes a draw at 2N:');
    for (const entry of result.top)
    {
        console.log(`    ${round(entry.bytesPerDraw).padStart(8)}  ${entry.name}  ${entry.where}`);
    }
}

await main();
