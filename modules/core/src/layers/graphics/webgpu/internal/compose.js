/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The screen from several processes' pictures (roadmap/v2/windows.md, step
 * 3). Each process draws its own windows on its own desktop, in its own
 * order -- the run's order for its windows -- and sends that picture: a layer.
 * The screen is one layer, the base, with every visible top-level window of
 * the run copied over it from its own process's layer, bottom to top.
 *
 * That is the right pixel everywhere. Where windows overlap, the last copy is
 * the topmost window's, from its process's layer, and in that layer the
 * topmost of the process's windows there is that window itself, since it is
 * the topmost of all. Where no window is, every layer shows the desktop.
 *
 * What is made here is the plan: which rectangle of which layer goes where.
 * The GPU carries it out as texture copies; a test carries it out on bytes.
 */

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 * @typedef {{ width: number, height: number }} Size
 * @typedef {{ processId: number, rect: Rect, visible: boolean, parent?: number }} PlacedWindow
 * @typedef {{ source: number, x: number, y: number, width: number, height: number,
 *     toX: number, toY: number }} Copy
 */

/**
 * @param {Object} options
 * @param {PlacedWindow[]} options.windows  the run's top-level windows, the topmost first
 * @param {Map<number, Size>} options.layers  each process's newest picture, by process
 * @param {number} options.base  the process whose layer is the screen under the windows
 * @param {Size} options.screen
 * @returns {Copy[]} in order: the base, then the windows bottom to top
 */
export function compositionPlan({ windows, layers, base, screen }){
    /** @type {Copy[]} */
    const plan = [];
    const under = layers.get(base);
    if (under)
    {
        plan.push({ source: base, x: 0, y: 0, toX: 0, toY: 0,
            width: Math.min(under.width, screen.width),
            height: Math.min(under.height, screen.height) });
    }
    for (const window of [...windows].reverse())
    {
        const layer = layers.get(window.processId);
        if (!window.visible || !layer || (window.parent ?? 0) !== 0)
        {
            continue;
        }
        // On the screen and inside the layer it is read from.
        const left = Math.max(0, window.rect.left);
        const top = Math.max(0, window.rect.top);
        const right = Math.min(window.rect.right, screen.width, layer.width);
        const bottom = Math.min(window.rect.bottom, screen.height, layer.height);
        if (right <= left || bottom <= top)
        {
            continue;
        }
        plan.push({ source: window.processId, x: left, y: top, toX: left, toY: top,
            width: right - left, height: bottom - top });
    }
    return plan;
}

/**
 * The process whose layer is the screen under the windows: the foreground
 * window's, else the topmost visible window's that has a layer, else any.
 *
 * @param {PlacedWindow[]} windows  the topmost first
 * @param {Map<number, Size>} layers
 * @param {number | null} foreground  the foreground window's process, if any
 * @returns {number | null}
 */
export function baseOf(windows, layers, foreground){
    if (foreground !== null && layers.has(foreground))
    {
        return foreground;
    }
    const top = windows.find(window=>window.visible && layers.has(window.processId));
    return top ? top.processId : layers.keys().next().value ?? null;
}

/**
 * Whether the screen needs composing at all: visible top-level windows of more
 * than one process. With one, its picture is the screen as it always was.
 *
 * @param {PlacedWindow[]} windows
 */
export function needsComposing(windows){
    const processes = new Set();
    for (const window of windows)
    {
        if (window.visible && (window.parent ?? 0) === 0)
        {
            processes.add(window.processId);
        }
    }
    return processes.size > 1;
}
