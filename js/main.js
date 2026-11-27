import {
  GAME_CONFIG,
  STATE,
  LOGICAL_HEIGHT,
  SEGMENT_LENGTH,
  PLAYER_Z,
  PLAYER_CENTER_OFFSET_Z,
  INITIAL_TRAFFIC_COUNT
} from './config.js';
import { initCanvasPolyfills, MathUtil, formatRaceTime } from './utils.js';
import { audio } from './audio.js';
import {
  state,
  initStars,
  loadSavedRecords,
  loadSettings,
  saveSettings,
  getBestScoreStorageKey,
  getBestLapStorageKey,
  getPlayerWorldZ,
  resetRunState,
  resetPlayerScreenAnchors,
  showBanner,
  clearSkidMarks,
  queryTouchDevice,
  getActiveAspectRatio
} from './state.js';
import { buildTrack, buildCircuitTrack, applySharpTurnGuardrails } from './track.js';
import { resetTraffic, resetCircuitRivals, getCircuitGridSlotPose } from './traffic.js';
import { updateSimulation } from './physics.js';
import { renderFrame } from './renderer.js';
import {
  t,
  getLang,
  getNumberLocale,
  formatLapsCount,
  applyDomTranslations
} from './i18n.js';

initCanvasPolyfills();
initStars();
loadSavedRecords();
loadSettings();

const canvas = document.getElementById('gameCanvas');
canvas.width = state.logicalWidth;
canvas.height = LOGICAL_HEIGHT;
const ctx = canvas.getContext('2d');

const wrapper = document.getElementById('game-wrapper');
const topBar = document.getElementById('top-bar');
const startScreen = document.getElementById('start-screen');
const settingsScreen = document.getElementById('settings-screen');
const pauseScreen = document.getElementById('pause-screen');
const gameoverScreen = document.getElementById('gameover-screen');
const touchControls = document.getElementById('touch-controls');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const mobilePauseBtn = document.getElementById('mobile-pause-btn');
const mobileMuteBtn = document.getElementById('mobile-mute-btn');
const desktopMuteBtn = document.getElementById('desktop-mute-btn');
const startSubtitle = document.getElementById('start-subtitle');
const devSettingsToggle = document.getElementById('dev-settings-toggle');
const devSettingsContent = document.getElementById('dev-settings-content');

// Кэшированные ссылки на узлы экрана завершения заезда (без повторного поиска в DOM)
const gameoverEls = {
  newRecordTag: document.getElementById('new-record-tag'),
  modeTag: document.getElementById('gameover-mode-tag'),
  title: document.getElementById('gameover-title'),
  label1: document.getElementById('stat-label-1'),
  finalScore: document.getElementById('final-score'),
  label2: document.getElementById('stat-label-2'),
  bestScore: document.getElementById('best-score'),
  label3: document.getElementById('stat-label-3'),
  finalDistance: document.getElementById('final-distance'),
  label4: document.getElementById('stat-label-4'),
  finalExtra: document.getElementById('final-extra')
};

// Таблица клавиш управления движением
const DIR_KEYS = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right'
};

// Раздельные буферы ввода исключают сброс зажатых клавиш клавиатуры при касании экрана или мыши
const kbInput = { up: false, down: false, left: false, right: false };
const pointerInput = { up: false, down: false, left: false, right: false };
const touchInput = { up: false, down: false, left: false, right: false };

const touchButtonMap = [
  { id: 'btn-left', key: 'left', el: document.getElementById('btn-left'), rect: null },
  { id: 'btn-right', key: 'right', el: document.getElementById('btn-right'), rect: null },
  { id: 'btn-gas', key: 'up', el: document.getElementById('btn-gas'), rect: null },
  { id: 'btn-brake', key: 'down', el: document.getElementById('btn-brake'), rect: null }
];

