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
 * - GetCreationParameters answers what the host wrote into the device's
 *   block when it made it (`SHADOW.CREATION`): they never change.
 * - TestCooperativeLevel answers D3D_OK from the device's block while the
 *   host's last answer was that (`SHADOW.COOPERATIVE`); a lost device is the
 *   host's.
 * - An event query is signalled as soon as it is issued, as the device has
 *   it: its Issue and its GetData take nothing from the host. An occlusion
 *   query's count is the GPU's: once the host has asked for it, a poll is
 *   S_FALSE in the guest until the host writes it into the block, and the
 *   count after (`QUERY.STATE`) -- a program that waits for a count polls
 *   millions of times a minute -- but for one poll in so many, which is the
 *   host's (`QUERY.BUDGET`).
 *
 * The offsets are the blocks' (`block.js`); the test holds them to it. An
 * interface's block is the word after its method table's: `self + 4` in a
 * 32-bit process, `self + 8` in a 64-bit one (`pointerBytes`), whose
 * x86-64 build is `inguest.x64.js`.
 */

/**
 * The guest's memory and the pointer's size: none of these touches the x87's
 * control or status words.
 *
 * @typedef {import('../../win32/msvcrt/guest-code.js').GuestMemory
 *     & Pick<import('../../win32/msvcrt/guest-code.js').Guest, 'pointerBytes'>} Guest
 */
/** @typedef {import('../../win32/msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../../win32/msvcrt/guest-code.js').ptr} ptr */

/** `SHADOW.COOPERATIVE`: zero while the device answers D3D_OK. */
const COOPERATIVE = 5352;
/** `QUERY.TYPE`. */
const QUERY_TYPE = 4;
/** `QUERY.STATE`, `QUERY.COUNT` and `QUERY.BUDGET`. */
const QUERY_STATE = 8;
const QUERY_COUNT = 12;
const QUERY_BUDGET = 16;
const D3DQUERYTYPE_EVENT = 8;
const D3DQUERYTYPE_OCCLUSION = 9;
/**
 * `COUNT_STATE`: asked for and not back; back; the played side writes it and
 * nothing has flushed its draws; the same, flushed. The state's low three bits.
 */
const COUNT_ASKED = 1;
const COUNT_BACK = 2;
const COUNT_WRITTEN = 3;
const COUNT_FLUSHED = 4;
const COUNT_STATE_MASK = 7;
const D3DGETDATA_FLUSH = 1;
const S_FALSE = 1;
const D3DISSUE_BEGIN = 2;
const FLAG_SLOW_PATH = 1;
/** `SHADOW.CREATION`. */
const CREATION = 5544;

/**
 * HRESULT TestCooperativeLevel(this)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {ptr} self
 * @returns {u32}
 */
export function TestCooperativeLevel({ u32, host, pointerBytes }, self){
    const block = u32(self + pointerBytes);
    if (block === 0 || (u32(block) & FLAG_SLOW_PATH) !== 0 || u32(block + COOPERATIVE) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * HRESULT GetCreationParameters(this, D3DDEVICE_CREATION_PARAMETERS *out),
 * from the device's block (`SHADOW.CREATION`), laid out for the process's
 * width: the focus window a pointer's size, the behaviour flags after it. A
 * null pointer and a block that holds none are the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {ptr} self @param {ptr} out
 * @returns {u32}
 */
export function GetCreationParameters({ u32, setU32, host, pointerBytes }, self, out){
    const block = u32(self + pointerBytes);
    if (out === 0 || block === 0 || u32(block + CREATION + 4) === 0)
    {
        return host();
    }
    setU32(out, u32(block + CREATION));
    setU32(out + 4, u32(block + CREATION + 4));
    setU32(out + 8, u32(block + CREATION + 8));
    if (pointerBytes === 8)
    {
        setU32(out + 12, 0);
        setU32(out + 16, u32(block + CREATION + 12));
    }
    else
    {
        setU32(out + 12, u32(block + CREATION + 12));
    }
    return 0;
}

/**
 * D3DQUERYTYPE GetType(this), from the query's block.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {ptr} self
 * @returns {u32}
 */
export function QueryGetType({ u32, host, pointerBytes }, self){
    const block = u32(self + pointerBytes);
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
 * @param {Guest} guest @param {ptr} self
 * @returns {u32}
 */
export function QueryGetDataSize({ u32, host, pointerBytes }, self){
    if (u32(self + pointerBytes) === 0)
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
 * @param {Guest} guest @param {ptr} self @param {u32} flags
 * @returns {u32}
 */
export function QueryIssue({ u32, host, pointerBytes }, self, flags){
    const block = u32(self + pointerBytes);
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
 * not done yet, S_FALSE, and one whose count is back has it in its four bytes,
 * or eight where there is room for them (Wine's test_occlusion_query).
 * A buffer too small for them is the host's to refuse, and every other query,
 * and an occlusion count the host has not asked for, is the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {ptr} self @param {ptr} data @param {u32} size
 * @param {u32} flags
 * @returns {u32}
 */
export function QueryGetData({ u32, setU32, host, pointerBytes }, self, data, size, flags){
    const block = u32(self + pointerBytes);
    if (block === 0 || (size !== 0 && size < 4) || flags > 1)
    {
        return host();
    }
    const type = u32(block + QUERY_TYPE);
    if (type === D3DQUERYTYPE_OCCLUSION)
    {
        const state = u32(block + QUERY_STATE) & COUNT_STATE_MASK;
        // A count the played side writes here: the poll that first asks
        // for a flush is the host's, which sends the draws on; every other
        // poll is answered here until the count lands.
        if (state === COUNT_WRITTEN)
        {
            if ((flags & D3DGETDATA_FLUSH) !== 0)
            {
                return host();
            }
            return S_FALSE;
        }
        if (state === COUNT_FLUSHED)
        {
            return S_FALSE;
        }
        if (state === COUNT_ASKED)
        {
            // Every so many polls one is the host's, which looks for the count.
            const left = u32(block + QUERY_BUDGET);
            if (left === 0)
            {
                return host();
            }
            setU32(block + QUERY_BUDGET, left - 1);
            return S_FALSE;
        }
        if (state !== COUNT_BACK)
        {
            return host();
        }
        if (data !== 0 && size !== 0)
        {
            setU32(data, u32(block + QUERY_COUNT));
            // Room for eight bytes takes the count as the 64-bit one it is.
            if (size >= 8)
            {
                setU32(data + 4, 0);
            }
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
