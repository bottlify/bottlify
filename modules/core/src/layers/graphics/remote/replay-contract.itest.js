/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The replay's contract, as a gate: a program's calls made on a Direct3D 8 or
 * 9 device that draws itself, and the same calls made on the recording device
 * whose twin draws in the graphics worker, must ask the same of the GPU, with
 * the same bytes, and answer the program the same. Each scenario below runs
 * once on a device of its own and once through each way the recording reaches
 * its twin -- played at each call, held in batches the twin plays only when the
 * program waits on it, across a real port -- with the bytes an unlock let the
 * program write copied into the batch and lent in place. What is compared:
 *
 * - every call's answer, awaited, and what it wrote into the structures it was
 *   given, the device's objects by the order they were first seen;
 * - the guest's memory, wherever a scenario looks: what a lock or a read-back
 *   let the program see;
 * - every call the renderer made on the GPU between two looks, as the fake
 *   GPU device records them: buffer and texture writes with their bytes, the
 *   pipelines, bind groups and draws.
 *
 * A scenario that writes through a pointer a lock handed out after its unlock
 * is outside the contract a program is given, but some programs do it; the
 * device that draws itself reads such bytes at the draw, and the cases that
 * do are marked as such.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { playedAtOnce, playedDirect3D, recordedDirect3D } from './direct3d.js';
import { createReceiver, createSender } from './channel.js';
import { createBorrower, createLendingBuffers } from './lending.js';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3DUSAGE, D3D_OK } from '../d3d9/constants.js';
import {
    D3DCLEAR, D3DFMT_INDEX, D3DLOCK, D3DPT, D3DRS, D3DTS, D3DTSS,
} from '../d3d8/constants.js';
import { D3DISSUE, D3DQUERYTYPE, createDirect3D9 } from '../d3d9/device.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from '../d3d9/declaration.js';
import { END_TOKEN, OPCODE, REGISTER, SHADER_KIND, versionToken } from '../d3d9/shader.js';
import { commandSlot } from '../d3d9/commands.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

const RAM_BASE = 0x40000000;
const RAM_SIZE = 16 << 20;

/** D3DGETDATA_FLUSH. */
const GETDATA_FLUSH = 1;
/** D3DSBT_ALL. */
const SBT_ALL = 1;
/** D3DTEXF_POINT. */
const TEXF_POINT = 1;
/** D3DTEXF_LINEAR. */
const TEXF_LINEAR = 2;
/** D3DCUBEMAP_FACE_NEGATIVE_X. */
const FACE_NEGATIVE_X = 1;

/**
 * The ways a recording reaches its twin.
 *
 * - `at once`: each call played as it is made (`playedAtOnce`);
 * - `held`: batches a sender posts, played only when the program waits on an
 *   answer or a scenario looks -- as late as the twin may play them;
 * - `port`: batches across a MessageChannel, as they cross to the worker;
 * - `lent`: either of the last two with the bytes an unlock let the program
 *   write lent in place out of shared guest memory (`lending.js`).
 */
const WAYS = /** @type {const} */ (['at once', 'held', 'held, lent', 'port', 'port, lent']);

/** Turns of the event loop, for what crosses ports and settles in promises. */
const turns = async(count = 8)=>{
    for (let turn = 0; turn < count; turn++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
};

/**
 * A guest memory: one block of RAM, shared where a lending needs it, with
 * allocations handed out from its start the same way on every run.
 *
 * @param {boolean} shared
 */
function guestMemory(shared){
    const ram = new Uint8Array(shared ? new SharedArrayBuffer(RAM_SIZE)
        : new ArrayBuffer(RAM_SIZE));
    let next = RAM_BASE + 0x10000;
    return {
        ram,
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += ((Math.max(bytes, 1) + 0xff) & ~0xff) + 0x100;
            return at;
        },
        free: (/** @type {number} */ address)=>{
            void address;
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        /** @param {number} address @param {number} length */
        windowMemory: (address, length)=>
            ram.subarray(address - RAM_BASE, address - RAM_BASE + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>ram.set(bytes, address - RAM_BASE),
    };
}

/** @param {any} gpu */
const backendOf = gpu=>createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
    now: ()=>0 });

/** @param {any} descriptor */
const createSampler = descriptor=>({ kind: 'sampler', id: `sampler-${JSON.stringify(descriptor)}`,
    descriptor });

/**
 * A root of one version, made the way the graphics layer makes it, on its own
 * or as a recording whose twin plays as `way` says.
 *
 * @param {8 | 9} version @param {string} way  'direct' or one of `WAYS`
 * @param {object} [caps]  what the root is made with besides its services
 */
function rig(version, way, caps = {}){
    const factory = version === 9 ? createDirect3D9 : createDirect3D8;
    const lend = way.endsWith('lent');
    const memory = guestMemory(lend);
    const gpu = createFakeDevice({ occlusionSamples: index=>17 + index });
    const services = {
        ...caps,
        readMemory: memory.readMemory,
        // Direct3D 9's root is given no window; its copies read through readMemory.
        ...(version === 8 ? { windowMemory: memory.windowMemory } : {}),
        writeMemory: memory.writeMemory,
        allocate: memory.allocate,
        free: memory.free,
    };
    /** Sends what was recorded and has the twin play it, as far as the way allows. */
    let settle = async()=>{};
    /** Plays what is held, for an answer the program waits on. */
    let release = ()=>{};
    let close = ()=>{};
    /** @type {any} */
    let d3d;
    if (way === 'direct')
    {
        d3d = factory({ ...services, backend: backendOf(gpu), createSampler });
    }
    else
    {
        const buffers = lend ? createLendingBuffers() : null;
        /**
         * What the twin writes outside a call -- pixels read back -- reaches
         * the guest as the worker sends it: in place where memory is shared.
         *
         * @type {(message: any) => void}
         */
        let toSender = ()=>{};
        const played = playedDirect3D(factory, {
            ...caps,
            backend: backendOf(gpu),
            createSampler,
            readMemory: true,
            borrow: buffers ? createBorrower({ ...buffers, memory: memory.ram, base: RAM_BASE })
                : undefined,
            writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
                if (lend)
                {
                    memory.writeMemory(address, bytes);
                    toSender({ type: 'wrote', writes: [{ address, length: bytes.length }] });
                    return;
                }
                toSender({ type: 'wrote', writes: [{ address, bytes: bytes.slice() }] });
            },
        });
        if (way === 'at once')
        {
            toSender = message=>{
                for (const { address, bytes } of message.writes ?? [])
                {
                    if (bytes)
                    {
                        memory.writeMemory(address, bytes);
                    }
                }
            };
            d3d = recordedDirect3D(factory, services, playedAtOnce(played));
        }
        else if (way.startsWith('held'))
        {
            /** @type {any[]} */
            const held = [];
            const sender = createSender({
                post: message=>held.push(message),
                later: ()=>{},
                now: ()=>0,
                on: { wrote: memory.writeMemory, adopted: ()=>{} },
                lending: buffers && { ...buffers, memory: memory.ram, base: RAM_BASE },
            });
            const receiver = createReceiver({ played, post: message=>sender.receive(message) });
            toSender = message=>sender.receive(message);
            release = ()=>{
                sender.flush();
                while (held.length > 0)
                {
                    receiver.receive(held.shift());
                }
            };
            settle = async()=>{
                for (let round = 0; round < 4; round++)
                {
                    release();
                    await turns(2);
                }
            };
            d3d = recordedDirect3D(factory, services, sender);
        }
        else
        {
            const { port1, port2 } = new MessageChannel();
            const sender = createSender({
                post: (message, transfer)=>port1.postMessage(message, transfer),
                now: ()=>0,
                on: { wrote: memory.writeMemory, adopted: ()=>{} },
                lending: buffers && { ...buffers, memory: memory.ram, base: RAM_BASE },
            });
            const receiver = createReceiver({ played,
                post: (message, transfer)=>port2.postMessage(message, transfer ?? []) });
            toSender = message=>port2.postMessage(message);
            port2.onmessage = event=>receiver.receive(event.data);
            port1.onmessage = event=>sender.receive(event.data);
            settle = async()=>{
                sender.flush();
                await turns(12);
            };
            close = ()=>{
                port1.close();
                port2.close();
            };
            d3d = recordedDirect3D(factory, services, sender);
        }
    }
    return { version, way, d3d, gpu, memory, settle, release, close };
}

/**
 * A program's shaders and declaration are numbered from counters of the
 * module, which every device in this process shares: the numbers in the names
 * of what is built from them say only how many were made before.
 */
const SHADER_NUMBERS = /^(programmable|vs|ps):\d+\/\d+\/\d+/;

/**
 * What the GPU was asked, as text: an object the double made by its id, bytes
 * by their exact bits.
 *
 * @param {any} value @param {number} depth @returns {any}
 */
function plain(value, depth = 0){
    if (value === null || typeof value !== 'object')
    {
        return typeof value === 'function' ? undefined : value;
    }
    if (ArrayBuffer.isView(value))
    {
        return createHash('sha1').update(new Uint8Array(value.buffer, value.byteOffset,
            value.byteLength)).digest('hex').slice(0, 16) + `/${value.byteLength}`;
    }
    if (typeof value.id === 'string' && typeof value.kind === 'string' && depth > 0)
    {
        return value.id;
    }
    if (depth > 6)
    {
        return '...';
    }
    if (Array.isArray(value))
    {
        return value.map(item=>plain(item, depth + 1));
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(value).sort())
    {
        if (typeof value[key] !== 'function')
        {
            out[key] = key === 'label' && typeof value[key] === 'string'
                ? value[key].replace(SHADER_NUMBERS, '$1:#/#/#')
                : plain(value[key], depth + 1);
        }
    }
    return out;
}

/**
 * The objects the GPU is asked to make, and the field of a call that holds
 * the one it made. What they are made of is compared, not when: a pipeline
 * and its shader are built in promises, which settle between the program's
 * calls when the device draws itself and after a batch when a twin plays it.
 */
const MADE = /** @type {Record<string, string>} */ ({
    createTexture: 'texture', createView: 'view', createShaderModule: 'module',
    getCompilationInfo: 'module', createBuffer: 'createBuffer',
    createBindGroupLayout: 'createBindGroupLayout', createPipelineLayout: 'createPipelineLayout',
    createBindGroup: 'createBindGroup', createRenderPipeline: 'createRenderPipeline',
    createQuerySet: 'createQuerySet',
});

/**
 * What the GPU was asked between two looks, with every object named by what
 * it was made of -- the objects made, in no order, and every other call in
 * the order it was made -- so two runs that asked the same name it the same.
 *
 * @param {any[]} calls
 * @returns {{ made: string[], stream: string[] }}
 */
function asked(calls){
    /** @type {Map<string, string>} */
    const names = new Map();
    /** @type {Map<string, number>} */
    const counts = new Map();
    /** @param {any} value @returns {any} */
    const rename = value=>{
        if (typeof value === 'string')
        {
            const known = names.get(value);
            if (known)
            {
                return known;
            }
            const kind = /^([A-Za-z]+)-\d+$/.exec(value);
            if (kind)
            {
                const n = counts.get(kind[1]) ?? 0;
                counts.set(kind[1], n + 1);
                const name = `${kind[1]}@${n}`;
                names.set(value, name);
                return name;
            }
            return value;
        }
        if (value === null || typeof value !== 'object')
        {
            return value;
        }
        if (Array.isArray(value))
        {
            return value.map(rename);
        }
        /** @type {Record<string, any>} */
        const out = {};
        for (const key of Object.keys(value))
        {
            out[key] = rename(value[key]);
        }
        return out;
    };
    /** @type {string[]} */
    const made = [];
    /** @type {string[]} */
    const stream = [];
    for (const call of calls)
    {
        const flat = plain(call);
        const field = MADE[call.op];
        if (field && call.op !== 'getCompilationInfo')
        {
            const id = flat[field];
            const rest = { ...flat };
            delete rest[field];
            const content = JSON.stringify(rename(rest));
            const kind = `${call.op}:${createHash('sha1').update(content).digest('hex')
                .slice(0, 12)}`;
            const n = counts.get(kind) ?? 0;
            counts.set(kind, n + 1);
            names.set(id, `${kind}#${n}`);
            made.push(`${kind}#${n} ${content}`);
            continue;
        }
        const line = JSON.stringify(rename(flat));
        (field ? made : stream).push(line);
    }
    return { made: made.sort(), stream };
}

/**
 * One run of a scenario: the program's side of it, written down as it goes.
 *
 * @param {ReturnType<typeof rig>} on
 */
function runner(on){
    /** What the program saw, a line a call or a look. @type {string[]} */
    const seen = [];
    /** What the GPU was asked before each look. @type {{ label: string, made: string[], stream: string[] }[]} */
    const looks = [];
    /** @type {WeakMap<object, string>} */
    const names = new WeakMap();
    let named = 0;
    /**
     * A value as the program reads it: the device's objects by the order they
     * were first seen in, numbers and bytes as they are.
     *
     * @param {any} value @param {number} depth @returns {any}
     */
    const shown = (value, depth = 0)=>{
        if (value === null || typeof value !== 'object')
        {
            return typeof value === 'function' ? undefined : value;
        }
        if (ArrayBuffer.isView(value))
        {
            return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].join(',');
        }
        if (Object.values(value).some(member=>typeof member === 'function')
            || typeof value.QueryInterface === 'function' || typeof value.addRef === 'function')
        {
            let name = names.get(value);
            if (!name)
            {
                name = `#${named++}`;
                names.set(value, name);
            }
            return name;
        }
        if (depth > 4)
        {
            return '...';
        }
        if (Array.isArray(value))
        {
            return value.map(one=>shown(one, depth + 1));
        }
        /** @type {Record<string, any>} */
        const out = {};
        for (const key of Object.keys(value).sort())
        {
            out[key] = shown(value[key], depth + 1);
        }
        return out;
    };
    return {
        on,
        seen,
        looks,
        /**
         * A call, made and answered: what the answer is once settled, and what
         * it wrote into the structures it was given.
         *
         * @param {string} label @param {() => any} make @param {any[]} [outs]
         */
        async call(label, make, outs = []){
            let answer = make();
            if (answer instanceof Promise)
            {
                on.release();
                answer = await answer;
            }
            seen.push(`${label} -> ${JSON.stringify(shown(answer))}`
                + (outs.length > 0 ? ` ${JSON.stringify(shown(outs))}` : ''));
            return answer;
        },
        /**
         * The guest's bytes in a range, as the program would read them now.
         *
         * @param {string} label @param {number} address @param {number} length
         */
        bytes(label, address, length){
            const bytes = on.memory.readMemory(address, length);
            seen.push(`${label} @${(address >>> 0).toString(16)} = ${createHash('sha1')
                .update(bytes).digest('hex').slice(0, 16)}`);
            return bytes;
        },
        /**
         * Everything recorded played, and what the GPU was asked since the last
         * look taken; and the whole of guest memory.
         *
         * @param {string} label
         */
        async look(label){
            await on.settle();
            looks.push({ label, ...asked(on.gpu.calls) });
            on.gpu.reset();
            seen.push(`${label}: memory ${createHash('sha1').update(on.memory.ram).digest('hex')}`);
        },
    };
}

