import {
  GAME_CONFIG,
  STATE,
  LOGICAL_HEIGHT,
  BASE_FOV,
  SEGMENT_LENGTH,
  PLAYER_Z,
  PLAYER_CENTER_OFFSET_Z,
  BASE_MAX_KMH,
  MAX_SPEED,
  OFF_ROAD_THRESHOLD_X,
  SPEED_PENALTY_PER_COLLISION_KMH,
  MIN_ALLOWED_MAX_KMH,
  MAX_HARDCORE_COLLISIONS
} from './config.js';
import { MathUtil } from './utils.js';

// Верхний предел активных частиц (исключает просадки FPS при интенсивном дыме и искрах)
const MAX_PARTICLES = 260;

export function queryTouchDevice() {
  return window.matchMedia('(pointer: coarse), (hover: none), (max-width: 900px)').matches;
}

/**
 * Определяет узкий/портретный экран по реальному соотношению сторон окна
 * (смартфоны в ландшафтной ориентации сохраняют широкий обзор 16:9)
 */
export function isNarrowScreen() {
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  return aspect < 1.35;
}

export function getActiveAspectRatio() {
  return isNarrowScreen()
    ? GAME_CONFIG.screen.mobileAspectRatio
    : GAME_CONFIG.screen.aspectRatio;
}

function createPlayerScreenAnchors(logicalWidth) {
  const cx = logicalWidth * 0.5;
  const centerY = LOGICAL_HEIGHT - GAME_CONFIG.playerVisuals.carCenterBottomOffsetPx;
  const tireY = LOGICAL_HEIGHT - GAME_CONFIG.playerVisuals.rearTireBottomOffsetPx;
  return {
    rearCenterX: cx,
    rearCenterY: centerY + 8,
    rearGroundY: tireY + 2,
    centerX: cx,
    centerY: centerY,
    hoodY: centerY - 16,
    carW: 120,
    carH: 66,
    leftWheelX: cx - 45,
    leftWheelY: tireY,
    rightWheelX: cx + 45,
    rightWheelY: tireY,
    exhaustLeftX: cx - 30,
    exhaustRightX: cx + 30,
    exhaustY: tireY - 6
  };
}

/**
 * Единый источник начальных значений параметров заезда (используется и при старте, и в resetRunState)
 */
function createInitialRunState() {
  const startFov = BASE_FOV - 4;
  return {
    isPaused: false,
    isSlipstreaming: false,

    // Позиция, физика и статистика игрока
    position: 0,
    playerX: 0,
    playerVX: 0,
    speed: 0,
    steerVisual: 0,
    // Мировые координаты машины игрока на момент завершения заезда (камера продолжает путь без неё)
    stoppedPlayerZ: 0,
    stoppedPlayerX: 0,
    stoppedPlayerYaw: 0,
    playerCarPassedByCamera: false,

    // Динамика 3D-камеры
    cameraPitch: 0,
    cameraLagX: 0,
    cameraRoll: 0,
    currentFov: startFov,
    activeCameraDepth: 1 / Math.tan((startFov * 0.5) * Math.PI / 180),

    // Таймеры и статистика
    timeLeft: GAME_CONFIG.gameplay.initialTimeSec,
    score: 0,
    distanceMeters: 0,
    checkpointsPassed: 0,
    maxKmhReached: 0,

    // Кольцевой заезд
    circuitCurrentLap: 1,
    circuitTotalLaps: GAME_CONFIG.circuit.totalLaps,
    playerProgressZ: 0,
    raceElapsedTime: 0,
    currentLapStartTime: 0,
    bestLapTime: null,
    bestLapAvgKmh: null,
    playerRank: 1,
    raceCountdownTimer: 0,
    lastCountdownDigit: 0,
    rivalsFinishedCount: 0,
    raceFinishCountdown: 0,

    // Прогресс вперёд и защита одометра от заднего хода
    netForwardZ: PLAYER_Z + PLAYER_CENTER_OFFSET_Z,
    maxNetForwardZ: PLAYER_Z + PLAYER_CENTER_OFFSET_Z,
    passedCheckpointUids: new Set(),

    // Повреждения, перегрев и таймеры эффектов
    collisionCount: 0,
    collisionsLeft: MAX_HARDCORE_COLLISIONS,
    visualDamage: 0,
    frontDamage: 0,
    leftDamage: 0,
    rightDamage: 0,
    rearDamage: 0,
    // Зафиксированная сторона повреждения спойлера (0 — целый, -1 — левая, 1 — правая)
    spoilerDamageSide: 0,
    engineMisfireTimer: 0,
    engineMisfireCooldown: 0,
    engineHeat: 0,
    isOverheated: false,
    heatWarnCooldown: 0,
    spriteHitCooldown: 0,
    guardrailSoundCooldown: 0,
    offRoadWarnCooldown: 0,
    impactShake: 0,
    timePenaltyFlash: 0,

    // Параллакс фона
    skyOffset: 0,
    hillOffset: 0,
    cityOffset: 0,

    // Эффекты и центральный баннер уведомлений
    particles: [],
    bannerText: '',
    bannerColor: '#ffbe0b',
    bannerTimer: 0
  };
}

