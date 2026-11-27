/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A SPIR-V module's entry point written as GLSL 4.60 (ARB_gl_spirv, OpenGL
 * 4.6 section 7.2.1), which the GLSL front end then compiles and the rest of
 * the pipeline links and draws as it does any GLSL shader.
 *
 * - **Interfaces are by location, not name** (the extension's section
 *   7.4.spv): a variable between stages is the member `v` of a block named
 *   by its location and component (`_L2c0`), the same name in both stages,
 *   so the linker's matching of blocks by name is matching by location; a
 *   vertex input is `_a<location>`, a fragment output `_f<location>i<index>`.
 *   A uniform is named by its location (`_l<location>`), a sampler or image
 *   by its binding (`_t<binding>`), a block by its binding (`_U<binding>`,
 *   `_B<binding>` for storage), an atomic counter by its binding and offset:
 *   the stages of a program then name one resource alike (decision A230).
 * - **Built-ins are GLSL's**: a variable or block member with a BuiltIn
 *   decoration is the gl_ variable of its name; gl_PerVertex arrays are
 *   gl_in and gl_out.
 * - **A block's members keep their offsets** (`layout(offset)`), and their
 *   strides must be std140's or std430's, which the module says by its
 *   ArrayStride and MatrixStride decorations: one the rules do not give is
 *   refused.
 * - **Values are variables**: each result id of a function is a variable
 *   declared at the function's top and assigned where the module computes
 *   it, so a value used past the construct it was made in is still in
 *   scope; an OpPhi is assigned by each predecessor before its branch.
 *   Pointers and opaque values (an image, a sampled image) are the
 *   expression they name instead.
 * - **Control flow is the module's structure** (SPIR-V 1.0 section 2.11): a
 *   selection is an if or a switch, a loop a `while (true)` whose continue
 *   construct runs at its top from the second iteration on, guarded by a
 *   flag, so that a branch to the continue target is `continue`. A break
 *   out of a loop from inside a switch sets the loop's flag and leaves each
 *   enclosing switch.
 * - **What is not taken is said**: a capability, a storage class, an
 *   instruction or a construct this does not write fails the lift with its
 *   reason, which is the shader's compile log.
 */

import { Decoration, Op } from './spirv-module.js';

/** OpEntryPoint's execution models (section 3.3), by the stage each is. */
export const EXECUTION_MODELS = Object.freeze({
    vertex: 0, tessControl: 1, tessEvaluation: 2, geometry: 3, fragment: 4, compute: 5,
});

/**
 * The capabilities a module for OpenGL may declare that this takes (section
 * 3.31; the OpenGL SPIR-V execution environment's list, less what nothing
 * here writes: 64-bit integers, 16-bit floats, variable pointers).
 */
const CAPABILITIES = new Set([0, 1, 2, 3, 10, 21, 23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34,
    35, 36, 37, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 56, 57]);

/** The names of capabilities a module may declare and this does not take, for the log. */
const CAPABILITY_NAMES = new Map([[4, 'Addresses'], [5, 'Linkage'], [6, 'Kernel'],
    [8, 'Float16Buffer'], [9, 'Float16'], [11, 'Int64'], [12, 'Int64Atomics'], [22, 'Int16'],
    [39, 'Int8'], [40, 'InputAttachment'], [41, 'SparseResidency'], [42, 'MinLod'],
    [55, 'StorageImageReadWithoutFormat'],
    [4427, 'DrawParameters']]);

/** The storage classes (section 3.7). */
const Storage = Object.freeze({
    UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Workgroup: 4, Private: 6,
    Function: 7, PushConstant: 9, AtomicCounter: 10, Image: 11, StorageBuffer: 12,
});

/** The built-ins (section 3.21), by GLSL's names; an input's where the two differ. */
const BUILTINS = new Map([[0, 'gl_Position'], [1, 'gl_PointSize'], [3, 'gl_ClipDistance'],
    [4, 'gl_CullDistance'], [5, 'gl_VertexID'], [6, 'gl_InstanceID'], [7, 'gl_PrimitiveID'],
    [8, 'gl_InvocationID'], [9, 'gl_Layer'], [10, 'gl_ViewportIndex'],
    [11, 'gl_TessLevelOuter'], [12, 'gl_TessLevelInner'], [13, 'gl_TessCoord'],
    [14, 'gl_PatchVerticesIn'], [15, 'gl_FragCoord'], [16, 'gl_PointCoord'],
    [17, 'gl_FrontFacing'], [18, 'gl_SampleID'], [19, 'gl_SamplePosition'],
    [20, 'gl_SampleMask'], [22, 'gl_FragDepth'], [23, 'gl_HelperInvocation'],
    [24, 'gl_NumWorkGroups'], [25, 'gl_WorkGroupSize'], [26, 'gl_WorkGroupID'],
    [27, 'gl_LocalInvocationID'], [28, 'gl_GlobalInvocationID'],
    [29, 'gl_LocalInvocationIndex'], [4424, 'gl_BaseVertex'], [4425, 'gl_BaseInstance'],
    [4426, 'gl_DrawID']]);

/** GLSL.std.450's instructions (its specification, section 2), by number: GLSL's name. */
const STD450 = new Map([[1, 'round'], [2, 'roundEven'], [3, 'trunc'], [4, 'abs'], [5, 'abs'],
    [6, 'sign'], [7, 'sign'], [8, 'floor'], [9, 'ceil'], [10, 'fract'], [11, 'radians'],
    [12, 'degrees'], [13, 'sin'], [14, 'cos'], [15, 'tan'], [16, 'asin'], [17, 'acos'],
    [18, 'atan'], [19, 'sinh'], [20, 'cosh'], [21, 'tanh'], [22, 'asinh'], [23, 'acosh'],
    [24, 'atanh'], [25, 'atan'], [26, 'pow'], [27, 'exp'], [28, 'log'], [29, 'exp2'],
    [30, 'log2'], [31, 'sqrt'], [32, 'inversesqrt'], [33, 'determinant'], [34, 'inverse'],
    [37, 'min'], [38, 'min'], [39, 'min'], [40, 'max'], [41, 'max'], [42, 'max'],
    [43, 'clamp'], [44, 'clamp'], [45, 'clamp'], [46, 'mix'], [48, 'step'],
    [49, 'smoothstep'], [50, 'fma'], [53, 'ldexp'], [54, 'packSnorm4x8'],
    [55, 'packUnorm4x8'], [56, 'packSnorm2x16'], [57, 'packUnorm2x16'], [58, 'packHalf2x16'],
    [59, 'packDouble2x32'], [60, 'unpackSnorm2x16'], [61, 'unpackUnorm2x16'],
    [62, 'unpackHalf2x16'], [63, 'unpackSnorm4x8'], [64, 'unpackUnorm4x8'],
    [65, 'unpackDouble2x32'], [66, 'length'], [67, 'distance'], [68, 'cross'],
    [69, 'normalize'], [70, 'faceforward'], [71, 'reflect'], [72, 'refract'], [73, 'findLSB'],
    [74, 'findMSB'], [75, 'findMSB'], [79, 'min'], [80, 'max'], [81, 'clamp']]);
/** The GLSL.std.450 instructions whose operands are signed and unsigned integers. */
const STD450_SIGNED = new Set([5, 7, 39, 42, 45, 74]);
const STD450_UNSIGNED = new Set([38, 41, 44, 75]);

/** The image formats (section 3.11), by GLSL's layout qualifier. */
const IMAGE_FORMATS = ['', 'rgba32f', 'rgba16f', 'r32f', 'rgba8', 'rgba8_snorm', 'rg32f',
    'rg16f', 'r11f_g11f_b10f', 'r16f', 'rgba16', 'rgb10_a2', 'rg16', 'rg8', 'r16', 'r8',
    'rgba16_snorm', 'rg16_snorm', 'rg8_snorm', 'r16_snorm', 'r8_snorm', 'rgba32i', 'rgba16i',
    'rgba8i', 'r32i', 'rg32i', 'rg16i', 'rg8i', 'r16i', 'r8i', 'rgba32ui', 'rgba16ui',
    'rgba8ui', 'r32ui', 'rgb10_a2ui', 'rg32ui', 'rg16ui', 'rg8ui', 'r16ui', 'r8ui'];

/** An image's dimensions (section 3.8), by GLSL's sampler and image suffix. */
const DIMS = ['1D', '2D', '3D', 'Cube', '2DRect', 'Buffer'];

/** The image operands' bits (section 3.14). */
const ImageOperand = Object.freeze({ Bias: 0x1, Lod: 0x2, Grad: 0x4, ConstOffset: 0x8,
    Offset: 0x10, ConstOffsets: 0x20, Sample: 0x40, MinLod: 0x80 });

/**
 * @typedef {Object} TypeInfo
 * @property {'void' | 'scalar' | 'vector' | 'matrix' | 'array' | 'runtime' | 'struct'
 *     | 'pointer' | 'image' | 'sampledImage' | 'function'} kind
 * @property {string} [base]  a scalar, vector or matrix's: bool, int, uint, float, double
 * @property {number} [size]  a vector's components
 * @property {number} [cols] @property {number} [rows]
 * @property {number} [element]  an array's, a vector's or a matrix's column type
 * @property {number} [length]  an array's length's id
 * @property {number[]} [members]  a struct's member types
 * @property {number} [storage] @property {number} [pointee]  a pointer's
 * @property {number} [image]  a sampled image's image type
 * @property {{ sampled: number, dim: number, depth: number, arrayed: number, ms: number,
 *     usage: number, format: number }} [shape]  an image's
 */

/** Why a lift stopped: its message is the compile log's. */
class LiftError extends Error {}

/**
 * @param {string} message @returns {never}
 */
const refuse = message=>{
    throw new LiftError(message);
};

/**
 * The SpecIds a module's specialization constants have (section 3.20).
 *
 * @param {import('./spirv-module.js').SpirvModule} module
 * @returns {Set<number>}
 */
export function specIdsOf(module){
    /** @type {Set<number>} */
    const ids = new Set();
    for (const id of module.order)
    {
        const op = module.globals.get(id)?.op;
        const specId = module.decorations.get(id)?.get(Decoration.SpecId);
        if (specId && (op === Op.SpecConstant || op === Op.SpecConstantTrue
            || op === Op.SpecConstantFalse))
        {
            ids.add(specId[0]);
        }
    }
    return ids;
}

/**
 * The entry point `name` of `stage` written as GLSL 4.60, its
 * specialization constants given the values `constants` holds by SpecId.
 *
 * @param {import('./spirv-module.js').SpirvModule} module
 * @param {{ entry: string, stage: keyof typeof EXECUTION_MODELS,
 *     constants: Map<number, number> }} options
 * @returns {{ ok: true, source: string } | { ok: false, log: string }}
 */
export function liftSpirv(module, options){
    try
    {
        return { ok: true, source: lift(module, options) };
    }
    catch (e){
        if (e instanceof LiftError)
        {
            return { ok: false, log: `ERROR: SPIR-V: ${e.message}\n` };
        }
        throw e;
    }
}

/**
 * @param {import('./spirv-module.js').SpirvModule} module
 * @param {{ entry: string, stage: keyof typeof EXECUTION_MODELS,
 *     constants: Map<number, number> }} options
 * @returns {string}
 */
