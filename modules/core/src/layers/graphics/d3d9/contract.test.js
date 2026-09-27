/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Direct3D 9 device answers beyond drawing: the checks a program makes
 * before it creates one, the objects it makes afterwards, and the refusals
 * that send it down another path. Each expectation is the documented one, or
 * the one a conformance test of the real runtime pins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL, D3DERR_NOTAVAILABLE, D3DERR_NOTFOUND, D3DFMT,
    D3DPOOL, D3DRS, D3DRTYPE, D3DSWAPEFFECT, D3DUSAGE, D3D_OK,
} from './constants.js';
import { D3DCLEAR, D3DFMT_INDEX, D3DPT, D3DTS } from '../d3d8/constants.js';
import {
    D3DCREATE, D3DISSUE, D3DQUERYTYPE, DEVICE_STATE, createDirect3D9,
} from './device.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from './declaration.js';
import { END_TOKEN, SHADER_KIND, versionToken } from './shader.js';
import { D3DSAMP } from './samplerstates.js';

const FVF_XYZ = 0x002;
const FVF_XYZ_DIFFUSE = 0x042;

/**
 * @param {{ caps?: object, parameters?: object, behaviour?: number, services?: object }} [options]
 */
function make(options = {}){
    const d3d = createDirect3D9({ ...options.caps, ...options.services });
    /** @type {{ device?: any }} */
    const out = {};
    const parameters = {
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: 64,
        backBufferHeight: 48,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
        ...options.parameters,
    };
    assert.equal(d3d.CreateDevice(parameters, out, options.behaviour ?? 0,
        { AdapterOrdinal: 0, DeviceType: 1, hFocusWindow: 0x1234 }), D3D_OK);
    return { d3d, device: out.device };
}

/** @param {number} usage @param {number} type @param {number} offset @param {number} index */
const element = (usage, type, offset, index = 0)=>({
    Stream: 0, Offset: offset, Type: type, Method: 0, Usage: usage, UsageIndex: index,
});

const VS_2_0_EMPTY = [versionToken(SHADER_KIND.VERTEX, 2, 0), END_TOKEN];
const PS_2_0_EMPTY = [versionToken(SHADER_KIND.PIXEL, 2, 0), END_TOKEN];

// --- the object behind Direct3DCreate9 ---

test('the adapter answers format questions from the table its creates consult', ()=>{
    const { d3d } = make();
    assert.equal(d3d.CheckDeviceType(D3DFMT.X8R8G8B8, D3DFMT.A8R8G8B8, true), D3D_OK);
    assert.equal(d3d.CheckDeviceType(D3DFMT.X8R8G8B8, D3DFMT.UNKNOWN, true), D3D_OK,
        'an unknown back buffer format means the adapter\'s, windowed');
    assert.equal(d3d.CheckDeviceType(D3DFMT.X8R8G8B8, D3DFMT.UNKNOWN, false),
        D3DERR_NOTAVAILABLE, 'and is not allowed full screen');
    assert.equal(d3d.CheckDeviceType(D3DFMT.D24S8, D3DFMT.X8R8G8B8, true), D3DERR_NOTAVAILABLE);

    assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.TEXTURE, D3DFMT.A8R8G8B8), D3D_OK);
    assert.equal(d3d.CheckDeviceFormat(D3DUSAGE.RENDERTARGET, D3DRTYPE.TEXTURE, D3DFMT.A8R8G8B8),
        D3D_OK);
    assert.equal(d3d.CheckDeviceFormat(D3DUSAGE.DEPTHSTENCIL, D3DRTYPE.SURFACE, D3DFMT.D24S8),
        D3D_OK);
    assert.equal(d3d.CheckDeviceFormat(D3DUSAGE.RENDERTARGET, D3DRTYPE.SURFACE, D3DFMT.D24S8),
        D3DERR_NOTAVAILABLE, 'a depth format is not a colour target');
    assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.TEXTURE, D3DFMT.D24S8), D3DERR_NOTAVAILABLE,
        'depth textures are off unless the capability says otherwise');
    assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.TEXTURE, D3DFMT.DXT1), D3D_OK,
        'a compressed format is legal whatever compressedTextures says -- it only chooses'
            + ' how the surface travels to the GPU');
    assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.VOLUMETEXTURE, D3DFMT.A8R8G8B8), D3D_OK);
    assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.VOLUMETEXTURE, D3DFMT.DXT1),
        D3DERR_NOTAVAILABLE, 'a volume is never made in blocks');
    assert.equal(d3d.CheckDeviceFormat(D3DUSAGE.RENDERTARGET, D3DRTYPE.VOLUMETEXTURE,
        D3DFMT.A8R8G8B8), D3DERR_NOTAVAILABLE, 'nor drawn into');
    assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.TEXTURE, 999), D3DERR_NOTAVAILABLE);

    /** @type {{ qualityLevels?: number }} */
    const quality = {};
    assert.equal(d3d.CheckDeviceMultiSampleType(0, quality), D3D_OK);
    assert.equal(quality.qualityLevels, 1);
    assert.equal(d3d.CheckDeviceMultiSampleType(2, quality), D3DERR_NOTAVAILABLE);
    assert.equal(d3d.CheckDepthStencilMatch(D3DFMT.X8R8G8B8, D3DFMT.D16), D3D_OK);
    assert.equal(d3d.CheckDepthStencilMatch(D3DFMT.X8R8G8B8, D3DFMT.X8R8G8B8),
        D3DERR_NOTAVAILABLE);
    assert.equal(d3d.CheckDeviceFormatConversion(D3DFMT.R5G6B5, D3DFMT.X8R8G8B8), D3D_OK);
    assert.equal(d3d.CheckDeviceFormatConversion(D3DFMT.D16, D3DFMT.X8R8G8B8),
        D3DERR_NOTAVAILABLE);
});

test('a device remembers what it was made with and who made it', ()=>{
    const { d3d, device } = make({ behaviour: D3DCREATE.HARDWARE_VERTEXPROCESSING });
    /** @type {{ parameters?: any }} */
    const creation = {};
    assert.equal(device.GetCreationParameters(creation), D3D_OK);
    assert.deepEqual(creation.parameters, {
        AdapterOrdinal: 0, DeviceType: 1, hFocusWindow: 0x1234,
        BehaviorFlags: D3DCREATE.HARDWARE_VERTEXPROCESSING,
    });
    /** @type {{ direct3D?: any }} */
    const parent = {};
    assert.equal(device.GetDirect3D(parent), D3D_OK);
    assert.equal(parent.direct3D, d3d, 'the same object, with a reference taken');
    // Its own, the one the device holds on it, and the one the call took
    // (Wine's d3d9 test_refcount).
    assert.equal(d3d.refCount, 3);
    d3d.release();
    assert.equal(device.GetNumberOfSwapChains(), 1);
    assert.ok(device.GetAvailableTextureMem() > 0);
    assert.equal(device.EvictManagedResources(), D3D_OK);
    assert.equal(device.GetSoftwareVertexProcessing(), false);
    assert.equal(device.SetSoftwareVertexProcessing(true), D3DERR_INVALIDCALL,
        'only a mixed device may switch');
    assert.equal(device.release(), 0);
    assert.equal(d3d.refCount, 1, 'a device gone gives back the reference it held');
});

