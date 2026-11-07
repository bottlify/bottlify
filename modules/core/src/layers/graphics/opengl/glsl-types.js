/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL's types, 1.10 to 4.60 (section 4.1), as values the checker and the
 * WGSL emitter share. A basic type is one object for the whole run, so two
 * are the same type when they are the same object; a struct is the same type
 * only as itself, as the specification has it (two structs with the same
 * members and different names are different types); an array is the same
 * type as another of the same element and length.
 *
 * Matrices are named by columns then rows, `mat2x3` two columns of three, in
 * GLSL and in WGSL alike, so the names cross unchanged.
 *
 * Each type name has the version that brought it (`typeSince`): before it the
 * name is an identifier like any other, which a 1.20 shader may use.
 */

/**
 * @typedef {'float' | 'int' | 'uint' | 'bool' | 'double'} ScalarBase
 * @typedef {'1D' | '2D' | '3D' | 'Cube' | '2DRect' | 'Buffer'} Dim
 * @typedef {{ kind: 'void' }} VoidType
 * @typedef {{ kind: 'scalar', base: ScalarBase }} ScalarType
 * @typedef {{ kind: 'vector', base: ScalarBase, size: number }} VectorType
 * @typedef {{ kind: 'matrix', cols: number, rows: number, base: 'float' | 'double' }} MatrixType
 * @typedef {{ kind: 'sampler', dim: Dim, shadow: boolean, array: boolean, ms: boolean,
 *     sampled: 'float' | 'int' | 'uint' }} SamplerType
 *     `sampled` the components a lookup returns; `ms` a multisampled one
 * @typedef {{ kind: 'image', dim: Dim, array: boolean, ms: boolean,
 *     sampled: 'float' | 'int' | 'uint' }} ImageType
 * @typedef {{ kind: 'atomic' }} AtomicType  atomic_uint
 * @typedef {{ kind: 'struct', name: string, fields: { name: string, type: GlslType }[],
 *     id: number }} StructType
 * @typedef {{ kind: 'array', element: GlslType, length: number }} ArrayType
 *     a `length` of 0 is a run-time sized array: a buffer block's last member
 * @typedef {VoidType | ScalarType | VectorType | MatrixType | SamplerType | ImageType
 *     | AtomicType | StructType | ArrayType} GlslType
 */

/** @type {Map<string, GlslType>} */
const NAMED = new Map();
/** The version each type name came with. @type {Map<string, number>} */
const SINCE = new Map();

/** @param {string} name @param {GlslType} type @param {number} [since] */
const define = (name, type, since = 110)=>{
    NAMED.set(name, Object.freeze(type));
    SINCE.set(name, since);
    return /** @type {any} */ (NAMED.get(name));
};

/** The prefix a vector's, matrix's or opaque type's name takes for its base. */
const PREFIX = /** @type {Record<ScalarBase, string>} */ ({ float: '', int: 'i', uint: 'u',
    bool: 'b', double: 'd' });

export const VOID = /** @type {VoidType} */ (define('void', { kind: 'void' }));
export const FLOAT = /** @type {ScalarType} */ (define('float', { kind: 'scalar', base: 'float' }));
export const INT = /** @type {ScalarType} */ (define('int', { kind: 'scalar', base: 'int' }));
export const BOOL = /** @type {ScalarType} */ (define('bool', { kind: 'scalar', base: 'bool' }));
export const UINT = /** @type {ScalarType} */ (define('uint', { kind: 'scalar', base: 'uint' },
    130));
export const DOUBLE = /** @type {ScalarType} */ (define('double',
    { kind: 'scalar', base: 'double' }, 400));
