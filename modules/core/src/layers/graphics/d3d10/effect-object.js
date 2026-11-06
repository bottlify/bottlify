/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The effect framework's objects over an effect `effect.js` read: the
 * ID3D10Effect, and its techniques, passes, variables and types.
 *
 * Only the effect counts references. Everything reached through it is an
 * interface without IUnknown, made when first asked for and the same object
 * ever after -- a program compares the pointers -- and gone with the effect;
 * `children()` names them for whoever published them.
 *
 * A lookup never answers null. Each kind has one invalid object: its
 * IsValid is FALSE, its description fails with E_FAIL, and its own lookups
 * lead to the invalid object of their kind (Wine's d3d10 effect tests). A
 * valid object handed a null out pointer answers E_INVALIDARG.
 *
 * A variable is published as the interface its type makes it -- a float as
 * ID3D10EffectScalarVariable, a texture as ID3D10EffectShaderResourceVariable
 * -- which extends ID3D10EffectVariable, so the pointer GetVariableByName
 * hands out is the same one AsScalar answers. As* for any other kind answers
 * that kind's invalid object.
 *
 * Numeric variables live in their constant buffer's bytes, laid out as the
 * buffer is, registers padded; a default value, stored packed, is spread
 * into that layout when the effect is made.
 *
 * Names are `{ at }`, an offset into the effect's image -- its unstructured
 * block, then the input signature of each of its shaders cut out of the
 * shader -- or `{ text }`, a string of the runtime's own ("$Anonymous",
 * "cbuffer").
 */

import { attachCom } from './com.js';
import { D3D10_BIND, D3D10_USAGE, E_FAIL, E_INVALIDARG, IID, S_OK } from './constants.js';
import { ASSIGNMENT, CONSTANT_TYPE, D3D10_SVC, D3D10_SVT } from './effect.js';
import { NotAnExpression, parseExpression, runExpression } from './effect-expression.js';
import { SAMPLER_TEXTURE, stateDesc } from './effect-states.js';
import {
    getComponents, getMatrices, setComponents, setMatrices,
} from './effect-values.js';
import { D3DERR_INVALIDCALL, containerOf, reflectShader } from './reflection.js';
import { D3D10_DST, stateBlockMask } from './stateblock.js';

/** D3D10_EFFECT_VARIABLE flags. */
export const D3D10_EFFECT_VARIABLE = Object.freeze({
    POOLED: 1, ANNOTATION: 2, EXPLICIT_BIND_POINT: 4,
});

/** The interface a variable is published as, by what it holds. */
export const VARIABLE_KIND = Object.freeze({
    VARIABLE: 'variable', SCALAR: 'scalar', VECTOR: 'vector', MATRIX: 'matrix', STRING: 'string',
    SHADER_RESOURCE: 'shaderResource', RENDER_TARGET_VIEW: 'renderTargetView',
    DEPTH_STENCIL_VIEW: 'depthStencilView', CONSTANT_BUFFER: 'constantBuffer', SHADER: 'shader',
    BLEND: 'blend', DEPTH_STENCIL: 'depthStencil', RASTERIZER: 'rasterizer', SAMPLER: 'sampler',
});

/** The pass states that name a shader, by stage. */
export const PASS_STATE = Object.freeze({
    RASTERIZER: 0, DEPTH_STENCIL: 1, BLEND: 2, VERTEX_SHADER: 6, PIXEL_SHADER: 7,
    GEOMETRY_SHADER: 8, STENCIL_REF: 9, BLEND_FACTOR: 0xa, SAMPLE_MASK: 0xb,
});

/** D3D10_SHADER_INPUT_TYPE: what a shader's binding is. */
const SHADER_INPUT = Object.freeze({ CBUFFER: 0, TBUFFER: 1, TEXTURE: 2, SAMPLER: 3 });

/** The state block entry each whole pass state is. @type {Readonly<Record<number, number>>} */
const MASK_OF_STATE = Object.freeze({
    [PASS_STATE.RASTERIZER]: D3D10_DST.RS_RASTERIZER_STATE,
    [PASS_STATE.DEPTH_STENCIL]: D3D10_DST.OM_DEPTH_STENCIL_STATE,
    [PASS_STATE.BLEND]: D3D10_DST.OM_BLEND_STATE,
    [PASS_STATE.VERTEX_SHADER]: D3D10_DST.VS,
    [PASS_STATE.PIXEL_SHADER]: D3D10_DST.PS,
    [PASS_STATE.GEOMETRY_SHADER]: D3D10_DST.GS,
});

/**
 * The state block entries a shader's bindings are, by stage and binding type.
 *
 * @type {Readonly<Record<string, Readonly<Record<number, number>>>>}
 */
const MASK_OF_BINDING = Object.freeze({
    VS: { [SHADER_INPUT.CBUFFER]: D3D10_DST.VS_CONSTANT_BUFFERS,
        [SHADER_INPUT.TEXTURE]: D3D10_DST.VS_SHADER_RESOURCES,
        [SHADER_INPUT.SAMPLER]: D3D10_DST.VS_SAMPLERS },
    GS: { [SHADER_INPUT.CBUFFER]: D3D10_DST.GS_CONSTANT_BUFFERS,
        [SHADER_INPUT.TEXTURE]: D3D10_DST.GS_SHADER_RESOURCES,
        [SHADER_INPUT.SAMPLER]: D3D10_DST.GS_SAMPLERS },
    PS: { [SHADER_INPUT.CBUFFER]: D3D10_DST.PS_CONSTANT_BUFFERS,
        [SHADER_INPUT.TEXTURE]: D3D10_DST.PS_SHADER_RESOURCES,
        [SHADER_INPUT.SAMPLER]: D3D10_DST.PS_SAMPLERS },
});

/**
 * @typedef {{ at: number } | { text: string }} EffectString
 */

/**
 * @typedef {(out: { desc?: Record<string, any> } | null) => number} Describe
 */

/**
 * The kind of variable a type makes.
 *
 * @param {import('./effect.js').FxType} type
 */
function kindOf(type){
    if (type.kind === 'numeric')
    {
        return type.svc === D3D10_SVC.SCALAR
            ? VARIABLE_KIND.SCALAR
            : type.svc === D3D10_SVC.VECTOR ? VARIABLE_KIND.VECTOR : VARIABLE_KIND.MATRIX;
    }
    switch (type.object)
    {
        case 'string': return VARIABLE_KIND.STRING;
        case 'texture': return VARIABLE_KIND.SHADER_RESOURCE;
        case 'rendertargetview': return VARIABLE_KIND.RENDER_TARGET_VIEW;
        case 'depthstencilview': return VARIABLE_KIND.DEPTH_STENCIL_VIEW;
        case 'pixelshader':
        case 'vertexshader':
        case 'geometryshader': return VARIABLE_KIND.SHADER;
        case 'blend': return VARIABLE_KIND.BLEND;
        case 'depthstencil': return VARIABLE_KIND.DEPTH_STENCIL;
        case 'rasterizer': return VARIABLE_KIND.RASTERIZER;
        case 'sampler': return VARIABLE_KIND.SAMPLER;
        default: return VARIABLE_KIND.VARIABLE;
    }
}

/**
 * @param {{ desc?: Record<string, any> } | null} out
 * @param {() => Record<string, any>} make
 */
const describeInto = (out, make)=>{
    if (!out)
    {
        return E_INVALIDARG;
    }
    out.desc = make();
    return S_OK;
};

/** @param {string | null} a @param {string | null} b */
const sameSemantic = (a, b)=>a !== null && b !== null && a.toUpperCase() === b.toUpperCase();

/**
 * One object per entry, made when first asked for; anything out of range is
 * the invalid object.
 *
 * @template E, T
 * @param {E[]} list
 * @param {(entry: E, index: number) => T} make
 * @param {T} invalid
 * @returns {(index: number) => T}
 */
function objectsOf(list, make, invalid){
    /** @type {T[]} */
    const made = [];
    return index=>{
        if (!(index >= 0 && index < list.length))
        {
            return invalid;
        }
        made[index] ??= make(list[index], index);
        return made[index];
    };
}

/**
 * The invalid object of every kind. They belong to no effect: a program may
 * hold one across effects, and compare it with what another lookup answered.
 */
function invalidObjects(){
    const fail = ()=>E_FAIL;
    /** @type {any} */
    const type = {
        invalid: true, owner: null, IsValid: ()=>false, GetDesc: fail,
        GetMemberTypeByIndex: ()=>type, GetMemberTypeByName: ()=>type,
        GetMemberTypeBySemantic: ()=>type, GetMemberName: ()=>null, GetMemberSemantic: ()=>null,
    };
    /** @type {Record<string, any>} */
    const variables = {};
    for (const kind of Object.values(VARIABLE_KIND))
    {
        variables[kind] = { invalid: true, owner: null, kind };
    }
    for (const variable of Object.values(variables))
    {
        Object.assign(variable, {
            IsValid: ()=>false,
            GetType: ()=>type,
            GetDesc: fail,
            GetAnnotationByIndex: ()=>variables.variable,
            GetAnnotationByName: ()=>variables.variable,
            GetMemberByIndex: ()=>variables.variable,
            GetMemberByName: ()=>variables.variable,
            GetMemberBySemantic: ()=>variables.variable,
            GetElement: ()=>variables.variable,
            GetParentConstantBuffer: ()=>variables.constantBuffer,
            /** @param {string} kind */
            As: kind=>variables[kind],
        });
    }
    /** @type {any} */
    const pass = {
        invalid: true, owner: null, IsValid: ()=>false, GetDesc: fail,
        GetShaderDesc: fail,
        GetAnnotationByIndex: ()=>variables.variable, GetAnnotationByName: ()=>variables.variable,
    };
    /** @type {any} */
    const technique = {
        invalid: true, owner: null, IsValid: ()=>false, GetDesc: fail,
        GetAnnotationByIndex: ()=>variables.variable, GetAnnotationByName: ()=>variables.variable,
        GetPassByIndex: ()=>pass, GetPassByName: ()=>pass,
    };
    return Object.freeze({ type, variables, pass, technique });
}

