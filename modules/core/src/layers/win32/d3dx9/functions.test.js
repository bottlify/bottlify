/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD3dxFunctions, d3dxVersionFunctions } from './functions.js';
import { COMPILED } from './inguest.x86.js';
import { COMPILED as MATRIX } from './inguest-matrix.x86.js';
import { COMPILED as VECTOR } from './inguest-vector.x86.js';
import { COMPILED as QUATERNION } from './inguest-quaternion.x86.js';

const E_NOTIMPL = 0x80004001;

function machine(){
    const memory = new Uint8Array(0x1000);
    /** @type {string[]} */
    const diverged = [];
    const fns = createD3dxFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        divergence: api=>diverged.push(api),
    });
    /** @param {number} address @param {number[]} values */
    const putFloats = (address, values)=>
        new Float32Array(memory.buffer, address, values.length).set(values);
    /** @param {number} address @param {number} count */
    const getFloats = (address, count)=>
        [...new Float32Array(memory.buffer.slice(address, address + count * 4))];
    /** Expected values, rounded to the single precision the store keeps. */
    const f32 = (/** @type {number[]} */ values)=>[...Float32Array.from(values)];
    /** @param {number} value  A FLOAT argument, as the raw dword the bridge reads. */
    const asArg = value=>{
        const view = new DataView(new ArrayBuffer(4));
        view.setFloat32(0, value, true);
        return view.getUint32(0, true);
    };
    return { fns: /** @type {any} */ (fns), putFloats, getFloats, asArg, f32, memory, diverged };
}

const OUT = 0x100;
const A = 0x200;
const B = 0x300;

/**
 * Every mathematical export of d3dx9, and the arguments each takes -- the
 * library's own list, as Wine's d3dx9_36.spec gives it: none may be missing,
 * since a program's import of one that is would stop it at the first call.
 */
const MATHEMATICS = {
    D3DXColorAdjustContrast: 3, D3DXColorAdjustSaturation: 3, D3DXFloat16To32Array: 3,
    D3DXFloat32To16Array: 3, D3DXFresnelTerm: 2, D3DXMatrixAffineTransformation: 5,
    D3DXMatrixAffineTransformation2D: 5, D3DXMatrixDecompose: 4, D3DXMatrixDeterminant: 1,
    D3DXMatrixInverse: 3, D3DXMatrixLookAtLH: 4, D3DXMatrixLookAtRH: 4, D3DXMatrixMultiply: 3,
    D3DXMatrixMultiplyTranspose: 3, D3DXMatrixOrthoLH: 5, D3DXMatrixOrthoOffCenterLH: 7,
    D3DXMatrixOrthoOffCenterRH: 7, D3DXMatrixOrthoRH: 5, D3DXMatrixPerspectiveFovLH: 5,
    D3DXMatrixPerspectiveFovRH: 5, D3DXMatrixPerspectiveLH: 5,
    D3DXMatrixPerspectiveOffCenterLH: 7, D3DXMatrixPerspectiveOffCenterRH: 7,
    D3DXMatrixPerspectiveRH: 5, D3DXMatrixReflect: 2, D3DXMatrixRotationAxis: 3,
    D3DXMatrixRotationQuaternion: 2, D3DXMatrixRotationX: 2, D3DXMatrixRotationY: 2,
    D3DXMatrixRotationYawPitchRoll: 4, D3DXMatrixRotationZ: 2, D3DXMatrixScaling: 4,
    D3DXMatrixShadow: 3, D3DXMatrixTransformation: 7, D3DXMatrixTransformation2D: 7,
    D3DXMatrixTranslation: 4, D3DXMatrixTranspose: 2, D3DXPlaneFromPointNormal: 3,
    D3DXPlaneFromPoints: 4, D3DXPlaneIntersectLine: 4, D3DXPlaneNormalize: 2,
    D3DXPlaneTransform: 3, D3DXPlaneTransformArray: 6, D3DXQuaternionBaryCentric: 6,
    D3DXQuaternionExp: 2, D3DXQuaternionInverse: 2, D3DXQuaternionLn: 2,
    D3DXQuaternionMultiply: 3, D3DXQuaternionNormalize: 2, D3DXQuaternionRotationAxis: 3,
    D3DXQuaternionRotationMatrix: 2, D3DXQuaternionRotationYawPitchRoll: 4,
    D3DXQuaternionSlerp: 4, D3DXQuaternionSquad: 6, D3DXQuaternionSquadSetup: 7,
    D3DXQuaternionToAxisAngle: 3, D3DXVec2BaryCentric: 6, D3DXVec2CatmullRom: 6,
    D3DXVec2Hermite: 6, D3DXVec2Normalize: 2, D3DXVec2Transform: 3, D3DXVec2TransformArray: 6,
    D3DXVec2TransformCoord: 3, D3DXVec2TransformCoordArray: 6, D3DXVec2TransformNormal: 3,
    D3DXVec2TransformNormalArray: 6, D3DXVec3BaryCentric: 6, D3DXVec3CatmullRom: 6,
    D3DXVec3Hermite: 6, D3DXVec3Normalize: 2, D3DXVec3Project: 6, D3DXVec3ProjectArray: 9,
    D3DXVec3Transform: 3, D3DXVec3TransformArray: 6, D3DXVec3TransformCoord: 3,
    D3DXVec3TransformCoordArray: 6, D3DXVec3TransformNormal: 3,
    D3DXVec3TransformNormalArray: 6, D3DXVec3Unproject: 6, D3DXVec3UnprojectArray: 9,
    D3DXVec4BaryCentric: 6, D3DXVec4CatmullRom: 6, D3DXVec4Cross: 4, D3DXVec4Hermite: 6,
    D3DXVec4Normalize: 2, D3DXVec4Transform: 3, D3DXVec4TransformArray: 6,
};

