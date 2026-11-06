/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * HLSL to a Direct3D 10 effect: the fx_4_0 and fx_4_1 profiles of D3DCompile and
 * D3D10CompileEffectFromMemory.
 */

/** The effect profiles. */
const PROFILES = new Set(['fx_4_0', 'fx_4_1']);

/** @param {string} name */
export const isEffectProfile = name=>PROFILES.has(name);

/**
 * @typedef {Object} EffectOptions
 * @property {string} profile
 * @property {number} [flags]
 * @property {number} [effectFlags]
 * @property {[string, string][]} [defines]
 * @property {import('../../win32/d3dx9/preprocess.js').PreprocessOptions['include']} [include]
 * @property {string} [source]
 */

/**
 * @param {string} source
 * @param {EffectOptions} options
 * @returns {Promise<import('./compile.js').Compile4Result>}
 */
export async function compileEffect(source, options){
    void source;
    return { ok: false, bytes: null, messages: `error X3506: '${options.profile}': effects `
        + 'are not compiled here yet\n' };
}
