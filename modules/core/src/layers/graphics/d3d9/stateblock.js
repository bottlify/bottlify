/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * State blocks: a set of device state a program names once and applies later.
 *
 * A block is a record of *which* states it holds and *what* they held when
 * it was last captured. Which states is fixed when the block is made -- by
 * recording, or by asking for one of the three predefined sets -- and never
 * changes; what they hold changes on every Capture. Apply writes the record
 * back into the device and touches nothing outside it.
 *
 * The predefined sets are tables, because that is what they are: the
 * documentation assigns each render state to the pixel half or the vertex
 * half (a few, the fog distances and the shade mode, to both), and a program
 * that makes a pixel block and applies it expects the vertex half untouched.
 *
 * Recording is the other way a block gets its set, and in this version what
 * is recorded is *not* applied to the device: a program that sets the
 * lighting off between Begin and End reads it back as on, and only Apply
 * turns it off. The device owns that rule; this file only supplies the record
 * it writes into.
 */

import { D3DRS } from './constants.js';
import { IDENTITY } from '../d3d8/render.js';
import { D3DSAMP, D3DTSS9, SAMPLER_STATE_KEY } from './samplerstates.js';

/** D3DSTATEBLOCKTYPE. */
export const D3DSBT = Object.freeze({ ALL: 1, PIXELSTATE: 2, VERTEXSTATE: 3 });

/** The render states a pixel block holds, by name. */
export const PIXEL_RENDER_STATES = Object.freeze([
    'ZENABLE', 'FILLMODE', 'SHADEMODE', 'ZWRITEENABLE', 'ALPHATESTENABLE', 'LASTPIXEL',
    'SRCBLEND', 'DESTBLEND', 'ZFUNC', 'ALPHAREF', 'ALPHAFUNC', 'DITHERENABLE',
    'FOGSTART', 'FOGEND', 'FOGDENSITY', 'ALPHABLENDENABLE', 'DEPTHBIAS', 'STENCILENABLE',
    'STENCILFAIL', 'STENCILZFAIL', 'STENCILPASS', 'STENCILFUNC', 'STENCILREF', 'STENCILMASK',
    'STENCILWRITEMASK', 'TEXTUREFACTOR', 'WRAP0', 'WRAP1', 'WRAP2', 'WRAP3', 'WRAP4', 'WRAP5',
    'WRAP6', 'WRAP7', 'WRAP8', 'WRAP9', 'WRAP10', 'WRAP11', 'WRAP12', 'WRAP13', 'WRAP14',
    'WRAP15', 'COLORWRITEENABLE', 'BLENDOP', 'SCISSORTESTENABLE', 'SLOPESCALEDEPTHBIAS',
    'ANTIALIASEDLINEENABLE', 'TWOSIDEDSTENCILMODE', 'CCW_STENCILFAIL', 'CCW_STENCILZFAIL',
    'CCW_STENCILPASS', 'CCW_STENCILFUNC', 'COLORWRITEENABLE1', 'COLORWRITEENABLE2',
    'COLORWRITEENABLE3', 'BLENDFACTOR', 'SRGBWRITEENABLE', 'SEPARATEALPHABLENDENABLE',
    'SRCBLENDALPHA', 'DESTBLENDALPHA', 'BLENDOPALPHA',
]);

