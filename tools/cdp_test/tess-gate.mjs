/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tessellator's gate on a real device: every patch of the reference's
 * corpus (`tess-corpus.json.gz`, which `tessellator.test.js` holds the
 * JavaScript tessellator to) run through the WGSL tessellator
 * (`tessellator-wgsl.js`), its count pass and its write pass, every point's
 * bits and every index compared with the reference's.
 *
 *   node tools/cdp_test/tess-gate.mjs [--headed] [--chrome-flag FLAG]...
 *
 * `--chrome-flag --use-webgpu-adapter=swiftshader` runs it on the software
 * adapter, as a machine without a GPU has it. Exits 1 on any difference.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { PATCH_BYTES, TESSELLATOR_BINDINGS, TESSELLATOR_WGSL }
    from '../../modules/core/src/layers/graphics/d3d10/tessellator-wgsl.js';
import { parseDxbc } from '../../modules/core/src/layers/graphics/d3d10/dxbc.js';
import {
    colouredPixelShader, forkPhaseHullShader, lerpQuadDomainShader, passQuadHullShader,
    passThroughVertexShader, quadDomainShader, quadHullShader,
} from '../../modules/core/src/layers/graphics/d3d10/shader-fixtures.js';
import {
    cullCases, drawCase, drawPageRunner, fetchCases, scanCases,
} from './tess-draw.mjs';
import { HULL_BINDING, linkHull } from '../../modules/core/src/layers/graphics/d3d10/wgsl.js';
import { tessellate } from '../../modules/core/src/layers/graphics/d3d10/tessellator.js';
import { isMain } from '../common.mjs';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const CORPUS = new URL('../../modules/core/src/layers/graphics/d3d10/tess-corpus.json.gz',
    import.meta.url);
/** Patches a dispatch, so no answer outgrows what one evaluation hands back. */
const BATCH = 100;

