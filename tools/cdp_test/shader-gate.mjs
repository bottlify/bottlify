/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shader gate: seeded random Direct3D 9 shaders down both paths -- the
 * reference machine written from the documentation, and the WGSL the
 * translator makes, run on a real WebGPU device -- with every output
 * component the program wrote compared.
 *
 *   node tools/cdp_test/shader-gate.mjs [--count 40] [--seed 1] [--length 10]
 *       [--profiles vs_1_1,ps_2_0,...] [--headed]
 *
 * A vertex shader runs as a compute dispatch (its entry is a plain function
 * once the stage attribute is taken off), so every output is read back,
 * oPos included. A pixel shader runs as what it is, a fragment stage drawing
 * one pixel of a float target, with each varying the same at the three
 * corners and each texture a 1x1 of known bytes, so interpolation and
 * filtering give back exactly what the machine was told.
 *
 * The machine is exact and the GPU is not: WGSL allows a few ulp on rsq and
 * the transcendentals and more on a chain of them, so a component passes
 * within a relative tolerance. Where the reference itself is not a number,
 * or beyond any float the GPU could answer with, Direct3D leaves the answer
 * to the hardware and the component is counted apart, not compared.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { buildCase, PROFILES, SAMPLER_BYTES } from './shader-cases.mjs';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/** A component passes within this share of its size, or of one below one. */
export const TOLERANCE = 2e-3;
/** Beyond this the reference is an infinity in all but name. */
const HUGE = 1e30;

/**
 * The fields of a struct the translator declared, with what stands before each.
 *
 * @param {string} wgsl @param {string} name
 * @returns {{ attrs: string, field: string, type: string, builtin: boolean }[]}
 */
export function structFields(wgsl, name){
    const lines = wgsl.split('\n');
    const start = lines.indexOf(`struct ${name} {`);
    /** @type {{ attrs: string, field: string, type: string, builtin: boolean }[]} */
    const fields = [];
    for (let at = start + 1; at < lines.length && lines[at] !== '}'; at++)
    {
        const match = /^\s*(.*?)\s*(\w+):\s*([\w<>]+),?\s*$/.exec(lines[at]);
        if (match)
        {
            fields.push({ attrs: match[1], field: match[2], type: match[3],
                builtin: match[1].includes('@builtin') });
        }
    }
    return fields;
}

/** @param {string} type @param {string} value  A vec4f, as the type holds it. */
const narrow = (type, value)=>{
    if (type === 'f32')
    {
        return `${value}.x`;
    }
    if (type === 'vec2f' || type === 'vec2<f32>')
    {
        return `${value}.xy`;
    }
    if (type === 'vec3f' || type === 'vec3<f32>')
    {
        return `${value}.xyz`;
    }
    if (type === 'vec4u' || type === 'vec4<u32>')
    {
        return `vec4u(${value})`;
    }
    if (type === 'vec4i' || type === 'vec4<i32>')
    {
        return `vec4i(${value})`;
    }
    return value;
};

/** @param {string} type @param {string} value  The value widened to a vec4f. */
const widen = (type, value)=>{
    if (type === 'f32')
    {
        return `vec4f(${value}, 0.0, 0.0, 0.0)`;
    }
    if (type === 'vec2f' || type === 'vec2<f32>')
    {
        return `vec4f(${value}, 0.0, 0.0)`;
    }
    if (type === 'vec3f' || type === 'vec3<f32>')
    {
        return `vec4f(${value}, 0.0)`;
    }
    return `vec4f(${value})`;
};

/**
 * What the page runs for one case: the module, the values it is fed in
 * order, and the names its outputs come back under.
 *
 * @param {import('./shader-cases.mjs').GateCase} c
 */
