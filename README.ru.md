# Bottlify

[English](README.md)

Bottlify состоит из четырёх JavaScript-пакетов. Веб-страница, которая их встраивает, запускает
программы и игры для Windows x86 прямо во вкладке браузера, без Windows, плагинов и установки.
Программе нужны core и cork, networking и installer подключаются по желанию:

- **[core](modules/core/README.md)** (`@bottlify/core`): окружение Windows, написанное с нуля на
  JavaScript. `kernel32`, `user32`, `gdi32`, DirectX, OpenGL, DirectSound, Winsock и остальные
  системные библиотеки работают поверх WebGPU, WebAudio и OPFS. Страница запускает всё одним
  вызовом `createApp()`. Движок работает в Web Worker, у графики, трансляции и звука свои потоки.
- **[cork](modules/cork/README.ru.md)** (`@bottlify/cork`): наш транслятор x86 → WebAssembly и его
  рантайм. Он переводит машинный код программы в wasm, а браузер компилирует его под процессор
  устройства, поэтому одна и та же сборка работает и на x86, и на ARM.
- **[networking](modules/networking/README.md)** (`@bottlify/networking`, по желанию): TCP и UDP
  для вкладки через один WebSocket, сервер-ретранслятор и его клиент. Без него программе доступен
  только loopback внутри вкладки.
- **[installer](modules/installer/README.md)** (`@bottlify/installer`, по желанию): собирает
  бутылку из установщика игры, который без изменений запускается внутри движка.

## Что поддерживается

- **Программы:** 32-битные PE-образы. Загрузчик отображает их в память и даёт каждой системной
  библиотеке настоящий модуль в памяти программы, поэтому `GetProcAddress` возвращает тот же адрес,
  к которому привязан импорт. Потоками управляет планировщик, квант которого считается в
  выполненных инструкциях программы.
- **Графика:** DirectDraw, Direct3D 7, 8, 9 и 10 (с DXGI), OpenGL 1.1 с расширениями и Vulkan. Всё
  идёт через один бэкенд на WebGPU в отдельном графическом воркере.
- **Звук и видео:** DirectSound, DirectMusic и waveOut сводит микшер, а играет `AudioWorklet`.
  Видео идёт через DirectShow поверх FFmpeg, собранного в WebAssembly.
- **Файлы и сеть:** файлы программы читаются из бандла по диапазонам байтов, а то, что она пишет,
  сохраняется как сессия. Сокеты идут через ретранслятор на WebSocket (`@bottlify/networking`).

Каждый слой (`cpu`, `memory`, `kernel`, `bridge`, `loader`, `log`, `filesystem`, `win32`,
`graphics`, `audio`, `input`, `media`) это модуль с объявленным интерфейсом. Без любого из них
система работает: хуже, но не ломается.

## Документация

- [`docs/architecture.ru.md`](docs/architecture.ru.md): как Bottlify устроен внутри: потоки,
  запуск, cork, системные библиотеки, графика, звук, сеть и хранилища.
- [`docs/core/`](docs/core/README.md): `@bottlify/core` для тех, кто его встраивает:
  [API](docs/core/api.md), [настройки](docs/core/configuration.md) и текущие
  [ограничения](docs/core/limits.md) (на английском).
- [`roadmap/`](roadmap/README.md): планы: [x86-64](roadmap/x64.ru.md),
  [Direct3D 11 и 12](roadmap/direct3d.ru.md), [OpenGL 2.0–4.x](roadmap/opengl.ru.md) и
  [`decisions.md`](roadmap/decisions.md).

## Сборка и тесты

```sh
npm ci
npm run fetch:video-decoder && npm run fetch:corpus   # the pinned decoder and cork's x86 corpus
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run test:integration && npm run build
npm run cdp:probe   # boots the engine in a real headless Chrome
```

## Структура

- `modules/<пакет>/`: четыре пакета, перечисленные выше. В `modules/core/` контракт модуля лежит в
  `src/system/`, каждый слой в своей папке `src/layers/<name>/`, а в `src/host/` код `createApp`
  для страницы и воркера.
- `tools/`: инструменты разработки: стенд с настоящим браузером (`cdp_test/`), аудит импортов,
  бенчмарки.
- `docs/` и `roadmap/` описаны выше.

Лаунчер и интерфейс бутылок живут в отдельном репозитории,
[`bottlify-ui`](https://github.com/bottlify/bottlify-ui).

Bottlify распространяется по лицензии MPL-2.0. Чужие компоненты и код перечислены в
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