test('a mixed device switches vertex processing, and a pure software one is what it is', ()=>{
    const mixed = make({ behaviour: D3DCREATE.MIXED_VERTEXPROCESSING }).device;
    assert.equal(mixed.SetSoftwareVertexProcessing(true), D3D_OK);
    assert.equal(mixed.GetSoftwareVertexProcessing(), true);
    mixed.release();
    const software = make({ behaviour: D3DCREATE.SOFTWARE_VERTEXPROCESSING }).device;
    assert.equal(software.GetSoftwareVertexProcessing(), true);
    assert.equal(software.SetSoftwareVertexProcessing(true), D3D_OK, 'the same value is fine');
    assert.equal(software.SetSoftwareVertexProcessing(false), D3DERR_INVALIDCALL);
    software.release();
});

// --- declarations and formats ---

test('setting a format makes a declaration, the same one each time, that reports the format', ()=>{
    const { device } = make();
    assert.equal(device.SetFVF(FVF_XYZ_DIFFUSE), D3D_OK);
    /** @type {{ declaration?: any }} */
    const first = {};
    assert.equal(device.GetVertexDeclaration(first), D3D_OK);
    assert.ok(first.declaration);
    assert.equal(first.declaration.fvf, FVF_XYZ_DIFFUSE);
    /** @type {{ count?: number, elements?: any[] }} */
    const read = {};
    first.declaration.GetDeclaration(read, 8);
    assert.deepEqual(read.elements?.slice(0, 2), [
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 12),
    ]);

    assert.equal(device.SetFVF(FVF_XYZ), D3D_OK);
    assert.equal(device.SetFVF(FVF_XYZ_DIFFUSE), D3D_OK);
    /** @type {{ declaration?: any }} */
    const second = {};
    device.GetVertexDeclaration(second);
    assert.equal(second.declaration, first.declaration, 'one declaration per format');
    /** @type {{ fvf?: number }} */
    const fvf = {};
    device.GetFVF(fvf);
    assert.equal(fvf.fvf, FVF_XYZ_DIFFUSE);

    assert.equal(device.SetFVF(0), D3D_OK, 'zero is accepted');
    device.GetFVF(fvf);
    assert.equal(fvf.fvf, FVF_XYZ_DIFFUSE, 'and changes nothing');

    first.declaration.release();
    second.declaration.release();
    assert.equal(device.release(), 0);
});

test('a declaration the program made reports no format, even when it describes one', ()=>{
    const { device } = make();
    /** @type {{ declaration?: any }} */
    const made = {};
    assert.equal(device.CreateVertexDeclaration([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 12),
    ], made), D3D_OK);
    assert.equal(device.SetVertexDeclaration(made.declaration), D3D_OK);
    /** @type {{ fvf?: number }} */
    const fvf = {};
    device.GetFVF(fvf);
    assert.equal(fvf.fvf, 0);
    // But a fixed-function draw still reads it as the format it describes.
    assert.equal(device.stageProcessing.fvf, FVF_XYZ_DIFFUSE);

    assert.equal(device.SetVertexDeclaration(null), D3D_OK);
    /** @type {{ declaration?: any }} */
    const bound = {};
    device.GetVertexDeclaration(bound);
    assert.equal(bound.declaration, null);

    assert.equal(device.CreateVertexDeclaration(null, made), D3DERR_INVALIDCALL);
    assert.equal(device.CreateVertexDeclaration([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 2),
    ], made), D3DERR_INVALIDCALL, 'a misaligned offset');
    made.declaration.release();
    assert.equal(device.release(), 0);
});

test('a draw through a declaration the fixed stage cannot read succeeds, reported once', ()=>{
    // A colour of four bytes read R, G, B, A: the fixed-function stage reads
    // D3DCOLOR alone. A declaration it can read -- a tangent beside the
    // position, a member in another stream -- is drawn, and not reported.
    /** @type {string[]} */
    const reports = [];
    const { device } = make({ services: { divergence: (/** @type {string} */ _api,
        /** @type {string} */ detail)=>reports.push(detail) } });
    /** @type {{ declaration?: any }} */
    const made = {};
    device.CreateVertexDeclaration([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.UBYTE4N, 12),
    ], made);
    device.SetVertexDeclaration(made.declaration);
    /** @type {{ buffer?: any }} */
    const held = {};
    device.CreateVertexBuffer(24 * 3, 0, 0, D3DPOOL.MANAGED, held);
    device.SetStreamSource(0, held.buffer, 0, 24);
    device.BeginScene();
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    device.EndScene();
    assert.equal(reports.filter(line=>line.includes('declaration')).length, 1);

    device.SetStreamSource(0, null, 0, 0);
    device.SetVertexDeclaration(null);
    held.buffer.release();
    made.declaration.release();
    assert.equal(device.release(), 0);
});

// --- shaders ---

test('a device that advertises no shader refuses every create and says so once', ()=>{
    /** @type {string[]} */
    const reports = [];
    const { device } = make({
        caps: {
            vertexShaderVersion: { major: 0, minor: 0 }, pixelShaderVersion: { major: 0, minor: 0 },
        },
        services: { divergence: (/** @type {string} */ _api,
            /** @type {string} */ detail)=>reports.push(detail) },
    });
    /** @type {{ shader?: any }} */
    const out = {};
    assert.equal(device.CreateVertexShader(VS_2_0_EMPTY, out), D3DERR_INVALIDCALL);
    assert.equal(device.CreateVertexShader(VS_2_0_EMPTY, out), D3DERR_INVALIDCALL);
    assert.equal(device.CreatePixelShader(PS_2_0_EMPTY, out), D3DERR_INVALIDCALL);
    assert.equal(out.shader, undefined);
    assert.equal(reports.filter(line=>line.includes('vertex shader')).length, 1);
    assert.equal(reports.filter(line=>line.includes('pixel shader')).length, 1);
    assert.equal(device.release(), 0);
});

test('a device that advertises a version makes shaders up to it and binds them', ()=>{
    const { device } = make({ caps: {
        vertexShaderVersion: { major: 2, minor: 0 }, pixelShaderVersion: { major: 2, minor: 0 },
    } });
    /** @type {{ shader?: any }} */
    const vs = {};
    assert.equal(device.CreateVertexShader(VS_2_0_EMPTY, vs), D3D_OK);
    assert.equal(device.CreateVertexShader(null, vs), D3DERR_INVALIDCALL);
    assert.equal(device.CreateVertexShader(PS_2_0_EMPTY, vs), D3DERR_INVALIDCALL,
        'a pixel shader is not a vertex shader');
    assert.equal(device.CreateVertexShader(
        [versionToken(SHADER_KIND.VERTEX, 3, 0), END_TOKEN], vs), D3DERR_INVALIDCALL,
    'past the advertised version');
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(device.CreatePixelShader(PS_2_0_EMPTY, ps), D3D_OK);

    assert.equal(device.SetVertexShader(vs.shader), D3D_OK);
    assert.equal(device.SetPixelShader(ps.shader), D3D_OK);
    /** @type {{ shader?: any }} */
    const bound = {};
    assert.equal(device.GetVertexShader(bound), D3D_OK);
    assert.equal(bound.shader, vs.shader);
    assert.equal(vs.shader.refCount, 2, 'a get takes a reference');
    bound.shader.release();
    assert.equal(device.stageProcessing.vertexShader, vs.shader.id);
    assert.equal(device.stageProcessing.fixedFunctionVertex, false);
    assert.equal(device.stageProcessing.pixelShader, ps.shader.id);
    assert.notEqual(vs.shader.id, ps.shader.id, 'ids are distinct across kinds');

    assert.equal(device.SetVertexShader(null), D3D_OK);
    assert.equal(device.SetPixelShader(null), D3D_OK);
    device.GetVertexShader(bound);
    assert.equal(bound.shader, null);
    vs.shader.release();
    ps.shader.release();
    assert.equal(device.release(), 0);
});

