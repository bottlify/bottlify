/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The OpenGL command ring's contract, as a gate: a call a routine takes into
 * the calling thread's context's ring in the guest must leave the context
 * exactly as the same call made through its export at once would. A GL call
 * that is an error does not fail, it sets the error flag, so the flag
 * `glGetError` answers next is part of what the call leaves -- and so is a
 * call inside glBegin/glEnd that is an error there, and one made with no
 * context current, which does nothing.
 *
 * Every case is made twice, on two libraries over the same guest memory: on
 * one through the export's handler, as a program gets it with no routine in
 * front of it; on the other by the routine the seam places, run by the real
 * processor with the calling thread's TEB behind `fs:` -- and, where the
 * routine leaves the call to its trap, through the handler with the words
 * the trap finds on the stack. Then the error flag is read through the
 * export on each, and every piece of state a getter reaches is read off each
 * context and compared.
 *
 * The table names every call the ring carries, so a call added to it without
 * its cases here fails too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { TEB_GL_CONTEXT, commandCode } from '../seam/shadow.js';
import { GL_COMMANDS } from './commands.js';
import { createOpengl } from './exports.js';
import { GL } from './constants.js';

const PROGRAM = 0x8000;
const TRAP = 0x8e00;
const ROUTINE = 0x9000;
/** Each thread's TEB: the slot its routines find their block in is TEB_GL_CONTEXT on. */
const TEBS = [0x20000, 0x22000];
/** What the call under test points at, and what a setup step does. */
const DATA = 0x30000;
const SETUP = 0x38000;
/** Where a getter answers, one place per library so the two answers can be compared. */
const OUT = [0x3c000, 0x3e000];
/** Where each library makes its rings, frames and strings. */
const SCRATCH = { direct: 0x100000, ring: 0x400000, bytes: 0x300000 };
const STACK = 0x0f0000;
const HDC = 0x900d;
const SIDE = 8;
/** A double-buffered format with depth and stencil, so a clear of either has a buffer to reach. */
const FORMAT = 9;

/** What the callee keeps for its caller, each with a value the routine must give back. */
const KEPT = /** @type {const} */ ([['ebx', 0x0b0b0b0b], ['esi', 0x05050505],
    ['edi', 0x0d0d0d0d], ['ebp', 0x0e0e0e0e]]);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const bits = new DataView(new ArrayBuffer(8));
/** A float's dword. @param {number} value */
const f = value=>{
    bits.setFloat32(0, value, true);
    return bits.getUint32(0, true);
};
/** A double's two dwords, low first. @param {number} value @returns {[number, number]} */
const d = value=>{
    bits.setFloat64(0, value, true);
    return [bits.getUint32(0, true), bits.getUint32(4, true)];
};
/** @param {number[]} values  floats as their dwords */
const floats = values=>values.map(f);

/**
 * One call under test: its arguments -- 'data' is the address of `data`,
 * dwords or bytes -- the steps made through the exports first, on both
 * libraries alike, and what the error flag must then answer. `inside` makes
 * it between glBegin and glEnd, `current: false` with no context current.
 *
 * @typedef {{ label: string, args: (number | 'data')[], data?: number[] | Uint8Array,
 *     before?: (gl: Gl) => void, error?: number, inside?: boolean, current?: boolean }} Case
 */

/**
 * A setup step, made through an export's handler: the words it pops, and
 * `put` the address of bytes or dwords it is given.
 *
 * @typedef {{ (name: string, ...args: number[]): number,
 *     put: (data: number[] | Uint8Array) => number }} Gl
 */

/** @typedef {Record<string, { argBytes: number, handler: (args: number[]) => any }>} Table */

/**
 * The processor, with every unbroken routine's trap a `hlt`, and the two
 * threads' TEBs.
 */
