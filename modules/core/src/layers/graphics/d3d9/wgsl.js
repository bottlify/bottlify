/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader bytecode to WGSL: one Direct3D instruction at a time.
 *
 * The translation is deliberately literal. Every Direct3D register becomes a
 * WGSL variable of four floats, every instruction a statement that reads its
 * sources through their swizzles and modifiers and writes its destination
 * through its mask, and the structured flow control maps onto WGSL's own.
 * Nothing is optimised, because a translator that reorders is a translator
 * whose mistakes are invisible: a literal one can be read next to the
 * disassembly and checked line by line.
 *
 * What the translation promises whoever binds it, and is the contract the
 * renderer meets:
 *
 * - **Vertex inputs arrive by location, typed as the declaration lays them.**
 *   A vertex shader's `dcl` registers are numbered in the order declared, and
 *   `inputs` says which usage each location carries. The caller says what
 *   shape each element has -- how many components, of what scalar, and
 *   whether it is a colour whose bytes arrive blue first -- and the shader
 *   promotes each to the four floats Direct3D reads, filling what the element
 *   lacks with (0, 0, 0, 1). A register declared and not supplied reads as
 *   that default, so a declaration short of an element the shader names
 *   draws rather than fails to bind.
 * - **Varyings travel at the locations `varyingLocation` gives a usage**, one
 *   table for both stages, so a vertex shader and a pixel shader that never
 *   see each other agree.
 * - **Constants are three uniform arrays** -- floats, integers, booleans --
 *   at bindings 0 to 2 of group 0 for the vertex stage and group 1 for the
 *   pixel stage. The float array is only as long as the shader reaches, so a
 *   draw uploads what the shader reads and not the whole file.
 * - **Fog is a varying**, at the location `varyingLocation` gives the oFog
 *   register: the fixed-function vertex stage of a hybrid computes the amount
 *   -- vertex fog from the camera-space depth, or the specular alpha -- and
 *   carries the fog colour beside it, and a pixel shader the caller fogged
 *   reads it and mixes its own colour towards that colour by that amount.
 *   Table fog is the pixel's, so for it the vertex stage carries the curve's
 *   range instead (`FOG_RANGE_LOCATION`) and the pixel shader evaluates the
 *   curve over its own depth. Direct3D applies its fog stage to a shader-drawn
 *   surface below model 3 exactly as to a fixed-function one.
 * - **Samplers are texture and sampler pairs** at group 2, two bindings per
 *   sampler register, in the order `samplers` lists them. A 1.x pixel shader
 *   declares none: each stage it samples is of the dimension the caller says
 *   the texture bound there has.
 * - **A 1.x pixel shader's bump matrices are constants** past the ones it
 *   reads (`bumpRegister`): two registers a stage, D3DTSS_BUMPENVMAT00, 01,
 *   10 and 11, then D3DTSS_BUMPENVLSCALE and LOFFSET.
 *
 * Three things are not translated and say so: predicated execution;
 * subroutines, whose body would need the entry point's registers; and texture
 * reads from a vertex shader. A shader using any of them is reported as
 * untranslatable rather than translated wrong.
 */

import { OPCODE, REGISTER, SHADER_KIND } from './shader.js';
import { D3DDECLUSAGE } from './declaration.js';
import { compareExpression, fogFunctionDeclaration } from '../webgpu/internal/fixedfunction.js';
import { FOG_SOURCE } from '../webgpu/internal/pipeline.js';

/** D3DSPSM, the source modifiers. */
const MODIFIER = Object.freeze({
    NONE: 0, NEG: 1, BIAS: 2, BIASNEG: 3, SIGN: 4, SIGNNEG: 5, COMP: 6, X2: 7, X2NEG: 8,
    DZ: 9, DW: 10, ABS: 11, ABSNEG: 12, NOT: 13,
});

/** D3DSPDM_SATURATE, in the destination's result modifier. */
const SATURATE = 0x1;

/**
 * The factor a destination's shift scales its result by: _x2, _x4 and _x8
 * as one to three, _d8, _d4 and _d2 as the signed nibble's -3 to -1.
 *
 * @type {Readonly<Record<number, string>>}
 */
const SHIFT = Object.freeze({ 1: '2.0', 2: '4.0', 3: '8.0', 13: '0.125', 14: '0.25', 15: '0.5' });

/** The texture WGSL declares for a sampler of each dimension. */
const TEXTURE_TYPE = Object.freeze({
    '2d': 'texture_2d<f32>', cube: 'texture_cube<f32>', '3d': 'texture_3d<f32>',
});

/**
 * D3DSHADER_COMPARISON, in the control bits of ifc, breakc and setp.
 *
 * @type {Readonly<Record<number, string>>}
 */
const COMPARISON = Object.freeze({ 1: '>', 2: '==', 3: '>=', 4: '<', 5: '!=', 6: '<=' });

/**
 * The sampler types a `dcl` names, and the WGSL texture each is.
 *
 * @type {Readonly<Record<number, string>>}
 */
const SAMPLER_TYPE = Object.freeze({
    2: 'texture_2d<f32>',
    3: 'texture_cube<f32>',
    4: 'texture_3d<f32>',
});

/** The components, by swizzle code. */
const COMPONENT = 'xyzw';

/** Which bind group each stage's constants live in, and where the samplers go. */
export const BIND_GROUP = Object.freeze({ VERTEX_CONSTANTS: 0, PIXEL_CONSTANTS: 1, SAMPLERS: 2 });

/** The constant registers the fixed vertex stage of a hybrid reads. */
export const HYBRID_CONSTANTS = Object.freeze({
    /** Four rows of the world-view-projection, packed as the fixed-function block packs it. */
    MATRIX: 0,
    /** Viewport offset in x and y, then scale in z and w, for pre-transformed vertices. */
    VIEWPORT: 4,
    /** Four rows of world then view: the camera space a generated coordinate is taken in. */
    WORLD_VIEW: 5,
    /** Four rows per stage for eight stages: the texture transform a generated coordinate goes through. */
    TRANSFORMS: 9,
    /** The fixed-function fog's start, end and density, and the fog colour beside it. */
    FOG: 41,
    FOG_COLOR: 42,
    /** Four rows: the inverse transpose of world then view, which the normal goes through. */
    CAMERA_NORMAL: 43,
    /** A point's size, minimum and maximum; then the scale's three coefficients and the viewport height. */
    POINT: 47,
    POINT_SCALE: 48,
    COUNT: 49,
});

/** vs_1_x expp: 2^floor(x), the fraction of x, 2^x, and one. */
const EXP_PARTS = `fn expParts(x: f32) -> vec4f {
    let whole = floor(x);
    return vec4f(exp2(whole), x - whole, exp2(x), 1.0);
}`;

/** vs_1_x logp: the exponent of |x|, its mantissa in [1, 2), log2 |x|, and one. */
const LOG_PARTS = `fn logParts(x: f32) -> vec4f {
    let magnitude = abs(x);
    let exponent = floor(d3dLog(x));
    return vec4f(exponent, select(magnitude / exp2(exponent), 1.0, x == 0.0), d3dLog(x), 1.0);
}`;

/**
 * The scalar instructions whose answer at zero is an infinity, given the
 * largest finite float instead. Under D3D9 a shader goes on to multiply that
 * answer -- rsq of a zero length times the zero vector, rcp of a zero w times
 * a zero distance -- and expects a finite colour; WGSL leaves 1/0 and
 * log2(0) to the implementation, a backend that compiles with fast maths
 * (Metal's) may hand back NaN for them, and inf times zero is NaN everywhere,
 * so a NaN reaches the target and the blend makes it black. pow is
 * exp2(y log2|x|) as the D3D9 reference defines it, so pow(0, 0) is one and
 * no exponent overflows to an infinity either; nrm is the vector times the
 * rsq of its length squared, so the zero vector stays zero.
 */
const D3D_MATH = `const d3dMax = 0x1.fffffep+127f;
fn d3dRcp(x: f32) -> f32 {
    return select(clamp(1.0 / x, -d3dMax, d3dMax), d3dMax, x == 0.0);
}
fn d3dRsq(x: f32) -> f32 {
    return select(min(inverseSqrt(abs(x)), d3dMax), d3dMax, x == 0.0);
}
fn d3dLog(x: f32) -> f32 {
    return select(log2(abs(x)), -d3dMax, x == 0.0);
}
fn d3dPow(x: f32, y: f32) -> f32 {
    return min(exp2(min(y * d3dLog(x), 127.99999)), d3dMax);
}
fn d3dNrm(v: vec3f) -> vec3f {
    return v * d3dRsq(dot(v, v));
}
fn d3dNrm4(v: vec4f) -> vec4f {
    return v * d3dRsq(dot(v.xyz, v.xyz));
}`;

/** Whether a varying location carries a coordinate set. @param {number} location */
const isCoordinate = location=>location >= varyingLocation(D3DDECLUSAGE.TEXCOORD, 0)
    && location <= varyingLocation(D3DDECLUSAGE.TEXCOORD, 7);

/**
 * The lines that move a point's vertex to its corner of the quad the point is
 * drawn as: six corners, two triangles, the corner the vertex index names;
 * half the size in pixels each way, held between the minimum and the maximum
 * (the maximum winning where they cross), and with a sprite every coordinate
 * the quad's own, (0, 0) at its top left.
 *
 * @param {string} corner   The vertex index.
 * @param {string} size     The size before it is held to its limits.
 * @param {string} limits   A vec4f: size, minimum, maximum.
 * @param {string} pixel    A vec2f: one pixel in clip space, as the viewport scale.
 * @param {readonly string[]} sprites  Outputs a sprite's coordinate goes to.
 * @returns {string[]}
 */
export function pointQuadLines(corner, size, limits, pixel, sprites){
    return [
        '    var pointCorners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0),',
        '        vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));',
        `    let pointCorner = pointCorners[${corner}];`,
        `    let pointSize = min(max(${size}, ${limits}.y), ${limits}.z);`,
        '    out.oPos = vec4f(out.oPos.xy + pointCorner * pointSize * 0.5',
        `        * ${pixel} * out.oPos.w, out.oPos.zw);`,
        ...sprites.map(target=>`    ${target} = vec4f(pointCorner * 0.5 + 0.5, 0.0, 1.0);`),
    ];
}

