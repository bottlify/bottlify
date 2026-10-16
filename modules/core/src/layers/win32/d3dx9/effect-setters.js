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
 * the clock, as the host's setter does. Any other case -- a name given for a
 * handle, a type to convert, a colour packed into an int, an invalid call --
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
export function SetMatrix({ u32, setU32, host }, self, h, m){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0 || m === 0)
    {
        return host();
    }
    if (u32(h) !== PT_FLOAT || u32(h + 16) !== 0)
    {
        return host();
    }
    const cls = u32(h + 4);
    const rows = u32(h + 8);
    const columns = u32(h + 12);
    if ((cls !== PC_MATRIX_ROWS && cls !== PC_MATRIX_COLUMNS) || rows > 4 || columns > 4)
    {
        return host();
    }
    let to = u32(h + 24);
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
    setU32(u32(h + 28), now);
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
export function SetMatrixTranspose({ u32, setU32, host }, self, h, m){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0 || m === 0)
    {
        return host();
    }
    if (u32(h) !== PT_FLOAT || u32(h + 16) !== 0)
    {
        return host();
    }
    const cls = u32(h + 4);
    const rows = u32(h + 8);
    const columns = u32(h + 12);
    if ((cls !== PC_MATRIX_ROWS && cls !== PC_MATRIX_COLUMNS) || rows > 4 || columns > 4)
    {
        return host();
    }
    let to = u32(h + 24);
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
    setU32(u32(h + 28), now);
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
export function SetVector({ u32, setU32, host }, self, h, v){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0 || v === 0)
    {
        return host();
    }
    const cls = u32(h + 4);
    const columns = u32(h + 12);
    if (u32(h) !== PT_FLOAT || u32(h + 16) !== 0 || (cls !== PC_SCALAR && cls !== PC_VECTOR)
        || columns > 4)
    {
        return host();
    }
    const data = u32(h + 24);
    for (let i = 0; i < (columns | 0); i++)
    {
        setU32(data + i * 4, u32(v + i * 4));
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(h + 28), now);
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
export function SetVectorArray({ u32, setU32, host }, self, h, v, count){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        return host();
    }
    const elements = u32(h + 16);
    const columns = u32(h + 12);
    if (u32(h) !== PT_FLOAT || u32(h + 4) !== PC_VECTOR || elements === 0 || count > elements
        || columns > 4 || (count !== 0 && v === 0))
    {
        return host();
    }
    let to = u32(h + 24);
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
    setU32(u32(h + 28), now);
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
export function SetFloat({ u32, setU32, host }, self, h, f){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        return host();
    }
    if (u32(h) !== PT_FLOAT || u32(h + 16) !== 0 || u32(h + 8) !== 1 || u32(h + 12) !== 1)
    {
        return host();
    }
    setU32(u32(h + 24), f);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(h + 28), now);
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
export function SetInt({ u32, setU32, host }, self, h, n){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        return host();
    }
    if (u32(h) !== PT_INT || u32(h + 16) !== 0 || u32(h + 8) !== 1 || u32(h + 12) !== 1)
    {
        return host();
    }
    setU32(u32(h + 24), n);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(h + 28), now);
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
export function SetBool({ u32, setU32, host }, self, h, b){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        return host();
    }
    if (u32(h) !== PT_BOOL || u32(h + 16) !== 0 || u32(h + 8) !== 1 || u32(h + 12) !== 1)
    {
        return host();
    }
    setU32(u32(h + 24), b);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(h + 28), now);
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
export function SetTexture({ u32, setU32, host }, self, h, texture){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0)
    {
        return host();
    }
    const type = u32(h);
    if (u32(h + 16) !== 0 || type < PT_TEXTURE || type > PT_TEXTURECUBE)
    {
        return host();
    }
    setU32(u32(h + 24), texture);
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(h + 28), now);
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
export function SetValue({ u32, setU32, host }, self, h, data, bytes){
    const block = u32(self + 4);
    if (block === 0 || u32(block) !== 0)
    {
        return host();
    }
    const offset = (h - u32(block + 4)) >>> 0;
    if (offset >= u32(block + 8) || (offset & 31) !== 0 || data === 0)
    {
        return host();
    }
    const cls = u32(h + 4);
    const size = u32(h + 20);
    if ((cls > PC_MATRIX_COLUMNS && cls !== PC_STRUCT) || size > bytes || (size & 3) !== 0)
    {
        return host();
    }
    const to = u32(h + 24);
    for (let i = 0; i < (size | 0); i += 4)
    {
        setU32(to + i, u32(data + i));
    }
    const clock = u32(block + 12);
    const now = u32(clock);
    setU32(u32(h + 28), now);
    setU32(clock, (now + 1) | 0);
    return 0;
}