/** The invalid objects, one set for the process. */
export const INVALID = invalidObjects();

/**
 * Spreads a value stored packed into the layout a constant buffer gives its
 * type: each element a stride apart, a matrix's rows or columns (as it is
 * stored) a register apart, a structure's members at their offsets.
 *
 * @param {import('./effect.js').FxType} type
 * @param {Uint8Array} packed
 * @param {Uint8Array} into
 * @param {number} at      Where the variable starts in `into`.
 * @param {{ read: number }} [cursor]
 */
function unpackInto(type, packed, into, at, cursor = { read: 0 }){
    const count = Math.max(1, type.elements);
    for (let element = 0; element < count; element++)
    {
        const base = at + element * type.stride;
        if (type.kind === 'struct')
        {
            for (const member of type.members)
            {
                unpackInto(member.type, packed, into, base + member.bufferOffset, cursor);
            }
            continue;
        }
        let registers = 1;
        let perRegister = type.columns;
        if (type.svc === D3D10_SVC.MATRIX_ROWS)
        {
            registers = type.rows;
        }
        else if (type.svc === D3D10_SVC.MATRIX_COLUMNS)
        {
            registers = type.columns;
            perRegister = type.rows;
        }
        for (let register = 0; register < registers; register++)
        {
            const length = perRegister * 4;
            const to = base + register * 16;
            if (cursor.read + length <= packed.length && to + length <= into.length)
            {
                into.set(packed.subarray(cursor.read, cursor.read + length), to);
            }
            cursor.read += length;
        }
    }
}

/** A child effect whose pool lacks what it shares: no effect is made. */
export class EffectRefused extends Error {}

/**
 * @typedef {Object} EffectServices
 * @property {any} device   The ID3D10Device the effect was made on.
 * @property {(detail: string) => void} [report]  Where a divergence is said.
 * @property {() => void} [onLastRef]
 * @property {boolean} [isPool]  Made by D3D10CreateEffectPoolFromMemory: every
 *     variable, buffer and annotation of it is flagged POOLED.
 * @property {any} [pool]  The pool a child effect takes its shared buffers and
 *     variables from, by name.
 */

/**
 * @param {import('./effect.js').EffectData} data
 * @param {EffectServices} services
 */
