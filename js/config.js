/**
 * ============================================================================
 * ГЛАВНЫЕ НАСТРОЙКИ И КОНСТАНТЫ ИГРЫ (SUNSET OVERDRIVE '90 — 3D EDITION)
 * ============================================================================
 * Система координат и единицы измерения:
 * - Ось X (поперечная): нормализована относительно полуширины дороги
 *   (-1.0 — левая кромка асфальта, 0.0 — ось трассы, +1.0 — правая кромка).
 *   В мировых координатах: worldX = normX * road.width.
 * - Ось Y (вертикальная): высота рельефа и камеры в мировых единицах.
 * - Ось Z (продольная): дистанция вдоль трассы в мировых единицах
 *   (1 реальный метр = WORLD_UNITS_PER_METER = 146.25 мир. ед.).
 */

/**
 * Рекурсивная заморозка объекта конфигурации (защищает шаблоны машин и ботов от мутаций в рантайме)
 */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    deepFreeze(obj[keys[i]]);
  }
  return obj;
}

/**
 * Компактная фабрика описания ИИ-соперника кольцевого режима (единые габариты спорткара)
 * @param {string} name — позывной гонщика на бейдже и в баннерах
 * @param {string} num — бортовой номер
 * @param {string} primary — основной цвет кузова (#hex)
 * @param {string} secondary — цвет нижней части кузова и акцентов (#hex)
 * @param {number} skill — базовый множитель темпа от MAX_SPEED (0.85..0.97)
 */
const createRival = (name, num, primary, secondary, skill) => ({
  name,
  num,
  primary,
  secondary,
  w: 0.185,   // Нормализованная ширина кузова (доля от полуширины дороги)
  h: 0.96,    // Коэффициент высоты крыши относительно спорт-профиля
  lenZ: 265,  // Продольная длина корпуса в мировых единицах (~1.81 м в масштабе сегментов)
  skill
});

// Стартовая ведомость ИИ-соперников (от самого быстрого лидера к замыкающему)
const CIRCUIT_RIVALS = [
  createRival('VIPER',   '02', '#00f0ff', '#005f73', 0.97),
  createRival('BLAZE',   '03', '#ffbe0b', '#fb5607', 0.95),
  createRival('PHANTOM', '04', '#9b5de5', '#3c096c', 0.93),
  createRival('NITRO',   '05', '#39ff14', '#134e07', 0.91),
  createRival('COBRA',   '06', '#ff5400', '#6a040f', 0.89),
  createRival('PULSE',   '07', '#f72585', '#560bad', 0.87),
  createRival('DRIFT',   '08', '#4cc9f0', '#3a0ca3', 0.85)
];

