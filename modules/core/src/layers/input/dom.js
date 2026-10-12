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
 * - **Focus decides where a keystroke goes, and only that.** A keyboard event
 *   reaches the focused element, so listeners on the canvas fire only while the
 *   canvas has focus, and a page carrying one of these behaves like an ordinary
 *   page until the person clicks into the game. Nothing had to be written to
 *   make that true; it is what attaching to the element instead of the document
 *   means. The pointer is a different matter: a move over this canvas is a move
 *   over this canvas, and it is reported whether or not the element holds
 *   focus. Making the mouse depend on focus lets a click on a panel beside the
 *   viewport freeze the cursor inside the program, which is the page telling
 *   the guest about itself.
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

import { keyFor } from '../win32/user32/keys.js';

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
/**
 * Each button by its bit in PointerEvent.buttons, which orders them otherwise:
 * left, right, middle, back, forward.
 */
/** @type {readonly (readonly [number, string])[]} */
const BUTTON_BITS = Object.freeze([[1, 'left'], [2, 'right'], [4, 'middle'], [8, 'x1'],
    [16, 'x2']]);
/**
 * The key held for the page's own pointer: right Alt, which a Mac keyboard has
 * as right Option and a game of the era all but never binds, where Control is
 * a crouch or a fire button.
 */
export const RELEASE_KEY = 'AltRight';
/**
 * Whether a key event is RELEASE_KEY: by its code, or as the right-hand Alt
 * where a layout names the key otherwise (AltGraph, Option under another code).
 *
 * @param {{ code?: string, key?: string, location?: number }} e
 */
export const isReleaseKey = e=>e.code === RELEASE_KEY
    || ((e.key === 'Alt' || e.key === 'AltGraph') && e.location === 2);
/** A wheel event this long after the last one is a notch of its own, however small. */
const WHEEL_GAP_MS = 120;

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
 * @property {() => { width: number, height: number }} [resolution]
 *     The picture's own pixels, when the canvas's size attributes do not say:
 *     a canvas whose control was transferred to a worker keeps the size the
 *     page gave it while the worker draws at the program's.
 */

/**
 * @param {DomInputOptions} options
 */
