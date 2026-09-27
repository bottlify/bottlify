/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Lights, materials, fog and the user clip planes: the state the vertex
 * stage reads that is not a matrix.
 *
 * A light's position and a clip plane's equation are transformed into eye
 * space at the call, by the modelview matrix current then, and that is what
 * is stored and what glGet answers with. It is the single most surprising
 * rule in this part of the API and the most often relied on.
 */

import { GL } from './constants.js';
import { createLight, createMaterial } from './lighting.js';
import { transform } from './matrix.js';
import { inverseTransposeOf } from './context-textures.js';

const LIGHTS = 8;
const CLIP_PLANES = 6;

/** @type {Set<number>} */
const FOG_MODES = new Set([GL.LINEAR, GL.EXP, GL.EXP2]);

/**
 * The four components a vector parameter sets, zero for any the caller's
 * array does not have.
 *
 * @param {ArrayLike<number>} values
 * @returns {number[]}
 */
const fourOf = values=>[values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installLightingCalls(context, kernel){
    const { enter, setError, record, setState } = kernel;

    const lights = Array.from({ length: LIGHTS }, (unused, index)=>createLight(index));
    const materials = { front: createMaterial(), back: createMaterial() };
    /** @type {number[][]} eye-space plane equations */
    const clipPlanes = Array.from({ length: CLIP_PLANES }, ()=>[0, 0, 0, 0]);

    Object.assign(kernel.side, {
        lights,
        materials,
        clipPlanes,

        /** @param {number} mask @returns {any} */
        saveServerLighting(mask){
            return {
                lights: mask & GL.LIGHTING_BIT ? structuredClone(lights) : null,
                materials: mask & GL.LIGHTING_BIT ? structuredClone(materials) : null,
                clipPlanes: mask & GL.TRANSFORM_BIT ? structuredClone(clipPlanes) : null,
            };
        },

        /** @param {any} saved */
        restoreServerLighting(saved){
            if (saved.lights)
            {
                saved.lights.forEach((/** @type {any} */ light, /** @type {number} */ i)=>{
                    Object.assign(lights[i], structuredClone(light));
                });
                Object.assign(materials.front, structuredClone(saved.materials.front));
                Object.assign(materials.back, structuredClone(saved.materials.back));
            }
            if (saved.clipPlanes)
            {
                saved.clipPlanes.forEach((/** @type {number[]} */ plane, /** @type {number} */ i)=>{
                    clipPlanes[i] = [...plane];
                });
            }
        },
    });

    /**
     * @param {string} name
     * @param {number} light
     * @param {number} parameter
     * @param {number[]} values
     */
    function setLight(name, light, parameter, values){
        if (!enter(name, [light, parameter, values]))
        {
            return;
        }
        const index = light - GL.LIGHT0;
        if (index < 0 || index >= LIGHTS)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const target = lights[index];
        const four = ()=>fourOf(values);
        switch (parameter)
        {
            case GL.AMBIENT:
                target.ambient = four();
                return;
            case GL.DIFFUSE:
                target.diffuse = four();
                return;
            case GL.SPECULAR:
                target.specular = four();
                return;
            case GL.POSITION:
                target.position = transform(kernel.stacks.modelview.current, four());
                return;
            case GL.SPOT_DIRECTION:
            {
                const m = kernel.stacks.modelview.current;
                const [x, y, z] = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
                // A direction goes through the upper 3x3 only: it has no
                // position to translate.
                target.spotDirection = [
                    m[0] * x + m[4] * y + m[8] * z,
                    m[1] * x + m[5] * y + m[9] * z,
                    m[2] * x + m[6] * y + m[10] * z,
                ];
                return;
            }
            case GL.SPOT_EXPONENT:
                if (values[0] < 0 || values[0] > 128)
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
                target.spotExponent = values[0];
                return;
            case GL.SPOT_CUTOFF:
                if (values[0] !== 180 && (values[0] < 0 || values[0] > 90))
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
                target.spotCutoff = values[0];
                return;
            case GL.CONSTANT_ATTENUATION:
            case GL.LINEAR_ATTENUATION:
            case GL.QUADRATIC_ATTENUATION:
                if (values[0] < 0)
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
                target[parameter === GL.CONSTANT_ATTENUATION ? 'constantAttenuation'
                    : parameter === GL.LINEAR_ATTENUATION ? 'linearAttenuation'
                        : 'quadraticAttenuation'] = values[0];
                return;
            default:
                setError(GL.INVALID_ENUM);
        }
    }

    /**
     * @param {string} name
     * @param {number} face
     * @param {number} parameter
     * @param {number[]} values
     */
    function setMaterial(name, face, parameter, values){
        if (!enter(name, [face, parameter, values]))
        {
            return;
        }
        if (face !== GL.FRONT && face !== GL.BACK && face !== GL.FRONT_AND_BACK)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const targets = face === GL.FRONT ? [materials.front]
            : face === GL.BACK ? [materials.back] : [materials.front, materials.back];
        const four = ()=>fourOf(values);
        for (const material of targets)
        {
            switch (parameter)
            {
                case GL.AMBIENT:
                    material.ambient = four();
                    break;
                case GL.DIFFUSE:
                    material.diffuse = four();
                    break;
                case GL.AMBIENT_AND_DIFFUSE:
                    material.ambient = four();
                    material.diffuse = four();
                    break;
                case GL.SPECULAR:
                    material.specular = four();
                    break;
                case GL.EMISSION:
                    material.emission = four();
                    break;
                case GL.SHININESS:
                    if (values[0] < 0 || values[0] > 128)
                    {
                        setError(GL.INVALID_VALUE);
                        return;
                    }
                    material.shininess = values[0];
                    break;
                case GL.COLOR_INDEXES:
                    break;
                default:
                    setError(GL.INVALID_ENUM);
                    return;
            }
        }
    }

    /**
     * @param {string} name
     * @param {number} parameter
     * @param {number[]} values
     */
    function setFog(name, parameter, values){
        if (!enter(name, [parameter, values]))
        {
            return;
        }
        const value = values[0];
        switch (parameter)
        {
            case GL.FOG_MODE:
                if (!FOG_MODES.has(value))
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                setState(GL.FOG_MODE, [value]);
                return;
            case GL.FOG_DENSITY:
                if (value < 0)
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
                setState(GL.FOG_DENSITY, [value]);
                return;
            case GL.FOG_START:
            case GL.FOG_END:
            case GL.FOG_INDEX:
                setState(parameter, [value]);
                return;
            case GL.FOG_COLOR:
                setState(GL.FOG_COLOR,
                    [0, 1, 2, 3].map(k=>Math.min(1, Math.max(0, values[k] ?? 0))));
                return;
            case GL.FOG_COORDINATE_SOURCE:
                if (value !== GL.FOG_COORDINATE && value !== GL.FRAGMENT_DEPTH)
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                setState(GL.FOG_COORDINATE_SOURCE, [value]);
                return;
            default:
                setError(GL.INVALID_ENUM);
        }
    }

    Object.assign(context, {
        /** @param {number} light @param {number} parameter @param {number} value */
        glLightf(light, parameter, value){
            setLight('glLightf', light, parameter, [value]);
        },

        /** @param {number} light @param {number} parameter @param {number[]} values */
        glLightfv(light, parameter, values){
            setLight('glLightfv', light, parameter, values);
        },

        /**
         * @param {number} light
         * @param {number} parameter
         * @returns {number[] | null}
         */
        glGetLightfv(light, parameter){
            if (!enter('glGetLightfv', [light, parameter]))
            {
                return null;
            }
            const index = light - GL.LIGHT0;
            if (index < 0 || index >= LIGHTS)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const source = lights[index];
            /** @type {Record<number, number[]>} */
            const answers = {
                [GL.AMBIENT]: source.ambient,
                [GL.DIFFUSE]: source.diffuse,
                [GL.SPECULAR]: source.specular,
                [GL.POSITION]: source.position,
                [GL.SPOT_DIRECTION]: source.spotDirection,
                [GL.SPOT_EXPONENT]: [source.spotExponent],
                [GL.SPOT_CUTOFF]: [source.spotCutoff],
                [GL.CONSTANT_ATTENUATION]: [source.constantAttenuation],
                [GL.LINEAR_ATTENUATION]: [source.linearAttenuation],
                [GL.QUADRATIC_ATTENUATION]: [source.quadraticAttenuation],
            };
            const answer = answers[parameter];
            if (!answer)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return [...answer];
        },

        /** @param {number} parameter @param {number} value */
        glLightModelf(parameter, value){
            context.glLightModelfv(parameter, [value]);
        },

        /** @param {number} parameter @param {number[]} values */
        glLightModelfv(parameter, values){
            if (!enter('glLightModelfv', [parameter, values]))
            {
                return;
            }
            switch (parameter)
            {
                case GL.LIGHT_MODEL_AMBIENT:
                    setState(GL.LIGHT_MODEL_AMBIENT, fourOf(values));
                    return;
                case GL.LIGHT_MODEL_LOCAL_VIEWER:
                case GL.LIGHT_MODEL_TWO_SIDE:
                    setState(parameter, [values[0] ? 1 : 0]);
                    return;
                case GL.LIGHT_MODEL_COLOR_CONTROL:
                    if (values[0] !== GL.SINGLE_COLOR && values[0] !== GL.SEPARATE_SPECULAR_COLOR)
                    {
                        setError(GL.INVALID_ENUM);
                        return;
                    }
                    setState(parameter, [values[0]]);
                    return;
                default:
                    setError(GL.INVALID_ENUM);
            }
        },

        /** @param {number} face @param {number} parameter @param {number} value */
        glMaterialf(face, parameter, value){
            setMaterial('glMaterialf', face, parameter, [value]);
        },

        /** @param {number} face @param {number} parameter @param {number[]} values */
        glMaterialfv(face, parameter, values){
            setMaterial('glMaterialfv', face, parameter, values);
        },

        /**
         * @param {number} face
         * @param {number} parameter
         * @returns {number[] | null}
         */
        glGetMaterialfv(face, parameter){
            if (!enter('glGetMaterialfv', [face, parameter]))
            {
                return null;
            }
            if (face !== GL.FRONT && face !== GL.BACK)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const material = face === GL.FRONT ? materials.front : materials.back;
            /** @type {Record<number, number[]>} */
            const answers = {
                [GL.AMBIENT]: material.ambient,
                [GL.DIFFUSE]: material.diffuse,
                [GL.SPECULAR]: material.specular,
                [GL.EMISSION]: material.emission,
                [GL.SHININESS]: [material.shininess],
                [GL.COLOR_INDEXES]: [0, 1, 1],
            };
            const answer = answers[parameter];
            if (!answer)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return [...answer];
        },

        /** @param {number} face @param {number} mode */
        glColorMaterial(face, mode){
            if (!enter('glColorMaterial', [face, mode]))
            {
                return;
            }
            const faces = [GL.FRONT, GL.BACK, GL.FRONT_AND_BACK];
            const modes = [GL.AMBIENT, GL.DIFFUSE, GL.SPECULAR, GL.EMISSION,
                GL.AMBIENT_AND_DIFFUSE];
            if (!faces.some(f=>f === face) || !modes.some(m=>m === mode))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.COLOR_MATERIAL_FACE, [face]);
            setState(GL.COLOR_MATERIAL_PARAMETER, [mode]);
        },

        /** @param {number} parameter @param {number} value */
        glFogf(parameter, value){
            setFog('glFogf', parameter, [value]);
        },

        /** @param {number} parameter @param {number[]} values */
        glFogfv(parameter, values){
            setFog('glFogfv', parameter, values);
        },

        /** @param {number} plane @param {number[]} equation */
        glClipPlane(plane, equation){
            if (!enter('glClipPlane', [plane, equation]))
            {
                return;
            }
            const index = plane - GL.CLIP_PLANE0;
            if (index < 0 || index >= CLIP_PLANES)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const inverse = inverseTransposeOf(kernel.stacks.modelview.current);
            const p = [0, 1, 2, 3].map(k=>equation[k] ?? 0);
            clipPlanes[index] = [0, 1, 2, 3].map(c=>p[0] * inverse[c] + p[1] * inverse[4 + c]
                + p[2] * inverse[8 + c] + p[3] * inverse[12 + c]);
        },

        /** @param {number} plane @returns {number[] | null} */
        glGetClipPlane(plane){
            if (!enter('glGetClipPlane', [plane]))
            {
                return null;
            }
            const index = plane - GL.CLIP_PLANE0;
            if (index < 0 || index >= CLIP_PLANES)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return [...clipPlanes[index]];
        },

        // --- GL_EXT_secondary_color and GL_EXT_fog_coord ---

        /** @param {number} red @param {number} green @param {number} blue */
        glSecondaryColor3fEXT(red, green, blue){
            if (enter('glSecondaryColor3fEXT', [red, green, blue]))
            {
                setState(GL.CURRENT_SECONDARY_COLOR, [red, green, blue, 1]);
            }
        },

        /** @param {number} coord */
        glFogCoordfEXT(coord){
            if (enter('glFogCoordfEXT', [coord]))
            {
                setState(GL.CURRENT_FOG_COORDINATE, [coord]);
            }
        },
    });

    /** Whether lighting is on, and with which material. */
    Object.assign(kernel.side, {
        /** @returns {readonly import('./lighting.js').Light[]} */
        enabledLights: ()=>lights.filter((light, i)=>record(GL.LIGHT0 + i).values[0] !== 0),
    });
}
