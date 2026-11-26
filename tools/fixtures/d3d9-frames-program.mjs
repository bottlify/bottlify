/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D 9 program shaped like a game's frame, built by `make-pe.mjs`:
 * each frame a Clear, BeginScene, `draws` times SetRenderState, SetTexture and
 * a DrawPrimitiveUP of two triangles, `queries` occlusion queries each polled
 * with GetData(FLUSH) until it answers, EndScene and Present; `frames` frames,
 * then ExitProcess(0). What the graphics worker's transport carries a frame:
 * a few batches, a waited answer, a present. `immediate` presents with
 * D3DPRESENT_INTERVAL_IMMEDIATE: no vertical blank holds the frames, which then
 * come as fast as the engine, the transport and the worker make them.
 *
 *     node tools/fixtures/d3d9-frames-program.mjs OUT.exe [FRAMES] [DRAWS] [QUERIES] [immediate]
 *
 * writes the program, for `make-btl.mjs pack` to bottle. Dev tooling, like
 * `make-pe.mjs`: never imported by a package.
 */

import { writeFileSync } from 'node:fs';
import { IDIRECT3DDEVICE9_SLOTS, IDIRECT3DQUERY9_SLOTS } from
    '../../modules/core/src/layers/graphics/d3d9/interfaces.js';
import { IDIRECT3D9_SLOTS } from '../../modules/core/src/layers/graphics/seam/vtables.js';
import { isMain } from '../lib/common.mjs';
import { buildExe } from './make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {number} value */
const f32 = value=>{
    const bytes = Buffer.alloc(4);
    bytes.writeFloatLE(value);
    return [...bytes];
};
/** @param {[string, number][]} slots @param {string} name */
const slotIn = (slots, name)=>3 + slots.findIndex(([entry])=>entry === name);

/** D3DQUERYTYPE_OCCLUSION. */
const OCCLUSION = 9;
/** D3DPRESENT_INTERVAL_IMMEDIATE. */
const INTERVAL_IMMEDIATE = 0x80000000;

/**
 * @param {{ frames?: number, draws?: number, queries?: number, immediate?: boolean }} [shape]
 * @returns {Uint8Array}
 */
export function framesProgram({ frames = 600, draws = 300, queries = 1, immediate = false } = {}){
    /** Two triangles of XYZRHW | DIFFUSE vertices. @type {number[]} */
    const vertices = [];
    for (const [x, y] of [[0, 0], [60, 0], [0, 30], [60, 0], [60, 30], [0, 30]])
    {
        vertices.push(...f32(x), ...f32(y), ...f32(0.5), ...f32(1), ...u32(0xff00ff00));
    }
    return buildExe({
        imports: {
            'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA'],
            'D3D9.dll': ['Direct3DCreate9'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        codeSize: 0x800,
        data: {
            className: [...Buffer.from('BottlifyFrames'), 0],
            wndclass: new Array(40).fill(0),
            present: [...u32(64), ...u32(32), ...u32(22), ...u32(1), ...u32(0), ...u32(0),
                ...u32(1), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
                ...u32(immediate ? INTERVAL_IMMEDIATE : 0)],
            device: u32(0),
            texture: u32(0),
            query: u32(0),
            result: u32(0),
            frames: u32(frames),
            vertices,
        },
        code: (/** @type {{ iat: (name: string) => number, at: (name: string) => number }} */
            { iat, at })=>{
            const push = (/** @type {number} */ value)=>[0x68, ...u32(value)];
            /** A call through the vtable of the object in esi, its arguments pushed last first. */
            const call = (/** @type {number} */ slot, /** @type {number[][]} */ args = [])=>[
                ...args.slice().reverse().flat(), 0x56, 0x8b, 0x06, 0xff, 0x90, ...u32(slot * 4)];
            const device = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>[
                0x8b, 0x35, ...u32(at('device')),
                ...call(slotIn(IDIRECT3DDEVICE9_SLOTS, name), args)];
            const query = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>[
                0x8b, 0x35, ...u32(at('query')),
                ...call(slotIn(IDIRECT3DQUERY9_SLOTS, name), args)];
            const draw = [
                ...device('SetRenderState', [push(60), [0x53]]), // TEXTUREFACTOR = ebx
                ...device('SetTexture', [push(0), [0xff, 0x35, ...u32(at('texture'))]]),
                ...device('DrawPrimitiveUP', [push(4), push(2), push(at('vertices')), push(20)]),
                0x4b, //                                                dec ebx
            ];
            const drawLoop = [0xbb, ...u32(draws), ...draw, 0x0f, 0x85,
                ...u32(-(draw.length + 6))];
            const poll = [...query('GetData', [push(at('result')), push(4), push(1)]),
                0x85, 0xc0]; //                                         test eax, eax
            const oneQuery = [...query('Issue', [push(2)]),
                ...device('DrawPrimitiveUP', [push(4), push(2), push(at('vertices')), push(20)]),
                ...query('Issue', [push(1)]),
                ...poll, 0x0f, 0x85, ...u32(-(poll.length + 6))];
            const frame = [
                ...device('Clear', [push(0), push(0), push(1), push(0xff102030),
                    [0x68, ...f32(1)], push(0)]),
                ...device('BeginScene'),
                ...drawLoop,
                ...Array.from({ length: queries }, ()=>oneQuery).flat(),
                ...device('EndScene'),
                ...device('Present', [push(0), push(0), push(0), push(0)]),
                0xff, 0x0d, ...u32(at('frames')), //                    dec [frames]
            ];
            return [
                0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                ...push(at('wndclass')), 0xff, 0x15, ...u32(iat('RegisterClassA')),
                ...push(0), ...push(0), ...push(0), ...push(0), ...push(32), ...push(64),
                ...push(0), ...push(0), ...push(0x10cf0000), ...push(at('className')),
                ...push(at('className')), ...push(0), 0xff, 0x15, ...u32(iat('CreateWindowExA')),
                0xa3, ...u32(at('present') + 28),
                0x89, 0xc7, //                                           mov edi, eax
                ...push(32), 0xff, 0x15, ...u32(iat('Direct3DCreate9')),
                0x89, 0xc6, //                                           mov esi, eax
                ...call(slotIn(IDIRECT3D9_SLOTS, 'CreateDevice'), [push(0), push(1), [0x57],
                    push(0x20), push(at('present')), push(at('device'))]),
                ...device('CreateTexture', [push(64), push(64), push(1), push(0),
                    push(21), push(1), push(at('texture')), push(0)]),
                ...device('CreateQuery', [push(OCCLUSION), push(at('query'))]),
                ...device('SetFVF', [push(0x44)]),
                ...frame,
                0x0f, 0x85, ...u32(-(frame.length + 6)),
                ...push(0), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

if (isMain(import.meta.url))
{
    const [out, frames = '600', draws = '300', queries = '1', interval = ''] =
        process.argv.slice(2);
    if (!out)
    {
        console.error('usage: node tools/fixtures/d3d9-frames-program.mjs OUT.exe [FRAMES] [DRAWS]'
            + ' [QUERIES] [immediate]');
        process.exit(2);
    }
    writeFileSync(out, framesProgram({ frames: Number(frames), draws: Number(draws),
        queries: Number(queries), immediate: interval === 'immediate' }));
}
