/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 7's command ring (`../d3d8/commands.js`): the setters a frame
 * makes thousands of whose arguments and structures are laid out as Direct3D
 * 8's -- render and stage states, transforms, the material, lights, the
 * viewport, clip planes -- the scene's beginning and end, and a draw by
 * pointer, its vertices copied into the record, a draw from a vertex buffer,
 * by pointer to its indices or not, a texture bound to a stage, and a clear.
 * What the ring holds is made before the DirectDraw seam's next call and a
 * vertex buffer's (`aroundDevices`): a Flip shows what was drawn before it, a
 * Lock of a buffer does not write under a draw that waits, and a Release
 * meets the binding the ring made. A draw by pointer to both its vertices and
 * its indices stays the host's: a record copies what one pointer names.
 */

import { IDIRECT3DDEVICE7_SLOTS } from '../seam/vtables.js';
import { SHARED_COMMANDS, commandSet } from '../d3d8/commands.js';
import { DRAW } from '../seam/shadow.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';
import { D3DDP_DONOTCLIP } from './constants.js';

/** The most of a draw's vertices a record copies: past it the host reads them itself. */
const UP_BYTES = 16 * 1024;

/** The shared entries Direct3D 7's ring carries, by name. */
const CARRIED = /** @type {const} */ (['SetRenderState', 'SetTransform', 'SetTextureStageState',
    'SetMaterial', 'SetViewport', 'SetLight', 'LightEnable', 'SetClipPlane', 'BeginScene',
    'EndScene', 'Clear']);

/** D3DPT_POINTLIST to D3DPT_TRIANGLEFAN. */
const PRIMITIVE_TYPES = /** @type {[number, number][]} */ ([[1, 6]]);
/**
 * Three elements or more, a whole primitive of every type: fewer is a draw of
 * nothing, or a count the device refuses, which the host answers.
 */
const SOME = /** @type {[number, number][]} */ ([[3, 0xffffffff]]);

/**
 * What a draw from a buffer is told of its clipping, as the seam's own call
 * tells it: the buffer's last ProcessVertices kept clip codes and the draw
 * does not say D3DDP_DONOTCLIP (decisions.md A45).
 *
 * @param {any} buffer @param {number} flags D3DDP
 */
export const clippedBy = (buffer, flags)=>(buffer?.clipCodes === true
    && (flags & D3DDP_DONOTCLIP) === 0 ? 1 : 0);

export const D3D7_COMMANDS = commandSet(IDIRECT3DDEVICE7_SLOTS, {
    ...Object.fromEntries(CARRIED.map(name=>[name, SHARED_COMMANDS[name]])),
    // A stage of the eight, and any surface or none: the device holds what is bound.
    SetTexture: { args: 2, objects: [1], within: [{ arg: 0, ranges: [[0, 7]] }],
        make: (d, c)=>d.SetTexture(c.arg(0), c.object()) },
    // DrawPrimitive(type, fvf, vertices, count, flags): in a scene, a whole
    // number of primitives, a format the host has drawn with (`fvfVertices`).
    DrawPrimitive: { args: 5, pointer: 2, kept: true, draws: true, needs: DRAW.SCENE,
        fvfVertices: { type: 0, fvf: 1, count: 3, most: UP_BYTES },
        make: (d, c)=>d.DrawPrimitive(c.arg(0), c.arg(1),
            c.copy(c.arg(3) * decodeFvf(c.arg(1)).stride), c.arg(3)) },
    // A block the device holds, by its handle: an apply leaves what the block
    // mirrors to the host (`stale`).
    ApplyStateBlock: { args: 1, token: 0, stale: true,
        make: (d, c)=>d.ApplyStateBlock(c.arg(0)) },
    CaptureStateBlock: { args: 1, token: 0, make: (d, c)=>d.CaptureStateBlock(c.arg(0)) },
    // DrawPrimitiveVB(type, buffer, start, count, flags): a buffer with a
    // block, unlocked, holding the vertices drawn (`vertexRange`).
    DrawPrimitiveVB: { args: 5, objects: [1], draws: true, needs: DRAW.SCENE,
        within: [{ arg: 0, ranges: PRIMITIVE_TYPES }, { arg: 3, ranges: SOME }],
        vertexRange: { buffer: 1, start: 2, count: 3 },
        make: (d, c)=>{
            const buffer = c.object();
            return d.DrawPrimitiveVB(c.arg(0), buffer, c.arg(2), c.arg(3),
                clippedBy(buffer, c.arg(4)));
        } },
    // DrawIndexedPrimitiveVB(type, buffer, start, count, indices, indexCount,
    // flags): the same, and the 16-bit indices copied into the record.
    DrawIndexedPrimitiveVB: { args: 7, objects: [1], pointer: 4, kept: true, draws: true,
        count: { arg: 5, shift: 1, most: UP_BYTES / 2 }, needs: DRAW.SCENE,
        within: [{ arg: 0, ranges: PRIMITIVE_TYPES }, { arg: 5, ranges: SOME }],
        vertexRange: { buffer: 1, start: 2, count: 3 },
        make: (d, c)=>{
            const buffer = c.object();
            return d.DrawIndexedPrimitiveVB(c.arg(0), buffer, c.arg(2), c.arg(3),
                c.copy(c.arg(5) * 2), c.arg(5), clippedBy(buffer, c.arg(6)));
        } },
});
