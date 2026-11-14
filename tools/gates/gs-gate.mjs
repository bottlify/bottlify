/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The geometry shader's and stream output's gate on a real device: the
 * engine's own Direct3D 11 device (`d3d10/device.js`) on the page's GPU,
 * draws through a geometry shader (`geometry.js`) whose stream output is
 * read back through a staging buffer, and the stream-output statistics and
 * overflow its queries answer, each against what Direct3D writes:
 *
 * - a vertex shader's bytecode made a geometry shader to stream points out;
 * - a triangle strip through a geometry shader that passes each triangle on,
 *   the odd triangle's first two vertices swapped as the input assembler
 *   hands it over, written as a list;
 * - two draws appending, and the statistics over both;
 * - a buffer with room for one triangle of two: the first written whole, the
 *   second to no buffer, and the overflow predicate set.
 *
 *   node tools/gates/gs-gate.mjs [--headed] [--chrome-flag FLAG]...
 *
 * Exits 1 on any difference.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from '../lib/browser.mjs';
import { CdpEndpoint } from '../lib/cdp.mjs';
import { serveStatic } from '../lib/server.mjs';
import {
    passThroughVertexShader, triangleGeometryShader,
} from '../../modules/core/src/layers/graphics/d3d10/shader-fixtures.js';
import { isMain } from '../lib/common.mjs';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const NO_RASTERIZED_STREAM = 0xffffffff;

/** What runs in the page: a scene drawn through the engine's device, and what it streamed. */
function pageRunner(){
    const page = /** @type {any} */ (globalThis);
    page.gsDevice = (async()=>{
        const adapter = await navigator.gpu?.requestAdapter();
        return adapter ? { device: await adapter.requestDevice() } : { error: 'no adapter' };
    })();
    /** @param {any} scene */
    page.gsRun = async scene=>{
        const opened = await page.gsDevice;
        if (!opened.device)
        {
            return { error: opened.error };
        }
        const device = opened.device;
        const { D3D11CreateDevice } = await import('/src/layers/graphics/d3d10/device.js');
        const { createBackend } = await import('/src/layers/graphics/webgpu/backend.js');
        /** @type {string[]} */
        const said = [];
        device.pushErrorScope('validation');
        const backend = createBackend({ device, queue: device.queue, presentTo: ()=>{} });
        /** @type {any} */
        const out = { wantDevice: true, wantContext: true };
        const hr = D3D11CreateDevice(null, 1, null, 0, [0xb000], out, {
            backend,
            createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
            createTexture: (/** @type {any} */ descriptor)=>device.createTexture(descriptor),
            divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
                said.push(detail),
        });
        if (hr !== 0)
        {
            return { error: `D3D11CreateDevice answered ${hr}` };
        }
        const d3d = out.device;
        const context = out.context;
        /** @type {any} */
        const made = {};
        /** @param {string} what @param {number} answer */
        const check = (what, answer)=>{
            if (answer !== 0)
            {
                throw new Error(`${what} answered ${answer >>> 0}`);
            }
        };
        const shader = (/** @type {number[]} */ words)=>new Uint8Array(words);
        check('CreateTexture2D', d3d.CreateTexture2D({ Width: 16, Height: 8, MipLevels: 1,
            ArraySize: 1, Format: 28, SampleDesc: { Count: 1, Quality: 0 }, Usage: 0,
            BindFlags: 0x20, CPUAccessFlags: 0, MiscFlags: 0 }, null, made));
        check('CreateRenderTargetView', d3d.CreateRenderTargetView(made.resource, null, made));
        context.OMSetRenderTargets([made.view], null);
        context.RSSetViewports([{ TopLeftX: 0, TopLeftY: 0, Width: 16, Height: 8,
            MinDepth: 0, MaxDepth: 1 }]);
        check('vertex buffer', d3d.CreateBuffer({ ByteWidth: scene.vertices.length * 4,
            Usage: 0, BindFlags: 1, CPUAccessFlags: 0, MiscFlags: 0 },
        { pSysMem: new Uint8Array(Float32Array.from(scene.vertices).buffer) }, made));
        context.IASetVertexBuffers(0, [made.resource], [16], [0]);
        check('CreateInputLayout', d3d.CreateInputLayout([{ SemanticName: 'POSITION',
            SemanticIndex: 0, Format: 2, InputSlot: 0, AlignedByteOffset: 0, InputSlotClass: 0,
            InstanceDataStepRate: 0 }], shader(scene.vs), made));
        context.IASetInputLayout(made.layout);
        check('CreateVertexShader', d3d.CreateVertexShader(shader(scene.vs), made));
        context.VSSetShader(made.shader);
        check('CreateGeometryShaderWithStreamOutput', d3d.CreateGeometryShaderWithStreamOutput(
            shader(scene.gs), scene.entries, scene.strides, scene.rasterized, made));
        context.GSSetShader(made.shader);
        context.IASetPrimitiveTopology(scene.topology);
        check('stream-output buffer', d3d.CreateBuffer({ ByteWidth: scene.bytes, Usage: 0,
            BindFlags: 0x10, CPUAccessFlags: 0, MiscFlags: 0 }, null, made));
        const streamed = made.resource;
        context.SOSetTargets([streamed], [0]);
        /** @type {any[]} */
        const queries = [];
        for (const kind of [6, 7])
        {
            check('CreateQuery', d3d.CreateQuery({ Query: kind, MiscFlags: 0 }, made));
            queries.push(made.query);
            made.query.Begin();
        }
        for (const count of scene.draws)
        {
            context.Draw(count, 0);
        }
        queries.forEach(query=>query.End());
        check('staging buffer', d3d.CreateBuffer({ ByteWidth: scene.bytes, Usage: 3,
            BindFlags: 0, CPUAccessFlags: 0x20000, MiscFlags: 0 }, null, made));
        const staging = made.resource;
        context.CopyResource(staging, streamed);
        context.Flush();
        await d3d.idle();
        /** @type {any} */
        const mapped = {};
        check('Map', await staging.Map(0, 1, 0, mapped));
        const words = [...new Float32Array(mapped.data.slice().buffer, 0, scene.bytes / 4)];
        /** @type {number[][]} */
        const answers = [];
        for (const query of queries)
        {
            /** @type {any} */
            const got = {};
            for (let tries = 0; tries < 100; tries++)
            {
                if (query.GetData(true, query.GetDataSize(), 0, got) === 0)
                {
                    break;
                }
                await d3d.idle();
                await new Promise(done=>setTimeout(done, 10));
            }
            const view = got.data ? new DataView(got.data.buffer, got.data.byteOffset) : null;
            answers.push(!view ? [] : query.GetDataSize() === 16
                ? [Number(view.getBigUint64(0, true)), Number(view.getBigUint64(8, true))]
                : [view.getUint32(0, true)]);
        }
        const failure = await device.popErrorScope();
        return { words, answers, said, error: failure?.message ?? null,
            geometry: d3d.diagnostics().geometry, failures: d3d.diagnostics().failures };
    };
}

