/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 10's command ring as a gate: whatever a program does in a frame,
 * the GPU is given what it would be given with every call a trap.
 *
 * The program runs on machines side by side -- the real processor, the
 * bridge's tables and the seam's own handlers -- one with the guest code off,
 * where every call traps, and one with it on, where the setters and the draws
 * write the device's command ring (`d3d10-inguest.js`) and the host makes
 * them on its way into its next method (`d3d10-ring.js`); and one more with
 * the guest code on and the device recording for a twin that draws, as in a
 * graphics worker. The program is drawn from a seed out of what a frame is
 * made of: every call the ring carries, with arrays of every length a record
 * holds and past it, null objects and null arrays; buffers mapped and written
 * through the address a map hands out; getters that read what the ring set;
 * and presents. What is compared is every call's answer and every out-
 * parameter, and every draw the GPU is given, as it would read it
 * (`gpuReads`). The guest code must have carried the calls, or the gate
 * would compare nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createGraphicsLibraries } from './exports.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { createDirect3D10 } from '../d3d10/root.js';
import { playedAtOnce } from '../remote/direct3d.js';
import { playedDirect3D10, recordedDirect3D10 } from '../remote/d3d10.js';
import { COMMAND_RING_BYTES } from './shadow.js';
import { COMPILED } from './d3d10-inguest.x86.js';

/** @type {Record<string, any>} */
const IN_GUEST = COMPILED;
import { gpuReads, idle } from './frames-contract.itest.js';
import {
    CONTEXT_RING, ID3D10BUFFER_SLOTS, ID3D10DEVICE_SLOTS, IDXGISWAPCHAIN_SLOTS, ID3D10VIEW_SLOTS,
} from './d3d10.js';
import { ID3D11DEVICECONTEXT_SLOTS, ID3D11DEVICE_SLOTS } from './d3d11.js';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_MAP, D3D10_PRIMITIVE_TOPOLOGY, D3D10_SDK_VERSION,
    D3D10_USAGE, DXGI_FORMAT,
} from '../d3d10/constants.js';
import { SHADER_KIND, SYSTEM_VALUE } from '../d3d10/dxbc.js';
import {
    assemble, cb, colouredPixelShader, colouredVertexShader, dclConstantBuffer, dclOutput, mov, o,
    ret,
} from '../d3d10/shader-fixtures.js';

/** D3D11_SDK_VERSION. */
const D3D11_SDK_VERSION = 7;

const PROGRAM = 0x8000;
const STRINGS = 0x9000;
const STACK = 0x300000;
const OUT = 0x10000;
const STRUCTS = 0x10100;
const TRAPS = 0x100000;
const CODE = 0x200000;
const HEAP = 0x400000;
const HEAP_END = 0x3f00000;
const UNTOUCHED = 0xdeadbeef;
const HWND = 0x00010044;

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    (value >>> 24) & 0xff];

/** The tables the program's calls go through, by the kind of object. */
const SLOTS = /** @type {Record<string, [string, number][]>} */ ({
    device: ID3D10DEVICE_SLOTS,
    buffer: ID3D10BUFFER_SLOTS,
    chain: IDXGISWAPCHAIN_SLOTS,
    view: ID3D10VIEW_SLOTS,
    device11: ID3D11DEVICE_SLOTS,
    context: ID3D11DEVICECONTEXT_SLOTS,
});

/** @param {number} seed */
const random = seed=>{
    let drawn = 0;
    const next = ()=>createHash('sha256').update(`${seed}:${drawn++}`).digest()
        .readUInt32LE(0) / 4294967296;
    return {
        /** @param {number} n */
        below: n=>Math.floor(next() * n),
        /** @template T @param {T[]} list @returns {T} */
        pick: list=>list[Math.floor(next() * list.length)],
        float: ()=>next() * 2 - 1,
    };
};

/** @param {number} value */
const floatWord = value=>new Uint32Array(new Float32Array([value]).buffer)[0];

/**
 * One call as the program makes it: through the pointer `on` names, the
 * method of that kind, its arguments -- a string names a pointer the program
 * holds, 'out', 'out2' and 'out3' the out-parameters, `{ words }` the address
 * of those words.
 *
 * @typedef {{ on: string, kind: string, method: string,
 *     args: (number | string | { words: (number | string)[] })[] }} Call
 */

/**
 * The processor with Direct3D 10's seam over it, and a device of 10's, or
 * of 11's with its immediate context.
 *
 * @param {boolean} guestCode @param {boolean} worker @param {boolean} [eleven]
 */
