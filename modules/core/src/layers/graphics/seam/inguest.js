/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Methods of Direct3D 8 and 9 a program calls every frame that answer from
 * what the guest already holds, as code the guest runs (`@guestCode`,
 * compiled into `inguest.x86.js`): each was a crossing, and a call on a
 * resource first makes the device's command ring, a pause of the program's
 * that compares every dynamic buffer a draw reads.
 *
 * - TestCooperativeLevel answers D3D_OK from the device's block while the
 *   host's last answer was that (`SHADOW.COOPERATIVE`); a lost device is the
 *   host's.
 * - An event query is signalled as soon as it is issued, as the device has
 *   it: its Issue and its GetData take nothing from the host. An occlusion
 *   query's count is the GPU's: once the host has asked for it, a poll is
 *   S_FALSE in the guest until the host writes it into the block, and the
 *   count after (`QUERY.STATE`) -- a program that waits for a count polls
 *   millions of times a minute.
 *
 * The offsets are the blocks' (`shadow.js`); the test holds them to it.
 */

/**
 * The guest's memory: none of these touches the x87's control or status words.
 *
 * @typedef {import('../../win32/msvcrt/guest-code.js').GuestMemory} Guest
 */
/** @typedef {import('../../win32/msvcrt/guest-code.js').u32} u32 */

/** `SHADOW.COOPERATIVE`: zero while the device answers D3D_OK. */
const COOPERATIVE = 5352;
/** `QUERY.TYPE`. */
const QUERY_TYPE = 4;
/** `QUERY.STATE` and `QUERY.COUNT`. */
const QUERY_STATE = 8;
const QUERY_COUNT = 12;
const D3DQUERYTYPE_EVENT = 8;
const D3DQUERYTYPE_OCCLUSION = 9;
/** `QUERY.STATE`: asked for and not back; back. */
const COUNT_ASKED = 1;
const COUNT_BACK = 2;
const S_FALSE = 1;
const D3DISSUE_BEGIN = 2;
const FLAG_SLOW_PATH = 1;

/**
 * HRESULT TestCooperativeLevel(this)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function TestCooperativeLevel({ u32, host }, self){
    const block = u32(self + 4);
    if (block === 0 || (u32(block) & FLAG_SLOW_PATH) !== 0 || u32(block + COOPERATIVE) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * D3DQUERYTYPE GetType(this), from the query's block.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function QueryGetType({ u32, host }, self){
    const block = u32(self + 4);
    if (block === 0)
    {
        return host();
    }
    return u32(block + QUERY_TYPE);
}

/**
 * DWORD GetDataSize(this): four bytes, a BOOL or a count, for every query
 * the device makes.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function QueryGetDataSize({ u32, host }, self){
    if (u32(self + 4) === 0)
    {
        return host();
    }
    return 4;
}

/**
 * HRESULT Issue(this, DWORD flags): an event's END. Its BEGIN, which the
 * device refuses, and every other query are the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} flags
 * @returns {u32}
 */
export function QueryIssue({ u32, host }, self, flags){
    const block = u32(self + 4);
    if (block === 0 || u32(block + QUERY_TYPE) !== D3DQUERYTYPE_EVENT
        || (flags & D3DISSUE_BEGIN) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * HRESULT GetData(this, void *data, DWORD size, DWORD flags): an event is
 * done, TRUE in its four bytes; an occlusion query the host has asked for is
 * not done yet, S_FALSE, and one whose count is back has it in its four bytes.
 * A buffer too small for them is the host's to refuse, and every other query,
 * and an occlusion count the host has not asked for, is the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} data @param {u32} size
 * @param {u32} flags
 * @returns {u32}
 */
export function QueryGetData({ u32, setU32, host }, self, data, size, flags){
    const block = u32(self + 4);
    if (block === 0 || (size !== 0 && size < 4) || flags > 1)
    {
        return host();
    }
    const type = u32(block + QUERY_TYPE);
    if (type === D3DQUERYTYPE_OCCLUSION)
    {
        const state = u32(block + QUERY_STATE);
        if (state === COUNT_ASKED)
        {
            return S_FALSE;
        }
        if (state !== COUNT_BACK)
        {
            return host();
        }
        if (data !== 0 && size !== 0)
        {
            setU32(data, u32(block + QUERY_COUNT));
        }
        return 0;
    }
    if (type !== D3DQUERYTYPE_EVENT)
    {
        return host();
    }
    if (data !== 0 && size !== 0)
    {
        setU32(data, 1);
    }
    return 0;
}
