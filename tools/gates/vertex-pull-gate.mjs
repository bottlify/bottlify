/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the vertex streams a vertex stage reads itself
 * (`VertexPull` in `d3d10/wgsl.js`) beside the ones WebGPU fetches as
 * vertex buffers, on a real device through the engine's own Direct3D 11
 * device. Each seeded case draws one point a vertex and instance, an
 * attribute of a random format carried to an integer target bit for bit,
 * twice:
 *
 * - as the case lays it out: a stride WebGPU does not align, per-instance
 *   data stepping once every several instances or for all of them, a first
 *   instance, and some drawn indirectly - the streams the vertex stage reads;
 * - the same elements repacked at an aligned stride, one per instance, drawn
 *   directly from instance zero - the streams WebGPU fetches.
 *
 * A format WebGPU has no vertex spelling for (`PULLED_VERTEX_FORMAT`) is
 * always read by the vertex stage; its second arm is the same elements
 * decoded on the processor (`uavclear.js` `smallFloatOf`) and given as
 * R32G32B32A32_FLOAT, which WebGPU fetches.
 *
 * Every pixel of the two targets must hold the same bits, and every one
 * must have been drawn.
 *
 *   node tools/gates/vertex-pull-gate.mjs [--cases N] [--seed S] [--headed]
 *
 * Exits 1 on any difference.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from '../lib/browser.mjs';
import { CdpEndpoint } from '../lib/cdp.mjs';
import { serveStatic } from '../lib/server.mjs';
import {
    add, assemble, dclInput, dclInputPs, dclOutput, dclOutputSiv, mov, o, ret, v,
} from '../../modules/core/src/layers/graphics/d3d10/shader-fixtures.js';
import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE } from
    '../../modules/core/src/layers/graphics/d3d10/dxbc.js';
import { PULLED_VERTEX_FORMAT, VERTEX_FORMAT, VERTEX_FORMAT_BYTES } from
    '../../modules/core/src/layers/graphics/d3d10/gpuformats.js';
import { smallFloatOf } from '../../modules/core/src/layers/graphics/d3d10/uavclear.js';
import { isMain } from '../lib/common.mjs';

/** DXGI_FORMAT_R32G32B32A32_FLOAT, the decoded arm of a pulled-only format. */
const RGBA32_FLOAT = 2;

/**
 * R11G11B10_FLOAT's three channels, as (shift, mantissa bits): what a
 * pulled-only element is decoded into on the processor.
 */
const SMALL_FLOATS = [[0, 6], [11, 6], [22, 5]];

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** @param {string} format a WebGPU vertex format @returns {number} a COMPONENT_TYPE */
const componentTypeOf = format=>(format.startsWith('uint') ? COMPONENT_TYPE.UINT
    : format.startsWith('sint') ? COMPONENT_TYPE.SINT : COMPONENT_TYPE.FLOAT);

/**
 * The vertex shader: SV_Position the sum of a per-vertex and a per-instance
 * position, the attribute under test passed on as it came; the pixel shader
 * writes it to an integer target, its bits unchanged.
 *
 * @param {number} componentType
 */
function shaders(componentType){
    const vs = assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'POSITION', register: 0 }, { name: 'PLACE', register: 1 },
            { name: 'ATTR', register: 2, componentType }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'ATTR', register: 1, componentType }],
        instructions: [dclInput(v(0)), dclInput(v(1)), dclInput(v(2)),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), dclOutput(o(1)),
            add(o(0), v(0), v(1)), mov(o(1), v(2)), ret()],
    });
    const ps = assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'ATTR', register: 1, componentType }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0,
            componentType: COMPONENT_TYPE.UINT }],
        instructions: [dclInputPs(v(1), 1), dclOutput(o(0)), mov(o(0), v(1)), ret()],
    });
    return { vs: [...vs], ps: [...ps] };
}

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
}

/**
 * One case: the attribute's format and layout, how it is drawn, and the two
 * arms' streams.
 *
 * @param {number} seed
 */