function machine(guestCode, worker, eleven = false){
    const gpu = createFakeDevice();
    const reads = gpuReads(gpu);
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: { sliceMs: Infinity },
    });
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    /** @param {number} at @param {number} length */
    const readBytes = (at, length)=>host.readPhysical(at >>> 0, length).slice();
    /** @param {number} at @param {Uint8Array} bytes */
    const writeBytes = (at, bytes)=>host.writePhysical(at >>> 0, bytes);
    /** @param {number} at */
    const readU32 = at=>{
        const b = host.readPhysical(at >>> 0, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>writeBytes(at, new Uint8Array(u32(value >>> 0)));
    const memory = { readBytes, writeBytes, readMemory: readBytes, writeMemory: writeBytes,
        readU32, writeU32 };
    let heap = HEAP;
    let code = CODE;
    /** @param {number} bytes */
    const allocate = bytes=>{
        const align = bytes >= 4096 ? 4096 : 16;
        const at = (heap + align - 1) & -align;
        if (at + bytes > HEAP_END)
        {
            return 0;
        }
        heap = at + bytes;
        return at;
    };
    /** @param {number} bytes */
    const allocateCode = bytes=>{
        const at = (code + 15) & -16;
        code = at + bytes;
        assert.ok(code < HEAP, 'the routines fit below the arena');
        return at;
    };
    /** @type {Map<number, { name: string, fn: any }>} */
    const handlers = new Map();
    let nextTrap = TRAPS;
    const vtables = createVtables({
        memory,
        heap: { allocate, allocateCode },
        register: (name, fn)=>{
            const at = nextTrap++;
            host.writePhysical(at, new Uint8Array([0xf4]));
            handlers.set(at, { name, fn });
            return at;
        },
    });
    /**
     * A write watch as the engine's says what was written: here by what
     * changed since the last look, a page at a time, since cork's stores
     * mark nothing in this machine.
     *
     * @param {number} base @param {number} length
     */
    const watchWrites = (base, length)=>{
        let seen = readBytes(base, length);
        return {
            take: (/** @type {number} */ address, /** @type {number} */ size)=>{
                const now = readBytes(base, length);
                /** @type {number[]} */
                const pages = [];
                for (let page = address >>> 12; page <= (address + size - 1) >>> 12; page++)
                {
                    const from = Math.max(0, page * 4096 - base);
                    const to = Math.min(length, (page + 1) * 4096 - base);
                    if (from < to
                        && now.subarray(from, to).some((/** @type {number} */ byte,
                            /** @type {number} */ i)=>byte !== seen[from + i]))
                    {
                        pages.push(page);
                        seen.set(now.subarray(from, to), from);
                    }
                }
                seen = seen.slice();
                return pages;
            },
        };
    };
    const guest = { allocate, free: ()=>{}, readMemory: readBytes, writeMemory: writeBytes,
        watchWrites };
    const drawing = {
        backend: createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
            now: ()=>0 }),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            id: `sampler-${JSON.stringify(descriptor)}`, descriptor }),
        createTexture: gpu.device.createTexture,
    };
    const libraries = createGraphicsLibraries({
        graphics: {
            create: (/** @type {string} */ name, /** @type {any} */ caps)=>{
                if (name !== 'd3d10')
                {
                    return null;
                }
                return worker
                    ? recordedDirect3D10(createDirect3D10, { ...caps, guest },
                        playedAtOnce(playedDirect3D10(createDirect3D10, { ...caps, ...drawing,
                            writeMemory: writeBytes })))
                    : createDirect3D10({ ...caps, ...drawing, guest });
            },
            available: ()=>false,
            adapter: ()=>({ vendor: 'nvidia', architecture: 'ampere', description: '' }),
        },
        only: [eleven ? 'D3D11.dll' : 'D3D10.dll', 'DXGI.dll'],
        memory,
        publishInterface: (object, id)=>vtables.publish(object, id),
        unpublishInterface: (object, id)=>vtables.unpublish(object, id),
        screen: ()=>({ width: 640, height: 480, bitsPerPixel: 32 }),
        windowClientSize: ()=>({ width: 16, height: 16 }),
        allocate,
        allocateCode,
        guestCode,
        guestTraps: [],
        ringBytes: COMMAND_RING_BYTES,
        divergence: ()=>{},
        resolution: ()=>{},
        now: ()=>0,
    });

    /** @type {Map<number, string>} */
    const nameOf = new Map();
    /** @type {Map<string, number>} */
    const pointerOf = new Map();
    /** @param {number} pointer */
    const name = pointer=>{
        if (pointer === 0)
        {
            return null;
        }
        let known = nameOf.get(pointer);
        if (known === undefined)
        {
            known = `#${nameOf.size}`;
            nameOf.set(pointer, known);
            pointerOf.set(known, pointer);
        }
        return known;
    };
    let structs = STRUCTS;
    /** @param {(number | string)[]} words */
    const place = words=>{
        const at = structs;
        structs += (words.length * 4 + 15) & -16;
        assert.ok(structs < TRAPS, 'the structures fit');
        writeBytes(at, new Uint8Array(new Uint32Array(words.map(word=>(typeof word === 'string'
            ? pointerOf.get(word) ?? 0 : word >>> 0))).buffer));
        return at;
    };

    /**
     * Runs one call from a fresh stack until it returns. What it wrote at
     * 'out' is named when `naming` -- a call that hands out an object -- and
     * otherwise said by the name of a pointer the program holds, or as it is.
     *
     * @param {Call} call @param {boolean} [naming]
     */
    const run = (call, naming = false)=>{
        const self = pointerOf.get(call.on);
        assert.ok(self !== undefined, `${call.on} is a pointer this machine handed out`);
        writeU32(OUT, UNTOUCHED);
        writeU32(OUT + 4, UNTOUCHED);
        writeU32(OUT + 8, UNTOUCHED);
        structs = STRUCTS;
        const values = call.args.map(arg=>{
            if (typeof arg === 'number')
            {
                return arg >>> 0;
            }
            if (typeof arg === 'object')
            {
                return place(arg.words);
            }
            if (arg === 'out' || arg === 'out2' || arg === 'out3')
            {
                return OUT + 4 * ['out', 'out2', 'out3'].indexOf(arg);
            }
            const pointer = pointerOf.get(arg);
            assert.ok(pointer !== undefined, `${arg} is a pointer this machine handed out`);
            return pointer;
        });
        const index = SLOTS[call.kind].findIndex(([entry])=>entry === call.method);
        assert.ok(index >= 0, `${call.method} is a ${call.kind} slot`);
        const slot = 3 + index;
        /** @type {number[]} */
        const bytes = [];
        for (const value of [...values].reverse())
        {
            bytes.push(0x68, ...u32(value));
        }
        bytes.push(0x68, ...u32(self), 0xb8, ...u32(self), 0x8b, 0x00, 0xff, 0x90,
            ...u32(slot * 4), 0xf4);
        const end = PROGRAM + bytes.length;
        host.writePhysical(PROGRAM, new Uint8Array(bytes));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        /** @type {string[]} */
        const traps = [];
        for (let slices = 0; ; slices++)
        {
            assert.ok(slices < 1000, `${call.method} returns`);
            host.runSlice(1 << 16);
            const eip = host.readReg32('eip');
            if (!host.halted())
            {
                continue;
            }
            if (eip === end)
            {
                break;
            }
            const entry = handlers.get(eip - 1);
            assert.ok(entry, `${call.method} stopped at 0x${eip.toString(16)}, no trap`);
            const esp = host.readReg32('esp');
            const words = entry.fn.argBytes >>> 2;
            const args = Array.from({ length: words }, (unused, i)=>readU32(esp + 4 + 4 * i));
            const answer = entry.fn.handler(args);
            assert.ok(typeof answer?.then !== 'function', `${entry.name} answers at once`);
            traps.push(entry.name.replace(/^.*::/, ''));
            host.writeReg32('eax', (answer ?? 0) >>> 0);
            host.writeReg32('esp', esp + 4 + entry.fn.argBytes);
            host.writeReg32('eip', readU32(esp));
        }
        assert.equal(host.readReg32('esp'), STACK, `${call.method} popped what it was handed`);
        const out = readU32(OUT);
        /** A word the call wrote: a pointer the program holds by its name. @param {number} at */
        const word = at=>{
            const value = readU32(at);
            return nameOf.get(value) ?? value;
        };
        return {
            eax: host.readReg32('eax'),
            out: out === UNTOUCHED ? 'untouched' : naming ? name(out) : nameOf.get(out) ?? out,
            out2: word(OUT + 4),
            out3: word(OUT + 8),
            traps,
        };
    };

    // A device and a swap chain, through the entry point the host answers.
    const descAt = place([16, 16, 60, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 0, 0, 1, 0, 0x20, 1, HWND,
        1, 0, 0]);
    assert.equal(eleven
        ? libraries.libraries['D3D11.dll'].D3D11CreateDeviceAndSwapChain.handler([0, 1, 0, 0, 0,
            0, D3D11_SDK_VERSION, descAt, OUT + 4, OUT, 0, OUT + 8]) >>> 0
        : libraries.libraries['D3D10.dll'].D3D10CreateDeviceAndSwapChain.handler([0, 1, 0,
            0, D3D10_SDK_VERSION, descAt, OUT + 4, OUT]) >>> 0, 0);
    name(readU32(OUT));
    name(readU32(OUT + 4));
    if (eleven)
    {
        name(readU32(OUT + 8));
    }
    const strings = new TextEncoder().encode('POSITION\0COLOR\0');
    writeBytes(STRINGS, strings);
    return { run, gpu, reads, writeBytes, readBytes, readU32, pointerOf };
}