test('a draw with a shader bound succeeds, and the renderer is handed the whole program', ()=>{
    /** @type {string[]} */
    const reports = [];
    const { device } = make({
        caps: { vertexShaderVersion: { major: 2, minor: 0 } },
        services: { divergence: (/** @type {string} */ _api,
            /** @type {string} */ detail)=>reports.push(detail) },
    });
    /** @type {{ shader?: any }} */
    const vs = {};
    device.CreateVertexShader(VS_2_0_EMPTY, vs);
    device.SetVertexShader(vs.shader);
    device.SetFVF(FVF_XYZ);
    device.SetVertexShaderConstantF(0, [1, 2, 3, 4], 1);
    device.BeginScene();
    const bytes = new Uint8Array(12 * 3);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, bytes, 12), D3D_OK);
    device.EndScene();
    assert.equal(reports.length, 0, 'the device reports nothing: the renderer decides');
    const program = device.stageProcessing.program;
    assert.ok(program);
    assert.equal(program.vertex, vs.shader.parsed);
    assert.equal(program.vertexId, vs.shader.id);
    assert.equal(program.pixel, null);
    assert.equal(program.declaration?.length, 1,
        'the declaration the format stands for, as elements');
    assert.deepEqual([...program.vertexConstants.floats.subarray(0, 4)], [1, 2, 3, 4]);
    device.SetVertexShader(null);
    assert.equal(device.stageProcessing.program, null);
    vs.shader.release();
    assert.equal(device.release(), 0);
});

test('shader constants are bounded per file, and read back what was set', ()=>{
    const { device } = make();
    assert.equal(device.SetVertexShaderConstantF(0, [1, 2, 3, 4, 5, 6, 7, 8], 2), D3D_OK);
    /** @type {{ values?: Float32Array }} */
    const out = {};
    assert.equal(device.GetVertexShaderConstantF(1, 1, out), D3D_OK);
    assert.deepEqual([...(out.values ?? [])], [5, 6, 7, 8]);
    assert.equal(device.SetVertexShaderConstantF(255, [0, 0, 0, 0, 0, 0, 0, 0], 2),
        D3DERR_INVALIDCALL, 'past the last of 256');
    assert.equal(device.GetVertexShaderConstantF(256, 1, out), D3DERR_INVALIDCALL);
    assert.equal(device.SetVertexShaderConstantF(0, null, 1), D3DERR_INVALIDCALL);
    assert.equal(device.SetVertexShaderConstantF(0, [], 0), D3D_OK, 'a count of zero');
    assert.equal(device.SetVertexShaderConstantI(16, [1, 2, 3, 4], 1), D3DERR_INVALIDCALL);
    assert.equal(device.SetVertexShaderConstantB(16, [1], 1), D3DERR_INVALIDCALL);
    assert.equal(device.SetVertexShaderConstantB(15, [1], 1), D3D_OK);
    /** @type {{ values?: Uint32Array }} */
    const bools = {};
    assert.equal(device.GetVertexShaderConstantB(15, 1, bools), D3D_OK);
    assert.deepEqual([...(bools.values ?? [])], [1]);
    assert.equal(device.SetPixelShaderConstantF(224, [0, 0, 0, 0], 1), D3DERR_INVALIDCALL,
        'the pixel file is smaller');
    assert.equal(device.SetPixelShaderConstantF(223, [0, 0, 0, 0], 1), D3D_OK);
    assert.equal(device.release(), 0);
});

// --- state the fixed-function pipeline reads ---

test('sampler state lives per sampler, reads back its defaults, and refuses what is not one', ()=>{
    const { device } = make();
    /** @type {{ value?: number }} */
    const out = {};
    assert.equal(device.GetSamplerState(0, D3DSAMP.MAGFILTER, out), D3D_OK);
    assert.equal(out.value, 1, 'point');
    assert.equal(device.GetSamplerState(0, D3DSAMP.ADDRESSW, out), D3D_OK);
    assert.equal(out.value, 1, 'wrap');
    assert.equal(device.GetSamplerState(0, D3DSAMP.MAXANISOTROPY, out), D3D_OK);
    assert.equal(out.value, 1);
    assert.equal(device.GetSamplerState(0, D3DSAMP.SRGBTEXTURE, out), D3D_OK);
    assert.equal(out.value, 0);
    assert.equal(device.SetSamplerState(15, D3DSAMP.MINFILTER, 2), D3D_OK);
    assert.equal(device.GetSamplerState(15, D3DSAMP.MINFILTER, out), D3D_OK);
    assert.equal(out.value, 2);
    assert.equal(device.GetSamplerState(0, D3DSAMP.MINFILTER, out), D3D_OK);
    assert.equal(out.value, 1, 'another sampler is untouched');
    assert.equal(device.SetSamplerState(257, D3DSAMP.MINFILTER, 2), D3D_OK, 'a vertex sampler');
    assert.equal(device.SetSamplerState(16, D3DSAMP.MINFILTER, 2), D3DERR_INVALIDCALL);
    assert.equal(device.SetSamplerState(0, 14, 2), D3DERR_INVALIDCALL);
    assert.equal(device.release(), 0);
});

test('a stage state this version dropped is accepted and ignored, as the runtime does', ()=>{
    const { device } = make();
    // 13 was ADDRESSU in Direct3D 8 and is nothing here.
    assert.equal(device.SetTextureStageState(0, 13, 3), D3D_OK);
    /** @type {{ value?: number }} */
    const out = {};
    assert.equal(device.GetSamplerState(0, D3DSAMP.ADDRESSU, out), D3D_OK);
    assert.equal(out.value, 1, 'and did not reach the sampler');
    assert.equal(device.SetTextureStageState(0, 32, 0x11223344), D3D_OK, 'the constant is new');
    assert.equal(device.GetTextureStageState(0, 32, out), D3D_OK);
    assert.equal(out.value, 0x11223344);
    assert.equal(device.SetTextureStageState(8, 1, 0), D3DERR_INVALIDCALL);
    assert.equal(device.release(), 0);
});

test('the scissor rectangle is kept as given and follows a new target', ()=>{
    const { device } = make();
    /** @type {{ rect?: any }} */
    const out = {};
    assert.equal(device.GetScissorRect(out), D3D_OK);
    assert.deepEqual(out.rect, { left: 0, top: 0, right: 64, bottom: 48 });
    assert.equal(device.SetScissorRect({ left: 1, top: 2, right: 300, bottom: 400 }), D3D_OK);
    device.GetScissorRect(out);
    assert.deepEqual(out.rect, { left: 1, top: 2, right: 300, bottom: 400 });
    assert.equal(device.SetScissorRect(null), D3DERR_INVALIDCALL);

    /** @type {{ surface?: any }} */
    const target = {};
    device.CreateRenderTarget(16, 8, D3DFMT.A8R8G8B8, false, target);
    assert.equal(device.SetRenderTarget(0, target.surface), D3D_OK);
    device.GetScissorRect(out);
    assert.deepEqual(out.rect, { left: 0, top: 0, right: 16, bottom: 8 });
    /** @type {{ viewport?: any }} */
    const viewport = {};
    device.GetViewport(viewport);
    assert.equal(viewport.viewport.Width, 16);

    /** @type {{ surface?: any }} */
    const back = {};
    device.GetBackBuffer(0, 0, 0, back);
    device.SetRenderTarget(0, back.surface);
    back.surface.release();
    target.surface.release();
    assert.equal(device.release(), 0);
});

