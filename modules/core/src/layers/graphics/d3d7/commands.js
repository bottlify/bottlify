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
 * pointer, its vertices copied into the record. A texture and a clear stay
 * the host's. What the ring holds is made before the DirectDraw seam's next
 * call (`syncDevices`): a Flip shows what was drawn before it.
 */

import { IDIRECT3DDEVICE7_SLOTS } from '../seam/vtables.js';
import { SHARED_COMMANDS, commandSet } from '../d3d8/commands.js';
import { DRAW } from '../seam/shadow.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';

/** The most of a draw's vertices a record copies: past it the host reads them itself. */
const UP_BYTES = 16 * 1024;

/** The shared entries Direct3D 7's ring carries, by name. */
const CARRIED = /** @type {const} */ (['SetRenderState', 'SetTransform', 'SetTextureStageState',
    'SetMaterial', 'SetViewport', 'SetLight', 'LightEnable', 'SetClipPlane', 'BeginScene',
    'EndScene']);

export const D3D7_COMMANDS = commandSet(IDIRECT3DDEVICE7_SLOTS, {
    ...Object.fromEntries(CARRIED.map(name=>[name, SHARED_COMMANDS[name]])),
    // DrawPrimitive(type, fvf, vertices, count, flags): in a scene, a whole
    // number of primitives, a format the host has drawn with (`fvfVertices`).
    DrawPrimitive: { args: 5, pointer: 2, kept: true, draws: true, needs: DRAW.SCENE,
        fvfVertices: { type: 0, fvf: 1, count: 3, most: UP_BYTES },
        make: (d, c)=>d.DrawPrimitive(c.arg(0), c.arg(1),
            c.copy(c.arg(3) * decodeFvf(c.arg(1)).stride), c.arg(3)) },
});
