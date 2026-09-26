/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The numbers an effect variable holds, read and written as a program's
 * typed calls see them.
 *
 * A variable keeps its values as its own type -- float, int, uint or bool --
 * in its constant buffer's layout, and every typed call converts. The
 * conversions are the effect framework's, not C's (Wine's d3d10
 * test_effect_scalar_variable and its vector and matrix siblings): TRUE
 * given to a number is -1, and a number read as a bool is -1 when it is not
 * zero; only a bool read as a bool keeps the value it was given, and only a
 * bool given to a bool is stored as given. Matrices are copied as they are,
 * a dword at a time, into rows or columns as the variable is laid out.
 */

import { D3D10_SVC, D3D10_SVT } from './effect.js';

/** @typedef {'float' | 'int' | 'bool'} Given */

const scratch = new DataView(new ArrayBuffer(4));

/** @param {number} value */
const floatBits = value=>{
    scratch.setFloat32(0, value, true);
    return scratch.getUint32(0, true);
};

/** @param {number} bits */
const bitsFloat = bits=>{
    scratch.setUint32(0, bits >>> 0, true);
    return scratch.getFloat32(0, true);
};

/**
 * A value a program gives, as the dword a variable of this type keeps.
 *
 * @param {number} value
 * @param {Given} given
 * @param {number} svt  The variable's D3D10_SHADER_VARIABLE_TYPE.
 */
export function toStored(value, given, svt){
    if (svt === D3D10_SVT.BOOL)
    {
        return given === 'bool' ? value >>> 0 : (value !== 0 ? 0xffffffff : 0);
    }
    if (given === 'bool')
    {
        if (value === 0)
        {
            return 0;
        }
        return svt === D3D10_SVT.FLOAT ? floatBits(-1) : 0xffffffff;
    }
    if (svt === D3D10_SVT.FLOAT)
    {
        return floatBits(value);
    }
    return (given === 'float' ? Math.trunc(value) : value) >>> 0;
}

/**
 * A dword a variable of this type keeps, as the value a program asks for.
 *
 * @param {number} bits
 * @param {number} svt
 * @param {Given} wanted
 */
export function fromStored(bits, svt, wanted){
    if (svt === D3D10_SVT.BOOL)
    {
        if (wanted === 'bool')
        {
            return bits | 0;
        }
        const truth = bits !== 0 ? -1 : 0;
        return truth;
    }
    // A uint converts as the int of its bits: TRUE stored in one reads as
    // -1.0, as it does from an int.
    const value = svt === D3D10_SVT.FLOAT ? bitsFloat(bits) : bits | 0;
    if (wanted === 'bool')
    {
        return value !== 0 ? -1 : 0;
    }
    if (wanted === 'int')
    {
        return Math.trunc(value) | 0;
    }
    return Math.fround(value);
}

/**
 * @typedef {Object} NumericPlace
 * @property {Uint8Array} bytes  The constant buffer's, or an annotation's own.
 * @property {number} at         Where the variable, or this element, starts.
 * @property {import('./effect.js').FxType} type
 */

/**
 * Where component `component` of register `register` of element `element`
 * sits, or -1 past the bytes.
 *
 * @param {NumericPlace} place
 * @param {number} element @param {number} register @param {number} component
 */
function addressOf(place, element, register, component){
    const at = place.at + element * place.type.stride + register * 16 + component * 4;
    return at + 4 <= place.bytes.length ? at : -1;
}

/** @param {NumericPlace} place */
const viewOf = place=>new DataView(place.bytes.buffer, place.bytes.byteOffset,
    place.bytes.byteLength);

/**
 * Writes scalars or vectors: `count` elements from `first`, each as many
 * components as the type has columns, from `values` in order. What would
 * fall past the buffer is dropped.
 *
 * @param {NumericPlace} place
 * @param {number[]} values
 * @param {Given} given
 * @param {number} first
 * @param {number} count
 */
export function setComponents(place, values, given, first, count){
    const view = viewOf(place);
    const columns = place.type.svc === D3D10_SVC.SCALAR ? 1 : place.type.columns;
    for (let element = 0; element < count; element++)
    {
        for (let column = 0; column < columns; column++)
        {
            const value = values[element * columns + column];
            const at = addressOf(place, first + element, 0, column);
            if (value !== undefined && at >= 0)
            {
                view.setUint32(at, toStored(value, given, place.type.svt), true);
            }
        }
    }
}

/**
 * @param {NumericPlace} place
 * @param {Given} wanted
 * @param {number} first
 * @param {number} count
 * @returns {number[]}
 */
export function getComponents(place, wanted, first, count){
    const view = viewOf(place);
    const columns = place.type.svc === D3D10_SVC.SCALAR ? 1 : place.type.columns;
    /** @type {number[]} */
    const values = [];
    for (let element = 0; element < count; element++)
    {
        for (let column = 0; column < columns; column++)
        {
            const at = addressOf(place, first + element, 0, column);
            values.push(fromStored(at >= 0 ? view.getUint32(at, true) : 0, place.type.svt,
                wanted));
        }
    }
    return values;
}

/**
 * The register and component entry [row][column] of a matrix sits at.
 *
 * @param {import('./effect.js').FxType} type
 * @param {number} row @param {number} column
 */
const matrixSlot = (type, row, column)=>(type.svc === D3D10_SVC.MATRIX_COLUMNS
    ? [column, row]
    : [row, column]);

/**
 * Writes matrices given as four-by-four arrays of dwords (a program's
 * float[4][4], entry [row][column] at row * 4 + column), `transposed` taking
 * entry [row][column] from [column][row].
 *
 * @param {NumericPlace} place
 * @param {number[]} dwords  Sixteen per matrix.
 * @param {number} first
 * @param {number} count
 * @param {boolean} transposed
 */
export function setMatrices(place, dwords, first, count, transposed){
    const view = viewOf(place);
    for (let element = 0; element < count; element++)
    {
        for (let row = 0; row < place.type.rows; row++)
        {
            for (let column = 0; column < place.type.columns; column++)
            {
                const from = element * 16 + (transposed ? column * 4 + row : row * 4 + column);
                const [register, component] = matrixSlot(place.type, row, column);
                const at = addressOf(place, first + element, register, component);
                if (at >= 0 && dwords[from] !== undefined)
                {
                    view.setUint32(at, dwords[from] >>> 0, true);
                }
            }
        }
    }
}

/**
 * @param {NumericPlace} place
 * @param {number} first
 * @param {number} count
 * @param {boolean} transposed
 * @returns {(number | undefined)[]}  Sixteen per matrix; entries the matrix has none
 *     for, undefined.
 */
export function getMatrices(place, first, count, transposed){
    const view = viewOf(place);
    /** @type {(number | undefined)[]} */
    const dwords = new Array(count * 16).fill(undefined);
    for (let element = 0; element < count; element++)
    {
        for (let row = 0; row < place.type.rows; row++)
        {
            for (let column = 0; column < place.type.columns; column++)
            {
                const to = element * 16 + (transposed ? column * 4 + row : row * 4 + column);
                const [register, component] = matrixSlot(place.type, row, column);
                const at = addressOf(place, first + element, register, component);
                dwords[to] = at >= 0 ? view.getUint32(at, true) : 0;
            }
        }
    }
    return dwords;
}
