/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/* global document, location, fetch */

// The docs site's search: search.json holds one entry per section, and every
// word asked for must be in an entry's title or text; a word in the title
// counts for more.
(()=>{
    const box = /** @type {HTMLInputElement} */ (document.getElementById('q'));
    const out = /** @type {HTMLElement} */ (document.getElementById('results'));
    const base = document.documentElement.dataset.base ?? '';
    /** @type {{ url: string, title: string, page: string, text: string }[] | null} */
    let index = null;
    let pick = 0;
    const load = async()=>{
        index ??= await (await fetch(`${base}search.json`)).json();
        return /** @type {NonNullable<typeof index>} */ (index);
    };
    /** @param {{ url: string, title: string, page: string }[]} items */
    const show = items=>{
        out.innerHTML = items.map((item, i)=>`<a href="${base}${item.url}"`
            + ` class="${i === pick ? 'on' : ''}">${item.title}<small>${item.page}</small></a>`).join('');
        out.style.display = items.length ? 'block' : 'none';
    };
    box.addEventListener('input', async()=>{
        const words = box.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!words.length)
        {
            show([]);
            return;
        }
        pick = 0;
        const scored = [];
        for (const item of await load())
        {
            const title = item.title.toLowerCase();
            let score = 0;
            for (const word of words)
            {
                score = score < 0 ? score
                    : title.includes(word) ? score + 10 : item.text.includes(word) ? score + 1 : -1;
            }
            if (score > 0)
            {
                scored.push({ item, score });
            }
        }
        show(scored.sort((a, b)=>b.score - a.score).slice(0, 12).map(entry=>entry.item));
    });
    box.addEventListener('keydown', event=>{
        const links = [...out.querySelectorAll('a')];
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && links.length)
        {
            event.preventDefault();
            pick = (pick + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
            links.forEach((link, i)=>link.classList.toggle('on', i === pick));
        }
        else if (event.key === 'Enter' && links[pick])
        {
            location.href = links[pick].href;
        }
        else if (event.key === 'Escape')
        {
            show([]);
            box.blur();
        }
    });
    document.addEventListener('click', event=>{
        if (!(/** @type {Element} */ (event.target)).closest('.search'))
        {
            out.style.display = 'none';
        }
    });
    document.addEventListener('keydown', event=>{
        if (event.key === '/' && document.activeElement !== box)
        {
            event.preventDefault();
            box.focus();
        }
    });
})();
