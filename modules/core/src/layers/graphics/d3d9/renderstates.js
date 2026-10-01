/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The render state a device has before a program has set anything.
 *
 * This is a table rather than a constructor because it is a specification: a
 * program reads these back and branches on them, several of them are read far
 * more often than they are written, and a wrong one shows up as a picture that
 * is subtly wrong rather than as a failed call.
 *
 * Two entries are not contract and are marked so:
 *
 * - POINTSIZE's initial value is whatever the driver picked. Asserting one
 *   freezes an arbitrary machine's answer.
 * - DEBUGMONITORTOKEN is not part of a state block's captured set, so a
 *   capture/apply cycle must leave it alone rather than restore it.
 *
 * Two more are not constants at all, and their condition travels with them:
 * ZENABLE follows the presentation parameters' automatic depth-stencil, and
 * POINTSIZE_MAX follows the reported maximum point size.
 */

import { HashedStates } from '../d3d8/statehash.js';
import {
    D3DBLEND, D3DBLENDOP, D3DCMP, D3DCULL, D3DDEGREE, D3DDMT, D3DFILL, D3DFOG, D3DMCS,
    D3DPATCHEDGE, D3DRS, D3DSHADE, D3DSTENCILOP, D3DVBF, D3DZB, floatToDword,
} from './constants.js';

const TRUE = 1;
const FALSE = 0;

/**
 * @typedef {Object} RenderStateDefault
 * @property {number} state    D3DRS_* identifier.
 * @property {string} name
 * @property {number} value    The DWORD a fresh device reads back.
 * @property {'autoDepthStencil' | 'maxPointSize'} [dependsOn]
 *           Names the device property the value is derived from, in which case
 *           `value` is only the placeholder the resolver replaces.
 * @property {boolean} [asserted]
 *           False where the initial value is the driver's business.
 * @property {boolean} [capturedByStateBlock]
 *           False where a state block does not record the state at all.
 */

/**
 * @typedef {Object} DeviceStateInputs
 * @property {boolean} enableAutoDepthStencil
 * @property {number} maxPointSize
 */

