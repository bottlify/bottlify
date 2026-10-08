/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A device method's failures, said aloud. A program told D3DERR_INVALIDCALL goes on
 * without what it asked for -- a copy not made, a target not set -- and nothing on the
 * screen says why; the report must. Each method and code is said once, so a failure in a
 * frame loop is one line.
 */

/** The failures a device method answers with, by name. */
const HRESULT_NAMES = new Map([
    [0x8876086c, 'D3DERR_INVALIDCALL'], [0x8876086a, 'D3DERR_NOTAVAILABLE'],
    [0x8876017c, 'D3DERR_OUTOFVIDEOMEMORY'], [0x88760868, 'D3DERR_DEVICELOST'],
    [0x88760869, 'D3DERR_DEVICENOTRESET'], [0x88760866, 'D3DERR_NOTFOUND'],
    [0x88760867, 'D3DERR_MOREDATA'], [0x8876081d, 'D3DERR_CONFLICTINGRENDERSTATE'],
    [0x80004001, 'E_NOTIMPL'], [0x80070057, 'E_INVALIDARG'], [0x8007000e, 'E_OUTOFMEMORY'],
    [0x80004005, 'E_FAIL'],
]);

/** @param {number} hr */
export const hresultName = hr=>HRESULT_NAMES.get(hr >>> 0) ?? `0x${(hr >>> 0).toString(16)}`;

/**
 * A reporter for one API's device methods.
 *
 * @param {string} api   'Direct3D 9'
 * @param {((api: string, detail: string) => void) | undefined} divergence
 * @returns {(name: string, answer: any) => any}  the answer, passed through, a promise too
 */
export function loudRefusals(api, divergence){
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} name @param {any} hr */
    const say = (name, hr)=>{
        if (typeof hr === 'number' && (hr & 0x80000000) !== 0 && divergence)
        {
            const key = `${name}:${hr >>> 0}`;
            if (!said.has(key))
            {
                said.add(key);
                divergence(api, `${name} answered ${hresultName(hr)}`);
            }
        }
        return hr;
    };
    return (name, answer)=>(answer instanceof Promise ? answer.then(hr=>say(name, hr))
        : say(name, answer));
}
