/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The states an effect's state blocks assign, by the id the file stores, and
 * the description each kind of block starts from.
 *
 * The ids are those of the fx_4_0 format, the order of the fields in the
 * descriptions they fill (Wine's d3d10 test_effect_state_groups names each).
 * The starting descriptions are the effect framework's own, which are not
 * all the device's: a sampler starts point-filtered and wrapping with an
 * anisotropy of sixteen, a blend state blending by source alpha
 * (test_effect_state_group_defaults).
 */

import { CONSTANT_TYPE } from './effect.js';

/**
 * @typedef {Object} StateProperty
 * @property {'rasterizer' | 'depthstencil' | 'blend' | 'sampler'} block
 * @property {string} field       A field of the description, `Face.Field` for a stencil face.
 * @property {'uint' | 'int' | 'float' | 'bool' | 'byte'} type
 * @property {number} [count]     How many values a whole assignment gives (a colour's four).
 * @property {boolean} [indexed]  Assigned per render target, by the assignment's index.
 */

/** @type {Readonly<Record<number, StateProperty>>} */
export const STATE_PROPERTY = Object.freeze({
    0x0c: { block: 'rasterizer', field: 'FillMode', type: 'uint' },
    0x0d: { block: 'rasterizer', field: 'CullMode', type: 'uint' },
    0x0e: { block: 'rasterizer', field: 'FrontCounterClockwise', type: 'bool' },
    0x0f: { block: 'rasterizer', field: 'DepthBias', type: 'int' },
    0x10: { block: 'rasterizer', field: 'DepthBiasClamp', type: 'float' },
    0x11: { block: 'rasterizer', field: 'SlopeScaledDepthBias', type: 'float' },
    0x12: { block: 'rasterizer', field: 'DepthClipEnable', type: 'bool' },
    0x13: { block: 'rasterizer', field: 'ScissorEnable', type: 'bool' },
    0x14: { block: 'rasterizer', field: 'MultisampleEnable', type: 'bool' },
    0x15: { block: 'rasterizer', field: 'AntialiasedLineEnable', type: 'bool' },
    0x16: { block: 'depthstencil', field: 'DepthEnable', type: 'bool' },
    0x17: { block: 'depthstencil', field: 'DepthWriteMask', type: 'uint' },
    0x18: { block: 'depthstencil', field: 'DepthFunc', type: 'uint' },
    0x19: { block: 'depthstencil', field: 'StencilEnable', type: 'bool' },
    0x1a: { block: 'depthstencil', field: 'StencilReadMask', type: 'byte' },
    0x1b: { block: 'depthstencil', field: 'StencilWriteMask', type: 'byte' },
    0x1c: { block: 'depthstencil', field: 'FrontFace.StencilFailOp', type: 'uint' },
    0x1d: { block: 'depthstencil', field: 'FrontFace.StencilDepthFailOp', type: 'uint' },
    0x1e: { block: 'depthstencil', field: 'FrontFace.StencilPassOp', type: 'uint' },
    0x1f: { block: 'depthstencil', field: 'FrontFace.StencilFunc', type: 'uint' },
    0x20: { block: 'depthstencil', field: 'BackFace.StencilFailOp', type: 'uint' },
    0x21: { block: 'depthstencil', field: 'BackFace.StencilDepthFailOp', type: 'uint' },
    0x22: { block: 'depthstencil', field: 'BackFace.StencilPassOp', type: 'uint' },
    0x23: { block: 'depthstencil', field: 'BackFace.StencilFunc', type: 'uint' },
    0x24: { block: 'blend', field: 'AlphaToCoverageEnable', type: 'bool' },
    0x25: { block: 'blend', field: 'BlendEnable', type: 'bool', indexed: true },
    0x26: { block: 'blend', field: 'SrcBlend', type: 'uint' },
    0x27: { block: 'blend', field: 'DestBlend', type: 'uint' },
    0x28: { block: 'blend', field: 'BlendOp', type: 'uint' },
    0x29: { block: 'blend', field: 'SrcBlendAlpha', type: 'uint' },
    0x2a: { block: 'blend', field: 'DestBlendAlpha', type: 'uint' },
    0x2b: { block: 'blend', field: 'BlendOpAlpha', type: 'uint' },
    0x2c: { block: 'blend', field: 'RenderTargetWriteMask', type: 'byte', indexed: true },
    0x2d: { block: 'sampler', field: 'Filter', type: 'uint' },
    0x2e: { block: 'sampler', field: 'AddressU', type: 'uint' },
    0x2f: { block: 'sampler', field: 'AddressV', type: 'uint' },
    0x30: { block: 'sampler', field: 'AddressW', type: 'uint' },
    0x31: { block: 'sampler', field: 'MipLODBias', type: 'float' },
    0x32: { block: 'sampler', field: 'MaxAnisotropy', type: 'uint' },
    0x33: { block: 'sampler', field: 'ComparisonFunc', type: 'uint' },
    0x34: { block: 'sampler', field: 'BorderColor', type: 'float', count: 4 },
    0x35: { block: 'sampler', field: 'MinLOD', type: 'float' },
    0x36: { block: 'sampler', field: 'MaxLOD', type: 'float' },
});

/** The sampler's Texture: a Direct3D 9 notion a Direct3D 10 sampler has no field for. */
export const SAMPLER_TEXTURE = 0x37;

/** The largest float, which an unassigned MaxLOD is. */
const FLT_MAX = 3.4028234663852886e38;

/** @param {'rasterizer' | 'depthstencil' | 'blend' | 'sampler'} block */
export function defaultDesc(block){
    switch (block)
    {
        case 'rasterizer':
            return {
                FillMode: 3, CullMode: 3, FrontCounterClockwise: false, DepthBias: 0,
                DepthBiasClamp: 0, SlopeScaledDepthBias: 0, DepthClipEnable: true,
                ScissorEnable: false, MultisampleEnable: false, AntialiasedLineEnable: false,
            };
        case 'depthstencil': {
            const face = ()=>({ StencilFailOp: 1, StencilDepthFailOp: 1, StencilPassOp: 1,
                StencilFunc: 8 });
            return {
                DepthEnable: true, DepthWriteMask: 1, DepthFunc: 2, StencilEnable: false,
                StencilReadMask: 0xff, StencilWriteMask: 0xff, FrontFace: face(),
                BackFace: face(),
            };
        }
        case 'blend':
            return {
                AlphaToCoverageEnable: false, BlendEnable: new Array(8).fill(false),
                SrcBlend: 5, DestBlend: 6, BlendOp: 1, SrcBlendAlpha: 5, DestBlendAlpha: 6,
                BlendOpAlpha: 1, RenderTargetWriteMask: new Array(8).fill(0xf),
            };
        default:
            return {
                Filter: 0, AddressU: 1, AddressV: 1, AddressW: 1, MipLODBias: 0,
                MaxAnisotropy: 16, ComparisonFunc: 1, BorderColor: [0, 0, 0, 0], MinLOD: 0,
                MaxLOD: FLT_MAX,
            };
    }
}

/**
 * A constant as the type a field takes: a stencil reference may be given as
 * a float, a blend enable as an int.
 *
 * @param {import('./effect.js').FxConstant} constant
 * @param {StateProperty['type']} type
 * @returns {number | boolean}
 */
export function convertConstant(constant, type){
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, constant.bits, true);
    const value = constant.type === CONSTANT_TYPE.FLOAT
        ? view.getFloat32(0, true)
        : constant.type === CONSTANT_TYPE.INT ? view.getInt32(0, true) : constant.bits;
    switch (type)
    {
        case 'bool': return value !== 0;
        case 'float': return Math.fround(value);
        case 'int': return Math.trunc(value) | 0;
        case 'byte': return Math.trunc(value) & 0xff;
        default: return Math.trunc(value) >>> 0;
    }
}