test('every mathematical export is there, stdcall, and pops its arguments', ()=>{
    const { fns } = machine();
    for (const [name, count] of Object.entries(MATHEMATICS))
    {
        assert.ok(fns[name], `${name} is exported`);
        assert.equal(fns[name].argBytes, count * 4, name);
        assert.equal(fns[name].convention, 'stdcall', name);
    }
    assert.equal(fns.D3DXCreateEffectPool.argBytes, 4);
    assert.equal(fns.D3DXCreateEffectFromResourceA.argBytes, 36);
});

test('a transpose swaps rows and columns and answers the output pointer', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.equal(fns.D3DXMatrixTranspose.handler([OUT, A]), OUT);
    assert.deepEqual(getFloats(OUT, 16), [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]);
});

test('multiplying by the identity is the matrix itself', ()=>{
    const { fns, putFloats, getFloats } = machine();
    const m = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    putFloats(A, m);
    putFloats(B, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    fns.D3DXMatrixMultiply.handler([OUT, A, B]);
    assert.deepEqual(getFloats(OUT, 16), m);
});

test('a translation carries a point, and its inverse carries it back', ()=>{
    const { fns, putFloats, getFloats, asArg } = machine();
    fns.D3DXMatrixTranslation.handler([A, asArg(10), asArg(-5), asArg(3)]);
    // v * T moves the point by the translation row.
    putFloats(B, [1, 2, 3, 1]);
    fns.D3DXVec4Transform.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 4), [11, -3, 6, 1]);

    const determinant = 0x40;
    assert.equal(fns.D3DXMatrixInverse.handler([0x400, determinant, A]), 0x400);
    fns.D3DXVec4Transform.handler([OUT, OUT, 0x400]);
    assert.deepEqual(getFloats(OUT, 4), [1, 2, 3, 1], 'through the inverse, back to the start');
});

test('a singular matrix inverts to NULL, the output and the determinant as they were', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, new Array(16).fill(0));
    putFloats(OUT, [7]);
    putFloats(0x40, [5]);
    assert.equal(fns.D3DXMatrixInverse.handler([OUT, 0x40, A]), 0);
    assert.deepEqual(getFloats(0x40, 1), [5]);
    assert.deepEqual(getFloats(OUT, 1), [7]);
});

test('normalising makes a unit vector and leaves a zero vector zero', ()=>{
    const { fns, putFloats, getFloats, f32 } = machine();
    putFloats(A, [0, 3, 4]);
    fns.D3DXVec3Normalize.handler([OUT, A]);
    assert.deepEqual(getFloats(OUT, 3), f32([0, 0.6, 0.8]));
    putFloats(A, [0, 0, 0]);
    fns.D3DXVec3Normalize.handler([OUT, A]);
    assert.deepEqual(getFloats(OUT, 3), [0, 0, 0]);
});

