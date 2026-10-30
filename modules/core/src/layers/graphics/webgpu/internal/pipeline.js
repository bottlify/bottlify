/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Render state, turned into a pipeline.
 *
 * A Direct3D device sets state one value at a time and then draws; WebGPU wants
 * all of it decided in advance, baked into an immutable pipeline. So every draw
 * asks this for the pipeline its current state describes, and the answer has to
 * be cached or the frame builds hundreds of identical ones.
 *
 * Which makes the cache key the load-bearing part of this file. A key that
 * folds less than the pipeline actually depends on hands two draws that differ
 * one pipeline, and the second draw renders -- with the first draw's blend
 * mode, or its depth test, or its shader. Nothing reports it. The rule is that
 * every field this file reads on the way to building a descriptor is a field
 * the key folds, and the two are written next to each other so that adding one
 * without the other is visible.
 *
 * The texture-stage cascade deserves its own note. The fragment formula depends
 * on more than stage zero: a second stage arms a different combination, and a
 * texture coordinate index other than the obvious one selects different
 * coordinates. A key built from stage zero and a count collides across draws
 * that differ in both. So stages are folded individually, and the default is
 * expressible as *off* rather than as stage zero's value -- otherwise "no
 * stages" and "one default stage" produce the same key and are not the same
 * picture.
 */

/**
 * Where the fog factor of a draw comes from, which is decided by which of the
 * two fog modes is set and not by the curve either of them names.
 *
 * - SPECULAR: the vertex's specular alpha, interpolated. D3DRS_FOGENABLE with
 *   both modes NONE, and vertex fog on a pre-transformed vertex, which has no
 *   eye space for the vertex pipeline to take a depth in.
 * - VERTEX: D3DRS_FOGVERTEXMODE's curve, evaluated per vertex over the
 *   magnitude of its camera-space z and interpolated.
 * - TABLE: D3DRS_FOGTABLEMODE's curve, evaluated per pixel over the pixel's
 *   depth: its z when the projection is affine, its w otherwise.
 */
export const FOG_SOURCE = Object.freeze({ NONE: 0, SPECULAR: 1, VERTEX: 2, TABLE: 3 });

/**
 * A state's fog source. A state that names a curve and no source is vertex
 * fog.
 *
 * @param {{ fogMode: number, fogSource?: number }} state
 * @returns {number} FOG_SOURCE
 */
export const fogSourceOf = state=>state.fogSource
    ?? (state.fogMode === 0 ? FOG_SOURCE.NONE : FOG_SOURCE.VERTEX);

/** D3DCMP → WebGPU's compare function. One is the identity of the other. */
const COMPARE = Object.freeze({
    1: 'never',
    2: 'less',
    3: 'equal',
    4: 'less-equal',
    5: 'greater',
    6: 'not-equal',
    7: 'greater-equal',
    8: 'always',
});

/**
 * D3DBLEND → WebGPU's blend factor.
 *
 * Two have no counterpart and are not silently approximated. BOTHSRCALPHA sets
 * the source *and* destination factor from one value, which is a pair of
 * factors rather than a factor, and BOTHINVSRCALPHA likewise; a caller has to
 * expand them before it gets here, and one that does not is told.
 */
const BLEND_FACTOR = Object.freeze({
    1: 'zero',
    2: 'one',
    3: 'src',
    4: 'one-minus-src',
    5: 'src-alpha',
    6: 'one-minus-src-alpha',
    7: 'dst-alpha',
    8: 'one-minus-dst-alpha',
    9: 'dst',
    10: 'one-minus-dst',
    11: 'src-alpha-saturated',
    14: 'constant',
    15: 'one-minus-constant',
});

/** D3DBLENDOP → WebGPU's blend operation. */
const BLEND_OP = Object.freeze({
    1: 'add',
    2: 'subtract',
    3: 'reverse-subtract',
    4: 'min',
    5: 'max',
});

