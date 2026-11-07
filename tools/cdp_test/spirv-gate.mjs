/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The SPIR-V gate: compute programs down both of OpenGL's shader paths, from
 * their GLSL source (glShaderSource) and from the SPIR-V glslang made of the
 * same source, plain and through `spirv-opt -O` (glShaderBinary and
 * glSpecializeShader, `spirv-glsl.js` writing the module back as GLSL), each
 * dispatched by the engine's GL context, what it gave the device replayed on
 * a real WebGPU device and every word it wrote compared with the source's.
 *
 * The cases (`spirv-gate-fixtures.mjs`) cover integer and float arithmetic,
 * GLSL.std.450, matrices and composites, loops with breaks and continues,
 * switches with fall-through and a loop's break from inside one, shared
 * memory, barriers and atomics, conversions, values swapped round a loop
 * (phis that read each other), and specialization constants
 * (the source path given the specialized values as plain constants). The
 * optimized modules carry the phis, selects and merged blocks a driver's
 * input has in practice, which glslang alone does not write.
 *
 *   node tools/cdp_test/spirv-gate.mjs [--headed] [--chrome-flag FLAG]...
 *
 * Exits 1 on any difference. A signed remainder of negative operands is left
 * out of the cases: GLSL's `%` leaves it undefined while SPIR-V's OpSMod
 * defines it, so the two paths may rightly differ there.
 */

import { GATE_FIXTURES } from './spirv-gate-fixtures.mjs';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GL } from '../../modules/core/src/layers/graphics/opengl/constants.js';
import { computeRig } from '../../modules/core/src/layers/graphics/opengl/compute-fixture.js';
import { spirvBytes } from '../../modules/core/src/layers/graphics/opengl/spirv-fixtures.js';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** Each case's output words, whether they are floats, and the constants it is specialized with. */
const CASES = [
    { name: 'ints', outWords: 64 * 8 },
    { name: 'floats', outWords: 64 * 8, floats: true },
    { name: 'flow', outWords: 64 * 4, spec: { 4: 7 } },
    { name: 'loopswitch', outWords: 64 * 2 },
    { name: 'matrix', outWords: 64 * 8, floats: true },
    { name: 'shared', outWords: 64 * 2 },
    { name: 'conv', outWords: 64 * 4, floats: true, spec: { 1: 0x40400000, 2: 0, 3: 5 } },
    { name: 'swap', outWords: 64 * 2 },
];
const GROUPS = 4;

/** The words every case reads: a spread of values, some at the edges. */
const INPUT = (()=>{
    const words = Array.from({ length: 96 }, (_, k)=>((k * 2654435761) ^ (k << 7)) >>> 0);
    words[3] = 0xfffffff9;
    words[5] = 0;
    words[7] = 0x80000000;
    words[11] = 3;
    words[13] = 0x3f800000;
    return words;
})();

/**
 * The GLSL source path's program: the fixture's source with each
 * specialization constant a plain constant of its specialized value.
 *
 * @param {string} source @param {Record<number, number>} spec
 */
function sourceArm(source, spec){
    return source.replace(/layout\(constant_id = (\d+)\) const (\w+) (\w+) = ([^;]+);/g,
        (_, id, type, name, value)=>{
            const given = spec[Number(id)];
            if (given === undefined)
            {
                return `const ${type} ${name} = ${value};`;
            }
            const text = type === 'float'
                ? new Float32Array(new Uint32Array([given]).buffer)[0].toPrecision(9)
                : type === 'bool' ? (given ? 'true' : 'false') : `${type}(${given}u)`;
            return `const ${type} ${name} = ${text};`;
        });
}

/**
 * Dispatches one arm on the recording device and keeps what it handed the
 * device: the module, the layouts, every bound buffer's bytes, the grid.
 *
 * @param {typeof CASES[number]} c @param {'source' | 'spirv' | 'optimized'} arm
 */
