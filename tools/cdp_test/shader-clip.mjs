/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The clip-plane gate: user clip planes have two paths -- the distances the
 * device clips by (WebGPU's `clip-distances`) and the varyings a fragment
 * stage discards on -- and this draws seeded random fixed-function triangles
 * under seeded random planes and world transforms down both, on a real GPU,
 * and compares every pixel each covers.
 *
 *   node tools/cdp_test/shader-clip.mjs [--count 40] [--seed 1] [--headed]
 *
 * The two agree wherever a plane does not pass within the rounding of a
 * pixel's centre; a pixel the two paths disagree on is a failure unless it
 * lies on the edge of what one of them drew, which is where that rounding
 * decides, and such pixels are counted apart. An adapter without
 * `clip-distances` measures nothing, and the gate says so and exits 2.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { generator } from './shader-cases.mjs';
import { generateFixedFunction } from
    '../../modules/core/src/layers/graphics/webgpu/internal/fixedfunction.js';
import { FVF, decodeFvf } from
    '../../modules/core/src/layers/graphics/webgpu/internal/vertexformat.js';
import {
    UNIFORM_AT, UNIFORM_FLOATS, clipPlanesOf,
} from '../../modules/core/src/layers/graphics/d3d8/render.js';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
/** The target's side, in pixels. */
const SIZE = 16;
const FORMAT = FVF.XYZ | FVF.DIFFUSE;

/**
 * One case: a triangle, a world, the planes, and the module and block of
 * each path.
 *
 * @param {number} seed
 */
export function clipCase(seed){
    const next = generator(seed);
    const between = (/** @type {number} */ low, /** @type {number} */ high)=>
        Math.fround(low + next() * (high - low));
    // A world near the identity, so the triangle stays in view: a turn, a
    // scale and a move of up to a quarter.
    const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const at of [0, 1, 4, 5])
    {
        world[at] += between(-0.4, 0.4);
    }
    world[12] = between(-0.25, 0.25);
    world[13] = between(-0.25, 0.25);
    let mask = 0;
    while (mask === 0)
    {
        mask = Math.floor(next() * 64);
    }
    const planes = new Map();
    for (let index = 0; index < 6; index++)
    {
        // Through the view, mostly: each keeps some of it and cuts some away.
        planes.set(index, [between(-1, 1), between(-1, 1), between(-1, 1), between(0.1, 0.9)]);
    }
    // Large enough to cover most of the target, whatever its corners.
    const triangle = [[between(-1.6, -0.8), between(-1.6, -0.8), 0.5],
        [between(0.8, 2.4), between(-1.6, 0.4), 0.5], [between(-1.6, 0.4), between(0.8, 2.4), 0.5]];
    const model = /** @type {any} */ ({ renderStates: new Map(), clipPlanes: planes });
    const block = new Float32Array(UNIFORM_FLOATS);
    // The world is the whole transform: view and projection the identity.
    block.set(world, UNIFORM_AT.worldViewProjection);
    block.set(world, UNIFORM_AT.world);
    const objectPlanes = clipPlanesOf(model, mask, world);
    const state = (/** @type {boolean} */ distances)=>({
        fvf: FORMAT, vertexShader: 0, pixelShader: 0, targetFormat: 'rgba8unorm',
        depthTest: false, depthWrite: false, depthFunc: 8, cullMode: 1, blend: false,
        srcBlend: 2, destBlend: 1, blendOp: 1, colorWrite: 0xf, alphaTest: false, alphaFunc: 8,
        fogMode: 0, stages: [], clipPlanes: mask, clipDistances: distances,
    });
    return {
        seed, mask, triangle,
        block: [...block, ...objectPlanes],
        modules: [false, true].map(distances=>
            generateFixedFunction(state(distances), decodeFvf(FORMAT)).code),
    };
}

