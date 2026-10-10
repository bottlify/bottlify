/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD3dxFunctions } from './functions.js';
import { IID_ID3DXEFFECT, IID_ID3DXEFFECTCOMPILER, IID_ID3DXEFFECTPOOL, IID_ID3DXEFFECT_25,
    IID_ID3DXEFFECT_26, createEffects } from './effect.js';
import { PC, PT, buildEffect, techniqueCompiles } from './effect-model.js';
import { assembleShader } from './shader-asm.js';
import { execute } from './d3d9-machine.fixture.js';

const D3D_OK = 0;
const S_FALSE = 1;
const E_FAIL = 0x80004005;
const E_NOTIMPL = 0x80004001;
const D3DERR_INVALIDCALL = 0x8876086c;

/** The guest's code addresses: a COM object's slot n is ENTRY + n; an include's are its own. */
const ENTRY = 0xe0000;
const INCLUDE_OPEN = 0xf0000;
const INCLUDE_CLOSE = 0xf0001;

/** IDirect3DDevice9's slots the tests read back. */
const SLOT = {
    AddRef: 1, Release: 2, SetTransform: 44, SetMaterial: 49, SetLight: 51, LightEnable: 53,
    SetRenderState: 57, BeginStateBlock: 60, EndStateBlock: 61, SetTexture: 65,
    SetTextureStageState: 67, SetSamplerState: 69, SetFVF: 89, CreateVertexShader: 91,
    SetVertexShader: 92, SetVertexShaderConstantF: 94, SetVertexShaderConstantI: 96,
    SetVertexShaderConstantB: 98, CreatePixelShader: 106, SetPixelShader: 107,
    SetPixelShaderConstantF: 109, SetPixelShaderConstantI: 111, SetPixelShaderConstantB: 113,
};
/** @type {Record<number, string>} */
const SLOT_NAME = Object.fromEntries(Object.entries(SLOT).map(([name, slot])=>[slot, name]));

/**
 * A guest: memory, a heap, COM objects published by the layer and found again by
 * pointer, a device whose methods are reached through its vtable and recorded, a
 * state manager of the same kind, and an ID3DXInclude serving some files. A call
 * into the guest made before the handler has returned fails the test, as the bridge
 * cannot take it.
 *
 * @param {{ files?: Record<string, string>, version?: number }} [options]
 */
function guest(options = {}){
    const memory = new Uint8Array(1 << 22);
    const view = new DataView(memory.buffer);
    let next = 0x10000;
    /** @type {number[]} */
    const freed = [];
    const heap = {
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        free: (/** @type {number} */ at)=>freed.push(at),
    };
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @param {any} state */
    const object = state=>{
        const at = heap.allocate(4);
        const vtable = heap.allocate(128 * 4);
        view.setUint32(at, vtable, true);
        for (let slot = 0; slot < 128; slot++)
        {
            view.setUint32(vtable + slot * 4, ENTRY + slot, true);
        }
        objects.set(at, { refs: 1, ...state });
        return at;
    };
    const device = object({ kind: 'device' });
    const manager = object({ kind: 'manager' });
    const include = heap.allocate(8);
    const includeTable = heap.allocate(8);
    view.setUint32(include, includeTable, true);
    view.setUint32(includeTable, INCLUDE_OPEN, true);
    view.setUint32(includeTable + 4, INCLUDE_CLOSE, true);

    /** Every call the layer made on a guest object, decoded. @type {any[]} */
    const calls = [];
    /** @type {string[]} */
    const opened = [];
    /** @type {string[]} */
    const diverged = [];
    let inHandler = false;
    /** @param {number} at @param {number} count */
    const floats = (at, count)=>Array.from({ length: count }, (_, i)=>view.getFloat32(at + i * 4,
        true));
    /** @param {number} at @param {number} count */
    const ints = (at, count)=>Array.from({ length: count }, (_, i)=>view.getInt32(at + i * 4,
        true));
    /** @param {number} at */
    const text = at=>{
        let out = '';
        for (let i = at; memory[i] !== 0; i++)
        {
            out += String.fromCharCode(memory[i]);
        }
        return out;
    };

    const callGuest = async(/** @type {{ entry: number, args: number[] }} */ { entry, args })=>{
        if (inHandler)
        {
            throw new Error('a call into the guest before the handler returned');
        }
        if (entry === INCLUDE_OPEN)
        {
            const [, , name, , dataOut, bytesOut] = args;
            const file = text(name);
            opened.push(file);
            const content = options.files?.[file];
            if (content === undefined)
            {
                return E_FAIL;
            }
            const at = heap.allocate(content.length + 1);
            memory.set([...content].map(c=>c.charCodeAt(0)), at);
            view.setUint32(dataOut, at, true);
            view.setUint32(bytesOut, content.length, true);
            return D3D_OK;
        }
        if (entry === INCLUDE_CLOSE)
        {
            return D3D_OK;
        }
        const slot = entry - ENTRY;
        const self = objects.get(args[0]);
        if (!self)
        {
            throw new Error(`a call on ${args[0].toString(16)}, which is no object`);
        }
        if (slot === SLOT.AddRef)
        {
            self.refs++;
            calls.push({ on: self.kind, name: 'AddRef' });
            return self.refs;
        }
        if (slot === SLOT.Release)
        {
            self.refs--;
            calls.push({ on: self.kind, name: 'Release' });
            return self.refs;
        }
        if (self.kind === 'texture')
        {
            if (slot === 17)
            {
                view.setUint32(args[2] + 12, self.pool, true);
            }
            return D3D_OK;
        }
        if (self.kind === 'block')
        {
            calls.push({ on: 'block', name: slot === 4 ? 'Capture' : slot === 5 ? 'Apply'
                : `slot ${slot}`, block: args[0] });
            return D3D_OK;
        }
        // The device and the state manager: the manager's setters are the device's, in
        // the device's order, from slot 3.
        const managerNames = ['SetTransform', 'SetMaterial', 'SetLight', 'LightEnable',
            'SetRenderState', 'SetTexture', 'SetTextureStageState', 'SetSamplerState',
            'SetNPatchMode', 'SetFVF', 'SetVertexShader', 'SetVertexShaderConstantF',
            'SetVertexShaderConstantI', 'SetVertexShaderConstantB', 'SetPixelShader',
            'SetPixelShaderConstantF', 'SetPixelShaderConstantI', 'SetPixelShaderConstantB'];
        const name = self.kind === 'manager' ? managerNames[slot - 3] : SLOT_NAME[slot];
        const rest = args.slice(1);
        /** @type {any} */
        const call = { on: self.kind, name, args: rest };
        switch (name)
        {
            case 'CreateVertexShader':
            case 'CreatePixelShader': {
                const tokens = [];
                for (let at = rest[0]; ; at += 4)
                {
                    tokens.push(view.getUint32(at, true));
                    if (tokens[tokens.length - 1] === 0xffff)
                    {
                        break;
                    }
                }
                const shader = object({ kind: name === 'CreatePixelShader' ? 'ps' : 'vs',
                    tokens: Uint32Array.from(tokens) });
                view.setUint32(rest[1], shader, true);
                call.shader = shader;
                break;
            }
            case 'EndStateBlock': {
                const block = object({ kind: 'block' });
                view.setUint32(rest[0], block, true);
                call.block = block;
                break;
            }
            case 'SetVertexShaderConstantF':
            case 'SetPixelShaderConstantF':
                call.values = floats(rest[1], rest[2] * 4);
                break;
            case 'SetVertexShaderConstantI':
            case 'SetPixelShaderConstantI':
                call.values = ints(rest[1], rest[2] * 4);
                break;
            case 'SetVertexShaderConstantB':
            case 'SetPixelShaderConstantB':
                call.values = ints(rest[1], rest[2]);
                break;
            case 'SetTransform':
                call.values = floats(rest[1], 16);
                break;
            case 'SetLight':
                call.values = [view.getUint32(rest[1], true), ...floats(rest[1] + 4, 25)];
                break;
            case 'SetMaterial':
                call.values = floats(rest[0], 17);
                break;
            default:
                break;
        }
        calls.push(call);
        return D3D_OK;
    };

    /** @type {Map<number, { object: any, iid: string }>} */
    const published = new Map();
    let nextPointer = 0x3000000;
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        heap, callGuest,
        vtables: { publish: (/** @type {any} */ obj, /** @type {string} */ iid)=>{
            nextPointer += 16;
            published.set(nextPointer, { object: obj, iid });
            return nextPointer;
        } },
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            diverged.push(`${api}: ${detail}`),
        currentThread: ()=>undefined,
    };
    const fns = /** @type {any} */ (createD3dxFunctions(host, { version: options.version }));

    /** @param {string} value */
    const put = value=>{
        const at = heap.allocate(value.length + 1);
        memory.set([...value].map(c=>c.charCodeAt(0) & 0xff), at);
        memory[at + value.length] = 0;
        return at;
    };
    /** @param {number[]} values */
    const putFloats = values=>{
        const at = heap.allocate(values.length * 4);
        values.forEach((v, i)=>view.setFloat32(at + i * 4, v, true));
        return at;
    };
    /** @param {number[]} values */
    const putInts = values=>{
        const at = heap.allocate(values.length * 4);
        values.forEach((v, i)=>view.setUint32(at + i * 4, v >>> 0, true));
        return at;
    };
    const out = (/** @type {number} */ bytes = 4)=>{
        const at = heap.allocate(bytes);
        memory.fill(0xcd, at, at + bytes);
        return at;
    };
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);

    /**
     * A function of the library, the way the bridge calls it.
     *
     * @param {string} name @param {...number} args
     * @returns {Promise<number>}
     */
    const fn = async(name, ...args)=>{
        assert.equal(fns[name].argBytes, args.length * 4, `${name} takes ${args.length} arguments`);
        inHandler = true;
        let answer;
        try
        {
            answer = fns[name].handler(args);
        }
        finally
        {
            inHandler = false;
        }
        return (await answer) >>> 0;
    };
    /**
     * A method of an object the layer published, by name.
     *
     * @param {number} pointer @param {string} name @param {...number} args
     * @returns {Promise<number>}
     */
    const call = async(pointer, name, ...args)=>{
        const entry = published.get(pointer);
        if (!entry)
        {
            throw new Error(`no object at ${pointer}`);
        }
        const methods = entry.object.interfaceFor(entry.iid).methods;
        const method = methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(method, `${name} is a method`);
        assert.equal(method.argBytes, args.length * 4 + 4, `${name} takes ${args.length}`);
        if (method.builtin === 'release')
        {
            return entry.object.release();
        }
        if (method.builtin === 'addRef')
        {
            return entry.object.addRef();
        }
        inHandler = true;
        let answer;
        try
        {
            answer = method.invoke(entry.object, args);
        }
        finally
        {
            inHandler = false;
        }
        return (await answer) >>> 0;
    };

    /**
     * An effect from source on the device.
     *
     * @param {string} source
     * @param {{ pool?: number, flags?: number, include?: boolean, errors?: boolean }} [how]
     */
    const effect = async(source, how = {})=>{
        const data = put(source);
        const effectOut = out();
        const errorsOut = out();
        const answer = await fn('D3DXCreateEffect', device, data, source.length, 0,
            how.include ? include : 0, how.flags ?? 0, how.pool ?? 0, effectOut, errorsOut);
        const errors = u32(errorsOut) ? bufferText(u32(errorsOut)) : '';
        assert.equal(answer, D3D_OK, `D3DXCreateEffect: ${errors}`);
        return u32(effectOut);
    };
    /** The text of an ID3DXBuffer the layer published. @param {number} pointer */
    const bufferText = pointer=>{
        const { state } = /** @type {any} */ (published.get(pointer)).object;
        return text(state.data);
    };
    /** The bytes of an ID3DXBuffer the layer published. @param {number} pointer */
    const bufferBytes = pointer=>{
        const { state } = /** @type {any} */ (published.get(pointer)).object;
        return memory.slice(state.data, state.data + state.size);
    };
    /** A handle by name. @param {number} fx @param {string} name */
    const handle = (fx, name)=>call(fx, 'GetParameterByName', 0, put(name));
    /** The D3DXPARAMETER_DESC of a handle. @param {number} fx @param {number} h */
    const desc = async(fx, h)=>{
        const at = out(44);
        assert.equal(await call(fx, 'GetParameterDesc', h, at), D3D_OK);
        const [name, semantic, cls, type, rows, columns, elements, annotations, members, flags,
            bytes] = Array.from({ length: 11 }, (_, i)=>u32(at + i * 4));
        return { name: name ? text(name) : null, semantic: semantic ? text(semantic) : null, cls,
            type, rows, columns, elements, annotations, members, flags, bytes };
    };
    return { memory, view, heap, freed, objects, object, device, manager, include, calls, opened,
        diverged, fns, fn, call, put, putFloats, putInts, out, u32, floats, ints, text, effect,
        bufferText, bufferBytes, handle, desc, published };
}

