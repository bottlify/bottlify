/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sampler state, and where a Direct3D 9 device keeps it.
 *
 * Direct3D 9 took the address modes, filters and level limits out of the
 * texture stage and gave them a table of their own, indexed by sampler. The
 * renderer behind this device is shared with Direct3D 8 and reads those
 * settings from the stage's map under the stage-state numbers 8 used, so a
 * sampler state is stored in the stage's map at 8's number: one place, read
 * by both versions, and the D3D9 device translates the number on the way in
 * and on the way out. The three states 8 never had go into the same map at
 * numbers 8 never used.
 */

import { D3DTSS } from '../d3d8/constants.js';

/** D3DSAMPLERSTATETYPE. */
export const D3DSAMP = Object.freeze({
    ADDRESSU: 1,
    ADDRESSV: 2,
    ADDRESSW: 3,
    BORDERCOLOR: 4,
    MAGFILTER: 5,
    MINFILTER: 6,
    MIPFILTER: 7,
    MIPMAPLODBIAS: 8,
    MAXMIPLEVEL: 9,
    MAXANISOTROPY: 10,
    SRGBTEXTURE: 11,
    ELEMENTINDEX: 12,
    DMAPOFFSET: 13,
});

/**
 * D3DTEXTURESTAGESTATETYPE as Direct3D 9 declares it: 8's list with the
 * sampler entries removed and one constant added at the end.
 */
export const D3DTSS9 = Object.freeze({
    COLOROP: 1,
    COLORARG1: 2,
    COLORARG2: 3,
    ALPHAOP: 4,
    ALPHAARG1: 5,
    ALPHAARG2: 6,
    BUMPENVMAT00: 7,
    BUMPENVMAT01: 8,
    BUMPENVMAT10: 9,
    BUMPENVMAT11: 10,
    TEXCOORDINDEX: 11,
    BUMPENVLSCALE: 22,
    BUMPENVLOFFSET: 23,
    TEXTURETRANSFORMFLAGS: 24,
    COLORARG0: 26,
    ALPHAARG0: 27,
    RESULTARG: 28,
    CONSTANT: 32,
});

/** Where each D3DSAMP lives in a stage's map, indexed by D3DSAMP. */
export const SAMPLER_STATE_KEY = Object.freeze([
    0,
    D3DTSS.ADDRESSU,
    D3DTSS.ADDRESSV,
    D3DTSS.ADDRESSW,
    D3DTSS.BORDERCOLOR,
    D3DTSS.MAGFILTER,
    D3DTSS.MINFILTER,
    D3DTSS.MIPFILTER,
    D3DTSS.MIPMAPLODBIAS,
    D3DTSS.MAXMIPLEVEL,
    D3DTSS.MAXANISOTROPY,
    // The three 8 never had, at numbers no stage state of either version uses.
    40,
    41,
    42,
]);

/** The number of samplers a pixel stage has, and where the vertex samplers start. */
export const SAMPLER_COUNT = 16;
export const D3DDMAPSAMPLER = 256;
export const D3DVERTEXTEXTURESAMPLER0 = 257;
export const VERTEX_SAMPLER_COUNT = 4;

/**
 * Whether a sampler number names a sampler at all: the sixteen pixel ones,
 * the displacement map sampler and the four vertex ones.
 *
 * @param {number} sampler
 */
export function isSampler(sampler){
    return (sampler >= 0 && sampler < SAMPLER_COUNT)
        || sampler === D3DDMAPSAMPLER
        || (sampler >= D3DVERTEXTEXTURESAMPLER0
            && sampler < D3DVERTEXTEXTURESAMPLER0 + VERTEX_SAMPLER_COUNT);
}

/**
 * The keys a fresh stage map gets beyond 8's defaults: the stage constant and
 * the three sampler states 8 never had, all zero.
 *
 * @param {Map<number, number>} states
 */
export function addDirect3D9StageDefaults(states){
    states.set(D3DTSS9.CONSTANT, 0);
    states.set(SAMPLER_STATE_KEY[D3DSAMP.SRGBTEXTURE], 0);
    states.set(SAMPLER_STATE_KEY[D3DSAMP.ELEMENTINDEX], 0);
    states.set(SAMPLER_STATE_KEY[D3DSAMP.DMAPOFFSET], 0);
    return states;
}
