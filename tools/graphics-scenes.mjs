/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The scenes the graphics benchmarks drive a device with, frame after frame:
 * Direct3D 8 and 9 draws of a lit, textured cube and through shaders, and
 * DirectDraw sprites (see `SCENES`). `tools/draw-alloc-bench.mjs` runs them in
 * node over the recording double; `tools/graphics-bench` in a browser worker
 * over a real device. The graphics layer they drive is the one under the
 * `root` parameter of this module's URL -- another checkout's for a tree
 * before a change against one after -- and this checkout's without it.
 */

/**
 * The GPU a scene draws on: a device and its queue, and what makes the GPU
 * ready for the next frame (the double forgets what it recorded).
 *
 * `mark`, when given, is told `recorded` as a frame's calls are made and before it is
 * presented, and `replayed` once its replay onto the device is done.
 *
 * `modelOnly` gives a Direct3D device no backend: it keeps its state and answers, and
 * nothing is rendered -- what the calls cost without the renderer behind them.
 *
 * `root`, when given, makes the Direct3D root from its factory and services in
 * the scene's place: a root whose calls are recorded and sent elsewhere.
 * `opengl` does the same for OpenGL's root (`createOpengl`'s `remote`), and
 * `d3d7` for a Direct3D 7 object over its DirectDraw object (the seam's
 * `remote`).
 *
 * @typedef {{ device: any, queue: any, reset: () => void,
 *     mark?: (name: 'recorded' | 'replayed') => void, modelOnly?: boolean,
 *     root?: (factory: (services: any) => any, services: any) => any,
 *     opengl?: (factory: (services: any) => any, services: any) => any,
 *     d3d7?: (ddraw: any, services: any) => any }} SceneGpu
 */

const GRAPHICS = new URL(import.meta.url).searchParams.get('root')
    ?? new URL('../modules/core/src/layers/graphics', import.meta.url).href;

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
const { FVF } = await import(`${GRAPHICS}/webgpu/internal/vertexformat.js`);
const { blt, bltFast } = await import(`${GRAPHICS}/ddraw/blit.js`);
const DDRAW = await import(`${GRAPHICS}/ddraw/constants.js`);
const { createPresenter } = await import(`${GRAPHICS}/webgpu/internal/presenter.js`);
const { createOpengl } = await import(`${GRAPHICS}/opengl/exports.js`);
const { GL } = await import(`${GRAPHICS}/opengl/constants.js`);
const { createDirect3D7 } = await import(`${GRAPHICS}/d3d7/device.js`);
const D3D7 = await import(`${GRAPHICS}/d3d7/constants.js`);
const { createDirectDraw } = await import(`${GRAPHICS}/ddraw/objects.js`);

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
 * matrix constants are set before every draw, or through a vertex shader
 * alone with the fixed pixel stage after it (`shader: 'vertex'`). With
 * `rebind`, every draw sets its declaration, its shader and its stream again,
 * the stream alternating between two buffers of one layout -- how a program
 * that draws each model through its own buffer goes.
 *
 * @param {{ version: 8 | 9, draws: number, gpu: SceneGpu, moving?: boolean,
 *     shader?: boolean | 'vertex', rebind?: boolean }} scene
 */
