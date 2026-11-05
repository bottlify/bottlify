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

async function main(){
    const corpus = JSON.parse(gunzipSync(readFileSync(CORPUS)).toString());
    const server = await serveStatic({ sandboxDir: TOOL_ROOT, srcDir: TOOL_ROOT });
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
        await cdp.send('Runtime.evaluate', { expression: `(${pageRunner.toString()})(); null` },
            sessionId);
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
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
    process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
{
    await main();
}