let lastTimestamp = performance.now();
let fpsFrameCount = 0;
let fpsSampleStart = lastTimestamp;
// Флаг однократной отрисовки сцены на паузе (экономит CPU/GPU без потери кадра при ресайзе)
let needsPausedRedraw = false;

/**
 * Кэширование экранных прямоугольников тач-педалей (предотвращает принудительный reflow на каждом touchmove)
 */
function refreshTouchButtonRects() {
  for (let i = 0; i < touchButtonMap.length; i++) {
    const item = touchButtonMap[i];
    item.rect = item.el ? item.el.getBoundingClientRect() : null;
  }
}

/**
 * Объединяет состояние клавиатуры, мыши и мультитача в единый state.input
 */
function syncCombinedInput() {
  const allowActiveInput = state.gameState === STATE.PLAYING && !state.isPaused;
  for (let i = 0; i < touchButtonMap.length; i++) {
    const item = touchButtonMap[i];
    const k = item.key;
    const btnActive = allowActiveInput && (pointerInput[k] || touchInput[k]);
    state.input[k] = allowActiveInput && (kbInput[k] || btnActive);
    if (item.el) {
      item.el.classList.toggle('pressed', btnActive);
    }
  }
}

function clearInputs() {
  for (const k of ['up', 'down', 'left', 'right']) {
    kbInput[k] = false;
    pointerInput[k] = false;
    touchInput[k] = false;
    state.input[k] = false;
  }
  for (let i = 0; i < touchButtonMap.length; i++) {
    const btn = touchButtonMap[i].el;
    if (btn) btn.classList.remove('pressed');
  }
}

function blurActiveElement() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

/**
 * Универсальная привязка клика с автоматическим снятием фокуса с кнопки
 */
function bindClick(el, handler) {
  if (!el) return;
  el.addEventListener('click', (e) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.blur();
    }
    handler(e);
  });
}

/**
 * Универсальная привязка группы переключателей .mode-pill
 */
function bindPillGroup(groupSelector, datasetKey, onSelect) {
  const buttons = document.querySelectorAll(`${groupSelector} .mode-pill`);
  buttons.forEach((btn) => {
    bindClick(btn, () => {
      const value = btn.dataset[datasetKey];
      if (value !== undefined) {
        onSelect(value, buttons, btn);
      }
    });
  });
}

/**
 * Единая перестройка трассы и потока машин/соперников под выбранный режим
 */
function initWorldForCurrentMode(playerGridSlot = null) {
  if (state.gameMode === 'circuit') {
    buildCircuitTrack();
    resetCircuitRivals(playerGridSlot);
  } else {
    buildTrack();
    resetTraffic(INITIAL_TRAFFIC_COUNT);
  }
}

function syncSetupButtonsWithConfig() {
  document.querySelectorAll('#track-mode-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.gameMode);
  });
  document.querySelectorAll('#difficulty-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.diff === state.difficulty);
  });
}

function isSettingsOpen() {
  return Boolean(settingsScreen && !settingsScreen.classList.contains('hidden'));
}

function syncSettingsUI() {
  const langVal = getLang();
  const particlesVal = state.settings.particlesEnabled ? 'on' : 'off';
  const soundVal = audio.muted ? 'off' : 'on';
  const fpsVal = state.settings.showFps ? 'on' : 'off';

  document.querySelectorAll('#settings-lang-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === langVal);
  });
  document.querySelectorAll('#settings-particles-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.particles === particlesVal);
  });
  document.querySelectorAll('#settings-light-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.light === state.settings.lightStyle);
  });
  document.querySelectorAll('#settings-sound-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.sound === soundVal);
  });
  document.querySelectorAll('#settings-fps-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.fps === fpsVal);
  });

  const label = audio.muted ? t('muteOff') : t('muteOn');
  if (desktopMuteBtn) desktopMuteBtn.textContent = label;
  if (mobileMuteBtn) mobileMuteBtn.textContent = label;
  needsPausedRedraw = true;
}

