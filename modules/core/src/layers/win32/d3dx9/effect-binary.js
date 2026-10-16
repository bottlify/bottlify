/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A compiled effect (fx_2_0, what fxc /Tfx_2_0 writes and D3DXCreateEffect
 * takes in place of source) read into the same model `effect-model.js` builds
 * from HLSL, so `effect.js` makes the same objects of either.
 *
 * The layout: the tag, the offset of the effect's body from the end of the
 * header; then, in the body, the parameters, the techniques with their passes
 * and states, and last the objects' data -- the strings and shaders the
 * parameters own, and the "resources": for a state, its shader, the name of the
 * parameter it reads, or an expression. Every name, type and default is reached
 * by an offset from the start of the body.
 *
 * A state whose value is an expression fxc left to evaluate (FXLC) keeps the
 * expression, `preshader.js` evaluating it each time the state is applied.
 * What is not read, and said in the messages: a state choosing an element of
 * an array by an expression, an expression of an instruction D3DX does not
 * know; and a shader's preshader, the constants fxc computes on the CPU from
 * the parameters -- the shader is made without them.
 */

import { PC, PT, STATES } from './effect-model.js';
import { PreshaderError, readPreshader } from './preshader.js';

/** @typedef {import('./effect-model.js').EffectModel} EffectModel */
/** @typedef {import('./effect-model.js').ParamModel} ParamModel */
/** @typedef {import('./effect-model.js').StateModel} StateModel */
/** @typedef {import('./effect-model.js').ShaderModel} ShaderModel */
/** @typedef {import('./effect-model.js').Slot} Slot */

/** The tag a compiled effect starts with. */
export const FX_2_0 = 0xfeff0901;

/** A comment token's own tag; CTAB and PRES are the comments a shader may carry. */
const CTAB = 0x42415443;
const PRES = 0x53455250;

/**
 * The states, by the number a compiled effect gives them: the effect file's
 * name of each, which `STATES` resolves.
 */
const STATE_NAMES = [
    'ZEnable', 'FillMode', 'ShadeMode', 'ZWriteEnable', 'AlphaTestEnable', 'LastPixel',
    'SrcBlend', 'DestBlend', 'CullMode', 'ZFunc', 'AlphaRef', 'AlphaFunc', 'DitherEnable',
    'AlphaBlendEnable', 'FogEnable', 'SpecularEnable', 'FogColor', 'FogTableMode', 'FogStart',
    'FogEnd', 'FogDensity', 'RangeFogEnable', 'StencilEnable', 'StencilFail', 'StencilZFail',
    'StencilPass', 'StencilFunc', 'StencilRef', 'StencilMask', 'StencilWriteMask',
    'TextureFactor', 'Wrap0', 'Wrap1', 'Wrap2', 'Wrap3', 'Wrap4', 'Wrap5', 'Wrap6', 'Wrap7',
    'Wrap8', 'Wrap9', 'Wrap10', 'Wrap11', 'Wrap12', 'Wrap13', 'Wrap14', 'Wrap15', 'Clipping',
    'Lighting', 'Ambient', 'FogVertexMode', 'ColorVertex', 'LocalViewer', 'NormalizeNormals',
    'DiffuseMaterialSource', 'SpecularMaterialSource', 'AmbientMaterialSource',
    'EmissiveMaterialSource', 'VertexBlend', 'ClipPlaneEnable', 'PointSize', 'PointSize_Min',
    'PointSize_Max', 'PointSpriteEnable', 'PointScaleEnable', 'PointScale_A', 'PointScale_B',
    'PointScale_C', 'MultiSampleAntialias', 'MultiSampleMask', 'PatchEdgeStyle',
    'DebugMonitorToken', 'IndexedVertexBlendEnable', 'ColorWriteEnable', 'TweenFactor',
    'BlendOp', 'PositionDegree', 'NormalDegree', 'ScissorTestEnable', 'SlopeScaleDepthBias',
    'AntialiasedLineEnable', 'MinTessellationLevel', 'MaxTessellationLevel', 'AdaptiveTess_X',
    'AdaptiveTess_Y', 'AdaptiveTess_Z', 'AdaptiveTess_W', 'EnableAdaptiveTessellation',
    'TwoSidedStencilMode', 'CCW_StencilFail', 'CCW_StencilZFail', 'CCW_StencilPass',
    'CCW_StencilFunc', 'ColorWriteEnable1', 'ColorWriteEnable2', 'ColorWriteEnable3',
    'BlendFactor', 'SRGBWriteEnable', 'DepthBias', 'SeparateAlphaBlendEnable', 'SrcBlendAlpha',
    'DestBlendAlpha', 'BlendOpAlpha',
    'ColorOp', 'ColorArg0', 'ColorArg1', 'ColorArg2', 'AlphaOp', 'AlphaArg0', 'AlphaArg1',
    'AlphaArg2', 'ResultArg', 'BumpEnvMat00', 'BumpEnvMat01', 'BumpEnvMat10', 'BumpEnvMat11',
    'TexCoordIndex', 'BumpEnvLScale', 'BumpEnvLOffset', 'TextureTransformFlags', 'Constant',
    'NPatchMode', 'FVF', 'ProjectionTransform', 'ViewTransform', 'WorldTransform',
    'TextureTransform', 'MaterialDiffuse', 'MaterialAmbient', 'MaterialSpecular',
    'MaterialEmissive', 'MaterialPower', 'LightType', 'LightDiffuse', 'LightSpecular',
    'LightAmbient', 'LightPosition', 'LightDirection', 'LightRange', 'LightFalloff',
    'LightAttenuation0', 'LightAttenuation1', 'LightAttenuation2', 'LightTheta', 'LightPhi',
    'LightEnable', 'VertexShader', 'PixelShader', 'VertexShaderConstantF',
    'VertexShaderConstantB', 'VertexShaderConstantI', 'VertexShaderConstant',
    'VertexShaderConstant1', 'VertexShaderConstant2', 'VertexShaderConstant3',
    'VertexShaderConstant4', 'PixelShaderConstantF', 'PixelShaderConstantB',
    'PixelShaderConstantI', 'PixelShaderConstant', 'PixelShaderConstant1',
    'PixelShaderConstant2', 'PixelShaderConstant3', 'PixelShaderConstant4', 'Texture',
    'AddressU', 'AddressV', 'AddressW', 'BorderColor', 'MagFilter', 'MinFilter', 'MipFilter',
    'MipMapLodBias', 'MaxMipLevel', 'MaxAnisotropy', 'SRGBTexture', 'ElementIndex',
    'DMAPOffset', 'Sampler',
];

