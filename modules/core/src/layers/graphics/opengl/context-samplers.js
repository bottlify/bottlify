/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sampler objects (OpenGL 3.3 section 3.9.2, GL_ARB_sampler_objects).
 *
 * - **A sampler bound to a unit samples every texture the unit reads** in
 *   place of the texture's own sampling state: its filters, wraps, comparison,
 *   levels of detail and border colour. Unbound (zero), the texture's own are
 *   read, as before 3.3.
 * - **A name is an object once glGenSamplers made it**; binding one it did not
 *   make is GL_INVALID_OPERATION. Deleting a bound sampler unbinds it from
 *   every unit of this context. Samplers are shared with the share group.
 * - The parameters take what glTexParameter takes for the same names, and
 *   answer GL_INVALID_ENUM for what a sampler does not hold (base and
 *   maximum levels, the depth texture mode).
 */

import { GL } from './constants.js';
import { samplingRefusal } from './context-textures.js';
import { TEX } from './formats.js';

/** The calls of this file a display list does not record: all of them. */
export const SAMPLER_CALLS_NOT_COMPILED = Object.freeze([
    'glGenSamplers', 'glDeleteSamplers', 'glIsSampler', 'glBindSampler', 'samplerParameter',
    'getSamplerParameter',
]);

/** GL_SAMPLER_BINDING: the sampler bound to the active unit. */
export const SAMPLER_BINDING = 0x8919;

/** What a new sampler holds (table 6.18 of 3.3). */
const DEFAULTS = Object.freeze(/** @type {[number, number][]} */ ([
    [GL.TEXTURE_WRAP_S, GL.REPEAT],
    [GL.TEXTURE_WRAP_T, GL.REPEAT],
    [GL.TEXTURE_WRAP_R, GL.REPEAT],
    [GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_LINEAR],
    [GL.TEXTURE_MAG_FILTER, GL.LINEAR],
    [GL.TEXTURE_MIN_LOD, -1000],
    [GL.TEXTURE_MAX_LOD, 1000],
    [TEX.TEXTURE_COMPARE_MODE, GL.NONE],
    [TEX.TEXTURE_COMPARE_FUNC, GL.LEQUAL],
    [GL.TEXTURE_MAX_ANISOTROPY, 1],
]));

/** @typedef {import('./objects.js').SamplerObject} SamplerObject */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installSamplerCalls(context, kernel){
    const { enter, setError, record } = kernel;

    /** @returns {Map<number, SamplerObject>} the share group's */
    const samplers = ()=>{
        const group = /** @type {any} */ (kernel.shareGroup());
        return group.samplers ??= new Map();
    };

    const units = record(GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS).values[0];
    /** @type {(SamplerObject | null)[]} each unit's */
    const bound = new Array(units).fill(null);

    const queries = kernel.side.queries ??= new Map();
    queries.set(SAMPLER_BINDING, ()=>({ kind: 'int',
        values: [bound[kernel.side.activeUnit?.() ?? 0]?.name ?? 0] }));

    Object.assign(kernel.side, {
        /**
         * Each unit's sampler, for the scene; null when no unit has one.
         *
         * @returns {(SamplerObject | null)[] | null}
         */
        boundSamplers: ()=>(bound.some(Boolean) ? [...bound] : null),
    });

    /** @param {number} name @returns {SamplerObject | undefined} */
    const samplerNamed = name=>samplers().get(name);

    Object.assign(context, {
        /** @param {number} count @returns {number[]} */
        glGenSamplers(count){
            if (!enter('glGenSamplers', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            const table = samplers();
            /** @type {number[]} */
            const names = [];
            for (let name = 1; names.length < count; name++)
            {
                if (!table.has(name))
                {
                    table.set(name, { name, parameters: new Map(DEFAULTS), parametersVersion: 0,
                        borderColour: [0, 0, 0, 0] });
                    names.push(name);
                }
            }
            kernel.shareGroup().used = true;
            return names;
        },

        /** @param {readonly number[]} names */
        glDeleteSamplers(names){
            if (!enter('glDeleteSamplers', [names]))
            {
                return;
            }
            for (const name of names)
            {
                const sampler = samplerNamed(name);
                if (!sampler)
                {
                    continue;
                }
                bound.forEach((held, unit)=>{
                    if (held === sampler)
                    {
                        bound[unit] = null;
                    }
                });
                samplers().delete(name);
            }
        },

        /** @param {number} name @returns {number} */
        glIsSampler(name){
            if (!enter('glIsSampler', [name]))
            {
                return GL.FALSE;
            }
            return samplerNamed(name) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} unit @param {number} name */
        glBindSampler(unit, name){
            if (!enter('glBindSampler', [unit, name]))
            {
                return;
            }
            if (unit < 0 || unit >= units)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const sampler = name === 0 ? null : samplerNamed(name);
            if (sampler === undefined)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            bound[unit] = sampler;
        },

        /**
         * glSamplerParameter{i,f}{,v} and glSamplerParameterI{i,ui}v.
         *
         * @param {number} name @param {number} parameter @param {readonly number[]} values
         */
        samplerParameter(name, parameter, values){
            if (!enter('samplerParameter', [name, parameter, values]))
            {
                return;
            }
            const sampler = samplerNamed(name);
            if (!sampler)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (parameter === GL.TEXTURE_BORDER_COLOR)
            {
                if (values.length < 4)
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                sampler.borderColour = values.slice(0, 4);
                sampler.parametersVersion++;
                return;
            }
            const refusal = sampler.parameters.has(parameter)
                ? samplingRefusal(parameter, values[0]) : GL.INVALID_ENUM;
            if (refusal)
            {
                setError(refusal);
                return;
            }
            sampler.parameters.set(parameter, values[0]);
            sampler.parametersVersion++;
        },

        /**
         * @param {number} name @param {number} parameter
         * @returns {number[] | null}
         */
        getSamplerParameter(name, parameter){
            if (!enter('getSamplerParameter', [name, parameter]))
            {
                return null;
            }
            const sampler = samplerNamed(name);
            if (!sampler)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            if (parameter === GL.TEXTURE_BORDER_COLOR)
            {
                return [...sampler.borderColour];
            }
            const value = sampler.parameters.get(parameter);
            if (value === undefined)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return [value];
        },
    });
}
