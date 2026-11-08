/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/* global document, window, ResizeObserver, requestAnimationFrame, ForceGraph3D */

// The project in 3D: every part a point, held together by the lines the code
// draws (what holds what, what requires what). Play sends the walkthrough's
// steps through it, a pulse along each step's arrows; a click flies to a point
// and opens its card. Drag turns, the wheel or a pinch zooms. The names are
// HTML over the canvas, placed each frame where their points project.
(()=>{
    const box = document.getElementById('graph3d');
    const json = document.getElementById('graph3d-data');
    if (!box || !json)
    {
        return;
    }
    if (typeof ForceGraph3D !== 'function')
    {
        box.classList.add('g3-failed');
        box.querySelector('.g3-caption').textContent = 'The 3D library did not load.';
        return;
    }
    /**
     * @typedef {{ id: string, label: string, group: string, about: string, file: string | null,
     *     pages: { title: string, href: string }[], x?: number, y?: number, z?: number }} Point
     */
    /** @type {{ nodes: Point[], links: { source: any, target: any, kind: string }[],
     *     steps: { title: string, hops: [string, string][], nodes: string[] }[],
     *     github: string }} */
    const data = JSON.parse(json.textContent ?? '{}');
    const COLOUR = { package: '#ffd166', layer: '#4cc9f0', library: '#8d99f5', cork: '#ff9f1c',
        thread: '#f72585', outside: '#80ed99' };
    const SIZE = { package: 14, layer: 6, thread: 5, outside: 6, cork: 3, library: 1.2 };
    const NAMED = new Set(['package', 'layer', 'thread', 'outside']);

    // Each step's arrows are lines of their own, curved off the structure's, so
    // a pulse runs the way the step goes whatever the structure's line says.
    const flows = data.steps.flatMap((step, s)=>step.hops.map(([source, target])=>({
        source, target, kind: 'flow', step: s })));
    const links = [...data.links, ...flows];
    const lit = new Set();
    /** @type {Set<any>} */
    const litLinks = new Set();
    let picked = /** @type {Point | null} */ (null);

    // The library empties the element it draws in: it gets one of its own.
    const canvas = /** @type {HTMLElement} */ (box.querySelector('.g3-canvas'));
    const graph = new ForceGraph3D(canvas, { controlType: 'orbit' })
        .backgroundColor('rgba(0,0,0,0)')
        .showNavInfo(false)
        .graphData({ nodes: data.nodes, links })
        .nodeId('id')
        .nodeVal(node=>(lit.has(node.id) ? Math.max(10, (SIZE[node.group] ?? 2) * 2)
            : SIZE[node.group] ?? 2))
        .nodeColor(node=>(lit.size && !lit.has(node.id) ? '#2c3340' : COLOUR[node.group] ?? '#ccc'))
        .nodeOpacity(0.95)
        .nodeResolution(16)
        .nodeRelSize(6)
        .nodeLabel(node=>`<b>${node.label}</b><br>${node.about}`)
        .linkVisibility(link=>link.kind !== 'flow' || litLinks.has(link))
        .linkCurvature(link=>(link.kind === 'flow' ? 0.3 : 0))
        .linkColor(link=>(link.kind === 'flow' ? '#ffd166'
            : link.kind === 'requires' ? '#4cc9f0' : link.kind === 'runs' ? '#80ed99' : '#5b6577'))
        .linkOpacity(0.45)
        .linkWidth(link=>(link.kind === 'flow' ? 2.4 : link.kind === 'requires' ? 0.6 : 0))
        .linkDirectionalParticleWidth(6)
        .linkDirectionalParticleSpeed(0.015)
        .linkDirectionalParticleColor(()=>'#ffe8a3')
        .onNodeClick(node=>fly(/** @type {Point} */ (node)))
        .onBackgroundClick(()=>card(null))
        .cooldownTicks(240);
    graph.d3Force('charge')?.strength(-150);
    // The route's lines barely pull: the layout is the code's.
    graph.d3Force('link')?.distance(link=>(link.kind === 'holds' ? 34 : 90))
        .strength(link=>(link.kind === 'flow' ? 0.02 : link.kind === 'holds' ? 0.8 : 0.3));
    // Once the points have settled, the whole graph fills the box.
    let fitted = false;
    graph.onEngineStop(()=>{
        if (!fitted)
        {
            fitted = true;
            graph.zoomToFit(900, 30);
        }
    });

    const controls = graph.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.addEventListener?.('start', ()=>{ controls.autoRotate = false; });

    const fit = ()=>graph.width(box.clientWidth).height(box.clientHeight);
    new ResizeObserver(fit).observe(box);
    fit();

    // The names: one tag per named point, moved to where the point projects.
    const layer = /** @type {HTMLElement} */ (box.querySelector('.g3-labels'));
    // A small point is named only while a step lights it.
    const tags = new Map(data.nodes.map(node=>{
        const tag = document.createElement('span');
        tag.className = `g3-tag g3-${node.group}`;
        tag.textContent = node.label;
        layer.append(tag);
        return [node.id, tag];
    }));
    const place = ()=>{
        const camera = graph.camera();
        const e = camera.matrixWorld.elements;
        for (const node of data.nodes)
        {
            const tag = tags.get(node.id);
            if (!tag || node.x === undefined)
            {
                continue;
            }
            // Behind the camera a projection lands on the screen mirrored: hide it.
            const dx = node.x - camera.position.x;
            const dy = node.y - camera.position.y;
            const dz = node.z - camera.position.z;
            const ahead = -(dx * e[8] + dy * e[9] + dz * e[10]);
            const at = graph.graph2ScreenCoords(node.x, node.y, node.z);
            const far = Math.hypot(dx, dy, dz);
            const named = NAMED.has(node.group) || lit.has(node.id);
            tag.style.display = ahead > 0 && named ? '' : 'none';
            tag.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -150%)`;
            tag.style.opacity = String(Math.max(0.25, Math.min(1, 420 / far)));
            tag.classList.toggle('dim', lit.size > 0 && !lit.has(node.id));
        }
        requestAnimationFrame(place);
    };
    requestAnimationFrame(place);

    const caption = /** @type {HTMLElement} */ (box.querySelector('.g3-caption'));
    const panel = /** @type {HTMLElement} */ (box.querySelector('.g3-card'));
    const by = new Map(data.nodes.map(node=>[node.id, node]));

    /** @param {Point | null} node */
    const card = node=>{
        picked = node;
        panel.hidden = !node;
        if (!node)
        {
            return;
        }
        const docs = node.pages.length ? `<p>${node.pages.map(page=>
            `<a href="${page.href}">${page.title}</a>`).join(' · ')}</p>` : '';
        const code = node.file ? `<p><a href="${data.github}${node.file}">${node.file}</a></p>` : '';
        panel.innerHTML = '<button type="button" class="g3-close" aria-label="Close">'
            + '&times;</button>'
            + `<h3>${node.label}</h3><p>${node.about}</p>${docs}${code}`;
        panel.querySelector('.g3-close')?.addEventListener('click', ()=>card(null));
    };

    /** @param {Point} node */
    const fly = node=>{
        controls.autoRotate = false;
        const distance = 70;
        const ratio = 1 + distance / Math.max(1, Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0));
        graph.cameraPosition({ x: (node.x ?? 0) * ratio, y: (node.y ?? 0) * ratio,
            z: (node.z ?? 0) * ratio }, node, 1200);
        card(node);
    };

    /**
     * The camera turns to the step's parts: it looks at their middle from where
     * it stands, near enough to see them all.
     *
     * @param {string[]} ids
     */
    const follow = ids=>{
        const points = ids.map(id=>by.get(id)).filter(node=>node && node.x !== undefined);
        if (!points.length)
        {
            return;
        }
        const mid = ['x', 'y', 'z'].map(axis=>points.reduce((sum, node)=>sum + node[axis], 0)
            / points.length);
        const spread = Math.max(...points.map(node=>Math.hypot(node.x - mid[0], node.y - mid[1],
            node.z - mid[2])));
        const from = graph.camera().position;
        const away = [from.x - mid[0], from.y - mid[1], from.z - mid[2]];
        const length = Math.hypot(...away) || 1;
        const distance = Math.max(300, spread * 3.2);
        graph.cameraPosition({ x: mid[0] + away[0] / length * distance,
            y: mid[1] + away[1] / length * distance, z: mid[2] + away[2] / length * distance },
        { x: mid[0], y: mid[1], z: mid[2] }, 1400);
    };

    // The route: a step lights its parts and sends a pulse along each arrow.
    let step = -1;
    let timer = 0;
    const refresh = ()=>graph.nodeColor(graph.nodeColor()).linkVisibility(graph.linkVisibility());
    /** @param {number} index */
    const show = index=>{
        step = (index + data.steps.length) % data.steps.length;
        const current = data.steps[step];
        lit.clear();
        litLinks.clear();
        current.nodes.forEach(id=>lit.add(id));
        for (const link of flows)
        {
            if (/** @type {any} */ (link).step === step)
            {
                litLinks.add(link);
            }
        }
        refresh();
        litLinks.forEach(link=>graph.emitParticle(link));
        follow(current.nodes);
        caption.textContent = `${step + 1} / ${data.steps.length} · `
            + `${current.title.replace(/^\d+\.\s*/, '')}`;
        if (picked && !lit.has(picked.id))
        {
            card(null);
        }
    };
    const play = /** @type {HTMLButtonElement} */ (box.querySelector('[data-act="play"]'));
    const stop = ()=>{
        window.clearInterval(timer);
        timer = 0;
        play.innerHTML = '&#9654; Play';
    };
    const start = ()=>{
        controls.autoRotate = true;
        show(step + 1);
        timer = window.setInterval(()=>{
            if (step === data.steps.length - 1)
            {
                stop();
                return;
            }
            show(step + 1);
        }, 2400);
        play.innerHTML = '&#10074;&#10074; Pause';
    };
    play.addEventListener('click', ()=>(timer ? stop() : start()));
    /** @param {number} delta */
    const move = delta=>{
        stop();
        show(step + delta);
    };
    box.querySelector('[data-act="next"]')?.addEventListener('click', ()=>move(1));
    box.querySelector('[data-act="back"]')?.addEventListener('click', ()=>move(-1));
    box.querySelector('[data-act="full"]')?.addEventListener('click', ()=>{
        if (document.fullscreenElement)
        {
            document.exitFullscreen();
        }
        else
        {
            box.requestFullscreen?.();
        }
    });
    // A part named in the address (`#core/win32`) opens with it.
    const asked = by.get(decodeURIComponent(window.location.hash.slice(1)));
    if (asked)
    {
        window.setTimeout(()=>fly(asked), 1500);
    }
})();
