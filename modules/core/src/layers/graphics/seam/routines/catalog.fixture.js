/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every guest routine of the graphics seam, built at a fixed place, for the
 * checks that read routines by their instructions (`publish-order.test.js`,
 * `tools/checks/check-lock-release.mjs`): one list, so that a routine added
 * to a family is read by both.
 *
 * `routinesFor(X64)` is the x86-64 a 64-bit process runs: only the routines
 * built for that width (`Width`), told by bytes that differ from their i386,
 * since a builder that ignores the width hands back the i386 - which a
 * 64-bit process never runs, and which does not decode as x86-64.
 *
 * For the tests and tools: nothing in the product reads it.
 */

import { I386 } from './assemble.js';
import { commandCode } from './command.js';
import {
    getLevelDescCode, getRenderStateCode, getSamplerStateCode, getShaderCode, getSurfaceDescCode,
    getSurfaceLevelCode, getTargetCode, getTextureStageStateCode, getTransformCode, getViewportCode,
} from './getters.js';
import {
    lock7Code, lockCode, lockLevelCode, moveCopyCode, unlockCode, unlockLevelCode,
} from './locks.js';
import { COMMANDS as D3D9_COMMANDS, commandSlot as d3d9Slot } from '../../d3d9/commands.js';
import { D3D8_COMMANDS } from '../../d3d8/commands.js';
import { D3D7_COMMANDS } from '../../d3d7/commands.js';
import { GL_COMMANDS } from '../../opengl/commands.js';

/** Where every routine is built, and the trap its slow way jumps to. */
export const ROUTINE_AT = 0x20000;
export const ROUTINE_TRAP = 0x105000;

/**
 * @typedef {Object} CatalogRoutine
 * @property {string} name
 * @property {Uint8Array} code
 * @property {boolean} command  one of the command routines, which record a call
 */

/**
 * Every routine as built for `width`: the builders handed it as their last
 * argument, which those not yet built for it ignore.
 *
 * @param {import('./assemble.js').Width} width
 * @returns {CatalogRoutine[]}
 */
function allFor(width){
    const AT = ROUTINE_AT;
    const TRAP = ROUTINE_TRAP;
    /** @type {[string, (w: any) => Uint8Array][]} */
    const built = [
        ['Lock', w=>/** @type {any} */ (lockCode)(AT, TRAP, undefined, undefined, w)],
        ['Lock with moves', w=>/** @type {any} */ (lockCode)(AT, TRAP, 0x7f, AT + 0x1000, w)],
        ['the copy of a move', w=>/** @type {any} */ (moveCopyCode)(w)],
        ['Lock (Direct3D 7)', ()=>lock7Code(AT, TRAP)],
        ['Unlock', w=>/** @type {any} */ (unlockCode)(AT, TRAP, w)],
        ['texture LockRect', w=>/** @type {any} */ (lockLevelCode)(AT, TRAP,
            { find: 'texture' }, w)],
        ['texture LockBox', w=>/** @type {any} */ (lockLevelCode)(AT, TRAP,
            { find: 'texture', box: true }, w)],
        ['surface LockRect', w=>/** @type {any} */ (lockLevelCode)(AT, TRAP,
            { find: 'surface' }, w)],
        ['texture UnlockRect', w=>/** @type {any} */ (unlockLevelCode)(AT, TRAP,
            { find: 'texture' }, w)],
        ['surface UnlockRect', w=>/** @type {any} */ (unlockLevelCode)(AT, TRAP,
            { find: 'surface' }, w)],
        ['GetRenderTarget', w=>/** @type {any} */ (getTargetCode)(AT, TRAP,
            { depth: false, indexed: true }, w)],
        ['GetDepthStencilSurface', w=>/** @type {any} */ (getTargetCode)(AT, TRAP,
            { depth: true, indexed: false }, w)],
        ['GetRenderState', w=>getRenderStateCode(AT, TRAP, w)],
        ['GetTransform', w=>/** @type {any} */ (getTransformCode)(AT, TRAP, false, w)],
        ['GetTextureStageState', w=>/** @type {any} */ (getTextureStageStateCode)(AT, TRAP,
            0xffffffff, w)],
        ['GetViewport', w=>/** @type {any} */ (getViewportCode)(AT, TRAP, w)],
        ['GetVertexShader', w=>/** @type {any} */ (getShaderCode)(AT, TRAP, 0, w)],
        ['GetPixelShader', w=>/** @type {any} */ (getShaderCode)(AT, TRAP, 1, w)],
        ['GetSurfaceDesc', w=>/** @type {any} */ (getSurfaceDescCode)(AT, TRAP, w)],
        ['GetSamplerState', w=>/** @type {any} */ (getSamplerStateCode)(AT, TRAP, w)],
        ['GetSurfaceLevel', w=>/** @type {any} */ (getSurfaceLevelCode)(AT, TRAP, w)],
        ['GetLevelDesc', w=>/** @type {any} */ (getLevelDescCode)(AT, TRAP, w)],
    ];
    /** @type {CatalogRoutine[]} */
    const routines = built.map(([name, build])=>({ name, code: build(width), command: false }));
    /**
     * @param {string} family @param {Record<string, any>} table
     * @param {(name: string) => number} slotOf @param {Record<string, any>} [more]
     */
    const commands = (family, table, slotOf, more = {})=>{
        for (const [name, shape] of Object.entries(table))
        {
            routines.push({ name: `${family} ${name}`, command: true,
                code: /** @type {any} */ (commandCode)(AT, TRAP,
                    { ...shape, slot: slotOf(name), ...more }, width) });
        }
    };
    commands('Direct3D 9', D3D9_COMMANDS, d3d9Slot);
    commands('Direct3D 8', D3D8_COMMANDS.COMMANDS, D3D8_COMMANDS.commandSlot);
    commands('Direct3D 7', D3D7_COMMANDS.COMMANDS, D3D7_COMMANDS.commandSlot);
    commands('OpenGL', GL_COMMANDS.COMMANDS, GL_COMMANDS.commandSlot, { thread: true });
    return routines;
}

/** @param {Uint8Array} a @param {Uint8Array} b */
const same = (a, b)=>a.length === b.length && a.every((byte, i)=>byte === b[i]);

/**
 * The routines a process of `width` runs: every one in a 32-bit process; in
 * a 64-bit one, those built for it.
 *
 * @param {import('./assemble.js').Width} width
 * @returns {CatalogRoutine[]}
 */
export function routinesFor(width){
    const narrow = allFor(I386);
    if (width.bits === 32)
    {
        return narrow;
    }
    return allFor(width).filter((routine, i)=>!same(routine.code, narrow[i].code));
}