function setDevSettingsOpen(isOpen) {
  if (!devSettingsToggle || !devSettingsContent) return;
  devSettingsToggle.classList.toggle('open', isOpen);
  devSettingsToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  devSettingsContent.classList.toggle('hidden', !isOpen);
}

function setSoundEnabled(enabled) {
  state.settings.soundEnabled = Boolean(enabled);
  const shouldMute = !state.settings.soundEnabled;

  if (audio.muted !== shouldMute) {
    audio.toggleMute();
  } else if (!shouldMute) {
    audio.init();
  }

  saveSettings();
  syncSettingsUI();
}

function openSettings() {
  if (state.gameState !== STATE.TITLE || !settingsScreen) return;
  blurActiveElement();
  syncSettingsUI();
  setDevSettingsOpen(false);
  startScreen.classList.add('hidden');
  settingsScreen.classList.remove('hidden');
}

function closeSettings() {
  if (!settingsScreen) return;
  blurActiveElement();
  setDevSettingsOpen(false);
  settingsScreen.classList.add('hidden');
  if (state.gameState === STATE.TITLE) {
    startScreen.classList.remove('hidden');
  }
}

function updateMobileTopBarState() {
  const inRace = state.gameState === STATE.PLAYING;
  if (mobileMenuBtn) {
    mobileMenuBtn.classList.toggle('invisible', !inRace);
  }
  if (mobilePauseBtn) {
    mobilePauseBtn.classList.toggle('invisible', !inRace);
    mobilePauseBtn.textContent = state.isPaused ? t('mobilePlayBtn') : t('mobilePauseBtn');
  }
}

function updateStartSubtitle() {
  if (!startSubtitle) return;
  if (state.gameMode === 'circuit') {
    const activeRivalsCount = Math.min(
      GAME_CONFIG.circuit.rivalsCount || GAME_CONFIG.circuit.rivals.length,
      GAME_CONFIG.circuit.rivals.length
    );
    const lapsText = formatLapsCount(GAME_CONFIG.circuit.totalLaps);
    startSubtitle.textContent = t('subtitleCircuit', {
      laps: lapsText,
      rivals: activeRivalsCount
    });
  } else if (state.gameMode === 'oncoming') {
    startSubtitle.textContent = t('subtitleOncoming');
  } else {
    startSubtitle.textContent = t('subtitleOneway');
  }
}

function resizeCanvas() {
  state.cachedIsTouch = queryTouchDevice();

  const aspect = getActiveAspectRatio();
  const targetLogicalWidth = Math.round(LOGICAL_HEIGHT * aspect);
  if (
    state.aspectRatio !== aspect ||
    state.logicalWidth !== targetLogicalWidth ||
    canvas.width !== targetLogicalWidth
  ) {
    state.aspectRatio = aspect;
    state.logicalWidth = targetLogicalWidth;
    canvas.width = state.logicalWidth;
    canvas.height = LOGICAL_HEIGHT;
    resetPlayerScreenAnchors();
  }

  const pad = 12;
  const vv = window.visualViewport;
  const viewportW = vv ? vv.width : window.innerWidth;
  const viewportH = vv ? vv.height : window.innerHeight;

  const topBarVisible = topBar && window.getComputedStyle(topBar).display !== 'none';
  const topBarReserve = topBarVisible ? (topBar.offsetHeight + 8) : 0;

  const controlsVisible =
    touchControls &&
    touchControls.classList.contains('active') &&
    window.getComputedStyle(touchControls).display !== 'none';
  const controlsReserve = controlsVisible ? (touchControls.offsetHeight + 10) : 0;

  const availW = Math.max(240, viewportW - pad);
  const availH = Math.max(135, viewportH - pad - topBarReserve - controlsReserve);

  let targetW = availW;
  let targetH = availW / aspect;

  if (targetH > availH) {
    targetH = availH;
    targetW = availH * aspect;
  }

  const finalW = Math.floor(targetW);
  const finalH = Math.floor(targetH);

  wrapper.style.width = `${finalW}px`;
  wrapper.style.height = `${finalH}px`;

  if (topBarVisible) {
    topBar.style.width = `${finalW}px`;
  }

  if (controlsVisible) {
    const deckW = Math.min(availW, Math.max(finalW, 520));
    touchControls.style.width = `${Math.floor(deckW)}px`;
  }

  refreshTouchButtonRects();
  needsPausedRedraw = true;
}

