/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 9's command ring (`../d3d8/commands.js`): its streams take an
 * offset, its indices no base vertex, its declaration and shaders are
 * objects, its sampler states and format are calls of their own, and its
 * shader constants come as floats, integers or booleans, up to the most a
 * device of this version has.
 */

import { IDIRECT3DDEVICE9_SLOTS } from './interfaces.js';
import { SHARED_COMMANDS, commandSet } from '../d3d8/commands.js';
import { DRAW } from '../seam/shadow.js';
import { D3DERR_INVALIDCALL } from './constants.js';

/**
 * A constant setter: `count` registers of four floats or integers, or of one
 * boolean, from the copy.
 *
 * @param {string} name @param {'floats' | 'ints' | 'words'} kind @param {number} width
 * @param {number} most
 * @returns {import('../d3d8/commands.js').CommandEntry}
 */
const constants = (name, kind, width, most)=>({
    args: 3, pointer: 1, count: { arg: 2, shift: width === 1 ? 2 : 4, most }, span: 0,
    make: (d, c)=>d[name](c.arg(0), c[kind].slice(0, c.arg(2) * width), c.arg(2)),
});

/**
 * A state block's own methods, which the device's ring carries with the
 * block beside the record: numbered past the device's own, so a record
 * names them as it names the device's.
 */
const STATE_BLOCK_SLOTS = /** @type {[string, number][]} */ ([
    ['StateBlock.Capture', 0],
    ['StateBlock.Apply', 0],
]);

const set = commandSet([...IDIRECT3DDEVICE9_SLOTS, ...STATE_BLOCK_SLOTS], {
    ...SHARED_COMMANDS,
    // The stages, the displacement map's sampler and the vertex shader's four.
    SetTexture: { args: 2, objects: [1], within: [{ arg: 0, ranges: [[0, 15], [256, 260]] }],
        make: (d, c)=>d.SetTexture(c.arg(0), c.object()) },
    // D3DSAMP_ADDRESSU to D3DSAMP_DMAPOFFSET: any other type is refused.
    SetSamplerState: { args: 3, within: [{ arg: 1, ranges: [[1, 13]] }],
        make: (d, c)=>d.SetSamplerState(c.arg(0), c.arg(1), c.arg(2)) },
    SetStreamSource: { args: 4, objects: [1], within: [{ arg: 0, ranges: [[0, 15]] }],
        make: (d, c)=>d.SetStreamSource(c.arg(0), c.object(), c.arg(2), c.arg(3)) },
    SetIndices: { args: 1, objects: [0], make: (d, c)=>d.SetIndices(c.object()) },
    SetVertexDeclaration: { args: 1, objects: [0],
        make: (d, c)=>d.SetVertexDeclaration(c.object()) },
    SetVertexShader: { args: 1, objects: [0], make: (d, c)=>d.SetVertexShader(c.object()) },
    SetPixelShader: { args: 1, objects: [0], make: (d, c)=>d.SetPixelShader(c.object()) },
    // Whether a format is one is a matter of its bits alone.
    SetFVF: { args: 1, validated: { arg: 0, when: 0xffffffff },
        make: (d, c)=>d.SetFVF(c.arg(0)) },
    SetScissorRect: { args: 1, pointer: 0, bytes: 16,
        make: (d, c)=>d.SetScissorRect({ left: c.words[0], top: c.words[1], right: c.words[2],
            bottom: c.words[3] }) },
    // Off is what every device takes; on is the host's, a mixed device's only.
    SetSoftwareVertexProcessing: { args: 1, within: [{ arg: 0, ranges: [[0, 0]] }],
        make: (d, c)=>d.SetSoftwareVertexProcessing(c.arg(0) !== 0) },
    SetVertexShaderConstantF: constants('SetVertexShaderConstantF', 'floats', 4, 256),
    SetVertexShaderConstantI: constants('SetVertexShaderConstantI', 'ints', 4, 16),
    SetVertexShaderConstantB: constants('SetVertexShaderConstantB', 'words', 1, 16),
    SetPixelShaderConstantF: constants('SetPixelShaderConstantF', 'floats', 4, 224),
    SetPixelShaderConstantI: constants('SetPixelShaderConstantI', 'ints', 4, 16),
    SetPixelShaderConstantB: constants('SetPixelShaderConstantB', 'words', 1, 16),
    DrawIndexedPrimitive: { args: 6, draws: true, fresh: true,
        within: [{ arg: 0, ranges: [[1, 6]] }, { arg: 5, ranges: [[1, 0xffffffff]] }],
        needs: DRAW.SCENE | DRAW.DECLARED | DRAW.STREAM | DRAW.INDEXED,
        make: (d, c)=>d.DrawIndexedPrimitive(c.arg(0), c.arg(1) | 0, c.arg(2), c.arg(3),
            c.arg(4), c.arg(5)) },
    'StateBlock.Capture': { args: 1, self: true, objects: [0],
        make: (d, c)=>c.object()?.Capture() ?? D3DERR_INVALIDCALL },
    // What the block applies is the device's state, which the guest's getters
    // read from the device's block: they wait for the host (`FLAG_STALE`).
    'StateBlock.Apply': { args: 1, self: true, stale: true, objects: [0],
        make: (d, c)=>c.object()?.Apply() ?? D3DERR_INVALIDCALL },
});

export const { COMMANDS, commandSlot, commandObjects, runCommands } = set;