/** @param {number} type */
const ownsObject = type=>type === PT.STRING || (type >= PT.TEXTURE && type <= PT.TEXTURECUBE)
    || type === PT.PIXELSHADER || type === PT.VERTEXSHADER;
/** @param {number} type */
const isSamplerType = type=>type >= PT.SAMPLER && type <= PT.SAMPLERCUBE;

/**
 * A state as read, before the objects say where its value comes from.
 *
 * @typedef {{ model: StateModel, param: ParamModel, objectId: number, label: string }} RawState
 */

/**
 * Reads a compiled effect. Null with a message when it is not one or does not
 * hold together; a state or preshader this does not read is a warning.
 *
 * @param {Uint8Array} bytes
 * @returns {{ model: EffectModel | null, messages: string }}
 */
export function readCompiledEffect(bytes){
    /** @type {string[]} */
    const messages = [];
    try
    {
        return { model: read(bytes, messages), messages: messages.join('\n') };
    }
    catch (e){
        if (e instanceof RangeError || e instanceof FxError)
        {
            messages.push(`error: ${e.message}`);
            return { model: null, messages: messages.join('\n') };
        }
        throw e;
    }
}

class FxError extends Error {}

/**
 * @param {Uint8Array} bytes @param {string[]} messages
 * @returns {EffectModel}
 */