/**
 * Where a hybrid's vertex stage puts table fog's start, end and density, and
 * whether the projection is affine: constant over the draw, so flat. The
 * point-size location, which no pixel shader below model 3 can read.
 */
export const FOG_RANGE_LOCATION = 11;

/**
 * The interpolation a varying at a location is declared with: flat for the
 * two colours under D3DSHADE_FLAT, which both stages must agree on.
 *
 * @param {number} location @param {boolean | undefined} flat
 */
export const colourInterpolation = (location, flat)=>
    (flat && location <= 1 ? ' @interpolate(flat)' : '');

/**
 * Where a varying of a given usage travels between the two stages: colours
 * first, then the coordinate sets, then everything else.
 *
 * @param {number} usage  D3DDECLUSAGE
 * @param {number} index
 */
export function varyingLocation(usage, index){
    switch (usage)
    {
        case D3DDECLUSAGE.COLOR:
            return index;
        case D3DDECLUSAGE.TEXCOORD:
            return 2 + index;
        case D3DDECLUSAGE.FOG:
            return 10;
        case D3DDECLUSAGE.PSIZE:
            return 11;
        default:
            return 12 + usage * 2 + Math.min(index, 1);
    }
}

/**
 * @typedef {Object} InputShape
 *     How one vertex element arrives, as the declaration lays it out.
 * @property {number} components   1 to 4.
 * @property {'f32' | 'u32' | 'i32'} scalar
 * @property {boolean} bgra        A packed colour, whose bytes arrive blue first.
 */

/**
 * @typedef {Object} ShaderInput
 * @property {number} location
 * @property {number} usage       D3DDECLUSAGE
 * @property {number} usageIndex
 * @property {number} register    The v# it arrives in.
 */

/**
 * @typedef {Object} TranslatedShader
 * @property {string} wgsl
 * @property {string} entry       The entry point's name.
 * @property {ShaderInput[]} inputs
 * @property {number[]} outputs   A vertex stage's varyings, as the locations it
 *     writes (`varyingLocation`): what a fragment stage made for it may read.
 * @property {number[]} reads     A pixel stage's varyings, as the locations it
 *     reads: what the vertex stage paired with it has to write.
 * @property {{ index: number, type: string }[]} samplers
 * @property {number} constants   How many float registers the shader reaches.
 * @property {number} [viewportRegister]
 * @property {number} [fogRegister]  A vertex shader carrying fog: the fog colour's
 *           register, with the table curve's range in the one after it.
 *     A vertex shader's: the float register past the ones it reads, where the
 *     viewport's scale is carried for the half-pixel move of its position.
 * @property {number} [alphaRegister]  A pixel shader under the alpha test:
 *           the register holding the reference, as a fraction of 255, in x.
 * @property {number} [pointRegister]  A vertex shader drawing points: the
 *           register holding the state's size, minimum and maximum.
 * @property {number} [bumpRegister]
 *     A 1.x pixel shader's that bumps: the first of the two registers a stage
 *     its bump matrix and luminance travel in, past the ones it reads.
 * @property {string | null} error
 */

/**
 * @param {import('./shader.js').Operand} operand
 * @returns {string} the four-component swizzle, e.g. ".xyzw"
 */
function swizzleOf(operand){
    let text = '';
    for (let component = 0; component < 4; component++)
    {
        text += COMPONENT[(operand.swizzle >>> (component * 2)) & 3];
    }
    return text === 'xyzw' ? '' : `.${text}`;
}

/**
 * The statement that writes a value into a destination through its mask,
 * scaled by its shift and then saturated when asked. A mask of all four is a
 * plain assignment; anything less rebuilds the vector from the old and new
 * components, since WGSL has no assignment through a swizzle.
 *
 * @param {string} target   The WGSL variable.
 * @param {import('./shader.js').Operand} dest
 * @param {string} value    A vec4f expression.
 */
function writeMasked(target, dest, value){
    const scale = SHIFT[dest.shift];
    const shifted = scale ? `(${value} * ${scale})` : value;
    const saturated = (dest.resultModifier & SATURATE) !== 0
        ? `clamp(${shifted}, vec4f(0.0), vec4f(1.0))`
        : shifted;
    if (dest.writeMask === 0xf)
    {
        return `${target} = ${saturated};`;
    }
    const parts = [];
    for (let component = 0; component < 4; component++)
    {
        const letter = COMPONENT[component];
        parts.push((dest.writeMask & (1 << component)) !== 0
            ? `_t.${letter}`
            : `${target}.${letter}`);
    }
    return `{ let _t = ${saturated}; ${target} = vec4f(${parts.join(', ')}); }`;
}

/**
 * Whether an expression is one pair of parentheses around the rest.
 *
 * @param {string} expression
 */
function enclosed(expression){
    let depth = 0;
    for (let at = 0; at < expression.length; at++)
    {
        depth += expression[at] === '(' ? 1 : expression[at] === ')' ? -1 : 0;
        if (depth === 0)
        {
            return at > 0 && at === expression.length - 1;
        }
    }
    return false;
}

/**
 * The WGSL type an input of this shape is declared as in the input structure.
 *
 * @param {InputShape} shape
 */
function inputType(shape){
    const scalar = shape.scalar;
    return shape.components === 1 ? scalar : `vec${shape.components}<${scalar}>`;
}

/**
 * The expression that promotes an input of this shape to the four floats the
 * shader reads: missing components are (0, 0, 0, 1), an integer is converted,
 * and a colour's bytes are put back in red-first order.
 *
 * @param {string} name @param {InputShape} shape
 */
function promoteInput(name, shape){
    const asFloat = shape.scalar === 'f32' ? name : `vec${shape.components}f(${name})`;
    const filled = shape.components === 4
        ? asFloat
        : shape.components === 1
            ? `vec4f(${asFloat}, 0.0, 0.0, 1.0)`
            : shape.components === 2
                ? `vec4f(${asFloat}, 0.0, 1.0)`
                : `vec4f(${asFloat}, 1.0)`;
    return shape.bgra ? `${filled}.zyxw` : filled;
}

/** The shape a test or a caller without a declaration gets: four floats. */
const FOUR_FLOATS = Object.freeze({ components: 4, scalar: 'f32', bgra: false });

/**
 * The uniform declarations and the input and output structures a stage's
 * module opens with, given what its body used.
 *
 * @param {Object} options
 * @param {boolean} options.vertex
 * @param {number} options.constants   Float registers to declare.
 * @param {{ index: number, type: string }[]} options.samplers
 * @param {string[]} options.inputFields    Lines inside the input structure.
 * @param {string[]} options.outputFields   Lines inside the output structure.
 */
function moduleHeader(options){
    const group = options.vertex ? BIND_GROUP.VERTEX_CONSTANTS : BIND_GROUP.PIXEL_CONSTANTS;
    const header = [
        `@group(${group}) @binding(0) var<uniform> c:`
            + ` array<vec4f, ${Math.max(1, options.constants)}>;`,
        `@group(${group}) @binding(1) var<uniform> ci: array<vec4i, 16>;`,
        `@group(${group}) @binding(2) var<uniform> cb: array<vec4u, 4>;`,
    ];
    options.samplers.forEach((entry, at)=>{
        header.push(`@group(${BIND_GROUP.SAMPLERS}) @binding(${at * 2}) var tex${entry.index}:`
            + ` ${entry.type};`);
        header.push(`@group(${BIND_GROUP.SAMPLERS}) @binding(${at * 2 + 1})`
            + ` var samp${entry.index}: sampler;`);
    });
    const inName = options.vertex ? 'VsIn' : 'PsIn';
    const outName = options.vertex ? 'VsOut' : 'PsOut';
    header.push(`struct ${inName} {`, ...options.inputFields, '}');
    header.push(`struct ${outName} {`, ...options.outputFields, '}');
    return header;
}

/**
 * Translates one shader.
 *
 * @param {import('./shader.js').ParsedShader} parsed
 * @param {{ inputs?: Map<number, InputShape>, alsoWrite?: readonly number[],
 *     fog?: number, fogSource?: number, flatColours?: boolean,
 *     stageDimensions?: readonly string[], projectedBy?: readonly string[],
 *     points?: { sprite: boolean }, alphaTest?: number, nanProbe?: boolean }} [options]
 *        For a vertex shader, the shape of each v# the declaration supplies,
 *        by register. Absent means every declared input arrives as four
 *        floats; present, a declared register it does not name reads as the
 *        default vertex. `alsoWrite` names varying locations the paired
 *        pixel stage reads that this shader does not write: each is written
 *        as zero, because a fragment input with no vertex output fails the
 *        pipeline, where Direct3D reads whatever was there. `fog` is the
 *        D3DFOG mode of the fixed-function fog stage that runs after a pixel
 *        shader below model 3: the pixel stage then reads the oFog varying
 *        the vertex stage wrote -- the amount in x and the fog colour in
 *        y,z,w -- and mixes the shader's own colour towards that colour,
 *        which is where Direct3D applies it. Only a draw whose vertex stage
 *        is the fixed one can promise the varying, so only it is fogged.
 *        `fogSource` FOG_SOURCE.TABLE evaluates the curve per pixel instead,
 *        over the range the vertex stage carries at `FOG_RANGE_LOCATION`.
 *        `points` draws a vertex shader's point list as quads, sized by the
 *        shader's oPts or the state's size, and with a sprite every
 *        coordinate set it writes is the quad's own.
 *        `flatColours` declares the two colour varyings flat, for
 *        D3DSHADE_FLAT; the stage paired with this one must say the same.
 *        For a 1.x pixel shader, `stageDimensions` is the dimension ('2d',
 *        'cube', '3d') of the texture bound at each stage, which is what its
 *        reads sample, and `projectedBy` the component each stage's
 *        coordinates are divided by under D3DTTFF_PROJECTED ('' for none),
 *        which a 1.0 to 1.3 shader's reads honour.
 * @returns {TranslatedShader}
 */
