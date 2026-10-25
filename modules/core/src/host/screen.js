/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page's screen while a program plays on it: taking the whole of it, and
 * keeping it lit.
 *
 * Fullscreen is three APIs in the browsers a person plays on: the standard
 * one, Safari's `webkit` names (what an iPad and an older Mac have), and none
 * at all for an element on an iPhone, whose Safari puts only a video into
 * fullscreen. A page that calls the standard one alone gets nothing on the
 * second and the third, and a button that does nothing; so the request here
 * tries both names and says plainly when there is no way, which on an iPhone
 * leaves the web app a person adds to the home screen, the one way there to
 * play without the browser around it.
 *
 * A screen nobody touches goes dark and locks after a minute or two, and a
 * game watched rather than played -- an intro, a cutscene, a demo -- is
 * nobody touching it. So a running program holds a screen wake lock, as a
 * video player does. The browser lets the lock go whenever the page is
 * hidden, and does not take it back on its own: it is asked for again each
 * time the page is shown, and at the person's next gesture where a browser
 * refused it without one.
 */

/** Events that count as a person's gesture, for asking again after a refusal. */
const GESTURES = Object.freeze(['pointerup', 'touchend', 'click', 'keydown']);

/**
 * @typedef {Object} ScreenScope  What these take from the page, so a test can
 *     hand them stand-ins.
 * @property {any} document
 * @property {any} [navigator]
 */

/** @param {any} element */
const requestOf = element=>element?.requestFullscreen ?? element?.webkitRequestFullscreen
    ?? null;

/**
 * Whether this browser can put an element into fullscreen at all: false on an
 * iPhone's Safari, where only a video can be.
 *
 * @param {any} element
 */
export const canFullscreen = element=>typeof requestOf(element) === 'function';

/**
 * The element in fullscreen, by either name, or null.
 *
 * @param {ScreenScope} [scope]
 */
export function fullscreenElement(scope = /** @type {any} */ (globalThis)){
    const page = scope.document;
    return page?.fullscreenElement ?? page?.webkitFullscreenElement ?? null;
}

/**
 * Puts an element into fullscreen; call it inside a click or a key's handler.
 * Settles with whether it went: `{ entered: false, reason }` where the browser
 * has no fullscreen for an element (`unsupported`) or refused this request
 * (`refused`, with its message).
 *
 * @param {any} element
 * @returns {Promise<{ entered: boolean, reason?: string, message?: string }>}
 */
export function requestFullscreen(element){
    const request = requestOf(element);
    if (typeof request !== 'function')
    {
        return Promise.resolve({ entered: false, reason: 'unsupported' });
    }
    try
    {
        // Safari's webkit name answers nothing; the standard one a promise.
        return Promise.resolve(request.call(element, { navigationUI: 'hide' }))
            .then(()=>({ entered: true }),
                (/** @type {any} */ error)=>({ entered: false, reason: 'refused',
                    message: String(error?.message ?? error) }));
    }
    catch (e){
        return Promise.resolve({ entered: false, reason: 'refused',
            message: String(/** @type {any} */ (e)?.message ?? e) });
    }
}

/**
 * Leaves fullscreen, by either name; nothing when nothing is in it.
 *
 * @param {ScreenScope} [scope]
 */
export function exitFullscreen(scope = /** @type {any} */ (globalThis)){
    const page = scope.document;
    if (!fullscreenElement(scope))
    {
        return;
    }
    const exit = page.exitFullscreen ?? page.webkitExitFullscreen;
    try
    {
        Promise.resolve(exit?.call(page)).catch(()=>{});
    }
    catch {
        // Already leaving.
    }
}

/**
 * Calls `handler` with the element in fullscreen, or null, whenever that
 * changes, whichever name the browser fires; answers the function that stops.
 *
 * @param {(element: any) => void} handler
 * @param {ScreenScope} [scope]
 * @returns {() => void}
 */
export function watchFullscreen(handler, scope = /** @type {any} */ (globalThis)){
    const page = scope.document;
    const changed = ()=>handler(fullscreenElement(scope));
    page?.addEventListener?.('fullscreenchange', changed);
    page?.addEventListener?.('webkitfullscreenchange', changed);
    return ()=>{
        page?.removeEventListener?.('fullscreenchange', changed);
        page?.removeEventListener?.('webkitfullscreenchange', changed);
    };
}

/**
 * @typedef {Object} AwakeScreen
 * @property {() => boolean} held  Whether the screen is held lit right now.
 * @property {() => void} pause  Lets it go while the run is paused.
 * @property {() => void} resume  Holds it again.
 * @property {() => void} release  Lets it go for good.
 * @property {() => string | null} refusal  Why the browser would not hold it,
 *     the last time it was asked; `unsupported` with no wake lock at all.
 */

/**
 * Keeps the screen from dimming and locking while a program runs.
 *
 * @param {ScreenScope} [scope]
 * @returns {AwakeScreen}
 */
export function keepScreenAwake(scope = /** @type {any} */ (globalThis)){
    const page = scope.document;
    const wakeLock = scope.navigator?.wakeLock;
    let wanted = true;
    let ended = false;
    /** @type {any} */
    let sentinel = null;
    /** @type {Promise<void> | null} */
    let asking = null;
    /** @type {string | null} */
    let refusal = wakeLock ? null : 'unsupported';

    const ask = ()=>{
        if (!wakeLock || !wanted || ended || asking || (sentinel && !sentinel.released)
            || page?.visibilityState === 'hidden')
        {
            return;
        }
        asking = Promise.resolve().then(()=>wakeLock.request('screen')).then(
            (/** @type {any} */ granted)=>{
                asking = null;
                if (!wanted || ended)
                {
                    Promise.resolve(granted.release()).catch(()=>{});
                    return;
                }
                sentinel = granted;
                refusal = null;
            },
            (/** @type {any} */ error)=>{
                asking = null;
                refusal = String(error?.message ?? error);
            });
    };
    const letGo = ()=>{
        const held = sentinel;
        sentinel = null;
        if (held && !held.released)
        {
            Promise.resolve(held.release()).catch(()=>{});
        }
    };
    const shown = ()=>{
        if (page?.visibilityState !== 'hidden')
        {
            ask();
        }
    };
    page?.addEventListener?.('visibilitychange', shown);
    for (const type of GESTURES)
    {
        page?.addEventListener?.(type, shown, { capture: true, passive: true });
    }
    ask();

    return {
        held: ()=>Boolean(sentinel && !sentinel.released),
        pause(){
            wanted = false;
            letGo();
        },
        resume(){
            wanted = true;
            ask();
        },
        release(){
            ended = true;
            page?.removeEventListener?.('visibilitychange', shown);
            for (const type of GESTURES)
            {
                page?.removeEventListener?.(type, shown, { capture: true });
            }
            letGo();
        },
        refusal: ()=>refusal,
    };
}