/** The render states a vertex block holds, by name. */
export const VERTEX_RENDER_STATES = Object.freeze([
    'CULLMODE', 'FOGCOLOR', 'FOGTABLEMODE', 'FOGSTART', 'FOGEND', 'FOGDENSITY',
    'RANGEFOGENABLE', 'AMBIENT', 'COLORVERTEX', 'FOGVERTEXMODE', 'CLIPPING', 'LIGHTING',
    'LOCALVIEWER', 'EMISSIVEMATERIALSOURCE', 'AMBIENTMATERIALSOURCE', 'DIFFUSEMATERIALSOURCE',
    'SPECULARMATERIALSOURCE', 'VERTEXBLEND', 'CLIPPLANEENABLE', 'POINTSIZE', 'POINTSIZE_MIN',
    'POINTSPRITEENABLE', 'POINTSCALEENABLE', 'POINTSCALE_A', 'POINTSCALE_B', 'POINTSCALE_C',
    'MULTISAMPLEANTIALIAS', 'MULTISAMPLEMASK', 'PATCHEDGESTYLE', 'POINTSIZE_MAX',
    'INDEXEDVERTEXBLENDENABLE', 'TWEENFACTOR', 'NORMALIZENORMALS', 'SPECULARENABLE',
    'SHADEMODE', 'FOGENABLE', 'POSITIONDEGREE', 'NORMALDEGREE', 'MINTESSELLATIONLEVEL',
    'MAXTESSELLATIONLEVEL', 'ADAPTIVETESS_X', 'ADAPTIVETESS_Y', 'ADAPTIVETESS_Z',
    'ADAPTIVETESS_W', 'ENABLEADAPTIVETESSELLATION',
]);

/** @param {readonly string[]} names @returns {Set<number>} */
const statesNamed = names=>new Set(names.map(name=>{
    const state = D3DRS[/** @type {keyof typeof D3DRS} */ (name)];
    if (state === undefined)
    {
        throw new Error(`graphics/d3d9: ${name} is not a render state`);
    }
    return state;
}));

const PIXEL_STATES = statesNamed(PIXEL_RENDER_STATES);
const VERTEX_STATES = statesNamed(VERTEX_RENDER_STATES);

/** How many texture stages and how many samplers a block walks. */
const STAGES = 8;
const SAMPLERS = 16;
/** The four vertex samplers, numbered from D3DVERTEXTEXTURESAMPLER0. */
const VERTEX_SAMPLER_FIRST = 257;
const VERTEX_SAMPLER_COUNT = 4;

/**
 * @typedef {Object} StateBlockRecord
 *     Everything a block can hold. A map with no entry, or a field left
 *     undefined, is a state the block does not hold and Apply leaves alone.
 * @property {Map<number, number>} renderStates
 * @property {Map<number, number>} stageStates    Keyed by (stage << 8) | type.
 * @property {Map<number, number>} samplerStates  Keyed by (sampler << 8) | type, in D3DSAMP.
 * @property {Map<number, any>} textures           Per stage; null means "nothing bound".
 * @property {Map<number, Float32Array>} transforms
 * @property {Map<number, { light: any, enabled: boolean }>} lights
 * @property {Map<number, Float32Array>} vertexConstantsF   Per register, four floats.
 * @property {Map<number, Int32Array>} vertexConstantsI
 * @property {Map<number, number>} vertexConstantsB
 * @property {Map<number, Float32Array>} pixelConstantsF
 * @property {Map<number, Int32Array>} pixelConstantsI
 * @property {Map<number, number>} pixelConstantsB
 * @property {Map<number, { buffer: any, offset: number, stride: number }>} streams
 * @property {Map<number, number>} streamFrequencies
 * @property {Map<number, Float32Array>} clipPlanes
 * @property {any} [material]
 * @property {any} [viewport]
 * @property {any} [scissor]
 * @property {{ declaration: any, fvf: number }} [vertexDeclaration]
 * @property {any} [vertexShader]       null when the block holds "no shader".
 * @property {any} [pixelShader]
 * @property {any} [indices]
 * @property {number} [nPatchMode]
 */

/** @returns {StateBlockRecord} a record holding nothing yet */
export function emptyRecord(){
    return {
        renderStates: new Map(),
        stageStates: new Map(),
        samplerStates: new Map(),
        textures: new Map(),
        transforms: new Map(),
        lights: new Map(),
        vertexConstantsF: new Map(),
        vertexConstantsI: new Map(),
        vertexConstantsB: new Map(),
        pixelConstantsF: new Map(),
        pixelConstantsI: new Map(),
        pixelConstantsB: new Map(),
        streams: new Map(),
        streamFrequencies: new Map(),
        clipPlanes: new Map(),
    };
}

