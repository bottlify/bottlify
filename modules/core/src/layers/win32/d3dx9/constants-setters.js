/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ID3DXConstantTable's hot methods as code in the guest: a program sets a
 * matrix or a vector by handle before almost every draw, and asks for a
 * constant's description and an element's handle as often, thousands of
 * times a frame, each a crossing into the host. Each `@guestCode` function
 * here is compiled by the build (`scripts/guest-code/`) into
 * `constants-setters.x86.js` and runs in the method's vtable slot.
 *
 * A handle the table hands out is a record in guest memory (`HANDLE_*`,
 * written by `constants.js`): the table's block and its complement, as a
 * mark that it is one, then the D3DXCONSTANT_DESC the table answers for it,
 * whether a twin of it in another register set is set beside it, and the
 * handles of its elements. A float constant of a vector or matrix shape is
 * set here, through the device's own setter, its registers laid out in the
 * table's scratch; anything else -- a name for a handle, a twin, integer or
 * boolean registers, an element not yet asked for -- is handed to the host's
 * method unchanged (`return host()`), nothing written before it goes.
 *
 * The interface's state word (`[this + 4]`) is the table's block: whether
 * its shader is a pixel shader, then the scratch the registers go out in.
 */

/** @typedef {import('../msvcrt/guest-code.js').Guest} Guest */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */

/**
 * The table's block: whether the shader is a pixel shader, the scratch, and
 * the list SetDefaults goes through and its length.
 */
export const BLOCK_PIXEL = 0;
export const BLOCK_SCRATCH = 4;
export const BLOCK_DEFAULTS = 68;
export const BLOCK_DEFAULT_COUNT = 72;
export const BLOCK_BYTES = 76;

/**
 * An entry of SetDefaults' list: the device's setter (its vtable slot, with
 * `DEFAULT_TWIN` where it sets the twin of the entry before), the first
 * register, the registers' values as the setter takes them and how many;
 * no values for a constant whose set the host answers without a call.
 */
export const DEFAULT_BYTES = 16;
export const DEFAULT_TWIN = 0x10000;

/** A handle's record. */
export const HANDLE_TAG = 0;
export const HANDLE_CHECK = 4;
/** D3DXCONSTANT_DESC: Name, RegisterSet, RegisterIndex, RegisterCount, Class, Type, Rows,
 * Columns, Elements, StructMembers, Bytes, DefaultValue. */
export const HANDLE_DESC = 8;
export const HANDLE_TWIN = 56;
export const HANDLE_ELEMENTS = 60;
export const HANDLE_BYTES = 64;

const SET = 12;
const INDEX = 16;
const COUNT = 20;
const CLASS = 24;
const ROWS = 32;
const COLUMNS = 36;
const ELEMENTS = 40;

const SET_FLOAT4 = 2;
const PC_SCALAR = 0;
const PC_VECTOR = 1;
const PC_MATRIX_ROWS = 2;
const PC_MATRIX_COLUMNS = 3;
/** IDirect3DDevice9's SetVertexShaderConstantF and SetPixelShaderConstantF. */
const SET_VS_F = 94;
const SET_PS_F = 109;

/**
 * HRESULT SetMatrix(LPDIRECT3DDEVICE9, D3DXHANDLE, const D3DXMATRIX *pMatrix):
 * a register a row, or a column where the shader packs the matrix by columns,
 * lanes past its shape zero, as many registers as it has up to its rows or columns.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} device @param {u32} h @param {u32} m
 * @returns {u32}
 */
export function SetMatrix({ u32, setU32, callStd, host }, self, device, h, m){
    const block = u32(self + 4);
    if (block === 0 || device === 0 || m === 0 || h === 0 || u32(h + HANDLE_TAG) !== block
        || u32(h + HANDLE_CHECK) !== (~block >>> 0))
    {
        return host();
    }
    const cls = u32(h + CLASS);
    const rows = u32(h + ROWS);
    const columns = u32(h + COLUMNS);
    if (u32(h + SET) !== SET_FLOAT4 || u32(h + HANDLE_TWIN) !== 0
        || (cls !== PC_MATRIX_ROWS && cls !== PC_MATRIX_COLUMNS)
        || rows === 0 || columns === 0 || rows > 4 || columns > 4)
    {
        return host();
    }
    let count = u32(h + COUNT);
    const span = cls === PC_MATRIX_ROWS ? rows : columns;
    if (count > span)
    {
        count = span;
    }
    if (count === 0)
    {
        return host();
    }
    const out = (block + BLOCK_SCRATCH) >>> 0;
    for (let r = 0; r < (count | 0); r++)
    {
        for (let lane = 0; lane < 4; lane++)
        {
            const row = cls === PC_MATRIX_ROWS ? r : lane;
            const column = cls === PC_MATRIX_ROWS ? lane : r;
            const at = (out + r * 16 + lane * 4) >>> 0;
            if (row < (rows | 0) && column < (columns | 0))
            {
                setU32(at, u32(m + row * 16 + column * 4));
            }
            else
            {
                setU32(at, 0);
            }
        }
    }
    const slot = u32(block + BLOCK_PIXEL) !== 0 ? SET_PS_F : SET_VS_F;
    return callStd(u32(u32(device) + slot * 4), device, u32(h + INDEX), out, count) >>> 0;
}

