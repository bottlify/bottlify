/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLSL semantic rules, 1.10 to 4.60 (sections 4 to 6 of the language
 * specification), over the parser's tree: every name resolved to what it
 * declares, every expression given its type, every implicit conversion made
 * a node of its own, constants folded where the language says an expression
 * is constant, and a compile error for what the specification makes one.
 *
 * What a compiled shader hands the linker -- its unit -- is its global
 * variables by name, its functions with what each one calls and which
 * global and built-in variables it touches, the structs it declared, and
 * from 1.40 its interface blocks and the layouts its stage declared. The
 * linker decides from that what a program actually uses, which is what its
 * active attributes and uniforms are.
 *
 * Three of the language's rules are the reason most of this file exists:
 *
 * - **Implicit conversions are few, and grew** (section 4.1.10): 1.10 and
 *   1.20 make an int a float and nothing else; 1.30 a uint a float too; 4.00
 *   an int a uint, and anything numeric a double. A conversion is a node of
 *   its own, in an operand, an argument, an initializer, an assignment, a
 *   return.
 * - **Overloads are chosen exactly first**: a call matching one signature
 *   exactly takes it. Before 4.00, two matches by conversion are an
 *   ambiguity; from 4.00 the best one is taken (section 6.1), float to
 *   double being better than any other conversion and an integer to float
 *   better than an integer to double.
 * - **A version has what it has**: a type, a keyword, a built-in or a rule
 *   that came later is not there, and a 1.50 core shader has none of the
 *   compatibility profile's state and functions (`glsl-versions.js`).
 *
 * The first error stops the check, as the first syntax error stops the
 * parse.
 */

import {
    BOOL, DOUBLE, FLOAT, INT, UINT, VOID, arrayOf, baseOf, componentsOf, glslName,
    holdsOpaque, holdsSampler, innermost, matrixOf, vectorOf,
} from './glsl-types.js';
import { BUILTIN_FUNCTIONS, BUILTIN_VARIABLES } from './glsl-builtins.js';
import {
    GLSL_CONSTANTS, builtinVariablesFor, extensionOverloads, modernOverloads, perVertexOf,
} from './glsl-library.js';
import { blockLayout } from './glsl-layout.js';
import { hasStage, languageOf } from './glsl-versions.js';

/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-types.js').StructType} StructType
 * @typedef {import('./glsl-types.js').ScalarBase} ScalarBase
 * @typedef {import('./glsl-preprocess.js').Token} Token
 * @typedef {import('./glsl-versions.js').Language} Language
 * @typedef {import('./glsl-versions.js').Stage} Stage
 * @typedef {import('./glsl-parse.js').Qualifiers} ParsedQualifiers
 */

/**
 * A declaration's layout, its qualifiers' values by their lower-case names
 * (section 4.4): `location`, `binding`, `offset`, `std140`, `triangles`, an
 * image format... A qualifier without a value is true.
 *
 * @typedef {Record<string, number | boolean>} Layout
 */

/**
 * The qualifiers a variable carries past its storage.
 *
 * @typedef {Object} VariableQualifiers
 * @property {'flat' | 'smooth' | 'noperspective' | null} interpolation
 * @property {boolean} centroid
 * @property {boolean} sample
 * @property {boolean} patch
 * @property {boolean} precise
 * @property {Set<string>} memory  coherent, volatile, restrict, readonly, writeonly
 * @property {Layout} layout
 */

/**
 * A declared variable.
 *
 * @typedef {Object} VariableSymbol
 * @property {'variable'} kind
 * @property {string} name
 * @property {GlslType} type
 * @property {'uniform' | 'attribute' | 'varying' | 'in' | 'out' | 'buffer' | 'shared'
 *     | 'global' | 'const' | 'local' | 'param' | 'builtin'} storage
 * @property {number} id  unique in its unit, for the names the emitter gives locals
 * @property {boolean} global
 * @property {Token} at
 * @property {'in' | 'out' | 'inout'} [direction]  a parameter's
 * @property {boolean} [readonly]  a const or `in`-less parameter written through
 * @property {number[] | null} [constant]  a constant's folded value
 * @property {import('./glsl-builtins.js').BuiltinVariable} [builtin]
 * @property {boolean} [invariant]
 * @property {boolean} [written]  assigned somewhere, or passed as `out`
 * @property {any} [initializer]  a global's checked initializer
 * @property {VariableQualifiers} [qualifiers]  from 1.30
 * @property {InterfaceBlock} [block]  the block it is a member of, or the block an
 *     instance name names
 * @property {string} [subroutine]  a subroutine uniform's subroutine type
 */

/**
 * A user function's one signature.
 *
 * @typedef {Object} UserFunction
 * @property {'user'} kind
 * @property {string} name
 * @property {string} key  name and parameter types: what a prototype and its
 *     definition, in any shader of the stage, have in common
 * @property {{ name: string | null, type: GlslType, direction: 'in' | 'out' | 'inout',
 *     symbol: VariableSymbol | null }[]} params
 * @property {GlslType} returns
 * @property {any} body  the checked block, or null for a prototype
 * @property {Set<string>} calls  the keys of the user functions it calls
 * @property {Set<VariableSymbol>} uses  the global and built-in variables it names
 * @property {Token} at
 * @property {string[]} [subroutines]  the subroutine types it may be called as
 * @property {number} [subroutineIndex]  its `layout(index)`, where it has one (4.30)
 * @property {Set<number>} [streams]  the vertex streams past 0 it emits to (4.00)
 */

/**
 * An interface block (section 4.3.9): a uniform or buffer block, or a
 * block of a stage's inputs or outputs.
 *
 * @typedef {Object} InterfaceBlock
 * @property {string} name  the block's name, what the program queries
 * @property {string | null} instance  the instance name, or null when the
 *     members are globals of their own
 * @property {'uniform' | 'buffer' | 'in' | 'out'} storage
 * @property {StructType} type  the members, as a struct of the block's name
 * @property {number[]} arrays  the instance's array dimensions, outermost first; 0 unsized
 * @property {Layout} layout  the block's own, the stage's defaults applied:
 *     `std140`, `std430`, `shared` or `packed`; `row_major` or `column_major`; `binding`
 * @property {{ name: string, type: GlslType, layout: Layout,
 *     qualifiers: VariableQualifiers }[]} members
 *     each member's own layout, the block's matrix order applied
 * @property {boolean} perVertex  a redeclaration of gl_PerVertex
 * @property {ReturnType<typeof blockLayout> | null} laid  where each member lies in
 *     a std140 or std430 block (`glsl-layout.js`); null for shared and packed,
 *     whose places the implementation chooses at link
 * @property {Token} at
 */

/**
 * @typedef {Object} ShaderUnit
 * @property {Stage} stage
 * @property {number} version
 * @property {'core' | 'compatibility' | null} profile
 * @property {Language} language
 * @property {Map<string, VariableSymbol>} globals  user globals, by name
 * @property {Map<string, VariableSymbol>} builtins  built-in variables it names
 * @property {UserFunction[]} functions  definitions and prototypes
 * @property {StructType[]} structs  every struct it declared, in order
 * @property {Set<VariableSymbol>} initUses  what the global initializers name
 * @property {Set<string>} initCalls  what the global initializers call
 * @property {InterfaceBlock[]} blocks
 * @property {{ input: Layout, output: Layout, uniform?: Layout, buffer?: Layout }} layouts
 *     what `layout(...) in;` and `layout(...) out;` declared for the stage (the
 *     primitives, invocations, vertices, tessellation mode, local size,
 *     fragment tests), and the defaults `layout(...) uniform;` and
 *     `layout(...) buffer;` set for later blocks
 * @property {Map<string, UserFunction>} subroutineTypes
 */

/** A compile error, with the token it was found at. */
export class GlslCompileError extends Error {
    /** @param {Token} at @param {string} message */
    constructor(at, message){
        super(message);
        this.name = 'GlslCompileError';
        this.at = at;
    }
}

/** @param {Token} at @param {string} message @returns {never} */
const fail = (at, message)=>{
    throw new GlslCompileError(at, message);
};

/** The swizzle sets, each spelling the same four components. */
const SWIZZLE_SETS = ['xyzw', 'rgba', 'stpq'];

/** @param {GlslType} a @param {GlslType} b */
export const sameType = (a, b)=>a === b;

/**
 * How good a conversion of one scalar base to another is, as section 6.1
 * ranks them: 0 none needed, 1 float to double, 2 an integer to float, 3 an
 * integer to double, 4 int to uint; null when the language has no such
 * conversion.
 *
 * @param {ScalarBase} from @param {ScalarBase} to @param {Language | null} language
 * @returns {number | null}
 */
function conversionRank(from, to, language){
    if (from === to)
    {
        return 0;
    }
    const v = language?.version ?? 110;
    if (to === 'float')
    {
        return from === 'int' || (from === 'uint' && v >= 130) ? 2 : null;
    }
    if (to === 'double' && (v >= 400 || language?.has('double')))
    {
        return from === 'float' ? 1 : from === 'int' || from === 'uint' ? 3 : null;
    }
    if (to === 'uint' && from === 'int' && language?.has('implicitUint'))
    {
        return 4;
    }
    return null;
}

/**
 * The rank of converting a whole type, or null; only scalars, vectors and
 * matrices of the same shape convert.
 *
 * @param {GlslType} from @param {GlslType} to @param {Language | null} language
 * @returns {number | null}
 */
function typeRank(from, to, language){
    if (from === to)
    {
        return 0;
    }
    if (from.kind === 'scalar' && to.kind === 'scalar'
        || from.kind === 'vector' && to.kind === 'vector' && from.size === to.size
        || from.kind === 'matrix' && to.kind === 'matrix' && from.cols === to.cols
            && from.rows === to.rows)
    {
        return conversionRank(from.base, to.base, language);
    }
    return null;
}

/**
 * Whether a value of `from` converts to `to` implicitly: 1.20's rule unless
 * a language says otherwise.
 *
 * @param {GlslType} from @param {GlslType} to @param {Language | null} [language]
 */
export function convertible(from, to, language = null){
    return typeRank(from, to, language) !== null;
}

/** @param {number} value @param {ScalarBase} base */
const castScalar = (value, base)=>{
    switch (base)
    {
        case 'float':
            return Math.fround(value);
        case 'double':
            return value;
        case 'int':
            return Number.isFinite(value) ? Math.trunc(value) | 0 : 0;
        case 'uint':
            return Number.isFinite(value) ? Math.trunc(value) >>> 0 : 0;
        default:
            return value !== 0 ? 1 : 0;
    }
};

/**
 * A node that converts `node` to `type`, the node itself when it already is
 * one; a constant converts in place.
 *
 * @param {any} node @param {GlslType} type
 * @returns {any}
 */
export function convertTo(node, type){
    if (node.type === type)
    {
        return node;
    }
    const base = baseOf(type) ?? 'float';
    return { node: 'convert', at: node.at, type, operand: node,
        constant: node.constant ? node.constant.map((/** @type {number} */ v)=>castScalar(v,
            base)) : null };
}

/** The layout qualifiers that name image formats, with the components they hold. */
const IMAGE_FORMATS = new Map([
    ...['rgba32f', 'rgba16f', 'rg32f', 'rg16f', 'r11f_g11f_b10f', 'r32f', 'r16f', 'rgba16',
        'rgb10_a2', 'rgba8', 'rg16', 'rg8', 'r16', 'r8', 'rgba16_snorm', 'rgba8_snorm',
        'rg16_snorm', 'rg8_snorm', 'r16_snorm', 'r8_snorm'].map(f=>/** @type {[string, string]} */
        ([f, 'float'])),
    ...['rgba32i', 'rgba16i', 'rgba8i', 'rg32i', 'rg16i', 'rg8i', 'r32i', 'r16i', 'r8i']
        .map(f=>/** @type {[string, string]} */ ([f, 'int'])),
    ...['rgba32ui', 'rgba16ui', 'rgb10_a2ui', 'rgba8ui', 'rg32ui', 'rg16ui', 'rg8ui', 'r32ui',
        'r16ui', 'r8ui'].map(f=>/** @type {[string, string]} */ ([f, 'uint'])),
]);

/** The input primitives of a geometry shader, with their vertices. */
const GS_INPUTS = new Map([['points', 1], ['lines', 2], ['lines_adjacency', 4],
    ['triangles', 3], ['triangles_adjacency', 6]]);
const GS_OUTPUTS = new Set(['points', 'line_strip', 'triangle_strip']);
const TES_MODES = new Set(['triangles', 'quads', 'isolines']);
const TES_SPACING = new Set(['equal_spacing', 'fractional_even_spacing',
    'fractional_odd_spacing']);
const DEPTH_LAYOUTS = new Set(['depth_any', 'depth_greater', 'depth_less', 'depth_unchanged']);
const PACKINGS = new Set(['std140', 'std430', 'shared', 'packed']);
const MATRIX_ORDERS = new Set(['row_major', 'column_major']);

/**
 * @typedef {Object} CheckOptions
 * @property {Stage} stage
 * @property {number} version
 * @property {'core' | 'compatibility' | null} [profile]  as #version said
 * @property {Iterable<string>} [extensions]  the extensions #extension enabled
 * @property {Language} [language]  in place of the three above
 * @property {import('./glsl-library.js').GlslConstants} [constants]  the
 *     implementation's values of the built-in constants, the specification's
 *     minimums by default
 */

/**
 * @param {any} ast  the parser's
 * @param {CheckOptions} options
 * @returns {ShaderUnit}
 */