function pauseGame() {
  if (state.gameState !== STATE.PLAYING || state.isPaused) return;
  blurActiveElement();
  state.isPaused = true;
  needsPausedRedraw = true;
  clearInputs();
  audio.update(0, false, false, false);
  updateMobileTopBarState();
  if (pauseScreen) pauseScreen.classList.remove('hidden');
}

function resumeGame() {
  if (state.gameState !== STATE.PLAYING || !state.isPaused) return;
  blurActiveElement();
  audio.init();
  state.isPaused = false;
  needsPausedRedraw = false;
  lastTimestamp = performance.now();
  fpsSampleStart = lastTimestamp;
  fpsFrameCount = 0;
  updateMobileTopBarState();
  if (pauseScreen) pauseScreen.classList.add('hidden');
}

function startGame() {
  blurActiveElement();
  audio.init();
  clearInputs();
  loadSavedRecords();
  resetRunState();

  state.gameState = STATE.PLAYING;
  needsPausedRedraw = false;
  if (startScreen) startScreen.classList.add('hidden');
  if (settingsScreen) settingsScreen.classList.add('hidden');
  if (pauseScreen) pauseScreen.classList.add('hidden');
  if (gameoverScreen) gameoverScreen.classList.add('hidden');

  if (state.gameMode === 'circuit') {
    const activeRivalsCount = Math.min(
      GAME_CONFIG.circuit.rivalsCount || GAME_CONFIG.circuit.rivals.length,
      GAME_CONFIG.circuit.rivals.length
    );
    const playerGridSlot = Math.floor(Math.random() * (activeRivalsCount + 1));
    initWorldForCurrentMode(playerGridSlot);

    const { gridCol, backFromStartLine } = getCircuitGridSlotPose(playerGridSlot);
    state.playerX = gridCol;
    // Позиционируем камеру с учётом смещения PLAYER_Z + PLAYER_CENTER_OFFSET_Z, чтобы сама машина игрока встала ровно в свой слот
    state.position = MathUtil.wrap(
      -backFromStartLine - (PLAYER_Z + PLAYER_CENTER_OFFSET_Z),
      state.trackLength
    );
    state.playerProgressZ = -backFromStartLine;
    state.playerRank = playerGridSlot + 1;
    state.raceCountdownTimer = GAME_CONFIG.circuit.countdownSec;
    state.lastCountdownDigit = 0;
  } else {
    state.position = 0;
    resetTraffic(INITIAL_TRAFFIC_COUNT);
  }

  if (touchControls) {
    touchControls.classList.toggle('active', state.cachedIsTouch);
  }
  updateMobileTopBarState();
  resizeCanvas();

  if (state.gameMode === 'circuit') {
    const lapsUpper = formatLapsCount(state.circuitTotalLaps).toUpperCase();
    showBanner(t('bannerStartCircuit', { seed: state.circuitSeedId, laps: lapsUpper }), '#39ff14', 1.6);
  } else {
    const modeLabel = state.gameMode === 'oncoming' ? t('modeTagOncoming') : t('modeTagOneway');
    showBanner(t('bannerStartHighway', { mode: modeLabel }), '#00f0ff', 1.8);
  }
}

