import * as fs from 'fs';
import type { Logging } from 'homebridge';

export interface HistoryEntry {
  /** ISO-tijd. */
  t: string;
  /** 'lux' | 'eval' | 'cmd'. */
  kind: string;
  [key: string]: unknown;
}

/**
 * Rollende geschiedenis (lux-verloop, timer-overgangen, commando's) in een eigen
 * JSON-bestand in de Homebridge-storage. Bewust los van de Homebridge-log, zodat
 * het een log-truncatie/rotatie overleeft en we de dag achteraf kunnen reconstrueren.
 *
 * In-memory ringbuffer; wegschrijven is gedebounced (max ~1×/5s) om I/O te sparen.
 */
export class HistoryLog {
  private ring: HistoryEntry[] = [];
  private dirty = false;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly log: Logging,
    private readonly max = 2000,
  ) {
    this.ring = this.load();
  }

  add(entry: Omit<HistoryEntry, 't'>): void {
    this.ring.push({ t: new Date().toISOString(), ...entry } as HistoryEntry);
    if (this.ring.length > this.max) {
      this.ring.splice(0, this.ring.length - this.max);
    }
    this.scheduleWrite();
  }

  /** De laatste n entries (default alles). */
  recent(n?: number): HistoryEntry[] {
    return n ? this.ring.slice(-n) : this.ring.slice();
  }

  stop(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flush();
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        this.flush();
      }, 5000);
    }
  }

  private flush(): void {
    if (!this.dirty) {
      return;
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.ring), 'utf8');
      this.dirty = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Kon geschiedenis niet schrijven: ${msg}`);
    }
  }

  private load(): HistoryEntry[] {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(parsed)) {
          return parsed.slice(-this.max);
        }
      }
    } catch {
      // begin met lege historie
    }
    return [];
  }
}
