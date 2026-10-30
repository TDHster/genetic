# genetic — учебные проекты: генетический алгоритм проектирует механизмы

Один git-репозиторий (https://github.com/TDHster/genetic, публичный), восемь независимых проектов в подпапках.
Сайт: https://genetic.tdhster.workers.dev/ — главная `index.html` с карточками проектов.

## Архитектура

Проекты друг от друга не зависят: общего кода нет, у каждого свои `js/`, `style.css`, `index.html`.
Общее — идея: один и тот же простой алгоритм (турнир из трёх, худший умирает, потомок с одной мутацией),
а различаются «модель мира» (что получается из генома) и оценка. **Главная цель везде — понятность для обучения.**

| Папка | Что эволюционирует | Запуск | Подробности |
|---|---|---|---|
| `watch/` | Часы из кучи деталей (по видео «Evolution IS a Blind Watchmaker») | `file://` или сервер | [watch/CLAUDE.md](watch/CLAUDE.md) |
| `teo-leg/` | Шагающая нога на кривошипе; эталон — нога Тео Янсена | `file://` или сервер | [teo-leg/CLAUDE.md](teo-leg/CLAUDE.md) |
| `builder/` | Самая высокая постройка из неровных камней (физика Rapier, 3D three.js) | только сервер | [builder/CLAUDE.md](builder/CLAUDE.md) |
| `coast/` | Защита набережной от столетнего шторма (мелкая вода, EurOtop, 3D three.js) | только сервер | [coast/CLAUDE.md](coast/CLAUDE.md) |
| `vawt/` | Ротор ветряка с вертикальной осью (Дарье; аэродинамика DMST, 3D three.js) | только сервер | [vawt/CLAUDE.md](vawt/CLAUDE.md) |
| `roof/` | Форма крыши, с которой капля скатывается быстрее всего (брахистохрона; эталон — циклоида) | `file://` или сервер | [roof/CLAUDE.md](roof/CLAUDE.md) |
| `roads/` | Сеть дорог между городами: компромисс стройки и поездок, дерево Штейнера (эталоны — остов, точные ответы малых карт) | `file://` или сервер | [roads/CLAUDE.md](roads/CLAUDE.md) |
| `bridge/` | Ферма моста через случайную долину: самая лёгкая, что держит грузовик (метод жёсткостей; эталон — ферма Уоррена) | `file://` или сервер | [bridge/CLAUDE.md](bridge/CLAUDE.md) |

Типовое устройство проекта: `index.html` + `style.css`, `js/` (rng, геном/модель, fitness, evolution, отрисовка, app),
`tools/headless.*` — тот же код в Node без браузера (на сайт не попадает). Библиотеки лежат в репо, без CDN:
`builder/vendor/` (three.js, Rapier с вшитым wasm), `coast/lib/` и `vawt/lib/` (three.js). Детали, эталоны для регрессии и
найденные лазейки — в `CLAUDE.md` и `README.md` проекта: **перед работой над проектом читать его CLAUDE.md.**

Корень: `index.html` (главная), `README.md` (обзор для людей), `make-site.sh` (сборка сайта),
`wrangler.jsonc` (Cloudflare Worker), `.claude/launch.json` (локальный сервер).

## Локальный сервер

`python3 -m http.server 8765` в корне `genetic/`, затем http://localhost:8765/<проект>/.
Это один общий сервер для всех проектов (им могут пользоваться параллельные сессии): не запускать второй, не останавливать
без просьбы, не `pkill -f` по шаблону. Перед запуском — `lsof -iTCP:8765 -sTCP:LISTEN`; остановить — `kill <PID>`.

## Выкладывание

Хостинг — Cloudflare Worker `genetic`, только статика. Деплой автоматический (Cloudflare Workers Builds):

1. Пуш в `main` на GitHub.
2. Cloudflare запускает `./make-site.sh` (build command) и `npx wrangler deploy` (deploy command), корень `/`.
3. Примерно через минуту изменения на сайте.

`make-site.sh` собирает чистую папку `site/` (в git не хранится): копирует всё через `tar`, кроме `.git`, `.claude`,
`CLAUDE.md`, `tools/`, `*.mp4`, `wrangler.jsonc`, `site/`, и вставляет перед `</body>` каждой страницы
beacon Cloudflare Web Analytics (токен публичный, прописан в скрипте; `./make-site.sh none` — без аналитики).
Лимит Cloudflare — 25 МБ на файл, скрипт предупреждает о превышении.

Вручную (если автодеплой сломан): `npx wrangler login` один раз, затем `./make-site.sh && npx wrangler deploy`.
Проверка без выкладки: `./make-site.sh && npx wrangler deploy --dry-run`.

Грабли:
- В сборочном образе Cloudflare нет `rsync` — поэтому `tar`. Новые внешние утилиты в `make-site.sh` не добавлять без проверки.
- Новый проект: добавить карточку в `index.html` и строку в `README.md`; файлы, которые не нужны на сайте
  (заметки, консольные утилиты вне `tools/`), — в исключения `make-site.sh`. Новый тип файлов/большие ассеты — проверить лимит.
- После деплоя проверить: `curl -s -o /dev/null -w "%{http_code}" https://genetic.tdhster.workers.dev/<проект>/`.
