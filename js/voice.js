/* voice.js — speech output (announcements) and speech input (club names).
 *
 * Output uses speechSynthesis (everywhere). Input uses SpeechRecognition,
 * which is available on Android Chrome; where it's missing (e.g. some iOS
 * versions) the app falls back to the on-screen club grid.
 */

export class Voice {
  constructor(settings) {
    this.settings = settings;
    this.Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  get canListen() { return !!this.Recognition; }

  speak(text) {
    if (!this.settings.voice || !('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.cancel(); // don't queue up behind stale announcements
      speechSynthesis.speak(u);
      setTimeout(resolve, 12000); // safety net
    });
  }

  /**
   * Listen for one utterance and resolve with the transcript ('' on
   * failure/timeout). Never rejects.
   */
  listenOnce({ timeoutMs = 6000 } = {}) {
    if (!this.canListen) return Promise.resolve('');
    return new Promise((resolve) => {
      const rec = new this.Recognition();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 4;
      let done = false;
      const finish = (text) => {
        if (done) return;
        done = true;
        try { rec.stop(); } catch { /* already stopped */ }
        resolve(text);
      };
      rec.onresult = (e) => {
        const alts = [...e.results[0]].map(r => r.transcript).join(' | ');
        finish(alts);
      };
      rec.onerror = () => finish('');
      rec.onend = () => finish('');
      setTimeout(() => finish(''), timeoutMs);
      try { rec.start(); } catch { finish(''); }
    });
  }
}
