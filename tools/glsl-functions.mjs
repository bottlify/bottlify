#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes `graphics/opengl/glsl-catalog.js` from the GLSL 4.60 specification's
 * chapter on built-in functions (`chapters/builtinfunctions.adoc` of
 * KhronosGroup/GLSL): every desktop built-in function's prototypes, the
 * generic types (genFType, gvec4, gsampler2D, mat, ...) spelled out, an
 * optional `[, float bias]` made a second overload, and each parameter's
 * direction. The section a prototype is under is kept, since stage rules
 * follow sections ("Geometry Shader Functions" are the geometry stage's).
 *
 *     node tools/glsl-functions.mjs <builtinfunctions.adoc>
 *
 * The catalog is made from the file at KhronosGroup/GLSL revision
 * 0099bf83b0288469917fc2e2972cb0a2b74d6711.
 *
 * The specification documents 4.60 alone; the version each function came
 * with is `glsl-builtins.js`'s, from the earlier specifications' tables.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMain } from './common.mjs';

const OUT = fileURLToPath(new URL(
    '../modules/core/src/layers/graphics/opengl/glsl-catalog.js', import.meta.url));

/** The generic types and what each stands for, in parallel lists. */
const GENERIC = /** @type {Record<string, string[]>} */ ({
    genFType: ['float', 'vec2', 'vec3', 'vec4'],
    genIType: ['int', 'ivec2', 'ivec3', 'ivec4'],
    genUType: ['uint', 'uvec2', 'uvec3', 'uvec4'],
    genBType: ['bool', 'bvec2', 'bvec3', 'bvec4'],
    genDType: ['double', 'dvec2', 'dvec3', 'dvec4'],
    vec: ['vec2', 'vec3', 'vec4'],
    ivec: ['ivec2', 'ivec3', 'ivec4'],
    uvec: ['uvec2', 'uvec3', 'uvec4'],
    bvec: ['bvec2', 'bvec3', 'bvec4'],
    dvec: ['dvec2', 'dvec3', 'dvec4'],
    mat: ['mat2', 'mat3', 'mat4', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x4', 'mat4x2', 'mat4x3'],
    dmat: ['dmat2', 'dmat3', 'dmat4', 'dmat2x3', 'dmat2x4', 'dmat3x2', 'dmat3x4', 'dmat4x2',
        'dmat4x3'],
});
/**
 * Slips in the specification's prototypes, set right as its text says: a
 * misspelt sampler, `in` for `int`, a missing comma.
 */
const FIXUPS = /** @type {[RegExp, string][]} */ ([
    [/gsamler2DRect/g, 'gsampler2DRect'],
    [/, in lod\)/g, ', int lod)'],
    [/float P float lod/g, 'float P, float lod'],
]);

/** g-prefixed types stand for the float, int and uint forms together. */
const G_PREFIX = ['', 'i', 'u'];

/**
 * The prototypes of the GLSL branch of the text: lines in source blocks,
 * outside ESSL-only regions.
 *
 * @param {string} text
 * @returns {{ section: string, line: string }[]}
 */
function prototypes(text){
    /** @type {{ section: string, line: string }[]} */
    const found = [];
    let section = '';
    let inSource = false;
    /** @type {string[]} */
    const conditions = [];
    /**
     * What the image functions' `IMAGE_PARAMS` stands for: the list the
     * specification gives before them, one image type and its coordinates
     * (and sample) a line.
     *
     * @type {string[]}
     */
    const imageParams = [];
    // A prototype whose parameters run over several lines (umulExtended's) is
    // read whole, its lines joined.
    let pending = '';
    for (const raw of text.split('\n'))
    {
        const line = (pending === '' ? raw.trim() : `${pending} ${raw.trim()}`);
        pending = '';
        if (inSource && /^[\w ]+\s+\w+\s*\([^)]*$/.test(line))
        {
            pending = line;
            continue;
        }
        const image = /^\{empty\}:: (gimage\w+) _image_, (\w+) _P_(, int _sample_)?$/.exec(line);
        if (image && !conditions.includes('ESSL'))
        {
            imageParams.push(`${image[1]} image, ${image[2]} P${image[3] ? ', int sample' : ''}`);
            continue;
        }
        const ifdef = /^ifdef::(\w+)\[\]$/.exec(line);
        if (ifdef)
        {
            conditions.push(ifdef[1]);
            continue;
        }
        const inline = /^ifdef::(\w+)\[(.+)\]$/.exec(line);
        if (/^endif::/.test(line))
        {
            conditions.pop();
            continue;
        }
        if (/^==+ /.test(line) && !inSource)
        {
            section = line.replace(/^==+ /, '').trim();
            continue;
        }
        if (line === '----')
        {
            inSource = !inSource;
            continue;
        }
        if (!inSource || conditions.includes('ESSL'))
        {
            continue;
        }
        const body = FIXUPS.reduce((fixed, [from, to])=>fixed.replace(from, to),
            inline ? (inline[1] === 'GLSL' ? inline[2] : '') : line);
        if (/^[\w ]+\s+\w+\s*\(.*\)\s*;?$/.test(body) && !/^(if|for|while|return)\b/.test(body))
        {
            const prototype = body.replace(/;$/, '');
            for (const params of /IMAGE_PARAMS/.test(prototype) ? imageParams : [null])
            {
                found.push({ section, line: params === null ? prototype
                    : prototype.replace('IMAGE_PARAMS', params) });
            }
        }
    }
    return found;
}

