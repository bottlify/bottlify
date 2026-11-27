/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tessellation gate's draw cases, run by `tess-gate.mjs` in its page:
 *
 * - the running sums between the tessellator's passes, the room cut short;
 * - vertex fetch: the vertex shader run as compute before the hull shader
 *   (`linkVertexPatches`), over seeded streams of every vertex format at
 *   offsets of every alignment a format allows, per-vertex and per-instance,
 *   through 16-bit indices at an odd word with a base vertex, some elements
 *   past the buffer's end; every register it stores compared with what a
 *   vertex fetch makes of the bytes, decoded here;
 * - a draw: the engine's own Direct3D 11 device (`d3d10/device.js`) on the
 *   page's GPU, two one-point patches through `quadHullShader` and
 *   `quadDomainShader` with fractional factors, every pixel of the target
 *   read back and compared with the picture the domain shader's mapping
 *   makes, whichever triangles the tessellator cut it into.
 */

import { parseDxbc, SHADER_KIND, SYSTEM_VALUE, COMPONENT_TYPE }
    from '../../modules/core/src/layers/graphics/d3d10/dxbc.js';
import {
    assemble, dclInput, dclInputSiv, dclOutput, mov, o, ret, v,
} from '../../modules/core/src/layers/graphics/d3d10/shader-fixtures.js';
import {
    VERTEX_PATCH_BINDING, linkVertexPatches, translateShader,
} from '../../modules/core/src/layers/graphics/d3d10/wgsl.js';
import { VERTEX_FORMAT } from '../../modules/core/src/layers/graphics/d3d10/gpuformats.js';
import {
    TESS_ARGS_WORDS, TESS_SCAN_BINDINGS, TESS_SCAN_WGSL,
} from '../../modules/core/src/layers/graphics/d3d10/tessellator-wgsl.js';
import { generator } from './shader-cases.mjs';

