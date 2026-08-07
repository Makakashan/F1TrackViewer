/**
 * Lightweight i18n dictionary — no library, no server. Just a flat key-value
 * map per language, with a small client-side hook to pick the active one.
 *
 * Default language is resolved from (in order):
 *   1. localStorage["f1tv:lang"]
 *   2. navigator.language (anything starting with "ru" → ru, otherwise en)
 *   3. "en" as a safe fallback
 *
 * English is the canonical source of truth — every key MUST exist in `en`.
 * Russian is a parallel set; if a key is missing it falls back to English.
 */

export type Lang = "ru" | "en";

export interface LangMeta {
  code: Lang;
  label: string; // native name for the dropdown
  flag: string;
}

export const LANGS: LangMeta[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "ru", label: "Русский", flag: "🇷🇺" },
];

export type Theme = "light" | "dark" | "system";

export const THEMES: { code: Theme; labelKey: keyof typeof en; flag: string }[] = [
  { code: "light", labelKey: "themeLight", flag: "☀️" },
  { code: "dark", labelKey: "themeDark", flag: "🌙" },
  { code: "system", labelKey: "themeSystem", flag: "🖥️" },
];

const en = {
  // App header
  appName: "F1 Track Studio",
  appTagline: "Globe Circuit Viewer · MVP 4",
  btnReload: "Reload",
  // Top bar toggles
  track: "Track",
  trackSettings: "Track settings",
  displaySettings: "Display settings",
  display: "Display",
  info: "Info",
  camera: "Camera",
  cameraTop: "Top",
  cameraIso: "Iso",
  cameraSide: "Side",
  diorama: "Diorama",
  terrain: "3D mode",
  layers: "Layers",
  quality: "Detail",
  qualityAuto: "Auto",
  qualityPerformance: "Performance",
  qualityHigh: "Quality",
  qualityHint: "Auto matches your device. Performance lowers building detail; Quality shows more.",
  autoRotate: "Auto-rotate",
  elevations: "Real elevation",
  elevationTerrainModeHint:
    "Disabled while Terrain is on; the track is draped on the terrain mesh.",
  trackWidth: "Width",
  realWidth: "Real width",
  realWidthHint: "Track color maps width along the lap",
  widthNarrow: "Narrow",
  widthWide: "Wide",
  // Settings
  settings: "Settings",
  language: "Language",
  theme: "Theme",
  themeLight: "Light",
  themeDark: "Dark",
  themeSystem: "System",
  // Circuit list sidebar
  circuits: "Circuits",
  circuitsCount: (n: number) => `${n} circuits with verified sector data`,
  searchPlaceholder: "Search: Monaco, Monza, mc-1929…",
  noResults: "Nothing found",
  // Track info sidebar
  circuit: "Circuit",
  length: "Length",
  altitudeStart: "Altitude (start)",
  opened: "Opened",
  firstGp: "First GP",
  elevationProfile: "Elevation profile",
  elevationOn: "on",
  elevationOff: "off",
  elevationLoading: "loading…",
  elevationUnavailable: "unavailable",
  elevationMin: "min",
  elevationMax: "max",
  elevationRange: "range",
  climb: "climb",
  descent: "descent",
  elevationSource: "Source: Open-Meteo Elevation API · SRTM-3 arcsec",
  geometry: "Geometry",
  geometryDesc: (n: number) => `${n} points · LineString (closed)`,
  geoSource: "Source: bacinger/f1-circuits (MIT)",
  widthTitle: "Track width",
  widthRealValue: (mean: number, min: number, max: number) =>
    `~${mean} m avg · ${min}–${max} m (real, per-point)`,
  widthRealSource: "Source: TUMFTM/racetrack-database (LGPL-3.0)",
  widthUniformValue: (w: number) => `${w} m uniform (manual)`,
  widthUnavailable: "This circuit is not available in the TUMFTM width dataset",
  mvpBadge: "MVP 4 · Globe circuit selector",
  mvpDesc:
    "Start from a textured 3D Earth, select a circuit by marker or menu, then open the detailed TrackViewer. Tracks are built from GeoJSON LineString via CatmullRomCurve3 + ribbon mesh, with sector splits, elevation, static environments, and real per-point width where available.",
  // Sector view
  viewMode: "View",
  viewModeNormal: "Normal",
  viewModeSectors: "Sectors",
  // Race mode
  raceEnter: "Race",
  raceExit: "Exit",
  raceModeTitle: "Race mode",
  raceBeta: "BETA",
  raceBetaTitle: "Race mode is brand new",
  raceBetaBody:
    "The cars now drive a lap: pace, braking and traffic come from the circuit's own geometry, not from recorded telemetry. Only one lap runs so far, and there is no wheel-to-wheel racing. Expect rough edges — placement is derived from circuit geometry, so a few layouts still look off.",
  raceBetaAck: "Got it",
  raceLap: "Lap",
  raceLaps: "Laps",
  raceStandby: "Ready to start",
  raceLightsOut: "Lights out",
  raceStart: "Start race",
  raceStartHint: "Lights out, then the full race distance.",
  racePause: "Pause",
  raceResume: "Resume",
  raceReset: "Back to the grid",
  raceSpeed: "Speed",
  raceRunning: "Racing",
  raceFinished: "Lap complete",
  raceLapTime: "Lap time",
  raceCamFollow: "Follow",
  raceCamFree: "Free cam",
  raceCamHint: "WASD move · Q/E rotate · drag to release",
  raceFastestLap: "Fastest lap",
  raceFinishNow: "To the flag",
  raceResults: "Race result",
  raceClose: "Close",
  raceGridOrder: "Grid",
  raceShuffle: "Shuffle",
  raceInterval: "Interval",
  /** The series line under the mark. The banana is set after it as the one. */
  brandSeries: "RUI Formula",
  /** Sanctioned by nobody, and saying so beats imitating a body that exists. */
  brandSanction: "Unofficial Championship",
  /** The leader's own gap column — the car everything else is measured from. */
  raceLeaderGap: "Leader",
  /** Suffix for a lapped car's gap: "+1 Lap". */
  raceLapsDown: "Lap",
  raceScene: "Scene",
  raceFollowing: "Camera",
  raceNoCars:
    "Car models are missing from this build, so the grid is empty. The circuit still renders.",
  raceBannerCta: "Try it on a random circuit of the season",
  sectorUnavailable: "Sectors unavailable for this layout",
  sectorSourceFastf1: "FastF1 telemetry-derived",
  sectorSourceManual: "Manual verified",
  sectorSourceEstimated: "Estimated",
  sectorLegend: "Sector splits",
  sectorN: (n: number) => `S${n}`,
  // Viewer overlay
  nowViewing: "Now viewing",
  loadingElevations: "Loading elevation profile (Open-Meteo)…",
  // Controls hint
  controlsLMB: "LMB — rotate",
  controlsRMB: "RMB — pan",
  controlsWheel: "Wheel — zoom",
  // Loading states
  loadingThree: "Loading Three.js…",
  loadingTrack: "Loading track…",
  selectTrack: "Select a track",
  selectTrackHint: "Pick a circuit on the left to see its metadata.",
  loadingCircuits: "Loading circuit list…",
  // Errors
  errLoadCircuits: "Failed to load circuit list",
  errLoadTrack: "Failed to load track",
  // Footer disclaimer
  disclaimerTitle: "Unofficial project",
  disclaimerBody:
    "This is an unofficial, non-commercial project. Not affiliated with, endorsed by, or sponsored by Formula 1, Formula One Licensing B.V., the FIA, or any of the data providers. F1, FORMULA ONE, and related marks are trademarks of Formula One Licensing B.V. Used here for identification purposes only.",
  dataSourcesTitle: "Data sources",
  // Specific unit suffixes
  unitKm: "km",
  unitM: "m",
  // Empty-ish extras
  trackEmpty: "—",
};

