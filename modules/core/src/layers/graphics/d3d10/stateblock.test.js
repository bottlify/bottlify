/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * State block masks and state blocks, after Wine's d3d10 device tests
 * (test_stateblock_mask, test_stateblock), whose expectations are the
 * runtime's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_BIND, D3D10_DRIVER_TYPE, D3D10_SDK_VERSION, D3D10_USAGE, DXGI_FORMAT, E_INVALIDARG, IID,
    S_OK,
} from './constants.js';
import { D3D10CreateDevice } from './device.js';
import {
    D3D10_DST, STATE_BLOCK_MASK, STATE_BLOCK_MASK_SIZE, createStateBlock, stateBlockMask,
} from './stateblock.js';
import { passThroughVertexShader } from './shader-fixtures.js';

const newMask = ()=>new Uint8Array(STATE_BLOCK_MASK_SIZE);

test('the mask is seventy-six bytes in the header\'s order', ()=>{
    assert.equal(STATE_BLOCK_MASK_SIZE, 76);
    assert.deepEqual([STATE_BLOCK_MASK.VS.at, STATE_BLOCK_MASK.VSSamplers.at,
        STATE_BLOCK_MASK.VSShaderResources.at, STATE_BLOCK_MASK.VSConstantBuffers.at,
        STATE_BLOCK_MASK.GS.at, STATE_BLOCK_MASK.PS.at, STATE_BLOCK_MASK.IAVertexBuffers.at,
        STATE_BLOCK_MASK.Predication.at], [0, 1, 3, 19, 21, 42, 63, 75]);
});

test('masks combine byte by byte, and a missing one is E_INVALIDARG', ()=>{
    const x = newMask();
    const y = newMask();
    const result = newMask();
    const { VS, Predication } = STATE_BLOCK_MASK;
    x[VS.at] = 0x33;
    y[VS.at] = 0x55;
    x[Predication.at] = 0x99;
    y[Predication.at] = 0xaa;
    assert.equal(stateBlockMask.Difference(x, y, result), S_OK);
    assert.deepEqual([result[VS.at], result[Predication.at]], [0x66, 0x33]);
    assert.equal(stateBlockMask.Intersect(x, y, result), S_OK);
    assert.deepEqual([result[VS.at], result[Predication.at]], [0x11, 0x88]);
    assert.equal(stateBlockMask.Union(x, y, result), S_OK);
    assert.deepEqual([result[VS.at], result[Predication.at]], [0x77, 0xbb]);
    for (const combine of [stateBlockMask.Difference, stateBlockMask.Intersect,
        stateBlockMask.Union])
    {
        assert.equal(combine(null, y, result), E_INVALIDARG);
        assert.equal(combine(x, null, result), E_INVALIDARG);
        assert.equal(combine(x, y, null), E_INVALIDARG);
    }
    result.fill(0xff);
    assert.equal(stateBlockMask.DisableAll(result), S_OK);
    assert.deepEqual([result[VS.at], result[Predication.at]], [0, 0]);
    assert.equal(stateBlockMask.DisableAll(null), E_INVALIDARG);
    assert.equal(stateBlockMask.EnableAll(result), S_OK);
    assert.deepEqual([result[VS.at], result[Predication.at]], [0xff, 0xff]);
    assert.equal(stateBlockMask.EnableAll(null), E_INVALIDARG);
});

test('a capture is enabled or disabled slot by slot, within the state\'s slots', ()=>{
    const mask = newMask();
    const { VS, VSShaderResources } = STATE_BLOCK_MASK;
    mask[VS.at] = 0xff;
    assert.equal(stateBlockMask.DisableCapture(mask, D3D10_DST.VS, 0, 1), S_OK);
    assert.equal(mask[VS.at], 0xfe);
    assert.equal(stateBlockMask.DisableCapture(mask, D3D10_DST.VS, 0, 4), E_INVALIDARG);
    assert.equal(stateBlockMask.DisableCapture(mask, D3D10_DST.VS, 1, 1), E_INVALIDARG);
    assert.equal(stateBlockMask.DisableCapture(null, D3D10_DST.VS, 0, 1), E_INVALIDARG);
    mask[VS.at] = 0;
    assert.equal(stateBlockMask.EnableCapture(mask, D3D10_DST.VS, 0, 1), S_OK);
    assert.equal(mask[VS.at], 0x01);
    assert.equal(stateBlockMask.EnableCapture(mask, D3D10_DST.VS, 0, 4), E_INVALIDARG);
    assert.equal(stateBlockMask.EnableCapture(mask, 99, 0, 1), E_INVALIDARG, 'no such state');

    /** @type {[number, number, number[], number[]][]} start, count, disabled, enabled */
    const runs = [
        [8, 4, [0xff, 0xf0, 0xff, 0xff, 0xff], [0x00, 0x0f, 0x00, 0x00, 0x00]],
        [13, 4, [0xff, 0x1f, 0xfe, 0xff, 0xff], [0x00, 0xe0, 0x01, 0x00, 0x00]],
        [9, 12, [0xff, 0x01, 0xe0, 0xff, 0xff], [0x00, 0xfe, 0x1f, 0x00, 0x00]],
        [15, 12, [0xff, 0x7f, 0x00, 0xf8, 0xff], [0x00, 0x80, 0xff, 0x07, 0x00]],
    ];
    const resources = (/** @type {Uint8Array} */ bytes)=>
        [...bytes.subarray(VSShaderResources.at, VSShaderResources.at + 5)];
    for (const [start, count, disabled, enabled] of runs)
    {
        mask.fill(0xff);
        assert.equal(stateBlockMask.DisableCapture(mask, D3D10_DST.VS_SHADER_RESOURCES, start,
            count), S_OK);
        assert.deepEqual(resources(mask), disabled, `disable ${start}+${count}`);
        mask.fill(0);
        assert.equal(stateBlockMask.EnableCapture(mask, D3D10_DST.VS_SHADER_RESOURCES, start,
            count), S_OK);
        assert.deepEqual(resources(mask), enabled, `enable ${start}+${count}`);
    }
});

