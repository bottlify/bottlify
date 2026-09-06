/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The render state a D3D8 device has before a program has set anything.
 *
 * The values a state shares with D3D9 are not restated: the table is the D3D9
 * one, cut at the highest state number D3D8 knows, with D3D8's own six states
 * added and its two renamed states relabelled. Restating them would create a
 * second copy free to drift from the first, and the drift would show up as a
 * picture that is subtly wrong rather than as a failed call.
 *
 * The cut is exact rather than approximate: every D3D9 state at or below
 * D3DRS_MAX exists in D3D8 with the same number and the same initial value,
 * and every state above it was introduced afterwards.
 *
 * One D3D8 default is not a constant and its condition travels with it:
 * SOFTWAREVERTEXPROCESSING follows how the device was created, the way ZENABLE
 * follows the automatic depth stencil and POINTSIZE_MAX follows the reported
 * maximum point size.
 */

import { floatToDword } from '../d3d9/constants.js';
import {
    DEFAULT_RENDER_STATES as DEFAULT_RENDER_STATES_9, resolveRenderStateDefault
    as resolveSharedDefault,
} from '../d3d9/renderstates.js';
import { D3DRS, D3DRS_MAX, D3DRS_RENAMED_IN_D3D9 } from './constants.js';

const TRUE = 1;
const FALSE = 0;

/**
 * @typedef {import('../d3d9/renderstates.js').RenderStateDefault} SharedDefault
 */

/**
 * @typedef {Object} RenderStateDefault
 * @property {number} state
 * @property {string} name
 * @property {number} value
 * @property {'autoDepthStencil' | 'maxPointSize' | 'softwareVertexProcessing'} [dependsOn]
 * @property {boolean} [asserted]
 * @property {boolean} [capturedByStateBlock]
 */

/** @type {readonly string[]} */
const RENAMED_IN_D3D9 = Object.keys(D3DRS_RENAMED_IN_D3D9);

/** @param {SharedDefault} entry */
function relabel(entry){
    const d3d8Name = RENAMED_IN_D3D9.find(name=>D3DRS[name] === entry.state);
    return d3d8Name ? { ...entry, name: d3d8Name } : entry;
}

/**
 * The six states D3D9 does not have. Five are plain constants; the sixth is
 * the vertex-processing switch, whose initial value is whatever the device was
 * created with rather than a fixed one.
 *
 * @type {readonly RenderStateDefault[]}
 */
export const D3D8_ONLY_RENDER_STATES = Object.freeze([
    { state: D3DRS.LINEPATTERN, name: 'LINEPATTERN', value: 0 },
    { state: D3DRS.ZVISIBLE, name: 'ZVISIBLE', value: FALSE },
    { state: D3DRS.EDGEANTIALIAS, name: 'EDGEANTIALIAS', value: FALSE },
    { state: D3DRS.ZBIAS, name: 'ZBIAS', value: 0 },
    {
        state: D3DRS.SOFTWAREVERTEXPROCESSING,
        name: 'SOFTWAREVERTEXPROCESSING',
        value: FALSE,
        dependsOn: 'softwareVertexProcessing',
    },
    { state: D3DRS.PATCHSEGMENTS, name: 'PATCHSEGMENTS', value: floatToDword(1.0) },
]);

/** @type {readonly RenderStateDefault[]} */
export const DEFAULT_RENDER_STATES = Object.freeze([
    ...DEFAULT_RENDER_STATES_9.filter(entry=>entry.state <= D3DRS_MAX).map(relabel),
    ...D3D8_ONLY_RENDER_STATES,
]);

/**
 * @typedef {Object} DeviceStateInputs
 * @property {boolean} enableAutoDepthStencil
 * @property {number} maxPointSize
 * @property {boolean} softwareVertexProcessing
 */

/**
 * @param {RenderStateDefault} entry
 * @param {DeviceStateInputs} inputs
 * @returns {number}
 */
export function resolveRenderStateDefault(entry, inputs){
    if (entry.dependsOn === 'softwareVertexProcessing')
    {
        return inputs.softwareVertexProcessing ? TRUE : FALSE;
    }
    return resolveSharedDefault(/** @type {SharedDefault} */ (entry), inputs);
}

/**
 * @param {DeviceStateInputs} inputs
 * @returns {Map<number, number>} every render state, at the value a fresh device has
 */
export function createDefaultRenderStates(inputs){
    /** @type {Map<number, number>} */
    const states = new Map();
    for (const entry of DEFAULT_RENDER_STATES)
    {
        states.set(entry.state, resolveRenderStateDefault(entry, inputs) >>> 0);
    }
    return states;
}