export function createDomInput({ canvas, send, pointerLock = false, resolution }){
    const pixels = resolution ?? (()=>({ width: canvas.width, height: canvas.height }));
    /** @type {[string, (event: any) => void, boolean][]} */
    const listeners = [];
    let focused = false;
    let lastEscape = -RELEASE_WINDOW_MS;
    let restX = 0;
    let restY = 0;
    // Where the pointer was, in the picture's own pixels, so that motion can be
    // the difference between two positions instead of a number in units of its
    // own. Null until there is a previous position, and again whenever the
    // pointer is locked and has none.
    /** @type {number | null} */
    let lastX = null;
    /** @type {number | null} */
    let lastY = null;
    let restNotches = 0;
    let lastWheel = -Infinity;
    /** The buttons the program was last told are down, as PointerEvent.buttons bits. */
    let heldButtons = 0;
    /** Whether the person holds the page's own pointer (RELEASE_KEY). */
    let releaseHeld = false;
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
     * How a position in the box the canvas is drawn in becomes a position in
     * the program's own screen.
     *
     * The ratio is the canvas's own pixels against the size it is really drawn
     * at on the page. Those pixels are the picture the person is looking at, so
     * they are the space a cursor lives in -- whatever the program's window was
     * configured to be. Taking a configured size instead puts the cursor where
     * nobody is pointing whenever the program presents at another one.
     *
     * Read on every move rather than remembered, because a canvas is routinely
     * displayed at a size that is not its resolution and that size changes
     * whenever a panel opens or the window is dragged.
     *
     * What the rectangle is not is the picture: `getBoundingClientRect` answers
     * with the border box, and a canvas is a replaced element whose image fills
     * the content box. A border of a single pixel therefore moves the origin
     * and stretches the ratio, and a page is entitled to put one there -- so
     * the insets are taken out rather than assumed away. They are re-read only
     * when the drawn size changes, because reading a computed style is a style
     * recalculation and a pointer moves a hundred times a second.
     */
    let boxWidth = -1;
    let boxHeight = -1;
    let inset = { left: 0, top: 0, x: 0, y: 0 };

    const insetsOf = ()=>{
        const style = globalThis.getComputedStyle?.(canvas);
        if (!style)
        {
            return { left: 0, top: 0, x: 0, y: 0 };
        }
        /** @param {string} value */
        const px = value=>parseFloat(value) || 0;
        const left = px(style.borderLeftWidth) + px(style.paddingLeft);
        const top = px(style.borderTopWidth) + px(style.paddingTop);
        return {
            left,
            top,
            x: left + px(style.borderRightWidth) + px(style.paddingRight),
            y: top + px(style.borderBottomWidth) + px(style.paddingBottom),
        };
    };

    const projection = ()=>{
        const rect = canvas.getBoundingClientRect();
        if (rect.width !== boxWidth || rect.height !== boxHeight)
        {
            boxWidth = rect.width;
            boxHeight = rect.height;
            inset = insetsOf();
        }
        const width = rect.width - inset.x;
        const height = rect.height - inset.y;
        const picture = pixels();
        return {
            left: rect.left + inset.left,
            top: rect.top + inset.top,
            x: width > 0 ? picture.width / width : 1,
            y: height > 0 ? picture.height / height : 1,
        };
    };

    // The paste gesture. The browser's paste event carries the text, but it
    // fires after the keydown that caused it -- and a program reads the
    // clipboard from that keydown. So the V of a Control- or Command-V is
    // held back until the paste event has put the text where the program
    // will look, then delivered as Control-V, which is the chord a program
    // of this era pastes on whatever the page's own was. A keydown that no
    // paste follows (nothing to paste, the shortcut taken by the browser)
    // is let go on its own shortly after.
    /** @type {KeyboardEvent | null} */
    let heldPaste = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let heldTimer = null;
    const HOLD_PASTE_MS = 250;

    const releaseHeldPaste = ()=>{
        const held = heldPaste;
        heldPaste = null;
        if (heldTimer !== null)
        {
            clearTimeout(heldTimer);
            heldTimer = null;
        }
        if (!held)
        {
            return;
        }
        const chord = !held.ctrlKey;
        if (chord)
        {
            send({ kind: 'key', code: 'ControlLeft', down: true });
        }
        send({ kind: 'key', code: 'KeyV', down: true });
        if (chord)
        {
            send({ kind: 'key', code: 'KeyV', down: false });
            send({ kind: 'key', code: 'ControlLeft', down: false });
        }
    };

    /** @param {ClipboardEvent} e */
    const onPaste = e=>{
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (text !== '')
        {
            send({ kind: 'paste', text });
        }
        releaseHeldPaste();
    };

    /** @param {KeyboardEvent} e */
    const onKeyDown = e=>{
        if (isReleaseKey(e))
        {
            releaseHeld = true;
        }
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV' && !e.repeat)
        {
            releaseHeldPaste();
            heldPaste = e;
            heldTimer = setTimeout(releaseHeldPaste, HOLD_PASTE_MS);
            return;
        }
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
        if (isReleaseKey(e))
        {
            releaseHeld = false;
        }
        if (e.code === 'KeyV' && heldPaste)
        {
            releaseHeldPaste();
        }
        if (keyFor(e.code) && !RESERVED.has(e.code) && !e.ctrlKey && !e.metaKey)
        {
            e.preventDefault();
        }
        send({ kind: 'key', code: e.code, down: false });
    };

    /** @param {PointerEvent} e */
    const onPointerMove = e=>{
        // A second button pressed while one is down, or one let go while
        // another stays, comes as a move with other buttons, not as a press.
        syncButtons(e);
        // A move with RELEASE_KEY held is the person's, not the program's: the
        // way out of a title that grabs the pointer and looks nowhere else,
        // to reach the page around it. The position is forgotten so that the
        // next free move starts from where it is rather than jumping the
        // distance travelled while held.
        if (releaseHeld)
        {
            lastX = null;
            lastY = null;
            return;
        }
        // Deliberately not gated on focus. Focus decides where a keystroke goes
        // and nothing else: a pointer that moved over this canvas moved over
        // this canvas whether or not somebody clicked a panel beside it a
        // moment ago, and a program whose cursor stops dead until the viewport
        // is clicked again is being told about the page rather than the mouse.
        //
        // Read rather than listened for: knowing whether the pointer is locked
        // is a property of the document, but subscribing to it would put a
        // listener outside the canvas, which is the one thing this file does
        // not do.
        const locked = typeof document !== 'undefined' && document.pointerLockElement === canvas;
        const { left, top, x: scaleX, y: scaleY } = projection();
        const atX = (e.clientX - left) * scaleX;
        const atY = (e.clientY - top) * scaleY;

        // Relative motion is taken from the positions rather than from
        // `movementX`, which is not measured in the same units: a browser
        // reports the position in CSS pixels and the movement in the screen's
        // own, so on a display running at anything but 100% they differ by the
        // device pixel ratio. A program that draws its own cursor by adding up
        // deltas -- which is what DirectInput gives it -- then drifts further
        // from the pointer the further it is moved, while every absolute
        // position stays exactly right. Subtracting two positions cannot
        // disagree with those positions about what a pixel is.
        //
        // A locked pointer has no position to subtract, so it is the one case
        // left with `movementX`. It is also the one case where a program
        // expects to scale the numbers itself.
        const dx = (locked || lastX === null ? (e.movementX ?? 0) * scaleX : atX - lastX)
            + restX;
        const dy = (locked || lastY === null ? (e.movementY ?? 0) * scaleY : atY - lastY)
            + restY;
        lastX = locked ? null : atX;
        lastY = locked ? null : atY;

        // What a rounded delta leaves over is carried rather than dropped: a
        // canvas shown larger than its backing store would otherwise lose slow
        // movement entirely, every delta rounding to zero.
        const wholeX = Math.trunc(dx);
        const wholeY = Math.trunc(dy);
        restX = dx - wholeX;
        restY = dy - wholeY;

        send({
            kind: 'pointerMove',
            // A locked pointer's client coordinates stop moving, so reporting
            // them would pin the cursor wherever the lock began. The router
            // advances its own from the deltas instead.
            x: locked ? undefined : Math.round(atX),
            y: locked ? undefined : Math.round(atY),
            dx: wholeX,
            dy: wholeY,
        });
    };

    /**
     * Where a press or a release happened, when that is not where the pointer
     * was last seen.
     *
     * A press carries its own position on Windows and a program hit-tests its
     * controls against it, but here the position only ever travelled with a
     * move -- so a press arriving without one was delivered wherever the
     * pointer had been before. A mouse always moves first; a touch, a pen and a
     * synthesised click do not.
     *
     * Only when it differs, and never while the pointer is locked: a press at
     * the position already reported is not news, and a locked pointer has no
     * absolute position to report at all.
     *
     * @param {PointerEvent} e
     */
    const moveToEventPosition = e=>{
        if (typeof document !== 'undefined' && document.pointerLockElement === canvas)
        {
            return;
        }
        const { left, top, x: scaleX, y: scaleY } = projection();
        const atX = (e.clientX - left) * scaleX;
        const atY = (e.clientY - top) * scaleY;
        if (!Number.isFinite(atX) || !Number.isFinite(atY)
            || (lastX !== null && Math.round(atX) === Math.round(lastX)
                && lastY !== null && Math.round(atY) === Math.round(lastY)))
        {
            return;
        }
        onPointerMove(e);
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
        // Before the lock, not after: once the pointer is locked there is no
        // absolute position to report, and reporting one from inside the lock
        // would throw away the position this press actually happened at.
        moveToEventPosition(e);
        if (pointerLock)
        {
            lockPointer();
        }
        syncButtons(e, e.button, true);
    };

    /**
     * Tells the program of every button whose state changed since it was last
     * told: a browser fires pointerdown and pointerup for the first press and
     * the last release only, and the presses in between as moves.
     *
     * @param {PointerEvent} e
     * @param {number} [button]  the button a down or up names, held to that state
     *     whatever `buttons` says
     * @param {boolean} [down]
     */
    const syncButtons = (e, button = -1, down = false)=>{
        let now = typeof e.buttons === 'number' ? e.buttons : heldButtons;
        const named = BUTTON_BITS.find(([, name])=>name === BUTTON_NAMES[button]);
        if (named)
        {
            now = down ? now | named[0] : now & ~named[0];
        }
        const changed = now ^ heldButtons;
        heldButtons = now;
        for (const [bit, name] of BUTTON_BITS)
        {
            if ((changed & bit) !== 0)
            {
                send({ kind: 'pointerButton', button: name, down: (now & bit) !== 0 });
            }
        }
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
        moveToEventPosition(e);
        syncButtons(e, e.button, false);
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
        // A wheel after a pause is a notch even when its delta is small: a
        // Mac reports a mouse wheel's notch as a few pixels, not a hundred.
        const alone = e.timeStamp - lastWheel > WHEEL_GAP_MS;
        lastWheel = e.timeStamp;
        const total = alone && Math.abs(restNotches + notches) < 1 && notches !== 0
            ? Math.sign(notches) : restNotches + notches;
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
        // Leaving releases everything held, buttons and the page's pointer key.
        heldButtons = 0;
        releaseHeld = false;
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
    listen('paste', onPaste, false);
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
            heldPaste = null;
            if (heldTimer !== null)
            {
                clearTimeout(heldTimer);
                heldTimer = null;
            }
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
