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

export function queryTouchDevice() {
  return window.matchMedia('(pointer: coarse), (hover: none), (max-width: 900px)').matches;
}

export function isNarrowScreen() {
  return window.innerWidth < window.innerHeight || window.innerWidth <= 768;
}

export function getActiveAspectRatio() {
  return isNarrowScreen()
    ? GAME_CONFIG.screen.mobileAspectRatio
    : GAME_CONFIG.screen.aspectRatio;
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
  isPaused: false,
  gameMode: GAME_CONFIG.gameplay.defaultTrackMode,
  difficulty: GAME_CONFIG.gameplay.defaultDifficulty,
  animClockMs: 0,
  frameCounter: 0,
  fpsValue: 0,

  // Пользовательские настройки (графика и звук)
  settings: {
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
  particles: [],
  stars: [],
  skidMarksList: [],
  prevSkidSample: null,

  // Экранные якоря 3D-модели машины игрока
  playerScreenAnchors: {
    rearCenterX: initialLogicalWidth * 0.5,
    rearCenterY: LOGICAL_HEIGHT - 36,
    rearGroundY: LOGICAL_HEIGHT - 16,
    centerX: initialLogicalWidth * 0.5,
    centerY: LOGICAL_HEIGHT - 44,
    hoodY: LOGICAL_HEIGHT - 60,
    carW: 120,
    carH: 66,
    leftWheelX: initialLogicalWidth * 0.5 - 45,
    leftWheelY: LOGICAL_HEIGHT - 18,
    rightWheelX: initialLogicalWidth * 0.5 + 45,
    rightWheelY: LOGICAL_HEIGHT - 18,
    exhaustLeftX: initialLogicalWidth * 0.5 - 30,
    exhaustRightX: initialLogicalWidth * 0.5 + 30,
    exhaustY: LOGICAL_HEIGHT - 28
  },

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
  timeLeft: GAME_CONFIG.gameplay.initialTimeSec,
  score: 0,
  bestScore: 0,
  bestLapRecordKmh: null,
  distanceMeters: 0,
  checkpointsPassed: 0,
  maxKmhReached: 0,

  // Динамика 3D-камеры
  cameraPitch: 0,
  cameraLagX: 0,
  cameraRoll: 0,
  currentFov: BASE_FOV - 4,
  activeCameraDepth: 1 / Math.tan(((BASE_FOV - 4) / 2) * Math.PI / 180),

  // Кольцевой заезд
  circuitSeedId: 1000,
  circuitTotalLaps: GAME_CONFIG.circuit.totalLaps,
  circuitCurrentLap: 1,
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
  isSlipstreaming: false,
  minimapCacheKey: '',

  // Прогресс вперед в режимах трафика и для защиты одометра
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

  // Центральный баннер уведомлений
  bannerText: '',
  bannerColor: '#ffbe0b',
  bannerTimer: 0,

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
 * Раздельный ключ рекорда средней скорости круга по уровню сложности.
 * Также автоматически изолирует новые физически точные рекорды от старых завышенных записей.
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
    if (savedLapKmh > 0 && isFinite(savedLapKmh)) {
      state.bestLapRecordKmh = savedLapKmh;
    } else {
      // Явно сбрасываем значение, чтобы при переключении сложности не залипал чужой рекорд
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
  return (
    state.gameMode === 'oncoming' &&
    state.playerX < -0.06 &&
    Math.abs(state.playerX) <= OFF_ROAD_THRESHOLD_X &&
    state.speed / MAX_SPEED > 0.45
  );
}

export function getSunX() {
  return state.logicalWidth * 0.5 - Math.sin(state.skyOffset * Math.PI * 2) * 160;
}

export function getPlayerWorldZ() {
  return (((state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z) % state.trackLength) + state.trackLength) % state.trackLength;
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
  if (!state.segments.length) return null;
  const wrappedZ = ((z % state.trackLength) + state.trackLength) % state.trackLength;
  const idx = Math.floor(wrappedZ / SEGMENT_LENGTH) % state.segments.length;
  return state.segments[idx];
}

export function resetPlayerScreenAnchors() {
  const cx = state.logicalWidth * 0.5;
  const a = state.playerScreenAnchors;
  a.rearCenterX = cx;
  a.rearCenterY = LOGICAL_HEIGHT - 36;
  a.rearGroundY = LOGICAL_HEIGHT - 16;
  a.centerX = cx;
  a.centerY = LOGICAL_HEIGHT - 44;
  a.hoodY = LOGICAL_HEIGHT - 60;
  a.carW = 120;
  a.carH = 66;
  a.leftWheelX = cx - 45;
  a.leftWheelY = LOGICAL_HEIGHT - 18;
  a.rightWheelX = cx + 45;
  a.rightWheelY = LOGICAL_HEIGHT - 18;
  a.exhaustLeftX = cx - 30;
  a.exhaustRightX = cx + 30;
  a.exhaustY = LOGICAL_HEIGHT - 28;
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
  for (let i = 0; i < count; i++) {
    state.particles.push({
      x: x + (Math.random() - 0.5) * 18,
      y: y + (Math.random() - 0.5) * 8,
      vx: (Math.random() - 0.5) * vxSpread,
      vy: -vyBase * (0.45 + Math.random() * 0.75),
      size: sizeRange[0] + Math.random() * (sizeRange[1] - sizeRange[0]),
      life: lifeRange[0] + Math.random() * (lifeRange[1] - lifeRange[0]),
      maxLife: lifeRange[1],
      color: color,
      gravity: gravity,
      expandRate: expandRate
    });
  }
}

export function resetRunState() {
  state.isPaused = false;
  state.isSlipstreaming = false;

  state.position = 0;
  state.playerX = 0;
  state.playerVX = 0;
  state.speed = 0;
  state.steerVisual = 0;
  state.stoppedPlayerZ = 0;
  state.stoppedPlayerX = 0;
  state.stoppedPlayerYaw = 0;
  state.playerCarPassedByCamera = false;

  state.cameraPitch = 0;
  state.cameraLagX = 0;
  state.cameraRoll = 0;
  state.currentFov = BASE_FOV - 4;
  state.activeCameraDepth = 1 / Math.tan((state.currentFov / 2) * Math.PI / 180);

  state.timeLeft = GAME_CONFIG.gameplay.initialTimeSec;
  state.score = 0;
  state.distanceMeters = 0;
  state.checkpointsPassed = 0;
  state.maxKmhReached = 0;

  state.circuitCurrentLap = 1;
  state.circuitTotalLaps = GAME_CONFIG.circuit.totalLaps;
  state.playerProgressZ = 0;
  state.raceElapsedTime = 0;
  state.currentLapStartTime = 0;
  state.bestLapTime = null;
  state.bestLapAvgKmh = null;
  state.playerRank = 1;
  state.raceCountdownTimer = 0;
  state.lastCountdownDigit = 0;
  state.rivalsFinishedCount = 0;
  state.raceFinishCountdown = 0;

  state.netForwardZ = PLAYER_Z + PLAYER_CENTER_OFFSET_Z;
  state.maxNetForwardZ = PLAYER_Z + PLAYER_CENTER_OFFSET_Z;
  state.passedCheckpointUids = new Set();

  state.collisionCount = 0;
  state.collisionsLeft = MAX_HARDCORE_COLLISIONS;
  state.visualDamage = 0;
  state.frontDamage = 0;
  state.leftDamage = 0;
  state.rightDamage = 0;
  state.rearDamage = 0;
  state.spoilerDamageSide = 0;
  state.engineMisfireTimer = 0;
  state.engineMisfireCooldown = 0;
  state.engineHeat = 0;
  state.isOverheated = false;
  state.heatWarnCooldown = 0;
  state.spriteHitCooldown = 0;
  state.guardrailSoundCooldown = 0;
  state.offRoadWarnCooldown = 0;
  state.impactShake = 0;
  state.timePenaltyFlash = 0;

  state.particles = [];
  state.bannerText = '';
  state.bannerTimer = 0;

  resetPlayerScreenAnchors();
  clearSkidMarks();
}