/**
 * D3DCULL → WebGPU's cull face.
 *
 * Direct3D names the winding it discards and WebGPU names the face it culls,
 * with front faces counter-clockwise unless told otherwise. So D3DCULL_CW
 * discards clockwise triangles, which are the back faces under that rule, and
 * D3DCULL_CCW discards the front ones. Getting this backwards turns a model
 * inside out, which reads as geometry vanishing when the camera moves rather
 * than as anything obviously wrong with culling.
 *
 * Nothing needs flipping on the way across: both APIs put the framebuffer
 * origin at the top left with Y up through the clip volume, so a triangle's
 * winding on screen is the same one Direct3D judged.
 */
const CULL = Object.freeze({ 1: 'none', 2: 'back', 3: 'front' });

/** D3DSTENCILOP to WebGPU's stencil operation. */
const STENCIL_OP = Object.freeze({
    1: 'keep', 2: 'zero', 3: 'replace', 4: 'increment-clamp', 5: 'decrement-clamp',
    6: 'invert', 7: 'increment-wrap', 8: 'decrement-wrap',
});

/** @param {Record<number, string>} table @param {number} value @param {string} what */
function lookUp(table, value, what){
    const found = table[value];
    if (found === undefined)
    {
        throw new Error(`Unsupported ${what}: ${value}`);
    }
    return found;
}

/**
 * A texture stage, reduced to what the fragment formula depends on.
 *
 * Anything a stage carries that the formula does not read is deliberately not
 * here: it would widen the key and split pipelines that draw identically.
 *
 * @typedef {Object} StageKey
 * @property {number} colorOp
 * @property {number} colorArg1
 * @property {number} colorArg2
 * @property {number} alphaOp
 * @property {number} alphaArg1
 * @property {number} alphaArg2
 * @property {number} [colorArg0]  MULTIPLYADD's and LERP's third operand; CURRENT if absent
 * @property {number} [alphaArg0]
 * @property {number} texCoordIndex
 * @property {number} [projected]
 *     For a stage generating its coordinate: which component the transformed
 *     coordinate is divided by at the sample -- 3 or 4 under
 *     D3DTTFF_PROJECTED with that count, 0 or absent for no divide.
 * @property {number[]} [bump]
 *     A BUMPENVMAP stage's matrix and luminance, as numbers: BUMPENVMAT00, 01,
 *     10, 11, BUMPENVLSCALE, BUMPENVLOFFSET. Carried in the draw's uniform block
 *     (`bumpEnv`), not the key, so only a bump stage carries them.
 * @property {number} [colorKey]
 *     Direct3D 7 colour keying in force on this stage's texture: the key as
 *     its texel expands, 0xRRGGBB. A texel of that colour is not drawn.
 * @property {'cube' | '3d'} [dimension]
 *     The texture the stage samples, when it is not two-dimensional: its
 *     coordinate is then three components and its binding another kind.
 * @property {number} [ones]
 *     The channels the stage's texture samples as one that the GPU's texture
 *     lacks (`sampledOnes` in `d3d9/constants.js`), when there are any.
 * @property {number} [lodBias]
 *     D3DTSS_MIPMAPLODBIAS of a stage that samples, when it is not zero: added
 *     to the level of detail its sample computes. Written into the shader, so
 *     only a stage with one carries it.
 * @property {number} [mirrorOnce]
 *     The axes (1 u, 2 v, 4 w) a sampling stage addresses D3DTADDRESS_MIRRORONCE,
 *     which no WebGPU sampler has: the sample folds the coordinate itself.
 * @property {number} [resultArg]
 *     D3DTSS_RESULTARG when it is D3DTA_TEMP: the stage writes the temporary
 *     register and leaves the current colour as it was. Absent, it writes the
 *     current colour, the default.
 * @property {{ mask: number, colour: number }} [border]
 *     The axes it addresses D3DTADDRESS_BORDER, and D3DSAMP_BORDERCOLOR as a
 *     D3DCOLOR, which the sample selects outside [0, 1] on those axes.
 */