export function checkShader(ast, options){
    const language = options.language ?? languageOf(options.version, options.profile ?? null,
        options.extensions ?? []);
    const { stage } = options;
    const version = language.version;
    const modern = version >= 130;
    const constants = options.constants ?? GLSL_CONSTANTS;
    if (!hasStage(stage, language) || (!modern && stage !== 'vertex' && stage !== 'fragment'))
    {
        fail(/** @type {any} */ ({ string: 0, line: 1, text: '' }), `a ${stage} shader needs a`
            + ' later version of the language');
    }
    const builtinTable = builtinVariablesFor(stage, language, constants);
    let nextId = 1;

    /** @type {ShaderUnit} */
    const unit = {
        stage, version, profile: language.profile, language,
        globals: new Map(),
        builtins: new Map(),
        functions: [],
        structs: [],
        initUses: new Set(),
        initCalls: new Set(),
        blocks: [],
        layouts: { input: {}, output: {} },
        subroutineTypes: new Map(),
    };

    /**
     * A scope: names to what they declare -- a variable, a struct, or the
     * user functions of that name.
     *
     * @typedef {Map<string, { kind: 'variable', symbol: VariableSymbol }
     *     | { kind: 'struct', type: StructType }
     *     | { kind: 'functions', list: UserFunction[] }>} Scope
     */
    /** @type {Scope[]} */
    const scopes = [new Map()];
    /** @param {string} name */
    const lookup = name=>{
        for (let k = scopes.length - 1; k >= 0; k--)
        {
            const found = scopes[k].get(name);
            if (found)
            {
                return found;
            }
        }
        return null;
    };
    /** @type {UserFunction | null} */
    let current = null;
    let loops = 0;
    /** Switches around the statement being checked: `break` leaves one too. */
    let switches = 0;
    /** Control flow around the statement being checked, for barrier()'s rule. */
    let control = 0;
    let returned = false;

    /** @param {VariableSymbol} symbol */
    const noteUse = symbol=>{
        if (!symbol.global)
        {
            return;
        }
        if (current)
        {
            current.uses.add(symbol);
        }
        else
        {
            unit.initUses.add(symbol);
        }
    };

    /**
     * The type a built-in variable has in this shader: gl_in sized by the
     * geometry stage's input primitive, gl_out by the tessellation control
     * stage's vertices, gl_WorkGroupSize by the local size.
     *
     * @param {string} name @param {import('./glsl-builtins.js').BuiltinVariable} builtin
     * @returns {GlslType}
     */
    const builtinType = (name, builtin)=>{
        if (name === 'gl_in' && stage === 'geometry' && builtin.type.kind === 'array')
        {
            const primitive = Object.keys(unit.layouts.input).find(k=>GS_INPUTS.has(k));
            return primitive ? arrayOf(builtin.type.element, /** @type {number} */ (
                GS_INPUTS.get(primitive))) : builtin.type;
        }
        if (name === 'gl_out' && stage === 'tessControl' && builtin.type.kind === 'array')
        {
            const vertices = unit.layouts.output.vertices;
            return typeof vertices === 'number' ? arrayOf(builtin.type.element, vertices)
                : builtin.type;
        }
        return builtin.type;
    };

    /** @param {string} name @returns {VariableSymbol | null} */
    const builtinSymbol = name=>{
        const named = builtinTable[name]?.alias ?? name;
        const existing = unit.builtins.get(named);
        if (existing)
        {
            return existing;
        }
        const builtin = builtinTable[name];
        if (!builtin)
        {
            return null;
        }

        let constant = builtin.role === 'const' ? builtin.value ?? null : null;
        if (name === 'gl_WorkGroupSize')
        {
            const size = ['local_size_x', 'local_size_y', 'local_size_z']
                .map(k=>unit.layouts.input[k]);
            constant = size.map(n=>(typeof n === 'number' ? n : 1));
        }
        /** @type {VariableSymbol} */
        const symbol = {
            kind: 'variable', name: named, type: builtinType(name, builtin), storage: 'builtin',
            id: nextId++, global: true, at: /** @type {any} */ (null), builtin, constant,
        };
        unit.builtins.set(named, symbol);
        return symbol;
    };

    // --- types ---

    /**
     * @param {any} expression
     * @returns {number}  a positive array length, from a constant integer
     */
    const arrayLength = expression=>{
        const checked = expr(expression);
        if ((checked.type !== INT && checked.type !== UINT) || !checked.constant)
        {
            fail(expression.at, 'array size must be a constant integer expression');
        }
        const length = checked.type === UINT ? checked.constant[0] : checked.constant[0] | 0;
        if (length <= 0)
        {
            fail(expression.at, 'array size must be greater than zero');
        }
        return length;
    };

    /**
     * An element type wrapped in array dimensions, outermost first; an
     * unsized dimension becomes `unsized` (0 when null).
     *
     * @param {GlslType} element @param {any[]} dims @param {Token} at
     * @param {number | null} [unsized]  what an unsized dimension becomes, or null
     *     for an error
     * @returns {GlslType}
     */
    const wrap = (element, dims, at, unsized = null)=>{
        let type = element;
        for (let k = dims.length - 1; k >= 0; k--)
        {
            const dim = dims[k];
            if (dim === 'unsized')
            {
                if (unsized === null)
                {
                    return fail(at, 'an array type needs a size here');
                }
                type = arrayOf(type, unsized);
            }
            else
            {
                type = arrayOf(type, arrayLength(dim));
            }
        }
        return type;
    };

    /**
     * @param {import('./glsl-parse.js').TypeSpec} spec
     * @returns {GlslType}  without the spec's array dimensions
     */
    const elementType = spec=>{
        if (spec.basic)
        {
            return spec.basic;
        }
        if (spec.structName)
        {
            const found = lookup(spec.structName);
            if (!found || found.kind !== 'struct')
            {
                return fail(spec.at, `'${spec.structName}' : undeclared type`);
            }
            return found.type;
        }
        const def = /** @type {import('./glsl-parse.js').StructDef} */ (spec.structDef);
        /** @type {{ name: string, type: GlslType }[]} */
        const fields = [];
        for (const member of def.members)
        {
            const base = resolve(member.type);
            for (const declarator of member.declarators)
            {
                if (fields.some(field=>field.name === declarator.name))
                {
                    fail(declarator.at, `'${declarator.name}' : redefinition of a struct member`);
                }
                let type = base;
                if (declarator.arrays.length > 0)
                {
                    if (!language.has('arraysOfArrays') && (type.kind === 'array'
                        || declarator.arrays.length > 1))
                    {
                        fail(declarator.at, `'${declarator.name}' : a struct member array`
                            + ' needs a size and cannot be an array of arrays');
                    }
                    if (declarator.arrays.includes('unsized'))
                    {
                        fail(declarator.at, `'${declarator.name}' : a struct member array`
                            + ' needs a size and cannot be an array of arrays');
                    }
                    type = wrap(type, declarator.arrays, declarator.at);
                }
                if (type.kind === 'void')
                {
                    fail(declarator.at, `'${declarator.name}' : a member cannot be void`);
                }
                if (holdsOpaque(type) && modern && type.kind !== 'sampler'
                    && innermost(type).kind !== 'sampler')
                {
                    fail(declarator.at, `'${declarator.name}' : a struct member cannot be an`
                        + ` ${glslName(innermost(type))}`);
                }
                fields.push({ name: declarator.name, type });
            }
        }
        /** @type {StructType} */
        const struct = Object.freeze({ kind: 'struct', name: def.name ?? `anon${nextId}`,
            fields, id: nextId++ });
        if (def.name)
        {
            const scope = scopes[scopes.length - 1];
            if (scope.has(def.name))
            {
                fail(def.at, `'${def.name}' : redefinition`);
            }
            scope.set(def.name, { kind: 'struct', type: struct });
        }
        unit.structs.push(struct);
        return struct;
    };

    /** @param {import('./glsl-parse.js').TypeSpec} spec @returns {GlslType} */
    const resolve = spec=>{
        const element = elementType(spec);
        if (spec.arrays.length === 0)
        {
            return element;
        }
        if (spec.arrays.length > 1 && !language.has('arraysOfArrays'))
        {
            fail(spec.at, "'[' : arrays of arrays need version 430");
        }
        return wrap(element, spec.arrays, spec.at);
    };

    // --- constants ---

    /**
     * Applies `op` component-wise to two constants, a scalar standing for
     * every component of the other.
     *
     * @param {number[]} a @param {number[]} b @param {(x: number, y: number) => number} op
     */
    const zip = (a, b, op)=>{
        const length = Math.max(a.length, b.length);
        return Array.from({ length }, (_, k)=>op(a.length === 1 ? a[0] : a[k],
            b.length === 1 ? b[0] : b[k]));
    };

    // --- expressions ---

    /**
     * A swizzle or a member of `object`.
     *
     * @param {any} node @param {any} object
     */
    const field = (node, object)=>{
        const type = object.type;
        if (type.kind === 'struct')
        {
            const member = type.fields.find((/** @type {any} */ f)=>f.name === node.name);
            if (!member)
            {
                fail(node.at, `'${node.name}' : no such field in structure '${type.name}'`);
            }
            return { ...node, object, type: member.type, member: node.name,
                constant: null };
        }
        if (type.kind === 'vector' || type.kind === 'scalar')
        {
            const size = type.kind === 'vector' ? type.size : 1;
            const set = SWIZZLE_SETS.find(letters=>[...node.name].every(c=>letters.includes(c)));
            if (!set || node.name.length > 4)
            {
                fail(node.at, `'${node.name}' : illegal vector field selection`);
            }
            const indices = [...node.name].map(c=>set.indexOf(c));
            if (indices.some(index=>index >= size))
            {
                fail(node.at, `'${node.name}' : vector field selection out of range`);
            }
            return {
                node: 'swizzle', at: node.at, object, indices,
                type: vectorOf(/** @type {any} */ (baseOf(type)), indices.length),
                constant: object.constant ? indices.map(index=>object.constant[index]) : null,
            };
        }
        if (type.kind === 'array' && node.name === 'length')
        {
            fail(node.at, "'length' : is a method, call it as length()");
        }
        return fail(node.at, `'${node.name}' : field selection requires a structure or a vector`);
    };

    /**
     * @param {any} node @param {any} object @param {any} index
     */
    const indexing = (node, object, index)=>{
        const type = object.type;
        if (index.type !== INT && !(modern && index.type === UINT))
        {
            fail(node.at, "'[]' : an index must be an integer expression");
        }
        const bound = type.kind === 'array' ? type.length : type.kind === 'vector' ? type.size
            : type.kind === 'matrix' ? type.cols : -1;
        if (bound === -1)
        {
            fail(node.at, "'[]' : only arrays, vectors and matrices can be indexed");
        }
        if (index.constant && bound > 0 && (index.constant[0] < 0 || index.constant[0] >= bound))
        {
            fail(node.at, `'${index.constant[0]}' : index out of range`);
        }
        if (index.constant && index.constant[0] < 0)
        {
            fail(node.at, `'${index.constant[0]}' : index out of range`);
        }
        // An array of samplers is indexed by a constant before 4.00
        // (section 4.1.7 of 1.30 to 3.30).
        if (type.kind === 'array' && holdsOpaque(type.element) && !index.constant
            && !language.has('gpuShader5') && version >= 130)
        {
            fail(node.at, "'[]' : an array of samplers is indexed by a constant expression only"
                + ' before version 400');
        }
        const element = type.kind === 'array' ? type.element
            : type.kind === 'vector' ? vectorOf(type.base, 1) : vectorOf(type.base, type.rows);
        /** @type {number[] | null} */
        let constant = null;
        if (object.constant && index.constant && type.kind !== 'array')
        {
            const at = index.constant[0];
            constant = type.kind === 'vector' ? [object.constant[at]]
                : object.constant.slice(at * type.rows, (at + 1) * type.rows);
        }
        return { node: 'index', at: node.at, object, index, type: element, constant };
    };

    /**
     * The symbol a writable expression ends at, or an error for one that is
     * not: what may be assigned, incremented, or passed as `out`.
     *
     * @param {any} node
     * @returns {VariableSymbol}
     */
    const lvalue = node=>{
        switch (node.node)
        {
            case 'name': {
                const symbol = /** @type {VariableSymbol} */ (node.symbol);
                const role = symbol.builtin?.role;
                const fragmentVarying = symbol.storage === 'varying' && stage === 'fragment';
                if (symbol.storage === 'const' || symbol.storage === 'uniform'
                    || symbol.storage === 'attribute' || symbol.storage === 'in'
                    || symbol.readonly || fragmentVarying
                    || role === 'uniform' || role === 'attribute' || role === 'in'
                    || role === 'const'
                    || (symbol.storage === 'buffer' && symbol.qualifiers?.memory.has('readonly')))
                {
                    fail(node.at, `'${symbol.name}' : l-value required (can't modify a`
                        + ` ${symbol.storage === 'builtin' ? 'read-only built-in'
                            : symbol.storage === 'in' ? 'shader input' : symbol.storage}`
                        + ' variable)');
                }
                if (holdsOpaque(symbol.type) && innermost(symbol.type) === symbol.type
                    && modern)
                {
                    fail(node.at, `'${symbol.name}' : l-value required (an opaque variable`
                        + ' cannot be written)');
                }
                return symbol;
            }
            case 'swizzle': {
                const seen = new Set(node.indices);
                if (seen.size !== node.indices.length)
                {
                    fail(node.at, 'l-value required: a swizzle that repeats a component'
                        + ' cannot be written');
                }
                return lvalue(node.object);
            }
            case 'field':
            case 'index':
                return lvalue(node.object);
            default:
                return fail(node.at, 'l-value required');
        }
    };

    /** @param {GlslType} t */
    const numeric = t=>(t.kind === 'scalar' || t.kind === 'vector') && t.base !== 'bool'
        || t.kind === 'matrix';
    /** @param {GlslType} t */
    const integral = t=>(t.kind === 'scalar' || t.kind === 'vector')
        && (t.base === 'int' || t.base === 'uint');

    /** @param {any} node @param {string} op @param {GlslType} a @param {GlslType} b @returns {never} */
    const wrongOperands = (node, op, a, b)=>fail(node.at, `'${op}' : wrong operand types: no`
        + ` operation '${op}' exists that takes a left-hand operand of type '${glslName(a)}'`
        + ` and a right operand of type '${glslName(b)}'`);

    /**
     * The scalar base two operands meet at (section 5.9): the same one, or
     * the one the other converts to, a floating-point one where either is.
     *
     * @param {ScalarBase} a @param {ScalarBase} b
     * @returns {ScalarBase | null}
     */
    const commonBase = (a, b)=>{
        if (conversionRank(a, b, language) !== null)
        {
            return b;
        }
        return conversionRank(b, a, language) !== null ? a : null;
    };

    /**
     * Both operands converted to their common base, keeping their shapes.
     *
     * @param {any} node @param {string} op @param {any} left @param {any} right
     * @returns {[any, any]}
     */
    const meet = (node, op, left, right)=>{
        const a = baseOf(left.type);
        const b = baseOf(right.type);
        if (!a || !b)
        {
            return wrongOperands(node, op, left.type, right.type);
        }
        const base = commonBase(a, b);
        if (!base)
        {
            return wrongOperands(node, op, left.type, right.type);
        }
        /** @param {any} side */
        const lift = side=>{
            const t = side.type;
            if (baseOf(t) === base)
            {
                return side;
            }
            const to = t.kind === 'matrix' ? matrixOf(t.cols, t.rows,
                /** @type {'float' | 'double'} */ (base))
                : vectorOf(base, componentsOf(t));
            return convertTo(side, to);
        };
        return [lift(left), lift(right)];
    };

    /**
     * Folds `op` over two constants of `base`.
     *
     * @param {string} op @param {ScalarBase} base @param {number[]} a @param {number[]} b
     * @returns {number[] | null}  null where folding would divide by zero
     */
    const foldBinary = (op, base, a, b)=>{
        const integer = base === 'int' || base === 'uint';
        /** @type {Record<string, (x: number, y: number) => number>} */
        const ops = {
            '+': (x, y)=>x + y, '-': (x, y)=>x - y,
            '*': (x, y)=>(integer ? Math.imul(x, y) : x * y),
            '/': (x, y)=>(integer ? (y === 0 ? 0 : Math.trunc(x / y)) : x / y),
            '%': (x, y)=>(y === 0 ? 0 : x % y),
            '&': (x, y)=>x & y, '|': (x, y)=>x | y, '^': (x, y)=>x ^ y,
            '<<': (x, y)=>x << (y & 31),
            '>>': (x, y)=>(base === 'uint' ? x >>> (y & 31) : x >> (y & 31)),
        };
        const apply = ops[op];
        if (!apply)
        {
            return null;
        }
        return zip(a, b, apply).map(value=>castScalar(value, base));
    };

    /**
     * The type of `left op right` for the arithmetic and bitwise operators,
     * with the operands converted to it, or an error.
     *
     * @param {any} node @param {string} op @param {any} left @param {any} right
     */
    const arithmetic = (node, op, left, right)=>{
        const bitwise = op === '%' || op === '<<' || op === '>>' || op === '&' || op === '|'
            || op === '^';
        if (bitwise && !language.has('bitwise'))
        {
            fail(node.at, `'${op}' : reserved operator`);
        }
        if (op === '<<' || op === '>>')
        {
            // A shift keeps its left operand's type, whatever the right's
            // signedness (section 5.9).
            const a = left.type;
            const b = right.type;
            if (!integral(a) || !integral(b) || (a.kind === 'scalar' && b.kind !== 'scalar')
                || (a.kind === 'vector' && b.kind === 'vector' && a.size !== b.size))
            {
                return wrongOperands(node, op, a, b);
            }
            const constant = left.constant && right.constant
                ? foldBinary(op, /** @type {ScalarBase} */ (baseOf(a)), left.constant,
                    right.constant) : null;
            return { node: 'binary', at: node.at, op, left, right, type: a, constant };
        }
        if (!numeric(left.type) || !numeric(right.type))
        {
            return wrongOperands(node, op, left.type, right.type);
        }
        [left, right] = meet(node, op, left, right);
        const a = left.type;
        const b = right.type;
        if (bitwise && (!integral(a) || !integral(b)))
        {
            return wrongOperands(node, op, a, b);
        }
        /** @type {GlslType | null} */
        let type = null;
        if (a === b && (a.kind !== 'matrix' || op !== '*'))
        {
            type = a;
        }
        else if (a.kind === 'scalar' && b.kind !== 'scalar')
        {
            type = b;
        }
        else if (b.kind === 'scalar' && a.kind !== 'scalar')
        {
            type = a;
        }
        else if (op === '*' && a.kind === 'matrix' && b.kind === 'matrix' && a.cols === b.rows)
        {
            type = matrixOf(b.cols, a.rows, a.base);
        }
        else if (op === '*' && a.kind === 'matrix' && b.kind === 'vector' && a.cols === b.size)
        {
            type = vectorOf(a.base, a.rows);
        }
        else if (op === '*' && a.kind === 'vector' && b.kind === 'matrix' && a.size === b.rows)
        {
            type = vectorOf(b.base, b.cols);
        }
        if (!type)
        {
            return wrongOperands(node, op, a, b);
        }
        /** @type {number[] | null} */
        let constant = null;
        if (left.constant && right.constant && a.kind !== 'matrix' && b.kind !== 'matrix')
        {
            constant = foldBinary(op, /** @type {ScalarBase} */ (baseOf(type)), left.constant,
                right.constant);
        }
        return { node: 'binary', at: node.at, op, left, right, type, constant };
    };

    /**
     * @param {any} node
     * @returns {any}
     */
    function expr(node){
        switch (node.node)
        {
            case 'literal': {
                const type = node.kind === 'int' ? INT : node.kind === 'uint' ? UINT
                    : node.kind === 'float' ? FLOAT : node.kind === 'double' ? DOUBLE : BOOL;
                const value = node.kind === 'bool' ? (node.value ? 1 : 0) : node.value;
                return { ...node, type, constant: [value] };
            }
            case 'name': {
                const found = lookup(node.name);
                if (found?.kind === 'variable')
                {
                    noteUse(found.symbol);
                    return { ...node, symbol: found.symbol, type: found.symbol.type,
                        constant: found.symbol.constant ?? null };
                }
                if (found)
                {
                    fail(node.at, `'${node.name}' : is not a variable`);
                }
                const builtin = builtinSymbol(node.name);
                if (builtin)
                {
                    noteUse(builtin);
                    return { ...node, symbol: builtin, type: builtin.type,
                        constant: builtin.constant ?? null };
                }
                const elsewhere = otherStageHas(node.name);
                if (elsewhere)
                {
                    fail(node.at, `'${node.name}' : not available in the ${stage} shader`);
                }
                return fail(node.at, `'${node.name}' : undeclared identifier`);
            }
            case 'field':
                return field(node, expr(node.object));
            case 'index':
                return indexing(node, expr(node.object), expr(node.index));
            case 'length': {
                const object = expr(node.object);
                const type = object.type;
                if (type.kind === 'array')
                {
                    if (type.length === 0)
                    {
                        // A run-time sized array's length is the buffer's.
                        return { node: 'length', at: node.at, object, type: INT, constant: null };
                    }
                    return { node: 'literal', at: node.at, kind: 'int', value: type.length,
                        type: INT, constant: [type.length] };
                }
                if ((type.kind === 'vector' || type.kind === 'matrix')
                    && language.has('shadingLanguage420pack'))
                {
                    const length = type.kind === 'vector' ? type.size : type.cols;
                    return { node: 'literal', at: node.at, kind: 'int', value: length,
                        type: INT, constant: [length] };
                }
                return fail(node.at, "'length' : only an array has a length");
            }
            case 'unary':
                return unary(node);
            case 'postfix': {
                const operand = expr(node.operand);
                lvalue(operand);
                if (!numeric(operand.type))
                {
                    fail(node.at, `'${node.op}' : wrong operand type '${glslName(operand.type)}'`);
                }
                return { ...node, operand, type: operand.type, constant: null };
            }
            case 'binary':
                return binary(node);
            case 'assign':
                return assign(node);
            case 'conditional':
                return conditionalExpression(node);
            case 'sequence': {
                const expressions = node.expressions.map(expr);
                const last = expressions[expressions.length - 1];
                return { ...node, expressions, type: last.type, constant: null };
            }
            case 'construct':
                return construct(node, resolveConstructed(node.type, node.args),
                    node.args.map(expr));
            case 'call':
                return call(node);
            case 'list':
                return fail(node.at, "'{' : an initializer list initializes a declaration only");
            default:
                return fail(node.at, 'syntax error');
        }
    }

    /** @param {string} name @returns {boolean} whether another stage has the built-in */
    function otherStageHas(name){
        /** @type {Stage[]} */
        const stages = modern ? ['vertex', 'tessControl', 'tessEvaluation', 'geometry',
            'fragment', 'compute'] : ['vertex', 'fragment'];
        return stages.some(other=>other !== stage && (modern
            ? (hasStage(other, language) && !!builtinVariablesFor(other, language,
                constants)[name])
            : !!BUILTIN_VARIABLES[/** @type {'vertex' | 'fragment'} */ (other)][name]));
    }

    /** @param {any} node */
    function conditionalExpression(node){
        const test = expr(node.test);
        if (test.type !== BOOL)
        {
            fail(node.at, "'?:' : the condition must be a boolean");
        }
        let then = expr(node.then);
        let otherwise = expr(node.otherwise);
        if (then.type !== otherwise.type)
        {
            if (convertible(then.type, otherwise.type, language))
            {
                then = convertTo(then, otherwise.type);
            }
            else if (convertible(otherwise.type, then.type, language))
            {
                otherwise = convertTo(otherwise, then.type);
            }
            else
            {
                fail(node.at, "'?:' : both branches must have the same type");
            }
        }
        if ((then.type.kind === 'array' && !language.has('shadingLanguage420pack'))
            || holdsOpaque(then.type))
        {
            fail(node.at, "'?:' : arrays and samplers cannot be selected");
        }
        const constant = test.constant && then.constant && otherwise.constant
            ? (test.constant[0] ? then.constant : otherwise.constant) : null;
        return { ...node, test, then, otherwise, type: then.type, constant };
    }

    /**
     * The type a constructor's type spec names, an unsized dimension taking
     * its length from the arguments.
     *
     * @param {import('./glsl-parse.js').TypeSpec} spec @param {any[]} args
     */
    const resolveConstructed = (spec, args)=>{
        if (spec.arrays.length > 0 && spec.arrays[0] === 'unsized')
        {
            const rest = spec.arrays.slice(1);
            if (rest.includes('unsized'))
            {
                // `float[][](...)`: the inner sizes from the first argument.
                return arrayOf(expr(args[0]).type, args.length);
            }
            return arrayOf(wrap(elementType(spec), rest, spec.at), args.length);
        }
        return resolve(spec);
    };

    /** @param {any} node */
    function unary(node){
        const operand = expr(node.operand);
        const type = operand.type;
        switch (node.op)
        {
            case '+':
            case '-': {
                if (!numeric(type))
                {
                    fail(node.at, `'${node.op}' : wrong operand type '${glslName(type)}'`);
                }
                const constant = operand.constant && node.op === '-'
                    ? operand.constant.map((/** @type {number} */ v)=>castScalar(-v,
                        /** @type {any} */ (baseOf(type))))
                    : operand.constant;
                return { ...node, operand, type, constant };
            }
            case '!':
                if (type !== BOOL)
                {
                    fail(node.at, `'!' : wrong operand type '${glslName(type)}'`);
                }
                return { ...node, operand, type,
                    constant: operand.constant ? [operand.constant[0] ? 0 : 1] : null };
            case '~':
                if (!language.has('bitwise'))
                {
                    return fail(node.at, "'~' : reserved operator");
                }
                if (!integral(type))
                {
                    fail(node.at, `'~' : wrong operand type '${glslName(type)}'`);
                }
                return { ...node, operand, type, constant: operand.constant
                    ? operand.constant.map((/** @type {number} */ v)=>castScalar(~v,
                        /** @type {any} */ (baseOf(type)))) : null };
            case '++':
            case '--':
                lvalue(operand);
                if (!numeric(type))
                {
                    fail(node.at, `'${node.op}' : wrong operand type '${glslName(type)}'`);
                }
                return { ...node, operand, type, constant: null };
            default:
                return fail(node.at, `'${node.op}' : reserved operator`);
        }
    }

    /** @param {any} node */
    function binary(node){
        const op = node.op;
        let left = expr(node.left);
        let right = expr(node.right);
        if (op === '&&' || op === '||' || op === '^^')
        {
            if (left.type !== BOOL || right.type !== BOOL)
            {
                fail(node.at, `'${op}' : wrong operand types: both must be scalar booleans`);
            }
            const constant = left.constant && right.constant
                ? [op === '&&' ? left.constant[0] & right.constant[0]
                    : op === '||' ? left.constant[0] | right.constant[0]
                        : left.constant[0] ^ right.constant[0]]
                : null;
            return { node: 'binary', at: node.at, op, left, right, type: BOOL, constant };
        }
        if (op === '<' || op === '>' || op === '<=' || op === '>=')
        {
            if (left.type.kind !== 'scalar' || right.type.kind !== 'scalar'
                || left.type === BOOL || right.type === BOOL)
            {
                wrongOperands(node, op, left.type, right.type);
            }
            if (left.type !== right.type)
            {
                [left, right] = meet(node, op, left, right);
            }
            const constant = left.constant && right.constant ? [Number(op === '<'
                ? left.constant[0] < right.constant[0] : op === '>'
                    ? left.constant[0] > right.constant[0] : op === '<='
                        ? left.constant[0] <= right.constant[0]
                        : left.constant[0] >= right.constant[0])] : null;
            return { node: 'binary', at: node.at, op, left, right, type: BOOL, constant };
        }
        if (op === '==' || op === '!=')
        {
            if (left.type !== right.type)
            {
                if (convertible(left.type, right.type, language)
                    && !convertible(right.type, left.type, language))
                {
                    left = convertTo(left, right.type);
                }
                else if (convertible(right.type, left.type, language))
                {
                    right = convertTo(right, left.type);
                }
                else if (numeric(left.type) && numeric(right.type) && modern)
                {
                    [left, right] = meet(node, op, left, right);
                    if (left.type !== right.type)
                    {
                        wrongOperands(node, op, left.type, right.type);
                    }
                }
                else
                {
                    wrongOperands(node, op, left.type, right.type);
                }
            }
            if (holdsSampler(left.type) || holdsOpaque(left.type))
            {
                fail(node.at, `'${op}' : samplers cannot be compared`);
            }
            let constant = null;
            if (left.constant && right.constant)
            {
                const equal = left.constant.every((/** @type {number} */ v, /** @type {number} */ k)=>
                    v === right.constant[k]);
                constant = [Number(op === '==' ? equal : !equal)];
            }
            return { node: 'binary', at: node.at, op, left, right, type: BOOL, constant };
        }
        return arithmetic(node, op, left, right);
    }

    /** @param {any} node */
    function assign(node){
        const target = expr(node.target);
        const symbol = lvalue(target);
        symbol.written = true;
        let value = expr(node.value);
        if (node.op === '=')
        {
            if (value.type !== target.type)
            {
                if (!convertible(value.type, target.type, language))
                {
                    fail(node.at, `'=' : cannot convert from '${glslName(value.type)}' to`
                        + ` '${glslName(target.type)}'`);
                }
                value = convertTo(value, target.type);
            }
            if (holdsSampler(target.type) || holdsOpaque(target.type))
            {
                fail(node.at, "'=' : a sampler cannot be assigned");
            }
            return { node: 'assign', at: node.at, op: '=', target, value, type: target.type,
                constant: null };
        }
        const op = node.op.slice(0, -1);
        const combined = arithmetic(node, op, target, value);
        if (combined.type !== target.type)
        {
            fail(node.at, `'${node.op}' : cannot convert from '${glslName(combined.type)}' to`
                + ` '${glslName(target.type)}'`);
        }
        return { node: 'assign', at: node.at, op: node.op, target, value: combined.right,
            type: target.type, constant: null };
    }

    /**
     * @param {any} node
     * @param {GlslType} type
     * @param {any[]} args
     */
    function construct(node, type, args){
        if (args.length === 0)
        {
            fail(node.at, `'${glslName(type)}' : constructor does not have any arguments`);
        }
        for (const arg of args)
        {
            if (holdsOpaque(arg.type) || arg.type.kind === 'void')
            {
                fail(arg.at, `'${glslName(type)}' : cannot construct from a`
                    + ` ${glslName(arg.type)}`);
            }
        }
        const allConstant = args.every(arg=>arg.constant);
        if (type.kind === 'struct' || type.kind === 'array')
        {
            const wanted = type.kind === 'struct'
                ? type.fields.map(f=>f.type)
                : Array.from({ length: type.length }, ()=>type.element);
            if (args.length !== wanted.length)
            {
                fail(node.at, `'${glslName(type)}' : wrong number of arguments: ${args.length}`
                    + ` given, ${wanted.length} expected`);
            }
            const converted = args.map((arg, k)=>{
                if (!convertible(arg.type, wanted[k], language))
                {
                    fail(arg.at, `'${glslName(type)}' : cannot convert from`
                        + ` '${glslName(arg.type)}' to '${glslName(wanted[k])}'`);
                }
                return convertTo(arg, wanted[k]);
            });
            return { node: 'construct', at: node.at, type, args: converted,
                constant: modern && allConstant && type.kind === 'array'
                    && converted.every(a=>a.constant && a.type.kind !== 'array'
                        && a.type.kind !== 'struct')
                    ? converted.flatMap(a=>a.constant) : null };
        }
        if (holdsOpaque(type) || type.kind === 'void')
        {
            fail(node.at, `'${glslName(type)}' : cannot be constructed`);
        }
        for (const arg of args)
        {
            if (arg.type.kind === 'struct' || arg.type.kind === 'array')
            {
                fail(arg.at, `'${glslName(type)}' : cannot construct from a`
                    + ` ${glslName(arg.type)}`);
            }
        }
        const base = /** @type {ScalarBase} */ (baseOf(type));
        const size = componentsOf(type);
        // Each argument's components, cast to the constructed type's scalar.
        const folded = allConstant
            ? args.flatMap(arg=>arg.constant.map((/** @type {number} */ v)=>castScalar(v, base)))
            : null;
        if (type.kind === 'scalar')
        {
            if (args.length > 1)
            {
                fail(node.at, `'${glslName(type)}' : too many arguments`);
            }
            return { node: 'construct', at: node.at, type, args,
                constant: folded ? [folded[0]] : null };
        }
        if (type.kind === 'matrix' && args.some(arg=>arg.type.kind === 'matrix')
            && args.length > 1)
        {
            fail(node.at, `'${glslName(type)}' : a matrix argument must be the only argument`
                + ' of a matrix constructor');
        }
        if (args.length === 1 && args[0].type.kind === 'scalar')
        {
            /** @type {number[] | null} */
            let constant = null;
            if (folded)
            {
                const rows = type.kind === 'matrix' ? type.rows : size;
                constant = type.kind === 'vector' ? new Array(size).fill(folded[0])
                    : Array.from({ length: size }, (_, k)=>(Math.floor(k / rows) === k % rows
                        ? folded[0] : 0));
            }
            return { node: 'construct', at: node.at, type, args, constant };
        }
        if (type.kind === 'matrix' && args.length === 1 && args[0].type.kind === 'matrix')
        {
            const from = args[0].type;
            /** @type {number[] | null} */
            let constant = null;
            if (folded)
            {
                constant = Array.from({ length: size }, (_, k)=>{
                    const col = Math.floor(k / type.rows);
                    const row = k % type.rows;
                    return col < from.cols && row < from.rows ? folded[col * from.rows + row]
                        : col === row ? 1 : 0;
                });
            }
            return { node: 'construct', at: node.at, type, args, constant };
        }
        let total = 0;
        for (let k = 0; k < args.length; k++)
        {
            if (total >= size)
            {
                fail(args[k].at, `'${glslName(type)}' : too many arguments`);
            }
            total += componentsOf(args[k].type);
        }
        if (total < size)
        {
            fail(node.at, `'${glslName(type)}' : not enough data provided for construction`);
        }
        return { node: 'construct', at: node.at, type, args,
            constant: folded ? folded.slice(0, size) : null };
    }

    /**
     * An initializer list made the constructor of the type it initializes
     * (section 4.1.11): each item the same, nested lists for nested
     * aggregates, and an unsized array sized by its items.
     *
     * @param {any} list @param {GlslType} type
     * @returns {any}
     */
    function fromList(list, type){
        if (list.node !== 'list')
        {
            const value = expr(list);
            if (value.type !== type)
            {
                if (!convertible(value.type, type, language))
                {
                    fail(list.at, `'=' : cannot convert from '${glslName(value.type)}' to`
                        + ` '${glslName(type)}'`);
                }
                return convertTo(value, type);
            }
            return value;
        }
        /** @type {GlslType[]} */
        let parts;
        const given = type;
        if (given.kind === 'array')
        {
            const length = given.length === 0 ? list.items.length : given.length;
            type = arrayOf(given.element, length);
            parts = Array.from({ length }, ()=>given.element);
        }
        else if (given.kind === 'struct')
        {
            parts = given.fields.map(f=>f.type);
        }
        else if (given.kind === 'matrix')
        {
            parts = Array.from({ length: given.cols }, ()=>vectorOf(given.base, given.rows));
        }
        else if (given.kind === 'vector')
        {
            parts = Array.from({ length: given.size }, ()=>vectorOf(given.base, 1));
        }
        else
        {
            parts = [type];
            if (list.items.length === 1)
            {
                return fromList(list.items[0], type);
            }
        }
        if (list.items.length !== parts.length)
        {
            fail(list.at, `'{' : wrong number of initializers: ${list.items.length} given,`
                + ` ${parts.length} expected`);
        }
        const args = list.items.map((/** @type {any} */ item, /** @type {number} */ k)=>
            fromList(item, parts[k]));
        return construct({ at: list.at }, type, args);
    }

    /**
     * @param {any} node
     */
    function call(node){
        const found = lookup(node.name);
        const args = node.args.map(expr);
        if (found?.kind === 'struct')
        {
            return construct(node, found.type, args);
        }
        if (found?.kind === 'variable')
        {
            if (found.symbol.subroutine)
            {
                return subroutineCall(node, found.symbol, args);
            }
            fail(node.at, `'${node.name}' : is not a function`);
        }
        const user = found?.kind === 'functions' ? found.list : [];
        /** @type {{ params: GlslType[], directions: string[], target: any }[]} */
        let candidates = user.map(f=>({ params: f.params.map(p=>p.type),
            directions: f.params.map(p=>p.direction), target: f }));
        if (user.length === 0)
        {
            candidates = modern
                ? modernOverloads(node.name, language).map(o=>({ params: o.params,
                    directions: o.directions, target: o }))
                : [...BUILTIN_FUNCTIONS.get(node.name) ?? [],
                    ...extensionOverloads(node.name, language)].map(b=>({ params: b.params,
                    directions: b.params.map(()=>'in'), target: b }));
        }
        if (candidates.length === 0)
        {
            fail(node.at, `'${node.name}' : no matching overloaded function found`);
        }
        const chosen = choose(node, candidates, args);
        const target = chosen.target;
        if (target.kind !== 'user')
        {
            if (target.stage && target.stage !== stage)
            {
                fail(node.at, `'${node.name}' : no matching overloaded function found: this form`
                    + ` is available in the ${target.stage} shader only`);
            }
            if (target.stages && !target.stages.has(stage))
            {
                fail(node.at, `'${node.name}' : no matching overloaded function found: this form`
                    + ` is available in the ${[...target.stages].join(' and ')} shader only`);
            }
        }
        const converted = args.map((/** @type {any} */ arg, /** @type {number} */ k)=>{
            if (chosen.directions[k] !== 'in')
            {
                lvalue(arg).written = true;
                return arg;
            }
            return convertTo(arg, chosen.params[k]);
        });
        if (node.name === 'ftransform')
        {
            noteUse(/** @type {VariableSymbol} */ (builtinSymbol('gl_Vertex')));
        }
        if (target.kind === 'user')
        {
            if (current)
            {
                current.calls.add(target.key);
            }
            else
            {
                unit.initCalls.add(target.key);
            }
            return { node: 'call', at: node.at, name: node.name, user: target, args: converted,
                type: target.returns, constant: null };
        }
        if (modern)
        {
            builtinCallRules(node, converted);
        }
        // An extension's spelling of a core function is the core one's call.
        const name = target.canonical ?? node.name;
        return { node: 'call', at: node.at, name, builtin: target, args: converted,
            type: target.returns, constant: foldBuiltin(name, converted, target.returns) };
    }

    /**
     * The one overload a call takes (section 6.1): exactly, or by conversion
     * -- before 4.00 only one may match that way, from 4.00 the best.
     *
     * @param {any} node
     * @param {{ params: GlslType[], directions: string[], target: any }[]} candidates
     * @param {any[]} args
     */
    function choose(node, candidates, args){
        const arity = candidates.filter(c=>c.params.length === args.length);
        const exact = arity.filter(c=>c.params.every((p, k)=>p === args[k].type));
        if (exact[0])
        {
            return exact[0];
        }
        /** @param {{ params: GlslType[], directions: string[] }} c @returns {number[] | null} */
        const ranks = c=>{
            /** @type {number[]} */
            const out = [];
            for (let k = 0; k < c.params.length; k++)
            {
                const p = c.params[k];
                const a = args[k].type;
                const direction = c.directions[k];
                // An out parameter converts back to the argument; before 4.00
                // it had to match exactly.
                const rank = direction === 'in' ? typeRank(a, p, language)
                    : direction === 'out' && language.has('gpuShader5') ? typeRank(p, a, language)
                        : p === a ? 0 : null;
                if (rank === null)
                {
                    return null;
                }
                out.push(rank);
            }
            return out;
        };
        const loose = arity.map(c=>({ c, r: ranks(c) })).filter(e=>e.r !== null);
        if (loose.length === 0)
        {
            fail(node.at, `'${node.name}' : no matching overloaded function found`
                + ` (given ${args.map((/** @type {any} */ a)=>glslName(a.type)).join(', ')
                    || 'no arguments'})`);
        }
        if (loose.length === 1)
        {
            return loose[0].c;
        }
        if (!language.has('gpuShader5'))
        {
            fail(node.at, `'${node.name}' : ambiguous overloaded function call`);
        }
        /** @param {number} x @param {number} y whether rank x beats y (section 6.1's three rules) */
        const better = (x, y)=>x !== y && (x === 0 || (x === 1 && y !== 0)
            || (x === 2 && y === 3));
        const best = loose.filter(e=>loose.every(other=>other === e
            || (/** @type {number[]} */ (e.r).some((x, k)=>better(x,
                /** @type {number[]} */ (other.r)[k]))
                && !/** @type {number[]} */ (other.r).some((y, k)=>better(y,
                    /** @type {number[]} */ (e.r)[k])))));
        if (best.length !== 1)
        {
            fail(node.at, `'${node.name}' : ambiguous overloaded function call`);
        }
        return best[0].c;
    }

    /**
     * A call through a subroutine uniform (section 6.1.2): the arguments of
     * its subroutine type.
     *
     * @param {any} node @param {VariableSymbol} symbol @param {any[]} args
     */
    function subroutineCall(node, symbol, args){
        const type = unit.subroutineTypes.get(/** @type {string} */ (symbol.subroutine));
        if (!type)
        {
            return fail(node.at, `'${node.name}' : is not a function`);
        }
        const chosen = choose(node, [{ params: type.params.map(p=>p.type),
            directions: type.params.map(p=>p.direction), target: type }], args);
        noteUse(symbol);
        return { node: 'call', at: node.at, name: node.name, subroutine: symbol,
            args: args.map((a, k)=>(chosen.directions[k] === 'in'
                ? convertTo(a, chosen.params[k]) : a)), type: type.returns, constant: null };
    }

    /**
     * What a built-in's arguments must be beyond their types: constant
     * offsets and components, an atomic's memory, an interpolant, an image's
     * access, the place of a barrier.
     *
     * @param {any} node @param {any[]} args
     */
    function builtinCallRules(node, args){
        const name = node.name;
        if (/Offset$/.test(name) && name !== 'textureGatherOffset')
        {
            const at = name === 'texelFetchOffset' ? args.length - 1
                : args.findIndex((/** @type {any} */ a, /** @type {number} */ k)=>k > 1
                    && integral(a.type));
            const offset = args[at];
            if (offset && !offset.constant)
            {
                fail(offset.at, `'${name}' : the offset must be a constant expression`);
            }
            const low = Number(constants.gl_MinProgramTexelOffset);
            const high = Number(constants.gl_MaxProgramTexelOffset);
            if (offset?.constant?.some((/** @type {number} */ v)=>v < low || v > high))
            {
                fail(offset.at, `'${name}' : an offset must be within [${low}, ${high}]`);
            }
        }
        if (name === 'textureGatherOffsets' && !args[2]?.constant && !args[3]?.constant)
        {
            const offsets = args.find((/** @type {any} */ a)=>a.type.kind === 'array');
            if (offsets && !isConstantTree(offsets))
            {
                fail(offsets.at, "'textureGatherOffsets' : the offsets must be a constant"
                    + ' expression');
            }
        }
        if (/^textureGather/.test(name) && args.length > 2)
        {
            const last = args[args.length - 1];
            const shadow = args[0].type.kind === 'sampler' && args[0].type.shadow;
            if (!shadow && last.type === INT && name !== 'textureGatherOffset'
                ? true : !shadow && last.type === INT && args.length === 4)
            {
                if (!last.constant || last.constant[0] < 0 || last.constant[0] > 3)
                {
                    fail(last.at, `'${name}' : the component must be a constant 0 to 3`);
                }
            }
        }
        if (/^atomic(Add|Min|Max|And|Or|Xor|Exchange|CompSwap)$/.test(name))
        {
            const root = lvalue(args[0]);
            if (root.storage !== 'buffer' && root.storage !== 'shared')
            {
                fail(args[0].at, `'${name}' : the memory must be a buffer or shared variable`);
            }
        }
        if (/^interpolateAt/.test(name))
        {
            const root = rootSymbol(args[0]);
            if (!root || (root.storage !== 'in' && root.storage !== 'varying'))
            {
                fail(args[0].at, `'${name}' : the interpolant must be a shader input`);
            }
            if (args[0].node === 'swizzle' && version < 440)
            {
                fail(args[0].at, `'${name}' : the interpolant cannot be a swizzle`);
            }
        }
        if (/^image/.test(name))
        {
            const root = rootSymbol(args[0]);
            const memory = root?.qualifiers?.memory ?? new Set();
            if (name === 'imageLoad' && memory.has('writeonly')
                || /^imageAtomic/.test(name) && (memory.has('writeonly')
                    || memory.has('readonly')))
            {
                fail(args[0].at, `'${name}' : the image is ${memory.has('writeonly')
                    ? 'writeonly' : 'readonly'}`);
            }
            if (name === 'imageStore' && memory.has('readonly'))
            {
                fail(args[0].at, `'${name}' : the image is readonly`);
            }
        }
        if (name === 'EmitStreamVertex' || name === 'EndStreamPrimitive')
        {
            if (!args[0].constant)
            {
                fail(args[0].at, `'${name}' : the stream must be a constant expression`);
            }
            else if (args[0].constant[0] !== 0 && current)
            {
                (current.streams ??= new Set()).add(args[0].constant[0]);
            }
        }
        if (name === 'barrier' && stage === 'tessControl')
        {
            if (current?.name !== 'main' || control > 0 || returned)
            {
                fail(node.at, "'barrier' : in a tessellation control shader only in main, outside"
                    + ' control flow and before any return');
            }
        }
    }

    /** @param {any} node @returns {VariableSymbol | null} the variable an expression reads */
    function rootSymbol(node){
        switch (node.node)
        {
            case 'name':
                return node.symbol;
            case 'swizzle':
            case 'field':
            case 'index':
                return rootSymbol(node.object);
            default:
                return null;
        }
    }

    /** @param {any} node @returns {boolean} whether every leaf is constant */
    function isConstantTree(node){
        if (node.constant)
        {
            return true;
        }
        return node.node === 'construct' && node.args.every(isConstantTree);
    }

    /**
     * The few built-ins a constant expression in a declaration's size or a
     * const's initializer is seen to use.
     *
     * @param {string} name @param {any[]} args @param {GlslType} returns
     * @returns {number[] | null}
     */
    function foldBuiltin(name, args, returns){
        if (!args.every(arg=>arg.constant))
        {
            return null;
        }
        const values = args.map(arg=>arg.constant);
        const base = baseOf(returns);
        const round = (/** @type {number} */ v)=>(base === 'float' ? Math.fround(v)
            : base === 'int' || base === 'uint' || base === 'double' ? castScalar(v, base) : v);
        /** @type {Record<string, (x: number, y: number) => number>} */
        const binaryOps = { min: Math.min, max: Math.max, pow: Math.pow };
        /** @type {Record<string, (x: number) => number>} */
        const unaryOps = { abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
            sin: Math.sin, cos: Math.cos, exp: Math.exp, log: Math.log, trunc: Math.trunc,
            radians: x=>x * Math.PI / 180, degrees: x=>x * 180 / Math.PI };
        if (base === 'bool' || base === null)
        {
            return null;
        }
        if (unaryOps[name] && values.length === 1)
        {
            return values[0].map((/** @type {number} */ v)=>round(unaryOps[name](v)));
        }
        if (binaryOps[name] && values.length === 2)
        {
            return zip(values[0], values[1], binaryOps[name]).map(round);
        }
        if (name === 'clamp' && values.length === 3)
        {
            return zip(zip(values[0], values[1], Math.max), values[2], Math.min).map(round);
        }
        return returns === FLOAT && name === 'length'
            ? [Math.fround(Math.hypot(...values[0]))] : null;
    }

    // --- qualifiers ---

    /**
     * A declaration's layout: each qualifier by its lower-case name, its
     * value a constant integer (section 4.4).
     *
     * @param {ParsedQualifiers} q
     * @returns {Layout}
     */
    function layoutOf(q){
        /** @type {Layout} */
        const layout = {};
        if (q.layout.length > 0 && !language.has('layout'))
        {
            fail(q.at, "'layout' : needs version 140");
        }
        for (const entry of q.layout)
        {
            const name = entry.name.toLowerCase();
            if (entry.value === null)
            {
                layout[name] = true;
                continue;
            }
            const value = expr(entry.value);
            if ((value.type !== INT && value.type !== UINT) || !value.constant)
            {
                fail(entry.at, `'${entry.name}' : a layout value must be a constant integer`);
            }
            if (value.constant[0] < 0)
            {
                fail(entry.at, `'${entry.name}' : a layout value cannot be negative`);
            }
            layout[name] = value.constant[0];
        }
        return layout;
    }

    /**
     * The layout qualifiers a declaration may carry, by what it declares, and
     * the version each came with.
     *
     * @param {Layout} layout @param {Token} at
     * @param {'uniform' | 'buffer' | 'in' | 'out' | 'member' | 'blockUniform' | 'blockBuffer'
     *     | 'blockIn' | 'blockOut' | 'defaultsIn' | 'defaultsOut' | 'defaultsUniform'
     *     | 'defaultsBuffer' | 'shared' | 'subroutine'} what
     * @param {GlslType} [type]
     */
    function checkLayout(layout, at, what, type){
        for (const name of Object.keys(layout))
        {
            const since = allowedSince(name, what, type);
            if (since === null)
            {
                fail(at, `'${name}' : layout qualifier not allowed here`);
            }
            // An extension brings its qualifiers to an earlier version:
            // GL_ARB_uniform_buffer_object a block's packing and matrix
            // order, GL_ARB_explicit_attrib_location the locations of 3.30,
            // and each 4.x one its own (`layoutFeature`).
            const brought = (since === 140 && (PACKINGS.has(name) || MATRIX_ORDERS.has(name))
                && language.has('uniformBlocks'))
                || (since === 330 && name === 'location' && language.has('explicitLocation'))
                || layoutFeature(name, since, what, type).some(feature=>language.has(feature));
            if (since > version && !brought)
            {
                fail(at, `'${name}' : layout qualifier needs version ${since}`);
            }
        }
    }

    /**
     * The features that bring a layout qualifier of a later version to an
     * earlier one, an extension having enabled them: each 4.x extension's
     * qualifiers where its specification adds them.
     *
     * @param {string} name @param {number | null} since @param {string} what
     * @param {GlslType} [type]
     * @returns {import('./glsl-versions.js').Feature[]}
     */
    function layoutFeature(name, since, what, type){
        const opaque = type ? innermost(type) : null;
        if (name === 'std430')
        {
            return ['shaderStorage'];
        }
        switch (name)
        {
            case 'binding':
                return opaque?.kind === 'atomic' ? ['binding', 'atomicCounters']
                    : what === 'blockBuffer' ? ['binding', 'shaderStorage']
                        : opaque?.kind === 'image' ? ['binding', 'images'] : ['binding'];
            case 'offset':
                return since === 420 ? ['atomicCounters'] : ['enhancedLayouts'];
            case 'align':
            case 'component':
            case 'xfb_buffer':
            case 'xfb_offset':
            case 'xfb_stride':
                return ['enhancedLayouts'];
            case 'location':
                return since === 410 ? ['separateShaders'] : since === 430
                    ? ['explicitUniformLocation'] : ['enhancedLayouts'];
            case 'index':
                return since === 430 ? ['explicitUniformLocation'] : [];
            case 'stream':
            case 'invocations':
                return ['gpuShader5'];
            case 'vertices':
            case 'point_mode':
            case 'cw':
            case 'ccw':
                return ['tessellation'];
            case 'local_size_x':
            case 'local_size_y':
            case 'local_size_z':
                return ['compute'];
            case 'early_fragment_tests':
                return ['images'];
            default:
                break;
        }
        if (DEPTH_LAYOUTS.has(name))
        {
            return ['conservativeDepth'];
        }
        if (TES_MODES.has(name) || TES_SPACING.has(name))
        {
            return ['tessellation'];
        }
        return IMAGE_FORMATS.has(name) ? ['images'] : [];
    }

    /**
     * The version a layout qualifier came with where it is allowed, or null
     * where it is not (section 4.4 and the versions before it).
     *
     * @param {string} name @param {string} what @param {GlslType} [type]
     * @returns {number | null}
     */
    function allowedSince(name, what, type){
        const opaque = type ? innermost(type) : null;
        if (PACKINGS.has(name))
        {
            if (!['blockUniform', 'blockBuffer', 'defaultsUniform', 'defaultsBuffer']
                .includes(what))
            {
                return null;
            }
            return name === 'std430' ? (what.endsWith('Buffer') ? 430 : null) : 140;
        }
        if (MATRIX_ORDERS.has(name))
        {
            return ['blockUniform', 'blockBuffer', 'defaultsUniform', 'defaultsBuffer', 'member']
                .includes(what) ? 140 : null;
        }
        switch (name)
        {
            case 'binding':
                return ['blockUniform', 'blockBuffer'].includes(what)
                    || (what === 'uniform' && opaque && holdsOpaque(opaque)) ? 420 : null;
            case 'offset':
                return what === 'uniform' && opaque?.kind === 'atomic' ? 420
                    : what === 'member' ? 440 : null;
            case 'align':
                return what === 'member' || what === 'blockUniform' || what === 'blockBuffer'
                    ? 440 : null;
            case 'location':
                if (what === 'in')
                {
                    return stage === 'vertex' ? 330 : 410;
                }
                if (what === 'out')
                {
                    return stage === 'fragment' ? 330 : 410;
                }
                if (what === 'blockIn' || what === 'blockOut' || what === 'member')
                {
                    return 440;
                }
                return what === 'uniform' || what === 'subroutine' ? 430 : null;
            case 'component':
                return what === 'in' || what === 'out' || what === 'member' ? 440 : null;
            case 'index':
                return what === 'out' && stage === 'fragment' || what === 'subroutine'
                    ? (what === 'subroutine' ? 430 : 330) : null;
            case 'xfb_buffer':
            case 'xfb_offset':
            case 'xfb_stride':
                return ['out', 'blockOut', 'defaultsOut', 'member'].includes(what) ? 440 : null;
            case 'stream':
                return stage === 'geometry' && ['out', 'blockOut', 'defaultsOut', 'member']
                    .includes(what) ? 400 : null;
            case 'invocations':
                return stage === 'geometry' && what === 'defaultsIn' ? 400 : null;
            case 'max_vertices':
                return stage === 'geometry' && what === 'defaultsOut' ? 150 : null;
            case 'vertices':
                return stage === 'tessControl' && what === 'defaultsOut' ? 400 : null;
            case 'local_size_x':
            case 'local_size_y':
            case 'local_size_z':
                return stage === 'compute' && what === 'defaultsIn' ? 430 : null;
            case 'early_fragment_tests':
                return stage === 'fragment' && what === 'defaultsIn' ? 420 : null;
            case 'origin_upper_left':
            case 'pixel_center_integer':
                return stage === 'fragment' && what === 'in' ? 150 : null;
            case 'point_mode':
            case 'cw':
            case 'ccw':
                return stage === 'tessEvaluation' && what === 'defaultsIn' ? 400 : null;
            default:
                break;
        }
        if (DEPTH_LAYOUTS.has(name))
        {
            return stage === 'fragment' && what === 'out' ? 420 : null;
        }
        if (GS_INPUTS.has(name) && stage === 'geometry' && what === 'defaultsIn')
        {
            return 150;
        }
        if (GS_OUTPUTS.has(name) && stage === 'geometry' && what === 'defaultsOut')
        {
            return 150;
        }
        if ((TES_MODES.has(name) || TES_SPACING.has(name)) && stage === 'tessEvaluation'
            && what === 'defaultsIn')
        {
            return 400;
        }
        if (IMAGE_FORMATS.has(name))
        {
            return what === 'uniform' && opaque?.kind === 'image' ? 420 : null;
        }
        return null;
    }

    /**
     * A variable's qualifiers past its storage, checked against what it is.
     *
     * @param {ParsedQualifiers} q @param {Layout} layout
     * @returns {VariableQualifiers}
     */
    function variableQualifiers(q, layout){
        return { interpolation: q.interpolation, centroid: q.centroid, sample: q.sample,
            patch: q.patch, precise: q.precise, memory: new Set(q.memory), layout };
    }

    // --- declarations ---

    /**
     * @param {any} decl  a `variables` node
     * @param {boolean} global
     * @returns {any[]}  the checked declarators: symbol and initializer
     */
    function variables(decl, global){
        /** @type {ParsedQualifiers} */
        const q = decl.qualifiers;
        const storage = q.storage;
        if (!global && storage && storage !== 'const')
        {
            fail(decl.at, `'${storage}' : only allowed at global scope`);
        }
        if (!global && (q.layout.length > 0 || q.interpolation || q.centroid || q.sample
            || q.patch || q.memory.length > 0 || q.invariant))
        {
            fail(decl.at, `'${q.at.text}' : not allowed on a local variable`);
        }
        if (storage === 'attribute' && stage !== 'vertex')
        {
            fail(decl.at, "'attribute' : supported in vertex shaders only");
        }
        if ((storage === 'attribute' || storage === 'varying') && !language.compatibility)
        {
            fail(decl.at, `'${storage}' : not supported in the core profile; use`
                + ` '${storage === 'attribute' ? 'in' : 'in or out'}'`);
        }
        if (storage === 'varying' && stage !== 'vertex' && stage !== 'fragment')
        {
            fail(decl.at, "'varying' : supported in vertex and fragment shaders only");
        }
        if (storage === 'shared' && stage !== 'compute')
        {
            fail(decl.at, "'shared' : supported in compute shaders only");
        }
        if (storage === 'buffer')
        {
            fail(decl.at, "'buffer' : a buffer variable must be a member of a buffer block");
        }
        if (q.subroutine && storage === 'uniform')
        {
            return subroutineUniform(decl);
        }
        if (q.patch && !((stage === 'tessControl' && storage === 'out')
            || (stage === 'tessEvaluation' && storage === 'in')))
        {
            fail(decl.at, "'patch' : only a tessellation control output or evaluation input");
        }
        const interpolated = q.interpolation || q.centroid || q.sample;
        if (interpolated && !(storage === 'in' && stage !== 'vertex'
            || storage === 'out' && stage !== 'fragment' || storage === 'varying'))
        {
            fail(decl.at, `'${q.interpolation ?? (q.centroid ? 'centroid' : 'sample')}' :`
                + ' only an input or output between stages is interpolated');
        }
        const layout = layoutOf(q);
        const base = elementType(decl.type);
        /** @type {any[]} */
        const checked = [];
        for (const declarator of decl.declarators)
        {
            const dims = [...declarator.arrays, ...decl.type.arrays];
            if (dims.length > 1 && !language.has('arraysOfArrays'))
            {
                fail(declarator.at, `'${declarator.name}' : arrays of arrays are not`
                    + ' allowed');
            }
            let type = base;
            if (dims.length > 0)
            {
                type = declaredArray(declarator, decl, base, dims, storage, q);
            }
            if (type.kind === 'void')
            {
                fail(declarator.at, `'${declarator.name}' : illegal use of type 'void'`);
            }
            const what = storage === 'uniform' ? 'uniform' : storage === 'in' ? 'in'
                : storage === 'out' ? 'out' : storage === 'shared' ? 'shared' : null;
            if (what)
            {
                checkLayout(layout, decl.at, what, type);
            }
            else if (Object.keys(layout).length > 0)
            {
                fail(decl.at, `'${Object.keys(layout)[0]}' : layout qualifier not allowed here`);
            }
            checkStorageType(declarator, type, storage, q, layout);
            /** @type {any} */
            let initializer = null;
            if (declarator.initializer)
            {
                initializer = declarator.initializer.node === 'list'
                    ? fromList(declarator.initializer, type)
                    : expr(declarator.initializer);
                if (initializer.type !== type)
                {
                    if (!convertible(initializer.type, type, language))
                    {
                        fail(declarator.at, `'=' : cannot convert from`
                            + ` '${glslName(initializer.type)}' to '${glslName(type)}'`);
                    }
                    initializer = convertTo(initializer, type);
                }
                if (storage === 'uniform' && !initializer.constant
                    && !isConstantTree(initializer))
                {
                    fail(declarator.at, `'${declarator.name}' : a uniform initializer must be`
                        + ' a constant expression');
                }
                if (storage === 'const' && global && modern && !initializer.constant
                    && !isConstantTree(initializer))
                {
                    fail(declarator.at, `'${declarator.name}' : a const variable at global scope`
                        + ' needs a constant initializer');
                }
                if (storage === 'const' && !global && modern
                    && !language.has('shadingLanguage420pack')
                    && !initializer.constant && !isConstantTree(initializer))
                {
                    fail(declarator.at, `'${declarator.name}' : a const variable needs a constant`
                        + ' initializer before version 420');
                }
            }
            if (storage === 'const' && !initializer)
            {
                fail(declarator.at, `'${declarator.name}' : a const variable must be`
                    + ' initialized');
            }
            const scope = scopes[scopes.length - 1];
            const existing = scope.get(declarator.name);
            if (existing)
            {
                fail(declarator.at, `'${declarator.name}' : redefinition`);
            }
            if (declarator.name.startsWith('gl_'))
            {
                if (!(global && redeclaresBuiltin(declarator.name, type, storage, q)))
                {
                    fail(declarator.at, `'${declarator.name}' : identifiers starting with`
                        + ' "gl_" are reserved');
                }
                const symbol = /** @type {VariableSymbol} */ (builtinSymbol(declarator.name));
                symbol.type = type;
                symbol.qualifiers = variableQualifiers(q, layout);
                if (q.invariant)
                {
                    symbol.invariant = true;
                }
                checked.push({ symbol, initializer: null });
                continue;
            }
            /** @type {VariableSymbol} */
            const symbol = {
                kind: 'variable', name: declarator.name, type,
                storage: global ? storage ?? 'global' : storage === 'const' ? 'const' : 'local',
                id: nextId++, global, at: declarator.at,
                constant: storage === 'const' ? initializer?.constant ?? null : null,
                invariant: q.invariant, initializer,
            };
            if (modern)
            {
                symbol.qualifiers = variableQualifiers(q, layout);
            }
            scope.set(declarator.name, { kind: 'variable', symbol });
            if (global)
            {
                unit.globals.set(declarator.name, symbol);
            }
            checked.push({ symbol, initializer });
        }
        return checked;
    }

    /**
     * A declared array's type: an unsized dimension sized by its initializer,
     * by the stage (a geometry input by the primitive, a tessellation input by
     * gl_MaxPatchVertices, a control output by its vertices), or an error.
     *
     * @param {any} declarator @param {any} decl @param {GlslType} base @param {any[]} dims
     * @param {string | null} storage @param {ParsedQualifiers} q
     * @returns {GlslType}
     */
    function declaredArray(declarator, decl, base, dims, storage, q){
        const unsized = dims.indexOf('unsized');
        if (unsized < 0)
        {
            return wrap(base, dims, declarator.at);
        }
        if (unsized > 0)
        {
            fail(declarator.at, `'${declarator.name}' : only the outermost dimension may be`
                + ' unsized');
        }
        if (dims.length === 1 && declarator.name === 'gl_TexCoord')
        {
            return builtinTable.gl_TexCoord?.type ?? base;
        }
        if (dims.length === 1 && (declarator.name === 'gl_ClipDistance'
            || declarator.name === 'gl_CullDistance'))
        {
            return builtinTable[declarator.name]?.type ?? base;
        }
        const inner = wrap(base, dims.slice(1), declarator.at);
        const perVertexInput = storage === 'in' && !q.patch && (stage === 'geometry'
            || stage === 'tessControl' || stage === 'tessEvaluation');
        if (perVertexInput)
        {
            if (stage === 'geometry')
            {
                const primitive = Object.keys(unit.layouts.input).find(k=>GS_INPUTS.has(k));
                return arrayOf(inner, primitive ? /** @type {number} */ (GS_INPUTS.get(primitive))
                    : 0);
            }
            return arrayOf(inner, Number(constants.gl_MaxPatchVertices));
        }
        if (storage === 'out' && stage === 'tessControl' && !q.patch)
        {
            const vertices = unit.layouts.output.vertices;
            return arrayOf(inner, typeof vertices === 'number' ? vertices : 0);
        }
        const init = declarator.initializer
            ? declarator.initializer.node === 'list'
                ? fromList(declarator.initializer, arrayOf(inner, 0))
                : expr(declarator.initializer) : null;
        if (!init || init.type.kind !== 'array')
        {
            fail(declarator.at, `'${declarator.name}' : an unsized array needs`
                + ' an initializer of a sized array');
        }
        return arrayOf(inner, init.type.length);
    }

    /**
     * What each storage takes (sections 4.3.4 to 4.3.8): an attribute or a
     * varying a float of 1.x's shapes, an input or output no bool or opaque
     * value, a fragment output no matrix or struct, an integer input or
     * output between stages `flat`, an opaque value only a uniform.
     *
     * @param {any} declarator @param {GlslType} type @param {string | null} storage
     * @param {ParsedQualifiers} q @param {Layout} layout
     */
    function checkStorageType(declarator, type, storage, q, layout){
        const name = declarator.name;
        if (storage === 'attribute' && !((type.kind === 'scalar' && type.base === 'float')
            || (type.kind === 'vector' && type.base === 'float') || type.kind === 'matrix'))
        {
            fail(declarator.at, `'${name}' : an attribute must be a float,`
                + ' a floating-point vector or a matrix');
        }
        if (storage === 'varying' && !isVaryingType(type))
        {
            fail(declarator.at, `'${name}' : a varying must be a float, a`
                + ' floating-point vector, a matrix or an array of them');
        }
        if (holdsSampler(type) && storage !== 'uniform')
        {
            fail(declarator.at, `'${name}' : a sampler must be a uniform or`
                + ' a function parameter');
        }
        if (holdsOpaque(type) && storage !== 'uniform')
        {
            fail(declarator.at, `'${name}' : an ${glslName(innermost(type))} must be a uniform`
                + ' or a function parameter');
        }
        if ((storage === 'attribute' || storage === 'varying' || storage === 'in'
            || storage === 'out' || storage === 'shared') && declarator.initializer)
        {
            fail(declarator.at, `'${name}' : cannot initialize this type of`
                + ' qualifier');
        }
        if (storage === 'uniform' && declarator.initializer && version < 120)
        {
            fail(declarator.at, `'${name}' : a uniform initializer needs`
                + ' version 120');
        }
        if (storage === 'uniform' && declarator.initializer && holdsOpaque(type))
        {
            fail(declarator.at, `'${name}' : an opaque uniform cannot be initialized`);
        }
        if (storage === 'in' || storage === 'out')
        {
            const leaf = innermost(type);
            if (leaf.kind === 'scalar' && leaf.base === 'bool'
                || leaf.kind === 'vector' && leaf.base === 'bool')
            {
                fail(declarator.at, `'${name}' : an input or output cannot be a boolean`);
            }
            if (storage === 'in' && stage === 'vertex' && (leaf.kind === 'struct'))
            {
                fail(declarator.at, `'${name}' : a vertex input cannot be a structure`);
            }
            if (storage === 'out' && stage === 'fragment' && (leaf.kind === 'matrix'
                || leaf.kind === 'struct' || baseOf(leaf) === 'double'))
            {
                fail(declarator.at, `'${name}' : a fragment output must be a scalar or a vector`
                    + ' of float, int or uint');
            }
            const integer = baseOf(leaf) === 'int' || baseOf(leaf) === 'uint'
                || baseOf(leaf) === 'double';
            if (integer && q.interpolation !== 'flat' && ((storage === 'in'
                && stage === 'fragment') || (storage === 'out' && stage === 'vertex'
                && version < 150)))
            {
                fail(declarator.at, `'${name}' : an integer or double ${storage === 'in'
                    ? 'fragment input' : 'vertex output'} must be qualified flat`);
            }
            const arrayed = type.kind === 'array';
            if (!q.patch && !arrayed && ((storage === 'in' && (stage === 'geometry'
                || stage === 'tessControl' || stage === 'tessEvaluation'))
                || (storage === 'out' && stage === 'tessControl')))
            {
                fail(declarator.at, `'${name}' : a per-vertex ${storage === 'in' ? 'input'
                    : 'output'} of this stage must be an array`);
            }
            if (storage === 'in' && stage === 'compute' || storage === 'out'
                && stage === 'compute')
            {
                fail(declarator.at, `'${name}' : a compute shader has no inputs or outputs`);
            }
        }
        const leaf = innermost(type);
        if (storage === 'uniform' && leaf.kind === 'image' && !holdsImageFormat(layout)
            && !q.memory.includes('writeonly'))
        {
            fail(declarator.at, `'${name}' : an image not writeonly needs a format`
                + ' layout qualifier');
        }
        if (storage === 'uniform' && leaf.kind === 'image')
        {
            const format = Object.keys(layout).find(k=>IMAGE_FORMATS.has(k));
            if (format && IMAGE_FORMATS.get(format) !== leaf.sampled)
            {
                fail(declarator.at, `'${format}' : the format does not match the image's type`);
            }
        }
        if (leaf.kind !== 'image' && q.memory.length > 0 && storage !== 'buffer')
        {
            fail(declarator.at, `'${q.memory[0]}' : only an image or a buffer takes a memory`
                + ' qualifier');
        }
        if (storage === 'uniform' && leaf.kind === 'atomic' && typeof layout.binding !== 'number')
        {
            fail(declarator.at, `'${name}' : an atomic counter needs a binding`);
        }
    }

    /** @param {Layout} layout */
    const holdsImageFormat = layout=>Object.keys(layout).some(k=>IMAGE_FORMATS.has(k));

    /**
     * Whether a declaration of a `gl_` name is one the language allows: a
     * built-in output or input given a size, invariance, an interpolation or
     * a layout again (sections 7.1.1 and 4.4).
     *
     * @param {string} name @param {GlslType} type @param {string | null} storage
     * @param {ParsedQualifiers} q
     */
    function redeclaresBuiltin(name, type, storage, q){
        const builtin = builtinTable[name];
        if (!builtin)
        {
            return false;
        }
        const role = builtin.role;
        const fits = storage === 'varying' || (storage === 'in' && role === 'in')
            || (storage === 'out' && role === 'out')
            || (storage === 'in' && role === 'attribute');
        if (!fits)
        {
            return false;
        }
        if (name === 'gl_TexCoord' || name === 'gl_ClipDistance' || name === 'gl_CullDistance')
        {
            return type.kind === 'array' && builtin.type.kind === 'array'
                && type.element === builtin.type.element
                && type.length <= builtin.type.length;
        }
        if (q.layout.length > 0 && !(name === 'gl_FragCoord' || name === 'gl_FragDepth'))
        {
            return false;
        }
        return type === builtin.type;
    }

    /** @param {GlslType} type @returns {boolean} */
    function isVaryingType(type){
        if (type.kind === 'array')
        {
            return isVaryingType(type.element);
        }
        return (type.kind === 'scalar' || type.kind === 'vector') && type.base === 'float'
            || type.kind === 'matrix';
    }

    /**
     * An interface block (section 4.3.9): its members, its layout and the
     * stage's defaults for it, its instance or the globals its members are.
     *
     * @param {any} decl
     */
    function block(decl){
        /** @type {ParsedQualifiers} */
        const q = decl.qualifiers;
        const storage = /** @type {'uniform' | 'buffer' | 'in' | 'out'} */ (q.storage);
        if (storage === 'uniform' && !language.has('uniformBlocks'))
        {
            fail(decl.at, "'uniform' : a uniform block needs version 140");
        }
        if ((storage === 'in' || storage === 'out') && !language.has('ioBlocks'))
        {
            fail(decl.at, `'${storage}' : an input or output block needs version 150`);
        }
        if (storage !== 'uniform' && storage !== 'buffer' && storage !== 'in'
            && storage !== 'out')
        {
            fail(decl.at, `'${storage}' : not a storage a block may have`);
        }
        if ((storage === 'in' && stage === 'vertex') || (storage === 'out'
            && stage === 'fragment') || ((storage === 'in' || storage === 'out')
            && stage === 'compute'))
        {
            fail(decl.at, `'${storage}' : this stage has no ${storage === 'in' ? 'input'
                : 'output'} blocks`);
        }
        const layout = layoutOf(q);
        const what = storage === 'uniform' ? 'blockUniform' : storage === 'buffer'
            ? 'blockBuffer' : storage === 'in' ? 'blockIn' : 'blockOut';
        checkLayout(layout, decl.at, what);
        const blockDefaults = storage === 'uniform' ? unit.layouts.uniform
            : storage === 'buffer' ? unit.layouts.buffer : undefined;
        /** @type {Layout} */
        const effective = { ...(blockDefaults ?? {}) };
        // A block's own packing or order replaces the default's (section 4.4.5).
        if (Object.keys(layout).some(k=>PACKINGS.has(k)))
        {
            for (const k of PACKINGS)
            {
                delete effective[k];
            }
        }
        if (Object.keys(layout).some(k=>MATRIX_ORDERS.has(k)))
        {
            for (const k of MATRIX_ORDERS)
            {
                delete effective[k];
            }
        }
        Object.assign(effective, layout);
        if ((storage === 'uniform' || storage === 'buffer')
            && !Object.keys(effective).some(k=>PACKINGS.has(k)))
        {
            effective.shared = true;
        }
        if ((storage === 'uniform' || storage === 'buffer')
            && !Object.keys(effective).some(k=>MATRIX_ORDERS.has(k)))
        {
            effective.column_major = true;
        }
        const perVertex = decl.name === 'gl_PerVertex';
        if (decl.name.startsWith('gl_') && !perVertex)
        {
            fail(decl.nameAt, `'${decl.name}' : identifiers starting with "gl_" are reserved`);
        }
        /** @type {InterfaceBlock['members']} */
        const members = [];
        const builtinPerVertex = perVertex ? perVertexOf(language, constants) : null;
        decl.members.forEach((/** @type {any} */ member, /** @type {number} */ m)=>{
            /** @type {ParsedQualifiers} */
            const mq = member.qualifiers;
            if (mq.storage && mq.storage !== storage)
            {
                fail(mq.at, `'${mq.storage}' : a member takes its block's storage`);
            }
            const memberLayout = layoutOf(mq);
            checkLayout(memberLayout, mq.at, 'member');
            if (mq.memory.length > 0 && storage !== 'buffer')
            {
                fail(mq.at, `'${mq.memory[0]}' : only a buffer block's member takes a memory`
                    + ' qualifier');
            }
            const base = elementType(member.type);
            for (const declarator of member.declarators)
            {
                const dims = [...declarator.arrays, ...member.type.arrays];
                const last = m === decl.members.length - 1
                    && declarator === member.declarators[member.declarators.length - 1];
                const runtime = storage === 'buffer' && last && dims[0] === 'unsized';
                if (dims.includes('unsized') && !runtime && !(perVertex
                    && (declarator.name === 'gl_ClipDistance'
                        || declarator.name === 'gl_CullDistance')))
                {
                    fail(declarator.at, `'${declarator.name}' : only a buffer block's last member`
                        + ' may be an unsized array');
                }
                let type = runtime ? arrayOf(wrap(base, dims.slice(1), declarator.at), 0)
                    : dims.includes('unsized')
                        ? /** @type {GlslType} */ (builtinPerVertex?.fields.find(f=>f.name
                            === declarator.name)?.type ?? base)
                        : wrap(base, dims, declarator.at);
                if (holdsOpaque(type))
                {
                    fail(declarator.at, `'${declarator.name}' : a block member cannot be`
                        + ` an ${glslName(innermost(type))}`);
                }
                if (type.kind === 'void')
                {
                    fail(declarator.at, `'${declarator.name}' : illegal use of type 'void'`);
                }
                if (members.some(x=>x.name === declarator.name))
                {
                    fail(declarator.at, `'${declarator.name}' : redefinition of a block member`);
                }
                if (perVertex)
                {
                    const declared = builtinPerVertex?.fields.find(f=>f.name === declarator.name);
                    if (!declared || (declared.type !== type && !(declared.type.kind === 'array'
                        && type.kind === 'array' && declared.type.element === type.element)))
                    {
                        fail(declarator.at, `'${declarator.name}' : not a member of`
                            + ' gl_PerVertex');
                    }
                }
                /** @type {Layout} */
                const own = { ...memberLayout };
                if (!Object.keys(own).some(k=>MATRIX_ORDERS.has(k)))
                {
                    if (effective.row_major)
                    {
                        own.row_major = true;
                    }
                    else if (effective.column_major)
                    {
                        own.column_major = true;
                    }
                }
                members.push({ name: declarator.name, type, layout: own,
                    qualifiers: variableQualifiers(mq, own) });
            }
        });
        /** @type {StructType} */
        const type = Object.freeze({ kind: 'struct', name: decl.name, id: nextId++,
            fields: members.map(x=>({ name: x.name, type: x.type })) });
        /** @type {InterfaceBlock} */
        const info = { name: decl.name, instance: decl.instance?.name ?? null, storage, type,
            arrays: [], layout: effective, members, perVertex, at: decl.at, laid: null };
        const packing = effective.std430 ? 'std430' : effective.std140 ? 'std140' : null;
        const placed = members.some(m=>m.layout.offset !== undefined
            || m.layout.align !== undefined);
        if (placed && !packing && (storage === 'uniform' || storage === 'buffer'))
        {
            fail(decl.at, "'offset' : a member is placed only in a std140 or std430 block");
        }
        if (packing)
        {
            try
            {
                info.laid = blockLayout(members.map(m=>({ name: m.name, type: m.type,
                    rowMajor: !!m.layout.row_major,
                    offset: typeof m.layout.offset === 'number' ? m.layout.offset : undefined,
                    align: typeof m.layout.align === 'number' ? m.layout.align : undefined })),
                packing);
            }
            catch (e){
                if (!(e instanceof RangeError))
                {
                    throw e;
                }
                fail(decl.at, e.message);
            }
        }
        if (unit.blocks.some(b=>b.name === decl.name && b.storage === storage))
        {
            fail(decl.nameAt, `'${decl.name}' : redefinition of a block`);
        }
        unit.blocks.push(info);
        if (decl.instance)
        {
            const instance = decl.instance;
            let instanceType = /** @type {GlslType} */ (type);
            const arrayed = instance.arrays.length > 0;
            if (arrayed)
            {
                const per = (storage === 'in' && ['geometry', 'tessControl', 'tessEvaluation']
                    .includes(stage)) || (storage === 'out' && stage === 'tessControl');
                instanceType = per && instance.arrays[0] === 'unsized'
                    ? declaredArray(instance, { type: { arrays: [] } }, type, instance.arrays,
                        storage, q)
                    : wrap(type, instance.arrays, instance.at,
                        storage === 'buffer' ? null : null);
                info.arrays = sizesOf(instanceType);
            }
            if (perVertex)
            {
                const name = instance.name;
                if (name !== 'gl_in' && name !== 'gl_out')
                {
                    fail(instance.at, `'${name}' : gl_PerVertex is redeclared as gl_in or`
                        + ' gl_out only');
                }
                const symbol = /** @type {VariableSymbol} */ (builtinSymbol(name));
                if (!symbol)
                {
                    fail(instance.at, `'${name}' : not available in the ${stage} shader`);
                }
                symbol.block = info;
                return;
            }
            const scope = scopes[0];
            if (scope.has(instance.name))
            {
                fail(instance.at, `'${instance.name}' : redefinition`);
            }
            /** @type {VariableSymbol} */
            const symbol = { kind: 'variable', name: instance.name, type: instanceType, storage,
                id: nextId++, global: true, at: instance.at, constant: null, initializer: null,
                block: info, qualifiers: variableQualifiers(q, effective) };
            scope.set(instance.name, { kind: 'variable', symbol });
            unit.globals.set(instance.name, symbol);
            return;
        }
        if (perVertex)
        {
            return;
        }
        for (const member of members)
        {
            const scope = scopes[0];
            if (scope.has(member.name))
            {
                fail(decl.at, `'${member.name}' : redefinition`);
            }
            /** @type {VariableSymbol} */
            const symbol = { kind: 'variable', name: member.name, type: member.type, storage,
                id: nextId++, global: true, at: decl.at, constant: null, initializer: null,
                block: info, qualifiers: member.qualifiers };
            scope.set(member.name, { kind: 'variable', symbol });
            unit.globals.set(member.name, symbol);
        }
    }

    /** @param {GlslType} type @returns {number[]} an array type's dimensions, outermost first */
    function sizesOf(type){
        /** @type {number[]} */
        const out = [];
        while (type.kind === 'array')
        {
            out.push(type.length);
            type = type.element;
        }
        return out;
    }

    /**
     * `layout(...) in;` and the like (section 4.4): the stage's primitives,
     * sizes and modes, or the defaults later blocks take.
     *
     * @param {any} decl
     */
    function defaults(decl){
        /** @type {ParsedQualifiers} */
        const q = decl.qualifiers;
        const storage = q.storage;
        const layout = layoutOf(q);
        if (Object.keys(layout).length === 0)
        {
            fail(decl.at, `'${storage}' : syntax error, a declaration needs a name`);
        }
        if (storage === 'uniform' || storage === 'buffer')
        {
            checkLayout(layout, decl.at, storage === 'uniform' ? 'defaultsUniform'
                : 'defaultsBuffer');
            const into = unit.layouts[storage] ??= {};
            if (Object.keys(layout).some(k=>PACKINGS.has(k)))
            {
                for (const k of PACKINGS)
                {
                    delete into[k];
                }
            }
            if (Object.keys(layout).some(k=>MATRIX_ORDERS.has(k)))
            {
                for (const k of MATRIX_ORDERS)
                {
                    delete into[k];
                }
            }
            Object.assign(into, layout);
            return;
        }
        if (storage !== 'in' && storage !== 'out')
        {
            fail(decl.at, `'${storage}' : a layout declaration takes in, out, uniform or`
                + ' buffer');
        }
        checkLayout(layout, decl.at, storage === 'in' ? 'defaultsIn' : 'defaultsOut');
        const into = storage === 'in' ? unit.layouts.input : unit.layouts.output;
        for (const [name, value] of Object.entries(layout))
        {
            const previous = into[name];
            if (previous !== undefined && previous !== value)
            {
                fail(decl.at, `'${name}' : declared again with a different value`);
            }
            const exclusive = stage === 'geometry' && storage === 'in' ? GS_INPUTS
                : stage === 'geometry' ? GS_OUTPUTS : stage === 'tessEvaluation'
                    ? (TES_MODES.has(name) ? TES_MODES : TES_SPACING.has(name) ? TES_SPACING
                        : null) : null;
            if (exclusive && /** @type {any} */ (exclusive).has(name)
                && Object.keys(into).some(k=>k !== name && /** @type {any} */ (exclusive).has(k)))
            {
                fail(decl.at, `'${name}' : a different primitive was declared already`);
            }
            into[name] = value;
        }
        if (stage === 'geometry' && storage === 'out' && typeof into.max_vertices === 'number'
            && into.max_vertices > Number(constants.gl_MaxGeometryOutputVertices))
        {
            fail(decl.at, "'max_vertices' : more than gl_MaxGeometryOutputVertices");
        }
        if (stage === 'compute')
        {
            const limit = /** @type {number[]} */ (constants.gl_MaxComputeWorkGroupSize);
            ['local_size_x', 'local_size_y', 'local_size_z'].forEach((k, axis)=>{
                const value = into[k];
                if (typeof value === 'number' && (value === 0 || value > limit[axis]))
                {
                    fail(decl.at, `'${k}' : must be 1 to ${limit[axis]}`);
                }
            });
        }
    }

    /**
     * `subroutine uniform T name;` (section 4.3.9): a uniform naming which
     * function of a subroutine type a call through it takes.
     *
     * @param {any} decl
     * @returns {any[]}
     */
    function subroutineUniform(decl){
        /** @type {ParsedQualifiers} */
        const q = decl.qualifiers;
        if (!language.has('subroutine'))
        {
            return fail(decl.at, "'subroutine' : needs version 400");
        }
        const typeName = decl.type.structName ?? decl.type.at.text;
        if (!unit.subroutineTypes.has(typeName))
        {
            fail(decl.type.at, `'${typeName}' : not a subroutine type`);
        }
        const layout = layoutOf(q);
        checkLayout(layout, decl.at, 'subroutine');
        /** @type {any[]} */
        const checked = [];
        for (const declarator of decl.declarators)
        {
            /** @type {VariableSymbol} */
            const symbol = { kind: 'variable', name: declarator.name, type: VOID,
                storage: 'uniform', id: nextId++, global: true, at: declarator.at,
                constant: null, initializer: null, subroutine: typeName,
                qualifiers: variableQualifiers(q, layout) };
            if (scopes[0].has(declarator.name))
            {
                fail(declarator.at, `'${declarator.name}' : redefinition`);
            }
            scopes[0].set(declarator.name, { kind: 'variable', symbol });
            unit.globals.set(declarator.name, symbol);
            checked.push({ symbol, initializer: null });
        }
        return checked;
    }

    // --- statements ---

    /** @param {any} node @returns {any} */
    function statement(node){
        switch (node.node)
        {
            case 'block': {
                scopes.push(new Map());
                const body = node.body.map(statement);
                scopes.pop();
                return { ...node, body };
            }
            case 'declaration': {
                const decl = node.declaration;
                if (decl.node === 'empty')
                {
                    return decl;
                }
                if (decl.node === 'invariant' || decl.node === 'precise')
                {
                    if (decl.node === 'invariant')
                    {
                        fail(decl.at, "'invariant' : only allowed at global scope");
                    }
                    for (const name of decl.names)
                    {
                        const found = lookup(name.text);
                        if (found?.kind !== 'variable')
                        {
                            fail(name, `'${name.text}' : undeclared identifier`);
                        }
                        /** @type {any} */ (found).symbol.precise = true;
                    }
                    return { node: 'empty', at: decl.at };
                }
                if (decl.node === 'block' || decl.node === 'defaults')
                {
                    fail(decl.at, `'${decl.qualifiers.storage}' : only allowed at global scope`);
                }
                return { node: 'declaration', at: node.at, declarators: variables(decl, false) };
            }
            case 'expression':
                return { ...node, expr: expr(node.expr) };
            case 'if': {
                const test = condition(node.test, 'if');
                control++;
                scopes.push(new Map());
                const then = statement(node.then);
                scopes.pop();
                scopes.push(new Map());
                const otherwise = node.otherwise ? statement(node.otherwise) : null;
                scopes.pop();
                control--;
                return { ...node, test, then, otherwise };
            }
            case 'for': {
                scopes.push(new Map());
                const init = node.init.node === 'variables'
                    ? { node: 'declaration', at: node.init.at,
                        declarators: variables(node.init, false) }
                    : statement(node.init);
                const test = node.test ? condition(node.test, 'for') : null;
                const update = node.update ? expr(node.update) : null;
                loops++;
                control++;
                const body = statement(node.body);
                control--;
                loops--;
                scopes.pop();
                return { ...node, init, test, update, body };
            }
            case 'while': {
                scopes.push(new Map());
                const test = condition(node.test, 'while');
                loops++;
                control++;
                scopes.push(new Map());
                const body = statement(node.body);
                scopes.pop();
                control--;
                loops--;
                scopes.pop();
                return { ...node, test, body };
            }
            case 'do': {
                loops++;
                control++;
                scopes.push(new Map());
                const body = statement(node.body);
                scopes.pop();
                control--;
                loops--;
                return { ...node, body, test: condition(node.test, 'do') };
            }
            case 'switch':
                return switchStatement(node);
            case 'case':
            case 'default':
                return fail(node.at, `'${node.node}' : only allowed in a switch`);
            case 'return': {
                const fn = /** @type {UserFunction} */ (current);
                if (fn.name === 'main' && control === 0)
                {
                    returned = true;
                }
                if (!node.value)
                {
                    if (fn.returns !== VOID)
                    {
                        fail(node.at, "'return' : non-void function must return a value");
                    }
                    return node;
                }
                let value = expr(node.value);
                if (fn.returns === VOID)
                {
                    fail(node.at, "'return' : void function cannot return a value");
                }
                if (value.type !== fn.returns)
                {
                    if (!convertible(value.type, fn.returns, language))
                    {
                        fail(node.at, "'return' : function return is not matching type");
                    }
                    value = convertTo(value, fn.returns);
                }
                return { ...node, value };
            }
            case 'break':
                if (loops === 0 && switches === 0)
                {
                    fail(node.at, `'${node.node}' : statement only allowed in loops`);
                }
                return node;
            case 'continue':
                if (loops === 0)
                {
                    fail(node.at, `'${node.node}' : statement only allowed in loops`);
                }
                return node;
            case 'discard':
                if (stage !== 'fragment')
                {
                    fail(node.at, stage === 'vertex' ? "'discard' : not supported in vertex"
                        + ' shaders' : "'discard' : supported in fragment shaders only");
                }
                return node;
            case 'empty':
                return node;
            default:
                return fail(node.at, 'syntax error');
        }
    }

    /**
     * A switch (section 6.2): an integer selector, constant labels of its
     * type, no label twice, one default, a label before the first statement
     * and a statement after the last label.
     *
     * @param {any} node
     */
    function switchStatement(node){
        const test = expr(node.test);
        if (test.type !== INT && test.type !== UINT)
        {
            fail(node.at, "'switch' : the selector must be a scalar integer");
        }
        if (node.body.length > 0 && node.body[0].node !== 'case'
            && node.body[0].node !== 'default')
        {
            fail(node.body[0].at, "'switch' : a statement before the first case label");
        }
        const last = node.body[node.body.length - 1];
        if (last && (last.node === 'case' || last.node === 'default'))
        {
            fail(last.at, `'${last.node}' : a label must be followed by a statement`);
        }
        const seen = new Set();
        let sawDefault = false;
        switches++;
        control++;
        scopes.push(new Map());
        const body = node.body.map((/** @type {any} */ item)=>{
            if (item.node === 'case')
            {
                let value = expr(item.value);
                if (!value.constant || (value.type !== INT && value.type !== UINT))
                {
                    fail(item.at, "'case' : the label must be a constant integer expression");
                }
                if (value.type !== test.type)
                {
                    if (!convertible(value.type, test.type, language))
                    {
                        fail(item.at, "'case' : the label's type is not the selector's");
                    }
                    value = convertTo(value, test.type);
                }
                const key = value.constant[0];
                if (seen.has(key))
                {
                    fail(item.at, `'case' : the label ${key} is used twice`);
                }
                seen.add(key);
                return { node: 'case', at: item.at, value };
            }
            if (item.node === 'default')
            {
                if (sawDefault)
                {
                    fail(item.at, "'default' : used twice in one switch");
                }
                sawDefault = true;
                return item;
            }
            return statement(item);
        });
        scopes.pop();
        control--;
        switches--;
        return { node: 'switch', at: node.at, test, body };
    }

    /** @param {any} node @param {string} what */
    function condition(node, what){
        if (node.node === 'condition')
        {
            const type = resolve(node.type);
            let value = expr(node.value);
            if (value.type !== type && convertible(value.type, type, language))
            {
                value = convertTo(value, type);
            }
            if (type !== BOOL || value.type !== BOOL)
            {
                fail(node.at, `'${what}' : the condition must be a scalar boolean expression`);
            }
            /** @type {VariableSymbol} */
            const symbol = { kind: 'variable', name: node.name.text, type, storage: 'local',
                id: nextId++, global: false, at: node.name, constant: null };
            scopes[scopes.length - 1].set(node.name.text, { kind: 'variable', symbol });
            return { node: 'condition', at: node.at, symbol, value, type: BOOL, constant: null };
        }
        const test = expr(node);
        if (test.type !== BOOL)
        {
            fail(node.at, `'${what}' : the condition must be a scalar boolean expression`);
        }
        return test;
    }

    // --- the unit ---

    /** @param {any} decl */
    function functionDecl(decl){
        const returns = resolve(decl.returnType);
        if ((returns.kind === 'array' && !modern) || holdsSampler(returns)
            || holdsOpaque(returns))
        {
            fail(decl.at, `'${decl.name}' : a function cannot return a sampler or an array`);
        }
        if (decl.name.startsWith('gl_'))
        {
            fail(decl.at, `'${decl.name}' : identifiers starting with "gl_" are reserved`);
        }
        const builtin = modern ? modernOverloads(decl.name, language).length > 0
            : BUILTIN_FUNCTIONS.has(decl.name)
                || extensionOverloads(decl.name, language).length > 0;
        if (version >= 120 && version < 400 && builtin)
        {
            fail(decl.at, `'${decl.name}' : a built-in function cannot be redefined or`
                + ' overloaded');
        }
        const params = decl.params.map((/** @type {any} */ p)=>{
            let type = resolve(p.type);
            if (p.arrays.length > 0)
            {
                if (p.arrays.includes('unsized'))
                {
                    fail(p.at, 'a parameter array needs a size');
                }
                type = wrap(type, p.arrays, p.at);
            }
            if (type.kind === 'void')
            {
                fail(p.at, "'void' : illegal use of type 'void'");
            }
            if (holdsSampler(type) && p.direction !== 'in')
            {
                fail(p.at, 'a sampler parameter cannot be out or inout');
            }
            if (p.memory?.length > 0 && innermost(type).kind !== 'image')
            {
                fail(p.at, `'${p.memory[0]}' : only an image parameter takes a memory qualifier`);
            }
            return { name: p.name, type, direction: p.direction, constant: p.constant, at: p.at,
                memory: p.memory ?? [] };
        });
        const key = `${decl.name}(${params.map((/** @type {any} */ p)=>glslName(p.type))
            .join(',')})`;
        /** @type {ParsedQualifiers | undefined} */
        const q = decl.qualifiers;
        if (q?.subroutine && !language.has('subroutine'))
        {
            fail(decl.at, "'subroutine' : needs version 400");
        }
        if (q?.subroutine && q.subroutine.length === 0 && !decl.body)
        {
            // A subroutine type: a name for a signature (section 6.1.2).
            if (unit.subroutineTypes.has(decl.name) || scopes[0].has(decl.name))
            {
                fail(decl.at, `'${decl.name}' : redefinition`);
            }
            unit.subroutineTypes.set(decl.name, {
                kind: 'user', name: decl.name, key,
                params: params.map((/** @type {any} */ p)=>({ name: p.name, type: p.type,
                    direction: p.direction, symbol: null })),
                returns, body: null, calls: new Set(), uses: new Set(), at: decl.at,
            });
            return;
        }
        const global = scopes[0];
        let entry = global.get(decl.name);
        if (entry && entry.kind !== 'functions')
        {
            fail(decl.at, `'${decl.name}' : redefinition`);
        }
        if (!entry)
        {
            entry = { kind: 'functions', list: [] };
            global.set(decl.name, entry);
        }
        if (decl.name === 'main' && (params.length > 0 || returns !== VOID))
        {
            fail(decl.at, "'main' : must be declared as void main()");
        }
        let fn = entry.list.find(f=>f.key === key);
        if (fn)
        {
            if (fn.returns !== returns)
            {
                fail(decl.at, `'${decl.name}' : overloaded functions must have the same`
                    + ' return type');
            }
            if (modern && fn.params.some((p, k)=>p.direction !== params[k].direction))
            {
                fail(decl.at, `'${decl.name}' : redeclared with different parameter qualifiers`);
            }
            if (fn.body && decl.body)
            {
                fail(decl.at, `'${decl.name}' : function already has a body`);
            }
        }
        else
        {
            fn = {
                kind: 'user', name: decl.name, key,
                params: params.map((/** @type {any} */ p)=>({ name: p.name, type: p.type,
                    direction: p.direction, symbol: null })),
                returns, body: null, calls: new Set(), uses: new Set(), at: decl.at,
            };
            entry.list.push(fn);
            unit.functions.push(fn);
        }
        if (q?.subroutine && q.subroutine.length > 0)
        {
            for (const named of q.subroutine)
            {
                const type = unit.subroutineTypes.get(named.text);
                if (!type)
                {
                    fail(named, `'${named.text}' : not a subroutine type`);
                }
                if (type.returns !== returns || type.params.length !== params.length
                    || type.params.some((p, k)=>p.type !== params[k].type
                        || p.direction !== params[k].direction))
                {
                    fail(decl.at, `'${decl.name}' : does not match subroutine type`
                        + ` '${named.text}'`);
                }
            }
            if (entry.list.length > 1)
            {
                fail(decl.at, `'${decl.name}' : a subroutine function cannot be overloaded`);
            }
            fn.subroutines = q.subroutine.map(t=>t.text);
            // 4.30's explicit index of a subroutine function (section 4.4.4).
            const index = /** @type {Record<string, any>} */ (layoutOf(q)).index;
            if (typeof index === 'number')
            {
                fn.subroutineIndex = index;
            }
        }
        if (!decl.body)
        {
            return;
        }
        const defined = /** @type {UserFunction} */ (fn);
        // A definition's parameters are its own, as named here.
        defined.params = params.map((/** @type {any} */ p)=>({ name: p.name, type: p.type,
            direction: p.direction, symbol: null }));
        current = defined;
        returned = false;
        scopes.push(new Map());
        params.forEach((/** @type {any} */ p, /** @type {number} */ k)=>{
            if (p.name === null)
            {
                return;
            }
            if (scopes[scopes.length - 1].has(p.name))
            {
                fail(p.at, `'${p.name}' : redefinition`);
            }
            /** @type {VariableSymbol} */
            const symbol = { kind: 'variable', name: p.name, type: p.type, storage: 'param',
                id: nextId++, global: false, at: p.at, direction: p.direction,
                readonly: p.constant };
            if (p.memory.length > 0)
            {
                symbol.qualifiers = { interpolation: null, centroid: false, sample: false,
                    patch: false, precise: false, memory: new Set(p.memory), layout: {} };
            }
            defined.params[k].symbol = symbol;
            scopes[scopes.length - 1].set(p.name, { kind: 'variable', symbol });
        });
        defined.body = { node: 'block', at: decl.body.at,
            body: decl.body.body.map(statement) };
        scopes.pop();
        current = null;
    }

    for (const decl of ast.decls)
    {
        switch (decl.node)
        {
            case 'variables':
                if (decl.declarators.length === 0)
                {
                    // A struct declared on its own.
                    elementType(decl.type);
                    break;
                }
                variables(decl, true);
                break;
            case 'function':
                functionDecl(decl);
                break;
            case 'block':
                block(decl);
                break;
            case 'defaults':
                defaults(decl);
                break;
            case 'invariant':
            case 'precise':
                for (const name of decl.names)
                {
                    const found = lookup(name.text);
                    const symbol = found?.kind === 'variable' ? found.symbol
                        : builtinSymbol(name.text);
                    if (decl.node === 'precise')
                    {
                        if (!symbol)
                        {
                            fail(name, `'${name.text}' : undeclared identifier`);
                        }
                        /** @type {any} */ (symbol).precise = true;
                        continue;
                    }
                    const out = symbol && (symbol.storage === 'varying' || symbol.storage === 'out'
                        || symbol.builtin?.role === 'out' || symbol.builtin?.role === 'in'
                        || (symbol.storage === 'in' && stage !== 'vertex' && version < 420));
                    if (!out)
                    {
                        fail(name, `'${name.text}' : only a varying can be made invariant`);
                    }
                    /** @type {VariableSymbol} */ (symbol).invariant = true;
                }
                break;
            default:
                break;
        }
    }
    if (modern && stage === 'fragment')
    {
        fragmentOutputRules();
    }
    return unit;

    /**
     * A fragment shader writes gl_FragColor, gl_FragData or its own outputs,
     * not two of them (section 7.1.5).
     */
    function fragmentOutputRules(){
        const color = unit.builtins.get('gl_FragColor');
        const data = unit.builtins.get('gl_FragData');
        const own = [...unit.globals.values()].find(s=>s.storage === 'out');
        const usedColor = color && unit.functions.some(f=>f.uses.has(color));
        const usedData = data && unit.functions.some(f=>f.uses.has(data));
        if (usedColor && usedData)
        {
            fail(/** @type {any} */ ({ string: 0, line: 1 }), "'gl_FragColor' : a shader cannot"
                + ' write both gl_FragColor and gl_FragData');
        }
        if (own && (usedColor || usedData))
        {
            fail(own.at, `'${own.name}' : a shader cannot write both gl_FragColor or`
                + ' gl_FragData and its own outputs');
        }
    }
}
