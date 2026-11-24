import { MathUtil } from './utils.js';

/**
 * Процедурный аудио-синтезатор (Web Audio API)
 */
export class RetroAudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.initialized = false;

    this.engineOsc = null;
    this.engineSubOsc = null;
    this.engineFilter = null;
    this.engineGain = null;

    this.damageRattleOsc = null;
    this.damageKnockOsc = null;
    this.damageBandpass = null;
    this.damageRattleGain = null;

    this.brakeOsc1 = null;
    this.brakeOsc2 = null;
    this.brakeLfo = null;
    this.brakeLfoGain = null;
    this.brakeFilter = null;
    this.brakeGain = null;

    this.noiseBuffer = null;
    this.noiseNode = null;
    this.noiseFilter = null;
    this.noiseGain = null;
  }

  init() {
    if (this.initialized) {
      if (this.ctx && this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      if (this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
      }

      // Основной двигатель
      this.engineOsc = this.ctx.createOscillator();
      this.engineSubOsc = this.ctx.createOscillator();
      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineGain = this.ctx.createGain();

      this.engineOsc.type = 'sawtooth';
      this.engineSubOsc.type = 'triangle';
      this.engineOsc.frequency.value = 55;
      this.engineSubOsc.frequency.value = 27.5;

      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 280;
      this.engineGain.gain.value = 0.0;

      this.engineOsc.connect(this.engineFilter);
      this.engineSubOsc.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.ctx.destination);

      this.engineOsc.start();
      this.engineSubOsc.start();

      // Слой повреждённого мотора
      this.damageRattleOsc = this.ctx.createOscillator();
      this.damageKnockOsc = this.ctx.createOscillator();
      this.damageBandpass = this.ctx.createBiquadFilter();
      this.damageRattleGain = this.ctx.createGain();

      this.damageRattleOsc.type = 'sawtooth';
      this.damageKnockOsc.type = 'square';
      this.damageRattleOsc.frequency.value = 28;
      this.damageKnockOsc.frequency.value = 82;

      this.damageBandpass.type = 'bandpass';
      this.damageBandpass.frequency.value = 640;
      this.damageBandpass.Q.value = 3.2;

      this.damageRattleGain.gain.value = 0.0;

      this.damageRattleOsc.connect(this.damageBandpass);
      this.damageKnockOsc.connect(this.damageBandpass);
      this.damageBandpass.connect(this.damageRattleGain);
      this.damageRattleGain.connect(this.ctx.destination);

      this.damageRattleOsc.start();
      this.damageKnockOsc.start();

      // 8-битный аркадный визг шин при торможении
      this.brakeOsc1 = this.ctx.createOscillator();
      this.brakeOsc2 = this.ctx.createOscillator();
      this.brakeLfo = this.ctx.createOscillator();
      this.brakeLfoGain = this.ctx.createGain();
      this.brakeFilter = this.ctx.createBiquadFilter();
      this.brakeGain = this.ctx.createGain();

      this.brakeOsc1.type = 'square';
      this.brakeOsc2.type = 'sawtooth';
      this.brakeOsc1.frequency.value = 380;
      this.brakeOsc2.frequency.value = 406;

      this.brakeLfo.type = 'triangle';
      this.brakeLfo.frequency.value = 34;
      this.brakeLfoGain.gain.value = 16;

      this.brakeFilter.type = 'lowpass';
      this.brakeFilter.frequency.value = 880;
      this.brakeFilter.Q.value = 2.4;

      this.brakeGain.gain.value = 0.0;

      this.brakeLfo.connect(this.brakeLfoGain);
      this.brakeLfoGain.connect(this.brakeOsc1.frequency);
      this.brakeLfoGain.connect(this.brakeOsc2.frequency);

      this.brakeOsc1.connect(this.brakeFilter);
      this.brakeOsc2.connect(this.brakeFilter);
      this.brakeFilter.connect(this.brakeGain);
      this.brakeGain.connect(this.ctx.destination);

      this.brakeOsc1.start();
      this.brakeOsc2.start();
      this.brakeLfo.start();

      // Генератор шума для гравия на обочине и хлопков выхлопа
      const bufferSize = this.ctx.sampleRate * 2;
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = noiseBuffer;

      this.noiseNode = this.ctx.createBufferSource();
      this.noiseNode.buffer = noiseBuffer;
      this.noiseNode.loop = true;

      this.noiseFilter = this.ctx.createBiquadFilter();
      this.noiseFilter.type = 'bandpass';
      this.noiseFilter.frequency.value = 460;
      this.noiseFilter.Q.value = 1.1;

      this.noiseGain = this.ctx.createGain();
      this.noiseGain.gain.value = 0.0;

      this.noiseNode.connect(this.noiseFilter);
      this.noiseFilter.connect(this.noiseGain);
      this.noiseGain.connect(this.ctx.destination);
      this.noiseNode.start();

      this.initialized = true;
    } catch (e) {}
  }

  toggleMute() {
    this.muted = !this.muted;
    if (!this.muted) {
      this.init();
    } else if (this.initialized && this.ctx) {
      const now = this.ctx.currentTime;
      this.engineGain.gain.setTargetAtTime(0, now, 0.03);
      if (this.damageRattleGain) this.damageRattleGain.gain.setTargetAtTime(0, now, 0.03);
      this.brakeGain.gain.setTargetAtTime(0, now, 0.03);
      this.noiseGain.gain.setTargetAtTime(0, now, 0.03);
    }
    return this.muted;
  }

  playTone(freq, duration, type = 'sine', volume = 0.14, slideTo = null, delay = 0) {
    if (this.muted) return;
    this.init();
    if (!this.initialized || !this.ctx) return;
    try {
      const startTime = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);
      if (slideTo !== null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), startTime + duration);
      }
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.linearRampToValueAtTime(volume, startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch (e) {}
      };
      osc.start(startTime);
      osc.stop(startTime + duration + 0.02);
    } catch (e) {}
  }

  playBackfire() {
    if (this.muted) return;
    this.init();
    if (!this.initialized || !this.ctx) return;
    this.playTone(125, 0.13, 'sawtooth', 0.11, 36, 0);
    this.playTone(72, 0.16, 'triangle', 0.12, 28, 0.01);
    try {
      if (this.noiseBuffer) {
        const now = this.ctx.currentTime;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(620, now);
        filter.frequency.exponentialRampToValueAtTime(140, now + 0.14);
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        src.onended = () => {
          try {
            src.disconnect();
            filter.disconnect();
            gain.disconnect();
          } catch (e) {}
        };
        src.start(now, Math.random() * 1.2, 0.15);
      }
    } catch (e) {}
  }

  playOncomingHorn(carType = 'sedan') {
    if (this.muted) return;
    this.init();
    if (!this.initialized || !this.ctx) return;

    const baseFreq = carType === 'van' ? 275 : (carType === 'sport' ? 395 : 340);
    const secondFreq = baseFreq * 1.25;

    this.playTone(baseFreq, 0.11, 'sawtooth', 0.065, baseFreq * 0.94, 0.00);
    this.playTone(secondFreq, 0.11, 'triangle', 0.065, secondFreq * 0.94, 0.00);

    this.playTone(baseFreq * 0.96, 0.24, 'sawtooth', 0.085, baseFreq * 0.84, 0.14);
    this.playTone(secondFreq * 0.96, 0.24, 'triangle', 0.085, secondFreq * 0.84, 0.14);
  }

  playCrash(intensity = 1) {
    const vol = MathUtil.clamp(0.14 * intensity, 0.08, 0.28);
    this.playTone(135, 0.24, 'sawtooth', vol, 32, 0);
    this.playTone(75, 0.32, 'square', vol * 0.9, 24, 0.02);
  }

  playGuardrailScrape() {
    this.playTone(260, 0.11, 'sawtooth', 0.075, 165, 0);
  }

  playCheckpoint() {
    this.playTone(523.25, 0.12, 'triangle', 0.16, null, 0.00);
    this.playTone(659.25, 0.12, 'triangle', 0.16, null, 0.09);
    this.playTone(783.99, 0.14, 'triangle', 0.18, null, 0.18);
    this.playTone(1046.5, 0.28, 'triangle', 0.20, null, 0.27);
  }

  playVictory() {
    this.playTone(523.25, 0.12, 'square', 0.15, null, 0.00);
    this.playTone(659.25, 0.12, 'square', 0.15, null, 0.10);
    this.playTone(783.99, 0.12, 'square', 0.16, null, 0.20);
    this.playTone(1046.5, 0.22, 'square', 0.18, null, 0.30);
    this.playTone(783.99, 0.12, 'square', 0.15, null, 0.52);
    this.playTone(1046.5, 0.42, 'square', 0.20, null, 0.65);
  }

  playStartBeep() {
    this.playTone(440, 0.11, 'square', 0.12, null, 0.00);
    this.playTone(587.33, 0.11, 'square', 0.12, null, 0.09);
    this.playTone(880, 0.22, 'square', 0.15, null, 0.18);
  }

  playOverheat() {
    this.playTone(660, 0.16, 'sawtooth', 0.16, 280, 0.0);
    this.playTone(520, 0.22, 'sawtooth', 0.16, 190, 0.14);
  }

  update(speedRatio, isBraking, isOffRoad, isPlaying, revOnly = false, damageRatio = 0, isMisfiring = false) {
    if (!this.initialized || !this.ctx) return;
    const now = this.ctx.currentTime;

    if (this.muted || !isPlaying) {
      this.engineGain.gain.setTargetAtTime(0, now, 0.05);
      if (this.damageRattleGain) this.damageRattleGain.gain.setTargetAtTime(0, now, 0.05);
      this.brakeGain.gain.setTargetAtTime(0, now, 0.05);
      this.noiseGain.gain.setTargetAtTime(0, now, 0.05);
      return;
    }

    if (revOnly) {
      const baseFreq = 58 + speedRatio * 145;
      this.engineOsc.frequency.setTargetAtTime(baseFreq, now, 0.05);
      this.engineSubOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.05);
      this.engineFilter.frequency.setTargetAtTime(240 + speedRatio * 360, now, 0.05);
      this.engineGain.gain.setTargetAtTime(0.045 + speedRatio * 0.04, now, 0.05);
      if (this.damageRattleGain) this.damageRattleGain.gain.setTargetAtTime(0, now, 0.05);
      this.brakeGain.gain.setTargetAtTime(0, now, 0.04);
      this.noiseGain.gain.setTargetAtTime(0, now, 0.04);
      return;
    }

    const absRatio = MathUtil.clamp(Math.abs(speedRatio), 0, 1);
    const gearCount = 5;
    const scaled = absRatio * gearCount;
    const gearFraction = scaled - Math.floor(scaled);
    const rpm = absRatio >= 0.96 ? 0.92 : (0.28 + gearFraction * 0.68);

    const dmgSeverity = MathUtil.clamp((damageRatio - 0.35) / 0.65, 0, 1);
    let roughPitchMult = 1.0;
    let roughGainMult = 1.0;

    if (dmgSeverity > 0) {
      const stutterWave = Math.sin(now * 31.0) * Math.sin(now * 13.7);
      const sputterPulse = isMisfiring || stutterWave < -0.52;
      const flutter = Math.sin(now * 44.0) * 0.045 * dmgSeverity;
      roughPitchMult = (sputterPulse ? (1.0 - 0.24 * dmgSeverity) : 1.0) + flutter;
      roughGainMult = sputterPulse ? (1.0 - 0.38 * dmgSeverity) : 1.0;
    }

    const baseFreq = (48 + rpm * 125 + absRatio * 35) * roughPitchMult;
    this.engineOsc.frequency.setTargetAtTime(baseFreq, now, 0.03);
    this.engineSubOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.03);

    const filterFreq = (220 + rpm * 340) * (1.0 - dmgSeverity * 0.26);
    this.engineFilter.frequency.setTargetAtTime(filterFreq, now, 0.04);
    this.engineFilter.Q.setTargetAtTime(1.0 + dmgSeverity * 2.8, now, 0.05);

    const baseEngineVol = (0.042 + absRatio * 0.052) * roughGainMult;
    this.engineGain.gain.setTargetAtTime(baseEngineVol, now, 0.03);

    if (this.damageRattleGain && this.damageRattleOsc && this.damageKnockOsc && this.damageBandpass) {
      if (dmgSeverity > 0.02) {
        const rattlePulse = 0.65 + 0.35 * Math.sin(now * 58.0);
        this.damageRattleOsc.frequency.setTargetAtTime(baseFreq * 0.51, now, 0.03);
        this.damageKnockOsc.frequency.setTargetAtTime(baseFreq * 1.49, now, 0.03);
        this.damageBandpass.frequency.setTargetAtTime(480 + rpm * 620, now, 0.04);
        const targetRattleVol = dmgSeverity * (0.020 + absRatio * 0.034) * rattlePulse;
        this.damageRattleGain.gain.setTargetAtTime(targetRattleVol, now, 0.03);
      } else {
        this.damageRattleGain.gain.setTargetAtTime(0, now, 0.05);
      }
    }

    let targetNoise = 0;
    if (isOffRoad && absRatio > 0.03) {
      targetNoise = 0.06 * Math.min(1, absRatio * 2.2);
    }
    this.noiseFilter.frequency.setTargetAtTime(460, now, 0.05);
    this.noiseGain.gain.setTargetAtTime(targetNoise, now, 0.05);

    let targetBrakeGain = 0;
    if (!isOffRoad && isBraking && absRatio > 0.05) {
      const intensity = Math.min(1, absRatio * 1.35);
      const skidFreq = 320 + absRatio * 230;
      this.brakeOsc1.frequency.setTargetAtTime(skidFreq, now, 0.04);
      this.brakeOsc2.frequency.setTargetAtTime(skidFreq * 1.07, now, 0.04);
      this.brakeFilter.frequency.setTargetAtTime(680 + absRatio * 520, now, 0.04);
      targetBrakeGain = 0.036 * intensity;
    }
    this.brakeGain.gain.setTargetAtTime(targetBrakeGain, now, 0.04);
  }
}

export const audio = new RetroAudioEngine();
