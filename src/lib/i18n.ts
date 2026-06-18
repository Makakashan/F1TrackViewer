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
  appTagline: "3D Circuit Viewer · MVP 2",
  btnReload: "Reload",
  // Top bar toggles
  autoRotate: "Auto-rotate",
  elevations: "Real elevation",
  trackWidth: "Width",
  // Settings
  settings: "Settings",
  language: "Language",
  theme: "Theme",
  themeLight: "Light",
  themeDark: "Dark",
  themeSystem: "System",
  // Circuit list sidebar
  circuits: "Circuits",
  circuitsCount: (n: number) => `${n} circuits in dataset · bacinger/f1-circuits`,
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
  mvpBadge: "MVP 2.5 · Real sector layer",
  mvpDesc:
    "Track built from GeoJSON LineString via CatmullRomCurve3 + ribbon mesh. Sector splits derived from FastF1 telemetry timing data. Elevations in real meter scale.",
  // Sector view
  viewMode: "View",
  viewModeNormal: "Normal",
  viewModeSectors: "Sectors",
  sectorUnavailable: "Sectors unavailable for this layout",
  sectorSourceFastf1: "FastF1 telemetry-derived",
  sectorSourceManual: "Manual",
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
  appTagline: "3D просмотрщик трасс · MVP 2",
  btnReload: "Обновить",
  autoRotate: "Авто-вращение",
  elevations: "Реальный рельеф",
  trackWidth: "Ширина",
  settings: "Настройки",
  language: "Язык",
  theme: "Тема",
  themeLight: "Светлая",
  themeDark: "Тёмная",
  themeSystem: "Системная",
  circuits: "Трассы",
  circuitsCount: (n: number) => `${n} трасс в датасете · bacinger/f1-circuits`,
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
  mvpBadge: "MVP 2.5 · Реальные сектора",
  mvpDesc:
    "Трасса построена из GeoJSON LineString через CatmullRomCurve3 + ribbon mesh. Разделение секторов получено из телеметрии FastF1. Высоты в реальном масштабе метров.",
  // Sector view
  viewMode: "Вид",
  viewModeNormal: "Обычный",
  viewModeSectors: "Сектора",
  sectorUnavailable: "Сектора недоступны для этой конфигурации",
  sectorSourceFastf1: "На основе телеметрии FastF1",
  sectorSourceManual: "Ручной ввод",
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
