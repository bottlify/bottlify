/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 10's ring routines in the guest answer and write as their
 * JavaScript, input by input, on cork's test machine: a device with no
 * block, no ring, the host's flag, its lock held, a ring nearly full; arrays
 * of every length up to past what a record holds, and null ones. What the
 * records make the device do against the host's own methods is the ring's
 * gate (`d3d10-ring.itest.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED as compiled } from './d3d10-inguest.x86.js';

/** @type {Record<string, any>} */
const COMPILED = compiled;
import * as sources from './d3d10-inguest.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { FLAG_SLOW_PATH, SHADOW } from './shadow.js';
import { ID3D10DEVICE_SLOTS } from './d3d10.js';
import { BUFFER10 } from './d3d10-ring.js';
import { D3D10_COMMANDS } from '../d3d10/commands.js';

const { same } = equivalence(COMPILED, sources);
const HANDED = { host: ()=>0x0badf00d };

const SELF = DATA;
const BLOCK = DATA + 0x100;
const RING = BLOCK + 0x1800;
const RING_BYTES = 0x400;
const ARRAYS = RING + RING_BYTES;

test('the offsets and slots the guest code reads are the block\'s and the device\'s', async()=>{
    const text = await readFile(new URL('./d3d10-inguest.js', import.meta.url), 'utf8');
    /** @param {string} name */
    const literal = name=>Number(new RegExp(`^const ${name} = (\\d+);`, 'm').exec(text)?.[1]);
    assert.equal(literal('COMMANDS'), SHADOW.COMMANDS);
    assert.equal(literal('COMMAND_BYTES'), SHADOW.COMMAND_BYTES);
    assert.equal(literal('COMMAND_HEAD'), SHADOW.COMMAND_HEAD);
    assert.equal(literal('HELD'), SHADOW.HELD);
    assert.equal(literal('FLAG_SLOW_PATH'), FLAG_SLOW_PATH);
    assert.ok(BLOCK + SHADOW.SIZE <= RING);
    // Each method's slot, by its name in capitals.
    let checked = 0;
    for (const [name] of ID3D10DEVICE_SLOTS)
    {
        const constant = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
            .replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
        const value = literal(constant);
        if (!Number.isNaN(value))
        {
            checked++;
            assert.equal(value, 3 + ID3D10DEVICE_SLOTS.findIndex(([entry])=>entry === name),
                name);
        }
    }
    assert.equal(checked, 28, 'every routine has its slot');
    assert.equal(literal('BUFFER_UNMAP'), D3D10_COMMANDS.commandSlot('Buffer.Unmap'));
    for (const [name, offset] of Object.entries({ B_FLAGS: BUFFER10.FLAGS,
        B_DEVICE: BUFFER10.DEVICE, B_CURRENT: BUFFER10.CURRENT, B_MAPPED: BUFFER10.MAPPED,
        B_FREE: BUFFER10.FREE, B_STORAGES: BUFFER10.STORAGES }))
    {
        assert.equal(literal(name), offset, name);
    }
});

/** Each routine's arguments after `this`, drawn: counts, pointers and words. */
const SHAPES = /** @type {Record<string, (next: () => number) => number[]>} */ ({
    VSSetShader: next=>[next()],
    PSSetShader: next=>[next()],
    GSSetShader: next=>[next()],
    IASetInputLayout: next=>[next()],
    IASetPrimitiveTopology: next=>[next() % 12],
    RSSetState: next=>[next()],
    VSSetConstantBuffers: next=>[next() % 14, count(next), array(next)],
    PSSetConstantBuffers: next=>[next() % 14, count(next), array(next)],
    GSSetConstantBuffers: next=>[next() % 14, count(next), array(next)],
    VSSetShaderResources: next=>[next() % 128, count(next), array(next)],
    PSSetShaderResources: next=>[next() % 128, count(next), array(next)],
    GSSetShaderResources: next=>[next() % 128, count(next), array(next)],
    VSSetSamplers: next=>[next() % 16, count(next), array(next)],
    PSSetSamplers: next=>[next() % 16, count(next), array(next)],
    GSSetSamplers: next=>[next() % 16, count(next), array(next)],
    IASetVertexBuffers: next=>[next() % 16, count(next), array(next), array(next) + 0x80,
        array(next) + 0x100],
    IASetIndexBuffer: next=>[next(), [57, 42, 0][next() % 3], next() % 4096],
    OMSetRenderTargets: next=>[next() % 10, array(next), next()],
    OMSetBlendState: next=>[next(), array(next), next()],
    OMSetDepthStencilState: next=>[next(), next() % 256],
    RSSetViewports: next=>[count(next), array(next)],
    RSSetScissorRects: next=>[count(next), array(next)],
    Draw: next=>[next() % 4096, next() % 4096],
    DrawIndexed: next=>[next() % 4096, next() % 4096, next()],
    DrawInstanced: next=>[next() % 4096, next() % 64, next() % 4096, next() % 64],
    DrawIndexedInstanced: next=>[next() % 4096, next() % 64, next() % 4096, next(), next() % 64],
    ClearRenderTargetView: next=>[next(), next() % 8 === 0 ? 0 : ARRAYS],
    ClearDepthStencilView: next=>[next(), next() % 4, next(), next()],
});

/** @param {() => number} next */
function count(next){
    return [0, 1, 2, 3, 8, 16, 17, 40][next() % 8];
}

/** @param {() => number} next */
function array(next){
    return next() % 10 === 0 ? 0 : ARRAYS;
}

test('every ring routine in the guest answers and writes as its JavaScript', ()=>{
    const next = random(10);
    for (const [name, argsOf] of Object.entries(SHAPES))
    {
        assert.ok(COMPILED[name], `${name} is compiled`);
        for (let round = 0; round < 150; round++)
        {
            const bytes = new Uint8Array(ARRAYS + 0x200 - DATA);
            const view = new DataView(bytes.buffer);
            view.setUint32(SELF - DATA + 4, next() % 12 === 0 ? 0 : BLOCK, true);
            const at = BLOCK - DATA;
            view.setUint32(at, next() % 10 === 0 ? FLAG_SLOW_PATH : 0, true);
            view.setUint32(at + SHADOW.COMMANDS, next() % 12 === 0 ? 0 : RING, true);
            view.setUint32(at + SHADOW.COMMAND_BYTES, RING_BYTES, true);
            view.setUint32(at + SHADOW.COMMAND_HEAD,
                [0, 4, 64, RING_BYTES - 64, RING_BYTES - 12, RING_BYTES][next() % 6], true);
            view.setUint32(at + SHADOW.HELD, next() % 10 === 0 ? 2 : 0, true);
            for (let word = 0; word < 0x200 / 4; word++)
            {
                view.setUint32(ARRAYS - DATA + word * 4, next(), true);
            }
            same(name, { stack: [SELF, ...argsOf(next)], memory: [[DATA, bytes]] }, HANDED);
        }
    }
});

test('a dynamic buffer\'s map and unmap in the guest answer and write as their JavaScript', ()=>{
    const next = random(12);
    // A buffer's block past the arrays, its device's block the one above.
    const BUFFER = ARRAYS + 0x200;
    for (let round = 0; round < 2000; round++)
    {
        const bytes = new Uint8Array(BUFFER + BUFFER10.SIZE + 0x40 - DATA);
        const view = new DataView(bytes.buffer);
        view.setUint32(SELF - DATA + 4, next() % 12 === 0 ? 0 : BUFFER, true);
        const device = BLOCK - DATA;
        view.setUint32(device, next() % 10 === 0 ? FLAG_SLOW_PATH : 0, true);
        view.setUint32(device + SHADOW.COMMANDS, next() % 12 === 0 ? 0 : RING, true);
        view.setUint32(device + SHADOW.COMMAND_BYTES, RING_BYTES, true);
        view.setUint32(device + SHADOW.COMMAND_HEAD, [0, 64, RING_BYTES - 12][next() % 3], true);
        view.setUint32(device + SHADOW.HELD, next() % 10 === 0 ? 2 : 0, true);
        const at = BUFFER - DATA;
        view.setUint32(at + BUFFER10.FLAGS, next() % 10 === 0 ? FLAG_SLOW_PATH : 0, true);
        view.setUint32(at + BUFFER10.DEVICE, next() % 12 === 0 ? 0 : BLOCK, true);
        view.setUint32(at + BUFFER10.CURRENT, 0x20000 + (next() % 4) * 0x1000, true);
        view.setUint32(at + BUFFER10.LENGTH, 0x800, true);
        view.setUint32(at + BUFFER10.MAPPED, [0, 0, 0, 4, 5][next() % 5], true);
        const storages = 1 + next() % 4;
        view.setUint32(at + BUFFER10.COUNT, storages, true);
        view.setUint32(at + BUFFER10.FREE, next() & ((1 << storages) - 1), true);
        for (let index = 0; index < storages; index++)
        {
            view.setUint32(at + BUFFER10.STORAGES + index * 4, 0x20000 + index * 0x1000, true);
        }
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, bytes]]);
        const type = [4, 4, 5, 5, 1, 2, 3, next()][next() % 8];
        const out = next() % 10 === 0 ? 0 : ARRAYS;
        same('BufferMap', { stack: [SELF, type, next() % 3 === 0 ? 0x100000 : 0, out], memory },
            HANDED);
        same('BufferUnmap', { stack: [SELF], memory }, HANDED);
        // Direct3D 11's context: an immediate one's word is its device's block,
        // a deferred one's zero, which leaves its maps to the host.
        const CONTEXT = ARRAYS + 0x100;
        view.setUint32(CONTEXT - DATA + 4, next() % 3 === 0 ? 0 : BLOCK, true);
        same('ContextMap', { stack: [CONTEXT, SELF, next() % 8 === 0 ? 1 : 0, type,
            next() % 3 === 0 ? 0x100000 : 0, out], memory }, HANDED);
        same('ContextUnmap', { stack: [CONTEXT, SELF, next() % 8 === 0 ? 1 : 0], memory },
            HANDED);
    }
});

test('a deferred context\'s map and unmap are the host\'s (test_deferred_context_map)', ()=>{
    const memory = new Uint8Array(0x100);
    const words = new DataView(memory.buffer);
    let handed = 0;
    const guest = /** @type {any} */ ({
        u32: (/** @type {number} */ at)=>words.getUint32(at, true),
        setU32: (/** @type {number} */ at, /** @type {number} */ value)=>{
            words.setUint32(at, value, true);
        },
        compareExchange: ()=>0,
        host: ()=>{
            handed++;
            return 0;
        },
    });
    // The context at 0x10, its word past the pointer zero; a resource at 0x40.
    sources.ContextMap(guest, 0x10, 0x40, 0, 4, 0, 0x80);
    sources.ContextUnmap(guest, 0x10, 0x40, 0);
    assert.equal(handed, 2);
});
