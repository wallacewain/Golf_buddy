/* gps.js — continuous position tracking with accuracy filtering */

export class GPS {
  constructor() {
    this.watchId = null;
    this.position = null;      // {lat, lng, accuracy, heading, speed, t}
    this.listeners = new Set();
  }

  get available() { return 'geolocation' in navigator; }

  /** Resolves with the first good fix, then keeps watching. */
  start() {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new Error('GPS not available on this device'));
      let resolved = false;
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const p = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading,
            speed: pos.coords.speed,
            t: pos.timestamp,
          };
          // Ignore wildly inaccurate fixes once we have a decent one
          if (this.position && p.accuracy > 60 && this.position.accuracy < 40) return;
          this.position = p;
          for (const fn of this.listeners) fn(p);
          if (!resolved) { resolved = true; resolve(p); }
        },
        (err) => { if (!resolved) { resolved = true; reject(err); } },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
      );
    });
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