/** What runs in the page: a compute program over given buffers, and the draw. */
export function drawPageRunner(){
    const page = /** @type {any} */ (globalThis);
    /**
     * One dispatch of `code` over `groups` (entries of a binding, a buffer
     * type and its words), and the words of the buffers `reads` names back.
     *
     * @param {string} code @param {string} entryPoint @param {number} invocations
     * @param {{ binding: number, type: string, words: number[] }[][]} groups
     * @param {number[][]} reads [group, binding] each
     */
    page.computeRun = async(code, entryPoint, invocations, groups, reads)=>{
        const device = (await page.tessDevice).device;
        device.pushErrorScope('validation');
        const usage = { storage: 0x80 | 0x4 | 0x8, 'read-only-storage': 0x80 | 0x8,
            uniform: 0x40 | 0x8 };
        const made = groups.map(entries=>entries.map(one=>{
            // A storage buffer as long as its words: its end is what a fetch
            // past it is judged by.
            const size = one.type === 'uniform'
                ? Math.max(16, Math.ceil((one.words.length * 4) / 16) * 16)
                : Math.max(4, one.words.length * 4);
            const buffer = device.createBuffer({ size,
                usage: usage[/** @type {'storage'} */ (one.type)] });
            const words = new Uint32Array(size / 4);
            words.set(one.words);
            device.queue.writeBuffer(buffer, 0, words);
            return { ...one, buffer, size };
        }));
        const module = device.createShaderModule({ code });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((/** @type {any} */ m)=>m.type === 'error');
        if (errors.length > 0)
        {
            return { error: errors.map((/** @type {any} */ m)=>`${m.lineNum}: ${m.message}`)
                .join('\n') };
        }
        const layouts = made.map(entries=>device.createBindGroupLayout({
            entries: entries.map(one=>({ binding: one.binding, visibility: 4,
                buffer: { type: one.type } })) }));
        const pipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
            compute: { module, entryPoint } });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        made.forEach((entries, index)=>pass.setBindGroup(index, device.createBindGroup({
            layout: layouts[index],
            entries: entries.map(one=>({ binding: one.binding, resource: { buffer: one.buffer } })),
        })));
        pass.dispatchWorkgroups(Math.ceil(invocations / 64));
        pass.end();
        const staged = reads.map(([group, binding])=>{
            const one = made[group].find(entry=>entry.binding === binding);
            const out = device.createBuffer({ size: one.size, usage: 0x1 | 0x8 });
            encoder.copyBufferToBuffer(one.buffer, 0, out, 0, one.size);
            return out;
        });
        device.queue.submit([encoder.finish()]);
        const failure = await device.popErrorScope();
        if (failure)
        {
            return { error: failure.message };
        }
        const results = [];
        for (const out of staged)
        {
            await out.mapAsync(1);
            results.push([...new Uint32Array(out.getMappedRange().slice(0))]);
        }
        return { results };
    };

    /**
     * Two one-point patches drawn through the engine's Direct3D 11 device:
     * the target's pixels, and what the device said.
     *
     * @param {number} width @param {number} height @param {any} scene
     */
    page.tessDraw = async(width, height, scene)=>{
        const device = (await page.tessDevice).device;
        const { D3D11CreateDevice } = await import('/src/layers/graphics/d3d10/device.js');
        const { createBackend } = await import('/src/layers/graphics/webgpu/backend.js');
        /** @type {string[]} */
        const said = [];
        /** @type {any[]} */
        const textures = [];
        device.pushErrorScope('validation');
        const backend = createBackend({ device, queue: device.queue, presentTo: ()=>{} });
        /** @type {any} */
        const out = { wantDevice: true, wantContext: true };
        const hr = D3D11CreateDevice(null, 1, null, 0, [0xb000], out, {
            backend,
            createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
            createTexture: (/** @type {any} */ descriptor)=>{
                const texture = device.createTexture(descriptor);
                textures.push({ descriptor, texture });
                return texture;
            },
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
        check('CreateTexture2D', d3d.CreateTexture2D({ Width: width, Height: height,
            MipLevels: 1, ArraySize: 1, Format: 28, SampleDesc: { Count: 1, Quality: 0 },
            Usage: 0, BindFlags: 0x20, CPUAccessFlags: 0, MiscFlags: 0 }, null, made));
        const target = textures.at(-1).texture;
        check('CreateRenderTargetView', d3d.CreateRenderTargetView(made.resource, null, made));
        context.OMSetRenderTargets([made.view], null);
        context.ClearRenderTargetView(made.view, scene.clear ?? [0, 0, 0, 0]);
        const bytes = (/** @type {number[]} */ words, float = false)=>new Uint8Array(
            (float ? Float32Array : Uint16Array).from(words).buffer);
        check('vertex buffer', d3d.CreateBuffer({ ByteWidth: scene.vertices.length * 4,
            Usage: 0, BindFlags: 1, CPUAccessFlags: 0, MiscFlags: 0 },
        { pSysMem: bytes(scene.vertices, true) }, made));
        context.IASetVertexBuffers(0, [made.resource], [16], [0]);
        if (scene.indices)
        {
            check('index buffer', d3d.CreateBuffer({ ByteWidth: scene.indices.length * 2,
                Usage: 0, BindFlags: 2, CPUAccessFlags: 0, MiscFlags: 0 },
            { pSysMem: bytes(scene.indices) }, made));
            context.IASetIndexBuffer(made.resource, 57, scene.indexOffset);
        }
        const shader = (/** @type {number[]} */ words)=>new Uint8Array(words);
        check('CreateInputLayout', d3d.CreateInputLayout([{ SemanticName: 'POSITION',
            SemanticIndex: 0, Format: 2, InputSlot: 0, AlignedByteOffset: 0, InputSlotClass: 0,
            InstanceDataStepRate: 0 }], shader(scene.vs), made));
        context.IASetInputLayout(made.layout);
        for (const [create, set, words] of [['CreateVertexShader', 'VSSetShader', scene.vs],
            ['CreateHullShader', 'HSSetShader', scene.hs],
            ['CreateDomainShader', 'DSSetShader', scene.ds],
            ['CreatePixelShader', 'PSSetShader', scene.ps]])
        {
            check(create, d3d[create](shader(words), made));
            context[set](made.shader);
        }
        // Without `cull`, both faces drawn; with it, Direct3D's default state.
        if (!scene.cull)
        {
            check('CreateRasterizerState', d3d.CreateRasterizerState({ FillMode: 3,
                CullMode: 1, FrontCounterClockwise: false, DepthBias: 0, DepthBiasClamp: 0,
                SlopeScaledDepthBias: 0, DepthClipEnable: true, ScissorEnable: false,
                MultisampleEnable: false, AntialiasedLineEnable: false }, made));
            context.RSSetState(made.state);
        }
        context.IASetPrimitiveTopology(scene.topology ?? 33);
        context.RSSetViewports([{ TopLeftX: 0, TopLeftY: 0, Width: width, Height: height,
            MinDepth: 0, MaxDepth: 1 }]);
        if (scene.indirect)
        {
            // Arguments a shader could have written: the device reads them on the GPU.
            check('arguments buffer', d3d.CreateBuffer({ ByteWidth: 64, Usage: 0,
                BindFlags: 0x80, CPUAccessFlags: 0, MiscFlags: 0, MiscFlags11: 0x10 },
            { pSysMem: new Uint8Array(Uint32Array.from(scene.indirect.words).buffer) }, made));
            context[scene.indices ? 'DrawIndexedInstancedIndirect' : 'DrawInstancedIndirect'](
                made.resource, scene.indirect.offset);
        }
        else if (scene.indices)
        {
            context.DrawIndexed(scene.indexCount, scene.startIndex, scene.baseVertex);
        }
        else
        {
            context.Draw(scene.vertexCount, scene.startVertex ?? 0);
        }
        context.Flush();
        await d3d.idle();
        const rowBytes = Math.ceil((width * 4) / 256) * 256;
        const read = device.createBuffer({ size: rowBytes * height, usage: 0x1 | 0x8 });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: rowBytes },
            { width, height });
        device.queue.submit([encoder.finish()]);
        const failure = await device.popErrorScope();
        await read.mapAsync(1);
        const mapped = new Uint8Array(read.getMappedRange());
        const pixels = [];
        for (let y = 0; y < height; y++)
        {
            pixels.push(...mapped.subarray(y * rowBytes, y * rowBytes + width * 4));
        }
        return { pixels, said, error: failure?.message ?? null,
            tessellation: d3d.diagnostics().tessellation };
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
    const got = JSON.parse(answer.result.value);
    if (got.error)
    {
        throw new Error(got.error);
    }
    return got;
}

