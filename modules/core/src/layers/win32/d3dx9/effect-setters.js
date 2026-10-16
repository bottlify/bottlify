/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ID3DXEffect's setters as code in the guest: a program sets a world matrix,
 * a colour or a texture before almost every draw, thousands of times a
 * frame, and each was a crossing into the host. Each `@guestCode` function
 * here is compiled by the build (`scripts/guest-code/`) into
 * `effect-setters.x86.js` and runs in the method's vtable slot.
 *
 * Each takes the case a program makes almost always -- a handle the effect
 * handed out, a parameter of the setter's own type and shape, no parameter
 * block being recorded -- reads the handle's record (`HANDLE` in
 * `effect.js`), writes the data into the parameter's store and dates it by
 * the clock, as the host's setter does. A name given for a handle, as D3DX
 * takes one, is looked up in the effect's table of names (`Resolve`). Any other
 * case -- a name not there, a type to convert, a colour packed into an int, an invalid call --
 * is handed to the host's setter unchanged (`return host()`), which answers
 * it as before; nothing is written before it goes.
 *
 * The interface's state word (`[this + 4]`) is the effect's block
 * (`EFFECT_BLOCK`): whether a parameter block is being recorded, the bounds
 * of the arena the handles are in, and the clock. A handle is taken as one
 * only within those bounds and on a record's boundary, so a name the program
 * passes for a handle is never read here.
 */

/** @typedef {import('../msvcrt/guest-code.js').Guest} Guest */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */

/**
 * The effect block's words for names (`EFFECT_BLOCK`): the table of the
 * parameters' names -- a mask, then for each slot the name's hash, where the
 * name is and its record, an empty slot's record 0 -- and where `Resolve` is.
 */
const BLOCK_NAMES = 48;
const BLOCK_RESOLVE = 52;

/** D3DXPARAMETER_TYPE. */
const PT_BOOL = 1;
const PT_INT = 2;
const PT_FLOAT = 3;
const PT_TEXTURE = 5;
const PT_TEXTURECUBE = 9;
/** D3DXPARAMETER_CLASS. */
const PC_SCALAR = 0;
const PC_VECTOR = 1;
const PC_MATRIX_ROWS = 2;
const PC_MATRIX_COLUMNS = 3;
const PC_STRUCT = 5;

/**
 * HRESULT SetMatrix(D3DXHANDLE hParameter, CONST D3DXMATRIX *pMatrix): a float
 * matrix's rows and columns from the matrix's top left, row by row.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} m
 * @returns {u32}
 */
