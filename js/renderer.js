import {
  STATE,
  LOGICAL_HEIGHT,
  PROJ_HALF_WIDTH,
  ROAD_WIDTH,
  SEGMENT_LENGTH,
  CAMERA_HEIGHT,
  DRAW_DISTANCE,
  FOG_DENSITY,
  PLAYER_Z,
  PLAYER_CENTER_OFFSET_Z,
  PLAYER_LEN_Z,
  MAX_HARDCORE_COLLISIONS
} from './config.js';
import { MathUtil, getShortestTrackDz } from './utils.js';
import { state, findSegment } from './state.js';
import { renderHUD } from './hud.js';
import {
  MIN_SAMPLE_CAM_Z,
  MIN_GUARDRAIL_CAM_Z,
  MIN_SPRITE_CAM_Z,
  MIN_CAR_CAM_Z,
  project,
  renderBackground,
  renderSegment,
  renderRoadHeadlights,
  renderGuardrail,
  renderOverheadArchPillarsClipped,
  renderOverheadArchBeam,
  renderSprite
} from './renderWorld.js';
import { renderTrafficCar, renderPlayerCar } from './renderCars.js';

// Кэши разобранных цветов и запечённых offscreen-спрайтов мягких частиц
const particleColorCache = new Map();
const softParticleSpriteCache = new Map();
const SOFT_PARTICLE_TEX_SIZE = 48;

// Постоянные пулы объектов переднего плана (устраняют ежекадровые аллокации в куче при проезде арок и обгонах)
const _fgCarPool = [];
const _foregroundCars = [];

const _archBeamPool = [];
const _foregroundArchBeams = [];
const _segArchBeams = [];

const _segCarsScratch = [];

/**
 * Выдаёт переиспользуемый слот для сортировки машин переднего плана (0 аллокаций после прогрева)
 */
function pushForegroundCar(car, isParkedPlayer, carCamZ) {
  const idx = _foregroundCars.length;
  let slot = _fgCarPool[idx];
  if (!slot) {
    slot = { car: null, isParkedPlayer: false, carCamZ: 0 };
    _fgCarPool.push(slot);
  }
  slot.car = car;
  slot.isParkedPlayer = isParkedPlayer;
  slot.carCamZ = carCamZ;
  _foregroundCars.push(slot);
}

/**
 * Выдаёт переиспользуемый слот параметров арки старта/чекпоинта (0 аллокаций после прогрева)
 */
function allocArchBeamSlot(poolIdx, scale, x, y, clip, isStartFinish, camZ, drawPillars) {
  let slot = _archBeamPool[poolIdx];
  if (!slot) {
    slot = {
      scale: 0,
      x: 0,
      y: 0,
      clip: LOGICAL_HEIGHT,
      isStartFinish: false,
      camZ: 0,
      drawPillars: false
    };
    _archBeamPool.push(slot);
  }
  slot.scale = scale;
  slot.x = x;
  slot.y = y;
  slot.clip = clip;
  slot.isStartFinish = isStartFinish;
  slot.camZ = camZ;
  slot.drawPillars = drawPillars;
  return slot;
}

// Статичные функции-компараторы (исключают создание стрелочных замыканий на каждом вызове Array.sort)
function compareSegCarsFarToNear(a, b) {
  return b._frameCamZ - a._frameCamZ;
}

function compareForegroundCarsFarToNear(a, b) {
  return b.carCamZ - a.carCamZ;
}

function compareArchBeamsFarToNear(a, b) {
  return b.camZ - a.camZ;
}

/**
 * Разбор цвета частицы (#hex или rgba) с кэшированием результата для мягких радиальных спрайтов
 */
