/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 10 state blocks: `D3D10CreateStateBlock`, `ID3D10StateBlock` and
 * the mask functions d3d10.dll exports beside them.
 *
 * A mask is D3D10_STATE_BLOCK_MASK, seventy-six bytes with one bit per piece
 * of device state and per slot of the slotted ones; the functions work on
 * those bytes and nothing else, and are exported so a program (or the effect
 * framework it links) can build one. A block captures what its mask selects
 * by asking the device, holding a reference to every object it took, and
 * applies it by setting it back the way a program would -- so a block is
 * exactly as faithful as the device's own getters and setters, and never
 * reaches past them.
 */

import { attachCom } from './com.js';
import { D3D10_LIMITS, E_INVALIDARG, IID, S_OK } from './constants.js';

/** D3D10_DEVICE_STATE_TYPES. */
export const D3D10_DST = Object.freeze({
    SO_BUFFERS: 1,
    OM_RENDER_TARGETS: 2,
    OM_DEPTH_STENCIL_STATE: 3,
    OM_BLEND_STATE: 4,
    VS: 5,
    VS_SAMPLERS: 6,
    VS_SHADER_RESOURCES: 7,
    VS_CONSTANT_BUFFERS: 8,
    GS: 9,
    GS_SAMPLERS: 10,
    GS_SHADER_RESOURCES: 11,
    GS_CONSTANT_BUFFERS: 12,
    PS: 13,
    PS_SAMPLERS: 14,
    PS_SHADER_RESOURCES: 15,
    PS_CONSTANT_BUFFERS: 16,
    IA_VERTEX_BUFFERS: 17,
    IA_INDEX_BUFFER: 18,
    IA_INPUT_LAYOUT: 19,
    IA_PRIMITIVE_TOPOLOGY: 20,
    RS_VIEWPORTS: 21,
    RS_SCISSOR_RECTS: 22,
    RS_RASTERIZER_STATE: 23,
    PREDICATION: 24,
});

/** @param {number} bits */
const bytesFor = bits=>(bits + 7) >> 3;

const STAGE_FIELDS = /** @type {const} */ ([
    ['', 1],
    ['Samplers', D3D10_LIMITS.SAMPLER_SLOTS],
    ['ShaderResources', D3D10_LIMITS.SHADER_RESOURCE_SLOTS],
    ['ConstantBuffers', D3D10_LIMITS.CONSTANT_BUFFER_SLOTS],
]);

/**
 * The mask's fields in declaration order, with how many slots each covers.
 *
 * @type {readonly [string, number][]}
 */
const MASK_FIELDS = [
    ...['VS', 'GS', 'PS'].flatMap(stage=>STAGE_FIELDS.map(([suffix, slots])=>
        /** @type {[string, number]} */ ([`${stage}${suffix}`, slots]))),
    ['IAVertexBuffers', D3D10_LIMITS.VERTEX_INPUT_SLOTS],
    ['IAIndexBuffer', 1], ['IAInputLayout', 1], ['IAPrimitiveTopology', 1],
    ['OMRenderTargets', 1], ['OMDepthStencilState', 1], ['OMBlendState', 1],
    ['RSViewports', 1], ['RSScissorRects', 1], ['RSRasterizerState', 1],
    ['SOBuffers', 1], ['Predication', 1],
];

/**
 * D3D10_STATE_BLOCK_MASK: each field's byte offset and slot count.
 *
 * @type {Readonly<Record<string, { at: number, slots: number }>>}
 */
export const STATE_BLOCK_MASK = (()=>{
    /** @type {Record<string, { at: number, slots: number }>} */
    const fields = {};
    let at = 0;
    for (const [name, slots] of MASK_FIELDS)
    {
        fields[name] = Object.freeze({ at, slots });
        at += bytesFor(slots);
    }
    return Object.freeze(fields);
})();

/** The size of D3D10_STATE_BLOCK_MASK. */
export const STATE_BLOCK_MASK_SIZE = MASK_FIELDS
    .reduce((total, [, slots])=>total + bytesFor(slots), 0);