/** A pixel shader whose colour is the first register of cb0. */
const constantPixelShader = ()=>assemble({
    kind: SHADER_KIND.PIXEL,
    outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
    instructions: [dclConstantBuffer(0, 1), dclOutput(o(0)), mov(o(0), cb(0, 0)), ret()],
});

/** @param {Uint8Array} bytes */
const words = bytes=>[...new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2)];

const STRIDE = 32;
const VERTICES = 64;
/** The device's calls the ring carries: any of them that traps with guest code had to. */
const CARRIED = new Set(Object.keys(IN_GUEST).filter(name=>/^[A-Z]/.test(name)));

/**
 * A program drawn from a seed, run on one machine: every call's answer and
 * what the GPU read.
 *
 * @param {number} seed @param {number} steps @param {boolean} guestCode
 * @param {boolean} worker
 */
async function play(seed, steps, guestCode, worker){
    const m = machine(guestCode, worker);
    const pick = random(seed);
    /** @type {string[]} */
    const answers = [];
    /** How many of the device's calls reached the host, and which. */
    let trapped = 0;
    /** @type {Map<string, number>} */
    const trappedBy = new Map();
    /** The ring's calls the program made, by the routine that carries each. @type {Set<string>} */
    const carried = new Set();
    /** @param {string} on @param {string} kind @param {string} method @param {Call['args']} args */
    const call = (on, kind, method, args = [])=>{
        const answer = m.run({ on, kind, method, args },
            method.startsWith('Create') || method === 'GetBuffer');
        const routine = kind === 'buffer' ? `Buffer${method}` : method;
        if ((kind === 'device' || kind === 'buffer') && CARRIED.has(routine))
        {
            carried.add(routine);
        }
        if ((kind === 'device' || kind === 'buffer') && CARRIED.has(routine)
            && answer.traps.includes(method))
        {
            trapped++;
            trappedBy.set(method, (trappedBy.get(method) ?? 0) + 1);
        }
        // Where a map puts the bytes is the device's to choose: that it put them somewhere is
        // what the program sees.
        answers.push(method === 'Map' ? `Map ${answer.eax.toString(16)} ${answer.out !== 0}`
            : `${method} ${answer.eax.toString(16)} ${answer.out} ${answer.out2} ${answer.out3}`);
        return answer;
    };
    /** @param {string} method @param {Call['args']} args */
    const device = (method, args = [])=>call('#0', 'device', method, args);
    /** @param {string} method @param {Call['args']} args @returns {string} */
    const make = (method, args)=>{
        const made = device(method, args);
        assert.ok(made.out && made.out !== 'untouched',
            `${method} made something: ${made.eax.toString(16)}`);
        return /** @type {string} */ (made.out);
    };

    // GetBuffer(0, IID_ID3D10Texture2D, out) and a view of it.
    const iidTexture2D = [0x9b7e4c04, 0x4106342c, 0x274f9fa1, 0xf089f604];
    const back = /** @type {string} */ (call('#1', 'chain', 'GetBuffer', [0,
        { words: iidTexture2D }, 'out']).out);
    const target = make('CreateRenderTargetView', [back, 0, 'out']);
    // A depth texture of the target's size and a view of it.
    const depthTexture = make('CreateTexture2D', [{ words: [16, 16, 1, 1,
        DXGI_FORMAT.D24_UNORM_S8_UINT, 1, 0, D3D10_USAGE.DEFAULT, D3D10_BIND.DEPTH_STENCIL, 0,
        0] }, 0, 'out']);
    const depthView = make('CreateDepthStencilView', [depthTexture, 0, 'out']);
    /** @param {number} usage @param {number} cpu @param {number} bind */
    const buffer = (usage, cpu, bind)=>make('CreateBuffer', [{ words: [VERTICES * STRIDE, usage,
        bind, cpu, 0] }, 0, 'out']);
    const dynamic = buffer(D3D10_USAGE.DYNAMIC, D3D10_CPU_ACCESS.WRITE, D3D10_BIND.VERTEX_BUFFER);
    const fixed = make('CreateBuffer', [{ words: [VERTICES * STRIDE, D3D10_USAGE.DEFAULT,
        D3D10_BIND.VERTEX_BUFFER, 0, 0] }, { words: [STRUCTS + 0x200, 0, 0] }, 'out']);
    const indices = make('CreateBuffer', [{ words: [256, D3D10_USAGE.DEFAULT,
        D3D10_BIND.INDEX_BUFFER, 0, 0] }, { words: [STRUCTS + 0x200, 0, 0] }, 'out']);
    const constants = make('CreateBuffer', [{ words: [16, D3D10_USAGE.DYNAMIC,
        D3D10_BIND.CONSTANT_BUFFER, D3D10_CPU_ACCESS.WRITE, 0] }, 0, 'out']);
    const vsCode = colouredVertexShader();
    const vs = make('CreateVertexShader', [{ words: words(vsCode) }, vsCode.length, 'out']);
    const pixel = [colouredPixelShader(), constantPixelShader()].map(bytes=>make(
        'CreatePixelShader', [{ words: words(bytes) }, bytes.length, 'out']));
    const layout = make('CreateInputLayout', [{ words: [
        STRINGS, 0, DXGI_FORMAT.R32G32B32A32_FLOAT, 0, 0, 0, 0,
        STRINGS + 9, 0, DXGI_FORMAT.R32G32B32A32_FLOAT, 0, 16, 0, 0,
    ] }, 2, { words: words(vsCode) }, vsCode.length, 'out']);
    // Rasterizer: solid, no culling, depth clip; and none, the device's default.
    const rasterizers = [0, make('CreateRasterizerState', [{ words: [3, 1, 0, 0, 0, 0, 1, 0,
        0, 0] }, 'out'])];
    const depthStates = [0, make('CreateDepthStencilState', [{ words: [0, 1, 2, 0, 0xffff, 0, 0,
        0, 0, 0, 0, 0, 0] }, 'out'])];
    // One target blended ONE, ZERO, ADD; every target's write mask all four channels.
    const blends = [0, make('CreateBlendState', [{ words: [0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1,
        2, 1, 1, 0x0f0f0f0f, 0x0f0f0f0f] }, 'out'])];
    const samplers = [0, make('CreateSamplerState', [{ words: [0x15, 1, 1, 1, 0, 1, 8, 0, 0, 0,
        0, 0, floatWord(1000)] }, 'out'])];
    const vertices = ()=>words(new Uint8Array(Float32Array.from({ length: VERTICES * STRIDE / 4 },
        ()=>pick.float()).buffer));

    const actions = {
        shaders: ()=>{
            device('VSSetShader', [pick.pick([vs, 0])]);
            device('PSSetShader', [pick.pick(pixel)]);
            device('GSSetShader', [0]);
            device('IASetInputLayout', [pick.pick([layout, layout, 0])]);
        },
        streams: ()=>{
            const count = pick.pick([0, 1, 2, 16, 17]);
            device('IASetVertexBuffers', [pick.below(2), count,
                pick.below(12) === 0 ? 0 : { words: Array.from({ length: count },
                    ()=>pick.pick([dynamic, fixed, 0])) },
                { words: Array.from({ length: count }, ()=>STRIDE) },
                { words: Array.from({ length: count }, ()=>STRIDE * pick.below(4)) }]);
            device('IASetVertexBuffers', [0, 1, { words: [pick.pick([dynamic, fixed])] },
                { words: [STRIDE] }, { words: [STRIDE * pick.below(4)] }]);
            device('IASetIndexBuffer', [pick.pick([indices, 0]),
                pick.pick([DXGI_FORMAT.R16_UINT, DXGI_FORMAT.R32_UINT]), 2 * pick.below(8)]);
            device('IASetPrimitiveTopology', [pick.pick([D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST,
                D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP, D3D10_PRIMITIVE_TOPOLOGY.LINELIST])]);
        },
        stages: ()=>{
            for (const stage of ['VS', 'PS', 'GS'])
            {
                const count = pick.pick([0, 1, 2, 17]);
                device(`${stage}SetConstantBuffers`, [pick.below(3), count, count > 0
                    && pick.below(10) === 0 ? 0 : { words: Array.from({ length: count },
                        ()=>pick.pick([constants, 0])) }]);
                device(`${stage}SetSamplers`, [pick.below(3), Math.min(count, 2), { words:
                    Array.from({ length: Math.min(count, 2) }, ()=>pick.pick(samplers)) }]);
                device(`${stage}SetShaderResources`, [pick.below(3), 1, { words: [0] }]);
            }
        },
        states: ()=>{
            device('RSSetState', [pick.pick(rasterizers)]);
            device('OMSetDepthStencilState', [pick.pick(depthStates), pick.below(256)]);
            const factor = pick.below(3) === 0 ? 0 : { words: [0.5, 0.25, 1, 0].map(floatWord) };
            device('OMSetBlendState', [pick.pick(blends), factor, 0xffffffff]);
            const x = pick.below(4);
            const count = pick.pick([1, 1, 2, 17]);
            device('RSSetViewports', [count, { words: Array.from({ length: count }, ()=>[x, x,
                16 - x, 16 - x, floatWord(0), floatWord(1)]).flat() }]);
            device('RSSetScissorRects', [1, { words: [x, x, 16, 16] }]);
            const targets = pick.pick([1, 1, 0, 9]);
            device('OMSetRenderTargets', [targets, { words: [target, ...Array.from(
                { length: Math.max(0, targets - 1) }, ()=>0)] }, pick.pick([0, depthView])]);
        },
        map: ()=>{
            // After a DISCARD what the buffer held is undefined, and the program
            // writes all of it; under NO_OVERWRITE it writes some vertices.
            const type = pick.pick([D3D10_MAP.WRITE_DISCARD, D3D10_MAP.WRITE_NO_OVERWRITE]);
            const answer = call(dynamic, 'buffer', 'Map', [type, 0, 'out']);
            const at = m.readU32(OUT);
            if (answer.eax === 0 && at !== 0)
            {
                const written = vertices();
                m.writeBytes(type === D3D10_MAP.WRITE_DISCARD ? at
                    : at + STRIDE * pick.below(VERTICES - 8), new Uint8Array(
                    new Uint32Array(type === D3D10_MAP.WRITE_DISCARD ? written
                        : written.slice(0, 64)).buffer));
            }
            call(dynamic, 'buffer', 'Unmap');
            call(constants, 'buffer', 'Map', [D3D10_MAP.WRITE_DISCARD, 0, 'out']);
            const cbAt = m.readU32(OUT);
            if (cbAt !== 0)
            {
                m.writeBytes(cbAt, new Uint8Array(Float32Array.from([pick.float(), pick.float(),
                    pick.float(), 1]).buffer));
            }
            call(constants, 'buffer', 'Unmap');
        },
        draw: ()=>{
            const count = 3 * (1 + pick.below(4));
            const start = pick.below(VERTICES - count);
            device('Draw', [count, start]);
            device('DrawIndexed', [count, pick.below(8), pick.below(8)]);
            device('DrawInstanced', [count, 1 + pick.below(2), start, 0]);
            device('DrawIndexedInstanced', [count, 1 + pick.below(2), pick.below(8),
                pick.below(8), 0]);
        },
        clear: ()=>{
            device('ClearRenderTargetView', [target, pick.below(10) === 0 ? 0
                : { words: [pick.float(), pick.float(), pick.float(), 1].map(floatWord) }]);
            device('ClearDepthStencilView', [depthView, 1 + pick.below(3), floatWord(pick.float()),
                pick.below(0x200)]);
        },
        read: ()=>{
            // Getters, which trap: what they answer is what the ring set.
            device('IAGetVertexBuffers', [0, 1, 'out', 'out2', 'out3']);
            device('IAGetIndexBuffer', ['out', 'out2', 'out3']);
            device('PSGetShader', ['out']);
            device('RSGetViewports', [{ words: [1] }, 'out']);
            device('OMGetRenderTargets', [1, 'out', 'out2']);
            device('IAGetPrimitiveTopology', ['out']);
        },
        present: ()=>{
            call('#1', 'chain', 'Present', [0, 0]);
        },
    };
    const names = /** @type {(keyof typeof actions)[]} */ (Object.keys(actions));
    for (let step = 0; step < steps; step++)
    {
        actions[pick.pick(names)]();
    }
    call('#1', 'chain', 'Present', [0, 0]);
    await idle(m.gpu);
    return { answers, reads: m.reads, trapped, trappedBy, carried };
}