/**
 * One prototype's overloads, generic types spelled out: the n-th of each
 * generic list goes together, so `genFType mix(genFType, genFType, float)` is
 * four overloads, not sixty-four.
 *
 * @param {string} line
 * @returns {{ name: string, returns: string, params: string[], outs: number[], bias: boolean }[]}
 */
function expand(line){
    const match = /^(.*?)\b(\w+)\s*\((.*)\)$/.exec(line);
    if (!match)
    {
        return [];
    }
    const returns = match[1].trim().split(/\s+/).pop() ?? '';
    const name = match[2];
    let paramText = match[3].trim();
    // `[, float bias]`: with the parameter and without.
    const optional = /\[,\s*([^\]]+)\]/.exec(paramText);
    const forms = optional ? [paramText.replace(optional[0], ''),
        paramText.replace(optional[0], `, ${optional[1]}`)] : [paramText];
    /** @type {{ name: string, returns: string, params: string[], outs: number[], bias: boolean }[]} */
    const out = [];
    for (const form of forms)
    {
        const bias = form !== forms[0];
        paramText = form.trim();
        const params = paramText === '' || paramText === 'void' ? [] : paramText.split(',')
            .map(p=>p.trim().replace(/\[\d*\]$/, '[]'));
        /** @type {string[]} */
        const types = [];
        /** @type {number[]} */
        const outs = [];
        /** @type {boolean[]} */
        const arrays = [];
        params.forEach((param, k)=>{
            const words = param.split(/\s+/).filter(w=>!['highp', 'mediump', 'lowp', 'coherent',
                'volatile', 'restrict', 'readonly', 'writeonly', 'const', 'in'].includes(w));
            if (words[0] === 'out' || words[0] === 'inout')
            {
                outs.push(k * 2 + (words[0] === 'inout' ? 1 : 0));
                words.shift();
            }
            arrays.push(/\[\]$/.test(param));
            types.push(words[0]);
        });
        // How many forms the generic lists make: the first generic's length.
        const generic = [returns, ...types].find(t=>GENERIC[t] || /^g(sampler|image|vec4)/.test(t)
            || t === 'gvec4');
        const count = !generic ? 1 : GENERIC[generic]?.length ?? 3;
        for (let n = 0; n < count; n++)
        {
            /** @param {string} t */
            const pick = t=>{
                if (GENERIC[t])
                {
                    return GENERIC[t][Math.min(n, GENERIC[t].length - 1)];
                }
                if (/^g(sampler|image)/.test(t) || t === 'gvec4')
                {
                    return `${G_PREFIX[n]}${t.slice(1)}`;
                }
                return t;
            };
            out.push({ name, returns: pick(returns),
                params: types.map((t, k)=>pick(t) + (arrays[k] ? '[]' : '')), outs, bias });
        }
    }
    return out;
}

/** @param {string} text */
export function readCatalog(text){
    /** @type {[string, string, string, string[], number[], number][]} */
    const rows = [];
    const seen = new Set();
    for (const { section, line } of prototypes(text))
    {
        for (const overload of expand(line))
        {
            const key = `${overload.name}(${overload.params.join(',')})`;
            // An image atomic's IMAGE_PARAMS stand for the image of its data's
            // type only: a uint form takes a uimage, an int form an iimage.
            const image = /^image(Atomic)/.test(overload.name)
                ? /^([iu]?)image/.exec(overload.params[0]) : null;
            if (image && image[1] !== ({ uint: 'u', int: 'i' }[overload.returns] ?? ''))
            {
                continue;
            }
            if (seen.has(key))
            {
                continue;
            }
            seen.add(key);
            rows.push([section, overload.name, overload.returns, overload.params, overload.outs,
                overload.bias ? 1 : 0]);
        }
    }
    return rows;
}

function main(){
    const text = readFileSync(process.argv[2], 'utf8');
    const rows = readCatalog(text);
    const lines = [
        '/*',
        ' * Copyright © 2026 Bottlify Project',
        ' * Licensed under the Mozilla Public License, version 2.0',
        ' * See LICENSE for details',
        ' */',
        '',
        '/**',
        ' * The built-in functions\' prototypes as the GLSL 4.60 specification declares them',
        ' * (chapter 8, KhronosGroup/GLSL `chapters/builtinfunctions.adoc`), written by',
        ' * tools/glsl-functions.mjs: do not edit. A row is the section, the name, the return',
        ' * type, the parameter types, the out (2n) and inout (2n + 1) parameters, and 1 for',
        ' * the form an optional `bias` parameter makes.',
        ' */',
        '',
        '/* eslint-disable max-len */',
        '',
        '/** @type {readonly [string, string, string, string[], number[], number][]} */',
        'export const GLSL_CATALOG = Object.freeze([',
        ...rows.map(row=>`    ${JSON.stringify(row).replace(/"/g, '\'').replace(/,/g, ', ')},`),
        ']);',
        '',
    ];
    writeFileSync(OUT, lines.join('\n'));
    console.log(`${rows.length} overloads -> ${OUT}`);
}

if (isMain(import.meta.url))
{
    main();
}
