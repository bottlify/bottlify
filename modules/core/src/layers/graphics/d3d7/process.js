/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IDirect3DVertexBuffer7::ProcessVertices and ProcessVerticesStrided: the
 * device's transform and lighting, run on the processor into a vertex buffer
 * the program reads back or draws later.
 *
 * Positions go through the world matrices -- blended by the vertex's weights
 * under D3DRENDERSTATE_VERTEXBLEND -- then the view, the projection and the
 * viewport, and come out as screen x and y, a depth in the viewport's range
 * and the reciprocal of w. Lighting happens in camera space, with each normal
 * carried by the inverse transpose of its world-view matrix, the whole four by
 * four: under a matrix that is not affine that is not the same as its upper
 * three rows, and Wine's ddraw7 test_lighting has such a matrix leave a lit
 * vertex black. A normal is used at the length it arrives with unless
 * D3DRENDERSTATE_NORMALIZENORMALS asks otherwise.
 */

import { D3D_OK, DDERR_INVALIDPARAMS } from './constants.js';
import { D3DLIGHTTYPE, D3DMCS, D3DRS, D3DTS } from '../d3d8/constants.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';

/** D3DVOP: what ProcessVertices is asked to do. */
export const D3DVOP = Object.freeze({
    LIGHT: 0x400,
    TRANSFORM: 0x1,
    CLIP: 0x4,
    EXTENTS: 0x8,
});

/** D3DPV_DONOTCOPYDATA: leave alone what the operation does not compute. */
export const D3DPV_DONOTCOPYDATA = 0x1;

/** The width a depth range is taken as when it is empty or runs backwards. */
const DEGENERATE_DEPTH = 0.001;

/**
 * @typedef {Object} ProcessMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 *
 * @typedef {Object} ProcessingState  The device's state as a vertex sees it.
 * @property {(type: number) => ArrayLike<number>} transform  By D3D8 number.
 * @property {{ x: number, y: number, width: number, height: number,
 *   minDepth: number, maxDepth: number }} viewport
 * @property {(state: number) => number} renderState
 * @property {any[]} lights    The enabled ones, as D3DLIGHT7.
 * @property {any} material
 *
 * @typedef {Object} VertexSource
 * @property {number} fvf
 * @property {(attribute: string, vertex: number) => number | null} addressOf
 *           Where one vertex's attribute is, or null for one it does not have.
 *
 * @typedef {{ r: number, g: number, b: number, a: number }} Colour
 * @typedef {[number, number, number]} Vector
 */

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {number[]} */
function multiply(a, b){
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row++)
    {
        for (let column = 0; column < 4; column++)
        {
            for (let k = 0; k < 4; k++)
            {
                out[row * 4 + column] += a[row * 4 + k] * b[k * 4 + column];
            }
        }
    }
    return out;
}

/** @param {ArrayLike<number>} v a row vector @param {ArrayLike<number>} m @returns {number[]} */
function transform(v, m){
    return [0, 1, 2, 3].map(column=>
        v[0] * m[column] + v[1] * m[4 + column] + v[2] * m[8 + column] + v[3] * m[12 + column]);
}

/**
 * @param {ArrayLike<number>} m
 * @returns {number[] | null} the inverse, or null for a singular matrix
 */
function invert(m){
    const a = [0, 1, 2, 3].map(row=>[
        ...[0, 1, 2, 3].map(column=>m[row * 4 + column]),
        ...[0, 1, 2, 3].map(column=>(row === column ? 1 : 0)),
    ]);
    for (let column = 0; column < 4; column++)
    {
        let pivot = column;
        for (let row = column + 1; row < 4; row++)
        {
            if (Math.abs(a[row][column]) > Math.abs(a[pivot][column]))
            {
                pivot = row;
            }
        }
        if (Math.abs(a[pivot][column]) < 1e-12)
        {
            return null;
        }
        [a[column], a[pivot]] = [a[pivot], a[column]];
        const divisor = a[column][column];
        a[column] = a[column].map(value=>value / divisor);
        for (let row = 0; row < 4; row++)
        {
            if (row !== column)
            {
                const factor = a[row][column];
                a[row] = a[row].map((value, index)=>value - factor * a[column][index]);
            }
        }
    }
    return a.flatMap(row=>row.slice(4));
}

