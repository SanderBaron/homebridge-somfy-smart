/**
 * Config-model voor de slimme laag (rule engine, interlock, glazenwasser).
 * Wordt in fase 3 door de custom Config UI X geschreven; nu handmatig in JSON.
 */

/** Hoe meerdere sensoren tot één luxwaarde worden gecombineerd. */
export type SensorCombine = 'avg' | 'max' | 'min' | 'first';

/** Een groep screens, bestuurbaar als geheel in regels (bv. Oost, Zuid). */
export interface GroupConfig {
  id: string;
  name: string;
  /** deviceURLs van de screens in deze groep. */
  screens: string[];
}

/** Zonlicht-conditie met hysterese en asymmetrische (Somfy-stijl) vertraging. */
export interface SunCondition {
  /** deviceURLs van sensoren; leeg = alle zonsensoren. */
  sensors: string[];
  /** Combinatie van die sensoren. Default 'avg'. */
  combine?: SensorCombine;
  /** Boven deze lux gaat het screen omlaag. */
  thresholdHigh: number;
  /** Onder deze (lagere) lux gaat het screen omhoog — hysterese-deadband ertussen. */
  thresholdLow: number;
  /**
   * @deprecated Gebruik durationDownSec/durationUpSec. Alleen nog als fallback
   * voor de omlaag-duur bij oude configs.
   */
  durationSec?: number;
  /**
   * Hoe lang de zon boven de drempel moet zijn vóór omlaag (Somfy: 2 min).
   * Default 120.
   */
  durationDownSec?: number;
  /**
   * Basis-wachttijd onder de drempel vóór omhoog (Somfy: 15 min). Default 900.
   * Bij adaptiveUp groeit deze met de zonduur tot 2× (Somfy: tot 30 min).
   */
  durationUpSec?: number;
  /**
   * Somfy-stijl: laat de omhoog-vertraging meegroeien met hoe lang de zon scheen
   * (tot 2× durationUpSec). Voorkomt dat een kort wolkje een lang-bezond screen
   * omhoog jaagt. Default true.
   */
  adaptiveUp?: boolean;
  /** HomeKit-positie (%) bij 'boven drempel' (bv. 0 = dicht, 30 = deels). */
  closedPosition: number;
  /** HomeKit-positie (%) bij 'onder drempel'. Default 100 (open). */
  openPosition?: number;
}

/** Tijdvenster dat een regel begrenst. */
export interface TimeWindow {
  /** "HH:MM" 24-uurs. */
  start: string;
  end: string;
  /** 'active' = regel werkt alléén binnen venster; 'inactive' = juist erbuiten. */
  mode: 'active' | 'inactive';
  /**
   * Open het scherm eenmalig zodra het actieve venster afloopt (voor ramen die
   * later op de dag geen zoninval meer hebben). Alleen zinvol bij mode 'active'.
   */
  reopenAtEnd?: boolean;
}

/** Eén slimme regel op een screen of groep. */
export interface RuleConfig {
  id: string;
  name: string;
  enabled: boolean;
  targetType: 'screen' | 'group';
  /** deviceURL (screen) of group-id. */
  targetId: string;
  sun?: SunCondition;
  time?: TimeWindow;
  /**
   * Hoe tijd en zon worden gecombineerd als beide gezet zijn:
   *  - 'and' (default): tijdvenster werkt als poort op de zon-regel.
   *  - 'or': de zon-regel geldt ongeacht het venster.
   */
  combine?: 'and' | 'or';
  /** Minimale tijd tussen commando's voor deze regel (anti-flapper). Default 60. */
  minIntervalSec?: number;
}

/** Veiligheids-interlock: screen mag alleen omlaag als het contact gesloten is. */
export interface InterlockConfig {
  /** deviceURL van het screen (bv. Tuindeuren). */
  screen: string;
  /** deviceURL van het contact (bv. Tuindeur). */
  contact: string;
  /** Wat te doen met een omlaag-commando terwijl de deur open is. Default 'queue'. */
  onDoorOpen?: 'queue' | 'drop';
}

/** Stateful "Glazenwasser"-schakelaar. */
export interface GlazenwasserConfig {
  enabled: boolean;
  /** Naam van de HomeKit-schakelaar. Default 'Glazenwasser'. */
  name?: string;
  /** Auto-hervat na N uur. 0/leeg = geen auto-hervat. */
  autoResumeHours?: number;
}

/**
 * Stateful "Pauzeer zonwering"-schakelaar. Legt bij inschakelen op elk scherm
 * dat afwijkt van de regels (handmatig verder open gezet) een minimum-openstand
 * vast: het scherm mag daarna wél mee omhoog, maar niet verder dicht dan die
 * stand. Uitschakelen heft alle grendels op.
 */
export interface SunPauseConfig {
  enabled: boolean;
  /** Naam van de HomeKit-schakelaar. Default 'Pauzeer zonwering'. */
  name?: string;
}

/** Volledige automatiserings-config onder de platform-config. */
export interface AutomationConfig {
  groups?: GroupConfig[];
  rules?: RuleConfig[];
  interlocks?: InterlockConfig[];
  glazenwasser?: GlazenwasserConfig;
  sunPause?: SunPauseConfig;
  /** Hoe vaak de engine alle regels herevalueert (s). Default 10. */
  evaluateIntervalSec?: number;
}

/** Bron van een beweegcommando — bepaalt of pauze/interlock van toepassing is. */
export type MoveSource = 'engine' | 'manual' | 'system';