test('clip planes are bounded by the capability and read back as zero until set', ()=>{
    const { device } = make({ caps: { maxUserClipPlanes: 6 } });
    /** @type {{ plane?: Float32Array }} */
    const out = {};
    assert.equal(device.GetClipPlane(0, out), D3D_OK);
    assert.deepEqual([...(out.plane ?? [])], [0, 0, 0, 0]);
    assert.equal(device.SetClipPlane(5, [1, 2, 3, 4]), D3D_OK);
    assert.equal(device.GetClipPlane(5, out), D3D_OK);
    assert.deepEqual([...(out.plane ?? [])], [1, 2, 3, 4]);
    assert.equal(device.SetClipPlane(6, [1, 2, 3, 4]), D3DERR_INVALIDCALL);
    assert.equal(device.GetClipPlane(6, out), D3DERR_INVALIDCALL);
    assert.equal(device.SetClipPlane(0, null), D3DERR_INVALIDCALL);
    assert.equal(device.release(), 0);

    // The default is none at all: nothing behind this device clips.
    const bare = make().device;
    assert.equal(bare.SetClipPlane(0, [1, 0, 0, 0]), D3DERR_INVALIDCALL);
    assert.equal(bare.release(), 0);
});

test('a multiplied transform is the current one times the given one', ()=>{
    const { device } = make();
    device.SetTransform(D3DTS.WORLD, [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1,
    ]);
    device.MultiplyTransform(D3DTS.WORLD, [
        2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1,
    ]);
    /** @type {{ matrix?: Float32Array }} */
    const out = {};
    device.GetTransform(D3DTS.WORLD, out);
    // Row-vector convention: the translation goes through the scale.
    assert.deepEqual([...(out.matrix ?? [])].slice(12), [20, 40, 60, 1]);
    assert.equal(device.release(), 0);
});

test('streams past the last are refused, and a frequency is checked for sense', ()=>{
    const { device } = make();
    /** @type {{ buffer?: any }} */
    const held = {};
    device.CreateVertexBuffer(64, 0, 0, D3DPOOL.MANAGED, held);
    assert.equal(device.SetStreamSource(16, held.buffer, 0, 16), D3DERR_INVALIDCALL);
    assert.equal(device.SetStreamSource(15, held.buffer, 0, 16), D3D_OK);
    /** @type {{ frequency?: number }} */
    const out = {};
    assert.equal(device.GetStreamSourceFreq(15, out), D3D_OK);
    assert.equal(out.frequency, 1);
    assert.equal(device.SetStreamSourceFreq(15, 0), D3DERR_INVALIDCALL);
    assert.equal(device.SetStreamSourceFreq(0, 0x80000001), D3DERR_INVALIDCALL,
        'instance data on stream zero');
    assert.equal(device.SetStreamSourceFreq(1, 0xc0000001), D3DERR_INVALIDCALL, 'both flags');
    assert.equal(device.SetStreamSourceFreq(1, 0x80000001), D3D_OK);
    assert.equal(device.SetStreamSourceFreq(0, 0x40000004), D3D_OK);
    device.GetStreamSourceFreq(0, out);
    assert.equal(out.frequency, 0x40000004);
    device.SetStreamSource(15, null, 0, 0);
    held.buffer.release();
    assert.equal(device.release(), 0);
});

test('a render target must be one, only index zero exists, and a depth stencil must be one', ()=>{
    const { device } = make();
    /** @type {{ texture?: any }} */
    const plain = {};
    device.CreateTexture(8, 8, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, plain);
    /** @type {{ surface?: any }} */
    const level = {};
    plain.texture.GetSurfaceLevel(0, level);
    assert.equal(device.SetRenderTarget(0, level.surface), D3DERR_INVALIDCALL);
    assert.equal(device.SetDepthStencilSurface(level.surface), D3DERR_INVALIDCALL);
    /** @type {{ surface?: any }} */
    const target = {};
    device.CreateRenderTarget(8, 8, D3DFMT.A8R8G8B8, false, target);
    assert.equal(device.SetRenderTarget(1, target.surface), D3DERR_INVALIDCALL);
    assert.equal(device.GetRenderTarget(1, target), D3DERR_INVALIDCALL);
    assert.equal(device.SetDepthStencilSurface(null), D3D_OK);
    /** @type {{ surface?: any }} */
    const depth = {};
    assert.equal(device.GetDepthStencilSurface(depth), D3DERR_NOTFOUND);
    // Wine's d3d9 test_swapchain: the type is not looked at, and a stereo
    // buffer asked for is the mono one.
    assert.equal(device.GetBackBuffer(0, 0, 1, depth), D3D_OK, 'D3DBACKBUFFER_TYPE_LEFT');
    depth.surface.release();
    assert.equal(device.GetBackBuffer(0, 1, 0, depth), D3DERR_INVALIDCALL, 'past the count');

    level.surface.release();
    plain.texture.release();
    target.surface.release();
    assert.equal(device.release(), 0);
});

test('patches, vertex processing and the front buffer are refused, and palettes are not there',
    ()=>{
        const { device } = make();
        assert.equal(device.DrawRectPatch(), D3DERR_INVALIDCALL);
        assert.equal(device.DrawTriPatch(), D3DERR_INVALIDCALL);
        assert.equal(device.DeletePatch(), D3DERR_INVALIDCALL);
        assert.equal(device.ProcessVertices(), D3DERR_INVALIDCALL);
        assert.equal(device.GetFrontBufferData(), D3DERR_INVALIDCALL);
        assert.equal(device.SetNPatchMode(4), D3D_OK);
        assert.equal(device.GetNPatchMode(), 4);
        assert.equal(device.SetDialogBoxMode(true), D3D_OK);
        assert.equal(device.dialogBoxMode, true);
        assert.equal(device.release(), 0);
    });

// --- queries ---

