import type { Logging } from 'homebridge';

import type { OverkizClient } from '../overkiz/client';
import { Command, OverkizAction } from '../overkiz/types';
import type { DeviceRegistry } from '../state/registry';
import type { StateStore } from '../state/store';
import { MoveSource } from './types';

interface InterlockEntry {
  contact: string;
  mode: 'queue' | 'drop';
}

export interface DispatcherOptions {
  client: OverkizClient;
  registry: DeviceRegistry;
  store: StateStore;
  log: Logging;
  /** Alle screen-deviceURLs (voor moveAll / glazenwasser). */
  screenUrls: string[];
  /** group-id → screen-deviceURLs. */
  groups: Map<string, string[]>;
  /** screen-deviceURL → interlock. */
  interlocks: Map<string, InterlockEntry>;
}

/**
 * Eén centrale poort waardoor ÁLLE screen-bewegingen lopen (handmatig, engine,
 * glazenwasser). Verantwoordelijk voor:
 *  - pauze (engine-acties worden geblokkeerd als de plugin gepauzeerd is)
 *  - interlock (omlaag onderdrukt zolang het gekoppelde deurcontact open is)
 *  - exec-queue-veiligheid (groep-bewegingen in één action group)
 *  - persistentie van de laatste actie per screen
 */
export class MoveDispatcher {
  /** Onderdrukte omlaag-commando's die wachten tot de deur weer dicht is. */
  private readonly pendingDown = new Map<string, { position: number; reason: string }>();

  constructor(private readonly opts: DispatcherOptions) {}

  /** Beweeg één screen of een hele groep naar een HomeKit-positie (0-100). */
  async applyTarget(
    targetType: 'screen' | 'group',
    targetId: string,
    position: number,
    source: MoveSource,
    reason: string,
  ): Promise<void> {
    const screens = this.resolveScreens(targetType, targetId);
    await this.move(screens, position, source, reason);
  }

  /** Beweeg alle screens (gebruikt door de glazenwasser-knop: alles omhoog). */
  async moveAll(position: number, source: MoveSource, reason: string): Promise<void> {
    await this.move(this.opts.screenUrls, position, source, reason);
  }

  /** Reageer op een contact-wijziging: bij 'dicht' de gewachte omlaag-commando's alsnog uitvoeren. */
  onContact(contactUrl: string, closed: boolean): void {
    if (!closed || this.pendingDown.size === 0) {
      return;
    }
    const toFlush: { url: string; position: number; reason: string }[] = [];
    for (const [url, pend] of this.pendingDown) {
      if (this.opts.interlocks.get(url)?.contact === contactUrl) {
        toFlush.push({ url, ...pend });
        this.pendingDown.delete(url);
      }
    }
    if (toFlush.length) {
      this.opts.log.info(`Deur dicht — ${toFlush.length} uitgesteld omlaag-commando alsnog uitvoeren.`);
      void this.executeBatch(
        toFlush.map((m) => ({ url: m.url, position: m.position })),
        'interlock: deur weer dicht',
      );
    }
  }

  private resolveScreens(targetType: 'screen' | 'group', targetId: string): string[] {
    if (targetType === 'group') {
      const screens = this.opts.groups.get(targetId);
      if (!screens) {
        this.opts.log.warn(`Onbekende groep '${targetId}' in regel — overgeslagen.`);
        return [];
      }
      return screens;
    }
    return [targetId];
  }

  private async move(
    screens: string[],
    position: number,
    source: MoveSource,
    reason: string,
  ): Promise<void> {
    if (source === 'engine' && this.opts.store.paused) {
      this.opts.log.debug(`Engine-actie '${reason}' overgeslagen: plugin is gepauzeerd.`);
      return;
    }

    const allowed: { url: string; position: number }[] = [];
    for (const url of screens) {
      // "Pauzeer zonwering"-grendel: engine mag niet verder dicht dan de
      // vastgelegde minimum-openstand. Omhoog (verder open) blijft vrij.
      let effective = position;
      if (source === 'engine') {
        const cap = this.opts.store.getCap(url);
        if (cap !== undefined && effective < cap) {
          effective = cap;
        }
      }

      if (this.isDownwardBlocked(url, effective)) {
        const il = this.opts.interlocks.get(url)!;
        if (il.mode === 'queue') {
          this.pendingDown.set(url, { position: effective, reason });
          this.opts.log.info(`Interlock: '${reason}' op ${url} uitgesteld — deur staat open.`);
        } else {
          this.opts.log.info(`Interlock: '${reason}' op ${url} vervallen — deur staat open.`);
        }
        continue;
      }
      // Een toegestaan (nieuw) commando annuleert een eerder uitgesteld omlaag.
      this.pendingDown.delete(url);
      allowed.push({ url, position: effective });
    }

    if (allowed.length) {
      await this.executeBatch(allowed, reason);
    }
  }

  /** Blokkeert de interlock dit (omlaag-)commando? */
  private isDownwardBlocked(screenUrl: string, position: number): boolean {
    const il = this.opts.interlocks.get(screenUrl);
    if (!il) {
      return false;
    }
    if (this.opts.registry.isClosed(il.contact)) {
      return false; // deur dicht → altijd toegestaan
    }
    // Deur open: alleen omlaag (verder dichtdoen) onderdrukken; omhoog mag.
    const current = this.opts.registry.getPosition(screenUrl) ?? 100;
    return position < current;
  }

  private async executeBatch(
    moves: { url: string; position: number }[],
    reason: string,
  ): Promise<void> {
    const actions: OverkizAction[] = moves.map((m) => ({
      deviceURL: m.url,
      commands: [buildCommand(m.position)],
    }));
    try {
      await this.opts.client.execApply(reason, actions);
      const at = new Date().toISOString();
      for (const m of moves) {
        this.opts.store.recordAction(m.url, { position: m.position, reason, at });
      }
      this.opts.log.info(`'${reason}': ${moves.length} screen(s) → ${moves.map((m) => `${m.position}%`).join(', ')}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log.error(`Commando '${reason}' faalde: ${msg}`);
    }
  }
}

/** HomeKit-positie → Overkiz-commando. 100=open, 0=dicht, ertussen=setClosure. */
function buildCommand(position: number): { name: string; parameters?: number[] } {
  const pos = Math.max(0, Math.min(100, Math.round(position)));
  if (pos >= 100) {
    return { name: Command.OPEN };
  }
  if (pos <= 0) {
    return { name: Command.CLOSE };
  }
  return { name: Command.SET_CLOSURE, parameters: [100 - pos] };
}
