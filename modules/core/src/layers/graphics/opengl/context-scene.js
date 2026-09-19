/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Reads the context's state into the one `Scene` the pipeline draws from.
 *
 * Built once per primitive rather than per vertex: the state cannot change
 * between a glBegin and its glEnd, so reading it once is both cheaper and
 * the same thing. Everything the pipeline needs to know about blending,
 * depth, fog, lighting and the texture units is decided here and nowhere
 * else, which is what keeps `pipeline.js` free of GL enumerants beyond the
 * handful it evaluates.
 */

import { GL } from './constants.js';
import { colourMaterialTargets, lightVertex, normalMatrix, normalise } from './lighting.js';
import { levelKey } from './objects.js';
import { compare, drawPrimitive } from './pipeline.js';

/**
 * The blend factor for one channel, as the specification's table gives it.
 *
 * @param {number} factor
 * @param {readonly number[]} source  0..1
 * @param {readonly number[]} destination  0..1
 * @param {number} k  the channel
 * @returns {number}
 */
function blendFactor(factor, source, destination, k){
    switch (factor)
    {
        case GL.ZERO:
            return 0;
        case GL.ONE:
            return 1;
        case GL.SRC_COLOR:
            return source[k];
        case GL.ONE_MINUS_SRC_COLOR:
            return 1 - source[k];
        case GL.DST_COLOR:
            return destination[k];
        case GL.ONE_MINUS_DST_COLOR:
            return 1 - destination[k];
        case GL.SRC_ALPHA:
            return source[3];
        case GL.ONE_MINUS_SRC_ALPHA:
            return 1 - source[3];
        case GL.DST_ALPHA:
            return destination[3];
        case GL.ONE_MINUS_DST_ALPHA:
            return 1 - destination[3];
        case GL.SRC_ALPHA_SATURATE:
            return k === 3 ? 1 : Math.min(source[3], 1 - destination[3]);
        default:
            return 1;
    }
}

/**
 * @param {number} op
 * @returns {(s: number, d: number) => number}
 */
function logicOperation(op){
    switch (op)
    {
        case GL.CLEAR:
            return ()=>0;
        case GL.AND:
            return (s, d)=>s & d;
        case GL.AND_REVERSE:
            return (s, d)=>s & ~d;
        case GL.COPY:
            return s=>s;
        case GL.AND_INVERTED:
            return (s, d)=>~s & d;
        case GL.NOOP:
            return (s, d)=>d;
        case GL.XOR:
            return (s, d)=>s ^ d;
        case GL.OR:
            return (s, d)=>s | d;
        case GL.NOR:
            return (s, d)=>~(s | d);
        case GL.EQUIV:
            return (s, d)=>~(s ^ d);
        case GL.INVERT:
            return (s, d)=>~d;
        case GL.OR_REVERSE:
            return (s, d)=>s | ~d;
        case GL.COPY_INVERTED:
            return s=>~s;
        case GL.OR_INVERTED:
            return (s, d)=>~s | d;
        case GL.NAND:
            return (s, d)=>~(s & d);
        default:
            return ()=>0xff;
    }
}