/**
 * HRESULT SetMatrixTranspose(LPDIRECT3DDEVICE9, D3DXHANDLE, const D3DXMATRIX *):
 * as SetMatrix, the matrix read by its columns.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} device @param {u32} h @param {u32} m
 * @returns {u32}
 */
export function SetMatrixTranspose({ u32, setU32, callStd, host }, self, device, h, m){
    const block = u32(self + 4);
    if (block === 0 || device === 0 || m === 0 || h === 0 || u32(h + HANDLE_TAG) !== block
        || u32(h + HANDLE_CHECK) !== (~block >>> 0))
    {
        return host();
    }
    const cls = u32(h + CLASS);
    const rows = u32(h + ROWS);
    const columns = u32(h + COLUMNS);
    if (u32(h + SET) !== SET_FLOAT4 || u32(h + HANDLE_TWIN) !== 0
        || (cls !== PC_MATRIX_ROWS && cls !== PC_MATRIX_COLUMNS)
        || rows === 0 || columns === 0 || rows > 4 || columns > 4)
    {
        return host();
    }
    let count = u32(h + COUNT);
    const span = cls === PC_MATRIX_ROWS ? rows : columns;
    if (count > span)
    {
        count = span;
    }
    if (count === 0)
    {
        return host();
    }
    const out = (block + BLOCK_SCRATCH) >>> 0;
    for (let r = 0; r < (count | 0); r++)
    {
        for (let lane = 0; lane < 4; lane++)
        {
            const row = cls === PC_MATRIX_ROWS ? r : lane;
            const column = cls === PC_MATRIX_ROWS ? lane : r;
            const at = (out + r * 16 + lane * 4) >>> 0;
            if (row < (rows | 0) && column < (columns | 0))
            {
                setU32(at, u32(m + column * 16 + row * 4));
            }
            else
            {
                setU32(at, 0);
            }
        }
    }
    const slot = u32(block + BLOCK_PIXEL) !== 0 ? SET_PS_F : SET_VS_F;
    return callStd(u32(u32(device) + slot * 4), device, u32(h + INDEX), out, count) >>> 0;
}

/**
 * HRESULT SetVector(LPDIRECT3DDEVICE9, D3DXHANDLE, const D3DXVECTOR4 *pVector):
 * one register, the lanes past the constant's columns zero.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} device @param {u32} h @param {u32} v
 * @returns {u32}
 */
export function SetVector({ u32, setU32, callStd, host }, self, device, h, v){
    const block = u32(self + 4);
    if (block === 0 || device === 0 || v === 0 || h === 0 || u32(h + HANDLE_TAG) !== block
        || u32(h + HANDLE_CHECK) !== (~block >>> 0))
    {
        return host();
    }
    const cls = u32(h + CLASS);
    let lanes = cls === PC_SCALAR ? 1 : u32(h + COLUMNS);
    if (lanes === 0)
    {
        lanes = 1;
    }
    if (u32(h + SET) !== SET_FLOAT4 || u32(h + HANDLE_TWIN) !== 0
        || (cls !== PC_SCALAR && cls !== PC_VECTOR) || lanes > 4 || u32(h + COUNT) === 0)
    {
        return host();
    }
    const out = (block + BLOCK_SCRATCH) >>> 0;
    for (let lane = 0; lane < 4; lane++)
    {
        if (lane < (lanes | 0))
        {
            setU32(out + lane * 4, u32(v + lane * 4));
        }
        else
        {
            setU32(out + lane * 4, 0);
        }
    }
    const slot = u32(block + BLOCK_PIXEL) !== 0 ? SET_PS_F : SET_VS_F;
    return callStd(u32(u32(device) + slot * 4), device, u32(h + INDEX), out, 1) >>> 0;
}