test('a normal ignores translation where a coordinate does not', ()=>{
    const { fns, putFloats, getFloats, asArg } = machine();
    fns.D3DXMatrixTranslation.handler([A, asArg(10), asArg(0), asArg(0)]);
    putFloats(B, [1, 0, 0]);
    fns.D3DXVec3TransformNormal.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 3), [1, 0, 0], 'a normal is unmoved by a translation');
});

/**
 * The facilities built on a device, each with its argument count as Wine's
 * d3dx9_43.spec gives it, then the arguments that point at an object the call
 * would have made.
 */
const NOT_BUILT = {
    D3DXComputeNormalMap: [6],
    D3DXCreateTeapot: [3, 1, 2], D3DXCreateTextA: [8, 5, 6],
    D3DXSimplifyMesh: [7, 6], D3DXUVAtlasPartition: [17, 11, 12, 13, 14],
};

test('D3DXCreateBuffer hands over a zeroed block behind an ID3DXBuffer, freed with it', ()=>{
    // A game fills one before it hands it on and never checks the answer:
    // E_NOTIMPL left it calling through a null pointer.
    const memory = new Uint8Array(0x1000).fill(0xaa);
    /** @type {any[]} */
    const published = [];
    /** @type {number[]} */
    const freed = [];
    const fns = /** @type {any} */ (createD3dxFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        heap: { allocate: ()=>0x800, free: address=>freed.push(address) },
        vtables: { publish: (object, id)=>{
            published.push({ object, id });
            return 0x600;
        } },
    }));
    const view = new DataView(memory.buffer);
    assert.equal(fns.D3DXCreateBuffer.argBytes, 8);
    assert.equal(fns.D3DXCreateBuffer.handler([0x424, OUT]), 0);
    assert.equal(view.getUint32(OUT, true), 0x600, 'the interface pointer');
    assert.ok(memory.subarray(0x800, 0x800 + 0x424).every(byte=>byte === 0), 'zeroed');
    const [{ object, id }] = published;
    assert.equal(id, '{8BA5FB08-5195-40E2-AC58-0D989C3A0102}', 'IID_ID3DXBuffer');
    const methods = object.interfaceFor(id).methods;
    const call = (/** @type {string} */ name)=>methods.find((/** @type {any} */ one)=>
        one.name === name).invoke(object, []);
    assert.deepEqual([call('GetBufferPointer'), call('GetBufferSize')], [0x800, 0x424]);
    object.release();
    assert.deepEqual(freed, [0x800], 'the block goes back with the last reference');
    assert.equal(fns.D3DXCreateBuffer.handler([16, 0]) >>> 0, 0x8876086c, 'nowhere to put it');
});

test('what is built on a device answers E_NOTIMPL, its objects null, and says so', ()=>{
    // Bound with the stack width the caller compiled against, so a program
    // that imports one gets an answer it checks rather than a stack walked off.
    for (const [name, [count, ...outs]] of Object.entries(NOT_BUILT))
    {
        const { fns, memory, diverged } = machine();
        assert.equal(fns[name].argBytes, count * 4, name);
        const args = new Array(count).fill(0);
        for (const at of outs)
        {
            args[at] = 0x400 + at * 4;
            memory.fill(0xaa, args[at], args[at] + 4);
        }
        assert.equal(fns[name].handler(args) >>> 0, E_NOTIMPL, name);
        for (const at of outs)
        {
            assert.deepEqual([...memory.subarray(args[at], args[at] + 4)], [0, 0, 0, 0],
                `${name}: argument ${at} left null`);
        }
        assert.deepEqual(diverged, [name]);
    }
});

/**
 * The device and mesh facilities built here, each with its argument count
 * as its documented signature gives it.
 */