function triggerGameOver(reasonTitle = null) {
  const finalReason = reasonTitle || t('goTimeUp');
  // Фиксируем положение машины игрока на трассе, чтобы камера проехала мимо и продолжила движение без неё
  state.stoppedPlayerZ = getPlayerWorldZ();
  state.stoppedPlayerX = state.playerX;
  state.stoppedPlayerYaw = MathUtil.clamp(state.steerVisual * 0.22 + state.playerVX * 0.14, -0.34, 0.34);
  state.playerCarPassedByCamera = false;
  state.speed = 0;
  state.playerVX = 0;
  state.steerVisual = 0;

  state.isPaused = false;
  state.isSlipstreaming = false;
  clearInputs();
  state.gameState = STATE.GAMEOVER;
  if (pauseScreen) pauseScreen.classList.add('hidden');
  if (touchControls) touchControls.classList.remove('active');
  updateMobileTopBarState();
  resizeCanvas();
  audio.update(0, false, false, false);

  const diffText = state.difficulty === 'hardcore' ? t('diffTagHardcore') : t('diffTagArcade');
  const kmhUnit = t('unitKmhLower');
  const newRecordTag = gameoverEls.newRecordTag;

  if (state.gameMode === 'circuit') {
    loadSavedRecords();
    // Округляем средний темп круга до десятых до сравнения с сохранённым рекордом, исключая ложный «Новый рекорд»
    const roundedLapAvgKmh = state.bestLapAvgKmh !== null
      ? Math.round(state.bestLapAvgKmh * 10) / 10
      : null;
    let isNewLapRecord = false;
    if (
      roundedLapAvgKmh !== null &&
      roundedLapAvgKmh > 0 &&
      (state.bestLapRecordKmh === null || roundedLapAvgKmh > state.bestLapRecordKmh)
    ) {
      state.bestLapRecordKmh = roundedLapAvgKmh;
      isNewLapRecord = true;
      try {
        localStorage.setItem(getBestLapStorageKey(), state.bestLapRecordKmh.toFixed(1));
      } catch (e) {}
    }

    const totalRacers = state.rivals.length + 1;
    gameoverEls.modeTag.textContent = t('modeTagCircuit', { seed: state.circuitSeedId, diff: diffText });
    gameoverEls.title.textContent = finalReason;

    gameoverEls.label1.textContent = t('statFinalPos');
    gameoverEls.finalScore.textContent = t('statRankOf', { rank: state.playerRank, total: totalRacers });

    gameoverEls.label2.textContent = t('statRaceTime');
    gameoverEls.bestScore.textContent = formatRaceTime(state.raceElapsedTime);

    gameoverEls.label3.textContent = t('statBestLap');
    gameoverEls.finalDistance.textContent = state.bestLapTime !== null
      ? `${formatRaceTime(state.bestLapTime)} (${Math.round(state.bestLapAvgKmh || 0)} ${kmhUnit})`
      : '--:--.--';

    gameoverEls.label4.textContent = state.bestLapRecordKmh !== null ? t('statLapRecordMax') : t('statMaxSpeed');
    gameoverEls.finalExtra.textContent = state.bestLapRecordKmh !== null
      ? `${Math.round(state.bestLapRecordKmh)} / ${state.maxKmhReached} ${kmhUnit}`
      : `${state.maxKmhReached} ${kmhUnit}`;

    if (isNewLapRecord && state.playerRank === 1) {
      newRecordTag.textContent = t('recWinAndLap');
      newRecordTag.classList.remove('hidden');
    } else if (isNewLapRecord) {
      newRecordTag.textContent = t('recNewLap');
      newRecordTag.classList.remove('hidden');
    } else if (state.playerRank === 1) {
      newRecordTag.textContent = t('recWin');
      newRecordTag.classList.remove('hidden');
    } else if (state.playerRank <= 3) {
      newRecordTag.textContent = t('recPodium');
      newRecordTag.classList.remove('hidden');
    } else {
      newRecordTag.classList.add('hidden');
    }
  } else {
    loadSavedRecords();
    const finalScoreInt = Math.floor(state.score);
    let isNewRecord = false;
    if (finalScoreInt > state.bestScore) {
      state.bestScore = finalScoreInt;
      isNewRecord = true;
      try {
        localStorage.setItem(getBestScoreStorageKey(), String(state.bestScore));
      } catch (e) {}
    }

    const modeText = state.gameMode === 'oncoming' ? t('modeTagOncoming') : t('modeTagOneway');
    const numLocale = getNumberLocale();
    gameoverEls.modeTag.textContent = `${modeText} • ${diffText}`;
    gameoverEls.title.textContent = finalReason;

    gameoverEls.label1.textContent = t('statFinalScore');
    gameoverEls.finalScore.textContent = finalScoreInt.toLocaleString(numLocale);

    gameoverEls.label2.textContent = t('statBestRecord');
    gameoverEls.bestScore.textContent = state.bestScore.toLocaleString(numLocale);

    gameoverEls.label3.textContent = t('statDistance');
    gameoverEls.finalDistance.textContent = `${(state.distanceMeters / 1000).toFixed(2)} ${t('unitKmLower')}`;

    gameoverEls.label4.textContent = t('statExtra');
    gameoverEls.finalExtra.textContent = `${state.checkpointsPassed} / ${state.maxKmhReached} ${kmhUnit}`;

    if (isNewRecord && finalScoreInt > 0) {
      newRecordTag.textContent = t('recNewHighScore');
      newRecordTag.classList.remove('hidden');
    } else {
      newRecordTag.classList.add('hidden');
    }
  }

  gameoverScreen.classList.remove('hidden');
}

