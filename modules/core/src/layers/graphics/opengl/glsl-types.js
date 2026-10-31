/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL 1.20's types (section 4.1), as values the checker and the WGSL
 * emitter share. A basic type is one object for the whole run, so two are the
 * same type when they are the same object; a struct is the same type only as
 * itself, as the specification has it (two structs with the same members and
 * different names are different types); an array is the same type as another
 * of the same element and length.
 *
 * Matrices are named by columns then rows, `mat2x3` two columns of three, in
 * GLSL and in WGSL alike, so the names cross unchanged.
 */

/**
 * @typedef {{ kind: 'void' }} VoidType
 * @typedef {{ kind: 'scalar', base: 'float' | 'int' | 'bool' }} ScalarType
 * @typedef {{ kind: 'vector', base: 'float' | 'int' | 'bool', size: number }} VectorType
 * @typedef {{ kind: 'matrix', cols: number, rows: number }} MatrixType
 * @typedef {{ kind: 'sampler', dim: '1D' | '2D' | '3D' | 'Cube', shadow: boolean }} SamplerType
 * @typedef {{ kind: 'struct', name: string, fields: { name: string, type: GlslType }[],
 *     id: number }} StructType
 * @typedef {{ kind: 'array', element: GlslType, length: number }} ArrayType
 * @typedef {VoidType | ScalarType | VectorType | MatrixType | SamplerType | StructType
 *     | ArrayType} GlslType
 */

/** @type {Map<string, GlslType>} */
const NAMED = new Map();

/** @param {string} name @param {GlslType} type */
const define = (name, type)=>{
    NAMED.set(name, Object.freeze(type));
    return /** @type {any} */ (NAMED.get(name));
};

export const VOID = /** @type {VoidType} */ (define('void', { kind: 'void' }));
export const FLOAT = /** @type {ScalarType} */ (define('float', { kind: 'scalar', base: 'float' }));
export const INT = /** @type {ScalarType} */ (define('int', { kind: 'scalar', base: 'int' }));
export const BOOL = /** @type {ScalarType} */ (define('bool', { kind: 'scalar', base: 'bool' }));
for (const size of [2, 3, 4])
{
    define(`vec${size}`, { kind: 'vector', base: 'float', size });
    define(`ivec${size}`, { kind: 'vector', base: 'int', size });
    define(`bvec${size}`, { kind: 'vector', base: 'bool', size });
    for (const rows of [2, 3, 4])
    {
        define(`mat${size}x${rows}`, { kind: 'matrix', cols: size, rows });
    }
    NAMED.set(`mat${size}`, /** @type {GlslType} */ (NAMED.get(`mat${size}x${size}`)));
}
for (const dim of /** @type {const} */ (['1D', '2D', '3D', 'Cube']))
{
    define(`sampler${dim}`, { kind: 'sampler', dim, shadow: false });
}
define('sampler1DShadow', { kind: 'sampler', dim: '1D', shadow: true });
define('sampler2DShadow', { kind: 'sampler', dim: '2D', shadow: true });

/** The type a basic type's name names, or undefined. @param {string} name */
export const basicType = name=>NAMED.get(name);

/**
 * A vector of `size` components of `base`, or the scalar when `size` is 1.
 *
 * @param {'float' | 'int' | 'bool'} base @param {number} size
 * @returns {ScalarType | VectorType}
 */
export function vectorOf(base, size){
    if (size === 1)
    {
        return base === 'float' ? FLOAT : base === 'int' ? INT : BOOL;
    }
    const prefix = base === 'float' ? '' : base === 'int' ? 'i' : 'b';
    return /** @type {VectorType} */ (NAMED.get(`${prefix}vec${size}`));
}

/** @param {number} cols @param {number} rows @returns {MatrixType} */
export const matrixOf = (cols, rows)=>/** @type {MatrixType} */ (NAMED.get(`mat${cols}x${rows}`));

/** @type {WeakMap<GlslType, Map<number, ArrayType>>} */
const ARRAYS = new WeakMap();

/**
 * The array of `length` elements of `element`, one object per pair.
 *
 * @param {GlslType} element @param {number} length
 * @returns {ArrayType}
 */
export function arrayOf(element, length){
    let byLength = ARRAYS.get(element);
    if (!byLength)
    {
        byLength = new Map();
        ARRAYS.set(element, byLength);
    }
    let made = byLength.get(length);
    if (!made)
    {
        made = Object.freeze({ kind: 'array', element, length });
        byLength.set(length, made);
    }
    return made;
}

/** @param {GlslType} type */
export const isScalar = type=>type.kind === 'scalar';
/** @param {GlslType} type */
export const isNumeric = type=>(type.kind === 'scalar' || type.kind === 'vector')
    && type.base !== 'bool' || type.kind === 'matrix';

/**
 * The scalar a scalar, vector or matrix is made of, or null.
 *
 * @param {GlslType} type
 * @returns {'float' | 'int' | 'bool' | null}
 */
export function baseOf(type){
    if (type.kind === 'scalar' || type.kind === 'vector')
    {
        return type.base;
    }
    return type.kind === 'matrix' ? 'float' : null;
}

/**
 * How many scalars a scalar, vector or matrix holds; zero for anything else.
 *
 * @param {GlslType} type
 */
export function componentsOf(type){
    switch (type.kind)
    {
        case 'scalar':
            return 1;
        case 'vector':
            return type.size;
        case 'matrix':
            return type.cols * type.rows;
        default:
            return 0;
    }
}

/**
 * Whether a type is or holds a sampler, which no expression but a
 * function argument or a sampling call may take.
 *
 * @param {GlslType} type
 * @returns {boolean}
 */
export function holdsSampler(type){
    if (type.kind === 'sampler')
    {
        return true;
    }
    if (type.kind === 'array')
    {
        return holdsSampler(type.element);
    }
    return type.kind === 'struct' && type.fields.some(field=>holdsSampler(field.type));
}

/**
 * The GLSL spelling of a type, for an info log.
 *
 * @param {GlslType} type
 * @returns {string}
 */
export function glslName(type){
    switch (type.kind)
    {
        case 'void':
            return 'void';
        case 'scalar':
            return type.base;
        case 'vector':
            return `${type.base === 'float' ? '' : type.base[0]}vec${type.size}`;
        case 'matrix':
            return type.cols === type.rows ? `mat${type.cols}` : `mat${type.cols}x${type.rows}`;
        case 'sampler':
            return `sampler${type.dim}${type.shadow ? 'Shadow' : ''}`;
        case 'struct':
            return type.name;
        default:
            return `${glslName(type.element)}[${type.length}]`;
    }
}

/**
 * The WGSL type a value of this type is, given the name each struct is
 * declared under there.
 *
 * @param {GlslType} type
 * @param {(struct: StructType) => string} structName
 * @returns {string}
 */
export function wgslName(type, structName){
    switch (type.kind)
    {
        case 'scalar':
            return type.base === 'float' ? 'f32' : type.base === 'int' ? 'i32' : 'bool';
        case 'vector':
            return type.base === 'float' ? `vec${type.size}f`
                : type.base === 'int' ? `vec${type.size}i` : `vec${type.size}<bool>`;
        case 'matrix':
            return `mat${type.cols}x${type.rows}f`;
        case 'struct':
            return structName(type);
        case 'array':
            return `array<${wgslName(type.element, structName)}, ${type.length}>`;
        default:
            throw new Error(`glsl: a ${glslName(type)} has no WGSL value type`);
    }
}