/**
 * What transform-and-lighting the vertex stage runs, or null for a vertex that
 * is used as it arrives.
 *
 * Only what changes the *shape* of the equation is here: how many lights there
 * are and what kind each one is, and which colour each term is taken from. The
 * light's own numbers -- its colour, its position, its attenuation -- are
 * uniforms, because a light that moves must not compile a pipeline.
 *
 * @typedef {Object} LightingState
 * @property {number[]} lights   D3DLIGHTTYPE of each enabled light, in index order.
 * @property {boolean} colorVertex
 * @property {number} diffuseSource   D3DMCS
 * @property {number} ambientSource
 * @property {number} specularSource
 * @property {number} emissiveSource
 * @property {boolean} [localViewer]  D3DRS_LOCALVIEWER; absent is on, its default.
 *           Off, the highlight's direction to the viewer is one direction for
 *           every vertex, which the block carries in `eye` instead of the eye.
 */

/**
 * Everything a pipeline depends on. Every field here is folded into the key.
 *
 * @typedef {Object} PipelineState
 * @property {number} fvf                 Zero when a vertex shader is bound.
 * @property {number} vertexShader        Handle, or zero for fixed function.
 * @property {number} pixelShader         Handle, or zero for fixed function.
 * @property {string} targetFormat
 * @property {string} [depthFormat]       Absent when there is no depth target.
 * @property {number} [sampleCount]
 * @property {string} [topology]
 * @property {boolean} depthTest
 * @property {boolean} depthWrite
 * @property {number} depthFunc
 * @property {number} [depthBias]            in the depth format's smallest steps
 * @property {number} [depthBiasSlopeScale]
 * @property {number} cullMode
 * @property {boolean} blend
 * @property {number} srcBlend
 * @property {number} destBlend
 * @property {number} blendOp
 * @property {number} [srcBlendAlpha]    D3DRS_SEPARATEALPHABLENDENABLE's alpha
 *     factors and operation; absent, alpha blends as colour does.
 * @property {number} [destBlendAlpha]
 * @property {number} [blendOpAlpha]
 * @property {number} colorWrite         D3DCOLORWRITEENABLE bits.
 * @property {boolean} alphaTest
 * @property {number} alphaFunc
 * @property {boolean} [srgbWrite]       D3DRS_SRGBWRITEENABLE into an eight-bit target:
 *     the fragment stage encodes its colour to sRGB.
 * @property {number} fogMode            D3DFOG, the curve; NONE is 0.
 * @property {number} [fogSource]
 *     FOG_SOURCE, where the factor comes from; absent is vertex fog for a
 *     curve and no fog without one (`fogSourceOf`).
 * @property {StageKey[]} stages         Empty means no cascade at all.
 * @property {boolean} [specularEnable]  D3DRS_SPECULARENABLE.
 * @property {LightingState | null} [lighting]  Absent or null means unlit.
 * @property {boolean} [normalizeNormals]
 *     D3DRS_NORMALIZENORMALS: whether a normal is renormalised after its
 *     transform, for lighting and for a coordinate generated from it.
 * @property {boolean} [flatShading]
 *     D3DSHADE_FLAT: the two vertex colours are the provoking vertex's over
 *     the whole primitive.
 * @property {boolean} [rangeFog]
 *     D3DRS_RANGEFOGENABLE under vertex fog: the distance from the eye rather
 *     than the depth.
 * @property {import('./vertexformat.js').VertexLayout} [vertexLayout]
 *     The vertex layout when the vertex format cannot spell it -- a declaration
 *     read by the fixed-function stage -- with `vertexLayoutKey` naming it.
 * @property {string} [vertexLayoutKey]
 * @property {PointState} [points]
 *     A point list, which WebGPU draws only a pixel wide: each point is drawn
 *     as a quad of its size instead, its vertex read once an instance.
 * @property {number} [clipPlanes]
 *     D3DRS_CLIPPLANEENABLE's bits, for a draw whose vertices the user planes
 *     clip; absent, none.
 * @property {boolean} [clipDistances]
 *     Whether those planes are clipped by the device (`clip-distances`) rather
 *     than by a discard in the fragment stage.
 * @property {StencilState} [stencil]
 * @property {boolean} [clipsBehindEye]
 *     A pre-transformed vertex with a negative RHW is behind the eye and its
 *     triangle is clipped there, rather than drawn at w one (decisions.md A45).
 * @property {number} [blendConstant]  D3DRS_BLENDFACTOR, a D3DCOLOR; set on the pass, not keyed.
 *     D3DRS_STENCILENABLE on a target with a stencil: absent, no stencil test.
 */