test('event and occlusion queries are offered, the timings are not, and a null pointer only asks',
    ()=>{
        /** @type {string[]} */
        const reports = [];
        const { device } = make({ services: { divergence: (/** @type {string} */ _api,
            /** @type {string} */ detail)=>reports.push(detail) } });
        assert.equal(device.CreateQuery(D3DQUERYTYPE.EVENT, null), D3D_OK);
        assert.equal(device.CreateQuery(D3DQUERYTYPE.OCCLUSION, null), D3D_OK);
        assert.equal(device.CreateQuery(D3DQUERYTYPE.TIMESTAMP, null), D3DERR_NOTAVAILABLE);
        /** @type {{ query?: any }} */
        const refused = {};
        assert.equal(device.CreateQuery(D3DQUERYTYPE.TIMESTAMP, refused), D3DERR_NOTAVAILABLE);
        assert.equal(refused.query, undefined);

        // A device that draws nothing counts nothing: an occlusion query
        // never ended answers without writing, and once ended, zero.
        /** @type {{ query?: any }} */
        const occlusion = {};
        assert.equal(device.CreateQuery(D3DQUERYTYPE.OCCLUSION, occlusion), D3D_OK);
        /** @type {{ value?: number }} */
        const pixels = {};
        assert.equal(occlusion.query.GetData(pixels, 4), D3D_OK);
        assert.equal(pixels.value, undefined);
        assert.equal(occlusion.query.Issue(D3DISSUE.BEGIN), D3D_OK);
        assert.equal(occlusion.query.GetData({}, 4), 1, 'S_FALSE until the end is issued');
        assert.equal(occlusion.query.Issue(D3DISSUE.END), D3D_OK);
        assert.equal(occlusion.query.GetData(pixels, 4), D3D_OK);
        assert.equal(pixels.value, 0);
        assert.equal(reports.filter(line=>line.includes('occlusion')).length, 0);
        assert.equal(occlusion.query.release(), 0);

        /** @type {{ query?: any }} */
        const out = {};
        assert.equal(device.CreateQuery(D3DQUERYTYPE.EVENT, out), D3D_OK);
        const query = out.query;
        assert.ok(query);
        assert.equal(query.GetType(), D3DQUERYTYPE.EVENT);
        assert.equal(query.GetDataSize(), 4);

        /** @type {{ value?: number }} */
        const data = {};
        // Signalled as created, as the real query is: a program that waits
        // for the GPU by polling an event query it never issued would
        // otherwise spin for ever on "not yet".
        assert.equal(query.GetData(data, 4), D3D_OK, 'S_OK before the query was ever issued');
        assert.equal(query.Issue(D3DISSUE.BEGIN), D3DERR_INVALIDCALL, 'an event has no beginning');
        assert.equal(query.Issue(D3DISSUE.END), D3D_OK);
        assert.equal(query.GetData(data, 1), D3DERR_INVALIDCALL, 'too small a buffer');
        assert.equal(query.GetData(null, 0), D3D_OK, 'no buffer at all only asks');
        assert.equal(query.GetData(data, 4), D3D_OK);
        assert.equal(data.value, 1);
        assert.equal(query.release(), 0);
        assert.equal(device.release(), 0);
    });

// --- reset ---

test('a reset is refused while a default-pool resource is held, and the device says so after',
    ()=>{
        const { device } = make();
        /** @type {{ buffer?: any }} */
        const held = {};
        device.CreateVertexBuffer(64, 0, 0, D3DPOOL.DEFAULT, held);
        assert.equal(device.Reset(), D3DERR_INVALIDCALL);
        assert.equal(device.TestCooperativeLevel(), D3DERR_DEVICENOTRESET);
        assert.equal(device.deviceState, DEVICE_STATE.NOT_RESET);
        held.buffer.release();
        assert.equal(device.Reset(), D3D_OK);
        assert.equal(device.TestCooperativeLevel(), D3D_OK);

        // Managed and system-memory resources are fine to hold.
        /** @type {{ texture?: any }} */
        const managed = {};
        device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, managed);
        /** @type {{ surface?: any }} */
        const system = {};
        device.CreateOffscreenPlainSurface(4, 4, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, system);
        assert.equal(device.Reset(), D3D_OK);
        managed.texture.release();
        system.surface.release();

        // So is a shader, a declaration or a state block: none lives in a pool.
        /** @type {{ declaration?: any }} */
        const declaration = {};
        device.CreateVertexDeclaration([element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0)],
            declaration);
        /** @type {{ block?: any }} */
        const block = {};
        device.CreateStateBlock(1, block);
        assert.equal(device.Reset(), D3D_OK);
        declaration.declaration.release();
        block.block.release();

        // A back buffer the program still holds is a default-pool resource too.
        /** @type {{ surface?: any }} */
        const back = {};
        device.GetBackBuffer(0, 0, 0, back);
        assert.equal(device.Reset(), D3DERR_INVALIDCALL);
        back.surface.release();
        assert.equal(device.Reset(), D3D_OK);
        assert.equal(device.release(), 0);
    });

test('a reset rebuilds the implicit surfaces at the new size and puts state back', ()=>{
    const { device } = make();
    device.SetRenderState(D3DRS.LIGHTING, 0);
    device.SetScissorRect({ left: 1, top: 1, right: 2, bottom: 2 });
    device.SetFVF(FVF_XYZ);
    assert.equal(device.Reset({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferWidth: 128, backBufferHeight: 96,
        backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D16,
    }), D3D_OK);
    /** @type {{ surface?: any }} */
    const back = {};
    device.GetBackBuffer(0, 0, 0, back);
    /** @type {{ desc?: any }} */
    const desc = {};
    back.surface.GetDesc(desc);
    assert.equal(desc.desc.Width, 128);
    assert.equal(desc.desc.Height, 96);
    back.surface.release();
    /** @type {{ surface?: any }} */
    const depth = {};
    assert.equal(device.GetDepthStencilSurface(depth), D3D_OK);
    depth.surface.GetDesc(desc);
    assert.equal(desc.desc.Format, D3DFMT.D16);
    depth.surface.release();
    /** @type {{ rect?: any }} */
    const scissor = {};
    device.GetScissorRect(scissor);
    assert.deepEqual(scissor.rect, { left: 0, top: 0, right: 128, bottom: 96 });
    /** @type {{ value?: number }} */
    const lighting = {};
    device.GetRenderState(D3DRS.LIGHTING, lighting);
    assert.equal(lighting.value, 1);
    /** @type {{ fvf?: number }} */
    const fvf = {};
    device.GetFVF(fvf);
    assert.equal(fvf.fvf, 0);
    /** @type {{ parameters?: any }} */
    const swap = {};
    /** @type {{ swapChain?: any }} */
    const chain = {};
    device.GetSwapChain(0, chain);
    chain.swapChain.GetPresentParameters(swap);
    assert.equal(swap.parameters.backBufferWidth, 128);
    chain.swapChain.release();
    assert.equal(device.release(), 0);
});

// --- copies between surfaces ---

/** A device whose guest memory is a flat buffer, so copies and fills can be checked. */
function makeWithMemory(){
    const memory = new Uint8Array(1 << 20);
    let next = 0x1000;
    const services = {
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    };
    const made = make({ services });
    return { ...made, memory };
}

