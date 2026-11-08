/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectWrite's fonts as data: a face read from a file's bytes, the fonts a
 * collection holds grouped into families, and how a family picks the font
 * nearest a weight, stretch and style. No COM here - `functions.js` hands
 * these out as interfaces.
 */

import {
    analyzeFile, characterMapOf, glyphsOf, metricsOf, namesOf, styleOf, tablesOf,
} from './sfnt.js';

/** DWRITE_FONT_SIMULATIONS. */
export const SIMULATION = Object.freeze({ NONE: 0, BOLD: 1, OBLIQUE: 2 });

/** DWRITE_FONT_STYLE. */
export const FONT_STYLE = Object.freeze({ NORMAL: 0, OBLIQUE: 1, ITALIC: 2 });

/** Windows LCIDs a 'name' record carries and the locale names DirectWrite gives them. */
const LOCALES = new Map([[0x409, 'en-us'], [0x809, 'en-gb'], [0x407, 'de-de'], [0x40c, 'fr-fr'],
    [0x410, 'it-it'], [0x40a, 'es-es'], [0xc0a, 'es-es'], [0x416, 'pt-br'], [0x816, 'pt-pt'],
    [0x413, 'nl-nl'], [0x419, 'ru-ru'], [0x415, 'pl-pl'], [0x405, 'cs-cz'], [0x40e, 'hu-hu'],
    [0x41d, 'sv-se'], [0x406, 'da-dk'], [0x414, 'nb-no'], [0x40b, 'fi-fi'], [0x408, 'el-gr'],
    [0x41f, 'tr-tr'], [0x411, 'ja-jp'], [0x412, 'ko-kr'], [0x804, 'zh-cn'], [0x404, 'zh-tw'],
    [0xc04, 'zh-hk'], [0x40d, 'he-il'], [0x401, 'ar-sa'], [0x41e, 'th-th'], [0x422, 'uk-ua'],
    [0x424, 'sl-si'], [0x41b, 'sk-sk'], [0x418, 'ro-ro'], [0x402, 'bg-bg'], [0x41a, 'hr-hr'],
    [0x81a, 'sr-latn-cs'], [0x425, 'et-ee'], [0x426, 'lv-lv'], [0x427, 'lt-lt'],
    [0x42a, 'vi-vn'], [0x429, 'fa-ir'], [0x439, 'hi-in'], [0x421, 'id-id']]);

/** A name record's language as a locale name, or null for one not known. @param {number} language */
export const localeOf = language=>LOCALES.get(language) ?? null;

/**
 * Localized strings: [locale, text], en-us first where it is one of them.
 *
 * @typedef {[string, string][]} Localized
 */

/**
 * A name of a face by name ids in order of preference, each language once.
 *
 * @param {{ id: number, language: number, platform: number, text: string }[]} names
 * @param {number[]} ids
 * @returns {Localized}
 */
export function localized(names, ids){
    for (const id of ids)
    {
        /** @type {Map<string, string>} */
        const found = new Map();
        // Windows' records first: a Macintosh one only fills a language they lack.
        for (const record of [...names].sort((a, b)=>b.platform - a.platform))
        {
            const locale = record.id === id ? localeOf(record.language) : null;
            if (locale && !found.has(locale))
            {
                found.set(locale, record.text);
            }
        }
        if (found.size)
        {
            const entries = [...found.entries()];
            entries.sort(([a], [b])=>(a === 'en-us' ? -1 : b === 'en-us' ? 1 : 0));
            return entries;
        }
    }
    return [];
}

/**
 * A face: one face of a file, with its simulations, its tables read.
 *
 * @typedef {Object} Face
 * @property {FileRef} file
 * @property {number} index
 * @property {number} simulations
 * @property {number} type       DWRITE_FONT_FACE_TYPE
 * @property {Uint8Array} bytes  the whole file
 * @property {Map<string, Uint8Array>} tables
 * @property {ReturnType<typeof metricsOf>} metrics
 * @property {ReturnType<typeof characterMapOf>} cmap
 * @property {ReturnType<typeof glyphsOf>} glyphs
 * @property {ReturnType<typeof styleOf>} style
 * @property {{ id: number, language: number, platform: number, text: string }[]} names
 * @property {ReturnType<typeof import('./system.js').createSystemFace> | null} system
 *     the system face it is, measured by the font engine; null for a file's
 */

/**
 * What a file is to DirectWrite: its reference key and which loader reads
 * it, and its bytes once read.
 *
 * @typedef {Object} FileRef
 * @property {string} id           the key's identity: loader and key bytes
 * @property {Uint8Array} key
 * @property {number} loader       the loader's pointer, 0 for the local file loader
 * @property {string | null} path  the local file's path
 * @property {Uint8Array | null} bytes
 * @property {ReturnType<typeof import('./system.js').createSystemFace> | null} system
 */