/** @type {Readonly<Record<number, string>>} which mask field each state type is */
const FIELD_OF = Object.freeze({
    [D3D10_DST.SO_BUFFERS]: 'SOBuffers',
    [D3D10_DST.OM_RENDER_TARGETS]: 'OMRenderTargets',
    [D3D10_DST.OM_DEPTH_STENCIL_STATE]: 'OMDepthStencilState',
    [D3D10_DST.OM_BLEND_STATE]: 'OMBlendState',
    [D3D10_DST.VS]: 'VS',
    [D3D10_DST.VS_SAMPLERS]: 'VSSamplers',
    [D3D10_DST.VS_SHADER_RESOURCES]: 'VSShaderResources',
    [D3D10_DST.VS_CONSTANT_BUFFERS]: 'VSConstantBuffers',
    [D3D10_DST.GS]: 'GS',
    [D3D10_DST.GS_SAMPLERS]: 'GSSamplers',
    [D3D10_DST.GS_SHADER_RESOURCES]: 'GSShaderResources',
    [D3D10_DST.GS_CONSTANT_BUFFERS]: 'GSConstantBuffers',
    [D3D10_DST.PS]: 'PS',
    [D3D10_DST.PS_SAMPLERS]: 'PSSamplers',
    [D3D10_DST.PS_SHADER_RESOURCES]: 'PSShaderResources',
    [D3D10_DST.PS_CONSTANT_BUFFERS]: 'PSConstantBuffers',
    [D3D10_DST.IA_VERTEX_BUFFERS]: 'IAVertexBuffers',
    [D3D10_DST.IA_INDEX_BUFFER]: 'IAIndexBuffer',
    [D3D10_DST.IA_INPUT_LAYOUT]: 'IAInputLayout',
    [D3D10_DST.IA_PRIMITIVE_TOPOLOGY]: 'IAPrimitiveTopology',
    [D3D10_DST.RS_VIEWPORTS]: 'RSViewports',
    [D3D10_DST.RS_SCISSOR_RECTS]: 'RSScissorRects',
    [D3D10_DST.RS_RASTERIZER_STATE]: 'RSRasterizerState',
    [D3D10_DST.PREDICATION]: 'Predication',
});

/**
 * @param {Uint8Array} mask
 * @param {number} type
 * @param {number} start
 * @param {number} count
 * @param {boolean} enable
 * @returns {number}
 */
function setCapture(mask, type, start, count, enable){
    const field = STATE_BLOCK_MASK[FIELD_OF[type] ?? ''];
    if (!mask || !field || start + count > field.slots || start + count < start)
    {
        return E_INVALIDARG;
    }
    for (let slot = start; slot < start + count; slot++)
    {
        const bit = 1 << (slot & 7);
        const at = field.at + (slot >> 3);
        mask[at] = enable ? mask[at] | bit : mask[at] & ~bit;
    }
    return S_OK;
}

/** The mask functions, over D3D10_STATE_BLOCK_MASK bytes. */
export const stateBlockMask = Object.freeze({
    /** @param {Uint8Array | null} mask @param {number} type @param {number} start @param {number} count */
    EnableCapture: (mask, type, start, count)=>
        setCapture(/** @type {Uint8Array} */ (mask), type, start, count, true),
    /** @param {Uint8Array | null} mask @param {number} type @param {number} start @param {number} count */
    DisableCapture: (mask, type, start, count)=>
        setCapture(/** @type {Uint8Array} */ (mask), type, start, count, false),
    /** @param {Uint8Array | null} mask */
    EnableAll: mask=>(mask ? (mask.fill(0xff), S_OK) : E_INVALIDARG),
    /** @param {Uint8Array | null} mask */
    DisableAll: mask=>(mask ? (mask.fill(0), S_OK) : E_INVALIDARG),
    /**
     * The entry's bit as it sits in its byte, not a normalised boolean: the
     * fourth shader resource answers eight.
     *
     * @param {Uint8Array | null} mask @param {number} type @param {number} entry
     * @returns {number}
     */
    GetSetting(mask, type, entry){
        const field = STATE_BLOCK_MASK[FIELD_OF[type] ?? ''];
        if (!mask || !field || entry >= field.slots)
        {
            return 0;
        }
        return mask[field.at + (entry >> 3)] & (1 << (entry & 7));
    },
    /** @param {Uint8Array | null} a @param {Uint8Array | null} b @param {Uint8Array | null} out */
    Difference: (a, b, out)=>combine(a, b, out, (x, y)=>x ^ y),
    /** @param {Uint8Array | null} a @param {Uint8Array | null} b @param {Uint8Array | null} out */
    Intersect: (a, b, out)=>combine(a, b, out, (x, y)=>x & y),
    /** @param {Uint8Array | null} a @param {Uint8Array | null} b @param {Uint8Array | null} out */
    Union: (a, b, out)=>combine(a, b, out, (x, y)=>x | y),
});

