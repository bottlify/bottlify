/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The calls a Direct3D 10 device's command ring carried
 * (`seam/d3d10-inguest.js`), made on the device in the order the program
 * made them, as Direct3D 8's and 9's are (`d3d8/commands.js`, whose reader
 * this is).
 *
 * Each is made with the arguments the seam's own handler of the call makes
 * it with: the same objects, the same numbers, the same structures -- so a
 * call through the ring and a call through a trap are one call to the
 * device, which is what the ring's gate holds them to.
 */

import { commandSet } from '../d3d8/commands.js';
import { ID3D10DEVICE_SLOTS } from './slots.js';

/**
 * The next `count` objects the record names.
 *
 * @param {import('../d3d8/commands.js').CommandArgs} c @param {number} count
 */
const objectsOf = (c, count)=>Array.from({ length: count }, ()=>c.object());

/** @param {number} word */
const floatOf = word=>new Float32Array(new Uint32Array([word]).buffer)[0];

/** A shader, a layout or a state: one object. @param {string} name */
const one = name=>({ args: 1, objects: [0],
    make: (/** @type {any} */ d, /** @type {any} */ c)=>{
        d[name](c.object());
    } });

/** A stage's slots: the first, how many, and the objects. @param {string} name */
const slots = name=>({ args: 2, copiedObjects: (/** @type {(i: number) => number} */ arg)=>arg(1),
    make: (/** @type {any} */ d, /** @type {any} */ c)=>{
        d[name](c.arg(0), objectsOf(c, c.arg(1)));
    } });

/** @type {Record<string, import('../d3d8/commands.js').CommandEntry>} */
const TABLE = {
    VSSetShader: one('VSSetShader'),
    PSSetShader: one('PSSetShader'),
    GSSetShader: one('GSSetShader'),
    IASetInputLayout: one('IASetInputLayout'),
    RSSetState: one('RSSetState'),
    IASetPrimitiveTopology: { args: 1, make: (d, c)=>{
        d.IASetPrimitiveTopology(c.arg(0));
    } },
    VSSetConstantBuffers: slots('VSSetConstantBuffers'),
    PSSetConstantBuffers: slots('PSSetConstantBuffers'),
    GSSetConstantBuffers: slots('GSSetConstantBuffers'),
    VSSetShaderResources: slots('VSSetShaderResources'),
    PSSetShaderResources: slots('PSSetShaderResources'),
    GSSetShaderResources: slots('GSSetShaderResources'),
    VSSetSamplers: slots('VSSetSamplers'),
    PSSetSamplers: slots('PSSetSamplers'),
    GSSetSamplers: slots('GSSetSamplers'),
    // The buffers, then the strides and the offsets, `count` words each.
    IASetVertexBuffers: { args: 2, copiedObjects: arg=>arg(1), make: (d, c)=>{
        const count = c.arg(1);
        d.IASetVertexBuffers(c.arg(0), objectsOf(c, count),
            Array.from(c.words.subarray(count, count * 2)),
            Array.from(c.words.subarray(count * 2, count * 3)));
    } },
    IASetIndexBuffer: { args: 3, objects: [0], make: (d, c)=>{
        d.IASetIndexBuffer(c.object(), c.arg(1), c.arg(2));
    } },
    // How many, the depth view, then the targets.
    OMSetRenderTargets: { args: 2, objects: [1], copiedObjects: arg=>arg(0), make: (d, c)=>{
        const depth = c.object();
        d.OMSetRenderTargets(objectsOf(c, c.arg(0)), depth);
    } },
    // The state, the mask, whether there is a factor, and its four floats.
    OMSetBlendState: { args: 3, objects: [0], make: (d, c)=>{
        d.OMSetBlendState(c.object(), c.arg(2) === 0 ? null : Array.from(c.floats.subarray(0, 4)),
            c.arg(1));
    } },
    OMSetDepthStencilState: { args: 2, objects: [0], make: (d, c)=>{
        d.OMSetDepthStencilState(c.object(), c.arg(1));
    } },
    // Six words a viewport: two signed, two unsigned, two floats.
    RSSetViewports: { args: 1, make: (d, c)=>{
        d.RSSetViewports(Array.from({ length: c.arg(0) }, (_, i)=>({
            TopLeftX: c.ints[i * 6], TopLeftY: c.ints[i * 6 + 1], Width: c.words[i * 6 + 2],
            Height: c.words[i * 6 + 3], MinDepth: c.floats[i * 6 + 4],
            MaxDepth: c.floats[i * 6 + 5],
        })));
    } },
    RSSetScissorRects: { args: 1, make: (d, c)=>{
        d.RSSetScissorRects(Array.from({ length: c.arg(0) }, (_, i)=>({
            left: c.ints[i * 4], top: c.ints[i * 4 + 1], right: c.ints[i * 4 + 2],
            bottom: c.ints[i * 4 + 3],
        })));
    } },
    Draw: { args: 2, make: (d, c)=>{
        d.Draw(c.arg(0), c.arg(1));
    } },
    DrawIndexed: { args: 3, make: (d, c)=>{
        d.DrawIndexed(c.arg(0), c.arg(1), c.arg(2) | 0);
    } },
    DrawInstanced: { args: 4, make: (d, c)=>{
        d.DrawInstanced(c.arg(0), c.arg(1), c.arg(2), c.arg(3));
    } },
    DrawIndexedInstanced: { args: 5, make: (d, c)=>{
        d.DrawIndexedInstanced(c.arg(0), c.arg(1), c.arg(2), c.arg(3) | 0, c.arg(4));
    } },
    ClearRenderTargetView: { args: 1, objects: [0], make: (d, c)=>{
        d.ClearRenderTargetView(c.object(), Array.from(c.floats.subarray(0, 4)));
    } },
    ClearDepthStencilView: { args: 4, objects: [0], make: (d, c)=>{
        d.ClearDepthStencilView(c.object(), c.arg(1), floatOf(c.arg(2)), c.arg(3) & 0xff);
    } },
    // The buffer, the storage it is on, and how it was mapped.
    'Buffer.Unmap': { args: 3, objects: [0], make: (d, c)=>{
        c.object()?.UnmapStorage(c.arg(1), c.arg(2));
    } },
    // Direct3D 11's viewports: six floats a viewport.
    'Context.RSSetViewports': { args: 1, make: (d, c)=>{
        d.RSSetViewports(Array.from({ length: c.arg(0) }, (_, i)=>({
            TopLeftX: c.floats[i * 6], TopLeftY: c.floats[i * 6 + 1], Width: c.floats[i * 6 + 2],
            Height: c.floats[i * 6 + 3], MinDepth: c.floats[i * 6 + 4],
            MaxDepth: c.floats[i * 6 + 5],
        })));
    } },
};

/**
 * Records numbered past the device's slots: a dynamic buffer's unmap, which
 * the guest made (`seam/d3d10-inguest.js`, `BufferUnmap`), and Direct3D 11's
 * viewports, which are floats where 10's are integers (`ContextRSSetViewports`).
 */
export const BUFFER_SLOTS = /** @type {[string, number][]} */ ([['Buffer.Unmap', 2],
    ['Context.RSSetViewports', 2]]);

/** The Direct3D 10 device's command set: its table, read by ID3D10Device's slots. */
export const D3D10_COMMANDS = commandSet([...ID3D10DEVICE_SLOTS, ...BUFFER_SLOTS], TABLE);
