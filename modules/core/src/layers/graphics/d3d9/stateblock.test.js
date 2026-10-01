/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DERR_INVALIDCALL, D3DFMT, D3DRS, D3DSWAPEFFECT, D3D_OK } from './constants.js';
import { D3DFMT_INDEX, D3DPOOL, D3DTS } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { D3DSBT, PIXEL_RENDER_STATES, VERTEX_RENDER_STATES } from './stateblock.js';
import { D3DSAMP, D3DTSS9 } from './samplerstates.js';
import { DEFAULT_RENDER_STATES } from './renderstates.js';

function createDevice(){
    const d3d = createDirect3D9({ vertexShaderVersion: { major: 2, minor: 0 } });
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferWidth: 64,
        backBufferHeight: 64,
        backBufferFormat: D3DFMT.X8R8G8B8,
    }, out), D3D_OK);
    return out.device;
}

/** @param {any} device @param {number} state */
const renderState = (device, state)=>{
    /** @type {{ value?: number }} */
    const out = {};
    assert.equal(device.GetRenderState(state, out), D3D_OK);
    return out.value;
};

test('a recorded state is not applied until the block is, and the block is what applies it', ()=>{
    const device = createDevice();
    assert.equal(renderState(device, D3DRS.LIGHTING), 1);

    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.BeginStateBlock(), D3DERR_INVALIDCALL, 'one recording at a time');
    assert.equal(device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
    assert.equal(device.SetSamplerState(2, D3DSAMP.MAGFILTER, 2), D3D_OK);
    assert.equal(device.SetTextureStageState(1, D3DTSS9.COLOROP, 4), D3D_OK);
    // What was set while recording is not what the device reads back.
    assert.equal(renderState(device, D3DRS.LIGHTING), 1);

    /** @type {{ block?: any }} */
    const out = {};
    assert.equal(device.EndStateBlock(out), D3D_OK);
    assert.ok(out.block);
    /** @type {{ block?: any }} */
    const again = {};
    assert.equal(device.EndStateBlock(again), D3DERR_INVALIDCALL, 'nothing was recording');
    assert.equal(again.block, undefined, 'and the caller\'s pointer is left alone');

    assert.equal(renderState(device, D3DRS.LIGHTING), 1, 'ending the block applies nothing');
    assert.equal(out.block.Apply(), D3D_OK);
    assert.equal(renderState(device, D3DRS.LIGHTING), 0);
    /** @type {{ value?: number }} */
    const sampler = {};
    assert.equal(device.GetSamplerState(2, D3DSAMP.MAGFILTER, sampler), D3D_OK);
    assert.equal(sampler.value, 2);
    /** @type {{ value?: number }} */
    const stage = {};
    assert.equal(device.GetTextureStageState(1, D3DTSS9.COLOROP, stage), D3D_OK);
    assert.equal(stage.value, 4);

    // A block holds only what was recorded: another state is untouched.
    assert.equal(renderState(device, D3DRS.ZENABLE), 0);
    assert.equal(out.block.release(), 0);
    assert.equal(device.release(), 0);
});