async function record(c, arm){
    const r = computeRig();
    const { gl } = r;
    const fixture = GATE_FIXTURES[`gate_${c.name}${arm === 'optimized' ? '_O' : ''}`];
    /** @type {number} */
    let program;
    if (arm === 'source')
    {
        program = r.program([[GL.COMPUTE_SHADER, sourceArm(fixture.source, c.spec ?? {})]]);
    }
    else
    {
        const bytes = spirvBytes(fixture.binary);
        const shader = gl.glCreateShader(GL.COMPUTE_SHADER);
        gl.glShaderBinary([shader], GL.SHADER_BINARY_FORMAT_SPIR_V, bytes.length, bytes);
        const spec = Object.entries(c.spec ?? {});
        gl.glSpecializeShader(shader, 'main', spec.map(([id])=>Number(id)),
            spec.map(([, value])=>value));
        if (gl.glGetShaderiv(shader, GL.COMPILE_STATUS)[0] !== 1)
        {
            return { error: gl.glGetShaderInfoLog(shader) };
        }
        program = gl.glCreateProgram();
        gl.glAttachShader(program, shader);
        gl.glLinkProgram(program);
    }
    if (gl.glGetProgramiv(program, GL.LINK_STATUS)[0] !== 1)
    {
        return { error: gl.glGetProgramInfoLog(program) };
    }
    gl.glUseProgram(program);
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 0,
        r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(c.outWords * 4)));
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 1,
        r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(new Uint32Array(INPUT).buffer)));
    gl.glDispatchCompute(GROUPS, 1, 1);
    await r.swap();
    if (r.renderer.diagnostics().failures.length > 0)
    {
        return { error: r.renderer.diagnostics().failures.join('; ') };
    }
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    const pipeline = dispatched.pipeline.descriptor;
    return {
        code: pipeline.compute.module.descriptor.code,
        entry: pipeline.compute.entryPoint,
        layouts: pipeline.layout.descriptor.bindGroupLayouts.map((/** @type {any} */ l)=>
            l.descriptor.entries),
        groups: dispatched.groups.map((/** @type {any} */ g)=>g.descriptor.entries
            .map((/** @type {any} */ e)=>({ binding: e.binding,
                bytes: Array.from(e.resource.buffer.bytes), offset: e.resource.offset ?? 0,
                size: e.resource.size }))),
        grid: dispatched.grid,
    };
}

/** What runs in the page: each recorded dispatch on the device, every buffer read back. */
function pageRunner(){
    const page = /** @type {any} */ (globalThis);
    /** @param {any[]} plans */
    page.spirvRun = async plans=>{
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter)
        {
            return { error: 'no adapter' };
        }
        const device = await adapter.requestDevice({ requiredLimits: {
            maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage } });
        const results = [];
        for (const plan of plans)
        {
            device.pushErrorScope('validation');
            const module = device.createShaderModule({ code: plan.code });
            const info = await module.getCompilationInfo();
            const errors = info.messages.filter((/** @type {any} */ m)=>m.type === 'error')
                .map((/** @type {any} */ m)=>`${m.lineNum}: ${m.message}`);
            if (errors.length > 0)
            {
                await device.popErrorScope();
                results.push({ error: errors.join('\n') });
                continue;
            }
            const layouts = plan.layouts.map((/** @type {any} */ entries)=>
                device.createBindGroupLayout({ entries }));
            const pipeline = device.createComputePipeline({ compute: { module,
                entryPoint: plan.entry }, layout: device.createPipelineLayout({
                bindGroupLayouts: layouts }) });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            /** @type {{ buffer: any, size: number }[]} */
            const made = [];
            plan.groups.forEach((/** @type {any[]} */ entries, /** @type {number} */ index)=>{
                pass.setBindGroup(index, device.createBindGroup({ layout: layouts[index],
                    entries: entries.map(e=>{
                        const size = Math.max(16, Math.ceil(e.bytes.length / 4) * 4);
                        const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE
                            | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC
                            | GPUBufferUsage.COPY_DST });
                        const bytes = new Uint8Array(size);
                        bytes.set(e.bytes);
                        device.queue.writeBuffer(buffer, 0, bytes);
                        made.push({ buffer, size });
                        return { binding: e.binding, resource: { buffer, offset: e.offset,
                            size: e.size } };
                    }) }));
            });
            pass.dispatchWorkgroups(...plan.grid);
            pass.end();
            const reads = made.map(({ buffer, size })=>{
                const read = device.createBuffer({ size,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                encoder.copyBufferToBuffer(buffer, 0, read, 0, size);
                return read;
            });
            device.queue.submit([encoder.finish()]);
            const failed = await device.popErrorScope();
            if (failed)
            {
                results.push({ error: failed.message });
                continue;
            }
            const buffers = [];
            for (const read of reads)
            {
                await read.mapAsync(GPUMapMode.READ);
                buffers.push(Array.from(new Uint32Array(read.getMappedRange())));
            }
            results.push({ buffers });
        }
        const info = adapter.info ?? {};
        return { adapter: [info.vendor, info.architecture, info.device, info.description]
            .filter(Boolean).join(' '), results };
    };
}