function parseParticleColor(color) {
  const cached = particleColorCache.get(color);
  if (cached) return cached;

  let parsed = { r: 220, g: 220, b: 230, a: 0.7, isLuminous: false, spriteKey: '220,220,230,0' };
  if (typeof color === 'string') {
    if (color.charCodeAt(0) === 35 && color.length === 7) {
      const num = parseInt(color.slice(1), 16);
      if (!Number.isNaN(num)) {
        const lower = color.toLowerCase();
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        const isLuminous = lower === '#ffbe0b' || lower === '#ff7b00';
        parsed = { r, g, b, a: 1.0, isLuminous, spriteKey: `${r},${g},${b},${isLuminous ? 1 : 0}` };
      }
    } else if (color.startsWith('rgba(') || color.startsWith('rgb(')) {
      const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (m) {
        const r = Math.round(Number(m[1]));
        const g = Math.round(Number(m[2]));
        const b = Math.round(Number(m[3]));
        const a = m[4] !== undefined ? Number(m[4]) : 1.0;
        parsed = { r, g, b, a, isLuminous: false, spriteKey: `${r},${g},${b},0` };
      }
    }
  }

  if (particleColorCache.size > 256) {
    particleColorCache.clear();
  }
  particleColorCache.set(color, parsed);
  return parsed;
}

/**
 * Кэшированный offscreen-спрайт мягкой частицы (заменяет сотни вызовов createRadialGradient за кадр)
 */
function getSoftParticleSprite(c) {
  let sprite = softParticleSpriteCache.get(c.spriteKey);
  if (sprite) return sprite;

  const size = SOFT_PARTICLE_TEX_SIZE;
  const half = size * 0.5;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const octx = off.getContext('2d');
  if (octx) {
    const grad = octx.createRadialGradient(half, half, half * 0.07, half, half, half);
    if (c.isLuminous) {
      grad.addColorStop(0.0, 'rgba(255, 253, 232, 0.96)');
      grad.addColorStop(0.32, `rgba(${c.r}, ${c.g}, ${c.b}, 0.72)`);
      grad.addColorStop(0.70, `rgba(${c.r}, ${Math.round(c.g * 0.55)}, 0, 0.22)`);
      grad.addColorStop(1.0, `rgba(${c.r}, ${Math.round(c.g * 0.4)}, 0, 0.0)`);
    } else {
      grad.addColorStop(0.0, `rgba(${c.r}, ${c.g}, ${c.b}, 0.92)`);
      grad.addColorStop(0.45, `rgba(${c.r}, ${c.g}, ${c.b}, 0.46)`);
      grad.addColorStop(1.0, `rgba(${c.r}, ${c.g}, ${c.b}, 0.0)`);
    }
    octx.fillStyle = grad;
    octx.beginPath();
    octx.arc(half, half, half, 0, Math.PI * 2);
    octx.fill();
  }

  if (softParticleSpriteCache.size > 64) {
    softParticleSpriteCache.clear();
  }
  softParticleSpriteCache.set(c.spriteKey, off);
  return off;
}

/**
 * Отрисовка системы частиц (дым шин, пыль обочины, искры ударов и выхлопа) с отсечением за пределами экрана
 */