export function translateShader(parsed, options = {}){
    const kind = parsed.version.kind;
    const vertex = kind === SHADER_KIND.VERTEX;
    const major = parsed.version.major;
    const minor = parsed.version.minor;
    const legacy = !vertex && major < 2;
    // ps_1_4 reads its coordinate sets as inputs and has temporaries for the
    // rest; 1.0 to 1.3 fill each texture register from its own stage.
    const phased = legacy && minor >= 4;
    const supplied = options.inputs ?? null;
    /** The old four-part expp and logp the body calls. @type {Set<'exp' | 'log'>} */
    const usesParts = new Set();
    /** @type {ShaderInput[]} */
    const inputs = [];
    /** @type {{ index: number, type: string }[]} */
    const samplers = [];
    /**
     * The semantic each numbered register was declared with: a vertex
     * shader's o# outputs, a pixel shader's v# inputs, in model 3.
     *
     * @type {Map<number, { usage: number, usageIndex: number }>}
     */
    const semantics = new Map();
    /** @type {Map<number, string>} def'd constants, as WGSL literals */
    const defined = new Map();
    /** Whether an indexed constant read may land on a def'd register. */
    let relativeDefs = false;
    /** @type {Map<number, string>} */
    const definedInts = new Map();
    /** @type {Map<number, string>} */
    const definedBools = new Map();
    /** @type {Set<string>} every variable the body names, for declaration */
    const used = new Set();
    /** @type {string[]} */
    const body = [];
    /** @type {string | null} */
    let error = null;
    let indent = 1;
    /** The highest float register read directly, or the whole file once one is indexed. */
    let constants = 0;
    /**
     * The open blocks, innermost last, so that the one closing instruction
     * shared by three openers knows what it closes.
     *
     * @type {{ kind: 'if' | 'rep' | 'loop', step?: string }[]}
     */
    const blocks = [];

    /** @param {string} line */
    const emit = line=>{
        body.push(`${'    '.repeat(indent)}${line}`);
    };

    /** @param {string} why */
    const fail = why=>{
        if (!error)
        {
            error = why;
        }
    };

    /** @type {Set<number>} the v# a pixel shader reads */
    const pixelInputs = new Set();
    /** @type {Set<number>} the t# coordinate sets a pixel shader reads */
    const pixelCoordinates = new Set();
    /** @type {Set<number>} the oC# a pixel shader writes, and -1 for depth */
    const pixelOutputs = new Set();
    /** @type {Set<number>} */
    const vertexOutputs = new Set();
    /** @type {Set<number>} the v# a vertex shader reads */
    const vertexInputs = new Set();
    /** @type {number[]} the stages of the texm3x rows taken so far */
    const pendingRows = [];
    let bumps = false;

    /**
     * The WGSL name of a register, declaring what needs declaring as a side
     * effect: the caller sees `r3` and this notes that `r3` exists.
     *
     * @param {import('./shader.js').Operand} operand
     * @param {boolean} writing
     * @returns {string}
     */
    const registerName = (operand, writing)=>{
        const index = operand.index;
        // aL is a scalar counter: it takes no swizzle, where a0 is a vector.
        const relative = !operand.relative ? ''
            : operand.relative.type === REGISTER.LOOP
                ? ` + ${registerName(operand.relative, false)}`
                : ` + i32(${registerName(operand.relative, false)}`
                    + `${swizzleOf(operand.relative)}.x)`;
        switch (operand.type)
        {
            case REGISTER.TEMP:
                used.add(`r${index}`);
                return `r${index}`;
            case REGISTER.INPUT:
                if (vertex)
                {
                    vertexInputs.add(index);
                    return `v${index}`;
                }
                pixelInputs.add(index);
                return `in.v${index}`;
            case REGISTER.CONST:
                if (defined.has(index) && !relative)
                {
                    return `k${index}`;
                }
                constants = relative ? Infinity : Math.max(constants, index + 1);
                // A def'd register is the shader's own whichever way it is
                // read, so an indexed read that lands on one sees the def.
                if (relative && defined.size > 0)
                {
                    relativeDefs = true;
                    return `cAt(${index}${relative})`;
                }
                // A 1.x pixel shader's constants are held to the range of
                // its registers, [-1, 1], however they were set.
                return legacy
                    ? `clamp(c[${index}${relative}], vec4f(-1.0), vec4f(1.0))`
                    : `c[${index}${relative}]`;
            case REGISTER.CONSTINT:
                if (definedInts.has(index) && !relative)
                {
                    return `ki${index}`;
                }
                return `ci[${index}${relative}]`;
            case REGISTER.CONSTBOOL:
                if (definedBools.has(index))
                {
                    return `kb${index}`;
                }
                return `(cb[${index >>> 2}][${index & 3}] != 0u)`;
            case REGISTER.ADDR:
                // The address register in a vertex shader; a texture
                // coordinate in a pixel shader -- and in a 1.x pixel shader
                // the register that `tex` fills, read as the texel from then on.
                if (vertex)
                {
                    used.add('a0');
                    return 'a0';
                }
                if (major < 2 && !phased)
                {
                    // Once `tex` has filled it, a 1.x texture register is a
                    // temporary like any other: the arithmetic that follows
                    // reads it and writes it (`mul t2.xyz, t1, v0`), and a
                    // write into the stage's immutable input would not build.
                    used.add(`t${index}`);
                    return `t${index}`;
                }
                pixelCoordinates.add(index);
                return `in.t${index}`;
            case REGISTER.RASTOUT:
                vertexOutputs.add(index);
                return ['out.oPos', 'out.oFog', 'out.oPts'][index] ?? 'out.oPos';
            case REGISTER.ATTROUT:
                vertexOutputs.add(100 + index);
                return `out.oD${index}`;
            case REGISTER.OUTPUT:
                if (vertex && major >= 3)
                {
                    // The output declared as the position is the position.
                    return semantics.get(index)?.usage === D3DDECLUSAGE.POSITION
                        ? 'out.oPos'
                        : `out.o${index}`;
                }
                vertexOutputs.add(200 + index);
                return `out.oT${index}`;
            case REGISTER.COLOROUT:
                pixelOutputs.add(index);
                return `oC${index}`;
            case REGISTER.DEPTHOUT:
                pixelOutputs.add(-1);
                return 'oDepth';
            case REGISTER.LOOP:
                used.add('aL');
                return 'aL';
            case REGISTER.MISCTYPE:
                // Direct3D 9 puts a pixel's centre on whole coordinates, the
                // first pixel's vPos being (0, 0); WebGPU's position is the
                // centre half a pixel on.
                return index === 0
                    ? 'vec4f(in.vPos.xy - 0.5, 0.0, 1.0)'
                    : 'vec4f(select(-1.0, 1.0, in.vFace))';
            case REGISTER.PREDICATE:
                fail('predicated execution is not translated');
                return 'r0';
            case REGISTER.LABEL:
                fail('subroutines are not translated');
                return 'r0';
            case REGISTER.SAMPLER:
                if (vertex)
                {
                    fail('a texture read from a vertex shader is not translated');
                }
                return `s${index}`;
            default:
                fail(`register type ${operand.type} is not translated`);
                return writing ? 'r0' : 'vec4f(0.0)';
        }
    };

    /**
     * A source, read through its swizzle and modifier, as a vec4f expression.
     *
     * @param {import('./shader.js').Operand} operand
     */
    const source = operand=>{
        const raw = `${registerName(operand, false)}${swizzleOf(operand)}`;
        switch (operand.modifier)
        {
            case MODIFIER.NONE:
                return raw;
            case MODIFIER.NEG:
                return `(-${raw})`;
            case MODIFIER.BIAS:
                return `(${raw} - vec4f(0.5))`;
            case MODIFIER.BIASNEG:
                return `(vec4f(0.5) - ${raw})`;
            case MODIFIER.SIGN:
                return `(${raw} * 2.0 - vec4f(1.0))`;
            case MODIFIER.SIGNNEG:
                return `(vec4f(1.0) - ${raw} * 2.0)`;
            case MODIFIER.COMP:
                return `(vec4f(1.0) - ${raw})`;
            case MODIFIER.X2:
                return `(${raw} * 2.0)`;
            case MODIFIER.X2NEG:
                return `(${raw} * -2.0)`;
            case MODIFIER.DZ:
                return `(${raw} / ${raw}.z)`;
            case MODIFIER.DW:
                return `(${raw} / ${raw}.w)`;
            case MODIFIER.ABS:
                return `abs(${raw})`;
            case MODIFIER.ABSNEG:
                return `(-abs(${raw}))`;
            case MODIFIER.NOT:
                return `(!${raw})`;
            default:
                fail(`source modifier ${operand.modifier} is not translated`);
                return raw;
        }
    };

    /**
     * A boolean source, for the flow control that reads one.
     *
     * @param {import('./shader.js').Operand} operand
     */
    const condition = operand=>{
        const raw = registerName(operand, false);
        return operand.modifier === MODIFIER.NOT ? `(!${raw})` : raw;
    };

    /**
     * An integer source's component, for the loops.
     *
     * @param {import('./shader.js').Operand} operand @param {string} component
     */
    const integer = (operand, component)=>`${registerName(operand, false)}.${component}`;

    /**
     * @param {import('./shader.js').Instruction} instruction
     * @param {string} value  A vec4f expression.
     */
    const write = (instruction, value)=>{
        const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
        emit(writeMasked(registerName(dest, true), dest, value));
    };

    /** @param {import('./shader.js').Instruction} instruction @param {number} at */
    const src = (instruction, at)=>source(instruction.sources[at]);

    /**
     * An expression's components, parenthesised unless it is a name or
     * already in parentheses of its own.
     *
     * @param {string} expression @param {string} components
     */
    const swizzled = (expression, components)=>(/^[\w.[\]]+$/.test(expression)
        || enclosed(expression)
        ? `${expression}.${components}`
        : `(${expression}).${components}`);

    /**
     * A 1.x read of the texture bound at a stage, of the dimension the caller
     * says it has, at the leading components of `at` that dimension takes.
     *
     * @param {number} stage @param {string} at  A vec4f expression.
     */
    const stageSample = (stage, at)=>{
        const dimension = options.stageDimensions?.[stage] ?? '2d';
        if (!samplers.some(one=>one.index === stage))
        {
            samplers.push({
                index: stage,
                type: TEXTURE_TYPE[/** @type {keyof typeof TEXTURE_TYPE} */ (dimension)]
                    ?? TEXTURE_TYPE['2d'],
            });
        }
        return `textureSample(tex${stage}, samp${stage},`
            + ` ${swizzled(at, dimension === '2d' ? 'xy' : 'xyz')})`;
    };

    /**
     * A 1.0 to 1.3 stage's coordinate set, divided as D3DTTFF_PROJECTED asks.
     *
     * @param {number} stage
     */
    const stageCoordinates = stage=>{
        pixelCoordinates.add(stage);
        const by = options.projectedBy?.[stage] ?? '';
        return by ? `(in.t${stage} / in.t${stage}.${by})` : `in.t${stage}`;
    };

    /**
     * Fills a 1.0 to 1.3 texture register, which is read as a temporary from
     * then on.
     *
     * @param {number} stage @param {string} value
     */
    const fill = (stage, value)=>{
        used.add(`t${stage}`);
        emit(`t${stage} = ${value};`);
    };

    /**
     * One row of a texm3x or texdp3 matrix: the stage's coordinates against
     * the source's colour.
     *
     * @param {number} stage @param {string} read
     */
    const rowOf = (stage, read)=>{
        pixelCoordinates.add(stage);
        return `dot(in.t${stage}.xyz, ${swizzled(read, 'xyz')})`;
    };

    /**
     * The register of a stage's bump matrix (0) or luminance (1).
     *
     * @param {number} stage @param {number} which
     */
    const bumpRegisterOf = (stage, which)=>{
        bumps = true;
        return `c[_bump + ${stage * 2 + which}]`;
    };

    /**
     * What a stage's bump matrix moves a coordinate by, for the source's red
     * and green: u by 00 and 10, v by 01 and 11.
     *
     * @param {number} stage @param {string} read
     */
    const bumpOffset = (stage, read)=>{
        const matrix = bumpRegisterOf(stage, 0);
        return `vec2f(dot(${swizzled(read, 'xy')}, ${matrix}.xz),`
            + ` dot(${swizzled(read, 'xy')}, ${matrix}.yw))`;
    };

    /**
     * Writes the depth a quotient spells: one where the divisor is zero, and
     * held to [0, 1] (Wine's d3d9 visual.c texdepth_test).
     *
     * @param {string} dividend @param {string} divisor
     */
    const depth = (dividend, divisor)=>{
        pixelOutputs.add(-1);
        emit(`oDepth = vec4f(select(clamp(${dividend} / ${divisor}, 0.0, 1.0), 1.0,`
            + ` ${divisor} == 0.0));`);
    };

    /**
     * The row dot products the matrix instructions unroll into: `rows` of
     * them, each against the constant register `columns` after the first.
     *
     * @param {import('./shader.js').Instruction} instruction
     * @param {number} rows @param {number} columns
     */
    const matrix = (instruction, rows, columns)=>{
        const vector = src(instruction, 0);
        const first = instruction.sources[1];
        const parts = [];
        for (let row = 0; row < rows; row++)
        {
            const register = { ...first, index: first.index + row };
            const operand = `${registerName(register, false)}${swizzleOf(register)}`;
            parts.push(columns === 4
                ? `dot(${vector}, ${operand})`
                : `dot(${vector}.xyz, ${operand}.xyz)`);
        }
        while (parts.length < 4)
        {
            parts.push('0.0');
        }
        return `vec4f(${parts.join(', ')})`;
    };

    /**
     * A texture read: the coordinate through the sampler's texture, of
     * whichever dimension the sampler was declared with.
     *
     * @param {import('./shader.js').Instruction} instruction
     * @param {string} how   'sample', 'level' or 'grad'.
     */
    const sample = (instruction, how)=>{
        const samplerOperand = instruction.sources[1];
        const entry = samplers.find(one=>one.index === samplerOperand.index);
        if (!entry)
        {
            fail(`sampler s${samplerOperand.index} is read without a declaration`);
            return 'vec4f(0.0)';
        }
        if (vertex)
        {
            fail('a texture read from a vertex shader is not translated');
        }
        const coordinates = entry.type === 'texture_2d<f32>' ? 'xy' : 'xyz';
        const project = (instruction.control & 0x1) !== 0;
        const bias = (instruction.control & 0x2) !== 0;
        const at = project
            ? `(${src(instruction, 0)}.${coordinates} / ${src(instruction, 0)}.w)`
            : `${src(instruction, 0)}.${coordinates}`;
        const pair = `tex${entry.index}, samp${entry.index}`;
        if (how === 'level')
        {
            return `textureSampleLevel(${pair}, ${at}, ${src(instruction, 0)}.w)`;
        }
        if (how === 'grad')
        {
            const derivatives = entry.type === 'texture_2d<f32>' ? 'xy' : 'xyz';
            return `textureSampleGrad(${pair}, ${at}, ${src(instruction, 2)}.${derivatives},`
                + ` ${src(instruction, 3)}.${derivatives})`;
        }
        if (bias)
        {
            return `textureSampleBias(${pair}, ${at}, ${src(instruction, 0)}.w)`;
        }
        return `textureSample(${pair}, ${at})`;
    };

    /** @param {import('./shader.js').Instruction} instruction */
    const comparison = instruction=>COMPARISON[instruction.control & 0x7] ?? '==';

    for (const instruction of parsed.instructions)
    {
        if (instruction.predicated)
        {
            fail('predicated execution is not translated');
        }
        switch (instruction.opcode)
        {
            case OPCODE.NOP:
                break;
            case OPCODE.DCL: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                const declaration = /** @type {any} */ (instruction.declaration);
                if (dest.type === REGISTER.SAMPLER)
                {
                    const type = SAMPLER_TYPE[declaration.samplerType];
                    if (!type)
                    {
                        fail(`sampler type ${declaration.samplerType} is not translated`);
                    }
                    samplers.push({ index: dest.index, type: type ?? 'texture_2d<f32>' });
                }
                else if (dest.type === REGISTER.INPUT && vertex)
                {
                    inputs.push({
                        location: inputs.length,
                        usage: declaration.usage,
                        usageIndex: declaration.usageIndex,
                        register: dest.index,
                    });
                }
                else if (dest.type === REGISTER.INPUT)
                {
                    pixelInputs.add(dest.index);
                    semantics.set(dest.index, declaration);
                }
                else if (dest.type === REGISTER.OUTPUT && vertex)
                {
                    semantics.set(dest.index, declaration);
                }
                else if (dest.type === REGISTER.ADDR && !vertex)
                {
                    pixelCoordinates.add(dest.index);
                }
                break;
            }
            case OPCODE.DEF: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                const floats = new Float32Array(
                    Uint32Array.from(instruction.literals ?? []).buffer);
                defined.set(dest.index, `vec4f(${[...floats]
                    .map(value=>(legacy ? Math.min(1, Math.max(-1, value)) : value))
                    .map(literal).join(', ')})`);
                break;
            }
            case OPCODE.DEFI: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                const ints = new Int32Array(Uint32Array.from(instruction.literals ?? []).buffer);
                definedInts.set(dest.index, `vec4i(${[...ints].join(', ')})`);
                break;
            }
            case OPCODE.DEFB: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                definedBools.set(dest.index, (instruction.literals ?? [0])[0] ? 'true' : 'false');
                break;
            }
            case OPCODE.MOV:
                write(instruction, src(instruction, 0));
                break;
            case OPCODE.MOVA:
                write(instruction, `round(${src(instruction, 0)})`);
                break;
            case OPCODE.ADD:
                write(instruction, `(${src(instruction, 0)} + ${src(instruction, 1)})`);
                break;
            case OPCODE.SUB:
                write(instruction, `(${src(instruction, 0)} - ${src(instruction, 1)})`);
                break;
            case OPCODE.MUL:
                write(instruction, `(${src(instruction, 0)} * ${src(instruction, 1)})`);
                break;
            case OPCODE.MAD:
                write(instruction,
                    `(${src(instruction, 0)} * ${src(instruction, 1)} + ${src(instruction, 2)})`);
                break;
            case OPCODE.MIN:
                write(instruction, `min(${src(instruction, 0)}, ${src(instruction, 1)})`);
                break;
            case OPCODE.MAX:
                write(instruction, `max(${src(instruction, 0)}, ${src(instruction, 1)})`);
                break;
            // A scalar instruction reads the last component its source swizzle
            // names -- w for a plain register, the one component of a
            // replicate (Wine's d3d8 test_scalar_instructions).
            case OPCODE.RCP:
                write(instruction, `vec4f(d3dRcp(${src(instruction, 0)}.w))`);
                break;
            case OPCODE.RSQ:
                write(instruction, `vec4f(d3dRsq(${src(instruction, 0)}.w))`);
                break;
            case OPCODE.EXP:
                write(instruction, `vec4f(exp2(${src(instruction, 0)}.w))`);
                break;
            case OPCODE.EXPP:
                // Below model 2 a vertex shader's expp is the old four-part
                // result: 2^floor, the fraction, the power, and one.
                write(instruction, vertex && major < 2
                    ? `expParts(${src(instruction, 0)}.w)`
                    : `vec4f(exp2(${src(instruction, 0)}.w))`);
                usesParts.add('exp');
                break;
            case OPCODE.LOG:
                write(instruction, `vec4f(d3dLog(${src(instruction, 0)}.w))`);
                break;
            case OPCODE.LOGP:
                // And its logp: the exponent, the mantissa, the logarithm, one.
                write(instruction, vertex && major < 2
                    ? `logParts(${src(instruction, 0)}.w)`
                    : `vec4f(d3dLog(${src(instruction, 0)}.w))`);
                usesParts.add('log');
                break;
            case OPCODE.FRC:
                write(instruction, `fract(${src(instruction, 0)})`);
                break;
            case OPCODE.DP3:
                write(instruction,
                    `vec4f(dot(${src(instruction, 0)}.xyz, ${src(instruction, 1)}.xyz))`);
                break;
            case OPCODE.DP4:
                write(instruction, `vec4f(dot(${src(instruction, 0)}, ${src(instruction, 1)}))`);
                break;
            case OPCODE.DP2ADD:
                write(instruction, `vec4f(dot(${src(instruction, 0)}.xy, ${src(instruction, 1)}.xy)`
                    + ` + ${src(instruction, 2)}.x)`);
                break;
            case OPCODE.SLT:
                write(instruction,
                    `select(vec4f(0.0), vec4f(1.0), ${src(instruction, 0)}`
                    + ` < ${src(instruction, 1)})`);
                break;
            case OPCODE.SGE:
                write(instruction,
                    `select(vec4f(0.0), vec4f(1.0), ${src(instruction, 0)}`
                    + ` >= ${src(instruction, 1)})`);
                break;
            case OPCODE.LIT: {
                const s = src(instruction, 0);
                // z is zero unless both x and y are above zero, so pow never sees
                // the zero base whose zeroth power the hardware does not define.
                write(instruction, `vec4f(1.0, max(${s}.x, 0.0), select(0.0, d3dPow(${s}.y,`
                    + ` clamp(${s}.w, -128.0, 128.0)), ${s}.x > 0.0 && ${s}.y > 0.0), 1.0)`);
                break;
            }
            case OPCODE.DST: {
                const a = src(instruction, 0);
                const b = src(instruction, 1);
                write(instruction, `vec4f(1.0, ${a}.y * ${b}.y, ${a}.z, ${b}.w)`);
                break;
            }
            case OPCODE.LRP:
                write(instruction,
                    `mix(${src(instruction, 2)}, ${src(instruction, 1)}, ${src(instruction, 0)})`);
                break;
            case OPCODE.M4x4:
                write(instruction, matrix(instruction, 4, 4));
                break;
            case OPCODE.M4x3:
                write(instruction, matrix(instruction, 3, 4));
                break;
            case OPCODE.M3x4:
                write(instruction, matrix(instruction, 4, 3));
                break;
            case OPCODE.M3x3:
                write(instruction, matrix(instruction, 3, 3));
                break;
            case OPCODE.M3x2:
                write(instruction, matrix(instruction, 2, 3));
                break;
            case OPCODE.POW:
                write(instruction,
                    `vec4f(d3dPow(${src(instruction, 0)}.x, ${src(instruction, 1)}.x))`);
                break;
            case OPCODE.CRS:
                write(instruction,
                    `vec4f(cross(${src(instruction, 0)}.xyz, ${src(instruction, 1)}.xyz), 0.0)`);
                break;
            case OPCODE.SGN:
                write(instruction, `sign(${src(instruction, 0)})`);
                break;
            case OPCODE.ABS:
                write(instruction, `abs(${src(instruction, 0)})`);
                break;
            case OPCODE.NRM:
                // All four scaled by the rsq of the length of xyz, w too, as the
                // reference pseudo-code writes it.
                write(instruction, `d3dNrm4(${src(instruction, 0)})`);
                break;
            case OPCODE.SINCOS: {
                const s = src(instruction, 0);
                write(instruction, `vec4f(cos(${s}.x), sin(${s}.x), 0.0, 0.0)`);
                break;
            }
            case OPCODE.CMP:
                write(instruction, `select(${src(instruction, 2)}, ${src(instruction, 1)},`
                    + ` ${src(instruction, 0)} >= vec4f(0.0))`);
                break;
            case OPCODE.CND:
                // Co-issued in 1.0 to 1.3, the comparison is not made and
                // the second source is taken (Wine's d3d8 visual.c cnd_test).
                write(instruction, legacy && !phased && instruction.coissue
                    ? src(instruction, 1)
                    : `select(${src(instruction, 2)}, ${src(instruction, 1)},`
                        + ` ${src(instruction, 0)} > vec4f(0.5))`);
                break;
            case OPCODE.DSX:
                write(instruction, `dpdx(${src(instruction, 0)})`);
                break;
            case OPCODE.DSY:
                write(instruction, `dpdy(${src(instruction, 0)})`);
                break;
            case OPCODE.TEXKILL: {
                // The register named is read, not written; in a 1.0 to 1.3
                // shader it is the coordinate set itself, not what a read
                // filled the register with.
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                if (dest.type === REGISTER.ADDR && legacy && !phased)
                {
                    pixelCoordinates.add(dest.index);
                }
                const read = dest.type === REGISTER.ADDR && legacy && !phased
                    ? `in.t${dest.index}`
                    : registerName(dest, false);
                emit(`if (any(${read}.xyz < vec3f(0.0))) { discard; }`);
                break;
            }
            case OPCODE.TEX:
                if (phased)
                {
                    // ps_1_4: `texld rN, src` samples stage N at the source.
                    const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                    write(instruction, stageSample(dest.index, src(instruction, 0)));
                    break;
                }
                if (legacy)
                {
                    // ps_1_x: `tex tN` samples texture N with coordinate set N.
                    const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                    fill(dest.index, stageSample(dest.index, stageCoordinates(dest.index)));
                    break;
                }
                write(instruction, sample(instruction, 'sample'));
                break;
            case OPCODE.TEXLDL:
                write(instruction, sample(instruction, 'level'));
                break;
            case OPCODE.TEXLDD:
                write(instruction, sample(instruction, 'grad'));
                break;
            case OPCODE.TEXCOORD: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                if (phased)
                {
                    // ps_1_4's texcrd: the coordinates, as its source reads them.
                    write(instruction, src(instruction, 0));
                    break;
                }
                // The coordinates as a colour: held to [0, 1], with a w of one.
                pixelCoordinates.add(dest.index);
                fill(dest.index,
                    `vec4f(clamp(in.t${dest.index}.xyz, vec3f(0.0), vec3f(1.0)), 1.0)`);
                break;
            }
            case OPCODE.IF:
                emit(`if (${condition(instruction.sources[0])}) {`);
                blocks.push({ kind: 'if' });
                indent++;
                break;
            case OPCODE.IFC:
                emit(`if (${src(instruction, 0)}.x ${comparison(instruction)}`
                    + ` ${src(instruction, 1)}.x) {`);
                blocks.push({ kind: 'if' });
                indent++;
                break;
            case OPCODE.ELSE:
                indent--;
                emit('} else {');
                indent++;
                break;
            case OPCODE.ENDIF:
            case OPCODE.ENDREP:
            case OPCODE.ENDLOOP: {
                const block = blocks.pop();
                if (!block)
                {
                    fail(`${instruction.name} closes nothing`);
                    break;
                }
                if (block.step)
                {
                    emit(block.step);
                }
                indent--;
                emit('}');
                break;
            }
            case OPCODE.REP:
                emit(`for (var _rep${blocks.length} = 0;`
                    + ` _rep${blocks.length} < ${integer(instruction.sources[0], 'x')};`
                    + ` _rep${blocks.length}++) {`);
                blocks.push({ kind: 'rep' });
                indent++;
                break;
            case OPCODE.LOOP: {
                // loop aL, i#: i.x passes, aL from i.y, stepping by i.z each pass.
                const counter = instruction.sources[1];
                used.add('aL');
                emit(`aL = ${integer(counter, 'y')};`);
                emit(`for (var _loop${blocks.length} = 0;`
                    + ` _loop${blocks.length} < ${integer(counter, 'x')};`
                    + ` _loop${blocks.length}++) {`);
                blocks.push({ kind: 'loop', step: `aL += ${integer(counter, 'z')};` });
                indent++;
                break;
            }
            case OPCODE.BREAK:
                emit('break;');
                break;
            case OPCODE.BREAKC:
                emit(`if (${src(instruction, 0)}.x ${comparison(instruction)}`
                    + ` ${src(instruction, 1)}.x) { break; }`);
                break;
            case OPCODE.RET:
                if (blocks.length === 0)
                {
                    emit('return out;');
                }
                else
                {
                    fail('a return inside a block is not translated');
                }
                break;
            case OPCODE.LABEL:
            case OPCODE.CALL:
            case OPCODE.CALLNZ:
                fail('subroutines are not translated');
                break;
            case OPCODE.SETP:
            case OPCODE.BREAKP:
                fail('predicated execution is not translated');
                break;
            case OPCODE.PHASE:
                break;
            case OPCODE.TEXBEM:
            case OPCODE.TEXBEML: {
                const stage = /** @type {import('./shader.js').Operand} */ (instruction.dest).index;
                const bumped = src(instruction, 0);
                const at = stageCoordinates(stage);
                fill(stage, stageSample(stage, `vec4f(${swizzled(at, 'xy')}`
                    + ` + ${bumpOffset(stage, bumped)}, ${swizzled(at, 'zw')})`));
                if (instruction.opcode === OPCODE.TEXBEML)
                {
                    const luminance = bumpRegisterOf(stage, 1);
                    emit(`t${stage} = vec4f(t${stage}.rgb * clamp(${swizzled(bumped, 'z')}`
                        + ` * ${luminance}.x + ${luminance}.y, 0.0, 1.0), t${stage}.a);`);
                }
                break;
            }
            case OPCODE.BEM: {
                // bem rN.xy: the first source moved by the second through
                // stage N's bump matrix.
                const stage = /** @type {import('./shader.js').Operand} */ (instruction.dest).index;
                write(instruction, `vec4f(${swizzled(src(instruction, 0), 'xy')}`
                    + ` + ${bumpOffset(stage, src(instruction, 1))}, 0.0, 0.0)`);
                break;
            }
            case OPCODE.TEXREG2AR:
            case OPCODE.TEXREG2GB:
            case OPCODE.TEXREG2RGB: {
                const stage = /** @type {import('./shader.js').Operand} */ (instruction.dest).index;
                const read = src(instruction, 0);
                const at = instruction.opcode === OPCODE.TEXREG2AR
                    ? `vec4f(${swizzled(read, 'wx')}, 0.0, 0.0)`
                    : instruction.opcode === OPCODE.TEXREG2GB
                        ? `vec4f(${swizzled(read, 'yz')}, 0.0, 0.0)`
                        : `vec4f(${swizzled(read, 'xyz')}, 0.0)`;
                fill(stage, stageSample(stage, at));
                break;
            }
            case OPCODE.TEXDP3TEX:
            case OPCODE.TEXDP3: {
                const stage = /** @type {import('./shader.js').Operand} */ (instruction.dest).index;
                const product = rowOf(stage, src(instruction, 0));
                fill(stage, instruction.opcode === OPCODE.TEXDP3
                    ? `vec4f(${product})`
                    : stageSample(stage, `vec4f(${product}, 0.0, 0.0, 0.0)`));
                break;
            }
            case OPCODE.TEXM3x2PAD:
            case OPCODE.TEXM3x3PAD: {
                const stage = /** @type {import('./shader.js').Operand} */ (instruction.dest).index;
                const name = `_row${stage}`;
                emit(`let ${name} = ${rowOf(stage, src(instruction, 0))};`);
                pendingRows.push(stage);
                break;
            }
            case OPCODE.TEXM3x2TEX:
            case OPCODE.TEXM3x2DEPTH:
            case OPCODE.TEXM3x3TEX:
            case OPCODE.TEXM3x3:
            case OPCODE.TEXM3x3SPEC:
            case OPCODE.TEXM3x3VSPEC: {
                const stage = /** @type {import('./shader.js').Operand} */ (instruction.dest).index;
                const wide = instruction.opcode !== OPCODE.TEXM3x2TEX
                    && instruction.opcode !== OPCODE.TEXM3x2DEPTH;
                if (pendingRows.length !== (wide ? 2 : 1))
                {
                    fail(`${instruction.name} follows ${pendingRows.length} rows`);
                    break;
                }
                const last = rowOf(stage, src(instruction, 0));
                const product = [...pendingRows.map(row=>`_row${row}`), last];
                const stages = [...pendingRows, stage];
                pendingRows.length = 0;
                if (instruction.opcode === OPCODE.TEXM3x2DEPTH)
                {
                    // The depth the pair of rows spells, z over w.
                    depth(product[0], product[1]);
                    break;
                }
                const vector = `vec3f(${product.join(', ')}${wide ? '' : ', 0.0'})`;
                if (instruction.opcode === OPCODE.TEXM3x3)
                {
                    fill(stage, `vec4f(${vector}, 1.0)`);
                    break;
                }
                if (instruction.opcode === OPCODE.TEXM3x3TEX
                    || instruction.opcode === OPCODE.TEXM3x2TEX)
                {
                    fill(stage, stageSample(stage, `vec4f(${vector}, 0.0)`));
                    break;
                }
                // The eye vector: a constant for spec, the three sets' w for
                // vspec; what is sampled is it reflected about the normal.
                const eye = instruction.opcode === OPCODE.TEXM3x3SPEC
                    ? swizzled(src(instruction, 1), 'xyz')
                    : `vec3f(${stages.map(one=>{
                        pixelCoordinates.add(one);
                        return `in.t${one}.w`;
                    }).join(', ')})`;
                emit(`{ let _n = ${vector}; let _e = ${eye};`
                    + ` t${stage} = ${stageSample(stage,
                        'vec4f(2.0 * dot(_n, _e) / dot(_n, _n) * _n - _e, 0.0)')}; }`);
                used.add(`t${stage}`);
                break;
            }
            case OPCODE.TEXDEPTH: {
                // texdepth r5: r5.r over r5.g.
                const read = registerName(
                    /** @type {import('./shader.js').Operand} */ (instruction.dest), false);
                depth(`${read}.x`, `${read}.y`);
                break;
            }
            default:
                fail(`${instruction.name} is not translated`);
        }
    }

    if (blocks.length > 0)
    {
        fail('a block is left open at the end of the shader');
    }
    if (!vertex && major < 2)
    {
        // A 1.x pixel shader has no colour output register: what r0 holds
        // at the end is the pixel.
        used.add('r0');
        pixelOutputs.add(0);
        body.push('    oC0 = r0;');
    }
    // The immediates a shader defines shadow the register file for its own
    // reads; a constant set from outside does not reach them.
    /** @type {string[]} */
    const immediates = [];
    for (const [index, value] of defined)
    {
        immediates.push(`    let k${index} = ${value};`);
    }
    for (const [index, value] of definedInts)
    {
        immediates.push(`    let ki${index} = ${value};`);
    }
    for (const [index, value] of definedBools)
    {
        immediates.push(`    let kb${index} = ${value};`);
    }

    /** @type {string[]} */
    const declarations = [];
    for (const name of [...used].sort())
    {
        declarations.push(name === 'aL'
            ? '    var aL: i32 = 0;'
            : `    var ${name}: vec4f = vec4f(0.0);`);
    }

    /** @type {string[]} */
    const inputFields = [];
    /** @type {string[]} */
    const outputFields = [];
    /** @type {number[]} */
    const outputs = [];
    /** @type {number[]} */
    const reads = [];
    /** @type {string[]} */
    const prologue = [];
    /** @type {string[]} module-scope declarations the fog stage adds */
    const fogCurve = [];
    /** @type {number | undefined} */
    let viewportRegister;
    /** @type {number | undefined} */
    let fogRegister;
    /** @type {number | undefined} */
    let pointRegister;
    /** A pixel shader under the alpha test: the reference's register. @type {number | undefined} */
    let alphaRegister;
    /** The name each varying location is written under. @type {Map<number, string>} */
    const emitted = new Map();
    let entry;
    if (vertex)
    {
        // Each declared input is promoted to the four floats the body reads,
        // from the shape it arrives in; one the declaration does not supply
        // is the default vertex.
        for (const input of inputs)
        {
            const shape = supplied ? supplied.get(input.register) ?? null : FOUR_FLOATS;
            const name = `v${input.register}`;
            if (shape)
            {
                inputFields.push(`    @location(${input.location}) ${name}: ${inputType(shape)},`);
                prologue.push(`    let ${name} = ${promoteInput(`in.${name}`, shape)};`);
            }
            else
            {
                prologue.push(`    let ${name} = vec4f(0.0, 0.0, 0.0, 1.0);`);
            }
        }
        for (const register of vertexInputs)
        {
            if (!inputs.some(input=>input.register === register))
            {
                fail(`v${register} is read without a declaration`);
            }
        }
        // Invariant, so the same shader compiled into two pipelines -- one
        // mesh drawn in two passes under two pixel shaders -- gives both the
        // same position.
        outputFields.push('    @builtin(position) @invariant oPos: vec4f,');
        /** @param {number} location @param {string} name */
        const emits = (location, name)=>{
            outputFields.push(`    @location(${location})`
                + `${colourInterpolation(location, options.flatColours)} ${name}: vec4f,`);
            outputs.push(location);
            emitted.set(location, name);
        };
        if (major >= 3)
        {
            for (const [index, declaration] of semantics)
            {
                if (declaration.usage !== D3DDECLUSAGE.POSITION)
                {
                    emits(varyingLocation(declaration.usage, declaration.usageIndex), `o${index}`);
                }
            }
        }
        else
        {
            for (const output of [...vertexOutputs].sort((a, b)=>a - b))
            {
                if (output >= 200)
                {
                    emits(varyingLocation(D3DDECLUSAGE.TEXCOORD, output - 200),
                        `oT${output - 200}`);
                }
                else if (output >= 100)
                {
                    emits(varyingLocation(D3DDECLUSAGE.COLOR, output - 100),
                        `oD${output - 100}`);
                    // Below model 3 a colour output leaves the shader held to
                    // [0, 1]; a model 3 output is whatever the shader wrote.
                    body.push(`    out.oD${output - 100} = saturate(out.oD${output - 100});`);
                }
                else if (output === 1)
                {
                    emits(varyingLocation(D3DDECLUSAGE.FOG, 0), 'oFog');
                }
                else if (output === 2)
                {
                    emits(varyingLocation(D3DDECLUSAGE.PSIZE, 0), 'oPts');
                }
            }
        }
        for (const location of options.alsoWrite ?? [])
        {
            if (!outputs.includes(location))
            {
                emits(location, `oX${location}`);
                body.push(`    out.oX${location} = vec4f(0.0);`);
            }
        }
        // Direct3D puts a pixel's centre on its integer coordinate and WebGPU
        // half a pixel further on, so the position the shader wrote moves by
        // half a pixel: half the viewport's scale in clip space, times w.
        viewportRegister = constants === Infinity ? 256 : constants;
        body.push(`    out.oPos = vec4f(out.oPos.xy + out.oPos.w * c[${viewportRegister}].xy`
            + ' * 0.5, out.oPos.zw);');
        // The fog stage after a pixel shader below model 3 reads the oFog
        // varying as the fixed vertex stage writes it: the amount, then the
        // fog colour. Through a vertex shader the amount is what the shader
        // put in oFog, and a shader that writes none is fogged whole; table fog
        // is the pixel's own, and takes the curve's range beside it.
        const carried = options.fogSource ?? FOG_SOURCE.NONE;
        if (carried !== FOG_SOURCE.NONE)
        {
            fogRegister = viewportRegister + 1;
            const wrote = vertexOutputs.has(1) && major < 3;
            if (!wrote)
            {
                emits(varyingLocation(D3DDECLUSAGE.FOG, 0), 'oFog');
            }
            const amount = carried === FOG_SOURCE.VERTEX && wrote ? 'out.oFog.x' : '0.0';
            body.push(`    out.oFog = vec4f(${amount}, c[${fogRegister}].rgb);`);
            if (carried === FOG_SOURCE.TABLE)
            {
                outputFields.push(`    @location(${FOG_RANGE_LOCATION}) @interpolate(flat)`
                    + ` o${FOG_RANGE_LOCATION}: vec4f,`);
                outputs.push(FOG_RANGE_LOCATION);
                body.push(`    out.o${FOG_RANGE_LOCATION} = c[${fogRegister + 1}];`);
            }
        }
        if (options.points)
        {
            pointRegister = fogRegister !== undefined ? fogRegister + 2 : viewportRegister + 1;
            inputFields.push('    @builtin(vertex_index) corner: u32,');
            const sprites = options.points.sprite
                ? [...emitted].filter(([location])=>isCoordinate(location))
                    .map(([, name])=>`out.${name}`)
                : [];
            body.push(...pointQuadLines('in.corner',
                vertexOutputs.has(2) && major < 3 ? 'out.oPts.x' : `c[${pointRegister}].x`,
                `c[${pointRegister}]`, `c[${viewportRegister}].xy`, sprites));
        }
        entry = 'vs_main';
    }
    else
    {
        inputFields.push('    @builtin(position) vPos: vec4f,');
        inputFields.push('    @builtin(front_facing) vFace: bool,');
        for (const set of [...pixelCoordinates].sort((a, b)=>a - b))
        {
            const location = varyingLocation(D3DDECLUSAGE.TEXCOORD, set);
            inputFields.push(`    @location(${location}) t${set}: vec4f,`);
            reads.push(location);
        }
        for (const input of [...pixelInputs].sort((a, b)=>a - b))
        {
            const declaration = major >= 3 ? semantics.get(input) : undefined;
            const location = declaration
                ? varyingLocation(declaration.usage, declaration.usageIndex)
                : varyingLocation(D3DDECLUSAGE.COLOR, input);
            inputFields.push(`    @location(${location})`
                + `${colourInterpolation(location, options.flatColours)} v${input}: vec4f,`);
            reads.push(location);
        }
        for (const output of [...pixelOutputs].sort((a, b)=>a - b))
        {
            outputFields.push(output < 0
                ? '    @builtin(frag_depth) oDepth: f32,'
                : `    @location(${output}) oC${output}: vec4f,`);
            declarations.push(output < 0
                ? '    var oDepth: vec4f = vec4f(0.0);'
                : `    var oC${output}: vec4f = vec4f(0.0);`);
            body.push(output < 0
                ? '    out.oDepth = oDepth.x;'
                : `    out.oC${output} = oC${output};`);
        }
        // The fog stage Direct3D applies after a pixel shader below model 3:
        // what the shader wrote is the colour it mixes towards the fog, by the
        // factor the vertex stage carried in the oFog varying -- its amount in
        // x and the fog colour in y,z,w. The mix goes in after the body and
        // before the outputs are written: fog on the shaded colour.
        const table = options.fogSource === FOG_SOURCE.TABLE;
        // Any source fogs, a curve set or not: through a vertex shader the
        // amount is the shader's own oFog with no mode at all.
        const fogged = options.fog || (options.fogSource ?? FOG_SOURCE.NONE) !== FOG_SOURCE.NONE;
        if (fogged && pixelOutputs.has(0))
        {
            inputFields.push(`    @location(${varyingLocation(D3DDECLUSAGE.FOG, 0)}) fog: vec4f,`);
            reads.push(varyingLocation(D3DDECLUSAGE.FOG, 0));
            // Table fog over the pixel's z under an affine projection, its w
            // otherwise; the curve reads its range from a module variable,
            // since a function cannot see the entry point's input.
            const amount = table
                ? 'fogFactorOf(select(d3dRcp(in.vPos.w), in.vPos.z, fogRange.w != 0.0))'
                : 'in.fog.x';
            const fogLines = [
                ...(table ? ['    fogRange = in.fogRange;'] : []),
                `    oC0 = vec4f(mix(in.fog.yzw, oC0.rgb, clamp(${amount}, 0.0, 1.0)), oC0.a);`,
            ];
            if (table)
            {
                inputFields.push(`    @location(${FOG_RANGE_LOCATION}) @interpolate(flat)`
                    + ' fogRange: vec4f,');
                reads.push(FOG_RANGE_LOCATION);
                fogCurve.push('var<private> fogRange: vec4f;',
                    fogFunctionDeclaration(options.fog ?? 0, 'fogRange').trimEnd());
            }
            const at = body.indexOf('    out.oC0 = oC0;');
            body.splice(at < 0 ? body.length : at, 0, ...fogLines);
        }
        // A colour that came out NaN or infinite, magenta: read by its bits,
        // which a compiler with fast maths cannot fold away as it may x != x.
        if (options.nanProbe === true && pixelOutputs.has(0))
        {
            const at = body.indexOf('    out.oC0 = oC0;');
            body.splice(at < 0 ? body.length : at, 0,
                '    if (any((bitcast<vec4u>(oC0) & vec4u(0x7f800000u)) == vec4u(0x7f800000u))) {',
                '        oC0 = vec4f(1.0, 0.0, 1.0, 1.0);',
                '    }');
        }
        // D3DRS_ALPHATESTENABLE runs after the pixel shader as after the
        // fixed stages: the colour's alpha, as written, against the
        // reference the register past the shader's own carries.
        if (options.alphaTest !== undefined && pixelOutputs.has(0))
        {
            alphaRegister = -1;
            const at = body.indexOf('    out.oC0 = oC0;');
            body.splice(at < 0 ? body.length : at, 0,
                `    if (!(${compareExpression(options.alphaTest, 'clamp(oC0.a, 0.0, 1.0)',
                    'c[_alphaRef].x')})) {`,
                '        discard;',
                '    }');
        }
        entry = 'ps_main';
    }

    // The bump registers follow the ones the shader reads, eight stages of
    // two, named through a module constant so the body did not need to know
    // where they would start.
    const bumpRegister = bumps ? constants : undefined;
    if (alphaRegister !== undefined)
    {
        alphaRegister = bumpRegister !== undefined ? bumpRegister + 16
            : constants === Infinity ? 224 : constants;
    }
    const reach = (()=>{
        if (alphaRegister !== undefined)
        {
            return alphaRegister + 1;
        }
        if (pointRegister !== undefined)
        {
            return pointRegister + 1;
        }
        if (fogRegister !== undefined)
        {
            return fogRegister + 2;
        }
        if (viewportRegister !== undefined)
        {
            return viewportRegister + 1;
        }
        if (bumpRegister !== undefined)
        {
            return bumpRegister + 16;
        }
        return constants === Infinity ? 224 : constants;
    })();
    const wgsl = [
        ...moduleHeader({
            vertex, constants: reach, samplers, inputFields, outputFields,
        }),
        D3D_MATH,
        ...fogCurve,
        ...(relativeDefs ? [
            'fn cAt(i: i32) -> vec4f {',
            '    switch i {',
            ...[...defined].map(([index, value])=>`        case ${index}i: { return ${value}; }`),
            '        default: { return c[i]; }',
            '    }',
            '}',
        ] : []),
        ...(usesParts.has('exp') && vertex && major < 2 ? [EXP_PARTS] : []),
        ...(usesParts.has('log') && vertex && major < 2 ? [LOG_PARTS] : []),
        ...(bumpRegister === undefined ? [] : [`const _bump = ${bumpRegister};`]),
        ...(alphaRegister === undefined ? [] : [`const _alphaRef = ${alphaRegister};`]),
        vertex ? '@vertex' : '@fragment',
        `fn ${entry}(in: ${vertex ? 'VsIn' : 'PsIn'}) -> ${vertex ? 'VsOut' : 'PsOut'} {`,
        `    var out: ${vertex ? 'VsOut' : 'PsOut'};`,
        ...declarations,
        ...prologue,
        ...immediates,
        ...body,
        '    return out;',
        '}',
    ].join('\n');

    return {
        wgsl, entry, inputs, outputs, reads, samplers, constants: reach,
        ...(viewportRegister === undefined ? {} : { viewportRegister }),
        ...(fogRegister === undefined ? {} : { fogRegister }),
        ...(pointRegister === undefined ? {} : { pointRegister }),
        ...(alphaRegister === undefined ? {} : { alphaRegister }),
        ...(bumpRegister === undefined ? {} : { bumpRegister }),
        error,
    };
}