/**
 * Where two runs part: the first line each wrote differently, with a line of
 * context before it.
 *
 * @param {string[]} direct @param {string[]} played @param {string} what
 * @returns {string | null}
 */
function parting(direct, played, what){
    const length = Math.max(direct.length, played.length);
    for (let index = 0; index < length; index++)
    {
        if (direct[index] !== played[index])
        {
            const cut = (/** @type {string | undefined} */ line)=>(line === undefined
                ? '(nothing)' : line.length > 600 ? `${line.slice(0, 600)}...` : line);
            return `${what} parts at line ${index}`
                + (index > 0 ? `\n    after:  ${cut(direct[index - 1])}` : '')
                + `\n    direct: ${cut(direct[index])}\n    played: ${cut(played[index])}`;
        }
    }
    return null;
}

/**
 * Runs a scenario on a device that draws itself and through every way, and
 * says each way it parts from the first.
 *
 * @param {8 | 9} version
 * @param {(run: ReturnType<typeof runner>) => Promise<void>} scenario
 * @param {readonly string[]} [ways]
 * @param {object} [caps]
 * @returns {Promise<string[]>}
 */
async function divergences(version, scenario, ways = WAYS, caps = {}){
    const direct = runner(rig(version, 'direct', caps));
    await scenario(direct);
    /** @type {string[]} */
    const found = [];
    // A frame the GPU refused draws nothing, whichever side it is on, and
    // the two sides would agree on what they asked of it all the same.
    /** @param {string} side @param {any} on */
    const refused = (side, on)=>{
        if (on.gpu.errors.length > 0)
        {
            found.push(`[${side}] the GPU refused: ${on.gpu.errors[0]}`);
        }
    };
    refused('direct', direct.on);
    for (const way of ways)
    {
        const played = runner(rig(version, way, caps));
        try
        {
            await scenario(played);
        }
        finally
        {
            played.on.close();
        }
        refused(way, played.on);
        const answers = parting(direct.seen, played.seen, 'what the program saw');
        if (answers)
        {
            found.push(`[${way}] ${answers}`);
        }
        const count = Math.max(direct.looks.length, played.looks.length);
        for (let look = 0; look < count; look++)
        {
            const one = direct.looks[look] ?? { label: '?', made: [], stream: [] };
            const other = played.looks[look] ?? { label: '?', made: [], stream: [] };
            const gpu = parting(one.made, other.made, `the objects the GPU made (${one.label})`)
                ?? parting(one.stream, other.stream, `what the GPU was asked (${one.label})`);
            if (gpu)
            {
                found.push(`[${way}] ${gpu}`);
                break;
            }
        }
    }
    return found;
}

/**
 * Asserts a scenario parts nowhere, every divergence in the message.
 *
 * @param {8 | 9} version
 * @param {(run: ReturnType<typeof runner>) => Promise<void>} scenario
 * @param {readonly string[]} [ways]
 * @param {object} [caps]
 */
async function same(version, scenario, ways, caps){
    const found = await divergences(version, scenario, ways, caps);
    assert.deepEqual(found, [], `\n${found.join('\n')}`);
}

// --- the program's side: helpers a scenario writes its calls with ---

const STRIDE = 24;
const FVF_LIT = FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);
const FVF_RHW = FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);
const STRIDE_RHW = 28;

/**
 * Four corners of a quad, a vertex of `FVF_LIT` each, written at an address.
 *
 * @param {ReturnType<typeof runner>} run @param {number} address @param {number} seed
 * @param {number} [count]
 */
function writeVertices(run, address, seed, count = 4){
    const view = new DataView(run.on.memory.ram.buffer, address - RAM_BASE, count * STRIDE);
    for (let corner = 0; corner < count; corner++)
    {
        view.setFloat32(corner * STRIDE, (corner & 1 ? 1 : -1) * (1 - seed / 64), true);
        view.setFloat32(corner * STRIDE + 4, (corner & 2 ? 1 : -1) * (1 - seed / 128), true);
        view.setFloat32(corner * STRIDE + 8, 0.25 + (corner % 4) / 16, true);
        view.setUint32(corner * STRIDE + 12, (0xff102030 + seed * 0x010203 + corner) >>> 0, true);
        view.setFloat32(corner * STRIDE + 16, corner & 1, true);
        view.setFloat32(corner * STRIDE + 20, corner >> 1 & 1, true);
    }
}

/**
 * A quad of `FVF_RHW` vertices covering `width` by `height` target pixels, as
 * a draw from user memory takes it.
 *
 * @param {number} width @param {number} height @param {number} colour
 */
function screenQuad(width, height, colour){
    const out = new Uint8Array(STRIDE_RHW * 4);
    const view = new DataView(out.buffer);
    [[0, 0], [width, 0], [0, height], [width, height]].forEach(([x, y], corner)=>{
        view.setFloat32(corner * STRIDE_RHW, x, true);
        view.setFloat32(corner * STRIDE_RHW + 4, y, true);
        view.setFloat32(corner * STRIDE_RHW + 8, 0.5, true);
        view.setFloat32(corner * STRIDE_RHW + 12, 1, true);
        view.setUint32(corner * STRIDE_RHW + 16, colour >>> 0, true);
        view.setFloat32(corner * STRIDE_RHW + 20, x > 0 ? 1 : 0, true);
        view.setFloat32(corner * STRIDE_RHW + 24, y > 0 ? 1 : 0, true);
    });
    return out;
}

/**
 * Fills a locked rectangle's rows: `rows` rows of `rowBytes` at `pitch`.
 *
 * @param {ReturnType<typeof runner>} run @param {number} address @param {number} pitch
 * @param {number} rows @param {number} rowBytes @param {number} seed
 */
function fillRows(run, address, pitch, rows, rowBytes, seed){
    for (let row = 0; row < rows; row++)
    {
        const at = address - RAM_BASE + row * pitch;
        for (let index = 0; index < rowBytes; index++)
        {
            run.on.memory.ram[at + index] = (seed * 31 + row * 7 + index) & 0xff;
        }
    }
}

/** @param {number} value */
const identity = value=>{
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    matrix[12] = value;
    return matrix;
};

/**
 * What a caller makes of the copies a Direct3D 8 call describes: the bytes
 * moved in guest memory, as the seam moves them.
 *
 * @param {ReturnType<typeof runner>} run @param {{ moves?: any[] }} held
 */
function applyMoves(run, held){
    for (const move of held.moves ?? [])
    {
        for (let row = 0; row < move.rows; row++)
        {
            run.on.memory.writeMemory(move.to + row * move.toPitch,
                run.on.memory.readMemory(move.from + row * move.fromPitch, move.rowBytes));
        }
    }
}

const PARAMETERS = {
    swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 32,
    backBufferHeight: 32, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
    autoDepthStencilFormat: D3DFMT.D24S8,
};

/**
 * A Direct3D 9 device, with a static vertex and index buffer of one quad.
 *
 * @param {ReturnType<typeof runner>} run @param {object} [parameters]
 */
async function device9(run, parameters = {}){
    /** @type {{ device?: any }} */
    const out = {};
    await run.call('CreateDevice', ()=>run.on.d3d.CreateDevice({ ...PARAMETERS, ...parameters },
        out), [out]);
    const device = out.device;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    await run.call('CreateVertexBuffer', ()=>device.CreateVertexBuffer(4 * STRIDE, 0, FVF_LIT,
        D3DPOOL.MANAGED, vertices), [vertices]);
    await run.call('CreateIndexBuffer', ()=>device.CreateIndexBuffer(12, 0, D3DFMT_INDEX.INDEX16,
        D3DPOOL.MANAGED, indices), [indices]);
    /** @type {{ pBits?: number }} */
    const locked = {};
    await run.call('Lock vertices', ()=>vertices.buffer.Lock(0, 0, locked, 0), [locked]);
    writeVertices(run, /** @type {number} */ (locked.pBits), 1);
    await run.call('Unlock vertices', ()=>vertices.buffer.Unlock());
    await run.call('Lock indices', ()=>indices.buffer.Lock(0, 0, locked, 0), [locked]);
    new Uint16Array(run.on.memory.ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE, 6)
        .set([0, 1, 2, 2, 1, 3]);
    await run.call('Unlock indices', ()=>indices.buffer.Unlock());
    return { device, vertices: vertices.buffer, indices: indices.buffer };
}

/**
 * A texture of one version, its levels filled through their locks.
 *
 * @param {ReturnType<typeof runner>} run @param {any} device @param {string} label
 * @param {{ size?: number, levels?: number, usage?: number, pool?: number, seed?: number,
 *     format?: number }} [options]
 */
async function makeTexture(run, device, label, options = {}){
    const { size = 8, levels = 2, usage = 0, pool = D3DPOOL.MANAGED, seed = 1,
        format = D3DFMT.A8R8G8B8 } = options;
    /** @type {{ texture?: any }} */
    const made = {};
    await run.call(`CreateTexture ${label}`, ()=>device.CreateTexture(size, size, levels, usage,
        format, pool, made), [made]);
    for (let level = 0; level < levels; level++)
    {
        await fillLevel(run, made.texture, `${label}[${level}]`, level, seed + level, { size });
    }
    return made.texture;
}

/**
 * One level of a texture written through a lock of all of it, or of a
 * rectangle of it.
 *
 * @param {ReturnType<typeof runner>} run @param {any} texture @param {string} label
 * @param {number} level @param {number} seed
 * @param {{ rect?: { left: number, top: number, right: number, bottom: number } | null,
 *     flags?: number, size?: number }} [options]  `size` is the top level's
 */
async function fillLevel(run, texture, label, level, seed, options = {}){
    const { rect = null, flags = 0, size = 8 } = options;
    /** @type {{ pBits?: number, Pitch?: number }} */
    const rectOut = {};
    const hr = await run.call(`LockRect ${label}`, ()=>texture.LockRect(level, rectOut, rect,
        flags), [rectOut]);
    if (hr !== D3D_OK)
    {
        return rectOut;
    }
    const width = rect ? rect.right - rect.left : Math.max(1, size >> level);
    const height = rect ? rect.bottom - rect.top : Math.max(1, size >> level);
    fillRows(run, /** @type {number} */ (rectOut.pBits), /** @type {number} */ (rectOut.Pitch),
        height, width * 4, seed);
    await run.call(`UnlockRect ${label}`, ()=>texture.UnlockRect(level));
    return rectOut;
}

/**
 * One textured, lit-off draw of the static quad.
 *
 * @param {ReturnType<typeof runner>} run @param {any} device @param {string} label
 * @param {any} texture @param {number} shift
 */
