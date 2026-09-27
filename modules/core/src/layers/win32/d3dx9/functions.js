/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9 — the maths half of the Direct3D helper library.
 *
 * These are the functions a program links from d3dx9 that touch no device:
 * matrix and vector arithmetic over the caller's own memory. They matter here
 * for a reason that has nothing to do with drawing: d3dx9 exports every one of
 * them by an *undecorated* name, though each is `__stdcall`. An import bound to
 * a stub that pops nothing then leaves the caller's stack short by the width of
 * the arguments -- and a program that calls one during start-up walks off into
 * data a few frames later and faults on the first byte it tries to run. So the
 * whole of this file's contract is the byte counts; the maths is here because
 * once the count is right the maths is a few lines and a program that transposes
 * a matrix expects the transpose.
 *
 * The ones that build an effect need a device, which this maths-only surface
 * does not have; they answer E_NOTIMPL, with the argument width still declared.
 *
 * Matrices are row-major, sixteen floats, `m[row * 4 + col]` -- the layout
 * D3DXMATRIX has in memory and the one every function here reads and writes.
 * The arithmetic is code in the guest's own d3dx9 (`inguest.js`,
 * `inguest-matrix.js`, `inguest-vector.js`, `inguest-quaternion.js`),
 * compiled from its JavaScript: a program that multiplies its matrices every
 * frame pays for the x87's instructions, not a crossing into the host. Every
 * function each of those modules compiles is an export, and the table is the
 * same for every version of the library from d3dx9_24 to d3dx9_43, whose
 * mathematics does not differ.
 */

import { guestEntry } from '../msvcrt/guest-code.js';
import * as inGuest from './inguest.js';
import * as matrix from './inguest-matrix.js';
import * as vector from './inguest-vector.js';
import * as quaternion from './inguest-quaternion.js';
import { COMPILED } from './inguest.x86.js';
import { COMPILED as MATRIX } from './inguest-matrix.x86.js';
import { COMPILED as VECTOR } from './inguest-vector.x86.js';
import { COMPILED as QUATERNION } from './inguest-quaternion.x86.js';

const E_NOTIMPL = 0x80004001;

/**
 * Each module of guest code and what the build made of it: every function
 * compiled is exported under its own name.
 *
 * @type {[Record<string, any>, Record<string, import('../msvcrt/guest-code.js').CompiledGuestCode>][]}
 */
const IN_GUEST = [[inGuest, COMPILED], [matrix, MATRIX], [vector, VECTOR],
    [quaternion, QUATERNION]];

/**
 * @typedef {Object} D3dxHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {D3dxHost} host
 */
export function createD3dxFunctions(host){
    /** @param {number} address @param {Float32Array} values */
    const writeFloats = (address, values)=>host.writeMemory(address >>> 0,
        new Uint8Array(values.buffer, values.byteOffset, values.byteLength));

    return {
        ...Object.fromEntries(IN_GUEST.flatMap(([source, compiled])=>Object.keys(compiled)
            .map(name=>[name, guestEntry(source[name], compiled[name], host)]))),

        /**
         * The effect facilities, which build objects on a device this maths
         * surface does not hold. Declared for their stack width and answered
         * E_NOTIMPL, which a caller checks; the effect pointer is left null.
         *
         * HRESULT D3DXCreateEffectPool(LPD3DXEFFECTPOOL* ppPool)
         * HRESULT D3DXCreateEffectFromResourceA(device, hSrcModule, pSrcResource,
         *     pDefines, pInclude, Flags, pPool, ppEffect, ppCompilationErrors)
         */
        D3DXCreateEffectPool: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pool])=>{
                if ((pool >>> 0) !== 0)
                {
                    writeFloats(pool, Float32Array.of(0));
                }
                return E_NOTIMPL;
            },
        },

        D3DXCreateEffectFromResourceA: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([, , , , , , , effect])=>{
                if ((effect >>> 0) !== 0)
                {
                    writeFloats(effect, Float32Array.of(0));
                }
                return E_NOTIMPL;
            },
        },
    };
}