/** D3DTSS_TCI_ modes a hybrid's vertex stage generates a coordinate under. */
const TCI_CAMERASPACENORMAL = 0x10000;
const TCI_CAMERASPACEREFLECTIONVECTOR = 0x30000;

/**
 * A vertex stage for a draw that binds a pixel shader and no vertex shader:
 * fixed-function transform feeding a programmable pixel stage, which is the
 * shape of a full-screen post-process quad. The position goes through the
 * world-view-projection in `c[0..3]`, or through the viewport in `c[4]` when
 * the vertex is already transformed; every colour and coordinate set the
 * declaration carries is passed to the location the pixel shader reads it at.
 *
 * @param {readonly { usage: number, usageIndex: number, register: number }[]} elements
 *        The declaration's elements, with the location each will arrive at
 *        as its `register`.
 * @param {Map<number, InputShape>} shapes  By register.
 * @param {readonly number[]} [alsoWrite]
 *        Varying locations the pixel shader reads that the declaration does
 *        not supply. A fragment input with no vertex output fails the
 *        pipeline, so each is written as the fixed-function pipeline leaves
 *        it: a colour as white, a coordinate set as zero.
 * @param {readonly number[]} [generated]
 *        Per coordinate set, the D3DTSS_TCI_ mode the stage of that number
 *        generates it under, or zero for a set the vertex carries: the
 *        fixed function computes it from the vertex in camera space (world
 *        then view in `c[WORLD_VIEW..]`) and puts it through the stage's
 *        transform (`c[TRANSFORMS..]`), whatever the declaration carries
 *        under that set.
 * @param {number} [fog]  D3DFOG mode, the curve; zero for none.
 * @param {number} [fogSource]  FOG_SOURCE; by default vertex fog for a curve
 *        and none without one. Fogged, the stage writes the oFog varying a
 *        fogged pixel shader reads -- the fixed function's factor and the fog
 *        colour -- which is the stage Direct3D applies after a pixel shader
 *        below model 3: the curve over the camera-space depth for vertex fog,
 *        the specular alpha for a pre-transformed vertex or with no mode set,
 *        and for table fog the colour alone, with the curve's range beside it
 *        for the pixel shader to evaluate per pixel.
 * @param {{ flatColours?: boolean, normalizeNormals?: boolean, rangeFog?: boolean,
 *     points?: { sprite: boolean, scale: boolean } }} [options]
 *        `flatColours`: the two colour varyings flat, for D3DSHADE_FLAT, as
 *        the pixel shader must read them. `normalizeNormals`:
 *        D3DRS_NORMALIZENORMALS, whether the camera-space normal a
 *        coordinate is generated from is renormalised. `rangeFog`:
 *        D3DRS_RANGEFOGENABLE, vertex fog over the distance from the eye.
 *        `points`: a point list drawn as quads, sized by the vertex's PSIZE
 *        or the state's, scaled with the distance as the fixed function does.
 * @returns {TranslatedShader}
 */