/** @param {Vector} a @param {Vector} b */
const dot = (a, b)=>a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** @param {Vector} v @returns {Vector} */
const unit = v=>{
    const length = Math.max(Math.sqrt(dot(v, v)), 1e-8);
    return [v[0] / length, v[1] / length, v[2] / length];
};

/** @param {number} value */
const clamp1 = value=>(value < 0 ? 0 : value > 1 ? 1 : value);

/** @param {number} argb @returns {Colour} */
const colourOf = argb=>({
    r: ((argb >>> 16) & 0xff) / 255,
    g: ((argb >>> 8) & 0xff) / 255,
    b: (argb & 0xff) / 255,
    a: ((argb >>> 24) & 0xff) / 255,
});

/** @param {Colour} colour @returns {number} */
const argbOf = colour=>((Math.round(clamp1(colour.a) * 255) << 24)
    | (Math.round(clamp1(colour.r) * 255) << 16)
    | (Math.round(clamp1(colour.g) * 255) << 8)
    | Math.round(clamp1(colour.b) * 255)) >>> 0;

/**
 * How much of one light reaches a point in camera space, and from where.
 *
 * @param {any} light  D3DLIGHT7, its position and direction already in camera space
 * @param {Vector} position
 * @returns {{ toLight: Vector, scale: number }}
 */
function reach(light, position){
    if (light.Type === D3DLIGHTTYPE.DIRECTIONAL)
    {
        const travels = unit(light.cameraDirection);
        return { toLight: [-travels[0], -travels[1], -travels[2]], scale: 1 };
    }
    const offset = /** @type {Vector} */ ([0, 1, 2].map(k=>light.cameraPosition[k] - position[k]));
    const distance = Math.sqrt(dot(offset, offset));
    const toLight = unit(offset);
    let scale = 0;
    if (distance <= light.Range)
    {
        const denominator = light.Attenuation0 + light.Attenuation1 * distance
            + light.Attenuation2 * distance * distance;
        scale = denominator <= 0 ? 1 : 1 / denominator;
    }
    if (light.Type !== D3DLIGHTTYPE.SPOT)
    {
        return { toLight, scale };
    }
    const rho = -dot(unit(light.cameraDirection), toLight);
    const inner = Math.cos(light.Theta / 2);
    const outer = Math.cos(light.Phi / 2);
    const cone = rho > inner
        ? 1
        : (rho <= outer ? 0 : Math.pow((rho - outer) / (inner - outer), light.Falloff));
    return { toLight, scale: scale * cone };
}

/**
 * @param {Object} request
 * @param {ProcessMemory} request.memory
 * @param {number} request.vertexOp   D3DVOP
 * @param {any} request.dest          The vertex buffer written: base, stride, fvf, numVertices.
 * @param {number} request.destIndex
 * @param {number} request.count
 * @param {VertexSource} request.source
 * @param {ProcessingState} request.state
 * @param {number} request.flags      D3DPV
 * @returns {number} HRESULT
 */