export function pagePlan(c){
    if (c.vertex)
    {
        const ins = structFields(c.wgsl, 'VsIn');
        const outs = structFields(c.wgsl, 'VsOut');
        const fed = ins.filter(f=>!f.builtin);
        const body = [
            '@group(3) @binding(0) var<storage, read> gateIn: array<vec4f, '
                + `${Math.max(1, fed.length)}>;`,
            `@group(3) @binding(1) var<storage, read_write> gateOut: array<vec4f, ${outs.length}>;`,
            '@compute @workgroup_size(1)',
            'fn gate_main() {',
            '    var gateVertex: VsIn;',
            ...ins.map(f=>(f.builtin ? `    gateVertex.${f.field} = 0u;`
                : `    gateVertex.${f.field} = ${narrow(f.type, `gateIn[${fed.indexOf(f)}]`)};`)),
            `    let gateResult = ${c.entry}(gateVertex);`,
            ...outs.map((f, at)=>`    gateOut[${at}] = ${widen(f.type, `gateResult.${f.field}`)};`),
            '}',
        ];
        return {
            vertex: true,
            wgsl: [...c.wgsl.split('\n').filter(line=>line !== '@vertex'), ...body].join('\n'),
            feed: fed.map(f=>c.inputs[f.field] ?? [0, 0, 0, 0]),
            outputs: outs.map(f=>f.field),
        };
    }
    const ins = structFields(c.wgsl, 'PsIn').filter(f=>!f.builtin);
    const vertex = [
        'struct GateVarying {',
        '    @builtin(position) gatePos: vec4f,',
        ...ins.map(f=>`    ${f.attrs} ${f.field}: ${f.type},`),
        '}',
        '@group(0) @binding(0) var<storage, read> gateIn:'
            + ` array<vec4f, ${Math.max(1, ins.length)}>;`,
        '@vertex',
        'fn gate_vs(@builtin(vertex_index) corner: u32) -> GateVarying {',
        '    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));',
        '    var out: GateVarying;',
        '    out.gatePos = vec4f(corners[corner], 0.5, 1.0);',
        ...ins.map((f, at)=>`    out.${f.field} = ${narrow(f.type, `gateIn[${at}]`)};`),
        '    return out;',
        '}',
    ];
    return {
        vertex: false,
        wgsl: c.wgsl,
        vertexWgsl: vertex.join('\n'),
        feed: ins.map(f=>c.inputs[f.field] ?? [0, 0, 0, 0]),
        outputs: ['oC0'],
    };
}

/**
 * The page's side, sent once: a device, then each case built, run and read
 * back. Written as a function so it is checked as code; it travels as its
 * source.
 */