/**
 * The stencil test and what it writes, as the render states say them. The
 * reference is set on the pass, not built into the pipeline, so it is no part
 * of the key.
 *
 * @typedef {Object} StencilState
 * @property {number} func       D3DCMP of the clockwise faces (all faces when one-sided).
 * @property {number} fail       D3DSTENCILOP, the test failed.
 * @property {number} zfail      D3DSTENCILOP, the test passed and the depth test failed.
 * @property {number} pass       D3DSTENCILOP, both passed.
 * @property {number} ccwFunc    The same four for the counter-clockwise faces, which equal
 * @property {number} ccwFail    the ones above unless D3DRS_TWOSIDEDSTENCILMODE is set.
 * @property {number} ccwZfail
 * @property {number} ccwPass
 * @property {number} readMask   D3DRS_STENCILMASK.
 * @property {number} writeMask  D3DRS_STENCILWRITEMASK.
 * @property {number} ref        D3DRS_STENCILREF.
 */

/**
 * @typedef {Object} PointState
 * @property {boolean} sprite  D3DRS_POINTSPRITEENABLE: every coordinate set is
 *           the quad's own, (0, 0) at its top left and (1, 1) at its bottom right.
 * @property {boolean} scale   D3DRS_POINTSCALEENABLE: the size falls off with
 *           the distance from the eye.
 */

/**
 * The key a pipeline is cached under.
 *
 * A string rather than a structure because it is compared by value on every
 * draw, and because a mismatch is far easier to read in a diagnostic than two
 * object graphs are.
 *
 * @param {PipelineState} state
 * @returns {string}
 */
export function pipelineKey(state){
    // Stages are joined with a separator that cannot occur inside one, so two
    // different stage lists cannot flatten to the same string.
    const stages = state.stages
        .map(stage=>[
            stage.colorOp, stage.colorArg1, stage.colorArg2,
            stage.alphaOp, stage.alphaArg1, stage.alphaArg2,
            stage.texCoordIndex, stage.projected ?? 0,
            ...(stage.colorArg0 === undefined && stage.alphaArg0 === undefined ? []
                : [`a${stage.colorArg0 ?? 1}/${stage.alphaArg0 ?? 1}`]),
            ...(stage.colorKey === undefined ? [] : [`k${stage.colorKey}`]),
            // That a stage bumps, not by how much: the matrix and luminance
            // are the block's, so every value draws through one pipeline.
            ...(stage.bump === undefined ? [] : ['b']),
            ...(stage.dimension === undefined ? [] : [stage.dimension]),
            ...(stage.ones === undefined ? [] : [`o${stage.ones}`]),
            ...(stage.lodBias === undefined ? [] : [`l${stage.lodBias}`]),
            ...(stage.mirrorOnce === undefined ? [] : [`m${stage.mirrorOnce}`]),
            ...(stage.resultArg === undefined ? [] : [`t${stage.resultArg}`]),
            ...(stage.border === undefined ? []
                : [`r${stage.border.mask}/${stage.border.colour}`]),
        ].join(','))
        .join(';');

    return [
        state.fvf,
        state.vertexShader,
        state.pixelShader,
        state.targetFormat,
        state.depthFormat === undefined ? '-' : state.depthFormat,
        state.sampleCount === undefined ? 1 : state.sampleCount,
        state.topology === undefined ? 'triangle-list' : state.topology,
        state.depthTest ? 1 : 0,
        state.depthWrite ? 1 : 0,
        state.depthFunc,
        ...(state.depthBias || state.depthBiasSlopeScale
            ? [`bias${state.depthBias ?? 0}/${state.depthBiasSlopeScale ?? 0}`] : []),
        state.cullMode,
        state.blend ? 1 : 0,
        state.srcBlend,
        state.destBlend,
        state.blendOp,
        state.srcBlendAlpha === undefined ? '-'
            : `${state.srcBlendAlpha}/${state.destBlendAlpha}/${state.blendOpAlpha}`,
        state.colorWrite,
        state.alphaTest ? 1 : 0,
        state.alphaFunc,
        `${fogSourceOf(state)}/${state.fogMode}`,
        // The separator is what keeps two stage lists apart; the count in front
        // is for reading a key in a diagnostic, not for correctness. Said
        // plainly because the first version of this comment claimed the count
        // prevented a collision, and a mutation showed it prevents none: with
        // the count removed every test still passed.
        `${state.stages.length}[${stages}]`,
        state.specularEnable ? 1 : 0,
        lightingKey(state.lighting),
        // Only a layout the format cannot spell adds a part, so every key of a
        // formatted draw reads as it always has; the same for the states below,
        // each named so that no two optional parts can be read as each other.
        ...(state.vertexLayoutKey === undefined ? [] : [state.vertexLayoutKey]),
        ...(state.normalizeNormals ? ['normalize'] : []),
        ...(state.srgbWrite ? ['srgb'] : []),
        ...(state.flatShading ? ['flat'] : []),
        ...(state.rangeFog ? ['range'] : []),
        ...(state.points
            ? [`points${state.points.sprite ? 's' : ''}${state.points.scale ? 'd' : ''}`] : []),
        ...(state.clipPlanes ? [`clip${state.clipPlanes}${state.clipDistances ? 'd' : 'v'}`] : []),
        ...(state.clipsBehindEye ? ['eye'] : []),
        ...(state.stencil ? [`stencil${[state.stencil.func, state.stencil.fail,
            state.stencil.zfail, state.stencil.pass, state.stencil.ccwFunc, state.stencil.ccwFail,
            state.stencil.ccwZfail, state.stencil.ccwPass, state.stencil.readMask & 0xff,
            state.stencil.writeMask & 0xff].join(',')}`] : []),
    ].join('|');
}