test('a block records a shader, declaration, indices and stream set to what is in force', ()=>{
    // A set that changes nothing is passed over outside a recording; inside
    // one it is the block's, and applied later it puts back what it named.
    const device = createDevice();
    /** @type {{ shader?: any }} */
    const shader = {};
    assert.equal(device.CreateVertexShader([0xfffe0200, 0x0000ffff], shader), D3D_OK);
    /** @type {{ declaration?: any }} */
    const declaration = {};
    assert.equal(device.CreateVertexDeclaration([
        { Stream: 0, Offset: 0, Type: 2, Method: 0, Usage: 0, UsageIndex: 0 },
    ], declaration), D3D_OK);
    /** @type {{ buffer?: any }} */
    const vertices = {};
    assert.equal(device.CreateVertexBuffer(64, 0, 0, D3DPOOL.MANAGED, vertices), D3D_OK);
    /** @type {{ buffer?: any }} */
    const indices = {};
    assert.equal(device.CreateIndexBuffer(64, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices),
        D3D_OK);
    const bind = ()=>{
        assert.equal(device.SetVertexShader(shader.shader), D3D_OK);
        assert.equal(device.SetVertexDeclaration(declaration.declaration), D3D_OK);
        assert.equal(device.SetIndices(indices.buffer), D3D_OK);
        assert.equal(device.SetStreamSource(0, vertices.buffer, 8, 12), D3D_OK);
    };
    bind();
    assert.equal(device.BeginStateBlock(), D3D_OK);
    bind();
    /** @type {{ block?: any }} */
    const out = {};
    assert.equal(device.EndStateBlock(out), D3D_OK);

    assert.equal(device.SetVertexShader(null), D3D_OK);
    assert.equal(device.SetVertexDeclaration(null), D3D_OK);
    assert.equal(device.SetIndices(null), D3D_OK);
    assert.equal(device.SetStreamSource(0, null, 0, 0), D3D_OK);
    assert.equal(out.block.Apply(), D3D_OK);

    /** @type {{ shader?: any }} */
    const heldShader = {};
    assert.equal(device.GetVertexShader(heldShader), D3D_OK);
    assert.equal(heldShader.shader, shader.shader);
    /** @type {{ declaration?: any }} */
    const heldDeclaration = {};
    assert.equal(device.GetVertexDeclaration(heldDeclaration), D3D_OK);
    assert.equal(heldDeclaration.declaration, declaration.declaration);
    /** @type {{ buffer?: any }} */
    const heldIndices = {};
    assert.equal(device.GetIndices(heldIndices), D3D_OK);
    assert.equal(heldIndices.buffer, indices.buffer);
    /** @type {{ buffer?: any, offset?: number, stride?: number }} */
    const stream = {};
    assert.equal(device.GetStreamSource(0, stream), D3D_OK);
    assert.deepEqual([stream.buffer, stream.offset, stream.stride], [vertices.buffer, 8, 12]);
});

test('capture and apply are refused while another block is recording, and so is a create', ()=>{
    const device = createDevice();
    /** @type {{ block?: any }} */
    const made = {};
    assert.equal(device.CreateStateBlock(D3DSBT.ALL, made), D3D_OK);

    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(made.block.Capture(), D3DERR_INVALIDCALL);
    assert.equal(made.block.Apply(), D3DERR_INVALIDCALL);
    /** @type {{ block?: any }} */
    const refused = {};
    assert.equal(device.CreateStateBlock(D3DSBT.ALL, refused), D3DERR_INVALIDCALL);
    assert.equal(refused.block, undefined);
    /** @type {{ block?: any }} */
    const other = {};
    assert.equal(device.EndStateBlock(other), D3D_OK);

    assert.equal(made.block.Capture(), D3D_OK);
    assert.equal(made.block.Apply(), D3D_OK);
    assert.equal(device.CreateStateBlock(0, other), D3DERR_INVALIDCALL, 'no such block type');
    assert.equal(device.CreateStateBlock(4, other), D3DERR_INVALIDCALL);

    made.block.release();
    other.block.release();
    assert.equal(device.release(), 0);
});

test('a captured block takes the values of the moment and keeps its set of states', ()=>{
    const device = createDevice();
    device.SetRenderState(D3DRS.ALPHAREF, 10);
    /** @type {{ block?: any }} */
    const made = {};
    assert.equal(device.CreateStateBlock(D3DSBT.ALL, made), D3D_OK);

    device.SetRenderState(D3DRS.ALPHAREF, 20);
    assert.equal(made.block.Apply(), D3D_OK);
    assert.equal(renderState(device, D3DRS.ALPHAREF), 10, 'the value at creation');

    device.SetRenderState(D3DRS.ALPHAREF, 30);
    assert.equal(made.block.Capture(), D3D_OK);
    device.SetRenderState(D3DRS.ALPHAREF, 40);
    assert.equal(made.block.Apply(), D3D_OK);
    assert.equal(renderState(device, D3DRS.ALPHAREF), 30, 'the value at capture');

    made.block.release();
    assert.equal(device.release(), 0);
});