async function drawQuad9(run, device, label, texture, shift){
    await run.call(`SetTexture ${label}`, ()=>device.SetTexture(0, texture));
    await run.call(`SetTransform ${label}`, ()=>device.SetTransform(D3DTS.WORLD, identity(shift)));
    await run.call(`DrawIndexedPrimitive ${label}`, ()=>device.DrawIndexedPrimitive(
        D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
}

// --- Direct3D 9 ---

test('Direct3D 9: buffers locked plain, with DISCARD and with NOOVERWRITE, drawn between'
    + ' the locks, play what the device drew itself', async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        /** @type {{ buffer?: any }} */
        const dynamic = {};
        await run.call('CreateVertexBuffer dynamic', ()=>device.CreateVertexBuffer(64 * STRIDE,
            D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_LIT, D3DPOOL.DEFAULT, dynamic), [dynamic]);
        /** @type {{ buffer?: any }} */
        const dynamicIndices = {};
        await run.call('CreateIndexBuffer dynamic', ()=>device.CreateIndexBuffer(256,
            D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT,
            dynamicIndices), [dynamicIndices]);
        const tex = await makeTexture(run, device, 'tex');
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        for (let frame = 0; frame < 3; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff000010 + frame, 1, 0));
            await run.call('SetStreamSource static', ()=>device.SetStreamSource(0, vertices, 0,
                STRIDE));
            await drawQuad9(run, device, `static ${frame}`, tex, frame / 8);
            // Two user clip planes, moving from frame to frame: the planes
            // reach the block a draw carries, wherever the device draws.
            await run.call('SetClipPlane 0', ()=>device.SetClipPlane(0, [1, 0, 0, frame / 4]));
            await run.call('SetClipPlane 4', ()=>device.SetClipPlane(4, [0, -1, 0.5, 1]));
            await run.call('SetRenderState CLIPPLANEENABLE', ()=>device.SetRenderState(
                D3DRS.CLIPPLANEENABLE, 0b10001));
            await drawQuad9(run, device, `clipped ${frame}`, tex, frame / 8);
            await run.call('SetRenderState CLIPPLANEENABLE off', ()=>device.SetRenderState(
                D3DRS.CLIPPLANEENABLE, 0));
            // Part of a vertex in: the whole vertices go into the first, and
            // the buffer is bound at the rest.
            await run.call('SetStreamSource part of a vertex in', ()=>device.SetStreamSource(0,
                vertices, STRIDE + 8, STRIDE));
            assert.equal(await run.call(`DrawIndexedPrimitive part of a vertex in ${frame}`,
                ()=>device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 2, 0, 1)), D3D_OK);
            await run.call('SetStreamSource static again', ()=>device.SetStreamSource(0, vertices,
                0, STRIDE));
            // A frame's worth of quads into one dynamic buffer: the first with
            // DISCARD, the rest after it with NOOVERWRITE, and one with neither.
            await run.call('SetStreamSource dynamic', ()=>device.SetStreamSource(0,
                dynamic.buffer, 0, STRIDE));
            for (let quad = 0; quad < 4; quad++)
            {
                const flags = quad === 0 ? D3DLOCK.DISCARD : quad === 3 ? 0 : D3DLOCK.NOOVERWRITE;
                /** @type {{ pBits?: number }} */
                const locked = {};
                await run.call(`Lock dynamic ${frame}/${quad}`, ()=>dynamic.buffer.Lock(
                    quad * 4 * STRIDE, 4 * STRIDE, locked, flags), [locked]);
                writeVertices(run, /** @type {number} */ (locked.pBits), 8 * frame + quad + 2);
                await run.call(`Unlock dynamic ${frame}/${quad}`, ()=>dynamic.buffer.Unlock());
                await run.call(`DrawIndexedPrimitive dynamic ${frame}/${quad}`,
                    ()=>device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, quad * 4, 0, 4, 0, 2));
            }
            // Indices of their own, DISCARD then NOOVERWRITE, a strip read at the draw.
            await run.call('SetIndices dynamic', ()=>device.SetIndices(dynamicIndices.buffer));
            for (let part = 0; part < 2; part++)
            {
                /** @type {{ pBits?: number }} */
                const locked = {};
                await run.call(`Lock indices ${frame}/${part}`, ()=>dynamicIndices.buffer.Lock(
                    part * 16, 16, locked, part === 0 ? D3DLOCK.DISCARD : D3DLOCK.NOOVERWRITE),
                [locked]);
                new Uint16Array(run.on.memory.ram.buffer,
                    /** @type {number} */ (locked.pBits) - RAM_BASE, 4).set(part === 0
                    ? [0, 1, 2, 3] : [3, 2, 1, 0]);
                await run.call(`Unlock indices ${frame}/${part}`, ()=>dynamicIndices.buffer
                    .Unlock());
                await run.call(`DrawIndexedPrimitive strip ${frame}/${part}`,
                    ()=>device.DrawIndexedPrimitive(D3DPT.TRIANGLESTRIP, 0, 0, 4, part * 8, 2));
            }
            await run.call('SetIndices static', ()=>device.SetIndices(indices));
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('Present', ()=>device.Present());
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
        }
        await run.call('Release dynamic', ()=>dynamic.buffer.release());
        await run.call('Release dynamic indices', ()=>dynamicIndices.buffer.release());
        await run.call('Release tex', ()=>tex.release());
        await run.call('Release vertices', ()=>vertices.release());
        await run.call('Release indices', ()=>indices.release());
        await run.call('Release device', ()=>device.release());
        await run.look('end');
    });
});