/**
 * The description a state block's assignments come to, from the effect's
 * starting description. An assignment this cannot evaluate -- a variable
 * or an expression rather than a constant -- is reported and the field left
 * as it starts.
 *
 * @param {'rasterizer' | 'depthstencil' | 'blend' | 'sampler'} block
 * @param {import('./effect.js').FxAssignment[]} assignments
 * @param {(detail: string) => void} report
 */
export function stateDesc(block, assignments, report){
    /** @type {Record<string, any>} */
    const desc = defaultDesc(block);
    for (const assignment of assignments)
    {
        if (assignment.state === SAMPLER_TEXTURE && block === 'sampler')
        {
            continue;
        }
        const property = STATE_PROPERTY[assignment.state];
        if (!property || property.block !== block)
        {
            report(`a ${block} state names state 0x${assignment.state.toString(16)}, which is`
                + ' not one of its fields; it is ignored');
            continue;
        }
        if (!assignment.constants)
        {
            report(`a ${block} state's ${property.field} given by a variable or an expression is`
                + ' not evaluated; it keeps its starting value');
            continue;
        }
        const values = assignment.constants.map(constant=>convertConstant(constant,
            property.type));
        const [face, field] = property.field.includes('.')
            ? property.field.split('.')
            : [null, property.field];
        const target = face ? desc[face] : desc;
        if (property.indexed)
        {
            if (assignment.index < 8)
            {
                target[field][assignment.index] = values[0];
            }
        }
        else if (property.count)
        {
            target[field] = values.slice(0, property.count);
        }
        else
        {
            target[field] = values[0];
        }
    }
    return desc;
}