/** What runs in the page: one batch of patches through both passes. */
function pageRunner(){
    const page = /** @type {any} */ (globalThis);
    page.tessDevice = (async()=>{
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter)
        {
            return { error: 'no adapter' };
        }
        return { device: await adapter.requestDevice(),
            info: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture } };
    })();
    /**
     * @param {string} source @param {any} bindings @param {number} patchBytes
     * @param {number[]} words  the patches' 32-bit words
     */
    /**
     * A hull program over `patchCount` patches of `inputs` (the input control
     * points' words), its records then tessellated on the device as they
     * stand: the output points, the patch constants, and every patch's points
     * and indices.
     *
     * @param {string} code @param {any} hull @param {number[]} inputs
     * @param {number} patchCount @param {any} stage @param {string} tessSource
     * @param {any} tessBindings
     */
    page.hullRun = async(code, hull, inputs, patchCount, stage, tessSource, tessBindings)=>{
        const opened = await page.tessDevice;
        const device = opened.device;
        device.pushErrorScope('validation');
        const STORAGE = 0x80;
        const COPY_SRC = 0x4;
        const COPY_DST = 0x8;
        const UNIFORM = 0x40;
        const MAP_READ = 0x1;
        /** @param {number} size @param {number} usage */
        const make = (size, usage)=>device.createBuffer({ size: Math.max(16, size), usage });
        /** @param {GPUBuffer} buffer @param {number} size @returns {Promise<ArrayBuffer>} */
        const readBack = async(buffer, size)=>{
            const out = make(size, COPY_DST | MAP_READ);
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(buffer, 0, out, 0, Math.max(16, size));
            device.queue.submit([encoder.finish()]);
            await out.mapAsync(MAP_READ);
            const copy = out.getMappedRange().slice(0, size);
            out.unmap();
            return copy;
        };
        const hullPipeline = device.createComputePipeline({ layout: 'auto',
            compute: { module: device.createShaderModule({ code }), entryPoint: 'hullMain' } });
        const inBuffer = make(inputs.length * 4, STORAGE | COPY_DST);
        device.queue.writeBuffer(inBuffer, 0, new Uint32Array(inputs));
        const pointsSize = patchCount * stage.outputPoints * stage.outputRegisters * 16;
        const constantsSize = patchCount * stage.constantRegisters * 16;
        const outPoints = make(pointsSize, STORAGE | COPY_SRC);
        const outConstants = make(constantsSize, STORAGE | COPY_SRC);
        const patches = make(patchCount * 48, STORAGE | COPY_SRC);
        const params = make(16, UNIFORM | COPY_DST);
        device.queue.writeBuffer(params, 0, new Uint32Array([patchCount, 0, 0, 0]));
        let encoder = device.createCommandEncoder();
        let pass = encoder.beginComputePass();
        pass.setPipeline(hullPipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: hullPipeline.getBindGroupLayout(0),
            entries: [] }));
        pass.setBindGroup(1, device.createBindGroup({ layout: hullPipeline.getBindGroupLayout(1),
            entries: [
                { binding: hull.inputs, resource: { buffer: inBuffer } },
                { binding: hull.points, resource: { buffer: outPoints } },
                { binding: hull.constants, resource: { buffer: outConstants } },
                { binding: hull.patches, resource: { buffer: patches } },
                { binding: hull.params, resource: { buffer: params } },
            ] }));
        pass.dispatchWorkgroups(Math.ceil(patchCount / 64));
        pass.end();
        device.queue.submit([encoder.finish()]);
        const tessPipeline = device.createComputePipeline({ layout: 'auto', compute: {
            module: device.createShaderModule({ code: tessSource }),
            entryPoint: 'tessellatePatches' } });
        const counts = make(patchCount * 8, STORAGE | COPY_SRC);
        /**
         * @param {number} write @param {GPUBuffer} offsets @param {GPUBuffer} pointsOut
         * @param {GPUBuffer} indicesOut
         */
        const tess = (write, offsets, pointsOut, indicesOut)=>{
            const p = make(16, UNIFORM | COPY_DST);
            device.queue.writeBuffer(p, 0, new Uint32Array([patchCount, write, 0, 0]));
            encoder = device.createCommandEncoder();
            pass = encoder.beginComputePass();
            pass.setPipeline(tessPipeline);
            const layout = tessPipeline.getBindGroupLayout(0);
            pass.setBindGroup(0, device.createBindGroup({ layout,
                entries: [
                    { binding: tessBindings.patches, resource: { buffer: patches } },
                    { binding: tessBindings.counts, resource: { buffer: counts } },
                    { binding: tessBindings.offsets, resource: { buffer: offsets } },
                    { binding: tessBindings.points, resource: { buffer: pointsOut } },
                    { binding: tessBindings.indices, resource: { buffer: indicesOut } },
                    { binding: tessBindings.params, resource: { buffer: p } },
                ] }));
            pass.dispatchWorkgroups(Math.ceil(patchCount / 64));
            pass.end();
            device.queue.submit([encoder.finish()]);
        };
        tess(0, make(16, STORAGE), make(16, STORAGE), make(16, STORAGE));
        const counted = new Uint32Array(await readBack(counts, patchCount * 8));
        const offsets = new Uint32Array(patchCount * 2);
        let pointTotal = 0;
        let indexTotal = 0;
        for (let k = 0; k < patchCount; k++)
        {
            offsets[k * 2] = pointTotal;
            offsets[k * 2 + 1] = indexTotal;
            pointTotal += counted[k * 2];
            indexTotal += counted[k * 2 + 1];
        }
        const offsetBuffer = make(offsets.byteLength, STORAGE | COPY_DST);
        device.queue.writeBuffer(offsetBuffer, 0, offsets);
        const tessPoints = make(pointTotal * 8, STORAGE | COPY_SRC);
        const tessIndices = make(indexTotal * 4, STORAGE | COPY_SRC);
        tess(1, offsetBuffer, tessPoints, tessIndices);
        const result = {
            points: [...new Uint32Array(await readBack(outPoints, pointsSize))],
            constants: [...new Uint32Array(await readBack(outConstants, constantsSize))],
            counts: [...counted],
            tessPoints: [...new Float32Array(await readBack(tessPoints, pointTotal * 8))],
            tessIndices: [...new Uint32Array(await readBack(tessIndices, indexTotal * 4))],
        };
        const invalid = await device.popErrorScope();
        return invalid ? { error: `validation: ${invalid.message}` } : result;
    };
    page.tessRun = async(source, bindings, patchBytes, words)=>{
        const opened = await page.tessDevice;
        if (opened.error)
        {
            return { error: opened.error };
        }
        const device = opened.device;
        const STORAGE = 0x80;
        const COPY_SRC = 0x4;
        const COPY_DST = 0x8;
        const UNIFORM = 0x40;
        const MAP_READ = 0x1;
        const count = words.length * 4 / patchBytes;
        device.pushErrorScope('validation');
        const module = device.createShaderModule({ code: source });
        const pipeline = device.createComputePipeline({ layout: 'auto',
            compute: { module, entryPoint: 'tessellatePatches' } });
        /** @param {number} size @param {number} usage */
        const make = (size, usage)=>device.createBuffer({ size: Math.max(16, size), usage });
        const patches = make(words.length * 4, STORAGE | COPY_DST);
        device.queue.writeBuffer(patches, 0, new Uint32Array(words));
        const counts = make(count * 8, STORAGE | COPY_SRC);
        /** @param {GPUBuffer} buffer @param {number} size @returns {Promise<ArrayBuffer>} */
        const readBack = async(buffer, size)=>{
            const out = make(size, COPY_DST | MAP_READ);
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(buffer, 0, out, 0, Math.max(16, size));
            device.queue.submit([encoder.finish()]);
            await out.mapAsync(MAP_READ);
            const copy = out.getMappedRange().slice(0, size);
            out.unmap();
            return copy;
        };
        /**
         * @param {number} write @param {GPUBuffer} offsets @param {GPUBuffer} points
         * @param {GPUBuffer} indices
         */
        const dispatch = (write, offsets, points, indices)=>{
            const params = make(16, UNIFORM | COPY_DST);
            device.queue.writeBuffer(params, 0, new Uint32Array([count, write, 0, 0]));
            const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: bindings.patches, resource: { buffer: patches } },
                    { binding: bindings.counts, resource: { buffer: counts } },
                    { binding: bindings.offsets, resource: { buffer: offsets } },
                    { binding: bindings.points, resource: { buffer: points } },
                    { binding: bindings.indices, resource: { buffer: indices } },
                    { binding: bindings.params, resource: { buffer: params } },
                ] });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(Math.ceil(count / 64));
            pass.end();
            device.queue.submit([encoder.finish()]);
        };
        const empty = make(16, STORAGE);
        dispatch(0, empty, make(16, STORAGE), make(16, STORAGE));
        const counted = new Uint32Array(await readBack(counts, count * 8));
        const offsets = new Uint32Array(count * 2);
        let pointTotal = 0;
        let indexTotal = 0;
        for (let k = 0; k < count; k++)
        {
            offsets[k * 2] = pointTotal;
            offsets[k * 2 + 1] = indexTotal;
            pointTotal += counted[k * 2];
            indexTotal += counted[k * 2 + 1];
        }
        const offsetBuffer = make(offsets.byteLength, STORAGE | COPY_DST);
        device.queue.writeBuffer(offsetBuffer, 0, offsets);
        const points = make(pointTotal * 8, STORAGE | COPY_SRC);
        const indices = make(indexTotal * 4, STORAGE | COPY_SRC);
        dispatch(1, offsetBuffer, points, indices);
        const pointWords = new Uint32Array(await readBack(points, pointTotal * 8));
        const indexWords = new Uint32Array(await readBack(indices, indexTotal * 4));
        const invalid = await device.popErrorScope();
        if (invalid)
        {
            return { error: `validation: ${invalid.message}` };
        }
        const results = [];
        for (let k = 0; k < count; k++)
        {
            const p = offsets[k * 2];
            const i = offsets[k * 2 + 1];
            results.push({
                points: [...pointWords.subarray(p * 2, (p + counted[k * 2]) * 2)]
                    .map(word=>word.toString(16)),
                indices: [...indexWords.subarray(i, i + counted[k * 2 + 1])],
            });
        }
        return { adapter: opened.info, results };
    };
}

