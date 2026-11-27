import { state } from './state.js';

/**
 * Словарь локализации интерфейса, HUD, уведомлений и экрана итогов (RU / EN)
 */
const TRANSLATIONS = Object.freeze({
  ru: Object.freeze({
    // Мета и верхняя панель
    pageTitle: "SUNSET OVERDRIVE '90 — 3D Аркадная Гонка",
    mobileMenuBtn: '⌂ МЕНЮ',
    mobilePauseBtn: '⏸ ПАУЗА',
    mobilePlayBtn: '▶ ИГРАТЬ',
    muteOn: '🔊 ЗВУК: ВКЛ',
    muteOff: '🔇 ЗВУК: ВЫКЛ',
    muteAria: 'Включить или выключить звук',
    muteTitle: 'Включить/выключить звук (M)',
    versionAria: 'Версия игры',

    // Стартовый экран
    startBadge: '★ ARCADE RETRO 3D SERIES 1990 ★',
    subtitleOneway:
      'Мчитесь навстречу неоновому закату, обгоняйте трафик и пересекайте чекпоинты до истечения таймера!',
    subtitleOncoming:
      'Выезжайте на встречную полосу для двойного множителя очков 2X, уворачивайтесь от встречных фар и успевайте к чекпоинтам!',
    subtitleCircuit:
      'Кольцевая гонка на {laps} с {rivals} соперниками, миникартой и случайной генерацией трассы. Машина не ломается!',
    labelMode: 'Режим',
    modeOneway: '➡ ПОПУТНЫЙ',
    modeOncoming: '⇄ ВСТРЕЧКА',
    modeCircuit: '🏁 КОЛЬЦЕВОЙ',
    labelDifficulty: 'Сложность',
    diffArcade: '★ ЛЕГКО',
    diffHardcore: '★★ НОРМАЛЬНО',
    btnStart: '▶ СТАРТ',
    btnSettings: '⚙ НАСТРОЙКИ',
    hintStart: 'НАЖМИТЕ ENTER ИЛИ ПРОБЕЛ',
    ctrlGas: 'Газ',
    ctrlBrake: 'Тормоз / Задний ход',
    ctrlSteer: 'Руль',
    ctrlPause: 'Пауза',
    ctrlSound: 'Звук',

    // Экран настроек
    settingsBadge: 'ПАРАМЕТРЫ ГРАФИКИ, ЗВУКА И ЯЗЫКА',
    settingsTitle: 'НАСТРОЙКИ',
    settingLanguage: 'Язык',
    settingParticles: 'Дым и частицы',
    settingLight: 'Свет и тени',
    settingSound: 'Звук',
    optOff: 'ВЫКЛ',
    optOn: 'ВКЛ',
    optHard: 'ЖЁСТКИЕ',
    optSoft: 'МЯГКИЕ',
    devSettingsToggle: 'Тестовые настройки',
    settingFps: 'Счётчик кадров',
    btnBack: '← НАЗАД',
    hintSettings: 'ESC / ENTER — НАЗАД В МЕНЮ',

    // Экран паузы
    pauseBadge: 'ЗАЕЗД ПРИОСТАНОВЛЕН',
    pauseTitle: 'ПАУЗА',
    btnResume: '▶ ПРОДОЛЖИТЬ',
    btnMainMenu: '⌂ В ГЛАВНОЕ МЕНЮ',
    hintPause: 'ESC / P / ENTER — ПРОДОЛЖИТЬ',

    // Сенсорные педали
    touchLeft: 'Влево',
    touchRight: 'Вправо',
    touchBrake: 'СТОП / R',
    touchGas: 'ГАЗ',

    // HUD и миникарта на канвасе
    hudPosition: 'ПОЗИЦИЯ',
    hudLap: 'КРУГ {cur}/{total}',
    hudDistance: 'ДИСТАНЦИЯ: {km} км',
    hudSlipstream: '⚡ СЛИПСТРИМ +5% ⚡',
    hudOverheat: 'ПЕРЕГРЕВ ДВИГАТЕЛЯ!',
    hudEngineTemp: 'ТЕМП. МОТОРА: {pct}%',
    hudFinishIn: 'ДО ФИНИША: {sec}с',
    hudRaceTime: 'ВРЕМЯ ЗАЕЗДА',
    hudBestLap: 'ЛУЧШИЙ: {time}',
    hudTrackNum: 'ТРЕК #{seed}',
    hudScore: 'СЧЁТ',
    hudOncoming2x: '★ 2X ВСТРЕЧКА ★',
    hudDurability: 'ПРОЧНОСТЬ: {cur}/{max}',
    hudTime: 'ВРЕМЯ',
    hudPenaltySec: '-{sec} СЕК',
    hudKmh: 'КМ/Ч',

    // Игровые баннеры
    bannerStartCircuit: 'ТРЕК #{seed} • {laps}',
    bannerStartHighway: 'СТАРТ! {mode}',
    bannerRaceStart: 'СТАРТ! ВПЕРЁД!',
    bannerRivalFinishedFirst: '{name} ФИНИШИРОВАЛ ПЕРВЫМ! У ВАС {sec} СЕК!',
    bannerEngineDamagedSuffix: ' • ДВИГАТЕЛЬ ПОВРЕЖДЁН!',
    bannerHitArcade: 'УДАР! -{sec} СЕК • МАКС: {kmh} КМ/Ч{engineWarn}',
    bannerHitHardcore: 'УДАР! -{sec} СЕК • МАКС: {kmh} • ПРОЧН.: {left}/{max}',
    bannerHeatWarn: 'ВНИМАНИЕ! ПЕРЕГРЕВ МОТОРА!',
    bannerOverheated: 'ПЕРЕГРЕВ! МОЩНОСТЬ СНИЖЕНА!',
    bannerEngineCooled: 'МОТОР ОСТЫЛ — ПОЛНАЯ МОЩНОСТЬ!',
    bannerCornerCut: 'СРЕЗКА ПОВОРОТА! СБРОС СКОРОСТИ!',
    bannerReturnToTrack: 'ВОЗВРАТ НА ТРАССУ!',
    bannerFinalLap: 'ФИНАЛЬНЫЙ КРУГ! ({lap}/{total})',
    bannerLapTime: 'КРУГ {lap} / {total} • {time}',
    bannerCheckpoint: 'ЧЕКПОИНТ! +{sec} СЕК',

    // Экран завершения заезда (Game Over)
    goTimeUp: 'ВРЕМЯ ВЫШЛО!',
    goCarWrecked: 'МАШИНА РАЗБИТА!',
    goHeadOnWreck: 'ЛОБОВОЙ УДАР НА {kmh} КМ/Ч!',
    goObstacleWreck: 'РАЗБИЛСЯ О ПРЕПЯТСТВИЕ НА {kmh} КМ/Ч!',
    goRaceOverPlace: 'ГОНКА ЗАВЕРШЕНА • {place}',
    goFinishPlace: 'ФИНИШ • {place}!',

    modeTagOneway: 'ПОПУТНЫЙ ПОТОК',
    modeTagOncoming: 'ВСТРЕЧНАЯ ПОЛОСА',
    modeTagCircuit: 'КОЛЬЦЕВОЙ ЗАЕЗД • ТРЕК #{seed} • {diff}',
    diffTagArcade: 'ЛЕГКО',
    diffTagHardcore: 'НОРМАЛЬНО',

    statFinalScore: 'Итоговый счёт',
    statBestRecord: 'Лучший рекорд',
    statDistance: 'Дистанция',
    statExtra: 'Чекпоинты / Макс. км/ч',
    statFinalPos: 'Итоговое место',
    statRankOf: '{rank} из {total}',
    statRaceTime: 'Время гонки',
    statBestLap: 'Лучший круг',
    statLapRecordMax: 'Рекорд круга / Макс.',
    statMaxSpeed: 'Макс. скорость',
    unitKmLower: 'км',
    unitKmhLower: 'км/ч',

    recWinAndLap: '★ ПОБЕДА И РЕКОРД ТЕМПА КРУГА! ★',
    recNewLap: '★ НОВЫЙ РЕКОРД ТЕМПА КРУГА! ★',
    recWin: '★ ПОБЕДА В ГОНКЕ! ★',
    recPodium: '★ ПОДИУМ! ПРИЗОВОЕ МЕСТО! ★',
    recNewHighScore: '★ НОВЫЙ РЕКОРД! ★',

    btnRestart: '↻ ИГРАТЬ СНОВА',
    hintGameover: 'ENTER / ПРОБЕЛ — РЕСТАРТ • ESC — МЕНЮ'
  }),

  en: Object.freeze({
    // Meta & top bar
    pageTitle: "SUNSET OVERDRIVE '90 — 3D Arcade Racer",
    mobileMenuBtn: '⌂ MENU',
    mobilePauseBtn: '⏸ PAUSE',
    mobilePlayBtn: '▶ PLAY',
    muteOn: '🔊 SOUND: ON',
    muteOff: '🔇 SOUND: OFF',
    muteAria: 'Toggle sound on or off',
    muteTitle: 'Toggle sound (M)',
    versionAria: 'Game version',

    // Start screen
    startBadge: '★ ARCADE RETRO 3D SERIES 1990 ★',
    subtitleOneway:
      'Race into the neon sunset, weave through traffic, and cross checkpoints before the timer runs out!',
    subtitleOncoming:
      'Drive in the oncoming lane for a 2X score multiplier, dodge oncoming headlights, and reach checkpoints in time!',
    subtitleCircuit:
      'Circuit race ({laps}) against {rivals} rivals with a minimap and procedural track generation. No car damage!',
    labelMode: 'Mode',
    modeOneway: '➡ ONE-WAY',
    modeOncoming: '⇄ ONCOMING',
    modeCircuit: '🏁 CIRCUIT',
    labelDifficulty: 'Difficulty',
    diffArcade: '★ EASY',
    diffHardcore: '★★ NORMAL',
    btnStart: '▶ START',
    btnSettings: '⚙ SETTINGS',
    hintStart: 'PRESS ENTER OR SPACE',
    ctrlGas: 'Gas',
    ctrlBrake: 'Brake / Reverse',
    ctrlSteer: 'Steer',
    ctrlPause: 'Pause',
    ctrlSound: 'Sound',

    // Settings screen
    settingsBadge: 'GRAPHICS, AUDIO & LANGUAGE OPTIONS',
    settingsTitle: 'SETTINGS',
    settingLanguage: 'Language',
    settingParticles: 'Smoke & Particles',
    settingLight: 'Light & Shadows',
    settingSound: 'Sound',
    optOff: 'OFF',
    optOn: 'ON',
    optHard: 'HARD',
    optSoft: 'SOFT',
    devSettingsToggle: 'Developer Options',
    settingFps: 'FPS Counter',
    btnBack: '← BACK',
    hintSettings: 'ESC / ENTER — BACK TO MENU',

    // Pause screen
    pauseBadge: 'RACE PAUSED',
    pauseTitle: 'PAUSE',
    btnResume: '▶ RESUME',
    btnMainMenu: '⌂ MAIN MENU',
    hintPause: 'ESC / P / ENTER — RESUME',

    // Touch pedals
    touchLeft: 'Steer left',
    touchRight: 'Steer right',
    touchBrake: 'STOP / R',
    touchGas: 'GAS',

    // Canvas HUD & minimap
    hudPosition: 'POSITION',
    hudLap: 'LAP {cur}/{total}',
    hudDistance: 'DISTANCE: {km} km',
    hudSlipstream: '⚡ SLIPSTREAM +5% ⚡',
    hudOverheat: 'ENGINE OVERHEAT!',
    hudEngineTemp: 'ENGINE TEMP: {pct}%',
    hudFinishIn: 'FINISH IN: {sec}s',
    hudRaceTime: 'RACE TIME',
    hudBestLap: 'BEST: {time}',
    hudTrackNum: 'TRACK #{seed}',
    hudScore: 'SCORE',
    hudOncoming2x: '★ 2X ONCOMING ★',
    hudDurability: 'DURABILITY: {cur}/{max}',
    hudTime: 'TIME',
    hudPenaltySec: '-{sec} SEC',
    hudKmh: 'KM/H',

    // Race banners
    bannerStartCircuit: 'TRACK #{seed} • {laps}',
    bannerStartHighway: 'START! {mode}',
    bannerRaceStart: 'GO! RACE!',
    bannerRivalFinishedFirst: '{name} FINISHED 1ST! {sec} SEC LEFT!',
    bannerEngineDamagedSuffix: ' • ENGINE DAMAGED!',
    bannerHitArcade: 'CRASH! -{sec} SEC • MAX: {kmh} KM/H{engineWarn}',
    bannerHitHardcore: 'CRASH! -{sec} SEC • MAX: {kmh} • DUR.: {left}/{max}',
    bannerHeatWarn: 'WARNING! ENGINE OVERHEATING!',
    bannerOverheated: 'OVERHEAT! POWER REDUCED!',
    bannerEngineCooled: 'ENGINE COOLED — FULL POWER!',
    bannerCornerCut: 'CORNER CUT! SLOWING DOWN!',
    bannerReturnToTrack: 'RETURN TO TRACK!',
    bannerFinalLap: 'FINAL LAP! ({lap}/{total})',
    bannerLapTime: 'LAP {lap} / {total} • {time}',
    bannerCheckpoint: 'CHECKPOINT! +{sec} SEC',

    // Game Over screen
    goTimeUp: 'TIME IS UP!',
    goCarWrecked: 'CAR WRECKED!',
    goHeadOnWreck: 'HEAD-ON CRASH AT {kmh} KM/H!',
    goObstacleWreck: 'CRASHED INTO OBSTACLE AT {kmh} KM/H!',
    goRaceOverPlace: 'RACE OVER • {place}',
    goFinishPlace: 'FINISH • {place}!',

    modeTagOneway: 'ONE-WAY TRAFFIC',
    modeTagOncoming: 'ONCOMING TRAFFIC',
    modeTagCircuit: 'CIRCUIT RACE • TRACK #{seed} • {diff}',
    diffTagArcade: 'EASY',
    diffTagHardcore: 'NORMAL',

    statFinalScore: 'Final Score',
    statBestRecord: 'Best Score',
    statDistance: 'Distance',
    statExtra: 'Checkpoints / Max km/h',
    statFinalPos: 'Final Position',
    statRankOf: '{rank} of {total}',
    statRaceTime: 'Race Time',
    statBestLap: 'Best Lap',
    statLapRecordMax: 'Lap Record / Max',
    statMaxSpeed: 'Max Speed',
    unitKmLower: 'km',
    unitKmhLower: 'km/h',

    recWinAndLap: '★ VICTORY & NEW LAP PACE RECORD! ★',
    recNewLap: '★ NEW LAP PACE RECORD! ★',
    recWin: '★ RACE VICTORY! ★',
    recPodium: '★ PODIUM FINISH! ★',
    recNewHighScore: '★ NEW HIGH SCORE! ★',

    btnRestart: '↻ PLAY AGAIN',
    hintGameover: 'ENTER / SPACE — RESTART • ESC — MENU'
  })
});