const initialAspect = getActiveAspectRatio();
const initialLogicalWidth = Math.round(LOGICAL_HEIGHT * initialAspect);

/**
 * Единое разделяемое состояние игры
 */
export const state = {
  // Экран и рендер
  aspectRatio: initialAspect,
  logicalWidth: initialLogicalWidth,
  cachedIsTouch: queryTouchDevice(),

  // Режимы и таймеры цикла
  gameState: STATE.TITLE,
  gameMode: GAME_CONFIG.gameplay.defaultTrackMode,
  difficulty: GAME_CONFIG.gameplay.defaultDifficulty,
  animClockMs: 0,
  frameCounter: 0,
  fpsValue: 0,
  // Пользовательские настройки (язык, графика и звук)
  settings: {
    language: GAME_CONFIG.settings.language,
    particlesEnabled: GAME_CONFIG.settings.particlesEnabled,
    lightStyle: GAME_CONFIG.settings.lightStyle,
    soundEnabled: GAME_CONFIG.settings.soundEnabled,
    showFps: GAME_CONFIG.settings.showFps
  },

  // Мир и сущности
  segments: [],
  trackLength: 0,
  cars: [],
  rivals: [],
  stars: [],
  skidMarksList: [],
  prevSkidSample: null,

  // Постоянные рекорды и кэш миникарты
  bestScore: 0,
  bestLapRecordKmh: null,
  circuitSeedId: 1000,
  minimapCacheKey: '',

  // Экранные якоря 3D-модели машины игрока
  playerScreenAnchors: createPlayerScreenAnchors(initialLogicalWidth),

  // Поля текущего заезда
  ...createInitialRunState(),

  // Состояние ввода
  input: {
    up: false,
    down: false,
    left: false,
    right: false
  },

  // Колбэк завершения игры (назначается в main.js во избежание циклических импортов)
  onGameOver: null
};

export function initStars() {
  state.stars = [];
  for (let i = 0; i < GAME_CONFIG.screen.starCount; i++) {
    state.stars.push({
      x: Math.random(),
      y: Math.random() * 0.45,
      r: 0.7 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2
    });
  }
}

export function getBestScoreStorageKey() {
  return `${GAME_CONFIG.storage.bestScoreKey}_${state.gameMode}_${state.difficulty}`;
}

/**
 * Раздельный ключ рекорда средней скорости круга по уровню сложности
 */
export function getBestLapStorageKey() {
  return `${GAME_CONFIG.storage.bestLapSpeedKey}_${state.difficulty}`;
}

export function loadSavedRecords() {
  try {
    const modeKey = getBestScoreStorageKey();
    const saved = localStorage.getItem(modeKey);
    state.bestScore = parseInt(saved || '0', 10) || 0;
  } catch (e) {
    state.bestScore = 0;
  }

  try {
    const lapKey = getBestLapStorageKey();
    const savedLapKmh = parseFloat(localStorage.getItem(lapKey) || '0');
    if (savedLapKmh > 0 && Number.isFinite(savedLapKmh)) {
      state.bestLapRecordKmh = savedLapKmh;
    } else {
      state.bestLapRecordKmh = null;
    }
  } catch (e) {
    state.bestLapRecordKmh = null;
  }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(GAME_CONFIG.storage.settingsKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.language === 'ru' || parsed.language === 'en') {
      state.settings.language = parsed.language;
    }
    if (typeof parsed.particlesEnabled === 'boolean') {
      state.settings.particlesEnabled = parsed.particlesEnabled;
    }
    if (parsed.lightStyle === 'hard' || parsed.lightStyle === 'soft') {
      state.settings.lightStyle = parsed.lightStyle;
    }
    if (typeof parsed.soundEnabled === 'boolean') {
      state.settings.soundEnabled = parsed.soundEnabled;
    }
    if (typeof parsed.showFps === 'boolean') {
      state.settings.showFps = parsed.showFps;
    }
  } catch (e) {}
}

