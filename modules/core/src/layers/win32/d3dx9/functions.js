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
 */

const E_NOTIMPL = 0x80004001;

/**
 * @typedef {Object} D3dxHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {D3dxHost} host
 */
export function createD3dxFunctions(host){
    /** @param {number} address @param {number} count */
    const floats = (address, count)=>{
        const bytes = host.readMemory(address >>> 0, count * 4);
        return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 4));
    };
    /** @param {number} address @param {Float32Array} values */
    const writeFloats = (address, values)=>host.writeMemory(address >>> 0,
        new Uint8Array(values.buffer, values.byteOffset, values.byteLength));

    /** @param {Float32Array} a @param {Float32Array} b  Row-major 4x4 product. */
    const multiply = (a, b)=>{
        const out = new Float32Array(16);
        for (let row = 0; row < 4; row++)
        {
            for (let col = 0; col < 4; col++)
            {
                let sum = 0;
                for (let k = 0; k < 4; k++)
                {
                    sum += a[row * 4 + k] * b[k * 4 + col];
                }
                out[row * 4 + col] = sum;
            }
        }
        return out;
    };

    /**
     * A row vector times a matrix, the convention D3DX transforms in: the
     * point is on the left, so it is `v * m`.
     *
     * @param {number[]} v  Four components; a 3-vector passes 1 as the fourth.
     * @param {Float32Array} m
     */
    const transform = (v, m)=>{
        const out = new Float32Array(4);
        for (let col = 0; col < 4; col++)
        {
            out[col] = v[0] * m[col] + v[1] * m[4 + col] + v[2] * m[8 + col] + v[3] * m[12 + col];
        }
        return out;
    };

    return {
        /** D3DXMATRIX* D3DXMatrixMultiply(D3DXMATRIX* pOut, const D3DXMATRIX* pM1, const D3DXMATRIX* pM2) */
        D3DXMatrixMultiply: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, m1, m2])=>{
                writeFloats(out, multiply(floats(m1, 16), floats(m2, 16)));
                return out >>> 0;
            },
        },

        /** D3DXMATRIX* D3DXMatrixTranspose(D3DXMATRIX* pOut, const D3DXMATRIX* pM) */
        D3DXMatrixTranspose: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, m])=>{
                const source = floats(m, 16);
                const result = new Float32Array(16);
                for (let row = 0; row < 4; row++)
                {
                    for (let col = 0; col < 4; col++)
                    {
                        result[row * 4 + col] = source[col * 4 + row];
                    }
                }
                writeFloats(out, result);
                return out >>> 0;
            },
        },

        /**
         * D3DXMATRIX* D3DXMatrixInverse(D3DXMATRIX* pOut, FLOAT* pDet, const D3DXMATRIX* pM)
         *
         * NULL when the matrix is singular, which a caller checks before using
         * the result; the determinant is written when a pointer for it is given.
         */
        D3DXMatrixInverse: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, determinantOut, m])=>{
                const source = floats(m, 16);
                const inverse = new Float32Array(16);
                const determinant = invert4x4(source, inverse);
                if ((determinantOut >>> 0) !== 0)
                {
                    writeFloats(determinantOut, Float32Array.of(determinant));
                }
                if (determinant === 0)
                {
                    return 0;
                }
                writeFloats(out, inverse);
                return out >>> 0;
            },
        },

        /** D3DXMATRIX* D3DXMatrixTranslation(D3DXMATRIX* pOut, FLOAT x, FLOAT y, FLOAT z) */
        D3DXMatrixTranslation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, x, y, z])=>{
                const m = identity();
                [m[12], m[13], m[14]] = asFloats([x, y, z]);
                writeFloats(out, m);
                return out >>> 0;
            },
        },

        /** D3DXMATRIX* D3DXMatrixOrthoLH(D3DXMATRIX* pOut, FLOAT w, FLOAT h, FLOAT zn, FLOAT zf) */
        D3DXMatrixOrthoLH: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, w, h, zn, zf])=>{
                const [width, height, near, far] = asFloats([w, h, zn, zf]);
                const m = new Float32Array(16);
                m[0] = 2 / width;
                m[5] = 2 / height;
                m[10] = 1 / (far - near);
                m[14] = near / (near - far);
                m[15] = 1;
                writeFloats(out, m);
                return out >>> 0;
            },
        },

        /** D3DXMATRIX* D3DXMatrixPerspectiveLH(D3DXMATRIX* pOut, FLOAT w, FLOAT h, FLOAT zn, FLOAT zf) */
        D3DXMatrixPerspectiveLH: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, w, h, zn, zf])=>{
                const [width, height, near, far] = asFloats([w, h, zn, zf]);
                const m = new Float32Array(16);
                m[0] = 2 * near / width;
                m[5] = 2 * near / height;
                m[10] = far / (far - near);
                m[11] = 1;
                m[14] = near * far / (near - far);
                writeFloats(out, m);
                return out >>> 0;
            },
        },

        /** D3DXVECTOR4* D3DXVec4Transform(D3DXVECTOR4* pOut, const D3DXVECTOR4* pV, const D3DXMATRIX* pM) */
        D3DXVec4Transform: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, v, m])=>{
                writeFloats(out, transform([...floats(v, 4)], floats(m, 16)));
                return out >>> 0;
            },
        },

        /** D3DXVECTOR4* D3DXVec3Transform(D3DXVECTOR4* pOut, const D3DXVECTOR3* pV, const D3DXMATRIX* pM) */
        D3DXVec3Transform: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, v, m])=>{
                const source = floats(v, 3);
                writeFloats(out, transform([source[0], source[1], source[2], 1], floats(m, 16)));
                return out >>> 0;
            },
        },

        /** D3DXVECTOR3* D3DXVec3TransformNormal(D3DXVECTOR3* pOut, const D3DXVECTOR3* pV, const D3DXMATRIX* pM) */
        D3DXVec3TransformNormal: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, v, m])=>{
                const source = floats(v, 3);
                // A normal ignores the translation row, so the fourth component
                // is zero rather than one.
                const result = transform([source[0], source[1], source[2], 0], floats(m, 16));
                writeFloats(out, result.subarray(0, 3));
                return out >>> 0;
            },
        },

        /**
         * D3DXVECTOR3* D3DXVec3TransformCoordArray(D3DXVECTOR3* pOut, UINT outStride,
         *     const D3DXVECTOR3* pV, UINT vStride, const D3DXMATRIX* pM, UINT n)
         *
         * The projected transform of each point: `v * m` with the result
         * divided by its own w, which is what "coord" rather than "transform"
         * means. Strides are byte counts between elements.
         */
        D3DXVec3TransformCoordArray: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([out, outStride, v, vStride, m, count])=>{
                const matrix = floats(m, 16);
                for (let at = 0; at < (count >>> 0); at++)
                {
                    const source = floats((v >>> 0) + at * (vStride >>> 0), 3);
                    const point = transform([source[0], source[1], source[2], 1], matrix);
                    const w = point[3] === 0 ? 1 : point[3];
                    writeFloats((out >>> 0) + at * (outStride >>> 0),
                        Float32Array.of(point[0] / w, point[1] / w, point[2] / w));
                }
                return out >>> 0;
            },
        },

        /** D3DXVECTOR3* D3DXVec3Normalize(D3DXVECTOR3* pOut, const D3DXVECTOR3* pV) */
        D3DXVec3Normalize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, v])=>{
                const source = floats(v, 3);
                const length = Math.hypot(source[0], source[1], source[2]);
                // D3DX leaves a zero vector zero rather than dividing by zero.
                const scale = length === 0 ? 0 : 1 / length;
                writeFloats(out,
                    Float32Array.of(source[0] * scale, source[1] * scale, source[2] * scale));
                return out >>> 0;
            },
        },

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