const scratch = new DataView(new ArrayBuffer(4));
/** @param {number} value */
const f32 = value=>{
    scratch.setFloat32(0, value, true);
    return scratch.getUint32(0, true);
};
/** @param {number} half */
const halfToFloat = half=>{
    const sign = half & 0x8000 ? -1 : 1;
    const exponent = (half >> 10) & 0x1f;
    const mantissa = half & 0x3ff;
    if (exponent === 0)
    {
        return sign * mantissa * 2 ** -24;
    }
    if (exponent === 31)
    {
        return mantissa ? NaN : sign * Infinity;
    }
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
};

/**
 * What a vertex fetch makes of the bytes at `at`: a register's four words,
 * the lacking components 0, 0, 0, 1; zero where the element is past the end.
 *
 * @param {string} format @param {Uint8Array} stream @param {number} at
 * @returns {{ words: number[], exact: boolean, float?: boolean }}  `float`: a NaN is any
 *     NaN (a device may or may not keep a half's payload in widening it)
 */
export function fetchReference(format, stream, at){
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    if (format === 'unorm10-10-10-2')
    {
        if (at + 4 > stream.length)
        {
            return { words: [0, 0, 0, 0], exact: true };
        }
        const word = view.getUint32(at, true);
        return { words: [word & 0x3ff, (word >>> 10) & 0x3ff, (word >>> 20) & 0x3ff]
            .map(c=>f32(c / 1023)).concat(f32((word >>> 30) / 3)), exact: false };
    }
    const bgra = format === 'unorm8x4-bgra';
    const match = /^(float|uint|sint|unorm|snorm)(8|16|32)(?:x(\d))?$/
        .exec(bgra ? 'unorm8x4' : format);
    if (!match)
    {
        throw new Error(`no reference for ${format}`);
    }
    const kind = match[1];
    const bits = Number(match[2]);
    const count = Number(match[3] ?? 1);
    if (at + (bits * count) / 8 > stream.length)
    {
        return { words: [0, 0, 0, 0], exact: true };
    }
    const integer = kind === 'uint' || kind === 'sint';
    const words = [0, 0, 0, integer ? 1 : f32(1)];
    for (let c = 0; c < count; c++)
    {
        const offset = at + (c * bits) / 8;
        const raw = bits === 8 ? view.getUint8(offset)
            : bits === 16 ? view.getUint16(offset, true) : view.getUint32(offset, true);
        const signed = bits === 8 ? view.getInt8(offset)
            : bits === 16 ? view.getInt16(offset, true) : view.getInt32(offset, true);
        words[c] = {
            float: bits === 16 ? f32(halfToFloat(raw)) : raw,
            uint: raw,
            sint: signed >>> 0,
            unorm: f32(raw / (2 ** bits - 1)),
            snorm: f32(Math.max(signed / (2 ** (bits - 1) - 1), -1)),
        }[kind] ?? raw;
    }
    if (bgra)
    {
        [words[0], words[2]] = [words[2], words[0]];
    }
    return { words, exact: kind !== 'unorm' && kind !== 'snorm', float: kind === 'float' };
}