function caseOf(seed){
    const next = random(seed * 2654435761);
    /** @param {number} n */
    const below = n=>Math.floor(next() * n);
    // A quarter of the cases a format only the vertex stage reads.
    const formats = next() < 0.25 ? Object.entries(PULLED_VERTEX_FORMAT)
        : Object.entries(VERTEX_FORMAT);
    const [dxgi, format] = formats[below(formats.length)];
    const pulledOnly = Object.values(PULLED_VERTEX_FORMAT).includes(format);
    const size = VERTEX_FORMAT_BYTES[format];
    const vertices = 1 + below(5);
    const instances = 1 + below(6);
    const perInstance = next() < 0.6;
    const rate = perInstance ? [0, 1, 2, 3][below(4)] : 1;
    const startInstance = below(4);
    const startVertex = below(3);
    const indirect = next() < 0.3;
    // The case's own stride: often one WebGPU does not align.
    const elementOffset = below(3) * Math.min(4, size);
    const stride = elementOffset + size + below(6);
    const bufferOffset = below(3) * 4;
    /** The case's elements as the program reads them, by element index. */
    const elements = perInstance
        ? startInstance + (rate === 0 ? 1 : Math.floor((instances - 1) / rate) + 1)
        : startVertex + vertices;
    const bytes = Array.from({ length: bufferOffset + elements * stride + 4 }, ()=>below(256));
    // A half of exponent 31 is an infinity or NaN, which Direct3D and the
    // vertex stage widen as such and SwiftShader's vertex fetch widens as a
    // number: the case keeps its halves finite.
    if (format.startsWith('float16'))
    {
        for (let element = 0; element < elements; element++)
        {
            for (let half = 0; half < size; half += 2)
            {
                const high = bufferOffset + element * stride + elementOffset + half + 1;
                bytes[high] = (bytes[high] & 0x7c) === 0x7c ? bytes[high] & ~0x40 : bytes[high];
            }
        }
    }
    // An unsigned small float of exponent 31 is an infinity or NaN, whose
    // payload the interstage need not keep: the case keeps them finite.
    if (pulledOnly)
    {
        for (let element = 0; element < elements; element++)
        {
            const at = bufferOffset + element * stride + elementOffset;
            let word = (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
                | bytes[at + 3] << 24) >>> 0;
            for (const [shift, mantissa] of SMALL_FLOATS)
            {
                const exponent = shift + mantissa;
                if (((word >>> exponent) & 0x1f) === 0x1f)
                {
                    word = (word & ~(1 << exponent)) >>> 0;
                }
                // Denormals, a quarter of the channels.
                if (next() < 0.25)
                {
                    word = (word & ~(0x1f << exponent)) >>> 0;
                }
            }
            bytes.splice(at, 4, word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff,
                word >>> 24);
        }
    }
    /** @param {number} element @returns {number[]} its bytes */
    const elementBytes = element=>bytes.slice(bufferOffset + element * stride + elementOffset,
        bufferOffset + element * stride + elementOffset + size);
    /** @param {number[]} one an element's bytes @returns {number[]} as the reference arm gives it */
    const decoded = one=>{
        if (!pulledOnly)
        {
            return [...one, ...new Array(Math.ceil(size / 4) * 4 - size).fill(0)];
        }
        const word = (one[0] | one[1] << 8 | one[2] << 16 | one[3] << 24) >>> 0;
        const channels = SMALL_FLOATS.map(([shift, mantissa])=>
            smallFloatOf((word >>> shift) & ((1 << (mantissa + 5)) - 1), mantissa));
        return [...new Uint8Array(Float32Array.from([...channels, 1]).buffer)];
    };
    // The repacked arm: one element a vertex, or a instance from instance zero.
    const packedStride = pulledOnly ? 16 : Math.ceil(size / 4) * 4;
    const packed = (perInstance
        ? Array.from({ length: instances }, (_, i)=>elementBytes(rate === 0 ? startInstance
            : startInstance + Math.floor(i / rate)))
        : Array.from({ length: startVertex + vertices }, (_, e)=>elementBytes(e)))
        .flatMap(decoded);
    /** @param {number} first @returns {number[]} the per-instance places from `first` */
    const places = first=>Array.from({ length: first + instances }, (_, e)=>[0,
        -2 * (Math.max(0, e - first) + 0.5) / instances, 0, 0]).flat();
    const positions = Array.from({ length: startVertex + vertices }, (_, e)=>[
        -1 + 2 * (Math.max(0, e - startVertex) + 0.5) / vertices, 1, 0, 1]).flat();
    return {
        seed, format, dxgi: Number(dxgi), size, vertices, instances, perInstance, rate,
        startInstance, startVertex, indirect, stride, elementOffset, bufferOffset,
        ...shaders(componentTypeOf(format)),
        positions,
        arms: [
            { bytes, stride, elementOffset, bufferOffset, rate, startInstance, indirect,
                places: places(startInstance) },
            { bytes: packed, stride: packedStride, elementOffset: 0, bufferOffset: 0,
                rate: perInstance ? 1 : 0, startInstance: 0, indirect: false,
                places: places(0), ...(pulledOnly ? { dxgi: RGBA32_FLOAT } : {}) },
        ],
    };
}