const BUILT = {
    D3DXCheckTextureRequirements: 7, D3DXComputeBoundingBox: 5, D3DXComputeBoundingSphere: 5,
    D3DXComputeNormals: 2, D3DXConvertMeshSubsetToSingleStrip: 5, D3DXCreateLine: 2,
    D3DXCreateRenderToSurface: 7, D3DXCreateTexture: 8, D3DXFillTexture: 3,
    D3DXFilterTexture: 4, D3DXSaveSurfaceToFileA: 5, D3DXSaveSurfaceToFileW: 5,
    D3DXSaveSurfaceToFileInMemory: 5,
    D3DXCreateBox: 6, D3DXCreateCylinder: 8, D3DXCreatePolygon: 5, D3DXCreateSphere: 6,
    D3DXCreateTorus: 7, D3DXValidMesh: 3, D3DXCleanMesh: 6,
    D3DXCreateMesh: 6, D3DXCreateMeshFVF: 6, D3DXDeclaratorFromFVF: 2, D3DXFVFFromDeclarator: 2,
    D3DXGetDeclVertexSize: 2, D3DXGetDeclLength: 1,
    D3DXAssembleShader: 7, D3DXAssembleShaderFromFileA: 6, D3DXAssembleShaderFromFileW: 6,
    D3DXAssembleShaderFromResourceA: 7, D3DXAssembleShaderFromResourceW: 7,
    D3DXCompileShader: 10, D3DXCompileShaderFromFileA: 9, D3DXCompileShaderFromFileW: 9,
    D3DXCompileShaderFromResourceA: 10, D3DXCompileShaderFromResourceW: 10,
    D3DXPreprocessShader: 6, D3DXPreprocessShaderFromFileA: 5, D3DXPreprocessShaderFromFileW: 5,
    D3DXPreprocessShaderFromResourceA: 6, D3DXPreprocessShaderFromResourceW: 6,
    D3DXGetShaderVersion: 1, D3DXSaveTextureToFileA: 4, D3DXSaveTextureToFileW: 4,
    D3DXGetPixelShaderProfile: 1, D3DXGetVertexShaderProfile: 1,
    D3DXSaveTextureToFileInMemory: 4,
    D3DXCreateTextureFromFileA: 3, D3DXCreateTextureFromFileW: 3,
    D3DXCreateTextureFromFileExA: 14, D3DXCreateTextureFromFileExW: 14,
    D3DXCreateTextureFromFileInMemory: 4, D3DXCreateTextureFromFileInMemoryEx: 15,
    D3DXCreateTextureFromResourceA: 4, D3DXCreateTextureFromResourceW: 4,
    D3DXCreateTextureFromResourceExA: 15, D3DXCreateTextureFromResourceExW: 15,
    D3DXCreateCubeTextureFromFileA: 3, D3DXCreateCubeTextureFromFileW: 3,
    D3DXCreateCubeTextureFromFileExA: 13, D3DXCreateCubeTextureFromFileExW: 13,
    D3DXCreateCubeTextureFromFileInMemory: 4, D3DXCreateCubeTextureFromFileInMemoryEx: 14,
    D3DXCreateCubeTextureFromResourceA: 4, D3DXCreateCubeTextureFromResourceW: 4,
    D3DXCreateCubeTextureFromResourceExA: 14, D3DXCreateCubeTextureFromResourceExW: 14,
    D3DXGetImageInfoFromFileA: 2, D3DXGetImageInfoFromFileW: 2,
    D3DXGetImageInfoFromFileInMemory: 3, D3DXGetImageInfoFromResourceA: 3,
    D3DXGetImageInfoFromResourceW: 3, D3DXLoadSurfaceFromFileA: 8, D3DXLoadSurfaceFromFileW: 8,
    D3DXLoadSurfaceFromFileInMemory: 9, D3DXLoadSurfaceFromResourceA: 9,
    D3DXLoadSurfaceFromResourceW: 9, D3DXLoadSurfaceFromSurface: 8, D3DXLoadSurfaceFromMemory: 10,
};

test('the device and mesh facilities are exported with the width they pop', ()=>{
    const { fns } = machine();
    for (const [name, count] of Object.entries(BUILT))
    {
        assert.equal(fns[name]?.argBytes, count * 4, name);
        assert.ok(!(name in NOT_BUILT), `${name} is not also listed as not built`);
    }
});

test('the arithmetic is code in the guest, stdcall, its handler the same JavaScript', ()=>{
    const { fns } = machine();
    for (const compiled of [COMPILED, MATRIX, VECTOR, QUATERNION])
    {
        for (const [name, { code }] of Object.entries(compiled))
        {
            assert.equal(fns[name].convention, 'stdcall', name);
            assert.deepEqual(fns[name].code(), code, name);
            assert.equal(typeof fns[name].handler, 'function', name);
        }
    }
});

