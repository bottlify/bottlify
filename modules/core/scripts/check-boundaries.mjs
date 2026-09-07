/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

/**
 * Boundary checker for the core package.
 *
 * Rules that fail the build:
 *  - anything in src/system must not import src/layers;
 *  - a layer may import another layer only if it declared it in `requires`;
 *  - vendor/v86 is importable only from src/layers/cpu;
 *  - layers must not import core.js (the facade is a consumer, not a dependency);
 *  - no file may import from outside src/ (except vendor through the cpu layer);
 *  - the import graph over src/ must be acyclic.
 *
 * Test files (`.test.js`, `.itest.js`) are skipped: they are bundled separately in CI.
 */

const SRC = resolve(fileURLToPath(new URL('..', import.meta.url)), 'src');
const VENDOR = resolve(SRC, '..', 'vendor');

const IMPORT_RE =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir){
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        const abs = join(dir, entry.name);
        if (entry.isDirectory())
        {
            out.push(...walk(abs));
        }
        else if (entry.isFile() && abs.endsWith('.js'))
        {
            out.push(abs);
        }
    }
    return out;
}

/**
 * @param {string} file
 * @returns {{ kind: "system" | "layer" | "layers-index" | "root", layer: string | null }}
 */
function classify(file){
    const rel = normalize(file).slice(SRC.length + 1).split(sep);
    if (rel[0] === 'system')
    {
        return { kind: 'system', layer: null };
    }
    if (rel[0] === 'layers')
    {
        if (rel[1] === 'index.js')
        {
            return { kind: 'layers-index', layer: null };
        }
        return { kind: 'layer', layer: rel[1] };
    }
    return { kind: 'root', layer: null };
}

/**
 * Loads each layer's declared `requires` straight from its module definition.
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function layerRequires(){
    const layersDir = join(SRC, 'layers');
    const map = new Map();
    for (const name of readdirSync(layersDir).filter(n=>statSync(join(layersDir, n)).isDirectory()))
    {
        const mod = await import(pathToFileURL(join(layersDir, name, 'module.js')).href);
        const exportName = `${name}Module`;
        if (!(exportName in mod))
        {
            throw new Error(`Missing export "${exportName}" in layers/${name}/module.js`);
        }
        map.set(name, new Set(mod[exportName].requires));
    }
    return map;
}

/**
 * @param {string} file
 * @returns {string[]} import specifiers found in the file
 */
function specifiersOf(file){
    const code = readFileSync(file, 'utf8');
    return [...code.matchAll(IMPORT_RE)]
        .map(match=>match[1] ?? match[2] ?? match[3])
        .filter(Boolean);
}

const files = walk(SRC).filter(file=>!file.endsWith('.test.js') && !file.endsWith('.itest.js'));
const requireMap = await layerRequires();
const issues = [];

for (const file of files)
{
    const { kind, layer } = classify(file);
    for (const spec of specifiersOf(file))
    {
        if (!spec.startsWith('.'))
        {
            continue;
        }

        const target = resolve(dirname(file), spec);

        if (target.startsWith(VENDOR + sep))
        {
            if (layer !== 'cpu')
            {
                issues.push(
                    `${file} imports vendor (${spec}): vendor is reachable only from layers/cpu`);
            }
            continue;
        }

        if (!target.startsWith(SRC + sep))
        {
            issues.push(`${file} imports outside src (${spec})`);
            continue;
        }

        const t = classify(target);

        if (kind === 'system' && (t.kind === 'layer' || t.kind === 'layers-index'))
        {
            issues.push(`${file} (system) imports a layer (${spec}): system must not know layers`);
            continue;
        }

        if (kind === 'layer')
        {
            if (t.kind === 'layers-index')
            {
                issues.push(`${file} imports the layer aggregator (${spec}): `
                    + 'import the layer module directly');
            }
            if (t.kind === 'layer' && t.layer !== layer && !requireMap.get(layer).has(t.layer))
            {
                issues.push(
                    `${file} imports layer "${t.layer}" (${spec}) `
                        + 'but it is not declared in requires',
                );
            }
            if (t.kind === 'root')
            {
                issues.push(`${file} imports core.js (${spec}): `
                    + 'the facade is a consumer, not a dependency');
            }
        }
    }
}

// Cycle detection over the src import graph.
const graph = new Map(files.map(file=>[file, []]));
for (const file of files)
{
    for (const spec of specifiersOf(file))
    {
        if (!spec.startsWith('.'))
        {
            continue;
        }
        const target = resolve(dirname(file), spec);
        if (target.startsWith(SRC + sep))
        {
            graph.get(file).push(target);
        }
    }
}
const state = new Map();
const visit = file=>{
    const seen = state.get(file);
    if (seen === 1)
    {
        return null;
    }
    if (seen === 0)
    {
        return file;
    }
    state.set(file, 0);
    for (const next of graph.get(file))
    {
        const hit = visit(next);
        if (hit)
        {
            return hit;
        }
    }
    state.set(file, 1);
    return null;
};
for (const file of files)
{
    const hit = visit(file);
    if (hit)
    {
        issues.push(`Import cycle detected involving: ${hit}`);
        break;
    }
}

if (issues.length > 0)
{
    console.error(`Boundary violations:\n  - ${issues.join('\n  - ')}`);
    process.exit(1);
}
console.log(`Boundaries OK (${files.length} files checked).`);
