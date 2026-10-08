/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ID3DXConstantTable: the constants a compiled shader declares, read from the
 * CTAB comment its compiler wrote into the bytecode, and the setters that put
 * values into the device's constant registers the way the table lays them out.
 *
 * A program that keeps its shaders compiled -- a cache of bytecode it loads
 * at start -- asks for the table to learn which register holds which name,
 * and then sets them by handle. The table is a copy of the CTAB block in the
 * guest's heap, so the names and defaults it hands out by pointer stay valid
 * for as long as the table does.
 *
 * The layout is the one the shader model documents: a comment token (0xFFFE,
 * its length in DWORDs in bits 16-30) whose first DWORD is 'CTAB', followed by
 * a D3DXSHADER_CONSTANTTABLE -- size, creator, version, the constants' count
 * and the offset of their D3DXSHADER_CONSTANTINFO records, flags, target --
 * every offset counted from the start of that block.
 */

import { createComObject } from '../ole32/objects.js';

export const IID_ID3DXCONSTANTTABLE = '{AB3C758F-093E-4356-B762-4DB18F1B3A01}';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;
const CTAB = 0x42415443;

/** D3DXREGISTER_SET, D3DXPARAMETER_CLASS. */
const SET = { BOOL: 0, INT4: 1, FLOAT4: 2, SAMPLER: 3 };
const CLASS = { SCALAR: 0, VECTOR: 1, MATRIX_ROWS: 2, MATRIX_COLUMNS: 3, OBJECT: 4, STRUCT: 5 };

/**
 * IDirect3DDevice9's slots for the constant setters, by register set, vertex
 * shader then pixel shader: SetVertexShaderConstantF/I/B and
 * SetPixelShaderConstantF/I/B.
 */
const SETTERS = {
    [SET.FLOAT4]: [94, 109],
    [SET.INT4]: [96, 111],
    [SET.BOOL]: [98, 113],
};

/**
 * @typedef {Object} Constant
 * @property {string} name
 * @property {number} nameAt   The guest address of its name, in the table's copy.
 * @property {number} set      D3DXREGISTER_SET.
 * @property {number} index    The first register.
 * @property {number} count    How many registers.
 * @property {number} cls      D3DXPARAMETER_CLASS.
 * @property {number} type     D3DXPARAMETER_TYPE.
 * @property {number} rows
 * @property {number} columns
 * @property {number} elements
 * @property {Constant[]} members
 * @property {number} defaultAt  The guest address of its default, or 0.
 */

/**
 * Where the CTAB block of a shader's bytecode is, and how long: found among
 * the comments that follow the version token, which is where a compiler puts
 * it. Null when there is none.
 *
 * @param {(address: number) => number} u32
 * @param {number} code
 * @returns {{ at: number, size: number, version: number } | null}
 */
export function findConstantTable(u32, code){
    const version = u32(code);
    if (((version & 0xfffe0000) >>> 0) !== 0xfffe0000)
    {
        return null;
    }
    for (let at = code + 4; ;)
    {
        const token = u32(at);
        if ((token & 0xffff) !== 0xfffe)
        {
            return null;
        }
        const length = (token >>> 16) & 0x7fff;
        if (length >= 1 && u32(at + 4) === CTAB)
        {
            return { at: at + 8, size: (length - 1) * 4, version };
        }
        at += 4 + length * 4;
    }
}

/**
 * The constants of a CTAB block, as its records describe them.
 *
 * @param {DataView} view   The block.
 * @param {number} base     Where the table's copy of it is in guest memory.
 * @returns {{ creatorAt: number, version: number, constants: Constant[] }}
 */