/**
 * Возвращает активный код языка ('ru' | 'en')
 */
export function getLang() {
  return state.settings.language === 'en' ? 'en' : 'ru';
}

/**
 * Возвращает локаль форматирования чисел для toLocaleString
 */
export function getNumberLocale() {
  return getLang() === 'en' ? 'en-US' : 'ru-RU';
}

/**
 * Получение переведённой строки по ключу с опциональной подстановкой параметров {key}
 */
export function t(key, params = null) {
  const dict = TRANSLATIONS[getLang()] || TRANSLATIONS.ru;
  const template = dict[key] !== undefined ? dict[key] : (TRANSLATIONS.ru[key] || key);
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (_, token) => (
    params[token] !== undefined ? String(params[token]) : ''
  ));
}

/**
 * Локализованное склонение количества кругов («3 круга» / «3 laps»)
 */
export function formatLapsCount(count) {
  if (getLang() === 'en') {
    return count === 1 ? '1 lap' : `${count} laps`;
  }
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return `${count} кругов`;
  if (n1 > 1 && n1 < 5) return `${count} круга`;
  if (n1 === 1) return `${count} круг`;
  return `${count} кругов`;
}

/**
 * Локализованное обозначение занятого места («1-Е МЕСТО» / «1ST PLACE»)
 */
export function formatPlaceText(rank) {
  if (getLang() === 'en') {
    const n = Math.abs(rank) % 100;
    const n1 = n % 10;
    let suffix = 'TH';
    if (n < 11 || n > 13) {
      if (n1 === 1) suffix = 'ST';
      else if (n1 === 2) suffix = 'ND';
      else if (n1 === 3) suffix = 'RD';
    }
    return `${rank}${suffix} PLACE`;
  }
  return `${rank}-Е МЕСТО`;
}

/**
 * Применяет переводы ко всем размеченным узлам DOM, атрибутам доступности и заголовку вкладки
 */
export function applyDomTranslations() {
  if (typeof document === 'undefined') return;

  const lang = getLang();
  document.documentElement.lang = lang;
  document.title = t('pageTitle');

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.dataset.i18nAria;
    if (key) el.setAttribute('aria-label', t(key));
  });

  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.setAttribute('title', t(key));
  });
}