type Dict = typeof en;

const ru: Dict = {
  appName: "F1 Track Studio",
  appTagline: "Глобус выбора трасс · MVP 4",
  btnReload: "Обновить",
  track: "Трасса",
  trackSettings: "Настройки трассы",
  displaySettings: "Настройки вида",
  display: "Вид",
  info: "Инфо",
  camera: "Камера",
  cameraTop: "Сверху",
  cameraIso: "Изометрия",
  cameraSide: "Сбоку",
  diorama: "Диорама",
  terrain: "3D режим",
  layers: "Слои",
  quality: "Детализация",
  qualityAuto: "Авто",
  qualityPerformance: "Производительность",
  qualityHigh: "Качество",
  qualityHint: "Авто подстраивается под устройство. Производительность снижает детализацию зданий; Качество показывает больше.",
  autoRotate: "Авто-вращение",
  elevations: "Реальный рельеф",
  elevationTerrainModeHint:
    "Недоступно при включённом ландшафте: трасса ложится на terrain mesh.",
  trackWidth: "Ширина",
  realWidth: "Реальная ширина",
  realWidthHint: "Цвет трассы показывает ширину по кругу",
  widthNarrow: "Узко",
  widthWide: "Широко",
  settings: "Настройки",
  language: "Язык",
  theme: "Тема",
  themeLight: "Светлая",
  themeDark: "Тёмная",
  themeSystem: "Системная",
  circuits: "Трассы",
  circuitsCount: (n: number) => `${n} трасс с проверенными секторами`,
  searchPlaceholder: "Поиск: Monaco, Monza, mc-1929…",
  noResults: "Ничего не найдено",
  circuit: "Трасса",
  length: "Длина",
  altitudeStart: "Высота (старт)",
  opened: "Открыта",
  firstGp: "Первый ГП",
  elevationProfile: "Профиль высот",
  elevationOn: "вкл",
  elevationOff: "выкл",
  elevationLoading: "загрузка…",
  elevationUnavailable: "недоступно",
  elevationMin: "мин",
  elevationMax: "макс",
  elevationRange: "перепад",
  climb: "подъём",
  descent: "спуск",
  elevationSource: "Источник: Open-Meteo Elevation API · SRTM-3 arcsec",
  geometry: "Геометрия",
  geometryDesc: (n: number) => `${n} точек · LineString (замкнутая)`,
  geoSource: "Источник: bacinger/f1-circuits (MIT)",
  widthTitle: "Ширина трассы",
  widthRealValue: (mean: number, min: number, max: number) =>
    `~${mean} м в ср. · ${min}–${max} м (реальная, по точкам)`,
  widthRealSource: "Источник: TUMFTM/racetrack-database (LGPL-3.0)",
  widthUniformValue: (w: number) => `${w} м равномерно (вручную)`,
    widthUnavailable: "Этой трассы нет в датасете ширины TUMFTM",
  mvpBadge: "MVP 4 · Выбор трасс на глобусе",
  mvpDesc:
    "Стартовый экран теперь показывает текстурированную 3D Землю: трассу можно выбрать по маркеру или меню, а затем открыть подробный TrackViewer. Трассы строятся из GeoJSON LineString через CatmullRomCurve3 + ribbon mesh, с секторами, высотами, статичными окружениями и реальной шириной там, где она доступна.",
  // Sector view
  viewMode: "Вид",
  viewModeNormal: "Обычный",
  viewModeSectors: "Сектора",
  // Гоночный режим
  raceEnter: "Гонка",
  raceExit: "Выйти",
  raceModeTitle: "Гоночный режим",
  raceBeta: "БЕТА",
  raceBetaTitle: "Гоночный режим совсем новый",
  raceBetaBody:
    "Машины теперь едут круг: темп, торможение и трафик считаются из геометрии трассы, а не из записанной телеметрии. Пока проезжается только один круг, борьбы колесо в колесо нет. Возможны шероховатости: расстановка выводится из геометрии трассы, поэтому кое-где она пока выглядит криво.",
  raceBetaAck: "Понятно",
  raceLap: "Круг",
  raceLaps: "Кругов",
  raceStandby: "Готов к старту",
  raceLightsOut: "Старт",
  raceStart: "Начать гонку",
  raceStartHint: "Огни, затем полная дистанция гонки.",
  racePause: "Пауза",
  raceResume: "Продолжить",
  raceReset: "На решётку",
  raceSpeed: "Скорость",
  raceRunning: "Гонка идёт",
  raceFinished: "Круг пройден",
  raceLapTime: "Время круга",
  raceCamFollow: "Слежение",
  raceCamFree: "Свободная",
  raceCamHint: "WASD — перемещение · Q/E — поворот · перетащить, чтобы отцепить",
  raceFastestLap: "Быстрый круг",
  raceFinishNow: "К финишу",
  raceResults: "Результат гонки",
  raceClose: "Закрыть",
  raceGridOrder: "Решётка",
  raceShuffle: "Перемешать",
  raceInterval: "Интервал",
  brandSeries: "RUI Formula",
  brandSanction: "Неофициальный чемпионат",
  raceLeaderGap: "Лидер",
  raceLapsDown: "кр.",
  raceScene: "Сцена",
  raceFollowing: "Камера",
  raceNoCars:
    "В этой сборке нет моделей машин, поэтому решётка пустая. Трасса рисуется как обычно.",
  raceBannerCta: "Попробовать на случайной трассе сезона",
  sectorUnavailable: "Сектора недоступны для этой конфигурации",
  sectorSourceFastf1: "На основе телеметрии FastF1",
  sectorSourceManual: "Проверено вручную",
  sectorSourceEstimated: "Приблизительно",
  sectorLegend: "Разделение секторов",
  sectorN: (n: number) => `С${n}`,
  nowViewing: "Сейчас просматриваете",
  loadingElevations: "Загрузка профиля высот (Open-Meteo)…",
  controlsLMB: "ЛКМ — вращать",
  controlsRMB: "ПКМ — панорамировать",
  controlsWheel: "Колесо — зум",
  loadingThree: "Загрузка Three.js…",
  loadingTrack: "Загрузка трассы…",
  selectTrack: "Выберите трассу",
  selectTrackHint: "Выберите трассу слева, чтобы увидеть метаданные.",
  loadingCircuits: "Загрузка списка трасс…",
  errLoadCircuits: "Не удалось загрузить список трасс",
  errLoadTrack: "Не удалось загрузить трассу",
  disclaimerTitle: "Неофициальный проект",
  disclaimerBody:
    "Это неофициальный некоммерческий проект. Не связан с Formula 1, Formula One Licensing B.V., FIA или поставщиками данных, не одобрен ими и не спонсируется ими. F1, FORMULA ONE и связанные знаки являются товарными знаками Formula One Licensing B.V. Используются здесь только для идентификации.",
  dataSourcesTitle: "Источники данных",
  unitKm: "км",
  unitM: "м",
  trackEmpty: "—",
};

export const DICTS: Record<Lang, Dict> = { en, ru };

export function resolveInitialLang(): Lang {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem("f1tv:lang") as Lang | null;
    if (stored === "ru" || stored === "en") return stored;
  } catch {
    // ignore
  }
  const nav = (navigator.language || "en").toLowerCase();
  return nav.startsWith("ru") ? "ru" : "en";
}