test('UpdateSurface moves a rectangle from system memory into the default pool', ()=>{
    const { device, memory } = makeWithMemory();
    /** @type {{ surface?: any }} */
    const source = {};
    device.CreateOffscreenPlainSurface(4, 4, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, source);
    /** @type {{ texture?: any }} */
    const texture = {};
    device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, texture);
    /** @type {{ surface?: any }} */
    const level = {};
    texture.texture.GetSurfaceLevel(0, level);
    // Paint the source row by row: pixel (x, y) holds y * 16 + x.
    for (let index = 0; index < 16; index++)
    {
        memory.fill(index, source.surface.base + index * 4, source.surface.base + index * 4 + 4);
    }
    assert.equal(device.UpdateSurface(source.surface, { left: 1, top: 1, right: 3, bottom: 3 },
        level.surface, { x: 2, y: 0 }), D3D_OK);
    const at = level.surface.base;
    assert.equal(memory[at + (0 * 4 + 2) * 4], 5, '(1,1) landed at (2,0)');
    assert.equal(memory[at + (0 * 4 + 3) * 4], 6);
    assert.equal(memory[at + (1 * 4 + 2) * 4], 9);
    assert.equal(memory[at + (0 * 4 + 1) * 4], 0, 'outside the point is untouched');

    assert.equal(device.UpdateSurface(level.surface, null, source.surface, null),
        D3DERR_INVALIDCALL, 'the pools are the wrong way round');
    assert.equal(device.UpdateSurface(source.surface, { left: 0, top: 0, right: 4, bottom: 4 },
        level.surface, { x: 1, y: 0 }), D3DERR_INVALIDCALL, 'off the edge');
    level.surface.release();
    texture.texture.release();
    source.surface.release();
    assert.equal(device.release(), 0);
});

test('UpdateTexture copies the levels, and the pools and formats have to match the rules', ()=>{
    const { device, memory } = makeWithMemory();
    /** @type {{ texture?: any }} */
    const source = {};
    device.CreateTexture(4, 4, 3, 0, D3DFMT.R5G6B5, D3DPOOL.SYSTEMMEM, source);
    /** @type {{ texture?: any }} */
    const destination = {};
    device.CreateTexture(4, 4, 3, 0, D3DFMT.R5G6B5, D3DPOOL.DEFAULT, destination);
    for (let level = 0; level < 3; level++)
    {
        /** @type {{ surface?: any }} */
        const held = {};
        source.texture.GetSurfaceLevel(level, held);
        memory.fill(level + 1, held.surface.base, held.surface.base + 4);
        held.surface.release();
    }
    assert.equal(device.UpdateTexture(source.texture, destination.texture), D3D_OK);
    for (let level = 0; level < 3; level++)
    {
        /** @type {{ surface?: any }} */
        const held = {};
        destination.texture.GetSurfaceLevel(level, held);
        assert.equal(memory[held.surface.base], level + 1, `level ${level} arrived`);
        held.surface.release();
    }
    /** @type {{ texture?: any }} */
    const managed = {};
    device.CreateTexture(4, 4, 1, 0, D3DFMT.R5G6B5, D3DPOOL.MANAGED, managed);
    assert.equal(device.UpdateTexture(managed.texture, destination.texture), D3DERR_INVALIDCALL);
    /** @type {{ texture?: any }} */
    const other = {};
    device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, other);
    assert.equal(device.UpdateTexture(other.texture, destination.texture), D3DERR_INVALIDCALL);
    managed.texture.release();
    other.texture.release();
    source.texture.release();
    destination.texture.release();
    assert.equal(device.release(), 0);
});

test('UpdateTexture carries only the source\'s dirty region, scaled to each level', ()=>{
    // Wine's d3d9 add_dirty_rect_test: an update takes the region, a lock
    // or AddDirtyRect adds to it, and the destination's own is ignored.
    const { device, memory } = makeWithMemory();
    /** @type {{ texture?: any }} */
    const source = {};
    device.CreateTexture(8, 8, 2, 0, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, source);
    /** @type {{ texture?: any }} */
    const destination = {};
    device.CreateTexture(8, 8, 2, 0, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, destination);
    /** @param {any} texture @param {number} level */
    const baseOf = (texture, level)=>{
        /** @type {{ surface?: any }} */
        const held = {};
        texture.GetSurfaceLevel(level, held);
        held.surface.release();
        return held.surface.base;
    };
    assert.equal(device.UpdateTexture(source.texture, destination.texture), D3D_OK);
    memory.fill(7, baseOf(source.texture, 0), baseOf(source.texture, 0) + 8 * 8 * 4);
    memory.fill(7, baseOf(source.texture, 1), baseOf(source.texture, 1) + 4 * 4 * 4);
    assert.equal(device.UpdateTexture(source.texture, destination.texture), D3D_OK);
    assert.equal(memory[baseOf(destination.texture, 0)], 0, 'written with no lock: not carried');

    assert.equal(destination.texture.AddDirtyRect({ left: 0, top: 0, right: 8, bottom: 8 }),
        D3D_OK);
    assert.equal(device.UpdateTexture(source.texture, destination.texture), D3D_OK);
    assert.equal(memory[baseOf(destination.texture, 0)], 0, 'nor for the destination\'s asking');

    assert.equal(source.texture.AddDirtyRect({ left: 4, top: 4, right: 6, bottom: 6 }), D3D_OK);
    assert.equal(device.UpdateTexture(source.texture, destination.texture), D3D_OK);
    const top = baseOf(destination.texture, 0);
    assert.equal(memory[top + (4 * 8 + 4) * 4], 7, 'inside the rectangle');
    assert.equal(memory[top + (5 * 8 + 5) * 4], 7);
    assert.equal(memory[top + (3 * 8 + 4) * 4], 0, 'outside it');
    assert.equal(memory[top + (4 * 8 + 6) * 4], 0);
    const next = baseOf(destination.texture, 1);
    assert.equal(memory[next + (2 * 4 + 2) * 4], 7, 'and its half at the next level');
    assert.equal(memory[next], 0);
    source.texture.release();
    destination.texture.release();
    assert.equal(device.release(), 0);
});

test('UpdateTexture carries a cube map face by face, each by its own dirty region', ()=>{
    const { device, memory } = makeWithMemory();
    /** @param {number} pool */
    const cube = pool=>{
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateCubeTexture(4, 1, 0, D3DFMT.A8R8G8B8, pool, out), D3D_OK);
        return out.texture;
    };
    const source = cube(D3DPOOL.SYSTEMMEM);
    const destination = cube(D3DPOOL.DEFAULT);
    /** @param {any} texture @param {number} face */
    const baseOf = (texture, face)=>{
        /** @type {{ surface?: any }} */
        const held = {};
        assert.equal(texture.GetCubeMapSurface(face, 0, held), D3D_OK);
        held.surface.release();
        return held.surface.base;
    };
    for (let face = 0; face < 6; face++)
    {
        memory.fill(face + 1, baseOf(source, face), baseOf(source, face) + 64);
    }
    assert.equal(device.UpdateTexture(source, destination), D3D_OK);
    assert.deepEqual(Array.from({ length: 6 }, (_, face)=>memory[baseOf(destination, face)]),
        [1, 2, 3, 4, 5, 6], 'every face, at first');

    for (let face = 0; face < 6; face++)
    {
        memory.fill(9, baseOf(source, face), baseOf(source, face) + 64);
    }
    /** @type {any} */
    const locked = {};
    assert.equal(source.LockCubeRect(3, 0, locked, null, 0), D3D_OK);
    assert.equal(source.UnlockCubeRect(3, 0), D3D_OK);
    assert.equal(device.UpdateTexture(source, destination), D3D_OK);
    assert.deepEqual(Array.from({ length: 6 }, (_, face)=>memory[baseOf(destination, face)]),
        [1, 2, 3, 9, 5, 6], 'the face that was locked, and no other');

    /** @type {{ texture?: any }} */
    const flat = {};
    device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, flat);
    assert.equal(device.UpdateTexture(source, flat.texture), D3DERR_INVALIDCALL,
        'a cube is not carried into a texture of one face');
    flat.texture.release();
    source.release();
    destination.release();
    assert.equal(device.release(), 0);
});