/**
 * A corpus case as the patch's words: domain, partitioning, output, a pad,
 * then the six factors' bits in two vec4s.
 *
 * @param {{ domain: string, partitioning: number, output: number, factors: string[] }} one
 */
function patchWords(one){
    const factors = one.factors.map(hex=>Number.parseInt(hex, 16));
    const f = [...factors, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8);
    return [['isoline', 'tri', 'quad'].indexOf(one.domain), one.partitioning, one.output, 0, ...f];
}

/**
 * The hull fixture on two patches, its records tessellated on the device.
 *
 * @param {CdpEndpoint} cdp @param {string} sessionId
 * @returns {Promise<number>} how many checks failed
 */
async function hullCase(cdp, sessionId){
    const linked = linkHull(/** @type {any} */ (parseDxbc(forkPhaseHullShader())));
    const bits = (/** @type {number} */ value)=>new Uint32Array(new Float32Array([value]).buffer)[0];
    const corners = [[0, 0, 0, 1], [0, 2, 0, 1], [2, 0, 0, 1], [2, 2, 0, 1]];
    const inputs = [[1, 2, 3, 0], [-1, -1, 0, 0]];
    const answer = await cdp.send('Runtime.evaluate', {
        expression: `hullRun(${JSON.stringify(linked.code)}, ${JSON.stringify(HULL_BINDING)}, ${
            JSON.stringify(inputs.flat().map(bits))}, 2, ${JSON.stringify(linked.stage)}, ${
            JSON.stringify(TESSELLATOR_WGSL)}, ${JSON.stringify(TESSELLATOR_BINDINGS)})`
            + '.then(r => JSON.stringify(r))',
        awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (answer.exceptionDetails)
    {
        throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails)}`);
    }
    const got = JSON.parse(answer.result.value);
    if (got.error)
    {
        throw new Error(got.error);
    }
    const expectedPoints = inputs.flatMap(input=>corners.flatMap(corner=>
        corner.map((value, k)=>bits(value + input[k]))));
    const expectedConstants = inputs.flatMap(input=>{
        const center = [0, 1, 2].map(k=>(corners.reduce((sum, corner)=>sum + corner[k] + input[k],
            0)) / 4);
        return [...[1, 1, 1, 1, 1, 1].flatMap(factor=>[bits(factor), 0, 0, 0]),
            ...center.map(bits), 0];
    });
    const quad = tessellate('quad', 0, 2, [1, 1, 1, 1, 1, 1]);
    const checks = [
        ['output control points', got.points, expectedPoints],
        ['patch constants', got.constants, expectedConstants],
        ['tessellated counts', got.counts, [4, 6, 4, 6]],
        ['tessellated points', got.tessPoints, [...quad.points, ...quad.points]],
        ['tessellated indices', got.tessIndices, [...quad.indices, ...quad.indices]],
    ];
    let failed = 0;
    for (const [name, actual, expected] of checks)
    {
        const same = JSON.stringify(actual) === JSON.stringify(expected);
        console.log(`hull: ${name} ${same ? 'as expected' : `differ: ${JSON.stringify(actual)}`
            + ` against ${JSON.stringify(expected)}`}`);
        failed += same ? 0 : 1;
    }
    return failed;
}

async function main(){
    const corpus = JSON.parse(gunzipSync(readFileSync(CORPUS)).toString());
    // The core's sources at /src/: the draw case runs the engine's own device.
    const server = await serveStatic({ sandboxDir: TOOL_ROOT,
        srcDir: resolve(TOOL_ROOT, '../../modules/core/src') });
    const extraFlags = process.argv.flatMap((arg, at)=>(arg === '--chrome-flag'
        ? [process.argv[at + 1]] : []));
    const browser = await launchWithGpu({ headed: process.argv.includes('--headed'), extraFlags });
    /** @type {CdpEndpoint | null} */
    let cdp = null;
    let failed = 0;
    let points = 0;
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
        await cdp.send('Runtime.evaluate', { expression: `(${pageRunner.toString()})();`
            + ` (${drawPageRunner.toString()})(); null` }, sessionId);
        let adapter = null;
        for (let from = 0; from < corpus.cases.length; from += BATCH)
        {
            const batch = corpus.cases.slice(from, from + BATCH);
            const words = batch.flatMap(patchWords);
            const answer = await cdp.send('Runtime.evaluate', {
                expression: `tessRun(${JSON.stringify(TESSELLATOR_WGSL)}, ${
                    JSON.stringify(TESSELLATOR_BINDINGS)}, ${PATCH_BYTES}, ${
                    JSON.stringify(words)}).then(r => JSON.stringify(r))`,
                awaitPromise: true, returnByValue: true,
            }, sessionId);
            if (answer.exceptionDetails)
            {
                throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails)}`);
            }
            const ran = JSON.parse(answer.result.value);
            if (ran.error)
            {
                throw new Error(ran.error);
            }
            adapter = ran.adapter;
            batch.forEach((/** @type {any} */ one, /** @type {number} */ k)=>{
                const got = ran.results[k];
                const gotPoints = [];
                for (let at = 0; at < got.points.length; at += 2)
                {
                    gotPoints.push(`${got.points[at]},${got.points[at + 1]}`);
                }
                points += gotPoints.length;
                const pointsSame = gotPoints.join(' ') === one.points;
                const indicesSame = got.indices.join(' ') === one.indices;
                if (!pointsSame || !indicesSame)
                {
                    failed++;
                    if (failed <= 10)
                    {
                        console.log(`differs: ${one.domain} ${one.partitioning}/${one.output}`
                            + ` [${one.factors.join(', ')}]: ${pointsSame ? '' : 'points '}${
                                indicesSame ? '' : 'indices'}`);
                    }
                }
            });
        }
        console.log(`${corpus.cases.length - failed}/${corpus.cases.length} patches as the`
            + ` reference, ${points} points; adapter ${JSON.stringify(adapter)}`);
        failed += await hullCase(cdp, sessionId);
        failed += await scanCases(cdp, sessionId);
        failed += await fetchCases(cdp, sessionId);
        for (const way of ['direct', 'indexed, indirect', 'indirect'])
        {
            failed += await drawCase(cdp, sessionId, { vs: passThroughVertexShader(),
                // Fractional odd at 4: five segments a side, two of them thin.
                hs: quadHullShader({ factor: 4, partitioning: 3,
                    corners: [[0, 0], [0, 2], [1, 0], [1, 2]] }),
                ds: quadDomainShader(), ps: colouredPixelShader() }, way);
        }
        failed += await cullCases(cdp, sessionId, passQuadHullShader, {
            vs: passThroughVertexShader(), ds: lerpQuadDomainShader(),
            ps: colouredPixelShader() });
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
    process.exitCode = failed === 0 ? 0 : 1;
}

if (isMain(import.meta.url))
{
    await main();
}