/** @param {number} bits a float's @returns {boolean} */
const isNaNBits = bits=>(bits & 0x7f800000) === 0x7f800000 && (bits & 0x7fffff) !== 0;

/** @param {number} a @param {number} b the bits of two floats @returns {number} ulps apart */
const ulps = (a, b)=>Math.abs((a | 0) - (b | 0));

const FORMATS = [...new Set(Object.values(VERTEX_FORMAT))].sort();

/** @param {string} format @returns {number} the bytes of one component */
const componentBytes = format=>(format === 'unorm10-10-10-2' ? 4
    : Number(/(8|16|32)/.exec(format)?.[1] ?? 32) / 8);

/**
 * Seeded vertex fetches through `linkVertexPatches` on the device.
 *
 * @param {any} cdp @param {string} sessionId
 * @returns {Promise<number>} how many cases failed
 */
export async function fetchCases(cdp, sessionId){
    let failed = 0;
    let compared = 0;
    const formats = [...FORMATS];
    for (let seed = 1; formats.length > 0 || seed <= 8; seed++)
    {
        const random = generator(seed);
        const pick = (/** @type {number} */ n)=>Math.floor(random() * n);
        const count = 6;
        const chosen = Array.from({ length: count }, ()=>(formats.length > 0
            ? /** @type {string} */ (formats.shift()) : FORMATS[pick(FORMATS.length)]));
        // Elements in two streams: a per-vertex one and a per-instance one.
        const elements = chosen.map((format, register)=>{
            const stream = register % 3 === 2 ? 1 : 0;
            const align = Math.min(4, componentBytes(format));
            return { format, register, stream, offset: pick(12) * align };
        });
        const strides = [0, 1].map(stream=>Math.max(4, ...elements
            .filter(one=>one.stream === stream).map(one=>one.offset + 16)) + pick(3) * 4);
        const streams = [0, 1].map(stream=>({
            stepMode: stream === 1 ? 'instance' : 'vertex',
            attributes: elements.filter(one=>one.stream === stream).map(one=>({
                shaderLocation: one.register, offset: one.offset, format: one.format })),
        }));
        const integerOf = (/** @type {string} */ format)=>(/^uint/.test(format)
            ? COMPONENT_TYPE.UINT : /^sint/.test(format) ? COMPONENT_TYPE.SINT
                : COMPONENT_TYPE.FLOAT);
        const signature = [...elements.map(one=>({ name: 'TEXCOORD', index: one.register,
            register: one.register, componentType: integerOf(one.format) })),
        { name: 'SV_VertexID', register: count, systemValue: SYSTEM_VALUE.VERTEX_ID,
            componentType: COMPONENT_TYPE.UINT },
        { name: 'SV_InstanceID', register: count + 1, systemValue: SYSTEM_VALUE.INSTANCE_ID,
            componentType: COMPONENT_TYPE.UINT }];
        const outputs = signature.map((one, at)=>({ name: 'TEXCOORD', index: at,
            register: at, componentType: one.componentType }));
        const vs = parseDxbc(assemble({
            kind: SHADER_KIND.VERTEX,
            inputs: signature,
            outputs,
            instructions: [
                ...signature.map((one, at)=>(one.systemValue ? dclInputSiv(v(at), one.systemValue)
                    : dclInput(v(at)))),
                ...outputs.map((_, at)=>dclOutput(o(at))),
                ...outputs.map((_, at)=>mov(o(at), v(at))),
                ret(),
            ],
        }));
        // The hull shader keeps them in the other order: each lands by its name.
        const registers = outputs.length;
        const hullInputs = outputs.map(one=>({ ...one, register: registers - 1 - one.register,
            mask: 0xf, systemValue: 0, componentType: one.componentType, readWriteMask: 0xf }));
        const translated = translateShader(/** @type {any} */ (vs));
        const linked = linkVertexPatches(translated, /** @type {any} */ (hullInputs), registers,
            streams);
        if (linked.unsupported.length > 0)
        {
            throw new Error(`vertex patches: ${linked.unsupported.join('; ')}`);
        }
        // Streams of random bytes, the per-vertex one short of its last elements.
        const vertexCount = 12;
        const instances = 3;
        const points = 4;
        // Half the bytes from the edges of the formats: the most negative
        // signed value (which a fetch clamps to -1), the ends, a half's NaN.
        const EDGES = [0x00, 0x80, 0xff, 0x7f, 0x01, 0x7c, 0xfe];
        const bytesOf = (/** @type {number} */ length)=>Uint8Array.from({ length },
            ()=>(pick(2) === 0 ? EDGES[pick(EDGES.length)] : pick(256)));
        const stream0 = bytesOf(strides[0] * vertexCount - 6);
        const stream1 = bytesOf(strides[1] * 4);
        const indices = Array.from({ length: 2 + points }, ()=>pick(vertexCount + 2));
        const indexOffset = 2;
        const indexBytes = new Uint8Array(indexOffset + indices.length * 2);
        indices.forEach((index, at)=>new DataView(indexBytes.buffer)
            .setUint16(indexOffset + at * 2, index, true));
        const baseVertex = pick(3) - 1;
        const first = 1;
        const startInstance = 1;
        const words = (/** @type {Uint8Array} */ bytes)=>{
            const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
            padded.set(bytes);
            return [...new Uint32Array(padded.buffer)];
        };
        const params = [points * instances, points, 2, indexOffset, first, baseVertex >>> 0,
            startInstance, 0, 0, strides[0], 0, 0, 0, strides[1], 0, 0];
        const got = await evaluate(cdp, sessionId, `computeRun(${JSON.stringify(linked.code)},`
            + ` 'vertexPatches', ${points * instances}, ${JSON.stringify([[], [
                { binding: VERTEX_PATCH_BINDING.indices, type: 'read-only-storage',
                    words: words(indexBytes) },
                { binding: VERTEX_PATCH_BINDING.out, type: 'storage',
                    words: new Array(points * instances * registers * 4).fill(0) },
                { binding: VERTEX_PATCH_BINDING.params, type: 'uniform', words: params },
                { binding: VERTEX_PATCH_BINDING.streams, type: 'read-only-storage',
                    words: words(stream0) },
                { binding: VERTEX_PATCH_BINDING.streams + 1, type: 'read-only-storage',
                    words: words(stream1) },
            ]])}, [[1, ${VERTEX_PATCH_BINDING.out}]])`);
        const out = got.results[0];
        const padded = [stream0, stream1].map(bytes=>{
            const copy = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
            copy.set(bytes);
            return copy;
        });
        const problems = [];
        for (let point = 0; point < points * instances; point++)
        {
            const instance = Math.floor(point / points);
            const vertex = (indices[first + (point % points)] + baseVertex) >>> 0;
            /** @type {{ words: number[], exact: boolean, float?: boolean }[]} */
            const expected = elements.map(one=>{
                const element = one.stream === 1 ? startInstance + instance : vertex;
                const stride = strides[one.stream];
                const length = padded[one.stream].length;
                return element > Math.floor(length / stride) ? { words: [0, 0, 0, 0], exact: true }
                    : fetchReference(one.format, padded[one.stream],
                        element * stride + one.offset);
            });
            // The vertex ID is the index itself, without the base vertex (test_vertex_id).
            expected.push({ words: [indices[first + (point % points)], 0, 0, 0], exact: true },
                { words: [instance, 0, 0, 0], exact: true });
            expected.forEach((want, register)=>{
                const at = (point * registers + (registers - 1 - register)) * 4;
                const have = out.slice(at, at + 4);
                compared++;
                const wrong = have.some((/** @type {number} */ word, /** @type {number} */ c)=>
                    (want.float && isNaNBits(word) && isNaNBits(want.words[c]) ? false
                        : want.exact ? word !== want.words[c] >>> 0
                            : ulps(word, want.words[c]) > 2));
                if (wrong && problems.length < 5)
                {
                    problems.push(`point ${point} ${register < count ? elements[register].format
                        : register === count ? 'SV_VertexID' : 'SV_InstanceID'}: ${
                        have.map((/** @type {number} */ x)=>x.toString(16))} against ${
                        want.words.map(x=>(x >>> 0).toString(16))}`);
                }
            });
        }
        if (problems.length > 0)
        {
            failed++;
            console.log(`vertex fetch, seed ${seed}: ${problems.join('; ')}`);
        }
    }
    console.log(`vertex fetch: ${compared} registers of every format compared, ${failed}`
        + ' seeds differ');
    return failed;
}