export function saveSettings() {
  try {
    localStorage.setItem(GAME_CONFIG.storage.settingsKey, JSON.stringify(state.settings));
  } catch (e) {}
}

export function isOncomingBonusActive() {
  if (state.gameMode !== 'oncoming') return false;
  if (state.playerX >= -0.06 || Math.abs(state.playerX) > OFF_ROAD_THRESHOLD_X) return false;

  // Порог бонуса масштабируется от текущего лимита скорости, чтобы на повреждённой машине в «Легко» бонус оставался доступен
  const currentMaxSpeed = MAX_SPEED * (getCurrentMaxAllowedKmh() / BASE_MAX_KMH);
  return currentMaxSpeed > 0 && state.speed > currentMaxSpeed * 0.45;
}

export function getSunX() {
  return state.logicalWidth * 0.5 - Math.sin(state.skyOffset * Math.PI * 2) * 160;
}

export function getPlayerWorldZ() {
  if (state.trackLength <= 0) return 0;
  return MathUtil.wrap(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z, state.trackLength);
}

export function getCurrentMaxAllowedKmh() {
  if (state.gameMode === 'circuit') return BASE_MAX_KMH;
  return Math.max(
    MIN_ALLOWED_MAX_KMH,
    BASE_MAX_KMH - state.collisionCount * SPEED_PENALTY_PER_COLLISION_KMH
  );
}

export function showBanner(text, color = '#ffbe0b', duration = 2.0) {
  state.bannerText = text;
  state.bannerColor = color;
  state.bannerTimer = duration;
}

export function findSegment(z) {
  const len = state.segments.length;
  if (!len || !Number.isFinite(z)) return null;
  const idx = ((Math.floor(z / SEGMENT_LENGTH) % len) + len) % len;
  return state.segments[idx];
}

export function resetPlayerScreenAnchors() {
  Object.assign(state.playerScreenAnchors, createPlayerScreenAnchors(state.logicalWidth));
}

export function clearSkidMarks() {
  state.skidMarksList = [];
  state.prevSkidSample = null;
  for (let i = 0; i < state.segments.length; i++) {
    state.segments[i].skidMarks = [];
  }
  for (let i = 0; i < state.rivals.length; i++) {
    state.rivals[i].prevSkidSample = null;
  }
}

export function spawnParticles(
  x,
  y,
  count,
  color,
  vxSpread,
  vyBase,
  sizeRange,
  lifeRange,
  gravity = 260,
  expandRate = 0
) {
  if (!state.settings.particlesEnabled) return;
  const available = MAX_PARTICLES - state.particles.length;
  if (available <= 0) return;

  const spawnCount = Math.min(count, available);
  for (let i = 0; i < spawnCount; i++) {
    const life = lifeRange[0] + Math.random() * (lifeRange[1] - lifeRange[0]);
    state.particles.push({
      x: x + (Math.random() - 0.5) * 18,
      y: y + (Math.random() - 0.5) * 8,
      vx: (Math.random() - 0.5) * vxSpread,
      vy: -vyBase * (0.45 + Math.random() * 0.75),
      size: sizeRange[0] + Math.random() * (sizeRange[1] - sizeRange[0]),
      life: life,
      // maxLife равен фактическому времени жизни частицы, чтобы затухание прозрачности всегда шло от 1.0 до 0.0
      maxLife: life,
      color: color,
      gravity: gravity,
      expandRate: expandRate
    });
  }
}

export function resetRunState() {
  Object.assign(state, createInitialRunState());
  resetPlayerScreenAnchors();
  clearSkidMarks();
}