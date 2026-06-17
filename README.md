# F1 Track Viewer

Интерактивный 3D-просмотрщик конфигураций трасс Формулы 1 на **Next.js 16 + Three.js**. Крутишь мышкой любую из 40+ официальных трасс, переключаешься между ними в один клик, видишь метаданные (длина, высота, год открытия).

Это **MVP 1** из поэтапного плана: статичный 3D-viewer поверх GeoJSON-датасета `bacinger/f1-circuits`. Дальше пойдут MVP 2 (сезоны/сессии из OpenF1), MVP 3 (реальная ширина полотна и elevation из TUMFTM/racetrack-database), MVP 4 (анимация болида по телеметрии).

---

## Скриншот

![F1 Track Viewer — Monaco](https://raw.githubusercontent.com/<OWNER>/F1TrackViewer/main/docs/preview.png)

> Замените `<OWNER>` на свой GitHub-username после fork'а. Скриншот лежит в `docs/preview.png`.

---

## Возможности (MVP 1)

- **40 трасс** из `bacinger/f1-circuits` (Monaco, Monza, Silverstone, Spa, Suzuka, Las Vegas, Jeddah, и т.д.)
- **3D-полотно трассы** — `CatmullRomCurve3` + `TubeGeometry`, строится прямо из GeoJSON `LineString`
- **Точная геопривязка** — lon/lat → метры (1 unit = 1 m), трасса центрируется по bbox
- **OrbitControls** — ЛКМ вращать, ПКМ панорамировать, колесо зум
- **Auto-rotate** — камера медленно облетает трассу (тоггл в шапке)
- **Регулируемая ширина полотна** — слайдер 3–20 м
- **Старт/финиш** — белая полоса с красным emissive на первом проходе трассы
- **Центральная линия** — красная подсветка поверх полотна
- **Поиск** по названию / локации / id (например, `mc-1929`)
- **Метаданные**: длина (км), высота (м), год открытия, год первого ГП, число точек геометрии
- **Тёмная F1-тема** с красно-оранжевыми акцентами

---

## Технологии

| Слой | Что используется |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript 5 |
| 3D | three@0.184 + @react-three/fiber@9 + @react-three/drei@10 |
| Стили | Tailwind CSS 4 + shadcn/ui (New York) |
| Источник трасс | [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT) — GeoJSON LineString |

GeoJSON подгружается **напрямую с `raw.githubusercontent.com`** — никакого бэкенда, никаких ключей, всё работает статически.

---

## Локальный запуск

### Вариант A — через `bun` (рекомендуется, быстрее)

```bash
git clone https://github.com/<OWNER>/F1TrackViewer.git
cd F1TrackViewer
bun install
bun run dev
```

### Вариант B — через `npm`

```bash
git clone https://github.com/<OWNER>/F1TrackViewer.git
cd F1TrackViewer
npm install
npm run dev
```

### Вариант C — через `pnpm`

```bash
git clone https://github.com/<OWNER>/F1TrackViewer.git
cd F1TrackViewer
pnpm install
pnpm dev
```

Открой <http://localhost:3000 в браузере. Monaco загрузится автоматически.

---

## Структура проекта

```
src/
├── app/
│   ├── layout.tsx          # root layout, dark theme by default
│   ├── page.tsx            # главная страница: 3-колоночный layout
│   └── globals.css         # Tailwind theme tokens
├── components/
│   ├── circuit-list.tsx    # левый сайдбар: список 40 трасс + поиск
│   ├── track-info.tsx      # правый сайдбар: метаданные выбранной трассы
│   ├── track-viewer.tsx    # центр: Three.js Canvas + OrbitControls + TrackMesh
│   └── ui/                 # shadcn/ui компоненты (Button, Input, Switch, …)
└── lib/
    ├── f1-circuits.ts      # типы и fetch-хелперы для bacinger/f1-circuits
    └── geo-utils.ts        # lon/lat → метры, buildTrackCurve, computeBounds
```

### Ключевые файлы

- **`src/lib/geo-utils.ts`** — `lonLatToXZ()` переводит WGS84 в локальные метры, `buildTrackCurve()` строит замкнутую `CatmullRomCurve3` (с устранением дублирующей замыкающей точки).
- **`src/components/track-viewer.tsx`** — `TrackMesh` строит `TubeGeometry` с динамическим `tubularSegments` (200–1500 в зависимости от длины трассы), красную centerline и старт/финиш. `OrbitControls` с `autoRotate`, `damping`, ограничением полярного угла.
- **`src/lib/f1-circuits.ts`** — `fetchCircuitIndex()` тянет ~5KB JSON-индекс, `fetchCircuitGeoJson(id)` — отдельный файл трассы. Оба с `revalidate: 86400`.

---

## Дорожная карта

- [x] **MVP 1** — статичный 3D-viewer на bacinger/f1-circuits + Three.js + OrbitControls
- [ ] **MVP 2** — подключить [OpenF1](https://openf1.org/) / [Jolpica](https://jolpi.ca/): выбор сезона, Гран-при, сессий; повороты с номерами; мини-карта
- [ ] **MVP 3** — перейти на [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) для реальной ширины полотна и racing line; построить ribbon-mesh вместо TubeGeometry; добавить elevation
- [ ] **MVP 4** — анимация болида по `location` endpoint OpenF1 (~3.7 Hz)

---

## Источники данных

- **[bacinger/f1-circuits](https://github.com/bacinger/f1-circuits)** — 40 трасс F1 в GeoJSON, лицензия MIT. Автор: Tomislav Bacinger. Используется как источник геометрии трасс и базовых метаданных (длина, высота, год открытия).
- **[TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database)** — LGPL-3.0, planned для MVP 3 (centerline + ширина слева/справа + racing line для 20+ трасс).
- **[OpenF1](https://openf1.org/)** — бесплатный API без auth для исторических данных с 2023 (сессии, телеметрия, positions), planned для MVP 2/4.

F1, FORMULA ONE и т.д. — товарные знаки Formula One Licensing B.V. Проект неофициальный, не связан с Formula One.

---

## Лицензия

MIT. См. [LICENSE](LICENSE).