for (const size of [2, 3, 4])
{
    define(`vec${size}`, { kind: 'vector', base: 'float', size });
    define(`ivec${size}`, { kind: 'vector', base: 'int', size });
    define(`bvec${size}`, { kind: 'vector', base: 'bool', size });
    define(`uvec${size}`, { kind: 'vector', base: 'uint', size }, 130);
    define(`dvec${size}`, { kind: 'vector', base: 'double', size }, 400);
    for (const rows of [2, 3, 4])
    {
        // 1.20 named the non-square matrices; a 1.10 shader has them too, as
        // the drivers the programs were written against give them (and as
        // this front end always did).
        define(`mat${size}x${rows}`, { kind: 'matrix', cols: size, rows, base: 'float' });
        define(`dmat${size}x${rows}`, { kind: 'matrix', cols: size, rows, base: 'double' }, 400);
    }
    NAMED.set(`mat${size}`, /** @type {GlslType} */ (NAMED.get(`mat${size}x${size}`)));
    SINCE.set(`mat${size}`, 110);
    NAMED.set(`dmat${size}`, /** @type {GlslType} */ (NAMED.get(`dmat${size}x${size}`)));
    SINCE.set(`dmat${size}`, 400);
}

/**
 * The samplers and images of each shape: the suffix, the dimension, whether
 * it is an array and multisampled, and the version the float sampler came
 * with. The integer samplers came with 1.30 whatever the shape's age, and
 * every image with 4.20.
 *
 * @type {[string, Dim, boolean, boolean, number][]}
 */
const OPAQUE_SHAPES = [
    ['1D', '1D', false, false, 110], ['2D', '2D', false, false, 110],
    ['3D', '3D', false, false, 110], ['Cube', 'Cube', false, false, 110],
    ['1DArray', '1D', true, false, 130], ['2DArray', '2D', true, false, 130],
    ['2DRect', '2DRect', false, false, 140], ['Buffer', 'Buffer', false, false, 140],
    ['2DMS', '2D', false, true, 150], ['2DMSArray', '2D', true, true, 150],
    ['CubeArray', 'Cube', true, false, 400],
];
for (const [suffix, dim, array, ms, since] of OPAQUE_SHAPES)
{
    for (const sampled of /** @type {const} */ (['float', 'int', 'uint']))
    {
        const prefix = PREFIX[sampled];
        define(`${prefix}sampler${suffix}`, { kind: 'sampler', dim, shadow: false, array, ms,
            sampled }, sampled === 'float' ? since : Math.max(since, 130));
        define(`${prefix}image${suffix}`, { kind: 'image', dim, array, ms, sampled }, 420);
    }
}
/** @type {[string, Dim, boolean, number][]} */
const SHADOWS = [['1DShadow', '1D', false, 110], ['2DShadow', '2D', false, 110],
    ['1DArrayShadow', '1D', true, 130], ['2DArrayShadow', '2D', true, 130],
    ['CubeShadow', 'Cube', false, 130], ['2DRectShadow', '2DRect', false, 140],
    ['CubeArrayShadow', 'Cube', true, 400]];
for (const [suffix, dim, array, since] of SHADOWS)
{
    define(`sampler${suffix}`, { kind: 'sampler', dim, shadow: true, array, ms: false,
        sampled: 'float' }, since);
}
export const ATOMIC_UINT = /** @type {AtomicType} */ (define('atomic_uint', { kind: 'atomic' },
    420));

/** The type a basic type's name names, or undefined. @param {string} name */
export const basicType = name=>NAMED.get(name);

/**
 * The type a name names in a shader of `version`, or undefined: a type that
 * came later is no type there, and its name an identifier.
 *
 * @param {string} name @param {number} version
 */
export const basicTypeAt = (name, version)=>((SINCE.get(name) ?? Infinity) <= version
    ? NAMED.get(name) : undefined);

/** The version a type name came with, or undefined. @param {string} name */
export const typeSince = name=>SINCE.get(name);

/** Every type name, for the parser's keyword sets. */
export const typeNames = ()=>[...NAMED.keys()];

/**
 * A vector of `size` components of `base`, or the scalar when `size` is 1.
 *
 * @param {ScalarBase} base @param {number} size
 * @returns {ScalarType | VectorType}
 */
export function vectorOf(base, size){
    if (size === 1)
    {
        return /** @type {ScalarType} */ (NAMED.get(base));
    }
    return /** @type {VectorType} */ (NAMED.get(`${PREFIX[base]}vec${size}`));
}