function directScene({ version, draws, gpu, moving = false, shader = false, rebind = false }){
    const nine = version === 9;
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(8 << 20);
    let next = RAM_BASE + (4 << 20);
    const services = {
        backend: gpu.modelOnly ? undefined : backend,
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        windowMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.subarray(address - RAM_BASE, address - RAM_BASE + length),
        // A real device's own, so that what is drawn on one is drawn; the
        // double makes none.
        createSampler: (/** @type {any} */ descriptor)=>gpu.device.createSampler?.(descriptor)
            ?? ({ kind: 'sampler', descriptor }),
        allocate: (/** @type {number} */ bytes)=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
    };
    const make = gpu.root ?? ((/** @type {any} */ factory, /** @type {any} */ given)=>
        factory(given));
    const d3d = nine
        ? make(createDirect3D9, { ...services, vertexShaderVersion: { major: 2, minor: 0 },
            pixelShaderVersion: { major: 2, minor: 0 } })
        : make(createDirect3D8, services);
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
    /** @type {{ buffer?: any }} */
    const otherVertices = {};
    check(device.CreateVertexBuffer(24 * stride, 0, fvf, D3DPOOL.MANAGED, otherVertices));
    check(otherVertices.buffer.Lock(0, 0, locked, 0));
    ram.copyWithin(/** @type {number} */ (locked.pBits) - RAM_BASE, view.byteOffset,
        view.byteOffset + 24 * stride);
    check(otherVertices.buffer.Unlock());

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
    /** @type {{ shader?: any, declaration?: any }} */
    const made = {};
    /** @type {any} */
    let vertexShader = null;
    if (shader)
    {
        check(device.CreateVertexDeclaration(CUBE_ELEMENTS, made));
        check(device.SetVertexDeclaration(made.declaration));
        check(device.CreateVertexShader(VERTEX_SHADER, made));
        vertexShader = made.shader;
        check(device.SetVertexShader(vertexShader));
        if (shader !== 'vertex')
        {
            check(device.CreatePixelShader(PIXEL_SHADER, made));
            check(device.SetPixelShader(made.shader));
            check(device.SetPixelShaderConstantF(2, [0.1, 0.2, 0.3, 0.4], 1));
        }
    }
    const declaration = made.declaration;
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
                if (rebind)
                {
                    check(device.SetVertexDeclaration(declaration), index);
                    check(device.SetStreamSource(0,
                        (index & 1 ? otherVertices : vertices).buffer, 0, stride), index);
                    check(device.SetVertexShader(vertexShader), index);
                }
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
            gpu.mark?.('recorded');
            const presented = device.Present();
            if (gpu.root)
            {
                // Played elsewhere: the present is the frame's last call
                // here, and what it holds the caller on is a wait.
                gpu.mark?.('replayed');
                check(await presented);
            }
            else
            {
                check(presented);
                await device.idle();
                gpu.mark?.('replayed');
            }
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
 * @param {{ draws: number, depth: 8 | 16 | 32, gpu: SceneGpu }} scene
 */
function ddrawScene({ draws, depth, gpu }){
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
            gpu.mark?.('recorded');
            shown.present({ buffer: primary.buffer, width: 640, height: 480, pitch: primary.pitch,
                bitCount: depth, palette });
            flushes.splice(0).forEach(flush=>flush());
            gpu.mark?.('replayed');
            gpu.reset();
        },
    };
}

/** A float's bits, as a guest pushes it. */
const floatWord = (()=>{
    const view = new DataView(new ArrayBuffer(4));
    return (/** @type {number} */ value)=>{
        view.setFloat32(0, value, true);
        return view.getUint32(0, true);
    };
})();

/**
 * OpenGL as a game of the Doom 3 or Quake III era draws, through OPENGL32's
 * own exports over a flat guest memory: a window's context, four textures,
 * and a frame of `draws` glDrawElements of 300 to 3,000 32-bit indices from
 * client memory, each after a texture bind, a blend, a depth mask, a matrix
 * and a colour -- the vertices in a buffer object (`client: false`, Doom 3)
 * or in client arrays the frame rewrites (`client: true`, Quake III) -- and a
 * swap that waits for the frame's replay.
 *
 * @param {{ draws: number, gpu: SceneGpu, client: boolean }} scene
 */
