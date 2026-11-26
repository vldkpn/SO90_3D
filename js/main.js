import {
  GAME_CONFIG,
  STATE,
  LOGICAL_HEIGHT,
  SEGMENT_LENGTH,
  PLAYER_Z,
  PLAYER_CENTER_OFFSET_Z,
  INITIAL_TRAFFIC_COUNT
} from './config.js';
import { initCanvasPolyfills, formatRaceTime } from './utils.js';
import { audio } from './audio.js';
import {
  state,
  initStars,
  loadSavedRecords,
  getBestScoreStorageKey,
  getBestLapStorageKey,
  resetRunState,
  showBanner,
  clearSkidMarks,
  queryTouchDevice,
  getActiveAspectRatio
} from './state.js';
import { buildTrack, buildCircuitTrack, applySharpTurnGuardrails } from './track.js';
import { resetTraffic, resetCircuitRivals } from './traffic.js';
import { updateSimulation } from './physics.js';
import { renderFrame } from './renderer.js';

initCanvasPolyfills();
initStars();
loadSavedRecords();

const canvas = document.getElementById('gameCanvas');
canvas.width = state.logicalWidth;
canvas.height = LOGICAL_HEIGHT;
const ctx = canvas.getContext('2d');

const wrapper = document.getElementById('game-wrapper');
const topBar = document.getElementById('top-bar');
const startScreen = document.getElementById('start-screen');
const pauseScreen = document.getElementById('pause-screen');
const gameoverScreen = document.getElementById('gameover-screen');
const touchControls = document.getElementById('touch-controls');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const mobilePauseBtn = document.getElementById('mobile-pause-btn');
const mobileMuteBtn = document.getElementById('mobile-mute-btn');
const desktopMuteBtn = document.getElementById('desktop-mute-btn');
const startSubtitle = document.getElementById('start-subtitle');

const touchButtonMap = [
  { id: 'btn-left', key: 'left', el: document.getElementById('btn-left') },
  { id: 'btn-right', key: 'right', el: document.getElementById('btn-right') },
  { id: 'btn-gas', key: 'up', el: document.getElementById('btn-gas') },
  { id: 'btn-brake', key: 'down', el: document.getElementById('btn-brake') }
];

let lastTimestamp = performance.now();

function clearInputs() {
  state.input.up = false;
  state.input.down = false;
  state.input.left = false;
  state.input.right = false;
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

function syncSetupButtonsWithConfig() {
  document.querySelectorAll('#track-mode-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.gameMode);
  });
  document.querySelectorAll('#difficulty-group .mode-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.diff === state.difficulty);
  });
}

function updateMobileTopBarState() {
  const inRace = state.gameState === STATE.PLAYING;
  if (mobileMenuBtn) {
    mobileMenuBtn.classList.toggle('invisible', !inRace);
  }
  if (mobilePauseBtn) {
    mobilePauseBtn.classList.toggle('invisible', !inRace);
    mobilePauseBtn.textContent = state.isPaused ? '▶ ИГРАТЬ' : '⏸ ПАУЗА';
  }
}

function updateStartSubtitle() {
  if (!startSubtitle) return;
  if (state.gameMode === 'circuit') {
    const activeRivalsCount = Math.min(
      GAME_CONFIG.circuit.rivalsCount || GAME_CONFIG.circuit.rivals.length,
      GAME_CONFIG.circuit.rivals.length
    );
    startSubtitle.textContent =
      `Кольцевая гонка на ${GAME_CONFIG.circuit.totalLaps} круга с ${activeRivalsCount} соперниками, миникартой и случайной генерацией трассы. Машина не ломается!`;
  } else if (state.gameMode === 'oncoming') {
    startSubtitle.textContent =
      'Выезжайте на встречную полосу для двойного множителя очков 2X, уворачивайтесь от встречных фар и успевайте к чекпоинтам!';
  } else {
    startSubtitle.textContent =
      'Мчитесь навстречу неоновому закату, обгоняйте трафик и пересекайте чекпоинты до истечения таймера!';
  }
}

function resizeCanvas() {
  state.cachedIsTouch = queryTouchDevice();

  const aspect = getActiveAspectRatio();
  const targetLogicalWidth = Math.round(LOGICAL_HEIGHT * aspect);
  if (state.aspectRatio !== aspect || state.logicalWidth !== targetLogicalWidth || canvas.width !== targetLogicalWidth) {
    state.aspectRatio = aspect;
    state.logicalWidth = targetLogicalWidth;
    canvas.width = state.logicalWidth;
    canvas.height = LOGICAL_HEIGHT;
  }

  const pad = 12;

  const topBarVisible = topBar && window.getComputedStyle(topBar).display !== 'none';
  const topBarReserve = topBarVisible ? (topBar.offsetHeight + 8) : 0;

  const controlsVisible =
    touchControls.classList.contains('active') &&
    window.getComputedStyle(touchControls).display !== 'none';
  const controlsReserve = controlsVisible ? (touchControls.offsetHeight + 10) : 0;

  const availW = Math.max(240, window.innerWidth - pad);
  const availH = Math.max(135, window.innerHeight - pad - topBarReserve - controlsReserve);

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
}

