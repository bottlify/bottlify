#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes `graphics/opengl/registry.js` from Khronos' gl.xml, the machine-readable OpenGL
 * specification: every command's arguments as the stack sees them, the commands each version
 * adds (and the core profile removes), and those of the ARB, KHR and EXT extensions.
 *
 *     node tools/gl-registry.mjs [--xml <gl.xml>]
 *
 * Without `--xml` the registry is fetched at the pinned revision. A type is a letter: `i` a
 * 32-bit value (an integer, an enum, a boolean, a handle), `f` a GLfloat, `d` a GLdouble, `l` a
 * 64-bit integer, `p` a pointer or a pointer-sized integer (GLintptr, GLsizeiptr, GLsync).
 * A command is `return:arguments`, `v` for a void return.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The revision of KhronosGroup/OpenGL-Registry the table is made from. */
const REVISION = '6af574a14089ccfee87efe230ebcdd8742859813';
const URL_OF = 'https://raw.githubusercontent.com/KhronosGroup/OpenGL-Registry/'
    + `${REVISION}/xml/gl.xml`;
const OUT = fileURLToPath(new URL(
    '../modules/core/src/layers/graphics/opengl/registry.js', import.meta.url));

/** The extensions whose commands are kept: the ones a GL 4.6 driver of either vendor lists. */
const EXTENSION = /^GL_(ARB|KHR|EXT)_/;

const LETTERS = /** @type {Record<string, string>} */ ({
    GLfloat: 'f', GLclampf: 'f', GLdouble: 'd', GLclampd: 'd',
    GLint64: 'l', GLuint64: 'l', GLint64EXT: 'l', GLuint64EXT: 'l',
    GLintptr: 'p', GLsizeiptr: 'p', GLintptrARB: 'p', GLsizeiptrARB: 'p', GLsync: 'p',
    GLDEBUGPROC: 'p', GLDEBUGPROCARB: 'p', GLDEBUGPROCKHR: 'p', GLDEBUGPROCAMD: 'p',
    GLeglImageOES: 'p', GLeglClientBufferEXT: 'p', GLvdpauSurfaceNV: 'p',
});

/** @param {string} text @returns {string} the letter of a declaration, its name dropped */
function letterOf(text){
    if (text.includes('*'))
    {
        return 'p';
    }
    const type = /<ptype>(\w+)<\/ptype>/.exec(text)?.[1] ?? text.replace(/<[^>]*>/g, '').trim();
    if (type === 'void' || type === '')
    {
        return 'v';
    }
    return LETTERS[type] ?? 'i';
}

