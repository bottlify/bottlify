/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// What the docs tools read out of a markdown page: its headings' anchors and
// its links. The anchors are GitHub's, so a link that works on GitHub works on
// the site and the other way round.

/**
 * GitHub's anchor for a heading's text: lower case, punctuation dropped, each
 * space a hyphen.
 *
 * @param {string} text
 */
export const slug = text=>text.trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

/**
 * The page's lines with fenced code blanked, so a `#` comment or a link in an
 * example is not read as a heading or a link.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function prose(text){
    let fenced = false;
    return text.replace(/\r\n/g, '\n').split('\n').map(line=>{
        if (/^\s*```/.test(line))
        {
            fenced = !fenced;
            return '';
        }
        return fenced ? '' : line;
    });
}

/**
 * Every heading of a page, with its level and the anchor GitHub gives it (a
 * repeated anchor gets `-1`, `-2`, ...).
 *
 * @param {string} text
 * @returns {{ level: number, text: string, anchor: string }[]}
 */
export function headings(text){
    /** @type {Map<string, number>} */
    const seen = new Map();
    const out = [];
    for (const line of prose(text))
    {
        const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (!match)
        {
            continue;
        }
        const base = slug(match[2].replace(/`/g, ''));
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const anchor = count ? `${base}-${count}` : base;
        out.push({ level: match[1].length, text: match[2], anchor });
    }
    return out;
}

/**
 * Every link of a page outside code: `[text](url)` and `<img src="url">`.
 *
 * @param {string} text
 * @returns {{ url: string, line: number }[]}
 */
export function links(text){
    const out = [];
    for (const [i, line] of prose(text).entries())
    {
        const outside = line.split(/(`[^`]*`)/).filter((_, k)=>k % 2 === 0).join(' ');
        for (const match of outside.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img[^>]*\ssrc="([^"]+)"/g))
        {
            out.push({ url: match[1] ?? match[2], line: i + 1 });
        }
    }
    return out;
}