function pauseGame() {
  if (state.gameState !== STATE.PLAYING || state.isPaused) return;
  blurActiveElement();
  state.isPaused = true;
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
  lastTimestamp = performance.now();
  updateMobileTopBarState();
  if (pauseScreen) pauseScreen.classList.add('hidden');
}

function startGame() {
  blurActiveElement();
  audio.init();
  clearInputs();
  loadSavedRecords();
  resetRunState();

  if (state.gameMode === 'circuit') {
    buildCircuitTrack();
    const startBackOffset = 9.8 * SEGMENT_LENGTH;
    state.position = (((state.trackLength - PLAYER_Z - startBackOffset) % state.trackLength) + state.trackLength) % state.trackLength;
    state.playerProgressZ = -startBackOffset + PLAYER_CENTER_OFFSET_Z;
    resetCircuitRivals();
    state.playerRank = state.rivals.length + 1;
    state.playerX = state.rivals.length % 2 === 0 ? -0.38 : 0.38;
    state.raceCountdownTimer = GAME_CONFIG.circuit.countdownSec;
    state.lastCountdownDigit = 4;
  } else {
    buildTrack();
    resetTraffic(INITIAL_TRAFFIC_COUNT);
    audio.playStartBeep();
  }

  state.gameState = STATE.PLAYING;
  lastTimestamp = performance.now();
  startScreen.classList.add('hidden');
  if (pauseScreen) pauseScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  touchControls.classList.add('active');
  updateMobileTopBarState();
  resizeCanvas();

  if (state.gameMode === 'circuit') {
    showBanner(`ТРЕК #${state.circuitSeedId} • ${state.circuitTotalLaps} КРУГА`, '#39ff14', 1.6);
  } else {
    const modeLabel = state.gameMode === 'oncoming' ? 'ВСТРЕЧНАЯ ПОЛОСА' : 'ПОПУТНЫЙ ПОТОК';
    showBanner(`СТАРТ! ${modeLabel}`, '#00f0ff', 1.8);
  }
}