export function processVertices(request){
    const { memory, dest, source, state } = request;
    const destIndex = request.destIndex >>> 0;
    const count = request.count >>> 0;
    if ((request.vertexOp & D3DVOP.TRANSFORM) === 0 || destIndex + count > dest.numVertices)
    {
        return DDERR_INVALIDPARAMS;
    }
    const from = decodeFvf(source.fvf);
    const to = decodeFvf(dest.fvf);
    if (from.preTransformed)
    {
        return DDERR_INVALIDPARAMS;
    }
    const has = (/** @type {import('../webgpu/internal/vertexformat.js').VertexLayout} */ layout,
        /** @type {string} */ name)=>layout.attributes.find(attribute=>attribute.name === name);
    const copying = (request.flags & D3DPV_DONOTCOPYDATA) === 0;

    /** @param {number} address @param {number} floats */
    const readFloats = (address, floats)=>{
        const bytes = memory.readMemory(address, floats * 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: floats }, (_, k)=>view.getFloat32(k * 4, true));
    };
    /** @param {number} address */
    const readDword = address=>{
        const bytes = memory.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number[]} values */
    const writeFloats = (address, values)=>{
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((value, k)=>view.setFloat32(k * 4, value, true));
        memory.writeMemory(address, bytes);
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        memory.writeMemory(address, Uint8Array.of(value & 0xff, (value >>> 8) & 0xff,
            (value >>> 16) & 0xff, (value >>> 24) & 0xff));
    };

    const view = state.transform(D3DTS.VIEW);
    const projection = state.transform(D3DTS.PROJECTION);
    const blend = state.renderState(D3DRS.VERTEXBLEND);
    // The weights a vertex carries, up to as many as the state blends by; a
    // vertex without them is carried by the world matrix alone.
    const weights = blend >= 1 && blend <= 3 ? Math.min(blend, from.blendWeights) : 0;
    const worldViews = Array.from({ length: weights + 1 },
        (_, index)=>multiply(state.transform(D3DTS.WORLD + index), view));
    const normalMatrices = worldViews.map(matrix=>invert(matrix));

    const vp = state.viewport;
    const depthRange = vp.maxDepth > vp.minDepth ? vp.maxDepth - vp.minDepth : DEGENERATE_DEPTH;

    const lighting = (request.vertexOp & D3DVOP.LIGHT) !== 0
        && state.renderState(D3DRS.LIGHTING) !== 0;
    const lights = state.lights.map(light=>({
        ...light,
        cameraDirection: transform([light.Direction.x, light.Direction.y, light.Direction.z, 0],
            view).slice(0, 3),
        cameraPosition: transform([light.Position.x, light.Position.y, light.Position.z, 1],
            view).slice(0, 3),
    }));
    const specularOn = state.renderState(D3DRS.SPECULARENABLE) !== 0;
    const normalize = state.renderState(D3DRS.NORMALIZENORMALS) !== 0;
    const localViewer = state.renderState(D3DRS.LOCALVIEWER) !== 0;
    const colorVertex = state.renderState(D3DRS.COLORVERTEX) !== 0;
    const sceneAmbient = colourOf(state.renderState(D3DRS.AMBIENT));
    const material = state.material;

    let lastRhw = 0;
    for (let k = 0; k < count; k++)
    {
        /** @param {string} name */
        const at = name=>source.addressOf(name, k);
        const positionAt = /** @type {number} */ (at('position'));
        const position = [...readFloats(positionAt, 3), 1];
        const weightAt = at('blendWeight');
        const given = weights > 0 && weightAt !== null ? readFloats(weightAt, weights) : [];
        const shares = [...given, 1 - given.reduce((sum, weight)=>sum + weight, 0)];

        const camera = [0, 0, 0, 0];
        worldViews.forEach((matrix, index)=>{
            transform(position, matrix).forEach((value, axis)=>{
                camera[axis] += shares[index] * value;
            });
        });
        const clip = transform(camera, projection);
        const rhw = 1 / clip[3];
        lastRhw = rhw;
        const vertexAt = dest.base + (destIndex + k) * to.stride;
        const screen = [
            vp.x + (1 + clip[0] * rhw) * vp.width / 2,
            vp.y + (1 - clip[1] * rhw) * vp.height / 2,
            vp.minDepth + clip[2] * rhw * depthRange,
        ];
        writeFloats(vertexAt, to.preTransformed ? [...screen, rhw] : screen);

        const diffuseAt = at('diffuse');
        const specularAt = at('specular');
        const destDiffuse = has(to, 'diffuse');
        const destSpecular = has(to, 'specular');
        if (lighting)
        {
            const normalAt = at('normal');
            const normal = normalAt === null ? [0, 0, 0] : readFloats(normalAt, 3);
            /** @type {Vector} */
            let n = [0, 0, 0];
            normalMatrices.forEach((inverse, index)=>{
                if (inverse)
                {
                    // The inverse transpose, applied to a row vector: the
                    // inverse's rows are the transpose's columns.
                    const carried = [0, 1, 2].map(axis=>normal[0] * inverse[axis * 4]
                        + normal[1] * inverse[axis * 4 + 1] + normal[2] * inverse[axis * 4 + 2]);
                    n = [n[0] + shares[index] * carried[0], n[1] + shares[index] * carried[1],
                        n[2] + shares[index] * carried[2]];
                }
            });
            if (normalize)
            {
                n = unit(n);
            }
            const point = /** @type {Vector} */ (camera[3] !== 0 && camera[3] !== 1
                ? camera.slice(0, 3).map(value=>value / camera[3])
                : camera.slice(0, 3));
            /** @type {Vector} */
            const toEye = localViewer ? unit([-point[0], -point[1], -point[2]]) : [0, 0, -1];
            const ambient = [0, 0, 0];
            const diffuse = [0, 0, 0];
            const specular = [0, 0, 0];
            for (const light of lights)
            {
                const { toLight, scale } = reach(light, point);
                const lambert = Math.max(dot(n, toLight), 0) * scale;
                const halfway = unit([toLight[0] + toEye[0], toLight[1] + toEye[1],
                    toLight[2] + toEye[2]]);
                const highlight = specularOn
                    ? Math.pow(Math.max(dot(n, halfway), 0), material.Power) * scale
                    : 0;
                ['r', 'g', 'b'].forEach((channel, index)=>{
                    ambient[index] += light.Ambient[channel] * scale;
                    diffuse[index] += light.Diffuse[channel] * lambert;
                    specular[index] += light.Specular[channel] * highlight;
                });
            }
            /** @param {number} which D3DMCS @param {Colour} own @returns {Colour} */
            const sourceOf = (which, own)=>{
                if (colorVertex && which === D3DMCS.COLOR1 && diffuseAt !== null)
                {
                    return colourOf(readDword(diffuseAt));
                }
                if (colorVertex && which === D3DMCS.COLOR2 && specularAt !== null)
                {
                    return colourOf(readDword(specularAt));
                }
                return own;
            };
            const cd = sourceOf(state.renderState(D3DRS.DIFFUSEMATERIALSOURCE), material.Diffuse);
            const ca = sourceOf(state.renderState(D3DRS.AMBIENTMATERIALSOURCE), material.Ambient);
            const cs = sourceOf(state.renderState(D3DRS.SPECULARMATERIALSOURCE),
                material.Specular);
            const ce = sourceOf(state.renderState(D3DRS.EMISSIVEMATERIALSOURCE),
                material.Emissive);
            const channels = /** @type {const} */ (['r', 'g', 'b']);
            if (destDiffuse)
            {
                const lit = channels.map((channel, index)=>ce[channel]
                    + ca[channel] * (sceneAmbient[channel] + ambient[index])
                    + cd[channel] * diffuse[index]);
                writeDword(vertexAt + destDiffuse.offset,
                    argbOf({ r: lit[0], g: lit[1], b: lit[2], a: cd.a }));
            }
            if (destSpecular)
            {
                const high = channels.map((channel, index)=>cs[channel] * specular[index]);
                writeDword(vertexAt + destSpecular.offset,
                    specularOn ? argbOf({ r: high[0], g: high[1], b: high[2], a: 0 }) : 0);
            }
        }
        else if (copying)
        {
            if (destDiffuse)
            {
                writeDword(vertexAt + destDiffuse.offset,
                    diffuseAt === null ? 0xffffffff : readDword(diffuseAt));
            }
            if (destSpecular)
            {
                writeDword(vertexAt + destSpecular.offset,
                    specularAt === null ? 0 : readDword(specularAt));
            }
        }

        if (copying)
        {
            const destNormal = has(to, 'normal');
            const normalAt = at('normal');
            if (destNormal && normalAt !== null)
            {
                writeFloats(vertexAt + destNormal.offset, readFloats(normalAt, 3));
            }
            for (let set = 0; set < to.texCoordSets; set++)
            {
                const target = /** @type {any} */ (has(to, `texCoord${set}`));
                const origin = has(from, `texCoord${set}`);
                const coordinateAt = at(`texCoord${set}`);
                if (origin && coordinateAt !== null)
                {
                    const floats = Math.min(floatsOf(target.format), floatsOf(origin.format));
                    writeFloats(vertexAt + target.offset, readFloats(coordinateAt, floats));
                }
            }
        }
    }

    // A position with no reciprocal w of its own still has one written after
    // it, where the next vertex begins (Wine's ddraw7 test_process_vertices);
    // every vertex but the last has that overwritten by its successor.
    if (!to.preTransformed && count > 0 && destIndex + count < dest.numVertices)
    {
        writeFloats(dest.base + (destIndex + count) * to.stride, [lastRhw]);
    }
    return D3D_OK;
}

/** @param {string} format a WebGPU float vertex format */
function floatsOf(format){
    return format === 'float32' ? 1 : Number(format.slice(-1));
}
