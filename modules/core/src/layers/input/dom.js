/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The browser half: a canvas, turned into the events the router understands.
 *
 * Everything here is attached to the viewport the game draws into and nothing
 * else. Not `window`, not `document` -- the canvas. That is the whole design,
 * and it decides three things at once:
 *
 * - **Focus is what arms the machine.** A keyboard event goes to the focused
 *   element, so listeners on the canvas fire only while the canvas has focus.
 *   A page carrying one of these behaves like an ordinary page until the person
 *   deliberately clicks into the game, and goes back to being one the moment
 *   they click out. Nothing had to be written to make that true; it is what
 *   attaching to the element instead of the document means.
 * - **Focus has to be visible, so it is made visible.** The canvas is given a
 *   tab stop if it has none and an outline while it holds focus. A machine that
 *   silently swallows every keystroke and one that silently ignores them look
 *   identical without it.
 * - **Nothing is captured by accident.** No listener outlives `detach`, and
 *   detaching releases whatever was held, because a key whose release is never
 *   delivered stays down inside the guest for ever.
 *
 * ## Escape
 *
 * Escape is a program's menu key and the browser's way out of pointer lock and
 * fullscreen, and those two claims cannot both be honoured by one press. The
 * rule here is that the person's way out always wins:
 *
 * - Escape is **never** `preventDefault`ed, so the browser's own exit gestures
 *   keep working exactly as they do on any other page. While the pointer is
 *   locked the browser consumes the first Escape to unlock and the guest does
 *   not see it; unlocked, it reaches the guest like any other key.
 * - Escape is **not** the way out of the game's focus. Two Escapes in quick
 *   succession give focus back to the page -- deliberate enough not to happen
 *   by accident, and reachable on a canvas that fills the window, where
 *   "click somewhere else" is not an instruction anybody can follow. Clicking
 *   outside the canvas does the same thing and needs no code at all.
 * - Both Escapes still reach the guest, so a program whose menu opens on the
 *   first one behaves normally; the second closes that menu and hands the page
 *   back.
 */

import { keyFor } from './keys.js';

/**
 * Keys the browser has already claimed. Preventing their default either does
 * nothing (F12) or takes something away from the person that the guest has no
 * business taking (reload, fullscreen, the way out of pointer lock).
 */
const RESERVED = new Set(['Escape', 'F5', 'F11', 'F12']);

/**
 * What a key press means as text, where the browser's own answer is a name
 * rather than a character. Everything else composes through the keyboard
 * layout and arrives as `KeyboardEvent.key`, which is the only source of a
 * character a table of key codes cannot be.
 */
const CONTROL_TEXT = Object.freeze({
    Enter: '\r',
    NumpadEnter: '\r',
    Tab: '\t',
    Backspace: '\b',
    Escape: '\x1b',
});

/** `MouseEvent.button`, in the order the DOM numbers them. */
const BUTTON_NAMES = Object.freeze(['left', 'middle', 'right', 'x1', 'x2']);

/** Two Escapes closer together than this hand focus back to the page. */
const RELEASE_WINDOW_MS = 600;

/**
 * What focus looks like. Set on the element rather than left to the browser's
 * own ring, because a page is free to have reset that away and an element that
 * takes every keystroke has to look like it is taking them.
 */
const FOCUS_OUTLINE = '2px solid #d0d0d0';

/** How far a stick has to move before it is worth an event. */
const AXIS_EPSILON = 0.02;

/**
 * A wheel notch, in the units a browser reports scrolling in. Pixel deltas are
 * what a mouse wheel produces in every current browser, and one notch is a
 * hundred of them; a line or a page delta is already counted in notches.
 */
const PIXELS_PER_NOTCH = 100;

/**
 * @typedef {Object} DomInputOptions
 * @property {HTMLCanvasElement} canvas   The viewport the game draws into.
 * @property {(event: import('./router.js').HostInputEvent) => unknown} send
 * @property {boolean} [pointerLock]
 *     Whether pressing a mouse button asks for the pointer. Off by default: a
 *     lock is a thing done to a person, and a program that does not need
 *     relative motion should not take their cursor away.
 */

/**
 * @param {DomInputOptions} options
 */