export function fixedVertexStage(elements, shapes, alsoWrite = [], generated = [], fog = 0,
    fogSource = fog === 0 ? FOG_SOURCE.NONE : FOG_SOURCE.VERTEX, options = {})
{
    const flatColours = options.flatColours === true;
    /** @type {string[]} */
    const inputFields = [];
    /** @type {string[]} */
    const outputFields = ['    @builtin(position) @invariant oPos: vec4f,'];
    /** @type {number[]} */
    const outputs = [];
    /** @type {string[]} */
    const body = [];
    /** @type {ShaderInput[]} */
    const inputs = [];
    let position = null;
    let vertex = null;
    let normal = 'vec3f(0.0, 0.0, 1.0)';
    let specularAlpha = '1.0';
    let pointBase = `c[${HYBRID_CONSTANTS.POINT}].x`;
    for (const element of elements)
    {
        const shape = shapes.get(element.register) ?? FOUR_FLOATS;
        const name = `v${element.register}`;
        inputFields.push(`    @location(${element.register}) ${name}: ${inputType(shape)},`);
        inputs.push({
            location: element.register, usage: element.usage, usageIndex: element.usageIndex,
            register: element.register,
        });
        const value = promoteInput(`in.${name}`, shape);
        if (element.usage === D3DDECLUSAGE.POSITION)
        {
            position = `mat4x4f(c[0], c[1], c[2], c[3]) * vec4f(${value}.xyz, 1.0)`;
            vertex = `${value}.xyz`;
        }
        else if (element.usage === D3DDECLUSAGE.POSITIONT)
        {
            position = `viewportPosition(${value})`;
        }
        else if (element.usage === D3DDECLUSAGE.NORMAL)
        {
            normal = `${value}.xyz`;
        }
        else if (element.usage === D3DDECLUSAGE.PSIZE)
        {
            pointBase = `${value}.x`;
        }
        else if (element.usage === D3DDECLUSAGE.TEXCOORD
            && (generated[element.usageIndex] ?? 0) !== 0)
        {
            // Generated under this set's number: the carried set is not what
            // the stage samples with.
            continue;
        }
        else if (element.usage === D3DDECLUSAGE.COLOR || element.usage === D3DDECLUSAGE.TEXCOORD)
        {
            if (element.usage === D3DDECLUSAGE.COLOR && element.usageIndex === 1)
            {
                specularAlpha = `${value}.w`;
            }
            const location = varyingLocation(element.usage, element.usageIndex);
            outputFields.push(`    @location(${location})`
                + `${colourInterpolation(location, flatColours)} o${location}: vec4f,`);
            outputs.push(location);
            body.push(`    out.o${location} = ${value};`);
        }
    }
    if (generated.some(mode=>mode !== 0) && vertex)
    {
        const wv = HYBRID_CONSTANTS.WORLD_VIEW;
        const cn = HYBRID_CONSTANTS.CAMERA_NORMAL;
        const turned = `(mat4x4f(c[${cn}], c[${cn + 1}], c[${cn + 2}], c[${cn + 3}])`
            + ` * vec4f(${normal}, 0.0)).xyz`;
        body.push(
            `    let worldView = mat4x4f(c[${wv}], c[${wv + 1}], c[${wv + 2}], c[${wv + 3}]);`,
            `    let cameraPosition = (worldView * vec4f(${vertex}, 1.0)).xyz;`,
            options.normalizeNormals
                ? `    let cameraNormal = d3dNrm(${turned});`
                : `    let cameraNormal = ${turned};`);
    }
    for (const [set, mode] of generated.entries())
    {
        if (mode === 0)
        {
            continue;
        }
        const location = varyingLocation(D3DDECLUSAGE.TEXCOORD, set);
        outputFields.push(`    @location(${location}) o${location}: vec4f,`);
        outputs.push(location);
        if (!vertex)
        {
            body.push(`    out.o${location} = vec4f(0.0);`);
            continue;
        }
        const coordinate = mode === TCI_CAMERASPACENORMAL ? 'cameraNormal'
            : mode === TCI_CAMERASPACEREFLECTIONVECTOR
                ? 'reflect(d3dNrm(cameraPosition), cameraNormal)'
                : 'cameraPosition';
        const row = HYBRID_CONSTANTS.TRANSFORMS + set * 4;
        body.push(`    out.o${location} = vec4f(dot(c[${row}], vec4f(${coordinate}, 1.0)),`
            + ` dot(c[${row + 1}], vec4f(${coordinate}, 1.0)),`
            + ` dot(c[${row + 2}], vec4f(${coordinate}, 1.0)),`
            + ` dot(c[${row + 3}], vec4f(${coordinate}, 1.0)));`);
    }
    // The fog the fixed-function stage adds after the pixel shader, with the
    // colour beside it so a fogged pixel shader needs nothing but varyings to
    // apply it. Vertex fog is the curve over the magnitude of the vertex's
    // camera-space z -- not its clip w, which an orthographic projection
    // holds at one -- and a pre-transformed vertex has no camera space, so
    // its fog is its specular alpha, as it is with no mode set at all.
    const vertexFog = fogSource === FOG_SOURCE.VERTEX && vertex !== null;
    if (fogSource !== FOG_SOURCE.NONE)
    {
        const location = varyingLocation(D3DDECLUSAGE.FOG, 0);
        outputFields.push(`    @location(${location}) o${location}: vec4f,`);
        outputs.push(location);
        const wv = HYBRID_CONSTANTS.WORLD_VIEW;
        const camera = `(mat4x4f(c[${wv}], c[${wv + 1}], c[${wv + 2}], c[${wv + 3}])`
            + ` * vec4f(${vertex}, 1.0))`;
        const amount = fogSource === FOG_SOURCE.TABLE ? '0.0'
            : vertexFog
                ? `fogFactorOf(${options.rangeFog ? `length(${camera}.xyz)` : `abs(${camera}.z)`})`
                : specularAlpha;
        body.push(`    out.o${location} = vec4f(${amount}, c[${HYBRID_CONSTANTS.FOG_COLOR}].rgb);`);
    }
    if (fogSource === FOG_SOURCE.TABLE)
    {
        outputFields.push(`    @location(${FOG_RANGE_LOCATION}) @interpolate(flat)`
            + ` o${FOG_RANGE_LOCATION}: vec4f,`);
        outputs.push(FOG_RANGE_LOCATION);
        body.push(`    out.o${FOG_RANGE_LOCATION} = c[${HYBRID_CONSTANTS.FOG}];`);
    }
    for (const location of alsoWrite)
    {
        if (!outputs.includes(location))
        {
            outputFields.push(`    @location(${location})`
                + `${colourInterpolation(location, flatColours)} o${location}: vec4f,`);
            outputs.push(location);
            const colour = location === varyingLocation(D3DDECLUSAGE.COLOR, 0)
                || location === varyingLocation(D3DDECLUSAGE.COLOR, 1);
            body.push(`    out.o${location} = vec4f(${colour ? '1.0' : '0.0'});`);
        }
    }
    if (options.points)
    {
        inputFields.push('    @builtin(vertex_index) corner: u32,');
        const wv = HYBRID_CONSTANTS.WORLD_VIEW;
        const scale = `c[${HYBRID_CONSTANTS.POINT_SCALE}]`;
        const distance = `length((mat4x4f(c[${wv}], c[${wv + 1}], c[${wv + 2}], c[${wv + 3}])`
            + ` * vec4f(${vertex}, 1.0)).xyz)`;
        const size = options.points.scale && vertex
            ? `${scale}.w * ${pointBase} * inverseSqrt(${scale}.x + ${scale}.y * ${distance}`
                + ` + ${scale}.z * ${distance} * ${distance})`
            : pointBase;
        body.push(...pointQuadLines('in.corner', size, `c[${HYBRID_CONSTANTS.POINT}]`,
            `c[${HYBRID_CONSTANTS.VIEWPORT}].zw`, options.points.sprite
                ? outputs.filter(isCoordinate).map(location=>`out.o${location}`)
                : []));
    }
    // Half a pixel on to WebGPU's pixel centres, as every Direct3D position.
    body.unshift(`    out.oPos = ${position ?? 'vec4f(0.0, 0.0, 0.0, 1.0)'};`,
        `    out.oPos = vec4f(out.oPos.xy + out.oPos.w * c[${HYBRID_CONSTANTS.VIEWPORT}].zw`
            + ' * 0.5, out.oPos.zw);');
    const wgsl = [
        ...moduleHeader({
            vertex: true, constants: HYBRID_CONSTANTS.COUNT, samplers: [], inputFields,
            outputFields,
        }),
        D3D_MATH,
        // The fog curve over the fixed function's own range row.
        fogFunctionDeclaration(vertexFog ? fog : 0, `c[${HYBRID_CONSTANTS.FOG}]`, true).trimEnd(),
        // The viewport's inverse offset and scale, as the fixed-function stage
        // applies them to a vertex given in target pixels, and its RHW back as
        // the clip w the rasteriser interpolates by (one for none to give).
        'fn viewportPosition(vertex: vec4f) -> vec4f {',
        `    let screen = (vertex.xy + c[${HYBRID_CONSTANTS.VIEWPORT}].xy)`
            + ` * c[${HYBRID_CONSTANTS.VIEWPORT}].zw;`,
        '    let clipW = select(1.0, 1.0 / vertex.w, vertex.w > 0.0);',
        '    return vec4f(screen.x - 1.0, screen.y + 1.0, vertex.z, 1.0) * clipW;',
        '}',
        '@vertex',
        'fn vs_main(in: VsIn) -> VsOut {',
        '    var out: VsOut;',
        ...body,
        '    return out;',
        '}',
    ].join('\n');
    return {
        wgsl, entry: 'vs_main', inputs, outputs, reads: [], samplers: [],
        constants: HYBRID_CONSTANTS.COUNT,
        error: position ? null : 'the declaration carries no position',
    };
}

/** @param {number} value @returns {string} a WGSL float literal */
function literal(value){
    if (!Number.isFinite(value))
    {
        return '0.0';
    }
    const text = String(value);
    return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}