/**
 * @param {Uint8Array | null} a
 * @param {Uint8Array | null} b
 * @param {Uint8Array | null} out
 * @param {(x: number, y: number) => number} operation
 */
function combine(a, b, out, operation){
    if (!a || !b || !out)
    {
        return E_INVALIDARG;
    }
    for (let index = 0; index < STATE_BLOCK_MASK_SIZE; index++)
    {
        out[index] = operation(a[index], b[index]);
    }
    return S_OK;
}

/**
 * @param {Uint8Array} mask
 * @param {string} name
 * @returns {number[]} the slots of a field the mask selects
 */
function selected(mask, name){
    const field = STATE_BLOCK_MASK[name];
    /** @type {number[]} */
    const slots = [];
    for (let slot = 0; slot < field.slots; slot++)
    {
        if ((mask[field.at + (slot >> 3)] & (1 << (slot & 7))) !== 0)
        {
            slots.push(slot);
        }
    }
    return slots;
}

/**
 * One captured piece of state: how to put it back, and the objects it holds a
 * reference to until the next capture or the block's end.
 *
 * @typedef {{ apply: () => void, holds: any[] }} Captured
 */

/**
 * Every piece of state a mask can select, as a capture that answers what to
 * apply later.
 *
 * @param {any} device
 * @param {Uint8Array} mask
 * @returns {Captured[]}
 */