// ---- the contract: exports, vtables ------------------------------------------------------

test('every effect function is exported with the width of its arguments', ()=>{
    const { fns } = guest();
    /** Arguments of each, as d3dx9effect.h declares them. */
    const widths = {
        D3DXCreateEffect: 9, D3DXCreateEffectEx: 10, D3DXCreateEffectFromFileA: 8,
        D3DXCreateEffectFromFileW: 8, D3DXCreateEffectFromFileExA: 9,
        D3DXCreateEffectFromFileExW: 9, D3DXCreateEffectFromResourceA: 9,
        D3DXCreateEffectFromResourceW: 9, D3DXCreateEffectFromResourceExA: 10,
        D3DXCreateEffectFromResourceExW: 10, D3DXCreateEffectPool: 1,
        D3DXCreateEffectCompiler: 7, D3DXCreateEffectCompilerFromFileA: 6,
        D3DXCreateEffectCompilerFromFileW: 6, D3DXCreateEffectCompilerFromResourceA: 7,
        D3DXCreateEffectCompilerFromResourceW: 7, D3DXDisassembleEffect: 3,
    };
    for (const [name, count] of Object.entries(widths))
    {
        assert.equal(fns[name]?.argBytes, count * 4, name);
    }
});

/** ID3DXBaseEffect's methods after IUnknown's, in d3dx9effect.h's order, with their arguments. */
const BASE = [['GetDesc', 1], ['GetParameterDesc', 2], ['GetTechniqueDesc', 2],
    ['GetPassDesc', 2], ['GetFunctionDesc', 2], ['GetParameter', 2], ['GetParameterByName', 2],
    ['GetParameterBySemantic', 2], ['GetParameterElement', 2], ['GetTechnique', 1],
    ['GetTechniqueByName', 1], ['GetPass', 2], ['GetPassByName', 2], ['GetFunction', 1],
    ['GetFunctionByName', 1], ['GetAnnotation', 2], ['GetAnnotationByName', 2], ['SetValue', 3],
    ['GetValue', 3], ['SetBool', 2], ['GetBool', 2], ['SetBoolArray', 3], ['GetBoolArray', 3],
    ['SetInt', 2], ['GetInt', 2], ['SetIntArray', 3], ['GetIntArray', 3], ['SetFloat', 2],
    ['GetFloat', 2], ['SetFloatArray', 3], ['GetFloatArray', 3], ['SetVector', 2],
    ['GetVector', 2], ['SetVectorArray', 3], ['GetVectorArray', 3], ['SetMatrix', 2],
    ['GetMatrix', 2], ['SetMatrixArray', 3], ['GetMatrixArray', 3], ['SetMatrixPointerArray', 3],
    ['GetMatrixPointerArray', 3], ['SetMatrixTranspose', 2], ['GetMatrixTranspose', 2],
    ['SetMatrixTransposeArray', 3], ['GetMatrixTransposeArray', 3],
    ['SetMatrixTransposePointerArray', 3], ['GetMatrixTransposePointerArray', 3],
    ['SetString', 2], ['GetString', 2], ['SetTexture', 2], ['GetTexture', 2],
    ['GetPixelShader', 2], ['GetVertexShader', 2], ['SetArrayRange', 3]];

/** ID3DXEffect's own, as d3dx9_27 and later have them; earlier versions lack two. */
const EFFECT = [['GetPool', 1], ['SetTechnique', 1], ['GetCurrentTechnique', 0],
    ['ValidateTechnique', 1], ['FindNextValidTechnique', 2], ['IsParameterUsed', 2],
    ['Begin', 2], ['BeginPass', 1], ['CommitChanges', 0], ['EndPass', 0], ['End', 0],
    ['GetDevice', 1], ['OnLostDevice', 0], ['OnResetDevice', 0], ['SetStateManager', 1],
    ['GetStateManager', 1], ['BeginParameterBlock', 0], ['EndParameterBlock', 0],
    ['ApplyParameterBlock', 1], ['DeleteParameterBlock', 1], ['CloneEffect', 2],
    ['SetRawValue', 4]];

test('the vtables are in the header\'s order, each slot popping its own arguments', ()=>{
    const host = { readMemory: ()=>new Uint8Array(4), writeMemory: ()=>{} };
    const helpers = { giveBuffer: ()=>0, includer: ()=>async()=>null, macrosAt: ()=>[],
        publishConstantTable: ()=>0 };
    /** @param {any} descriptor */
    const slots = descriptor=>descriptor.methods.map((/** @type {any} */ m)=>
        [m.name, m.argBytes / 4 - 1]);
    const latest = createEffects(host, helpers);
    assert.equal(latest.effectInterface.id, IID_ID3DXEFFECT);
    assert.deepEqual(slots(latest.effectInterface), [...BASE, ...EFFECT]);
    const v26 = createEffects(host, helpers, { version: 26 });
    assert.equal(v26.effectInterface.id, IID_ID3DXEFFECT_26);
    assert.deepEqual(slots(v26.effectInterface), [...BASE,
        ...EFFECT.filter(([name])=>name !== 'SetRawValue')]);
    const v25 = createEffects(host, helpers, { version: 25 });
    assert.equal(v25.effectInterface.id, IID_ID3DXEFFECT_25);
    assert.deepEqual(slots(v25.effectInterface), [...BASE,
        ...EFFECT.filter(([name])=>name !== 'SetRawValue' && name !== 'DeleteParameterBlock')]);
    assert.equal(latest.compilerInterface.id, IID_ID3DXEFFECTCOMPILER);
    assert.deepEqual(slots(latest.compilerInterface), [...BASE, ['SetLiteral', 2],
        ['GetLiteral', 2], ['CompileEffect', 3], ['CompileShader', 6]]);
    assert.equal(latest.poolInterface.id, IID_ID3DXEFFECTPOOL);
    assert.deepEqual(latest.poolInterface.methods, []);
});

// ---- making one -----------------------------------------------------------------------

const MINIMAL = 'technique t { pass p { } }';

test('D3DXCreateEffect checks its arguments as D3DX does', async()=>{
    const g = guest();
    const data = g.put(MINIMAL);
    const effectOut = g.out();
    assert.equal(await g.fn('D3DXCreateEffect', 0, data, MINIMAL.length, 0, 0, 0, 0, effectOut, 0),
        D3DERR_INVALIDCALL, 'no device');
    assert.equal(g.u32(effectOut), 0, 'the out pointer is cleared first');
    assert.equal(await g.fn('D3DXCreateEffect', g.device, 0, 0, 0, 0, 0, 0, effectOut, 0),
        D3DERR_INVALIDCALL, 'no data');
    assert.equal(await g.fn('D3DXCreateEffect', g.device, data, 0, 0, 0, 0, 0, effectOut, 0),
        E_FAIL, 'no length');
    assert.equal(await g.fn('D3DXCreateEffect', g.device, data, MINIMAL.length, 0, 0, 0, 0, 0, 0),
        D3D_OK, 'nowhere to put it is no error');
    const fx = await g.effect(MINIMAL);
    const at = g.out(16);
    assert.equal(await g.call(fx, 'GetDesc', at), D3D_OK);
    assert.equal(g.text(g.u32(at)), 'D3DX Effect Compiler');
    assert.deepEqual([g.u32(at + 4), g.u32(at + 8), g.u32(at + 12)], [0, 1, 0],
        'parameters, techniques, functions');
    assert.equal(await g.call(fx, 'GetDesc', 0), D3DERR_INVALIDCALL);
});

test('a compiled fx_2_0 effect is refused, and said so; source is compiled', async()=>{
    const g = guest();
    const binary = g.putInts([0xfeff0901, 0, 0, 0]);
    const effectOut = g.out();
    assert.equal(await g.fn('D3DXCreateEffect', g.device, binary, 16, 0, 0, 0, 0, effectOut, 0),
        E_NOTIMPL);
    assert.equal(g.u32(effectOut), 0);
    assert.match(g.diverged.join('\n'), /fx_2_0/);
    const errorsOut = g.out();
    const bad = 'float4 f( : COLOR { return 0; }';
    assert.equal(await g.fn('D3DXCreateEffect', g.device, g.put(bad), bad.length, 0, 0, 0, 0,
        effectOut, errorsOut), E_FAIL, 'a syntax error');
    assert.match(g.bufferText(g.u32(errorsOut)), /^memory\(1,\d+\): error X3000/);
});

// ---- parameters ---------------------------------------------------------------------

