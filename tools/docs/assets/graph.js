/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/* global document, location, history */

// The module graph: picking a layer shades everything it requires (all the way
// down) and everything that requires it, draws its own edges, and shows what
// its module.js says about it.
(()=>{
    const svg = document.querySelector('svg.graph');
    const card = document.getElementById('card');
    const json = document.getElementById('layers');
    if (!svg || !card || !json)
    {
        return;
    }
    /** @type {{ name: string, requires: string[] }[]} */
    const layers = JSON.parse(json.textContent ?? '[]');
    const by = new Map(layers.map(layer=>[layer.name, layer]));
    /** @param {string} name @param {(name: string) => string[]} next */
    const closure = (name, next)=>{
        const seen = new Set();
        const walk = (/** @type {string} */ at)=>next(at).forEach(other=>{
            if (!seen.has(other))
            {
                seen.add(other);
                walk(other);
            }
        });
        walk(name);
        return seen;
    };
    /** @param {string} name */
    const pick = name=>{
        const down = closure(name, at=>by.get(at)?.requires ?? []);
        const up = closure(name, at=>layers.filter(layer=>layer.requires.includes(at))
            .map(layer=>layer.name));
        svg.querySelectorAll('.node').forEach(node=>{
            const own = /** @type {SVGElement} */ (node).dataset.name ?? '';
            node.classList.toggle('on', own === name);
            node.classList.toggle('down', down.has(own));
            node.classList.toggle('up', up.has(own));
        });
        svg.querySelectorAll('.edge').forEach(edge=>{
            const { from, to } = /** @type {SVGElement} */ (edge).dataset;
            edge.classList.toggle('on', from === name || to === name);
        });
        card.innerHTML = document.getElementById(`about-${name}`)?.innerHTML ?? '';
        history.replaceState(null, '', `#${name}`);
    };
    svg.querySelectorAll('.node').forEach(node=>{
        const name = /** @type {SVGElement} */ (node).dataset.name ?? '';
        node.addEventListener('click', ()=>pick(name));
        node.addEventListener('keydown', event=>{
            if (/** @type {KeyboardEvent} */ (event).key === 'Enter'
                || /** @type {KeyboardEvent} */ (event).key === ' ')
            {
                event.preventDefault();
                pick(name);
            }
        });
    });
    const asked = location.hash.slice(1);
    pick(by.has(asked) ? asked : layers[layers.length - 1].name);
})();