for (const seed of [1, 2, 3, 5, 6, 7])
{
    test(`Direct3D 10: the GPU is given what it would be with every call a trap, through the`
        + ` command ring and drawn elsewhere, seed ${seed}`, async()=>{
        const traps = await play(seed, 120, false, false);
        const ring = await play(seed, 120, true, false);
        const elsewhere = await play(seed, 120, true, true);
        assert.ok(traps.reads.some(line=>line.includes('draw')), 'the GPU drew');
        // A call the ring carries that no program makes is a call this gate does not hold.
        assert.deepEqual([...CARRIED].filter(name=>!traps.carried.has(name)), [],
            'every call the ring carries is in the program');
        assert.ok(traps.trapped > 200, 'every call trapped without guest code');
        assert.ok(ring.trapped < traps.trapped / 4, `the ring carried the calls (${ring.trapped}`
            + ` of ${traps.trapped} trapped: ${JSON.stringify([...ring.trappedBy])})`);
        assert.deepEqual(ring.answers, traps.answers, 'every answer, through the ring');
        assert.deepEqual(ring.reads, traps.reads, 'what every draw read, through the ring');
        assert.deepEqual(elsewhere.answers, traps.answers, 'every answer, drawn elsewhere');
        assert.deepEqual(elsewhere.reads, traps.reads, 'what every draw read, drawn elsewhere');
    });
}

