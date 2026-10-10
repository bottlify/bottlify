/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Clicks and key taps driven from outside -- a test, a recorded route, a
 * tool -- as steps sent one a frame, in the shapes a program that reads its
 * input once a frame can see.
 *
 * A program that keeps a cursor of its own and moves it by relative motion
 * (DirectInput's mouse) puts it wherever it likes, the middle of a menu it
 * has just opened as often as not, so a click's motion from where the driver
 * last left its pointer lands somewhere else. A click here pushes the pointer
 * far up and left first, where it stops in the corner, and moves it from
 * there to the point: the program's cursor and the window's pointer meet
 * there whatever the program. The push and the move go a frame apart, since a
 * program that adds a frame's motion up before it stops the cursor at an edge
 * would take the two together for a push into the corner; the press goes
 * with the move, and the release a frame later.
 *
 * A key is pressed on one step and let go after `frames` more. Whatever is
 * queued runs in order, each after the one before it has let go.
 */

/**
 * Further than any screen is wide or tall: the motion that takes a cursor a
 * program moves by relative motion into the top left corner.
 */
export const CORNER = 1 << 16;

/**
 * @typedef {import('./router.js').HostInputEvent} HostInputEvent
 */

/**
 * @param {(event: HostInputEvent) => unknown} send  where each event goes
 * @returns {{
 *     click: (x: number, y: number, options?: { button?: string }) => void,
 *     key: (code: string, frames?: number) => void,
 *     tick: () => number,
 *     pending: () => number,
 * }}
 *     `click` and `key` queue; `tick` sends the next step's events and answers
 *     how many steps are left, and is called once a frame -- on a present, or
 *     on a timer for a program that does not present; `pending` is the steps
 *     left without sending any.
 */
export function createInputRoute(send){
    /** @type {HostInputEvent[][]} */
    const steps = [];
    return {
        click(x, y, options = {}){
            const button = options.button ?? 'left';
            steps.push(
                [{ kind: 'pointerMove', x: 0, y: 0, dx: -CORNER, dy: -CORNER }],
                [{ kind: 'pointerMove', x, y, dx: x, dy: y },
                    { kind: 'pointerButton', button, down: true }],
                [{ kind: 'pointerButton', button, down: false }]);
        },
        key(code, frames = 1){
            steps.push([{ kind: 'key', code, down: true }]);
            for (let held = 1; held < frames; held++)
            {
                steps.push([]);
            }
            steps.push([{ kind: 'key', code, down: false }]);
        },
        tick(){
            for (const event of steps.shift() ?? [])
            {
                send(event);
            }
            return steps.length;
        },
        pending: ()=>steps.length,
    };
}
