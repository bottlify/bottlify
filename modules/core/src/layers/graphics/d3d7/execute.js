/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Execute buffers, DirectX 3's way of drawing, run on the device the later
 * versions draw through.
 *
 * An execute buffer is a block of guest memory holding vertices and, after
 * them, a stream of instructions: D3DINSTRUCTION headers -- an opcode, the
 * size of one operand and how many follow -- each with its operands. The
 * instructions set render, light and transform states, load and multiply
 * matrices by handle, process vertices from the buffer into the device's
 * transformed-vertex array, and draw points, lines and triangles that index
 * into that array. So the run keeps one such array per execution, of
 * D3DTLVERTEX, and every draw is a draw of transformed vertices; processing
 * is the Direct3D 7 ProcessVertices, lighting and all.
 *
 * What is not done: D3DOP_SPAN (horizontal runs of pixels, a software
 * rasteriser's primitive) is skipped, and the extents D3DPROCESSVERTICES_
 * UPDATEEXTENTS asks for are not accumulated into the status.
 */

import {
    D3DDEB_BUFSIZE, D3DDEB_CAPS, D3DDEB_LPDATA, D3DERR_EXECUTE_LOCKED,
    D3DERR_EXECUTE_NOT_LOCKED, D3DFVF_LVERTEX, D3DFVF_TLVERTEX, D3DFVF_VERTEX, D3DOP, D3DPT,
    D3DPROCESSVERTICES, D3D_OK, DDERR_INVALIDPARAMS,
} from './constants.js';
import { D3DVOP, processVertices } from './process.js';
import { loadTexture } from './load.js';
import { multiplyMatrices } from '../d3d8/render.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';

/** Every vertex an execute buffer holds is 32 bytes, whichever of the three it is. */
const VERTEX_BYTES = 32;

/** The most vertices one run may process: a D3DPROCESSVERTICES index is a WORD. */
const MAX_VERTICES = 0x10000;

/** D3DINSTRUCTION: the opcode, one operand's size and the count, in four bytes. */
const INSTRUCTION_BYTES = 4;

/**
 * @typedef {Object} ExecuteMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 *
 * @typedef {Object} ExecuteData  D3DEXECUTEDATA's fields.
 * @property {number} vertexOffset
 * @property {number} vertexCount
 * @property {number} instructionOffset
 * @property {number} instructionLength
 * @property {number} hVertexOffset
 * @property {{ flags: number, status: number, extent: number[] }} status
 */

/**
 * An execute buffer over `size` bytes at `data`: the program's own memory
 * when it named some, a fresh allocation otherwise.
 *
 * @param {{ caps: number, size: number, data: number }} desc
 */
export function createExecuteBuffer(desc){
    let locked = false;
    let count = 1;
    /** @type {ExecuteData} */
    let executeData = {
        vertexOffset: 0, vertexCount: 0, instructionOffset: 0, instructionLength: 0,
        hVertexOffset: 0, status: { flags: 0, status: 0, extent: [0, 0, 0, 0] },
    };
    const buffer = {
        caps: desc.caps >>> 0,
        size: desc.size >>> 0,
        data: desc.data >>> 0,
        get locked(){
            return locked;
        },
        get refCount(){
            return count;
        },
        addRef(){
            count++;
            return count;
        },
        release(){
            count = Math.max(count - 1, 0);
            return count;
        },

        /** @returns {{ hr: number, desc?: { flags: number, caps: number, size: number, data: number } }} */
        lock(){
            if (locked)
            {
                return { hr: D3DERR_EXECUTE_LOCKED };
            }
            locked = true;
            return {
                hr: D3D_OK,
                desc: { flags: D3DDEB_BUFSIZE | D3DDEB_CAPS | D3DDEB_LPDATA, caps: buffer.caps,
                    size: buffer.size, data: buffer.data },
            };
        },
        unlock(){
            if (!locked)
            {
                return D3DERR_EXECUTE_NOT_LOCKED;
            }
            locked = false;
            return D3D_OK;
        },

        /**
         * Stored as given: Windows checks the structure's size and nothing
         * else (Wine's ddraw1.c test_execute_data).
         *
         * @param {ExecuteData} value
         */
        setExecuteData(value){
            executeData = { ...value,
                status: { ...value.status, extent: [...value.status.extent] } };
            return D3D_OK;
        },
        /** @returns {ExecuteData} */
        getExecuteData: ()=>({ ...executeData, status: { ...executeData.status,
            extent: [...executeData.status.extent] } }),
    };
    return buffer;
}

/**
 * Runs an execute buffer's instructions on a device, through a viewport.
 *
 * @param {Object} request
 * @param {ExecuteMemory} request.memory
 * @param {any} request.device    A legacy device (`d3d7/legacy.js`).
 * @param {ReturnType<typeof createExecuteBuffer>} request.buffer
 * @param {any} request.viewport  One of the device's.
 * @returns {number} HRESULT: the first draw's failure, or D3D_OK
 */
export function executeBuffer({ memory, device, buffer, viewport }){
    if (!buffer || !viewport)
    {
        return DDERR_INVALIDPARAMS;
    }
    if (buffer.locked)
    {
        return D3DERR_EXECUTE_LOCKED;
    }
    const data = buffer.getExecuteData();
    const end = buffer.size;
    // Reads stay inside the buffer, whatever the execute data claims.
    /** @param {number} offset @param {number} length */
    const read = (offset, length)=>(offset < 0 || offset + length > end
        ? null
        : memory.readMemory(buffer.data + offset, length));

    const vertexCount = Math.min(data.vertexCount, MAX_VERTICES);
    const transformed = new Uint8Array(vertexCount * VERTEX_BYTES);
    // An execute-buffer device draws nothing through a viewport its target
    // cannot hold (Wine's ddraw1.c test_viewport); its states still apply.
    const drawing = viewport.data !== null && device.holds(viewport.data);

    return device.through(viewport, ()=>{
        let at = data.instructionOffset;
        const stop = Math.min(data.instructionOffset + data.instructionLength, end);
        let hr = D3D_OK;
        while (at + INSTRUCTION_BYTES <= stop)
        {
            const header = /** @type {Uint8Array} */ (read(at, INSTRUCTION_BYTES));
            const opcode = header[0];
            const size = header[1];
            const repeat = header[2] | header[3] << 8;
            const operands = at + INSTRUCTION_BYTES;
            if (opcode === D3DOP.EXIT)
            {
                break;
            }
            const bytes = read(operands, size * repeat);
            if (!bytes)
            {
                break;
            }
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const next = operands + size * repeat;
            if (opcode === D3DOP.BRANCHFORWARD)
            {
                const taken = branch(view, data.status.status);
                if (taken === 0)
                {
                    break;
                }
                at = taken === null ? next : at + taken;
                continue;
            }
            const failed = perform(opcode, size, repeat, view);
            if (failed !== D3D_OK && hr === D3D_OK)
            {
                hr = failed;
            }
            at = next;
        }
        return hr;
    });

    /**
     * D3DBRANCH: taken when the status masked equals the value, or when it
     * does not and the branch is negated; an offset of zero ends the run.
     *
     * @param {DataView} view @param {number} status
     * @returns {number | null} how far forward from this instruction, or null to go on
     */
    function branch(view, status){
        const mask = view.getUint32(0, true);
        const value = view.getUint32(4, true);
        const negate = view.getUint32(8, true) !== 0;
        const offset = view.getUint32(12, true);
        return ((status & mask) >>> 0 === value) !== negate ? offset : null;
    }

    /**
     * @param {number} opcode @param {number} size @param {number} repeat
     * @param {DataView} view  The operands.
     * @returns {number} HRESULT
     */
    function perform(opcode, size, repeat, view){
        /** @param {number} k @param {number} offset */
        const dword = (k, offset)=>view.getUint32(k * size + offset, true);
        /** @param {number} k @param {number} offset */
        const word = (k, offset)=>view.getUint16(k * size + offset, true);
        switch (opcode)
        {
            case D3DOP.STATERENDER:
                for (let k = 0; k < repeat; k++)
                {
                    device.setRenderState(dword(k, 0), dword(k, 4));
                }
                return D3D_OK;
            case D3DOP.STATELIGHT:
                for (let k = 0; k < repeat; k++)
                {
                    device.setLightState(dword(k, 0), dword(k, 4));
                }
                return D3D_OK;
            case D3DOP.STATETRANSFORM:
                for (let k = 0; k < repeat; k++)
                {
                    const matrix = device.getMatrix(dword(k, 4));
                    if (matrix)
                    {
                        device.setTransform(dword(k, 0), matrix);
                    }
                }
                return D3D_OK;
            case D3DOP.MATRIXLOAD:
                for (let k = 0; k < repeat; k++)
                {
                    const source = device.getMatrix(dword(k, 4));
                    if (source)
                    {
                        device.setMatrix(dword(k, 0), source);
                    }
                }
                return D3D_OK;
            case D3DOP.MATRIXMULTIPLY:
                for (let k = 0; k < repeat; k++)
                {
                    const a = device.getMatrix(dword(k, 4));
                    const b = device.getMatrix(dword(k, 8));
                    if (a && b)
                    {
                        device.setMatrix(dword(k, 0), multiplyMatrices(a, b));
                    }
                }
                return D3D_OK;
            case D3DOP.PROCESSVERTICES:
                for (let k = 0; k < repeat; k++)
                {
                    process(dword(k, 0), word(k, 4), word(k, 6), dword(k, 8));
                }
                return D3D_OK;
            case D3DOP.TEXTURELOAD:
                for (let k = 0; k < repeat; k++)
                {
                    const dest = device.legacy.textures.surfaceOf(dword(k, 0));
                    const src = device.legacy.textures.surfaceOf(dword(k, 4));
                    loadTexture({ memory, dest, destPoint: null, src, srcRect: null,
                        keepDestinationKey: true });
                }
                return D3D_OK;
            case D3DOP.SETSTATUS:
                if (repeat > 0)
                {
                    const status = {
                        flags: dword(0, 0), status: dword(0, 4),
                        extent: [0, 1, 2, 3].map(index=>dword(0, 8 + index * 4) | 0),
                    };
                    buffer.setExecuteData({ ...buffer.getExecuteData(), status });
                    data.status = status;
                }
                return D3D_OK;
            case D3DOP.TRIANGLE:
                return drawIndexed(D3DPT.TRIANGLELIST, Array.from({ length: repeat * 3 },
                    (_, index)=>word(Math.floor(index / 3), (index % 3) * 2)));
            case D3DOP.LINE:
                return drawIndexed(D3DPT.LINELIST, Array.from({ length: repeat * 2 },
                    (_, index)=>word(index >> 1, (index & 1) * 2)));
            case D3DOP.POINT: {
                let hr = D3D_OK;
                for (let k = 0; k < repeat && hr === D3D_OK; k++)
                {
                    const points = word(k, 0);
                    const first = word(k, 2);
                    hr = drawRange(first, points);
                }
                return hr;
            }
            default:
                // D3DOP_SPAN and anything unknown: skipped whole, by its sizes.
                return D3D_OK;
        }
    }

    /**
     * D3DPROCESSVERTICES: `count` vertices of the buffer from `start` into
     * the transformed array at `dest`, transformed and lit, transformed, or
     * copied as they are.
     *
     * @param {number} flags @param {number} start @param {number} dest @param {number} count
     */
    function process(flags, start, dest, count){
        const n = Math.max(0, Math.min(count, vertexCount - dest));
        const from = data.vertexOffset + start * VERTEX_BYTES;
        const operation = flags & D3DPROCESSVERTICES.OPMASK;
        if (operation === D3DPROCESSVERTICES.COPY)
        {
            const bytes = read(from, n * VERTEX_BYTES);
            if (bytes)
            {
                transformed.set(bytes, dest * VERTEX_BYTES);
            }
            return;
        }
        const fvf = operation === D3DPROCESSVERTICES.TRANSFORMLIGHT
            ? D3DFVF_VERTEX
            : D3DFVF_LVERTEX;
        const layout = decodeFvf(fvf);
        if (!read(from, n * VERTEX_BYTES))
        {
            return;
        }
        processVertices({
            // The source is the program's buffer; what is written is this run's array.
            memory: {
                readMemory: memory.readMemory,
                writeMemory: (address, bytes)=>transformed.set(bytes, address),
            },
            vertexOp: operation === D3DPROCESSVERTICES.TRANSFORMLIGHT
                ? D3DVOP.TRANSFORM | D3DVOP.LIGHT
                : D3DVOP.TRANSFORM,
            dest: { base: 0, fvf: D3DFVF_TLVERTEX, numVertices: vertexCount,
                stride: VERTEX_BYTES },
            destIndex: dest,
            count: n,
            source: {
                fvf,
                addressOf: (name, k)=>{
                    const attribute = layout.attributes.find(entry=>entry.name === name);
                    return attribute
                        ? buffer.data + from + k * VERTEX_BYTES + attribute.offset
                        : null;
                },
            },
            state: device.processingState(),
            flags: 0,
        });
    }

    /**
     * @param {number} type @param {number[]} indices  Into the transformed array.
     * @returns {number}
     */
    function drawIndexed(type, indices){
        if (!drawing || indices.length === 0)
        {
            return D3D_OK;
        }
        const reach = Math.max(...indices) + 1;
        if (reach > vertexCount)
        {
            return DDERR_INVALIDPARAMS;
        }
        return device.drawIndexedPrimitive(type, D3DFVF_TLVERTEX,
            transformed.subarray(0, reach * VERTEX_BYTES), reach,
            new Uint8Array(Uint16Array.from(indices).buffer), indices.length, 0);
    }

    /** @param {number} first @param {number} count @returns {number} */
    function drawRange(first, count){
        if (!drawing || count === 0)
        {
            return D3D_OK;
        }
        if (first + count > vertexCount)
        {
            return DDERR_INVALIDPARAMS;
        }
        return device.drawPrimitive(D3DPT.POINTLIST, D3DFVF_TLVERTEX,
            transformed.subarray(first * VERTEX_BYTES, (first + count) * VERTEX_BYTES), count, 0);
    }
}