/**
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function createSceneBuilder(kernel){
    const { record } = kernel;
    const side = kernel.side;
    const on = (/** @type {number} */ cap)=>record(cap).values[0] !== 0;

    /** @returns {import('./pipeline.js').Scene & { lit: (vertex: any, eye: number[]) => number[] }} */
    function scene(){
        const modelview = kernel.stacks.modelview.current;
        const lighting = on(GL.LIGHTING)
            ? {
                material: side.materials.front,
                model: {
                    ambient: record(GL.LIGHT_MODEL_AMBIENT).values,
                    localViewer: on(GL.LIGHT_MODEL_LOCAL_VIEWER),
                    separateSpecular: record(GL.LIGHT_MODEL_COLOR_CONTROL).values[0]
                        === GL.SEPARATE_SPECULAR_COLOR,
                },
                lights: side.enabledLights(),
                normalMatrix: normalMatrix(modelview),
                normalise: on(GL.NORMALIZE) || on(GL.RESCALE_NORMAL),
                colourMaterial: on(GL.COLOR_MATERIAL)
                    ? colourMaterialTargets(record(GL.COLOR_MATERIAL_PARAMETER).values[0])
                    : null,
            }
            : null;
        if (lighting && on(GL.LIGHT_MODEL_TWO_SIDE))
        {
            kernel.diverge('two-sided lighting was enabled and back faces are lit as front'
                + ' faces: a program that colours its back material differently sees the'
                + ' front colour on both');
        }

        const fog = on(GL.FOG)
            ? {
                mode: record(GL.FOG_MODE).values[0],
                density: record(GL.FOG_DENSITY).values[0],
                start: record(GL.FOG_START).values[0],
                end: record(GL.FOG_END).values[0],
                colour: record(GL.FOG_COLOR).values,
                fromCoordinate: record(GL.FOG_COORDINATE_SOURCE).values[0] === GL.FOG_COORDINATE,
            }
            : null;

        /** @type {import('./pipeline.js').SceneUnit[]} */
        const units = side.activeTextures().map((/** @type {any} */ entry)=>{
            const { index, texture, unit } = entry;
            const cube = texture.target === GL.TEXTURE_CUBE_MAP;
            const images = [];
            for (let face = 0; face < (cube ? 6 : 1); face++)
            {
                const level = texture.levels.get(levelKey(0, face));
                images.push({
                    width: level.width,
                    height: level.height,
                    texels: level.texels ?? new Uint8Array(level.width * level.height * 4),
                });
            }
            const generated = unit.genEnabled.some((/** @type {number} */ g)=>g !== 0);
            return {
                index,
                texture,
                images,
                cube,
                baseFormat: texture.levels.get(levelKey(0)).baseFormat,
                parameters: {
                    magFilter: texture.parameters.get(GL.TEXTURE_MAG_FILTER),
                    minFilter: texture.parameters.get(GL.TEXTURE_MIN_FILTER),
                    wrapS: texture.parameters.get(GL.TEXTURE_WRAP_S),
                    wrapT: texture.parameters.get(GL.TEXTURE_WRAP_T),
                },
                env: unit.env,
                matrix: unit.stack.current,
                generation: generated
                    ? {
                        modes: unit.genModes.map((/** @type {number} */ mode, /** @type {number} */ k)=>(unit.genEnabled[k] ? mode : null)),
                        objectPlanes: unit.objectPlanes,
                        eyePlanes: unit.eyePlanes,
                    }
                    : null,
            };
        });

        const clipPlanes = [];
        for (let i = 0; i < 6; i++)
        {
            if (on(GL.CLIP_PLANE0 + i))
            {
                clipPlanes.push(side.clipPlanes[i]);
            }
        }

        // A program stage is what the renderer draws with only when its cap
        // is on, its target has a program bound, and that program loaded: an
        // enabled cap with nothing valid bound draws the fixed pipeline, as
        // it does on hardware.
        const programsSide = side.programs;
        /**
         * @param {number} target
         * @param {'vertex' | 'fragment'} kind
         * @returns {import('./pipeline.js').SceneProgram | null}
         */
        const stage = (target, kind)=>{
            if (!programsSide || record(target).values[0] === 0)
            {
                return null;
            }
            const program = programsSide.boundProgram(target);
            if (!program || !program.parsed || program.parsed.kind !== kind)
            {
                return null;
            }
            return {
                name: program.name,
                version: program.version,
                text: program.text,
                ir: program.parsed,
                local: program.local,
                env: /** @type {Float32Array} */ (programsSide.env.get(target)),
            };
        };
        const programs = {
            vertex: stage(GL.VERTEX_PROGRAM_ARB, 'vertex'),
            fragment: stage(GL.FRAGMENT_PROGRAM_ARB, 'fragment'),
        };
        const programmed = programs.vertex !== null || programs.fragment !== null;
        // The state a program reads that the fixed path reads only per
        // enabled unit: the matrices and bindings of every unit, and the
        // current generic attribute values. A fragment program samples what
        // is bound whether or not the unit is enabled, per the specification.
        const textureMatrices = programmed
            ? side.units.map((/** @type {any} */ unit)=>unit.stack.current)
            : [];
        const boundTextures = programmed
            ? side.units.map((/** @type {any} */ unused, /** @type {number} */ index)=>({
                twoD: side.textureBoundAt(index, GL.TEXTURE_2D),
                cube: side.textureBoundAt(index, GL.TEXTURE_CUBE_MAP),
            }))
            : [];
        const genericAttribs = programmed && programsSide
            ? programsSide.attribValues.map((/** @type {number[]} */ value)=>[...value])
            : [];

        const blendOn = on(GL.BLEND);
        const src = record(GL.BLEND_SRC).values[0];
        const dst = record(GL.BLEND_DST).values[0];
        const depthOn = on(GL.DEPTH_TEST);
        const depthFunc = record(GL.DEPTH_FUNC).values[0];
        const stencilFront = on(GL.STENCIL_TEST)
            ? {
                func: record(GL.STENCIL_FUNC).values[0],
                reference: record(GL.STENCIL_REF).values[0],
                readMask: record(GL.STENCIL_VALUE_MASK).values[0] & 0xff,
                writeMask: record(GL.STENCIL_WRITEMASK).values[0] & 0xff,
                fail: record(GL.STENCIL_FAIL).values[0],
                zfail: record(GL.STENCIL_PASS_DEPTH_FAIL).values[0],
                zpass: record(GL.STENCIL_PASS_DEPTH_PASS).values[0],
            }
            : null;
        const built = {
            modelview,
            projection: kernel.stacks.projection.current,
            viewport: record(GL.VIEWPORT).values,
            depthRange: record(GL.DEPTH_RANGE).values,
            framebuffer: kernel.framebuffer(),
            scissor: kernel.scissorBox(),
            clipPlanes,
            lighting,
            fog,
            units,
            current: kernel.currentVertex(),
            blend: blendOn ? { src, dst } : null,
            stencil: stencilFront,
            // GL_EXT_stencil_two_side's back-face record: the layer's own
            // `GL_STENCIL_BACK_*` storage when two-sided testing is on, and
            // the front's own record when it is off -- the specification's
            // "front for all fragments" rule for a disabled test.
            stencilBack: stencilFront && (on(GL.STENCIL_TEST_TWO_SIDE_EXT)
                ? {
                    func: record(GL.STENCIL_BACK_FUNC).values[0],
                    reference: record(GL.STENCIL_BACK_REF).values[0],
                    readMask: record(GL.STENCIL_BACK_VALUE_MASK).values[0] & 0xff,
                    writeMask: record(GL.STENCIL_BACK_WRITEMASK).values[0] & 0xff,
                    fail: record(GL.STENCIL_BACK_FAIL).values[0],
                    zfail: record(GL.STENCIL_BACK_PASS_DEPTH_FAIL).values[0],
                    zpass: record(GL.STENCIL_BACK_PASS_DEPTH_PASS).values[0],
                }
                : stencilFront),
            polygonOffset: on(GL.POLYGON_OFFSET_FILL)
                ? {
                    factor: record(GL.POLYGON_OFFSET_FACTOR).values[0],
                    units: record(GL.POLYGON_OFFSET_UNITS).values[0],
                }
                : null,
            colourSum: on(GL.COLOR_SUM)
                || (lighting !== null && lighting.model.separateSpecular),
            cull: on(GL.CULL_FACE)
                ? { mode: record(GL.CULL_FACE_MODE).values[0], frontIsCcw: true }
                : null,
            frontIsCcw: record(GL.FRONT_FACE).values[0] === GL.CCW,
            flat: record(GL.SHADE_MODEL).values[0] === GL.FLAT,
            polygonMode: record(GL.POLYGON_MODE).values,
            pointSize: record(GL.POINT_SIZE).values[0],
            alphaTest: on(GL.ALPHA_TEST)
                ? {
                    func: record(GL.ALPHA_TEST_FUNC).values[0],
                    reference: record(GL.ALPHA_TEST_REF).values[0],
                }
                : null,
            operations: {
                depthTest: depthOn ? compare : undefined,
                depthFunc,
                depthWrite: on(GL.DEPTH_WRITEMASK),
                blend: blendOn && !(src === GL.ONE && dst === GL.ZERO)
                    ? (/** @type {number[]} */ s, /** @type {number[]} */ d)=>{
                        const sf = s.map(v=>v / 255);
                        const df = d.map(v=>v / 255);
                        return [0, 1, 2, 3].map(k=>Math.min(255,
                            s[k] * blendFactor(src, sf, df, k)
                                + d[k] * blendFactor(dst, sf, df, k)));
                    }
                    : null,
                logicOp: on(GL.COLOR_LOGIC_OP)
                    ? logicOperation(record(GL.LOGIC_OP_MODE).values[0])
                    : null,
                colourMask: record(GL.COLOR_WRITEMASK).values.map(v=>v !== 0),
            },
            programs,
            genericAttribs,
            textureMatrices,
            boundTextures,

            /**
             * The colour a vertex ends up with: lit, or its own.
             *
             * @param {any} vertex
             * @param {number[]} eye
             * @returns {number[]}
             */
            lit(vertex, eye){
                if (!lighting)
                {
                    return [...vertex.color];
                }
                const nm = lighting.normalMatrix;
                const n = vertex.normal;
                let normal = [
                    nm[0] * n[0] + nm[3] * n[1] + nm[6] * n[2],
                    nm[1] * n[0] + nm[4] * n[1] + nm[7] * n[2],
                    nm[2] * n[0] + nm[5] * n[1] + nm[8] * n[2],
                ];
                if (lighting.normalise)
                {
                    normal = normalise(normal);
                }
                let material = lighting.material;
                if (lighting.colourMaterial)
                {
                    material = { ...material };
                    for (const property of lighting.colourMaterial)
                    {
                        material[property] = [...vertex.color];
                    }
                }
                return lightVertex({
                    position: eye, normal, material, model: lighting.model,
                    lights: lighting.lights,
                }).primary;
            },
        };
        return built;
    }

    return {
        scene,
        /**
         * @param {number} mode
         * @param {any[]} vertices
         */
        draw(mode, vertices){
            drawPrimitive(scene(), mode, vertices);
        },
    };
}