/** The page's side: each case drawn down both paths, the coverage of each read back. */
function pageRunner(){
    const gateWindow = /** @type {any} */ (globalThis);
    gateWindow.clipRun = async(/** @type {any[]} */ cases, /** @type {number} */ size)=>{
        const adapter = await /** @type {any} */ (navigator).gpu?.requestAdapter();
        if (!adapter)
        {
            return { error: 'no adapter' };
        }
        if (!adapter.features.has('clip-distances'))
        {
            return { error: 'the adapter has no clip-distances' };
        }
        const device = await adapter.requestDevice({ requiredFeatures: ['clip-distances'] });
        const results = [];
        for (const c of cases)
        {
            const covered = [];
            device.pushErrorScope('validation');
            for (const code of c.modules)
            {
                const module = device.createShaderModule({ code });
                const pipeline = device.createRenderPipeline({ layout: 'auto',
                    vertex: { module, entryPoint: 'vertexMain', buffers: [{ arrayStride: 16,
                        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' },
                            { shaderLocation: 1, offset: 12, format: 'unorm8x4' }] }] },
                    fragment: { module, entryPoint: 'fragmentMain',
                        targets: [{ format: 'rgba8unorm' }] },
                    primitive: { topology: 'triangle-list' } });
                const vertices = new ArrayBuffer(48);
                const floats = new Float32Array(vertices);
                const words = new Uint32Array(vertices);
                c.triangle.forEach((/** @type {number[]} */ point, /** @type {number} */ at)=>{
                    floats.set(point, at * 4);
                    words[at * 4 + 3] = 0xffffffff;
                });
                const vertexBuffer = device.createBuffer({ size: 48, usage: 0x20 | 0x08 });
                device.queue.writeBuffer(vertexBuffer, 0, vertices);
                const uniforms = device.createBuffer({ size: c.block.length * 4,
                    usage: 0x40 | 0x08 });
                device.queue.writeBuffer(uniforms, 0, new Float32Array(c.block));
                const target = device.createTexture({ size: [size, size], format: 'rgba8unorm',
                    usage: 0x10 | 0x01 });
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginRenderPass({ colorAttachments: [{
                    view: target.createView(), loadOp: 'clear', storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [{ binding: 0, resource: { buffer: uniforms } }] }));
                pass.setVertexBuffer(0, vertexBuffer);
                pass.draw(3);
                pass.end();
                const readBack = device.createBuffer({ size: 256 * size, usage: 0x01 | 0x08 });
                encoder.copyTextureToBuffer({ texture: target }, { buffer: readBack,
                    bytesPerRow: 256 }, [size, size]);
                device.queue.submit([encoder.finish()]);
                await readBack.mapAsync(1);
                const bytes = new Uint8Array(readBack.getMappedRange());
                const mask = [];
                for (let y = 0; y < size; y++)
                {
                    for (let x = 0; x < size; x++)
                    {
                        mask.push(bytes[y * 256 + x * 4] !== 0 ? 1 : 0);
                    }
                }
                readBack.unmap();
                covered.push(mask);
            }
            const invalid = await device.popErrorScope();
            results.push({ covered, error: invalid ? invalid.message : null });
        }
        return { adapter: adapter.info ? { vendor: adapter.info.vendor,
            architecture: adapter.info.architecture } : null, results };
    };
}

/**
 * Whether a pixel lies on the edge of what a path drew: a neighbour differs.
 *
 * @param {number[]} mask @param {number} x @param {number} y
 */
const onEdge = (mask, x, y)=>[[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy])=>{
    const nx = x + dx;
    const ny = y + dy;
    return nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE
        && mask[ny * SIZE + nx] !== mask[y * SIZE + x];
});

/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>{
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : fallback;
};

async function main(){
    const count = Number(flag('--count', '40'));
    const seed = Number(flag('--seed', '1'));
    const cases = Array.from({ length: count }, (_, k)=>clipCase(seed * 1000003 + k));
    const server = await serveStatic({ sandboxDir: TOOL_ROOT, srcDir: TOOL_ROOT });
    const browser = await launchWithGpu({ headed: process.argv.includes('--headed') });
    /** @type {CdpEndpoint | null} */
    let cdp = null;
    try
    {
        cdp = new CdpEndpoint(browser.browserWs);
        await cdp.open();
        const { targetId } = await cdp.send('Target.createTarget',
            { url: `http://127.0.0.1:${server.port}/sandbox/shader-gate.html` });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, sessionId);
        for (let tries = 0; ; tries++)
        {
            const loaded = await cdp.send('Runtime.evaluate', {
                expression: 'location.pathname.endsWith(\'shader-gate.html\')'
                    + ' && document.readyState === \'complete\'',
                returnByValue: true,
            }, sessionId);
            if (loaded.result?.value === true)
            {
                break;
            }
            if (tries > 100)
            {
                throw new Error('the gate page did not load');
            }
            await new Promise(done=>setTimeout(done, 100));
        }
        await cdp.send('Runtime.evaluate', { expression: `(${pageRunner.toString()})(); null` },
            sessionId);
        const answer = await cdp.send('Runtime.evaluate', {
            expression: `clipRun(${JSON.stringify(cases)}, ${SIZE}).then(r => JSON.stringify(r))`,
            awaitPromise: true, returnByValue: true,
        }, sessionId);
        if (answer.exceptionDetails)
        {
            throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails)}`);
        }
        const ran = JSON.parse(answer.result.value);
        if (ran.error)
        {
            console.error(`not measured: ${ran.error}`);
            return 2;
        }
        let passed = 0;
        let edges = 0;
        let covered = 0;
        ran.results.forEach((/** @type {any} */ result, /** @type {number} */ at)=>{
            const [discarded, clipped] = result.covered;
            let wrong = 0;
            for (let y = 0; y < SIZE; y++)
            {
                for (let x = 0; x < SIZE; x++)
                {
                    const index = y * SIZE + x;
                    covered += discarded[index];
                    if (discarded[index] === clipped[index])
                    {
                        continue;
                    }
                    if (onEdge(discarded, x, y) || onEdge(clipped, x, y))
                    {
                        edges++;
                    }
                    else
                    {
                        wrong++;
                    }
                }
            }
            if (result.error || wrong > 0)
            {
                console.log(`FAIL seed ${cases[at].seed} planes ${cases[at].mask.toString(2)}:`
                    + ` ${result.error ?? `${wrong} pixels apart`}`);
            }
            else
            {
                passed++;
            }
        });
        console.log(`clip planes: ${passed}/${cases.length} pass, ${covered} pixels drawn by the`
            + ` discard path${edges ? `, ${edges} on an edge where rounding decides, not compared`
                : ''}`);
        console.log(`adapter: ${JSON.stringify(ran.adapter)}`);
        return passed === cases.length ? 0 : 1;
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().then(code=>process.exit(code), error=>{
        console.error(error);
        process.exit(2);
    });
}