export const GAME_CONFIG = deepFreeze({
  // Параметры виртуального экрана, камеры и дальности прорисовки
  screen: {
    aspectRatio: 16 / 9,       // Широкоформатное соотношение сторон (ПК и ландшафт смартфона)
    mobileAspectRatio: 4 / 3,  // Соотношение сторон для портретных и узких экранов
    logicalHeight: 540,        // Фиксированное внутреннее вертикальное разрешение канваса (px)
    fieldOfView: 100,          // Базовый угол обзора камеры в градусах (динамически растёт на скорости)
    cameraHeight: 1150,        // Высота подвеса камеры над полотном дороги (мир. ед.)
    drawDistance: 300,         // Дальность отрисовки трассы вперёд (в количестве сегментов)
    fogDensity: 1.6,           // Плотность экспоненциальной дымки у горизонта
    starCount: 65,             // Количество мерцающих звёзд на ночном небе
    maxFrameDeltaSec: 0.05     // Верхний предел шага симуляции dt (50 мс = минимум 20 FPS, защита от туннелирования)
  },

  // Геометрия дорожного полотна
  road: {
    width: 2000,               // Полуширина дорожного полотна от центра до обочины (мир. ед.)
    segmentLength: 200,        // Длина одного сегмента дороги по оси Z (мир. ед.)
    rumbleLength: 5,           // Число сегментов в одной цветной полосе поребрика и пунктира разметки
    checkpointInterval: 450    // Целевой шаг между арками чекпоинтов в шоссейных режимах (в сегментах)
  },

  // Ходовая физика и управляемость автомобиля игрока
  physics: {
    baseMaxKmh: 320,           // Паспортная максимальная скорость целой машины (км/ч)
    speedPenaltyPerHitKmh: 20, // Потеря максимальной скорости за 1 очко урона в шоссейных режимах (км/ч)
    minAllowedMaxKmh: 120,     // Нижний порог, ниже которого максималка не падает даже при сильных повреждениях (км/ч)
    maxReverseKmh: 20,         // Максимальная скорость заднего хода (км/ч)

    accelTimeToMaxSec: 5.2,    // Время разгона с 0 до baseMaxKmh по прямой на полном газу (сек)
    reverseAccelRatio: 0.095,  // Темп разгона задним ходом (доля от MAX_SPEED в секунду)
    // Штатное торможение на асфальте всегда эффективнее пассивного вязкого замедления на обочине (1 / 2.2 ≈ 0.455)
    brakeHighSpeedRatio: 0.48, // Интенсивность торможения на максимальной скорости (доля от MAX_SPEED/сек)
    brakeLowSpeedRatio: 0.60,  // Интенсивность торможения на малой скорости (доля от MAX_SPEED/сек)
    coastDecelDivisor: 10.5,   // Время полной остановки накатом при отпущенном газе (сек)
    offRoadDecelDivisor: 2.2,  // Время гашения скорости вязким грунтом при выезде на обочину (сек)
    offRoadSpeedLimitRatio: 0.34, // Предел скорости при движении по траве/обочине (доля от MAX_SPEED)

    centrifugalForce: 0.34,    // Базовый коэффициент центробежного сноса в поворотах шоссе
    steerSensitivity: 2.05,    // Скорость поперечного смещения при рулении вперёд (норм. ед. X/сек)
    reverseSteerSensitivity: 0.42, // Манёвренность при движении задним ходом (норм. ед. X/сек)
    maxLateralX: 2.35          // Крайняя граница выезда за пределы дороги (норм. ед. X)
  },

  // Правила игры, таймеры, очки, урон и температурный режим двигателя
  gameplay: {
    defaultTrackMode: 'oneway',   // Стартовый режим трассы ('oneway' | 'oncoming' | 'circuit')
    defaultDifficulty: 'arcade',  // Стартовая сложность ('arcade' — Легко | 'hardcore' — Нормально)

    initialTimeSec: 45.0,         // Стартовый запас времени на таймере (сек)
    maxTimeSec: 99.0,             // Максимальный потолок накопленного времени на таймере (сек)
    checkpointBaseBonusSec: 24,   // Бонус времени за первый чекпоинт (плавно убывает с прогрессом)
    checkpointMinBonusSec: 14,    // Минимальный гарантированный бонус времени за чекпоинт (сек)
    checkpointScoreBonus: 500,    // Базовый бонус очков за пересечение чекпоинта (умножается на номер чекпоинта)
    scorePerMeter: 5.85,          // Базовые очки за 1 реальный метр пути (растут со скоростью)
    oncomingScoreMultiplier: 2.0, // Множитель очков за быструю езду по встречной полосе в режиме 'oncoming'

    collisionTimePenaltySec: 5.0, // Штраф времени за столкновение в шоссейных режимах (сек)
    maxHardcoreCollisions: 5,     // Запас прочности кузова в режиме «Нормально» (число единиц урона до тотала)
    headOnInstantWreckKmh: 100,   // Скорость игрока для мгновенного тотала при лобовом ударе со встречкой (км/ч)
    obstacleInstantWreckKmh: 210, // Скорость игрока для мгновенного тотала об опору/пальму/щит (км/ч)

    engineHeatRate: 21,           // Скорость нагрева мотора на полном газу вблизи максималки (%/сек)
    engineCoolRate: 15,           // Скорость штатного остывания мотора при сбросе нагрузки (%/сек)
    engineOverheatCoolRate: 19,   // Скорость принудительного охлаждения в состоянии перегрева (%/сек)
    engineOverheatRecoverPct: 35, // Порог температуры, до которого должен остыть мотор для снятия ограничения (%)
    overheatSpeedCapRatio: 0.54   // Ограничение максимальной скорости во время перегрева (доля от MAX_SPEED)
  },

  // Параметры гражданского трафика (для режимов 'oneway' и 'oncoming')
  traffic: {
    initialCount: 34,             // Начальное количество машин трафика на трассе
    maxCount: 68,                 // Максимальное количество машин при полном уплотнении потока
    metersPerExtraCar: 38,        // Каждые N пройденных метров в поток добавляется +1 машина
    progressionDistanceMeters: 860, // Дистанция, к которой скорость потока выходит на пиковую сложность (м)
    // Шаблоны кузовов гражданских машин (w — норм. ширина, h — множитель высоты, lenZ — длина по Z, speedMult — темп)
    carTypes: [
      { type: 'coupe', w: 0.18, h: 1.00, lenZ: 255, primary: '#00e5ff', secondary: '#0077b6', speedMult: 1.02 },
      { type: 'sport', w: 0.19, h: 0.94, lenZ: 265, primary: '#ffbe0b', secondary: '#fb5607', speedMult: 1.18 },
      { type: 'van',   w: 0.21, h: 1.28, lenZ: 295, primary: '#9b5de5', secondary: '#5a189a', speedMult: 0.80 },
      { type: 'sedan', w: 0.18, h: 1.04, lenZ: 260, primary: '#39ff14', secondary: '#1b7a0a', speedMult: 0.94 }
    ]
  },

  // Параметры кольцевой гонки с соперниками (режим 'circuit')
  circuit: {
    totalLaps: 3,                 // Количество кругов в заезде
    rivalsCount: CIRCUIT_RIVALS.length, // Число активных ИИ-соперников на стартовой решётке
    minSegments: 520,             // Минимальная длина процедурно генерируемого кольца (в сегментах)
    maxSegments: 660,             // Максимальная длина процедурно генерируемого кольца (в сегментах)
    countdownSec: 2.7,            // Длительность предстартового отсчёта «3-2-1» на решётке (сек)
    finishGraceSec: 15.0,         // Льготное время на финиш после того, как первый соперник закончил гонку (сек)
    impactSlowdownRatio: 0.85,    // Сохраняемая доля скорости при боковом контакте с соперником
    rearBumpSlowdownRatio: 0.78,  // Сохраняемая доля скорости игрока при ударе сопернику в задний бампер
    obstacleSlowdownRatio: 0.45,  // Сохраняемая доля скорости при ударе о придорожный объект (в кольце машина не бьётся)
    guardrailCurveThreshold: 4.5, // Порог крутизны поворота для установки защитных отбойников в режиме «Легко»
    botMistakeChance: 0.28,       // Базовая вероятность ошибки бота (позднее торможение / широкий вход) перед крутым виражом
    botBumpChance: 0.35,          // Вероятность жёсткого силового контакта при сближении двух ботов
    slipstreamBoostRatio: 1.05,   // Прибавка к максимальной скорости в воздушном мешке за соперником (+5%)
    rivals: CIRCUIT_RIVALS
  },

  // Визуальная геометрия и эффекты машины игрока
  playerVisuals: {
    hitboxWidthNorm: 0.185,       // Поперечный физический и визуальный габарит машины игрока (доля полуширины дороги)
    rearTireBottomOffsetPx: 25,   // Отступ пятна контакта задних шин от нижнего края экрана (px)
    carCenterBottomOffsetPx: 54,  // Отступ проекционного центра машины от нижнего края экрана (px)
    maxSkidMarks: 640,            // Размер кольцевого буфера сегментов тормозного следа на асфальте
    tireSmokeMinKmh: 50           // Минимальная скорость для появления клубов дыма из-под шин (км/ч)
  },

  // Настройки графики и звука по умолчанию (переопределяются сохранением игрока из localStorage)
  settings: {
    language: 'ru',               // Язык интерфейса и HUD: 'ru' (Русский) | 'en' (English)
    particlesEnabled: true,       // Отрисовка дыма, пыли обочины и искр
    lightStyle: 'hard',           // Стиль света и теней: 'hard' (чёткий ретро-стиль) | 'soft' (мягкие градиенты и ореолы)
    soundEnabled: true,           // Глобальное включение процедурного звука Web Audio API
    showFps: false                // Отображение диагностического счётчика кадров в секунду
  },

  // Префиксы ключей для сохранения рекордов и настроек в localStorage браузера
  storage: {
    bestScoreKey: 'sunset_overdrive_best',
    bestLapSpeedKey: 'sunset_overdrive_best_lap_kmh',
    settingsKey: 'sunset_overdrive_settings'
  }
});

