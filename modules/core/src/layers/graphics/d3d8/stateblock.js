/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 8's state blocks: which states a block holds, and what they held
 * when it was last captured.
 *
 * Which states is fixed when the block is made -- by recording, or by asking
 * for one of the three predefined sets -- and never changes; what they hold
 * changes on every capture. Apply writes the record back and touches nothing
 * outside it.
 *
 * The predefined halves are tables because that is what they are. Each render
 * state belongs to the pixel half or the vertex half, the fog distances and
 * the shade mode to both; the lights and the vertex shader are the vertex
 * half's, the pixel shader the pixel half's, and the transforms, the textures,
 * the streams and the indices belong to neither -- only a block of everything
 * holds them. Wine's d3d8 stateblock tests pin each of those assignments.
 * Nothing there pins the texture stage states or the material: the stage
 * states go with the pixel half, as they do in the Direct3D 9 blocks here, and
 * the material, an input of the lighting, with the vertex half. The render
 * states Wine's tables leave out go where their Direct3D 9 counterparts do.
 */

import { D3DRS, D3DSBT } from './constants.js';
import { IDENTITY } from './render.js';

/** The render states a pixel block holds, by name. */
export const PIXEL_RENDER_STATES = Object.freeze([
    'ZENABLE', 'FILLMODE', 'SHADEMODE', 'LINEPATTERN', 'ZWRITEENABLE', 'ALPHATESTENABLE',
    'LASTPIXEL', 'SRCBLEND', 'DESTBLEND', 'ZFUNC', 'ALPHAREF', 'ALPHAFUNC', 'DITHERENABLE',
    'FOGSTART', 'FOGEND', 'FOGDENSITY', 'ALPHABLENDENABLE', 'EDGEANTIALIAS', 'ZBIAS',
    'STENCILENABLE', 'STENCILFAIL', 'STENCILZFAIL', 'STENCILPASS', 'STENCILFUNC', 'STENCILREF',
    'STENCILMASK', 'STENCILWRITEMASK', 'TEXTUREFACTOR', 'WRAP0', 'WRAP1', 'WRAP2', 'WRAP3',
    'WRAP4', 'WRAP5', 'WRAP6', 'WRAP7', 'COLORWRITEENABLE', 'BLENDOP',
]);

/** The render states a vertex block holds, by name. */
export const VERTEX_RENDER_STATES = Object.freeze([
    'SHADEMODE', 'CULLMODE', 'FOGENABLE', 'SPECULARENABLE', 'FOGCOLOR', 'FOGTABLEMODE',
    'FOGSTART', 'FOGEND', 'FOGDENSITY', 'RANGEFOGENABLE', 'CLIPPING', 'LIGHTING', 'AMBIENT',
    'FOGVERTEXMODE', 'COLORVERTEX', 'LOCALVIEWER', 'NORMALIZENORMALS', 'DIFFUSEMATERIALSOURCE',
    'SPECULARMATERIALSOURCE', 'AMBIENTMATERIALSOURCE', 'EMISSIVEMATERIALSOURCE', 'VERTEXBLEND',
    'CLIPPLANEENABLE', 'POINTSIZE', 'POINTSIZE_MIN', 'POINTSPRITEENABLE', 'POINTSCALEENABLE',
    'POINTSCALE_A', 'POINTSCALE_B', 'POINTSCALE_C', 'MULTISAMPLEANTIALIAS', 'MULTISAMPLEMASK',
    'PATCHEDGESTYLE', 'PATCHSEGMENTS', 'POINTSIZE_MAX', 'INDEXEDVERTEXBLENDENABLE', 'TWEENFACTOR',
    'POSITIONORDER', 'NORMALORDER',
]);

/** @param {readonly string[]} names @returns {Set<number>} */
const statesNamed = names=>new Set(names.map(name=>{
    const state = /** @type {Record<string, number>} */ (D3DRS)[name];
    if (state === undefined)
    {
        throw new Error(`graphics/d3d8: ${name} is not a render state`);
    }
    return state;
}));

const PIXEL_STATES = statesNamed(PIXEL_RENDER_STATES);
const VERTEX_STATES = statesNamed(VERTEX_RENDER_STATES);

/**
 * The device's own shapes, which this file only copies.
 *
 * @typedef {Record<string, any>} Light
 * @typedef {Record<string, any>} Material
 */