function triggerGameOver(reasonTitle = 'ВРЕМЯ ВЫШЛО!') {
  state.isPaused = false;
  state.isSlipstreaming = false;
  clearInputs();
  state.gameState = STATE.GAMEOVER;
  if (pauseScreen) pauseScreen.classList.add('hidden');
  touchControls.classList.remove('active');
  updateMobileTopBarState();
  resizeCanvas();
  audio.update(0, false, false, false);

  const diffText = state.difficulty === 'hardcore' ? 'НОРМАЛЬНО' : 'ЛЕГКО';
  const newRecordTag = document.getElementById('new-record-tag');

  if (state.gameMode === 'circuit') {
    // Актуализируем сохранённый рекорд для текущей сложности перед сравнением
    loadSavedRecords();
    let isNewLapRecord = false;
    if (
      state.bestLapAvgKmh !== null &&
      state.bestLapAvgKmh > 0 &&
      (state.bestLapRecordKmh === null || state.bestLapAvgKmh > state.bestLapRecordKmh)
    ) {
      state.bestLapRecordKmh = state.bestLapAvgKmh;
      isNewLapRecord = true;
      try {
        localStorage.setItem(getBestLapStorageKey(), state.bestLapRecordKmh.toFixed(1));
      } catch (e) {}
    }

    const totalRacers = state.rivals.length + 1;
    document.getElementById('gameover-mode-tag').textContent = `КОЛЬЦЕВОЙ ЗАЕЗД • ТРЕК #${state.circuitSeedId} • ${diffText}`;
    document.getElementById('gameover-title').textContent = reasonTitle;

    document.getElementById('stat-label-1').textContent = 'Итоговое место';
    document.getElementById('final-score').textContent = `${state.playerRank} из ${totalRacers}`;

    document.getElementById('stat-label-2').textContent = 'Время гонки';
    document.getElementById('best-score').textContent = formatRaceTime(state.raceElapsedTime);

    document.getElementById('stat-label-3').textContent = 'Лучший круг';
    document.getElementById('final-distance').textContent = state.bestLapTime !== null
      ? `${formatRaceTime(state.bestLapTime)} (${Math.round(state.bestLapAvgKmh || 0)} км/ч)`
      : '--:--.--';

    document.getElementById('stat-label-4').textContent = state.bestLapRecordKmh !== null ? 'Рекорд круга / Макс.' : 'Макс. скорость';
    document.getElementById('final-extra').textContent = state.bestLapRecordKmh !== null
      ? `${Math.round(state.bestLapRecordKmh)} / ${state.maxKmhReached} км/ч`
      : `${state.maxKmhReached} км/ч`;

    if (isNewLapRecord && state.playerRank === 1) {
      newRecordTag.textContent = '★ ПОБЕДА И РЕКОРД ТЕМПА КРУГА! ★';
      newRecordTag.classList.remove('hidden');
    } else if (isNewLapRecord) {
      newRecordTag.textContent = '★ НОВЫЙ РЕКОРД ТЕМПА КРУГА! ★';
      newRecordTag.classList.remove('hidden');
    } else if (state.playerRank === 1) {
      newRecordTag.textContent = '★ ПОБЕДА В ГОНКЕ! ★';
      newRecordTag.classList.remove('hidden');
    } else if (state.playerRank <= 3) {
      newRecordTag.textContent = '★ ПОДИУМ! ПРИЗОВОЕ МЕСТО! ★';
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

    const modeText = state.gameMode === 'oncoming' ? 'ВСТРЕЧНАЯ ПОЛОСА' : 'ПОПУТНЫЙ ПОТОК';
    document.getElementById('gameover-mode-tag').textContent = `${modeText} • ${diffText}`;
    document.getElementById('gameover-title').textContent = reasonTitle;

    document.getElementById('stat-label-1').textContent = 'Итоговый счёт';
    document.getElementById('final-score').textContent = finalScoreInt.toLocaleString('ru-RU');

    document.getElementById('stat-label-2').textContent = 'Лучший рекорд';
    document.getElementById('best-score').textContent = state.bestScore.toLocaleString('ru-RU');

    document.getElementById('stat-label-3').textContent = 'Дистанция';
    document.getElementById('final-distance').textContent = `${(state.distanceMeters / 1000).toFixed(2)} км`;

    document.getElementById('stat-label-4').textContent = 'Чекпоинты / Макс. км/ч';
    document.getElementById('final-extra').textContent = `${state.checkpointsPassed} / ${state.maxKmhReached} км/ч`;

    if (isNewRecord && finalScoreInt > 0) {
      newRecordTag.textContent = '★ НОВЫЙ РЕКОРД! ★';
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
  touchControls.classList.remove('active');
  updateMobileTopBarState();
  audio.update(0, false, false, false);

  if (pauseScreen) pauseScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');

  if (state.gameMode === 'circuit') {
    buildCircuitTrack();
    resetCircuitRivals();
  } else {
    buildTrack();
    resetTraffic(INITIAL_TRAFFIC_COUNT);
  }
  updateStartSubtitle();
  resizeCanvas();
}

// Подключаем обработчик завершения игры для physics.js
state.onGameOver = triggerGameOver;

window.addEventListener('resize', resizeCanvas);

// Переключатели режима трассы и сложности
document.querySelectorAll('#track-mode-group .mode-pill').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    document.querySelectorAll('#track-mode-group .mode-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.gameMode = btn.dataset.mode;
    loadSavedRecords();
    state.position = 0;
    clearSkidMarks();
    if (state.gameMode === 'circuit') {
      buildCircuitTrack();
      resetCircuitRivals();
    } else {
      buildTrack();
      resetTraffic(INITIAL_TRAFFIC_COUNT);
    }
    updateStartSubtitle();
  });
});

document.querySelectorAll('#difficulty-group .mode-pill').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    document.querySelectorAll('#difficulty-group .mode-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.difficulty = btn.dataset.diff;
    loadSavedRecords();
    if (state.gameMode === 'circuit') {
      applySharpTurnGuardrails(GAME_CONFIG.circuit.guardrailCurveThreshold);
    }
  });
});

// Кнопки интерфейса
document.getElementById('start-btn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  startGame();
});
document.getElementById('restart-btn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  startGame();
});
document.getElementById('menu-btn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  returnToMenu();
});
const resumeBtn = document.getElementById('resume-btn');
if (resumeBtn) {
  resumeBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    resumeGame();
  });
}
const pauseMenuBtn = document.getElementById('pause-menu-btn');
if (pauseMenuBtn) {
  pauseMenuBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    returnToMenu();
  });
}
if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    returnToMenu();
  });
}
if (mobilePauseBtn) {
  mobilePauseBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    if (state.isPaused) resumeGame();
    else pauseGame();
  });
}