test('a setting reads back as its bit, not as a boolean', ()=>{
    const mask = newMask();
    mask[STATE_BLOCK_MASK.VS.at] = 0xff;
    assert.equal(stateBlockMask.GetSetting(mask, D3D10_DST.VS, 0), 1);
    assert.equal(stateBlockMask.GetSetting(mask, D3D10_DST.VS, 1), 0, 'past the one slot');
    mask[STATE_BLOCK_MASK.VS.at] = 0xfe;
    assert.equal(stateBlockMask.GetSetting(mask, D3D10_DST.VS, 0), 0);
    mask.fill(0xff);
    assert.equal(stateBlockMask.GetSetting(mask, D3D10_DST.VS_SHADER_RESOURCES, 3), 8);
    assert.equal(stateBlockMask.GetSetting(mask, D3D10_DST.VS_SHADER_RESOURCES, 128), 0);
    mask.fill(0);
    assert.equal(stateBlockMask.GetSetting(mask, D3D10_DST.VS_SHADER_RESOURCES, 3), 0);
});

test('a block captures what its mask selects and applies it back, and nothing else', ()=>{
    /** @type {{ device?: any }} */
    const made = {};
    assert.equal(D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, D3D10_SDK_VERSION,
        made), S_OK);
    const device = made.device;
    /** @type {{ shader?: any }} */
    const vs = {};
    assert.equal(device.CreateVertexShader(passThroughVertexShader(), vs), S_OK);
    /** @type {{ resource?: any }} */
    const indices = {};
    assert.equal(device.CreateBuffer({
        ByteWidth: 64, Usage: D3D10_USAGE.DEFAULT, BindFlags: D3D10_BIND.INDEX_BUFFER,
        CPUAccessFlags: 0, MiscFlags: 0,
    }, null, indices), S_OK);

    const mask = newMask();
    stateBlockMask.EnableAll(mask);
    stateBlockMask.DisableCapture(mask, D3D10_DST.OM_BLEND_STATE, 0, 1);
    stateBlockMask.DisableCapture(mask, D3D10_DST.VS, 0, 1);
    stateBlockMask.DisableCapture(mask, D3D10_DST.IA_INDEX_BUFFER, 0, 1);

    device.OMSetBlendState(null, [0.1, 0, 0, 0], 0);
    device.VSSetShader(vs.shader);
    device.IASetIndexBuffer(indices.resource, DXGI_FORMAT.R16_UINT, 0);
    device.IASetPrimitiveTopology(4);
    const block = createStateBlock(device, mask);
    assert.ok(block.supports(IID.ID3D10StateBlock));
    assert.equal(block.Capture(), S_OK);

    device.OMSetBlendState(null, [0.2, 0, 0, 0], 0);
    device.VSSetShader(null);
    device.IASetIndexBuffer(null, 0, 0);
    device.IASetPrimitiveTopology(1);
    assert.equal(block.Apply(), S_OK);

    /** @type {{ blendFactor?: number[] }} */
    const blend = {};
    device.OMGetBlendState(blend);
    assert.equal(blend.blendFactor?.[0], 0.2, 'the blend state was left out');
    /** @type {{ shader?: any }} */
    const shader = {};
    device.VSGetShader(shader);
    assert.equal(shader.shader, null);
    /** @type {{ buffer?: any }} */
    const index = {};
    device.IAGetIndexBuffer(index);
    assert.equal(index.buffer, null);
    /** @type {{ topology?: number }} */
    const topology = {};
    device.IAGetPrimitiveTopology(topology);
    assert.equal(topology.topology, 4, 'the topology was captured and applied');

    /** @type {{ device?: any }} */
    const owner = {};
    assert.equal(block.GetDevice(owner), S_OK);
    assert.equal(owner.device, device);
    owner.device.release();
    assert.equal(block.release(), 0);
});

test('a block holds what it captured until the next capture or its end', ()=>{
    /** @type {{ device?: any }} */
    const made = {};
    assert.equal(D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, D3D10_SDK_VERSION,
        made), S_OK);
    const device = made.device;
    /** @type {{ shader?: any }} */
    const vs = {};
    assert.equal(device.CreateVertexShader(passThroughVertexShader(), vs), S_OK);
    device.VSSetShader(vs.shader);
    const mask = newMask();
    stateBlockMask.EnableCapture(mask, D3D10_DST.VS, 0, 1);
    const block = createStateBlock(device, mask);
    block.Capture();
    assert.equal(vs.shader.release(), 1, 'the block\'s reference remains');
    device.VSSetShader(null);
    block.Apply();
    /** @type {{ shader?: any }} */
    const shader = {};
    device.VSGetShader(shader);
    assert.equal(shader.shader, vs.shader, 'applied from the block\'s own reference');
    shader.shader.release();
    device.VSSetShader(null);
    assert.equal(block.ReleaseAllDeviceObjects(), S_OK);
    assert.equal(vs.shader.refCount, 0, 'let go');
    block.release();
});