/**
 * @typedef {Object} StateView
 *     The device's state, as a block reads and writes it. Every member is
 *     live; the block never keeps one of these.
 * @property {Map<number, number>} renderStates
 * @property {(stage: number) => Map<number, number>} stageStates
 * @property {Map<number, any>} textures
 * @property {Map<number, Float32Array>} transforms
 * @property {Map<number, { light: any, enabled: boolean }>} lights
 * @property {() => void} lightsChanged
 * @property {() => any} defaultLight   What enabling an unwritten light brings into being.
 * @property {import('./shader.js').ConstantFile} vertexConstants
 * @property {import('./shader.js').ConstantFile} pixelConstants
 * @property {Map<number, { buffer: any, offset: number, stride: number }>} streams
 * @property {Map<number, number>} streamFrequencies
 * @property {Map<number, Float32Array>} clipPlanes
 * @property {number} maxClipPlanes
 * @property {any} material
 * @property {any} viewport
 * @property {any} scissor
 * @property {{ declaration: any, fvf: number }} vertexDeclaration
 * @property {any} vertexShader
 * @property {any} pixelShader
 * @property {any} indices
 * @property {number} nPatchMode
 */

/** @param {any} light */
const copyLight = light=>({ ...light });

/**
 * Names every state of the given kind into the record, at its current value.
 *
 * @param {StateBlockRecord} record
 * @param {number} type   D3DSBT
 * @param {StateView} view
 */
export function fillRecord(record, type, view){
    const pixel = type !== D3DSBT.VERTEXSTATE;
    const vertex = type !== D3DSBT.PIXELSTATE;
    const all = type === D3DSBT.ALL;

    for (const state of view.renderStates.keys())
    {
        if ((pixel && PIXEL_STATES.has(state)) || (vertex && VERTEX_STATES.has(state)))
        {
            record.renderStates.set(state, 0);
        }
    }
    if (pixel)
    {
        for (let stage = 0; stage < STAGES; stage++)
        {
            for (const state of Object.values(D3DTSS9))
            {
                record.stageStates.set((stage << 8) | state, 0);
            }
        }
        for (let sampler = 0; sampler < SAMPLERS; sampler++)
        {
            for (const state of Object.values(D3DSAMP))
            {
                record.samplerStates.set((sampler << 8) | state, 0);
            }
        }
        record.pixelShader = null;
        for (let register = 0; register < view.pixelConstants.floats.length / 4; register++)
        {
            record.pixelConstantsF.set(register, new Float32Array(4));
        }
        for (let register = 0; register < view.pixelConstants.ints.length / 4; register++)
        {
            record.pixelConstantsI.set(register, new Int32Array(4));
        }
        for (let register = 0; register < view.pixelConstants.bools.length; register++)
        {
            record.pixelConstantsB.set(register, 0);
        }
    }
    if (vertex)
    {
        for (let index = 0; index < VERTEX_SAMPLER_COUNT; index++)
        {
            for (const state of Object.values(D3DSAMP))
            {
                record.samplerStates.set(((VERTEX_SAMPLER_FIRST + index) << 8) | state, 0);
            }
        }
        for (const index of view.lights.keys())
        {
            record.lights.set(index, { light: null, enabled: false });
        }
        record.vertexDeclaration = { declaration: null, fvf: 0 };
        record.vertexShader = null;
        for (let register = 0; register < view.vertexConstants.floats.length / 4; register++)
        {
            record.vertexConstantsF.set(register, new Float32Array(4));
        }
        for (let register = 0; register < view.vertexConstants.ints.length / 4; register++)
        {
            record.vertexConstantsI.set(register, new Int32Array(4));
        }
        for (let register = 0; register < view.vertexConstants.bools.length; register++)
        {
            record.vertexConstantsB.set(register, 0);
        }
        record.nPatchMode = 0;
    }
    if (all)
    {
        for (let stage = 0; stage < STAGES; stage++)
        {
            record.textures.set(stage, null);
        }
        for (const key of view.transforms.keys())
        {
            record.transforms.set(key, new Float32Array(16));
        }
        record.material = null;
        record.viewport = null;
        record.scissor = null;
        for (const index of view.streams.keys())
        {
            record.streams.set(index, { buffer: null, offset: 0, stride: 0 });
        }
        for (const index of view.streamFrequencies.keys())
        {
            record.streamFrequencies.set(index, 1);
        }
        record.indices = null;
        for (let index = 0; index < view.maxClipPlanes; index++)
        {
            record.clipPlanes.set(index, new Float32Array(4));
        }
    }
    captureRecord(record, view);
}