/** What runs in the page: one case's two arms drawn through the engine's device. */
function pageRunner(){
    const page = /** @type {any} */ (globalThis);
    page.pullDevice = (async()=>{
        const adapter = await navigator.gpu?.requestAdapter();
        return adapter ? { device: await adapter.requestDevice() } : { error: 'no adapter' };
    })();
    /** @param {any} scene */
    page.pullRun = async scene=>{
        const opened = await page.pullDevice;
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
        /** @param {Uint8Array} bytes @param {number} [misc] */
        const buffer = (bytes, misc = 0)=>{
            check('CreateBuffer', d3d.CreateBuffer({ ByteWidth: bytes.length, Usage: 0,
                BindFlags: misc ? 0 : 1, CPUAccessFlags: 0, MiscFlags: misc },
            { pSysMem: bytes }, made));
            return made.resource;
        };
        const floats = (/** @type {number[]} */ values)=>new Uint8Array(
            Float32Array.from(values).buffer);
        const width = scene.vertices;
        const height = scene.instances;
        check('CreateVertexShader', d3d.CreateVertexShader(new Uint8Array(scene.vs), made));
        context.VSSetShader(made.shader);
        const vs = new Uint8Array(scene.vs);
        check('CreatePixelShader', d3d.CreatePixelShader(new Uint8Array(scene.ps), made));
        context.PSSetShader(made.shader);
        context.IASetPrimitiveTopology(1);
        context.RSSetViewports([{ TopLeftX: 0, TopLeftY: 0, Width: width, Height: height,
            MinDepth: 0, MaxDepth: 1 }]);
        /** @type {number[][]} */
        const results = [];
        for (const arm of scene.arms)
        {
            check('CreateTexture2D', d3d.CreateTexture2D({ Width: width, Height: height,
                MipLevels: 1, ArraySize: 1, Format: 3, SampleDesc: { Count: 1, Quality: 0 },
                Usage: 0, BindFlags: 0x20, CPUAccessFlags: 0, MiscFlags: 0 }, null, made));
            const target = made.resource;
            check('CreateRenderTargetView', d3d.CreateRenderTargetView(target, null, made));
            const view = made.view;
            context.ClearRenderTargetView(view, [0xdead, 0xdead, 0xdead, 0xdead]);
            context.OMSetRenderTargets([view], null);
            const perInstance = scene.perInstance;
            check('CreateInputLayout', d3d.CreateInputLayout([
                { SemanticName: 'POSITION', SemanticIndex: 0, Format: 2, InputSlot: 0,
                    AlignedByteOffset: 0, InputSlotClass: 0, InstanceDataStepRate: 0 },
                { SemanticName: 'PLACE', SemanticIndex: 0, Format: 2, InputSlot: 1,
                    AlignedByteOffset: 0, InputSlotClass: 1, InstanceDataStepRate: 1 },
                { SemanticName: 'ATTR', SemanticIndex: 0, Format: arm.dxgi ?? scene.dxgi,
                    InputSlot: 2,
                    AlignedByteOffset: arm.elementOffset, InputSlotClass: perInstance ? 1 : 0,
                    InstanceDataStepRate: perInstance ? arm.rate : 0 },
            ], vs, made));
            context.IASetInputLayout(made.layout);
            context.IASetVertexBuffers(0, [buffer(floats(scene.positions)),
                buffer(floats(arm.places)), buffer(new Uint8Array(arm.bytes))],
            [16, 16, arm.stride], [0, 0, arm.bufferOffset]);
            if (arm.indirect)
            {
                const args = buffer(new Uint8Array(Uint32Array.of(width, height,
                    scene.startVertex, arm.startInstance).buffer), 0x10);
                context.DrawInstancedIndirect(args, 0);
            }
            else
            {
                context.DrawInstanced(width, height, scene.startVertex, arm.startInstance);
            }
            check('staging', d3d.CreateTexture2D({ Width: width, Height: height, MipLevels: 1,
                ArraySize: 1, Format: 3, SampleDesc: { Count: 1, Quality: 0 }, Usage: 3,
                BindFlags: 0, CPUAccessFlags: 0x20000, MiscFlags: 0 }, null, made));
            const staging = made.resource;
            context.CopyResource(staging, target);
            context.Flush();
            await d3d.idle();
            /** @type {any} */
            const mapped = {};
            check('Map', await staging.Map(0, 1, 0, mapped));
            const words = new Uint32Array(mapped.data.slice().buffer);
            /** @type {number[]} */
            const pixels = [];
            for (let y = 0; y < height; y++)
            {
                for (let x = 0; x < width * 4; x++)
                {
                    pixels.push(words[y * mapped.rowPitch / 4 + x]);
                }
            }
            results.push(pixels);
        }
        const failure = await device.popErrorScope();
        return { results, said, error: failure?.message ?? null };
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

async function main(){
    const argument = (/** @type {string} */ name, /** @type {number} */ fallback)=>{
        const at = process.argv.indexOf(name);
        return at >= 0 ? Number(process.argv[at + 1]) : fallback;
    };
    const cases = argument('--cases', 60);
    const firstSeed = argument('--seed', 1);
    const server = await serveStatic({ sandboxDir: TOOL_ROOT,
        srcDir: resolve(TOOL_ROOT, '../../modules/core/src') });
    const browser = await launchWithGpu({ headed: process.argv.includes('--headed') });
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
        /** @type {Record<string, number>} */
        const kinds = { pulled: 0, indirect: 0, stepped: 0, everyInstance: 0, pulledOnly: 0 };
        for (let seed = firstSeed; seed < firstSeed + cases; seed++)
        {
            const scene = caseOf(seed);
            kinds.pulled += scene.stride % 4 !== 0 ? 1 : 0;
            kinds.pulledOnly += scene.arms[1].dxgi === RGBA32_FLOAT ? 1 : 0;
            kinds.indirect += scene.indirect ? 1 : 0;
            kinds.stepped += scene.perInstance && scene.rate > 1 ? 1 : 0;
            kinds.everyInstance += scene.perInstance && scene.rate === 0 ? 1 : 0;
            const got = await evaluate(cdp, sessionId, `pullRun(${JSON.stringify(scene)})`);
            const [laid, packed] = got.results ?? [[], []];
            const drawn = laid.length > 0 && laid.every((/** @type {number} */ word,
                /** @type {number} */ at)=>word === packed[at])
                && !laid.some((/** @type {number} */ word, /** @type {number} */ at)=>
                    word === 0xdead && packed[at] === 0xdead && at % 4 === 3);
            const fine = !got.error && got.said.length === 0 && drawn;
            failed += fine ? 0 : 1;
            if (!fine)
            {
                console.log(`seed ${seed} (${scene.format}, stride ${scene.stride},`
                    + ` ${scene.perInstance ? `per instance at rate ${scene.rate}` : 'per vertex'},`
                    + ` first instance ${scene.startInstance}${scene.indirect ? ', indirect' : ''})`
                    + ` differs: ${JSON.stringify({ laid, packed, said: got.said,
                        error: got.error })}`);
            }
        }
        console.log(`${cases - failed} of ${cases} cases drew the same bits both ways`
            + ` (${JSON.stringify(kinds)})`);
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