/**
 * @typedef {Object} StateBlock
 *     What a block holds. A map entry, or a field that is not undefined, is a
 *     state the block holds and Apply writes back; Apply leaves the rest.
 * @property {Map<number, number>} renderStates
 * @property {Map<number, number>} stageStates   Keyed by (stage << 8) | type.
 * @property {Map<number, Float32Array>} transforms
 * @property {Map<number, any>} textures         Per stage; null means "nothing bound".
 * @property {Map<number, { light?: Light, enabled?: boolean }>} lights
 *     A field left undefined is one the block did not record: a light only
 *     enabled keeps the device's parameters, one only set keeps its switch.
 * @property {Map<number, { buffer: any, stride: number }>} streams
 * @property {Map<number, Float32Array>} clipPlanes
 * @property {Material} [material]
 * @property {any} [viewport]              The paired viewport state.
 * @property {{ buffer: any, base: number }} [indices]
 * @property {number} [vertexShader]       A handle, or a vertex format.
 * @property {number} [pixelShader]
 * @property {Map<number, Float32Array>} vertexConstants   Four floats by register.
 * @property {Map<number, Float32Array>} pixelConstants
 */

/**
 * @typedef {Object} StateView
 *     The device's state, as a block reads and writes it. Every member is
 *     live; a block never keeps one of these.
 * @property {Map<number, number>} renderStates
 * @property {(stage: number) => Map<number, number>} stageStates
 * @property {number} stageCount
 * @property {Map<number, any>} textures
 * @property {Map<number, Float32Array>} transforms
 * @property {Map<number, { light: Light, enabled: boolean }>} lights
 * @property {() => Light} defaultLight   What enabling an unwritten light brings into being.
 * @property {(index: number) => { buffer: any, stride: number }} stream
 * @property {Map<number, { buffer: any, stride: number }>} streams
 * @property {Map<number, Float32Array>} clipPlanes
 * @property {Material} material
 * @property {any} viewport
 * @property {{ buffer: any, base: number }} indices
 * @property {number} vertexShader
 * @property {number} pixelShader
 * @property {Float32Array} vertexConstants   The float files, four to a register.
 * @property {Float32Array} pixelConstants
 */

/**
 * Each of a block's constant maps beside the file it is of.
 *
 * @param {StateBlock} block @param {StateView} view
 * @returns {[Map<number, Float32Array>, Float32Array][]}
 */
const constantFiles = (block, view)=>[
    [block.vertexConstants, view.vertexConstants],
    [block.pixelConstants, view.pixelConstants],
];

/** @returns {StateBlock} a block holding nothing yet */
export function emptyBlock(){
    return {
        renderStates: new Map(),
        stageStates: new Map(),
        transforms: new Map(),
        textures: new Map(),
        lights: new Map(),
        streams: new Map(),
        clipPlanes: new Map(),
        vertexConstants: new Map(),
        pixelConstants: new Map(),
    };
}

/**
 * A block of one of the predefined kinds, at the device's values of the moment.
 *
 * @param {number} type D3DSBT
 * @param {StateView} view
 * @param {Set<number>} [uncaptured]  render states no block holds
 * @returns {StateBlock}
 */
export function fillBlock(type, view, uncaptured = new Set()){
    const block = emptyBlock();
    const pixel = type !== D3DSBT.VERTEXSTATE;
    const vertex = type !== D3DSBT.PIXELSTATE;
    const all = type === D3DSBT.ALL;

    for (const state of view.renderStates.keys())
    {
        if (!uncaptured.has(state) && (all || (pixel && PIXEL_STATES.has(state))
            || (vertex && VERTEX_STATES.has(state))))
        {
            block.renderStates.set(state, 0);
        }
    }
    if (pixel)
    {
        for (let stage = 0; stage < view.stageCount; stage++)
        {
            for (const tss of view.stageStates(stage).keys())
            {
                block.stageStates.set((stage << 8) | tss, 0);
            }
        }
        block.pixelShader = 0;
        for (let register = 0; register < view.pixelConstants.length / 4; register++)
        {
            block.pixelConstants.set(register, new Float32Array(4));
        }
    }
    if (vertex)
    {
        for (const index of view.lights.keys())
        {
            block.lights.set(index, {});
        }
        block.vertexShader = 0;
        block.material = view.material;
        for (let register = 0; register < view.vertexConstants.length / 4; register++)
        {
            block.vertexConstants.set(register, new Float32Array(4));
        }
    }
    if (all)
    {
        for (let stage = 0; stage < view.stageCount; stage++)
        {
            block.textures.set(stage, null);
        }
        for (const transform of view.transforms.keys())
        {
            block.transforms.set(transform, new Float32Array(16));
        }
        for (const index of view.streams.keys())
        {
            block.streams.set(index, { buffer: null, stride: 0 });
        }
        for (const index of view.clipPlanes.keys())
        {
            block.clipPlanes.set(index, new Float32Array(4));
        }
        block.indices = { buffer: null, base: 0 };
        block.viewport = view.viewport;
    }
    captureBlock(block, view);
    return block;
}