test('Direct3D 9: textures of every kind -- levels, a rectangle, DISCARD, cube faces,'
    + ' volumes, and a texture locked again before it is drawn -- play what the device'
    + ' drew itself', async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        const managed = await makeTexture(run, device, 'managed', { levels: 3, seed: 3 });
        const dynamic = await makeTexture(run, device, 'dynamic', { levels: 1, seed: 5,
            usage: D3DUSAGE.DYNAMIC, pool: D3DPOOL.DEFAULT });
        /** @type {{ texture?: any }} */
        const cube = {};
        await run.call('CreateCubeTexture', ()=>device.CreateCubeTexture(4, 1, 0, D3DFMT.A8R8G8B8,
            D3DPOOL.MANAGED, cube), [cube]);
        for (let face = 0; face < 6; face++)
        {
            /** @type {{ pBits?: number, Pitch?: number }} */
            const rect = {};
            await run.call(`LockRect cube ${face}`, ()=>cube.texture.LockCubeRect(face, 0, rect,
                null, 0), [rect]);
            fillRows(run, /** @type {number} */ (rect.pBits), /** @type {number} */ (rect.Pitch),
                4, 16, 40 + face);
            await run.call(`UnlockRect cube ${face}`, ()=>cube.texture.UnlockCubeRect(face, 0));
        }
        /** @type {{ texture?: any }} */
        const volume = {};
        await run.call('CreateVolumeTexture', ()=>device.CreateVolumeTexture(4, 4, 2, 1, 0,
            D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, volume), [volume]);
        /** @type {{ pBits?: number, RowPitch?: number, SlicePitch?: number }} */
        const box = {};
        await run.call('LockBox', ()=>volume.texture.LockBox(0, box, null, 0), [box]);
        fillRows(run, /** @type {number} */ (box.pBits), 16, 8, 16, 60);
        await run.call('UnlockBox', ()=>volume.texture.UnlockBox(0));
        const generated = await makeTexture(run, device, 'generated', { levels: 1, seed: 65,
            usage: D3DUSAGE.AUTOGENMIPMAP });
        await run.call('SetAutoGenFilterType', ()=>generated.SetAutoGenFilterType(2));
        await run.call('GenerateMipSubLevels', ()=>generated.GenerateMipSubLevels());
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, 0, STRIDE));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        for (let frame = 0; frame < 2; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff200000 + frame, 1, 0));
            await drawQuad9(run, device, `generated ${frame}`, generated, 0.4);
            await drawQuad9(run, device, `managed ${frame}`, managed, 0);
            await drawQuad9(run, device, `dynamic ${frame}`, dynamic, 0.1);
            await drawQuad9(run, device, `cube ${frame}`, cube.texture, 0.2);
            await drawQuad9(run, device, `volume ${frame}`, volume.texture, 0.3);
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('Present', ()=>device.Present());
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
            // Between frames: a rectangle of a level, the dynamic texture with
            // DISCARD, a level locked twice before it is drawn, and a level
            // locked to read, which sends nothing.
            await fillLevel(run, managed, 'managed rect', 0, 70 + frame,
                { rect: { left: 2, top: 1, right: 6, bottom: 5 } });
            await fillLevel(run, dynamic, 'dynamic discard', 0, 80 + frame,
                { flags: D3DLOCK.DISCARD });
            await fillLevel(run, managed, 'managed[1] once', 1, 90 + frame);
            await fillLevel(run, managed, 'managed[1] twice', 1, 95 + frame);
            /** @type {{ pBits?: number, Pitch?: number }} */
            const read = {};
            await run.call('LockRect read-only', ()=>managed.LockRect(2, read, null,
                D3DLOCK.READONLY), [read]);
            run.bytes('read-only level', /** @type {number} */ (read.pBits), 16);
            await run.call('UnlockRect read-only', ()=>managed.UnlockRect(2));
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([['managed', managed],
            ['dynamic', dynamic], ['cube', cube.texture], ['volume', volume.texture],
            ['generated', generated],
            ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 9: the copies between surfaces -- UpdateSurface, UpdateTexture, StretchRect,'
    + ' ColorFill, GetRenderTargetData -- play what the device drew itself and leave the'
    + ' program the same bytes', async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        const size = 8;
        // A system-memory texture carried into a default-pool one.
        const system = await makeTexture(run, device, 'system', { pool: D3DPOOL.SYSTEMMEM,
            levels: 2, seed: 11 });
        /** @type {{ texture?: any }} */
        const video = {};
        await run.call('CreateTexture video', ()=>device.CreateTexture(size, size, 2, 0,
            D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, video), [video]);
        await run.call('UpdateTexture', ()=>device.UpdateTexture(system, video.texture));
        // A system-memory surface into a level of a default-pool texture.
        /** @type {{ surface?: any }} */
        const plainSystem = {};
        await run.call('CreateOffscreenPlainSurface system', ()=>device.CreateOffscreenPlainSurface(
            size, size, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, plainSystem), [plainSystem]);
        /** @type {{ pBits?: number, Pitch?: number }} */
        const rect = {};
        await run.call('LockRect plain system', ()=>plainSystem.surface.LockRect(rect, null, 0),
            [rect]);
        fillRows(run, /** @type {number} */ (rect.pBits), /** @type {number} */ (rect.Pitch), size,
            size * 4, 13);
        await run.call('UnlockRect plain system', ()=>plainSystem.surface.UnlockRect());
        /** @type {{ texture?: any }} */
        const target = {};
        await run.call('CreateTexture updated', ()=>device.CreateTexture(size, size, 1, 0,
            D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, target), [target]);
        /** @type {{ surface?: any }} */
        const targetLevel = {};
        await run.call('GetSurfaceLevel updated', ()=>target.texture.GetSurfaceLevel(0,
            targetLevel), [targetLevel]);
        await run.call('UpdateSurface', ()=>device.UpdateSurface(plainSystem.surface,
            { left: 1, top: 1, right: 5, bottom: 5 }, targetLevel.surface, { x: 2, y: 3 }));
        // A render-target texture, drawn into and copied about on the GPU.
        /** @type {{ texture?: any }} */
        const drawn = {};
        await run.call('CreateTexture render target', ()=>device.CreateTexture(32, 32, 1,
            D3DUSAGE.RENDERTARGET, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, drawn), [drawn]);
        /** @type {{ surface?: any }} */
        const drawnLevel = {};
        await run.call('GetSurfaceLevel render target', ()=>drawn.texture.GetSurfaceLevel(0,
            drawnLevel), [drawnLevel]);
        /** @type {{ surface?: any }} */
        const back = {};
        await run.call('GetBackBuffer', ()=>device.GetBackBuffer(0, 0, 0, back), [back]);
        /** @type {{ surface?: any }} */
        const plainVideo = {};
        await run.call('CreateOffscreenPlainSurface video', ()=>device.CreateOffscreenPlainSurface(
            32, 32, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, plainVideo), [plainVideo]);
        /** @type {{ surface?: any }} */
        const readBack = {};
        await run.call('CreateOffscreenPlainSurface read-back', ()=>device
            .CreateOffscreenPlainSurface(32, 32, D3DFMT.X8R8G8B8, D3DPOOL.SYSTEMMEM, readBack),
        [readBack]);
        // And a system-memory texture read back into, carried on by its texture.
        /** @type {{ texture?: any }} */
        const readTexture = {};
        await run.call('CreateTexture read-back', ()=>device.CreateTexture(32, 32, 1, 0,
            D3DFMT.X8R8G8B8, D3DPOOL.SYSTEMMEM, readTexture), [readTexture]);
        /** @type {{ surface?: any }} */
        const readLevel = {};
        await run.call('GetSurfaceLevel read-back', ()=>readTexture.texture.GetSurfaceLevel(0,
            readLevel), [readLevel]);
        /** @type {{ texture?: any }} */
        const carried = {};
        await run.call('CreateTexture carried', ()=>device.CreateTexture(32, 32, 1,
            D3DUSAGE.RENDERTARGET, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, carried), [carried]);
        /** @type {{ surface?: any }} */
        const carriedLevel = {};
        await run.call('GetSurfaceLevel carried', ()=>carried.texture.GetSurfaceLevel(0,
            carriedLevel), [carriedLevel]);
        /** @type {{ surface?: any }} */
        const front = {};
        await run.call('CreateOffscreenPlainSurface front', ()=>device.CreateOffscreenPlainSurface(
            32, 32, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, front), [front]);
        /** @type {{ swapChain?: any }} */
        const chain = {};
        await run.call('CreateAdditionalSwapChain', ()=>device.CreateAdditionalSwapChain({
            ...PARAMETERS, enableAutoDepthStencil: false, backBufferWidth: 16,
            backBufferHeight: 16, windowed: true, hDeviceWindow: 0x1234 }, chain), [chain]);
        /** @type {{ surface?: any }} */
        const chainBack = {};
        await run.call('GetBackBuffer chain', ()=>chain.swapChain.GetBackBuffer(0, 0, chainBack),
            [chainBack]);
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, 0, STRIDE));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        for (let frame = 0; frame < 2; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('SetRenderTarget drawn', ()=>device.SetRenderTarget(0,
                drawnLevel.surface));
            await run.call('Clear drawn', ()=>device.Clear(0, null, D3DCLEAR.TARGET,
                0xff336699 + frame, 1, 0));
            await drawQuad9(run, device, `into drawn ${frame}`, video.texture, 0);
            await run.call('SetRenderTarget back', ()=>device.SetRenderTarget(0, back.surface));
            await run.call('Clear back', ()=>device.Clear(0, null, D3DCLEAR.TARGET
                | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0));
            await drawQuad9(run, device, `drawn ${frame}`, drawn.texture, 0.1);
            await drawQuad9(run, device, `updated ${frame}`, target.texture, 0.2);
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('StretchRect back into drawn', ()=>device.StretchRect(back.surface,
                { left: 0, top: 0, right: 16, bottom: 16 }, drawnLevel.surface,
                { left: 16, top: 16, right: 32, bottom: 32 }, TEXF_POINT));
            // Scaled, which only the device that draws can do: the one that
            // records for it answers as that one will.
            await run.call('StretchRect back scaled into drawn', ()=>device.StretchRect(
                back.surface, { left: 0, top: 0, right: 32, bottom: 32 }, drawnLevel.surface,
                { left: 0, top: 0, right: 16, bottom: 16 }, TEXF_LINEAR));
            await run.call('StretchRect drawn into plain', ()=>device.StretchRect(
                drawnLevel.surface, null, plainVideo.surface, null, TEXF_POINT));
            await run.call('ColorFill plain', ()=>device.ColorFill(plainVideo.surface,
                { left: 0, top: 0, right: 4, bottom: 4 }, 0xff00ff00 + frame));
            await run.call('GetRenderTargetData', ()=>device.GetRenderTargetData(back.surface,
                readBack.surface));
            // The read-back surface copied on before anything locks it: the
            // copy is the device's, and carries the pixels the copy back put
            // there, not what the program's memory held while they travelled.
            await run.call('UpdateSurface read-back into plain', ()=>device.UpdateSurface(
                readBack.surface, { left: 0, top: 0, right: 8, bottom: 8 }, plainVideo.surface,
                { x: 8, y: 8 }));
            await run.call('GetRenderTargetData into a texture', ()=>device.GetRenderTargetData(
                back.surface, readLevel.surface));
            await run.call('UpdateTexture read-back', ()=>device.UpdateTexture(
                readTexture.texture, carried.texture));
            await run.call('StretchRect carried into plain', ()=>device.StretchRect(
                carriedLevel.surface, { left: 0, top: 0, right: 8, bottom: 8 },
                plainVideo.surface, { left: 16, top: 16, right: 24, bottom: 24 }, TEXF_POINT));
            /** @type {{ pBits?: number, Pitch?: number }} */
            const pixels = {};
            await run.call('LockRect read-back', ()=>readBack.surface.LockRect(pixels, null,
                D3DLOCK.READONLY), [pixels]);
            run.bytes('read-back pixels', /** @type {number} */ (pixels.pBits), 32 * 32 * 4);
            await run.call('UnlockRect read-back', ()=>readBack.surface.UnlockRect());
            /** @type {{ pBits?: number, Pitch?: number }} */
            const plainBytes = {};
            await run.call('LockRect plain video', ()=>plainVideo.surface.LockRect(plainBytes,
                null, D3DLOCK.READONLY), [plainBytes]);
            run.bytes('plain video bytes', /** @type {number} */ (plainBytes.pBits), 32 * 32 * 4);
            await run.call('UnlockRect plain video', ()=>plainVideo.surface.UnlockRect());
            await run.call('Present', ()=>device.Present());
            await run.call('idle', ()=>device.idle());
            await run.call('GetFrontBufferData', ()=>device.GetFrontBufferData(0, front.surface));
            /** @type {{ pBits?: number, Pitch?: number }} */
            const shown = {};
            await run.call('LockRect front', ()=>front.surface.LockRect(shown, null,
                D3DLOCK.READONLY), [shown]);
            run.bytes('front pixels', /** @type {number} */ (shown.pBits), 32 * 32 * 4);
            await run.call('UnlockRect front', ()=>front.surface.UnlockRect());
            // A swap chain of its own, drawn into and presented.
            await run.call('SetRenderTarget chain', ()=>device.SetRenderTarget(0,
                chainBack.surface));
            await run.call('BeginScene chain', ()=>device.BeginScene());
            await run.call('Clear chain', ()=>device.Clear(0, null, D3DCLEAR.TARGET, 0xff0000ff
                - frame, 1, 0));
            await drawQuad9(run, device, `chain ${frame}`, video.texture, 0);
            await run.call('EndScene chain', ()=>device.EndScene());
            await run.call('SetRenderTarget back again', ()=>device.SetRenderTarget(0,
                back.surface));
            await run.call('Present chain', ()=>chain.swapChain.Present(null, null, 0, null, 0));
            await run.call('idle chain', ()=>device.idle());
            await run.look(`frame ${frame}`);
            // The system texture written again, and carried again.
            await fillLevel(run, system, 'system again', 0, 20 + frame,
                { rect: { left: 0, top: 0, right: 4, bottom: 4 } });
            await run.call('UpdateTexture again', ()=>device.UpdateTexture(system, video.texture));
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([
            ['system', system], ['video', video.texture], ['plain system', plainSystem.surface],
            ['updated level', targetLevel.surface], ['updated', target.texture],
            ['drawn level', drawnLevel.surface], ['drawn', drawn.texture],
            ['back', back.surface], ['plain video', plainVideo.surface],
            ['read-back', readBack.surface], ['front', front.surface],
            ['read-back level', readLevel.surface], ['read-back texture', readTexture.texture],
            ['carried level', carriedLevel.surface], ['carried', carried.texture],
            ['chain back', chainBack.surface], ['chain', chain.swapChain],
            ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 9: state, state blocks, draws from user memory, a run of the command ring,'
    + ' queries and the getters play what the device drew itself and answer the same',
async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        const tex = await makeTexture(run, device, 'tex', { seed: 7 });
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, 0, STRIDE));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        await run.call('SetMaterial', ()=>device.SetMaterial({
            Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 }, Ambient: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
            Specular: { r: 0, g: 0, b: 0, a: 0 }, Emissive: { r: 0, g: 0, b: 0, a: 0 },
            Power: 0 }));
        await run.call('SetLight', ()=>device.SetLight(0, { Type: 3,
            Diffuse: { r: 1, g: 1, b: 1, a: 1 }, Specular: { r: 0, g: 0, b: 0, a: 0 },
            Ambient: { r: 0, g: 0, b: 0, a: 0 }, Position: { x: 0, y: 0, z: 0 },
            Direction: { x: 0, y: 0, z: 1 }, Range: 0, Falloff: 0, Attenuation0: 0,
            Attenuation1: 0, Attenuation2: 0, Theta: 0, Phi: 0 }));
        await run.call('LightEnable', ()=>device.LightEnable(0, 1));
        await run.call('SetTextureStageState', ()=>device.SetTextureStageState(0,
            D3DTSS.COLOROP, 4));
        await run.call('SetSamplerState', ()=>device.SetSamplerState(0, 5, 1));
        await run.call('SetViewport', ()=>device.SetViewport({ X: 2, Y: 2, Width: 28,
            Height: 28, MinZ: 0, MaxZ: 1 }));
        await run.call('SetScissorRect', ()=>device.SetScissorRect({ left: 1, top: 1, right: 30,
            bottom: 30 }));
        await run.call('SetRenderState SCISSORTESTENABLE', ()=>device.SetRenderState(174, 1));
        // A state block recorded, and one captured, each applied later.
        await run.call('BeginStateBlock', ()=>device.BeginStateBlock());
        await run.call('SetRenderState ZENABLE in block', ()=>device.SetRenderState(D3DRS.ZENABLE,
            0));
        await run.call('SetTransform in block', ()=>device.SetTransform(D3DTS.VIEW,
            identity(0.5)));
        /** @type {{ block?: any }} */
        const recordedBlock = {};
        await run.call('EndStateBlock', ()=>device.EndStateBlock(recordedBlock), [recordedBlock]);
        /** @type {{ block?: any }} */
        const captured = {};
        await run.call('CreateStateBlock', ()=>device.CreateStateBlock(SBT_ALL, captured),
            [captured]);
        /** @type {{ query?: any }} */
        const event = {};
        await run.call('CreateQuery event', ()=>device.CreateQuery(D3DQUERYTYPE.EVENT, event),
            [event]);
        /** @type {{ query?: any }} */
        const occlusion = {};
        await run.call('CreateQuery occlusion', ()=>device.CreateQuery(D3DQUERYTYPE.OCCLUSION,
            occlusion), [occlusion]);
        /** @type {{ buffer?: any }} */
        const processed = {};
        await run.call('CreateVertexBuffer processed', ()=>device.CreateVertexBuffer(
            4 * STRIDE_RHW, 0, FVF_RHW, D3DPOOL.SYSTEMMEM, processed), [processed]);
        const one = new Uint32Array(new Float32Array([1]).buffer)[0];
        for (let frame = 0; frame < 2; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff004000 + frame, 1, 0));
            await run.call('Issue occlusion BEGIN', ()=>occlusion.query.Issue(D3DISSUE.BEGIN));
            await drawQuad9(run, device, `lit ${frame}`, tex, 0);
            await run.call('Issue occlusion END', ()=>occlusion.query.Issue(D3DISSUE.END));
            await run.call('Apply recorded block', ()=>recordedBlock.block.Apply());
            await run.call('SetRenderState LIGHTING off', ()=>device.SetRenderState(
                D3DRS.LIGHTING, 0));
            await run.call('DrawPrimitiveUP', ()=>device.DrawPrimitiveUP(D3DPT.TRIANGLESTRIP, 2,
                screenQuad(16, 16, 0xff8080ff), STRIDE_RHW));
            await run.call('SetFVF rhw', ()=>device.SetFVF(FVF_RHW));
            await run.call('DrawIndexedPrimitiveUP', ()=>device.DrawIndexedPrimitiveUP(
                D3DPT.TRIANGLELIST, 0, 4, 2, new Uint8Array(new Uint16Array([0, 1, 2, 2, 1, 3])
                    .buffer), D3DFMT_INDEX.INDEX16, screenQuad(24, 8, 0xffff8040 + frame),
                STRIDE_RHW));
            // A draw from user memory leaves no stream and no indices bound.
            await run.call('SetFVF lit', ()=>device.SetFVF(FVF_LIT));
            await run.call('SetStreamSource again', ()=>device.SetStreamSource(0, vertices, 0,
                STRIDE));
            await run.call('SetIndices again', ()=>device.SetIndices(indices));
            // Two calls in one run of the ring, as the guest's routines write them.
            const records = new Uint32Array([
                commandSlot('SetViewport'), 36, 0, 1, 2, 24, 20, 0, one,
                commandSlot('LightEnable'), 16, 0, frame,
            ]);
            await run.call('commands', ()=>device.commands(new Uint8Array(records.buffer)));
            await drawQuad9(run, device, `after the ring ${frame}`, tex, 0.25);
            await run.call('Apply captured block', ()=>captured.block.Apply());
            await drawQuad9(run, device, `captured ${frame}`, tex, 0.5);
            await run.call('Capture captured block', ()=>captured.block.Capture());
            await run.call('ProcessVertices', ()=>device.ProcessVertices(0, 0, 4,
                processed.buffer, null, 0));
            /** @type {{ pBits?: number }} */
            const out = {};
            await run.call('Lock processed', ()=>processed.buffer.Lock(0, 0, out,
                D3DLOCK.READONLY), [out]);
            run.bytes('processed vertices', /** @type {number} */ (out.pBits), 4 * STRIDE_RHW);
            await run.call('Unlock processed', ()=>processed.buffer.Unlock());
            await run.call('SetFVF processed', ()=>device.SetFVF(FVF_RHW));
            await run.call('SetStreamSource processed', ()=>device.SetStreamSource(0,
                processed.buffer, 0, STRIDE_RHW));
            await run.call('DrawPrimitive processed', ()=>device.DrawPrimitive(
                D3DPT.TRIANGLESTRIP, 0, 2));
            await run.call('SetFVF back', ()=>device.SetFVF(FVF_LIT));
            await run.call('SetStreamSource back', ()=>device.SetStreamSource(0, vertices, 0,
                STRIDE));
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('Issue event', ()=>event.query.Issue(D3DISSUE.END));
            /** @type {{ value?: number }} */
            const signalled = {};
            await run.call('GetData event', ()=>event.query.GetData(signalled, 4, GETDATA_FLUSH),
                [signalled]);
            /** @type {{ value?: number }} */
            const counted = {};
            // Polled until counted, as Wine's test_occlusion_query polls: a driver
            // answers S_FALSE until the GPU has counted, and so does the renderer
            // across the worker.
            await run.call('GetData occlusion', async()=>{
                let answer = await occlusion.query.GetData(counted, 4, GETDATA_FLUSH);
                for (let tries = 0; answer === 1 && tries < 1000; tries++)
                {
                    await new Promise(resolve=>setTimeout(resolve, 1));
                    answer = await occlusion.query.GetData(counted, 4, GETDATA_FLUSH);
                }
                return answer;
            }, [counted]);
            // What the program reads back of the state it set.
            /** @type {Record<string, any>} */
            const outs = {};
            await run.call('GetRenderState', ()=>device.GetRenderState(D3DRS.ZENABLE,
                outs.state = {}), [outs.state]);
            await run.call('GetTransform', ()=>device.GetTransform(D3DTS.VIEW,
                outs.transform = {}), [outs.transform]);
            await run.call('GetViewport', ()=>device.GetViewport(outs.viewport = {}),
                [outs.viewport]);
            await run.call('GetLightEnable', ()=>device.GetLightEnable(0, outs.light = {}),
                [outs.light]);
            await run.call('GetAvailableTextureMem', ()=>device.GetAvailableTextureMem());
            await run.call('GetSurfaceLevel', ()=>tex.GetSurfaceLevel(1, outs.level = {}),
                [outs.level]);
            await run.call('GetDesc', ()=>outs.level.surface.GetDesc(outs.desc = {}),
                [outs.desc]);
            await run.call('Release level', ()=>outs.level.surface.release());
            await run.call('GetRenderTarget', ()=>device.GetRenderTarget(0, outs.target = {}),
                [outs.target]);
            await run.call('Release target', ()=>outs.target.surface.release());
            await run.call('GetDepthStencilSurface', ()=>device.GetDepthStencilSurface(
                outs.depth = {}), [outs.depth]);
            await run.call('Release depth', ()=>outs.depth.surface.release());
            await run.call('GetTexture', ()=>device.GetTexture(0, outs.texture = {}),
                [outs.texture]);
            await run.call('Release got texture', ()=>outs.texture.texture?.release());
            await run.call('TestCooperativeLevel', ()=>device.TestCooperativeLevel());
            await run.call('ValidateDevice', ()=>device.ValidateDevice(outs.passes = {}),
                [outs.passes]);
            await run.call('Present', ()=>device.Present());
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([
            ['recorded block', recordedBlock.block], ['captured block', captured.block],
            ['event', event.query], ['occlusion', occlusion.query], ['tex', tex],
            ['processed', processed.buffer],
            ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 9: a Reset with default-pool resources held is refused, and once they are'
    + ' released the device and what is made after it play what the device drew itself',
async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        /** @type {{ buffer?: any }} */
        const dynamic = {};
        await run.call('CreateVertexBuffer dynamic', ()=>device.CreateVertexBuffer(16 * STRIDE,
            D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_LIT, D3DPOOL.DEFAULT, dynamic), [dynamic]);
        const managed = await makeTexture(run, device, 'managed', { seed: 9 });
        await run.call('Reset refused', ()=>device.Reset({ ...PARAMETERS }));
        await run.call('TestCooperativeLevel', ()=>device.TestCooperativeLevel());
        await run.call('Release dynamic', ()=>dynamic.buffer.release());
        await run.call('Reset', ()=>device.Reset({ ...PARAMETERS, backBufferWidth: 48,
            backBufferHeight: 24 }));
        await run.call('CreateVertexBuffer dynamic again', ()=>device.CreateVertexBuffer(
            16 * STRIDE, D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_LIT, D3DPOOL.DEFAULT,
            dynamic), [dynamic]);
        /** @type {{ pBits?: number }} */
        const locked = {};
        await run.call('Lock dynamic', ()=>dynamic.buffer.Lock(0, 4 * STRIDE, locked,
            D3DLOCK.DISCARD), [locked]);
        writeVertices(run, /** @type {number} */ (locked.pBits), 30);
        await run.call('Unlock dynamic', ()=>dynamic.buffer.Unlock());
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        await run.call('BeginScene', ()=>device.BeginScene());
        await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
            0xff101010, 1, 0));
        await run.call('SetStreamSource managed', ()=>device.SetStreamSource(0, vertices, 0,
            STRIDE));
        await drawQuad9(run, device, 'managed', managed, 0);
        await run.call('SetStreamSource dynamic', ()=>device.SetStreamSource(0, dynamic.buffer,
            0, STRIDE));
        await drawQuad9(run, device, 'dynamic', managed, 0.5);
        await run.call('EndScene', ()=>device.EndScene());
        await run.call('Present', ()=>device.Present());
        await run.call('idle', ()=>device.idle());
        await run.look('after the reset');
        for (const [name, object] of /** @type {[string, any][]} */ ([['dynamic', dynamic.buffer],
            ['managed', managed], ['vertices', vertices], ['indices', indices],
            ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 9: a texture locked and written again before the twin has played the draw that'
    + ' samples it, and one released and its memory written over, are drawn as they were at'
    + ' the draw', async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        const managed = await makeTexture(run, device, 'managed', { levels: 1, seed: 2 });
        const dynamic = await makeTexture(run, device, 'dynamic', { levels: 1, seed: 3,
            usage: D3DUSAGE.DYNAMIC, pool: D3DPOOL.DEFAULT });
        /** @type {{ surface?: any }} */
        const level = {};
        await run.call('GetSurfaceLevel managed', ()=>managed.GetSurfaceLevel(0, level), [level]);
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, 0, STRIDE));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        await run.call('BeginScene', ()=>device.BeginScene());
        await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
            0xff000000, 1, 0));
        for (let pass = 0; pass < 3; pass++)
        {
            await drawQuad9(run, device, `managed ${pass}`, managed, pass / 8);
            await drawQuad9(run, device, `dynamic ${pass}`, dynamic, pass / 8 + 0.5);
            // Written again at once, the draws above not yet played where
            // the twin plays late: once through the texture, once through its
            // level, and the dynamic one with DISCARD.
            if (pass === 1)
            {
                /** @type {{ pBits?: number, Pitch?: number }} */
                const rect = {};
                await run.call('LockRect level', ()=>level.surface.LockRect(rect, null, 0),
                    [rect]);
                fillRows(run, /** @type {number} */ (rect.pBits),
                    /** @type {number} */ (rect.Pitch), 8, 32, 100 + pass);
                await run.call('UnlockRect level', ()=>level.surface.UnlockRect());
            }
            else
            {
                await fillLevel(run, managed, `managed again ${pass}`, 0, 100 + pass);
            }
            await fillLevel(run, dynamic, `dynamic again ${pass}`, 0, 110 + pass,
                { flags: D3DLOCK.DISCARD });
        }
        // A texture drawn and let go of at once: the heap may hand its bytes
        // to the program, which writes them before the twin has drawn.
        const brief = await makeTexture(run, device, 'brief', { levels: 1, seed: 120 });
        /** @type {{ pBits?: number, Pitch?: number }} */
        const where = {};
        await run.call('LockRect brief', ()=>brief.LockRect(0, where, null, D3DLOCK.READONLY),
            [where]);
        await run.call('UnlockRect brief', ()=>brief.UnlockRect(0));
        await drawQuad9(run, device, 'brief', brief, 0.75);
        await run.call('SetTexture none', ()=>device.SetTexture(0, null));
        await run.call('Release brief', ()=>brief.release());
        run.on.memory.ram.fill(0xcd, /** @type {number} */ (where.pBits) - RAM_BASE,
            /** @type {number} */ (where.pBits) - RAM_BASE + 8 * 8 * 4);
        await run.call('EndScene', ()=>device.EndScene());
        await run.call('Present', ()=>device.Present());
        await run.call('idle', ()=>device.idle());
        await run.look('frame');
        for (const [name, object] of /** @type {[string, any][]} */ ([['level', level.surface],
            ['managed', managed], ['dynamic', dynamic], ['vertices', vertices],
            ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 9: a lockable back buffer and a render-target texture locked -- the pixels read'
    + ' back, written and unlocked -- play what the device drew itself and show the program'
    + ' the same pixels', async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run, { lockableBackBuffer: true });
        const tex = await makeTexture(run, device, 'tex', { levels: 1, seed: 12 });
        /** @type {{ surface?: any }} */
        const back = {};
        await run.call('GetBackBuffer', ()=>device.GetBackBuffer(0, 0, 0, back), [back]);
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, 0, STRIDE));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        for (let frame = 0; frame < 2; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff445566 + frame, 1, 0));
            await drawQuad9(run, device, `frame ${frame}`, tex, 0);
            await run.call('EndScene', ()=>device.EndScene());
            /** @type {{ pBits?: number, Pitch?: number }} */
            const read = {};
            await run.call('LockRect back read-only', ()=>back.surface.LockRect(read, null,
                D3DLOCK.READONLY), [read]);
            run.bytes('back buffer as drawn', /** @type {number} */ (read.pBits), 32 * 32 * 4);
            await run.call('UnlockRect back read-only', ()=>back.surface.UnlockRect());
            /** @type {{ pBits?: number, Pitch?: number }} */
            const written = {};
            await run.call('LockRect back', ()=>back.surface.LockRect(written,
                { left: 4, top: 4, right: 12, bottom: 12 }, 0), [written]);
            fillRows(run, /** @type {number} */ (written.pBits),
                /** @type {number} */ (written.Pitch), 8, 32, 140 + frame);
            await run.call('UnlockRect back', ()=>back.surface.UnlockRect());
            await run.call('Present', ()=>device.Present());
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([['back', back.surface],
            ['tex', tex], ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

/**
 * One record of a command ring: the slot, the length, the arguments, and
 * what is copied after them.
 *
 * @param {number} slot @param {number[]} args @param {number[]} [copy]
 */
const record = (slot, args, copy = [])=>[slot, (2 + args.length + copy.length) * 4, ...args,
    ...copy];

test('Direct3D 9 and 8: runs of the command ring that bind objects and draw play what the'
    + ' device drew itself', async()=>{
    const one = new Uint32Array(new Float32Array([1]).buffer)[0];
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        const tex = await makeTexture(run, device, 'tex', { levels: 1, seed: 33 });
        await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        /** @type {{ block?: any }} */
        const block = {};
        await run.call('CreateStateBlock', ()=>device.CreateStateBlock(SBT_ALL, block), [block]);
        for (let frame = 0; frame < 2; frame++)
        {
            const records = new Uint32Array([
                ...record(commandSlot('BeginScene'), []),
                ...record(commandSlot('SetTexture'), [0, 0x1000]),
                ...record(commandSlot('SetStreamSource'), [0, 0x2000, 0, STRIDE]),
                ...record(commandSlot('SetIndices'), [0x3000]),
                ...record(commandSlot('SetViewport'), [0], [0, 0, 30, 30, 0, one]),
                ...record(commandSlot('DrawIndexedPrimitive'), [D3DPT.TRIANGLELIST, 0, 0, 4, 0,
                    2]),
                ...record(commandSlot('StateBlock.Apply'), [0x4000]),
                ...record(commandSlot('SetRenderState'), [D3DRS.LIGHTING, 0]),
                ...record(commandSlot('SetStreamSource'), [0, 0x2000, 0, STRIDE]),
                ...record(commandSlot('SetIndices'), [0x3000]),
                ...record(commandSlot('SetTexture'), [0, 0x1000]),
                ...record(commandSlot('DrawIndexedPrimitive'), [D3DPT.TRIANGLESTRIP, 0, 0, 4, 0,
                    2]),
                ...record(commandSlot('EndScene'), []),
            ]);
            await fillLevel(run, tex, `tex ${frame}`, 0, 34 + frame);
            await run.call('commands', ()=>device.commands(new Uint8Array(records.buffer),
                [tex, vertices, indices, block.block, vertices, indices, tex]));
            await run.call('Present', ()=>device.Present());
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([['block', block.block],
            ['tex', tex], ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        const tex = await makeTexture(run, device, 'tex', { levels: 1, seed: 36 });
        const slot = D3D8_COMMANDS.commandSlot;
        for (let frame = 0; frame < 2; frame++)
        {
            const records = new Uint32Array([
                ...record(slot('BeginScene'), []),
                ...record(slot('SetTexture'), [0, 0x1000]),
                ...record(slot('SetStreamSource'), [0, 0x2000, STRIDE]),
                ...record(slot('SetIndices'), [0x3000, 0]),
                ...record(slot('SetVertexShader'), [FVF_LIT]),
                ...record(slot('DrawIndexedPrimitive'), [D3DPT.TRIANGLELIST, 0, 4, 0, 2]),
                ...record(slot('DrawIndexedPrimitive'), [D3DPT.TRIANGLEFAN, 0, 4, 0, 2]),
                ...record(slot('EndScene'), []),
            ]);
            await fillLevel(run, tex, `tex ${frame}`, 0, 37 + frame);
            await run.call('commands', ()=>device.commands(new Uint8Array(records.buffer),
                [tex, vertices, indices]));
            await run.call('Present', ()=>device.Present(null, null, 0, null));
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([['tex', tex],
            ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 8: a texture locked and written again before the twin has played the draw that'
    + ' samples it is drawn as it was at the draw', async()=>{
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        void vertices;
        void indices;
        const managed = await makeTexture(run, device, 'managed', { levels: 1, seed: 40 });
        await run.call('BeginScene', ()=>device.BeginScene());
        await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
            0xff000000, 1, 0));
        for (let pass = 0; pass < 3; pass++)
        {
            await drawQuad8(run, device, `managed ${pass}`, managed, pass / 8);
            await fillLevel(run, managed, `managed again ${pass}`, 0, 41 + pass);
        }
        await run.call('EndScene', ()=>device.EndScene());
        await run.call('Present', ()=>device.Present(null, null, 0, null));
        await run.call('idle', ()=>device.idle());
        await run.look('frame');
        await run.call('Release managed', ()=>managed.release());
        await run.call('Release device', ()=>device.release());
        await run.look('end');
    });
});

/** @param {number} type @param {number} index @param {number} [writeMask] */
const dst = (type, index, writeMask = 0xf)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (writeMask << 16) | index) >>> 0;
/** @param {number} type @param {number} index @param {number} [swizzle] */
const src = (type, index, swizzle = 0xe4)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (swizzle << 16) | index) >>> 0;
/** @param {number} opcode @param {number} length */
const op = (opcode, length)=>((length << 24) | opcode) >>> 0;
/** @param {number} usage @param {number} register */
const dclInput = (usage, register)=>[
    op(OPCODE.DCL, 2), (0x80000000 | usage) >>> 0, dst(REGISTER.INPUT, register),
];

/** vs_2_0: the position through c0..c3, the colour scaled by c5, the coordinates as they come. */
const VERTEX_SHADER = [
    versionToken(SHADER_KIND.VERTEX, 2, 0),
    ...dclInput(D3DDECLUSAGE.POSITION, 0),
    ...dclInput(D3DDECLUSAGE.COLOR, 1),
    ...dclInput(D3DDECLUSAGE.TEXCOORD, 2),
    op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), src(REGISTER.CONST, 0),
    op(OPCODE.MUL, 3), dst(REGISTER.ATTROUT, 0), src(REGISTER.INPUT, 1), src(REGISTER.CONST, 5),
    op(OPCODE.MOV, 2), dst(REGISTER.TEXCRDOUT, 0), src(REGISTER.INPUT, 2),
    END_TOKEN,
];

/** ps_2_0: a sample times the colour, offset by c2. */
const PIXEL_SHADER = [
    versionToken(SHADER_KIND.PIXEL, 2, 0),
    op(OPCODE.DCL, 2), (2 << 27) >>> 0, dst(REGISTER.SAMPLER, 0),
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.TEXTURE, 0),
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.INPUT, 0),
    op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0), src(REGISTER.SAMPLER, 0),
    op(OPCODE.MAD, 4), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0), src(REGISTER.INPUT, 0),
    src(REGISTER.CONST, 2),
    END_TOKEN,
];