/** @param {string} xml */
export function readRegistry(xml){
    /** @type {Map<string, string>} */
    const signatures = new Map();
    for (const [, body] of xml.matchAll(/<command\b[^>]*>([\s\S]*?)<\/command>/g))
    {
        const proto = /<proto\b[^>]*>([\s\S]*?)<\/proto>/.exec(body)?.[1] ?? '';
        const name = /<name>(\w+)<\/name>/.exec(proto)?.[1];
        if (!name)
        {
            continue;
        }
        const back = letterOf(proto.replace(/<name>\w+<\/name>/, ''));
        const args = [...body.matchAll(/<param\b[^>]*>([\s\S]*?)<\/param>/g)]
            .map(([, param])=>letterOf(param.replace(/<name>\w+<\/name>/, '')));
        signatures.set(name, `${back}:${args.join('')}`);
    }

    /** @param {string} block @param {string} tag @returns {string[]} */
    const commandsIn = (block, tag)=>[...block.matchAll(new RegExp(
        `<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g'))]
        .filter(([, attributes])=>!/api="(?!gl")/.test(attributes))
        .flatMap(([, , inner])=>[...inner.matchAll(/<command name="(\w+)"/g)].map(m=>m[1]));

    /** @type {Record<string, string[]>} */
    const features = {};
    /** @type {string[]} */
    const removed = [];
    for (const [, attributes, body] of xml.matchAll(/<feature\b([^>]*)>([\s\S]*?)<\/feature>/g))
    {
        if (!/api="gl"/.test(attributes))
        {
            continue;
        }
        const name = /name="(\w+)"/.exec(attributes)?.[1] ?? '';
        features[name] = commandsIn(body, 'require');
        removed.push(...commandsIn(body, 'remove'));
    }

    /** @type {Record<string, string[]>} */
    const extensions = {};
    // An extension that adds nothing is one self-closed element.
    for (const [, attributes, body = ''] of xml.matchAll(
        /<extension\b([^>]*?)(?:\/>|>([\s\S]*?)<\/extension>)/g))
    {
        const name = /name="(\w+)"/.exec(attributes)?.[1] ?? '';
        const supported = /supported="([^"]*)"/.exec(attributes)?.[1] ?? '';
        if (!EXTENSION.test(name) || !supported.split('|').some(api=>api === 'gl'
            || api === 'glcore'))
        {
            continue;
        }
        extensions[name] = [...new Set(commandsIn(body, 'require'))];
    }
    for (const extension of Object.keys(extensions))
    {
        if (extensions[extension].length === 0)
        {
            delete extensions[extension];
        }
    }

    const kept = new Set([...Object.values(features).flat(), ...Object.values(extensions).flat()]);
    return {
        signatures: new Map([...signatures].filter(([name])=>kept.has(name))
            .sort(([a], [b])=>(a < b ? -1 : a > b ? 1 : 0))),
        features, removed: [...new Set(removed)], extensions,
    };
}

/** @param {ReturnType<typeof readRegistry>} registry @returns {string} the module's text */
export function writeModule(registry){
    /** @param {string[]} names */
    const list = names=>`'${names.join(' ')}'`;
    /** @param {Record<string, string[]>} named */
    const groups = named=>Object.entries(named)
        .map(([name, names])=>`    ${name}: ${list(names)},`).join('\n');
    const lines = [
        '/*',
        ' * Copyright © 2026 Bottlify Project',
        ' * Licensed under the Mozilla Public License, version 2.0',
        ' * See LICENSE for details',
        ' */',
        '',
        '/**',
        ' * OpenGL\'s commands as Khronos\' gl.xml declares them (Apache-2.0,',
        ' * THIRD-PARTY-NOTICES.md), written by tools/gl-registry.mjs from revision',
        ` * ${REVISION}: do not edit.`,
        ' *',
        ' * A command is `return:arguments`, a letter each: `i` 32 bits, `f` GLfloat, `d`',
        ' * GLdouble, `l` 64-bit integer, `p` pointer-sized, `v` no value. The versions\' and',
        ' * extensions\' commands are space-separated names.',
        ' */',
        '',
        '/* eslint-disable max-len */',
        '',
        '/** @type {Readonly<Record<string, string>>} */',
        'export const GL_SIGNATURES = Object.freeze({',
        ...[...registry.signatures].map(([name, signature])=>`    ${name}: '${signature}',`),
        '});',
        '',
        '/** The commands each version adds. @type {Readonly<Record<string, string>>} */',
        'export const GL_FEATURE_COMMANDS = Object.freeze({',
        groups(registry.features),
        '});',
        '',
        '/** The commands a core profile does not have (3.2 and later). */',
        `export const GL_CORE_REMOVED = ${list(registry.removed)};`,
        '',
        '/** The commands each ARB, KHR and EXT extension adds. */',
        '/** @type {Readonly<Record<string, string>>} */',
        'export const GL_EXTENSION_COMMANDS = Object.freeze({',
        groups(registry.extensions),
        '});',
        '',
    ];
    return lines.join('\n');
}

async function main(){
    const at = process.argv.indexOf('--xml');
    const xml = at > 0 ? readFileSync(process.argv[at + 1], 'utf8')
        : await (await fetch(URL_OF)).text();
    const registry = readRegistry(xml);
    writeFileSync(OUT, writeModule(registry));
    console.log(`${registry.signatures.size} commands, ${Object.keys(registry.features).length}`
        + ` versions, ${Object.keys(registry.extensions).length} extensions -> ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    await main();
}