export function SetMatrix({ u32, setU32, callStd, host }, self, h, m){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (m === 0)
    {
        return host();
    }
    if (u32(p) !== PT_FLOAT || u32(p + 16) !== 0)
    {
        return host();
    }
    const cls = u32(p + 4);
    const rows = u32(p + 8);
    const columns = u32(p + 12);
    if ((cls !== PC_MATRIX_ROWS && cls !== PC_MATRIX_COLUMNS) || rows > 4 || columns > 4)
    {
        return host();
    }
    let to = u32(p + 24);
    for (let r = 0; r < (rows | 0); r++)
    {
        for (let c = 0; c < (columns | 0); c++)
        {
            setU32(to, u32(m + r * 16 + c * 4));
            to = (to + 4) >>> 0;
        }
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetMatrixTranspose(D3DXHANDLE hParameter, CONST D3DXMATRIX *pMatrix):
 * as SetMatrix, the matrix read by its columns.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} m
 * @returns {u32}
 */
export function SetMatrixTranspose({ u32, setU32, callStd, host }, self, h, m){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (m === 0)
    {
        return host();
    }
    if (u32(p) !== PT_FLOAT || u32(p + 16) !== 0)
    {
        return host();
    }
    const cls = u32(p + 4);
    const rows = u32(p + 8);
    const columns = u32(p + 12);
    if ((cls !== PC_MATRIX_ROWS && cls !== PC_MATRIX_COLUMNS) || rows > 4 || columns > 4)
    {
        return host();
    }
    let to = u32(p + 24);
    for (let r = 0; r < (rows | 0); r++)
    {
        for (let c = 0; c < (columns | 0); c++)
        {
            setU32(to, u32(m + c * 16 + r * 4));
            to = (to + 4) >>> 0;
        }
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetVector(D3DXHANDLE hParameter, CONST D3DXVECTOR4 *pVector): a float
 * scalar's or vector's columns.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} v
 * @returns {u32}
 */
export function SetVector({ u32, setU32, callStd, host }, self, h, v){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (v === 0)
    {
        return host();
    }
    const cls = u32(p + 4);
    const columns = u32(p + 12);
    if (u32(p) !== PT_FLOAT || u32(p + 16) !== 0 || (cls !== PC_SCALAR && cls !== PC_VECTOR)
        || columns > 4)
    {
        return host();
    }
    const data = u32(p + 24);
    for (let i = 0; i < (columns | 0); i++)
    {
        setU32(data + i * 4, u32(v + i * 4));
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetVectorArray(D3DXHANDLE hParameter, CONST D3DXVECTOR4 *pVector,
 * UINT Count): the first Count elements of a float vector array, each its
 * columns of a vector.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} v @param {u32} count
 * @returns {u32}
 */
export function SetVectorArray({ u32, setU32, callStd, host }, self, h, v, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    const elements = u32(p + 16);
    const columns = u32(p + 12);
    if (u32(p) !== PT_FLOAT || u32(p + 4) !== PC_VECTOR || elements === 0 || count > elements
        || columns > 4 || (count !== 0 && v === 0))
    {
        return host();
    }
    let to = u32(p + 24);
    let from = v;
    for (let e = 0; e < (count | 0); e++)
    {
        for (let i = 0; i < (columns | 0); i++)
        {
            setU32(to, u32(from + i * 4));
            to = (to + 4) >>> 0;
        }
        from = (from + 16) >>> 0;
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetFloat(D3DXHANDLE hParameter, FLOAT f): a float scalar.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} f
 * @returns {u32}
 */
export function SetFloat({ u32, setU32, callStd, host }, self, h, f){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (u32(p) !== PT_FLOAT || u32(p + 16) !== 0 || u32(p + 8) !== 1 || u32(p + 12) !== 1)
    {
        return host();
    }
    setU32(u32(p + 24), f);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetInt(D3DXHANDLE hParameter, INT n): an int scalar.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} n
 * @returns {u32}
 */
export function SetInt({ u32, setU32, callStd, host }, self, h, n){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (u32(p) !== PT_INT || u32(p + 16) !== 0 || u32(p + 8) !== 1 || u32(p + 12) !== 1)
    {
        return host();
    }
    setU32(u32(p + 24), n);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetBool(D3DXHANDLE hParameter, BOOL b): a bool scalar, the word as given.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} b
 * @returns {u32}
 */
export function SetBool({ u32, setU32, callStd, host }, self, h, b){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (u32(p) !== PT_BOOL || u32(p + 16) !== 0 || u32(p + 8) !== 1 || u32(p + 12) !== 1)
    {
        return host();
    }
    setU32(u32(p + 24), b);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetTexture(D3DXHANDLE hParameter, LPDIRECT3DBASETEXTURE9 pTexture): a
 * texture parameter's pointer; the host's setter takes no reference either.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} texture
 * @returns {u32}
 */
export function SetTexture({ u32, setU32, callStd, host }, self, h, texture){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    const type = u32(p);
    if (u32(p + 16) !== 0 || type < PT_TEXTURE || type > PT_TEXTURECUBE)
    {
        return host();
    }
    setU32(u32(p + 24), texture);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetValue(D3DXHANDLE hParameter, LPCVOID pData, UINT Bytes): a numeric
 * parameter's words, or a structure's, as given.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} data @param {u32} bytes
 * @returns {u32}
 */
export function SetValue({ u32, setU32, callStd, host }, self, h, data, bytes){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (data === 0)
    {
        return host();
    }
    const cls = u32(p + 4);
    const size = u32(p + 20);
    if ((cls > PC_MATRIX_COLUMNS && cls !== PC_STRUCT) || size > bytes || (size & 3) !== 0)
    {
        return host();
    }
    const to = u32(p + 24);
    for (let i = 0; i < (size | 0); i += 4)
    {
        setU32(to + i, u32(data + i));
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetIntArray(D3DXHANDLE hParameter, CONST INT *pn, UINT Count): as
 * many ints as an int parameter -- a scalar, a vector, a matrix of rows or an
 * array of them -- holds, from its start.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} n @param {u32} count
 * @returns {u32}
 */
export function SetIntArray({ u32, setU32, callStd, host }, self, h, n, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    const most = u32(p + 20) >>> 2;
    const size = count < most ? count : most;
    if (u32(p) !== PT_INT || u32(p + 4) > PC_MATRIX_ROWS || (size !== 0 && n === 0))
    {
        return host();
    }
    const data = u32(p + 24);
    for (let i = 0; i < (size | 0); i++)
    {
        setU32(data + i * 4, u32(n + i * 4));
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetFloatArray(D3DXHANDLE hParameter, CONST FLOAT *pf, UINT Count): as
 * SetIntArray, for a float parameter.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} f @param {u32} count
 * @returns {u32}
 */
export function SetFloatArray({ u32, setU32, callStd, host }, self, h, f, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    const most = u32(p + 20) >>> 2;
    const size = count < most ? count : most;
    if (u32(p) !== PT_FLOAT || u32(p + 4) > PC_MATRIX_ROWS || (size !== 0 && f === 0))
    {
        return host();
    }
    const data = u32(p + 24);
    for (let i = 0; i < (size | 0); i++)
    {
        setU32(data + i * 4, u32(f + i * 4));
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetBoolArray(D3DXHANDLE hParameter, CONST BOOL *pb, UINT Count): as
 * SetIntArray, for a bool parameter, each word one when it is not zero.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} b @param {u32} count
 * @returns {u32}
 */
export function SetBoolArray({ u32, setU32, callStd, host }, self, h, b, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    const most = u32(p + 20) >>> 2;
    const size = count < most ? count : most;
    if (u32(p) !== PT_BOOL || u32(p + 4) > PC_MATRIX_ROWS || (size !== 0 && b === 0))
    {
        return host();
    }
    const data = u32(p + 24);
    for (let i = 0; i < (size | 0); i++)
    {
        setU32(data + i * 4, u32(b + i * 4) !== 0 ? 1 : 0);
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetMatrixArray(D3DXHANDLE hParameter, CONST D3DXMATRIX *pMatrix, UINT
 * Count): the first Count elements of an array of float matrices of rows,
 * each as SetMatrix sets one, from matrices one after another.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} m @param {u32} count
 * @returns {u32}
 */
export function SetMatrixArray({ u32, setU32, callStd, host }, self, h, m, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (m === 0 || count === 0)
    {
        return host();
    }
    const rows = u32(p + 8);
    const columns = u32(p + 12);
    if (u32(p) !== PT_FLOAT || u32(p + 4) !== PC_MATRIX_ROWS || count > u32(p + 16)
        || rows > 4 || columns > 4)
    {
        return host();
    }
    let to = u32(p + 24);
    for (let e = 0; e < (count | 0); e++)
    {
        const from = (m + e * 64) >>> 0;
        for (let r = 0; r < (rows | 0); r++)
        {
            for (let c = 0; c < (columns | 0); c++)
            {
                setU32(to, u32(from + r * 16 + c * 4));
                to = (to + 4) >>> 0;
            }
        }
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetMatrixTransposeArray(D3DXHANDLE hParameter, CONST D3DXMATRIX
 * *pMatrix, UINT Count): as SetMatrixArray, each matrix read by its columns.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} m @param {u32} count
 * @returns {u32}
 */
export function SetMatrixTransposeArray({ u32, setU32, callStd, host }, self, h, m, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (m === 0 || count === 0)
    {
        return host();
    }
    const rows = u32(p + 8);
    const columns = u32(p + 12);
    if (u32(p) !== PT_FLOAT || u32(p + 4) !== PC_MATRIX_ROWS || count > u32(p + 16)
        || rows > 4 || columns > 4)
    {
        return host();
    }
    let to = u32(p + 24);
    for (let e = 0; e < (count | 0); e++)
    {
        const from = (m + e * 64) >>> 0;
        for (let r = 0; r < (rows | 0); r++)
        {
            for (let c = 0; c < (columns | 0); c++)
            {
                setU32(to, u32(from + c * 16 + r * 4));
                to = (to + 4) >>> 0;
            }
        }
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetMatrixPointerArray(D3DXHANDLE hParameter, CONST D3DXMATRIX
 * **ppMatrix, UINT Count): as SetMatrixArray, each matrix where its pointer
 * says; a null pointer among them is the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} m @param {u32} count
 * @returns {u32}
 */
export function SetMatrixPointerArray({ u32, setU32, callStd, host }, self, h, m, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (m === 0 || count === 0)
    {
        return host();
    }
    const rows = u32(p + 8);
    const columns = u32(p + 12);
    if (u32(p) !== PT_FLOAT || u32(p + 4) !== PC_MATRIX_ROWS || count > u32(p + 16)
        || rows > 4 || columns > 4)
    {
        return host();
    }
    for (let e = 0; e < (count | 0); e++)
    {
        if (u32(m + e * 4) === 0)
        {
            return host();
        }
    }
    let to = u32(p + 24);
    for (let e = 0; e < (count | 0); e++)
    {
        const from = u32(m + e * 4);
        for (let r = 0; r < (rows | 0); r++)
        {
            for (let c = 0; c < (columns | 0); c++)
            {
                setU32(to, u32(from + r * 16 + c * 4));
                to = (to + 4) >>> 0;
            }
        }
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * HRESULT SetMatrixTransposePointerArray(D3DXHANDLE hParameter, CONST D3DXMATRIX
 * **ppMatrix, UINT Count): as SetMatrixPointerArray, each matrix read by its columns.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} m @param {u32} count
 * @returns {u32}
 */
export function SetMatrixTransposePointerArray({ u32, setU32, callStd, host }, self, h, m, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    let p = h;
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        // A name for a handle: the effect's table of names says whose record it is.
        p = callStd(u32(block + BLOCK_RESOLVE), block, h) >>> 0;
        if (p === 0)
        {
            return host();
        }
    }
    if (m === 0 || count === 0)
    {
        return host();
    }
    const rows = u32(p + 8);
    const columns = u32(p + 12);
    if (u32(p) !== PT_FLOAT || u32(p + 4) !== PC_MATRIX_ROWS || count > u32(p + 16)
        || rows > 4 || columns > 4)
    {
        return host();
    }
    for (let e = 0; e < (count | 0); e++)
    {
        if (u32(m + e * 4) === 0)
        {
            return host();
        }
    }
    let to = u32(p + 24);
    for (let e = 0; e < (count | 0); e++)
    {
        const from = u32(m + e * 4);
        for (let r = 0; r < (rows | 0); r++)
        {
            for (let c = 0; c < (columns | 0); c++)
            {
                setU32(to, u32(from + c * 16 + r * 4));
                to = (to + 4) >>> 0;
            }
        }
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(p + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}

/**
 * The record of the parameter a name given for a handle names, or 0 for none:
 * the name hashed (FNV-1a over its bytes, as `nameHash` in `effect.js`) and
 * looked up in the effect's table of names, its bytes compared whole. A name
 * longer than any parameter's is none. Called by the setters through the
 * block's RESOLVE.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} block @param {u32} name
 * @returns {u32}
 */
export function Resolve({ u8, u32 }, block, name){
    const table = u32(block + BLOCK_NAMES);
    if (table === 0 || name < 0x10000)
    {
        return 0;
    }
    let hash = -2128831035;
    let length = 0;
    while (length < 256 && u8(name + length) !== 0)
    {
        hash = Math.imul(hash ^ u8(name + length), 16777619);
        length++;
    }
    if (length >= 256)
    {
        return 0;
    }
    const mask = u32(table);
    let slot = hash & mask;
    for (let probe = 0; probe <= (mask | 0); probe++)
    {
        const entry = (table + 4 + slot * 12) >>> 0;
        const record = u32(entry + 8);
        if (record === 0)
        {
            return 0;
        }
        if (u32(entry) === (hash >>> 0))
        {
            const known = u32(entry + 4);
            let i = 0;
            while (i <= length && u8(name + i) === u8(known + i))
            {
                i++;
            }
            if (i > length)
            {
                return record;
            }
        }
        slot = (slot + 1) & mask;
    }
    return 0;
}

/**
 * HRESULT SetArrayRange(D3DXHANDLE hParameter, UINT uStart, UINT uEnd): a hint
 * the host takes for any parameter, setting every array whole anyway.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} start @param {u32} end
 * @returns {u32}
 */
export function SetArrayRange({ host }, self, h, start, end){ // eslint-disable-line no-unused-vars
    // Every argument named, unread: a stdcall's arguments are what its return takes off the stack.
    if (self === 0)
    {
        return host();
    }
    return 0;
}
