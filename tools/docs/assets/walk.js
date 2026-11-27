/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/* global document, window, requestAnimationFrame */

// A walkthrough page: the panel stays above the steps, and the step being
// read lights its parts and arrows. The step follows the scroll; Back and
// Next, the arrow keys and a click on a part move to a step and scroll to it.
(()=>{
    const panel = document.getElementById('walk');
    const json = document.getElementById('walk-data');
    if (!panel || !json)
    {
        return;
    }
    /** @type {{ anchor: string, title: string, nodes: string[], edges: [string, string][] }[]} */
    const steps = JSON.parse(json.textContent ?? '[]');
    const map = /** @type {SVGElement} */ (panel.querySelector('svg'));
    const title = /** @type {HTMLElement} */ (panel.querySelector('.walk-title'));
    const headings = steps.map(step=>document.getElementById(step.anchor));
    let current = -1;
    let steering = 0;

    /** @param {number} index */
    const show = index=>{
        if (index === current)
        {
            return;
        }
        current = index;
        const step = steps[index];
        const lit = new Set(step.edges.map(([a, b])=>`${a}>${b}`));
        map.classList.add('stepping');
        map.querySelectorAll('.node').forEach(node=>node.classList.toggle('on',
            step.nodes.includes(/** @type {SVGElement} */ (node).dataset.id ?? '')));
        map.querySelectorAll('.edge').forEach(edge=>edge.classList.toggle('on',
            lit.has(/** @type {SVGElement} */ (edge).dataset.key ?? '')));
        headings.forEach((heading, i)=>heading?.classList.toggle('current', i === index));
        title.textContent = `${index + 1} / ${steps.length} · ${step.title.replace(/^\d+\.\s*/, '')}`;
    };

    // The steps' headings scroll to just under the panel, not behind it.
    const clearance = ()=>{
        const below = panel.getBoundingClientRect().height + 72;
        document.documentElement.style.scrollPaddingTop = `${below}px`;
        return below;
    };

    /** @param {number} index */
    const go = index=>{
        const to = Math.max(0, Math.min(steps.length - 1, index));
        show(to);
        clearance();
        steering = Date.now();
        headings[to]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // The step being read: the last whose heading has come up to the panel.
    let queued = false;
    const follow = ()=>{
        queued = false;
        if (Date.now() - steering < 800)
        {
            return;
        }
        const line = clearance() + 8;
        let index = 0;
        headings.forEach((heading, i)=>{
            if (heading && heading.getBoundingClientRect().top <= line)
            {
                index = i;
            }
        });
        show(index);
    };
    window.addEventListener('scroll', ()=>{
        if (!queued)
        {
            queued = true;
            requestAnimationFrame(follow);
        }
    }, { passive: true });
    window.addEventListener('resize', clearance);

    panel.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',
        ()=>go(current + Number(/** @type {HTMLElement} */ (button).dataset.go))));
    document.addEventListener('keydown', event=>{
        const typing = /** @type {HTMLElement} */ (event.target).closest?.('input, textarea');
        if (!typing && (event.key === 'ArrowRight' || event.key === 'ArrowLeft'))
        {
            go(current + (event.key === 'ArrowRight' ? 1 : -1));
        }
    });
    map.querySelectorAll('.node').forEach(node=>{
        const id = /** @type {SVGElement} */ (node).dataset.id ?? '';
        const open = ()=>{
            const first = steps.findIndex(step=>step.nodes.includes(id));
            if (first >= 0)
            {
                go(first);
            }
        };
        node.addEventListener('click', open);
        node.addEventListener('keydown', event=>{
            if (/** @type {KeyboardEvent} */ (event).key === 'Enter')
            {
                open();
            }
        });
    });
    clearance();
    show(0);
    follow();
})();