/**
 * The lighting half of a key.
 *
 * Unlit is one character rather than a list of defaults, so that the state
 * every pre-transformed and every unlit draw shares folds to the same short
 * key however the material sources happen to be set at the time.
 *
 * @param {LightingState | null | undefined} lighting
 * @returns {string}
 */
function lightingKey(lighting){
    if (!lighting)
    {
        return '-';
    }
    return `L${lighting.colorVertex ? 1 : 0}`
        + `,${lighting.diffuseSource},${lighting.ambientSource}`
        + `,${lighting.specularSource},${lighting.emissiveSource}`
        + `[${lighting.lights.join(',')}]${lighting.localViewer === false ? 'v' : ''}`;
}

/**
 * D3DCOLORWRITEENABLE bits → a WebGPU colour write mask.
 *
 * The bit order is red, green, blue, alpha from bit zero, and it happens to
 * match WebGPU's; it is restated rather than passed through because "happens to
 * match" is not something the next reader can check without looking both up.
 *
 * @param {number} bits
 * @returns {number}
 */
export function colorWriteMask(bits){
    return (bits & 1 ? 1 : 0) | (bits & 2 ? 2 : 0) | (bits & 4 ? 4 : 0) | (bits & 8 ? 8 : 0);
}

/**
 * The vertex buffers a layout reads: stream zero's first, then one per
 * further stream in the order the layout lists them, each with the
 * attributes read from it.
 *
 * @param {number} stride  Stream zero's.
 * @param {readonly { shaderLocation: number, offset: number, format: string,
 *     stream?: number }[]} attributes
 * @param {readonly { stream: number, stride: number, instanced?: boolean }[]} [streams]
 *        A stream `instanced` steps once an instance.
 * @param {boolean} [points]  Every stream steps once an instance: a point each.
 * @returns {{ arrayStride: number, stepMode: string,
 *     attributes: { shaderLocation: number, offset: number, format: string }[] }[]}
 */