test('a pixel block leaves the vertex half alone and a vertex block the pixel half', ()=>{
    const device = createDevice();
    /** @type {{ block?: any }} */
    const pixel = {};
    /** @type {{ block?: any }} */
    const vertex = {};
    assert.equal(device.CreateStateBlock(D3DSBT.PIXELSTATE, pixel), D3D_OK);
    assert.equal(device.CreateStateBlock(D3DSBT.VERTEXSTATE, vertex), D3D_OK);

    // ZENABLE is pixel state, LIGHTING is vertex state; both were captured at
    // their defaults, and both are now changed.
    device.SetRenderState(D3DRS.ZENABLE, 1);
    device.SetRenderState(D3DRS.LIGHTING, 0);
    assert.equal(pixel.block.Apply(), D3D_OK);
    assert.equal(renderState(device, D3DRS.ZENABLE), 0, 'restored by the pixel block');
    assert.equal(renderState(device, D3DRS.LIGHTING), 0, 'left alone by it');

    device.SetRenderState(D3DRS.ZENABLE, 1);
    assert.equal(vertex.block.Apply(), D3D_OK);
    assert.equal(renderState(device, D3DRS.LIGHTING), 1, 'restored by the vertex block');
    assert.equal(renderState(device, D3DRS.ZENABLE), 1, 'left alone by it');

    // A texture is in neither half, only in a block of everything.
    /** @type {{ texture?: any }} */
    const held = {};
    assert.equal(device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, 1, held), D3D_OK);
    device.SetTexture(0, held.texture);
    assert.equal(pixel.block.Apply(), D3D_OK);
    /** @type {{ texture?: any }} */
    const bound = {};
    device.GetTexture(0, bound);
    assert.equal(bound.texture, held.texture);
    bound.texture.release();

    device.SetTexture(0, null);
    held.texture.release();
    pixel.block.release();
    vertex.block.release();
    assert.equal(device.release(), 0);
});

test('every render state is in a half, and the two halves cover the defaults table', ()=>{
    // The fog distances and the shade mode belong to both halves, so the
    // union is what has to be complete rather than the two being disjoint.
    const named = new Set([...PIXEL_RENDER_STATES, ...VERTEX_RENDER_STATES]);
    for (const entry of DEFAULT_RENDER_STATES)
    {
        if (entry.capturedByStateBlock === false)
        {
            continue;
        }
        assert.ok(named.has(entry.name), `${entry.name} is in a state block half`);
    }
});

test('a block of everything restores transforms, shaders, the declaration and the constants', ()=>{
    const device = createDevice();
    device.SetTransform(D3DTS.VIEW, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    device.SetFVF(0x002);
    device.SetVertexShaderConstantF(3, [1, 2, 3, 4], 1);
    /** @type {{ block?: any }} */
    const all = {};
    assert.equal(device.CreateStateBlock(D3DSBT.ALL, all), D3D_OK);

    device.SetTransform(D3DTS.VIEW, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    device.SetFVF(0x042);
    device.SetVertexShaderConstantF(3, [9, 9, 9, 9], 1);
    assert.equal(all.block.Apply(), D3D_OK);

    /** @type {{ matrix?: Float32Array }} */
    const matrix = {};
    device.GetTransform(D3DTS.VIEW, matrix);
    assert.equal(matrix.matrix?.[0], 2);
    /** @type {{ fvf?: number }} */
    const fvf = {};
    device.GetFVF(fvf);
    assert.equal(fvf.fvf, 0x002);
    /** @type {{ values?: Float32Array }} */
    const constants = {};
    device.GetVertexShaderConstantF(3, 1, constants);
    assert.deepEqual([...(constants.values ?? [])], [1, 2, 3, 4]);

    all.block.release();
    assert.equal(device.release(), 0);
});

test('a light recorded by enabling alone is applied with the light the device holds', ()=>{
    const device = createDevice();
    device.LightEnable(0, true);
    /** @type {{ light?: any }} */
    const before = {};
    device.GetLight(0, before);

    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.LightEnable(0, false), D3D_OK);
    /** @type {{ block?: any }} */
    const out = {};
    assert.equal(device.EndStateBlock(out), D3D_OK);
    /** @type {{ enabled?: number }} */
    const enabled = {};
    device.GetLightEnable(0, enabled);
    assert.equal(enabled.enabled, 128, 'not applied while recording');

    assert.equal(out.block.Apply(), D3D_OK);
    device.GetLightEnable(0, enabled);
    assert.equal(enabled.enabled, 0);
    /** @type {{ light?: any }} */
    const after = {};
    device.GetLight(0, after);
    assert.deepEqual(after.light, before.light, 'the light itself was not replaced');

    out.block.release();
    assert.equal(device.release(), 0);
});