test('Direct3D 9: shaders over a declaration of two streams, their constants set between the'
    + ' draws, play what the device drew itself', async()=>{
    await same(9, async run=>{
        const { device, vertices, indices } = await device9(run);
        /** @type {{ buffer?: any }} */
        const coordinates = {};
        await run.call('CreateVertexBuffer coordinates', ()=>device.CreateVertexBuffer(32, 0, 0,
            D3DPOOL.MANAGED, coordinates), [coordinates]);
        /** @type {{ pBits?: number }} */
        const locked = {};
        await run.call('Lock coordinates', ()=>coordinates.buffer.Lock(0, 0, locked, 0),
            [locked]);
        new Float32Array(run.on.memory.ram.buffer, /** @type {number} */ (locked.pBits)
            - RAM_BASE, 8).set([0, 0, 1, 0, 0, 1, 1, 1]);
        await run.call('Unlock coordinates', ()=>coordinates.buffer.Unlock());
        /** @type {{ declaration?: any }} */
        const declaration = {};
        await run.call('CreateVertexDeclaration', ()=>device.CreateVertexDeclaration([
            { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0,
                Usage: D3DDECLUSAGE.POSITION, UsageIndex: 0 },
            { Stream: 0, Offset: 12, Type: D3DDECLTYPE.D3DCOLOR, Method: 0,
                Usage: D3DDECLUSAGE.COLOR, UsageIndex: 0 },
            { Stream: 1, Offset: 0, Type: D3DDECLTYPE.FLOAT2, Method: 0,
                Usage: D3DDECLUSAGE.TEXCOORD, UsageIndex: 0 },
        ], declaration), [declaration]);
        /** @type {{ shader?: any }} */
        const vertexShader = {};
        await run.call('CreateVertexShader', ()=>device.CreateVertexShader(VERTEX_SHADER,
            vertexShader), [vertexShader]);
        /** @type {{ shader?: any }} */
        const pixelShader = {};
        await run.call('CreatePixelShader', ()=>device.CreatePixelShader(PIXEL_SHADER,
            pixelShader), [pixelShader]);
        const tex = await makeTexture(run, device, 'tex', { levels: 1, seed: 160 });
        await run.call('SetVertexDeclaration', ()=>device.SetVertexDeclaration(
            declaration.declaration));
        await run.call('SetVertexShader', ()=>device.SetVertexShader(vertexShader.shader));
        await run.call('SetPixelShader', ()=>device.SetPixelShader(pixelShader.shader));
        await run.call('SetStreamSource 0', ()=>device.SetStreamSource(0, vertices, 0, STRIDE));
        await run.call('SetStreamSource 1', ()=>device.SetStreamSource(1, coordinates.buffer, 0,
            8));
        await run.call('SetIndices', ()=>device.SetIndices(indices));
        await run.call('SetTexture', ()=>device.SetTexture(0, tex));
        for (let frame = 0; frame < 2; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff000000 + frame, 1, 0));
            for (let draw = 0; draw < 3; draw++)
            {
                await run.call(`SetVertexShaderConstantF ${draw}`, ()=>device
                    .SetVertexShaderConstantF(0, identity(draw / 4 - frame / 8), 4));
                await run.call(`SetVertexShaderConstantF colour ${draw}`, ()=>device
                    .SetVertexShaderConstantF(5, new Float32Array([1, 0.5, draw / 2, 1]), 1));
                await run.call(`SetPixelShaderConstantF ${draw}`, ()=>device
                    .SetPixelShaderConstantF(2, new Float32Array([0.1 * draw, 0, 0, 0]), 1));
                await run.call(`DrawIndexedPrimitive ${draw}`, ()=>device.DrawIndexedPrimitive(
                    D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
            }
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('Present', ()=>device.Present());
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([
            ['coordinates', coordinates.buffer], ['declaration', declaration.declaration],
            ['vertex shader', vertexShader.shader], ['pixel shader', pixelShader.shader],
            ['tex', tex], ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    }, WAYS, { vertexShaderVersion: { major: 2, minor: 0 },
        pixelShaderVersion: { major: 2, minor: 0 } });
});

test('Direct3D 9: a level locked through the texture and unlocked through its surface is drawn'
    + ' as written', async()=>{
    await same(9, run=>keptFrame(run, async({ device, tex })=>{
        /** @type {{ surface?: any }} */
        const level = {};
        await run.call('GetSurfaceLevel', ()=>tex.GetSurfaceLevel(0, level), [level]);
        /** @type {{ pBits?: number, Pitch?: number }} */
        const rect = {};
        await run.call('LockRect texture', ()=>tex.LockRect(0, rect, null, 0), [rect]);
        fillRows(run, /** @type {number} */ (rect.pBits), /** @type {number} */ (rect.Pitch), 8,
            32, 170);
        await run.call('UnlockRect surface', ()=>level.surface.UnlockRect());
        await drawQuad9(run, device, 'tex', tex, 0);
        await run.call('Release level', ()=>level.surface.release());
    }));
});

test('Direct3D 9: a level, a cube face and a volume locked through their own object and'
    + ' unlocked through the texture are drawn as written',
async()=>{
    await same(9, run=>keptFrame(run, async({ device, tex })=>{
        /** @type {{ surface?: any }} */
        const level = {};
        await run.call('GetSurfaceLevel', ()=>tex.GetSurfaceLevel(0, level), [level]);
        /** @type {{ pBits?: number, Pitch?: number }} */
        const rect = {};
        await run.call('LockRect surface', ()=>level.surface.LockRect(rect, null, 0), [rect]);
        fillRows(run, /** @type {number} */ (rect.pBits), /** @type {number} */ (rect.Pitch), 8,
            32, 171);
        await run.call('UnlockRect texture', ()=>tex.UnlockRect(0));
        await drawQuad9(run, device, 'tex', tex, 0);
        await run.call('Release level', ()=>level.surface.release());
        /** @type {{ texture?: any }} */
        const cube = {};
        await run.call('CreateCubeTexture', ()=>device.CreateCubeTexture(4, 1, 0,
            D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, cube), [cube]);
        /** @type {{ surface?: any }} */
        const face = {};
        await run.call('GetCubeMapSurface', ()=>cube.texture.GetCubeMapSurface(FACE_NEGATIVE_X,
            0, face), [face]);
        await run.call('LockRect face', ()=>face.surface.LockRect(rect, null, 0), [rect]);
        fillRows(run, /** @type {number} */ (rect.pBits), /** @type {number} */ (rect.Pitch), 4,
            16, 172);
        await run.call('UnlockCubeRect', ()=>cube.texture.UnlockCubeRect(FACE_NEGATIVE_X, 0));
        await drawQuad9(run, device, 'cube', cube.texture, 0.25);
        /** @type {{ texture?: any }} */
        const volume = {};
        await run.call('CreateVolumeTexture', ()=>device.CreateVolumeTexture(4, 4, 2, 1, 0,
            D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, volume), [volume]);
        /** @type {{ volume?: any }} */
        const slice = {};
        await run.call('GetVolumeLevel', ()=>volume.texture.GetVolumeLevel(0, slice), [slice]);
        /** @type {{ pBits?: number }} */
        const box = {};
        await run.call('LockBox volume', ()=>slice.volume.LockBox(box, null, 0), [box]);
        fillRows(run, /** @type {number} */ (box.pBits), 16, 8, 16, 173);
        await run.call('UnlockBox texture', ()=>volume.texture.UnlockBox(0));
        await drawQuad9(run, device, 'volume', volume.texture, 0.5);
        await run.call('SetTexture none', ()=>device.SetTexture(0, null));
        for (const [name, object] of /** @type {[string, any][]} */ ([['face', face.surface],
            ['cube', cube.texture], ['slice', slice.volume], ['volume', volume.texture]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
    }));
});

// --- outside the contract: bytes written through a pointer after its unlock ---

/**
 * A frame of the static quad that samples `drawn`, with `between` run after
 * the setup and before the draws -- where a scenario writes through a pointer
 * it kept.
 *
 * @param {ReturnType<typeof runner>} run
 * @param {(parts: { device: any, vertices: any, indices: any, tex: any,
 *     texBits: number, indexBits: number, vertexBits: number }) => Promise<void>} between
 */
async function keptFrame(run, between){
    const { device, vertices, indices } = await device9(run);
    const tex = await makeTexture(run, device, 'tex', { levels: 1, seed: 150 });
    /** @type {{ pBits?: number, Pitch?: number }} */
    const where = {};
    await run.call('LockRect where', ()=>tex.LockRect(0, where, null, D3DLOCK.READONLY), [where]);
    await run.call('UnlockRect where', ()=>tex.UnlockRect(0));
    /** @type {{ pBits?: number }} */
    const indexWhere = {};
    await run.call('Lock indices where', ()=>indices.Lock(0, 0, indexWhere, D3DLOCK.READONLY),
        [indexWhere]);
    await run.call('Unlock indices where', ()=>indices.Unlock());
    /** @type {{ pBits?: number }} */
    const vertexWhere = {};
    await run.call('Lock vertices where', ()=>vertices.Lock(0, 0, vertexWhere, D3DLOCK.READONLY),
        [vertexWhere]);
    await run.call('Unlock vertices where', ()=>vertices.Unlock());
    await run.call('SetFVF', ()=>device.SetFVF(FVF_LIT));
    await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
    await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, 0, STRIDE));
    await run.call('SetIndices', ()=>device.SetIndices(indices));
    await run.call('BeginScene', ()=>device.BeginScene());
    await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
        0xff000000, 1, 0));
    await between({ device, vertices, indices, tex,
        texBits: /** @type {number} */ (where.pBits),
        indexBits: /** @type {number} */ (indexWhere.pBits),
        vertexBits: /** @type {number} */ (vertexWhere.pBits) });
    await run.call('EndScene', ()=>device.EndScene());
    await run.call('Present', ()=>device.Present());
    await run.call('idle', ()=>device.idle());
    await run.look('frame');
    for (const [name, object] of /** @type {[string, any][]} */ ([['tex', tex],
        ['vertices', vertices], ['indices', indices], ['device', device]]))
    {
        await run.call(`Release ${name}`, ()=>object.release());
    }
}

test('outside the contract: a texture written after its unlock, before the draw that first'
    + ' samples it, is drawn as written', async()=>{
    await same(9, run=>keptFrame(run, async({ device, tex, texBits })=>{
        await fillLevel(run, tex, 'tex again', 0, 151);
        fillRows(run, texBits, 32, 8, 32, 152);
        await drawQuad9(run, device, 'tex', tex, 0);
    }));
});

test('outside the contract: a texture written after its unlock and after a call that reads no'
    + ' texture of its own, before the draw that first samples it, is drawn as written',
async()=>{
    await same(9, run=>keptFrame(run, async({ device, tex, texBits })=>{
        await fillLevel(run, tex, 'tex again', 0, 153);
        await run.call('Clear again', ()=>device.Clear(0, null, D3DCLEAR.TARGET, 0xff000001, 1,
            0));
        fillRows(run, texBits, 32, 8, 32, 154);
        await drawQuad9(run, device, 'tex', tex, 0);
    }));
});

test('outside the contract: a vertex buffer written after its unlock is drawn as it was at the'
    + ' unlock', async()=>{
    await same(9, run=>keptFrame(run, async({ device, vertices, tex, vertexBits })=>{
        /** @type {{ pBits?: number }} */
        const locked = {};
        await run.call('Lock vertices', ()=>vertices.Lock(0, 0, locked, 0), [locked]);
        writeVertices(run, /** @type {number} */ (locked.pBits), 155);
        await run.call('Unlock vertices', ()=>vertices.Unlock());
        writeVertices(run, vertexBits, 156);
        await drawQuad9(run, device, 'list', tex, 0);
    }));
});

test('outside the contract: an index buffer written after its unlock, drawn as a strip the'
    + ' renderer reads out of guest memory at the draw, is drawn as written',
async()=>{
    await same(9, run=>keptFrame(run, async({ device, indices, tex, indexBits })=>{
        /** @type {{ pBits?: number }} */
        const locked = {};
        await run.call('Lock indices', ()=>indices.Lock(0, 0, locked, 0), [locked]);
        new Uint16Array(run.on.memory.ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE,
            4).set([0, 1, 2, 3]);
        await run.call('Unlock indices', ()=>indices.Unlock());
        new Uint16Array(run.on.memory.ram.buffer, indexBits - RAM_BASE, 4).set([3, 2, 1, 0]);
        await run.call('SetTexture', ()=>device.SetTexture(0, tex));
        await run.call('DrawIndexedPrimitive strip', ()=>device.DrawIndexedPrimitive(
            D3DPT.TRIANGLESTRIP, 0, 0, 4, 0, 2));
    }));
});

// --- Direct3D 8 ---

/**
 * A Direct3D 8 device, with a static vertex and index buffer of one quad.
 *
 * @param {ReturnType<typeof runner>} run @param {object} [parameters]
 */
async function device8(run, parameters = {}){
    /** @type {{ device?: any }} */
    const out = {};
    await run.call('CreateDevice', ()=>run.on.d3d.CreateDevice({ ...PARAMETERS, ...parameters },
        out), [out]);
    const device = out.device;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    await run.call('CreateVertexBuffer', ()=>device.CreateVertexBuffer(4 * STRIDE, 0, FVF_LIT,
        D3DPOOL.MANAGED, vertices), [vertices]);
    await run.call('CreateIndexBuffer', ()=>device.CreateIndexBuffer(12, 0, D3DFMT_INDEX.INDEX16,
        D3DPOOL.MANAGED, indices), [indices]);
    /** @type {{ pBits?: number }} */
    const locked = {};
    await run.call('Lock vertices', ()=>vertices.buffer.Lock(0, 0, locked, 0), [locked]);
    writeVertices(run, /** @type {number} */ (locked.pBits), 2);
    await run.call('Unlock vertices', ()=>vertices.buffer.Unlock());
    await run.call('Lock indices', ()=>indices.buffer.Lock(0, 0, locked, 0), [locked]);
    new Uint16Array(run.on.memory.ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE, 6)
        .set([0, 1, 2, 2, 1, 3]);
    await run.call('Unlock indices', ()=>indices.buffer.Unlock());
    await run.call('SetVertexShader', ()=>device.SetVertexShader(FVF_LIT));
    await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
    await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices.buffer, STRIDE));
    await run.call('SetIndices', ()=>device.SetIndices(indices.buffer, 0));
    return { device, vertices: vertices.buffer, indices: indices.buffer };
}

