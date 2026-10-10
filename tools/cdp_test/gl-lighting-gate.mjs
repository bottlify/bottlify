/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GL lighting gate: seeded random fixed-pipeline lighting -- lights,
 * material, light model, colour material, normal matrix -- down both paths:
 * the processor's (`lightVertex`, as a context lights a vertex it assembles)
 * and the device's (`lightingFunction`, the vertex stage a lit draw by arrays
 * runs), the latter as a compute dispatch on a real WebGPU device, every lit
 * colour compared.
 *   node tools/cdp_test/gl-lighting-gate.mjs [--count 60] [--vertices 32] [--seed 1] [--headed]
 * The processor works in doubles and the device in floats, so a component
 * passes within a tolerance; a vertex sitting on a spot cone's edge or on a
 * surface's terminator is decided by the last bit on either side, and one
 * that agrees with the reference only once the edge is moved by a hair is
 * counted apart, not failed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { generator } from './shader-cases.mjs';
import {
    LIGHTS, UNIFORM, UNIFORM_STRUCT, lightingFunction, lightingStateOf, writeLighting,
} from '../../modules/core/src/layers/graphics/opengl/wgsl.js';
import {
    colourMaterialTargets, lightVertex, normalMatrix, normalise,
} from '../../modules/core/src/layers/graphics/opengl/lighting.js';
import { GL } from '../../modules/core/src/layers/graphics/opengl/constants.js';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/** A component passes within this of the reference. */
export const TOLERANCE = 3e-3;

/**
 * One random lighting setup and its vertices.
 * @param {number} seed @param {number} vertices
 */
export function buildCase(seed, vertices){
    const random = generator(seed);
    const pick = (/** @type {number} */ low, /** @type {number} */ high)=>low + random() * (high - low);
    const colour = ()=>[pick(0, 1), pick(0, 1), pick(0, 1), pick(0, 1)];
    const lightCount = 1 + Math.floor(random() * LIGHTS);
    const lights = Array.from({ length: lightCount }, ()=>{
        const directional = random() < 0.4;
        const cone = !directional && random() < 0.5;
        return {
            ambient: colour(), diffuse: colour(), specular: colour(),
            position: directional
                ? [pick(-1, 1), pick(-1, 1), pick(-1, 1), 0]
                : [pick(-10, 10), pick(-10, 10), pick(-10, 10), pick(0.5, 2)],
            spotDirection: [pick(-1, 1), pick(-1, 1), pick(-1, 1)],
            spotExponent: cone ? pick(0, 20) : 0,
            spotCutoff: cone ? pick(5, 90) : 180,
            constantAttenuation: pick(0.5, 2),
            linearAttenuation: random() < 0.5 ? pick(0, 0.3) : 0,
            quadraticAttenuation: random() < 0.5 ? pick(0, 0.05) : 0,
        };
    });
    const modes = [null, GL.AMBIENT, GL.DIFFUSE, GL.SPECULAR, GL.EMISSION, GL.AMBIENT_AND_DIFFUSE];
    const mode = modes[Math.floor(random() * modes.length)];
    // A modelview with a non-uniform scale, so the normal matrix is not the
    // modelview's own corner.
    const angle = pick(0, Math.PI * 2);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const scale = [pick(0.5, 2), pick(0.5, 2), pick(0.5, 2)];
    const modelview = [c * scale[0], 0, -s * scale[0], 0, 0, scale[1], 0, 0,
        s * scale[2], 0, c * scale[2], 0, pick(-5, 5), pick(-5, 5), pick(-20, -2), 1];
    const lighting = {
        material: { ambient: colour(), diffuse: colour(), specular: colour(), emission: colour(),
            shininess: random() < 0.2 ? 0 : pick(0, 128) },
        model: { ambient: colour(), localViewer: random() < 0.5,
            separateSpecular: random() < 0.3 },
        lights,
        normalMatrix: normalMatrix(modelview),
        normalise: random() < 0.7,
        colourMaterial: mode === null ? null : colourMaterialTargets(mode),
    };
    const points = Array.from({ length: vertices }, ()=>({
        eye: [pick(-10, 10), pick(-10, 10), pick(-30, -1), 1],
        normal: [pick(-1, 1), pick(-1, 1), pick(-1, 1)],
        colour: colour(),
    }));
    return { seed, lighting, modelview, points };
}

