# Bottlify изнутри

По коду `bottlify` d066d2b и `bottlify-ui` bea9c9b на 2 октября 2026. Пути без префикса — от
`modules/` в репозитории bottlify, с префиксом `ui/` — от корня bottlify-ui. Если код и схема
расходятся, прав код.

1. [Что это](#1-что-это)
2. [Из чего состоит](#2-из-чего-состоит)
3. [Потоки: кто кого запускает и зачем](#3-потоки-кто-кого-запускает-и-зачем)
4. [Запуск: от createApp до первой инструкции](#4-запуск-от-createapp-до-первой-инструкции)
5. [cork — ядро исполнения](#5-cork--ядро-исполнения)
6. [Win32 на JavaScript: как получается DLL](#6-win32-на-javascript-как-получается-dll)
7. [Графика](#7-графика)
8. [Звук](#8-звук)
9. [Сеть](#9-сеть)
10. [Хранилища](#10-хранилища)

## 1. Что это

Bottlify — прототип, который запускает программы для Windows x86 прямо во вкладке браузера. Он
соединяет два известных подхода:

- **Двоичная трансляция, как в Rosetta 2.** Машинный код x86 переводится в другой набор команд —
  здесь в WebAssembly. В команды настоящего процессора его компилирует уже браузер, поэтому один и
  тот же перевод работает и на x86, и на ARM.
- **Свой Windows API, как в Wine.** Windows не эмулируется: её системные библиотеки (`kernel32`,
  `user32`, `gdi32`, DirectX, Winsock…) написаны заново — на JavaScript, поверх веб-API.

Цель — запускать исходный `.exe` в Chrome, Safari и Firefox на любом устройстве, от телефона до
настольного компьютера: без установки, плагинов и сервера на пути кадра. Сервер только отдаёт
файлы и ретранслирует сеть.

Основное направление сейчас — игры. Поэтому глубже всего проработано то, чем они пользуются:
DirectX, OpenGL, звук, ввод, видеоролики и сокеты.

| Что нужно программе Windows | Что даёт Bottlify | На чём в браузере |
| --- | --- | --- |
| Процессор x86 | cork — перевод x86 в wasm | WebAssembly |
| Системные DLL | слой `win32`: функции на JS, показанные игре настоящими PE-образами | — |
| DirectDraw, Direct3D 7–10, OpenGL, Vulkan, GDI | слой `graphics` | WebGPU |
| DirectSound, waveOut, DirectMusic | слой `audio` | AudioWorklet, SharedArrayBuffer |
| DirectInput, XInput, сообщения окна | слой `input` | события клавиатуры и мыши, Gamepad API |
| Видеоролики DirectShow | слой `media`, FFmpeg в wasm | WebAssembly |
| Диск | бандл, читаемый блоками, и сессия поверх него | fetch с Range, OPFS |
| Winsock | `wsock32` и ретранслятор | WebSocket |

## 2. Из чего состоит

| Пакет | Что внутри |
| --- | --- |
| `core` (`@bottlify/core`) | Движок: слои Win32 и DirectX, загрузчик, планировщик, файлы, хост `createApp`. Эмулятор v86 — подмодуль `core/vendor/v86` |
| `cork` (`@bottlify/cork`) | Транслятор x86 → wasm и его рантайм. Ядро его не импортирует, а загружает по URL |
| `networking` | Клиент и сервер ретранслятора сокетов |
| `installer` | Добавление программы запуском её установщика, упаковка бандлов |
| bottlify-ui | Лаунчер на React и локальный сервер: приложение, движок, бандлы и ретранслятор на одном адресе |

Движок собран из слоёв. Каждый слой — модуль со своим интерфейсом, конфигурацией и тестами. Другие
слои он видит только через объявленные `requires`, и `npm run check:boundaries` проверяет это по
коду. Отключённый слой заменяется заглушкой: с `graphics: null` игра идёт без картинки.

| Слой | Отвечает за | `requires` |
| --- | --- | --- |
| `log` | журнал, счётчики, профиль фаз | — |
| `cpu` | исполнение x86: cork (по умолчанию) или эмулятор v86; ловушки системных вызовов | `log` |
| `memory` | адресное пространство игры: резервирование, страницы, защита | `cpu`, `log` |
| `kernel` | процессы, потоки, планировщик, объекты ожидания | `cpu`, `memory`, `log` |
| `loader` | PE-загрузчик и синтез системных DLL | `cpu`, `memory`, `log` |
| `bridge` | соглашения вызова, парковка потока, обратные вызовы, COM в памяти игры | `cpu`, `kernel`, `memory`, `log` |
| `filesystem` | бандл, кэш блоков, том `C:`, записи игры | `log` |
| `win32` | kernel32, user32, gdi32, advapi32, ole32, msvcrt, winmm, wsock32 и ещё три десятка DLL | `bridge`, `kernel`, `memory`, `loader`, `filesystem`, `log` |
| `graphics` | DirectDraw, Direct3D 7/8/9/10, OpenGL, Vulkan, бэкенд WebGPU | `win32`, `bridge`, `memory` |
| `audio` | DirectSound, DirectMusic, микшер, MP3 для Miles | `win32`, `bridge`, `memory` |
| `input` | DirectInput, XInput, клавиатура и мышь в очередь сообщений | `win32`, `bridge`, `memory` |
| `media` | декодер видео (FFmpeg в wasm), `ijl15.dll` | `log` |

## 3. Потоки: кто кого запускает и зачем

Вкладка — это до шести потоков. Три создаёт страница, один — поток движка, ещё один — рантайм cork
внутри потока движка. Почти вся работа идёт в потоке движка. Остальные снимают с него то, что можно
делать параллельно, или то, что браузер разрешает только в отдельном потоке.

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 56, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TB
  P["<b>Главный поток страницы</b><br/>лаунчер · createApp<br/>core/src/host/create.js"]
  E["<b>Поток движка</b><br/>core/src/host/engine.worker.js"]
  K["<b>Хранитель журнала</b><br/>core/src/host/log.worker.js"]
  A["<b>AudioWorklet</b><br/>core/src/layers/audio/output/worklet.js"]
  G["<b>Поток графики</b><br/>core/src/host/graphics.worker.js"]
  T["<b>Поток трансляции</b><br/>cork/src/runtime/translator.worker.js"]
  P -->|"new Worker"| E
  P -->|"new Worker"| K
  P -->|"audioWorklet.addModule<br/>new AudioWorkletNode"| A
  E -->|"new Worker<br/>при старте, если есть холст"| G
  E -->|"new Worker<br/>из рантайма cork"| T
```

| Поток | Кто и где создаёт | Когда | Зачем он отдельный |
| --- | --- | --- | --- |
| Главный поток страницы | браузер | всегда | Интерфейс лаунчера, вызов `createApp`, события DOM. Каждый кадр только опрашивает геймпады (`requestAnimationFrame` → `input.poll`) |
| Поток движка | страница, `core/src/host/create.js` | всегда. С `?host=thread` движок работает на потоке страницы за тем же протоколом | Гость исполняется длинными квантами. На потоке страницы его останавливали бы сборка мусора и компоновка, а клик ждал бы конца кванта. Синхронные дескрипторы OPFS есть только в воркере. Устройство WebGPU нельзя передать между потоками, поэтому воркер открывает его сам, а холст получает как `OffscreenCanvas` |
| Хранитель журнала | страница, `core/src/host/remote.js` | всегда. Без `Worker` — `MessageChannel` на странице | Движок пишет журнал, счётчики и таблицы в общую память и никому не отвечает. Хранитель вычитывает кольцо раньше, чем оно перезапишется, хранит историю и считает кадры, профиль и разбивку по модулям. Ни страница, ни движок за журнал не платят |
| Поток графики | поток движка, `core/src/host/graphics-worker.js` (вызов в `serve.js`) | при старте, если у движка есть холст и не задано `device.graphicsWorker: false`. Живёт между программами. Не открыл устройство за 10 с — Direct3D рисует в потоке движка | Проигрывает вызовы Direct3D 8 и 9 на своём устройстве WebGPU. В бенче `tools/graphics-bench --remote` поток движка тратит на кадр 0,69 мс вместо 2,95 |
| Поток трансляции | рантайм cork в потоке движка, `cork/src/runtime/translator.js` | если движок — cork. Пока поток не ответил `ready`, регионы переводятся в потоке движка | Генерирует и кодирует wasm для регионов и компилирует модуль. Поток движка не ждёт: отправил пакет, готовое публикует между кадрами |
| AudioWorklet | страница, `ui/src/engine/session.js` | если страница `crossOriginIsolated` и звук включён | Поток реального времени Web Audio. Сам читает голоса из общей памяти по своим часам, поэтому звук не рвётся, пока движок занят |

Как потоки обмениваются данными (⇄ — в обе стороны, SAB — `SharedArrayBuffer`, общая память):

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 70, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart LR
  P["Страница"] -->|"postMessage ⇄<br/>OffscreenCanvas"| E["Поток движка"]
  P -->|"postMessage ⇄"| K["Хранитель журнала"]
  E -->|"SAB: кольцо журнала"| K
  E -->|"MessageChannel ⇄"| G["Поток графики"]
  E -->|"postMessage ⇄"| T["Поток трансляции"]
  E -->|"SAB: таблица голосов"| A["AudioWorklet"]
```

- **Страница ⇄ движок.** Запросы и события ввода — `postMessage`. Вместе с каждым сообщением
  страница увеличивает слово-сигнал в общей памяти, и движок видит сообщение между двумя ходами
  планировщика, а не на следующей плановой уступке. Холст передаётся один раз
  (`transferControlToOffscreen`), дальше кадры в него пишет только движок.
- **Движок → хранитель журнала.** Только общая память: хранитель опрашивает кольцо раз в 200 мс.
  Без `SharedArrayBuffer` страница пересылает ему записи сообщениями.
- **Движок ⇄ графика.** У каждого устройства Direct3D свой `MessageChannel`. Вызовы пишутся в один
  буфер на пакет, буфер передаётся без копирования. Обратно идут кадр `ImageBitmap` и ответы на
  вызовы, которые знает только рендерер.
- **Движок ⇄ трансляция.** Туда — регионы, которых нет в хранилище; обратно — байты модуля и уже
  скомпилированный `WebAssembly.Module`.
- **Движок → AudioWorklet.** Сообщений нет: таблица голосов лежит в общей памяти. Страница
  получает её в ответе на запуск и передаёт в `AudioWorkletNode`.

## 4. Запуск: от createApp до первой инструкции

```mermaid
%%{init: {"theme": "base", "sequence": {"mirrorActors": false, "messageMargin": 24, "noteMargin": 8, "actorMargin": 40}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "actorBkg": "#FFFFFF", "actorBorder": "#2F3A40", "actorTextColor": "#1B2328", "actorLineColor": "#9AA6AC", "signalColor": "#5C6970", "signalTextColor": "#1B2328", "noteBkgColor": "#F3F5F6", "noteBorderColor": "#9AA6AC", "noteTextColor": "#1B2328", "labelBoxBkgColor": "#F3F5F6", "labelBoxBorderColor": "#9AA6AC", "labelTextColor": "#1B2328", "loopTextColor": "#1B2328"}}}%%
sequenceDiagram
  participant S as Сервер
  participant P as Страница
  participant K as Журнал
  participant E as Движок
  participant G as Графика
  participant T as Трансляция
  participant O as OPFS
  participant A as AudioWorklet
  Note over S,P: лаунчер, ui/src/engine/session.js
  P->>S: /engine/core.js, /bundles/id/entry, wasm v86 и видеодекодера
  P->>P: системный том DirectX из Cache Storage
  P->>P: AudioContext, addModule(worklet.js)
  Note over P,E: createApp, core/src/host/
  P->>E: new Worker(engine.worker.js)
  P->>K: new Worker(log.worker.js)
  P->>E: холст как OffscreenCanvas, запрос start
  E->>E: устройство WebGPU
  E->>G: new Worker(graphics.worker.js)
  G-->>E: своё устройство WebGPU открыто
  E->>S: WebSocket /relay, если нужна сеть
  Note over E,O: createApp движка, core/src/app.js
  E->>O: каталог переводов cork
  E->>E: слои в порядке requires
  E->>O: сессия: реестр и файлы с прошлого раза
  E->>S: /engine/cork/index.js
  E->>T: new Worker(translator.worker.js)
  E->>S: заголовок и оглавление бандла (Range)
  E->>O: кэш блоков, переводы из бандла
  E->>E: загрузчик: .exe, DLL, TLS, главный поток игры в планировщик
  E-->>P: ответ start: таблица голосов, память журнала
  P->>K: память журнала
  P->>A: new AudioWorkletNode(таблица голосов)
  P->>E: run
  Note over E: первая инструкция игры
  loop каждый кадр
    E->>G: пакет вызовов Direct3D 8/9
    G-->>E: кадр ImageBitmap
    E->>E: презентер: кадр в OffscreenCanvas
  end
```

Три места, где порядок важен:

- **Устройство WebGPU и поток графики открываются до слоёв.** `createApp` движка получает поток
  графики в настройках устройства (`device.worker`): слой `graphics` при сборке уже знает, где
  рисует Direct3D 8/9.
- **Сессия накладывается до первой инструкции игры.** Игра сразу видит свои сейвы и реестр.
- **Код игры начинает исполняться только на `run`,** когда страница уже подключила журнал, ввод и
  звук. `DllMain` библиотек и TLS-колбэки — тоже код игры: их вызывает синтезированная заглушка в
  начале главного потока, а не хост.

Где в коде: `ui/src/engine/session.js` (что передаёт лаунчер), `core/src/host/create.js` и
`remote.js` (страница), `serve.js` (движок), `core/src/app.js` (`createApp`, `buildApp`,
загрузчик).

## 5. cork — ядро исполнения

cork — транслятор x86-32 в WebAssembly со своим рантаймом, пакет `cork/`. Ядро его не импортирует:
слой `cpu` загружает его по URL (`/engine/cork/index.js`), а без него запуск идёт на эмуляторе v86.
cork исполняет только пользовательский режим: системных вызовов ядра Windows нет, их место занимает
ловушка в мост (раздел 6).

| Где | Что делает |
| --- | --- |
| Поток движка | Интерпретаторы, формирование регионов, поиск в хранилище, публикация и исполнение переведённого кода, ловушки в мост |
| Поток трансляции | Эмиттер и кодировщик: пакет регионов → модуль wasm → скомпилированный `WebAssembly.Module` |
| OPFS | Хранилище переводов `cork/<id>.v3/` |
| Сервер | Код cork и воркера (`/engine/cork/`). Бандл может принести готовые переводы |

**Память.** Вся память игры — одна `WebAssembly.Memory` фиксированного размера (по умолчанию 1 ГиБ
под игру и таблицы cork рядом). Адрес игры `a` — это `0x10000 + a`, поэтому чтение и запись x86 становятся обычными
`i32.load` и `i32.store` со смещением. В первых 64 КиБ лежит блок состояния (регистры, 512 байт),
после памяти игры — таблицы cork. Таблиц страниц нет: на каждую страницу 4 КиБ один байт флагов —
`INACCESSIBLE`, `HAS_CODE`, `VOLATILE`, `CLOSED`, `NO_EXECUTE`.

### Слои cork

| Слой | Файлы | Вход → выход | Что важно |
| --- | --- | --- | --- |
| Декодер | `decode/decoder.js`, `decode/table.js` | байты по адресу → `Instruction` | Таблицы опкодов написаны вручную. Запись знает операнды, длину, какие флаги инструкция читает и пишет и как может упасть. Неизвестный опкод — отказ с его названием |
| Формирователь регионов | `region.js`, `helpers.js` | адрес входа → `Region` | Блоки по прямым переходам до косвенного перехода, `ret`, `call`, ловушки, `hlt`, отказа или предела 128 блоков / 8192 байт. Короткие листовые функции (до 16 блоков / 512 байт) встраиваются. `helpers.js` узнаёт помощников компилятора (`_ftol2` MSVC) по отпечатку байтов |
| Эмиттер | `emit/` | `Region` → одна wasm-функция | Цикл диспетчеризации `br_table` со структурными циклами. `integer.js` — целочисленные, `flags.js` — ленивые флаги, `memory.js` — доступ к памяти и проверки страниц, `x87.js` — FPU, `simd.js` — MMX и SSE, `helpers.js` — общий модуль помощников |
| Кодировщик и пакеты | `wasm/encoder.js`, `wasm/features.js`, `runtime/emit-built.js`, `runtime/translator.worker.js` | пакет регионов → один модуль | Чистая функция: работает в потоке трансляции, а пока он не готов — в потоке движка. `features.js` проверяет, умеет ли браузер SIMD и хвостовые вызовы |
| Рантайм | `runtime/runtime.js`, `entries.js`, `pages.js`, `layout.js`, `cache.js` | EIP → переведённая функция | Очередь кандидатов по горячести, пакеты, публикация, хэш входов на 262 144 слота, флаги страниц, сброс переводов при записи в код, перелинковка модулей |
| Интерпретаторы | `interp.js` с `fast.js`, `interp-wasm.c` | исполняют то, что ещё не переведено | Сначала JS-интерпретатор, затем wasm-интерпретатор, собранный clang из C. MMX и редкие формы wasm-интерпретатор отдаёт JS |
| Модель инструкций | `ir.js`, `ir-x87.js`, `ir-simd.js` | — | Намеренно медленная и очевидная семантика x86. По ней работает JS-интерпретатор, с ней сверяются тесты эмиттера |
| Связка с движком | `core/src/layers/cpu/internal/cork-host.js`, `translation-store.js`, `thunks.js` | — | Память, цикл квантов, переключение уровней, хранилище переводов в OPFS, заглушки ловушек |

Отдельного промежуточного представления нет: эмиттер работает прямо с декодированными
инструкциями.

### Перевод: от горячего адреса до функции

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 46, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TB
  subgraph E1["Поток движка"]
    HOT["Интерпретатор: горячий адрес"]
    REG["Формирователь регионов и декодер"]
    Q{"Перевод есть<br/>в хранилище?"}
  end
  subgraph TW["Поток трансляции"]
    EMI["Эмиттер: регион → wasm-функция"]
    ENC["Кодировщик: пакет → модуль,<br/>компиляция"]
  end
  subgraph E2["Поток движка"]
    PUT["Запись в хранилище, OPFS"]
    PUB["Публикация: экземпляр модуля,<br/>функции в таблицу, входы в хэш"]
  end
  HOT --> REG --> Q
  Q -->|"нет"| EMI
  EMI --> ENC
  ENC -->|"байты и WebAssembly.Module"| PUT
  PUT --> PUB
  Q -->|"да"| PUB
```

- **Горячий адрес.** Интерпретаторы считают посещения целей переходов. Цель становится кандидатом
  на втором посещении, затем на каждой степени двойки. Ещё кандидат — адрес, в который переведённый
  код 64 раза вышел без перевода.
- **Пакет.** Регионы переводятся пачками по 32, при длинной очереди — до 256. Один пакет — один
  модуль wasm. Функции, которые регион вызывает напрямую, переводятся в том же пакете. Позже модули
  перелинковываются в модули по 512 регионов.
- **Хранилище.** Ключ — версия кэша, возможности браузера, раскладка памяти, id бандла, адрес входа,
  64-битный хэш FNV байтов региона и вершина стека x87. Второй запуск берёт из хранилища всё, что
  перевёл первый. Бандл может принести переводы с собой (`CORKSEED`), их засевают до первой
  инструкции.

### Исполнение: чем кончается регион

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 26, "rankSpacing": 50, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart LR
  EIP["EIP потока игры"] --> H{"Вход есть<br/>в хэше?"}
  H -->|"да"| R["Регион<br/>регистры в локалях wasm"]
  H -->|"нет"| I["Интерпретатор<br/>горячие адреса — в очередь на перевод"]
  R -->|"переход, ret, call"| X1["Цель в хэше — хвостовой вызов<br/>следующего региона, иначе интерпретатор"]
  R -->|"out dx, eax"| X2["Вызов моста прямо из региона"]
  R -->|"квант исчерпан"| X3["Планировщик: следующий поток"]
  R -->|"запись в страницу с кодом"| X4["Сброс переводов страницы"]
  R -->|"исключение"| X5["Точные EIP и регистры → SEH игры"]
```

- **Переход между регионами** — хвостовой вызов (`return_call_indirect`) через общую таблицу
  функций, без выхода в хост, если браузер умеет хвостовые вызовы wasm. `switch` через таблицу
  переходов остаётся внутри региона: цель сверяется с таблицей при исполнении.
- **Счёт инструкций.** Каждый блок на выходе списывает своё число инструкций из бюджета, бюджет
  проверяется на обратных переходах. Квант планировщика — 100 000 инструкций. Переведённому коду
  бюджет выдаётся по 10 000, чтобы поток можно было вытеснить.
- **Уровни интерпретатора.** Первые 8192 единицы работы процесса (инструкции плюс 128 за каждую
  новую цель перехода) исполняет JS-интерпретатор, дальше — wasm-интерпретатор.
- **Ленивые флаги.** Арифметика запоминает вид операции, ширину, результат и операнды. Флаг
  вычисляется там, где его читают, поэтому `cmp` + `jl` — одно знаковое сравнение wasm. Отдельный
  проход убирает флаги, которых никто не читает.
- **x87** — восемь локалей f64. Регион компилируется под вершину стека на входе (её хранит слот
  хэша) и проверяет форму стека один раз, поэтому `fld`, `fmul`, `fstp` идут прямо по локалям.
  Режим точности FPU соблюдается.
- **SSE** — регистры XMM в локалях `v128` (wasm SIMD), MMX — локали `i64` поверх регистров x87.
- **Память и самоизменяющийся код.** Вне точного режима чтение памяти не проверяется: адрес заворачивается
  в пределы памяти игры. Запись проверяет байт флагов страницы. Запись туда, где на странице лежит
  переведённый код, выходит из региона и сбрасывает все переводы страницы. Границы кода хранятся с
  точностью до 32 байт, чтобы запись в данные рядом с кодом не считалась записью в код. Страница,
  которая так потеряла переводы 8 раз, становится летучей (`VOLATILE`): её код дальше только
  интерпретируется.
- **Исключения точные:** регион выходит перед упавшей инструкцией, с её EIP и регистрами. Деление на
  ноль — #DE, неизвестная инструкция — #UD, запись в закрытую страницу — #GP, переход ниже `0x10000`
  (вызов по нулевому указателю) — #PF. `int3` доигрывает интерпретатор. Дальше исключение идёт в
  SEH игры: #GP и #PF становятся `EXCEPTION_ACCESS_VIOLATION`.

Где в коде: `cork/src/decode/`, `cork/src/region.js`, `cork/src/emit/`, `cork/src/wasm/`,
`cork/src/runtime/`, `cork/src/interp.js`, `cork/src/interp-wasm.c`; связка с движком —
`core/src/layers/cpu/internal/cork-host.js`. Подробный дизайн — `roadmap/cork-x86-translator.md`.

## 6. Win32 на JavaScript: как получается DLL

Каждая системная библиотека — набор таблиц на JS: имя функции → обработчик, сколько байт
аргументов снять со стека и соглашение вызова (по умолчанию stdcall). Например,
`AddAtomA: { argBytes: 4, handler: ([p]) => add(p) }` в `core/src/layers/win32/kernel32/atoms.js`.
При старте процесса загрузчик собирает по этим таблицам настоящие PE32-образы `kernel32.dll`,
`d3d9.dll` и остальных и кладёт их в память игры. Игра видит обычную DLL: заголовки, таблицу
экспорта, байты кода. Поэтому адрес из `GetProcAddress` совпадает с тем, к которому привязан импорт.

| Где | Что лежит |
| --- | --- |
| Поток движка | Таблицы функций, синтез образов, мост и обработчики |
| Память игры | Образы DLL; таблица заглушек с адреса `0x100000` (16 384 слота по 16 байт); COM-объекты и таблицы их методов |

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 46, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TB
  subgraph E1["Поток движка · при старте процесса"]
    TBL["Таблицы функций на JS<br/>win32/dll/*.js: имя → argBytes, handler"]
    SYN["Синтез образа<br/>loader/internal/synth.js"]
  end
  subgraph IMG["kernel32.dll в памяти игры — настоящий PE32"]
    H1["Заголовки MZ и PE"]
    H2["Таблица экспорта: имена, ординалы, адреса"]
    H3["Слот 16 байт на функцию: JMP на заглушку, int3"]
    H4[".data: _iob, __pioinfo, _environ"]
    H5["Функции машинным кодом x86"]
  end
  subgraph STB["Таблица заглушек, 0x100000"]
    TH["mov dx, 0xB077 · mov eax, id<br/>out dx, eax · ret N"]
  end
  BR["Мост → обработчик на JS"]
  IAT["IAT игры, GetProcAddress"]
  TBL --> SYN --> H1
  H1 ~~~ H2 ~~~ H3 ~~~ H4 ~~~ H5
  IAT -->|"адреса из экспорта"| H2
  H3 --> TH --> BR
```

Заглушка — 16 байт, одна на функцию:

```
66 BA 77 B0      mov dx, 0xB077     ; порт ловушек
B8 xx xx xx xx   mov eax, id        ; номер функции в мосте
EF               out dx, eax        ; cork вызывает мост
C2 nn nn         ret N              ; C3 для cdecl
CC ...           int3 до 16 байт
```

`N` считает мост по соглашению: stdcall снимает все `argBytes`, cdecl — ничего, thiscall и
fastcall не считают аргументы в регистрах.

### Один вызов, от игры до JS и обратно

```mermaid
%%{init: {"theme": "base", "sequence": {"mirrorActors": false, "messageMargin": 24, "noteMargin": 8}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "actorBkg": "#FFFFFF", "actorBorder": "#2F3A40", "actorTextColor": "#1B2328", "actorLineColor": "#9AA6AC", "signalColor": "#5C6970", "signalTextColor": "#1B2328", "noteBkgColor": "#F3F5F6", "noteBorderColor": "#9AA6AC", "noteTextColor": "#1B2328", "labelBoxBkgColor": "#F3F5F6", "labelBoxBorderColor": "#9AA6AC", "labelTextColor": "#1B2328", "loopTextColor": "#1B2328"}}}%%
sequenceDiagram
  participant X as Код игры
  participant K as kernel32 в памяти
  participant Z as Заглушка
  participant C as cork
  participant B as Мост
  participant H as Обработчик JS
  X->>K: call [IAT] — ReadFile, 5 аргументов
  K->>Z: JMP rel32
  Z->>C: out dx, eax
  C->>B: вызов моста из региона, регистры в блоке состояния
  B->>H: ECX и EDX по соглашению, аргументы со стека
  alt ответ готов сразу
    H-->>B: результат
    B-->>Z: EAX = результат
    Z-->>X: ret 20
  else ждём блок файла, событие, ответ видеокарты
    H-->>B: Promise
    Note over B: поток игры паркуется в планировщике,<br/>остальные потоки идут дальше
    B-->>X: по готовности поток продолжает с адреса возврата, EAX = результат
  end
```

- **COM-объекты** — Direct3D, DirectSound, DirectInput — тоже лежат в памяти игры. Первое слово
  объекта указывает на таблицу методов, каждый слот — такая же заглушка. Метод — stdcall, указатель
  на интерфейс — первый аргумент на стеке.
- **Обратные вызовы** — оконная процедура, колбэк COM, `DllMain`: мост останавливает поток, строит
  кадр на стеке игры и запускает её код до возврата в служебную ловушку.
- **Код прямо в памяти игры.** Часть экспортов — сразу машинный код x86: функции msvcrt и
  kernel32, выдача мелких блоков кучи (до 1 КиБ). Они работают без ловушки, на скорости cork, а в
  мост уходит только то, что они не решают сами.
- **Вызов, которого нет.** У каждого имени своя заглушка. Если известно, сколько байт аргументов
  снять (декорация `@N`, имя C++, cdecl-библиотека, библиотека самой программы), она возвращает 0.
  Иначе игра падает с ошибкой `unimplemented import`, где названы функция и вызывающий.

### Какая DLL достаётся игре

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 40, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TD
  A["Игре нужна DLL: импорт или LoadLibrary"] --> B{"KnownDLL или библиотека,<br/>которую заменяет движок?"}
  B -->|"да"| OUR["Наша: синтезированный образ"]
  B -->|"нет"| C{"Файл нашёлся?<br/>папка .exe → system32 →<br/>C:\WINDOWS → текущая папка"}
  C -->|"да"| REAL["Настоящая DLL: релоки, зависимости,<br/>импорты, DllMain. Код исполняет cork"]
  C -->|"нет"| D{"У движка есть<br/>таблица этой DLL?"}
  D -->|"да"| OUR
  D -->|"нет"| X["Не загружается:<br/>LoadLibrary возвращает 0"]
```

- **Всегда наши** — KnownDLLs (`kernel32`, `user32`, `msvcrt`, `ole32`…) и библиотеки, которые
  заменяет слой движка: `Mp3dec.asi` (звук) и `ijl15.dll` (media).
- **Порядок поиска** у `LoadLibrary`: папка `.exe`, `C:\WINDOWS\system32\`, `C:\WINDOWS\`, текущая
  папка. Статические импорты ищутся так же, но без текущей папки.
- **Настоящая DLL** разбирается и перемещается загрузчиком, её зависимости грузятся раньше неё,
  импорты (и отложенные) привязываются, `DllMain` вызывается через мост как код игры. TLS
  поддерживается у главного образа и статически загруженных библиотек.
- **Системный том** — DirectX runtime (`d3dx9_*` и другие распространяемые библиотеки Microsoft).
  Лаунчер монтирует его только для чтения в `C:\WINDOWS\system32\`. Если тома нет, на `d3dx9_*`
  отвечает таблица движка.

Где в коде: `core/src/layers/loader/internal/synth.js` (образ), `core/src/layers/cpu/internal/thunks.js`
(заглушки), `core/src/layers/bridge/` (мост), таблицы — `core/src/layers/win32/<dll>/`, порядок
поиска — `core/src/app.js` (`libraryCandidates`, `answeredByEngine`).

## 7. Графика

| Где | Что делает |
| --- | --- |
| Страница | Один раз отдаёт `<canvas>` движку (`transferControlToOffscreen`) и вписывает элемент в окно с сохранением пропорций (`ui/src/components/PlayScreen.jsx`) |
| Поток движка | Все графические API игры. Устройство Direct3D 8/9 хранит состояние и отвечает игре, но не рисует. Direct3D 7, Direct3D 10, OpenGL и Vulkan рисуют здесь через бэкенд WebGPU. DirectDraw и GDI — программные поверхности в памяти игры, их выгружает презентер. Презентер кладёт кадр в `OffscreenCanvas` |
| Поток графики | Двойник устройства Direct3D 8/9 проигрывает вызовы на своём устройстве WebGPU и возвращает кадр как `ImageBitmap` |
| OPFS | Не используется. Кэши пайплайнов и шейдеров живут только в памяти |

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 50, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TB
  subgraph E1["Поток движка"]
    D89["Direct3D 8/9<br/>состояние и ответы, без рендерера"]
    D7["Direct3D 7, 10, OpenGL, Vulkan<br/>бэкенд WebGPU, устройство движка"]
    SW["DirectDraw, GDI<br/>поверхности в памяти игры"]
  end
  TW["<b>Поток графики</b><br/>двойник устройства:<br/>бэкенд WebGPU, своё устройство"]
  PR["<b>Поток движка</b><br/>презентер"]
  CV["canvas страницы"]
  D89 -->|"пакет вызовов"| TW
  TW -->|"ImageBitmap"| PR
  D7 --> PR
  SW -->|"выгрузка поверхности"| PR
  PR -->|"OffscreenCanvas"| CV
```

- **Вызовы.** Каждый вызов Direct3D 8/9 сразу пишется в двоичный пакет (`remote/wire.js`). Пакет
  уходит в конце хода (`queueMicrotask`) или сразу, если вызову нужен ответ. Байты ресурсов едут в
  том же пакете: для буфера — то, что игра записала через `Lock` к `Unlock`, для текстуры — к
  следующему вызову, который может её прочесть. Рендерер в потоке движка читает их в тот же момент,
  поэтому картинка одна и та же, где бы ни рисовал Direct3D.
- **Ожидание.** `Present` ждёт поток графики, только если тот отстал больше чем на два кадра.
  Ответа ждут вызовы, результат которых знает только рендерер: `GetData` (в том числе occlusion
  query), `GetRenderTargetData`, `GetFrontBuffer(Data)`, `LockRect`, `GetDC` и `CopyRects` на
  рендертаргете. Ждёт не поток движка, а поток игры: мост паркует его в планировщике, остальные
  потоки игры идут дальше.
- **Шейдеры.** Байткод шейдеров Direct3D 8/9 разбирается и переводится в WGSL
  (`graphics/d3d9/shader.js`, `wgsl.js`). Для фиксированного конвейера WGSL генерируется
  (`webgpu/internal/fixedfunction.js`).
- **Текстуры** загружаются на GPU как `bgra8unorm`, сжатые DXT по умолчанию распаковываются на CPU.
  Как BC-форматы они уходят на GPU только с `graphics.compressedTextures` и на устройстве с
  `texture-compression-bc`.
- **Отказы.** Поток графики не открылся — Direct3D рисует в потоке движка, в консоли
  предупреждение. Потеряно устройство WebGPU — `Present` и `Reset` отвечают `D3DERR_DEVICELOST`
  (у 9Ex — `D3DERR_DEVICEREMOVED`). Восстановления нет, новые кадры не приходят.

Где в коде: `core/src/layers/graphics/` (`d3d7`, `d3d8`, `d3d9`, `d3d10`, `ddraw`, `gdi`,
`opengl`, `vulkan`, `webgpu`), поток графики — `graphics/remote/` и
`core/src/host/graphics.worker.js`.

## 8. Звук

| Где | Что делает |
| --- | --- |
| Страница | До старта создаёт `AudioContext` и загружает `worklet.js`. После старта создаёт `AudioWorkletNode` над таблицей голосов из ответа движка |
| Поток движка | DirectSound, waveOut, DirectMusic и MP3 для Miles. Перед каждой уступкой браузеру дописывает в общую память то, что записала игра, переносит громкость и панораму, сигналит уведомления |
| AudioWorklet | Читает 64 слота голосов по своим часам, линейно пересэмплирует, применяет громкость и панораму, сводит |
| OPFS | Не используется |

Буфер DirectSound устроен как голос звуковой карты: копия его байтов лежит в общей памяти, и
AudioWorklet читает её сам, как DMA. Поэтому звук не рвётся, когда движок занят загрузкой или
переводом кода, — пока в буфере игры хватает звука.

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 46, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TB
  subgraph GC["Код игры, x86"]
    DS["Буфер DirectSound<br/>Lock, Unlock, Play, Stop"]
    WO["waveOutWrite"]
  end
  subgraph EW["Поток движка"]
    DB["dsound/buffers.js"]
    WM["winmm: очередь блоков"]
    DM["DirectMusic: дорожки"]
    MX["Микшер<br/>output/mixer.js"]
  end
  TB["<b>Общая память</b><br/>таблица голосов:<br/>64 слота по 128 байт<br/>и арена копий, 16 МиБ"]
  RD["<b>AudioWorklet</b><br/>чтение по своим часам,<br/>пересэмплирование, сведение<br/>output/mix.js"]
  DS --> DB
  WO --> WM
  DB -->|"Unlock: копия байтов<br/>Play, Stop: заголовок"| MX
  WM --> MX
  DM --> MX
  MX --> TB
  TB --> RD
  RD --> SPK["Колонки"]
```

- **Голос** — слот в таблице: заголовок из 32 слов (`RATE`, `CHANNELS`, `BITS`, `GAIN`, срез
  левого и правого канала, `POSITION`, `LOOPING`, `PLAYING`, `LAPS`…) и копия буфера в арене. Весь
  буфер копируется, когда движок впервые видит его играющим, дальше — только диапазоны каждого
  `Unlock`. `Play` пишет позицию, `LOOPING` и `PLAYING`, `Stop` — `PLAYING = 0`.
- **Курсор воспроизведения** — сколько прочёл AudioWorklet (`POSITION` и `LAPS`), курсор записи —
  на 30 мс впереди. Поэтому `GetCurrentPosition` и уведомления по позициям совпадают с тем, что
  реально звучит.
- **Потоковый буфер** — тот, что игра дописывает по ходу, как микшеры Miles и FMOD. Голос не играет
  дальше дописанного: при задержке звучит тишина, а не повтор старого круга. Через
  max(250 мс, один круг) голос перестаёт ждать и идёт по кругу дальше.
- **waveOut** — дорожка на устройство. `waveOutWrite` сразу копирует блок, а `WOM_DONE` приходит,
  когда AudioWorklet его прочёл.
- **MP3 для Miles.** Вместо гостевого `Mp3dec.asi` работает свой провайдер через `RIB`-вход
  `mss32.dll`, декодер — minimp3 в wasm (`audio/asi/`). Есть и MP3-кодек для ACM.
- **Ограничения.** Свободных слотов нет — буфер играет через дорожку-очередь, курсор идёт по часам.
  3D-интерфейсы DirectSound отдаются, параметры хранятся, но не слышны. Захват звука —
  `DSERR_NODRIVER`.
- **Без изоляции вкладки** (COOP/COEP, их ставит `ui/server.mjs`) нет `SharedArrayBuffer`. Тогда
  звука нет совсем: лаунчер так и пишет, движок ничего не сводит, курсоры идут по часам.

Где в коде: `core/src/layers/audio/` — `output/mixer.js`, `output/mix.js`, `output/worklet.js`,
`dsound/buffers.js`, `asi/provider.js`; waveOut — `core/src/layers/win32/winmm/functions.js`.

## 9. Сеть

| Где | Что делает |
| --- | --- |
| Страница | Передаёт в `createApp` модуль клиента (`/networking/client/index.js`), адрес ретранслятора (`ws://` или `wss://` того же хоста, `/relay`) и комнату — id бандла |
| Поток движка | `wsock32`, `ws2_32`, `mswsock`: реестр сокетов, петля `127.0.0.0/8` внутри вкладки, клиент ретранслятора. WebSocket открывается в воркере |
| Сервер лаунчера | Ретранслятор `/relay` в том же процессе и на том же порту, что и HTTP |
| OPFS | Не используется |

Вкладка не умеет открывать TCP и UDP — только WebSocket. Поэтому сокеты игры идут через
ретранслятор: он соединяет вкладки одной комнаты и, если разрешено, открывает настоящие соединения
наружу.

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 46, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TB
  subgraph EW["Поток движка, вкладка игрока"]
    GM["Игра: socket, connect,<br/>send, sendto, select"]
    WS["wsock32: реестр сокетов<br/>127.0.0.0/8 — внутри вкладки"]
    CL["Клиент ретранслятора<br/>networking/src/client"]
  end
  RL["<b>Сервер лаунчера</b><br/>ретранслятор /relay<br/>networking/src/server/relay.js"]
  TB2["Другая вкладка<br/>в той же комнате"]
  NET["Внешний хост<br/>из RELAY_ALLOW"]
  GM --> WS --> CL
  CL -->|"WebSocket<br/>JSON: вход в комнату<br/>двоичные кадры: данные"| RL
  RL -->|"адрес 10.86.x.x"| TB2
  RL -->|"TCP, UDP, DNS"| NET
```

- **Комната** — частная сеть: вкладки с одним бандлом видят друг друга, как в одной LAN. Каждая
  получает наименьший свободный адрес из `10.86.0.0/16`, в комнате до 32 участников.
  Широковещание доходит только до участников комнаты, слушающих этот UDP-порт.
- **Наружу закрыто по умолчанию.** Ретранслятор без настройки — LAN, а не открытый прокси. Хосты
  разрешает `RELAY_ALLOW` при запуске сервера: список через запятую, `*.` — суффикс. Имена
  разрешает ретранслятор и запоминает их, поэтому политика проверяет имя, а не только адрес. С
  пустым списком DNS не отвечает ничего.
- **Кадр.** Вход в комнату — JSON (`hello` → `welcome` с адресом и списком участников). Данные —
  двоичный кадр: 20 байт заголовка и до 64 КиБ данных. Один `send()` — один кадр, поэтому границы
  UDP-датаграмм сохраняются. TCP-`send()` больше 64 КиБ пока на кадры не делится и падает.

| Смещение | Тип | Поле |
| --- | --- | --- |
| 0 | u8 | op: `DIAL`, `OPENED`, `STREAM`, `HANGUP`, `DATAGRAM`, `LISTEN`, `UNLISTEN`, `ACCEPTED`, `RESOLVE`, `RESOLVED` |
| 1 | u8 | флаги: `REJECT`, `HALF`, `STREAM` |
| 2 | u16 | резерв |
| 4 | u32 | tag — номер потока TCP или запроса DNS |
| 8 | u32 | IP отправителя |
| 12 | u32 | IP получателя |
| 16 | u16 | порт отправителя |
| 18 | u16 | порт получателя |

TCP — это `DIAL` → `OPENED` (или `HANGUP` с `REJECT`), затем `STREAM`. `shutdown(SD_SEND)` —
`HANGUP` с `HALF`. Все поля little-endian.

Где в коде: `core/src/layers/win32/wsock32/` (сокеты и транспорт), `networking/src/` (клиент,
`protocol.js`, сервер), подключение — `ui/server.mjs` и `ui/src/engine/session.js`.

## 10. Хранилища

OPFS — файловая система браузера, своя у каждого origin (схема, хост, порт). Поэтому лаунчер
открывают всегда по одному адресу: на другом — другой OPFS и другие сейвы. По умолчанию это
`http://127.0.0.1:5180`. С `TLS_DIR` сервер слушает https на всех адресах: с другой машины без
защищённого контекста не будет ни OPFS, ни `SharedArrayBuffer`.

| Хранилище | Где | Что лежит | Как устроено |
| --- | --- | --- | --- |
| Кэш блоков | OPFS: `<id>.blocks`, `<id>.present`, `<id>.order` | блоки бандла, уже полученные с сервера | Блок N лежит со смещения N × размер блока (из заголовка бандла, по умолчанию 256 КиБ). `.present` — битовая карта полученных блоков, `.order` — порядок первых обращений (до 4096). Синхронные дескрипторы, пул на 16, первым закрывается тот, что дольше не нужен |
| Переводы cork | OPFS: `cork/<id>.v3/` | переведённые регионы | `records` — записи подряд, `index` — журнал, где какая лежит. Индекс читается один раз, промах не трогает диск, попадание — одно чтение по смещению. Новое дописывается пакетами; уплотнение, предел 1 ГиБ |
| Сессия | OPFS: `<id>.session` | файлы, которые записала игра, и реестр | Один поток deflate-raw. Накладывается до первой инструкции, сохраняется через 250 мс после того, как записи игры улеглись. Бандл не меняется никогда |
| Системный том | Cache Storage: `bottlify-system-volume` | DirectX runtime: `d3dx9_*` и другие распространяемые библиотеки | Страница качает его один раз и монтирует только для чтения в `C:\WINDOWS\system32\` |
| Настройки | localStorage | настройки лаунчера, время первого кадра | — |

Чтение файла игры:

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 40, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TD
  RD["ReadFile игры"] --> W{"Игра писала<br/>этот файл?"}
  W -->|"да"| OV["Слой записей поверх бандла"]
  W -->|"нет"| BIT{"Блок есть<br/>в битовой карте?"}
  BIT -->|"да"| SL["Чтение блока из OPFS<br/>синхронно, без ожидания"]
  BIT -->|"нет"| F["Range-запрос блока к серверу<br/>поток игры паркуется, другие идут"]
  F --> CRC["Проверка CRC-32"]
  CRC --> PUT["Запись в слот и в битовую карту"]
  PUT --> SL
  SL --> DEC["zstd — распаковка, перед ней<br/>кэш готовых блоков в памяти;<br/>deflate хранится распакованным"]
  DEC --> OUT["Байты игре"]
  OV --> OUT
```

- **Кэш блоков не держит бандл в памяти:** игра может весить больше гигабайта. Если размер битовой
  карты не сходится с бандлом, карта сбрасывается, и блоки скачиваются заново.
- **Синхронные дескрипторы** (`createSyncAccessHandle`) есть только в воркере. Зато чтение из OPFS
  не ждёт событий, и `ReadFile` по уже скачанному блоку отвечает сразу.
- **Сессия** читается и пишется асинхронно (`getFile`, `createWritable`).

Где в коде: `core/src/layers/filesystem/internal/bundle/cache.js` (блоки),
`core/src/layers/filesystem/internal/opfs-store.js` (дескрипторы),
`core/src/layers/cpu/internal/translation-store.js` (переводы), `core/src/storage.js` (сессии),
`ui/src/engine/session.js` (системный том).