test('a normal takes no part of the translation row, whatever it holds', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, Infinity, NaN, -Infinity, 1]);
    putFloats(B, [1, 1, 1]);
    fns.D3DXVec3TransformNormal.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 3), [2, 3, 4]);
});

test('a point transformed to a w of zero is divided by one', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 0]);
    putFloats(B, [1, 2, 3]);
    fns.D3DXVec3TransformCoord.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 3), [6, 8, 10]);
});

/**
 * A guest whose memory ends in several places -- the ends of allocations,
 * past which may lie nothing -- and refuses a read across one, as the memory
 * layer refuses one past a region's end; with a heap, a place for objects and
 * a disk that records what was opened.
 *
 * @param {number[]} ends
 */
function endingMemory(ends){
    const memory = new Uint8Array(Math.max(...ends));
    /** @type {any[]} */
    const published = [];
    /** @type {string[]} */
    const opened = [];
    let free = 0x100;
    const fns = /** @type {any} */ (createD3dxFunctions({
        readMemory: (address, length)=>{
            for (const end of ends)
            {
                assert.ok(address >= end || address + length <= end, `read of ${length} bytes`
                    + ` at 0x${address.toString(16)} runs past an end at 0x${end.toString(16)}`);
            }
            return memory.subarray(address, address + length);
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readFile: async path=>{
            opened.push(path);
            return new TextEncoder().encode('float4 tint() : COLOR0 { return 1; }');
        },
        heap: { allocate: bytes=>{
            const at = free;
            free += bytes + 15 & ~15;
            return at;
        }, free: ()=>{} },
        vtables: { publish: object=>{
            published.push(object);
            return 0x10 + published.length * 16;
        } },
    }));
    /**
     * Text ending 8 bytes before an end, terminator included.
     *
     * @param {string} text @param {number} end @param {boolean} [wide]
     */
    const before = (text, end, wide = false)=>{
        const bytes = wide
            ? new Uint8Array(Uint16Array.from(`${text}\0`, c=>c.charCodeAt(0)).buffer)
            : new TextEncoder().encode(`${text}\0`);
        const at = end - 8 - bytes.length;
        memory.set(bytes, at);
        return at;
    };
    return { fns, published, opened, before };
}

test('names that end just short of the end of their memory are read without reading past it',
    async()=>{
        const ends = [0x4000, 0x6000, 0x8000, 0xa000, 0xc000];
        const m = endingMemory(ends);
        const out = 0x200;
        assert.equal(m.fns.D3DXCreateFontA.handler([0x900, 16, 0, 400, 1, 0, 0, 0, 0, 0,
            m.before('Tahoma', ends[0]), out]), 0);
        assert.equal(m.fns.D3DXCreateFontW.handler([0x900, 16, 0, 400, 1, 0, 0, 0, 0, 0,
            m.before('Arial', ends[1], true), out]), 0);
        assert.deepEqual(m.published.map(font=>font.state.desc.faceName), ['Tahoma', 'Arial']);

        assert.equal(await m.fns.D3DXCompileShaderFromFileW.handler([
            m.before('shaders\\tint.psh', ends[2], true), 0, 0, m.before('tint', ends[3]),
            m.before('ps_2_0', ends[4]), 0, out, out + 4, out + 8]), 0);
        assert.deepEqual(m.opened, ['shaders\\tint.psh']);
    });

test('D3DXCheckVersion answers its own SDK version and D3DXDebugMute the setting before', ()=>{
    const v43 = d3dxVersionFunctions(43);
    // D3D_SDK_VERSION 32, D3DX_SDK_VERSION the library's number.
    assert.equal(v43.D3DXCheckVersion.handler([32, 43]), 1);
    assert.equal(v43.D3DXCheckVersion.handler([32, 42]), 0);
    assert.equal(v43.D3DXCheckVersion.handler([31, 43]), 0);
    assert.equal(d3dxVersionFunctions(24).D3DXCheckVersion.handler([32, 24]), 1);
    assert.equal(v43.D3DXCheckVersion.argBytes, 8);
    assert.equal(v43.D3DXDebugMute.handler([1]), 0);
    assert.equal(v43.D3DXDebugMute.handler([0]), 1);
    assert.equal(v43.D3DXDebugMute.handler([0]), 0);
    assert.equal(v43.D3DXDebugMute.argBytes, 4);
});