function pageRunner(){
    const gateWindow = /** @type {any} */ (globalThis);
    const UNIFORM = 0x40;
    const STORAGE = 0x80;
    const COPY_DST = 0x08;
    const COPY_SRC = 0x04;
    const MAP_READ = 0x01;
    const VERTEX = 1;
    const FRAGMENT = 2;
    const COMPUTE = 4;
    gateWindow.gateDevice = (async()=>{
        const gpu = /** @type {any} */ (navigator).gpu;
        if (!gpu)
        {
            return { error: 'no navigator.gpu' };
        }
        const adapter = await gpu.requestAdapter();
        if (!adapter)
        {
            return { error: 'no adapter' };
        }
        const device = await adapter.requestDevice();
        return { device, info: adapter.info ? { vendor: adapter.info.vendor,
            architecture: adapter.info.architecture, description: adapter.info.description }
            : null };
    })();
    /**
     * @param {any} device @param {number[]} values @param {number} usage @param {number} [floor]
     */
    const buffer = (device, values, usage, floor = 16)=>{
        const bytes = Math.max(floor, values.length * 4);
        const made = device.createBuffer({ size: Math.ceil(bytes / 16) * 16,
            usage: usage | COPY_DST });
        device.queue.writeBuffer(made, 0, new Float32Array(values));
        return made;
    };
    /** @param {any} device @param {number[]} values @param {number} usage */
    const intBuffer = (device, values, usage)=>{
        const made = device.createBuffer({ size: Math.ceil(values.length * 4 / 16) * 16,
            usage: usage | COPY_DST });
        device.queue.writeBuffer(made, 0, new Int32Array(values));
        return made;
    };
    /** @param {any} device @param {number} visibility */
    const constantsLayout = (device, visibility)=>device.createBindGroupLayout({ entries: [0, 1, 2]
        .map(binding=>({ binding, visibility, buffer: { type: 'uniform' } })) });
    /** @param {any} device @param {any} layout @param {any} plan */
    const constantsGroup = (device, layout, plan)=>{
        const count = Number(/var<uniform> c: array<vec4f, (\d+)>/.exec(plan.wgsl)?.[1] ?? 1);
        const floats = new Array(count * 4).fill(0);
        const given = /** @type {number[]} */ (plan.constants);
        for (let at = 0; at < Math.min(given.length, floats.length); at++)
        {
            floats[at] = given[at];
        }
        const bools = [];
        for (const b of plan.bools)
        {
            bools.push(b);
        }
        return device.createBindGroup({ layout, entries: [
            { binding: 0, resource: { buffer: buffer(device, floats, UNIFORM) } },
            { binding: 1, resource: { buffer: intBuffer(device, plan.ints, UNIFORM) } },
            { binding: 2, resource: { buffer: intBuffer(device, bools, UNIFORM) } },
        ] });
    };
    /** @param {any} device @param {any} buffer @param {number} size */
    const readBack = async(device, source, size)=>{
        const staging = device.createBuffer({ size, usage: MAP_READ | COPY_DST });
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(source, 0, staging, 0, size);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(MAP_READ);
        const out = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
        staging.unmap();
        return out;
    };
    /** @param {any} module */
    const compileErrors = async module=>(await module.getCompilationInfo()).messages
        .filter((/** @type {any} */ m)=>m.type === 'error')
        .map((/** @type {any} */ m)=>`${m.lineNum}:${m.linePos} ${m.message}`);

    /** @param {any} device @param {any} plan */
    const runVertex = async(device, plan)=>{
        const module = device.createShaderModule({ code: plan.wgsl });
        const errors = await compileErrors(module);
        if (errors.length)
        {
            return { error: `compile: ${errors.join('; ')}` };
        }
        const layouts = [constantsLayout(device, COMPUTE),
            device.createBindGroupLayout({ entries: [] }),
            device.createBindGroupLayout({ entries: [] }),
            device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: COMPUTE, buffer: { type: 'storage' } },
            ] })];
        const pipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
            compute: { module, entryPoint: 'gate_main' },
        });
        const outBuffer = device.createBuffer({ size: plan.outputs.length * 16,
            usage: STORAGE | COPY_SRC });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, constantsGroup(device, layouts[0], plan));
        pass.setBindGroup(1, device.createBindGroup({ layout: layouts[1], entries: [] }));
        pass.setBindGroup(2, device.createBindGroup({ layout: layouts[2], entries: [] }));
        pass.setBindGroup(3, device.createBindGroup({ layout: layouts[3], entries: [
            { binding: 0, resource: { buffer: buffer(device, plan.feed.flat(), STORAGE) } },
            { binding: 1, resource: { buffer: outBuffer } },
        ] }));
        pass.dispatchWorkgroups(1);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const flat = await readBack(device, outBuffer, plan.outputs.length * 16);
        return { values: Object.fromEntries(plan.outputs.map((/** @type {string} */ name,
            /** @type {number} */ at)=>[name, flat.slice(at * 4, at * 4 + 4)])) };
    };

    /** @param {any} device @param {any} plan */
    const runPixel = async(device, plan)=>{
        const module = device.createShaderModule({ code: plan.wgsl });
        const vertexModule = device.createShaderModule({ code: plan.vertexWgsl });
        const errors = [...await compileErrors(module), ...await compileErrors(vertexModule)];
        if (errors.length)
        {
            return { error: `compile: ${errors.join('; ')}` };
        }
        /** @type {Record<string, string>} */
        const dims = { 'texture_2d<f32>': '2d', 'texture_cube<f32>': 'cube',
            'texture_3d<f32>': '3d' };
        const samplerEntries = plan.samplers.flatMap((/** @type {any} */ s, /** @type {number} */ at)=>[
            { binding: at * 2, visibility: FRAGMENT,
                texture: { sampleType: 'float', viewDimension: dims[s.type] ?? '2d' } },
            { binding: at * 2 + 1, visibility: FRAGMENT, sampler: { type: 'filtering' } },
        ]);
        const layouts = [
            device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: VERTEX, buffer: { type: 'read-only-storage' } }] }),
            constantsLayout(device, FRAGMENT),
            device.createBindGroupLayout({ entries: samplerEntries }),
        ];
        const pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
            vertex: { module: vertexModule, entryPoint: 'gate_vs' },
            fragment: { module, entryPoint: plan.entry, targets: [{ format: 'rgba32float' }] },
            primitive: { topology: 'triangle-list' },
        });
        const target = device.createTexture({ size: [1, 1], format: 'rgba32float',
            usage: 0x10 | COPY_SRC });
        const samplerResources = plan.samplers.flatMap((/** @type {any} */ s)=>{
            const dimension = dims[s.type] ?? '2d';
            const layers = dimension === 'cube' ? 6 : 1;
            const texture = device.createTexture({
                size: [1, 1, layers], format: 'rgba8unorm',
                dimension: dimension === '3d' ? '3d' : '2d', usage: 0x04 | COPY_DST,
            });
            const bytes = plan.samplerBytes[s.index % plan.samplerBytes.length];
            for (let layer = 0; layer < layers; layer++)
            {
                device.queue.writeTexture({ texture, origin: [0, 0, layer] },
                    new Uint8Array(bytes), { bytesPerRow: 4 }, [1, 1, 1]);
            }
            return [texture.createView({ dimension }), device.createSampler({
                magFilter: 'linear', minFilter: 'linear' })];
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{
            view: target.createView(), loadOp: 'clear', storeOp: 'store',
            clearValue: { r: -7, g: -7, b: -7, a: -7 } }] });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: layouts[0], entries: [
            { binding: 0, resource: { buffer: buffer(device, plan.feed.flat(), STORAGE) } }] }));
        pass.setBindGroup(1, constantsGroup(device, layouts[1], plan));
        pass.setBindGroup(2, device.createBindGroup({ layout: layouts[2],
            entries: samplerResources.map((/** @type {any} */ resource, /** @type {number} */ binding)=>
                ({ binding, resource })) }));
        pass.draw(3);
        pass.end();
        const out = device.createBuffer({ size: 256, usage: COPY_DST | COPY_SRC });
        encoder.copyTextureToBuffer({ texture: target }, { buffer: out, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        const flat = await readBack(device, out, 16);
        return { values: { oC0: flat.slice(0, 4) } };
    };

    gateWindow.gateRun = async(/** @type {any[]} */ plans)=>{
        const opened = await gateWindow.gateDevice;
        if (opened.error)
        {
            return { error: opened.error };
        }
        const device = opened.device;
        const results = [];
        for (const plan of plans)
        {
            device.pushErrorScope('validation');
            /** @type {any} */
            let result;
            try
            {
                result = plan.vertex ? await runVertex(device, plan) : await runPixel(device, plan);
            }
            catch (e){
                result = { error: `threw: ${/** @type {Error} */ (e).message}` };
            }
            const invalid = await device.popErrorScope();
            if (invalid && !result.error)
            {
                result = { error: `validation: ${invalid.message}` };
            }
            results.push(result);
        }
        return { adapter: opened.info, results };
    };
}

