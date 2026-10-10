/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createComObject } from '../ole32/objects.js';
import { DEVICE, STATEBLOCK_APPLY, UNKNOWN_ADDREF, UNKNOWN_RELEASE, createDeviceCalls }
    from './device.js';

/**
 * ID3DXLine: polylines drawn on the program's device as pre-transformed,
 * coloured vertices -- a list of lines at a width of one pixel or less, a quad
 * along each segment, its sides half the width out, wider than that.
 *
 * Between Begin and End the device's state is kept in a state block and put
 * back at End, as ID3DXSprite does; a Draw outside the pair does its own
 * Begin and End, as the documentation says. DrawTransform takes each vertex
 * through the matrix, divides by w and places it in the device's viewport;
 * a segment with an end at or behind the eye (w <= 0) is not drawn.
 *
 * Not drawn as asked, and told as divergences: the stipple pattern (the line
 * is drawn solid) and OpenGL-style lines (the width is laid across the
 * segment, not along the minor axis). Antialiasing is asked of the device
 * through D3DRS_ANTIALIASEDLINEENABLE, which reaches a one-pixel line only.
 */

export const IID_ID3DXLINE = '{D379BA7F-9042-4AC4-9F5E-58192A4C6BD8}';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;

/** XYZRHW | DIFFUSE: x, y, z, rhw, colour. */
const FVF = 0x44;
const STRIDE = 20;
const D3DPT_LINELIST = 2;
const D3DPT_TRIANGLELIST = 4;
const SOLID = 0xffffffff;
const D3DRS_ANTIALIASEDLINEENABLE = 176;

/** The render and stage states a line draws under, as [state, value]: the colour as given. */
const RENDER_STATES = [[137, 0], [22, 1], [27, 1], [19, 5], [20, 6], [171, 1], [8, 3],
    [15, 0], [28, 0], [52, 0], [168, 0xf]];
const STAGE_STATES = [[0, 1, 2], [0, 2, 0], [0, 4, 2], [0, 5, 0], [1, 1, 1], [1, 4, 1]];

/**
 * A FLOAT a method answers is left in ST0, which a trap cannot reach: the
 * slot is code that calls the method's own trap for the float's bits and
 * loads them.
 *
 *     push dword [esp+4]; call <trap>; push eax; fld dword [esp]; pop eax; ret 4
 */
const FLOAT_RETURN_LENGTH = 17;

/**
 * @typedef {Object} LineHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any,
 *     allocateCode?: (bytes: number) => number }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 */

/** @param {number} value */
const bitsOf = value=>new Uint32Array(Float32Array.of(value).buffer)[0];
/** @param {number} bits */
const floatOf = bits=>new Float32Array(Uint32Array.of(bits >>> 0).buffer)[0];

/**
 * @param {LineHost} host
 */
