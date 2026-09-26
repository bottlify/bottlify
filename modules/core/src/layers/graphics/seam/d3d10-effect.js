/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 10 effect framework's interfaces, as a program calls them.
 *
 * ID3D10Effect counts references; its techniques, passes, variables and
 * types derive from no interface, so their tables start with their own first
 * method (descriptors marked `bare`) and are given back through the bridge
 * with the effect's last Release, as the runtime frees them with it. A
 * variable is published as the interface its type makes it, which extends
 * ID3D10EffectVariable, so one pointer serves both.
 *
 * Every name, string, bytecode and signature an effect hands out points
 * into a copy of its image -- the unstructured block, then its shaders'
 * input signatures -- kept in guest memory for the effect's life; the
 * runtime's own strings ("$Anonymous", "cbuffer") are constants of the
 * process.
 */

import { S_OK, IID } from '../d3d10/constants.js';
import { parseEffect } from '../d3d10/effect.js';
import { INVALID, PASS_STATE, VARIABLE_KIND, createEffect } from '../d3d10/effect-object.js';
import { STATE_BLOCK_MASK_SIZE } from '../d3d10/stateblock.js';
import { describe as describeSlots } from './vtables.js';

/** D3DERR_INVALIDCALL, which effect creation answers for a missing device. */
const D3DERR_INVALIDCALL = 0x8876086c | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_FAIL = 0x80004005 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

export const ID3D10EFFECT_SLOTS = /** @type {[string, number][]} */ ([
    ['IsValid', 0], ['IsPool', 0], ['GetDevice', 1], ['GetDesc', 1],
    ['GetConstantBufferByIndex', 1], ['GetConstantBufferByName', 1], ['GetVariableByIndex', 1],
    ['GetVariableByName', 1], ['GetVariableBySemantic', 1], ['GetTechniqueByIndex', 1],
    ['GetTechniqueByName', 1], ['Optimize', 0], ['IsOptimized', 0],
]);

export const ID3D10EFFECTTECHNIQUE_SLOTS = /** @type {[string, number][]} */ ([
    ['IsValid', 0], ['GetDesc', 1], ['GetAnnotationByIndex', 1], ['GetAnnotationByName', 1],
    ['GetPassByIndex', 1], ['GetPassByName', 1], ['ComputeStateBlockMask', 1],
]);

export const ID3D10EFFECTPASS_SLOTS = /** @type {[string, number][]} */ ([
    ['IsValid', 0], ['GetDesc', 1], ['GetVertexShaderDesc', 1], ['GetGeometryShaderDesc', 1],
    ['GetPixelShaderDesc', 1], ['GetAnnotationByIndex', 1], ['GetAnnotationByName', 1],
    ['Apply', 1], ['ComputeStateBlockMask', 1],
]);

export const ID3D10EFFECTTYPE_SLOTS = /** @type {[string, number][]} */ ([
    ['IsValid', 0], ['GetDesc', 1], ['GetMemberTypeByIndex', 1], ['GetMemberTypeByName', 1],
    ['GetMemberTypeBySemantic', 1], ['GetMemberName', 1], ['GetMemberSemantic', 1],
]);

export const ID3D10EFFECTVARIABLE_SLOTS = /** @type {[string, number][]} */ ([
    ['IsValid', 0], ['GetType', 0], ['GetDesc', 1], ['GetAnnotationByIndex', 1],
    ['GetAnnotationByName', 1], ['GetMemberByIndex', 1], ['GetMemberByName', 1],
    ['GetMemberBySemantic', 1], ['GetElement', 1], ['GetParentConstantBuffer', 0],
    ['AsScalar', 0], ['AsVector', 0], ['AsMatrix', 0], ['AsString', 0], ['AsShaderResource', 0],
    ['AsRenderTargetView', 0], ['AsDepthStencilView', 0], ['AsConstantBuffer', 0],
    ['AsShader', 0], ['AsBlend', 0], ['AsDepthStencil', 0], ['AsRasterizer', 0],
    ['AsSampler', 0], ['SetRawValue', 3], ['GetRawValue', 3],
]);

/**
 * Each kind's interface: its id and the methods it adds after
 * ID3D10EffectVariable's.
 *
 * @type {Readonly<Record<string, { iid: string, slots: [string, number][] }>>}
 */