export function parseConstantTable(view, base){
    const u16 = (/** @type {number} */ at)=>view.getUint16(at, true);
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    const string = (/** @type {number} */ at)=>{
        let end = at;
        while (end < view.byteLength && view.getUint8(end) !== 0)
        {
            end++;
        }
        return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, end - at));
    };
    /**
     * A type and what it is laid out over: its registers counted from `index`.
     *
     * @param {string} name @param {number} nameOffset @param {number} typeOffset
     * @param {number} set @param {number} index @param {number} count @param {number} defaultAt
     * @returns {Constant}
     */
    const constant = (name, nameOffset, typeOffset, set, index, count, defaultAt)=>{
        const elements = Math.max(1, u16(typeOffset + 8));
        const memberCount = u16(typeOffset + 10);
        const membersAt = u32(typeOffset + 12);
        /** @type {Constant[]} */
        const members = [];
        let next = index;
        for (let m = 0; m < memberCount; m++)
        {
            const record = membersAt + m * 8;
            const memberType = u32(record + 4);
            const span = registersOf(memberType);
            members.push(constant(string(u32(record)), u32(record), memberType, set, next,
                span, 0));
            next += span;
        }
        return {
            name, nameAt: base + nameOffset, set, index, count,
            cls: u16(typeOffset), type: u16(typeOffset + 2),
            rows: u16(typeOffset + 4), columns: u16(typeOffset + 6), elements, members,
            defaultAt,
        };
    };
    /** The registers one instance of a type takes. @param {number} typeOffset @returns {number} */
    const registersOf = typeOffset=>{
        const cls = u16(typeOffset);
        const elements = Math.max(1, u16(typeOffset + 8));
        if (cls === CLASS.STRUCT)
        {
            let total = 0;
            for (let m = 0; m < u16(typeOffset + 10); m++)
            {
                total += registersOf(u32(u32(typeOffset + 12) + m * 8 + 4));
            }
            return total * elements;
        }
        const rows = u16(typeOffset + 4);
        const columns = u16(typeOffset + 6);
        return (cls === CLASS.MATRIX_COLUMNS ? columns : cls === CLASS.MATRIX_ROWS ? rows : 1)
            * elements;
    };

    const count = u32(12);
    const infos = u32(16);
    const constants = [];
    for (let c = 0; c < count; c++)
    {
        const record = infos + c * 20;
        const defaultOffset = u32(record + 16);
        constants.push(constant(string(u32(record)), u32(record), u32(record + 12), u16(record + 4),
            u16(record + 6), u16(record + 8), defaultOffset === 0 ? 0 : base + defaultOffset));
    }
    return { creatorAt: base + u32(4), version: u32(8), constants };
}

/**
 * The register values a constant takes from a run of numbers given in its own
 * order -- a scalar or a vector an element a register, a matrix a register a
 * row, or a column when the shader packs it by column -- as many registers as
 * the numbers fill, up to the constant's own.
 *
 * @param {Constant} constant
 * @param {number[]} values
 * @returns {{ registers: number[], count: number }}  Four numbers a register.
 */
export function registerValues(constant, values){
    const { cls, rows, columns } = constant;
    const perElement = cls === CLASS.SCALAR ? 1 : cls === CLASS.VECTOR ? columns : rows * columns;
    const registersPerElement = cls === CLASS.MATRIX_COLUMNS ? columns
        : cls === CLASS.MATRIX_ROWS ? rows : 1;
    const elements = Math.min(Math.ceil(values.length / Math.max(perElement, 1)),
        Math.floor(constant.count / Math.max(registersPerElement, 1)) || 1);
    const count = Math.min(constant.count, elements * registersPerElement);
    const registers = new Array(count * 4).fill(0);
    for (let e = 0; e < elements; e++)
    {
        for (let r = 0; r < Math.max(rows, 1); r++)
        {
            for (let c = 0; c < Math.max(columns, 1); c++)
            {
                const from = e * perElement + (cls === CLASS.SCALAR ? 0 : r * columns + c);
                if (from >= values.length || (cls === CLASS.SCALAR && c > 0))
                {
                    continue;
                }
                const register = e * registersPerElement
                    + (cls === CLASS.MATRIX_COLUMNS ? c : cls === CLASS.MATRIX_ROWS ? r : 0);
                const lane = cls === CLASS.MATRIX_COLUMNS ? r : c;
                if (register < count)
                {
                    registers[register * 4 + lane] = values[from];
                }
            }
            if (cls === CLASS.SCALAR || cls === CLASS.VECTOR)
            {
                break;
            }
        }
    }
    return { registers, count };
}