/**
 * The running sums between the tessellator's passes (`TESS_SCAN_WGSL`) over
 * seeded counts, the buffers' room cut short in the middle: every offset, the
 * patches culled (exactly those past the room), the draw's arguments.
 *
 * @param {any} cdp @param {string} sessionId
 * @returns {Promise<number>} how many cases failed
 */
export async function scanCases(cdp, sessionId){
    let failed = 0;
    for (const [seed, patches] of [[1, 1], [2, 255], [3, 600], [4, 2049]])
    {
        const random = generator(seed);
        const pick = (/** @type {number} */ n)=>Math.floor(random() * n);
        const counts = Array.from({ length: patches }, ()=>(pick(5) === 0 ? [0, 0]
            : [1 + pick(50), 1 + pick(100)]));
        const total = counts.reduce((sum, [p, i])=>[sum[0] + p, sum[1] + i], [0, 0]);
        const room = [Math.max(1, Math.floor(total[0] * 0.7)), Math.floor(total[1] * 0.9)];
        const records = Array.from({ length: patches }, ()=>[2, 0, 2, 0,
            0x40000000, 0x40000000, 0x40000000, 0x40000000, 0x40000000, 0x40000000, 0, 0]);
        const got = await evaluate(cdp, sessionId, `computeRun(${JSON.stringify(TESS_SCAN_WGSL)},`
            + ` 'scanPatches', 1, ${JSON.stringify([[
                { binding: TESS_SCAN_BINDINGS.counts, type: 'read-only-storage',
                    words: counts.flat() },
                { binding: TESS_SCAN_BINDINGS.offsets, type: 'storage',
                    words: new Array(patches * 2).fill(0) },
                { binding: TESS_SCAN_BINDINGS.patches, type: 'storage', words: records.flat() },
                { binding: TESS_SCAN_BINDINGS.args, type: 'storage',
                    words: new Array(TESS_ARGS_WORDS).fill(7) },
                { binding: TESS_SCAN_BINDINGS.params, type: 'uniform',
                    words: [patches, 0, room[0], room[1]] },
            ]])}, [[0, ${TESS_SCAN_BINDINGS.offsets}], [0, ${TESS_SCAN_BINDINGS.patches}],`
            + ` [0, ${TESS_SCAN_BINDINGS.args}]])`);
        const [offsets, written, args] = got.results;
        const problems = [];
        let run = [0, 0];
        let drawn = 0;
        counts.forEach(([p, i], patch)=>{
            if (offsets[patch * 2] !== run[0] || offsets[patch * 2 + 1] !== run[1])
            {
                problems.push(`patch ${patch} offsets ${offsets.slice(patch * 2, patch * 2 + 2)}`
                    + ` against ${run}`);
            }
            run = [run[0] + p, run[1] + i];
            const fits = run[0] <= room[0] && run[1] <= room[1];
            if (fits)
            {
                drawn = run[1];
            }
            const culled = written[patch * 12 + 4] === 0;
            if (culled === fits)
            {
                problems.push(`patch ${patch} ${culled ? 'culled' : 'kept'} with its end at`
                    + ` ${run} of ${room}`);
            }
        });
        const wantArgs = [drawn, 1, 0, 0, total[0], total[1]];
        if (JSON.stringify(args.slice(0, 6)) !== JSON.stringify(wantArgs))
        {
            problems.push(`arguments ${args.slice(0, 6)} against ${wantArgs}`);
        }
        if (problems.length > 0)
        {
            failed++;
            console.log(`sums, ${patches} patches: ${problems.slice(0, 4).join('; ')}`);
        }
    }
    console.log(`sums: 4 cases of 1 to 2049 patches, ${failed} differ`);
    return failed;
}

