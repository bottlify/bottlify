/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The texture stage state a D3D8 device has before a program has set anything.
 *
 * Two entries depend on which stage they are for, and both are the reason the
 * cascade is off until a program arms it: stage zero modulates the texture
 * with what came before it and every later stage is disabled, so a program
 * that binds one texture and touches no stage state gets it drawn, and one
 * that binds two gets the second ignored until it says how to combine it. The
 * coordinate index likewise follows the stage, so stage one reads the second
 * coordinate set unless told otherwise.
 */

import { D3DTA, D3DTADDRESS, D3DTEXF, D3DTOP, D3DTSS } from './constants.js';

/**
 * @typedef {Object} StageStateDefault
 * @property {number} state
 * @property {string} name
 * @property {number} value         The DWORD every stage but zero reads back.
 * @property {number} [stageZero]   What stage zero reads back instead, when it differs.
 * @property {boolean} [followsStage]  True when the value is the stage index itself.
 */

/** @type {readonly StageStateDefault[]} */
export const DEFAULT_STAGE_STATES = Object.freeze([
    { state: D3DTSS.COLOROP, name: 'COLOROP', value: D3DTOP.DISABLE, stageZero: D3DTOP.MODULATE },
    { state: D3DTSS.COLORARG1, name: 'COLORARG1', value: D3DTA.TEXTURE },
    { state: D3DTSS.COLORARG2, name: 'COLORARG2', value: D3DTA.CURRENT },
    {
        state: D3DTSS.ALPHAOP,
        name: 'ALPHAOP',
        value: D3DTOP.DISABLE,
        stageZero: D3DTOP.SELECTARG1,
    },
    { state: D3DTSS.ALPHAARG1, name: 'ALPHAARG1', value: D3DTA.TEXTURE },
    { state: D3DTSS.ALPHAARG2, name: 'ALPHAARG2', value: D3DTA.CURRENT },
    { state: D3DTSS.BUMPENVMAT00, name: 'BUMPENVMAT00', value: 0 },
    { state: D3DTSS.BUMPENVMAT01, name: 'BUMPENVMAT01', value: 0 },
    { state: D3DTSS.BUMPENVMAT10, name: 'BUMPENVMAT10', value: 0 },
    { state: D3DTSS.BUMPENVMAT11, name: 'BUMPENVMAT11', value: 0 },
    { state: D3DTSS.TEXCOORDINDEX, name: 'TEXCOORDINDEX', value: 0, followsStage: true },
    { state: D3DTSS.ADDRESSU, name: 'ADDRESSU', value: D3DTADDRESS.WRAP },
    { state: D3DTSS.ADDRESSV, name: 'ADDRESSV', value: D3DTADDRESS.WRAP },
    { state: D3DTSS.BORDERCOLOR, name: 'BORDERCOLOR', value: 0 },
    { state: D3DTSS.MAGFILTER, name: 'MAGFILTER', value: D3DTEXF.POINT },
    { state: D3DTSS.MINFILTER, name: 'MINFILTER', value: D3DTEXF.POINT },
    { state: D3DTSS.MIPFILTER, name: 'MIPFILTER', value: D3DTEXF.NONE },
    { state: D3DTSS.MIPMAPLODBIAS, name: 'MIPMAPLODBIAS', value: 0 },
    { state: D3DTSS.MAXMIPLEVEL, name: 'MAXMIPLEVEL', value: 0 },
    { state: D3DTSS.MAXANISOTROPY, name: 'MAXANISOTROPY', value: 1 },
    { state: D3DTSS.BUMPENVLSCALE, name: 'BUMPENVLSCALE', value: 0 },
    { state: D3DTSS.BUMPENVLOFFSET, name: 'BUMPENVLOFFSET', value: 0 },
    { state: D3DTSS.TEXTURETRANSFORMFLAGS, name: 'TEXTURETRANSFORMFLAGS', value: 0 },
    { state: D3DTSS.ADDRESSW, name: 'ADDRESSW', value: D3DTADDRESS.WRAP },
    { state: D3DTSS.COLORARG0, name: 'COLORARG0', value: D3DTA.CURRENT },
    { state: D3DTSS.ALPHAARG0, name: 'ALPHAARG0', value: D3DTA.CURRENT },
    { state: D3DTSS.RESULTARG, name: 'RESULTARG', value: D3DTA.CURRENT },
]);

/**
 * @param {StageStateDefault} entry
 * @param {number} stage
 * @returns {number}
 */
export function resolveStageStateDefault(entry, stage){
    if (entry.followsStage)
    {
        return stage;
    }
    if (stage === 0 && entry.stageZero !== undefined)
    {
        return entry.stageZero;
    }
    return entry.value;
}

/**
 * @param {number} stage
 * @returns {Map<number, number>} every stage state, at the value a fresh device has
 */
export function createDefaultStageStates(stage){
    /** @type {Map<number, number>} */
    const states = new Map();
    for (const entry of DEFAULT_STAGE_STATES)
    {
        states.set(entry.state, resolveStageStateDefault(entry, stage) >>> 0);
    }
    return states;
}