function read(bytes, messages){
    const whole = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (whole.getUint32(0, true) !== FX_2_0)
    {
        throw new FxError('not an fx_2_0 effect');
    }
    const base = 8;
    const view = new DataView(bytes.buffer, bytes.byteOffset + base, bytes.byteLength - base);
    const u32 = (/** @type {number} */ offset)=>view.getUint32(offset, true);
    let at = whole.getUint32(4, true);

    const next = ()=>{
        const value = u32(at);
        at += 4;
        return value;
    };
    /** A name at an offset: its length, then its bytes, the last a NUL. */
    const nameAt = (/** @type {number} */ offset)=>{
        const size = u32(offset);
        if (size === 0)
        {
            return null;
        }
        let text = '';
        for (let i = 0; i < size; i++)
        {
            const c = view.getUint8(offset + 4 + i);
            if (c === 0)
            {
                break;
            }
            text += String.fromCharCode(c);
        }
        return text;
    };

    /** @type {Map<number, { slot: Slot, param: ParamModel }[]>} what each object fills */
    const objectUsers = new Map();
    /** @type {Map<number, Uint8Array>} */
    const objectData = new Map();

    /**
     * A type at `cursor.at`: what D3DXPARAMETER_DESC describes, members and
     * elements and all.
     *
     * @param {{ at: number }} cursor @param {number} flags
     * @returns {ParamModel}
     */
    const typedef = (cursor, flags)=>{
        const take = ()=>{
            const value = u32(cursor.at);
            cursor.at += 4;
            return value;
        };
        const type = take();
        const cls = take();
        const name = nameAt(take()) ?? '';
        const semantic = nameAt(take());
        const elements = take();
        /** @type {ParamModel} */
        const param = { name, semantic, cls, type, rows: 0, columns: 0, elements, flags,
            bytes: 0, members: [], annotations: [], init: [], samplers: [], hlsl: null };
        if (cls === PC.VECTOR)
        {
            param.columns = take();
            param.rows = take();
        }
        else if (cls === PC.SCALAR || cls === PC.MATRIX_ROWS || cls === PC.MATRIX_COLUMNS)
        {
            param.rows = take();
            param.columns = take();
        }
        let memberCount = 0;
        if (cls === PC.STRUCT)
        {
            memberCount = take();
        }
        const one = cls === PC.OBJECT ? (ownsObject(type) ? 4 : 0) : 4 * param.rows * param.columns;
        /** @type {ParamModel[]} */
        const members = [];
        for (let i = 0; i < memberCount; i++)
        {
            members.push(typedef(cursor, flags));
        }
        const oneBytes = cls === PC.STRUCT ? members.reduce((sum, m)=>sum + m.bytes, 0) : one;
        if (elements > 0)
        {
            param.members = Array.from({ length: elements }, ()=>({ ...param, elements: 0,
                bytes: oneBytes, members: members.map(cloneType), annotations: [], init: [],
                samplers: [] }));
            param.bytes = oneBytes * elements;
        }
        else
        {
            param.members = members;
            param.bytes = oneBytes;
        }
        return param;
    };

    /**
     * Fills a parameter's default from the data at `cursor.at`: numbers in
     * place, an object's id, a sampler's states.
     *
     * @param {ParamModel} param @param {{ at: number }} cursor @param {RawState[]} states
     * @param {string} label
     */
    const value = (param, cursor, states, label)=>{
        if (param.elements > 0 || param.cls === PC.STRUCT)
        {
            for (const [i, member] of param.members.entries())
            {
                value(member, cursor, states, param.elements > 0 ? `${label}[${i}]`
                    : `${label}.${member.name}`);
            }
            param.init = param.members.flatMap(member=>member.init);
            param.samplers = param.members.flatMap(member=>member.samplers);
            return;
        }
        if (param.cls !== PC.OBJECT)
        {
            for (let i = 0; i < param.bytes; i += 4)
            {
                param.init.push({ word: u32(cursor.at) });
                cursor.at += 4;
            }
            return;
        }
        if (ownsObject(param.type))
        {
            const id = u32(cursor.at);
            cursor.at += 4;
            /** @type {Slot} */
            const slot = param.type === PT.STRING ? { string: '' }
                : param.type === PT.PIXELSHADER || param.type === PT.VERTEXSHADER
                    ? { shader: null } : { word: 0 };
            param.init.push(slot);
            const users = objectUsers.get(id) ?? [];
            users.push({ slot, param });
            objectUsers.set(id, users);
            return;
        }
        if (isSamplerType(param.type))
        {
            const count = u32(cursor.at);
            cursor.at += 4;
            /** @type {StateModel[]} */
            const list = [];
            for (let i = 0; i < count; i++)
            {
                const state = readState(cursor, `${label}`);
                list.push(state.model);
                states.push(state);
            }
            param.samplers = [list];
        }
    };

    /**
     * A state: its number, its index, its type and its value.
     *
     * @param {{ at: number }} cursor @param {string} label
     * @returns {RawState}
     */
    const readState = (cursor, label)=>{
        const operation = u32(cursor.at);
        const index = u32(cursor.at + 4);
        const typeAt = u32(cursor.at + 8);
        const valueAt = u32(cursor.at + 12);
        cursor.at += 16;
        const name = STATE_NAMES[operation];
        if (name === undefined)
        {
            throw new FxError(`state ${operation} of ${label} is not one D3DX knows`);
        }
        const entry = /** @type {NonNullable<ReturnType<typeof STATES.get>>} */ (
            STATES.get(name.toLowerCase()));
        const param = typedef({ at: typeAt }, 0);
        value(param, { at: valueAt }, [], label);
        const objectId = param.cls === PC.OBJECT && ownsObject(param.type)
            ? u32(valueAt) : -1;
        /** @type {StateModel} */
        const model = { name, kind: entry.kind, op: entry.op, index, value: entry.value,
            source: entry.kind === 'vs' || entry.kind === 'ps'
                ? { kind: 'shader', shader: null } : constOf(param) };
        return { model, param, objectId, label: `${label} ${name}` };
    };

    /**
     * Annotations: each a type and a value, by offset.
     *
     * @param {number} count
     * @returns {ParamModel[]}
     */
    const annotations = count=>{
        /** @type {ParamModel[]} */
        const list = [];
        for (let i = 0; i < count; i++)
        {
            const typeAt = next();
            const valueAt = next();
            const param = typedef({ at: typeAt }, 4);
            value(param, { at: valueAt }, [], param.name);
            list.push(param);
        }
        return list;
    };

    const paramCount = next();
    const techniqueCount = next();
    next();
    next();

    /** @type {ParamModel[]} */
    const parameters = [];
    /** @type {RawState[]} */
    const samplerStates = [];
    /** @type {RawState[][]} per parameter, its sampler states in order of the elements */
    const samplerStatesOf = [];
    for (let i = 0; i < paramCount; i++)
    {
        const typeAt = next();
        const valueAt = next();
        const flags = next();
        const annotationCount = next();
        const param = typedef({ at: typeAt }, flags);
        /** @type {RawState[]} */
        const own = [];
        value(param, { at: valueAt }, own, param.name);
        param.annotations = annotations(annotationCount);
        parameters.push(param);
        samplerStates.push(...own);
        samplerStatesOf.push(own);
    }

    /** @type {import('./effect-model.js').TechniqueModel[]} */
    const techniques = [];
    /** @type {RawState[][][]} */
    const passStates = [];
    for (let t = 0; t < techniqueCount; t++)
    {
        const name = nameAt(next());
        const annotationCount = next();
        const passCount = next();
        const technique = { name, annotations: annotations(annotationCount),
            passes: /** @type {import('./effect-model.js').PassModel[]} */ ([]) };
        /** @type {RawState[][]} */
        const perPass = [];
        for (let p = 0; p < passCount; p++)
        {
            const passName = nameAt(next());
            const passAnnotations = next();
            const stateCount = next();
            const list = annotations(passAnnotations);
            /** @type {RawState[]} */
            const raw = [];
            const cursor = { at };
            for (let s = 0; s < stateCount; s++)
            {
                raw.push(readState(cursor, `${name ?? ''}.${passName ?? ''}`));
            }
            at = cursor.at;
            technique.passes.push({ name: passName, annotations: list,
                states: raw.map(state=>state.model) });
            perPass.push(raw);
        }
        techniques.push(technique);
        passStates.push(perPass);
    }

    const stringCount = next();
    const resourceCount = next();
    /** @param {number} id */
    const copy = id=>{
        const size = next();
        const data = bytes.slice(base + at, base + at + size);
        if (data.length !== size)
        {
            throw new RangeError('an object runs past the end of the effect');
        }
        at += (size + 3) & ~3;
        objectData.set(id, data);
        return data;
    };
    for (let i = 0; i < stringCount; i++)
    {
        copy(next());
    }

    /** @type {ShaderModel[]} */
    const shaders = [];
    /** @param {Uint8Array} data @param {string} label */
    const addShader = (data, label)=>{
        const shader = shaderOf(data, label, messages);
        shaders.push(shader);
        return shaders.length - 1;
    };

    for (let i = 0; i < resourceCount; i++)
    {
        const techniqueIndex = next();
        const index = next();
        const element = next();
        const stateIndex = next();
        const usage = next();
        /** @type {RawState | undefined} */
        let state;
        if (techniqueIndex === 0xffffffff)
        {
            const param = parameters[index];
            const own = samplerStatesOf[index] ?? [];
            const lists = param?.samplers ?? [];
            const list = lists[element === 0xffffffff ? 0 : element] ?? [];
            const first = lists.slice(0, element === 0xffffffff ? 0 : element)
                .reduce((sum, l)=>sum + (l?.length ?? 0), 0);
            state = list[stateIndex] ? own[first + stateIndex] : undefined;
        }
        else
        {
            state = passStates[techniqueIndex]?.[index]?.[stateIndex];
        }
        if (!state)
        {
            throw new FxError(`resource ${i} names a state the effect does not have`);
        }
        const data = copy(state.objectId < 0 ? -1 - i : state.objectId);
        if (usage === 1)
        {
            state.model.source = { kind: 'param', path: cText(data) };
        }
        else if (usage === 0 && (state.param.type === PT.VERTEXSHADER
            || state.param.type === PT.PIXELSHADER))
        {
            state.model.source = { kind: 'shader', shader: addShader(data, state.label) };
        }
        else if (usage === 0)
        {
            try
            {
                const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
                state.model.source = { kind: 'expression', program: readPreshader(words),
                    type: state.param.type, count: Math.max(1, state.param.bytes >>> 2) };
            }
            catch (e){
                if (!(e instanceof PreshaderError))
                {
                    throw e;
                }
                messages.push(`warning: ${state.label}: an expression (FXLC) of ${e.message} is `
                    + 'not evaluated; the state is left out');
                state.model.name = '';
            }
        }
        else
        {
            messages.push(`warning: ${state.label}: an element chosen by an expression is not `
                + 'evaluated; the state is left out');
            state.model.name = '';
        }
    }

    for (const [id, users] of objectUsers)
    {
        const data = objectData.get(id);
        for (const { slot, param } of users)
        {
            if ('string' in slot)
            {
                slot.string = data ? cText(data) : '';
            }
            else if ('shader' in slot && data && data.length > 0)
            {
                slot.shader = addShader(data, param.name);
            }
        }
    }

    // A state left out is dropped from its list, as the source path leaves it out.
    for (const technique of techniques)
    {
        for (const pass of technique.passes)
        {
            pass.states = pass.states.filter(state=>state.name !== '');
        }
    }
    for (const state of samplerStates)
    {
        if (state.model.name === '')
        {
            for (const param of parameters)
            {
                prune(param);
            }
            break;
        }
    }
    return { parameters, techniques, functions: [], shaders };
}