/**
 * The verdict on one output component.
 *
 * @param {number} expected @param {number} got
 * @returns {'pass' | 'fail' | 'undefined'}
 */
export function judge(expected, got){
    if (!Number.isFinite(expected) || Math.abs(expected) > HUGE)
    {
        return 'undefined';
    }
    if (!Number.isFinite(got))
    {
        return 'fail';
    }
    // At FLT_MAX the GPU and the machine round apart and both mean "too large".
    if (Math.abs(expected) > 1e37 && Math.sign(expected) === Math.sign(got) && Math.abs(got) > 1e37)
    {
        return 'pass';
    }
    const allowed = TOLERANCE * Math.max(1, Math.abs(expected));
    return Math.abs(expected - got) <= allowed ? 'pass' : 'fail';
}

/**
 * @param {import('./shader-cases.mjs').GateCase} c @param {any} result
 */
function compare(c, result){
    if (result.error)
    {
        return { ok: false, error: result.error, mismatches: [], undefinedCount: 0 };
    }
    /** @type {{ output: string, component: number, expected: number, got: number }[]} */
    const mismatches = [];
    let undefinedCount = 0;
    for (const [name, mask] of Object.entries(c.written))
    {
        const got = result.values[name];
        if (!got)
        {
            continue;
        }
        for (let component = 0; component < 4; component++)
        {
            if (!(mask & (1 << component)))
            {
                continue;
            }
            const verdict = judge(c.expected[name][component], got[component]);
            if (verdict === 'undefined')
            {
                undefinedCount++;
            }
            else if (verdict === 'fail')
            {
                mismatches.push({ output: name, component, expected: c.expected[name][component],
                    got: got[component] });
            }
        }
    }
    return { ok: mismatches.length === 0, error: null, mismatches, undefinedCount };
}