// Перечисление глобальных состояний игрового экрана
export const STATE = Object.freeze({
  TITLE: 0,    // Главное меню и экран настроек (фоновый демо-пролёт по трассе)
  PLAYING: 1,  // Активный заезд (включая предстартовый отсчёт и паузу)
  GAMEOVER: 2  // Экран итогов заезда (камера уезжает вперёд или показывает разбитую машину)
});

// ============================================================================
// ПРОИЗВОДНЫЕ КОНСТАНТЫ (ВЫЧИСЛЯЮТСЯ АВТОМАТИЧЕСКИ ИЗ GAME_CONFIG)
// ============================================================================

// Базовые размеры проекционной плоскости (привязаны к эталонному формату 16:9, чтобы обзор по высоте не плавал)
export const LOGICAL_HEIGHT = GAME_CONFIG.screen.logicalHeight;
export const PROJ_HALF_WIDTH = LOGICAL_HEIGHT * GAME_CONFIG.screen.aspectRatio * 0.5;

// Быстрые алиасы геометрии трассы и камеры для горячих циклов рендера и физики
export const ROAD_WIDTH = GAME_CONFIG.road.width;
export const SEGMENT_LENGTH = GAME_CONFIG.road.segmentLength;
export const RUMBLE_LENGTH = GAME_CONFIG.road.rumbleLength;
export const BASE_FOV = GAME_CONFIG.screen.fieldOfView;
export const CAMERA_HEIGHT = GAME_CONFIG.screen.cameraHeight;
export const DRAW_DISTANCE = GAME_CONFIG.screen.drawDistance;
export const FOG_DENSITY = GAME_CONFIG.screen.fogDensity;
export const CHECKPOINT_INTERVAL = GAME_CONFIG.road.checkpointInterval;