const machine = ()=>{
    const host = createCorkHost({
        memorySize: 16 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    const layout = host.blockLayout();
    const block = host.block();
    const state = new DataView(block.buffer, block.byteOffset, block.byteLength);
    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @type {Map<string, Uint8Array>} */
    const routines = new Map();
    /**
     * Runs the routine the seam places for `name` on `thread`, with `args`
     * pushed as a program pushes them: the words the trap found on the stack
     * when the routine left the call to it, or null when it took the call.
     *
     * @param {string} name @param {number[]} args @param {number} thread
     * @returns {number[] | null}
     */
    const run = (name, args, thread)=>{
        let routine = routines.get(name);
        if (!routine)
        {
            routine = commandCode(ROUTINE, TRAP, { ...GL_COMMANDS.COMMANDS[name],
                slot: GL_COMMANDS.commandSlot(name), thread: true });
            routines.set(name, routine);
        }
        host.writePhysical(ROUTINE, routine);
        /** @type {number[]} */
        const code = [];
        for (const value of [...args].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        code.push(0xe8, ...u32((ROUTINE - (PROGRAM + code.length + 5)) | 0), 0xf4);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        state.setUint32(layout.fsBase, TEBS[thread], true);
        for (const [register, value] of KEPT)
        {
            host.writeReg32(register, value);
        }
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(1000000);
        for (const [register, value] of KEPT)
        {
            assert.equal(host.readReg32(register) >>> 0, value, `${name} keeps ${register}`);
        }
        if (host.readReg32('eip') === TRAP + 1)
        {
            const esp = host.readReg32('esp') >>> 0;
            assert.equal(esp, STACK - 4 * args.length - 4,
                `${name} leaves its trap the frame it was called with`);
            return args.map((unused, i)=>read(esp + 4 + 4 * i));
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length, `${name} returned`);
        assert.equal(host.readReg32('esp') >>> 0, STACK, `${name} popped what its export pops`);
        return null;
    };
    return { host, run };
};

/**
 * The two libraries over one machine's memory: `direct` with no TEB, so
 * nothing places a block for a routine and every call is its handler's, and
 * `ring` whose contexts the routines write -- the TEB the calling thread
 * runs on, as the bridge reports it. `thread` is the calling thread on both.
 *
 * @param {ReturnType<typeof machine>} processor
 */
const pair = processor=>{
    const { host } = processor;
    /** @type {{ thread: number }} */
    const calling = { thread: 0 };
    /**
     * @param {number} from  where its scratch starts
     * @param {boolean} routines
     */
    const library = (from, routines)=>{
        let next = from;
        /** @type {string[]} */
        const divergences = [];
        const opengl = createOpengl({
            readMemory: (at, length)=>host.readPhysical(at >>> 0, length).slice(),
            windowMemory: (at, length)=>host.readPhysical(at >>> 0, length),
            writeMemory: (at, bytes)=>host.writePhysical(at >>> 0, bytes),
            screen: ()=>({ width: SIDE, height: SIDE }),
            currentThread: ()=>calling.thread + 1,
            currentTeb: routines ? ()=>TEBS[calling.thread] : undefined,
            scratch: { allocate: bytes=>{
                const at = next;
                next += (bytes + 0xfff) & ~0xfff;
                assert.ok(next <= from + SCRATCH.bytes, 'the scratch holds what is made');
                return at;
            } },
            divergence: (api, detail)=>divergences.push(detail),
        });
        const table = /** @type {Table} */ (/** @type {unknown} */ (opengl.table));
        let putAt = SETUP;
        /** @type {Gl} */
        const gl = Object.assign((/** @type {string} */ name, /** @type {number[]} */ ...args)=>
            table[name].handler(args.map(arg=>arg >>> 0)), {
            /** @param {number[] | Uint8Array} data */
            put: (/** @type {number[] | Uint8Array} */ data)=>{
                const bytes = data instanceof Uint8Array ? data
                    : new Uint8Array(new Uint32Array(data).buffer);
                const at = putAt;
                host.writePhysical(at, bytes);
                putAt += (bytes.length + 15) & ~15;
                return at;
            },
        });
        return { opengl, table, gl, divergences, reset: ()=>{
            putAt = SETUP;
        } };
    };
    const direct = library(SCRATCH.direct, false);
    const ring = library(SCRATCH.ring, true);
    host.writePhysical(TEBS[0] + TEB_GL_CONTEXT, new Uint8Array(4));
    /** Each library's context, current on the first thread. @type {number[]} */
    const handles = [];
    for (const side of [direct, ring])
    {
        assert.equal(side.gl('wglSetPixelFormat', HDC, FORMAT, 0), 1);
        const handle = side.gl('wglCreateContext', HDC);
        assert.notEqual(handle, 0);
        assert.equal(side.gl('wglMakeCurrent', HDC, handle), 1);
        handles.push(handle);
        // Only the ring's side places a block where the routines look for one.
        const slot = /** @type {Uint8Array} */ (host.readPhysical(TEBS[0] + TEB_GL_CONTEXT, 4));
        assert.equal(slot.some(byte=>byte !== 0), side === ring);
    }
    return { direct, ring, calling, handles };
};

/** Every GL enumerant there is, each once: what a getter is asked over. */
const ENUMS = [...new Set(Object.values(GL).map(value=>value >>> 0))].sort((a, b)=>a - b);

/**
 * Everything of a context a program can read, read through its getters -- an
 * error a query raises cleared and kept as part of it -- in an order both
 * contexts are read in alike: the queries, the capabilities and the pointers;
 * per texture unit the environment, generation and the bound texture's
 * parameters; the generic attributes, the program parameters, the bound
 * buffers' bytes, the picture, and the matrix stacks popped to the bottom.
 *
 * @param {any} context
 * @returns {unknown[]}
 */
function snapshot(context){
    /** @type {unknown[]} */
    const out = [];
    /** @param {string} what @param {unknown} value */
    const keep = (what, value)=>{
        const error = context.glGetError();
        out.push([what, ArrayBuffer.isView(value) ? [.../** @type {any} */ (value)] : value,
            error]);
    };
    for (const query of ENUMS)
    {
        keep(`float ${query}`, context.glGetFloatv(query));
        keep(`enabled ${query}`, context.glIsEnabled(query));
        keep(`pointer ${query}`, context.glGetPointerv(query));
    }
    for (let unit = 0; unit < 4; unit++)
    {
        context.glActiveTextureARB(GL.TEXTURE0 + unit);
        context.glClientActiveTextureARB(GL.TEXTURE0 + unit);
        for (const query of ENUMS)
        {
            keep(`unit ${unit} ${query}`, context.glGetFloatv(query));
            keep(`unit ${unit} pointer ${query}`, context.glGetPointerv(query));
            keep(`env ${unit} ${query}`, context.glGetTexEnvfv(GL.TEXTURE_ENV, query));
            keep(`parameter ${unit} ${query}`, context.glGetTexParameterfv(GL.TEXTURE_2D, query));
        }
        for (const coord of [GL.S, GL.T, GL.R, GL.Q])
        {
            for (const parameter of [GL.TEXTURE_GEN_MODE, GL.OBJECT_PLANE, GL.EYE_PLANE])
            {
                keep(`gen ${unit} ${coord} ${parameter}`, context.glGetTexGenfv(coord, parameter));
            }
        }
    }
    const attributes = [GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB, GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB,
        GL.VERTEX_ATTRIB_ARRAY_STRIDE_ARB, GL.VERTEX_ATTRIB_ARRAY_TYPE_ARB,
        GL.VERTEX_ATTRIB_ARRAY_NORMALIZED_ARB, GL.CURRENT_VERTEX_ATTRIB_ARB];
    for (let index = 0; index < 17; index++)
    {
        for (const parameter of attributes)
        {
            keep(`attribute ${index} ${parameter}`,
                context.glGetVertexAttribfvARB(index, parameter));
        }
        keep(`attribute ${index} pointer`, context.glGetVertexAttribPointervARB(index,
            GL.VERTEX_ATTRIB_ARRAY_POINTER_ARB));
    }
    for (const target of [GL.VERTEX_PROGRAM_ARB, GL.FRAGMENT_PROGRAM_ARB])
    {
        for (let index = 0; index < 257; index++)
        {
            keep(`env ${target} ${index}`, context.glGetProgramEnvParameterfvARB(target, index));
            keep(`local ${target} ${index}`,
                context.glGetProgramLocalParameterfvARB(target, index));
        }
    }
    for (const target of [GL.ARRAY_BUFFER, GL.ELEMENT_ARRAY_BUFFER])
    {
        for (const parameter of [GL.BUFFER_SIZE, GL.BUFFER_USAGE, GL.BUFFER_MAPPED])
        {
            keep(`buffer ${target} ${parameter}`,
                context.glGetBufferParameterivARB(target, parameter));
        }
        const size = context.glGetBufferParameterivARB(target, GL.BUFFER_SIZE)?.[0] ?? 0;
        context.glGetError();
        keep(`buffer ${target} bytes`, context.glGetBufferSubDataARB(target, 0, size));
    }
    keep('colour', context.glReadPixels(0, 0, SIDE, SIDE, GL.RGBA, GL.UNSIGNED_BYTE));
    keep('depth', context.glReadPixels(0, 0, SIDE, SIDE, GL.DEPTH_COMPONENT, GL.FLOAT));
    keep('stencil', context.glReadPixels(0, 0, SIDE, SIDE, GL.STENCIL_INDEX, GL.UNSIGNED_BYTE));
    keep('surface', context.framebuffer.bytes);
    keep('surface depth', context.framebuffer.depth);
    context.glActiveTextureARB(GL.TEXTURE0);
    for (const [mode, query] of [[GL.MODELVIEW, GL.MODELVIEW_MATRIX],
        [GL.PROJECTION, GL.PROJECTION_MATRIX], [GL.TEXTURE, GL.TEXTURE_MATRIX]])
    {
        context.glMatrixMode(mode);
        for (let depth = 0; depth < 40; depth++)
        {
            keep(`stack ${mode} ${depth}`, context.glGetFloatv(query));
            context.glPopMatrix();
            if (context.glGetError() !== GL.NO_ERROR)
            {
                break;
            }
        }
    }
    return out;
}

/**
 * The calls GL takes between glBegin and glEnd, of the ones the ring carries:
 * any other there is GL_INVALID_OPERATION. The client side's -- arrays,
 * buffers -- are only compared: the specification leaves it open whether one
 * made there is an error.
 */
const INSIDE_TAKEN = /^gl(Vertex[234]f|Color[34]u?[bf]|TexCoord2f|Normal3f|End$)/;
const CLIENT_SIDE =
    /^gl(.*Pointer|.*ClientState|ClientActiveTexture|.*VertexAttribArray|Buffer|BindBuffer)/;

/**
 * Makes every case of every call on a fresh pair of contexts, and says which
 * left the two contexts different.
 *
 * @param {Record<string, Case[]>} table
 * @returns {{ wrong: string[], taken: Set<string> }}
 */
function gate(table){
    const processor = machine();
    /** @type {string[]} */
    const wrong = [];
    /** @type {Set<string>} */
    const taken = new Set();
    for (const [name, cases] of Object.entries(table))
    {
        const first = cases[0];
        const all = [
            ...cases,
            // Every call between glBegin and glEnd, and with no context current.
            { ...first, label: `${first.label}, inside glBegin/glEnd`, inside: true,
                error: name === 'glEnd' ? GL.NO_ERROR : INSIDE_TAKEN.test(name)
                    ? first.error : CLIENT_SIDE.test(name) ? undefined : GL.INVALID_OPERATION },
            { ...first, label: `${first.label}, with no context current`, current: false,
                error: GL.INVALID_OPERATION },
        ];
        for (const one of all)
        {
            const outcome = once(processor, name, one);
            if (outcome.taken)
            {
                taken.add(name);
            }
            wrong.push(...outcome.wrong);
        }
    }
    return { wrong, taken };
}

/**
 * One case on a fresh pair: what differed, and whether the routine took the
 * call into the ring.
 *
 * @param {ReturnType<typeof machine>} processor @param {string} name @param {Case} one
 * @returns {{ wrong: string[], taken: boolean }}
 */
function once(processor, name, one){
    const { direct, ring, handles } = pair(processor);
    const { label, args, data = [], before, error, inside = false, current = true } = one;
    /** @type {string[]} */
    const wrong = [];
    const where = `${name} (${label})`;
    for (const side of [direct, ring])
    {
        side.reset();
        before?.(side.gl);
        if (inside)
        {
            side.gl('glBegin', GL.TRIANGLES);
        }
        side.gl('glGetError');
        if (!current)
        {
            assert.equal(side.gl('wglMakeCurrent', HDC, 0), 1);
        }
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(new Uint32Array(data).buffer);
    processor.host.writePhysical(DATA, bytes);
    const values = args.map(arg=>(arg === 'data' ? DATA : arg >>> 0));

    direct.table[name].handler(values);
    poison();
    const trapped = processor.run(name, values, 0);
    if (trapped)
    {
        ring.table[name].handler(trapped);
    }
    // The error flag, read through the export: a host entry, which plays the ring first.
    const errors = [direct.gl('glGetError'), ring.gl('glGetError')];
    if (errors[0] !== errors[1])
    {
        wrong.push(`${where}: glGetError ${hex(errors[0])} made at once, ${hex(errors[1])} `
            + 'through the ring');
    }
    if (error !== undefined && errors[0] !== error)
    {
        wrong.push(`${where}: glGetError ${hex(errors[0])}, not ${hex(error)}`);
    }
    for (const [index, side] of [direct, ring].entries())
    {
        if (inside)
        {
            side.gl('glEnd');
        }
        if (!current)
        {
            assert.equal(side.gl('wglMakeCurrent', HDC, handles[index]), 1);
        }
    }
    const states = [direct, ring].map(side=>side.opengl.withContext(snapshot));
    const differs = states[0]?.findIndex((entry, i)=>!equal(entry, states[1]?.[i])) ?? -1;
    if (differs >= 0)
    {
        wrong.push(`${where}: the contexts differ at ${JSON.stringify(states[0]?.[differs])}`
            + ` against ${JSON.stringify(states[1]?.[differs])}`);
    }
    if (!equal(direct.divergences, ring.divergences))
    {
        wrong.push(`${where}: reported ${JSON.stringify(direct.divergences)} made at once,`
            + ` ${JSON.stringify(ring.divergences)} through the ring`);
    }
    return { wrong, taken: trapped === null };
}

/**
 * Fills what a run decodes a record's copy through with values no case
 * passes: the scratch outlives a record, and a routine that copied less than
 * its call reads would otherwise be read the rest of an earlier case's data
 * -- which, cases sharing their vectors, is often the very data it left out.
 */
const poison = ()=>{
    const record = new Uint32Array(2 + 1 + 16);
    record.set([GL_COMMANDS.commandSlot('glLoadMatrixf'), record.byteLength, 0]);
    record.fill(f(-1234.5), 3);
    GL_COMMANDS.runCommands({ glLoadMatrixf: ()=>{} }, new Uint8Array(record.buffer), [],
        ()=>{});
};

const equal = isDeepStrictEqual;

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

const BAD = 0x1234;
const MATRIX = floats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const VECTOR = floats([0.25, -0.5, 2, 1]);

/** A buffer object bound to `target` with `size` bytes of its own. @param {number} size */
const buffer = (size = 32, target = GL.ARRAY_BUFFER)=>(/** @type {Gl} */ gl)=>{
    gl('glBindBufferARB', target, 1);
    gl('glBufferDataARB', target, size,
        gl.put(Uint8Array.from({ length: size }, (unused, i)=>i + 100)), GL.STATIC_DRAW);
};

/** @param {number} count */
const pushes = count=>(/** @type {Gl} */ gl)=>{
    for (let i = 0; i < count; i++)
    {
        gl('glPushMatrix');
    }
};

/** @type {Record<string, Case[]>} */
const CASES = {
    glEnable: [
        { label: 'BLEND', args: [GL.BLEND], error: GL.NO_ERROR },
        { label: 'TEXTURE_2D on the second unit', args: [GL.TEXTURE_2D],
            before: gl=>gl('glActiveTextureARB', GL.TEXTURE1) },
        { label: 'two-sided stencil', args: [GL.STENCIL_TEST_TWO_SIDE_EXT] },
        { label: 'texture generation', args: [GL.TEXTURE_GEN_S] },
        { label: 'a capability there is not', args: [BAD], error: GL.INVALID_ENUM },
        { label: 'an array, which is client state', args: [GL.VERTEX_ARRAY] },
    ],
    glDisable: [
        { label: 'DITHER', args: [GL.DITHER], error: GL.NO_ERROR },
        { label: 'BLEND after it was enabled', args: [GL.BLEND],
            before: gl=>gl('glEnable', GL.BLEND) },
        { label: 'a capability there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glEnableClientState: [
        { label: 'VERTEX_ARRAY', args: [GL.VERTEX_ARRAY], error: GL.NO_ERROR },
        { label: 'TEXTURE_COORD_ARRAY of the second unit', args: [GL.TEXTURE_COORD_ARRAY],
            before: gl=>gl('glClientActiveTextureARB', GL.TEXTURE1) },
        { label: 'a server capability', args: [GL.BLEND], error: GL.INVALID_ENUM },
    ],
    glDisableClientState: [
        { label: 'COLOR_ARRAY after it was enabled', args: [GL.COLOR_ARRAY],
            before: gl=>gl('glEnableClientState', GL.COLOR_ARRAY), error: GL.NO_ERROR },
        { label: 'a server capability', args: [GL.BLEND], error: GL.INVALID_ENUM },
    ],
    glBindTexture: [
        { label: 'a new name', args: [GL.TEXTURE_2D, 5], error: GL.NO_ERROR },
        { label: 'none', args: [GL.TEXTURE_2D, 0], before: gl=>gl('glBindTexture',
            GL.TEXTURE_2D, 5) },
        { label: 'a target there is not', args: [BAD, 5], error: GL.INVALID_ENUM },
        { label: 'a name of another target', args: [GL.TEXTURE_1D, 5],
            before: gl=>gl('glBindTexture', GL.TEXTURE_2D, 5), error: GL.INVALID_OPERATION },
    ],
    glActiveTextureARB: [
        { label: 'the second unit', args: [GL.TEXTURE1], error: GL.NO_ERROR },
        { label: 'the last unit', args: [GL.TEXTURE0 + 3] },
        { label: 'the last image unit', args: [GL.TEXTURE0 + 7] },
        { label: 'past the last image unit', args: [GL.TEXTURE0 + 8], error: GL.INVALID_ENUM },
        { label: 'no unit', args: [0], error: GL.INVALID_ENUM },
    ],
    glClientActiveTextureARB: [
        { label: 'the second unit', args: [GL.TEXTURE1], error: GL.NO_ERROR },
        { label: 'the last coordinate set', args: [GL.TEXTURE0 + 7] },
        { label: 'past the last coordinate set', args: [GL.TEXTURE0 + 8],
            error: GL.INVALID_ENUM },
    ],
    glBindBufferARB: [
        { label: 'an array buffer', args: [GL.ARRAY_BUFFER, 3], error: GL.NO_ERROR },
        { label: 'an index buffer', args: [GL.ELEMENT_ARRAY_BUFFER, 3] },
        { label: 'none', args: [GL.ARRAY_BUFFER, 0], before: buffer() },
        { label: 'a target there is not', args: [BAD, 3], error: GL.INVALID_ENUM },
    ],
    glBindProgramARB: [
        { label: 'a vertex program', args: [GL.VERTEX_PROGRAM_ARB, 1], error: GL.NO_ERROR },
        { label: 'a fragment program', args: [GL.FRAGMENT_PROGRAM_ARB, 2] },
        { label: 'a target there is not', args: [BAD, 1], error: GL.INVALID_ENUM },
        { label: 'a name of the other target', args: [GL.VERTEX_PROGRAM_ARB, 2],
            before: gl=>gl('glBindProgramARB', GL.FRAGMENT_PROGRAM_ARB, 2),
            error: GL.INVALID_OPERATION },
    ],
    glMatrixMode: [
        { label: 'PROJECTION', args: [GL.PROJECTION], error: GL.NO_ERROR },
        { label: 'TEXTURE', args: [GL.TEXTURE] },
        { label: 'a mode there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glEnableVertexAttribArrayARB: [
        { label: 'the first', args: [0], error: GL.NO_ERROR },
        { label: 'the last', args: [15] },
        { label: 'past the last', args: [16], error: GL.INVALID_VALUE },
    ],
    glDisableVertexAttribArrayARB: [
        { label: 'one enabled', args: [3], before: gl=>gl('glEnableVertexAttribArrayARB', 3),
            error: GL.NO_ERROR },
        { label: 'past the last', args: [16], error: GL.INVALID_VALUE },
    ],
    glActiveStencilFaceEXT: [
        { label: 'BACK', args: [GL.BACK], error: GL.NO_ERROR },
        { label: 'FRONT', args: [GL.FRONT] },
        { label: 'both, which is no face', args: [GL.FRONT_AND_BACK], error: GL.INVALID_ENUM },
    ],
    glCullFace: [
        { label: 'FRONT', args: [GL.FRONT], error: GL.NO_ERROR },
        { label: 'FRONT_AND_BACK', args: [GL.FRONT_AND_BACK] },
        { label: 'a face there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glFrontFace: [
        { label: 'CW', args: [GL.CW], error: GL.NO_ERROR },
        { label: 'a winding there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glDepthFunc: [
        { label: 'LEQUAL', args: [GL.LEQUAL], error: GL.NO_ERROR },
        { label: 'a function there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glDepthMask: [
        { label: 'off', args: [0], error: GL.NO_ERROR },
        { label: 'on after off', args: [1], before: gl=>gl('glDepthMask', 0) },
        { label: 'a word whose low byte is zero', args: [0x100] },
        { label: 'every bit', args: [0xffffffff] },
    ],
    glColorMask: [
        { label: 'red and blue', args: [1, 0, 1, 0], error: GL.NO_ERROR },
        { label: 'words wider than a byte', args: [0x100, 2, 0xff00, 0xffffffff] },
    ],
    glBlendFunc: [
        { label: 'alpha blending', args: [GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA],
            error: GL.NO_ERROR },
        { label: 'a source there is not', args: [BAD, GL.ONE], error: GL.INVALID_ENUM },
        { label: 'a destination there is not', args: [GL.ONE, BAD], error: GL.INVALID_ENUM },
    ],
    glAlphaFunc: [
        { label: 'GREATER a half', args: [GL.GREATER, f(0.5)], error: GL.NO_ERROR },
        { label: 'a reference past one', args: [GL.LESS, f(2)] },
        { label: 'a reference that is no number', args: [GL.LESS, 0x7fc00000] },
        { label: 'a function there is not', args: [BAD, f(0)], error: GL.INVALID_ENUM },
    ],
    glStencilOp: [
        { label: 'keep, replace, incr', args: [GL.KEEP, GL.REPLACE, GL.INCR],
            error: GL.NO_ERROR },
        { label: 'an operation there is not', args: [GL.KEEP, BAD, GL.KEEP],
            error: GL.INVALID_ENUM },
    ],
    glStencilFunc: [
        { label: 'ALWAYS one', args: [GL.ALWAYS, 1, 0xff], error: GL.NO_ERROR },
        { label: 'a negative reference', args: [GL.EQUAL, -1, 0xffffffff] },
        { label: 'a function there is not', args: [BAD, 0, 0], error: GL.INVALID_ENUM },
    ],
    glStencilMask: [
        { label: 'a byte', args: [0xff], error: GL.NO_ERROR },
        { label: 'none', args: [0] },
    ],
    glClearStencil: [
        { label: 'seven', args: [7], error: GL.NO_ERROR },
        { label: 'minus one', args: [-1] },
    ],
    glClearColor: [
        { label: 'a colour', args: floats([0.1, 0.2, 0.3, 0.4]), error: GL.NO_ERROR },
        { label: 'out of range and no number', args: [f(-1), f(2), 0x7fc00000, f(Infinity)] },
    ],
    glClearDepth: [
        { label: 'a half', args: d(0.5), error: GL.NO_ERROR },
        { label: 'past one', args: d(2) },
        { label: 'below zero', args: d(-1) },
    ],
    glDepthRange: [
        { label: 'a quarter to three', args: [...d(0.25), ...d(0.75)], error: GL.NO_ERROR },
        { label: 'out of range', args: [...d(-1), ...d(2)] },
    ],
    glPolygonMode: [
        { label: 'lines on both', args: [GL.FRONT_AND_BACK, GL.LINE], error: GL.NO_ERROR },
        { label: 'points on the back', args: [GL.BACK, GL.POINT] },
        { label: 'a face there is not', args: [BAD, GL.FILL], error: GL.INVALID_ENUM },
        { label: 'a mode there is not', args: [GL.FRONT, BAD], error: GL.INVALID_ENUM },
    ],
    glPolygonOffset: [
        { label: 'one and two', args: floats([1, 2]), error: GL.NO_ERROR },
        { label: 'negative', args: floats([-1, -0]) },
    ],
    glShadeModel: [
        { label: 'FLAT', args: [GL.FLAT], error: GL.NO_ERROR },
        { label: 'a model there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glScissor: [
        { label: 'a box', args: [1, 2, 3, 4], error: GL.NO_ERROR },
        { label: 'a negative corner', args: [-5, -5, 10, 10] },
        { label: 'a negative width', args: [0, 0, -1, 4], error: GL.INVALID_VALUE },
    ],
    glViewport: [
        { label: 'a box', args: [1, 2, 3, 4], error: GL.NO_ERROR },
        { label: 'past the largest', args: [0, 0, 100000, 100000] },
        { label: 'a negative height', args: [0, 0, 4, -1], error: GL.INVALID_VALUE },
    ],
    glDrawBuffer: [
        { label: 'FRONT', args: [GL.FRONT], error: GL.NO_ERROR },
        { label: 'BACK after FRONT', args: [GL.BACK], before: gl=>gl('glDrawBuffer', GL.FRONT) },
        { label: 'an auxiliary buffer there is not', args: [GL.AUX0],
            error: GL.INVALID_OPERATION },
        { label: 'a buffer there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glReadBuffer: [
        { label: 'FRONT', args: [GL.FRONT], error: GL.NO_ERROR },
        { label: 'a buffer there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glLineWidth: [
        { label: 'two', args: [f(2)], error: GL.NO_ERROR },
        { label: 'zero', args: [f(0)], error: GL.INVALID_VALUE },
        { label: 'negative', args: [f(-1)], error: GL.INVALID_VALUE },
    ],
    glPointSize: [
        { label: 'three', args: [f(3)], error: GL.NO_ERROR },
        { label: 'zero', args: [f(0)], error: GL.INVALID_VALUE },
    ],
    glClear: [
        { label: 'colour and depth', args: [GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT],
            before: gl=>{
                gl('glClearColor', ...floats([0.25, 0.5, 0.75, 1]));
                gl('glClearDepth', ...d(0.5));
            }, error: GL.NO_ERROR },
        { label: 'stencil, scissored', args: [GL.STENCIL_BUFFER_BIT], before: gl=>{
            gl('glClearStencil', 5);
            gl('glScissor', 1, 1, 2, 2);
            gl('glEnable', GL.SCISSOR_TEST);
        } },
        { label: 'nothing', args: [0], error: GL.NO_ERROR },
        { label: 'a bit there is not', args: [1], error: GL.INVALID_VALUE },
    ],
    glVertexPointer: [
        { label: 'three floats', args: [3, GL.FLOAT, 0, DATA], error: GL.NO_ERROR },
        { label: 'into a buffer', args: [4, GL.DOUBLE, 32, 16], before: buffer() },
        { label: 'one component', args: [1, GL.FLOAT, 0, DATA], error: GL.INVALID_VALUE },
        { label: 'a type there is not', args: [3, GL.UNSIGNED_BYTE, 0, DATA],
            error: GL.INVALID_ENUM },
        { label: 'a negative stride', args: [3, GL.FLOAT, -4, DATA], error: GL.INVALID_VALUE },
    ],
    glTexCoordPointer: [
        { label: 'two floats', args: [2, GL.FLOAT, 8, DATA], error: GL.NO_ERROR },
        { label: 'of the second set', args: [4, GL.SHORT, 0, DATA],
            before: gl=>gl('glClientActiveTextureARB', GL.TEXTURE1) },
        { label: 'five components', args: [5, GL.FLOAT, 0, DATA], error: GL.INVALID_VALUE },
        { label: 'a type there is not', args: [2, BAD, 0, DATA], error: GL.INVALID_ENUM },
    ],
    glColorPointer: [
        { label: 'four bytes', args: [4, GL.UNSIGNED_BYTE, 4, DATA], error: GL.NO_ERROR },
        { label: 'two components', args: [2, GL.FLOAT, 0, DATA], error: GL.INVALID_VALUE },
        { label: 'a type there is not', args: [3, BAD, 0, DATA], error: GL.INVALID_ENUM },
    ],
    glNormalPointer: [
        { label: 'floats', args: [GL.FLOAT, 12, DATA], error: GL.NO_ERROR },
        { label: 'a type there is not', args: [GL.UNSIGNED_BYTE, 0, DATA],
            error: GL.INVALID_ENUM },
        { label: 'a negative stride', args: [GL.FLOAT, -1, DATA], error: GL.INVALID_VALUE },
    ],
    glVertexAttribPointerARB: [
        { label: 'four floats', args: [0, 4, GL.FLOAT, 0, 16, DATA], error: GL.NO_ERROR },
        { label: 'normalised bytes', args: [1, 4, GL.UNSIGNED_BYTE, 1, 0, DATA] },
        { label: 'normalised by a word whose low byte is zero',
            args: [2, 4, GL.UNSIGNED_BYTE, 0x100, 0, DATA] },
        { label: 'past the last attribute', args: [16, 4, GL.FLOAT, 0, 0, DATA],
            error: GL.INVALID_VALUE },
        { label: 'five components', args: [0, 5, GL.FLOAT, 0, 0, DATA],
            error: GL.INVALID_VALUE },
        { label: 'a type there is not', args: [0, 4, BAD, 0, 0, DATA], error: GL.INVALID_ENUM },
    ],
    glBufferDataARB: [
        { label: 'ten bytes', args: [GL.ARRAY_BUFFER, 10, 'data', GL.STATIC_DRAW],
            data: Uint8Array.from({ length: 10 }, (unused, i)=>i + 1),
            before: gl=>gl('glBindBufferARB', GL.ARRAY_BUFFER, 1), error: GL.NO_ERROR },
        { label: 'five, over a store', args: [GL.ARRAY_BUFFER, 5, 'data', GL.DYNAMIC_DRAW],
            data: Uint8Array.of(9, 8, 7, 6, 5), before: buffer() },
        { label: 'a store with no data', args: [GL.ARRAY_BUFFER, 6, 0, GL.STATIC_DRAW],
            before: buffer() },
        { label: 'no store and no data', args: [GL.ARRAY_BUFFER, 0, 0, GL.STATIC_DRAW],
            before: buffer() },
        { label: 'no store, with data', args: [GL.ARRAY_BUFFER, 0, 'data', GL.STATIC_DRAW],
            data: [1], before: buffer() },
        { label: 'the most a record holds', args: [GL.ARRAY_BUFFER, 16384, 'data',
            GL.STREAM_DRAW], data: Uint8Array.from({ length: 16384 }, (unused, i)=>i * 7),
        before: buffer() },
        { label: 'a byte past it', args: [GL.ARRAY_BUFFER, 16385, 'data', GL.STREAM_DRAW],
            data: Uint8Array.from({ length: 16385 }, (unused, i)=>i * 3), before: buffer() },
        { label: 'a store past it with no data',
            args: [GL.ARRAY_BUFFER, 100000, 0, GL.STATIC_DRAW], before: buffer() },
        { label: 'a negative size', args: [GL.ARRAY_BUFFER, -1, 0, GL.STATIC_DRAW],
            before: buffer(), error: GL.INVALID_VALUE },
        { label: 'a negative size with data', args: [GL.ARRAY_BUFFER, -4, 'data',
            GL.STATIC_DRAW], data: [1], before: buffer(), error: GL.INVALID_VALUE },
        { label: 'a usage there is not', args: [GL.ARRAY_BUFFER, 4, 'data', BAD], data: [1],
            before: buffer(), error: GL.INVALID_ENUM },
        { label: 'no buffer bound', args: [GL.ELEMENT_ARRAY_BUFFER, 4, 'data', GL.STATIC_DRAW],
            data: [1], error: GL.INVALID_OPERATION },
        { label: 'a target there is not', args: [BAD, 4, 'data', GL.STATIC_DRAW], data: [1],
            error: GL.INVALID_ENUM },
        { label: 'a mapped buffer', args: [GL.ARRAY_BUFFER, 4, 'data', GL.STATIC_DRAW],
            data: [1], before: gl=>{
                buffer()(gl);
                gl('glMapBufferARB', GL.ARRAY_BUFFER, GL.WRITE_ONLY);
            }, error: GL.INVALID_OPERATION },
    ],
    glBufferSubDataARB: [
        { label: 'five bytes in', args: [GL.ARRAY_BUFFER, 3, 5, 'data'],
            data: Uint8Array.of(1, 2, 3, 4, 5), before: buffer(), error: GL.NO_ERROR },
        { label: 'the whole store', args: [GL.ARRAY_BUFFER, 0, 32, 'data'],
            data: Uint8Array.from({ length: 32 }, (unused, i)=>255 - i), before: buffer() },
        { label: 'the whole of the largest store a record holds',
            args: [GL.ARRAY_BUFFER, 0, 16384, 'data'],
            data: Uint8Array.from({ length: 16384 }, (unused, i)=>i * 5),
            before: buffer(16384) },
        { label: 'nothing', args: [GL.ARRAY_BUFFER, 4, 0, 'data'], data: [1],
            before: buffer() },
        { label: 'past the end', args: [GL.ARRAY_BUFFER, 30, 5, 'data'], data: [1, 2],
            before: buffer(), error: GL.INVALID_VALUE },
        { label: 'a negative offset', args: [GL.ARRAY_BUFFER, -1, 4, 'data'], data: [1],
            before: buffer(), error: GL.INVALID_VALUE },
        { label: 'a negative size', args: [GL.ARRAY_BUFFER, 0, -4, 'data'], data: [1],
            before: buffer(), error: GL.INVALID_VALUE },
        { label: 'no data', args: [GL.ARRAY_BUFFER, 0, 4, 0], before: buffer() },
        { label: 'no buffer bound', args: [GL.ARRAY_BUFFER, 0, 4, 'data'], data: [1],
            error: GL.INVALID_OPERATION },
        { label: 'a mapped buffer', args: [GL.ARRAY_BUFFER, 0, 4, 'data'], data: [1],
            before: gl=>{
                buffer()(gl);
                gl('glMapBufferARB', GL.ARRAY_BUFFER, GL.WRITE_ONLY);
            }, error: GL.INVALID_OPERATION },
    ],
    glLoadIdentity: [
        { label: 'after a translation', args: [], error: GL.NO_ERROR,
            before: gl=>gl('glTranslatef', ...floats([1, 2, 3])) },
    ],
    glPushMatrix: [
        { label: 'one', args: [], error: GL.NO_ERROR,
            before: gl=>gl('glTranslatef', ...floats([1, 2, 3])) },
        { label: 'one past the deepest', args: [], before: pushes(31),
            error: GL.STACK_OVERFLOW },
        { label: 'of the projection, one past its deepest', args: [], before: gl=>{
            gl('glMatrixMode', GL.PROJECTION);
            pushes(1)(gl);
        }, error: GL.STACK_OVERFLOW },
    ],
    glPopMatrix: [
        { label: 'one pushed', args: [], before: gl=>{
            gl('glPushMatrix');
            gl('glScalef', ...floats([2, 2, 2]));
        }, error: GL.NO_ERROR },
        { label: 'none pushed', args: [], error: GL.STACK_UNDERFLOW },
    ],
    glLoadMatrixf: [
        { label: 'a matrix', args: ['data'], data: MATRIX, error: GL.NO_ERROR },
        { label: 'one that is no numbers', args: ['data'],
            data: [0x7fc00000, ...MATRIX.slice(1, 15), f(-Infinity)] },
        { label: 'no matrix', args: [0] },
    ],
    glMultMatrixf: [
        { label: 'after a translation', args: ['data'], data: MATRIX, error: GL.NO_ERROR,
            before: gl=>gl('glTranslatef', ...floats([1, 2, 3])) },
        { label: 'no matrix', args: [0] },
    ],
    glTranslatef: [
        { label: 'a step', args: floats([1, -2, 3.5]), error: GL.NO_ERROR },
        { label: 'no number', args: [0x7fc00000, 0, 0] },
    ],
    glRotatef: [
        { label: 'about an axis', args: floats([30, 0, 0, 1]), error: GL.NO_ERROR },
        { label: 'about no axis', args: floats([30, 0, 0, 0]) },
    ],
    glScalef: [
        { label: 'a scale', args: floats([2, 3, 4]), error: GL.NO_ERROR },
        { label: 'to nothing', args: floats([0, 0, 0]) },
    ],
    glOrtho: [
        { label: 'a box', args: [...d(-1), ...d(1), ...d(-2), ...d(2), ...d(-3), ...d(3)],
            error: GL.NO_ERROR },
        { label: 'no width', args: [...d(1), ...d(1), ...d(-2), ...d(2), ...d(-3), ...d(3)],
            error: GL.INVALID_VALUE },
    ],
    glFrustum: [
        { label: 'a frustum', args: [...d(-1), ...d(1), ...d(-1), ...d(1), ...d(1), ...d(10)],
            error: GL.NO_ERROR },
        { label: 'a near plane at zero',
            args: [...d(-1), ...d(1), ...d(-1), ...d(1), ...d(0), ...d(10)],
            error: GL.INVALID_VALUE },
        { label: 'far before near',
            args: [...d(-1), ...d(1), ...d(-1), ...d(1), ...d(10), ...d(1)] },
        { label: 'far at near',
            args: [...d(-1), ...d(1), ...d(-1), ...d(1), ...d(2), ...d(2)],
            error: GL.INVALID_VALUE },
    ],
    glProgramEnvParameter4fvARB: [
        { label: 'a vertex parameter', args: [GL.VERTEX_PROGRAM_ARB, 3, 'data'], data: VECTOR,
            error: GL.NO_ERROR },
        { label: 'the last fragment parameter', args: [GL.FRAGMENT_PROGRAM_ARB, 95, 'data'],
            data: VECTOR },
        { label: 'past the last', args: [GL.VERTEX_PROGRAM_ARB, 96, 'data'], data: VECTOR,
            error: GL.INVALID_VALUE },
        { label: 'a target there is not', args: [BAD, 0, 'data'], data: VECTOR,
            error: GL.INVALID_ENUM },
        { label: 'no vector', args: [GL.VERTEX_PROGRAM_ARB, 0, 0] },
    ],
    glProgramLocalParameter4fvARB: [
        { label: 'of the bound program', args: [GL.VERTEX_PROGRAM_ARB, 3, 'data'],
            data: VECTOR, before: gl=>gl('glBindProgramARB', GL.VERTEX_PROGRAM_ARB, 1),
            error: GL.NO_ERROR },
        { label: 'the last', args: [GL.FRAGMENT_PROGRAM_ARB, 255, 'data'], data: VECTOR,
            before: gl=>gl('glBindProgramARB', GL.FRAGMENT_PROGRAM_ARB, 1) },
        { label: 'past the last', args: [GL.FRAGMENT_PROGRAM_ARB, 256, 'data'], data: VECTOR,
            before: gl=>gl('glBindProgramARB', GL.FRAGMENT_PROGRAM_ARB, 1),
            error: GL.INVALID_VALUE },
        { label: 'a target there is not', args: [BAD, 0, 'data'], data: VECTOR,
            error: GL.INVALID_ENUM },
    ],
    glProgramEnvParameter4fARB: [
        { label: 'a vertex parameter', args: [GL.VERTEX_PROGRAM_ARB, 7, ...VECTOR],
            error: GL.NO_ERROR },
        { label: 'past the last', args: [GL.FRAGMENT_PROGRAM_ARB, 96, ...VECTOR],
            error: GL.INVALID_VALUE },
    ],
    glProgramLocalParameter4fARB: [
        { label: 'of the bound program', args: [GL.FRAGMENT_PROGRAM_ARB, 2, ...VECTOR],
            before: gl=>gl('glBindProgramARB', GL.FRAGMENT_PROGRAM_ARB, 4),
            error: GL.NO_ERROR },
        { label: 'a target there is not', args: [BAD, 0, ...VECTOR], error: GL.INVALID_ENUM },
    ],
    glTexEnvf: [
        { label: 'the mode', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, f(GL.DECAL)],
            error: GL.NO_ERROR },
        { label: 'a mode there is not', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, f(BAD)],
            error: GL.INVALID_ENUM },
        { label: 'the colour, which is a vector', args: [GL.TEXTURE_ENV,
            GL.TEXTURE_ENV_COLOR, f(0.5)] },
        { label: 'a target there is not', args: [BAD, GL.TEXTURE_ENV_MODE, f(GL.DECAL)],
            error: GL.INVALID_ENUM },
    ],
    glTexEnvi: [
        { label: 'the mode', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.REPLACE],
            error: GL.NO_ERROR },
        { label: 'the colour as an integer', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR,
            0x7fffffff] },
        { label: 'a mode there is not', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, BAD],
            error: GL.INVALID_ENUM },
    ],
    glTexEnvfv: [
        { label: 'the colour', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR, 'data'],
            data: VECTOR, error: GL.NO_ERROR },
        { label: 'the mode', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, 'data'],
            data: [f(GL.MODULATE)] },
        { label: 'a parameter there is not', args: [GL.TEXTURE_ENV, BAD, 'data'], data: VECTOR,
            error: GL.INVALID_ENUM },
        { label: 'no vector', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR, 0] },
    ],
    glTexGenf: [
        { label: 'sphere mapping', args: [GL.S, GL.TEXTURE_GEN_MODE, f(GL.SPHERE_MAP)],
            error: GL.NO_ERROR },
        { label: 'sphere mapping of R', args: [GL.R, GL.TEXTURE_GEN_MODE, f(GL.SPHERE_MAP)],
            error: GL.INVALID_ENUM },
        { label: 'a plane, which is a vector', args: [GL.S, GL.OBJECT_PLANE, f(1)] },
    ],
    glTexGeni: [
        { label: 'object linear', args: [GL.T, GL.TEXTURE_GEN_MODE, GL.OBJECT_LINEAR],
            error: GL.NO_ERROR },
        { label: 'a coordinate there is not', args: [BAD, GL.TEXTURE_GEN_MODE, GL.EYE_LINEAR],
            error: GL.INVALID_ENUM },
    ],
    glTexGenfv: [
        { label: 'an object plane', args: [GL.S, GL.OBJECT_PLANE, 'data'], data: VECTOR,
            error: GL.NO_ERROR },
        { label: 'an eye plane', args: [GL.Q, GL.EYE_PLANE, 'data'], data: VECTOR },
        { label: 'the mode', args: [GL.R, GL.TEXTURE_GEN_MODE, 'data'],
            data: [f(GL.EYE_LINEAR)] },
        { label: 'a parameter there is not', args: [GL.S, BAD, 'data'], data: VECTOR,
            error: GL.INVALID_ENUM },
    ],
    glTexParameterf: [
        { label: 'the minifying filter', args: [GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER,
            f(GL.LINEAR)], before: gl=>gl('glBindTexture', GL.TEXTURE_2D, 1),
        error: GL.NO_ERROR },
        { label: 'a filter there is not', args: [GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, f(BAD)],
            error: GL.INVALID_ENUM },
        { label: 'the border colour, which is a vector', args: [GL.TEXTURE_2D,
            GL.TEXTURE_BORDER_COLOR, f(0.5)] },
    ],
    glTexParameteri: [
        { label: 'clamping', args: [GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP],
            error: GL.NO_ERROR },
        { label: 'a target there is not', args: [BAD, GL.TEXTURE_WRAP_S, GL.CLAMP],
            error: GL.INVALID_ENUM },
        { label: 'the border colour as an integer', args: [GL.TEXTURE_2D,
            GL.TEXTURE_BORDER_COLOR, 0x7fffffff] },
    ],
    glBegin: [
        { label: 'triangles', args: [GL.TRIANGLES], error: GL.NO_ERROR },
        { label: 'a polygon', args: [GL.POLYGON] },
        { label: 'a mode there is not', args: [BAD], error: GL.INVALID_ENUM },
    ],
    glEnd: [
        { label: 'a triangle drawn', args: [], before: gl=>{
            gl('glBegin', GL.TRIANGLES);
            gl('glColor3f', ...floats([1, 0, 0]));
            gl('glVertex2f', ...floats([-1, -1]));
            gl('glVertex2f', ...floats([1, -1]));
            gl('glVertex2f', ...floats([0, 1]));
        }, error: GL.NO_ERROR },
        { label: 'with no glBegin', args: [], error: GL.INVALID_OPERATION },
    ],
    glVertex2f: [{ label: 'a vertex', args: floats([0.5, -0.5]), error: GL.NO_ERROR }],
    glVertex3f: [{ label: 'a vertex', args: floats([0.5, -0.5, 0.25]), error: GL.NO_ERROR }],
    glVertex2fv: [
        { label: 'a vertex', args: ['data'], data: floats([0.5, -0.5]), error: GL.NO_ERROR },
        { label: 'none', args: [0] },
    ],
    glVertex3fv: [
        { label: 'a vertex', args: ['data'], data: floats([0.5, -0.5, 2]), error: GL.NO_ERROR },
    ],
    glColor3f: [
        { label: 'a colour', args: floats([0.25, 0.5, 0.75]), error: GL.NO_ERROR },
        { label: 'out of range', args: floats([-1, 2, 0]) },
    ],
    glColor4f: [{ label: 'a colour', args: floats([0.25, 0.5, 0.75, 0.125]),
        error: GL.NO_ERROR }],
    glColor3ub: [
        { label: 'a colour', args: [0x40, 0x80, 0xff], error: GL.NO_ERROR },
        { label: 'words wider than a byte', args: [0x1ff, 0xffffff00, 0x1234] },
    ],
    glColor4ub: [{ label: 'a colour', args: [0x40, 0x80, 0xff, 0x10], error: GL.NO_ERROR }],
    glColor3fv: [{ label: 'a colour', args: ['data'], data: floats([0.25, 0.5, 0.75]),
        error: GL.NO_ERROR }],
    glColor4fv: [{ label: 'a colour', args: ['data'], data: VECTOR, error: GL.NO_ERROR }],
    glTexCoord2f: [{ label: 'a coordinate', args: floats([0.25, 4]), error: GL.NO_ERROR }],
    glTexCoord2fv: [{ label: 'a coordinate', args: ['data'], data: floats([0.25, 4]),
        error: GL.NO_ERROR }],
    glNormal3f: [{ label: 'a normal', args: floats([0, 0, -1]), error: GL.NO_ERROR }],
    glNormal3fv: [{ label: 'a normal', args: ['data'], data: floats([0, 1, 0]),
        error: GL.NO_ERROR }],
};

test('every OpenGL call the ring takes leaves the context as the same call made at once',
    { timeout: 300000 }, ()=>{
        assert.deepEqual(Object.keys(CASES).sort(), Object.keys(GL_COMMANDS.COMMANDS).sort(),
            'every call the ring carries has its cases, and only those');
        const { wrong, taken } = gate(CASES);
        assert.deepEqual(wrong, [], 'the ring leaves every context as the calls made at once');
        assert.deepEqual(Object.keys(CASES).filter(name=>!taken.has(name)), [],
            'each call has a case the routine takes, so the routine is exercised');
    });

/**
 * A step of a sequence, on the calling thread `on`: a call the routine is
 * given (`ring`) -- which it must take, or leave to its trap, as `expect`
 * says -- or one through the export (`host`), whose answer, and the `out`
 * bytes it wrote, are compared and kept, under `keep` for a later step's
 * argument. An argument may be 'data', 'out' or a name kept before.
 *
 * @typedef {{ ring?: string, host?: string, args?: (number | string)[],
 *     data?: number[] | Uint8Array, on?: number, expect?: 'taken' | 'trap',
 *     out?: number, keep?: string }} Step
 */

/**
 * Makes `steps` on both libraries, one step on each in turn, with no host
 * entry on the ring's side but the steps': what differed, and each step's
 * answer as the ring's side got it.
 *
 * @param {Step[]} steps
 * @returns {{ wrong: string[], answers: unknown[], trapped: number }}
 */
function sequence(steps){
    const processor = machine();
    const { direct, ring, calling } = pair(processor);
    /** @type {Map<string, number>[]} */
    const named = [new Map(), new Map()];
    /** @type {unknown[][]} */
    const answers = [[], []];
    /** @type {string[]} */
    const wrong = [];
    let trapped = 0;
    steps.forEach((step, at)=>{
        const { ring: routine, host, args = [], data = [], on = 0, expect, out = 0, keep } = step;
        calling.thread = on;
        const where = `step ${at}, ${routine ?? host}`;
        [direct, ring].forEach((side, index)=>{
            processor.host.writePhysical(DATA, data instanceof Uint8Array ? data
                : new Uint8Array(new Uint32Array(data).buffer));
            const values = args.map(arg=>(typeof arg === 'number' ? arg >>> 0
                : arg === 'data' ? DATA : arg === 'out' ? OUT[index]
                    : /** @type {number} */ (named[index].get(arg))));
            if (routine && index === 0)
            {
                side.table[routine].handler(values);
            }
            else if (routine)
            {
                poison();
                const left = processor.run(routine, values, on);
                if (left)
                {
                    trapped++;
                    side.table[routine].handler(left);
                }
                if (expect && expect !== (left ? 'trap' : 'taken'))
                {
                    wrong.push(`${where}: ${left ? 'left to the trap' : 'taken'}, not ${expect}`);
                }
            }
            else if (host)
            {
                processor.host.writePhysical(OUT[index], new Uint8Array(out));
                const answer = side.table[host].handler(values);
                answers[index].push(out ? [answer, [...processor.host.readPhysical(OUT[index],
                    out)]] : answer);
                if (keep)
                {
                    named[index].set(keep, answer);
                }
            }
        });
        if (host && !equal(answers[0].at(-1), answers[1].at(-1)))
        {
            wrong.push(`${where}: ${JSON.stringify(answers[0].at(-1))} made at once, `
                + `${JSON.stringify(answers[1].at(-1))} through the ring`);
        }
    });
    calling.thread = 0;
    const states = [direct, ring].map(side=>side.opengl.withContext(snapshot));
    const differs = states[0]?.findIndex((entry, i)=>!equal(entry, states[1]?.[i])) ?? -1;
    if (differs >= 0 || (states[0] === null) !== (states[1] === null))
    {
        wrong.push(`the contexts differ at ${JSON.stringify(states[0]?.[differs])} against `
            + `${JSON.stringify(states[1]?.[differs])}`);
    }
    if (!equal(direct.divergences, ring.divergences))
    {
        wrong.push(`reported ${JSON.stringify(direct.divergences)} made at once, `
            + `${JSON.stringify(ring.divergences)} through the ring`);
    }
    return { wrong, answers: answers[1], trapped };
}

/** A float's bytes, as a getter writes it. @param {number[]} values */
const floatBytes = values=>[...new Uint8Array(new Float32Array(values).buffer)];

test('a getter after calls the ring took sees them, and the first error is the one kept', ()=>{
    const colour = [0.25, 0.5, 0.75, 1];
    const { wrong, answers } = sequence([
        { ring: 'glColor4f', args: floats(colour), expect: 'taken' },
        { host: 'glGetFloatv', args: [GL.CURRENT_COLOR, 'out'], out: 16 },
        { ring: 'glEnable', args: [BAD], expect: 'taken' },
        { ring: 'glLineWidth', args: [f(0)], expect: 'taken' },
        { ring: 'glEnable', args: [GL.BLEND], expect: 'taken' },
        { host: 'glGetError' },
        { host: 'glGetError' },
        { host: 'glIsEnabled', args: [GL.BLEND] },
        // Inside glBegin/glEnd: a vertex is taken there, a matrix mode is an error.
        { ring: 'glBegin', args: [GL.TRIANGLES], expect: 'taken' },
        { ring: 'glVertex2f', args: floats([0, 0]), expect: 'taken' },
        { ring: 'glMatrixMode', args: [GL.PROJECTION], expect: 'taken' },
        { ring: 'glColor3ub', args: [0xff, 0, 0x80], expect: 'taken' },
        { ring: 'glEnd', args: [], expect: 'taken' },
        { host: 'glGetError' },
        { host: 'glGetIntegerv', args: [GL.MATRIX_MODE, 'out'], out: 4 },
        { host: 'glGetFloatv', args: [GL.CURRENT_COLOR, 'out'], out: 16 },
    ]);
    assert.deepEqual(wrong, []);
    assert.deepEqual(answers, [
        [0, floatBytes(colour)], GL.INVALID_ENUM, GL.NO_ERROR, GL.TRUE, GL.INVALID_OPERATION,
        [0, u32(GL.MODELVIEW)], [0, floatBytes([1, 0, 0x80 / 255, 1])],
    ]);
});

test('a display list compiled from calls the ring took holds what they held when made', ()=>{
    const first = floats([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);
    const second = floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    const { wrong, answers } = sequence([
        { host: 'glNewList', args: [1, GL.COMPILE] },
        { ring: 'glLoadMatrixf', args: ['data'], data: first, expect: 'taken' },
        { ring: 'glMultMatrixf', args: ['data'], data: second, expect: 'taken' },
        { ring: 'glProgramEnvParameter4fvARB', args: [GL.VERTEX_PROGRAM_ARB, 0, 'data'],
            data: floats([1, 2, 3, 4]), expect: 'taken' },
        { ring: 'glProgramEnvParameter4fvARB', args: [GL.VERTEX_PROGRAM_ARB, 1, 'data'],
            data: floats([5, 6, 7, 8]), expect: 'taken' },
        { ring: 'glColor3fv', args: ['data'], data: floats([0.5, 0.25, 1]), expect: 'taken' },
        { host: 'glEndList' },
        { host: 'glGetFloatv', args: [GL.MODELVIEW_MATRIX, 'out'], out: 64 },
        { ring: 'glLoadIdentity', args: [], expect: 'taken' },
        { host: 'glCallList', args: [1] },
        { host: 'glGetFloatv', args: [GL.MODELVIEW_MATRIX, 'out'], out: 64 },
        { host: 'glGetProgramEnvParameterfvARB', args: [GL.VERTEX_PROGRAM_ARB, 0, 'out'],
            out: 16 },
        { host: 'glGetError' },
    ]);
    assert.deepEqual(wrong, []);
    assert.deepEqual(answers.at(-3), [0, floatBytes([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0,
        11, 14, 17, 1])], 'the product of the two matrices, not the second twice');
    assert.deepEqual(answers.at(-2), [0, floatBytes([1, 2, 3, 4])]);
});

test('a ring that fills leaves the call to the host after the ones before it, and starts over',
    ()=>{
        /** @type {Step[]} */
        const steps = [
            { ring: 'glBindBufferARB', args: [GL.ARRAY_BUFFER, 1], expect: 'taken' },
            { ring: 'glBufferDataARB', args: [GL.ARRAY_BUFFER, 4096, 0, GL.DYNAMIC_DRAW],
                expect: 'taken' },
        ];
        for (let i = 0; i < 300; i++)
        {
            steps.push({ ring: 'glBufferSubDataARB', args: [GL.ARRAY_BUFFER, (i * 37) % 3000,
                1001, 'data'], data: Uint8Array.from({ length: 1001 }, (unused, k)=>k + i) });
            if (i % 50 === 7)
            {
                steps.push({ ring: 'glEnable', args: [BAD] });
            }
        }
        steps.push(
            { host: 'glGetBufferSubDataARB', args: [GL.ARRAY_BUFFER, 0, 4096, 'out'], out: 4096 },
            { host: 'glGetError' }, { host: 'glGetError' });
        const { wrong, answers, trapped } = sequence(steps);
        assert.deepEqual(wrong, []);
        assert.ok(trapped > 0, 'the ring filled, and the routine left a call to the host');
        assert.ok(trapped < 30, `${trapped} of 306 calls left to the host: the ring started over`);
        assert.deepEqual(answers.slice(1), [GL.INVALID_ENUM, GL.NO_ERROR]);
    });

test('with no context current the routine leaves the call to the host, which does nothing, '
    + 'and a context is its own thread\'s', ()=>{
    const { wrong, answers } = sequence([
        { ring: 'glClearColor', args: floats([1, 0, 0, 1]), expect: 'taken' },
        { host: 'wglGetCurrentContext', keep: 'first' },
        { host: 'wglDeleteContext', args: ['first'] },
        // The context is gone and the TEB's slot with it.
        { ring: 'glClearColor', args: floats([0, 1, 0, 1]), expect: 'trap' },
        { ring: 'glEnable', args: [BAD], expect: 'trap' },
        { host: 'glGetError' },
        { host: 'wglCreateContext', args: [HDC], keep: 'second' },
        { host: 'wglMakeCurrent', args: [HDC, 'second'] },
        { host: 'glGetFloatv', args: [GL.COLOR_CLEAR_VALUE, 'out'], out: 16 },
        // The second thread has none.
        { ring: 'glEnable', args: [GL.BLEND], on: 1, expect: 'trap' },
        { host: 'glGetError', on: 1 },
        { host: 'wglCreateContext', args: [HDC], on: 1, keep: 'third' },
        { host: 'wglMakeCurrent', args: [HDC, 'third'], on: 1 },
        { ring: 'glEnable', args: [BAD], on: 1, expect: 'taken' },
        { ring: 'glClearColor', args: floats([0, 0, 1, 1]), on: 1, expect: 'taken' },
        // Not the first thread's error, nor its colour.
        { host: 'glGetError' },
        { host: 'glGetFloatv', args: [GL.COLOR_CLEAR_VALUE, 'out'], out: 16 },
        { host: 'wglDeleteContext', args: ['third'] },
        { host: 'glGetError', on: 1 },
        { host: 'glGetFloatv', args: [GL.COLOR_CLEAR_VALUE, 'out'], on: 1, out: 16 },
        { host: 'wglMakeCurrent', args: [HDC, 0], on: 1 },
        { ring: 'glEnable', args: [GL.BLEND], on: 1, expect: 'trap' },
        { host: 'wglMakeCurrent', args: [HDC, 'third'], on: 1 },
        { host: 'glIsEnabled', args: [GL.BLEND], on: 1 },
        { ring: 'glDisable', args: [GL.DITHER], expect: 'taken' },
        { host: 'glIsEnabled', args: [GL.DITHER] },
    ]);
    assert.deepEqual(wrong, []);
    assert.deepEqual(answers.filter(answer=>typeof answer !== 'number' || answer < 0x10000), [
        1, GL.INVALID_OPERATION, 1, [0, floatBytes([0, 0, 0, 0])], GL.INVALID_OPERATION, 1,
        GL.NO_ERROR, [0, floatBytes([0, 0, 0, 0])], 0, GL.INVALID_ENUM,
        [0, floatBytes([0, 0, 1, 1])], 1, 1, GL.FALSE, GL.FALSE,
    ]);
});

test('a scalar form given a parameter only the vector form takes is GL_INVALID_ENUM',
    ()=>{
        const { wrong, answers } = sequence([
            { ring: 'glTexGenf', args: [GL.S, GL.OBJECT_PLANE, f(7)], expect: 'taken' },
            { host: 'glGetError' },
            { ring: 'glTexEnvf', args: [GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR, f(0.5)],
                expect: 'taken' },
            { host: 'glGetError' },
            { ring: 'glTexParameteri', args: [GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR, 0x7fffffff],
                expect: 'taken' },
            { host: 'glGetError' },
        ]);
        assert.deepEqual(wrong, []);
        assert.deepEqual(answers, [GL.INVALID_ENUM, GL.INVALID_ENUM, GL.INVALID_ENUM]);
    });