function returnToMenu() {
  blurActiveElement();
  clearInputs();
  resetRunState();

  state.gameState = STATE.TITLE;
  needsPausedRedraw = false;
  if (touchControls) touchControls.classList.remove('active');
  updateMobileTopBarState();
  audio.update(0, false, false, false);

  if (pauseScreen) pauseScreen.classList.add('hidden');
  if (settingsScreen) settingsScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');

  initWorldForCurrentMode();
  updateStartSubtitle();
  resizeCanvas();
}

function handleToggleMute() {
  setSoundEnabled(audio.muted);
}

// Подключаем обработчик завершения игры для physics.js
state.onGameOver = triggerGameOver;

window.addEventListener('resize', resizeCanvas);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resizeCanvas);
}

// Переключатели режима трассы, сложности и графических/звуковых настроек
bindPillGroup('#track-mode-group', 'mode', (nextMode, buttons, activeBtn) => {
  if (nextMode === state.gameMode) return;
  buttons.forEach((b) => b.classList.remove('active'));
  activeBtn.classList.add('active');
  state.gameMode = nextMode;
  loadSavedRecords();
  state.position = 0;
  clearSkidMarks();
  initWorldForCurrentMode();
  updateStartSubtitle();
});

bindPillGroup('#difficulty-group', 'diff', (nextDiff, buttons, activeBtn) => {
  if (nextDiff === state.difficulty) return;
  buttons.forEach((b) => b.classList.remove('active'));
  activeBtn.classList.add('active');
  state.difficulty = nextDiff;
  loadSavedRecords();
  if (state.gameMode === 'circuit') {
    applySharpTurnGuardrails(GAME_CONFIG.circuit.guardrailCurveThreshold);
  }
});

bindPillGroup('#settings-lang-group', 'lang', (val) => {
  const nextLang = val === 'en' ? 'en' : 'ru';
  if (nextLang === state.settings.language) return;
  state.settings.language = nextLang;
  saveSettings();
  applyDomTranslations();
  syncSettingsUI();
  updateStartSubtitle();
  updateMobileTopBarState();
  resizeCanvas();
});

bindPillGroup('#settings-particles-group', 'particles', (val) => {
  state.settings.particlesEnabled = val === 'on';
  if (!state.settings.particlesEnabled) {
    state.particles = [];
  }
  saveSettings();
  syncSettingsUI();
});