function lift(module, options){
    const model = EXECUTION_MODELS[options.stage];
    const entry = module.entryPoints.find(e=>e.name === options.entry && e.model === model);
    if (!entry)
    {
        refuse(`no entry point '${options.entry}' of the shader's stage`);
    }
    for (const capability of module.capabilities)
    {
        if (!CAPABILITIES.has(capability))
        {
            refuse(`capability ${CAPABILITY_NAMES.get(capability) ?? capability} is not taken`);
        }
    }
    // GL_NUM_SPIR_V_EXTENSIONS is zero: a module that needs one is not taken.
    for (const extension of module.extensions)
    {
        refuse(`the SPIR-V extension ${extension} is not taken`);
    }
    for (const [id, set] of module.imports)
    {
        if (set !== 'GLSL.std.450')
        {
            refuse(`the extended instruction set '${set}' (id ${id}) is not taken`);
        }
    }
    const stage = options.stage;

    // --- decorations and types ---

    /** @param {number} id @param {number} decoration @returns {number[] | undefined} */
    const dec = (id, decoration)=>module.decorations.get(id)?.get(decoration);
    /**
     * @param {number} struct @param {number} member @param {number} decoration
     * @returns {number[] | undefined}
     */
    const memberDec = (struct, member, decoration)=>module.memberDecorations.get(struct)
        ?.get(member)?.get(decoration);

    /** @type {Map<number, TypeInfo>} */
    const types = new Map();
    /** @param {number} id @returns {TypeInfo} */
    const info = id=>{
        const known = types.get(id);
        if (known)
        {
            return known;
        }
        const ins = module.globals.get(id);
        if (!ins)
        {
            return refuse(`type ${id} is not declared`);
        }
        const o = ins.operands;
        /** @type {TypeInfo} */
        let made;
        switch (ins.op)
        {
            case Op.TypeVoid:
                made = { kind: 'void' };
                break;
            case Op.TypeBool:
                made = { kind: 'scalar', base: 'bool' };
                break;
            case Op.TypeInt:
                if (o[0] !== 32)
                {
                    refuse(`a ${o[0]}-bit integer is not taken`);
                }
                made = { kind: 'scalar', base: o[1] ? 'int' : 'uint' };
                break;
            case Op.TypeFloat:
                if (o[0] !== 32 && o[0] !== 64)
                {
                    refuse(`a ${o[0]}-bit float is not taken`);
                }
                made = { kind: 'scalar', base: o[0] === 64 ? 'double' : 'float' };
                break;
            case Op.TypeVector:
                made = { kind: 'vector', base: info(o[0]).base, size: o[1], element: o[0] };
                break;
            case Op.TypeMatrix:
                made = { kind: 'matrix', base: info(o[0]).base, cols: o[1],
                    rows: info(o[0]).size, element: o[0] };
                break;
            case Op.TypeArray:
                made = { kind: 'array', element: o[0], length: o[1] };
                break;
            case Op.TypeRuntimeArray:
                made = { kind: 'runtime', element: o[0] };
                break;
            case Op.TypeStruct:
                made = { kind: 'struct', members: Array.from(o) };
                break;
            case Op.TypePointer:
                made = { kind: 'pointer', storage: o[0], pointee: o[1] };
                break;
            case Op.TypeImage:
                made = { kind: 'image', shape: { sampled: o[0], dim: o[1], depth: o[2],
                    arrayed: o[3], ms: o[4], usage: o[5], format: o[6] } };
                break;
            case Op.TypeSampledImage:
                made = { kind: 'sampledImage', image: o[0] };
                break;
            case Op.TypeFunction:
                made = { kind: 'function' };
                break;
            case Op.TypeSampler:
                return refuse('a separate sampler (OpTypeSampler) is not OpenGL\'s');
            default:
                return refuse(`type opcode ${ins.op} is not taken`);
        }
        types.set(id, made);
        return made;
    };

    // --- constants ---

    /** @type {Map<number, number>} a scalar constant's value, specialized */
    const constants = new Map();
    /** @param {number} id @returns {number} */
    const constantValue = id=>{
        const value = constants.get(id);
        if (value === undefined)
        {
            return refuse(`id ${id} is not a scalar constant`);
        }
        return value;
    };
    /** The words of a constant as its type's value. @param {number} type @param {number[]} words */
    const valueOf = (type, words)=>{
        const base = info(type).base;
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, words[0] >>> 0, true);
        view.setUint32(4, (words[1] ?? 0) >>> 0, true);
        switch (base)
        {
            case 'float':
                return view.getFloat32(0, true);
            case 'double':
                return view.getFloat64(0, true);
            case 'int':
                return view.getInt32(0, true);
            default:
                return view.getUint32(0, true);
        }
    };

    /** @param {number} value @param {string} base @returns {string} */
    const literal = (value, base)=>{
        switch (base)
        {
            case 'bool':
                return value ? 'true' : 'false';
            case 'int':
                return value === -2147483648 ? 'int(0x80000000u)' : `${value}`;
            case 'uint':
                return `${value >>> 0}u`;
            default: {
                if (!Number.isFinite(value))
                {
                    const bits = Number.isNaN(value) ? '0x7fc00000u'
                        : value > 0 ? '0x7f800000u' : '0xff800000u';
                    return base === 'double' ? `double(uintBitsToFloat(${bits}))`
                        : `uintBitsToFloat(${bits})`;
                }
                let text = Object.is(value, -0) ? '-0.0' : String(value);
                if (!/[.e]/.test(text))
                {
                    text += '.0';
                }
                return base === 'double' ? `${text}lf` : text;
            }
        }
    };

    // --- names of types ---

    /** @param {number} id @returns {string} */
    const typeName = id=>{
        const t = info(id);
        switch (t.kind)
        {
            case 'void':
                return 'void';
            case 'scalar':
                return /** @type {string} */ (t.base);
            case 'vector':
                return `${{ bool: 'b', int: 'i', uint: 'u', float: '', double: 'd' }[
                    /** @type {string} */ (t.base)]}vec${t.size}`;
            case 'matrix': {
                const shape = t.cols === t.rows ? `${t.cols}` : `${t.cols}x${t.rows}`;
                return `${t.base === 'double' ? 'd' : ''}mat${shape}`;
            }
            case 'array':
            case 'runtime': {
                /** @type {string[]} */
                const dims = [];
                let at = id;
                while (info(at).kind === 'array' || info(at).kind === 'runtime')
                {
                    const a = info(at);
                    dims.push(a.kind === 'runtime' ? '' : lengthText(/** @type {number} */ (
                        a.length)));
                    at = /** @type {number} */ (a.element);
                }
                return `${typeName(at)}${dims.map(d=>`[${d}]`).join('')}`;
            }
            case 'struct':
                return `_S${id}`;
            case 'sampledImage':
                return samplerName(/** @type {number} */ (t.image), true);
            case 'image':
                return samplerName(id, false);
            default:
                return refuse(`a ${t.kind} has no GLSL type`);
        }
    };
    /** @param {number} id @returns {string} */
    const lengthText = id=>{
        const ins = module.globals.get(id);
        return ins && (ins.op === Op.Constant) ? `${constantValue(id)}` : `_k${id}`;
    };
    /**
     * A sampler's or an image's GLSL type.
     *
     * @param {number} imageType @param {boolean} sampled
     */
    const samplerName = (imageType, sampled)=>{
        const shape = /** @type {NonNullable<TypeInfo['shape']>} */ (info(imageType).shape);
        const base = info(shape.sampled).base;
        const prefix = base === 'int' ? 'i' : base === 'uint' ? 'u' : '';
        if (shape.dim > 5)
        {
            refuse(`an image of dimension ${shape.dim} is not OpenGL's`);
        }
        const shadow = sampled && shape.depth === 1 ? 'Shadow' : '';
        return `${prefix}${sampled ? 'sampler' : 'image'}${DIMS[shape.dim]}`
            + `${shape.ms ? 'MS' : ''}${shape.arrayed ? 'Array' : ''}${shadow}`;
    };
    /**
     * A type with its base changed, its shape kept (a scalar or a vector).
     *
     * @param {number} id @param {string} base @returns {string}
     */
    const withBase = (id, base)=>{
        const t = info(id);
        if (t.kind === 'vector')
        {
            return `${{ bool: 'b', int: 'i', uint: 'u', float: '', double: 'd' }[base]}`
                + `vec${t.size}`;
        }
        return base;
    };

    /** @param {number} id @returns {string} */
    const zeroOf = id=>{
        const t = info(id);
        switch (t.kind)
        {
            case 'scalar':
                return literal(0, /** @type {string} */ (t.base));
            case 'vector':
            case 'matrix':
                return `${typeName(id)}(${literal(0, /** @type {string} */ (t.base))})`;
            case 'array': {
                const n = constantValue(/** @type {number} */ (t.length));
                const element = zeroOf(/** @type {number} */ (t.element));
                return `${typeName(id)}(${Array.from({ length: n }, ()=>element).join(', ')})`;
            }
            case 'struct':
                return `${typeName(id)}(${(t.members ?? []).map(zeroOf).join(', ')})`;
            default:
                return refuse(`a null ${t.kind} is not taken`);
        }
    };

    // --- the module's globals ---

    /** @type {Map<number, number>} every id's type */
    const typeOf = new Map();
    /** @type {Map<number, string>} what an id is in GLSL: a name or an expression */
    const code = new Map();
    /** @type {string[]} */
    const declarations = [];
    /** @type {string[]} the module's layout lines */
    const layouts = [];
    /** @type {Set<number>} the struct types a block is, never declared as structs */
    const blockStructs = new Set();

    /**
     * A struct's members, each laid where its Offset says, refused where a
     * stride is not what `packing`'s rules give (std140 or std430).
     *
     * @param {number} struct @param {boolean} withOffsets
     * @returns {string}
     */
    const memberLines = (struct, withOffsets)=>{
        const t = info(struct);
        return (t.members ?? []).map((member, k)=>{
            /** @type {string[]} */
            const qualifiers = [];
            const offset = memberDec(struct, k, Decoration.Offset);
            if (withOffsets && offset)
            {
                qualifiers.push(`offset = ${offset[0]}`);
            }
            if (memberDec(struct, k, Decoration.RowMajor))
            {
                qualifiers.push('row_major');
            }
            const builtin = memberDec(struct, k, Decoration.BuiltIn);
            if (builtin)
            {
                refuse('a block of built-ins is not a uniform or storage block');
            }
            const words = [];
            if (memberDec(struct, k, Decoration.NonWritable))
            {
                words.push('readonly');
            }
            if (memberDec(struct, k, Decoration.NonReadable))
            {
                words.push('writeonly');
            }
            if (memberDec(struct, k, Decoration.Coherent))
            {
                words.push('coherent');
            }
            if (memberDec(struct, k, Decoration.Volatile))
            {
                words.push('volatile');
            }
            if (memberDec(struct, k, Decoration.Restrict))
            {
                words.push('restrict');
            }
            return `    ${qualifiers.length > 0 ? `layout(${qualifiers.join(', ')}) ` : ''}`
                + `${words.map(w=>`${w} `).join('')}${declarator(member, `m${k}`)};`;
        }).join('\n');
    };

    /**
     * A declaration's type and name, an array's dimensions after the name
     * as GLSL writes a run-time sized one.
     *
     * @param {number} type @param {string} name
     */
    const declarator = (type, name)=>{
        const t = info(type);
        if (t.kind === 'array' || t.kind === 'runtime')
        {
            /** @type {string[]} */
            const dims = [];
            let at = type;
            while (info(at).kind === 'array' || info(at).kind === 'runtime')
            {
                const a = info(at);
                dims.push(a.kind === 'runtime' ? '' : lengthText(/** @type {number} */ (
                    a.length)));
                at = /** @type {number} */ (a.element);
            }
            return `${typeName(at)} ${name}${dims.map(d=>`[${d}]`).join('')}`;
        }
        return `${typeName(type)} ${name}`;
    };

    /** The interface variables of the entry point. */
    const interfaceIds = new Set(entry.interface);

    /**
     * How a variable of the stage's interface is reached: its name, and
     * whether its first index is an array of vertices or invocations (a
     * geometry or tessellation stage's arrayed inputs and outputs).
     *
     * @type {Map<number, { base: string, member: string, arrayed: boolean,
     *     builtinBlock: boolean }>}
     */
    const io = new Map();

    /** @param {number} storage */
    const isArrayedIo = storage=>(storage === Storage.Input
        && (stage === 'geometry' || stage === 'tessControl' || stage === 'tessEvaluation'))
        || (storage === Storage.Output && stage === 'tessControl');

    /** The interpolation and auxiliary qualifiers of a variable or a member. @param {Map<number, number[]> | undefined} decorations */
    const auxiliary = decorations=>{
        if (!decorations)
        {
            return '';
        }
        return [[Decoration.Flat, 'flat '], [Decoration.NoPerspective, 'noperspective '],
            [Decoration.Centroid, 'centroid '], [Decoration.Sample, 'sample '],
            [Decoration.Patch, 'patch ']]
            .filter(([d])=>decorations.has(/** @type {number} */ (d))).map(([, w])=>w).join('');
    };

    /**
     * The memory qualifiers a variable's decorations give it, each with a
     * space after it.
     *
     * @param {Map<number, number[]> | undefined} decorations
     */
    const accessWords = decorations=>[[Decoration.Coherent, 'coherent '],
        [Decoration.Volatile, 'volatile '], [Decoration.Restrict, 'restrict '],
        [Decoration.NonWritable, 'readonly '], [Decoration.NonReadable, 'writeonly ']]
        .filter(([d])=>decorations?.has(/** @type {number} */ (d))).map(([, w])=>w).join('');

    /**
     * Declares a variable of the module's global scope.
     *
     * @param {import('./spirv-module.js').Instruction} ins
     */
    const declareVariable = ins=>{
        const id = ins.id;
        const pointer = info(ins.type);
        const storage = /** @type {number} */ (pointer.storage);
        const type = /** @type {number} */ (pointer.pointee);
        typeOf.set(id, ins.type);
        const decorations = module.decorations.get(id);
        const binding = dec(id, Decoration.Binding)?.[0];
        const location = dec(id, Decoration.Location)?.[0];
        const set = dec(id, Decoration.DescriptorSet)?.[0];
        if (set !== undefined && set !== 0)
        {
            refuse('a descriptor set other than 0 is not OpenGL\'s');
        }
        switch (storage)
        {
            case Storage.Input:
            case Storage.Output: {
                if (!interfaceIds.has(id))
                {
                    // Not this entry point's: another stage's in the module.
                    code.set(id, `_x${id}`);
                    return;
                }
                declareInterface(id, storage, type, decorations, location);
                return;
            }
            case Storage.UniformConstant: {
                const inner = innermost(type);
                const kind = info(inner).kind;
                if (kind === 'sampledImage' || kind === 'image')
                {
                    const shape = kind === 'image' ? info(inner).shape
                        : info(/** @type {number} */ (info(inner).image)).shape;
                    if (kind === 'image' && shape?.usage !== 2)
                    {
                        refuse('an image to sample with no sampler (a texture apart from its'
                            + ' sampler) is not OpenGL\'s');
                    }
                    const name = `_t${binding ?? `i${id}`}`;
                    /** @type {string[]} */
                    const qualifiers = [];
                    if (binding !== undefined)
                    {
                        qualifiers.push(`binding = ${binding}`);
                    }
                    if (location !== undefined)
                    {
                        qualifiers.push(`location = ${location}`);
                    }
                    if (kind === 'image')
                    {
                        const format = IMAGE_FORMATS[shape?.format ?? 0];
                        if (format)
                        {
                            qualifiers.push(format);
                        }
                    }
                    const words = accessWords(decorations);
                    declarations.push(`${qualifiers.length > 0 ? `layout(${qualifiers.join(', ')}) `
                        : ''}uniform ${words}${declarator(type, name)};`);
                    code.set(id, name);
                    return;
                }
                if (location === undefined)
                {
                    refuse('a default uniform without a location is not OpenGL SPIR-V\'s');
                }
                const name = `_l${location}`;
                const initializer = ins.operands[1] ? ` = ${constantText(ins.operands[1])}` : '';
                declarations.push(`layout(location = ${location}) uniform ${declarator(type, name)}`
                    + `${initializer};`);
                code.set(id, name);
                return;
            }
            case Storage.Uniform:
            case Storage.StorageBuffer: {
                const struct = innermost(type);
                const buffer = storage === Storage.StorageBuffer
                    || !!dec(struct, Decoration.BufferBlock);
                if (!dec(struct, Decoration.Block) && !dec(struct, Decoration.BufferBlock))
                {
                    refuse('a uniform that is not a block');
                }
                blockStructs.add(struct);
                const block = buffer ? `_B${binding}` : `_U${binding}`;
                const instance = buffer ? `_b${binding}` : `_u${binding}`;
                const dims = declarator(type, instance).slice(typeName(struct).length + 1);
                const words = accessWords(decorations);
                // A storage block's strides may be std430's or std140's; a
                // uniform block's only std140's (GLSL 4.60 section 4.4.5).
                /** @type {'std140' | 'std430'} */
                let packing = 'std140';
                if (buffer)
                {
                    try
                    {
                        checkStrides(struct, 'std430');
                        packing = 'std430';
                    }
                    catch (e){
                        if (!(e instanceof LiftError))
                        {
                            throw e;
                        }
                    }
                }
                if (packing === 'std140')
                {
                    checkStrides(struct, 'std140');
                }
                declarations.push(`layout(${packing}, binding = ${binding ?? 0})`
                    + ` ${words}${buffer ? 'buffer' : 'uniform'} ${block} {\n`
                    + `${memberLines(struct, true)}`
                    + `\n} ${dims};`);
                code.set(id, instance);
                return;
            }
            case Storage.AtomicCounter: {
                const offset = dec(id, Decoration.Offset)?.[0] ?? 0;
                const name = `_c${binding ?? 0}o${offset}`;
                // The counter's pointee is a uint; GLSL's type for it is atomic_uint.
                const dims = declarator(type, name).slice(typeName(innermost(type)).length);
                declarations.push(`layout(binding = ${binding ?? 0}, offset = ${offset}) uniform`
                    + ` atomic_uint${dims};`);
                code.set(id, name);
                return;
            }
            case Storage.Workgroup:
                declarations.push(`shared ${declarator(type, `_w${id}`)};`);
                code.set(id, `_w${id}`);
                return;
            case Storage.Private: {
                const initializer = ins.operands[1] ? ` = ${constantText(ins.operands[1])}` : '';
                declarations.push(`${declarator(type, `_p${id}`)}${initializer};`);
                code.set(id, `_p${id}`);
                return;
            }
            case Storage.PushConstant:
                return refuse('push constants are not OpenGL\'s');
            default:
                return refuse(`storage class ${storage} is not taken`);
        }
    };

    /** The type inside a type's arrays. @param {number} type @returns {number} */
    const innermost = type=>{
        let at = type;
        while (info(at).kind === 'array' || info(at).kind === 'runtime')
        {
            at = /** @type {number} */ (info(at).element);
        }
        return at;
    };

    /**
     * Refuses a block whose ArrayStride or MatrixStride decorations differ
     * from what `packing`'s rules give, a member or a nested struct's alike.
     *
     * @param {number} struct @param {'std140' | 'std430'} packing
     */
    const checkStrides = (struct, packing)=>{
        /** @param {number} type @returns {{ align: number, size: number }} */
        const layoutOf = type=>{
            const t = info(type);
            const scalar = t.base === 'double' ? 8 : 4;
            switch (t.kind)
            {
                case 'scalar':
                    return { align: scalar, size: scalar };
                case 'vector': {
                    const n = /** @type {number} */ (t.size);
                    return { align: (n === 2 ? 2 : 4) * scalar, size: n * scalar };
                }
                case 'matrix': {
                    const rows = /** @type {number} */ (t.rows);
                    const column = (rows === 2 ? 2 : 4) * scalar;
                    const stride = packing === 'std140' ? Math.max(column, 16) : column;
                    return { align: stride, size: stride * /** @type {number} */ (t.cols) };
                }
                case 'array':
                case 'runtime': {
                    const element = layoutOf(/** @type {number} */ (t.element));
                    const align = packing === 'std140' ? Math.max(element.align, 16)
                        : element.align;
                    const stride = Math.ceil(element.size / align) * align;
                    const given = dec(type, Decoration.ArrayStride)?.[0];
                    if (given !== undefined && given !== stride)
                    {
                        refuse(`an array stride of ${given}, where ${packing} gives ${stride}`);
                    }
                    const count = t.kind === 'array'
                        ? constantValue(/** @type {number} */ (t.length)) : 1;
                    return { align, size: stride * count };
                }
                case 'struct': {
                    let align = 1;
                    let end = 0;
                    (t.members ?? []).forEach((member, k)=>{
                        const m = layoutOf(member);
                        const matrixStride = memberDec(type, k, Decoration.MatrixStride)?.[0];
                        const mt = info(innermost(member));
                        if (matrixStride !== undefined && mt.kind === 'matrix')
                        {
                            const rowMajor = !!memberDec(type, k, Decoration.RowMajor);
                            const vectors = rowMajor ? mt.cols : mt.rows;
                            const n = (vectors === 2 ? 2 : 4) * (mt.base === 'double' ? 8 : 4);
                            const want = packing === 'std140' ? Math.max(n, 16) : n;
                            if (matrixStride !== want)
                            {
                                refuse(`a matrix stride of ${matrixStride}, where ${packing}`
                                    + ` gives ${want}`);
                            }
                        }
                        align = Math.max(align, m.align);
                        const offset = memberDec(type, k, Decoration.Offset)?.[0]
                            ?? Math.ceil(end / m.align) * m.align;
                        if (type !== struct && offset !== Math.ceil(end / m.align) * m.align)
                        {
                            refuse('a struct in a block whose members lie apart from its'
                                + ` ${packing} places`);
                        }
                        end = offset + m.size;
                    });
                    if (packing === 'std140')
                    {
                        align = Math.max(align, 16);
                    }
                    return { align, size: Math.ceil(end / align) * align };
                }
                default:
                    return refuse(`a ${t.kind} in a block`);
            }
        };
        layoutOf(struct);
    };

    /**
     * Declares one of the stage's inputs or outputs.
     *
     * @param {number} id @param {number} storage @param {number} type
     * @param {Map<number, number[]> | undefined} decorations @param {number | undefined} location
     */
    const declareInterface = (id, storage, type, decorations, location)=>{
        const input = storage === Storage.Input;
        const arrayed = isArrayedIo(storage) && !decorations?.has(Decoration.Patch);
        const inner = arrayed && info(type).kind === 'array'
            ? /** @type {number} */ (info(type).element) : type;
        const builtin = decorations?.get(Decoration.BuiltIn)?.[0];
        if (builtin !== undefined)
        {
            const name = builtinName(builtin, input);
            code.set(id, name);
            io.set(id, { base: name, member: '', arrayed: false, builtinBlock: false });
            return;
        }
        if (info(inner).kind === 'struct' && memberDec(inner, 0, Decoration.BuiltIn))
        {
            // gl_PerVertex: its members are the built-ins of their names.
            io.set(id, { base: arrayed ? input ? 'gl_in' : 'gl_out' : '', member: '',
                arrayed, builtinBlock: true });
            code.set(id, arrayed ? input ? 'gl_in' : 'gl_out' : '');
            return;
        }
        if (location === undefined)
        {
            refuse(`an ${input ? 'input' : 'output'} with no location`);
        }
        const component = decorations?.get(Decoration.Component)?.[0] ?? 0;
        const stream = decorations?.get(Decoration.Stream)?.[0];
        const qualifiers = `location = ${location}${component ? `, component = ${component}` : ''}`
            + `${stream ? `, stream = ${stream}` : ''}`;
        if (stage === 'vertex' && input)
        {
            const name = `_a${location}`;
            declarations.push(`layout(${qualifiers}) in ${declarator(type, name)};`);
            code.set(id, name);
            io.set(id, { base: name, member: '', arrayed: false, builtinBlock: false });
            return;
        }
        if (stage === 'fragment' && !input)
        {
            const index = decorations?.get(Decoration.Index)?.[0] ?? 0;
            const name = `_f${location}i${index}`;
            declarations.push(`layout(${qualifiers}${index ? `, index = ${index}` : ''}) out`
                + ` ${declarator(type, name)};`);
            code.set(id, name);
            io.set(id, { base: name, member: '', arrayed: false, builtinBlock: false });
            return;
        }
        // Between stages: a block named by the location, the same in both.
        const block = `_L${location}c${component}`;
        const instance = `_${input ? 'i' : 'o'}${location}c${component}`;
        const suffix = arrayed ? `[${info(type).kind === 'array' && !(input
            && (stage === 'tessControl' || stage === 'tessEvaluation' || stage === 'geometry'))
            ? lengthText(/** @type {number} */ (info(type).length)) : ''}]` : '';
        const patch = decorations?.has(Decoration.Patch);
        const words = auxiliary(decorations);
        if (info(inner).kind === 'struct' && dec(inner, Decoration.Block))
        {
            blockStructs.add(inner);
            const members = (info(inner).members ?? []).map((member, k)=>
                `    ${auxiliary(module.memberDecorations.get(inner)?.get(k))}`
                + `${declarator(member, `m${k}`)};`).join('\n');
            const streamed = stream ? `, stream = ${stream}` : '';
            declarations.push(`layout(location = ${location}${streamed})`
                + ` ${words}${input ? 'in' : 'out'} ${block} {\n${members}\n}`
                + ` ${instance}${patch ? '' : suffix};`);
            io.set(id, { base: instance, member: '', arrayed: arrayed && !patch,
                builtinBlock: false });
            code.set(id, instance);
            return;
        }
        if (patch)
        {
            // A patch's input or output is one a patch: never arrayed by vertex.
            const name = `_P${location}c${component}`;
            declarations.push(`layout(${qualifiers}) patch ${input ? 'in' : 'out'}`
                + ` ${declarator(type, name)};`);
            code.set(id, name);
            io.set(id, { base: name, member: '', arrayed: false, builtinBlock: false });
            return;
        }
        declarations.push(`layout(${qualifiers}) ${words}${input ? 'in' : 'out'} ${block} {`
            + ` ${declarator(inner, 'v')}; } ${instance}${suffix};`);
        io.set(id, { base: instance, member: '.v', arrayed, builtinBlock: false });
        code.set(id, arrayed ? instance : `${instance}.v`);
    };

    /** @param {number} builtin @param {boolean} input @returns {string} */
    const builtinName = (builtin, input)=>{
        if (builtin === 42 || builtin === 43)
        {
            refuse('VertexIndex and InstanceIndex are not OpenGL\'s');
        }
        if (builtin === 7 && input && stage !== 'fragment')
        {
            return stage === 'geometry' ? 'gl_PrimitiveIDIn' : 'gl_PrimitiveID';
        }
        if (builtin === 20)
        {
            return input ? 'gl_SampleMaskIn' : 'gl_SampleMask';
        }
        const name = BUILTINS.get(builtin);
        if (!name)
        {
            return refuse(`built-in ${builtin} is not taken`);
        }
        return name;
    };

    /**
     * A constant's GLSL text: a named constant, or a literal for an
     * unspecialized scalar.
     *
     * @param {number} id @returns {string}
     */
    const constantText = id=>{
        const known = code.get(id);
        if (known === undefined)
        {
            return refuse(`constant ${id} is not declared before its use`);
        }
        return known;
    };

    /** The SpecId-specialized value of a spec constant's words. @param {number} id @param {number[]} words */
    const specialized = (id, words)=>{
        const specId = dec(id, Decoration.SpecId)?.[0];
        const given = specId === undefined ? undefined : options.constants.get(specId);
        return given === undefined ? words : [given];
    };

    /** @type {number[] | null} the work group size a WorkgroupSize constant gives */
    let workGroupSize = null;
    /** @type {{ at: number, ins: import('./spirv-module.js').Instruction }[]} */
    const pendingSpecOps = [];

    /**
     * An OpSpecConstantOp's value where its operands are scalar constants
     * known here and its opcode an integer or a logical one; undefined
     * otherwise (it is then a GLSL constant expression only).
     *
     * @param {number} op @param {number[]} ids @param {string | undefined} base
     * @returns {number | undefined}
     */
    const foldSpecOp = (op, ids, base)=>{
        const literalOps = op === Op.VectorShuffle || op === Op.CompositeExtract
            || op === Op.CompositeInsert;
        if (literalOps || !ids.every(i=>constants.has(i)) || base === 'float' || base === 'double')
        {
            return undefined;
        }
        const v = ids.map(i=>/** @type {number} */ (constants.get(i)));
        const s = v.map(x=>x | 0);
        const u = v.map(x=>x >>> 0);
        const signed = base === 'int';
        /** @param {number | boolean} x */
        const fit = x=>(base === 'bool' ? (x ? 1 : 0) : signed ? Number(x) | 0 : Number(x) >>> 0);
        switch (op)
        {
            case Op.SNegate: return fit(-s[0]);
            case Op.Not: return fit(~u[0]);
            case Op.IAdd: return fit(u[0] + u[1]);
            case Op.ISub: return fit(u[0] - u[1]);
            case Op.IMul: return fit(Math.imul(u[0], u[1]));
            case Op.UDiv: return u[1] ? fit(Math.floor(u[0] / u[1])) : undefined;
            case Op.SDiv: return s[1] ? fit(Math.trunc(s[0] / s[1])) : undefined;
            case Op.UMod: return u[1] ? fit(u[0] % u[1]) : undefined;
            case Op.SRem: return s[1] ? fit(s[0] % s[1]) : undefined;
            case Op.SMod: {
                if (!s[1])
                {
                    return undefined;
                }
                const r = s[0] % s[1];
                return fit(r !== 0 && (r < 0) !== (s[1] < 0) ? r + s[1] : r);
            }
            case Op.ShiftLeftLogical: return fit(u[0] << (u[1] & 31));
            case Op.ShiftRightLogical: return fit(u[0] >>> (u[1] & 31));
            case Op.ShiftRightArithmetic: return fit(s[0] >> (u[1] & 31));
            case Op.BitwiseOr: return fit(u[0] | u[1]);
            case Op.BitwiseXor: return fit(u[0] ^ u[1]);
            case Op.BitwiseAnd: return fit(u[0] & u[1]);
            case Op.LogicalOr: return fit(v[0] || v[1]);
            case Op.LogicalAnd: return fit(v[0] && v[1]);
            case Op.LogicalNot: return fit(!v[0]);
            case Op.LogicalEqual: return fit(!v[0] === !v[1]);
            case Op.LogicalNotEqual: return fit(!v[0] !== !v[1]);
            case Op.Select: return fit(v[0] ? v[1] : v[2]);
            case Op.IEqual: return fit(u[0] === u[1]);
            case Op.INotEqual: return fit(u[0] !== u[1]);
            case Op.ULessThan: return fit(u[0] < u[1]);
            case Op.SLessThan: return fit(s[0] < s[1]);
            case Op.UGreaterThan: return fit(u[0] > u[1]);
            case Op.SGreaterThan: return fit(s[0] > s[1]);
            case Op.ULessThanEqual: return fit(u[0] <= u[1]);
            case Op.SLessThanEqual: return fit(s[0] <= s[1]);
            case Op.UGreaterThanEqual: return fit(u[0] >= u[1]);
            case Op.SGreaterThanEqual: return fit(s[0] >= s[1]);
            case Op.UConvert:
            case Op.SConvert: return fit(v[0]);
            default: return undefined;
        }
    };

    for (const id of module.order)
    {
        const ins = /** @type {import('./spirv-module.js').Instruction} */ (module.globals.get(id));
        const o = Array.from(ins.operands);
        switch (ins.op)
        {
            case Op.TypeStruct:
                info(id);
                continue;
            case Op.Constant:
            case Op.SpecConstant: {
                typeOf.set(id, ins.type);
                const words = ins.op === Op.SpecConstant ? specialized(id, o) : o;
                const value = valueOf(ins.type, words);
                constants.set(id, value);
                const text = literal(value, /** @type {string} */ (info(ins.type).base));
                if (ins.op === Op.SpecConstant)
                {
                    declarations.push(`const ${typeName(ins.type)} _k${id} = ${text};`);
                    code.set(id, `_k${id}`);
                }
                else
                {
                    code.set(id, text);
                }
                continue;
            }
            case Op.ConstantTrue:
            case Op.ConstantFalse:
            case Op.SpecConstantTrue:
            case Op.SpecConstantFalse: {
                typeOf.set(id, ins.type);
                let value = ins.op === Op.ConstantTrue || ins.op === Op.SpecConstantTrue ? 1 : 0;
                if (ins.op === Op.SpecConstantTrue || ins.op === Op.SpecConstantFalse)
                {
                    value = specialized(id, [value])[0] ? 1 : 0;
                    declarations.push(`const bool _k${id} = ${value ? 'true' : 'false'};`);
                    code.set(id, `_k${id}`);
                }
                else
                {
                    code.set(id, value ? 'true' : 'false');
                }
                constants.set(id, value);
                continue;
            }
            case Op.ConstantComposite:
            case Op.SpecConstantComposite: {
                typeOf.set(id, ins.type);
                const parts = o.map(constantText);
                declarations.push(`const ${declarator(ins.type, `_k${id}`)} = ${typeName(ins.type)}`
                    + `(${parts.join(', ')});`);
                code.set(id, `_k${id}`);
                if (dec(id, Decoration.BuiltIn)?.[0] === 25)
                {
                    workGroupSize = o.map(constantValue);
                }
                continue;
            }
            case Op.ConstantNull:
                typeOf.set(id, ins.type);
                if (info(ins.type).kind === 'scalar')
                {
                    constants.set(id, 0);
                }
                declarations.push(`const ${declarator(ins.type, `_k${id}`)}`
                    + ` = ${zeroOf(ins.type)};`);
                code.set(id, `_k${id}`);
                continue;
            case Op.SpecConstantOp: {
                typeOf.set(id, ins.type);
                // Written once the expressions below are defined; its value
                // kept now where it is a scalar's, for a length or a size.
                pendingSpecOps.push({ at: declarations.length, ins });
                declarations.push('');
                code.set(id, `_k${id}`);
                const folded = foldSpecOp(ins.operands[0], Array.from(ins.operands.subarray(1)),
                    /** @type {string | undefined} */ (info(ins.type).base));
                if (folded !== undefined)
                {
                    constants.set(id, folded);
                }
                continue;
            }
            case Op.Variable:
                declareVariable(ins);
                continue;
            case Op.Undef:
                typeOf.set(id, ins.type);
                code.set(id, zeroOf(ins.type));
                continue;
            default:
                info(id);
        }
    }

    /**
     * An OpSpecConstantOp's value as a constant expression.
     *
     * @param {import('./spirv-module.js').Instruction} ins @returns {string}
     */
    function specOp(ins){
        const inner = /** @type {import('./spirv-module.js').Instruction} */ ({
            op: ins.operands[0], type: ins.type, id: ins.id, operands: ins.operands.subarray(1) });
        const text = valueExpression(inner, false);
        if (text === null)
        {
            return refuse(`OpSpecConstantOp of opcode ${inner.op} is not taken`);
        }
        return text;
    }

    // Struct declarations, before everything that names them.
    /** @type {string[]} */
    const structs = [];
    for (const id of module.order)
    {
        const ins = module.globals.get(id);
        if (ins?.op === Op.TypeStruct && !blockStructs.has(id))
        {
            if (memberDec(id, 0, Decoration.BuiltIn))
            {
                continue;
            }
            structs.push(`struct _S${id} {\n${memberLines(id, false)}\n};`);
        }
    }

    // --- the stage's modes ---

    const modes = module.modes.get(entry.id) ?? [];
    /** @param {number} mode */
    const modeOf = mode=>modes.find(m=>m.mode === mode);
    /** @type {string[]} */
    const inputs = [];
    /** @type {string[]} */
    const outputs = [];
    for (const { mode, operands } of modes)
    {
        switch (mode)
        {
            case 0:
                inputs.push(`invocations = ${operands[0]}`);
                break;
            case 1:
                inputs.push('equal_spacing');
                break;
            case 2:
                inputs.push('fractional_even_spacing');
                break;
            case 3:
                inputs.push('fractional_odd_spacing');
                break;
            case 4:
                inputs.push('cw');
                break;
            case 5:
                inputs.push('ccw');
                break;
            case 6:
                layouts.push('layout(pixel_center_integer) in vec4 gl_FragCoord;');
                break;
            case 7:
                layouts.push('layout(origin_upper_left) in vec4 gl_FragCoord;');
                break;
            case 8:
                break;
            case 9:
                layouts.push('layout(early_fragment_tests) in;');
                break;
            case 10:
                inputs.push('point_mode');
                break;
            case 11:
                // As for a GLSL shader's xfb_ qualifiers, which nothing here captures by.
                refuse('transform feedback the shader declares (the Xfb execution mode) is not'
                    + ' taken: name the outputs with glTransformFeedbackVaryings');
                break;
            case 12:
            case 16:
                break;
            case 14:
                layouts.push('layout(depth_greater) out float gl_FragDepth;');
                break;
            case 15:
                layouts.push('layout(depth_less) out float gl_FragDepth;');
                break;
            case 17:
                if (!workGroupSize)
                {
                    workGroupSize = operands;
                }
                break;
            case 19:
                inputs.push('points');
                break;
            case 20:
                inputs.push('lines');
                break;
            case 21:
                inputs.push('lines_adjacency');
                break;
            case 22:
                inputs.push('triangles');
                break;
            case 23:
                inputs.push('triangles_adjacency');
                break;
            case 24:
                inputs.push('quads');
                break;
            case 25:
                inputs.push('isolines');
                break;
            case 26:
                outputs.push(stage === 'tessControl' ? `vertices = ${operands[0]}`
                    : `max_vertices = ${operands[0]}`);
                break;
            case 27:
                outputs.push('points');
                break;
            case 28:
                outputs.push('line_strip');
                break;
            case 29:
                outputs.push('triangle_strip');
                break;
            default:
                refuse(`execution mode ${mode} is not taken`);
        }
    }
    if (modeOf(7) && modeOf(6))
    {
        layouts.splice(layouts.indexOf('layout(origin_upper_left) in vec4 gl_FragCoord;'), 1);
        layouts.splice(layouts.indexOf('layout(pixel_center_integer) in vec4 gl_FragCoord;'), 1,
            'layout(origin_upper_left, pixel_center_integer) in vec4 gl_FragCoord;');
    }
    if (stage === 'compute')
    {
        const size = workGroupSize ?? [1, 1, 1];
        layouts.push(`layout(local_size_x = ${size[0]}, local_size_y = ${size[1] ?? 1},`
            + ` local_size_z = ${size[2] ?? 1}) in;`);
    }
    // A tessellation control shader's primitive modes are its evaluation shader's.
    if (inputs.length > 0 && stage !== 'tessControl')
    {
        layouts.push(`layout(${inputs.join(', ')}) in;`);
    }
    if (outputs.length > 0)
    {
        layouts.push(`layout(${outputs.join(', ')}) out;`);
    }

    // --- expressions ---

    /** @param {number} id @returns {string} */
    const of = id=>{
        const text = code.get(id);
        if (text === undefined)
        {
            return refuse(`id ${id} is used and was never defined`);
        }
        return text;
    };
    /** @param {number} id @returns {TypeInfo} */
    const infoOf = id=>info(/** @type {number} */ (typeOf.get(id)));
    /** @param {number} id @returns {string | undefined} */
    const baseOfId = id=>infoOf(id).base;

    /**
     * An operand converted to a base type of its own shape: an integer of the
     * other signedness or a float, as SPIR-V lets an operand's signedness
     * differ from its instruction's.
     *
     * @param {number} id @param {string} base @returns {string}
     */
    const as = (id, base)=>{
        const own = baseOfId(id);
        if (own === base)
        {
            return of(id);
        }
        return `${withBase(/** @type {number} */ (typeOf.get(id)), base)}(${of(id)})`;
    };
    /**
     * An expression of base `from` as the instruction's result type.
     *
     * @param {string} text @param {string} from @param {number} type @returns {string}
     */
    const result = (text, from, type)=>(info(type).base === from || info(type).kind === 'struct'
        ? text : `${typeName(type)}(${text})`);

    /** The base of an integer instruction's result. @param {number} type */
    const intBase = type=>/** @type {string} */ (info(type).base);

    /**
     * A binary operator over two operands of the result's base.
     *
     * @param {import('./spirv-module.js').Instruction} ins @param {string} op
     * @param {string} [base]  the base the operands are taken as, the result's by default
     */
    const binary = (ins, op, base)=>{
        const b = base ?? intBase(ins.type);
        const text = `(${as(ins.operands[0], b)} ${op} ${as(ins.operands[1], b)})`;
        return result(text, b, ins.type);
    };

    /**
     * A comparison: an operator for scalars, GLSL's function for vectors.
     *
     * @param {import('./spirv-module.js').Instruction} ins @param {string} op
     * @param {string} fn @param {string | null} base  the operands' base, theirs by default
     */
    const compare = (ins, op, fn, base)=>{
        const [a, b] = ins.operands;
        const own = base ?? /** @type {string} */ (baseOfId(a));
        const x = as(a, own);
        const y = as(b, own);
        return infoOf(a).kind === 'vector' ? `${fn}(${x}, ${y})` : `(${x} ${op} ${y})`;
    };

    /**
     * A boolean vector's logical operator, as GLSL has none.
     *
     * @param {import('./spirv-module.js').Instruction} ins @param {string} op
     */
    const logical = (ins, op)=>{
        const [a, b] = ins.operands;
        const t = infoOf(a);
        if (t.kind !== 'vector')
        {
            return `(${of(a)} ${op} ${of(b)})`;
        }
        const u = `uvec${t.size}`;
        const word = op === '&&' ? '&' : '|';
        return `bvec${t.size}(${u}(${of(a)}) ${word} ${u}(${of(b)}))`;
    };

    /**
     * A composite's part by literal indices: a member, an element, a
     * component.
     *
     * @param {string} text @param {number} type @param {number[]} indices
     */
    const extract = (text, type, indices)=>{
        let at = text;
        let t = type;
        for (const index of indices)
        {
            const i = info(t);
            if (i.kind === 'struct')
            {
                at = `${at}.m${index}`;
                t = /** @type {number[]} */ (i.members)[index];
            }
            else
            {
                at = `${at}[${index}]`;
                t = /** @type {number} */ (i.element);
            }
        }
        return at;
    };

    /**
     * An instruction's value as an expression, or null for one that is not a
     * pure value; `inFunction` false for a specialization constant's.
     *
     * @param {import('./spirv-module.js').Instruction} ins @param {boolean} inFunction
     * @returns {string | null}
     */
    function valueExpression(ins, inFunction){
        const o = Array.from(ins.operands);
        const type = ins.type;
        void inFunction;
        switch (ins.op)
        {
            case Op.CopyObject:
                return of(o[0]);
            case Op.SNegate:
                return result(`(-${as(o[0], 'int')})`, 'int', type);
            case Op.FNegate:
                return `(-${of(o[0])})`;
            case Op.Not:
                return result(`(~${of(o[0])})`, /** @type {string} */ (baseOfId(o[0])), type);
            case Op.IAdd:
                return binary(ins, '+');
            case Op.ISub:
                return binary(ins, '-');
            case Op.IMul:
                return binary(ins, '*');
            case Op.UDiv:
                return binary(ins, '/', 'uint');
            case Op.SDiv:
                return binary(ins, '/', 'int');
            case Op.UMod:
                return binary(ins, '%', 'uint');
            case Op.SRem:
                return binary(ins, '%', 'int');
            case Op.SMod: {
                // The sign of the divisor's (section 3.32.13), from the remainder.
                const a = as(o[0], 'int');
                const b = as(o[1], 'int');
                const r = `(${a} - ${b} * (${a} / ${b}))`;
                const t = infoOf(o[0]);
                if (t.kind === 'vector')
                {
                    const iv = `ivec${t.size}`;
                    return result(`(${r} + ${iv}(notEqual(${r}, ${iv}(0)))`
                        + ` * ${iv}(notEqual(lessThan(${r}, ${iv}(0)), lessThan(${b}, ${iv}(0))))`
                        + ` * ${b})`, 'int', type);
                }
                return result(`((${r} != 0 && ((${r} < 0) != (${b} < 0))) ? ${r} + ${b} : ${r})`,
                    'int', type);
            }
            case Op.FAdd:
                return `(${of(o[0])} + ${of(o[1])})`;
            case Op.FSub:
                return `(${of(o[0])} - ${of(o[1])})`;
            case Op.FMul:
                return infoOf(o[0]).kind === 'matrix'
                    ? `matrixCompMult(${of(o[0])}, ${of(o[1])})` : `(${of(o[0])} * ${of(o[1])})`;
            case Op.FDiv:
                return `(${of(o[0])} / ${of(o[1])})`;
            case Op.FMod:
                return `mod(${of(o[0])}, ${of(o[1])})`;
            case Op.FRem:
                return `(${of(o[0])} - ${of(o[1])} * trunc(${of(o[0])} / ${of(o[1])}))`;
            case Op.VectorTimesScalar:
            case Op.MatrixTimesScalar:
            case Op.VectorTimesMatrix:
            case Op.MatrixTimesVector:
            case Op.MatrixTimesMatrix:
                return `(${of(o[0])} * ${of(o[1])})`;
            case Op.OuterProduct:
                return `outerProduct(${of(o[0])}, ${of(o[1])})`;
            case Op.Dot:
                return `dot(${of(o[0])}, ${of(o[1])})`;
            case Op.Transpose:
                return `transpose(${of(o[0])})`;
            case Op.ShiftLeftLogical:
                return result(`(${of(o[0])} << ${of(o[1])})`, /** @type {string} */ (
                    baseOfId(o[0])), type);
            case Op.ShiftRightLogical:
                return result(`(${as(o[0], 'uint')} >> ${of(o[1])})`, 'uint', type);
            case Op.ShiftRightArithmetic:
                return result(`(${as(o[0], 'int')} >> ${of(o[1])})`, 'int', type);
            case Op.BitwiseOr:
                return binary(ins, '|');
            case Op.BitwiseXor:
                return binary(ins, '^');
            case Op.BitwiseAnd:
                return binary(ins, '&');
            case Op.BitFieldInsert:
                return `bitfieldInsert(${of(o[0])}, ${as(o[1], /** @type {string} */ (
                    baseOfId(o[0])))}, ${as(o[2], 'int')}, ${as(o[3], 'int')})`;
            case Op.BitFieldSExtract:
                return result(`bitfieldExtract(${as(o[0], 'int')}, ${as(o[1], 'int')},`
                    + ` ${as(o[2], 'int')})`, 'int', type);
            case Op.BitFieldUExtract:
                return result(`bitfieldExtract(${as(o[0], 'uint')}, ${as(o[1], 'int')},`
                    + ` ${as(o[2], 'int')})`, 'uint', type);
            case Op.BitReverse:
                return `bitfieldReverse(${of(o[0])})`;
            case Op.BitCount:
                return result(`bitCount(${of(o[0])})`, 'int', type);
            case Op.ConvertFToU:
            case Op.ConvertFToS:
            case Op.ConvertSToF:
            case Op.ConvertUToF:
            case Op.FConvert:
            case Op.UConvert:
            case Op.SConvert: {
                const from = ins.op === Op.ConvertSToF || ins.op === Op.SConvert ? 'int'
                    : ins.op === Op.ConvertUToF || ins.op === Op.UConvert ? 'uint' : null;
                return `${typeName(type)}(${from ? as(o[0], from) : of(o[0])})`;
            }
            case Op.QuantizeToF16: {
                const t = infoOf(o[0]);
                const x = of(o[0]);
                if (t.kind === 'vector' && t.size === 2)
                {
                    return `unpackHalf2x16(packHalf2x16(${x}))`;
                }
                if (t.kind !== 'vector')
                {
                    return `unpackHalf2x16(packHalf2x16(vec2(${x}))).x`;
                }
                const lanes = Array.from({ length: /** @type {number} */ (t.size) }, (_, k)=>
                    `unpackHalf2x16(packHalf2x16(vec2(${x}[${k}]))).x`);
                return `${typeName(type)}(${lanes.join(', ')})`;
            }
            case Op.Bitcast:
                return bitcast(o[0], type);
            case Op.Any:
                return `any(${of(o[0])})`;
            case Op.All:
                return `all(${of(o[0])})`;
            case Op.IsNan:
                return `isnan(${of(o[0])})`;
            case Op.IsInf:
                return `isinf(${of(o[0])})`;
            case Op.LogicalEqual:
                return compare(ins, '==', 'equal', null);
            case Op.LogicalNotEqual:
                return compare(ins, '!=', 'notEqual', null);
            case Op.LogicalOr:
                return logical(ins, '||');
            case Op.LogicalAnd:
                return logical(ins, '&&');
            case Op.LogicalNot:
                return infoOf(o[0]).kind === 'vector' ? `not(${of(o[0])})` : `(!${of(o[0])})`;
            case Op.Select: {
                const cond = infoOf(o[0]);
                return cond.kind === 'vector' ? `mix(${of(o[2])}, ${of(o[1])}, ${of(o[0])})`
                    : `(${of(o[0])} ? ${of(o[1])} : ${of(o[2])})`;
            }
            case Op.IEqual:
                return compare(ins, '==', 'equal', null);
            case Op.INotEqual:
                return compare(ins, '!=', 'notEqual', null);
            case Op.UGreaterThan:
                return compare(ins, '>', 'greaterThan', 'uint');
            case Op.SGreaterThan:
                return compare(ins, '>', 'greaterThan', 'int');
            case Op.UGreaterThanEqual:
                return compare(ins, '>=', 'greaterThanEqual', 'uint');
            case Op.SGreaterThanEqual:
                return compare(ins, '>=', 'greaterThanEqual', 'int');
            case Op.ULessThan:
                return compare(ins, '<', 'lessThan', 'uint');
            case Op.SLessThan:
                return compare(ins, '<', 'lessThan', 'int');
            case Op.ULessThanEqual:
                return compare(ins, '<=', 'lessThanEqual', 'uint');
            case Op.SLessThanEqual:
                return compare(ins, '<=', 'lessThanEqual', 'int');
            case Op.FOrdEqual:
                return compare(ins, '==', 'equal', null);
            case Op.FUnordNotEqual:
                return compare(ins, '!=', 'notEqual', null);
            case Op.FOrdLessThan:
                return compare(ins, '<', 'lessThan', null);
            case Op.FOrdGreaterThan:
                return compare(ins, '>', 'greaterThan', null);
            case Op.FOrdLessThanEqual:
                return compare(ins, '<=', 'lessThanEqual', null);
            case Op.FOrdGreaterThanEqual:
                return compare(ins, '>=', 'greaterThanEqual', null);
            // Unordered: true where either is a NaN, the ordered opposite's negation.
            case Op.FUnordLessThan:
                return negate(compare(ins, '>=', 'greaterThanEqual', null), o[0]);
            case Op.FUnordGreaterThan:
                return negate(compare(ins, '<=', 'lessThanEqual', null), o[0]);
            case Op.FUnordLessThanEqual:
                return negate(compare(ins, '>', 'greaterThan', null), o[0]);
            case Op.FUnordGreaterThanEqual:
                return negate(compare(ins, '<', 'lessThan', null), o[0]);
            case Op.FUnordEqual: {
                const t = infoOf(o[0]);
                if (t.kind === 'vector')
                {
                    const u = `uvec${t.size}`;
                    return `bvec${t.size}(${u}(equal(${of(o[0])}, ${of(o[1])})) | ${u}(isnan(`
                        + `${of(o[0])})) | ${u}(isnan(${of(o[1])})))`;
                }
                return `(${of(o[0])} == ${of(o[1])} || isnan(${of(o[0])}) || isnan(${of(o[1])}))`;
            }
            case Op.FOrdNotEqual: {
                const t = infoOf(o[0]);
                if (t.kind === 'vector')
                {
                    const u = `uvec${t.size}`;
                    return `bvec${t.size}(${u}(notEqual(${of(o[0])}, ${of(o[1])})) & ${u}(not(`
                        + `isnan(${of(o[0])}))) & ${u}(not(isnan(${of(o[1])}))))`;
                }
                return `(${of(o[0])} != ${of(o[1])} && !isnan(${of(o[0])})`
                    + ` && !isnan(${of(o[1])}))`;
            }
            case Op.VectorShuffle: {
                const [a, b, ...lanes] = o;
                const n = /** @type {number} */ (infoOf(a).size);
                const xyzw = 'xyzw';
                if (lanes.every(l=>l < n))
                {
                    return `${of(a)}.${lanes.map(l=>xyzw[l]).join('')}`;
                }
                if (lanes.every(l=>l >= n && l !== 0xffffffff))
                {
                    return `${of(b)}.${lanes.map(l=>xyzw[l - n]).join('')}`;
                }
                const element = info(/** @type {number} */ (info(type).element));
                return `${typeName(type)}(${lanes.map(l=>(l === 0xffffffff
                    ? literal(0, /** @type {string} */ (element.base)) : l < n
                        ? `${of(a)}.${xyzw[l]}` : `${of(b)}.${xyzw[l - n]}`)).join(', ')})`;
            }
            case Op.CompositeConstruct:
                return `${typeName(type)}(${o.map(of).join(', ')})`;
            case Op.CompositeExtract:
                return extract(of(o[0]), /** @type {number} */ (typeOf.get(o[0])), o.slice(1));
            case Op.VectorExtractDynamic:
                return `${of(o[0])}[${of(o[1])}]`;
            case Op.Dot + 1000:
                return null;
            default:
                return null;
        }
    }

    /** @param {string} text @param {number} operand */
    const negate = (text, operand)=>(infoOf(operand).kind === 'vector' ? `not(${text})`
        : `(!${text})`);

    /**
     * OpBitcast between the bases of one width (section 3.32.11).
     *
     * @param {number} operand @param {number} type @returns {string}
     */
    function bitcast(operand, type){
        const from = /** @type {string} */ (baseOfId(operand));
        const to = /** @type {string} */ (info(type).base);
        const x = of(operand);
        const sizeOf = (/** @type {TypeInfo} */ t)=>(t.kind === 'vector' ? /** @type {number} */ (
            t.size) : 1);
        if (from === to)
        {
            return x;
        }
        if (to === 'double' || from === 'double')
        {
            // A double and two 32-bit words.
            if (to === 'double' && sizeOf(info(type)) === 1 && sizeOf(infoOf(operand)) === 2)
            {
                return `packDouble2x32(${from === 'uint' ? x : `uvec2(${x})`})`;
            }
            if (from === 'double' && sizeOf(infoOf(operand)) === 1)
            {
                return to === 'uint' ? `unpackDouble2x32(${x})`
                    : `${typeName(type)}(unpackDouble2x32(${x}))`;
            }
            return refuse('a bitcast of doubles of more than one component is not taken');
        }
        if (from === 'float')
        {
            return to === 'int' ? `floatBitsToInt(${x})` : `floatBitsToUint(${x})`;
        }
        if (to === 'float')
        {
            return from === 'int' ? `intBitsToFloat(${x})` : `uintBitsToFloat(${x})`;
        }
        return `${typeName(type)}(${x})`;
    }

    // --- functions ---

    const blocksOf = (/** @type {import('./spirv-module.js').SpirvFunction} */ fn)=>
        new Map(fn.blocks.map(b=>[b.label, b]));
    /** @type {Map<number, string>} a function's GLSL name */
    const functionNames = new Map(module.functions.map(fn=>[fn.id,
        fn.id === entry.id ? 'main' : `_f${fn.id}`]));

    /**
     * A parameter's or a pointer's GLSL text and what it points to.
     *
     * @param {number} id @returns {string}
     */
    const pointer = id=>of(id);

    /**
     * The functions the entry point reaches, callees first.
     *
     * @returns {import('./spirv-module.js').SpirvFunction[]}
     */
    const reached = ()=>{
        const byId = new Map(module.functions.map(fn=>[fn.id, fn]));
        /** @type {import('./spirv-module.js').SpirvFunction[]} */
        const order = [];
        /** @type {Set<number>} */
        const seen = new Set();
        /** @param {number} id */
        const visit = id=>{
            if (seen.has(id))
            {
                return;
            }
            seen.add(id);
            const fn = byId.get(id);
            if (!fn)
            {
                refuse(`function ${id} is called and not defined`);
            }
            for (const block of /** @type {import('./spirv-module.js').SpirvFunction} */ (fn)
                .blocks)
            {
                for (const ins of block.body)
                {
                    if (ins.op === Op.FunctionCall)
                    {
                        visit(ins.operands[0]);
                    }
                }
            }
            order.push(/** @type {import('./spirv-module.js').SpirvFunction} */ (fn));
        };
        visit(entry.id);
        return order;
    };


    /**
     * A function's GLSL text.
     *
     * @param {import('./spirv-module.js').SpirvFunction} fn
     * @returns {{ text: string, prototype: string }}
     */
    function writeFunction(fn){
        const blocks = blocksOf(fn);
        /** @type {string[]} the function's hoisted declarations */
        const hoisted = [];
        const params = fn.params.map(p=>{
            typeOf.set(p.id, p.type);
            const t = info(p.type);
            const name = `_a${p.id}`;
            code.set(p.id, name);
            if (t.kind === 'pointer')
            {
                return `inout ${declarator(/** @type {number} */ (t.pointee), name)}`;
            }
            return `in ${declarator(p.type, name)}`;
        });
        const prototype = `${typeName(fn.type)} ${functionNames.get(fn.id)}(${params.join(', ')})`;
        // Every value a variable, declared once at the top.
        for (const block of fn.blocks)
        {
            for (const ins of block.body)
            {
                if (!ins.id || ins.op === Op.Label)
                {
                    continue;
                }
                typeOf.set(ins.id, ins.type);
                const t = info(ins.type);
                if (ins.op === Op.Variable)
                {
                    const pointee = /** @type {number} */ (t.pointee);
                    const name = `_v${ins.id}`;
                    code.set(ins.id, name);
                    hoisted.push(`    ${declarator(pointee, name)}${ins.operands[1]
                        ? ` = ${of(ins.operands[1])}` : ''};`);
                    continue;
                }
                if (t.kind === 'pointer' || t.kind === 'image' || t.kind === 'sampledImage'
                    || t.kind === 'void')
                {
                    continue;
                }
                code.set(ins.id, `_r${ins.id}`);
                hoisted.push(`    ${declarator(ins.type, `_r${ins.id}`)};`);
            }
        }
        /** @type {Set<number>} labels of blocks with more than one phi */
        const manyPhis = new Set();
        for (const block of fn.blocks)
        {
            const phis = block.body.filter(i=>i.op === Op.Phi);
            if (phis.length > 1)
            {
                manyPhis.add(block.label);
                for (const phi of phis)
                {
                    hoisted.push(`    ${declarator(phi.type, `_q${phi.id}`)};`);
                }
            }
            if (block.body.some(i=>i.op === Op.LoopMerge))
            {
                hoisted.push(`    bool _l${block.label};`, `    bool _x${block.label};`);
            }
        }

        /**
         * @typedef {Object} Flow
         * @property {{ header: number, merge: number, cont: number } | null} loop
         * @property {boolean} inContinue  emitting the loop's continue construct
         * @property {boolean} inSwitch  inside a switch of the innermost loop
         * @property {number | null} switchMerge
         * @property {Set<number>} stops  selection merges, where emission returns
         */

        let depth = 0;

        /**
         * The phi copies for a branch from `from` to `target`.
         *
         * @param {number} target @param {number} from @param {string[]} out @param {string} pad
         */
        const copies = (target, from, out, pad)=>{
            const block = blocks.get(target);
            const phis = block?.body.filter(i=>i.op === Op.Phi) ?? [];
            /** @type {[number, string][]} */
            const values = phis.map(phi=>{
                const o = phi.operands;
                for (let k = 0; k + 1 < o.length; k += 2)
                {
                    if (o[k + 1] === from)
                    {
                        return [phi.id, of(o[k])];
                    }
                }
                return refuse(`phi ${phi.id} has no value from block ${from}`);
            });
            if (manyPhis.has(target))
            {
                for (const [id, value] of values)
                {
                    out.push(`${pad}_q${id} = ${value};`);
                }
                for (const [id] of values)
                {
                    out.push(`${pad}_r${id} = _q${id};`);
                }
                return;
            }
            for (const [id, value] of values)
            {
                out.push(`${pad}_r${id} = ${value};`);
            }
        };

        /**
         * A branch from `from` to `target`: the phi copies, then the jump
         * the target is in the flow, or the target's code.
         *
         * @param {number} target @param {number} from @param {Flow} flow
         * @param {string[]} out @param {string} pad @param {boolean} [withCopies]
         */
        const branch = (target, from, flow, out, pad, withCopies = true)=>{
            if (withCopies)
            {
                copies(target, from, out, pad);
            }
            const loop = flow.loop;
            if (loop && target === loop.header)
            {
                if (!flow.inContinue)
                {
                    out.push(`${pad}continue;`);
                }
                return;
            }
            if (loop && target === loop.cont)
            {
                out.push(`${pad}continue;`);
                return;
            }
            if (loop && target === loop.merge)
            {
                if (flow.inSwitch)
                {
                    out.push(`${pad}_x${loop.header} = true;`);
                }
                out.push(`${pad}break;`);
                return;
            }
            if (flow.switchMerge === target)
            {
                out.push(`${pad}break;`);
                return;
            }
            if (flow.stops.has(target))
            {
                return;
            }
            block(target, flow, out, pad);
        };

        /**
         * A block's code and what follows it in its construct.
         *
         * @param {number} label @param {Flow} flow @param {string[]} out @param {string} pad
         */
        const block = (label, flow, out, pad)=>{
            if (++depth > 65536)
            {
                refuse('control flow this does not follow (not structured as SPIR-V says)');
            }
            const b = blocks.get(label);
            if (!b)
            {
                return refuse(`block ${label} is not the function's`);
            }
            const body = b.body;
            const terminator = body[body.length - 1];
            const merge = body.length > 1 ? body[body.length - 2] : null;
            if (merge?.op === Op.LoopMerge && !(flow.loop?.header === label))
            {
                const [mergeLabel, cont] = merge.operands;
                const inner = `${pad}    `;
                out.push(`${pad}_l${label} = false;`, `${pad}_x${label} = false;`,
                    `${pad}while (true) {`);
                /** @type {Flow} */
                const loopFlow = { loop: { header: label, merge: mergeLabel, cont },
                    inContinue: false, inSwitch: false, switchMerge: null, stops: flow.stops };
                if (cont !== label)
                {
                    out.push(`${inner}if (_l${label}) {`);
                    block(cont, { ...loopFlow, inContinue: true }, out, `${inner}    `);
                    out.push(`${inner}}`);
                }
                out.push(`${inner}_l${label} = true;`);
                block(label, loopFlow, out, inner);
                out.push(`${pad}}`);
                if (flow.inSwitch && flow.loop)
                {
                    // A break of the enclosing loop from inside this one's switch.
                }
                branch(mergeLabel, label, flow, out, pad, false);
                return;
            }
            for (const ins of body)
            {
                if (ins === terminator || ins === merge && (merge.op === Op.LoopMerge
                    || merge.op === Op.SelectionMerge) || ins.op === Op.Phi)
                {
                    continue;
                }
                statement(ins, out, pad);
            }
            const t = terminator.operands;
            switch (terminator.op)
            {
                case Op.Branch:
                    branch(t[0], label, flow, out, pad);
                    return;
                case Op.BranchConditional: {
                    const selection = merge?.op === Op.SelectionMerge ? merge.operands[0] : null;
                    const inner = `${pad}    `;
                    /** @type {Flow} */
                    const arm = selection === null ? flow
                        : { ...flow, stops: new Set([...flow.stops, selection]) };
                    out.push(`${pad}if (${of(t[0])}) {`);
                    branch(t[1], label, arm, out, inner);
                    out.push(`${pad}} else {`);
                    branch(t[2], label, arm, out, inner);
                    out.push(`${pad}}`);
                    if (selection !== null)
                    {
                        branch(selection, label, flow, out, pad, false);
                    }
                    return;
                }
                case Op.Switch: {
                    const selection = merge?.op === Op.SelectionMerge ? merge.operands[0] : null;
                    if (selection === null)
                    {
                        refuse('a switch with no selection merge');
                    }
                    const selector = of(t[0]);
                    const unsigned = baseOfId(t[0]) === 'uint';
                    /** @type {Map<number, string[]>} each target's case labels */
                    const cases = new Map();
                    for (let k = 2; k + 1 < t.length; k += 2)
                    {
                        const list = cases.get(t[k + 1]) ?? [];
                        list.push(unsigned ? `${t[k] >>> 0}u` : `${t[k] | 0}`);
                        cases.set(t[k + 1], list);
                    }
                    /** @type {Flow} */
                    const inside = { ...flow, inSwitch: !!flow.loop,
                        switchMerge: /** @type {number} */ (selection),
                        stops: new Set([...flow.stops, /** @type {number} */ (selection)]) };
                    const inner = `${pad}        `;
                    /** A case's code; a case that runs into another runs that one's after it. @param {number} target */
                    const arm = target=>{
                        branch(target, label, inside, out, inner);
                        if (!/(?:break|continue|return(?: [^;]*)?|discard);$/.test(out[out.length - 1]))
                        {
                            out.push(`${inner}break;`);
                        }
                        out.push(`${pad}    }`);
                    };
                    out.push(`${pad}switch (${selector}) {`);
                    for (const [target, labels] of cases)
                    {
                        out.push(`${pad}    ${labels.map(l=>`case ${l}:`).join(' ')}`
                            + `${target === t[1] ? ' default:' : ''} {`);
                        arm(target);
                    }
                    if (!cases.has(t[1]))
                    {
                        out.push(`${pad}    default: {`);
                        arm(t[1]);
                    }
                    out.push(`${pad}}`);
                    if (flow.loop)
                    {
                        // A break of the loop from inside: each switch it is in left in turn.
                        out.push(`${pad}if (_x${flow.loop.header}) {`, `${pad}    break;`,
                            `${pad}}`);
                    }
                    branch(/** @type {number} */ (selection), label, flow, out, pad, false);
                    return;
                }
                case Op.Return:
                    out.push(`${pad}return;`);
                    return;
                case Op.ReturnValue:
                    out.push(`${pad}return ${of(t[0])};`);
                    return;
                case Op.Kill:
                case Op.TerminateInvocation:
                    out.push(`${pad}discard;`);
                    return;
                case Op.Unreachable:
                    return;
                default:
                    refuse(`block ${label} ends in opcode ${terminator.op}, no terminator`);
            }
        };

        /** @type {string[]} */
        const lines = [];
        const first = fn.blocks[0];
        block(first.label, { loop: null, inContinue: false, inSwitch: false, switchMerge: null,
            stops: new Set() }, lines, '    ');
        return { prototype, text: `${prototype} {\n${[...hoisted, ...lines].join('\n')}\n}` };
    }

    /**
     * A pointer's GLSL lvalue through an access chain.
     *
     * @param {number} base @param {number[]} indices @returns {string}
     */
    const accessChain = (base, indices)=>{
        const pointerType = info(/** @type {number} */ (typeOf.get(base)));
        let type = /** @type {number} */ (pointerType.pointee);
        const reach = io.get(base);
        let text = of(base);
        let rest = indices;
        if (reach)
        {
            if (reach.arrayed)
            {
                text = `${reach.base}[${indexText(rest[0])}]${reach.member}`;
                type = /** @type {number} */ (info(type).element);
                rest = rest.slice(1);
            }
            if (reach.builtinBlock)
            {
                // gl_PerVertex's member: the built-in of its name.
                const k = constantValue(rest[0]);
                const builtin = /** @type {number[]} */ (memberDec(type, k,
                    Decoration.BuiltIn))[0];
                const input = pointerType.storage === Storage.Input;
                const name = builtinName(builtin, input);
                text = reach.arrayed ? `${text}.${name}` : name;
                type = /** @type {number[]} */ (info(type).members)[k];
                rest = rest.slice(1);
            }
        }
        for (const index of rest)
        {
            const t = info(type);
            if (t.kind === 'struct')
            {
                const k = constantValue(index);
                text = `${text}.m${k}`;
                type = /** @type {number[]} */ (t.members)[k];
            }
            else
            {
                text = `${text}[${indexText(index)}]`;
                type = /** @type {number} */ (t.element);
            }
        }
        return text;
    };
    /** @param {number} id */
    const indexText = id=>(constants.has(id) ? `${constantValue(id)}` : of(id));

    /**
     * The sampler or image a sampled image or image value names.
     *
     * @param {number} id @returns {string}
     */
    const opaque = id=>of(id);

    /**
     * One instruction of a block as statements.
     *
     * @param {import('./spirv-module.js').Instruction} ins
     * @param {string[]} out @param {string} pad
     */
    function statement(ins, out, pad){
        const o = Array.from(ins.operands);
        const assign = (/** @type {string} */ text)=>out.push(`${pad}_r${ins.id} = ${text};`);
        switch (ins.op)
        {
            case Op.Variable:
            case Op.Line:
            case Op.NoLine:
            case Op.Nop:
                return;
            case Op.Undef:
                assign(zeroOf(ins.type));
                return;
            case Op.Load: {
                const t = info(ins.type);
                if (t.kind === 'image' || t.kind === 'sampledImage')
                {
                    code.set(ins.id, of(o[0]));
                    return;
                }
                const reach = io.get(o[0]);
                if (reach?.arrayed)
                {
                    const pointee = info(/** @type {number} */ (info(
                        /** @type {number} */ (typeOf.get(o[0]))).pointee));
                    const n = constantValue(/** @type {number} */ (pointee.length));
                    assign(`${typeName(ins.type)}(${Array.from({ length: n }, (_, k)=>
                        `${reach.base}[${k}]${reach.member}`).join(', ')})`);
                    return;
                }
                if (reach?.builtinBlock)
                {
                    refuse('a load of gl_PerVertex whole');
                }
                assign(pointer(o[0]));
                return;
            }
            case Op.Store: {
                const reach = io.get(o[0]);
                if (reach?.arrayed || reach?.builtinBlock)
                {
                    refuse('a store of an arrayed input or output whole');
                }
                out.push(`${pad}${pointer(o[0])} = ${of(o[1])};`);
                return;
            }
            case Op.CopyMemory:
                out.push(`${pad}${pointer(o[0])} = ${pointer(o[1])};`);
                return;
            case Op.AccessChain:
            case Op.InBoundsAccessChain:
                code.set(ins.id, accessChain(o[0], o.slice(1)));
                return;
            case Op.PtrAccessChain:
                return refuse('OpPtrAccessChain is not taken');
            case Op.ArrayLength:
                assign(`uint(${of(o[0])}.m${o[1]}.length())`);
                return;
            case Op.CompositeInsert: {
                assign(of(o[1]));
                out.push(`${pad}${extract(`_r${ins.id}`, ins.type, o.slice(2))} = ${of(o[0])};`);
                return;
            }
            case Op.VectorInsertDynamic:
                assign(of(o[0]));
                out.push(`${pad}_r${ins.id}[${of(o[2])}] = ${of(o[1])};`);
                return;
            case Op.FunctionCall: {
                const callee = functionNames.get(o[0]);
                const args = o.slice(1).map(a=>of(a));
                const call = `${callee}(${args.join(', ')})`;
                if (info(ins.type).kind === 'void')
                {
                    out.push(`${pad}${call};`);
                }
                else
                {
                    assign(call);
                }
                return;
            }
            case Op.ExtInst:
                extInst(ins, out, pad);
                return;
            case Op.SampledImage:
            case Op.Image:
                code.set(ins.id, opaque(o[0]));
                return;
            case Op.ImageSampleImplicitLod:
            case Op.ImageSampleExplicitLod:
            case Op.ImageSampleDrefImplicitLod:
            case Op.ImageSampleDrefExplicitLod:
            case Op.ImageSampleProjImplicitLod:
            case Op.ImageSampleProjExplicitLod:
            case Op.ImageSampleProjDrefImplicitLod:
            case Op.ImageSampleProjDrefExplicitLod:
                assign(sample(ins));
                return;
            case Op.ImageFetch: {
                const { mask, ids } = imageOperands(o, 2);
                const s = opaque(o[0]);
                const shape = imageShape(o[0]);
                const lod = mask & ImageOperand.Lod ? of(/** @type {number} */ (ids.get(
                    ImageOperand.Lod))) : '0';
                const sampleIndex = mask & ImageOperand.Sample ? of(/** @type {number} */ (
                    ids.get(ImageOperand.Sample))) : null;
                const extra = shape.ms ? `, ${sampleIndex ?? '0'}`
                    : shape.dim === 4 || shape.dim === 5 ? '' : `, ${lod}`;
                const offset = mask & (ImageOperand.ConstOffset | ImageOperand.Offset)
                    ? of(/** @type {number} */ (ids.get(ImageOperand.ConstOffset)
                        ?? ids.get(ImageOperand.Offset))) : null;
                const at = coordinate(o[1], needed(shape), 'int');
                assign(result(offset ? `texelFetchOffset(${s}, ${at}${extra}, ${offset})`
                    : `texelFetch(${s}, ${at}${extra})`,
                /** @type {string} */ (info(ins.type).base), ins.type));
                return;
            }
            case Op.ImageGather:
            case Op.ImageDrefGather: {
                const s = opaque(o[0]);
                const third = ins.op === Op.ImageDrefGather ? of(o[2])
                    : `${constantValue(o[2])}`;
                const { mask, ids } = imageOperands(o, 3);
                const at = coordinate(o[1], needed(imageShape(o[0])), 'float');
                if (mask & ImageOperand.ConstOffsets)
                {
                    assign(`textureGatherOffsets(${s}, ${at}, ${of(/** @type {number} */ (
                        ids.get(ImageOperand.ConstOffsets)))}, ${third})`);
                    return;
                }
                const offset = ids.get(ImageOperand.ConstOffset) ?? ids.get(ImageOperand.Offset);
                assign(offset !== undefined
                    ? `textureGatherOffset(${s}, ${at}, ${of(offset)}, ${third})`
                    : `textureGather(${s}, ${at}, ${third})`);
                return;
            }
            case Op.ImageRead: {
                const { mask, ids } = imageOperands(o, 2);
                const sampleIndex = mask & ImageOperand.Sample
                    ? `, ${of(/** @type {number} */ (ids.get(ImageOperand.Sample)))}` : '';
                const at = coordinate(o[1], needed(imageShape(o[0])), 'int');
                assign(result(`imageLoad(${opaque(o[0])}, ${at}${sampleIndex})`,
                    imageBase(o[0]), ins.type));
                return;
            }
            case Op.ImageWrite: {
                const { mask, ids } = imageOperands(o, 3);
                const sampleIndex = mask & ImageOperand.Sample
                    ? `, ${of(/** @type {number} */ (ids.get(ImageOperand.Sample)))}` : '';
                const at = coordinate(o[1], needed(imageShape(o[0])), 'int');
                out.push(`${pad}imageStore(${opaque(o[0])}, ${at}${sampleIndex},`
                    + ` ${as(o[2], imageBase(o[0]))});`);
                return;
            }
            case Op.ImageQuerySizeLod:
                assign(result(`textureSize(${opaque(o[0])}, ${as(o[1], 'int')})`, 'int',
                    ins.type));
                return;
            case Op.ImageQuerySize: {
                const shape = imageShape(o[0]);
                assign(result(shape.usage === 2 ? `imageSize(${opaque(o[0])})`
                    : `textureSize(${opaque(o[0])})`, 'int', ins.type));
                return;
            }
            case Op.ImageQueryLod:
                assign(`textureQueryLod(${opaque(o[0])}, ${of(o[1])})`);
                return;
            case Op.ImageQueryLevels:
                assign(result(`textureQueryLevels(${opaque(o[0])})`, 'int', ins.type));
                return;
            case Op.ImageQuerySamples: {
                const shape = imageShape(o[0]);
                assign(result(shape.usage === 2 ? `imageSamples(${opaque(o[0])})`
                    : `textureSamples(${opaque(o[0])})`, 'int', ins.type));
                return;
            }
            case Op.DPdx:
            case Op.DPdy:
            case Op.Fwidth:
            case Op.DPdxFine:
            case Op.DPdyFine:
            case Op.FwidthFine:
            case Op.DPdxCoarse:
            case Op.DPdyCoarse:
            case Op.FwidthCoarse: {
                const name = /** @type {Record<number, string>} */ ({ [Op.DPdx]: 'dFdx',
                    [Op.DPdy]: 'dFdy', [Op.Fwidth]: 'fwidth', [Op.DPdxFine]: 'dFdxFine',
                    [Op.DPdyFine]: 'dFdyFine', [Op.FwidthFine]: 'fwidthFine',
                    [Op.DPdxCoarse]: 'dFdxCoarse', [Op.DPdyCoarse]: 'dFdyCoarse',
                    [Op.FwidthCoarse]: 'fwidthCoarse' })[ins.op];
                assign(`${name}(${of(o[0])})`);
                return;
            }
            case Op.EmitVertex:
                out.push(`${pad}EmitVertex();`);
                return;
            case Op.EndPrimitive:
                out.push(`${pad}EndPrimitive();`);
                return;
            case Op.EmitStreamVertex:
                out.push(`${pad}EmitStreamVertex(${of(o[0])});`);
                return;
            case Op.EndStreamPrimitive:
                out.push(`${pad}EndStreamPrimitive(${of(o[0])});`);
                return;
            case Op.ControlBarrier:
                out.push(`${pad}barrier();`);
                return;
            case Op.MemoryBarrier: {
                const semantics = constantValue(o[1]);
                const name = semantics & 0x100 && !(semantics & 0xc40) ? 'memoryBarrierShared'
                    : semantics & 0x40 && !(semantics & 0xd00) ? 'memoryBarrierBuffer'
                        : semantics & 0x800 && !(semantics & 0x540) ? 'memoryBarrierImage'
                            : semantics & 0x400 && !(semantics & 0x940)
                                ? 'memoryBarrierAtomicCounter' : 'memoryBarrier';
                out.push(`${pad}${name}();`);
                return;
            }
            case Op.AtomicLoad:
            case Op.AtomicStore:
            case Op.AtomicExchange:
            case Op.AtomicCompareExchange:
            case Op.AtomicCompareExchangeWeak:
            case Op.AtomicIIncrement:
            case Op.AtomicIDecrement:
            case Op.AtomicIAdd:
            case Op.AtomicISub:
            case Op.AtomicSMin:
            case Op.AtomicUMin:
            case Op.AtomicSMax:
            case Op.AtomicUMax:
            case Op.AtomicAnd:
            case Op.AtomicOr:
            case Op.AtomicXor:
                atomic(ins, out, pad);
                return;
            case Op.IAddCarry:
            case Op.ISubBorrow:
                assign(`${typeName(ins.type)}(${zeroOf(info(ins.type).members?.[0] ?? 0)},`
                    + ` ${zeroOf(info(ins.type).members?.[0] ?? 0)})`);
                out.push(`${pad}_r${ins.id}.m0 = ${ins.op === Op.IAddCarry ? 'uaddCarry'
                    : 'usubBorrow'}(${as(o[0], 'uint')}, ${as(o[1], 'uint')}, _r${ins.id}.m1);`);
                return;
            case Op.UMulExtended:
            case Op.SMulExtended: {
                const base = ins.op === Op.UMulExtended ? 'uint' : 'int';
                assign(`${typeName(ins.type)}(${zeroOf(info(ins.type).members?.[0] ?? 0)},`
                    + ` ${zeroOf(info(ins.type).members?.[0] ?? 0)})`);
                out.push(`${pad}${base === 'uint' ? 'umulExtended' : 'imulExtended'}(`
                    + `${as(o[0], base)}, ${as(o[1], base)}, _r${ins.id}.m1, _r${ins.id}.m0);`);
                return;
            }
            default: {
                const text = valueExpression(ins, true);
                if (text === null)
                {
                    refuse(`instruction opcode ${ins.op} is not taken`);
                }
                assign(/** @type {string} */ (text));
            }
        }
    }

    /**
     * An image instruction's image operands: the mask, and each operand's
     * id by its bit (Grad's two as the bit and the bit's negation).
     *
     * @param {number[]} o @param {number} at  where the mask is
     * @returns {{ mask: number, ids: Map<number, number> }}
     */
    function imageOperands(o, at){
        const mask = o[at] ?? 0;
        /** @type {Map<number, number>} */
        const ids = new Map();
        let k = at + 1;
        for (const bit of [ImageOperand.Bias, ImageOperand.Lod, ImageOperand.Grad,
            ImageOperand.ConstOffset, ImageOperand.Offset, ImageOperand.ConstOffsets,
            ImageOperand.Sample, ImageOperand.MinLod])
        {
            if (!(mask & bit))
            {
                continue;
            }
            ids.set(bit, o[k++]);
            if (bit === ImageOperand.Grad)
            {
                ids.set(-bit, o[k++]);
            }
        }
        if (mask & ~0xff)
        {
            refuse(`image operands 0x${mask.toString(16)} are not taken`);
        }
        if (mask & ImageOperand.MinLod)
        {
            refuse('a minimum level of detail (MinLod) is not taken');
        }
        return { mask, ids };
    }

    /**
     * The shape of the image a sampled image or image value is of.
     *
     * @param {number} id
     */
    function imageShape(id){
        const t = infoOf(id);
        const image = t.kind === 'sampledImage' ? info(/** @type {number} */ (t.image)) : t;
        return /** @type {NonNullable<TypeInfo['shape']>} */ (image.shape);
    }

    /**
     * The coordinate components an image of `shape` is addressed by: its
     * dimensions' and the layer's.
     *
     * @param {NonNullable<TypeInfo['shape']>} shape
     */
    function needed(shape){
        return [1, 2, 3, 3, 2, 1][shape.dim] + (shape.arrayed ? 1 : 0);
    }

    /** The base of the texels an image holds. @param {number} id @returns {string} */
    function imageBase(id){
        return /** @type {string} */ (info(imageShape(id).sampled).base);
    }

    /**
     * A coordinate's first `count` components, as `base`.
     *
     * @param {number} id @param {number} count @param {string} base @returns {string}
     */
    function coordinate(id, count, base){
        const t = infoOf(id);
        const size = t.kind === 'vector' ? /** @type {number} */ (t.size) : 1;
        let text = of(id);
        if (size > count)
        {
            text = `${text}.${'xyzw'.slice(0, count)}`;
        }
        if (t.base !== base)
        {
            text = `${count === 1 ? base : withBase(/** @type {number} */ (typeOf.get(id)), base)
                .replace(/\d$/, String(count))}(${text})`;
        }
        return text;
    }

    /** One component of a vector or a scalar. @param {number} id @param {number} k */
    function lane(id, k){
        return infoOf(id).kind === 'vector' ? `${of(id)}.${'xyzw'[k]}` : of(id);
    }

    /**
     * An OpImageSample* as GLSL's lookup.
     *
     * @param {import('./spirv-module.js').Instruction} ins @returns {string}
     */
    function sample(ins){
        const o = Array.from(ins.operands);
        const s = opaque(o[0]);
        const proj = ins.op === Op.ImageSampleProjImplicitLod
            || ins.op === Op.ImageSampleProjExplicitLod
            || ins.op === Op.ImageSampleProjDrefImplicitLod
            || ins.op === Op.ImageSampleProjDrefExplicitLod;
        const dref = ins.op === Op.ImageSampleDrefImplicitLod
            || ins.op === Op.ImageSampleDrefExplicitLod
            || ins.op === Op.ImageSampleProjDrefImplicitLod
            || ins.op === Op.ImageSampleProjDrefExplicitLod;
        const shape = imageShape(o[0]);
        const { mask, ids } = imageOperands(o, dref ? 3 : 2);
        // The coordinate may hold more components than the image needs
        // (section 3.32.10): GLSL's lookups take exactly theirs, a projective
        // one's q after them and a shadow one's reference after those.
        const n = needed(shape);
        let P = coordinate(o[1], proj ? n + 1 : n, 'float');
        let comparison = '';
        if (dref)
        {
            const ref = of(o[2]);
            if (n === 4)
            {
                comparison = `, ${ref}`;
            }
            else if (proj)
            {
                P = n === 1 ? `vec4(${lane(o[1], 0)}, 0.0, ${ref}, ${lane(o[1], 1)})`
                    : `vec4(${coordinate(o[1], 2, 'float')}, ${ref}, ${lane(o[1], 2)})`;
            }
            else
            {
                P = n === 1 ? `vec3(${P}, 0.0, ${ref})` : `vec${n + 1}(${P}, ${ref})`;
            }
        }
        const offsetId = ids.get(ImageOperand.ConstOffset) ?? ids.get(ImageOperand.Offset);
        const offset = offsetId !== undefined ? `, ${of(offsetId)}` : '';
        const name = `texture${proj ? 'Proj' : ''}`;
        const off = offset ? 'Offset' : '';
        let text;
        if (mask & ImageOperand.Grad)
        {
            text = `${name}Grad${off}(${s}, ${P}${comparison}, ${of(/** @type {number} */ (ids.get(
                ImageOperand.Grad)))}, ${of(/** @type {number} */ (ids.get(-ImageOperand.Grad)))}`
                + `${offset})`;
        }
        else if (mask & ImageOperand.Lod)
        {
            text = `${name}Lod${off}(${s}, ${P}${comparison}, ${of(/** @type {number} */ (ids.get(
                ImageOperand.Lod)))}${offset})`;
        }
        else
        {
            const bias = mask & ImageOperand.Bias
                ? `, ${of(/** @type {number} */ (ids.get(ImageOperand.Bias)))}` : '';
            text = `${name}${off}(${s}, ${P}${comparison}${offset}${bias})`;
        }
        return result(text, /** @type {string} */ (info(ins.type).base ?? 'float'), ins.type);
    }

    /**
     * An atomic instruction: GLSL's atomic function on the place, an atomic
     * counter's on a counter.
     *
     * @param {import('./spirv-module.js').Instruction} ins
     * @param {string[]} out @param {string} pad
     */
    function atomic(ins, out, pad){
        const o = Array.from(ins.operands);
        const place = pointer(o[0]);
        const storage = info(/** @type {number} */ (typeOf.get(o[0]))).storage;
        const assign = (/** @type {string} */ text)=>out.push(`${pad}_r${ins.id} = ${text};`);
        if (storage === Storage.AtomicCounter)
        {
            switch (ins.op)
            {
                case Op.AtomicLoad:
                    assign(`atomicCounter(${place})`);
                    return;
                case Op.AtomicIIncrement:
                    assign(`atomicCounterIncrement(${place})`);
                    return;
                case Op.AtomicIDecrement:
                    // SPIR-V answers the value before; GLSL the value after.
                    assign(`(atomicCounterDecrement(${place}) + 1u)`);
                    return;
                default:
                    refuse(`atomic opcode ${ins.op} on an atomic counter is not taken`);
            }
        }
        const base = /** @type {string} */ (info(ins.type).base ?? baseOfId(o[3] ?? o[0]));
        switch (ins.op)
        {
            case Op.AtomicLoad:
                assign(place);
                return;
            case Op.AtomicStore:
                out.push(`${pad}atomicExchange(${place}, ${of(o[3])});`);
                return;
            case Op.AtomicExchange:
                assign(`atomicExchange(${place}, ${as(o[3], base)})`);
                return;
            case Op.AtomicCompareExchange:
            case Op.AtomicCompareExchangeWeak:
                assign(`atomicCompSwap(${place}, ${as(o[5], base)}, ${as(o[4], base)})`);
                return;
            case Op.AtomicIIncrement:
                assign(`atomicAdd(${place}, ${literal(1, base)})`);
                return;
            case Op.AtomicIDecrement:
                assign(`atomicAdd(${place}, ${base === 'uint' ? '0xffffffffu' : '-1'})`);
                return;
            case Op.AtomicISub:
                assign(`atomicAdd(${place}, -${as(o[3], base)})`);
                return;
            default: {
                const name = /** @type {Record<number, string>} */ ({ [Op.AtomicIAdd]: 'atomicAdd',
                    [Op.AtomicSMin]: 'atomicMin', [Op.AtomicUMin]: 'atomicMin',
                    [Op.AtomicSMax]: 'atomicMax', [Op.AtomicUMax]: 'atomicMax',
                    [Op.AtomicAnd]: 'atomicAnd', [Op.AtomicOr]: 'atomicOr',
                    [Op.AtomicXor]: 'atomicXor' })[ins.op];
                assign(`${name}(${place}, ${as(o[3], base)})`);
            }
        }
    }

    /**
     * A GLSL.std.450 instruction.
     *
     * @param {import('./spirv-module.js').Instruction} ins
     * @param {string[]} out @param {string} pad
     */
    function extInst(ins, out, pad){
        const o = Array.from(ins.operands);
        const number = o[1];
        const args = o.slice(2);
        const assign = (/** @type {string} */ text)=>out.push(`${pad}_r${ins.id} = ${text};`);
        switch (number)
        {
            case 35:
                assign(`modf(${of(args[0])}, ${pointer(args[1])})`);
                return;
            case 36:
                out.push(`${pad}_r${ins.id}.m0 = modf(${of(args[0])}, _r${ins.id}.m1);`);
                return;
            case 51:
                assign(`frexp(${of(args[0])}, ${pointer(args[1])})`);
                return;
            case 52:
                out.push(`${pad}_r${ins.id}.m0 = frexp(${of(args[0])}, _r${ins.id}.m1);`);
                return;
            case 76:
                assign(`interpolateAtCentroid(${pointer(args[0])})`);
                return;
            case 77:
                assign(`interpolateAtSample(${pointer(args[0])}, ${as(args[1], 'int')})`);
                return;
            case 78:
                assign(`interpolateAtOffset(${pointer(args[0])}, ${of(args[1])})`);
                return;
            default:
                break;
        }
        const name = STD450.get(number);
        if (!name)
        {
            refuse(`GLSL.std.450 instruction ${number} is not taken`);
        }
        const base = STD450_SIGNED.has(number) ? 'int' : STD450_UNSIGNED.has(number) ? 'uint'
            : null;
        const texts = args.map(a=>(base ? as(a, base) : of(a)));
        let text = `${name}(${texts.join(', ')})`;
        if (number === 73 || number === 74 || number === 75)
        {
            text = result(text, 'int', ins.type);
        }
        else if (base)
        {
            text = result(text, base, ins.type);
        }
        assign(text);
    }

    for (const { at, ins } of pendingSpecOps)
    {
        declarations[at] = `const ${declarator(ins.type, `_k${ins.id}`)} = ${specOp(ins)};`;
    }

    /** @type {string[]} */
    const functionTexts = [];
    /** @type {string[]} */
    const prototypes = [];
    for (const fn of reached())
    {
        const { text, prototype } = writeFunction(fn);
        functionTexts.push(text);
        if (fn.id !== entry.id)
        {
            prototypes.push(`${prototype};`);
        }
    }

    const header = ['#version 460', ...layouts, ...structs, ...declarations, ...prototypes];
    return `${header.join('\n')}\n\n${functionTexts.join('\n\n')}\n`;
}
