/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX's geometry over vertex data: the bounds of a run of positions.
 *
 * Positions are D3DXVECTOR3, three floats at the start of each vertex, the
 * vertices `stride` bytes apart. The arithmetic is single precision, rounded
 * after every operation, as D3DX does it in float.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

/**
 * @typedef {Object} MeshHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {MeshHost} host
 */
export function createMeshFunctions(host){
    const f = Math.fround;
    /** @param {number} at @returns {[number, number, number]} */
    const position = at=>{
        const view = new DataView(host.readMemory(at >>> 0, 12).slice().buffer);
        return [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)];
    };
    /** @param {number} at @param {number[]} values */
    const putFloats = (at, values)=>host.writeMemory(at >>> 0,
        new Uint8Array(Float32Array.from(values).buffer));

    return {
        /**
         * HRESULT D3DXComputeBoundingBox(const D3DXVECTOR3 *pFirstPosition,
         *     DWORD NumVertices, DWORD dwStride, D3DXVECTOR3 *pMin, D3DXVECTOR3 *pMax)
         *
         * The first position starts both corners, so no vertices at all still
         * reads one: the documentation gives no other answer for an empty run.
         */
        D3DXComputeBoundingBox: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([first, count, stride, minOut, maxOut])=>{
                if ((first >>> 0) === 0 || (minOut >>> 0) === 0 || (maxOut >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const low = position(first);
                const high = low.slice();
                for (let i = 1; i < (count >>> 0); i++)
                {
                    const p = position((first >>> 0) + i * (stride >>> 0));
                    for (let k = 0; k < 3; k++)
                    {
                        low[k] = Math.min(low[k], p[k]);
                        high[k] = Math.max(high[k], p[k]);
                    }
                }
                putFloats(minOut, low);
                putFloats(maxOut, high);
                return D3D_OK;
            },
        },

        /**
         * HRESULT D3DXComputeBoundingSphere(const D3DXVECTOR3 *pFirstPosition,
         *     DWORD NumVertices, DWORD dwStride, D3DXVECTOR3 *pCenter, FLOAT *pRadius)
         *
         * The centre is the mean of the positions, not the smallest enclosing
         * sphere's; the radius is the farthest position from it.
         */
        D3DXComputeBoundingSphere: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([first, count, stride, centerOut, radiusOut])=>{
                if ((first >>> 0) === 0 || (centerOut >>> 0) === 0 || (radiusOut >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const n = count >>> 0;
                /** @param {number} i */
                const at = i=>(first >>> 0) + i * (stride >>> 0);
                const sum = [0, 0, 0];
                for (let i = 0; i < n; i++)
                {
                    const p = position(at(i));
                    for (let k = 0; k < 3; k++)
                    {
                        sum[k] = f(sum[k] + p[k]);
                    }
                }
                const center = sum.map(s=>f(s / n));
                let radius = 0;
                for (let i = 0; i < n; i++)
                {
                    const [dx, dy, dz] = position(at(i)).map((v, k)=>f(v - center[k]));
                    radius = Math.max(radius, f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy))
                        + f(dz * dz)))));
                }
                putFloats(centerOut, center);
                putFloats(radiusOut, [radius]);
                return D3D_OK;
            },
        },
    };
}