/** @returns {Float32Array} the 4x4 identity, row-major. */
function identity(){
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

/**
 * The 32-bit floats the guest passed. A FLOAT argument arrives as the raw
 * dword the bridge read off the stack; it is the bit pattern of a float, not
 * an integer, so it is reinterpreted rather than converted.
 *
 * @param {number[]} raw
 * @returns {number[]}
 */
function asFloats(raw){
    const view = new DataView(new ArrayBuffer(4));
    return raw.map(value=>{
        view.setUint32(0, value >>> 0, true);
        return view.getFloat32(0, true);
    });
}

/**
 * Inverts a row-major 4x4 by cofactors, writing the result and returning the
 * determinant; a singular matrix returns zero and writes nothing.
 *
 * @param {Float32Array} m @param {Float32Array} out
 * @returns {number}
 */
function invert4x4(m, out){
    const a = [
        m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15]
            + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10],
        -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15]
            - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10],
        m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15]
            + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6],
        -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11]
            - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6],
        -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15]
            - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10],
        m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15]
            + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10],
        -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15]
            - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6],
        m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11]
            + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6],
        m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15]
            + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9],
        -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15]
            - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9],
        m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15]
            + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5],
        -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11]
            - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5],
        -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14]
            - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9],
        m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14]
            + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9],
        -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14]
            - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5],
        m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10]
            + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5],
    ];
    const determinant = m[0] * a[0] + m[1] * a[4] + m[2] * a[8] + m[3] * a[12];
    if (determinant === 0)
    {
        return 0;
    }
    const scale = 1 / determinant;
    for (let at = 0; at < 16; at++)
    {
        out[at] = a[at] * scale;
    }
    return determinant;
}