export function createLines(host){
    const { u32, putU32s, method } = createDeviceCalls(host);
    /** @param {number} at @param {number} count */
    const floats = (at, count)=>Array.from(new Float32Array(host.readMemory(at >>> 0, count * 4)
        .slice().buffer));

    /**
     * Begin's work, once its handler has returned: the state saved, then set.
     *
     * @param {any} state @param {any} thread
     */
    const start = async(state, thread)=>{
        await null;
        const heap = /** @type {NonNullable<LineHost['heap']>} */ (host.heap);
        /** @param {number} slot @param {number[]} rest */
        const call = (slot, rest)=>method(thread, state.device, slot, rest);
        const out = heap.allocate(4);
        if (out === 0)
        {
            return E_OUTOFMEMORY;
        }
        putU32s(out, [0]);
        // D3DSBT_ALL.
        state.saved = await call(DEVICE.CreateStateBlock, [1, out]) === D3D_OK ? u32(out) : 0;
        heap.free(out);
        await call(DEVICE.SetVertexShader, [0]);
        await call(DEVICE.SetPixelShader, [0]);
        await call(DEVICE.SetTexture, [0, 0]);
        await call(DEVICE.SetFVF, [FVF]);
        for (const [name, value] of RENDER_STATES)
        {
            await call(DEVICE.SetRenderState, [name, value]);
        }
        await call(DEVICE.SetRenderState, [D3DRS_ANTIALIASEDLINEENABLE, state.antialias ? 1 : 0]);
        for (const [stage, name, value] of STAGE_STATES)
        {
            await call(DEVICE.SetTextureStageState, [stage, name, value]);
        }
        return D3D_OK;
    };

    /** End's work: the device's state put back. @param {any} state @param {any} thread */
    const finish = async(state, thread)=>{
        await null;
        if (state.saved)
        {
            await method(thread, state.saved, STATEBLOCK_APPLY, []);
            await method(thread, state.saved, UNKNOWN_RELEASE, []);
            state.saved = 0;
        }
        return D3D_OK;
    };

    /**
     * The vertices of a polyline in screen space, as a primitive and its count.
     *
     * @param {any} state @param {(number[] | null)[]} points  x, y, z, rhw; null where a
     *     vertex is behind the eye. @param {number} color
     * @returns {{ type: number, count: number, data: DataView } | null}
     */
    const geometry = (state, points, color)=>{
        /** @type {number[][]} */
        const vertices = [];
        const thin = state.width <= 1;
        for (let i = 0; i + 1 < points.length; i++)
        {
            const a = points[i];
            const b = points[i + 1];
            if (!a || !b)
            {
                continue;
            }
            if (thin)
            {
                vertices.push(a, b);
                continue;
            }
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = Math.hypot(dx, dy);
            if (length === 0)
            {
                continue;
            }
            const nx = -dy / length * state.width / 2;
            const ny = dx / length * state.width / 2;
            /** @param {number[]} p @param {number} side */
            const off = (p, side)=>[p[0] + nx * side, p[1] + ny * side, p[2], p[3]];
            vertices.push(off(a, 1), off(b, 1), off(a, -1), off(b, 1), off(b, -1), off(a, -1));
        }
        if (vertices.length === 0)
        {
            return null;
        }
        const data = new DataView(new ArrayBuffer(vertices.length * STRIDE));
        vertices.forEach(([x, y, z, rhw], k)=>{
            data.setFloat32(k * STRIDE, x, true);
            data.setFloat32(k * STRIDE + 4, y, true);
            data.setFloat32(k * STRIDE + 8, z, true);
            data.setFloat32(k * STRIDE + 12, rhw, true);
            data.setUint32(k * STRIDE + 16, color >>> 0, true);
        });
        // Separate segments, not a strip, so a vertex behind the eye breaks
        // the line rather than joining across it.
        return thin ? { type: D3DPT_LINELIST, count: vertices.length / 2, data }
            : { type: D3DPT_TRIANGLELIST, count: vertices.length / 3, data };
    };

    /**
     * A Draw's work: the polyline drawn, inside a Begin and End of its own
     * when the program made none.
     *
     * @param {any} state @param {() => Promise<(number[] | null)[]>} pointsOf
     * @param {number} color @param {any} thread
     */
    const draw = async(state, pointsOf, color, thread)=>{
        await null;
        const own = !state.begun;
        if (own)
        {
            const begun = await start(state, thread);
            if (begun !== D3D_OK)
            {
                return begun;
            }
        }
        if (state.pattern !== SOLID)
        {
            host.divergence?.('ID3DXLine::Draw', 'a stipple pattern: drawn solid');
        }
        if (state.glLines && state.width > 1)
        {
            host.divergence?.('ID3DXLine::Draw', 'OpenGL-style lines: the width is laid '
                + 'across each segment');
        }
        let answer = D3D_OK;
        const shape = geometry(state, await pointsOf(), color);
        if (shape)
        {
            const heap = /** @type {NonNullable<LineHost['heap']>} */ (host.heap);
            const data = heap.allocate(shape.data.byteLength);
            if (data === 0)
            {
                answer = E_OUTOFMEMORY;
            }
            else
            {
                host.writeMemory(data, new Uint8Array(shape.data.buffer));
                answer = await method(thread, state.device, DEVICE.DrawPrimitiveUP,
                    [shape.type, shape.count, data, STRIDE]);
                heap.free(data);
            }
        }
        if (own)
        {
            await finish(state, thread);
        }
        return answer;
    };

    /** Lines by the interface pointer a program holds. @type {Map<number, any>} */
    const byPointer = new Map();
    /** The code of each slot that answers a FLOAT, by method, once placed. */
    /** @type {Map<string, number>} */
    const floatSlots = new Map();

    /**
     * A slot whose method answers a FLOAT: its code, placed once and shared by
     * every line, calls the trap of the first table built -- a trap finds its
     * object by the interface pointer, so any line's will do.
     *
     * @param {string} name @param {(state: any) => number} value
     * @returns {import('../ole32/objects.js').ComMethod}
     */
    const floatMethod = (name, value)=>/** @type {any} */ ({
        name, argBytes: 4,
        invoke: (/** @type {any} */ object)=>bitsOf(value(object.state)),
        guest: (/** @type {{ trap: number }} */ { trap })=>{
            const placed = floatSlots.get(name);
            if (placed !== undefined)
            {
                return placed;
            }
            const heap = /** @type {NonNullable<LineHost['heap']>} */ (host.heap);
            const at = (heap.allocateCode ?? heap.allocate)(FLOAT_RETURN_LENGTH);
            if (at === 0)
            {
                return trap;
            }
            const relative = (trap - (at + 9)) | 0;
            host.writeMemory(at, Uint8Array.of(0xff, 0x74, 0x24, 0x04, 0xe8,
                relative & 0xff, relative >>> 8 & 0xff, relative >>> 16 & 0xff,
                relative >>> 24 & 0xff, 0x50, 0xd9, 0x04, 0x24, 0x58, 0xc2, 0x04, 0x00));
            floatSlots.set(name, at);
            return at;
        },
    });

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const line = {
        id: IID_ID3DXLINE,
        methods: [
            /** HRESULT GetDevice(LPDIRECT3DDEVICE9 *ppDevice) */
            { name: 'GetDevice', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32s(out, [object.state.device]);
                // A reference the caller releases.
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>method(thread, object.state.device,
                    UNKNOWN_ADDREF, [])).then(()=>D3D_OK);
            } },
            /** HRESULT Begin() */
            { name: 'Begin', argBytes: 4, invoke: object=>{
                const state = object.state;
                if (state.begun)
                {
                    return D3DERR_INVALIDCALL;
                }
                state.begun = true;
                return start(state, host.currentThread?.());
            } },
            /** HRESULT Draw(CONST D3DXVECTOR2 *pVertexList, DWORD dwVertexListCount, D3DCOLOR) */
            { name: 'Draw', argBytes: 16, invoke: (object, [list, count, color])=>{
                if ((list >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const flat = floats(list, (count >>> 0) * 2);
                const points = Array.from({ length: count >>> 0 }, (_, i)=>
                    [flat[i * 2], flat[i * 2 + 1], 0, 1]);
                return draw(object.state, async()=>points, color,
                    host.currentThread?.());
            } },
            /**
             * HRESULT DrawTransform(CONST D3DXVECTOR3 *pVertexList, DWORD dwVertexListCount,
             *     CONST D3DXMATRIX *pTransform, D3DCOLOR Color)
             */
            { name: 'DrawTransform', argBytes: 20, invoke: (object, [list, count, at, color])=>{
                if ((list >>> 0) === 0 || (at >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const flat = floats(list, (count >>> 0) * 3);
                const m = floats(at, 16);
                const state = object.state;
                const thread = host.currentThread?.();
                const pointsOf = async()=>{
                    const heap = /** @type {NonNullable<LineHost['heap']>} */ (host.heap);
                    const viewport = heap.allocate(24);
                    await method(thread, state.device, DEVICE.GetViewport, [viewport]);
                    const [x0, y0, width, height] = [0, 4, 8, 12].map(o=>u32(viewport + o));
                    const [minZ, maxZ] = floats(viewport + 16, 2);
                    heap.free(viewport);
                    return Array.from({ length: count >>> 0 }, (_, i)=>{
                        const [x, y, z] = flat.slice(i * 3, i * 3 + 3);
                        /** @param {number} c */
                        const column = c=>x * m[c] + y * m[4 + c] + z * m[8 + c] + m[12 + c];
                        const w = column(3);
                        if (!(w > 0))
                        {
                            return null;
                        }
                        return [x0 + (column(0) / w + 1) * width / 2,
                            y0 + (1 - column(1) / w) * height / 2,
                            minZ + column(2) / w * (maxZ - minZ), 1 / w];
                    });
                };
                return draw(state, pointsOf, color, thread);
            } },
            /** HRESULT SetPattern(DWORD dwPattern) */
            { name: 'SetPattern', argBytes: 8, invoke: (object, [pattern])=>{
                object.state.pattern = pattern >>> 0;
                return D3D_OK;
            } },
            /** DWORD GetPattern() */
            { name: 'GetPattern', argBytes: 4, invoke: object=>object.state.pattern },
            /** HRESULT SetPatternScale(FLOAT fPatternScale) */
            { name: 'SetPatternScale', argBytes: 8, invoke: (object, [scale])=>{
                object.state.patternScale = floatOf(scale);
                return D3D_OK;
            } },
            /** FLOAT GetPatternScale() */
            floatMethod('GetPatternScale', state=>state.patternScale),
            /** HRESULT SetWidth(FLOAT fWidth) -- a width of zero or less is refused. */
            { name: 'SetWidth', argBytes: 8, invoke: (object, [bits])=>{
                const width = floatOf(bits);
                if (!(width > 0))
                {
                    return D3DERR_INVALIDCALL;
                }
                object.state.width = width;
                return D3D_OK;
            } },
            /** FLOAT GetWidth() */
            floatMethod('GetWidth', state=>state.width),
            /** HRESULT SetAntialias(BOOL bAntialias) */
            { name: 'SetAntialias', argBytes: 8, invoke: (object, [on])=>{
                object.state.antialias = on ? 1 : 0;
                return D3D_OK;
            } },
            /** BOOL GetAntialias() */
            { name: 'GetAntialias', argBytes: 4, invoke: object=>object.state.antialias },
            /** HRESULT SetGLLines(BOOL bGLLines) */
            { name: 'SetGLLines', argBytes: 8, invoke: (object, [on])=>{
                object.state.glLines = on ? 1 : 0;
                return D3D_OK;
            } },
            /** BOOL GetGLLines() */
            { name: 'GetGLLines', argBytes: 4, invoke: object=>object.state.glLines },
            /** HRESULT End() */
            { name: 'End', argBytes: 4, invoke: object=>{
                const state = object.state;
                if (!state.begun)
                {
                    return D3DERR_INVALIDCALL;
                }
                state.begun = false;
                return finish(state, host.currentThread?.());
            } },
            /** HRESULT OnLostDevice() */
            { name: 'OnLostDevice', argBytes: 4, invoke: ()=>D3D_OK },
            /** HRESULT OnResetDevice() */
            { name: 'OnResetDevice', argBytes: 4, invoke: ()=>D3D_OK },
        ],
    };

    /**
     * HRESULT D3DXCreateLine(LPDIRECT3DDEVICE9 pDevice, LPD3DXLINE *ppLine)
     *
     * A line one pixel wide, solid, its pattern scale 1, neither antialiased
     * nor OpenGL-style.
     *
     * @param {number[]} args
     * @returns {number}
     */
    const create = ([device, out])=>{
        if ((out >>> 0) !== 0)
        {
            putU32s(out, [0]);
        }
        if ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.vtables)
        {
            return D3DERR_INVALIDCALL;
        }
        let pointer = 0;
        const object = createComObject(IID_ID3DXLINE, { interfaces: [line],
            state: { device: device >>> 0, width: 1, pattern: SOLID, patternScale: 1,
                antialias: 0, glLines: 0, begun: false, saved: 0 },
            destroy: ()=>byPointer.delete(pointer) });
        pointer = host.vtables.publish(object, IID_ID3DXLINE) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        byPointer.set(pointer, object);
        putU32s(out, [pointer]);
        return D3D_OK;
    };

    return { create, line,
        /** @param {number} pointer */
        objectAt: pointer=>byPointer.get(pointer >>> 0) ?? null,
        /** @param {string} name  Where that FLOAT slot's code is, once a table is built. */
        floatSlot: name=>floatSlots.get(name) ?? 0 };
}
