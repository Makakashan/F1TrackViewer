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
  appTagline: "3D Circuit Viewer · MVP 3.5",
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
  terrain: "Terrain",
  layers: "Layers",
  autoRotate: "Auto-rotate",
  elevations: "Real elevation",
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
  mvpBadge: "MVP 3.5 · Real per-point track width",
  mvpDesc:
    "Track built from GeoJSON LineString via CatmullRomCurve3 + ribbon mesh. 20 circuits carry real per-point width from TUMFTM, curvature-aligned to the layout. Sector splits use FastF1 telemetry; Monaco includes an OpenStreetMap terrain diorama.",
  // Sector view
  viewMode: "View",
  viewModeNormal: "Normal",
  viewModeSectors: "Sectors",
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
  appTagline: "3D просмотрщик трасс · MVP 3.5",
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
  terrain: "Ландшафт",
  layers: "Слои",
  autoRotate: "Авто-вращение",
  elevations: "Реальный рельеф",
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
  mvpBadge: "MVP 3.5 · Реальная ширина трассы по точкам",
  mvpDesc:
    "Трасса построена из GeoJSON LineString через CatmullRomCurve3 + ribbon mesh. У 20 трасс — реальная ширина по точкам из TUMFTM, выровненная по кривизне разметки. Сектора используют телеметрию FastF1; для Monaco добавлена OpenStreetMap-диорама с рельефом.",
  // Sector view
  viewMode: "Вид",
  viewModeNormal: "Обычный",
  viewModeSectors: "Сектора",
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