test('ColorFill writes the colour in the format\'s own layout, over the rectangle only', ()=>{
    const { device, memory } = makeWithMemory();
    /** @type {{ surface?: any }} */
    const plain = {};
    device.CreateOffscreenPlainSurface(4, 2, D3DFMT.R5G6B5, D3DPOOL.DEFAULT, plain);
    assert.equal(device.ColorFill(plain.surface, { left: 1, top: 0, right: 3, bottom: 1 },
        0xffff0000), D3D_OK);
    const at = plain.surface.base;
    assert.deepEqual([...memory.slice(at, at + 8)], [0, 0, 0x00, 0xf8, 0x00, 0xf8, 0, 0],
        'pure red in 5:6:5, little-endian, in pixels one and two');
    assert.deepEqual([...memory.slice(at + 8, at + 16)], [0, 0, 0, 0, 0, 0, 0, 0],
        'the second row is untouched');

    /** @type {{ surface?: any }} */
    const system = {};
    device.CreateOffscreenPlainSurface(4, 2, D3DFMT.R5G6B5, D3DPOOL.SYSTEMMEM, system);
    assert.equal(device.ColorFill(system.surface, null, 0), D3DERR_INVALIDCALL,
        'only the default pool');
    /** @type {{ texture?: any }} */
    const texture = {};
    device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, texture);
    /** @type {{ surface?: any }} */
    const level = {};
    texture.texture.GetSurfaceLevel(0, level);
    assert.equal(device.ColorFill(level.surface, null, 0), D3DERR_INVALIDCALL,
        'a texture level with no target usage');
    assert.equal(device.ColorFill(plain.surface, { left: 0, top: 0, right: 5, bottom: 1 }, 0),
        D3DERR_INVALIDCALL, 'off the edge');
    level.surface.release();
    texture.texture.release();
    system.surface.release();
    plain.surface.release();
    assert.equal(device.release(), 0);
});

test('StretchRect copies equal rectangles and refuses a stretch, saying why', ()=>{
    const { device, memory } = makeWithMemory();
    /** @type {{ surface?: any }} */
    const source = {};
    device.CreateOffscreenPlainSurface(4, 4, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, source);
    /** @type {{ surface?: any }} */
    const target = {};
    device.CreateRenderTarget(4, 4, D3DFMT.A8R8G8B8, false, target);
    memory.fill(7, source.surface.base, source.surface.base + 64);
    assert.equal(device.StretchRect(source.surface, { left: 0, top: 0, right: 2, bottom: 2 },
        target.surface, { left: 2, top: 2, right: 4, bottom: 4 }, 1), D3D_OK);
    assert.equal(memory[target.surface.base + (2 * 4 + 2) * 4], 7);
    assert.equal(memory[target.surface.base], 0);
    assert.equal(device.StretchRect(source.surface, { left: 0, top: 0, right: 2, bottom: 2 },
        target.surface, { left: 0, top: 0, right: 4, bottom: 4 }, 1), D3DERR_INVALIDCALL,
    'a stretch');
    assert.equal(device.StretchRect(source.surface, null, target.surface, null, 4),
        D3DERR_INVALIDCALL, 'no such filter');
    /** @type {{ surface?: any }} */
    const system = {};
    device.CreateOffscreenPlainSurface(4, 4, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, system);
    assert.equal(device.StretchRect(system.surface, null, target.surface, null, 1),
        D3DERR_INVALIDCALL, 'system memory is not a source');
    system.surface.release();
    source.surface.release();
    target.surface.release();
    assert.equal(device.release(), 0);
});

test('GetRenderTargetData wants a system-memory twin of the target', ()=>{
    /** @type {string[]} */
    const reports = [];
    const memory = new Uint8Array(1 << 18);
    let next = 0x100;
    const { device } = make({ services: {
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        divergence: (/** @type {string} */ _api, /** @type {string} */ detail)=>reports.push(detail),
    } });
    /** @type {{ surface?: any }} */
    const target = {};
    device.CreateRenderTarget(4, 4, D3DFMT.A8R8G8B8, false, target);
    /** @type {{ surface?: any }} */
    const twin = {};
    device.CreateOffscreenPlainSurface(4, 4, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, twin);
    /** @type {{ surface?: any }} */
    const smaller = {};
    device.CreateOffscreenPlainSurface(2, 4, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, smaller);
    assert.equal(device.GetRenderTargetData(target.surface, smaller.surface), D3DERR_INVALIDCALL);
    assert.equal(device.GetRenderTargetData(twin.surface, target.surface), D3DERR_INVALIDCALL);
    memory.fill(3, target.surface.base, target.surface.base + 64);
    assert.equal(device.GetRenderTargetData(target.surface, twin.surface), D3D_OK);
    assert.equal(memory[twin.surface.base + 63], 3);
    assert.equal(reports.filter(line=>line.includes('never read back')).length, 1,
        'the copy is reported, once');
    smaller.surface.release();
    twin.surface.release();
    target.surface.release();
    assert.equal(device.release(), 0);
});

test('a clear under the scissor test touches only the scissor rectangle', ()=>{
    // No backend here, so what is checked is that the call is accepted and
    // that a scissor with nothing inside it is still a successful clear.
    const { device } = make();
    device.SetRenderState(D3DRS.SCISSORTESTENABLE, 1);
    device.SetScissorRect({ left: 10, top: 10, right: 10, bottom: 10 });
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0, 1, 0), D3D_OK);
    device.SetScissorRect({ left: 0, top: 0, right: 8, bottom: 8 });
    assert.equal(device.Clear(1, [{ x1: 4, y1: 4, x2: 20, y2: 20 }], D3DCLEAR.TARGET, 0, 1, 0),
        D3D_OK);
    assert.equal(device.release(), 0);
});

test('an index buffer describes itself with its index width', ()=>{
    const { device } = make();
    /** @type {{ buffer?: any }} */
    const held = {};
    assert.equal(device.CreateIndexBuffer(0, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, held),
        D3DERR_INVALIDCALL, 'no bytes');
    assert.equal(device.CreateIndexBuffer(6, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, held),
        D3D_OK);
    /** @type {{ desc?: any }} */
    const out = {};
    assert.equal(held.buffer.GetDesc(out), D3D_OK);
    assert.equal(out.desc.Format, D3DFMT_INDEX.INDEX16);
    assert.equal(out.desc.Type, D3DRTYPE.INDEXBUFFER);
    assert.equal(out.desc.Size, 6);
    held.buffer.release();
    assert.equal(device.release(), 0);
});

test('a palette is kept and read back, and the current one remembered', ()=>{
    const { device } = make();
    // Opaque entries: this device claims no D3DPTEXTURECAPS_ALPHAPALETTE, and
    // without it an entry whose peFlags is not 0xff is refused (Wine's d3d9
    // test_set_palette).
    const entries = Uint8Array.from({ length: 1024 },
        (_, index)=>(index % 4 === 3 ? 0xff : index & 0xff));
    assert.equal(device.SetPaletteEntries(3, entries), D3D_OK);
    assert.equal(device.SetPaletteEntries(4, new Uint8Array(12)), D3DERR_INVALIDCALL,
        'a palette is 256 entries');
    assert.equal(device.SetPaletteEntries(4,
        Uint8Array.from({ length: 1024 }, (_, index)=>index & 0xff)), D3DERR_INVALIDCALL,
    'an entry with alpha');
    /** @type {{ entries?: Uint8Array }} */
    const out = {};
    assert.equal(device.GetPaletteEntries(3, out), D3D_OK);
    assert.deepEqual([...(out.entries ?? [])], [...entries]);
    assert.equal(device.GetPaletteEntries(4, out), D3DERR_INVALIDCALL, 'never set');
    assert.equal(device.SetCurrentTexturePalette(3), D3D_OK);
    /** @type {{ number?: number }} */
    const current = {};
    assert.equal(device.GetCurrentTexturePalette(current), D3D_OK);
    assert.equal(current.number, 3);
    assert.equal(device.release(), 0);
});

