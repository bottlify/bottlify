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

/** @param {string} text */
const escape = text=>text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The inline tags a page may write as HTML; any other `<` is text. */
const INLINE_TAGS = /^<\/?(br|b|i|em|strong|sub|sup|kbd|code|img|a|span)\b[^>]*>/i;

/**
 * One line's inline markdown as HTML: code spans, links and images, bold,
 * italic, struck text, and the few inline tags `INLINE_TAGS` lets through.
 *
 * @param {string} text
 * @param {(url: string) => string} link  Where a link's or an image's url leads.
 */
export function inline(text, link){
    /** @type {string[]} */
    const held = [];
    const hold = (/** @type {string} */ html)=>`\uE000${held.push(html) - 1}\uE000`;
    let out = text
        .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code)=>hold(`<code>${escape(code.trim())}</code>`))
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
            (_, alt, url)=>hold(`<img src="${escape(link(url))}" alt="${escape(alt)}">`))
        .replace(/<[^>]*>/g, tag=>INLINE_TAGS.test(tag)
            ? hold(tag.replace(/\ssrc="([^"]+)"/, (_, url)=>` src="${escape(link(url))}"`)) : tag);
    out = escape(out)
        .replace(/\[((?:[^\]\\]|\\.|\uE000\d+\uE000)+)\]\(([^)\s]+)\)/g,
            (_, label, url)=>`<a href="${escape(link(url.replace(/&amp;/g, '&')))}">${label}</a>`)
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1<em>$2</em>')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
        .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1');
    return out.replace(/\uE000(\d+)\uE000/g, (_, i)=>held[Number(i)]);
}

/**
 * A table row's cells: split on `|` that is not escaped and not inside code.
 *
 * @param {string} line
 */
function cells(line){
    const out = [''];
    let code = false;
    const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    for (let i = 0; i < body.length; i++)
    {
        const c = body[i];
        if (c === '\\' && body[i + 1] === '|')
        {
            out[out.length - 1] += '|';
            i++;
        }
        else if (c === '`')
        {
            code = !code;
            out[out.length - 1] += c;
        }
        else if (c === '|' && !code)
        {
            out.push('');
        }
        else
        {
            out[out.length - 1] += c;
        }
    }
    return out.map(cell=>cell.trim());
}

/**
 * A page as HTML. What the docs use and nothing more: headings with GitHub's
 * anchors, paragraphs, nested lists, tables, fenced code (a `mermaid` fence
 * kept for the diagram script), and blocks of HTML passed through.
 *
 * @param {string} text
 * @param {{ link?: (url: string) => string }} [options]
 */
export function render(text, { link = url=>url } = {}){
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const anchors = headings(text).map(heading=>heading.anchor);
    const html = [];
    let paragraph = [];
    /** @type {{ indent: number, tag: string }[]} */
    const lists = [];
    let item = false;
    const flush = ()=>{
        if (paragraph.length)
        {
            const body = inline(paragraph.join('\n'), link);
            html.push(lists.length ? body : `<p>${body}</p>`);
            paragraph = [];
        }
    };
    const closeLists = (/** @type {number} */ indent)=>{
        while (lists.length && lists[lists.length - 1].indent >= indent)
        {
            flush();
            html.push(`</li></${/** @type {any} */ (lists.pop()).tag}>`);
        }
    };
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        const fence = /^(\s*)```\s*([\w-]*)/.exec(line);
        if (fence)
        {
            flush();
            const body = [];
            while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]))
            {
                body.push(lines[i].slice(fence[1].length));
            }
            html.push(fence[2] === 'mermaid'
                ? `<pre class="mermaid">${escape(body.join('\n'))}</pre>`
                : `<pre><code${fence[2] ? ` class="language-${fence[2]}"` : ''}>`
                    + `${escape(body.join('\n'))}</code></pre>`);
            continue;
        }
        if (/^\s*<!--/.test(line))
        {
            // A comment is for whoever edits the page (`covers:`), not its reader.
            while (!lines[i].includes('-->') && i + 1 < lines.length)
            {
                i++;
            }
            continue;
        }
        const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading)
        {
            flush();
            closeLists(0);
            const id = anchors.shift();
            html.push(`<h${heading[1].length} id="${id}">${inline(heading[2], link)}`
                + `<a class="anchor" href="#${id}" aria-hidden="true">#</a></h${heading[1].length}>`);
            continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? ''))
        {
            flush();
            closeLists(0);
            const align = cells(lines[i + 1]).map(cell=>cell.endsWith(':')
                ? (cell.startsWith(':') ? 'center' : 'right') : '');
            const cell = (/** @type {string} */ tag, /** @type {string} */ body,
                /** @type {number} */ k)=>`<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>`
                + `${inline(body, link)}</${tag}>`;
            const head = cells(line).map((body, k)=>cell('th', body, k)).join('');
            const rows = [];
            i += 2;
            for (; i < lines.length && /^\s*\|/.test(lines[i]); i++)
            {
                const row = cells(lines[i]).map((body, k)=>cell('td', body, k)).join('');
                rows.push(`<tr>${row}</tr>`);
            }
            i--;
            html.push(`<div class="table"><table><thead><tr>${head}</tr></thead>`
                + `<tbody>${rows.join('')}</tbody></table></div>`);
            continue;
        }
        const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (bullet)
        {
            flush();
            const indent = bullet[1].length;
            const tag = /\d/.test(bullet[2]) ? 'ol' : 'ul';
            const top = lists[lists.length - 1];
            if (top && top.indent > indent)
            {
                closeLists(indent + 1);
            }
            const current = lists[lists.length - 1];
            if (current && current.indent === indent)
            {
                html.push('</li><li>');
            }
            else
            {
                const start = tag === 'ol' && parseInt(bullet[2], 10) !== 1
                    ? ` start="${parseInt(bullet[2], 10)}"` : '';
                lists.push({ indent, tag });
                html.push(`<${tag}${start}><li>`);
            }
            item = true;
            paragraph.push(bullet[3]);
            continue;
        }
        if (!line.trim())
        {
            flush();
            // A blank line ends a list unless the next line goes on inside it.
            const next = lines.slice(i + 1).find(l=>l.trim());
            if (lists.length && !(next && /^\s+\S/.test(next)
                && next.search(/\S/) > lists[0].indent))
            {
                closeLists(0);
            }
            item = false;
            continue;
        }
        if (/^\s*<\/?[a-z][^>]*>/i.test(line) && !INLINE_TAGS.test(line.trim()) && !paragraph.length)
        {
            closeLists(0);
            const block = [line];
            while (i + 1 < lines.length && lines[i + 1].trim())
            {
                block.push(lines[++i]);
            }
            html.push(block.join('\n').replace(/\ssrc="([^"]+)"/g,
                (_, url)=>` src="${escape(link(url))}"`));
            continue;
        }
        if (lists.length && !item && paragraph.length === 0)
        {
            html.push('<br>');
        }
        paragraph.push(line.trim());
    }
    flush();
    closeLists(0);
    return html.join('\n');
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