const VALUES = `
float f = 0.1;
float1 f1 = {1.1};
float2 f2 = {2.1, 2.2};
float3 f3 = {3.1, 3.2, 3.3};
float4 f4 = {4.1, 4.2, 4.3, 4.4};
float1x1 f11 = {11.1};
float2x1 f21 = {{21.11, 21.21}};
float2x3 f23 = {{23.11, 23.21}, {23.12, 23.22}, {23.13, 23.23}};
float4x4 f44 = {{44.11, 44.21, 44.31, 44.41}, {44.12, 44.22, 44.32, 44.42},
        {44.13, 44.23, 44.33, 44.43}, {44.14, 44.24, 44.34, 44.44}};
float f_2[2] = {0.101, 0.102};
float4 f4_2[2] = {{4.101, 4.201, 4.301, 4.401}, {4.102, 4.202, 4.302, 4.402}};
float2x2 f22_2[2] = {{{22.1101, 22.2101}, {22.1201, 22.2201}},
        {{22.1102, 22.2102}, {22.1202, 22.2202}}};
int i = 1;
int4 i4 = {41, 42, 43, 44};
int2x3 i23 = {{2311, 2321}, {2312, 2322}, {2313, 2323}};
bool b = true;
bool3 b3 = {true, false, true};
string s = "test";
string s_2[2] = {"test1", "test2"};
texture2D tex;
Vertexshader v;
Vertexshader v_2[2];
Pixelshader p;
Pixelshader p_2[2];
technique t { pass p { } }
`;

/**
 * What D3DX describes each parameter of VALUES as, and holds for it.
 *
 * @type {[string, number, number, number, number, number, number, number[] | null][]}
 */
const EXPECTED = [
    ['f', PC.SCALAR, PT.FLOAT, 1, 1, 0, 4, [0.1]],
    ['f1', PC.VECTOR, PT.FLOAT, 1, 1, 0, 4, [1.1]],
    ['f2', PC.VECTOR, PT.FLOAT, 1, 2, 0, 8, [2.1, 2.2]],
    ['f3', PC.VECTOR, PT.FLOAT, 1, 3, 0, 12, [3.1, 3.2, 3.3]],
    ['f4', PC.VECTOR, PT.FLOAT, 1, 4, 0, 16, [4.1, 4.2, 4.3, 4.4]],
    ['f11', PC.MATRIX_ROWS, PT.FLOAT, 1, 1, 0, 4, [11.1]],
    ['f21', PC.MATRIX_ROWS, PT.FLOAT, 2, 1, 0, 8, [21.11, 21.21]],
    ['f23', PC.MATRIX_ROWS, PT.FLOAT, 2, 3, 0, 24, [23.11, 23.21, 23.12, 23.22, 23.13, 23.23]],
    ['f44', PC.MATRIX_ROWS, PT.FLOAT, 4, 4, 0, 64, [44.11, 44.21, 44.31, 44.41, 44.12, 44.22,
        44.32, 44.42, 44.13, 44.23, 44.33, 44.43, 44.14, 44.24, 44.34, 44.44]],
    ['f_2', PC.SCALAR, PT.FLOAT, 1, 1, 2, 8, [0.101, 0.102]],
    ['f4_2', PC.VECTOR, PT.FLOAT, 1, 4, 2, 32, [4.101, 4.201, 4.301, 4.401, 4.102, 4.202, 4.302,
        4.402]],
    ['f22_2', PC.MATRIX_ROWS, PT.FLOAT, 2, 2, 2, 32, [22.1101, 22.2101, 22.1201, 22.2201,
        22.1102, 22.2102, 22.1202, 22.2202]],
    ['i', PC.SCALAR, PT.INT, 1, 1, 0, 4, [1]],
    ['i4', PC.VECTOR, PT.INT, 1, 4, 0, 16, [41, 42, 43, 44]],
    ['i23', PC.MATRIX_ROWS, PT.INT, 2, 3, 0, 24, [2311, 2321, 2312, 2322, 2313, 2323]],
    ['b', PC.SCALAR, PT.BOOL, 1, 1, 0, 4, [1]],
    ['b3', PC.VECTOR, PT.BOOL, 1, 3, 0, 12, [1, 0, 1]],
    ['s', PC.OBJECT, PT.STRING, 0, 0, 0, 4, null],
    ['s_2', PC.OBJECT, PT.STRING, 0, 0, 2, 8, null],
    ['tex', PC.OBJECT, PT.TEXTURE2D, 0, 0, 0, 4, null],
    ['v', PC.OBJECT, PT.VERTEXSHADER, 0, 0, 0, 4, null],
    ['v_2', PC.OBJECT, PT.VERTEXSHADER, 0, 0, 2, 8, null],
    ['p', PC.OBJECT, PT.PIXELSHADER, 0, 0, 0, 4, null],
    ['p_2', PC.OBJECT, PT.PIXELSHADER, 0, 0, 2, 8, null],
];

test('parameters are described and hold their defaults as D3DX lays them out', async()=>{
    const g = guest();
    const fx = await g.effect(VALUES);
    const at = g.out(16);
    await g.call(fx, 'GetDesc', at);
    assert.equal(g.u32(at + 4), EXPECTED.length, 'every parameter, in order');
    for (const [index, [name, cls, type, rows, columns, elements, bytes, values]] of
        EXPECTED.entries())
    {
        const h = await g.call(fx, 'GetParameter', 0, index);
        assert.equal(await g.handle(fx, name), h, `${name} by name`);
        const d = await g.desc(fx, h);
        assert.deepEqual([d.name, d.cls, d.type, d.rows, d.columns, d.elements, d.bytes],
            [name, cls, type, rows, columns, elements, bytes], `${name}'s description`);
        if (!values)
        {
            continue;
        }
        const data = g.out(bytes);
        assert.equal(await g.call(fx, 'GetValue', h, data, bytes), D3D_OK);
        const got = type === PT.FLOAT ? g.floats(data, values.length)
            : g.ints(data, values.length);
        assert.deepEqual(got, values.map(x=>(type === PT.FLOAT ? Math.fround(x) : x)), name);
    }
    const s = await g.handle(fx, 's');
    const sOut = g.out();
    assert.equal(await g.call(fx, 'GetString', s, sOut), D3D_OK);
    assert.equal(g.text(g.u32(sOut)), 'test');
    const s2 = await g.handle(fx, 's_2[1]');
    assert.equal(await g.call(fx, 'GetString', s2, sOut), D3D_OK);
    assert.equal(g.text(g.u32(sOut)), 'test2');
    assert.equal(await g.call(fx, 'SetString', s, g.put('other')), D3D_OK);
    await g.call(fx, 'GetString', s, sOut);
    assert.equal(g.text(g.u32(sOut)), 'other');
});

test('a string array sized by its list has that many elements, each its string', async()=>{
    // Battlefield 2's renderer walks `string reqVertexElement[] = {...}` by
    // the description's element count; an open length read as 0xffffffff.
    const g = guest();
    const fx = await g.effect('string names[] = {"Position", "Normal"};\n'
        + 'float4 ps() : COLOR { return 1; }\n'
        + 'technique t { pass p { PixelShader = compile ps_2_0 ps(); } }\n');
    const names = await g.handle(fx, 'names');
    assert.equal((await g.desc(fx, names)).elements, 2);
    const out = g.out();
    for (const [index, text] of /** @type {[number, string][]} */ ([[0, 'Position'],
        [1, 'Normal']]))
    {
        const element = await g.call(fx, 'GetParameterElement', names, index);
        assert.ok(element);
        assert.equal(await g.call(fx, 'GetString', element, out), D3D_OK);
        assert.equal(g.text(g.u32(out)), text);
    }
    assert.equal(await g.call(fx, 'GetParameterElement', names, 2), 0);
});

test('an annotation array sized by its list has that many elements', async()=>{
    // Battlefield 2 sizes an allocation by a technique's `Declaration`
    // annotation; an open length came out as -1 elements, a -4-byte block.
    const g = guest();
    const fx = await g.effect('float4 ps() : COLOR { return 1; }\n'
        + 'technique t < int Declaration[] = { 0, 3, 1, 2 }; string list[] = {"a", "b"}; >\n'
        + '{ pass p { PixelShader = compile ps_2_0 ps(); } }\n');
    const technique = await g.call(fx, 'GetTechnique', 0);
    const declaration = await g.call(fx, 'GetAnnotationByName', technique, g.put('Declaration'));
    assert.ok(declaration);
    assert.equal((await g.desc(fx, declaration)).elements, 4);
    const ints = g.out(16);
    assert.equal(await g.call(fx, 'GetIntArray', declaration, ints, 4), D3D_OK);
    assert.deepEqual(g.ints(ints, 4), [0, 3, 1, 2]);
    const list = await g.call(fx, 'GetAnnotationByName', technique, g.put('list'));
    assert.equal((await g.desc(fx, list)).elements, 2);
});