/**
 * @param {Map<number, Float32Array>} floats
 * @param {Map<number, Int32Array>} ints
 * @param {Map<number, number>} bools
 * @param {import('./shader.js').ConstantFile} file
 */
function captureConstants(floats, ints, bools, file){
    for (const register of floats.keys())
    {
        floats.set(register, file.floats.slice(register * 4, register * 4 + 4));
    }
    for (const register of ints.keys())
    {
        ints.set(register, file.ints.slice(register * 4, register * 4 + 4));
    }
    for (const register of bools.keys())
    {
        bools.set(register, file.bools[register]);
    }
}

/**
 * @param {Map<number, Float32Array>} floats
 * @param {Map<number, Int32Array>} ints
 * @param {Map<number, number>} bools
 * @param {import('./shader.js').ConstantFile} file
 */
function applyConstants(floats, ints, bools, file){
    for (const [register, values] of floats)
    {
        file.floats.set(values, register * 4);
    }
    for (const [register, values] of ints)
    {
        file.ints.set(values, register * 4);
    }
    for (const [register, value] of bools)
    {
        file.bools[register] = value;
    }
}

/**
 * The record's states take the device's current values. Which states it
 * holds does not change.
 *
 * @param {StateBlockRecord} record
 * @param {StateView} view
 */
export function captureRecord(record, view){
    for (const state of record.renderStates.keys())
    {
        record.renderStates.set(state, view.renderStates.get(state) ?? 0);
    }
    for (const key of record.stageStates.keys())
    {
        record.stageStates.set(key, view.stageStates(key >>> 8).get(key & 0xff) ?? 0);
    }
    for (const key of record.samplerStates.keys())
    {
        record.samplerStates.set(key,
            view.stageStates(key >>> 8).get(SAMPLER_STATE_KEY[key & 0xff]) ?? 0);
    }
    for (const stage of record.textures.keys())
    {
        record.textures.set(stage, view.textures.get(stage) ?? null);
    }
    for (const type of record.transforms.keys())
    {
        record.transforms.set(type, Float32Array.from(view.transforms.get(type) ?? IDENTITY));
    }
    for (const index of record.lights.keys())
    {
        const held = view.lights.get(index);
        record.lights.set(index, held
            ? { light: copyLight(held.light), enabled: held.enabled }
            : { light: null, enabled: false });
    }
    captureConstants(record.vertexConstantsF, record.vertexConstantsI, record.vertexConstantsB,
        view.vertexConstants);
    captureConstants(record.pixelConstantsF, record.pixelConstantsI, record.pixelConstantsB,
        view.pixelConstants);
    for (const index of record.streams.keys())
    {
        const held = view.streams.get(index);
        record.streams.set(index, held
            ? { buffer: held.buffer, offset: held.offset, stride: held.stride }
            : { buffer: null, offset: 0, stride: 0 });
    }
    for (const index of record.streamFrequencies.keys())
    {
        record.streamFrequencies.set(index, view.streamFrequencies.get(index) ?? 1);
    }
    for (const index of record.clipPlanes.keys())
    {
        record.clipPlanes.set(index,
            Float32Array.from(view.clipPlanes.get(index) ?? [0, 0, 0, 0]));
    }
    if (record.material !== undefined)
    {
        record.material = view.material;
    }
    if (record.viewport !== undefined)
    {
        record.viewport = view.viewport;
    }
    if (record.scissor !== undefined)
    {
        record.scissor = view.scissor;
    }
    if (record.vertexDeclaration !== undefined)
    {
        record.vertexDeclaration = { ...view.vertexDeclaration };
    }
    if (record.vertexShader !== undefined)
    {
        record.vertexShader = view.vertexShader;
    }
    if (record.pixelShader !== undefined)
    {
        record.pixelShader = view.pixelShader;
    }
    if (record.indices !== undefined)
    {
        record.indices = view.indices;
    }
    if (record.nPatchMode !== undefined)
    {
        record.nPatchMode = view.nPatchMode;
    }
}