/**
 * What Wine's test_quad_tessellation (d3d11.c) checks of the target, without
 * the geometry shader and stream output it reads its triangles back with: a
 * quad patch of four points over the whole target, under Direct3D's default
 * culling, is culled when the tessellator turns its triangles counter-
 * clockwise, drawn when clockwise, discarded with an edge factor of zero, and
 * drawn again with one of five.
 *
 * @param {any} cdp @param {string} sessionId
 * @param {(options: { factors: number[], output: number }) => Uint8Array} hull
 * @param {{ ds: Uint8Array, ps: Uint8Array, vs: Uint8Array }} shaders
 * @returns {Promise<number>} how many cases differ
 */
export async function cullCases(cdp, sessionId, hull, shaders){
    const WHITE = 0xffffffff;
    const GREEN = 0xff00ff00;
    const cases = [
        { name: 'counter-clockwise, culled', output: 4, factors: [1, 1, 1, 1, 1, 1], want: WHITE },
        { name: 'clockwise, drawn', output: 3, factors: [1, 1, 1, 1, 1, 1], want: GREEN },
        { name: 'an edge factor of 0, discarded', output: 3, factors: [0, 2, 2, 2, 1, 1],
            want: WHITE },
        { name: 'an edge factor of 5, drawn', output: 3, factors: [5, 2, 2, 2, 1, 1],
            want: GREEN },
    ];
    let failed = 0;
    for (const one of cases)
    {
        const scene = {
            vs: [...shaders.vs], hs: [...hull(one)], ds: [...shaders.ds], ps: [...shaders.ps],
            vertices: [-1, -1, 0, 1, -1, 1, 0, 1, 1, -1, 0, 1, 1, 1, 0, 1],
            indices: null, vertexCount: 4, topology: 36, cull: true, clear: [1, 1, 1, 1],
        };
        const got = await evaluate(cdp, sessionId, `tessDraw(8, 8, ${JSON.stringify(scene)})`);
        const colours = new Set();
        for (let at = 0; at < got.pixels.length; at += 4)
        {
            colours.add(((got.pixels[at + 3] << 24) | (got.pixels[at + 2] << 16)
                | (got.pixels[at + 1] << 8) | got.pixels[at]) >>> 0);
        }
        const fine = colours.size === 1 && colours.has(one.want) && got.error === null
            && got.said.length === 0;
        failed += fine ? 0 : 1;
        console.log(`quad tessellation, ${one.name}: ${fine ? 'as Windows draws it'
            : `${[...colours].map(c=>c.toString(16))} against ${one.want.toString(16)}${
                got.error ? `; GPU: ${got.error}` : ''}${got.said.length
                ? `; said: ${got.said.join(' | ')}` : ''}`}`);
    }
    return failed;
}