export const EFFECT_VARIABLE_INTERFACES = Object.freeze({
    [VARIABLE_KIND.VARIABLE]: { iid: IID.ID3D10EffectVariable, slots: [] },
    [VARIABLE_KIND.CONSTANT_BUFFER]: { iid: IID.ID3D10EffectConstantBuffer, slots: [
        ['SetConstantBuffer', 1], ['GetConstantBuffer', 1], ['SetTextureBuffer', 1],
        ['GetTextureBuffer', 1]] },
    [VARIABLE_KIND.SCALAR]: { iid: IID.ID3D10EffectScalarVariable, slots: [
        ['SetFloat', 1], ['GetFloat', 1], ['SetFloatArray', 3], ['GetFloatArray', 3],
        ['SetInt', 1], ['GetInt', 1], ['SetIntArray', 3], ['GetIntArray', 3], ['SetBool', 1],
        ['GetBool', 1], ['SetBoolArray', 3], ['GetBoolArray', 3]] },
    [VARIABLE_KIND.VECTOR]: { iid: IID.ID3D10EffectVectorVariable, slots: [
        ['SetBoolVector', 1], ['SetIntVector', 1], ['SetFloatVector', 1], ['GetBoolVector', 1],
        ['GetIntVector', 1], ['GetFloatVector', 1], ['SetBoolVectorArray', 3],
        ['SetIntVectorArray', 3], ['SetFloatVectorArray', 3], ['GetBoolVectorArray', 3],
        ['GetIntVectorArray', 3], ['GetFloatVectorArray', 3]] },
    [VARIABLE_KIND.MATRIX]: { iid: IID.ID3D10EffectMatrixVariable, slots: [
        ['SetMatrix', 1], ['GetMatrix', 1], ['SetMatrixArray', 3], ['GetMatrixArray', 3],
        ['SetMatrixTranspose', 1], ['GetMatrixTranspose', 1], ['SetMatrixTransposeArray', 3],
        ['GetMatrixTransposeArray', 3]] },
    [VARIABLE_KIND.STRING]: { iid: IID.ID3D10EffectStringVariable, slots: [
        ['GetString', 1], ['GetStringArray', 3]] },
    [VARIABLE_KIND.SHADER_RESOURCE]: { iid: IID.ID3D10EffectShaderResourceVariable, slots: [
        ['SetResource', 1], ['GetResource', 1], ['SetResourceArray', 3],
        ['GetResourceArray', 3]] },
    [VARIABLE_KIND.RENDER_TARGET_VIEW]: { iid: IID.ID3D10EffectRenderTargetViewVariable,
        slots: [['SetRenderTarget', 1], ['GetRenderTarget', 1], ['SetRenderTargetArray', 3],
            ['GetRenderTargetArray', 3]] },
    [VARIABLE_KIND.DEPTH_STENCIL_VIEW]: { iid: IID.ID3D10EffectDepthStencilViewVariable,
        slots: [['SetDepthStencil', 1], ['GetDepthStencil', 1], ['SetDepthStencilArray', 3],
            ['GetDepthStencilArray', 3]] },
    [VARIABLE_KIND.SHADER]: { iid: IID.ID3D10EffectShaderVariable, slots: [
        ['GetShaderDesc', 2], ['GetVertexShader', 2], ['GetGeometryShader', 2],
        ['GetPixelShader', 2], ['GetInputSignatureElementDesc', 3],
        ['GetOutputSignatureElementDesc', 3]] },
    [VARIABLE_KIND.BLEND]: { iid: IID.ID3D10EffectBlendVariable, slots: [
        ['GetBlendState', 2], ['GetBackingStore', 2]] },
    [VARIABLE_KIND.DEPTH_STENCIL]: { iid: IID.ID3D10EffectDepthStencilVariable, slots: [
        ['GetDepthStencilState', 2], ['GetBackingStore', 2]] },
    [VARIABLE_KIND.RASTERIZER]: { iid: IID.ID3D10EffectRasterizerVariable, slots: [
        ['GetRasterizerState', 2], ['GetBackingStore', 2]] },
    [VARIABLE_KIND.SAMPLER]: { iid: IID.ID3D10EffectSamplerVariable, slots: [
        ['GetSampler', 2], ['GetBackingStore', 2]] },
});

/** Which As* asks for which kind. */
const AS = Object.freeze({
    AsScalar: VARIABLE_KIND.SCALAR, AsVector: VARIABLE_KIND.VECTOR,
    AsMatrix: VARIABLE_KIND.MATRIX, AsString: VARIABLE_KIND.STRING,
    AsShaderResource: VARIABLE_KIND.SHADER_RESOURCE,
    AsRenderTargetView: VARIABLE_KIND.RENDER_TARGET_VIEW,
    AsDepthStencilView: VARIABLE_KIND.DEPTH_STENCIL_VIEW,
    AsConstantBuffer: VARIABLE_KIND.CONSTANT_BUFFER, AsShader: VARIABLE_KIND.SHADER,
    AsBlend: VARIABLE_KIND.BLEND, AsDepthStencil: VARIABLE_KIND.DEPTH_STENCIL,
    AsRasterizer: VARIABLE_KIND.RASTERIZER, AsSampler: VARIABLE_KIND.SAMPLER,
});

/**
 * @typedef {Object} EffectSeamContext
 * @property {any} publisher
 * @property {ReturnType<typeof import('./structs.js').createFields>} fields
 * @property {any} memory                 readMemory/writeMemory.
 * @property {((bytes: number) => number) | undefined} allocate
 * @property {((address: number) => void) | undefined} free
 * @property {(detail: string) => void} report
 * @property {(text: string) => number} constantString
 * @property {(address: number) => string} readCString
 * @property {(object: any, interfaces: any[], id: string, out: number) => number} handBack
 * @property {(address: number, objects: any[], interfaces: any[], id: string) => void}
 *     writeObjects  Objects that already carry the caller's reference, as pointers.
 * @property {() => any[]} deviceInterfaces
 * @property {Record<string, [any[], string]>} children  The device's interfaces and
 *     interface id for each kind of object an effect hands out: buffer,
 *     shaderResourceView, renderTargetView, depthStencilView, vertex, pixel,
 *     geometry, blend, depthStencil, rasterizer and sampler.
 * @property {Record<string, (desc: any, out: number) => void>} writeStateDesc  Each
 *     state block's description, by variable kind, as its state object writes it.
 */