test('Direct3D 10: a buffer the guest maps with DISCARD faster than the host plays the ring is'
    + ' given storages until its maps stop trapping', ()=>{
    const m = machine(true, false);
    const made = m.run({ on: '#0', kind: 'device', method: 'CreateBuffer', args: [
        { words: [VERTICES * STRIDE, D3D10_USAGE.DYNAMIC, D3D10_BIND.VERTEX_BUFFER,
            D3D10_CPU_ACCESS.WRITE, 0] }, 0, 'out'] }, true);
    const dynamic = /** @type {string} */ (made.out);
    /** How many of each round's maps trapped. */
    const trapped = [];
    for (let round = 0; round < 12; round++)
    {
        let traps = 0;
        // Eight maps in a frame, then a call of the host's, which plays the ring.
        for (let map = 0; map < 8; map++)
        {
            const answer = m.run({ on: dynamic, kind: 'buffer', method: 'Map',
                args: [D3D10_MAP.WRITE_DISCARD, 0, 'out'] }, false);
            traps += answer.traps.includes('Map') ? 1 : 0;
            m.run({ on: dynamic, kind: 'buffer', method: 'Unmap', args: [] }, false);
        }
        m.run({ on: '#0', kind: 'device', method: 'IAGetPrimitiveTopology', args: ['out'] },
            false);
        trapped.push(traps);
    }
    // A buffer of a storage traps every DISCARD it cannot move off; the host
    // gives it one more each time, and a frame's eight then fit.
    assert.ok(trapped[0] > 0, `the first maps trapped: ${trapped}`);
    assert.deepEqual(trapped.slice(-4), [0, 0, 0, 0], `none trapped in the end: ${trapped}`);
});