bindPillGroup('#settings-light-group', 'light', (val) => {
  state.settings.lightStyle = val === 'soft' ? 'soft' : 'hard';
  saveSettings();
  syncSettingsUI();
});

bindPillGroup('#settings-sound-group', 'sound', (val) => {
  setSoundEnabled(val === 'on');
});

bindPillGroup('#settings-fps-group', 'fps', (val) => {
  state.settings.showFps = val === 'on';
  saveSettings();
  syncSettingsUI();
});

// Основные кнопки навигации по экранам
bindClick(document.getElementById('start-btn'), startGame);
bindClick(document.getElementById('settings-btn'), openSettings);
bindClick(document.getElementById('settings-back-btn'), closeSettings);
bindClick(document.getElementById('restart-btn'), startGame);
bindClick(document.getElementById('menu-btn'), returnToMenu);
bindClick(document.getElementById('resume-btn'), resumeGame);
bindClick(document.getElementById('pause-menu-btn'), returnToMenu);
bindClick(mobileMenuBtn, returnToMenu);
bindClick(mobilePauseBtn, () => {
  if (state.isPaused) resumeGame();
  else pauseGame();
});
bindClick(devSettingsToggle, () => {
  const currentlyOpen = devSettingsToggle.classList.contains('open');
  setDevSettingsOpen(!currentlyOpen);
});
bindClick(desktopMuteBtn, handleToggleMute);
bindClick(mobileMuteBtn, handleToggleMute);

// Клавиатура (с защитой от системных сочетаний и автоповтора e.repeat на хоткеях)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const code = e.code;
  const dirKey = DIR_KEYS[code];
  if (dirKey) {
    e.preventDefault();
    if (!e.repeat && !state.isPaused && state.gameState === STATE.PLAYING) {
      kbInput[dirKey] = true;
      syncCombinedInput();
    }
    return;
  }

  if (code === 'KeyM') {
    if (!e.repeat) handleToggleMute();
  } else if (code === 'KeyP') {
    if (state.gameState === STATE.PLAYING) {
      e.preventDefault();
      if (!e.repeat) {
        if (state.isPaused) resumeGame();
        else pauseGame();
      }
    }
  } else if (code === 'Enter' || code === 'Space') {
    if (isSettingsOpen()) {
      e.preventDefault();
      if (!e.repeat) closeSettings();
    } else if (state.gameState === STATE.PLAYING && state.isPaused) {
      e.preventDefault();
      if (!e.repeat) resumeGame();
    } else if (state.gameState === STATE.TITLE || state.gameState === STATE.GAMEOVER) {
      e.preventDefault();
      if (!e.repeat) startGame();
    }
  } else if (code === 'Escape') {
    if (isSettingsOpen()) {
      e.preventDefault();
      if (!e.repeat) closeSettings();
    } else if (state.gameState === STATE.PLAYING) {
      e.preventDefault();
      if (!e.repeat) {
        if (state.isPaused) resumeGame();
        else pauseGame();
      }
    } else if (state.gameState === STATE.GAMEOVER) {
      e.preventDefault();
      if (!e.repeat) returnToMenu();
    }
  }
});

window.addEventListener('keyup', (e) => {
  const dirKey = DIR_KEYS[e.code];
  if (dirKey) {
    kbInput[dirKey] = false;
    syncCombinedInput();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInputs();
    pauseGame();
  }
});

window.addEventListener('blur', () => {
  clearInputs();
  pauseGame();
});