/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>{
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : fallback;
};

async function main(){
    const count = Number(flag('--count', '40'));
    const seed = Number(flag('--seed', '1'));
    const length = Number(flag('--length', '10'));
    const profiles = flag('--profiles', Object.keys(PROFILES).join(',')).split(',');
    const server = await serveStatic({ sandboxDir: TOOL_ROOT, srcDir: TOOL_ROOT });
    const browser = await launchWithGpu({ headed: process.argv.includes('--headed') });
    /** @type {CdpEndpoint | null} */
    let cdp = null;
    /** @type {any[]} */
    const failures = [];
    /** @type {Record<string, { cases: number, passed: number, undefinedComponents: number }>} */
    const byProfile = {};
    let adapter = null;
    try
    {
        cdp = new CdpEndpoint(browser.browserWs);
        await cdp.open();
        const { targetId } = await cdp.send('Target.createTarget',
            { url: `http://127.0.0.1:${server.port}/sandbox/README.md` });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Runtime.evaluate', { expression: `(${pageRunner.toString()})(); null` },
            sessionId);
        for (const profile of profiles)
        {
            const cases = Array.from({ length: count },
                (_, k)=>buildCase(profile, seed * 1000003 + k, length));
            const plans = cases.map(c=>({ ...pagePlan(c), entry: c.entry, samplers: c.samplers,
                constants: c.constants, ints: c.ints, bools: c.bools,
                samplerBytes: SAMPLER_BYTES }));
            const answer = await cdp.send('Runtime.evaluate', {
                expression: `gateRun(${JSON.stringify(plans)}).then(r => JSON.stringify(r))`,
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
            const stats = { cases: cases.length, passed: 0, undefinedComponents: 0 };
            cases.forEach((c, at)=>{
                const verdict = compare(c, ran.results[at]);
                stats.undefinedComponents += verdict.undefinedCount;
                if (verdict.ok)
                {
                    stats.passed++;
                }
                else
                {
                    failures.push({ profile, seed: c.seed, text: c.text, ...verdict,
                        inputs: c.inputs, constants: c.constants.slice(0, 40), wgsl: c.wgsl,
                        expected: c.expected, got: ran.results[at].values ?? null });
                }
            });
            byProfile[profile] = stats;
            console.log(`${profile}: ${stats.passed}/${stats.cases} pass`
                + `${stats.undefinedComponents ? `, ${stats.undefinedComponents} components`
                    + ' undefined by Direct3D not compared' : ''}`);
        }
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = join(REPORTS_DIR, `shader-gate-${stamp}.json`);
    writeFileSync(reportPath, JSON.stringify({ adapter, seed, count, length, tolerance: TOLERANCE,
        byProfile, failures }, null, 1));
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
