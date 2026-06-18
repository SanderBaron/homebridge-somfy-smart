import * as fs from 'fs';
import type { Logging } from 'homebridge';

/** Laatst uitgevoerde actie op een screen (voor de UI / inzicht). */
export interface LastAction {
  position: number;
  reason: string;
  at: string;
}

interface PersistShape {
  /** Engine gepauzeerd (bv. door de glazenwasser-knop). */
  paused: boolean;
  /** ISO-tijd waarop de glazenwasser automatisch hervat, of null. */
  glazenwasserUntil: string | null;
  /** Laatste actie per screen-deviceURL. */
  lastActions: Record<string, LastAction>;
  /** "Pauzeer zonwering" actief. */
  sunPause: boolean;
  /** Minimum-openstand (HomeKit-positie) per screen-deviceURL; engine sluit niet verder. */
  caps: Record<string, number>;
}

const EMPTY: PersistShape = {
  paused: false,
  glazenwasserUntil: null,
  lastActions: {},
  sunPause: false,
  caps: {},
};

/**
 * Persistente plugin-state in één JSON-bestand in de Homebridge-storage.
 * Pauze-status en laatste acties overleven hiermee een herstart (harde eis).
 */
export class StateStore {
  private data: PersistShape;

  constructor(private readonly file: string, private readonly log: Logging) {
    this.data = this.load();
  }

  private load(): PersistShape {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return { ...EMPTY, ...parsed };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Kon state-bestand niet lezen (${msg}); start met lege state.`);
    }
    return { ...EMPTY };
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Kon state-bestand niet schrijven: ${msg}`);
    }
  }

  get paused(): boolean {
    return this.data.paused;
  }

  setPaused(value: boolean): void {
    this.data.paused = value;
    this.save();
  }

  get glazenwasserUntil(): Date | null {
    return this.data.glazenwasserUntil ? new Date(this.data.glazenwasserUntil) : null;
  }

  setGlazenwasserUntil(value: Date | null): void {
    this.data.glazenwasserUntil = value ? value.toISOString() : null;
    this.save();
  }

  recordAction(deviceURL: string, action: LastAction): void {
    this.data.lastActions[deviceURL] = action;
    this.save();
  }

  lastAction(deviceURL: string): LastAction | undefined {
    return this.data.lastActions[deviceURL];
  }

  get sunPause(): boolean {
    return this.data.sunPause;
  }

  /** Minimum-openstand (HomeKit-positie) voor een screen, of undefined. */
  getCap(deviceURL: string): number | undefined {
    return this.data.caps[deviceURL];
  }

  /** Leg de grendels vast en zet de pauzeer-status. */
  setSunPause(active: boolean, caps: Record<string, number>): void {
    this.data.sunPause = active;
    this.data.caps = active ? caps : {};
    this.save();
  }
}