/** @param {any} cdp @param {string} sessionId @param {string} expression */
async function evaluate(cdp, sessionId, expression){
    const answer = await cdp.send('Runtime.evaluate', {
        expression: `${expression}.then(r => JSON.stringify(r))`,
        awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (answer.exceptionDetails)
    {
        throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails)}`);
    }
    return JSON.parse(answer.result.value);
}

/** Four vertices, each its own position: (k, k + 0.25, k + 0.5, 1). */
const VERTICES = [0, 1, 2, 3].flatMap(k=>[k, k + 0.25, k + 0.5, 1]);
/** @param {number[]} order @returns {number[]} those vertices' words */
const verticesOf = order=>order.flatMap(k=>VERTICES.slice(k * 4, k * 4 + 4));
const POSITION_OUT = [{ Stream: 0, SemanticName: 'SV_POSITION', SemanticIndex: 0,
    StartComponent: 0, ComponentCount: 4, OutputSlot: 0 }];

const CASES = [
    { name: 'a vertex shader\'s points streamed out',
        scene: { gs: passThroughVertexShader(), topology: 1, draws: [4], bytes: 256,
            rasterized: NO_RASTERIZED_STREAM },
        words: verticesOf([0, 1, 2, 3]), answers: [[4, 4], [0]] },
    { name: 'a strip through a geometry shader, written as a list',
        scene: { gs: triangleGeometryShader(), topology: 5, draws: [4], bytes: 256,
            rasterized: 0 },
        words: verticesOf([0, 1, 2, 2, 1, 3]), answers: [[2, 2], [0]] },
    { name: 'two draws appending',
        scene: { gs: triangleGeometryShader(), topology: 4, draws: [3, 3], bytes: 256,
            rasterized: NO_RASTERIZED_STREAM },
        words: verticesOf([0, 1, 2, 0, 1, 2]), answers: [[2, 2], [0]] },
    { name: 'room for one triangle of two',
        scene: { gs: triangleGeometryShader(), topology: 5, draws: [4], bytes: 64,
            rasterized: NO_RASTERIZED_STREAM },
        words: verticesOf([0, 1, 2]), answers: [[1, 2], [1]] },
];

async function main(){
    const server = await serveStatic({ sandboxDir: TOOL_ROOT,
        srcDir: resolve(TOOL_ROOT, '../../modules/core/src') });
    const extraFlags = process.argv.flatMap((arg, at)=>(arg === '--chrome-flag'
        ? [process.argv[at + 1]] : []));
    const browser = await launchWithGpu({ headed: process.argv.includes('--headed'), extraFlags });
    /** @type {CdpEndpoint | null} */
    let cdp = null;
    let failed = 0;
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
                expression: 'document.readyState === \'complete\'', returnByValue: true,
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
        for (const one of CASES)
        {
            const scene = { ...one.scene, vs: [...passThroughVertexShader()],
                gs: [...one.scene.gs], vertices: VERTICES, entries: POSITION_OUT, strides: [16] };
            const got = await evaluate(cdp, sessionId, `gsRun(${JSON.stringify(scene)})`);
            const words = got.words?.slice(0, one.words.length) ?? [];
            const rest = got.words?.slice(one.words.length) ?? [];
            const fine = !got.error && got.said.length === 0
                && JSON.stringify(words) === JSON.stringify(one.words)
                && rest.every((/** @type {number} */ word)=>word === 0)
                && JSON.stringify(got.answers) === JSON.stringify(one.answers);
            failed += fine ? 0 : 1;
            console.log(`${one.name}: ${fine ? 'as Direct3D writes it' : `differs: ${
                JSON.stringify({ words: got.words, answers: got.answers, said: got.said,
                    geometry: got.geometry, failures: got.failures, error: got.error })
            } against ${JSON.stringify({ words: one.words,
                answers: one.answers })}`}`);
        }
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