/**
 * Writes the record into the device. Only what the record holds.
 *
 * @param {StateBlockRecord} record
 * @param {StateView} view
 */
export function applyRecord(record, view){
    for (const [state, value] of record.renderStates)
    {
        view.renderStates.set(state, value);
    }
    for (const [key, value] of record.stageStates)
    {
        view.stageStates(key >>> 8).set(key & 0xff, value);
    }
    for (const [key, value] of record.samplerStates)
    {
        view.stageStates(key >>> 8).set(SAMPLER_STATE_KEY[key & 0xff], value);
    }
    for (const [stage, texture] of record.textures)
    {
        if (texture)
        {
            view.textures.set(stage, texture);
        }
        else
        {
            view.textures.delete(stage);
        }
    }
    for (const [type, matrix] of record.transforms)
    {
        view.transforms.set(type, Float32Array.from(matrix));
    }
    if (record.lights.size > 0)
    {
        for (const [index, held] of record.lights)
        {
            // A light recorded by enabling alone keeps whatever light the
            // device holds at that index, brought into being if none was.
            const light = held.light ?? view.lights.get(index)?.light ?? view.defaultLight();
            view.lights.set(index, { light: copyLight(light), enabled: held.enabled });
        }
        view.lightsChanged();
    }
    applyConstants(record.vertexConstantsF, record.vertexConstantsI, record.vertexConstantsB,
        view.vertexConstants);
    applyConstants(record.pixelConstantsF, record.pixelConstantsI, record.pixelConstantsB,
        view.pixelConstants);
    for (const [index, held] of record.streams)
    {
        view.streams.set(index, { buffer: held.buffer, offset: held.offset, stride: held.stride });
    }
    for (const [index, frequency] of record.streamFrequencies)
    {
        view.streamFrequencies.set(index, frequency);
    }
    for (const [index, plane] of record.clipPlanes)
    {
        view.clipPlanes.set(index, Float32Array.from(plane));
    }
    if (record.material)
    {
        view.material = record.material;
    }
    if (record.viewport)
    {
        view.viewport = record.viewport;
    }
    if (record.scissor)
    {
        view.scissor = record.scissor;
    }
    if (record.vertexDeclaration !== undefined)
    {
        view.vertexDeclaration = { ...record.vertexDeclaration };
    }
    if (record.vertexShader !== undefined)
    {
        view.vertexShader = record.vertexShader;
    }
    if (record.pixelShader !== undefined)
    {
        view.pixelShader = record.pixelShader;
    }
    if (record.indices !== undefined)
    {
        view.indices = record.indices;
    }
    if (record.nPatchMode !== undefined)
    {
        view.nPatchMode = record.nPatchMode;
    }
}

/**
 * @typedef {Object} StateBlock
 * @property {StateBlockRecord} record
 * @property {number} refCount
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {() => number} Capture
 * @property {() => number} Apply
 */

/**
 * @param {Object} options
 * @param {StateBlockRecord} options.record
 * @param {import('./resources.js').ReferenceCount} options.count
 * @param {() => number} options.capture   The device's, which knows whether it is recording.
 * @param {() => number} options.apply
 * @returns {StateBlock}
 */
export function createStateBlock(options){
    return {
        record: options.record,
        get refCount(){
            return options.count.value;
        },
        addRef: ()=>options.count.addRef(),
        release: ()=>options.count.release(),
        Capture: ()=>options.capture(),
        Apply: ()=>options.apply(),
    };
}