export function createEffect(data, services){
    const { device } = services;
    const report = services.report ?? (()=>{});
    const pooled = services.isPool ? D3D10_EFFECT_VARIABLE.POOLED : 0;
    const pool = services.pool ?? null;
    // What a child effect shares, the pool's own objects, found by name: a
    // name its pool lacks makes no effect.
    const sharedBuffers = (data.sharedBuffers ?? []).map(shared=>{
        const found = pool?.GetConstantBufferByName(shared.name);
        if (!found || found.invalid)
        {
            throw new EffectRefused(`the pool has no constant buffer ${shared.name}`);
        }
        return found;
    });
    const sharedObjects = (data.sharedObjects ?? []).map(shared=>{
        const found = pool?.GetVariableByName(shared.name);
        if (!found || found.invalid)
        {
            throw new EffectRefused(`the pool has no variable ${shared.name}`);
        }
        return found;
    });
    /** @type {any[]} */
    const sharedVariables = [...sharedBuffers.flatMap(buffer=>buffer.variables()),
        ...sharedObjects];
    /**
     * The effect, made first so that everything built below can name it;
     * its methods are attached at the end.
     *
     * @type {any}
     */
    const self = {};
    // Optimize drops what only reflection reads, as Windows does (Wine's
    // test_effect_optimize, test_effect_annotations): every annotation, the
    // names of techniques and passes, and a shader's bytecode, stream output
    // declaration and signature counts; variables keep their names.
    let optimized = false;
    /**
     * An object's annotations as reflection sees them: none once optimized.
     *
     * @param {(index: number) => any} at @param {readonly { name: string }[]} list
     */
    const annotationsOf = (at, list)=>({
        count: ()=>(optimized ? 0 : list.length),
        /** @param {number} index */
        byIndex: index=>(optimized ? INVALID.variables.variable : at(index)),
        /** @param {string | null} name */
        byName: name=>(optimized ? INVALID.variables.variable
            : at(list.findIndex(entry=>entry.name === name))),
    });
    /** Everything made for this effect that is not the effect. @type {object[]} */
    const made = [];
    /**
     * @template {object} T
     * @param {T} object
     * @returns {T}
     */
    const kept = object=>{
        made.push(object);
        return object;
    };

    // --- types ---

    /**
     * @typedef {Object} TypeShape
     * @property {EffectString} name
     * @property {number} svc
     * @property {number} svt
     * @property {number} elements
     * @property {number} rows
     * @property {number} columns
     * @property {number} packedSize
     * @property {number} unpackedSize
     * @property {number} stride
     * @property {{ name: string, nameAt: number, semantic: string | null,
     *              semanticAt: number, type: () => any }[]} members
     */

    /** @param {TypeShape} shape @returns {any} */
    const typeObject = shape=>{
        const memberAt = objectsOf(shape.members, member=>member.type(), INVALID.type);
        /** @param {(member: TypeShape['members'][number]) => boolean} test */
        const find = test=>memberAt(shape.members.findIndex(test));
        return kept({
            invalid: false,
            owner: self,
            shape,
            IsValid: ()=>true,
            /** @param {{ desc?: Record<string, any> } | null} out */
            GetDesc: out=>describeInto(out, ()=>({
                TypeName: shape.name, Class: shape.svc, Type: shape.svt,
                Elements: shape.elements, Members: shape.members.length, Rows: shape.rows,
                Columns: shape.columns, PackedSize: shape.packedSize,
                UnpackedSize: shape.unpackedSize, Stride: shape.stride,
            })),
            GetMemberTypeByIndex: memberAt,
            /** @param {string | null} name */
            GetMemberTypeByName: name=>find(member=>member.name === name),
            /** @param {string | null} semantic */
            GetMemberTypeBySemantic: semantic=>find(member=>
                sameSemantic(member.semantic, semantic)),
            /** @param {number} index @returns {EffectString | null} */
            GetMemberName: index=>(index >= 0 && index < shape.members.length
                ? { at: shape.members[index].nameAt }
                : null),
            /** @param {number} index @returns {EffectString | null} */
            GetMemberSemantic: index=>{
                const member = index >= 0 && index < shape.members.length
                    ? shape.members[index]
                    : null;
                return member && member.semanticAt >= 0 ? { at: member.semanticAt } : null;
            },
        });
    };

    /** @type {Map<import('./effect.js').FxType, any>} */
    const types = new Map();
    /** @type {Map<import('./effect.js').FxType, any>} */
    const elementTypes = new Map();
    /** @param {import('./effect.js').FxType} type @returns {any} */
    const typeOf = type=>{
        let object = types.get(type);
        if (!object)
        {
            object = typeObject({
                name: { at: type.nameAt }, svc: type.svc, svt: type.svt, elements: type.elements,
                rows: type.rows, columns: type.columns, packedSize: type.packedSize,
                unpackedSize: type.unpackedSize, stride: type.stride,
                members: type.members.map(member=>({ ...member, type: ()=>typeOf(member.type) })),
            });
            types.set(type, object);
        }
        return object;
    };
    /**
     * One element of an array type: one element's sizes, no elements.
     *
     * @param {import('./effect.js').FxType} type
     */
    const elementTypeOf = type=>{
        let object = elementTypes.get(type);
        if (!object)
        {
            const whole = typeOf(type).shape;
            object = typeObject({
                ...whole, elements: 0,
                packedSize: type.elements ? type.packedSize / type.elements : type.packedSize,
                unpackedSize: type.unpackedSize - type.stride * Math.max(0, type.elements - 1),
            });
            elementTypes.set(type, object);
        }
        return object;
    };

    // --- variables ---

    /**
     * @typedef {Object} VariableShape
     * @property {string} kind          VARIABLE_KIND.
     * @property {EffectString} name
     * @property {string | null} semantic
     * @property {number} semanticAt
     * @property {number} flags
     * @property {number} bufferOffset
     * @property {number} explicitBindPoint
     * @property {() => any} type
     * @property {import('./effect.js').FxType | null} fxType
     * @property {any[]} annotations    Made lazily, like everything else.
     * @property {import('./effect.js').FxAnnotation[]} fxAnnotations
     * @property {any} buffer           The constant buffer it is in, or null.
     * @property {{ bytes: Uint8Array, at: number } | null} storage  A number's.
     * @property {any[] | null} slots   An object's elements, shared with its element variables.
     * @property {number} slot          Which of them, for an element; -1 for all.
     * @property {(() => any[]) | null} members
     * @property {((index: number) => any) | null} element
     */

    /** @param {VariableShape} shape @returns {any} */
    const variableObject = shape=>{
        const annotations = annotationsOf(objectsOf(shape.fxAnnotations, annotationVariable,
            INVALID.variables.variable), shape.fxAnnotations);
        /** @type {any[] | null} */
        let members = null;
        const memberList = ()=>(members ??= shape.members ? shape.members() : []);
        /** @param {number} index */
        const memberAt = index=>{
            const list = memberList();
            return index >= 0 && index < list.length ? list[index] : INVALID.variables.variable;
        };
        /** @param {(member: any) => boolean} test */
        const findMember = test=>memberList().find(test) ?? INVALID.variables.variable;
        /** @type {any} */
        const variable = kept({
            invalid: false,
            owner: self,
            kind: shape.kind,
            shape,
            IsValid: ()=>true,
            GetType: ()=>shape.type(),
            /** @param {{ desc?: Record<string, any> } | null} out */
            GetDesc: out=>describeInto(out, ()=>({
                Name: shape.name,
                Semantic: shape.semanticAt >= 0 ? { at: shape.semanticAt } : null,
                Flags: shape.flags,
                Annotations: annotations.count(),
                BufferOffset: shape.bufferOffset,
                ExplicitBindPoint: shape.explicitBindPoint,
            })),
            GetAnnotationByIndex: annotations.byIndex,
            GetAnnotationByName: annotations.byName,
            GetMemberByIndex: memberAt,
            /** @param {string | null} name */
            GetMemberByName: name=>findMember(member=>member.shape.memberName === name),
            /** @param {string | null} semantic */
            GetMemberBySemantic: semantic=>findMember(member=>
                sameSemantic(member.shape.semantic, semantic)),
            /** @param {number} index */
            GetElement: index=>(shape.element ? shape.element(index) : INVALID.variables.variable),
            GetParentConstantBuffer: ()=>shape.buffer ?? INVALID.variables.constantBuffer,
            /** @param {string} kind */
            As: kind=>(kind === shape.kind ? variable : INVALID.variables[kind]),
            /**
             * Bytes of the buffer from the variable's start on; past the
             * variable they are its neighbours', as the runtime's are.
             *
             * @param {Uint8Array} bytes @param {number} offset
             */
            SetRawValue(bytes, offset){
                const storage = shape.storage;
                if (!storage)
                {
                    return E_FAIL;
                }
                const at = storage.at + offset;
                if (at < storage.bytes.length)
                {
                    storage.bytes.set(bytes.subarray(0, storage.bytes.length - at), at);
                    markChanged(shape);
                }
                return S_OK;
            },
            /**
             * As many of the bytes asked for as the buffer has.
             *
             * @param {number} offset @param {number} count @returns {Uint8Array | null}
             */
            GetRawValue(offset, count){
                const storage = shape.storage;
                if (!storage)
                {
                    return null;
                }
                const at = storage.at + offset;
                return storage.bytes.slice(at, Math.min(at + count, storage.bytes.length));
            },
        });
        Object.assign(variable, typedMethods(variable));
        return variable;
    };

    /** A numeric variable's bytes changed: its buffer is uploaded before its next use. */
    const markChanged = (/** @type {any} */ shape)=>{
        if (shape.buffer)
        {
            shape.buffer.dirty = true;
        }
        else if (shape.kind === VARIABLE_KIND.CONSTANT_BUFFER)
        {
            buffers.find(buffer=>buffer.shape === shape).dirty = true;
        }
    };

    /**
     * Where an object variable's element sits among every object of its
     * kind in the effect. An index a program gives a variable counts on
     * from its own first element through the rest, as the runtime's does
     * (Wine's test_effect_shader_description, test_effect_state_groups).
     *
     * @type {Record<string, any[]>}
     */
    const flat = {
        [VARIABLE_KIND.SHADER]: [], [VARIABLE_KIND.BLEND]: [],
        [VARIABLE_KIND.DEPTH_STENCIL]: [], [VARIABLE_KIND.RASTERIZER]: [],
        [VARIABLE_KIND.SAMPLER]: [],
    };
    /** @param {any} shape @param {number} index */
    const flatSlot = (shape, index)=>{
        const own = shape.slots?.[shape.slot >= 0 ? shape.slot : 0];
        if (index === 0)
        {
            return own ?? null;
        }
        const list = flat[shape.kind];
        const at = own && own.flat !== undefined ? own.flat + index : -1;
        return list && at >= 0 && at < list.length ? list[at] : null;
    };

    /** @type {Readonly<Record<string, string>>} */
    const SHADER_STAGE = Object.freeze({
        vertex: 'vertexshader', pixel: 'pixelshader', geometry: 'geometryshader',
    });

    /**
     * What each kind of variable adds: its typed views of what it holds.
     *
     * @param {any} variable
     * @returns {Record<string, Function>}
     */
    const typedMethods = variable=>{
        const shape = variable.shape;
        const place = ()=>({ bytes: shape.storage.bytes, at: shape.storage.at,
            type: shape.fxType });
        /** An element count and where it starts, among the variable's own slots. */
        const own = (/** @type {number} */ first)=>(shape.slot >= 0 ? shape.slot : 0) + first;
        switch (shape.kind)
        {
            case VARIABLE_KIND.SCALAR:
            case VARIABLE_KIND.VECTOR:
                return {
                    /**
                     * @param {import('./effect-values.js').Given} given
                     * @param {number[]} values @param {number} first @param {number} count
                     */
                    SetValues(given, values, first, count){
                        setComponents(place(), values, given, first, count);
                        markChanged(shape);
                        return S_OK;
                    },
                    /**
                     * @param {import('./effect-values.js').Given} wanted
                     * @param {number} first @param {number} count
                     */
                    GetValues: (wanted, first, count)=>getComponents(place(), wanted, first, count),
                };
            case VARIABLE_KIND.MATRIX:
                return {
                    /**
                     * @param {number[]} dwords @param {number} first @param {number} count
                     * @param {boolean} transposed
                     */
                    SetMatrices(dwords, first, count, transposed){
                        setMatrices(place(), dwords, first, count, transposed);
                        markChanged(shape);
                        return S_OK;
                    },
                    /** @param {number} first @param {number} count @param {boolean} transposed */
                    GetMatrices: (first, count, transposed)=>
                        getMatrices(place(), first, count, transposed),
                };
            case VARIABLE_KIND.STRING:
                return {
                    /** @param {number} first @param {number} count @returns {EffectString[]} */
                    GetStrings: (first, count)=>Array.from({ length: count }, (_, index)=>{
                        const slot = shape.slots[own(first + index)];
                        return slot?.stringAt !== undefined ? { at: slot.stringAt } : { text: '' };
                    }),
                };
            case VARIABLE_KIND.SHADER_RESOURCE:
            case VARIABLE_KIND.RENDER_TARGET_VIEW:
            case VARIABLE_KIND.DEPTH_STENCIL_VIEW:
                return {
                    /** @param {any[]} views @param {number} first */
                    SetViews(views, first){
                        views.forEach((view, index)=>{
                            const slot = shape.slots[own(first + index)];
                            if (!slot)
                            {
                                return;
                            }
                            view?.addRef?.();
                            slot.resource?.release?.();
                            slot.resource = view ?? null;
                        });
                        return S_OK;
                    },
                    /** @param {number} first @param {number} count */
                    GetViews: (first, count)=>Array.from({ length: count }, (_, index)=>{
                        const view = shape.slots[own(first + index)]?.resource ?? null;
                        view?.addRef?.();
                        return view;
                    }),
                };
            case VARIABLE_KIND.CONSTANT_BUFFER:
                return {
                    /**
                     * A buffer of the program's own, bound in place of the
                     * effect's, which the effect then leaves alone.
                     *
                     * @param {any} buffer
                     */
                    SetConstantBuffer(buffer){
                        const target = buffers.find(entry=>entry.shape === shape);
                        buffer?.addRef?.();
                        target.override?.release?.();
                        target.override = buffer ?? null;
                        return S_OK;
                    },
                    GetConstantBuffer(){
                        const target = buffers.find(entry=>entry.shape === shape);
                        const buffer = target.override ?? target.gpu ?? null;
                        buffer?.addRef?.();
                        return buffer;
                    },
                    textureBuffer: ()=>buffers.find(entry=>entry.shape === shape).fx.textureBuffer,
                };
            case VARIABLE_KIND.SHADER:
                return {
                    /**
                     * D3D10_EFFECT_SHADER_DESC of the shader at an index, a
                     * NULL one with no bytecode.
                     *
                     * @param {number} index
                     * @param {{ desc?: Record<string, any> } | null} out
                     */
                    GetShaderDesc(index, out){
                        const slot = flatSlot(shape, index);
                        if (!slot)
                        {
                            return E_FAIL;
                        }
                        return describeInto(out, ()=>{
                            /** @type {import('./effect.js').FxShader | null} */
                            const shader = slot.shader ?? null;
                            const signature = shader ? signatures.get(shader) : null;
                            const reflected = shader ? reflectionOf(shader) : null;
                            const whole = shader && !optimized ? shader : null;
                            return {
                                InputSignature: signature ? { at: signature.at } : null,
                                IsInline: Boolean(slot.inline),
                                Bytecode: whole ? { at: whole.at } : null,
                                BytecodeLength: whole ? whole.bytecode.length : 0,
                                SODecl: whole && whole.streamOutputAt >= 0
                                    ? { at: whole.streamOutputAt }
                                    : null,
                                NumInputSignatureEntries: whole ? reflected?.inputs.length ?? 0
                                    : 0,
                                NumOutputSignatureEntries: whole ? reflected?.outputs.length ?? 0
                                    : 0,
                            };
                        });
                    },
                    /**
                     * The shader of a stage, or D3DERR_INVALIDCALL when the
                     * one at that index is of another.
                     *
                     * @param {'vertex' | 'pixel' | 'geometry'} stage
                     * @param {number} index
                     */
                    GetShader(stage, index){
                        const slot = flatSlot(shape, index);
                        if (!slot)
                        {
                            return { hr: E_FAIL, shader: null };
                        }
                        if (slot.stage !== SHADER_STAGE[stage])
                        {
                            return { hr: D3DERR_INVALIDCALL, shader: null };
                        }
                        slot.made?.addRef?.();
                        return { hr: S_OK, shader: slot.made ?? null };
                    },
                    /**
                     * One element of a shader's input or output signature,
                     * its name an offset into the image; a NULL shader has
                     * none, D3DERR_INVALIDCALL.
                     *
                     * @param {'inputs' | 'outputs'} which
                     * @param {number} index @param {number} element
                     * @param {{ entry?: import('./reflection.js').ReflectedParameter } | null} out
                     */
                    GetSignatureElement(which, index, element, out){
                        const slot = flatSlot(shape, index);
                        if (!slot)
                        {
                            return E_FAIL;
                        }
                        const shader = slot.shader ?? null;
                        const reflected = shader ? reflectionOf(shader) : null;
                        if (!shader || !reflected)
                        {
                            return D3DERR_INVALIDCALL;
                        }
                        const entry = reflected[which][element];
                        if (!entry || !out)
                        {
                            return E_INVALIDARG;
                        }
                        out.entry = { ...entry, nameAt: shader.at + entry.nameAt };
                        return S_OK;
                    },
                };
            case VARIABLE_KIND.BLEND:
            case VARIABLE_KIND.DEPTH_STENCIL:
            case VARIABLE_KIND.RASTERIZER:
            case VARIABLE_KIND.SAMPLER:
                return {
                    /** @param {number} index */
                    GetState(index){
                        const slot = flatSlot(shape, index);
                        if (!slot)
                        {
                            return { hr: E_FAIL, state: null };
                        }
                        slot.made?.addRef?.();
                        return { hr: S_OK, state: slot.made ?? null };
                    },
                    /** @param {number} index @param {{ desc?: any } | null} out */
                    GetBackingStore(index, out){
                        const slot = flatSlot(shape, index);
                        if (!slot || !out)
                        {
                            return out ? E_FAIL : E_INVALIDARG;
                        }
                        out.desc = structuredClone(slot.desc);
                        return S_OK;
                    },
                };
            default:
                return {};
        }
    };

    /**
     * A numeric variable in a constant buffer, or a member or element of one.
     *
     * @param {{ name: EffectString, memberName: string, semantic: string | null,
     *           semanticAt: number, flags: number,
     *           fxAnnotations: import('./effect.js').FxAnnotation[],
     *           type: import('./effect.js').FxType, element: boolean, buffer: any,
     *           storage: { bytes: Uint8Array, at: number } }} spec
     * @returns {any}
     */
    const numericVariable = spec=>{
        const { type, storage } = spec;
        const isArray = type.elements > 0 && !spec.element;
        /** @type {any} */
        const variable = variableObject({
            kind: type.kind === 'struct' ? VARIABLE_KIND.VARIABLE : kindOf(type),
            name: spec.name,
            semantic: spec.semantic,
            semanticAt: spec.semanticAt,
            flags: spec.flags,
            bufferOffset: storage.at,
            explicitBindPoint: spec.flags & D3D10_EFFECT_VARIABLE.EXPLICIT_BIND_POINT
                ? storage.at
                : 0,
            type: ()=>(spec.element ? elementTypeOf(type) : typeOf(type)),
            fxType: type,
            fxAnnotations: spec.fxAnnotations,
            annotations: [],
            buffer: spec.buffer,
            storage,
            slots: null,
            slot: -1,
            members: type.kind === 'struct' && !isArray
                ? ()=>type.members.map(member=>numericVariable({
                    name: { at: member.nameAt }, memberName: member.name,
                    semantic: member.semantic, semanticAt: member.semanticAt, flags: 0,
                    fxAnnotations: [], type: member.type, element: false, buffer: spec.buffer,
                    storage: { bytes: storage.bytes, at: storage.at + member.bufferOffset },
                }))
                : null,
            element: isArray
                ? objectsOf(Array.from({ length: type.elements }), (_, index)=>numericVariable({
                    ...spec, flags: 0, fxAnnotations: [], element: true,
                    storage: { bytes: storage.bytes, at: storage.at + index * type.stride },
                }), INVALID.variables.variable)
                : null,
        });
        variable.shape.memberName = spec.memberName;
        return variable;
    };

    /**
     * An object variable, or one element of an array of them; the elements
     * share one set of slots, so what is set through an element is what the
     * array holds there.
     *
     * @param {import('./effect.js').FxObjectVariable} fx
     * @param {any[]} slots
     * @param {number} slot  -1 for the whole variable.
     * @returns {any}
     */
    const objectVariable = (fx, slots, slot)=>{
        const isArray = fx.type.elements > 0 && slot < 0;
        /** @type {any} */
        const variable = variableObject({
            kind: kindOf(fx.type),
            name: { at: fx.nameAt },
            semantic: fx.semantic,
            semanticAt: fx.semanticAt,
            flags: slot < 0 ? (fx.bindPoint >= 0 ? D3D10_EFFECT_VARIABLE.EXPLICIT_BIND_POINT : 0)
                | pooled : 0,
            bufferOffset: 0,
            explicitBindPoint: slot < 0 && fx.bindPoint >= 0 ? fx.bindPoint : 0,
            type: ()=>(slot >= 0 ? elementTypeOf(fx.type) : typeOf(fx.type)),
            fxType: fx.type,
            fxAnnotations: slot < 0 ? fx.annotations : [],
            annotations: [],
            buffer: null,
            storage: null,
            slots,
            slot,
            members: null,
            element: isArray
                ? objectsOf(slots, (_, index)=>objectVariable(fx, slots, index),
                    INVALID.variables.variable)
                : null,
        });
        variable.shape.memberName = fx.name;
        return variable;
    };

    /**
     * An annotation: a variable of its own, flagged as one, whose value
     * lives in its own few bytes.
     *
     * @param {import('./effect.js').FxAnnotation} fx
     * @returns {any}
     */
    const annotationVariable = fx=>{
        /** @type {any} */
        let variable;
        if (fx.type.kind === 'numeric')
        {
            const bytes = new Uint8Array(Math.max(fx.type.unpackedSize, 16));
            if (fx.value)
            {
                unpackInto(fx.type, fx.value, bytes, 0);
            }
            variable = numericVariable({
                name: { at: fx.nameAt }, memberName: fx.name, semantic: null, semanticAt: -1,
                flags: D3D10_EFFECT_VARIABLE.ANNOTATION | pooled, fxAnnotations: [],
                type: fx.type, element: false, buffer: null, storage: { bytes, at: 0 },
            });
        }
        else
        {
            const slots = (annotationStrings.get(fx) ?? fx.strings).map(at=>({ stringAt: at }));
            variable = objectVariable({
                name: fx.name, nameAt: fx.nameAt, semantic: null, semanticAt: -1, bindPoint: -1,
                type: fx.type, annotations: [], elements: slots,
            }, slots, -1);
            variable.shape.flags = D3D10_EFFECT_VARIABLE.ANNOTATION | pooled;
        }
        return variable;
    };

    // --- constant buffers ---

    const buffers = data.buffers.map(fx=>{
        const bytes = new Uint8Array(Math.ceil(Math.max(fx.size, 16) / 16) * 16);
        const packedSize = fx.variables.reduce((sum, variable)=>sum + variable.type.packedSize, 0);
        /** @type {any} */
        let buffer = null;
        const variables = fx.variables.map(variable=>{
            if (variable.defaultValue)
            {
                unpackInto(variable.type, variable.defaultValue, bytes, variable.bufferOffset);
            }
            return ()=>numericVariable({
                name: { at: variable.nameAt }, memberName: variable.name,
                semantic: variable.semantic, semanticAt: variable.semanticAt,
                flags: (variable.flags & D3D10_EFFECT_VARIABLE.EXPLICIT_BIND_POINT) | pooled,
                fxAnnotations: variable.annotations, type: variable.type, element: false,
                buffer, storage: { bytes, at: variable.bufferOffset },
            });
        });
        /** @type {any[] | null} */
        let memberVariables = null;
        const members = ()=>(memberVariables ??= variables.map(make=>make()));
        const cbufferType = typeObject({
            name: { text: fx.textureBuffer ? 'tbuffer' : 'cbuffer' },
            svc: D3D10_SVC.OBJECT,
            svt: fx.textureBuffer ? D3D10_SVT.TBUFFER : D3D10_SVT.CBUFFER,
            elements: 0, rows: 0, columns: 0, packedSize,
            unpackedSize: fx.size, stride: fx.size,
            members: fx.variables.map(variable=>({
                name: variable.name, nameAt: variable.nameAt, semantic: variable.semantic,
                semanticAt: variable.semanticAt, type: ()=>typeOf(variable.type),
            })),
        });
        buffer = variableObject({
            kind: VARIABLE_KIND.CONSTANT_BUFFER,
            name: { at: fx.nameAt },
            semantic: null,
            semanticAt: -1,
            flags: (fx.bindPoint >= 0 ? D3D10_EFFECT_VARIABLE.EXPLICIT_BIND_POINT : 0) | pooled,
            bufferOffset: 0,
            explicitBindPoint: fx.bindPoint >= 0 ? fx.bindPoint : 0,
            type: ()=>cbufferType,
            fxType: null,
            fxAnnotations: fx.annotations,
            annotations: [],
            buffer: null,
            storage: { bytes, at: 0 },
            slots: null,
            slot: -1,
            members,
            element: null,
        });
        buffer.shape.memberName = fx.name;
        buffer.fx = fx;
        buffer.bytes = bytes;
        buffer.variables = members;
        return buffer;
    });

    // --- what the effect makes on its device ---

    /**
     * Device objects the effect made, each holding its reference until the
     * effect's last release.
     *
     * @type {any[]}
     */
    const owned = [];

    for (const buffer of buffers)
    {
        /** @type {{ resource?: any }} */
        const out = {};
        const hr = device.CreateBuffer({
            ByteWidth: buffer.bytes.length, Usage: D3D10_USAGE.DEFAULT,
            BindFlags: D3D10_BIND.CONSTANT_BUFFER, CPUAccessFlags: 0, MiscFlags: 0,
        }, null, out);
        buffer.gpu = hr === S_OK ? out.resource : null;
        if (buffer.gpu)
        {
            owned.push(buffer.gpu);
        }
        buffer.dirty = true;
        // What a shader that reads it is bound to, uploaded first if it
        // changed: a child effect binds its pool's buffers through this.
        buffer.uploaded = ()=>{
            if (buffer.override)
            {
                return buffer.override;
            }
            upload(buffer);
            return buffer.gpu;
        };
    }

    /** @type {WeakMap<object, import('./reflection.js').ShaderReflection | null>} */
    const reflections = new WeakMap();
    /** @param {import('./effect.js').FxShader} shader */
    const reflectionOf = shader=>{
        if (!reflections.has(shader))
        {
            reflections.set(shader, reflectShader(shader.bytecode));
        }
        return reflections.get(shader) ?? null;
    };

    /**
     * Each shader's input signature, cut out of it into a container of its
     * own as the runtime hands one out, laid after the unstructured block in
     * the effect's image. Every shader is made with the effect, so the image
     * is whole before anyone copies it.
     */
    const imageBase = Math.ceil(data.unstructured.length / 4) * 4;
    /** @type {Uint8Array[]} */
    const appendix = [];
    let imageLength = imageBase;
    /** @type {Map<import('./effect.js').FxShader, { at: number, size: number } | null>} */
    const signatures = new Map();
    /** @param {import('./effect.js').FxShader} shader */
    const cutSignature = shader=>{
        if (signatures.has(shader))
        {
            return;
        }
        const bytes = containerOf(shader.bytecode, ['ISGN']);
        signatures.set(shader, bytes ? { at: imageLength, size: bytes.length } : null);
        if (bytes)
        {
            appendix.push(bytes);
            imageLength += Math.ceil(bytes.length / 4) * 4;
        }
    };

    /**
     * A string of the unstructured block copied into the image, its own:
     * fxc writes a string once however many annotations or variables hold
     * it, and the runtime hands each holder a pointer of its own (Wine's
     * test_effect_constant_buffer_type).
     *
     * @param {number} at @returns {number}  where the copy lies
     */
    const ownString = at=>{
        const source = data.unstructured;
        let end = at;
        while (end < source.length && source[end] !== 0)
        {
            end++;
        }
        const bytes = source.slice(at, Math.min(end + 1, source.length));
        const placed = imageLength;
        appendix.push(bytes);
        imageLength += Math.ceil(bytes.length / 4) * 4;
        return placed;
    };
    /** Each annotation's strings, copied. @type {Map<import('./effect.js').FxAnnotation, number[]>} */
    const annotationStrings = new Map();
    for (const annotation of [
        ...data.buffers.flatMap(buffer=>[...buffer.annotations,
            ...buffer.variables.flatMap(variable=>variable.annotations)]),
        ...data.objects.flatMap(object=>object.annotations),
        ...data.techniques.flatMap(technique=>[...technique.annotations,
            ...technique.passes.flatMap(pass=>pass.annotations)]),
    ])
    {
        if (annotation.strings.length > 0)
        {
            annotationStrings.set(annotation, annotation.strings.map(ownString));
        }
    }

    /**
     * A shader an effect holds, made on the device when the effect is. A
     * geometry shader built with stream output is made without it, which the
     * device could not honour, and says so.
     *
     * @param {string} stage  'vertexshader', 'pixelshader' or 'geometryshader'.
     * @param {import('./effect.js').FxShader | null} shader
     * @param {boolean} streamOutput
     */
    const makeShader = (stage, shader, streamOutput)=>{
        if (!shader)
        {
            return null;
        }
        cutSignature(shader);
        if (streamOutput || shader.streamOutput)
        {
            report('an effect\'s geometry shader with stream output is made without it: nothing'
                + ' here writes a stream-output buffer');
        }
        /** @type {{ shader?: any }} */
        const out = {};
        const method = stage === 'vertexshader'
            ? 'CreateVertexShader'
            : stage === 'pixelshader' ? 'CreatePixelShader' : 'CreateGeometryShader';
        if (device[method](shader.bytecode, out) !== S_OK || !out.shader)
        {
            report(`an effect's ${stage} could not be made on the device; it is set as none`);
            return null;
        }
        owned.push(out.shader);
        return out.shader;
    };

    /** @type {Record<string, { block: 'blend' | 'depthstencil' | 'rasterizer' | 'sampler', create: string }>} */
    const STATE_BLOCKS = {
        [VARIABLE_KIND.BLEND]: { block: 'blend', create: 'CreateBlendState' },
        [VARIABLE_KIND.DEPTH_STENCIL]: { block: 'depthstencil', create: 'CreateDepthStencilState' },
        [VARIABLE_KIND.RASTERIZER]: { block: 'rasterizer', create: 'CreateRasterizerState' },
        [VARIABLE_KIND.SAMPLER]: { block: 'sampler', create: 'CreateSamplerState' },
    };

    /**
     * Whether a state's field is given by what a variable holds now, or an
     * expression over it, rather than a constant.
     *
     * @param {import('./effect.js').FxAssignment} assignment
     */
    const dependent = assignment=>!assignment.constants && assignment.state !== SAMPLER_TEXTURE;

    /**
     * A state object whose fields follow the effect's variables: its
     * description is what they make of it when it is read, and the object is
     * made again when that changed (test_effect_value_expression's mutable
     * depth-stencil state).
     *
     * @param {any} slot
     * @param {{ block: 'blend' | 'depthstencil' | 'rasterizer' | 'sampler',
     *           create: string }} stateBlock
     */
    const stateNow = (slot, stateBlock)=>{
        /** @type {{ key: string, desc: any, made: any }} */
        const held = { key: '', desc: null, made: null };
        const refresh = ()=>{
            const desc = stateDesc(stateBlock.block, slot.assignments ?? [], report,
                (assignment, count)=>constantsOf(assignment, count));
            const key = JSON.stringify(desc);
            if (key !== held.key)
            {
                /** @type {{ state?: any }} */
                const out = {};
                const state = device[stateBlock.create](desc, out) === S_OK
                    ? out.state ?? null
                    : null;
                const at = owned.indexOf(held.made);
                if (held.made && at >= 0)
                {
                    owned.splice(at, 1);
                    held.made.release?.();
                }
                if (state)
                {
                    owned.push(state);
                }
                Object.assign(held, { key, desc, made: state });
            }
            return held;
        };
        Object.defineProperties(slot, {
            desc: { get: ()=>refresh().desc, enumerable: true },
            made: { get: ()=>refresh().made, enumerable: true },
        });
    };

    const objects = data.objects.map(fx=>{
        /** @type {any[]} */
        const slots = fx.elements.map(element=>(element.stringAt === undefined ? { ...element }
            : { ...element, stringAt: ownString(element.stringAt) }));
        const kind = kindOf(fx.type);
        const stateBlock = STATE_BLOCKS[kind];
        for (const slot of slots)
        {
            if (stateBlock && (slot.assignments ?? []).some(dependent))
            {
                stateNow(slot, stateBlock);
            }
            else if (stateBlock)
            {
                slot.desc = stateDesc(stateBlock.block, slot.assignments ?? [], report);
                /** @type {{ state?: any }} */
                const out = {};
                slot.made = device[stateBlock.create](slot.desc, out) === S_OK
                    ? out.state ?? null
                    : null;
                if (slot.made)
                {
                    owned.push(slot.made);
                }
            }
            else if (kind === VARIABLE_KIND.SHADER)
            {
                slot.stage = fx.type.object;
                slot.made = makeShader(/** @type {string} */ (fx.type.object), slot.shader ?? null,
                    fx.type.streamOutput);
            }
            if (flat[kind])
            {
                slot.flat = flat[kind].length;
                flat[kind].push(slot);
            }
        }
        return objectVariable(fx, slots, -1);
    });

    /** Every global variable, in the order GetVariableByIndex counts them. */
    const globals = ()=>[...buffers.flatMap(buffer=>buffer.variables()), ...objects];

    // --- techniques and passes ---

    /** @type {Map<string, any>} */
    const anonymousTypes = new Map();
    /** @param {string} stage 'vertexshader', 'pixelshader' or 'geometryshader' */
    const anonymousTypeOf = stage=>{
        let type = anonymousTypes.get(stage);
        if (!type)
        {
            type = typeObject({
                name: { text: stage }, svc: D3D10_SVC.OBJECT,
                svt: stage === 'vertexshader'
                    ? D3D10_SVT.VERTEXSHADER
                    : stage === 'pixelshader' ? D3D10_SVT.PIXELSHADER : D3D10_SVT.GEOMETRYSHADER,
                elements: 0, rows: 0, columns: 0, packedSize: 0, unpackedSize: 0, stride: 0,
                members: [],
            });
            anonymousTypes.set(stage, type);
        }
        return type;
    };
    /**
     * A shader a pass names without a variable -- compiled in place, or
     * NULL -- is a variable of its own named "$Anonymous". One compiled in
     * place counts among the effect's shaders after the global ones, in the
     * order the passes give them; NULL does not count, and is one variable
     * per stage however many passes assign it (Wine's
     * test_effect_local_shader).
     *
     * @param {string} stage
     * @param {import('./effect.js').FxShader | null} shader
     */
    const anonymousShader = (stage, shader)=>{
        /** @type {any} */
        const slot = { shader, stage, inline: shader !== null,
            made: makeShader(stage, shader, false) };
        if (shader)
        {
            slot.flat = flat.shader.length;
            flat.shader.push(slot);
        }
        /** @type {any} */
        const variable = variableObject({
            kind: VARIABLE_KIND.SHADER, name: { text: '$Anonymous' }, semantic: null,
            semanticAt: -1, flags: 0, bufferOffset: 0, explicitBindPoint: 0,
            type: ()=>anonymousTypeOf(stage), fxType: null, fxAnnotations: [], annotations: [],
            buffer: null, storage: null, slots: [slot], slot: 0, members: null, element: null,
        });
        variable.shape.memberName = '$Anonymous';
        variable.shape.stage = stage;
        return variable;
    };

    /** @type {Readonly<Record<number, string>>} */
    const STAGES = Object.freeze({
        [PASS_STATE.VERTEX_SHADER]: 'vertexshader',
        [PASS_STATE.PIXEL_SHADER]: 'pixelshader',
        [PASS_STATE.GEOMETRY_SHADER]: 'geometryshader',
    });

    /** @type {Map<string, any>} */
    const nullShaders = new Map();
    /** @param {string} stage */
    const nullShaderOf = stage=>{
        let variable = nullShaders.get(stage);
        if (!variable)
        {
            variable = anonymousShader(stage, null);
            nullShaders.set(stage, variable);
        }
        return variable;
    };
    /**
     * The shaders passes compile in place, made with the effect so that
     * their places among its shaders are those of the passes' order.
     *
     * @type {Map<import('./effect.js').FxAssignment, any>}
     */
    const inlineShaders = new Map();
    for (const technique of data.techniques)
    {
        for (const pass of technique.passes)
        {
            for (const assignment of pass.assignments)
            {
                const stage = STAGES[assignment.state];
                if (stage && assignment.kind === ASSIGNMENT.ANONYMOUS_SHADER && assignment.shader)
                {
                    inlineShaders.set(assignment, anonymousShader(stage, assignment.shader));
                }
            }
        }
    }

    /** @param {string} name */
    const variableNamed = name=>[...globals(), ...sharedVariables]
        .find(variable=>variable.shape.memberName === name)
        ?? null;

    /**
     * The dwords a numeric variable holds from a component on, as the
     * constants an assignment would have given: its type decides how they
     * read.
     *
     * @param {any} variable
     * @param {number} from    In dwords.
     * @param {number} count
     * @returns {import('./effect.js').FxConstant[] | null}
     */
    const valuesOf = (variable, from, count)=>{
        const storage = variable?.shape.storage;
        const fxType = variable?.shape.fxType;
        if (!storage || !fxType || fxType.kind !== 'numeric')
        {
            return null;
        }
        const view = new DataView(storage.bytes.buffer, storage.bytes.byteOffset);
        const type = fxType.svt === D3D10_SVT.FLOAT
            ? CONSTANT_TYPE.FLOAT
            : fxType.svt === D3D10_SVT.BOOL
                ? CONSTANT_TYPE.BOOL
                : fxType.svt === D3D10_SVT.INT ? CONSTANT_TYPE.INT : CONSTANT_TYPE.UINT;
        /** @type {import('./effect.js').FxConstant[]} */
        const values = [];
        // A scalar stands for every component a state takes, as a vector's
        // components do one each (Wine's test_effect_dynamic_numeric_field:
        // a blend factor set from one float).
        const scalar = fxType.rows * fxType.columns <= 1;
        for (let index = 0; index < count; index++)
        {
            const at = storage.at + (from + (scalar ? 0 : index)) * 4;
            values.push({
                type, bits: at + 4 <= storage.bytes.length ? view.getUint32(at, true) : 0,
            });
        }
        return values;
    };

    /**
     * The words a numeric variable holds, as an expression reads them into
     * its registers: `words` of them, those past the variable's own zero.
     *
     * @param {string} name @param {number} words
     */
    const wordsOf = (name, words)=>{
        const variable = variableNamed(name);
        const storage = variable?.shape.storage;
        const fxType = variable?.shape.fxType;
        if (!storage || fxType?.kind !== 'numeric')
        {
            return null;
        }
        const out = new Uint32Array(words);
        const bytes = Math.min(words * 4, fxType.unpackedSize, storage.bytes.length - storage.at);
        const view = new DataView(storage.bytes.buffer, storage.bytes.byteOffset);
        for (let index = 0; (index + 1) * 4 <= bytes; index++)
        {
            out[index] = view.getUint32(storage.at + index * 4, true);
        }
        return out;
    };

    /** @type {Map<import('./effect.js').FxAssignment, import('./effect-expression.js').Expression | null>} */
    const expressions = new Map();
    /**
     * What an assignment's expression comes to over the variables' values
     * now, or null for one this runtime cannot read, said once.
     *
     * @param {import('./effect.js').FxAssignment} assignment
     */
    const evaluated = assignment=>{
        if (!expressions.has(assignment))
        {
            let parsed = null;
            try
            {
                parsed = assignment.expression ? parseExpression(assignment.expression) : null;
            }
            catch (e){
                if (!(e instanceof NotAnExpression))
                {
                    throw e;
                }
                report(`an expression of pass state 0x${assignment.state.toString(16)} is not`
                    + ` evaluated: ${e.message}`);
            }
            expressions.set(assignment, parsed);
        }
        const expression = expressions.get(assignment);
        if (!expression)
        {
            return null;
        }
        try
        {
            return runExpression(expression, wordsOf);
        }
        catch (e){
            if (!(e instanceof NotAnExpression))
            {
                throw e;
            }
            report(`an expression of pass state 0x${assignment.state.toString(16)} is not`
                + ` evaluated: ${e.message}`);
            expressions.set(assignment, null);
            return null;
        }
    };

    /**
     * The element of `elements` an assignment picks now: a constant index,
     * the value of an index variable, or what an index expression comes
     * to. One past the array picks the first, as Windows does
     * (test_effect_index_expression).
     *
     * @param {import('./effect.js').FxAssignment} assignment
     * @param {number} elements
     */
    const indexOf = (assignment, elements)=>{
        let index = assignment.element ?? 0;
        if (assignment.kind === ASSIGNMENT.VARIABLE_INDEX)
        {
            index = convert(valuesOf(variableNamed(assignment.indexVariable ?? ''), 0, 1)?.[0],
                'uint');
        }
        else if (assignment.kind === ASSIGNMENT.INDEX_EXPRESSION)
        {
            index = evaluated(assignment)?.[0] ?? 0;
        }
        return index < elements ? index : 0;
    };

    /**
     * The variable an assignment names and the element of it it picks now,
     * or null for an assignment that names none.
     *
     * @param {import('./effect.js').FxAssignment} assignment
     * @returns {{ named: any, index: number } | null}
     */
    const elementOf = assignment=>{
        switch (assignment.kind)
        {
            case ASSIGNMENT.VARIABLE:
            case ASSIGNMENT.CONSTANT_INDEX:
            case ASSIGNMENT.VARIABLE_INDEX:
            case ASSIGNMENT.INDEX_EXPRESSION: {
                const named = variableNamed(assignment.variable ?? '');
                if (!named)
                {
                    return null;
                }
                const elements = named.shape.slots?.length
                    ?? Math.max(1, named.shape.fxType?.elements ?? 0);
                return { named, index: indexOf(assignment, elements) };
            }
            default:
                return null;
        }
    };

    /**
     * The constants an assignment comes to now: its own, those its numeric
     * variable holds, or what its expression computes.
     *
     * @param {import('./effect.js').FxAssignment} assignment
     * @param {number} count
     * @returns {import('./effect.js').FxConstant[] | null}
     */
    const constantsOf = (assignment, count)=>{
        if (assignment.kind === ASSIGNMENT.CONSTANT)
        {
            return assignment.constants ?? null;
        }
        if (assignment.kind === ASSIGNMENT.VALUE_EXPRESSION)
        {
            const words = evaluated(assignment);
            return words
                ? Array.from({ length: count }, (_, index)=>({
                    type: CONSTANT_TYPE.AS_TAKEN, bits: words[index] ?? 0,
                }))
                : null;
        }
        const picked = elementOf(assignment);
        const fxType = picked?.named.shape.fxType;
        if (!picked || fxType?.kind !== 'numeric')
        {
            report(`a pass state 0x${assignment.state.toString(16)} names no numeric variable;`
                + ' it is not set');
            return null;
        }
        // A constant index into numeric data is the dword it starts at
        // (`fv1_a[1]` is 4); an index computed now counts elements.
        return valuesOf(picked.named, assignment.kind === ASSIGNMENT.CONSTANT_INDEX
            ? assignment.element ?? 0
            : picked.index * (fxType.stride / 4), count);
    };

    /**
     * @param {import('./effect.js').FxConstant | undefined} constant
     * @param {'float' | 'uint'} as
     */
    const convert = (constant, as)=>{
        if (!constant)
        {
            return 0;
        }
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, constant.bits, true);
        if (constant.type === CONSTANT_TYPE.AS_TAKEN)
        {
            return as === 'float' ? view.getFloat32(0, true) : constant.bits >>> 0;
        }
        const value = constant.type === CONSTANT_TYPE.FLOAT
            ? view.getFloat32(0, true)
            : constant.type === CONSTANT_TYPE.INT ? view.getInt32(0, true) : constant.bits;
        return as === 'float' ? Math.fround(value) : (Math.trunc(value) >>> 0);
    };

    /**
     * A constant buffer's bytes onto its GPU buffer, when they changed.
     *
     * @param {any} buffer
     */
    const upload = buffer=>{
        if (buffer.dirty && buffer.gpu)
        {
            device.UpdateSubresource(buffer.gpu, 0, null, buffer.bytes, 0, 0);
            buffer.dirty = false;
        }
    };

    /**
     * What a shader reads and at which slots, from its own resource
     * definitions.
     *
     * @param {import('./effect.js').FxShader} shader
     */
    const bindingsOf = shader=>reflectionOf(shader)?.bindings ?? [];

    /** @param {import('./effect.js').FxPass} fx */
    const passObject = fx=>{
        const annotations = annotationsOf(objectsOf(fx.annotations, annotationVariable,
            INVALID.variables.variable), fx.annotations);
        /** @type {Map<number, { variable: any, index: number }>} */
        const shaders = new Map();
        /** @param {number} state */
        const shaderOf = state=>{
            let found = shaders.get(state);
            if (found)
            {
                return found;
            }
            const assignment = fx.assignments.find(entry=>entry.state === state);
            const stage = STAGES[state];
            found = { variable: INVALID.variables.shader, index: 0 };
            if (assignment?.kind === ASSIGNMENT.CONSTANT)
            {
                found = { variable: nullShaderOf(stage), index: 0 };
            }
            else if (assignment?.kind === ASSIGNMENT.ANONYMOUS_SHADER)
            {
                found = { variable: inlineShaders.get(assignment) ?? nullShaderOf(stage),
                    index: 0 };
            }
            else if (assignment)
            {
                const picked = elementOf(assignment);
                if (picked?.named.kind === VARIABLE_KIND.SHADER)
                {
                    found = { variable: picked.named, index: picked.index };
                }
                // What an index variable or expression picks follows the
                // variables, so it is looked at each time.
                if (assignment.kind === ASSIGNMENT.VARIABLE_INDEX
                    || assignment.kind === ASSIGNMENT.INDEX_EXPRESSION)
                {
                    return found;
                }
            }
            shaders.set(state, found);
            return found;
        };
        /** @param {number} state @param {number} count */
        const stateValues = (state, count)=>{
            const assignment = fx.assignments.find(entry=>entry.state === state);
            return assignment ? constantsOf(assignment, count) : null;
        };
        /**
         * The state object an assignment names: a state variable's element,
         * or none for NULL. Undefined for what cannot be evaluated, which is
         * then left as it is on the device.
         *
         * @param {import('./effect.js').FxAssignment} assignment
         * @param {string} kind
         */
        const stateOf = (assignment, kind)=>{
            if (assignment.kind === ASSIGNMENT.CONSTANT)
            {
                return null;
            }
            const picked = elementOf(assignment);
            if (picked?.named.kind === kind)
            {
                return picked.named.shape.slots[picked.index]?.made ?? null;
            }
            report(`a pass's ${kind} state naming no ${kind} variable is not applied`);
            return undefined;
        };

        /** @type {Readonly<Record<number, string>>} */
        const STAGE_OF = Object.freeze({
            [PASS_STATE.VERTEX_SHADER]: 'VS', [PASS_STATE.PIXEL_SHADER]: 'PS',
            [PASS_STATE.GEOMETRY_SHADER]: 'GS',
        });

        /** @param {number} state @returns {{ made: any, shader: import('./effect.js').FxShader | null } | null} */
        const shaderSlotOf = state=>{
            const { variable, index } = shaderOf(state);
            if (variable.invalid)
            {
                return null;
            }
            const slots = variable.shape.slots;
            return slots[variable.shape.slot >= 0 ? variable.shape.slot : index] ?? null;
        };

        /**
         * What a shader reads, bound where its bindings say: the effect's
         * constant buffer of that name, uploaded first if it changed, and the
         * resources and samplers its variables of those names hold.
         *
         * @param {string} stage  'VS', 'GS' or 'PS'.
         * @param {import('./effect.js').FxShader} shader
         */
        const bindFor = (stage, shader)=>{
            /**
             * The view a sampler's Texture state names, or null for NULL or none.
             *
             * @param {any} slot
             */
            const samplerTexture = slot=>{
                const assignment = (slot?.assignments ?? [])
                    .find((/** @type {any} */ entry)=>entry.state === SAMPLER_TEXTURE);
                const picked = assignment ? elementOf(assignment) : null;
                return picked?.named.kind === VARIABLE_KIND.SHADER_RESOURCE
                    ? picked.named.shape.slots[picked.index]?.resource ?? null
                    : null;
            };
            for (const binding of bindingsOf(shader))
            {
                if (binding.type === SHADER_INPUT.CBUFFER)
                {
                    const buffer = [...buffers, ...sharedBuffers]
                        .find(entry=>entry.shape.memberName === binding.name);
                    const bound = buffer?.uploaded?.();
                    if (bound)
                    {
                        device[`${stage}SetConstantBuffers`](binding.bindPoint, [bound]);
                    }
                    continue;
                }
                const named = variableNamed(binding.name);
                const slots = named?.shape.slots ?? [];
                const count = Math.max(1, binding.bindCount);
                if (binding.type === SHADER_INPUT.TEXTURE
                    && named?.kind === VARIABLE_KIND.SHADER_RESOURCE)
                {
                    device[`${stage}SetShaderResources`](binding.bindPoint,
                        Array.from({ length: count }, (_, index)=>slots[index]?.resource ?? null));
                }
                else if (binding.type === SHADER_INPUT.TEXTURE
                    && named?.kind === VARIABLE_KIND.SAMPLER)
                {
                    // A shader compiled from Direct3D 9's tex2D reads the
                    // texture its sampler's Texture state names, NULL
                    // included (Wine's test_effect_state_groups).
                    device[`${stage}SetShaderResources`](binding.bindPoint,
                        Array.from({ length: count }, (_, index)=>samplerTexture(slots[index])));
                }
                else if (binding.type === SHADER_INPUT.SAMPLER
                    && named?.kind === VARIABLE_KIND.SAMPLER)
                {
                    device[`${stage}SetSamplers`](binding.bindPoint,
                        Array.from({ length: count }, (_, index)=>slots[index]?.made ?? null));
                }
                else if (binding.type === SHADER_INPUT.TBUFFER)
                {
                    report('a texture buffer an effect\'s shader reads is not bound');
                }
            }
        };

        /** @param {number} state */
        const uintOf = state=>convert(stateValues(state, 1)?.[0], 'uint');

        /** @param {Uint8Array | null} mask */
        const computeMask = mask=>{
            if (!mask)
            {
                return E_INVALIDARG;
            }
            for (const assignment of fx.assignments)
            {
                const whole = MASK_OF_STATE[assignment.state];
                if (whole !== undefined)
                {
                    stateBlockMask.EnableCapture(mask, whole, 0, 1);
                }
                const stage = STAGE_OF[assignment.state];
                const shader = stage ? shaderSlotOf(assignment.state)?.shader : null;
                if (!stage || !shader)
                {
                    continue;
                }
                for (const binding of bindingsOf(shader))
                {
                    const type = MASK_OF_BINDING[stage][binding.type];
                    if (type !== undefined)
                    {
                        stateBlockMask.EnableCapture(mask, type, binding.bindPoint,
                            Math.max(1, binding.bindCount));
                    }
                }
            }
            return S_OK;
        };

        /** The vertex shader's input signature, a container of its own. */
        const inputSignature = ()=>{
            const { variable, index } = shaderOf(PASS_STATE.VERTEX_SHADER);
            const slots = variable.shape?.slots;
            const shader = slots ? slots[variable.shape.slot >= 0 ? variable.shape.slot : index]
                ?.shader : null;
            return shader ? signatures.get(shader) ?? null : null;
        };
        return kept({
            invalid: false,
            owner: self,
            fx,
            IsValid: ()=>true,
            /** @param {{ desc?: Record<string, any> } | null} out */
            GetDesc: out=>describeInto(out, ()=>{
                const signature = inputSignature();
                const factor = stateValues(PASS_STATE.BLEND_FACTOR, 4);
                return {
                    Name: optimized ? null : { at: fx.nameAt },
                    Annotations: annotations.count(),
                    IAInputSignature: signature ? { at: signature.at } : null,
                    IAInputSignatureSize: signature ? signature.size : 0,
                    StencilRef: convert(stateValues(PASS_STATE.STENCIL_REF, 1)?.[0], 'uint'),
                    SampleMask: convert(stateValues(PASS_STATE.SAMPLE_MASK, 1)?.[0], 'uint'),
                    BlendFactor: [0, 1, 2, 3].map(index=>convert(factor?.[index], 'float')),
                };
            }),
            /**
             * @param {number} state  PASS_STATE's VERTEX_SHADER, PIXEL_SHADER or GEOMETRY_SHADER.
             * @param {{ desc?: { variable: any, index: number } } | null} out
             */
            GetShaderDesc: (state, out)=>{
                if (!out)
                {
                    return E_INVALIDARG;
                }
                out.desc = shaderOf(state);
                return S_OK;
            },
            GetAnnotationByIndex: annotations.byIndex,
            GetAnnotationByName: annotations.byName,
            /**
             * Sets what the pass assigns, in its order, and binds what each
             * shader it sets reads; what it does not assign is left as it is.
             *
             * @param {number} flags  None are defined.
             */
            Apply(flags){
                void flags;
                for (const assignment of fx.assignments)
                {
                    switch (assignment.state)
                    {
                        case PASS_STATE.RASTERIZER: {
                            const state = stateOf(assignment, VARIABLE_KIND.RASTERIZER);
                            if (state !== undefined)
                            {
                                device.RSSetState(state);
                            }
                            break;
                        }
                        case PASS_STATE.DEPTH_STENCIL: {
                            const state = stateOf(assignment, VARIABLE_KIND.DEPTH_STENCIL);
                            if (state !== undefined)
                            {
                                device.OMSetDepthStencilState(state,
                                    uintOf(PASS_STATE.STENCIL_REF));
                            }
                            break;
                        }
                        case PASS_STATE.BLEND: {
                            const state = stateOf(assignment, VARIABLE_KIND.BLEND);
                            if (state !== undefined)
                            {
                                const factor = stateValues(PASS_STATE.BLEND_FACTOR, 4);
                                device.OMSetBlendState(state,
                                    [0, 1, 2, 3].map(index=>convert(factor?.[index], 'float')),
                                    uintOf(PASS_STATE.SAMPLE_MASK));
                            }
                            break;
                        }
                        case PASS_STATE.VERTEX_SHADER:
                        case PASS_STATE.PIXEL_SHADER:
                        case PASS_STATE.GEOMETRY_SHADER: {
                            const stage = STAGE_OF[assignment.state];
                            const { variable } = shaderOf(assignment.state);
                            // A pass that assigns NULL takes the stage's
                            // shader away (Wine's test_effect_local_shader).
                            if (variable.invalid)
                            {
                                device[`${stage}SetShader`](null);
                                break;
                            }
                            const slot = shaderSlotOf(assignment.state);
                            device[`${stage}SetShader`](slot?.made ?? null);
                            if (slot?.shader)
                            {
                                bindFor(stage, slot.shader);
                            }
                            break;
                        }
                        case PASS_STATE.STENCIL_REF:
                        case PASS_STATE.BLEND_FACTOR:
                        case PASS_STATE.SAMPLE_MASK:
                            break;
                        default:
                            report(`a pass state 0x${assignment.state.toString(16)} is not`
                                + ' applied');
                    }
                }
                return S_OK;
            },
            ComputeStateBlockMask: computeMask,
        });
    };

    const techniques = data.techniques.map(fx=>{
        const annotations = annotationsOf(objectsOf(fx.annotations, annotationVariable,
            INVALID.variables.variable), fx.annotations);
        const passAt = objectsOf(fx.passes, passObject, INVALID.pass);
        return kept({
            invalid: false,
            owner: self,
            fx,
            IsValid: ()=>true,
            /** @param {{ desc?: Record<string, any> } | null} out */
            GetDesc: out=>describeInto(out, ()=>({
                Name: optimized ? null : { at: fx.nameAt }, Passes: fx.passes.length,
                Annotations: annotations.count(),
            })),
            GetAnnotationByIndex: annotations.byIndex,
            GetAnnotationByName: annotations.byName,
            GetPassByIndex: passAt,
            /** @param {string | null} name */
            GetPassByName: name=>(optimized ? INVALID.pass
                : passAt(fx.passes.findIndex(pass=>pass.name === name))),
            /** @param {Uint8Array | null} mask */
            ComputeStateBlockMask: mask=>{
                if (!mask)
                {
                    return E_INVALIDARG;
                }
                fx.passes.forEach((_, index)=>passAt(index).ComputeStateBlockMask(mask));
                return S_OK;
            },
        });
    });

    // --- the effect ---

    // A child effect's own buffers and variables come first, then the ones
    // it shares with its pool (Wine's test_effect_pool).
    const allBuffers = ()=>[...buffers, ...sharedBuffers];
    const allVariables = ()=>[...globals(), ...sharedVariables];
    /** @param {number} index */
    const bufferAt = index=>{
        const list = allBuffers();
        return index >= 0 && index < list.length ? list[index] : INVALID.variables.constantBuffer;
    };
    /** @param {number} index */
    const variableAt = index=>{
        const list = allVariables();
        return index >= 0 && index < list.length ? list[index] : INVALID.variables.variable;
    };
    /** @param {number} index */
    const techniqueAt = index=>(index >= 0 && index < techniques.length
        ? techniques[index]
        : INVALID.technique);

    device.addRef?.();
    pool?.addRef?.();
    return attachCom(Object.assign(self, {
        data,
        // QueryInterface answers ID3D10EffectPool alone, IUnknown and
        // ID3D10Effect not: a pool's effect is the pool, and an effect that
        // is no pool answers with itself (Wine's test_effect_pool, as
        // Windows answers).
        /** @param {string} id */
        answers: id=>id === IID.ID3D10EffectPool,
        IsValid: ()=>true,
        IsPool: ()=>services.isPool === true,
        /** @param {{ device?: any }} out */
        GetDevice(out){
            device.addRef?.();
            out.device = device;
            return S_OK;
        },
        /** @param {{ desc?: Record<string, any> } | null} out */
        GetDesc: out=>describeInto(out, ()=>({
            IsChildEffect: pool !== null,
            ConstantBuffers: buffers.length,
            SharedConstantBuffers: sharedBuffers.length,
            GlobalVariables: globals().length,
            SharedGlobalVariables: sharedVariables.length,
            Techniques: techniques.length,
        })),
        GetConstantBufferByIndex: bufferAt,
        /** @param {string | null} name */
        GetConstantBufferByName: name=>bufferAt(allBuffers().findIndex(buffer=>
            buffer.shape.memberName === name)),
        GetVariableByIndex: variableAt,
        /** @param {string | null} name */
        GetVariableByName: name=>variableNamed(name ?? '\0') ?? INVALID.variables.variable,
        /** @param {string | null} semantic */
        GetVariableBySemantic: semantic=>allVariables().find(variable=>
            sameSemantic(variable.shape.semantic, semantic)) ?? INVALID.variables.variable,
        GetTechniqueByIndex: techniqueAt,
        /** @param {string | null} name */
        GetTechniqueByName: name=>(optimized ? INVALID.technique
            : techniqueAt(techniques.findIndex(technique=>technique.fx.name === name))),
        Optimize: ()=>{
            optimized = true;
            return S_OK;
        },
        IsOptimized: ()=>optimized,
        /** Every object made for the effect so far, not counting the invalid ones. */
        children: ()=>[...made],
        /** What every `{ at }` the effect hands out is an offset into. */
        image: ()=>{
            const bytes = new Uint8Array(imageLength);
            bytes.set(data.unstructured);
            let at = imageBase;
            for (const part of appendix)
            {
                bytes.set(part, at);
                at += Math.ceil(part.length / 4) * 4;
            }
            return bytes;
        },
        /** The constant buffers, with their bytes. */
        buffers: ()=>buffers,
    }), {
        interfaces: [IID.ID3D10Effect, IID.ID3D10EffectPool],
        onLastRef: ()=>{
            for (const buffer of buffers)
            {
                buffer.override?.release?.();
            }
            for (const variable of objects)
            {
                for (const slot of variable.shape.slots)
                {
                    slot.resource?.release?.();
                }
            }
            for (const object of owned.splice(0))
            {
                object.release?.();
            }
            device.release?.();
            pool?.release?.();
            services.onLastRef?.();
        },
    });
}