function handleToggleMute(e) {
  if (e && e.currentTarget instanceof HTMLElement) {
    e.currentTarget.blur();
  }
  const isMuted = audio.toggleMute();
  const label = isMuted ? '🔇 ЗВУК: ВЫКЛ' : '🔊 ЗВУК: ВКЛ';
  if (desktopMuteBtn) desktopMuteBtn.textContent = label;
  if (mobileMuteBtn) mobileMuteBtn.textContent = label;
}
if (desktopMuteBtn) desktopMuteBtn.addEventListener('click', handleToggleMute);
if (mobileMuteBtn) mobileMuteBtn.addEventListener('click', handleToggleMute);

// Клавиатура
window.addEventListener('keydown', (e) => {
  const code = e.code;
  if (code === 'ArrowUp' || code === 'KeyW') {
    if (!state.isPaused) state.input.up = true;
    e.preventDefault();
  } else if (code === 'ArrowDown' || code === 'KeyS') {
    if (!state.isPaused) state.input.down = true;
    e.preventDefault();
  } else if (code === 'ArrowLeft' || code === 'KeyA') {
    if (!state.isPaused) state.input.left = true;
    e.preventDefault();
  } else if (code === 'ArrowRight' || code === 'KeyD') {
    if (!state.isPaused) state.input.right = true;
    e.preventDefault();
  } else if (code === 'KeyM') {
    handleToggleMute();
  } else if (code === 'KeyP') {
    if (state.gameState === STATE.PLAYING) {
      e.preventDefault();
      if (state.isPaused) resumeGame();
      else pauseGame();
    }
  } else if (code === 'Enter' || code === 'Space') {
    if (state.gameState === STATE.PLAYING && state.isPaused) {
      e.preventDefault();
      resumeGame();
    } else if (state.gameState === STATE.TITLE || state.gameState === STATE.GAMEOVER) {
      e.preventDefault();
      startGame();
    }
  } else if (code === 'Escape') {
    if (state.gameState === STATE.PLAYING) {
      e.preventDefault();
      if (state.isPaused) resumeGame();
      else pauseGame();
    } else if (state.gameState === STATE.GAMEOVER) {
      e.preventDefault();
      returnToMenu();
    }
  }
});

window.addEventListener('keyup', (e) => {
  const code = e.code;
  if (code === 'ArrowUp' || code === 'KeyW') state.input.up = false;
  else if (code === 'ArrowDown' || code === 'KeyS') state.input.down = false;
  else if (code === 'ArrowLeft' || code === 'KeyA') state.input.left = false;
  else if (code === 'ArrowRight' || code === 'KeyD') state.input.right = false;
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

// Мультитач-управление
function updateTouchesFromList(touchList) {
  if (state.isPaused || state.gameState !== STATE.PLAYING) {
    clearInputs();
    return;
  }

  const activeIds = new Set();
  const hitSlopPx = 5;

  for (let i = 0; i < touchList.length; i++) {
    const t = touchList[i];
    const tx = t.clientX;
    const ty = t.clientY;

    let bestId = null;
    let bestDistSq = Infinity;

    for (let b = 0; b < touchButtonMap.length; b++) {
      const btnEl = touchButtonMap[b].el;
      if (!btnEl) continue;
      const rect = btnEl.getBoundingClientRect();
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
          bestId = touchButtonMap[b].id;
        }
      }
    }

    if (bestId) activeIds.add(bestId);
  }

  for (let i = 0; i < touchButtonMap.length; i++) {
    const item = touchButtonMap[i];
    const isPressed = activeIds.has(item.id);
    state.input[item.key] = isPressed;
    if (item.el) {
      item.el.classList.toggle('pressed', isPressed);
    }
  }
}

if (touchControls) {
  touchControls.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (state.isPaused || state.gameState !== STATE.PLAYING) {
      clearInputs();
      return;
    }
    audio.init();
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
    state.input[item.key] = true;
    el.classList.add('pressed');
  });
  const releaseMouse = () => {
    state.input[item.key] = false;
    el.classList.remove('pressed');
  };
  el.addEventListener('mouseup', releaseMouse);
  el.addEventListener('mouseleave', releaseMouse);
}

// Главный игровой цикл
function gameLoop(now) {
  const dt = Math.min(GAME_CONFIG.screen.maxFrameDeltaSec, Math.max(0.001, (now - lastTimestamp) / 1000));
  lastTimestamp = now;

  updateSimulation(dt);
  renderFrame(ctx);

  requestAnimationFrame(gameLoop);
}

// Инициализация при запуске
syncSetupButtonsWithConfig();
if (state.gameMode === 'circuit') {
  buildCircuitTrack();
  resetCircuitRivals();
} else {
  buildTrack();
  resetTraffic(INITIAL_TRAFFIC_COUNT);
}
updateStartSubtitle();
updateMobileTopBarState();
resizeCanvas();
requestAnimationFrame(gameLoop);