export function vertexBuffersOf(stride, attributes, streams = [], points = false){
    /** @type {readonly { stream: number, stride: number, instanced?: boolean }[]} */
    const buffers = [{ stream: 0, stride }, ...streams];
    return buffers.map(buffer=>({
        arrayStride: buffer.stride,
        stepMode: buffer.instanced || points ? 'instance' : 'vertex',
        attributes: attributes
            .filter(attribute=>(attribute.stream ?? 0) === buffer.stream)
            .map(attribute=>({
                shaderLocation: attribute.shaderLocation,
                offset: attribute.offset,
                format: attribute.format,
            })),
    }));
}

/**
 * A pipeline's stencil faces and masks. A clockwise face is WebGPU's back one
 * (`CULL`: D3DCULL_CW culls 'back'), so the states Direct3D applies to
 * clockwise triangles go to `stencilBack` and the counter-clockwise ones to
 * `stencilFront`.
 *
 * @param {StencilState} stencil
 */
function stencilDescriptor(stencil){
    /** @param {number} func @param {number} fail @param {number} zfail @param {number} pass */
    const face = (func, fail, zfail, pass)=>({
        compare: lookUp(COMPARE, func, 'stencil function'),
        failOp: lookUp(STENCIL_OP, fail, 'stencil operation'),
        depthFailOp: lookUp(STENCIL_OP, zfail, 'stencil operation'),
        passOp: lookUp(STENCIL_OP, pass, 'stencil operation'),
    });
    return {
        stencilBack: face(stencil.func, stencil.fail, stencil.zfail, stencil.pass),
        stencilFront: face(stencil.ccwFunc, stencil.ccwFail, stencil.ccwZfail, stencil.ccwPass),
        stencilReadMask: stencil.readMask & 0xff,
        stencilWriteMask: stencil.writeMask & 0xff,
    };
}

/**
 * The descriptor for the state, less the shader modules and layout, which the
 * caller supplies because it owns compilation and binding.
 *
 * @param {PipelineState} state
 * @param {import('./vertexformat.js').VertexLayout | null} layout
 * @returns {any}
 */
export function pipelineDescriptor(state, layout){
    const depth = state.depthFormat === undefined
        ? undefined
        : {
            format: state.depthFormat,
            // A depth test that is off is expressed as always-passing rather
            // than by dropping the attachment: the target is still there, and a
            // later draw in the same pass may want to test against it.
            depthCompare: state.depthTest
                ? lookUp(COMPARE, state.depthFunc, 'depth function')
                : 'always',
            depthWriteEnabled: state.depthWrite,
            ...(state.depthBias ? { depthBias: state.depthBias } : {}),
            ...(state.depthBiasSlopeScale
                ? { depthBiasSlopeScale: state.depthBiasSlopeScale } : {}),
            ...(state.stencil ? stencilDescriptor(state.stencil) : {}),
        };

    const blend = state.blend
        ? {
            color: {
                srcFactor: lookUp(BLEND_FACTOR, state.srcBlend, 'source blend'),
                dstFactor: lookUp(BLEND_FACTOR, state.destBlend, 'destination blend'),
                operation: lookUp(BLEND_OP, state.blendOp, 'blend operation'),
            },
            alpha: {
                srcFactor: lookUp(BLEND_FACTOR, state.srcBlendAlpha ?? state.srcBlend,
                    'source blend'),
                dstFactor: lookUp(BLEND_FACTOR, state.destBlendAlpha ?? state.destBlend,
                    'destination blend'),
                operation: lookUp(BLEND_OP, state.blendOpAlpha ?? state.blendOp,
                    'blend operation'),
            },
        }
        : undefined;

    const vertexBuffers = layout === null
        ? undefined
        : vertexBuffersOf(layout.stride, layout.attributes, layout.streams,
            Boolean(state.points));
    // A strip drawn from an index buffer names its index format after a
    // slash (`triangle-strip/uint16`): the pipeline has to be built for it.
    const [topology, stripIndexFormat] = (state.topology ?? 'triangle-list').split('/');
    return {
        primitive: {
            // A point's quad is two triangles, and a point is never culled.
            topology: state.points ? 'triangle-list' : topology,
            ...(stripIndexFormat && !state.points ? { stripIndexFormat } : {}),
            cullMode: state.points ? 'none' : lookUp(CULL, state.cullMode, 'cull mode'),
            frontFace: 'ccw',
        },
        depthStencil: depth,
        multisample: { count: state.sampleCount === undefined ? 1 : state.sampleCount },
        vertexLayout: vertexBuffers?.[0],
        vertexBuffers,
        target: {
            format: state.targetFormat,
            blend,
            writeMask: colorWriteMask(state.colorWrite),
        },
    };
}

