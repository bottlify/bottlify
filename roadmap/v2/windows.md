# A window manager for the run

Русская версия: [windows.ru.md](windows.ru.md).

**Status:** plan, no code. 2026-10-05, against `cork2` 1ad2506c; supersedes the first draft of the
same day (a run-wide mirror of each process's windows). Part of v2 stage 2; it comes before the
translation pools. File references are to `modules/core/src/` unless said otherwise.

## Why

A window exists today only as a record inside the process that made it
(`layers/win32/user32/windows.js`, `windows` Map), changed in place wherever a call needs to: about
130 places in `windows.js`, `system.js` and `frame.js` assign `x`, `y`, `width`, `height`, `style`,
`parent` or `owner` directly. There is no window state anyone else can read, no operation that
changes it as a whole, and no notice when it changes. The run knows a window's handle, owner, class
and title (`user32/directory.js`), nothing more. So:

- **The screen** is whichever process's frame came last (`webgpu/internal/presenter.js`, `show`);
  each process paints its own full-screen desktop and its frames carry no source. The graphics
  worker keeps one `newest` slot for every client's Direct3D frames. A parent repaints everything
  when its child exits (`app.js`, `refreshWindows`).
- **Input** goes to the process started last (`app.js`, `facade.input`).
- **Activation** is per process; each believes no other program is active (WM_ACTIVATEAPP).
  `GetForegroundWindow`, `WindowFromPoint` and `EnumWindows` answer for one process.
- **Z-order** is one process's Map insertion order; there is no topmost band, and `HWND_BOTTOM`
  does not move a top-level window.
- **Changes nobody hears of:** `SetWindowPlacement`, `SetWindowLong(GWL_STYLE)` flipping
  WS_VISIBLE and `windowService.place` mutate a record and repaint nothing.

And nothing but GDI can show a window: a view of the windows other than the guest's own pixels --
a page that draws a dialog's controls itself, a window per window -- has no state to read and no
way to be told.

## The design

Three parts, each with one job.

### 1. The window model (`user32/model.js`)

A pure JavaScript model of a tree of windows with Win32's semantics, no guest memory, no messages.
Every change to a window is one of its operations, and every operation answers with the changes it
made. It is what a process holds its own windows in.

```js
const model = createWindowModel({ screen: () => ({ width, height }) });

// operations: each returns the changes it made, [] for none
model.create({ hwnd, parent, owner, className, title, style, exStyle, rect, thread }) // Change[]
model.place(hwnd, { rect?, insertAfter?, flags })   // SetWindowPos: SWP_* flags, HWND_* sentinels
model.show(hwnd, command)                           // ShowWindow: SW_* commands
model.setStyle(hwnd, style, exStyle?)               // GWL_STYLE / GWL_EXSTYLE, WS_VISIBLE included
model.setText(hwnd, text)
model.setParent(hwnd, parent) / model.setOwner(hwnd, owner)
model.enable(hwnd, enabled)
model.destroy(hwnd)                                 // the window and its descendants

// questions
model.get(hwnd)            // WindowState, frozen: hwnd, parent, owner, className, title, style,
                           // exStyle, rect (parent's client coordinates), screenRect, clientRect,
                           // visible (it and its ancestors), enabled, minimized, maximized, topmost
model.children(hwnd)       // in z-order, topmost first; hwnd 0: the top-level windows
model.fromPoint(x, y)      // the deepest visible, enabled-or-not window under a point
model.uncovered(hwnd)      // its visible region on the screen, as rectangles
```

A `Change` is `{ kind: 'created' | 'placed' | 'shown' | 'hidden' | 'stacked' | 'styled' |
'retitled' | 'reparented' | 'enabled' | 'destroyed', hwnd, before, after }`. Activation, focus
and capture are not the model's: they are per thread and per run (below).

user32 stops assigning to records. Its API functions call the model's operations, and what a
program is told -- WM_WINDOWPOSCHANGING and CHANGED, WM_MOVE, WM_SIZE, WM_SHOWWINDOW,
WM_STYLECHANGING and CHANGED, WM_SETTEXT's effects, the repaint of what was uncovered -- is made
from the changes the operation returned, in one place. The record keeps what is the process's
alone: the procedure, the class, the extra bytes, the properties, the update region.

### 2. The run's window manager (`user32/manager.js`)

On the system's thread, one per run, beside the directory. It holds:

- every window of every process, as each process's model publishes its changes: a process sends
  its `Change[]` after each operation, a call that does not block;
- the z-order of top-level windows across processes: a topmost band above the rest, an owned
  window above its owner;
- the foreground window, and the window that has the mouse captured;
- a revision that moves with every change.

```js
manager.apply(processId, changes)        // what a process's model did
manager.raise(hwnd) / manager.lower(hwnd) / manager.insertAfter(hwnd, after)
manager.setForeground(hwnd)              // → notices to the processes losing and gaining it
manager.setCapture(hwnd) / manager.releaseCapture()
manager.get(hwnd) / manager.topLevel()   // top-level windows of the run in z-order
manager.fromPoint(x, y)                  // across processes
manager.foreground() / manager.capture()
manager.subscribe(listener)              // every change, in order: (event) => void
manager.command(hwnd, request)           // a view's request, carried to the window's process
```

A process asks the manager what only the run knows (foreground, the window at a point, the order of
other processes' windows) with a blocking ask, as the directory is asked now. A change to another
process's window -- SetWindowPos or ShowWindow on a handle it does not own -- is carried to the
owning process and made there by its model, as Windows sends it to the owning thread.

### 3. Views

A view is anything that shows the windows: it subscribes to the manager and never reaches into a
process. It can send requests back (`manager.command`): a window dragged, a close button pressed,
a click -- which the manager carries to the owning process as the input or the message Windows
would make of it.

- **The GDI compositor**, first: each process's frames are a layer, tagged with its source; the
  screen is composed from the layers by the manager's top-level windows, bottom to top, each
  scissored to its rectangle minus what is above it, the rest the desktop background. The canvas
  is the screen's size. The graphics worker keeps a `newest` slot per client.
- **Input routing**: the mouse to the window under the cursor or the captured one, the keyboard to
  the foreground window's process.
- **A JS view**, later: the same events give it the whole tree -- classes, titles, styles,
  rectangles, order -- to show a window or a standard control as the page's own element, the
  guest's pixels used only where the guest draws them.

## Steps

Each step lands with its tests; the full suite runs before it goes to `cork2`.

1. **The model.** `model.js` with its operations and questions, the contract taken from Windows'
   documented behaviour and Wine's user32 conformance tests (`dlls/user32/tests/win.c`:
   SetWindowPos, ShowWindow, z-order, styles). Unit tests per operation, and a validator in
   `tools/` that no file of user32 assigns a window's geometry, style, parent or owner outside
   the model.
2. **user32 onto the model.** The records' geometry, style, parent, owner, visibility and order
   become the model's; the ~130 assignments become operations; the messages are made from the
   changes. This lands in slices (placement, then show, then styles, then parent and owner), each
   behind a gate: seeded sequences of window calls run through the old path and the model path
   compare everything a program can observe -- answers, messages and their parameters in order,
   the window list, the desktop's pixels -- and the old path goes when its slice is gated.
3. **The manager.** `manager.js`, the publication from each process, the run-wide z-order with
   its bands, foreground and capture with activation notices to both processes, the questions
   across processes, and `subscribe`. Tests: the manager's own unit tests, and a fixture of two
   processes that raise and activate each other's windows and check the messages, at
   concurrency 1, 2 and 4.
4. **The compositor and input.** Frames with sources, a slot per client in the graphics worker,
   layers composed by the manager; input routed by it. Gate: a CPU reference composer and the GPU
   composition give the same pixels on seeded random layouts of two and three processes' windows.
   An itest of two processes with overlapping windows, read back and compared.
5. **What it replaces goes.** `refreshWindows` on exit, the last frame winning, the newest process
   taking input, per-process activation. `docs/core/` and `docs/architecture.md` describe the
   manager and the view API.

## Done when

The steps' tests pass at concurrency 1, 2 and 4, no window state is assigned outside the model
(the validator), and in a browser a launcher and the game it starts, and an installer with its
child processes, show every process's windows at once in their order. The browser check is the
person's; it is not measured here.