/**
 * The block's states take the device's values of the moment. Which states it
 * holds does not change, which is the whole difference between capturing a
 * block and making one.
 *
 * @param {StateBlock} block
 * @param {StateView} view
 */
export function captureBlock(block, view){
    for (const state of block.renderStates.keys())
    {
        block.renderStates.set(state, view.renderStates.get(state) ?? 0);
    }
    for (const key of block.stageStates.keys())
    {
        block.stageStates.set(key, view.stageStates(key >>> 8).get(key & 0xff) ?? 0);
    }
    for (const type of block.transforms.keys())
    {
        const matrix = view.transforms.get(type);
        block.transforms.set(type, Float32Array.from(matrix ?? IDENTITY));
    }
    for (const stage of block.textures.keys())
    {
        block.textures.set(stage, view.textures.get(stage) ?? null);
    }
    for (const index of block.lights.keys())
    {
        const held = view.lights.get(index);
        block.lights.set(index, held
            ? { light: { ...held.light }, enabled: held.enabled }
            : {});
    }
    for (const index of block.streams.keys())
    {
        const held = view.stream(index);
        block.streams.set(index, { buffer: held.buffer, stride: held.stride });
    }
    for (const index of block.clipPlanes.keys())
    {
        block.clipPlanes.set(index, Float32Array.from(view.clipPlanes.get(index) ?? [0, 0, 0, 0]));
    }
    for (const [constants, file] of constantFiles(block, view))
    {
        for (const register of constants.keys())
        {
            constants.set(register, file.slice(register * 4, register * 4 + 4));
        }
    }
    if (block.material !== undefined)
    {
        block.material = { ...view.material };
    }
    if (block.viewport !== undefined)
    {
        block.viewport = view.viewport;
    }
    if (block.indices !== undefined)
    {
        block.indices = { ...view.indices };
    }
    if (block.vertexShader !== undefined)
    {
        block.vertexShader = view.vertexShader;
    }
    if (block.pixelShader !== undefined)
    {
        block.pixelShader = view.pixelShader;
    }
}

/**
 * Writes the block into the device: only what the block holds.
 *
 * @param {StateBlock} block
 * @param {StateView} view
 */
export function applyBlock(block, view){
    for (const [state, value] of block.renderStates)
    {
        view.renderStates.set(state, value);
    }
    for (const [key, value] of block.stageStates)
    {
        view.stageStates(key >>> 8).set(key & 0xff, value);
    }
    for (const [type, matrix] of block.transforms)
    {
        view.transforms.set(type, Float32Array.from(matrix));
    }
    for (const [stage, texture] of block.textures)
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
    for (const [index, held] of block.lights)
    {
        if (held.light === undefined && held.enabled === undefined)
        {
            continue;
        }
        const current = view.lights.get(index);
        view.lights.set(index, {
            light: { ...(held.light ?? current?.light ?? view.defaultLight()) },
            enabled: held.enabled ?? current?.enabled ?? false,
        });
    }
    for (const [index, held] of block.streams)
    {
        const record = view.stream(index);
        record.buffer = held.buffer;
        record.stride = held.stride;
    }
    for (const [index, plane] of block.clipPlanes)
    {
        view.clipPlanes.set(index, Float32Array.from(plane));
    }
    for (const [constants, file] of constantFiles(block, view))
    {
        for (const [register, values] of constants)
        {
            file.set(values, register * 4);
        }
    }
    if (block.material !== undefined)
    {
        view.material = { ...block.material };
    }
    if (block.viewport !== undefined)
    {
        view.viewport = block.viewport;
    }
    if (block.indices !== undefined)
    {
        view.indices = { ...block.indices };
    }
    if (block.vertexShader !== undefined)
    {
        view.vertexShader = block.vertexShader;
    }
    if (block.pixelShader !== undefined)
    {
        view.pixelShader = block.pixelShader;
    }
}