/**
 * The words an arm wrote to its output against the source's: the same bits,
 * or, for a float case, within a part in ten thousand.
 *
 * @param {typeof CASES[number]} c @param {number[]} source @param {number[]} other
 */
function differences(c, source, other){
    const f = new Float32Array(2);
    const u = new Uint32Array(f.buffer);
    /** @type {number[]} */
    const at = [];
    for (let k = 0; k < c.outWords; k++)
    {
        if (source[k] === other[k])
        {
            continue;
        }
        u[0] = source[k];
        u[1] = other[k];
        if (c.floats && Math.abs(f[0] - f[1]) <= 1e-4 * Math.max(1, Math.abs(f[0])))
        {
            continue;
        }
        at.push(k);
    }
    return at;
}

async function main(){
    const arms = /** @type {const} */ (['source', 'spirv', 'optimized']);
    /** @type {any[]} */
    const plans = [];
    let bad = 0;
    for (const c of CASES)
    {
        for (const arm of arms)
        {
            const plan = await record(c, arm);
            if (plan.error)
            {
                console.log(`${c.name} ${arm}: ${plan.error}`);
                bad++;
            }
            plans.push(plan);
        }
    }
    const extraFlags = process.argv.flatMap((arg, at)=>(arg === '--chrome-flag'
        ? [process.argv[at + 1]] : []));
    const server = await serveStatic({ sandboxDir: TOOL_ROOT, srcDir: TOOL_ROOT });
    const browser = await launchWithGpu({ headed: process.argv.includes('--headed'), extraFlags });
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
            expression: `spirvRun(${JSON.stringify(plans.filter(p=>!p.error))})`
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
        console.log(`adapter: ${ran.adapter || 'not said'}`);
        let next = 0;
        const outputs = plans.map(p=>(p.error ? null : ran.results[next++]));
        CASES.forEach((c, k)=>{
            /** @param {any} result */
            const output = result=>(result?.buffers ?? [])
                .find((/** @type {number[]} */ b)=>b.length === c.outWords);
            const [source, ...others] = outputs.slice(k * arms.length, (k + 1) * arms.length);
            if (!source || source.error || !output(source))
            {
                console.log(`${c.name} source: ${source?.error ?? 'no output'}`);
                bad++;
                return;
            }
            const written = output(source).filter((/** @type {number} */ w)=>w !== 0).length;
            others.forEach((result, at)=>{
                const arm = arms[at + 1];
                if (!result || result.error || !output(result))
                {
                    console.log(`${c.name} ${arm}: ${result?.error ?? 'no output'}`);
                    bad++;
                    return;
                }
                const differ = differences(c, output(source), output(result));
                const verdict = differ.length === 0 ? 'the same'
                    : `${differ.length} words differ, the first at ${differ.slice(0, 4)
                        .join(', ')}`;
                console.log(`${c.name} ${arm}: ${verdict} (${written} of ${c.outWords} words`
                    + ' written)');
                bad += differ.length > 0 ? 1 : 0;
            });
        });
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
    console.log(bad === 0 ? 'spirv gate: every arm the same' : `spirv gate: ${bad} failed`);
    process.exitCode = bad === 0 ? 0 : 1;
}

await main();