/**
 * The colour the processor's path gives a vertex: the scene's own steps
 * (`context-scene.js` lit) -- the normal through the normal matrix,
 * normalised where asked, the vertex colour standing for the colour
 * material -- then `lightVertex`.
 *
 * @param {ReturnType<typeof buildCase>['lighting']} lighting
 * @param {{ eye: number[], normal: number[], colour: number[] }} point
 */
export function reference(lighting, point){
    const nm = lighting.normalMatrix;
    const n = point.normal;
    let normal = [
        nm[0] * n[0] + nm[3] * n[1] + nm[6] * n[2],
        nm[1] * n[0] + nm[4] * n[1] + nm[7] * n[2],
        nm[2] * n[0] + nm[5] * n[1] + nm[8] * n[2],
    ];
    if (lighting.normalise)
    {
        normal = normalise(normal);
    }
    /** @type {any} */
    const material = { ...lighting.material };
    for (const property of lighting.colourMaterial ?? [])
    {
        material[property] = [...point.colour];
    }
    return lightVertex({ position: point.eye, normal, material, model: lighting.model,
        lights: lighting.lights }).primary;
}

/**
 * What the page is handed for one case: the module, the uniform block and the
 * vertices packed three vectors each.
 * @param {ReturnType<typeof buildCase>} c
 */
export function pagePlan(c){
    const state = /** @type {import('../../modules/core/src/layers/graphics/opengl/wgsl.js').LightingState} */ (
        lightingStateOf(/** @type {any} */ (c.lighting)));
    const block = new Float32Array(UNIFORM.floats);
    const nm = c.lighting.normalMatrix;
    const at = UNIFORM.normalMatrix;
    block.set([nm[0], nm[1], nm[2], 0, nm[3], nm[4], nm[5], 0, nm[6], nm[7], nm[8], 0, 0, 0, 0, 1],
        at);
    writeLighting(block, /** @type {any} */ (c.lighting));
    const wgsl = `${UNIFORM_STRUCT}
${lightingFunction(state)}
@group(1) @binding(0) var<storage, read> gateIn: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> gateOut: array<vec4f>;
@compute @workgroup_size(1)
fn gate_main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    gateOut[i] = glLit(gateIn[i * 3u], gateIn[i * 3u + 1u].xyz, gateIn[i * 3u + 2u]);
}`;
    const feed = c.points.flatMap(p=>[...p.eye, ...p.normal, 0, ...p.colour]);
    return { wgsl, block: Array.from(block), feed, count: c.points.length };
}

/** In the page: runs every plan, answering each one's colours. */
function pageRunner(){
    const gateWindow = /** @type {any} */ (globalThis);
    const UNIFORM_USAGE = 0x40;
    const STORAGE = 0x80;
    const COPY_DST = 0x08;
    const COPY_SRC = 0x04;
    const MAP_READ = 0x01;
    gateWindow.gateRun = async(/** @type {any[]} */ plans)=>{
        const gpu = /** @type {any} */ (navigator).gpu;
        const adapter = gpu && await gpu.requestAdapter();
        if (!adapter)
        {
            return { error: 'no adapter' };
        }
        const device = await adapter.requestDevice();
        const results = [];
        for (const plan of plans)
        {
            const module = device.createShaderModule({ code: plan.wgsl });
            const errors = (await module.getCompilationInfo()).messages
                .filter((/** @type {any} */ m)=>m.type === 'error')
                .map((/** @type {any} */ m)=>`${m.lineNum}:${m.linePos} ${m.message}`);
            if (errors.length > 0)
            {
                results.push({ errors });
                continue;
            }
            const pipeline = device.createComputePipeline({ layout: 'auto',
                compute: { module, entryPoint: 'gate_main' } });
            const made = (/** @type {number[]} */ values, /** @type {number} */ usage)=>{
                const buffer = device.createBuffer({ size: Math.ceil(values.length * 4 / 16) * 16,
                    usage: usage | COPY_DST });
                device.queue.writeBuffer(buffer, 0, new Float32Array(values));
                return buffer;
            };
            const size = plan.count * 16;
            const out = device.createBuffer({ size, usage: STORAGE | COPY_SRC });
            const staging = device.createBuffer({ size, usage: MAP_READ | COPY_DST });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0,
                    resource: { buffer: made(plan.block, UNIFORM_USAGE) } }] }));
            pass.setBindGroup(1, device.createBindGroup({ layout: pipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: { buffer: made(plan.feed, STORAGE) } },
                    { binding: 1, resource: { buffer: out } }] }));
            pass.dispatchWorkgroups(plan.count);
            pass.end();
            encoder.copyBufferToBuffer(out, 0, staging, 0, size);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(MAP_READ);
            const read = new Float32Array(staging.getMappedRange().slice(0));
            results.push({ values: Array.from(read) });
            staging.unmap();
        }
        const info = adapter.info;
        return { results, adapter: info ? { vendor: info.vendor, architecture: info.architecture,
            description: info.description } : null };
    };
}