// Мультитач-управление по предварительно закэшированным прямоугольникам кнопок (без getBoundingClientRect в touchmove)
function updateTouchesFromList(touchList) {
  if (state.isPaused || state.gameState !== STATE.PLAYING) {
    clearInputs();
    return;
  }

  touchInput.up = false;
  touchInput.down = false;
  touchInput.left = false;
  touchInput.right = false;

  const hitSlopPx = 5;

  for (let i = 0; i < touchList.length; i++) {
    const t = touchList[i];
    const tx = t.clientX;
    const ty = t.clientY;

    let bestKey = null;
    let bestDistSq = Infinity;

    for (let b = 0; b < touchButtonMap.length; b++) {
      const rect = touchButtonMap[b].rect;
      if (!rect || rect.width <= 0) continue;
      if (
        tx >= rect.left - hitSlopPx &&
        tx <= rect.right + hitSlopPx &&
        ty >= rect.top - hitSlopPx &&
        ty <= rect.bottom + hitSlopPx
      ) {
        const cx = (rect.left + rect.right) * 0.5;
        const cy = (rect.top + rect.bottom) * 0.5;
        const distSq = (tx - cx) * (tx - cx) + (ty - cy) * (ty - cy);
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestKey = touchButtonMap[b].key;
        }
      }
    }

    if (bestKey) {
      touchInput[bestKey] = true;
    }
  }

  syncCombinedInput();
}

if (touchControls) {
  touchControls.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (state.isPaused || state.gameState !== STATE.PLAYING) {
      clearInputs();
      return;
    }
    audio.init();
    refreshTouchButtonRects();
    updateTouchesFromList(e.touches);
  }, { passive: false });

  touchControls.addEventListener('touchmove', (e) => {
    e.preventDefault();
    updateTouchesFromList(e.touches);
  }, { passive: false });

  touchControls.addEventListener('touchend', (e) => {
    e.preventDefault();
    updateTouchesFromList(e.touches);
  }, { passive: false });

  touchControls.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    updateTouchesFromList(e.touches);
  }, { passive: false });
}

for (let i = 0; i < touchButtonMap.length; i++) {
  const item = touchButtonMap[i];
  const el = item.el;
  if (!el) continue;

  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (state.isPaused || state.gameState !== STATE.PLAYING) return;
    audio.init();
    pointerInput[item.key] = true;
    syncCombinedInput();
  });

  const releaseMouse = () => {
    if (!pointerInput[item.key]) return;
    pointerInput[item.key] = false;
    syncCombinedInput();
  };
  el.addEventListener('mouseup', releaseMouse);
  el.addEventListener('mouseleave', releaseMouse);
}

window.addEventListener('mouseup', () => {
  let changed = false;
  for (const k of ['up', 'down', 'left', 'right']) {
    if (pointerInput[k]) {
      pointerInput[k] = false;
      changed = true;
    }
  }
  if (changed) syncCombinedInput();
});

// Главный игровой цикл
function gameLoop(now) {
  // На паузе не крутим холостую перерисовку 3D-сцены в 60–240 FPS (перерисовываем только при входе или ресайзе)
  if (state.gameState === STATE.PLAYING && state.isPaused) {
    lastTimestamp = now;
    audio.update(0, false, false, false);
    if (needsPausedRedraw) {
      renderFrame(ctx);
      needsPausedRedraw = false;
    }
    requestAnimationFrame(gameLoop);
    return;
  }

  const dt = Math.min(GAME_CONFIG.screen.maxFrameDeltaSec, Math.max(0.001, (now - lastTimestamp) / 1000));
  lastTimestamp = now;

  fpsFrameCount++;
  const fpsElapsed = now - fpsSampleStart;
  if (fpsElapsed >= 250) {
    state.fpsValue = Math.round((fpsFrameCount * 1000) / fpsElapsed);
    fpsFrameCount = 0;
    fpsSampleStart = now;
  }

  updateSimulation(dt);
  renderFrame(ctx);

  requestAnimationFrame(gameLoop);
}

// Инициализация при запуске (без вызова audio.init() до первого пользовательского жеста)
audio.muted = !state.settings.soundEnabled;
applyDomTranslations();
syncSetupButtonsWithConfig();
syncSettingsUI();
initWorldForCurrentMode();
updateStartSubtitle();
updateMobileTopBarState();
resizeCanvas();
requestAnimationFrame(gameLoop);