function captureAll(device, mask){
    /** @type {Captured[]} */
    const captured = [];
    const stages = /** @type {const} */ (['VS', 'GS', 'PS']);
    for (const stage of stages)
    {
        if (selected(mask, stage).length > 0)
        {
            /** @type {{ shader?: any }} */
            const out = {};
            device[`${stage}GetShader`](out);
            const shader = out.shader ?? null;
            captured.push({ apply: ()=>device[`${stage}SetShader`](shader), holds: [shader] });
        }
        for (const [kind, key] of /** @type {const} */ ([['Samplers', 'samplers'],
            ['ShaderResources', 'views'], ['ConstantBuffers', 'buffers']]))
        {
            for (const slot of selected(mask, `${stage}${kind}`))
            {
                /** @type {Record<string, any[]>} */
                const out = {};
                device[`${stage}Get${kind}`](slot, 1, out);
                const object = out[key]?.[0] ?? null;
                captured.push({
                    apply: ()=>device[`${stage}Set${kind}`](slot, [object]),
                    holds: [object],
                });
            }
        }
    }
    for (const slot of selected(mask, 'IAVertexBuffers'))
    {
        /** @type {{ buffers?: any[], strides?: number[], offsets?: number[] }} */
        const out = {};
        device.IAGetVertexBuffers(slot, 1, out);
        const buffer = out.buffers?.[0] ?? null;
        const stride = out.strides?.[0] ?? 0;
        const offset = out.offsets?.[0] ?? 0;
        captured.push({
            apply: ()=>device.IASetVertexBuffers(slot, [buffer], [stride], [offset]),
            holds: [buffer],
        });
    }
    if (selected(mask, 'IAIndexBuffer').length > 0)
    {
        /** @type {{ buffer?: any, format?: number, offset?: number }} */
        const out = {};
        device.IAGetIndexBuffer(out);
        const { buffer = null, format = 0, offset = 0 } = out;
        captured.push({
            apply: ()=>device.IASetIndexBuffer(buffer, format, offset), holds: [buffer],
        });
    }
    if (selected(mask, 'IAInputLayout').length > 0)
    {
        /** @type {{ layout?: any }} */
        const out = {};
        device.IAGetInputLayout(out);
        const layout = out.layout ?? null;
        captured.push({ apply: ()=>device.IASetInputLayout(layout), holds: [layout] });
    }
    if (selected(mask, 'IAPrimitiveTopology').length > 0)
    {
        /** @type {{ topology?: number }} */
        const out = {};
        device.IAGetPrimitiveTopology(out);
        const topology = out.topology ?? 0;
        captured.push({ apply: ()=>device.IASetPrimitiveTopology(topology), holds: [] });
    }
    if (selected(mask, 'OMRenderTargets').length > 0)
    {
        /** @type {{ views?: any[], depthStencilView?: any }} */
        const out = {};
        device.OMGetRenderTargets(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS, out);
        const views = out.views ?? [];
        const depthStencilView = out.depthStencilView ?? null;
        captured.push({
            apply: ()=>device.OMSetRenderTargets(views, depthStencilView),
            holds: [...views, depthStencilView],
        });
    }
    if (selected(mask, 'OMDepthStencilState').length > 0)
    {
        /** @type {{ state?: any, stencilRef?: number }} */
        const out = {};
        device.OMGetDepthStencilState(out);
        const { state = null, stencilRef = 0 } = out;
        captured.push({
            apply: ()=>device.OMSetDepthStencilState(state, stencilRef), holds: [state],
        });
    }
    if (selected(mask, 'OMBlendState').length > 0)
    {
        /** @type {{ state?: any, blendFactor?: number[], sampleMask?: number }} */
        const out = {};
        device.OMGetBlendState(out);
        const { state = null, blendFactor = null, sampleMask = 0xffffffff } = out;
        captured.push({
            apply: ()=>device.OMSetBlendState(state, blendFactor, sampleMask), holds: [state],
        });
    }
    if (selected(mask, 'RSViewports').length > 0)
    {
        /** @type {{ viewports?: any[] }} */
        const out = {};
        device.RSGetViewports(out);
        const viewports = out.viewports ?? [];
        captured.push({ apply: ()=>device.RSSetViewports(viewports), holds: [] });
    }
    if (selected(mask, 'RSScissorRects').length > 0)
    {
        /** @type {{ rects?: any[] }} */
        const out = {};
        device.RSGetScissorRects(out);
        const rects = out.rects ?? [];
        captured.push({ apply: ()=>device.RSSetScissorRects(rects), holds: [] });
    }
    if (selected(mask, 'RSRasterizerState').length > 0)
    {
        /** @type {{ state?: any }} */
        const out = {};
        device.RSGetState(out);
        const state = out.state ?? null;
        captured.push({ apply: ()=>device.RSSetState(state), holds: [state] });
    }
    if (selected(mask, 'SOBuffers').length > 0)
    {
        /** @type {{ buffers?: any[], offsets?: number[] }} */
        const out = {};
        device.SOGetTargets(D3D10_LIMITS.SO_BUFFER_SLOTS, out);
        const buffers = out.buffers ?? [];
        const offsets = out.offsets ?? [];
        captured.push({ apply: ()=>device.SOSetTargets(buffers, offsets), holds: buffers });
    }
    if (selected(mask, 'Predication').length > 0)
    {
        /** @type {{ predicate?: any, value?: boolean }} */
        const out = {};
        device.GetPredication(out);
        const { predicate = null, value = false } = out;
        captured.push({ apply: ()=>device.SetPredication(predicate, value), holds: [predicate] });
    }
    return captured;
}

/**
 * An ID3D10StateBlock over a device and a copy of the mask it was made with.
 * It holds the device, and every object its last capture took.
 *
 * @param {any} device
 * @param {Uint8Array} mask
 */
export function createStateBlock(device, mask){
    const own = Uint8Array.from(mask.subarray(0, STATE_BLOCK_MASK_SIZE));
    /** @type {Captured[]} */
    let captured = [];
    const releaseCaptured = ()=>{
        for (const entry of captured)
        {
            entry.holds.forEach(object=>object?.release());
        }
        captured = [];
    };
    device.addRef();
    return attachCom({
        Capture(){
            const next = captureAll(device, own);
            releaseCaptured();
            captured = next;
            return S_OK;
        },
        Apply(){
            captured.forEach(entry=>entry.apply());
            return S_OK;
        },
        ReleaseAllDeviceObjects(){
            releaseCaptured();
            return S_OK;
        },
        /** @param {{ device?: any }} out */
        GetDevice(out){
            device.addRef();
            out.device = device;
            return S_OK;
        },
    }, {
        interfaces: [IID.ID3D10StateBlock],
        onLastRef: ()=>{
            releaseCaptured();
            device.release();
        },
    });
}