/**
 * Whether the device's colours are the reference's; a vertex on an edge
 * the last bit decides is answered as unsettled.
 * @param {ReturnType<typeof buildCase>} c @param {number[]} values
 */
export function compare(c, values){
    let failed = 0;
    let unsettled = 0;
    /** @type {any[]} */
    const wrong = [];
    c.points.forEach((point, i)=>{
        const expected = reference(c.lighting, point);
        const got = values.slice(i * 4, i * 4 + 4);
        const near = (/** @type {number[]} */ want)=>want.every((v, k)=>Math.abs(v - got[k]) <= TOLERANCE);
        if (near(expected))
        {
            return;
        }
        // The cone's edge and the terminator moved by a hair either way.
        const nudged = [-1e-3, 1e-3].some(delta=>near(reference({ ...c.lighting,
            lights: c.lighting.lights.map(light=>({ ...light,
                spotCutoff: light.spotCutoff === 180 ? 180 : light.spotCutoff + delta * 10 })),
        }, { ...point, normal: point.normal.map(v=>v + delta) })));
        if (nudged)
        {
            unsettled++;
            return;
        }
        failed++;
        if (wrong.length < 4)
        {
            wrong.push({ point, expected, got });
        }
    });
    return { ok: failed === 0, failed, unsettled, wrong };
}

/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>{
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : fallback;
};

async function main(){
    const count = Number(flag('--count', '60'));
    const vertices = Number(flag('--vertices', '32'));
    const seed = Number(flag('--seed', '1'));
    const server = await serveStatic({ sandboxDir: TOOL_ROOT, srcDir: TOOL_ROOT });
    const browser = await launchWithGpu({ headed: process.argv.includes('--headed') });
    /** @type {CdpEndpoint | null} */
    let cdp = null;
    const cases = Array.from({ length: count }, (_, k)=>buildCase(seed * 1000003 + k, vertices));
    /** @type {any[]} */
    const failures = [];
    let passed = 0;
    let unsettled = 0;
    /** @type {any} */
    let adapter;
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
            expression: `gateRun(${JSON.stringify(cases.map(pagePlan))})`
                + '.then(r => JSON.stringify(r))',
            awaitPromise: true, returnByValue: true,
        }, sessionId);
        if (answer.exceptionDetails)
        {
            throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails)}`);
        }
        const ran = JSON.parse(answer.result.value);
        if (ran.error)
        {
            throw new Error(`no device: ${ran.error}`);
        }
        adapter = ran.adapter;
        cases.forEach((c, at)=>{
            const result = ran.results[at];
            if (result.errors)
            {
                failures.push({ seed: c.seed, errors: result.errors });
                return;
            }
            const verdict = compare(c, result.values);
            unsettled += verdict.unsettled;
            if (verdict.ok)
            {
                passed++;
            }
            else
            {
                failures.push({ seed: c.seed, state: lightingStateOf(/** @type {any} */ (c.lighting)),
                    ...verdict });
            }
        });
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
    console.log(`lighting: ${passed}/${count} setups pass, ${count * vertices} vertices`
        + `${unsettled ? `, ${unsettled} on an edge the last bit decides, not compared` : ''}`);
    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = join(REPORTS_DIR, `gl-lighting-gate-${stamp}.json`);
    writeFileSync(reportPath, JSON.stringify({ adapter, seed, count, vertices,
        tolerance: TOLERANCE, failures }, null, 1));
    console.log(`adapter: ${JSON.stringify(adapter)}`);
    console.log(`report: ${reportPath}`);
    return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().then(code=>process.exit(code), error=>{
        console.error(error);
        process.exit(2);
    });
}
