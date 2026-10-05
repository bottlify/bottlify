# A window manager for the run

Русская версия: [windows.ru.md](windows.ru.md).

**Status:** plan, no code. 2026-10-05, against `cork2` 1ad2506c. Part of v2 stage 2; it comes
before the translation pools. File references are to `modules/core/src/` unless said otherwise.

## Why

user32's windows themselves are sound; what is wrong is what was built around them to get several
processes onto one screen. A window exists only inside the process that made it
(`layers/win32/user32/windows.js`); the run knows its handle, owner, class and title
(`user32/directory.js`), nothing more. Everything that involves two processes' windows is therefore
decided by a rule that ignores them:

- **The screen** is whichever process's frame came last (`webgpu/internal/presenter.js`, `show`),
  and the canvas takes that frame's size; each process paints its own full-screen desktop and its
  frames carry no source. The graphics worker keeps one `newest` slot for every client's Direct3D
  frames. A parent repaints everything when its child exits (`app.js`, `refreshWindows`).
- **Input** goes to the process started last (`app.js`, `facade.input`, `across().at(-1)`).
- **Activation** is per process; each believes no other program is active (WM_ACTIVATEAPP).
  `GetForegroundWindow`, `WindowFromPoint` and `EnumWindows` answer for one process.
- **Z-order** across processes does not exist.

And nothing but GDI can show a window: a view other than the guest's own pixels -- a page that
draws a dialog's controls itself, a window per window -- has no state to read and no way to be
told of a change.

## The design

user32 stays as it is. It tells the run about its windows; the run keeps what only the run can
know; views show the windows from what the run keeps.

### 1. What a process tells the run

user32 tells the run's manager what each of its windows is now, a state in values:

```js
// WindowState: what the run knows of a window
{ hwnd, processId, threadId, parent, owner, className, title, style, exStyle,
  rect, client,          // screen coordinates
  visible,               // it and its ancestors
  enabled, minimized, maximized, topmost, region }
```

It hears of a change wherever user32 makes one: the fields a state is read from (`x`, `y`,
`width`, `height`, `style`, `exStyle`, `parent`, `owner`, `title`, `frameless`, `regionBox`,
`menu`) are watched on each record, and an assignment to one, anywhere in user32, marks the window;
the window and the others in its top-level window are told once that call is over, only what
changed crossing. The places that change a window as a whole (`makeWindow`, `raise`, `restack`,
`showNow`, SetWindowPos's `place`) tell it at once as well. A child window's state is told too, so
that a view has the whole tree.

The order of top-level windows is the run's: a raise is told to the manager, and after a raise, a
new window, or a change of band or owner, the process takes its windows' order from the manager,
which keeps Windows' rules for it (topmost band, owned above owner) across processes. A process's
windows go from the run when the process ends.

### 2. The run's window manager (`user32/manager.js`)

On the system's thread, one per run, beside the directory. It holds:

- every window of every process, as each process publishes it;
- the z-order of top-level windows across processes: a topmost band above the rest, an owned
  window above its owner;
- the foreground window, and the window that has the mouse captured;
- a revision that moves with every change.

```js
manager.publish(state) / manager.remove(hwnd)   // what a process tells it
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
owning process and made there by its user32, as Windows sends it to the owning thread.

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

1. **The manager, and what processes tell it.** `manager.js` with its state, the run-wide z-order
   (topmost band, owned above owner), `subscribe`, a `windows` diagnostics table; user32's watched
   fields and the order taken from the run. Gate: seeded sequences of window calls, and after each
   the manager holds every window of the process as its user32 does (`list()`) and its top-level
   windows in the same order; the window-across itest sees both processes' windows in the run at
   concurrency 1 and 2, and none after they end.
2. **Activation and the questions across processes.** Foreground and capture are the manager's;
   a process losing or gaining the foreground is told (WM_ACTIVATE, WM_ACTIVATEAPP with the other
   program's thread); `GetForegroundWindow`, `WindowFromPoint`, `EnumWindows` and `GetWindow`
   answer for the run; a change asked for another process's window is made by its owner. Tests:
   a fixture of two processes that raise and activate each other's windows and check what they
   are told, at concurrency 1, 2 and 4.
3. **The compositor.** Frames with sources, a slot per client in the graphics worker, layers
   composed by the manager, the canvas at the screen's size. Gate: a CPU reference composer and
   the GPU composition give the same pixels on seeded random layouts of two and three processes'
   windows; an itest of two processes with overlapping windows, read back and compared.
4. **Input.** The mouse to the window under the cursor or the captured one, the keyboard to the
   foreground window's process. Tests: input reaches the right process in the two-process
   fixture.
5. **The hacks go.** `refreshWindows` on exit, the last frame winning, the canvas taking each
   frame's size, the newest process taking input, per-process activation. `docs/core/` and
   `docs/architecture.md` describe the manager and the view API.

## Done when

The steps' tests pass at concurrency 1, 2 and 4, none of the hacks listed in step 5 is left, and
in a browser a launcher and the game it starts, and an installer with its child processes, show
every process's windows at once in their order. The browser check is the
person's; it is not measured here.