/**
 * HRESULT SetFloat(LPDIRECT3DDEVICE9, D3DXHANDLE, FLOAT f), by the float's bits:
 * the first lane of one register.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} device @param {u32} h @param {u32} f
 * @returns {u32}
 */
export function SetFloat({ u32, setU32, callStd, host }, self, device, h, f){
    const block = u32(self + 4);
    if (block === 0 || device === 0 || h === 0 || u32(h + HANDLE_TAG) !== block
        || u32(h + HANDLE_CHECK) !== (~block >>> 0))
    {
        return host();
    }
    const cls = u32(h + CLASS);
    let lanes = cls === PC_SCALAR ? 1 : u32(h + COLUMNS);
    if (lanes === 0)
    {
        lanes = 1;
    }
    if (u32(h + SET) !== SET_FLOAT4 || u32(h + HANDLE_TWIN) !== 0
        || (cls !== PC_SCALAR && cls !== PC_VECTOR) || lanes > 4 || u32(h + COUNT) === 0)
    {
        return host();
    }
    const out = (block + BLOCK_SCRATCH) >>> 0;
    for (let lane = 0; lane < 4; lane++)
    {
        setU32(out + lane * 4, 0);
    }
    setU32(out, f);
    const slot = u32(block + BLOCK_PIXEL) !== 0 ? SET_PS_F : SET_VS_F;
    return callStd(u32(u32(device) + slot * 4), device, u32(h + INDEX), out, 1) >>> 0;
}

/**
 * HRESULT SetDefaults(LPDIRECT3DDEVICE9): each float constant with a default,
 * and its twins, through the device's setters in the table's order; the
 * answer the last one's, a twin skipped once the set before it failed.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} device
 * @returns {u32}
 */
export function SetDefaults({ u32, callStd, host }, self, device){
    const block = u32(self + 4);
    if (block === 0 || device === 0)
    {
        return host();
    }
    const list = u32(block + BLOCK_DEFAULTS);
    const count = u32(block + BLOCK_DEFAULT_COUNT);
    let answer = 0;
    for (let i = 0; i < (count | 0); i++)
    {
        const entry = (list + i * DEFAULT_BYTES) >>> 0;
        const slot = u32(entry);
        if ((slot & DEFAULT_TWIN) === 0 || answer === 0)
        {
            const data = u32(entry + 8);
            if (data === 0)
            {
                answer = 0;
            }
            else
            {
                answer = callStd(u32(u32(device) + (slot & 0xffff) * 4), device, u32(entry + 4),
                    data, u32(entry + 12)) | 0;
            }
        }
    }
    return answer >>> 0;
}

/**
 * HRESULT GetConstantDesc(D3DXHANDLE, D3DXCONSTANT_DESC *pDesc, UINT *pCount):
 * the description the record carries, one of it.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} out @param {u32} countAt
 * @returns {u32}
 */
export function GetConstantDesc({ u32, setU32, host }, self, h, out, countAt){
    const block = u32(self + 4);
    if (block === 0 || h === 0 || u32(h + HANDLE_TAG) !== block
        || u32(h + HANDLE_CHECK) !== (~block >>> 0))
    {
        return host();
    }
    if (out !== 0)
    {
        for (let i = 0; i < 12; i++)
        {
            setU32(out + i * 4, u32(h + HANDLE_DESC + i * 4));
        }
    }
    if (countAt !== 0)
    {
        setU32(countAt, 1);
    }
    return 0;
}

/**
 * D3DXHANDLE GetConstantElement(D3DXHANDLE hConstant, UINT Index): the handle
 * the host made for that element the first time it was asked for.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} h @param {u32} index
 * @returns {u32}
 */
export function GetConstantElement({ u32, host }, self, h, index){
    const block = u32(self + 4);
    if (block === 0 || h === 0 || u32(h + HANDLE_TAG) !== block
        || u32(h + HANDLE_CHECK) !== (~block >>> 0))
    {
        return host();
    }
    const elements = u32(h + HANDLE_ELEMENTS);
    if (elements === 0 || index >= u32(h + ELEMENTS))
    {
        return host();
    }
    const element = u32(elements + index * 4);
    if (element === 0)
    {
        return host();
    }
    return element;
}