/**
 * Two patches through the engine's device; every pixel against the picture.
 *
 * @param {any} cdp @param {string} sessionId
 * @param {{ ds: Uint8Array, hs: Uint8Array, ps: Uint8Array, vs: Uint8Array }} shaders
 * @returns {Promise<number>} 1 when it differs
 */
export async function drawCase(cdp, sessionId, shaders, way = 'direct'){
    const width = 16;
    const height = 8;
    const base = {
        vs: [...shaders.vs], hs: [...shaders.hs], ds: [...shaders.ds], ps: [...shaders.ps],
        // Vertices 1 and 2 are the patches' points; 0 and 3 are never read.
        vertices: [5, 5, 0, 1, -1, -1, 0, 1, 0, -1, 0, 1, 7, 7, 0, 1],
    };
    // From the index buffer's second index on, each one less than the vertex.
    const indexed = { indices: [9, 0, 1], indexOffset: 2 };
    /** @type {Record<string, any>} */
    const ways = {
        direct: { ...indexed, indexCount: 2, startIndex: 0, baseVertex: 1 },
        // The same draw with its counts on the GPU, a word into the buffer.
        'indexed, indirect': { ...indexed,
            indirect: { offset: 4, words: [0xdead, 2, 1, 0, 1, 0] } },
        'indirect': { indirect: { offset: 8, words: [0xdead, 0xdead, 2, 1, 1, 0] } },
    };
    const scene = { ...base, ...ways[way] };
    const got = await evaluate(cdp, sessionId,
        `tessDraw(${width}, ${height}, ${JSON.stringify(scene)})`);
    let wrong = 0;
    const examples = [];
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const ndcX = ((x + 0.5) / width) * 2 - 1;
            const ndcY = 1 - ((y + 0.5) / height) * 2;
            const patch = ndcX < 0 ? 0 : 1;
            const u = ndcX - (patch === 0 ? -1 : 0);
            const across = (ndcY + 1) / 2;
            const want = [u, across, patch, 1].map(c=>Math.round(Math.min(1, c) * 255));
            const at = (y * width + x) * 4;
            const have = got.pixels.slice(at, at + 4);
            if (have.some((/** @type {number} */ c, /** @type {number} */ k)=>
                Math.abs(c - want[k]) > 2))
            {
                wrong++;
                if (examples.length < 4)
                {
                    examples.push(`(${x}, ${y}) ${have} against ${want}`);
                }
            }
        }
    }
    const fine = wrong === 0 && got.error === null && got.said.length === 0;
    const named = way === 'direct' ? '' : ` (${way})`;
    console.log(`draw${named}: ${fine ? 'every pixel as expected' : `${wrong} pixels differ`
        + ` ${examples.join('; ')}${got.error ? `; GPU: ${got.error}` : ''}${got.said.length
            ? `; said: ${got.said.join(' | ')}` : ''}`}; ${JSON.stringify(got.tessellation)}`);
    return fine ? 0 : 1;
}