// Продольные габариты игрока и дистанции реакций ИИ / света фар по оси Z (в мировых единицах)
export const PLAYER_LEN_Z = SEGMENT_LENGTH * 1.325;         // Полная длина кузова игрока (265 мир. ед.)
export const PLAYER_CENTER_OFFSET_Z = SEGMENT_LENGTH * 0.325; // Смещение центра массы игрока вперёд от базовой точки PLAYER_Z
export const TRAFFIC_SCAN_DIST_Z = SEGMENT_LENGTH * 9.75;   // Дальность обзора впереди идущих помех для ИИ трафика
export const HEADLIGHT_BEAM_DIST_Z = SEGMENT_LENGTH * 21.0; // Длина светового конуса фар игрока на полотне
export const ONCOMING_DETECT_DIST_Z = SEGMENT_LENGTH * 21.0; // Дистанция, с которой встречка замечает игрока на своей полосе и моргает дальним
export const ONCOMING_HORN_DIST_Z = SEGMENT_LENGTH * 17.0;  // Дистанция подачи звукового сигнала встречным автомобилем

// Эталонный физический масштаб перевода км/ч в мировые единицы в секунду:
// при 320 км/ч (88.89 м/с) машина проходит 65 сегментов по 200 ед. (13 000 ед./с) => 1 м = 146.25 мир. ед.
const REFERENCE_SPEED_KMH = 320;
const SEGMENTS_PER_SEC_AT_REF = 65;
export const WORLD_SPEED_SCALE = (SEGMENT_LENGTH * SEGMENTS_PER_SEC_AT_REF) / REFERENCE_SPEED_KMH;
export const WORLD_UNITS_PER_METER = WORLD_SPEED_SCALE * 3.6;