/** @type {readonly RenderStateDefault[]} */
export const DEFAULT_RENDER_STATES = Object.freeze([
    { state: D3DRS.ZENABLE, name: 'ZENABLE', value: D3DZB.TRUE, dependsOn: 'autoDepthStencil' },
    { state: D3DRS.FILLMODE, name: 'FILLMODE', value: D3DFILL.SOLID },
    { state: D3DRS.SHADEMODE, name: 'SHADEMODE', value: D3DSHADE.GOURAUD },
    { state: D3DRS.ZWRITEENABLE, name: 'ZWRITEENABLE', value: TRUE },
    { state: D3DRS.ALPHATESTENABLE, name: 'ALPHATESTENABLE', value: FALSE },
    { state: D3DRS.LASTPIXEL, name: 'LASTPIXEL', value: TRUE },
    { state: D3DRS.SRCBLEND, name: 'SRCBLEND', value: D3DBLEND.ONE },
    { state: D3DRS.DESTBLEND, name: 'DESTBLEND', value: D3DBLEND.ZERO },
    { state: D3DRS.CULLMODE, name: 'CULLMODE', value: D3DCULL.CCW },
    { state: D3DRS.ZFUNC, name: 'ZFUNC', value: D3DCMP.LESSEQUAL },
    { state: D3DRS.ALPHAREF, name: 'ALPHAREF', value: 0 },
    { state: D3DRS.ALPHAFUNC, name: 'ALPHAFUNC', value: D3DCMP.ALWAYS },
    { state: D3DRS.DITHERENABLE, name: 'DITHERENABLE', value: FALSE },
    { state: D3DRS.ALPHABLENDENABLE, name: 'ALPHABLENDENABLE', value: FALSE },
    { state: D3DRS.FOGENABLE, name: 'FOGENABLE', value: FALSE },
    { state: D3DRS.SPECULARENABLE, name: 'SPECULARENABLE', value: FALSE },
    { state: D3DRS.FOGCOLOR, name: 'FOGCOLOR', value: 0 },
    { state: D3DRS.FOGTABLEMODE, name: 'FOGTABLEMODE', value: D3DFOG.NONE },
    { state: D3DRS.FOGSTART, name: 'FOGSTART', value: floatToDword(0.0) },
    { state: D3DRS.FOGEND, name: 'FOGEND', value: floatToDword(1.0) },
    { state: D3DRS.FOGDENSITY, name: 'FOGDENSITY', value: floatToDword(1.0) },
    { state: D3DRS.RANGEFOGENABLE, name: 'RANGEFOGENABLE', value: FALSE },
    { state: D3DRS.STENCILENABLE, name: 'STENCILENABLE', value: FALSE },
    { state: D3DRS.STENCILFAIL, name: 'STENCILFAIL', value: D3DSTENCILOP.KEEP },
    { state: D3DRS.STENCILZFAIL, name: 'STENCILZFAIL', value: D3DSTENCILOP.KEEP },
    { state: D3DRS.STENCILPASS, name: 'STENCILPASS', value: D3DSTENCILOP.KEEP },
    { state: D3DRS.STENCILFUNC, name: 'STENCILFUNC', value: D3DCMP.ALWAYS },
    { state: D3DRS.STENCILREF, name: 'STENCILREF', value: 0 },
    { state: D3DRS.STENCILMASK, name: 'STENCILMASK', value: 0xffffffff },
    { state: D3DRS.STENCILWRITEMASK, name: 'STENCILWRITEMASK', value: 0xffffffff },
    { state: D3DRS.TEXTUREFACTOR, name: 'TEXTUREFACTOR', value: 0xffffffff },
    { state: D3DRS.WRAP0, name: 'WRAP0', value: 0 },
    { state: D3DRS.WRAP1, name: 'WRAP1', value: 0 },
    { state: D3DRS.WRAP2, name: 'WRAP2', value: 0 },
    { state: D3DRS.WRAP3, name: 'WRAP3', value: 0 },
    { state: D3DRS.WRAP4, name: 'WRAP4', value: 0 },
    { state: D3DRS.WRAP5, name: 'WRAP5', value: 0 },
    { state: D3DRS.WRAP6, name: 'WRAP6', value: 0 },
    { state: D3DRS.WRAP7, name: 'WRAP7', value: 0 },
    { state: D3DRS.CLIPPING, name: 'CLIPPING', value: TRUE },
    { state: D3DRS.LIGHTING, name: 'LIGHTING', value: TRUE },
    { state: D3DRS.AMBIENT, name: 'AMBIENT', value: 0 },
    { state: D3DRS.FOGVERTEXMODE, name: 'FOGVERTEXMODE', value: D3DFOG.NONE },
    { state: D3DRS.COLORVERTEX, name: 'COLORVERTEX', value: TRUE },
    { state: D3DRS.LOCALVIEWER, name: 'LOCALVIEWER', value: TRUE },
    { state: D3DRS.NORMALIZENORMALS, name: 'NORMALIZENORMALS', value: FALSE },
    { state: D3DRS.DIFFUSEMATERIALSOURCE, name: 'DIFFUSEMATERIALSOURCE', value: D3DMCS.COLOR1 },
    { state: D3DRS.SPECULARMATERIALSOURCE, name: 'SPECULARMATERIALSOURCE', value: D3DMCS.COLOR2 },
    { state: D3DRS.AMBIENTMATERIALSOURCE, name: 'AMBIENTMATERIALSOURCE', value: D3DMCS.MATERIAL },
    { state: D3DRS.EMISSIVEMATERIALSOURCE, name: 'EMISSIVEMATERIALSOURCE', value: D3DMCS.MATERIAL },
    { state: D3DRS.VERTEXBLEND, name: 'VERTEXBLEND', value: D3DVBF.DISABLE },
    { state: D3DRS.CLIPPLANEENABLE, name: 'CLIPPLANEENABLE', value: 0 },
    { state: D3DRS.POINTSIZE, name: 'POINTSIZE', value: floatToDword(1.0), asserted: false },
    { state: D3DRS.POINTSIZE_MIN, name: 'POINTSIZE_MIN', value: floatToDword(1.0) },
    { state: D3DRS.POINTSPRITEENABLE, name: 'POINTSPRITEENABLE', value: FALSE },
    { state: D3DRS.POINTSCALEENABLE, name: 'POINTSCALEENABLE', value: FALSE },
    { state: D3DRS.POINTSCALE_A, name: 'POINTSCALE_A', value: floatToDword(1.0) },
    { state: D3DRS.POINTSCALE_B, name: 'POINTSCALE_B', value: floatToDword(0.0) },
    { state: D3DRS.POINTSCALE_C, name: 'POINTSCALE_C', value: floatToDword(0.0) },
    { state: D3DRS.MULTISAMPLEANTIALIAS, name: 'MULTISAMPLEANTIALIAS', value: TRUE },
    { state: D3DRS.MULTISAMPLEMASK, name: 'MULTISAMPLEMASK', value: 0xffffffff },
    { state: D3DRS.PATCHEDGESTYLE, name: 'PATCHEDGESTYLE', value: D3DPATCHEDGE.DISCRETE },
    {
        state: D3DRS.DEBUGMONITORTOKEN,
        name: 'DEBUGMONITORTOKEN',
        value: D3DDMT.ENABLE,
        asserted: false,
        capturedByStateBlock: false,
    },
    {
        state: D3DRS.POINTSIZE_MAX,
        name: 'POINTSIZE_MAX',
        value: floatToDword(64.0),
        dependsOn: 'maxPointSize',
    },
    { state: D3DRS.INDEXEDVERTEXBLENDENABLE, name: 'INDEXEDVERTEXBLENDENABLE', value: FALSE },
    { state: D3DRS.COLORWRITEENABLE, name: 'COLORWRITEENABLE', value: 0x0000000f },
    { state: D3DRS.TWEENFACTOR, name: 'TWEENFACTOR', value: floatToDword(0.0) },
    { state: D3DRS.BLENDOP, name: 'BLENDOP', value: D3DBLENDOP.ADD },
    { state: D3DRS.POSITIONDEGREE, name: 'POSITIONDEGREE', value: D3DDEGREE.CUBIC },
    { state: D3DRS.NORMALDEGREE, name: 'NORMALDEGREE', value: D3DDEGREE.LINEAR },
    { state: D3DRS.SCISSORTESTENABLE, name: 'SCISSORTESTENABLE', value: FALSE },
    { state: D3DRS.SLOPESCALEDEPTHBIAS, name: 'SLOPESCALEDEPTHBIAS', value: floatToDword(0.0) },
    { state: D3DRS.ANTIALIASEDLINEENABLE, name: 'ANTIALIASEDLINEENABLE', value: FALSE },
    { state: D3DRS.MINTESSELLATIONLEVEL, name: 'MINTESSELLATIONLEVEL', value: floatToDword(1.0) },
    { state: D3DRS.MAXTESSELLATIONLEVEL, name: 'MAXTESSELLATIONLEVEL', value: floatToDword(1.0) },
    { state: D3DRS.ADAPTIVETESS_X, name: 'ADAPTIVETESS_X', value: floatToDword(0.0) },
    { state: D3DRS.ADAPTIVETESS_Y, name: 'ADAPTIVETESS_Y', value: floatToDword(0.0) },
    { state: D3DRS.ADAPTIVETESS_Z, name: 'ADAPTIVETESS_Z', value: floatToDword(1.0) },
    { state: D3DRS.ADAPTIVETESS_W, name: 'ADAPTIVETESS_W', value: floatToDword(0.0) },
    {
        state: D3DRS.ENABLEADAPTIVETESSELLATION,
        name: 'ENABLEADAPTIVETESSELLATION',
        value: FALSE,
    },
    { state: D3DRS.TWOSIDEDSTENCILMODE, name: 'TWOSIDEDSTENCILMODE', value: FALSE },
    { state: D3DRS.CCW_STENCILFAIL, name: 'CCW_STENCILFAIL', value: D3DSTENCILOP.KEEP },
    { state: D3DRS.CCW_STENCILZFAIL, name: 'CCW_STENCILZFAIL', value: D3DSTENCILOP.KEEP },
    { state: D3DRS.CCW_STENCILPASS, name: 'CCW_STENCILPASS', value: D3DSTENCILOP.KEEP },
    { state: D3DRS.CCW_STENCILFUNC, name: 'CCW_STENCILFUNC', value: D3DCMP.ALWAYS },
    { state: D3DRS.COLORWRITEENABLE1, name: 'COLORWRITEENABLE1', value: 0x0000000f },
    { state: D3DRS.COLORWRITEENABLE2, name: 'COLORWRITEENABLE2', value: 0x0000000f },
    { state: D3DRS.COLORWRITEENABLE3, name: 'COLORWRITEENABLE3', value: 0x0000000f },
    { state: D3DRS.BLENDFACTOR, name: 'BLENDFACTOR', value: 0xffffffff },
    { state: D3DRS.SRGBWRITEENABLE, name: 'SRGBWRITEENABLE', value: 0 },
    { state: D3DRS.DEPTHBIAS, name: 'DEPTHBIAS', value: floatToDword(0.0) },
    { state: D3DRS.WRAP8, name: 'WRAP8', value: 0 },
    { state: D3DRS.WRAP9, name: 'WRAP9', value: 0 },
    { state: D3DRS.WRAP10, name: 'WRAP10', value: 0 },
    { state: D3DRS.WRAP11, name: 'WRAP11', value: 0 },
    { state: D3DRS.WRAP12, name: 'WRAP12', value: 0 },
    { state: D3DRS.WRAP13, name: 'WRAP13', value: 0 },
    { state: D3DRS.WRAP14, name: 'WRAP14', value: 0 },
    { state: D3DRS.WRAP15, name: 'WRAP15', value: 0 },
    { state: D3DRS.SEPARATEALPHABLENDENABLE, name: 'SEPARATEALPHABLENDENABLE', value: FALSE },
    { state: D3DRS.SRCBLENDALPHA, name: 'SRCBLENDALPHA', value: D3DBLEND.ONE },
    { state: D3DRS.DESTBLENDALPHA, name: 'DESTBLENDALPHA', value: D3DBLEND.ZERO },
    // Not D3DBLENDOP_ADD, though the two happen to share a value: the initial
    // value of the separate alpha blend operation reads back as TRUE.
    { state: D3DRS.BLENDOPALPHA, name: 'BLENDOPALPHA', value: TRUE },
]);

/**
 * @param {RenderStateDefault} entry
 * @param {DeviceStateInputs} inputs
 * @returns {number}
 */
export function resolveRenderStateDefault(entry, inputs){
    switch (entry.dependsOn)
    {
        case 'autoDepthStencil':
            return inputs.enableAutoDepthStencil ? D3DZB.TRUE : D3DZB.FALSE;
        case 'maxPointSize':
            return floatToDword(inputs.maxPointSize);
        default:
            return entry.value;
    }
}

/**
 * @param {DeviceStateInputs} inputs
 * @returns {Map<number, number>} every render state, at the value a fresh device has
 */
export function createDefaultRenderStates(inputs){
    const states = new HashedStates();
    for (const entry of DEFAULT_RENDER_STATES)
    {
        states.set(entry.state, resolveRenderStateDefault(entry, inputs) >>> 0);
    }
    return states;
}
