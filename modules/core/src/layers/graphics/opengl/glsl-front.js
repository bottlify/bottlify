/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLSL front end in one call: preprocess, parse in the language the
 * `#version` line names, check for the stage, and the log as a driver
 * writes it (`ERROR: <string>:<line>: <message>`, decision A69). Which
 * versions a shader may name is the caller's: the specification's 1.10 to
 * 4.60 are the language, what the context offers is the context's.
 */

import { ALL_GLSL_VERSIONS, preprocess } from './glsl-preprocess.js';
import { GlslSyntaxError, parse } from './glsl-parse.js';
import { GlslCompileError, checkShader } from './glsl-check.js';
import { languageOf } from './glsl-versions.js';

/**
 * @typedef {Object} FrontOptions
 * @property {readonly number[]} [versions]  the versions a `#version` may name;
 *     every one of the language's by default
 * @property {readonly string[]} [extensions]  the extensions `#extension` may enable
 * @property {import('./glsl-library.js').GlslConstants} [constants]
 */

/**
 * @param {readonly string[]} sources
 * @param {import('./glsl-versions.js').Stage} stage
 * @param {FrontOptions} [options]
 * @returns {{ ok: boolean, log: string, unit: import('./glsl-check.js').ShaderUnit | null }}
 */
export function compileFront(sources, stage, options = {}){
    const pre = preprocess(sources, { versions: options.versions ?? ALL_GLSL_VERSIONS,
        extensions: new Set(options.extensions ?? []) });
    const lines = pre.diagnostics.map(d=>`${d.severity === 'error' ? 'ERROR' : 'WARNING'}:`
        + ` ${d.string}:${d.line}: ${d.message}`);
    if (pre.diagnostics.some(d=>d.severity === 'error'))
    {
        return { ok: false, log: `${lines.join('\n')}\n`, unit: null };
    }
    const language = languageOf(pre.version, pre.profile, [...pre.extensions]
        .filter(([, behaviour])=>behaviour !== 'disable').map(([name])=>name));
    try
    {
        const unit = checkShader(parse(pre.tokens, language), { stage, version: pre.version,
            language, constants: options.constants });
        return { ok: true, log: lines.length > 0 ? `${lines.join('\n')}\n` : '', unit };
    }
    catch (e){
        if (!(e instanceof GlslSyntaxError) && !(e instanceof GlslCompileError))
        {
            throw e;
        }
        lines.push(`ERROR: ${e.at.string}:${e.at.line}: ${e.message}`);
        return { ok: false, log: `${lines.join('\n')}\n`, unit: null };
    }
}