/**
 * @param {number} cols @param {number} rows @param {'float' | 'double'} [base]
 * @returns {MatrixType}
 */
export const matrixOf = (cols, rows, base = 'float')=>/** @type {MatrixType} */ (
    NAMED.get(`${base === 'double' ? 'd' : ''}mat${cols}x${rows}`));

/** @type {WeakMap<GlslType, Map<number, ArrayType>>} */
const ARRAYS = new WeakMap();

/**
 * The array of `length` elements of `element`, one object per pair; a length
 * of 0 is a run-time sized one.
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
 * @returns {ScalarBase | null}
 */
export function baseOf(type){
    if (type.kind === 'scalar' || type.kind === 'vector' || type.kind === 'matrix')
    {
        return type.base;
    }
    return null;
}

/**
 * The vertex attribute locations a column of a type takes (4.1 section
 * 11.1.1): a dvec3's and a dvec4's two, every other column one.
 *
 * @param {GlslType} type @returns {number}
 */
export function columnSlots(type){
    if (!('base' in type) || type.base !== 'double')
    {
        return 1;
    }
    const rows = type.kind === 'matrix' ? type.rows : type.kind === 'vector' ? type.size : 1;
    return rows > 2 ? 2 : 1;
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
 * Whether a type is or holds an opaque type -- a sampler, an image or an
 * atomic counter -- which only a uniform, a parameter or a call may take.
 *
 * @param {GlslType} type
 * @returns {boolean}
 */
export function holdsOpaque(type){
    if (type.kind === 'sampler' || type.kind === 'image' || type.kind === 'atomic')
    {
        return true;
    }
    if (type.kind === 'array')
    {
        return holdsOpaque(type.element);
    }
    return type.kind === 'struct' && type.fields.some(field=>holdsOpaque(field.type));
}

/**
 * The innermost element of an array, of arrays of arrays too; the type itself
 * for anything else.
 *
 * @param {GlslType} type
 * @returns {GlslType}
 */
export function innermost(type){
    return type.kind === 'array' ? innermost(type.element) : type;
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
            return `${PREFIX[type.base]}vec${type.size}`;
        case 'matrix': {
            const d = type.base === 'double' ? 'd' : '';
            return type.cols === type.rows ? `${d}mat${type.cols}`
                : `${d}mat${type.cols}x${type.rows}`;
        }
        case 'sampler':
        case 'image':
            return `${PREFIX[type.sampled]}${type.kind}${type.dim}${type.ms ? 'MS' : ''}`
                + `${type.array ? 'Array' : ''}`
                + `${type.kind === 'sampler' && type.shadow ? 'Shadow' : ''}`;
        case 'atomic':
            return 'atomic_uint';
        case 'struct':
            return type.name;
        default:
            return `${glslName(type.element)}[${type.length || ''}]`;
    }
}

/**
 * The WGSL type a value of this type is, given the name each struct is
 * declared under there. A double has none: how one is carried is the
 * emitter's to decide.
 *
 * @param {GlslType} type
 * @param {(struct: StructType) => string} structName
 * @returns {string}
 */
export function wgslName(type, structName){
    switch (type.kind)
    {
        case 'scalar':
        case 'vector':
        case 'matrix':
            if (type.base === 'double')
            {
                throw new Error(`glsl: a ${glslName(type)} has no WGSL value type`);
            }
            if (type.kind === 'matrix')
            {
                return `mat${type.cols}x${type.rows}f`;
            }
            if (type.kind === 'scalar')
            {
                return type.base === 'float' ? 'f32' : type.base === 'int' ? 'i32'
                    : type.base === 'uint' ? 'u32' : 'bool';
            }
            return type.base === 'bool' ? `vec${type.size}<bool>`
                : `vec${type.size}${type.base === 'float' ? 'f' : type.base === 'int' ? 'i' : 'u'}`;
        case 'struct':
            return structName(type);
        case 'array':
            return `array<${wgslName(type.element, structName)}, ${type.length}>`;
        default:
            throw new Error(`glsl: a ${glslName(type)} has no WGSL value type`);
    }
}