/** The routines Direct3D 11's immediate context runs in the guest. */
const CARRIED11 = new Set(Object.values(CONTEXT_RING));

/**
 * A Direct3D 11 program drawn from a seed, through its immediate context:
 * Direct3D 10's calls under 11's interface, with 11's own arguments -- class
 * instances, viewports of floats, maps through the context.
 *
 * @param {number} seed @param {number} steps @param {boolean} guestCode
 * @param {boolean} worker
 */
async function play11(seed, steps, guestCode, worker){
    const m = machine(guestCode, worker, true);
    const pick = random(seed);
    /** @type {string[]} */
    const answers = [];
    let trapped = 0;
    /** @type {Map<string, number>} */
    const trappedBy = new Map();
    /** @type {Set<string>} */
    const carried = new Set();
    /** @param {string} on @param {string} kind @param {string} method @param {Call['args']} args */
    const call = (on, kind, method, args = [])=>{
        const answer = m.run({ on, kind, method, args },
            method.startsWith('Create') || method === 'GetBuffer');
        const routine = kind === 'context' ? /** @type {Record<string, string>} */ (CONTEXT_RING)[
            method] : undefined;
        if (routine)
        {
            carried.add(routine);
            if (answer.traps.includes(method))
            {
                trapped++;
                trappedBy.set(method, (trappedBy.get(method) ?? 0) + 1);
            }
        }
        // Where a map puts the bytes is the device's to choose; its pitches are not.
        answers.push(method === 'Map'
            ? `Map ${answer.eax.toString(16)} ${answer.out !== 0} ${answer.out2} ${answer.out3}`
            : `${method} ${answer.eax.toString(16)} ${answer.out} ${answer.out2} ${answer.out3}`);
        return answer;
    };
    /** @param {string} method @param {Call['args']} args */
    const device = (method, args = [])=>call('#0', 'device11', method, args);
    /** @param {string} method @param {Call['args']} args */
    const context = (method, args = [])=>call('#2', 'context', method, args);
    /** @param {string} method @param {Call['args']} args @returns {string} */
    const make = (method, args)=>{
        const made = device(method, args);
        assert.ok(made.out && made.out !== 'untouched',
            `${method} made something: ${made.eax.toString(16)}`);
        return /** @type {string} */ (made.out);
    };

    const iidTexture2D = [0x6f15aaf2, 0x4e89d208, 0x9548b49a, 0x9c4fd335];
    const back = /** @type {string} */ (call('#1', 'chain', 'GetBuffer', [0,
        { words: iidTexture2D }, 'out']).out);
    const target = make('CreateRenderTargetView', [back, 0, 'out']);
    const depthTexture = make('CreateTexture2D', [{ words: [16, 16, 1, 1,
        DXGI_FORMAT.D24_UNORM_S8_UINT, 1, 0, D3D10_USAGE.DEFAULT, D3D10_BIND.DEPTH_STENCIL, 0,
        0] }, 0, 'out']);
    const depthView = make('CreateDepthStencilView', [depthTexture, 0, 'out']);
    const dynamic = make('CreateBuffer', [{ words: [VERTICES * STRIDE, D3D10_USAGE.DYNAMIC,
        D3D10_BIND.VERTEX_BUFFER, D3D10_CPU_ACCESS.WRITE, 0, 0] }, 0, 'out']);
    const fixed = make('CreateBuffer', [{ words: [VERTICES * STRIDE, D3D10_USAGE.DEFAULT,
        D3D10_BIND.VERTEX_BUFFER, 0, 0, 0] }, { words: [STRUCTS + 0x200, 0, 0] }, 'out']);
    const indices = make('CreateBuffer', [{ words: [256, D3D10_USAGE.DEFAULT,
        D3D10_BIND.INDEX_BUFFER, 0, 0, 0] }, { words: [STRUCTS + 0x200, 0, 0] }, 'out']);
    const constants = make('CreateBuffer', [{ words: [16, D3D10_USAGE.DYNAMIC,
        D3D10_BIND.CONSTANT_BUFFER, D3D10_CPU_ACCESS.WRITE, 0, 0] }, 0, 'out']);
    const vsCode = colouredVertexShader();
    const vs = make('CreateVertexShader', [{ words: words(vsCode) }, vsCode.length, 0, 'out']);
    const pixel = [colouredPixelShader(), constantPixelShader()].map(bytes=>make(
        'CreatePixelShader', [{ words: words(bytes) }, bytes.length, 0, 'out']));
    const layout = make('CreateInputLayout', [{ words: [
        STRINGS, 0, DXGI_FORMAT.R32G32B32A32_FLOAT, 0, 0, 0, 0,
        STRINGS + 9, 0, DXGI_FORMAT.R32G32B32A32_FLOAT, 0, 16, 0, 0,
    ] }, 2, { words: words(vsCode) }, vsCode.length, 'out']);
    const rasterizers = [0, make('CreateRasterizerState', [{ words: [3, 1, 0, 0, 0, 0, 1, 0,
        0, 0] }, 'out'])];
    const depthStates = [0, make('CreateDepthStencilState', [{ words: [0, 1, 2, 0, 0xffff, 0, 0,
        0, 0, 0, 0, 0, 0] }, 'out'])];
    // Direct3D 11's blend description: a target's state each, ONE, ZERO, ADD.
    const blends = [0, make('CreateBlendState', [{ words: [0, 0, ...Array.from({ length: 8 },
        ()=>[0, 2, 1, 1, 2, 1, 1, 0x0f]).flat()] }, 'out'])];
    const samplers = [0, make('CreateSamplerState', [{ words: [0x15, 1, 1, 1, 0, 1, 8, 0, 0, 0,
        0, 0, floatWord(1000)] }, 'out'])];
    const vertices = ()=>words(new Uint8Array(Float32Array.from({ length: VERTICES * STRIDE / 4 },
        ()=>pick.float()).buffer));

    const actions = {
        shaders: ()=>{
            // A class instance named leaves the call to the host.
            const instances = pick.below(8) === 0 ? 1 : 0;
            context('VSSetShader', [pick.pick([vs, 0]), instances ? { words: [0] } : 0, instances]);
            context('PSSetShader', [pick.pick(pixel), 0, 0]);
            context('GSSetShader', [0, 0, 0]);
            context('IASetInputLayout', [pick.pick([layout, layout, 0])]);
        },
        streams: ()=>{
            const count = pick.pick([0, 1, 2, 16, 17]);
            context('IASetVertexBuffers', [pick.below(2), count,
                pick.below(12) === 0 ? 0 : { words: Array.from({ length: count },
                    ()=>pick.pick([dynamic, fixed, 0])) },
                { words: Array.from({ length: count }, ()=>STRIDE) },
                { words: Array.from({ length: count }, ()=>STRIDE * pick.below(4)) }]);
            context('IASetVertexBuffers', [0, 1, { words: [pick.pick([dynamic, fixed])] },
                { words: [STRIDE] }, { words: [STRIDE * pick.below(4)] }]);
            context('IASetIndexBuffer', [pick.pick([indices, 0]),
                pick.pick([DXGI_FORMAT.R16_UINT, DXGI_FORMAT.R32_UINT]), 2 * pick.below(8)]);
            context('IASetPrimitiveTopology', [pick.pick([D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST,
                D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP, D3D10_PRIMITIVE_TOPOLOGY.LINELIST])]);
        },
        stages: ()=>{
            for (const stage of ['VS', 'PS', 'GS'])
            {
                const count = pick.pick([0, 1, 2, 17]);
                context(`${stage}SetConstantBuffers`, [pick.below(3), count, count > 0
                    && pick.below(10) === 0 ? 0 : { words: Array.from({ length: count },
                        ()=>pick.pick([constants, 0])) }]);
                context(`${stage}SetSamplers`, [pick.below(3), Math.min(count, 2), { words:
                    Array.from({ length: Math.min(count, 2) }, ()=>pick.pick(samplers)) }]);
                context(`${stage}SetShaderResources`, [pick.below(3), 1, { words: [0] }]);
            }
        },
        states: ()=>{
            context('RSSetState', [pick.pick(rasterizers)]);
            context('OMSetDepthStencilState', [pick.pick(depthStates), pick.below(256)]);
            const factor = pick.below(3) === 0 ? 0 : { words: [0.5, 0.25, 1, 0].map(floatWord) };
            context('OMSetBlendState', [pick.pick(blends), factor, 0xffffffff]);
            // Viewports of floats, a half pixel in.
            const x = pick.below(4) + 0.5;
            const count = pick.pick([1, 1, 2, 17]);
            context('RSSetViewports', [count, { words: Array.from({ length: count }, ()=>[x, x,
                16 - x, 16 - x, 0, 1].map(floatWord)).flat() }]);
            context('RSSetScissorRects', [1, { words: [1, 1, 16, 16] }]);
            const targets = pick.pick([1, 1, 0, 9]);
            context('OMSetRenderTargets', [targets, { words: [target, ...Array.from(
                { length: Math.max(0, targets - 1) }, ()=>0)] }, pick.pick([0, depthView])]);
        },
        map: ()=>{
            const type = pick.pick([D3D10_MAP.WRITE_DISCARD, D3D10_MAP.WRITE_NO_OVERWRITE]);
            const answer = context('Map', [dynamic, 0, type, 0, 'out']);
            const at = m.readU32(OUT);
            if (answer.eax === 0 && at !== 0)
            {
                const written = vertices();
                m.writeBytes(type === D3D10_MAP.WRITE_DISCARD ? at
                    : at + STRIDE * pick.below(VERTICES - 8), new Uint8Array(
                    new Uint32Array(type === D3D10_MAP.WRITE_DISCARD ? written
                        : written.slice(0, 64)).buffer));
            }
            context('Unmap', [dynamic, 0]);
            context('Map', [constants, 0, D3D10_MAP.WRITE_DISCARD, 0, 'out']);
            const cbAt = m.readU32(OUT);
            if (cbAt !== 0)
            {
                m.writeBytes(cbAt, new Uint8Array(Float32Array.from([pick.float(), pick.float(),
                    pick.float(), 1]).buffer));
            }
            context('Unmap', [constants, 0]);
        },
        draw: ()=>{
            const count = 3 * (1 + pick.below(4));
            const start = pick.below(VERTICES - count);
            context('Draw', [count, start]);
            context('DrawIndexed', [count, pick.below(8), pick.below(8)]);
            context('DrawInstanced', [count, 1 + pick.below(2), start, 0]);
            context('DrawIndexedInstanced', [count, 1 + pick.below(2), pick.below(8),
                pick.below(8), 0]);
        },
        clear: ()=>{
            context('ClearRenderTargetView', [target, { words: [pick.float(), pick.float(),
                pick.float(), 1].map(floatWord) }]);
            context('ClearDepthStencilView', [depthView, 1 + pick.below(3),
                floatWord(pick.float()), pick.below(0x200)]);
        },
        read: ()=>{
            context('IAGetVertexBuffers', [0, 1, 'out', 'out2', 'out3']);
            context('IAGetIndexBuffer', ['out', 'out2', 'out3']);
            context('PSGetShader', ['out', 0, 0]);
            context('RSGetViewports', [{ words: [1] }, 'out']);
            context('OMGetRenderTargets', [1, 'out', 'out2']);
            context('IAGetPrimitiveTopology', ['out']);
        },
        present: ()=>{
            call('#1', 'chain', 'Present', [0, 0]);
        },
    };
    const names = /** @type {(keyof typeof actions)[]} */ (Object.keys(actions));
    for (let step = 0; step < steps; step++)
    {
        actions[pick.pick(names)]();
    }
    call('#1', 'chain', 'Present', [0, 0]);
    await idle(m.gpu);
    return { answers, reads: m.reads, trapped, trappedBy, carried };
}