// Производные скоростные лимиты и ускорения автомобиля (в мировых единицах в секунду и ед./с²)
export const BASE_MAX_KMH = GAME_CONFIG.physics.baseMaxKmh;
export const SPEED_PENALTY_PER_COLLISION_KMH = GAME_CONFIG.physics.speedPenaltyPerHitKmh;
export const MIN_ALLOWED_MAX_KMH = GAME_CONFIG.physics.minAllowedMaxKmh;
export const MAX_SPEED = BASE_MAX_KMH * WORLD_SPEED_SCALE;
export const MAX_REVERSE_SPEED = GAME_CONFIG.physics.maxReverseKmh * WORLD_SPEED_SCALE;
export const ACCEL = MAX_SPEED / GAME_CONFIG.physics.accelTimeToMaxSec;
export const REVERSE_ACCEL = MAX_SPEED * GAME_CONFIG.physics.reverseAccelRatio;
export const BRAKE_HIGH_SPEED = -MAX_SPEED * GAME_CONFIG.physics.brakeHighSpeedRatio;
export const BRAKE_LOW_SPEED = -MAX_SPEED * GAME_CONFIG.physics.brakeLowSpeedRatio;
export const DECEL = -MAX_SPEED / GAME_CONFIG.physics.coastDecelDivisor;
export const OFF_ROAD_DECEL = -MAX_SPEED / GAME_CONFIG.physics.offRoadDecelDivisor;
export const OFF_ROAD_LIMIT = MAX_SPEED * GAME_CONFIG.physics.offRoadSpeedLimitRatio;
export const CENTRIFUGAL_FORCE = GAME_CONFIG.physics.centrifugalForce;
export const STEER_SENSITIVITY = GAME_CONFIG.physics.steerSensitivity;
export const REVERSE_STEER_SENSITIVITY = GAME_CONFIG.physics.reverseSteerSensitivity;
export const PLAYER_MAX_LATERAL_X = GAME_CONFIG.physics.maxLateralX;
export const OFF_ROAD_THRESHOLD_X = 1.14; // Порог |playerX| за внешним краем поребрика, с которого начинается трава/обочина

// Быстрые константы правил заезда, рекордов и генератора трафика
export const COLLISION_TIME_PENALTY = GAME_CONFIG.gameplay.collisionTimePenaltySec;
export const SCORE_PER_METER = GAME_CONFIG.gameplay.scorePerMeter;
export const MAX_SKID_MARKS = GAME_CONFIG.playerVisuals.maxSkidMarks;
export const INITIAL_TRAFFIC_COUNT = GAME_CONFIG.traffic.initialCount;
export const MAX_TRAFFIC_COUNT = GAME_CONFIG.traffic.maxCount;
export const METERS_PER_EXTRA_CAR = GAME_CONFIG.traffic.metersPerExtraCar;
export const TRAFFIC_PROGRESSION_METERS = GAME_CONFIG.traffic.progressionDistanceMeters;
export const MAX_HARDCORE_COLLISIONS = GAME_CONFIG.gameplay.maxHardcoreCollisions;
export const PLAYER_WIDTH_NORM = GAME_CONFIG.playerVisuals.hitboxWidthNorm;
export const CAR_TYPES = GAME_CONFIG.traffic.carTypes;

// Перспективная привязка дистанции машины игрока от камеры (PLAYER_Z) и расчёт ширины следов шин:
// вычисляем, на каком удалении Z точка на полотне проецируется ровно в заданный экранный отступ от низа
const halfLogicalH = LOGICAL_HEIGHT * 0.5;
const baseCameraDepth = 1 / Math.tan((BASE_FOV * 0.5) * Math.PI / 180);
const carCenterNormY = (halfLogicalH - GAME_CONFIG.playerVisuals.carCenterBottomOffsetPx) / halfLogicalH;
const rearTireScale = ((halfLogicalH - GAME_CONFIG.playerVisuals.rearTireBottomOffsetPx) / halfLogicalH) / CAMERA_HEIGHT;

export const PLAYER_Z = (CAMERA_HEIGHT * baseCameraDepth) / carCenterNormY; // Дистанция от камеры до базовой точки машины
export const WHEEL_TRACK_OFFSET = PLAYER_WIDTH_NORM * 0.375;                // Смещение левой/правой колеи от центра кузова (норм. X)
export const WHEEL_SKID_HALF_W = 11.5 / (rearTireScale * ROAD_WIDTH * PROJ_HALF_WIDTH); // Полуширина одного следа шины (норм. X)