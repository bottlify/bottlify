/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 7's command ring (`../d3d8/commands.js`): the setters a frame
 * makes thousands of whose arguments and structures are laid out as Direct3D
 * 8's -- render and stage states, transforms, the material, lights, the
 * viewport, clip planes -- and the scene's beginning and end. A texture, a
 * clear and a draw stay the host's: a texture is a DirectDraw surface, and
 * a clear or a draw is shown by a Flip the DirectDraw seam makes.
 */

import { IDIRECT3DDEVICE7_SLOTS } from '../seam/vtables.js';
import { SHARED_COMMANDS, commandSet } from '../d3d8/commands.js';

/** The shared entries Direct3D 7's ring carries, by name. */
const CARRIED = /** @type {const} */ (['SetRenderState', 'SetTransform', 'SetTextureStageState',
    'SetMaterial', 'SetViewport', 'SetLight', 'LightEnable', 'SetClipPlane', 'BeginScene',
    'EndScene']);

export const D3D7_COMMANDS = commandSet(IDIRECT3DDEVICE7_SLOTS,
    Object.fromEntries(CARRIED.map(name=>[name, SHARED_COMMANDS[name]])));