function renderParticles(ctx) {
  if (!state.settings.particlesEnabled) return;
  const particles = state.particles;
  if (!particles.length) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const isSoftLight = state.settings.lightStyle === 'soft';

  ctx.save();
  if (isSoftLight) {
    let activeComposite = 'source-over';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const alpha = MathUtil.clamp(p.life / p.maxLife, 0, 1);
      if (alpha <= 0.01) continue;

      const c = parseParticleColor(p.color);
      const r = c.isLuminous
        ? Math.max(2.5, p.size * 2.1)
        : Math.max(2.5, p.size * (p.expandRate > 0 ? 1.5 : 1.3));

      if (p.x + r < -16 || p.x - r > LOGICAL_WIDTH + 16 || p.y + r < -16 || p.y - r > LOGICAL_HEIGHT + 16) {
        continue;
      }

      const targetComposite = c.isLuminous ? 'screen' : 'source-over';
      if (targetComposite !== activeComposite) {
        ctx.globalCompositeOperation = targetComposite;
        activeComposite = targetComposite;
      }

      ctx.globalAlpha = c.isLuminous ? alpha : c.a * alpha;
      ctx.drawImage(getSoftParticleSprite(c), p.x - r, p.y - r, r * 2, r * 2);
    }
  } else {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const alpha = MathUtil.clamp(p.life / p.maxLife, 0, 1);
      if (alpha <= 0.01) continue;

      const r = p.size;
      if (p.x + r < -16 || p.x - r > LOGICAL_WIDTH + 16 || p.y + r < -16 || p.y - r > LOGICAL_HEIGHT + 16) {
        continue;
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      if (r <= 2.2) {
        // Мелкие искры в жёстком режиме рисуются быстрым квадратом без тесселяции окружности
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/**
 * Главный конвейер отрисовки кадра 3D-сцены и HUD
 */
export function renderFrame(ctx) {
  const frameId = ++state.frameCounter;
  const LOGICAL_WIDTH = state.logicalWidth;
  const segments = state.segments;
  const trackLength = state.trackLength;

  // Плавный непрерывный зум крена камеры вместо порогового скачка ctx.scale(1.03, 1.03) на скорости ~100 км/ч.
  // На прямых участках (absRoll <= 1e-5) матрица контекста остаётся единичной для аппаратного ускорения fillRect/clip.
  const absRoll = Math.abs(state.cameraRoll);
  const hasRollTransform = absRoll > 1e-5;
  if (hasRollTransform) {
    const rollZoom = 1 + absRoll * 0.55;
    ctx.save();
    ctx.translate(LOGICAL_WIDTH * 0.5, LOGICAL_HEIGHT * 0.5);
    ctx.rotate(state.cameraRoll);
    ctx.scale(rollZoom, rollZoom);
    ctx.translate(-LOGICAL_WIDTH * 0.5, -LOGICAL_HEIGHT * 0.5);
  }

  renderBackground(ctx);

  if (!segments.length) {
    if (hasRollTransform) ctx.restore();
    return;
  }

  const baseSegment = findSegment(state.position);
  const basePercent = MathUtil.percentRemaining(state.position, SEGMENT_LENGTH);
  const playerFocusZ = state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z;
  const playerSegment = findSegment(playerFocusZ);
  const playerPercent = MathUtil.percentRemaining(playerFocusZ, SEGMENT_LENGTH);
  const playerY = playerSegment
    ? MathUtil.lerp(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent)
    : 0;

  const effectiveCamWorldX = (state.playerX - state.cameraLagX) * ROAD_WIDTH;
  const cameraWorldY = playerY + CAMERA_HEIGHT;

  // Запас +18px снизу гарантирует закрытие нижних углов экрана при максимальном угле крена камеры
  let maxY = LOGICAL_HEIGHT + 18 + Math.max(0, state.cameraPitch);

  // C1-непрерывный квадратичный интеграл кривизны от точной позиции камеры внутри baseSegment:
  // полностью устраняет пилообразный скачок дороги и машин при смене сегмента (basePercent: 0.999 -> 0.000)
  let x = 0.5 * baseSegment.curve * basePercent * basePercent;
  let dx = -(baseSegment.curve * basePercent);

  const invDrawDist = 1 / DRAW_DISTANCE;

  // 1. Прямой проход (от камеры к горизонту): проекция вершин и отрисовка полотна дороги
  for (let n = 0; n < DRAW_DISTANCE; n++) {
    const segIndex = (baseSegment.index + n) % segments.length;
    const seg = segments[segIndex];
    const looped = seg.index < baseSegment.index;
    const camZ = state.position - (looped ? trackLength : 0);
    const stepX = dx + 0.5 * seg.curve;

    project(
      seg.p1,
      effectiveCamWorldX - x,
      cameraWorldY,
      camZ,
      state.activeCameraDepth,
      LOGICAL_WIDTH,
      LOGICAL_HEIGHT,
      ROAD_WIDTH,
      state.cameraPitch
    );
    project(
      seg.p2,
      effectiveCamWorldX - x - stepX,
      cameraWorldY,
      camZ,
      state.activeCameraDepth,
      LOGICAL_WIDTH,
      LOGICAL_HEIGHT,
      ROAD_WIDTH,
      state.cameraPitch
    );

    x += stepX;
    dx += seg.curve;
    seg.clip = maxY;

    if (seg.p2.camera.z > MIN_SAMPLE_CAM_Z) {
      seg.projectedFrame = frameId;
    }

    if (
      seg.p1.camera.z <= state.activeCameraDepth ||
      seg.p2.screen.y >= seg.p1.screen.y ||
      seg.p2.screen.y >= maxY
    ) {
      continue;
    }

    const distRatio = n * invDrawDist;
    const fogNorm = distRatio > 0.72 ? (distRatio - 0.72) / 0.28 : 0;
    const fog = fogNorm > 0 ? MathUtil.exponentialFog(fogNorm, FOG_DENSITY) * 0.28 : 0;
    renderSegment(ctx, seg, n, fog);

    maxY = seg.p2.screen.y;
  }

  renderRoadHeadlights(ctx);

  _foregroundCars.length = 0;
  _foregroundArchBeams.length = 0;
  let archPoolCursor = 0;
  const foregroundThresholdZ = PLAYER_Z + PLAYER_CENTER_OFFSET_Z;

  // 2. Обратный проход (от горизонта к камере): отбойники, придорожные объекты, трафик и арки
  for (let n = DRAW_DISTANCE - 1; n >= 0; n--) {
    const segIndex = (baseSegment.index + n) % segments.length;
    const seg = segments[segIndex];
    const distRatio = n * invDrawDist;
    _segArchBeams.length = 0;

    if (seg.p1.camera.z > MIN_GUARDRAIL_CAM_Z) {
      if (state.gameMode === 'circuit') {
        renderGuardrail(ctx, seg, distRatio);
      }

      if (seg.p1.camera.z > MIN_SPRITE_CAM_Z && seg.sprites.length > 0) {
        const spriteScale = seg.p1.screen.scale;
        const spriteBaseX = seg.p1.screen.x;
        const spriteY = seg.p1.screen.y;

        for (let i = 0; i < seg.sprites.length; i++) {
          const sp = seg.sprites[i];
          const spriteX = spriteBaseX + (spriteScale * sp.offset * ROAD_WIDTH * PROJ_HALF_WIDTH);
          const isArch = sp.type === 'start_arch' || sp.type === 'checkpoint_arch';

          if (isArch && seg.p1.camera.z < foregroundThresholdZ) {
            _segArchBeams.push(
              allocArchBeamSlot(
                archPoolCursor++,
                spriteScale,
                spriteX,
                spriteY,
                seg.clip,
                sp.type === 'start_arch',
                seg.p1.camera.z,
                true
              )
            );
            continue;
          }

          renderSprite(ctx, sp, spriteScale, spriteX, spriteY, seg.clip, distRatio);

          if (isArch) {
            _segArchBeams.push(
              allocArchBeamSlot(
                archPoolCursor++,
                spriteScale,
                spriteX,
                spriteY,
                seg.clip,
                sp.type === 'start_arch',
                seg.p1.camera.z,
                false
              )
            );
          }
        }
      }
    }

    if (seg.cars.length > 0) {
      let segCars = seg.cars;
      const carCount = segCars.length;

      for (let i = 0; i < carCount; i++) {
        const c = segCars[i];
        c._frameCamZ = getShortestTrackDz(state.position, c.z, trackLength);
      }

      if (carCount === 2) {
        // Быстрая сортировка двух машин в одном сегменте без вызова Array.prototype.sort
        const c0 = segCars[0];
        const c1 = segCars[1];
        _segCarsScratch.length = 2;
        if (c0._frameCamZ >= c1._frameCamZ) {
          _segCarsScratch[0] = c0;
          _segCarsScratch[1] = c1;
        } else {
          _segCarsScratch[0] = c1;
          _segCarsScratch[1] = c0;
        }
        segCars = _segCarsScratch;
      } else if (carCount > 2) {
        _segCarsScratch.length = 0;
        for (let i = 0; i < carCount; i++) _segCarsScratch.push(segCars[i]);
        _segCarsScratch.sort(compareSegCarsFarToNear);
        segCars = _segCarsScratch;
      }

      for (let i = 0; i < carCount; i++) {
        const car = segCars[i];
        if (car._renderedFrame === frameId) continue;
        car._renderedFrame = frameId;

        const carCamZ = car._frameCamZ;
        const halfCarLen = (car.lenZ || SEGMENT_LENGTH * 1.3) * 0.5;
        if (carCamZ + halfCarLen <= MIN_CAR_CAM_Z) continue;

        if (carCamZ < foregroundThresholdZ) {
          pushForegroundCar(car, false, carCamZ);
        } else {
          renderTrafficCar(ctx, car, carCamZ);
        }
      }
    }

    for (let b = 0; b < _segArchBeams.length; b++) {
      const beam = _segArchBeams[b];
      if (beam.drawPillars || beam.camZ < foregroundThresholdZ + 220) {
        _foregroundArchBeams.push(beam);
      } else {
        renderOverheadArchBeam(ctx, beam.scale, beam.x, beam.y, beam.clip, beam.isStartFinish);
      }
    }
  }

  // 3. Автомобиль игрока (при Game Over, кроме полного тотала, остаётся на трассе, пока камера проезжает вперёд)
  const isTotalWreckGameOver =
    state.gameState === STATE.GAMEOVER &&
    state.gameMode !== 'circuit' &&
    state.visualDamage >= MAX_HARDCORE_COLLISIONS;
  const isDetachedGameOverCar = state.gameState === STATE.GAMEOVER && !isTotalWreckGameOver;

  if (!isDetachedGameOverCar) {
    renderPlayerCar(ctx);
  } else if (!state.playerCarPassedByCamera) {
    const parkedCamZ = getShortestTrackDz(state.position, state.stoppedPlayerZ, trackLength);
    if (parkedCamZ + PLAYER_LEN_Z * 0.5 <= MIN_CAR_CAM_Z) {
      state.playerCarPassedByCamera = true;
    } else {
      pushForegroundCar(null, true, parkedCamZ);
    }
  }

  // 4. Машины на переднем плане (между бампером игрока и объективом камеры)
  if (_foregroundCars.length > 0) {
    if (_foregroundCars.length > 1) {
      _foregroundCars.sort(compareForegroundCarsFarToNear);
    }
    for (let i = 0; i < _foregroundCars.length; i++) {
      const item = _foregroundCars[i];
      if (item.isParkedPlayer) {
        renderPlayerCar(ctx, item.carCamZ);
      } else {
        renderTrafficCar(ctx, item.car, item.carCamZ);
      }
    }
  }

  // 5. Ближние арки (перекладины и опоры, оказавшиеся ближе машины игрока)
  if (_foregroundArchBeams.length > 0) {
    if (_foregroundArchBeams.length > 1) {
      _foregroundArchBeams.sort(compareArchBeamsFarToNear);
    }
    for (let b = 0; b < _foregroundArchBeams.length; b++) {
      const beam = _foregroundArchBeams[b];
      if (beam.drawPillars) {
        renderOverheadArchPillarsClipped(ctx, beam.scale, beam.x, beam.y, beam.clip, beam.isStartFinish);
      }
      renderOverheadArchBeam(ctx, beam.scale, beam.x, beam.y, beam.clip, beam.isStartFinish);
    }
  }

  // 6. Экранный слой частиц
  renderParticles(ctx);

  if (hasRollTransform) {
    ctx.restore();
  }

  // 7. Приборная панель и интерфейс поверх 3D-сцены
  renderHUD(ctx);
}