test('the setters and getters convert as D3DX does, and refuse the wrong shape', async()=>{
    const g = guest();
    const fx = await g.effect(VALUES);
    const pf = g.out();
    const [f, i, b, f4, i4, f44, f_2, f4_2, f23, tex] = await Promise.all(['f', 'i', 'b', 'f4',
        'i4', 'f44', 'f_2', 'f4_2', 'f23', 'tex'].map(name=>g.handle(fx, name)));
    // Scalars: a float read as an int is truncated, anything read as a BOOL is its DWORD
    // not being zero.
    assert.equal(await g.call(fx, 'SetFloat', f, new Uint32Array(Float32Array.of(2.75).buffer)[0]),
        D3D_OK);
    assert.equal(await g.call(fx, 'GetInt', f, pf), D3D_OK);
    assert.equal(g.u32(pf), 2);
    assert.equal(await g.call(fx, 'GetBool', f, pf), D3D_OK);
    assert.equal(g.u32(pf), 1);
    assert.equal(await g.call(fx, 'SetInt', i, -3), D3D_OK);
    assert.equal(await g.call(fx, 'GetFloat', i, pf), D3D_OK);
    assert.equal(g.floats(pf, 1)[0], -3);
    assert.equal(await g.call(fx, 'SetBool', b, 0), D3D_OK);
    assert.equal(await g.call(fx, 'GetBool', b, pf), D3D_OK);
    assert.equal(g.u32(pf), 0);
    assert.equal(await g.call(fx, 'SetFloat', f4, 0), D3DERR_INVALIDCALL, 'not a scalar');
    assert.equal(await g.call(fx, 'GetFloat', f_2, pf), D3DERR_INVALIDCALL, 'an array');
    // An int given to a vector of three or four is a colour, ARGB, and back.
    assert.equal(await g.call(fx, 'SetInt', f4, 0x80ff4000), D3D_OK);
    const v = g.out(16);
    assert.equal(await g.call(fx, 'GetVector', f4, v), D3D_OK);
    assert.deepEqual(g.floats(v, 4), [255, 64, 0, 128].map(x=>Math.fround(x
        * Math.fround(1 / 255))));
    assert.equal(await g.call(fx, 'GetInt', f4, pf), D3D_OK);
    assert.equal(g.u32(pf), 0x80ff4000);
    // A vector given to an int is packed the same way.
    const red = g.putFloats([1, 0, 0, 0.5]);
    const iOnly = await g.handle(fx, 'i');
    assert.equal(await g.call(fx, 'SetVector', iOnly, red), D3D_OK);
    assert.equal(await g.call(fx, 'GetInt', iOnly, pf), D3D_OK);
    assert.equal(g.u32(pf), 0x7fff0000);
    // Vectors convert per component.
    assert.equal(await g.call(fx, 'SetVector', i4, g.putFloats([1.9, -2.9, 3, 4])), D3D_OK);
    const ints = g.out(16);
    assert.equal(await g.call(fx, 'GetIntArray', i4, ints, 4), D3D_OK);
    assert.deepEqual(g.ints(ints, 4), [1, -2, 3, 4]);
    // Matrices: by row; the transposed setter and getter by column.
    const m = g.putFloats(Array.from({ length: 16 }, (_, k)=>k));
    assert.equal(await g.call(fx, 'SetMatrix', f44, m), D3D_OK);
    const back = g.out(64);
    assert.equal(await g.call(fx, 'GetMatrixTranspose', f44, back), D3D_OK);
    assert.deepEqual(g.floats(back, 16), [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]);
    assert.equal(await g.call(fx, 'SetMatrixTranspose', f23, m), D3D_OK);
    const f23Out = g.out(24);
    assert.equal(await g.call(fx, 'GetFloatArray', f23, f23Out, 6), D3D_OK);
    assert.deepEqual(g.floats(f23Out, 6), [0, 4, 8, 1, 5, 9], 'a 2x3 from the columns');
    assert.equal(await g.call(fx, 'GetMatrix', f23, back), D3D_OK);
    assert.deepEqual(g.floats(back, 16), [0, 4, 8, 0, 1, 5, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        'zero outside the rows and columns');
    assert.equal(await g.call(fx, 'SetMatrix', f4, m), D3DERR_INVALIDCALL, 'a vector');
    // Arrays: as many as given, or the array's length.
    assert.equal(await g.call(fx, 'SetVectorArray', f4_2, g.putFloats([1, 2, 3, 4, 5, 6, 7, 8]),
        2), D3D_OK);
    const arr = g.out(32);
    assert.equal(await g.call(fx, 'GetVectorArray', f4_2, arr, 2), D3D_OK);
    assert.deepEqual(g.floats(arr, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(await g.call(fx, 'SetVectorArray', f4_2, arr, 3), D3DERR_INVALIDCALL);
    assert.equal(await g.call(fx, 'SetFloatArray', f_2, g.putFloats([7, 8, 9]), 3), D3D_OK);
    assert.equal(await g.call(fx, 'GetFloatArray', f_2, arr, 2), D3D_OK);
    assert.deepEqual(g.floats(arr, 2), [7, 8]);
    // SetValue takes at least the parameter's bytes.
    assert.equal(await g.call(fx, 'SetValue', f4, g.putFloats([9, 9, 9]), 12), D3DERR_INVALIDCALL);
    assert.equal(await g.call(fx, 'SetValue', f4, g.putFloats([9, 8, 7, 6]), 16), D3D_OK);
    assert.equal(await g.call(fx, 'GetVector', f4, v), D3D_OK);
    assert.deepEqual(g.floats(v, 4), [9, 8, 7, 6]);
    // Textures: GetTexture hands back a reference the caller releases.
    const texture = g.object({ kind: 'texture', pool: 1 });
    assert.equal(await g.call(fx, 'SetTexture', tex, texture), D3D_OK);
    assert.equal(await g.call(fx, 'GetTexture', tex, pf), D3D_OK);
    assert.equal(g.u32(pf), texture);
    assert.equal(g.objects.get(texture).refs, 2);
    assert.equal(await g.call(fx, 'SetTexture', f, texture), D3DERR_INVALIDCALL, 'not a texture');
    // A handle may be the name.
    assert.equal(await g.call(fx, 'SetFloat', g.put('f'), 0), D3D_OK);
    assert.equal(await g.call(fx, 'SetFloat', g.put('nothing'), 0), D3DERR_INVALIDCALL);
});

/** Wine's test of names: elements, members and annotations, each found its documented way. */
const NAMES = `
float a;
float b[1];
float c <float d = 3;>;
struct {float e;} f;
float g <float h[1] = {3};>;
struct s {float j;};
float i <s k[1] = {4};>;
technique t <s l[1] = {5};> { pass p <s m[1] = {6};> { } }
`;

test('names: elements by [n], members by ., annotations by @, as D3DX looks them up', async()=>{
    const g = guest();
    const fx = await g.effect(NAMES);
    /** @param {number} parent @param {string | null} name */
    const byName = async(parent, name)=>g.call(fx, 'GetParameterByName', parent,
        name === null ? 0 : g.put(name));
    const s = (/** @type {string} */ x)=>g.put(x);
    const a = await byName(0, 'a');
    assert.ok(a);
    assert.equal(await byName(s('a'), null), a, 'a parent and no name is the parent');
    for (const [parent, name] of [[0, 'a.'], [s('a.'), null], [s('a'), '.'], [0, 'a.invalid'],
        [s('a'), 'invalid'], [0, 'a[]'], [0, 'a[0]'], [s('a'), '[0]'], [0, 'a@'], [0, 'a@invalid'],
        [0, 'invalid1'], [0, null], [s('invalid1'), 'invalid2']])
    {
        assert.equal(await byName(/** @type {number} */ (parent), /** @type {any} */ (name)), 0,
            `${parent} ${name}`);
    }
    assert.equal(await g.call(fx, 'GetParameterElement', s('a'), 0), 0);
    const b0 = await byName(0, 'b[0]');
    assert.ok(b0);
    assert.equal(await byName(s('b[0]'), null), b0);
    assert.equal(await g.call(fx, 'GetParameterElement', s('b'), 0), b0);
    assert.equal(await byName(s('b'), '[0]'), 0);
    assert.equal(await byName(0, 'b[1]'), 0);
    assert.equal(await g.call(fx, 'GetParameterElement', s('b'), 1), 0);
    const cd = await byName(0, 'c@d');
    assert.ok(cd);
    assert.equal(await g.call(fx, 'GetAnnotationByName', s('c'), s('d')), cd);
    assert.equal(await g.call(fx, 'GetAnnotation', s('c'), 0), cd);
    assert.equal(await g.call(fx, 'GetAnnotation', s('c'), 1), 0);
    assert.equal(await byName(s('c'), '@d'), 0);
    assert.equal(await byName(s('c@'), 'd'), 0);
    assert.equal((await g.desc(fx, cd)).flags, 4, 'D3DX_PARAMETER_ANNOTATION');
    const pf = g.out();
    assert.equal(await g.call(fx, 'GetFloat', cd, pf), D3D_OK);
    assert.equal(g.floats(pf, 1)[0], 3);
    const fe = await byName(0, 'f.e');
    assert.ok(fe);
    assert.equal(await byName(s('f'), 'e'), fe);
    assert.equal(await byName(s('f'), '.e'), 0);
    assert.equal(await byName(s('f.'), 'e'), 0);
    const fDesc = await g.desc(fx, await byName(0, 'f'));
    assert.deepEqual([fDesc.cls, fDesc.type, fDesc.members, fDesc.bytes],
        [PC.STRUCT, PT.VOID, 1, 4]);
    const gh = await byName(0, 'g@h[0]');
    assert.ok(gh);
    assert.equal(await g.call(fx, 'GetAnnotationByName', s('g'), s('h[0]')), gh);
    assert.equal(await g.call(fx, 'GetParameterElement', s('g@h'), 0), gh);
    assert.equal(await g.call(fx, 'GetParameterElement', await g.call(fx, 'GetAnnotation',
        s('g'), 0), 0), gh);
    const ikj = await byName(0, 'i@k[0].j');
    assert.ok(ikj);
    assert.equal(await g.call(fx, 'GetAnnotationByName', s('i'), s('k[0].j')), ikj);
    assert.equal(await byName(await g.call(fx, 'GetParameterElement', s('i@k'), 0), 'j'), ikj);
    const tl = await g.call(fx, 'GetAnnotationByName', s('t'), s('l[0].j'));
    assert.ok(tl, 'a technique\'s annotation, under its name');
    assert.equal(await g.call(fx, 'GetFloat', tl, pf), D3D_OK);
    assert.equal(g.floats(pf, 1)[0], 5);
    const pass = await g.call(fx, 'GetPassByName', s('t'), s('p'));
    const pm = await g.call(fx, 'GetAnnotationByName', pass, s('m[0].j'));
    assert.ok(pm, 'a pass\'s');
    assert.equal(await g.call(fx, 'GetFloat', pm, pf), D3D_OK);
    assert.equal(g.floats(pf, 1)[0], 6);
});

test('a parameter is found by its semantic without regard to case', async()=>{
    const g = guest();
    const fx = await g.effect('float4x4 wvp : WorldViewProjection; float x; '
        + 'struct S { float a : ALPHA; float b; } st; technique t { pass p { } }');
    const wvp = await g.handle(fx, 'wvp');
    assert.equal(await g.call(fx, 'GetParameterBySemantic', 0, g.put('worldviewprojection')), wvp);
    assert.equal(await g.call(fx, 'GetParameterBySemantic', 0, g.put('none')), 0);
    assert.equal(await g.call(fx, 'GetParameterBySemantic', 0, 0), await g.handle(fx, 'x'),
        'no semantic finds the first without one');
    assert.equal(await g.call(fx, 'GetParameterBySemantic', await g.handle(fx, 'st'),
        g.put('alpha')), await g.handle(fx, 'st.a'));
    assert.equal((await g.desc(fx, wvp)).semantic, 'WorldViewProjection');
});

test('a handle of one effect names its parameter in that effect, given to another', async()=>{
    const g = guest();
    const source = 'int4 v = {1, 2, 3, 4}; technique t { pass p { } }';
    const one = await g.effect(source);
    const two = await g.effect(source);
    const h1 = await g.handle(one, 'v');
    const h2 = await g.handle(two, 'v');
    assert.notEqual(h1, h2);
    assert.equal(await g.call(two, 'SetValue', h1, g.putInts([28, 29, 30, 31]), 16), D3D_OK);
    const got = g.out(16);
    assert.equal(await g.call(one, 'GetValue', h1, got, 16), D3D_OK);
    assert.deepEqual(g.ints(got, 4), [28, 29, 30, 31]);
    assert.equal(await g.call(two, 'GetValue', h2, got, 16), D3D_OK);
    assert.deepEqual(g.ints(got, 4), [1, 2, 3, 4]);
});

// ---- techniques and passes on the device ------------------------------------------------

/**
 * Two post-processing effects of the kind a renderer builds with a pool: a highlight
 * mask (with and without a glow added) and an eight-tap blur, guarded the way such
 * files guard their HLSL from a C compiler, the one including a file of shared
 * declarations through the program's ID3DXInclude.
 */
const COMMON = `
#ifndef COMMON_FX
#define COMMON_FX
shared float4 Tint = {1, 1, 1, 1};
half Brightness(half3 c)
{
    return dot(c, float3(0.3, 0.59, 0.11));
}
#endif
`;

const MASK = `
#include "common.fx"
#ifndef WIN32
float2 SrcTexelSize;
float HighlightThreshold = 0.5;
float3 OverGlow;
sampler2D SrcMap : register(ps, s0);
sampler2D GlowMap : register(ps, s1);
struct VS_IN { float4 Pos : POSITION; float2 UV : TEXCOORD0; };
struct VS_OUT { float4 Position : POSITION; float2 UV[4] : TEXCOORD0; };
VS_OUT VS_Pass(VS_IN input)
{
    VS_OUT o = (VS_OUT)0;
    o.Position = input.Pos;
    o.UV[0] = + input.UV;
    return o;
}
half Highlights(half3 c)
{
    return smoothstep(HighlightThreshold, 1.0, Brightness(c.rgb));
}
half4 PS_Mask(VS_OUT input) : COLOR
{
    half4 c = tex2D(SrcMap, input.UV[0]);
    c.rgb *= Highlights(c.rgb);
    c.rgb += OverGlow;
    return c;
}
half4 PS_MaskGlow(VS_OUT input) : COLOR
{
    half4 c = tex2D(SrcMap, input.UV[0]);
    c.rgb *= Highlights(c.rgb);
    c.rgb += OverGlow;
    c.rgb += tex2D(GlowMap, input.UV[0]);
    return c * Tint;
}
technique Mask
{
    pass p0
    {
        VertexShader = compile vs_2_0 VS_Pass();
        PixelShader = compile ps_2_0 PS_Mask();
        MinFilter[0] = Linear;
        MagFilter[0] = Linear;
        MipFilter[0] = Point;
        AddressU[0] = Clamp;
        AddressV[0] = Clamp;
    }
}
technique MaskGlow
{
    pass p0
    {
        VertexShader = compile vs_2_0 VS_Pass();
        PixelShader = compile ps_2_0 PS_MaskGlow();
        MinFilter[0] = Linear;
        MagFilter[0] = Linear;
        MipFilter[0] = Point;
        AddressU[0] = Clamp;
        AddressV[0] = Clamp;
    }
}
#endif
`;

const BLUR = `
#ifndef WIN32
float2 TexCoordOffsets[8];
float ConvolutionKernel[8];
sampler2D ColorMap : register(ps, s0);
struct VS_IN { float4 vPos : POSITION; float2 vTex0 : TEXCOORD0; };
struct VS_OUT { float4 vPos : POSITION; float2 vTexCoord[8] : TEXCOORD0; };
VS_OUT VS_Blur8(VS_IN input)
{
    VS_OUT o = (VS_OUT)0;
    o.vPos = input.vPos;
    for (int i = 0; i < 8; i++)
    {
        o.vTexCoord[i] = input.vTex0 + TexCoordOffsets[i];
    }
    return o;
}
half4 PS_Blur8(VS_OUT input) : COLOR
{
    half4 c = 0;
    for (int i = 0; i < 8; i++)
    {
        c += tex2D(ColorMap, input.vTexCoord[i]) * ConvolutionKernel[i];
    }
    return c;
}
technique Blur8
{
    pass p0
    {
        VertexShader = compile vs_2_0 VS_Blur8();
        PixelShader = compile ps_2_0 PS_Blur8();
        MinFilter[0] = Linear;
        MagFilter[0] = Linear;
        MipFilter[0] = Point;
        AddressU[0] = Clamp;
        AddressV[0] = Clamp;
    }
}
#endif
`;

/** D3DSAMP_* and the D3DTEXF_/D3DTADDRESS_ values the passes above set. */
const SAMPLER_STATES = [[0, 6, 2], [0, 5, 2], [0, 7, 1], [0, 1, 3], [0, 2, 3]];

/** The constants of a shader's table, by name: register set, index, count. @param {Uint32Array} tokens */
function tableOf(tokens){
    const block = new Uint8Array(tokens.buffer, tokens.byteOffset + 12, (((tokens[1] >>> 16)
        & 0x7fff) - 1) * 4);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    /** @type {Record<string, { set: number, index: number, count: number }>} */
    const out = {};
    for (let c = 0; c < view.getUint32(12, true); c++)
    {
        const record = view.getUint32(16, true) + c * 20;
        let name = '';
        for (let at = view.getUint32(record, true); view.getUint8(at) !== 0; at++)
        {
            name += String.fromCharCode(view.getUint8(at));
        }
        out[name] = { set: view.getUint16(record + 4, true),
            index: view.getUint16(record + 6, true), count: view.getUint16(record + 8, true) };
    }
    return out;
}

test('a pool of post-processing effects: made, valid, and each pass set on the device', async()=>{
    const g = guest({ files: { 'common.fx': COMMON } });
    const poolOut = g.out();
    assert.equal(await g.fn('D3DXCreateEffectPool', poolOut), D3D_OK);
    const pool = g.u32(poolOut);
    const mask = await g.effect(MASK, { pool, include: true });
    const blur = await g.effect(BLUR, { pool, include: true });
    const blurAgain = await g.effect(BLUR, { pool, include: true });
    assert.deepEqual(g.opened, ['common.fx']);
    assert.deepEqual(g.diverged, []);
    for (const [fx, names] of /** @type {[number, string[]][]} */ ([[mask, ['Mask', 'MaskGlow']],
        [blur, ['Blur8']], [blurAgain, ['Blur8']]]))
    {
        const at = g.out(16);
        await g.call(fx, 'GetDesc', at);
        assert.equal(g.u32(at + 8), names.length);
        for (const name of names)
        {
            const t = await g.call(fx, 'GetTechniqueByName', g.put(name));
            assert.ok(t, name);
            assert.equal(await g.call(fx, 'ValidateTechnique', t), D3D_OK, name);
        }
        const next = g.out();
        assert.equal(await g.call(fx, 'FindNextValidTechnique', 0, next), D3D_OK);
        assert.equal(g.u32(next), await g.call(fx, 'GetTechnique', 0));
    }
    const shaders = g.calls.filter(c=>c.name === 'CreateVertexShader'
        || c.name === 'CreatePixelShader');
    assert.equal(shaders.length, 3 + 2 + 2, 'one vertex shader for both mask techniques');

    // The glow technique: Begin records the technique's states, BeginPass sets them.
    g.calls.length = 0;
    assert.equal(await g.call(mask, 'SetTechnique', g.put('MaskGlow')), D3D_OK);
    assert.equal(await g.call(mask, 'SetFloat', await g.handle(mask, 'HighlightThreshold'),
        new Uint32Array(Float32Array.of(0.25).buffer)[0]), D3D_OK);
    const passes = g.out();
    assert.equal(await g.call(mask, 'Begin', passes, 0), D3D_OK);
    assert.equal(g.u32(passes), 1);
    const recorded = g.calls.splice(0);
    assert.equal(recorded[0].name, 'BeginStateBlock');
    assert.equal(recorded.at(-2).name, 'EndStateBlock');
    assert.deepEqual([recorded.at(-1).on, recorded.at(-1).name], ['block', 'Capture']);
    assert.equal(await g.call(mask, 'BeginPass', 0), D3D_OK);
    const set = g.calls.splice(0);
    const glowPass = /** @type {any} */ (shaders.find(c=>c.name === 'CreatePixelShader'
        && tableOf(g.objects.get(c.shader).tokens).GlowMap));
    const vs = /** @type {any} */ (shaders.find(c=>c.name === 'CreateVertexShader'));
    assert.deepEqual(set.filter(c=>c.name === 'SetVertexShader' || c.name === 'SetPixelShader')
        .map(c=>c.args[0]), [vs.shader, glowPass.shader]);
    assert.deepEqual(set.filter(c=>c.name === 'SetSamplerState').map(c=>c.args), SAMPLER_STATES);
    const table = tableOf(g.objects.get(glowPass.shader).tokens);
    const threshold = set.find(c=>c.name === 'SetPixelShaderConstantF'
        && c.args[0] === table.HighlightThreshold.index);
    assert.equal(threshold?.values[0], 0.25, 'the threshold as the program set it');
    const tint = set.find(c=>c.name === 'SetPixelShaderConstantF'
        && c.args[0] === table.Tint.index);
    assert.deepEqual(tint?.values, [1, 1, 1, 1], 'the shared tint, from its default');
    assert.equal(await g.call(mask, 'BeginPass', 0), D3DERR_INVALIDCALL, 'a pass is begun');
    assert.equal(await g.call(mask, 'EndPass'), D3D_OK);
    assert.equal(await g.call(mask, 'EndPass'), D3DERR_INVALIDCALL);
    assert.equal(await g.call(mask, 'End'), D3D_OK);
    assert.deepEqual(g.calls.splice(0).map(c=>[c.on, c.name, c.block]), [['block', 'Apply',
        recorded.at(-2).block]], 'End puts back what Begin kept');

    // The blur: its kernel and offsets set, then CommitChanges sets only what changed.
    const kernel = [0.05, 0.1, 0.15, 0.2, 0.2, 0.15, 0.1, 0.05];
    const offsets = [-4, -3, -2, -1, 1, 2, 3, 4].flatMap(x=>[x / 256, 0]);
    assert.equal(await g.call(blur, 'SetFloatArray', await g.handle(blur, 'ConvolutionKernel'),
        g.putFloats(kernel), 8), D3D_OK);
    assert.equal(await g.call(blur, 'SetValue', await g.handle(blur, 'TexCoordOffsets'),
        g.putFloats(offsets), 64), D3D_OK);
    assert.equal(await g.call(blur, 'Begin', passes, 1), D3D_OK, 'without saving the state');
    assert.equal(g.calls.length, 0, 'nothing recorded');
    assert.equal(await g.call(blur, 'BeginPass', 0), D3D_OK);
    const blurSet = g.calls.splice(0);
    const blurVs = g.objects.get(blurSet.find(c=>c.name === 'SetVertexShader')?.args[0]);
    const blurPs = g.objects.get(blurSet.find(c=>c.name === 'SetPixelShader')?.args[0]);
    const vsTable = tableOf(blurVs.tokens);
    const offsetsSet = blurSet.find(c=>c.name === 'SetVertexShaderConstantF'
        && c.args[0] === vsTable.TexCoordOffsets.index);
    assert.deepEqual(offsetsSet?.values, offsets.flatMap((x, k)=>(k % 2 ? [x, 0, 0] : [x]))
        .map(Math.fround), 'an element a register');

    // The pixel shader, run on the reference machine with the registers the effect set
    // and a texture whose texel is its coordinate: the weighted sum of eight reads.
    const f = new Array(32 * 4).fill(0);
    for (const c of blurSet.filter(one=>one.name === 'SetPixelShaderConstantF'))
    {
        c.values.forEach((/** @type {number} */ x, /** @type {number} */ k)=>{
            f[c.args[0] * 4 + k] = x;
        });
    }
    const coords = Array.from({ length: 8 }, (_, k)=>[0.5 + offsets[k * 2], 0.25, 0, 0]);
    const result = execute(blurPs.tokens, { constants: { f }, inputs: { t: coords },
        sample: (_, __, coord)=>[coord[0], coord[1], 1, 1] });
    const expected = [0, 1, 2, 3].map(lane=>kernel.reduce((sum, w, k)=>sum + w
        * [coords[k][0], coords[k][1], 1, 1][lane], 0));
    result.outputs.oC0.forEach((x, lane)=>assert.ok(Math.abs(x - expected[lane]) < 1e-5,
        `lane ${lane}: ${x} against ${expected[lane]}`));

    assert.equal(await g.call(blur, 'CommitChanges'), D3D_OK);
    assert.deepEqual(g.calls.splice(0).filter(c=>c.name !== 'SetVertexShader'
        && c.name !== 'SetPixelShader'), [], 'nothing changed, nothing set');
    kernel[0] = 0.5;
    await g.call(blur, 'SetFloatArray', await g.handle(blur, 'ConvolutionKernel'),
        g.putFloats(kernel), 8);
    assert.equal(await g.call(blur, 'CommitChanges'), D3D_OK);
    const committed = g.calls.splice(0).filter(c=>c.name.includes('Constant'));
    assert.deepEqual(committed.map(c=>c.name), ['SetPixelShaderConstantF'],
        'only the kernel, which only the pixel shader reads');
    assert.equal(committed[0].values[0], 0.5);
    await g.call(blur, 'EndPass');
    assert.equal(await g.call(blur, 'End'), D3D_OK);
    assert.deepEqual(g.calls, [], 'nothing to put back');
});

test('shared parameters are one value across a pool; the first effect gives it', async()=>{
    const g = guest();
    const poolOut = g.out();
    await g.fn('D3DXCreateEffectPool', poolOut);
    const pool = g.u32(poolOut);
    const one = await g.effect('shared float4 x = {1, 2, 3, 4}; float4 y = {1, 1, 1, 1}; '
        + 'technique t { pass p { } }', { pool });
    const two = await g.effect('shared float4 x = {9, 9, 9, 9}; float4 y = {2, 2, 2, 2}; '
        + 'shared float z; technique t { pass p { } }', { pool });
    const alone = await g.effect('shared float4 x = {5, 5, 5, 5}; technique t { pass p { } }');
    const v = g.out(16);
    await g.call(two, 'GetVector', await g.handle(two, 'x'), v);
    assert.deepEqual(g.floats(v, 4), [1, 2, 3, 4], 'the first effect\'s default');
    await g.call(two, 'SetVector', await g.handle(two, 'x'), g.putFloats([7, 6, 5, 4]));
    await g.call(one, 'GetVector', await g.handle(one, 'x'), v);
    assert.deepEqual(g.floats(v, 4), [7, 6, 5, 4], 'written through one, read through the other');
    await g.call(alone, 'GetVector', await g.handle(alone, 'x'), v);
    assert.deepEqual(g.floats(v, 4), [5, 5, 5, 5], 'an effect without the pool has its own');
    await g.call(one, 'GetVector', await g.handle(one, 'y'), v);
    assert.deepEqual(g.floats(v, 4), [1, 1, 1, 1], 'what is not shared is not');
    assert.equal((await g.desc(two, await g.handle(two, 'x'))).flags, 1, 'D3DX_PARAMETER_SHARED');
    const got = g.out();
    assert.equal(await g.call(one, 'GetPool', got), D3D_OK);
    assert.equal(g.u32(got), pool);
    assert.equal(await g.call(alone, 'GetPool', got), D3D_OK);
    assert.equal(g.u32(got), 0);
    assert.equal(await g.call(alone, 'GetPool', 0), D3DERR_INVALIDCALL);
    // The pool lives while an effect holds it.
    const { object: poolObject } = /** @type {any} */ (g.published.get(pool));
    assert.equal(poolObject.refCount, 4, 'the program\'s, two effects\' and GetPool\'s');
    assert.equal(await g.call(one, 'Release'), 0);
    assert.equal(poolObject.refCount, 3);
    await g.call(two, 'GetVector', await g.handle(two, 'x'), v);
    assert.deepEqual(g.floats(v, 4), [7, 6, 5, 4], 'the value outlives the effect that gave it');
    assert.equal(await g.fn('D3DXCreateEffectPool', 0), D3DERR_INVALIDCALL);
});

/** States of every kind a pass may assign, with values of every kind. */
const STATES = `
bool blend = true;
float4 fogColor = {1, 0.5, 0, 1};
float4x4 world = {1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1};
float4 constants[2] = {{1, 2, 3, 4}, {5, 6, 7, 8}};
texture tex;
sampler2D smp = sampler_state { Texture = <tex>; MinFilter = Anisotropic; AddressW = Mirror; };
technique t
{
    pass p
    {
        ZEnable = true;
        CullMode = None;
        AlphaBlendEnable = <blend>;
        SrcBlend = SrcAlpha;
        DestBlend = InvSrcAlpha;
        ZFunc = LessEqual;
        FogColor = <fogColor>;
        FogDensity = 0.5;
        ColorWriteEnable = Red | Green | Blue;
        ColorOp[1] = Modulate2x;
        ColorArg1[1] = Texture | Complement;
        Texture[2] = <tex>;
        Sampler[3] = (smp);
        WorldTransform[1] = <world>;
        LightEnable[0] = false;
        LightDiffuse[0] = {1, 0, 0, 1};
        LightRange[0] = 10;
        MaterialPower = 4;
        FVF = 0x142;
        VertexShaderConstantF[4] = <constants>;
        PixelShaderConstantB[1] = true;
        VertexShader = NULL;
    }
}
`;

test('each kind of state goes to its setter, with its value as the device takes it', async()=>{
    const g = guest();
    const fx = await g.effect(STATES);
    assert.deepEqual(g.diverged, []);
    const texture = g.object({ kind: 'texture', pool: 1 });
    await g.call(fx, 'SetTexture', g.put('tex'), texture);
    assert.equal(await g.call(fx, 'Begin', 0, 1), D3D_OK);
    assert.equal(await g.call(fx, 'BeginPass', 0), D3D_OK);
    const f = (/** @type {number} */ x)=>new Uint32Array(Float32Array.of(x).buffer)[0];
    assert.deepEqual(g.calls.map(c=>[c.name, ...(c.values ? [c.args[0], c.values] : c.args)]), [
        ['SetRenderState', 7, 1],
        ['SetRenderState', 22, 1],
        ['SetRenderState', 27, 1],
        ['SetRenderState', 19, 5],
        ['SetRenderState', 20, 6],
        ['SetRenderState', 23, 4],
        ['SetRenderState', 34, 0xffff8000],
        ['SetRenderState', 38, f(0.5)],
        ['SetRenderState', 168, 7],
        ['SetTextureStageState', 1, 1, 5],
        ['SetTextureStageState', 1, 2, 0x12],
        ['SetTexture', 2, texture],
        ['SetTexture', 3, texture],
        ['SetSamplerState', 3, 6, 3],
        ['SetSamplerState', 3, 3, 2],
        ['SetTransform', 257, [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1]],
        ['LightEnable', 0, 0],
        ['SetFVF', 0x142],
        ['SetVertexShaderConstantF', 4, [1, 2, 3, 4, 5, 6, 7, 8]],
        ['SetPixelShaderConstantB', 1, [1]],
        ['SetVertexShader', 0],
        // D3DLIGHT9: the type, then diffuse, specular, ambient, position, direction, range...
        ['SetLight', 0, [0, 1, 0, 0, 1, ...new Array(14).fill(0), 10, 0, 0, 0, 0, 0, 0]],
        // D3DMATERIAL9: four colours, then the power.
        ['SetMaterial', g.calls.find(c=>c.name === 'SetMaterial')?.args[0],
            [...new Array(16).fill(0), 4]],
    ]);
});

test('Begin and the passes refuse what D3DX refuses', async()=>{
    const g = guest();
    const fx = await g.effect('technique a { pass p0 { } pass p1 { } } technique b { pass q { } }');
    assert.equal(await g.call(fx, 'BeginPass', 0), D3DERR_INVALIDCALL, 'not begun');
    assert.equal(await g.call(fx, 'End'), D3D_OK, 'an End without Begin is no error');
    assert.equal(await g.call(fx, 'EndPass'), D3DERR_INVALIDCALL);
    assert.equal(await g.call(fx, 'CommitChanges'), D3D_OK, 'nothing to commit');
    const passes = g.out();
    assert.equal(await g.call(fx, 'Begin', passes, 1), D3D_OK);
    assert.equal(g.u32(passes), 2);
    assert.equal(await g.call(fx, 'BeginPass', 2), D3DERR_INVALIDCALL);
    assert.equal(await g.call(fx, 'BeginPass', 1), D3D_OK);
    await g.call(fx, 'EndPass');
    await g.call(fx, 'End');
    assert.equal(await g.call(fx, 'SetTechnique', g.put('none')), D3DERR_INVALIDCALL);
    const b = await g.call(fx, 'GetTechniqueByName', g.put('b'));
    assert.equal(await g.call(fx, 'SetTechnique', b), D3D_OK);
    assert.equal(await g.call(fx, 'GetCurrentTechnique'), b);
    assert.equal(await g.call(fx, 'GetTechniqueByName', 0), 0);
    const td = g.out(12);
    assert.equal(await g.call(fx, 'GetTechniqueDesc', 0, td), D3D_OK, 'NULL is the first');
    assert.deepEqual([g.text(g.u32(td)), g.u32(td + 4), g.u32(td + 8)], ['a', 2, 0]);
    const pass = await g.call(fx, 'GetPass', g.put('a'), 1);
    const pd = g.out(16);
    assert.equal(await g.call(fx, 'GetPassDesc', pass, pd), D3D_OK);
    assert.equal(g.text(g.u32(pd)), 'p1');
    assert.equal(await g.call(fx, 'GetPassByName', b, g.put('q')), await g.call(fx, 'GetPass',
        b, 0));
    assert.equal(await g.call(fx, 'GetPassDesc', 0, pd), D3DERR_INVALIDCALL);
});

test('a technique whose shader does not compile is not valid, and is passed over', async()=>{
    const g = guest();
    const errorsOut = g.out();
    const source = `
        float4 Bad(float2 uv : TEXCOORD0) : COLOR { return noise(uv); }
        float4 Good() : COLOR { return 1; }
        technique first { pass p { PixelShader = compile ps_2_0 Bad(); } }
        technique second { pass p { PixelShader = compile ps_2_0 Good(); } }
        technique third { pass p { PixelShader = NULL; } }`;
    const effectOut = g.out();
    assert.equal(await g.fn('D3DXCreateEffect', g.device, g.put(source), source.length, 0, 0, 0, 0,
        effectOut, errorsOut), D3D_OK, 'made, with the technique marked');
    const fx = g.u32(effectOut);
    assert.match(g.bufferText(g.u32(errorsOut)), /warning/);
    assert.match(g.diverged.join('\n'), /technique 'first' is not valid/);
    const [first, second, third] = await Promise.all([0, 1, 2].map(i=>g.call(fx, 'GetTechnique',
        i)));
    assert.equal(await g.call(fx, 'ValidateTechnique', first), E_FAIL);
    assert.equal(await g.call(fx, 'ValidateTechnique', second), D3D_OK);
    assert.equal(await g.call(fx, 'ValidateTechnique', 0), D3DERR_INVALIDCALL);
    const next = g.out();
    assert.equal(await g.call(fx, 'FindNextValidTechnique', 0, next), D3D_OK);
    assert.equal(g.u32(next), second);
    assert.equal(await g.call(fx, 'FindNextValidTechnique', second, next), D3D_OK);
    assert.equal(g.u32(next), third);
    assert.equal(await g.call(fx, 'FindNextValidTechnique', third, next), S_FALSE);
    assert.equal(g.u32(next), 0);
});

test('a compile with arguments binds them to the uniform parameters of the entry', async()=>{
    const g = guest();
    const fx = await g.effect(`
        float4 tint = {1, 1, 1, 1};
        float4 PS(uniform float scale, uniform bool flip) : COLOR
        {
            return (flip ? -tint : tint) * scale;
        }
        technique t { pass p { PixelShader = compile ps_2_0 PS(0.25, true); } }`);
    await g.call(fx, 'Begin', 0, 1);
    await g.call(fx, 'BeginPass', 0);
    const ps = g.objects.get(/** @type {any} */ (g.calls.find(c=>c.name === 'SetPixelShader'))
        .args[0]);
    assert.deepEqual(Object.keys(tableOf(ps.tokens)), ['tint'], 'the arguments are no constants');
    const f = new Array(32 * 4).fill(0);
    for (const c of g.calls.filter(one=>one.name === 'SetPixelShaderConstantF'))
    {
        c.values.forEach((/** @type {number} */ x, /** @type {number} */ k)=>{
            f[c.args[0] * 4 + k] = x;
        });
    }
    assert.deepEqual(execute(ps.tokens, { constants: { f } }).outputs.oC0, [-0.25, -0.25, -0.25,
        -0.25]);
});

test('a state manager takes the states instead of the device, and is counted', async()=>{
    const g = guest();
    const fx = await g.effect('float4 c = {1, 2, 3, 4}; float4 PS() : COLOR { return c; } '
        + 'technique t { pass p { CullMode = CW; PixelShader = compile ps_2_0 PS(); } }');
    const got = g.out();
    assert.equal(await g.call(fx, 'GetStateManager', got), D3D_OK);
    assert.equal(g.u32(got), 0);
    assert.equal(await g.call(fx, 'GetStateManager', 0), D3DERR_INVALIDCALL);
    assert.equal(await g.call(fx, 'SetStateManager', g.manager), D3D_OK);
    assert.equal(g.objects.get(g.manager).refs, 2);
    g.calls.length = 0;
    await g.call(fx, 'Begin', 0, 0);
    assert.ok(g.calls.every(c=>c.on !== 'manager'), 'a recording is the device\'s');
    g.calls.length = 0;
    await g.call(fx, 'BeginPass', 0);
    assert.deepEqual(g.calls.map(c=>[c.on, c.name]), [['manager', 'SetRenderState'],
        ['manager', 'SetPixelShader'], ['manager', 'SetPixelShaderConstantF']]);
    await g.call(fx, 'EndPass');
    await g.call(fx, 'End');
    assert.equal(await g.call(fx, 'GetStateManager', got), D3D_OK);
    assert.equal(g.u32(got), g.manager);
    assert.equal(g.objects.get(g.manager).refs, 3, 'the getter adds the caller\'s reference');
    assert.equal(await g.call(fx, 'SetStateManager', 0), D3D_OK);
    assert.equal(g.objects.get(g.manager).refs, 2, 'and letting it go releases the effect\'s');
});

test('a parameter block records values and applies them again', async()=>{
    const g = guest();
    const fx = await g.effect('float a = 1; float4 b; technique t { pass p { } }');
    const a = await g.handle(fx, 'a');
    const b = await g.handle(fx, 'b');
    assert.equal(await g.call(fx, 'EndParameterBlock'), 0, 'none begun');
    assert.equal(await g.call(fx, 'BeginParameterBlock'), D3D_OK);
    assert.equal(await g.call(fx, 'BeginParameterBlock'), D3DERR_INVALIDCALL);
    await g.call(fx, 'SetFloat', a, new Uint32Array(Float32Array.of(5).buffer)[0]);
    await g.call(fx, 'SetVector', b, g.putFloats([1, 2, 3, 4]));
    const block = await g.call(fx, 'EndParameterBlock');
    assert.ok(block);
    await g.call(fx, 'SetFloat', a, 0);
    await g.call(fx, 'SetVector', b, g.putFloats([0, 0, 0, 0]));
    assert.equal(await g.call(fx, 'ApplyParameterBlock', block), D3D_OK);
    const v = g.out(16);
    await g.call(fx, 'GetFloat', a, v);
    assert.equal(g.floats(v, 1)[0], 5);
    await g.call(fx, 'GetVector', b, v);
    assert.deepEqual(g.floats(v, 4), [1, 2, 3, 4]);
    assert.equal(await g.call(fx, 'DeleteParameterBlock', block), D3D_OK);
    assert.equal(await g.call(fx, 'DeleteParameterBlock', block), D3DERR_INVALIDCALL);
    assert.equal(await g.call(fx, 'ApplyParameterBlock', block), D3DERR_INVALIDCALL);
    await g.call(fx, 'BeginParameterBlock');
    assert.equal(await g.call(fx, 'ApplyParameterBlock', await g.call(fx, 'EndParameterBlock')),
        D3DERR_INVALIDCALL, 'an empty block');
});

test('SetRawValue writes bytes into a numeric parameter at an offset', async()=>{
    const g = guest();
    const fx = await g.effect('float4 v = {1, 2, 3, 4}; texture t; technique t0 { pass p { } }');
    const v = await g.handle(fx, 'v');
    assert.equal(await g.call(fx, 'SetRawValue', v, g.putFloats([8, 9]), 8, 8), D3D_OK);
    const got = g.out(16);
    await g.call(fx, 'GetVector', v, got);
    assert.deepEqual(g.floats(got, 4), [1, 2, 8, 9]);
    assert.equal(await g.call(fx, 'SetRawValue', v, g.putFloats([8, 9]), 12, 8),
        D3DERR_INVALIDCALL, 'past its end');
    assert.equal(await g.call(fx, 'SetRawValue', await g.handle(fx, 't'), g.putFloats([1]), 0, 4),
        D3DERR_INVALIDCALL, 'an object');
});

test('CloneEffect makes the effect again on a device, with the values it holds', async()=>{
    const g = guest();
    const fx = await g.effect('float4 c = {1, 2, 3, 4}; string s = "a"; '
        + 'float4 PS() : COLOR { return c; } '
        + 'technique t0 { pass p { } } '
        + 'technique t1 { pass p { PixelShader = compile ps_2_0 PS(); } }');
    await g.call(fx, 'SetVector', await g.handle(fx, 'c'), g.putFloats([5, 6, 7, 8]));
    await g.call(fx, 'SetString', await g.handle(fx, 's'), g.put('b'));
    await g.call(fx, 'SetTechnique', g.put('t1'));
    const out = g.out();
    const other = g.object({ kind: 'device' });
    assert.equal(await g.call(fx, 'CloneEffect', other, out), D3D_OK);
    const copy = g.u32(out);
    assert.notEqual(copy, fx);
    const v = g.out(16);
    await g.call(copy, 'GetVector', await g.handle(copy, 'c'), v);
    assert.deepEqual(g.floats(v, 4), [5, 6, 7, 8]);
    await g.call(copy, 'GetString', await g.handle(copy, 's'), v);
    assert.equal(g.text(g.u32(v)), 'b');
    assert.equal(await g.call(copy, 'GetCurrentTechnique'), await g.call(copy, 'GetTechnique', 1));
    const made = g.calls.filter(c=>c.name === 'CreatePixelShader');
    assert.deepEqual(made.map(c=>c.on), ['device', 'device']);
    await g.call(copy, 'GetDevice', v);
    assert.equal(g.u32(v), other, 'on the other device');
    assert.equal(g.objects.get(other).refs, 2, 'GetDevice adds the caller\'s reference');
    assert.equal(await g.call(fx, 'CloneEffect', 0, out), D3DERR_INVALIDCALL);
    const fixed = await g.effect('technique t { pass p { } }', { flags: 1 << 11 });
    assert.equal(await g.call(fixed, 'CloneEffect', other, out), D3DERR_INVALIDCALL,
        'D3DXFX_NOT_CLONEABLE');
});

test('OnLostDevice lets go of default-pool textures and the state blocks it made', async()=>{
    const g = guest();
    const fx = await g.effect('texture a; texture b; technique t { pass p { CullMode = CW; } }');
    const rt = g.object({ kind: 'texture', pool: 0 });
    const managed = g.object({ kind: 'texture', pool: 1 });
    await g.call(fx, 'SetTexture', g.put('a'), rt);
    await g.call(fx, 'SetTexture', g.put('b'), managed);
    await g.call(fx, 'Begin', 0, 0);
    await g.call(fx, 'End');
    const block = g.calls.find(c=>c.name === 'EndStateBlock')?.block;
    g.calls.length = 0;
    assert.equal(await g.call(fx, 'OnLostDevice'), D3D_OK);
    const got = g.out();
    await g.call(fx, 'GetTexture', g.put('a'), got);
    assert.equal(g.u32(got), 0, 'the render target is gone');
    await g.call(fx, 'GetTexture', g.put('b'), got);
    assert.equal(g.u32(got), managed, 'the managed texture stays');
    assert.equal(g.objects.get(block).refs, 0, 'the state block is released');
    assert.equal(await g.call(fx, 'OnResetDevice'), D3D_OK);
    g.calls.length = 0;
    await g.call(fx, 'Begin', 0, 0);
    assert.equal(g.calls[0].name, 'BeginStateBlock', 'and recorded again');
});

test('IsParameterUsed: named by a state, read by a shader, or under a sampler one reads', async()=>{
    const g = guest();
    const fx = await g.effect(`
        float unused; bool blend; float4 c; texture tex;
        sampler2D s = sampler_state { Texture = <tex>; };
        float4 PS(float2 uv : TEXCOORD0) : COLOR { return tex2D(s, uv) * c; }
        technique t0 { pass p { AlphaBlendEnable = <blend>; } }
        technique t1 { pass p { PixelShader = compile ps_2_0 PS(); } }`);
    const used = async(/** @type {string} */ p, /** @type {string} */ t)=>g.call(fx,
        'IsParameterUsed', g.put(p), g.put(t));
    assert.deepEqual(await Promise.all([['blend', 't0'], ['blend', 't1'], ['c', 't1'],
        ['tex', 't1'], ['s', 't1'], ['unused', 't0'], ['c', 't0']].map(([p, t])=>used(p, t))),
    [1, 0, 1, 1, 1, 0, 0]);
});

test('GetPassDesc hands back the bytecode of the pass\'s shaders', async()=>{
    const g = guest();
    const fx = await g.effect('float4 VS(float4 p : POSITION) : POSITION { return p; } '
        + 'technique t { pass p { VertexShader = compile vs_2_0 VS(); } }');
    const pd = g.out(16);
    assert.equal(await g.call(fx, 'GetPassDesc', await g.call(fx, 'GetPass', g.put('t'), 0), pd),
        D3D_OK);
    const vs = g.objects.get(/** @type {any} */ (g.calls.find(c=>c.name === 'CreateVertexShader'))
        .shader);
    assert.deepEqual(g.ints(g.u32(pd + 8), vs.tokens.length).map(x=>x >>> 0), [...vs.tokens]);
    assert.equal(g.u32(pd + 12), 0, 'no pixel shader');
});

// ---- the effect compiler --------------------------------------------------------------

test('the effect compiler lists functions, techniques and annotations', async()=>{
    const g = guest();
    const source = 'float4 main() : COLOR { return 0; }\n'
        + 'float4 func2() : COLOR { return 0; }\n'
        + 'float4 func() : COLOR { return 0; }\n'
        + 'technique t0 < int a = 1; > { pass p0 < float b = 2; float c = 3; > {} }';
    const out = g.out();
    assert.equal(await g.fn('D3DXCreateEffectCompiler', 0, 0, 0, 0, 0, out, 0), D3DERR_INVALIDCALL);
    assert.equal(await g.fn('D3DXCreateEffectCompiler', g.put(source), source.length, 0, 0, 0, 0,
        0), D3DERR_INVALIDCALL, 'nowhere to put it');
    assert.equal(await g.fn('D3DXCreateEffectCompiler', g.put(source), 0, 0, 0, 0, out, 0), D3D_OK,
        'an empty source is an empty effect');
    assert.equal(await g.fn('D3DXCreateEffectCompiler', g.put(source), source.length, 0, 0, 0, out,
        0), D3D_OK);
    const compiler = g.u32(out);
    const d = g.out(16);
    assert.equal(await g.call(compiler, 'GetDesc', d), D3D_OK);
    assert.deepEqual([g.u32(d), g.u32(d + 4), g.u32(d + 8), g.u32(d + 12)], [0, 0, 1, 3],
        'no creator, no parameters, a technique, three functions');
    const fd = g.out(8);
    for (const [index, name] of ['main', 'func2', 'func'].entries())
    {
        const h = await g.call(compiler, 'GetFunction', index);
        assert.equal(await g.call(compiler, 'GetFunctionDesc', h, fd), D3D_OK);
        assert.deepEqual([g.text(g.u32(fd)), g.u32(fd + 4)], [name, 0]);
    }
    assert.equal(await g.call(compiler, 'GetFunction', 3), 0);
    const t = await g.call(compiler, 'GetTechnique', 0);
    const td = g.out(12);
    await g.call(compiler, 'GetTechniqueDesc', t, td);
    assert.deepEqual([g.text(g.u32(td)), g.u32(td + 4), g.u32(td + 8)], ['t0', 1, 1]);
    const a = await g.call(compiler, 'GetAnnotation', t, 0);
    const ad = await g.desc(compiler, a);
    assert.deepEqual([ad.name, ad.type, ad.flags], ['a', PT.INT, 4]);
    assert.equal(await g.call(compiler, 'SetLiteral', a, 1), D3DERR_INVALIDCALL);
    const pass = await g.call(compiler, 'GetPass', t, 0);
    const pd = g.out(16);
    await g.call(compiler, 'GetPassDesc', pass, pd);
    assert.deepEqual([g.text(g.u32(pd)), g.u32(pd + 4)], ['p0', 2]);
});

test('CompileEffect hands back what D3DXCreateEffect reads again, includes and all', async()=>{
    const g = guest({ files: { 'common.fx': COMMON } });
    const out = g.out();
    const errors = g.out();
    assert.equal(await g.fn('D3DXCreateEffectCompiler', g.put(MASK), MASK.length, 0, g.include, 0,
        out, errors), D3D_OK);
    const compiler = g.u32(out);
    const literal = await g.call(compiler, 'GetParameterByName', 0, g.put('OverGlow'));
    assert.equal(await g.call(compiler, 'SetLiteral', literal, 1), D3D_OK);
    const flag = g.out();
    assert.equal(await g.call(compiler, 'GetLiteral', literal, flag), D3D_OK);
    assert.equal(g.u32(flag), 1);
    const compiled = g.out();
    assert.equal(await g.call(compiler, 'CompileEffect', 0, compiled, errors), D3D_OK);
    const bytes = g.bufferBytes(g.u32(compiled));
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'BTFX');
    assert.match(g.diverged.join('\n'), /CompileEffect: the compiled effect is this layer's own/);
    // Made again without the include: the container has the file.
    const data = g.heap.allocate(bytes.length);
    g.memory.set(bytes, data);
    const effectOut = g.out();
    assert.equal(await g.fn('D3DXCreateEffect', g.device, data, bytes.length, 0, 0, 6, 0,
        effectOut, 0), D3D_OK);
    const fx = g.u32(effectOut);
    assert.equal(await g.call(fx, 'ValidateTechnique', g.put('MaskGlow')), D3D_OK);
    assert.deepEqual(g.opened, ['common.fx'], 'the include was asked once, by the compiler');
    // A function compiled on its own, with its constant table.
    const shader = g.out();
    const table = g.out();
    assert.equal(await g.call(compiler, 'CompileShader', g.put('PS_Mask'), g.put('ps_2_0'), 0,
        shader, errors, table), D3D_OK);
    assert.equal(g.bufferBytes(g.u32(shader))[3], 0xff, 'a pixel shader\'s version token');
    assert.ok(g.u32(table));
    assert.equal(await g.call(compiler, 'CompileShader', g.put('nothing'), g.put('ps_2_0'), 0,
        shader, errors, table), D3DERR_INVALIDCALL);
});

test('the FromFile functions read through the host, and say so when there is none', async()=>{
    const g = guest();
    const effectOut = g.out();
    assert.equal(await g.fn('D3DXCreateEffectFromFileA', g.device, g.put('a.fx'), 0, 0, 0, 0,
        effectOut, 0), 0x88760b59, 'D3DXERR_INVALIDDATA');
    assert.match(g.diverged.join('\n'), /no file reader/);
});

// ---- the model on its own -------------------------------------------------------------

test('the model of an effect: its states resolved, its shaders compiled once each', async()=>{
    const { model, messages } = await buildEffect(MASK, { include: name=>(name === 'common.fx'
        ? COMMON : null) });
    assert.ok(model, messages);
    assert.equal(messages.includes('error'), false);
    assert.deepEqual(model.parameters.map(p=>p.name), ['Tint', 'SrcTexelSize', 'HighlightThreshold',
        'OverGlow', 'SrcMap', 'GlowMap']);
    assert.deepEqual(model.techniques.map(t=>t.passes[0].states.map(s=>[s.kind, s.op, s.index])),
        [0, 1].map(()=>[['vs', 0, -1], ['ps', 0, -1], ['sampler', 6, 0], ['sampler', 5, 0],
            ['sampler', 7, 0], ['sampler', 1, 0], ['sampler', 2, 0]]));
    assert.equal(model.shaders.length, 3);
    assert.ok(model.shaders.every(s=>s.tokens), 'every shader compiled');
    const unknown = await buildEffect('technique t { pass p { NoSuchState = 1; ZFunc = foo(); } }');
    assert.match(unknown.messages, /'NoSuchState': this state is not applied/);
    assert.match(unknown.messages, /'ZFunc': the value is not a literal/);
    assert.deepEqual(unknown.model?.techniques[0].passes[0].states, []);
    const assembly = await buildEffect('technique t { pass p { VertexShader = asm { vs_1_1\n'
        + 'dcl_position v0\nmov oPos, v0 }; } } technique u { pass p { } }');
    assert.equal(assembly.messages, '');
    assert.deepEqual(assembly.model?.techniques.map(t=>techniqueCompiles(
        /** @type {any} */ (assembly.model), t)), [true, true]);
    assert.deepEqual(assembly.model?.shaders.map(s=>[s.profile, s.pixel]), [['vs_1_1', false]]);
    assert.deepEqual(assembly.model?.shaders[0].tokens,
        assembleShader('vs_1_1\ndcl_position v0\nmov oPos, v0').tokens);
});

test('an asm block is assembled where it stands, in a pass or in a parameter', async()=>{
    // Written as the period's effects write it: the version with dots, numbers run
    // together with commas, a trailing space.
    const text = 'ps.1.1\ndef c0,1,1,1,0.8 \ntex t0 \nmul r0, t0, c0\n';
    const inPass = await buildEffect(`technique t { pass p { PixelShader = asm {\n${text}}; } }`);
    assert.equal(inPass.messages, '');
    assert.deepEqual(inPass.model?.shaders[0].tokens, assembleShader(text).tokens);
    assert.equal(inPass.model?.shaders[0].profile, 'ps_1_1');
    const named = await buildEffect('PixelShader p = asm { ps_1_1\ndef c0, 1, 0, 0, 0.5\n'
        + 'mov r0, c0 };\ntechnique t { pass q { PixelShader = (p); } }');
    assert.equal(named.messages, '');
    assert.deepEqual(named.model?.techniques.map(t=>techniqueCompiles(
        /** @type {any} */ (named.model), t)), [true]);
    // Two blocks of different text are two shaders, the same text one.
    const two = await buildEffect('technique t { pass a { PixelShader = asm { ps_1_1\n'
        + 'mov r0, v0 }; } pass b { PixelShader = asm { ps_1_1\nmov r0, v1 }; }'
        + ' pass c { PixelShader = asm { ps_1_1\nmov r0, v0 }; } }');
    assert.equal(two.model?.shaders.length, 2);
    // One that does not assemble leaves its technique invalid and says why.
    const wrong = await buildEffect('technique t { pass p { PixelShader = asm { ps_2_0\n'
        + 'nosuch r0 }; } } technique u { pass p { } }');
    assert.match(wrong.messages, /asm line 2: warning X5000: unknown instruction "nosuch"/);
    assert.deepEqual(wrong.model?.techniques.map(t=>techniqueCompiles(
        /** @type {any} */ (wrong.model), t)), [false, true]);
});