/**
 * @typedef {Object} ConstantTableHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any })
 *     => Promise<number>} [callGuest]
 * @property {() => any} [currentThread]
 */

/**
 * D3DXGetShaderConstantTable, and the table it hands out; `publish` makes a
 * table over a CTAB block for whoever has just compiled the shader.
 *
 * @param {ConstantTableHost} host
 */
export function createConstantTableObjects(host){
    const u32 = (/** @type {number} */ address)=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    const dword = (/** @type {number} */ value)=>Uint8Array.of(value & 0xff, value >> 8 & 0xff,
        value >> 16 & 0xff, value >>> 24);
    const f32 = (/** @type {number} */ address)=>new DataView(
        host.readMemory(address >>> 0, 4).slice().buffer).getFloat32(0, true);
    const readString = (/** @type {number} */ address)=>{
        let text = '';
        for (let at = address >>> 0; text.length < 256; at++)
        {
            const byte = host.readMemory(at, 1)[0];
            if (byte === 0)
            {
                break;
            }
            text += String.fromCharCode(byte);
        }
        return text;
    };

    /**
     * @typedef {Object} TableState
     * @property {number} base  The copy of the block.
     * @property {number} size
     * @property {number} creatorAt
     * @property {number} version
     * @property {boolean} pixel
     * @property {Constant[]} constants
     * @property {Map<number, Constant>} handles
     * @property {Map<Constant, number>} handleOf
     * @property {number[]} owned  Blocks that go back to the heap with the table.
     */

    /**
     * A constant's handle: the address of its record in the table's copy for
     * a constant the table lists, a block of its own for a member or element.
     *
     * @param {TableState} table @param {Constant} constant
     */
    const handleFor = (table, constant)=>{
        const known = table.handleOf.get(constant);
        if (known !== undefined)
        {
            return known;
        }
        const handle = host.heap?.allocate(4) ?? 0;
        if (handle === 0)
        {
            return 0;
        }
        table.owned.push(handle);
        table.handles.set(handle, constant);
        table.handleOf.set(constant, handle);
        return handle;
    };

    /**
     * What a D3DXHANDLE names: one this table handed out, or -- as D3DX takes
     * either -- a name, with `.member` and `[index]` along the way.
     *
     * @param {TableState} table @param {number} handle
     * @returns {Constant | null}
     */
    const resolve = (table, handle)=>{
        if ((handle >>> 0) === 0)
        {
            return null;
        }
        const known = table.handles.get(handle >>> 0);
        if (known)
        {
            return known;
        }
        /** @type {Constant | null} */
        let found = null;
        for (const part of readString(handle).split('.'))
        {
            const [, name, index] = /^([^[]*)(?:\[(\d+)\])?$/.exec(part) ?? [];
            /** @type {Constant[]} */
            const scope = found ? found.members : table.constants;
            found = scope.find(one=>one.name === name) ?? null;
            if (found && index !== undefined)
            {
                found = elementOf(found, Number(index));
            }
            if (!found)
            {
                return null;
            }
        }
        return found;
    };

    /** One element of an array constant. @param {Constant} constant @param {number} index */
    const elementOf = (constant, index)=>{
        if (index >= constant.elements)
        {
            return null;
        }
        const per = Math.max(1, Math.floor(constant.count / constant.elements));
        return { ...constant, elements: 1, index: constant.index + index * per, count: per,
            defaultAt: 0 };
    };

    /**
     * Puts a constant's values into the device's registers through its own
     * setter: SetVertexShaderConstantF or the pixel shader's, I or B by the
     * constant's register set.
     *
     * @param {TableState} table @param {number} device @param {Constant | null} constant
     * @param {number[]} values  In the constant's own order.
     * @param {any} [thread]  Whose call it is, when it comes after an await.
     */
    const store = (table, device, constant, values, thread)=>{
        // fxc gives a model 3 loop's int count a second entry of the same name in the integer
        // registers, which rep reads, beside the float one arithmetic reads: both are set.
        const twins = constant && table.constants.includes(constant)
            ? table.constants.filter(one=>one !== constant && one.name === constant.name
                && one.set !== constant.set) : [];
        if (twins.length === 0)
        {
            return storeSet(table, device, constant, values, thread);
        }
        const who = thread ?? host.currentThread?.();
        return twins.reduce((chain, twin)=>Promise.resolve(chain).then(answer=>(answer !== D3D_OK
            ? answer : storeSet(table, device, twin, values, who))),
        storeSet(table, device, constant, values, thread));
    };

    /**
     * @param {TableState} table @param {number} device @param {Constant | null} constant
     * @param {number[]} values @param {any} [thread]
     */
    const storeSet = (table, device, constant, values, thread)=>{
        if (!constant || (device >>> 0) === 0 || !host.callGuest || !host.heap)
        {
            return D3DERR_INVALIDCALL;
        }
        if (constant.set === SET.SAMPLER || constant.cls === CLASS.STRUCT)
        {
            return D3D_OK;
        }
        const { registers, count } = registerValues(constant, values);
        if (count === 0)
        {
            return D3D_OK;
        }
        // Floats for the float registers; integers four to a register for the
        // integer ones; one BOOL a register for the boolean ones.
        const bytes = new DataView(new ArrayBuffer(count * 16));
        const units = constant.set === SET.BOOL ? count : count * 4;
        for (let i = 0; i < units; i++)
        {
            const value = registers[constant.set === SET.BOOL ? i * 4 : i];
            if (constant.set === SET.FLOAT4)
            {
                bytes.setFloat32(i * 4, value, true);
            }
            else
            {
                bytes.setInt32(i * 4, constant.set === SET.BOOL ? (value !== 0 ? 1 : 0)
                    : Math.trunc(value), true);
            }
        }
        const data = host.heap.allocate(bytes.byteLength);
        if (data === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(data, new Uint8Array(bytes.buffer));
        const slot = SETTERS[constant.set][table.pixel ? 1 : 0];
        const entry = u32(u32(device) + slot * 4);
        const free = ()=>host.heap?.free(data);
        return host.callGuest({ entry, args: [device >>> 0, constant.index, data, count],
            ...(thread === undefined ? {} : { thread }) })
            .then(answer=>{
                free();
                return answer >>> 0;
            }, failure=>{
                free();
                throw failure;
            });
    };

    /** Floats from guest memory. @param {number} at @param {number} count */
    const floats = (at, count)=>Array.from({ length: count }, (_, i)=>f32(at + i * 4));
    /** Integers from guest memory. @param {number} at @param {number} count */
    const ints = (at, count)=>Array.from({ length: count }, (_, i)=>u32(at + i * 4) | 0);
    /**
     * A D3DXMATRIX's sixteen floats, transposed if asked, cut to the
     * constant's rows and columns.
     *
     * @param {Constant} constant @param {number} at @param {boolean} transpose
     */
    const matrix = (constant, at, transpose)=>{
        const m = floats(at, 16);
        const rows = Math.max(constant.rows, 1);
        const columns = Math.max(constant.columns, 1);
        const out = [];
        for (let r = 0; r < rows; r++)
        {
            for (let c = 0; c < columns; c++)
            {
                out.push(transpose ? m[c * 4 + r] : m[r * 4 + c]);
            }
        }
        return out;
    };
    /** A vector's four floats, cut to the constant's columns. */
    const vector = (/** @type {Constant} */ constant, /** @type {number} */ at)=>
        floats(at, 4).slice(0, constant.cls === CLASS.SCALAR ? 1 : Math.max(constant.columns, 1));
    /** @param {number} value */
    const asFloat = value=>new DataView(Uint32Array.of(value >>> 0).buffer).getFloat32(0, true);

    /** @param {any} object @returns {TableState} */
    const tableOf = object=>object.state;

    /**
     * The setters of one shape: a value, an array of them, or an array of
     * pointers to them -- every one taking the device and the handle first.
     *
     * @param {string} name @param {number} argBytes
     * @param {(table: TableState, constant: Constant, args: number[]) => number[]} read
     * @returns {import('../ole32/objects.js').ComMethod}
     */
    const setter = (name, argBytes, read)=>({
        name, argBytes,
        invoke: (object, [device, handle, ...rest])=>{
            const table = tableOf(object);
            const constant = resolve(table, handle);
            return constant ? store(table, device, constant, read(table, constant, rest))
                : D3DERR_INVALIDCALL;
        },
    });

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const constantTable = {
        id: IID_ID3DXCONSTANTTABLE,
        methods: [
            /** LPVOID GetBufferPointer() */
            { name: 'GetBufferPointer', argBytes: 4, invoke: object=>tableOf(object).base },
            /** DWORD GetBufferSize() */
            { name: 'GetBufferSize', argBytes: 4, invoke: object=>tableOf(object).size },
            /** HRESULT GetDesc(D3DXCONSTANTTABLE_DESC *pDesc) */
            { name: 'GetDesc', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const table = tableOf(object);
                host.writeMemory(out >>> 0, Uint8Array.of(...dword(table.creatorAt),
                    ...dword(table.version), ...dword(table.constants.length)));
                return D3D_OK;
            } },
            /** HRESULT GetConstantDesc(D3DXHANDLE, D3DXCONSTANT_DESC *pDesc, UINT *pCount) */
            { name: 'GetConstantDesc', argBytes: 16, invoke: (object, [handle, out, countAt])=>{
                const constant = resolve(tableOf(object), handle);
                if (!constant)
                {
                    return D3DERR_INVALIDCALL;
                }
                if ((out >>> 0) !== 0)
                {
                    const numbers = constant.set === SET.SAMPLER || constant.cls === CLASS.OBJECT
                        ? 4 * constant.elements
                        : 4 * Math.max(constant.rows, 1) * Math.max(constant.columns, 1)
                            * constant.elements;
                    host.writeMemory(out >>> 0, Uint8Array.of(...[constant.nameAt, constant.set,
                        constant.index, constant.count, constant.cls, constant.type,
                        constant.rows, constant.columns, constant.elements,
                        constant.members.length, numbers, constant.defaultAt]
                        .flatMap(value=>[...dword(value)])));
                }
                if ((countAt >>> 0) !== 0)
                {
                    host.writeMemory(countAt >>> 0, dword(1));
                }
                return D3D_OK;
            } },
            /** UINT GetSamplerIndex(D3DXHANDLE): the sampler, or -1 for none. */
            { name: 'GetSamplerIndex', argBytes: 8, invoke: (object, [handle])=>{
                const constant = resolve(tableOf(object), handle);
                return constant?.set === SET.SAMPLER ? constant.index : 0xffffffff;
            } },
            /** D3DXHANDLE GetConstant(D3DXHANDLE hConstant, UINT Index) */
            { name: 'GetConstant', argBytes: 12, invoke: (object, [parent, index])=>{
                const table = tableOf(object);
                const scope = (parent >>> 0) === 0 ? table.constants
                    : resolve(table, parent)?.members ?? [];
                const constant = scope[index >>> 0];
                return constant ? handleFor(table, constant) : 0;
            } },
            /** D3DXHANDLE GetConstantByName(D3DXHANDLE hConstant, LPCSTR pName) */
            { name: 'GetConstantByName', argBytes: 12, invoke: (object, [parent, name])=>{
                const table = tableOf(object);
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                /** @type {Constant | null} */
                const scope = (parent >>> 0) === 0 ? null : resolve(table, parent);
                const wanted = readString(name);
                const constant = scope ? scope.members.find(one=>one.name === wanted) ?? null
                    : resolve(table, name);
                return constant ? handleFor(table, constant) : 0;
            } },
            /** D3DXHANDLE GetConstantElement(D3DXHANDLE hConstant, UINT Index) */
            { name: 'GetConstantElement', argBytes: 12, invoke: (object, [parent, index])=>{
                const table = tableOf(object);
                const constant = resolve(table, parent);
                const element = constant ? elementOf(constant, index >>> 0) : null;
                return element ? handleFor(table, element) : 0;
            } },
            /** HRESULT SetDefaults(LPDIRECT3DDEVICE9) */
            { name: 'SetDefaults', argBytes: 8, invoke: (object, [device])=>{
                const table = tableOf(object);
                // Every store after the first comes after an await.
                const thread = host.currentThread?.();
                let chain = Promise.resolve(D3D_OK);
                for (const constant of table.constants.filter(one=>one.defaultAt !== 0
                    && one.set === SET.FLOAT4))
                {
                    chain = chain.then(()=>store(table, device, constant,
                        floats(constant.defaultAt, constant.count * 4)
                            .filter((_, i)=>i % 4 < Math.max(constant.columns, 1)), thread));
                }
                return chain;
            } },
            /** HRESULT SetValue(LPDIRECT3DDEVICE9, D3DXHANDLE, LPCVOID pData, UINT Bytes) */
            setter('SetValue', 20, (_, constant, [data, bytes])=>(constant.set === SET.FLOAT4
                ? floats(data, (bytes >>> 0) >>> 2) : ints(data, (bytes >>> 0) >>> 2))),
            /** HRESULT SetBool(device, handle, BOOL b) */
            setter('SetBool', 16, (_, __, [value])=>[value !== 0 ? 1 : 0]),
            /** HRESULT SetBoolArray(device, handle, const BOOL *pb, UINT Count) */
            setter('SetBoolArray', 20, (_, __, [at, count])=>ints(at, count >>> 0)
                .map(value=>(value !== 0 ? 1 : 0))),
            /** HRESULT SetInt(device, handle, INT n) */
            setter('SetInt', 16, (_, __, [value])=>[value | 0]),
            /** HRESULT SetIntArray(device, handle, const INT *pn, UINT Count) */
            setter('SetIntArray', 20, (_, __, [at, count])=>ints(at, count >>> 0)),
            /** HRESULT SetFloat(device, handle, FLOAT f) */
            setter('SetFloat', 16, (_, __, [value])=>[asFloat(value)]),
            /** HRESULT SetFloatArray(device, handle, const FLOAT *pf, UINT Count) */
            setter('SetFloatArray', 20, (_, __, [at, count])=>floats(at, count >>> 0)),
            /** HRESULT SetVector(device, handle, const D3DXVECTOR4 *pVector) */
            setter('SetVector', 16, (_, constant, [at])=>vector(constant, at)),
            /** HRESULT SetVectorArray(device, handle, const D3DXVECTOR4 *pVector, UINT Count) */
            setter('SetVectorArray', 20, (_, constant, [at, count])=>Array.from(
                { length: count >>> 0 }, (__, i)=>vector(constant, at + i * 16)).flat()),
            /** HRESULT SetMatrix(device, handle, const D3DXMATRIX *pMatrix) */
            setter('SetMatrix', 16, (_, constant, [at])=>matrix(constant, at, false)),
            /** HRESULT SetMatrixArray(device, handle, const D3DXMATRIX *, UINT Count) */
            setter('SetMatrixArray', 20, (_, constant, [at, count])=>Array.from(
                { length: count >>> 0 }, (__, i)=>matrix(constant, at + i * 64, false)).flat()),
            /** HRESULT SetMatrixPointerArray(device, handle, const D3DXMATRIX **, UINT Count) */
            setter('SetMatrixPointerArray', 20, (_, constant, [at, count])=>Array.from(
                { length: count >>> 0 }, (__, i)=>matrix(constant, u32(at + i * 4), false)).flat()),
            /** HRESULT SetMatrixTranspose(device, handle, const D3DXMATRIX *pMatrix) */
            setter('SetMatrixTranspose', 16, (_, constant, [at])=>matrix(constant, at, true)),
            /** HRESULT SetMatrixTransposeArray(device, handle, const D3DXMATRIX *, UINT Count) */
            setter('SetMatrixTransposeArray', 20, (_, constant, [at, count])=>Array.from(
                { length: count >>> 0 }, (__, i)=>matrix(constant, at + i * 64, true)).flat()),
            /** HRESULT SetMatrixTransposePointerArray(device, handle, const D3DXMATRIX **, UINT Count) */
            setter('SetMatrixTransposePointerArray', 20, (_, constant, [at, count])=>Array.from(
                { length: count >>> 0 }, (__, i)=>matrix(constant, u32(at + i * 4), true)).flat()),
        ],
    };

    /**
     * An ID3DXConstantTable over a CTAB block, its pointer written to `out`.
     *
     * @param {Uint8Array} block   The block as `findConstantTable` locates it, copied.
     * @param {number} version     The version token of the shader the block came from.
     * @param {number} out
     * @returns {number}  An HRESULT.
     */
    const publish = (block, version, out)=>{
        const { heap, vtables } = host;
        if (!heap || !vtables)
        {
            return D3DERR_INVALIDCALL;
        }
        const size = block.length;
        const base = heap.allocate(Math.max(size, 4));
        if (base === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(base, block);
        const parsed = parseConstantTable(new DataView(block.buffer, block.byteOffset, size),
            base);
        /** @type {TableState} */
        const table = { base, size, creatorAt: parsed.creatorAt, version: parsed.version,
            pixel: ((version & 0xffff0000) >>> 0) === 0xffff0000,
            constants: parsed.constants, handles: new Map(), handleOf: new Map(),
            owned: [base] };
        // A constant the table lists is named by its record's address.
        const infos = new DataView(block.buffer, block.byteOffset, size).getUint32(16, true);
        parsed.constants.forEach((constant, c)=>{
            table.handles.set(base + infos + c * 20, constant);
            table.handleOf.set(constant, base + infos + c * 20);
        });
        const object = createComObject(IID_ID3DXCONSTANTTABLE, {
            interfaces: [constantTable], state: table,
            destroy: ()=>table.owned.forEach(address=>heap.free(address)),
        });
        const pointer = vtables.publish(object, IID_ID3DXCONSTANTTABLE) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        host.writeMemory(out >>> 0, dword(pointer));
        return D3D_OK;
    };

    const exports = {
        /**
         * HRESULT D3DXGetShaderConstantTable(const DWORD *pFunction,
         *     LPD3DXCONSTANTTABLE *ppConstantTable)
         *
         * The table of a shader whose bytecode carries one; a shader compiled
         * without it is refused with D3DXERR_INVALIDDATA's neighbour, as
         * D3DX refuses it.
         */
        D3DXGetShaderConstantTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([code, out])=>{
                if ((code >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                host.writeMemory(out >>> 0, new Uint8Array(4));
                if (!host.heap || !host.vtables)
                {
                    return D3DERR_INVALIDCALL;
                }
                const found = findConstantTable(u32, code >>> 0);
                if (!found)
                {
                    return D3DERR_INVALIDCALL;
                }
                return publish(host.readMemory(found.at, found.size).slice(), found.version,
                    out);
            },
        },
    };

    return { exports, publish };
}

/**
 * D3DXGetShaderConstantTable, and the table it hands out.
 *
 * @param {ConstantTableHost} host
 */
export function createConstantTables(host){
    return createConstantTableObjects(host).exports;
}