/**
 * A face read from its file's bytes.
 *
 * @param {FileRef} file @param {Uint8Array} bytes @param {number} index
 * @param {number} simulations
 * @returns {Face}
 */
export function readFace(file, bytes, index, simulations){
    const kind = analyzeFile(bytes);
    const tables = tablesOf(bytes, kind.faces[index]);
    return { file, index, simulations, type: kind.faceType, bytes,
        tables, metrics: metricsOf(tables), cmap: characterMapOf(tables.get('cmap')),
        glyphs: glyphsOf(tables), style: styleOf(tables), names: namesOf(tables.get('name')),
        system: file.system };
}

/**
 * A font of a collection: its face's identity, and what DirectWrite says of it.
 *
 * @typedef {Object} FontEntry
 * @property {FileRef} file
 * @property {number} index
 * @property {number} simulations
 * @property {number} weight
 * @property {number} stretch
 * @property {number} style
 * @property {Localized} faceNames
 * @property {() => Face} face  the face, read when first asked for
 */

/**
 * @typedef {Object} FamilyEntry
 * @property {Localized} names
 * @property {FontEntry[]} fonts
 */

/**
 * The fonts a face makes, and the family each belongs to by its en-us name.
 *
 * @param {Face[]} faces
 * @returns {FamilyEntry[]}
 */
export function familiesOf(faces){
    /** @type {Map<string, FamilyEntry>} */
    const byName = new Map();
    for (const face of faces)
    {
        const names = localized(face.names, [16, 1]);
        if (!names.length)
        {
            continue;
        }
        const key = names[0][1].toLowerCase();
        let family = byName.get(key);
        if (!family)
        {
            family = { names, fonts: [] };
            byName.set(key, family);
        }
        family.fonts.push({ file: face.file, index: face.index, simulations: face.simulations,
            weight: face.style.weight, stretch: face.style.stretch, style: face.style.style,
            faceNames: localized(face.names, [17, 2]), face: ()=>face });
    }
    return [...byName.values()];
}

/**
 * How far a font is from what is asked, CSS's way: the stretch first, then the
 * style (italic, then oblique, then normal for an italic asked), then the
 * weight (from 400 to 500 first, then lighter, then heavier; above 500
 * heavier first).
 *
 * @param {FontEntry} font @param {number} weight @param {number} stretch @param {number} style
 */
function distance(font, weight, stretch, style){
    const stretchDistance = Math.abs(font.stretch - stretch);
    const styles = style === FONT_STYLE.ITALIC ? [2, 1, 0] : style === FONT_STYLE.OBLIQUE
        ? [1, 2, 0] : [0, 1, 2];
    const styleDistance = styles.indexOf(font.style);
    let weightDistance;
    if (font.weight === weight)
    {
        weightDistance = 0;
    }
    else if (weight >= 400 && weight <= 500)
    {
        weightDistance = font.weight > weight && font.weight <= 500 ? font.weight - weight
            : font.weight < weight ? 1000 + weight - font.weight : 2000 + font.weight - weight;
    }
    else if (weight < 400)
    {
        weightDistance = font.weight < weight ? weight - font.weight : 1000 + font.weight - weight;
    }
    else
    {
        weightDistance = font.weight > weight ? font.weight - weight : 1000 + weight - font.weight;
    }
    return stretchDistance * 1e8 + styleDistance * 1e5 + weightDistance;
}

/**
 * A family's fonts nearest first, and the simulations the first needs to
 * look as asked: bold where a weight of 600 or more is asked of a face under
 * 500, oblique where an italic or oblique is asked of an upright face.
 *
 * @param {FamilyEntry} family @param {number} weight @param {number} stretch @param {number} style
 * @returns {FontEntry[]}
 */
export function matching(family, weight, stretch, style){
    const sorted = [...family.fonts].sort((a, b)=>distance(a, weight, stretch, style)
        - distance(b, weight, stretch, style));
    return sorted.map((font, i)=>{
        if (i > 0)
        {
            return font;
        }
        const simulations = (weight >= 600 && font.weight < 500 ? SIMULATION.BOLD : 0)
            | (style !== FONT_STYLE.NORMAL && font.style === FONT_STYLE.NORMAL
                ? SIMULATION.OBLIQUE : 0);
        return simulations ? { ...font, simulations: font.simulations | simulations,
            weight: simulations & SIMULATION.BOLD ? 700 : font.weight,
            style: simulations & SIMULATION.OBLIQUE ? FONT_STYLE.OBLIQUE : font.style } : font;
    });
}