for (const seed of [1, 2, 3, 5])
{
    test(`Direct3D 11: the GPU is given what it would be with every call of the immediate`
        + ` context a trap, through the device's command ring and drawn elsewhere, seed ${seed}`,
    async()=>{
        const traps = await play11(seed, 120, false, false);
        const ring = await play11(seed, 120, true, false);
        const elsewhere = await play11(seed, 120, true, true);
        assert.ok(traps.reads.some(line=>line.includes('draw')), 'the GPU drew');
        assert.deepEqual([...CARRIED11].filter(name=>!traps.carried.has(name)), [],
            'every call the ring carries is in the program');
        assert.ok(traps.trapped > 200, 'every call trapped without guest code');
        assert.ok(ring.trapped < traps.trapped / 4, `the ring carried the calls (${ring.trapped}`
            + ` of ${traps.trapped} trapped: ${JSON.stringify([...ring.trappedBy])})`);
        assert.deepEqual(ring.answers, traps.answers, 'every answer, through the ring');
        assert.deepEqual(ring.reads, traps.reads, 'what every draw read, through the ring');
        assert.deepEqual(elsewhere.answers, traps.answers, 'every answer, drawn elsewhere');
        assert.deepEqual(elsewhere.reads, traps.reads, 'what every draw read, drawn elsewhere');
    });
}