/** @param {ParamModel} param */
function prune(param){
    param.samplers = param.samplers.map(list=>list && list.filter(state=>state.name !== ''));
    param.members.forEach(prune);
}

/** @param {ParamModel} param @returns {ParamModel} */
function cloneType(param){
    return { ...param, members: param.members.map(cloneType), annotations: [], init: [],
        samplers: [] };
}

/**
 * A state's value as its default gives it.
 *
 * @param {ParamModel} param
 * @returns {import('./effect-model.js').ValueSource}
 */
function constOf(param){
    return { kind: 'const', words: param.init.map(slot=>'word' in slot ? slot.word : 0) };
}

/** @param {Uint8Array} data */
function cText(data){
    const end = data.indexOf(0);
    let text = '';
    for (const c of end < 0 ? data : data.subarray(0, end))
    {
        text += String.fromCharCode(c);
    }
    return text;
}

/**
 * A shader's bytecode as the model holds a compiled one: its profile from the
 * version token, its constant table from its CTAB comment.
 *
 * @param {Uint8Array} data @param {string} label @param {string[]} messages
 * @returns {ShaderModel}
 */
function shaderOf(data, label, messages){
    const copy = new Uint8Array((data.length + 3) & ~3);
    copy.set(data);
    const tokens = new Uint32Array(copy.buffer);
    const version = tokens[0] ?? 0;
    const pixel = (version >>> 16) === 0xffff;
    const profile = `${pixel ? 'ps' : 'vs'}_${(version >>> 8) & 0xff}_${version & 0xff}`;
    /** @type {Uint8Array | null} */
    let constantTable = null;
    for (let i = 1; i < tokens.length && (tokens[i] & 0xffff) === 0xfffe;)
    {
        const length = (tokens[i] >>> 16) & 0x7fff;
        if (tokens[i + 1] === CTAB && !constantTable)
        {
            constantTable = copy.slice((i + 2) * 4, (i + 1 + length) * 4);
        }
        else if (tokens[i + 1] === PRES)
        {
            messages.push(`warning: ${label}: the shader's preshader is not run; the constants `
                + 'it computes are not set');
        }
        i += 1 + length;
    }
    return { profile, entry: '', pixel, tokens, constantTable, messages: '' };
}
