/* shotlistener.js — detects the "crack" of a golf shot with the microphone.
 *
 * A golf impact is a short broadband transient well above the ambient level.
 * We high-pass the mic stream (wind/voice rumble lives below ~1.5 kHz, the
 * click of impact has lots of energy above it), track a slow-moving noise
 * floor, and fire when the instantaneous level jumps far above that floor
 * and decays quickly. A refractory period stops one swing (practice swing
 * echoes, ball landing) counting twice.
 */

const SENSITIVITY = {
  low:    { ratio: 9, minLevel: 0.10 },
  normal: { ratio: 6, minLevel: 0.06 },
  high:   { ratio: 4, minLevel: 0.035 },
};

const REFRACTORY_MS = 8000;

export class ShotListener {
  constructor({ sensitivity = 'normal', onShot }) {
    this.cfg = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
    this.onShot = onShot;
    this.ctx = null;
    this.stream = null;
    this.raf = null;
    this.noiseFloor = 0.01;
    this.lastShotAt = 0;
    this.paused = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(hp);
    hp.connect(this.analyser);

    this.buf = new Float32Array(this.analyser.fftSize);
    this._loop();
  }

  /** Pause detection (e.g. while the app is talking / listening for a club). */
  setPaused(p) { this.paused = p; }

  _loop() {
    this.raf = requestAnimationFrame(() => this._loop());
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);

    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);

    const now = performance.now();
    const inRefractory = now - this.lastShotAt < REFRACTORY_MS;

    if (!this.paused && !inRefractory &&
        rms > Math.max(this.noiseFloor * this.cfg.ratio, this.cfg.minLevel)) {
      this.lastShotAt = now;
      this.onShot?.();
      return; // don't let the bang inflate the noise floor
    }

    // Slow EWMA noise floor; adapts to wind/chatter without chasing spikes.
    const alpha = rms > this.noiseFloor ? 0.002 : 0.02;
    this.noiseFloor += alpha * (rms - this.noiseFloor);
    this.noiseFloor = Math.max(this.noiseFloor, 0.003);
  }

  async resume() {
    // AudioContext suspends when the page is backgrounded on some phones
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }
}