function openglScene({ draws, gpu, client }){
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const bytes = new Uint8Array(24 << 20);
    const view = new DataView(bytes.buffer);
    let next = 16 << 20;
    const opengl = createOpengl({
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
            bytes.set(value, at),
        scratch: { allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 15 & ~15;
            return at;
        } },
        screen: ()=>({ width: 640, height: 480 }),
        present: ()=>{},
        presenter: ()=>({ claim: ()=>{} }),
        backend: ()=>backend,
        createSampler: (/** @type {any} */ descriptor)=>gpu.device.createSampler?.(descriptor)
            ?? ({ kind: 'sampler', descriptor }),
        // A swap waits for its frame's replay, as the run's latency bound
        // would once frames were in flight.
        frameQueued: (/** @type {any} */ settled)=>settled,
        exportAddress: ()=>0x10000000,
        remote: gpu.opengl,
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        opengl.table);
    /** @param {string} name @param {number[]} args */
    const gl = (name, ...args)=>table[name].handler(args);
    const hdc = 0x900d;
    gl('wglSetPixelFormat', hdc, 1, 0);
    gl('wglMakeCurrent', hdc, gl('wglCreateContext', hdc));
    const STRIDE = 32;
    const VERTICES = 4096;
    for (let i = 0; i < VERTICES; i++)
    {
        view.setFloat32(0x100000 + i * STRIDE, (i % 64) / 32 - 1, true);
        view.setFloat32(0x100000 + i * STRIDE + 4, (i >> 6) / 32 - 1, true);
        view.setFloat32(0x100000 + i * STRIDE + 8, 0.5, true);
        view.setFloat32(0x100000 + i * STRIDE + 12, (i % 64) / 64, true);
        view.setFloat32(0x100000 + i * STRIDE + 16, (i >> 6) / 64, true);
    }
    gl('glGenBuffersARB', 1, 0x1000);
    const vbo = view.getUint32(0x1000, true);
    if (!client)
    {
        gl('glBindBufferARB', GL.ARRAY_BUFFER, vbo);
        gl('glBufferDataARB', GL.ARRAY_BUFFER, VERTICES * STRIDE, 0x100000, GL.STATIC_DRAW);
        gl('glBindBufferARB', GL.ARRAY_BUFFER, 0);
    }
    gl('glGenTextures', 4, 0x1000);
    const textures = [0, 1, 2, 3].map(i=>view.getUint32(0x1000 + i * 4, true));
    for (const name of textures)
    {
        gl('glBindTexture', GL.TEXTURE_2D, name);
        gl('glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
        gl('glTexImage2D', GL.TEXTURE_2D, 0, GL.RGBA, 64, 64, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            0x80000);
    }
    const counts = Array.from({ length: draws }, (_, i)=>300 + (i * 997) % 2700);
    let at = 0x200000;
    const lists = counts.map(count=>{
        const base = at;
        for (let i = 0; i < count; i++)
        {
            view.setUint32(base + i * 4, (i * 7) % VERTICES, true);
        }
        at += count * 4 + 64;
        return base;
    });
    gl('glEnable', GL.TEXTURE_2D);
    gl('glEnable', GL.DEPTH_TEST);
    let frames = 0;
    return {
        gpu,
        async frame(){
            gl('glClear', GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
            gl('glEnableClientState', GL.VERTEX_ARRAY);
            gl('glEnableClientState', GL.TEXTURE_COORD_ARRAY);
            if (client)
            {
                // What moves this frame, written where the arrays point.
                view.setFloat32(0x100000 + (frames % VERTICES) * STRIDE + 8, frames % 2, true);
            }
            else
            {
                gl('glBindBufferARB', GL.ARRAY_BUFFER, vbo);
            }
            const base = client ? 0x100000 : 0;
            gl('glVertexPointer', 3, GL.FLOAT, STRIDE, base);
            gl('glTexCoordPointer', 2, GL.FLOAT, STRIDE, base + 12);
            for (let d = 0; d < draws; d++)
            {
                gl('glBindTexture', GL.TEXTURE_2D, textures[d & 3]);
                gl('glEnable', GL.BLEND);
                gl('glBlendFunc', GL.ONE, GL.ONE);
                gl('glDepthMask', d & 1);
                gl('glMatrixMode', GL.MODELVIEW);
                gl('glLoadIdentity');
                gl('glTranslatef', floatWord(d / draws), floatWord(0), floatWord(-0.5));
                gl('glColor4f', floatWord(1), floatWord(1), floatWord(1), floatWord(1));
                gl('glDrawElements', GL.TRIANGLES, counts[d], GL.UNSIGNED_INT, lists[d]);
            }
            frames++;
            gpu.mark?.('recorded');
            await gl('wglSwapBuffers', hdc);
            gpu.mark?.('replayed');
            gpu.reset();
        },
    };
}

/**
 * OpenGL as a Quake 3 renderer draws: each surface written into the same
 * client arrays (positions, two texture-coordinate sets, colours), locked
 * with glLockArraysEXT, and drawn once a stage -- glColor4ubv and
 * glDrawElements of its indices -- before the unlock. `draws` is the count of
 * glDrawElements a frame, three stages a surface.
 *
 * @param {{ draws: number, gpu: SceneGpu }} scene
 */
function openglTessScene({ draws, gpu }){
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const bytes = new Uint8Array(24 << 20);
    const view = new DataView(bytes.buffer);
    let next = 16 << 20;
    const opengl = createOpengl({
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
            bytes.set(value, at),
        scratch: { allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 15 & ~15;
            return at;
        } },
        screen: ()=>({ width: 640, height: 480 }),
        present: ()=>{},
        presenter: ()=>({ claim: ()=>{} }),
        backend: ()=>backend,
        createSampler: (/** @type {any} */ descriptor)=>gpu.device.createSampler?.(descriptor)
            ?? ({ kind: 'sampler', descriptor }),
        frameQueued: (/** @type {any} */ settled)=>settled,
        exportAddress: ()=>0x10000000,
        remote: gpu.opengl,
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        opengl.table);
    /** @param {string} name @param {number[]} args */
    const gl = (name, ...args)=>table[name].handler(args);
    const hdc = 0x900d;
    gl('wglSetPixelFormat', hdc, 1, 0);
    gl('wglMakeCurrent', hdc, gl('wglCreateContext', hdc));
    // The tesselator's arrays, as Quake 3 keeps them: 1000 vertices at most.
    const XYZ = 0x100000;
    const ST0 = 0x110000;
    const ST1 = 0x118000;
    const RGBA = 0x120000;
    const INDEXES = 0x128000;
    const COLOUR = 0x130000;
    const VERTICES = 170;
    const INDICES = 510;
    for (let i = 0; i < INDICES; i++)
    {
        view.setUint32(INDEXES + i * 4, (i * 7) % VERTICES, true);
    }
    view.setUint32(COLOUR, 0xffc0a080, true);
    gl('glGenTextures', 4, 0x1000);
    const textures = [0, 1, 2, 3].map(i=>view.getUint32(0x1000 + i * 4, true));
    for (const name of textures)
    {
        gl('glBindTexture', GL.TEXTURE_2D, name);
        gl('glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
        gl('glTexImage2D', GL.TEXTURE_2D, 0, GL.RGBA, 64, 64, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            0x80000);
    }
    gl('glEnable', GL.TEXTURE_2D);
    gl('glEnable', GL.DEPTH_TEST);
    const surfaces = Math.max(1, Math.round(draws / 3));
    let frames = 0;
    return {
        gpu,
        async frame(){
            gl('glClear', GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
            gl('glEnableClientState', GL.VERTEX_ARRAY);
            gl('glEnableClientState', GL.TEXTURE_COORD_ARRAY);
            gl('glVertexPointer', 3, GL.FLOAT, 16, XYZ);
            gl('glTexCoordPointer', 2, GL.FLOAT, 0, ST0);
            for (let s = 0; s < surfaces; s++)
            {
                // The surface, written over the last one where the arrays point.
                for (let v = 0; v < VERTICES; v++)
                {
                    view.setFloat32(XYZ + v * 16, ((v + s) % 32) / 16 - 1, true);
                    view.setFloat32(XYZ + v * 16 + 4, ((v * 3 + frames) % 32) / 16 - 1, true);
                    view.setFloat32(XYZ + v * 16 + 8, 0.5, true);
                    view.setFloat32(ST0 + v * 8, (v % 8) / 8, true);
                    view.setFloat32(ST0 + v * 8 + 4, (s % 8) / 8, true);
                    view.setFloat32(ST1 + v * 8, (v % 4) / 4, true);
                    view.setFloat32(ST1 + v * 8 + 4, (s % 4) / 4, true);
                    view.setUint32(RGBA + v * 4, 0xff808080 + v, true);
                }
                gl('glLockArraysEXT', 0, VERTICES);
                for (let stage = 0; stage < 3; stage++)
                {
                    gl('glBindTexture', GL.TEXTURE_2D, textures[(s + stage) & 3]);
                    gl('glTexCoordPointer', 2, GL.FLOAT, 0, stage === 1 ? ST1 : ST0);
                    if (stage === 2)
                    {
                        gl('glEnableClientState', GL.COLOR_ARRAY);
                        gl('glColorPointer', 4, GL.UNSIGNED_BYTE, 0, RGBA);
                    }
                    else
                    {
                        gl('glDisableClientState', GL.COLOR_ARRAY);
                        gl('glColor4ubv', COLOUR);
                    }
                    gl('glDrawElements', GL.TRIANGLES, INDICES, GL.UNSIGNED_INT, INDEXES);
                }
                gl('glUnlockArraysEXT');
            }
            frames++;
            gpu.mark?.('recorded');
            await gl('wglSwapBuffers', hdc);
            gpu.mark?.('replayed');
            gpu.reset();
        },
    };
}

/**
 * Direct3D 7 as a game of its era draws: a 640x480 target with a depth
 * buffer attached, two textures, and a frame of `draws` lit draws of a
 * vertex buffer through indices by pointer, a world matrix and a texture
 * before each, presented as a flip shows the target -- through the
 * presenter's claim -- and waited for.
 *
 * @param {{ draws: number, gpu: SceneGpu }} scene
 */
function d3d7Scene({ draws, gpu }){
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(4 << 20);
    let next = 0x10000;
    const root = createDirectDraw({ version: 7, screenWidth: 640, screenHeight: 480,
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes + 0xfff & ~0xfff;
            return at;
        } });
    root.setCooperativeLevel(0x10044, DDRAW.DDSCL_NORMAL);
    /** @type {Map<number, () => unknown>} */
    const claims = new Map();
    const services = {
        backend: gpu.d3d7 ? undefined : backend,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            ram.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
            ram.set(value, at),
        createSampler: (/** @type {any} */ descriptor)=>gpu.device.createSampler?.(descriptor)
            ?? ({ kind: 'sampler', descriptor }),
        presenter: {
            claim: (/** @type {number} */ buffer, /** @type {() => unknown} */ show)=>
                claims.set(buffer, show),
            release: (/** @type {number} */ buffer)=>claims.delete(buffer),
        },
    };
    const d3d = gpu.d3d7 ? gpu.d3d7(root, services) : createDirect3D7(root, services);
    /** @param {any} request */
    const made = request=>root.createSurface(request).surface;
    const ARGB = { size: 0x20, flags: DDRAW.DDPF_RGB | DDRAW.DDPF_ALPHAPIXELS, fourCC: 0,
        bitCount: 32, redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff,
        alphaMask: 0xff000000 };
    const sized = DDRAW.DDSD_CAPS | DDRAW.DDSD_WIDTH | DDRAW.DDSD_HEIGHT;
    const target = made({ flags: sized, caps: DDRAW.DDSCAPS_3DDEVICE | DDRAW.DDSCAPS_OFFSCREENPLAIN,
        width: 640, height: 480 });
    const depth = made({ flags: sized | DDRAW.DDSD_ZBUFFERBITDEPTH, caps: DDRAW.DDSCAPS_ZBUFFER,
        width: 640, height: 480, zBufferBitDepth: 16 });
    target.addAttachedSurface(depth);
    const textures = [0, 1].map(()=>made({ flags: sized | DDRAW.DDSD_PIXELFORMAT,
        caps: DDRAW.DDSCAPS_TEXTURE, width: 64, height: 64, pixelFormat: ARGB }));
    const device = d3d.createDevice(D3D7.DEVICE_IDS.TNLHAL, target).device;
    const fvf = FVF.XYZ | FVF.NORMAL | (1 << FVF.TEXCOUNT_SHIFT);
    const buffer = d3d.createVertexBuffer({ caps: 0, fvf, numVertices: 24 }).buffer;
    buffer.Lock(0, {});
    buffer.Unlock();
    const indices = 0x300000;
    ram.set(new Uint8Array(Uint16Array.from({ length: 36 }, (_, i)=>i % 24).buffer), indices);
    device.SetRenderState(D3D7.D3DRENDERSTATE.LIGHTING, 1);
    device.SetLight(0, light());
    device.LightEnable(0, 1);
    const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
    return {
        gpu,
        async frame(){
            device.BeginScene();
            device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0);
            for (let d = 0; d < draws; d++)
            {
                world[12] = (d % 20) / 10 - 1;
                device.SetTransform(D3D7.D3DTRANSFORMSTATE.WORLD, world);
                device.SetTexture(0, textures[d & 1]);
                device.DrawIndexedPrimitiveVB(D3DPT.TRIANGLELIST, buffer, 0, 24, indices, 36);
            }
            device.EndScene();
            gpu.mark?.('recorded');
            await /** @type {() => unknown} */ (claims.get(target.buffer))();
            await device.idle();
            gpu.mark?.('replayed');
            gpu.reset();
        },
    };
}

/**
 * Each scene by name: a builder of it over `draws` draws a frame on the GPU given.
 *
 * @type {Record<string, (draws: number, gpu: SceneGpu) => { frame: () => Promise<void> }>}
 */
export const SCENES = {
    'ddraw-32': (draws, gpu)=>ddrawScene({ draws, depth: 32, gpu }),
    'gl-buffers': (draws, gpu)=>openglScene({ draws, gpu, client: false }),
    'gl-client': (draws, gpu)=>openglScene({ draws, gpu, client: true }),
    'gl-tess': (draws, gpu)=>openglTessScene({ draws, gpu }),
    'd3d7-lit': (draws, gpu)=>d3d7Scene({ draws, gpu }),
    'ddraw-8': (draws, gpu)=>ddrawScene({ draws, depth: 8, gpu }),
    'd3d8-lit': (draws, gpu)=>directScene({ version: 8, draws, gpu }),
    'd3d8-moving': (draws, gpu)=>directScene({ version: 8, draws, gpu, moving: true }),
    'd3d9-lit': (draws, gpu)=>directScene({ version: 9, draws, gpu }),
    'd3d9-moving': (draws, gpu)=>directScene({ version: 9, draws, gpu, moving: true }),
    'd3d9-shader': (draws, gpu)=>directScene({ version: 9, draws, gpu, shader: true }),
    'd3d9-vertex-shader': (draws, gpu)=>directScene({ version: 9, draws, gpu, shader: 'vertex',
        rebind: true }),
};