export function createDomInput({ canvas, send, pointerLock = false }){
    /** @type {[string, (event: any) => void, boolean][]} */
    const listeners = [];
    let focused = false;
    let lastEscape = -RELEASE_WINDOW_MS;
    // What a rounded delta has left over. Dropping it would mean a canvas shown
    // larger than its backing store loses slow mouse movement entirely, since
    // every delta would round to zero.
    let restX = 0;
    let restY = 0;
    let restNotches = 0;
    /** @type {number[]} */
    const padAxes = [];
    /** @type {boolean[]} */
    const padButtons = [];

    /** @param {string} type @param {(event: any) => void} handler @param {boolean} [passive] */
    const listen = (type, handler, passive = true)=>{
        listeners.push([type, handler, passive]);
        canvas.addEventListener(type, handler, { passive });
    };

    /**
     * Where the canvas's own pixels are, relative to the box it is drawn in.
     * A canvas is routinely displayed at a size that is not its resolution, and
     * a program told the CSS position would put its cursor somewhere else.
     */
    const projection = ()=>{
        const rect = canvas.getBoundingClientRect();
        return {
            rect,
            x: rect.width > 0 ? canvas.width / rect.width : 1,
            y: rect.height > 0 ? canvas.height / rect.height : 1,
        };
    };

    /** @param {KeyboardEvent} e */
    const onKeyDown = e=>{
        const mapping = keyFor(e.code);
        // Only what the guest actually consumes, and never over a combination
        // the browser reserves: a page that eats ctrl-w or F5 is a page nobody
        // can leave. ALT is deliberately not in that set -- a program of this
        // era binds alt-enter, and the browser's alt menu is recoverable.
        if (mapping && !RESERVED.has(e.code) && !e.ctrlKey && !e.metaKey)
        {
            e.preventDefault();
        }

        send({ kind: 'key', code: e.code, down: true });

        if (!e.ctrlKey && !e.metaKey)
        {
            const character = /** @type {Record<string, string>} */ (CONTROL_TEXT)[e.code]
                ?? (e.key.length === 1 ? e.key : null);
            if (character !== null)
            {
                send({ kind: 'text', text: character });
            }
        }

        // Last, so that the press itself has already reached the guest: this is
        // the second of two Escapes, and the program is entitled to see it
        // before it is told the window went away.
        if (e.code === 'Escape')
        {
            const quick = e.timeStamp - lastEscape < RELEASE_WINDOW_MS;
            lastEscape = e.timeStamp;
            if (quick)
            {
                // Blurring is what releases everything held, through the blur
                // handler -- including this Escape.
                canvas.blur();
            }
        }
    };

    /** @param {KeyboardEvent} e */
    const onKeyUp = e=>{
        if (keyFor(e.code) && !RESERVED.has(e.code) && !e.ctrlKey && !e.metaKey)
        {
            e.preventDefault();
        }
        send({ kind: 'key', code: e.code, down: false });
    };

    /** @param {PointerEvent} e */
    const onPointerMove = e=>{
        // A pointer event reaches an element whether or not it has focus, which
        // the keyboard's does not. Without this the guest would be tracking a
        // cursor across a page whose author is typing somewhere else entirely.
        if (!focused)
        {
            return;
        }
        // Read rather than listened for: knowing whether the pointer is locked
        // is a property of the document, but subscribing to it would put a
        // listener outside the canvas, which is the one thing this file does
        // not do.
        const locked = typeof document !== 'undefined' && document.pointerLockElement === canvas;
        const { rect, x: scaleX, y: scaleY } = projection();
        const dx = (e.movementX ?? 0) * scaleX + restX;
        const dy = (e.movementY ?? 0) * scaleY + restY;
        const wholeX = Math.trunc(dx);
        const wholeY = Math.trunc(dy);
        restX = dx - wholeX;
        restY = dy - wholeY;

        send({
            kind: 'pointerMove',
            // A locked pointer has no position: the client coordinates stop
            // moving, so reporting them would pin the cursor wherever the lock
            // began. The router advances its own from the deltas instead.
            x: locked ? undefined : Math.round((e.clientX - rect.left) * scaleX),
            y: locked ? undefined : Math.round((e.clientY - rect.top) * scaleY),
            dx: wholeX,
            dy: wholeY,
        });
    };

    /** @param {PointerEvent} e */
    const onPointerDown = e=>{
        e.preventDefault();
        // A canvas is not focusable by clicking in every browser, and this is
        // the gesture that means "I am playing now".
        canvas.focus();
        try
        {
            canvas.setPointerCapture(e.pointerId);
        }
        catch {
            // Already captured, or the pointer is locked. Neither is a failure:
            // both mean the moves are coming here anyway.
        }
        if (pointerLock)
        {
            lockPointer();
        }
        send({ kind: 'pointerButton', button: BUTTON_NAMES[e.button] ?? '', down: true });
    };

    /** @param {PointerEvent} e */
    const onPointerUp = e=>{
        try
        {
            canvas.releasePointerCapture(e.pointerId);
        }
        catch {
            // Nothing was captured. The button still has to be released.
        }
        send({ kind: 'pointerButton', button: BUTTON_NAMES[e.button] ?? '', down: false });
    };

    /** @param {WheelEvent} e */
    const onWheel = e=>{
        // Scrolling over a game nobody is playing scrolls the page, which is
        // why this returns before preventing anything.
        if (!focused)
        {
            return;
        }
        e.preventDefault();
        // Accumulated rather than one notch per event: a trackpad reports a
        // continuous stream of small deltas, and treating each as a full notch
        // makes every gesture a violent one.
        const notches = e.deltaMode === 0 ? e.deltaY / PIXELS_PER_NOTCH : e.deltaY;
        const total = restNotches + notches;
        const whole = Math.trunc(total);
        restNotches = total - whole;
        if (whole !== 0)
        {
            // A browser counts downwards as positive and a wheel message counts
            // it as negative, which is why this is not just a scale.
            send({ kind: 'wheel', delta: -whole * 120 });
        }
    };

    /** @param {Event} e */
    const onContextMenu = e=>{
        // The right button is a game's button, not a menu.
        e.preventDefault();
    };

    const onFocus = ()=>{
        focused = true;
        canvas.style.outline = FOCUS_OUTLINE;
        send({ kind: 'focus', gained: true });
    };

    const onBlur = ()=>{
        focused = false;
        canvas.style.outline = '';
        send({ kind: 'focus', gained: false });
    };

    /**
     * Asks for the pointer. Only ever from inside a user gesture: a browser
     * refuses otherwise, and a page that grabs the cursor on its own is a page
     * that has taken something.
     */
    const lockPointer = ()=>{
        try
        {
            const answer = /** @type {unknown} */ (canvas.requestPointerLock());
            if (answer instanceof Promise)
            {
                // A refusal is ordinary -- the gesture was too long ago, the
                // user just left a lock -- and is not worth an unhandled
                // rejection.
                answer.catch(()=>{});
            }
        }
        catch {
            // No pointer lock in this browser. Relative motion still arrives
            // through movementX/Y; it is only unbounded by the window.
        }
    };

    // A canvas is not in the tab order unless it is told to be, and an element
    // that cannot take focus can never receive a keystroke.
    if (!canvas.hasAttribute('tabindex'))
    {
        canvas.tabIndex = 0;
    }

    listen('keydown', onKeyDown, false);
    listen('keyup', onKeyUp, false);
    listen('pointermove', onPointerMove);
    listen('pointerdown', onPointerDown, false);
    listen('pointerup', onPointerUp);
    listen('pointercancel', onPointerUp);
    listen('wheel', onWheel, false);
    listen('contextmenu', onContextMenu, false);
    listen('focus', onFocus);
    listen('blur', onBlur);

    return {
        /** Puts the keyboard on the game, for a host with its own play button. */
        focus: ()=>canvas.focus(),
        lockPointer,
        focused: ()=>focused,

        /**
         * Reads the gamepads. They have no events -- the API is a snapshot --
         * so something has to ask, and this deliberately starts no timer of its
         * own: whoever already ticks the engine calls this, and a session
         * nobody is ticking is not one a pad should be polled for.
         */
        poll(){
            if (!focused || typeof navigator === 'undefined')
            {
                return;
            }
            const pads = navigator.getGamepads?.() ?? [];
            // The first pad that is actually there. Two-pad play is a device
            // model this layer does not have yet, and picking silently between
            // them would be a guess.
            const pad = [...pads].find(entry=>entry) ?? null;
            if (!pad)
            {
                return;
            }
            pad.axes.forEach((value, axis)=>{
                if (Math.abs(value - (padAxes[axis] ?? 0)) <= AXIS_EPSILON)
                {
                    return;
                }
                padAxes[axis] = value;
                send({ kind: 'padAxis', axis, value });
            });
            pad.buttons.forEach((entry, index)=>{
                if (entry.pressed === (padButtons[index] ?? false))
                {
                    return;
                }
                padButtons[index] = entry.pressed;
                send({ kind: 'padButton', index, down: entry.pressed });
            });
        },

        detach(){
            for (const [type, handler] of listeners)
            {
                canvas.removeEventListener(type, handler);
            }
            listeners.length = 0;
            canvas.style.outline = '';
            if (focused)
            {
                // Whatever was held goes up. Detaching is the last moment
                // anything can say so.
                focused = false;
                send({ kind: 'focus', gained: false });
            }
        },
    };
}