/**
 * @param {EffectSeamContext} context
 */
export function createEffectSeam(context){
    const { publisher, fields, memory, allocate, free, report, constantString, readCString,
        handBack, writeObjects, children, writeStateDesc } = context;

    /**
     * @param {string} id
     * @param {[string, number][]} slots
     * @param {Record<string, (target: any, args: number[]) => number | void>} implemented
     * @param {boolean} [bare]
     */
    const describe = (id, slots, implemented, bare = true)=>({
        ...describeSlots(id, slots,
            /** @type {Record<string, (target: any, args: number[]) => number>} */ (implemented)),
        bare,
    });

    /**
     * Where each effect's unstructured block sits in guest memory.
     *
     * @type {WeakMap<any, number>}
     */
    const blocks = new WeakMap();

    /**
     * A name or string an object hands out, as a guest pointer.
     *
     * @param {any} owner  The effect whose block an offset is into.
     * @param {{ at: number } | { text: string } | null} name
     */
    const pointerOf = (owner, name)=>{
        if (!name)
        {
            return 0;
        }
        if ('text' in name)
        {
            return constantString(name.text);
        }
        return ((blocks.get(owner) ?? 0) + name.at) >>> 0;
    };

    /** A name the program passed, or null for a null pointer. @param {number} address */
    const nameArgument = address=>((address >>> 0) === 0 ? null : readCString(address >>> 0));

    /** @param {number} value */
    const bool = value=>(value ? 1 : 0);

    /**
     * Writes a description's fields in order, pointers through `pointerOf`.
     *
     * @param {any} object
     * @param {number} out
     * @param {[string, 'u32' | 'pointer' | 'f32' | 'f32x4'][]} layout
     */
    const writeDesc = (object, out, layout)=>{
        /** @type {{ desc?: Record<string, any> }} */
        const held = {};
        const hr = object.GetDesc((out >>> 0) === 0 ? null : held);
        if (hr !== S_OK || !held.desc)
        {
            return hr;
        }
        const desc = held.desc;
        let at = out >>> 0;
        for (const [field, kind] of layout)
        {
            if (kind === 'pointer')
            {
                fields.writeU32(at, pointerOf(object.owner, desc[field]));
            }
            else if (kind === 'f32x4')
            {
                for (let index = 0; index < 4; index++)
                {
                    fields.writeF32(at + index * 4, desc[field][index]);
                }
                at += 12;
            }
            else
            {
                fields.writeU32(at, (desc[field] ?? 0) >>> 0);
            }
            at += 4;
        }
        return hr;
    };

    // --- publishing ---

    /** @type {Map<string, any[]>} */
    const variableInterfaces = new Map();
    /** @param {string} kind */
    const interfacesForKind = kind=>{
        let interfaces = variableInterfaces.get(kind);
        if (!interfaces)
        {
            const { iid, slots } = EFFECT_VARIABLE_INTERFACES[kind];
            interfaces = [describe(iid, [...ID3D10EFFECTVARIABLE_SLOTS, ...slots],
                { ...variableMethods, ...(kindMethods[kind] ?? {}) })];
            variableInterfaces.set(kind, interfaces);
        }
        return interfaces;
    };
    /** @param {any} variable @returns {number} */
    const publishVariable = variable=>publisher.publish(variable, interfacesForKind(variable.kind),
        EFFECT_VARIABLE_INTERFACES[variable.kind].iid);
    /** @param {any} type @returns {number} */
    const publishType = type=>publisher.publish(type, typeInterfaces, IID.ID3D10EffectType);
    /** @param {any} pass @returns {number} */
    const publishPass = pass=>publisher.publish(pass, passInterfaces, IID.ID3D10EffectPass);
    /** @param {any} technique @returns {number} */
    const publishTechnique = technique=>publisher.publish(technique, techniqueInterfaces,
        IID.ID3D10EffectTechnique);

    // --- types ---

    const typeInterfaces = [describe(IID.ID3D10EffectType, ID3D10EFFECTTYPE_SLOTS, {
        /** @param {any} type */
        IsValid: type=>bool(type.IsValid()),
        /** @param {any} type @param {number[]} args */
        GetDesc: (type, [out])=>writeDesc(type, out, [['TypeName', 'pointer'],
            ['Class', 'u32'], ['Type', 'u32'], ['Elements', 'u32'], ['Members', 'u32'],
            ['Rows', 'u32'], ['Columns', 'u32'], ['PackedSize', 'u32'], ['UnpackedSize', 'u32'],
            ['Stride', 'u32']]),
        /** @param {any} type @param {number[]} args */
        GetMemberTypeByIndex: (type, [index])=>publishType(type.GetMemberTypeByIndex(index >>> 0)),
        /** @param {any} type @param {number[]} args */
        GetMemberTypeByName: (type, [name])=>
            publishType(type.GetMemberTypeByName(nameArgument(name))),
        /** @param {any} type @param {number[]} args */
        GetMemberTypeBySemantic: (type, [name])=>
            publishType(type.GetMemberTypeBySemantic(nameArgument(name))),
        /** @param {any} type @param {number[]} args */
        GetMemberName: (type, [index])=>pointerOf(type.owner, type.GetMemberName(index >>> 0)),
        /** @param {any} type @param {number[]} args */
        GetMemberSemantic: (type, [index])=>
            pointerOf(type.owner, type.GetMemberSemantic(index >>> 0)),
    })];

    // --- variables ---

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const variableMethods = {
        /** @param {any} variable */
        IsValid: variable=>bool(variable.IsValid()),
        /** @param {any} variable */
        GetType: variable=>publishType(variable.GetType()),
        /** @param {any} variable @param {number[]} args */
        GetDesc: (variable, [out])=>writeDesc(variable, out, [['Name', 'pointer'],
            ['Semantic', 'pointer'], ['Flags', 'u32'], ['Annotations', 'u32'],
            ['BufferOffset', 'u32'], ['ExplicitBindPoint', 'u32']]),
        /** @param {any} variable @param {number[]} args */
        GetAnnotationByIndex: (variable, [index])=>
            publishVariable(variable.GetAnnotationByIndex(index >>> 0)),
        /** @param {any} variable @param {number[]} args */
        GetAnnotationByName: (variable, [name])=>
            publishVariable(variable.GetAnnotationByName(nameArgument(name))),
        /** @param {any} variable @param {number[]} args */
        GetMemberByIndex: (variable, [index])=>
            publishVariable(variable.GetMemberByIndex(index >>> 0)),
        /** @param {any} variable @param {number[]} args */
        GetMemberByName: (variable, [name])=>
            publishVariable(variable.GetMemberByName(nameArgument(name))),
        /** @param {any} variable @param {number[]} args */
        GetMemberBySemantic: (variable, [name])=>
            publishVariable(variable.GetMemberBySemantic(nameArgument(name))),
        /** @param {any} variable @param {number[]} args */
        GetElement: (variable, [index])=>publishVariable(variable.GetElement(index >>> 0)),
        /** @param {any} variable */
        GetParentConstantBuffer: variable=>publishVariable(variable.GetParentConstantBuffer()),
        ...Object.fromEntries(Object.entries(AS).map(([method, kind])=>[method,
            (/** @type {any} */ variable)=>publishVariable(variable.As(kind))])),
        /** @param {any} variable @param {number[]} args */
        SetRawValue: (variable, [data, offset, count])=>{
            if (variable.invalid)
            {
                return E_FAIL;
            }
            if ((data >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return variable.SetRawValue(memory.readMemory(data >>> 0, count >>> 0), offset >>> 0);
        },
        /** @param {any} variable @param {number[]} args */
        GetRawValue: (variable, [data, offset, count])=>{
            const bytes = variable.invalid ? null : variable.GetRawValue(offset >>> 0, count >>> 0);
            if (!bytes)
            {
                return E_FAIL;
            }
            if ((data >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            memory.writeMemory(data >>> 0, bytes);
            return S_OK;
        },
    };

    // --- each kind's typed views ---

    /**
     * @typedef {(variable: any, args: number[]) => number} KindMethod
     */

    /**
     * A method only a variable of the kind answers; the invalid one of the
     * kind fails, and leaves the program's out pointer as it was.
     *
     * @param {KindMethod} method
     * @returns {KindMethod}
     */
    const valid = method=>(variable, args)=>(variable.invalid ? E_FAIL : method(variable, args));

    /** @param {number} at @param {number} count */
    const readDwords = (at, count)=>Array.from({ length: count },
        (_, index)=>fields.readU32((at >>> 0) + index * 4));

    /** @param {number} pointer */
    const objectOf = pointer=>((pointer >>> 0) === 0
        ? null
        : publisher.objectAt(pointer) ?? null);

    /** @type {Readonly<Record<string, string>>} */
    const GIVEN_NAME = Object.freeze({ float: 'Float', int: 'Int', bool: 'Bool' });

    /** A dword a program passed, as the number its type reads it as. @param {string} given */
    const reader = given=>(given === 'float'
        ? (/** @type {number} */ bits)=>fields.asFloat(bits)
        : (/** @type {number} */ bits)=>bits | 0);
    /** @param {string} given */
    const writer = given=>(given === 'float'
        ? (/** @type {number} */ at, /** @type {number} */ value)=>fields.writeF32(at, value)
        : (/** @type {number} */ at, /** @type {number} */ value)=>fields.writeU32(at, value >>> 0));

    /**
     * Elements of a scalar or vector from or into the program's array,
     * each as many dwords as the type has components.
     *
     * @param {any} variable @param {'float' | 'int' | 'bool'} given
     * @param {number} at @param {number} first @param {number} count
     */
    const setNumbers = (variable, given, at, first, count)=>{
        if ((at >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const components = variable.kind === VARIABLE_KIND.VECTOR
            ? variable.shape.fxType.columns
            : 1;
        return variable.SetValues(given, readDwords(at, count * components).map(reader(given)),
            first, count);
    };
    /**
     * @param {any} variable @param {'float' | 'int' | 'bool'} given
     * @param {number} at @param {number} first @param {number} count
     */
    const getNumbers = (variable, given, at, first, count)=>{
        if ((at >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const write = writer(given);
        variable.GetValues(given, first, count).forEach((/** @type {number} */ value,
            /** @type {number} */ index)=>write((at >>> 0) + index * 4, value));
        return S_OK;
    };

    /** @param {'float' | 'int' | 'bool'} given @returns {Record<string, KindMethod>} */
    const scalarMethods = given=>{
        const name = GIVEN_NAME[given];
        return {
            [`Set${name}`]: valid((variable, [bits])=>variable.SetValues(given,
                [reader(given)(bits)], 0, 1)),
            [`Get${name}`]: valid((variable, [out])=>getNumbers(variable, given, out, 0, 1)),
            // A scalar array's offset goes unused: it is set and read from its
            // first element on (Wine's test_scalar_array_methods).
            [`Set${name}Array`]: valid((variable, [at, , count])=>
                setNumbers(variable, given, at, 0, count >>> 0)),
            [`Get${name}Array`]: valid((variable, [at, , count])=>
                getNumbers(variable, given, at, 0, count >>> 0)),
        };
    };

    /** @param {'float' | 'int' | 'bool'} given @returns {Record<string, KindMethod>} */
    const vectorMethods = given=>{
        const name = GIVEN_NAME[given];
        return {
            [`Set${name}Vector`]: valid((variable, [at])=>setNumbers(variable, given, at, 0, 1)),
            [`Get${name}Vector`]: valid((variable, [at])=>getNumbers(variable, given, at, 0, 1)),
            // Unlike a scalar array's, the offset is honoured
            // (test_vector_array_methods).
            [`Set${name}VectorArray`]: valid((variable, [at, offset, count])=>
                setNumbers(variable, given, at, offset >>> 0, count >>> 0)),
            [`Get${name}VectorArray`]: valid((variable, [at, offset, count])=>
                getNumbers(variable, given, at, offset >>> 0, count >>> 0)),
        };
    };

    /**
     * Matrices from or into the program's float[4][4]s; only the entries
     * the type has are read into it or written back.
     *
     * @param {boolean} transposed
     * @returns {Record<string, KindMethod>}
     */
    const matrixMethods = transposed=>{
        const name = transposed ? 'MatrixTranspose' : 'Matrix';
        /** @param {any} variable @param {number} at @param {number} first @param {number} count */
        const set = (variable, at, first, count)=>((at >>> 0) === 0
            ? E_INVALIDARG
            : variable.SetMatrices(readDwords(at, count * 16), first, count, transposed));
        /** @param {any} variable @param {number} at @param {number} first @param {number} count */
        const get = (variable, at, first, count)=>{
            if ((at >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {(number | undefined)[]} */
            const dwords = variable.GetMatrices(first, count, transposed);
            dwords.forEach((dword, index)=>{
                if (dword !== undefined)
                {
                    fields.writeU32((at >>> 0) + index * 4, dword);
                }
            });
            return S_OK;
        };
        return {
            [`Set${name}`]: valid((variable, [at])=>set(variable, at, 0, 1)),
            [`Get${name}`]: valid((variable, [at])=>get(variable, at, 0, 1)),
            [`Set${name}Array`]: valid((variable, [at, offset, count])=>
                set(variable, at, offset >>> 0, count >>> 0)),
            [`Get${name}Array`]: valid((variable, [at, offset, count])=>
                get(variable, at, offset >>> 0, count >>> 0)),
        };
    };

    /**
     * A view variable's four methods: one view or an array of them, set with
     * a reference the variable keeps and got with one the caller owns.
     *
     * @param {string} child  Which of `children` the views are.
     * @param {string} name   'Resource', 'RenderTarget' or 'DepthStencil'.
     * @returns {Record<string, KindMethod>}
     */
    const viewMethods = (child, name)=>{
        const [interfaces, id] = children[child];
        return {
            [`Set${name}`]: valid((variable, [view])=>variable.SetViews([objectOf(view)], 0)),
            [`Get${name}`]: valid((variable, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeObjects(out, variable.GetViews(0, 1), interfaces, id);
                return S_OK;
            }),
            [`Set${name}Array`]: valid((variable, [at, offset, count])=>((at >>> 0) === 0
                ? E_INVALIDARG
                : variable.SetViews(readDwords(at, count >>> 0).map(objectOf), offset >>> 0))),
            [`Get${name}Array`]: valid((variable, [at, offset, count])=>{
                if ((at >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeObjects(at, variable.GetViews(offset >>> 0, count >>> 0), interfaces, id);
                return S_OK;
            }),
        };
    };

    /**
     * A texture buffer's view: a constant buffer is not one, and a texture
     * buffer's is not made here.
     *
     * @param {'Set' | 'Get'} verb
     * @returns {KindMethod}
     */
    const textureBufferMethod = verb=>valid((variable, [out])=>{
        if (!variable.textureBuffer())
        {
            return D3DERR_INVALIDCALL;
        }
        report(`${verb}TextureBuffer: an effect's texture buffer has no view here`);
        if (verb === 'Get' && (out >>> 0) !== 0)
        {
            fields.writeU32(out, 0);
        }
        return E_NOTIMPL;
    });

    /**
     * @param {'vertex' | 'pixel' | 'geometry'} stage
     * @returns {KindMethod}
     */
    const shaderGetter = stage=>valid((variable, [index, out])=>{
        const { hr, shader } = variable.GetShader(stage, index >>> 0);
        if ((out >>> 0) === 0)
        {
            shader?.release?.();
            return hr === S_OK ? E_INVALIDARG : hr;
        }
        const [interfaces, id] = children[stage];
        writeObjects(out, [shader], interfaces, id);
        return hr;
    });

    /**
     * D3D10_SIGNATURE_PARAMETER_DESC: the name, four dwords, and the two
     * masks as bytes.
     *
     * @param {'inputs' | 'outputs'} which
     * @returns {KindMethod}
     */
    const signatureElement = which=>valid((variable, [index, element, out])=>{
        /** @type {{ entry?: import('../d3d10/reflection.js').ReflectedParameter }} */
        const held = {};
        const hr = variable.GetSignatureElement(which, index >>> 0, element >>> 0,
            (out >>> 0) === 0 ? null : held);
        const entry = held.entry;
        if (hr === S_OK && entry)
        {
            [pointerOf(variable.owner, { at: entry.nameAt }), entry.index, entry.register,
                entry.systemValue, entry.componentType,
                entry.mask | (entry.readWriteMask << 8)]
                .forEach((value, position)=>fields.writeU32(out + position * 4, value >>> 0));
        }
        return hr;
    });

    /**
     * A state variable's state object and backing store at an index.
     *
     * @param {string} kind
     * @param {string} getter
     * @returns {Record<string, KindMethod>}
     */
    const stateMethods = (kind, getter)=>{
        const [interfaces, id] = children[kind];
        return {
            [getter]: valid((variable, [index, out])=>{
                const { hr, state } = variable.GetState(index >>> 0);
                if ((out >>> 0) === 0)
                {
                    state?.release?.();
                    return hr === S_OK ? E_INVALIDARG : hr;
                }
                writeObjects(out, [state], interfaces, id);
                return hr;
            }),
            GetBackingStore: valid((variable, [index, out])=>{
                /** @type {{ desc?: any }} */
                const held = {};
                const hr = variable.GetBackingStore(index >>> 0, (out >>> 0) === 0 ? null : held);
                if (hr === S_OK && held.desc)
                {
                    writeStateDesc[kind](held.desc, out >>> 0);
                }
                return hr;
            }),
        };
    };

    /**
     * What each kind adds after ID3D10EffectVariable's methods.
     *
     * @type {Record<string, Record<string, KindMethod>>}
     */
    const kindMethods = {
        [VARIABLE_KIND.SCALAR]: {
            ...scalarMethods('float'), ...scalarMethods('int'), ...scalarMethods('bool'),
        },
        [VARIABLE_KIND.VECTOR]: {
            ...vectorMethods('float'), ...vectorMethods('int'), ...vectorMethods('bool'),
        },
        [VARIABLE_KIND.MATRIX]: { ...matrixMethods(false), ...matrixMethods(true) },
        [VARIABLE_KIND.STRING]: {
            GetString: valid((variable, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                fields.writeU32(out, pointerOf(variable.owner, variable.GetStrings(0, 1)[0]));
                return S_OK;
            }),
            GetStringArray: valid((variable, [at, offset, count])=>{
                if ((at >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                variable.GetStrings(offset >>> 0, count >>> 0).forEach((/** @type {any} */ text,
                    /** @type {number} */ index)=>fields.writeU32((at >>> 0) + index * 4,
                    pointerOf(variable.owner, text)));
                return S_OK;
            }),
        },
        [VARIABLE_KIND.SHADER_RESOURCE]: viewMethods('shaderResourceView', 'Resource'),
        [VARIABLE_KIND.RENDER_TARGET_VIEW]: viewMethods('renderTargetView', 'RenderTarget'),
        [VARIABLE_KIND.DEPTH_STENCIL_VIEW]: viewMethods('depthStencilView', 'DepthStencil'),
        [VARIABLE_KIND.CONSTANT_BUFFER]: {
            SetConstantBuffer: valid((variable, [buffer])=>(variable.textureBuffer()
                ? D3DERR_INVALIDCALL
                : variable.SetConstantBuffer(objectOf(buffer)))),
            GetConstantBuffer: valid((variable, [out])=>{
                if (variable.textureBuffer())
                {
                    return D3DERR_INVALIDCALL;
                }
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const [interfaces, id] = children.buffer;
                writeObjects(out, [variable.GetConstantBuffer()], interfaces, id);
                return S_OK;
            }),
            SetTextureBuffer: textureBufferMethod('Set'),
            GetTextureBuffer: textureBufferMethod('Get'),
        },
        [VARIABLE_KIND.SHADER]: {
            GetShaderDesc: valid((variable, [index, out])=>{
                /** @type {{ desc?: Record<string, any> }} */
                const held = {};
                const hr = variable.GetShaderDesc(index >>> 0, (out >>> 0) === 0 ? null : held);
                const desc = held.desc;
                if (hr === S_OK && desc)
                {
                    [pointerOf(variable.owner, desc.InputSignature), bool(desc.IsInline),
                        pointerOf(variable.owner, desc.Bytecode), desc.BytecodeLength,
                        pointerOf(variable.owner, desc.SODecl), desc.NumInputSignatureEntries,
                        desc.NumOutputSignatureEntries]
                        .forEach((value, position)=>fields.writeU32(out + position * 4,
                            value >>> 0));
                }
                return hr;
            }),
            GetVertexShader: shaderGetter('vertex'),
            GetGeometryShader: shaderGetter('geometry'),
            GetPixelShader: shaderGetter('pixel'),
            GetInputSignatureElementDesc: signatureElement('inputs'),
            GetOutputSignatureElementDesc: signatureElement('outputs'),
        },
        [VARIABLE_KIND.BLEND]: stateMethods(VARIABLE_KIND.BLEND, 'GetBlendState'),
        [VARIABLE_KIND.DEPTH_STENCIL]: stateMethods(VARIABLE_KIND.DEPTH_STENCIL,
            'GetDepthStencilState'),
        [VARIABLE_KIND.RASTERIZER]: stateMethods(VARIABLE_KIND.RASTERIZER, 'GetRasterizerState'),
        [VARIABLE_KIND.SAMPLER]: stateMethods(VARIABLE_KIND.SAMPLER, 'GetSampler'),
    };

    // --- passes and techniques ---

    /**
     * ComputeStateBlockMask: the program's mask read, added to and written
     * back.
     *
     * @param {any} object @param {number[]} args
     */
    const computeMask = (object, [maskAt])=>{
        if ((maskAt >>> 0) === 0)
        {
            return object.ComputeStateBlockMask(null);
        }
        const mask = Uint8Array.from(memory.readMemory(maskAt >>> 0, STATE_BLOCK_MASK_SIZE));
        const hr = object.ComputeStateBlockMask(mask);
        memory.writeMemory(maskAt >>> 0, mask);
        return hr;
    };

    /** @param {number} state */
    const shaderDesc = state=>{
        /** @param {any} pass @param {number[]} args */
        const write = (pass, [out])=>{
            /** @type {{ desc?: { variable: any, index: number } }} */
            const held = {};
            const hr = pass.GetShaderDesc(state, (out >>> 0) === 0 ? null : held);
            if (hr === S_OK && held.desc)
            {
                fields.writeU32(out, publishVariable(held.desc.variable));
                fields.writeU32(out + 4, held.desc.index >>> 0);
            }
            return hr;
        };
        return write;
    };

    const passInterfaces = [describe(IID.ID3D10EffectPass, ID3D10EFFECTPASS_SLOTS, {
        /** @param {any} pass */
        IsValid: pass=>bool(pass.IsValid()),
        /** @param {any} pass @param {number[]} args */
        GetDesc: (pass, [out])=>writeDesc(pass, out, [['Name', 'pointer'],
            ['Annotations', 'u32'], ['IAInputSignature', 'pointer'],
            ['IAInputSignatureSize', 'u32'], ['StencilRef', 'u32'], ['SampleMask', 'u32'],
            ['BlendFactor', 'f32x4']]),
        GetVertexShaderDesc: shaderDesc(PASS_STATE.VERTEX_SHADER),
        GetGeometryShaderDesc: shaderDesc(PASS_STATE.GEOMETRY_SHADER),
        GetPixelShaderDesc: shaderDesc(PASS_STATE.PIXEL_SHADER),
        /** @param {any} pass @param {number[]} args */
        GetAnnotationByIndex: (pass, [index])=>
            publishVariable(pass.GetAnnotationByIndex(index >>> 0)),
        /** @param {any} pass @param {number[]} args */
        GetAnnotationByName: (pass, [name])=>
            publishVariable(pass.GetAnnotationByName(nameArgument(name))),
        /** @param {any} pass @param {number[]} args */
        Apply: (pass, [flags])=>(pass.invalid ? E_FAIL : pass.Apply(flags >>> 0)),
        /** @param {any} pass @param {number[]} args */
        ComputeStateBlockMask: (pass, args)=>(pass.invalid ? E_FAIL : computeMask(pass, args)),
    })];

    const techniqueInterfaces = [describe(IID.ID3D10EffectTechnique,
        ID3D10EFFECTTECHNIQUE_SLOTS, {
            /** @param {any} technique */
            IsValid: technique=>bool(technique.IsValid()),
            /** @param {any} technique @param {number[]} args */
            GetDesc: (technique, [out])=>writeDesc(technique, out, [['Name', 'pointer'],
                ['Passes', 'u32'], ['Annotations', 'u32']]),
            /** @param {any} technique @param {number[]} args */
            GetAnnotationByIndex: (technique, [index])=>
                publishVariable(technique.GetAnnotationByIndex(index >>> 0)),
            /** @param {any} technique @param {number[]} args */
            GetAnnotationByName: (technique, [name])=>
                publishVariable(technique.GetAnnotationByName(nameArgument(name))),
            /** @param {any} technique @param {number[]} args */
            GetPassByIndex: (technique, [index])=>
                publishPass(technique.GetPassByIndex(index >>> 0)),
            /** @param {any} technique @param {number[]} args */
            GetPassByName: (technique, [name])=>
                publishPass(technique.GetPassByName(nameArgument(name))),
            /** @param {any} technique @param {number[]} args */
            ComputeStateBlockMask: (technique, args)=>(technique.invalid
                ? E_FAIL
                : computeMask(technique, args)),
        })];

    // --- the effect ---

    const effectInterfaces = [describe(IID.ID3D10Effect, ID3D10EFFECT_SLOTS, {
        /** @param {any} effect */
        IsValid: effect=>bool(effect.IsValid()),
        /** @param {any} effect */
        IsPool: effect=>bool(effect.IsPool()),
        /** @param {any} effect @param {number[]} args */
        GetDevice: (effect, [out])=>{
            /** @type {{ device?: any }} */
            const held = {};
            effect.GetDevice(held);
            return handBack(held.device, context.deviceInterfaces(), IID.ID3D10Device, out);
        },
        /** @param {any} effect @param {number[]} args */
        GetDesc: (effect, [out])=>writeDesc(effect, out, [['IsChildEffect', 'u32'],
            ['ConstantBuffers', 'u32'], ['SharedConstantBuffers', 'u32'],
            ['GlobalVariables', 'u32'], ['SharedGlobalVariables', 'u32'], ['Techniques', 'u32']]),
        /** @param {any} effect @param {number[]} args */
        GetConstantBufferByIndex: (effect, [index])=>
            publishVariable(effect.GetConstantBufferByIndex(index >>> 0)),
        /** @param {any} effect @param {number[]} args */
        GetConstantBufferByName: (effect, [name])=>
            publishVariable(effect.GetConstantBufferByName(nameArgument(name))),
        /** @param {any} effect @param {number[]} args */
        GetVariableByIndex: (effect, [index])=>
            publishVariable(effect.GetVariableByIndex(index >>> 0)),
        /** @param {any} effect @param {number[]} args */
        GetVariableByName: (effect, [name])=>
            publishVariable(effect.GetVariableByName(nameArgument(name))),
        /** @param {any} effect @param {number[]} args */
        GetVariableBySemantic: (effect, [name])=>
            publishVariable(effect.GetVariableBySemantic(nameArgument(name))),
        /** @param {any} effect @param {number[]} args */
        GetTechniqueByIndex: (effect, [index])=>
            publishTechnique(effect.GetTechniqueByIndex(index >>> 0)),
        /** @param {any} effect @param {number[]} args */
        GetTechniqueByName: (effect, [name])=>
            publishTechnique(effect.GetTechniqueByName(nameArgument(name))),
        /** @param {any} effect */
        Optimize: effect=>effect.Optimize(),
        /** @param {any} effect */
        IsOptimized: effect=>bool(effect.IsOptimized()),
    }, false)];

    /**
     * HRESULT D3D10CreateEffectFromMemory(void *data, SIZE_T size, UINT flags,
     *     ID3D10Device *device, ID3D10EffectPool *pool, ID3D10Effect **effect)
     *
     * @param {number[]} args
     */
    const fromMemory = ([data, size, flags, devicePointer, pool, out])=>{
        void flags;
        const clear = ()=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
        };
        const device = publisher.objectAt(devicePointer);
        if (!device || typeof device.CreateBuffer !== 'function')
        {
            clear();
            return D3DERR_INVALIDCALL;
        }
        if ((data >>> 0) === 0 || (size >>> 0) === 0 || (out >>> 0) === 0)
        {
            clear();
            return E_INVALIDARG;
        }
        if ((pool >>> 0) !== 0)
        {
            report('an effect made as the child of a pool is refused: effect pools are not'
                + ' implemented');
            clear();
            return E_NOTIMPL;
        }
        const parsed = parseEffect(memory.readMemory(data >>> 0, size >>> 0));
        if ('error' in parsed)
        {
            report(`an effect was refused: ${parsed.error}`);
            clear();
            return E_FAIL;
        }
        let copy = 0;
        /** @type {any} */
        let effect = null;
        effect = createEffect(parsed.effect, {
            device,
            report,
            onLastRef: ()=>{
                for (const child of effect.children())
                {
                    publisher.unpublish(child);
                }
                if (copy)
                {
                    free?.(copy);
                }
            },
        });
        const image = effect.image();
        copy = allocate ? allocate(Math.max(image.length, 4)) : 0;
        if (!copy)
        {
            effect.release();
            clear();
            return E_OUTOFMEMORY;
        }
        memory.writeMemory(copy, image);
        blocks.set(effect, copy);
        return handBack(effect, effectInterfaces, IID.ID3D10Effect, out);
    };

    return {
        fromMemory,
        effectInterfaces,
        /** The invalid objects' pointers are the same in every effect; for tests. */
        invalid: INVALID,
    };
}