/**
 * What a pipeline cache built, kept so a key made anew draw after draw shows:
 * how many builds, how long they took to come back, the last keys, and for
 * each build the parts of its key that differ from the most alike key built
 * before -- the part a program changes every frame is the one counted most.
 * A shader that writes a value of the state into its source builds a pipeline
 * for every value; this names that value's place in the key.
 *
 * @returns {{ built: (key: string, building: Promise<any>) => void,
 *     stats: () => { buildMs: number, latest: string[],
 *         churn: { part: number, count: number, from: string, to: string }[] } }}
 */
export function createBuildLog(){
    /** @type {string[][]} */
    const recentParts = [];
    /** @type {string[]} */
    const latest = [];
    /** @type {Map<number, { count: number, from: string, to: string }>} */
    const changed = new Map();
    let buildMs = 0;
    const clock = ()=>(typeof performance === 'undefined' ? Date.now() : performance.now());
    return {
        built(key, building){
            latest.push(key);
            if (latest.length > 4)
            {
                latest.shift();
            }
            const parts = key.split(/[|;,[\]]/);
            let closest = null;
            let same = -1;
            for (const earlier of recentParts)
            {
                if (earlier.length !== parts.length)
                {
                    continue;
                }
                const equal = earlier.reduce(
                    (sum, part, at)=>sum + (part === parts[at] ? 1 : 0), 0);
                // The latest of equally alike keys: what the value moved from last.
                if (equal >= same)
                {
                    same = equal;
                    closest = earlier;
                }
            }
            // A key differing in one or two parts from one built before is a
            // value moving; one that differs everywhere is a new kind of draw.
            if (closest && parts.length - same <= 2)
            {
                for (let at = 0; at < parts.length; at++)
                {
                    if (parts[at] !== closest[at])
                    {
                        const entry = changed.get(at) ?? { count: 0, from: '', to: '' };
                        entry.count++;
                        entry.from = closest[at];
                        entry.to = parts[at];
                        changed.set(at, entry);
                    }
                }
            }
            recentParts.push(parts);
            if (recentParts.length > 32)
            {
                recentParts.shift();
            }
            const began = clock();
            building.then(()=>{
                buildMs += clock() - began;
            }, ()=>{});
        },
        stats: ()=>({
            buildMs: Math.round(buildMs),
            latest: latest.slice(),
            churn: [...changed].map(([part, entry])=>({ part, ...entry }))
                .sort((a, b)=>b.count - a.count).slice(0, 5),
        }),
    };
}

/**
 * A cache of pipelines, keyed by the state they were built from.
 *
 * Building is asynchronous because compiling a shader is, and two draws with
 * the same state in one frame must not build twice -- so a build in flight is
 * cached, not just a finished one.
 *
 * @param {{ build: (state: PipelineState, key: string) => Promise<any> }} options
 * @returns {any}
 */
export function createPipelineCache(options){
    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    let built = 0;
    let reused = 0;
    const log = createBuildLog();

    return {
        /** @param {PipelineState} state @returns {Promise<any>} */
        get(state){
            const key = pipelineKey(state);
            const existing = pipelines.get(key);
            if (existing)
            {
                reused++;
                return existing;
            }
            built++;
            const building = options.build(state, key);
            log.built(key, building);
            pipelines.set(key, building);
            return building;
        },

        stats: ()=>({ built, reused, resident: pipelines.size, ...log.stats() }),

        clear(){
            pipelines.clear();
        },
    };
}