/**
 * @param {ReturnType<typeof runner>} run @param {any} device @param {string} label
 * @param {any} texture @param {number} shift
 */
async function drawQuad8(run, device, label, texture, shift){
    await run.call(`SetTexture ${label}`, ()=>device.SetTexture(0, texture));
    await run.call(`SetTransform ${label}`, ()=>device.SetTransform(D3DTS.WORLD, identity(shift)));
    await run.call(`DrawIndexedPrimitive ${label}`, ()=>device.DrawIndexedPrimitive(
        D3DPT.TRIANGLELIST, 0, 4, 0, 2));
}

test('Direct3D 8: buffers and textures locked every way, drawn, play what the device drew'
    + ' itself', async()=>{
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        /** @type {{ buffer?: any }} */
        const dynamic = {};
        await run.call('CreateVertexBuffer dynamic', ()=>device.CreateVertexBuffer(64 * STRIDE,
            D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_LIT, D3DPOOL.DEFAULT, dynamic), [dynamic]);
        const managed = await makeTexture(run, device, 'managed', { levels: 2, seed: 4 });
        const dynamicTexture = await makeTexture(run, device, 'dynamic texture', { levels: 1,
            seed: 6, usage: D3DUSAGE.DYNAMIC, pool: D3DPOOL.DEFAULT });
        for (let frame = 0; frame < 3; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff000020 + frame, 1, 0));
            await run.call('SetStreamSource static', ()=>device.SetStreamSource(0, vertices,
                STRIDE));
            await drawQuad8(run, device, `managed ${frame}`, managed, 0);
            await drawQuad8(run, device, `dynamic texture ${frame}`, dynamicTexture, 0.2);
            await run.call('SetStreamSource dynamic', ()=>device.SetStreamSource(0,
                dynamic.buffer, STRIDE));
            for (let quad = 0; quad < 3; quad++)
            {
                const flags = quad === 0 ? D3DLOCK.DISCARD : quad === 2 ? 0 : D3DLOCK.NOOVERWRITE;
                /** @type {{ pBits?: number }} */
                const locked = {};
                await run.call(`Lock dynamic ${frame}/${quad}`, ()=>dynamic.buffer.Lock(
                    quad * 4 * STRIDE, 4 * STRIDE, locked, flags), [locked]);
                writeVertices(run, /** @type {number} */ (locked.pBits), 5 * frame + quad + 3);
                await run.call(`Unlock dynamic ${frame}/${quad}`, ()=>dynamic.buffer.Unlock());
                await run.call(`SetIndices base ${frame}/${quad}`, ()=>device.SetIndices(indices,
                    quad * 4));
                await run.call(`DrawIndexedPrimitive dynamic ${frame}/${quad}`,
                    ()=>device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 4, 0, 2));
            }
            await run.call('DrawPrimitiveUP', ()=>device.DrawPrimitiveUP(D3DPT.TRIANGLESTRIP, 2,
                screenQuad(8, 8, 0xff40ff40), STRIDE_RHW));
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('Present', ()=>device.Present(null, null, 0, null));
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
            await fillLevel(run, managed, 'managed rect', 0, 50 + frame,
                { rect: { left: 1, top: 2, right: 7, bottom: 6 } });
            await fillLevel(run, dynamicTexture, 'dynamic discard', 0, 60 + frame,
                { flags: D3DLOCK.DISCARD });
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([['dynamic', dynamic.buffer],
            ['managed', managed], ['dynamic texture', dynamicTexture], ['vertices', vertices],
            ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 8: CopyRects, UpdateTexture and GetFrontBuffer, the moves made by the caller,'
    + ' play what the device drew itself and leave the program the same bytes', async()=>{
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        void vertices;
        void indices;
        const system = await makeTexture(run, device, 'system', { pool: D3DPOOL.SYSTEMMEM,
            levels: 2, seed: 21 });
        /** @type {{ texture?: any }} */
        const video = {};
        await run.call('CreateTexture video', ()=>device.CreateTexture(8, 8, 2, 0,
            D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, video), [video]);
        /** @type {{ moves?: any[] }} */
        let held = {};
        await run.call('UpdateTexture', ()=>device.UpdateTexture(system, video.texture, held));
        applyMoves(run, held);
        /** @type {{ surface?: any }} */
        const image = {};
        await run.call('CreateImageSurface', ()=>device.CreateImageSurface(8, 8, D3DFMT.A8R8G8B8,
            image), [image]);
        /** @type {{ pBits?: number, Pitch?: number }} */
        const rect = {};
        await run.call('LockRect image', ()=>image.surface.LockRect(rect, null, 0), [rect]);
        fillRows(run, /** @type {number} */ (rect.pBits), /** @type {number} */ (rect.Pitch), 8,
            32, 23);
        await run.call('UnlockRect image', ()=>image.surface.UnlockRect());
        /** @type {{ texture?: any }} */
        const managed = {};
        await run.call('CreateTexture managed', ()=>device.CreateTexture(8, 8, 1, 0,
            D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, managed), [managed]);
        /** @type {{ surface?: any }} */
        const managedLevel = {};
        await run.call('GetSurfaceLevel managed', ()=>managed.texture.GetSurfaceLevel(0,
            managedLevel), [managedLevel]);
        held = {};
        await run.call('CopyRects image into managed', ()=>device.CopyRects(image.surface,
            [{ left: 0, top: 0, right: 4, bottom: 4 }], 1, managedLevel.surface, [{ x: 4, y: 4 }],
            held));
        applyMoves(run, held);
        /** @type {{ surface?: any }} */
        const back = {};
        await run.call('GetBackBuffer', ()=>device.GetBackBuffer(0, 0, back), [back]);
        /** @type {{ surface?: any }} */
        const readBack = {};
        await run.call('CreateImageSurface read-back', ()=>device.CreateImageSurface(32, 32,
            D3DFMT.X8R8G8B8, readBack), [readBack]);
        /** @type {{ surface?: any }} */
        const front = {};
        await run.call('CreateImageSurface front', ()=>device.CreateImageSurface(32, 32,
            D3DFMT.A8R8G8B8, front), [front]);
        for (let frame = 0; frame < 2; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff302010 + frame, 1, 0));
            await drawQuad8(run, device, `video ${frame}`, video.texture, 0);
            await drawQuad8(run, device, `managed ${frame}`, managed.texture, 0.3);
            await run.call('EndScene', ()=>device.EndScene());
            held = {};
            await run.call('CopyRects back into read-back', ()=>device.CopyRects(back.surface,
                null, 0, readBack.surface, null, held));
            applyMoves(run, held);
            /** @type {{ pBits?: number, Pitch?: number }} */
            const pixels = {};
            await run.call('LockRect read-back', ()=>readBack.surface.LockRect(pixels, null,
                D3DLOCK.READONLY), [pixels]);
            run.bytes('read-back pixels', /** @type {number} */ (pixels.pBits), 32 * 32 * 4);
            await run.call('UnlockRect read-back', ()=>readBack.surface.UnlockRect());
            await run.call('Present', ()=>device.Present(null, null, 0, null));
            await run.call('idle', ()=>device.idle());
            await run.call('GetFrontBuffer', ()=>device.GetFrontBuffer(front.surface));
            /** @type {{ pBits?: number, Pitch?: number }} */
            const shown = {};
            await run.call('LockRect front', ()=>front.surface.LockRect(shown, null,
                D3DLOCK.READONLY), [shown]);
            run.bytes('front pixels', /** @type {number} */ (shown.pBits), 32 * 32 * 4);
            await run.call('UnlockRect front', ()=>front.surface.UnlockRect());
            await run.look(`frame ${frame}`);
            await fillLevel(run, system, 'system again', 1, 30 + frame);
            held = {};
            await run.call('UpdateTexture again', ()=>device.UpdateTexture(system, video.texture,
                held));
            applyMoves(run, held);
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([['system', system],
            ['video', video.texture], ['image', image.surface],
            ['managed level', managedLevel.surface], ['managed', managed.texture],
            ['back', back.surface], ['read-back', readBack.surface], ['front', front.surface],
            ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 8: state blocks, a Reset and the getters play what the device drew itself and'
    + ' answer the same', async()=>{
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        const tex = await makeTexture(run, device, 'tex', { seed: 8 });
        await run.call('BeginStateBlock', ()=>device.BeginStateBlock());
        await run.call('SetRenderState in block', ()=>device.SetRenderState(D3DRS.ZENABLE, 0));
        /** @type {{ handle?: number }} */
        const block = {};
        await run.call('EndStateBlock', ()=>device.EndStateBlock(block), [block]);
        /** @type {{ handle?: number }} */
        const all = {};
        await run.call('CreateStateBlock', ()=>device.CreateStateBlock(SBT_ALL, all), [all]);
        await run.call('BeginScene', ()=>device.BeginScene());
        await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
            0xff0a0b0c, 1, 0));
        await run.call('ApplyStateBlock', ()=>device.ApplyStateBlock(block.handle));
        await drawQuad8(run, device, 'with the block', tex, 0);
        await run.call('ApplyStateBlock all', ()=>device.ApplyStateBlock(all.handle));
        await drawQuad8(run, device, 'with all', tex, 0.4);
        await run.call('EndScene', ()=>device.EndScene());
        await run.call('Present', ()=>device.Present(null, null, 0, null));
        await run.call('idle', ()=>device.idle());
        /** @type {Record<string, any>} */
        const outs = {};
        await run.call('GetRenderState', ()=>device.GetRenderState(D3DRS.ZENABLE,
            outs.state = {}), [outs.state]);
        await run.call('GetViewport', ()=>device.GetViewport(outs.viewport = {}),
            [outs.viewport]);
        await run.call('GetAvailableTextureMem', ()=>device.GetAvailableTextureMem());
        await run.call('GetRenderTarget', ()=>device.GetRenderTarget(outs.target = {}),
            [outs.target]);
        await run.call('Release target', ()=>outs.target.surface.release());
        await run.look('frame');
        await run.call('DeleteStateBlock', ()=>device.DeleteStateBlock(block.handle));
        await run.call('DeleteStateBlock all', ()=>device.DeleteStateBlock(all.handle));
        await run.call('Reset', ()=>device.Reset({ ...PARAMETERS, backBufferWidth: 16,
            backBufferHeight: 16 }));
        await run.call('SetVertexShader', ()=>device.SetVertexShader(FVF_LIT));
        await run.call('SetRenderState LIGHTING', ()=>device.SetRenderState(D3DRS.LIGHTING, 0));
        await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, STRIDE));
        await run.call('SetIndices', ()=>device.SetIndices(indices, 0));
        await run.call('BeginScene again', ()=>device.BeginScene());
        await run.call('Clear again', ()=>device.Clear(0, null, D3DCLEAR.TARGET
            | D3DCLEAR.ZBUFFER, 0xff0c0b0a, 1, 0));
        await drawQuad8(run, device, 'after the reset', tex, 0);
        await run.call('EndScene again', ()=>device.EndScene());
        await run.call('Present again', ()=>device.Present(null, null, 0, null));
        await run.call('idle again', ()=>device.idle());
        await run.look('after the reset');
        for (const [name, object] of /** @type {[string, any][]} */ ([['tex', tex],
            ['vertices', vertices], ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

/** D3DVSD_STREAM(index). */
const vsdStream = (/** @type {number} */ index)=>(0x20000000 | index) >>> 0;
/** D3DVSD_REG(register, type). */
const vsdRegister = (/** @type {number} */ register, /** @type {number} */ type)=>
    (0x40000000 | (type << 16) | register) >>> 0;

/** Position and colour from stream zero, c4 loaded by the declaration. */
const DECLARATION_8 = [
    vsdStream(0), vsdRegister(0, 2), vsdRegister(5, 4),
    0x82000004, 0x3f000000, 0x3f000000, 0x3f000000, 0x3f800000,
    0xffffffff,
];

/** vs_1_1: m4x4 oPos, v0, c0; mul oD0, v5, c4. */
const SHADER_8 = [
    0xfffe0101,
    0x00000014, 0xc00f0000, 0x90e40000, 0xa0e40000,
    0x00000005, 0xd00f0000, 0x90e40005, 0xa0e40004,
    0x0000ffff,
];

test('Direct3D 8: a vertex shader by its handle, its constants set between the draws, plays'
    + ' what the device drew itself', async()=>{
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        /** @type {{ handle?: number }} */
        const shader = {};
        await run.call('CreateVertexShader', ()=>device.CreateVertexShader(DECLARATION_8,
            SHADER_8, shader), [shader]);
        await run.call('SetVertexShader handle', ()=>device.SetVertexShader(shader.handle));
        await run.call('SetTextureStageState COLOROP', ()=>device.SetTextureStageState(0,
            D3DTSS.COLOROP, 3));
        await run.call('SetStreamSource', ()=>device.SetStreamSource(0, vertices, STRIDE));
        for (let frame = 0; frame < 2; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
                0xff000000 + frame, 1, 0));
            for (let draw = 0; draw < 2; draw++)
            {
                await run.call(`SetVertexShaderConstant ${draw}`, ()=>device
                    .SetVertexShaderConstant(0, identity(draw / 4 + frame / 8), 4));
                await run.call(`DrawIndexedPrimitive ${draw}`, ()=>device.DrawIndexedPrimitive(
                    D3DPT.TRIANGLELIST, 0, 4, 0, 2));
            }
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('Present', ()=>device.Present(null, null, 0, null));
            await run.call('idle', ()=>device.idle());
            await run.look(`frame ${frame}`);
        }
        await run.call('SetVertexShader fixed', ()=>device.SetVertexShader(FVF_LIT));
        await run.call('DeleteVertexShader', ()=>device.DeleteVertexShader(shader.handle));
        for (const [name, object] of /** @type {[string, any][]} */ ([['vertices', vertices],
            ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 9: a texture unlocked, then bound by a state block\'s Apply and drawn, is drawn as'
    + ' written', async()=>{
    // The bytes wait for the first draw that samples the texture; Apply binds
    // it without naming it, and the draw after must still find them sent.
    await same(9, run=>keptFrame(run, async({ device, tex })=>{
        const other = await makeTexture(run, device, 'other', { levels: 1, seed: 160 });
        await run.call('BeginStateBlock', ()=>device.BeginStateBlock());
        await run.call('SetTexture other in block', ()=>device.SetTexture(0, other));
        /** @type {{ block?: any }} */
        const recorded = {};
        await run.call('EndStateBlock', ()=>device.EndStateBlock(recorded), [recorded]);
        await drawQuad9(run, device, 'tex', tex, 0);
        await fillLevel(run, other, 'other again', 0, 161);
        await run.call('Clear again', ()=>device.Clear(0, null, D3DCLEAR.TARGET, 0xff000002, 1,
            0));
        await run.call('Apply', ()=>recorded.block.Apply());
        await run.call('DrawIndexedPrimitive other', ()=>device.DrawIndexedPrimitive(
            D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
        await run.call('Release block', ()=>recorded.block.release());
        await run.call('Release other', ()=>other.release());
    }));
});

test('Direct3D 9: a texture unlocked and copied from through its level is copied as written',
    async()=>{
        // A copy names the level, not the texture the bytes wait on.
        await same(9, run=>keptFrame(run, async({ device, tex })=>{
            const source = await makeTexture(run, device, 'source', { levels: 1, seed: 170,
                pool: D3DPOOL.SYSTEMMEM });
            /** @type {{ surface?: any }} */
            const level = {};
            await run.call('GetSurfaceLevel source', ()=>source.GetSurfaceLevel(0, level),
                [level]);
            await fillLevel(run, source, 'source again', 0, 171);
            await run.call('Clear again', ()=>device.Clear(0, null, D3DCLEAR.TARGET, 0xff000003,
                1, 0));
            /** @type {{ surface?: any }} */
            const into = {};
            await run.call('GetSurfaceLevel tex', ()=>tex.GetSurfaceLevel(0, into), [into]);
            await run.call('UpdateSurface', ()=>device.UpdateSurface(level.surface, null,
                into.surface, null));
            await drawQuad9(run, device, 'tex', tex, 0);
            await run.call('Release into', ()=>into.surface.release());
            await run.call('Release level', ()=>level.surface.release());
            await run.call('Release source', ()=>source.release());
        }));
    });

test('outside the contract: a texture written after its unlock and after a draw that does not'
    + ' sample it, before the draw that does, is drawn as written', async()=>{
    await same(9, run=>keptFrame(run, async({ device, tex, texBits })=>{
        await fillLevel(run, tex, 'tex again', 0, 180);
        await run.call('SetTexture none', ()=>device.SetTexture(0, null));
        await run.call('DrawIndexedPrimitive untextured', ()=>device.DrawIndexedPrimitive(
            D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
        fillRows(run, texBits, 32, 8, 32, 181);
        await drawQuad9(run, device, 'tex', tex, 0);
    }));
});

test('outside the contract: a level written after its surface\'s unlock and after a call that'
    + ' reads no texture, before the draw that samples it, is drawn as written', async()=>{
    // Unlocked through its own surface, the level's bytes are the texture's
    // all the same, and wait for the draw as the texture's do.
    await same(9, run=>keptFrame(run, async({ device, tex, texBits })=>{
        /** @type {{ surface?: any }} */
        const level = {};
        await run.call('GetSurfaceLevel', ()=>tex.GetSurfaceLevel(0, level), [level]);
        /** @type {{ pBits?: number, Pitch?: number }} */
        const rect = {};
        await run.call('LockRect level', ()=>level.surface.LockRect(rect, null, 0), [rect]);
        fillRows(run, texBits, 32, 8, 32, 190);
        await run.call('UnlockRect level', ()=>level.surface.UnlockRect());
        await run.call('Clear again', ()=>device.Clear(0, null, D3DCLEAR.TARGET, 0xff000004, 1,
            0));
        fillRows(run, texBits, 32, 8, 32, 191);
        await drawQuad9(run, device, 'tex', tex, 0);
        await run.call('Release level', ()=>level.surface.release());
    }));
});

test('Direct3D 8: a Reset across a large change of size, with default-pool resources bound,'
    + ' released and held, answers the same on both sides', async()=>{
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        /** @type {{ buffer?: any }} */
        const dynamic = {};
        await run.call('CreateVertexBuffer default', ()=>device.CreateVertexBuffer(4 * STRIDE,
            D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_LIT, D3DPOOL.DEFAULT, dynamic), [dynamic]);
        /** @type {{ texture?: any }} */
        const target = {};
        await run.call('CreateTexture target', ()=>device.CreateTexture(16, 16, 1,
            D3DUSAGE.RENDERTARGET, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, target), [target]);
        /** @type {{ surface?: any }} */
        const level = {};
        await run.call('GetSurfaceLevel', ()=>target.texture.GetSurfaceLevel(0, level), [level]);
        await run.call('SetStreamSource default', ()=>device.SetStreamSource(0, dynamic.buffer,
            STRIDE));
        await run.call('SetTexture target', ()=>device.SetTexture(0, target.texture));
        /** @type {Record<string, any>} */
        const implicit = {};
        await run.call('GetBackBuffer', ()=>device.GetBackBuffer(0, 0, implicit.back = {}),
            [implicit.back]);
        await run.call('GetDepthStencilSurface', ()=>device.GetDepthStencilSurface(
            implicit.depth = {}), [implicit.depth]);
        // Held: refused alike.
        await run.call('Reset held', ()=>device.Reset({ ...PARAMETERS, backBufferWidth: 640,
            backBufferHeight: 480 }));
        await run.call('TestCooperativeLevel held', ()=>device.TestCooperativeLevel());
        await run.call('Release back', ()=>implicit.back.surface.release());
        await run.call('Release depth', ()=>implicit.depth.surface.release());
        await run.call('Release level', ()=>level.surface.release());
        await run.call('Release target', ()=>target.texture.release());
        await run.call('Release default', ()=>dynamic.buffer.release());
        // Released but still bound.
        await run.call('Reset bound', ()=>device.Reset({ ...PARAMETERS, backBufferWidth: 1600,
            backBufferHeight: 1200 }));
        await run.call('TestCooperativeLevel bound', ()=>device.TestCooperativeLevel());
        await run.call('SetStreamSource managed', ()=>device.SetStreamSource(0, vertices, STRIDE));
        await run.call('SetTexture none', ()=>device.SetTexture(0, null));
        await run.call('Reset unbound', ()=>device.Reset({ ...PARAMETERS, backBufferWidth: 1600,
            backBufferHeight: 1200 }));
        await run.call('TestCooperativeLevel', ()=>device.TestCooperativeLevel());
        await run.call('SetIndices', ()=>device.SetIndices(indices, 0));
        await run.call('BeginScene', ()=>device.BeginScene());
        await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
            0xff0a0b0c, 1, 0));
        await run.call('EndScene', ()=>device.EndScene());
        await run.call('Present', ()=>device.Present(null, null, 0, null));
        await run.call('idle', ()=>device.idle());
        await run.look('after the reset');
        for (const [name, object] of /** @type {[string, any][]} */ ([['vertices', vertices],
            ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 8: a Reset after render targets, a state block and surfaces of its own were made,'
    + ' bound and released answers the same on both sides', async()=>{
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        /** @type {{ texture?: any }} */
        const target = {};
        await run.call('CreateTexture target', ()=>device.CreateTexture(16, 16, 1,
            D3DUSAGE.RENDERTARGET, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, target), [target]);
        /** @type {{ surface?: any }} */
        const level = {};
        await run.call('GetSurfaceLevel', ()=>target.texture.GetSurfaceLevel(0, level), [level]);
        /** @type {{ surface?: any }} */
        const depth = {};
        await run.call('CreateDepthStencilSurface', ()=>device.CreateDepthStencilSurface(16, 16,
            D3DFMT.D24S8, depth), [depth]);
        /** @type {{ surface?: any }} */
        const lone = {};
        await run.call('CreateRenderTarget', ()=>device.CreateRenderTarget(16, 16, D3DFMT.X8R8G8B8,
            0, lone), [lone]);
        /** @type {Record<string, any>} */
        const old = {};
        await run.call('GetRenderTarget', ()=>device.GetRenderTarget(old.target = {}),
            [old.target]);
        await run.call('GetDepthStencilSurface', ()=>device.GetDepthStencilSurface(
            old.depth = {}), [old.depth]);
        await run.call('SetRenderTarget level', ()=>device.SetRenderTarget(level.surface,
            depth.surface));
        await run.call('SetTexture target', ()=>device.SetTexture(1, target.texture));
        /** @type {{ handle?: number }} */
        const all = {};
        await run.call('CreateStateBlock', ()=>device.CreateStateBlock(SBT_ALL, all), [all]);
        await run.call('Clear target', ()=>device.Clear(0, null, D3DCLEAR.TARGET, 0xff203040,
            1, 0));
        await run.call('SetRenderTarget back', ()=>device.SetRenderTarget(old.target.surface,
            old.depth.surface));
        await run.call('SetTexture none', ()=>device.SetTexture(1, null));
        await run.call('Release old target', ()=>old.target.surface.release());
        await run.call('Release old depth', ()=>old.depth.surface.release());
        await run.call('Reset with a state block', ()=>device.Reset({ ...PARAMETERS,
            backBufferWidth: 1280, backBufferHeight: 1024 }));
        await run.call('DeleteStateBlock', ()=>device.DeleteStateBlock(all.handle));
        await run.call('Reset without', ()=>device.Reset({ ...PARAMETERS, backBufferWidth: 1280,
            backBufferHeight: 1024 }));
        for (const [name, object] of /** @type {[string, any][]} */ ([['level', level.surface],
            ['target', target.texture], ['depth', depth.surface], ['lone', lone.surface]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.call('Reset released', ()=>device.Reset({ ...PARAMETERS, backBufferWidth: 1280,
            backBufferHeight: 1024 }));
        await run.call('TestCooperativeLevel', ()=>device.TestCooperativeLevel());
        await run.call('BeginScene', ()=>device.BeginScene());
        await run.call('Clear', ()=>device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER,
            0xff0a0b0c, 1, 0));
        await run.call('EndScene', ()=>device.EndScene());
        await run.call('Present', ()=>device.Present(null, null, 0, null));
        await run.call('idle', ()=>device.idle());
        await run.look('after the reset');
        for (const [name, object] of /** @type {[string, any][]} */ ([['vertices', vertices],
            ['indices', indices], ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 8: a small target read back every frame, drawn into only now and then, leaves'
    + ' the program the same bytes on both sides', async()=>{
    // A GPU fence as a program makes one: a render target nothing draws into
    // most frames, copied into an image surface and locked to read each frame.
    // The recording answers the copy from the target's own memory while
    // nothing has touched the target since the last read-back; the bytes have
    // to be what the renderer would have answered.
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        /** @type {{ surface?: any }} */
        const fence = {};
        await run.call('CreateRenderTarget fence', ()=>device.CreateRenderTarget(16, 16,
            D3DFMT.X8R8G8B8, 0, fence), [fence]);
        /** @type {{ surface?: any }} */
        const image = {};
        await run.call('CreateImageSurface', ()=>device.CreateImageSurface(16, 16,
            D3DFMT.X8R8G8B8, image), [image]);
        /** @type {Record<string, any>} */
        const old = {};
        await run.call('GetRenderTarget', ()=>device.GetRenderTarget(old.target = {}),
            [old.target]);
        for (let frame = 0; frame < 5; frame++)
        {
            await run.call('BeginScene', ()=>device.BeginScene());
            // Frames 0 and 3 clear the fence, each in its own colour; the
            // rest only name it and name the back buffer again.
            await run.call('SetRenderTarget fence', ()=>device.SetRenderTarget(fence.surface,
                null));
            if (frame === 0 || frame === 3)
            {
                await run.call('Clear fence', ()=>device.Clear(0, null, D3DCLEAR.TARGET,
                    0xff102030 + frame * 0x010101, 1, 0));
            }
            await run.call('SetRenderTarget back', ()=>device.SetRenderTarget(old.target.surface,
                null));
            await run.call('Clear back', ()=>device.Clear(0, null, D3DCLEAR.TARGET,
                0xff405060 + frame, 1, 0));
            await run.call('EndScene', ()=>device.EndScene());
            /** @type {{ moves?: any[] }} */
            const held = {};
            await run.call('CopyRects fence', ()=>device.CopyRects(fence.surface, null, 0,
                image.surface, null, held));
            applyMoves(run, held);
            /** @type {{ pBits?: number, Pitch?: number }} */
            const pixels = {};
            await run.call('LockRect image', ()=>image.surface.LockRect(pixels, null,
                D3DLOCK.READONLY), [pixels]);
            run.bytes(`fence ${frame}`, /** @type {number} */ (pixels.pBits), 16 * 16 * 4);
            await run.call('UnlockRect image', ()=>image.surface.UnlockRect());
            await run.call('Present', ()=>device.Present(null, null, 0, null));
            await run.call('idle', ()=>device.idle());
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([
            ['old target', old.target.surface], ['image', image.surface],
            ['fence', fence.surface], ['vertices', vertices], ['indices', indices],
            ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});

test('Direct3D 8: a target drawn into every frame and read back the frame after leaves the'
    + ' program the same bytes on both sides', async()=>{
    // The order a fence keeps: the copy of what the frame before drew, then
    // the frame's own drawing into it -- every copy the renderer's to answer.
    await same(8, async run=>{
        const { device, vertices, indices } = await device8(run);
        /** @type {{ surface?: any }} */
        const fence = {};
        await run.call('CreateRenderTarget fence', ()=>device.CreateRenderTarget(16, 16,
            D3DFMT.X8R8G8B8, 0, fence), [fence]);
        /** @type {{ surface?: any }} */
        const image = {};
        await run.call('CreateImageSurface', ()=>device.CreateImageSurface(16, 16,
            D3DFMT.X8R8G8B8, image), [image]);
        /** @type {Record<string, any>} */
        const old = {};
        await run.call('GetRenderTarget', ()=>device.GetRenderTarget(old.target = {}),
            [old.target]);
        for (let frame = 0; frame < 6; frame++)
        {
            /** @type {{ moves?: any[] }} */
            const held = {};
            await run.call('CopyRects fence', ()=>device.CopyRects(fence.surface, null, 0,
                image.surface, null, held));
            applyMoves(run, held);
            /** @type {{ pBits?: number, Pitch?: number }} */
            const pixels = {};
            await run.call('LockRect image', ()=>image.surface.LockRect(pixels, null,
                D3DLOCK.READONLY), [pixels]);
            run.bytes(`fence ${frame}`, /** @type {number} */ (pixels.pBits), 16 * 16 * 4);
            await run.call('UnlockRect image', ()=>image.surface.UnlockRect());
            await run.call('BeginScene', ()=>device.BeginScene());
            await run.call('SetRenderTarget fence', ()=>device.SetRenderTarget(fence.surface,
                null));
            await run.call('Clear fence', ()=>device.Clear(0, null, D3DCLEAR.TARGET,
                0xff000000 + frame * 0x030507, 1, 0));
            await run.call('SetRenderTarget back', ()=>device.SetRenderTarget(old.target.surface,
                null));
            await run.call('EndScene', ()=>device.EndScene());
            await run.call('Present', ()=>device.Present(null, null, 0, null));
            await run.call('idle', ()=>device.idle());
        }
        for (const [name, object] of /** @type {[string, any][]} */ ([
            ['old target', old.target.surface], ['image', image.surface],
            ['fence', fence.surface], ['vertices', vertices], ['indices', indices],
            ['device', device]]))
        {
            await run.call(`Release ${name}`, ()=>object.release());
        }
        await run.look('end');
    });
});