test('a texture that makes its own levels shows the program one, in the pools that allow it',
    ()=>{
        // Wine's d3d9 test_mipmap_gen and test_cube_texture_mipmap_gen.
        const { d3d, device } = make();
        const AUTOGEN = D3DUSAGE.AUTOGENMIPMAP;
        const D3DOK_NOAUTOGEN = 0x0876086f;
        assert.equal(d3d.CheckDeviceFormat(AUTOGEN, D3DRTYPE.TEXTURE, D3DFMT.X8R8G8B8), D3D_OK);
        assert.equal(d3d.CheckDeviceFormat(AUTOGEN, D3DRTYPE.CUBETEXTURE, D3DFMT.X8R8G8B8),
            D3D_OK);
        assert.equal(d3d.CheckDeviceFormat(AUTOGEN, D3DRTYPE.TEXTURE, D3DFMT.DXT5),
            D3DOK_NOAUTOGEN, 'a format no level is drawn into is made without them');
        assert.equal(d3d.CheckDeviceFormat(AUTOGEN | D3DUSAGE.DYNAMIC, D3DRTYPE.TEXTURE,
            D3DFMT.X8R8G8B8), D3DERR_NOTAVAILABLE);
        assert.equal(d3d.CheckDeviceFormat(AUTOGEN, D3DRTYPE.VOLUMETEXTURE, D3DFMT.X8R8G8B8),
            D3DERR_NOTAVAILABLE);

        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(64, 64, 0, D3DUSAGE.RENDERTARGET | AUTOGEN,
            D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, out), D3D_OK);
        out.texture.release();
        assert.equal(device.CreateTexture(64, 64, 0, AUTOGEN, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
            out), D3D_OK);
        const texture = out.texture;
        assert.equal(texture.GetAutoGenFilterType(), 2, 'D3DTEXF_LINEAR');
        assert.equal(texture.SetAutoGenFilterType(0), D3DERR_INVALIDCALL, 'D3DTEXF_NONE');
        assert.equal(texture.SetAutoGenFilterType(3), D3D_OK);
        assert.equal(texture.GetAutoGenFilterType(), 3, 'D3DTEXF_ANISOTROPIC');
        assert.equal(texture.levels, 1);
        /** @type {any} */
        const held = {};
        assert.equal(texture.GetSurfaceLevel(0, held), D3D_OK);
        /** @type {{ desc?: any }} */
        const described = {};
        held.surface.GetDesc(described);
        assert.equal(described.desc.Usage, AUTOGEN);
        held.surface.release();
        for (let level = 1; level < 6; level++)
        {
            assert.equal(texture.GetSurfaceLevel(level, {}), D3DERR_INVALIDCALL);
            assert.equal(texture.LockRect(level, {}, null, 0), D3DERR_INVALIDCALL);
        }
        texture.release();

        for (const levels of [2, 6])
        {
            assert.equal(device.CreateTexture(64, 64, levels, AUTOGEN, D3DFMT.X8R8G8B8,
                D3DPOOL.MANAGED, out), D3DERR_INVALIDCALL, `${levels} levels`);
        }
        assert.equal(device.CreateTexture(64, 64, 1, AUTOGEN, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
            out), D3D_OK);
        out.texture.release();
        assert.equal(device.CreateTexture(64, 64, 0, AUTOGEN, D3DFMT.X8R8G8B8,
            D3DPOOL.SYSTEMMEM, out), D3DERR_INVALIDCALL);
        assert.equal(device.CreateTexture(64, 64, 0, AUTOGEN, D3DFMT.DXT5, D3DPOOL.DEFAULT, out),
            D3D_OK, 'made, without generated levels');
        assert.equal(out.texture.levels, 1);
        out.texture.release();
        assert.equal(device.CreateCubeTexture(64, 0, AUTOGEN, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
            out), D3D_OK);
        assert.equal(out.texture.levels, 1);
        out.texture.release();
        assert.equal(device.CreateVolumeTexture(64, 64, 64, 0, AUTOGEN, D3DFMT.X8R8G8B8,
            D3DPOOL.DEFAULT, out), D3DERR_INVALIDCALL);
        assert.equal(device.release(), 0);
    });

test('UpdateTexture into a texture that makes its own levels carries the source\'s top level',
    ()=>{
        const { device } = make();
        /** @type {{ texture?: any }} */
        const source = {};
        assert.equal(device.CreateTexture(16, 16, 0, 0, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM,
            source), D3D_OK);
        /** @type {{ texture?: any }} */
        const destination = {};
        assert.equal(device.CreateTexture(16, 16, 0, D3DUSAGE.AUTOGENMIPMAP, D3DFMT.A8R8G8B8,
            D3DPOOL.DEFAULT, destination), D3D_OK);
        /** @type {{ moves?: any[] }} */
        const out = {};
        assert.equal(device.UpdateTexture(source.texture, destination.texture, out), D3D_OK);
        assert.equal(out.moves?.length, 1);
        assert.deepEqual([out.moves?.[0].rowBytes, out.moves?.[0].rows], [64, 16]);
        source.texture.release();
        destination.texture.release();
        assert.equal(device.release(), 0);
    });

test('a surface made on its own gives its storage back with its last reference', ()=>{
    // A render target made and released in a loop otherwise keeps the heap it
    // took, and a program that makes enough of them runs the arena out.
    /** @type {Map<number, number>} */
    const held = new Map();
    let next = 0x100000;
    const { device } = make({ services: {
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes + 0x1000;
            held.set(at, bytes);
            return at;
        },
        free: (/** @type {number} */ at)=>held.delete(at),
    } });
    const before = held.size;
    for (let round = 0; round < 3; round++)
    {
        /** @type {{ surface?: any }[]} */
        const made = [{}, {}, {}, {}];
        assert.equal(device.CreateRenderTarget(64, 64, D3DFMT.A8R8G8B8, true, made[0]), D3D_OK);
        assert.equal(device.CreateDepthStencilSurface(64, 64, D3DFMT.D24S8, made[1]), D3D_OK);
        assert.equal(device.CreateOffscreenPlainSurface(64, 64, D3DFMT.A8R8G8B8,
            D3DPOOL.SYSTEMMEM, made[2]), D3D_OK);
        assert.equal(device.CreateOffscreenPlainSurface(64, 64, D3DFMT.A8R8G8B8,
            D3DPOOL.DEFAULT, made[3]), D3D_OK);
        for (const one of made)
        {
            assert.equal(one.surface?.release(), 0);
        }
    }
    assert.equal(held.size, before, 'every block went back');
    assert.equal(device.release(), 0);
});
