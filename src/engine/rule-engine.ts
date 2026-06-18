import type { Logging } from 'homebridge';

import type { DeviceRegistry } from '../state/registry';
import type { StateStore } from '../state/store';
import type { MoveDispatcher } from './dispatcher';
import { RuleConfig, SunCondition, TimeWindow } from './types';

type Decision = 'up' | 'down' | undefined;

interface RuleRuntime {
  /** Sinds wanneer (ms) de lux onafgebroken boven de hoge drempel is. */
  aboveSince?: number;
  belowSince?: number;
  /** Begin van de huidige zonperiode (eerste keer boven de hoge drempel). */
  sunSince?: number;
  /** Laatst toegepaste richting. */
  mode: 'up' | 'down' | 'idle';
  lastCommandAt: number;
  /** Vorige status van het tijdvenster (voor reopen-at-end detectie). */
  prevTimeActive?: boolean;
}

/**
 * Evalueert de slimme regels op basis van zonlicht en/of tijd, met hysterese,
 * duur-bevestiging en een minimaal interval tussen commando's. Acties gaan via
 * de MoveDispatcher (die pauze en interlock afhandelt).
 */
export class RuleEngine {
  private readonly runtime = new Map<string, RuleRuntime>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly dispatcher: MoveDispatcher,
    private readonly store: StateStore,
    private readonly log: Logging,
    private readonly rules: RuleConfig[],
    private readonly intervalSec: number,
    private readonly groups: Map<string, string[]>,
  ) {}

  start(): void {
    if (this.rules.length === 0) {
      this.log.info('Geen regels geconfigureerd — rule engine staat stand-by.');
      return;
    }
    // Herevalueer periodiek én meteen bij elke sensor-wijziging.
    this.registry.on('sensor', () => this.evaluateAll());
    this.timer = setInterval(() => this.evaluateAll(), this.intervalSec * 1000);
    this.log.info(`Rule engine actief: ${this.rules.length} regel(s), evaluatie elke ${this.intervalSec}s.`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private evaluateAll(): void {
    if (this.store.paused) {
      return;
    }
    const now = Date.now();
    for (const rule of this.rules) {
      try {
        this.evaluateRule(rule, now);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Regel '${rule.name}' faalde: ${msg}`);
      }
    }
  }

  private evaluateRule(rule: RuleConfig, now: number): void {
    if (!rule.enabled) {
      return;
    }
    const rt = this.runtime.get(rule.id) ?? { mode: 'idle' as const, lastCommandAt: 0 };
    this.runtime.set(rule.id, rt);

    const sunWants = rule.sun ? this.evaluateSun(rule.sun, rt, now) : undefined;
    const timeActive = rule.time ? inWindow(now, rule.time) : undefined;

    // Tijdvenster-reopen: zodra een actief venster afloopt, scherm eenmalig open.
    if (rule.time?.reopenAtEnd && rule.time.mode === 'active' && rule.sun) {
      if (rt.prevTimeActive === true && timeActive === false) {
        const openPos = rule.sun.openPosition ?? 100;
        void this.dispatcher.applyTarget(rule.targetType, rule.targetId, openPos, 'engine', `${rule.name} (einde venster)`);
        rt.mode = 'up';
        rt.lastCommandAt = now;
      }
    }
    rt.prevTimeActive = timeActive;

    const decision = this.combine(rule, sunWants, timeActive);

    if (!decision || !rule.sun) {
      return;
    }
    const minInterval = (rule.minIntervalSec ?? 60) * 1000;
    if (decision === rt.mode || now - rt.lastCommandAt < minInterval) {
      return;
    }

    const position = decision === 'down'
      ? rule.sun.closedPosition
      : (rule.sun.openPosition ?? 100);

    void this.dispatcher.applyTarget(rule.targetType, rule.targetId, position, 'engine', rule.name);
    rt.mode = decision;
    rt.lastCommandAt = now;
  }

  /**
   * Zon-conditie met hysterese-deadband en Somfy-stijl asymmetrische vertraging:
   * kort wachten om omlaag te gaan, lang (en adaptief) om omhoog te gaan.
   */
  private evaluateSun(sun: SunCondition, rt: RuleRuntime, now: number): Decision {
    const lux = this.combinedLux(sun);
    if (lux === undefined) {
      return undefined; // geen sensordata → niets doen
    }
    const downMs = (sun.durationDownSec ?? sun.durationSec ?? 120) * 1000;
    const baseUpMs = (sun.durationUpSec ?? 900) * 1000;
    const adaptiveUp = sun.adaptiveUp ?? true;

    if (lux >= sun.thresholdHigh) {
      rt.belowSince = undefined;
      rt.sunSince ??= now; // zonperiode begint/loopt door
      rt.aboveSince ??= now;
      return now - rt.aboveSince >= downMs ? 'down' : undefined;
    }
    if (lux <= sun.thresholdLow) {
      rt.aboveSince = undefined;
      rt.belowSince ??= now;
      const upMs = adaptiveUp ? this.adaptiveUpDelay(baseUpMs, rt) : baseUpMs;
      if (now - rt.belowSince >= upMs) {
        rt.sunSince = undefined; // zonperiode afgesloten na omhoog
        return 'up';
      }
      return undefined;
    }
    // Tussen de drempels: hysterese-deadband — geen bevestiging, zonperiode loopt door.
    rt.aboveSince = undefined;
    rt.belowSince = undefined;
    return undefined;
  }

  /**
   * Somfy-stijl adaptieve omhoog-vertraging: schaalt van 1× naar 2× de basis
   * naarmate de zon langer aaneengesloten scheen (referentie: 1 uur zon = 2×).
   * Zo kan een kort wolkje een lang-bezond screen niet omhoog jagen.
   */
  private adaptiveUpDelay(baseUpMs: number, rt: RuleRuntime): number {
    if (!rt.sunSince || !rt.belowSince) {
      return baseUpMs;
    }
    const presenceMs = Math.max(0, rt.belowSince - rt.sunSince);
    const factor = Math.min(1, presenceMs / 3_600_000); // 0..1 over 1 uur
    return baseUpMs * (1 + factor);
  }

  private combine(rule: RuleConfig, sun: Decision, timeActive: boolean | undefined): Decision {
    if (rule.sun && rule.time) {
      const mode = rule.combine ?? 'and';
      if (mode === 'and') {
        return timeActive ? sun : undefined; // tijdvenster als poort
      }
      return sun; // 'or' — venster heft de zon-regel niet op
    }
    if (rule.sun) {
      return sun;
    }
    return undefined; // tijd-alleen regels: nog niet ondersteund (fase 3)
  }

  /**
   * Wat wil de actieve regelgeving op dit moment met dit scherm (HomeKit-positie)?
   * Undefined als geen ingeschakelde regel het scherm bestuurt of nog niet besloten
   * heeft. Gebruikt door de "Pauzeer zonwering"-knop om afwijkende schermen te vinden.
   */
  desiredPositionFor(deviceURL: string): number | undefined {
    for (const rule of this.rules) {
      if (!rule.enabled || !rule.sun) {
        continue;
      }
      if (!this.screensFor(rule).includes(deviceURL)) {
        continue;
      }
      const rt = this.runtime.get(rule.id);
      if (!rt || rt.mode === 'idle') {
        continue;
      }
      return rt.mode === 'down' ? rule.sun.closedPosition : (rule.sun.openPosition ?? 100);
    }
    return undefined;
  }

  private screensFor(rule: RuleConfig): string[] {
    if (rule.targetType === 'group') {
      return this.groups.get(rule.targetId) ?? [];
    }
    return [rule.targetId];
  }

  private combinedLux(sun: SunCondition): number | undefined {
    const urls = sun.sensors.length ? sun.sensors : this.registry.luxUrls();
    const values = urls
      .map((u) => this.registry.getLux(u))
      .filter((v): v is number => v !== undefined);
    if (values.length === 0) {
      return undefined;
    }
    switch (sun.combine ?? 'avg') {
      case 'max':
        return Math.max(...values);
      case 'min':
        return Math.min(...values);
      case 'first':
        return values[0];
      case 'avg':
      default:
        return values.reduce((a, b) => a + b, 0) / values.length;
    }
  }
}

/** Valt `now` binnen het venster, rekening houdend met active/inactive en middernacht? */
export function inWindow(now: number, tw: TimeWindow): boolean {
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = toMinutes(tw.start);
  const end = toMinutes(tw.end);
  const within = start <= end
    ? cur >= start && cur < end
    : cur >= start || cur < end; // venster over middernacht
  return tw.mode === 'active' ? within : !within;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}
