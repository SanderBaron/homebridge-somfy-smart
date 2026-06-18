import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SomfySmartPlatform } from '../platform';
import type { MoveDispatcher } from '../engine/dispatcher';
import type { StateStore } from '../state/store';
import type { GlazenwasserConfig } from '../engine/types';

/**
 * Stateful "Glazenwasser"-schakelaar voor Siri ("activeer glazenwasser").
 *
 * AAN  → alle screens omhoog + engine gepauzeerd (geen omlaag-acties meer).
 * UIT  → normale werking hervat.
 * Optioneel auto-hervat na N uur; pauze-status overleeft een herstart.
 */
export class GlazenwasserAccessory {
  private readonly service: Service;
  private autoResumeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: SomfySmartPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly dispatcher: MoveDispatcher,
    private readonly store: StateStore,
    private readonly config: GlazenwasserConfig,
  ) {
    const { Service, Characteristic } = this.platform;
    const name = config.name ?? 'Glazenwasser';

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'homebridge-somfy-smart')
      .setCharacteristic(Characteristic.Model, 'Glazenwasser-modus')
      .setCharacteristic(Characteristic.SerialNumber, 'glazenwasser');

    this.service =
      this.accessory.getService(Service.Switch) ??
      this.accessory.addService(Service.Switch, name);
    this.service.setCharacteristic(Characteristic.Name, name);
    // ConfiguredName is wat Apple Home gebruikt voor de tegelnaam (en renames).
    this.service.setCharacteristic(Characteristic.ConfiguredName, name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.store.paused)
      .onSet(this.setOn.bind(this));

    // Herstel toestand na herstart: stond de glazenwasser aan, reflecteer dat
    // en herplan een eventueel auto-hervat.
    if (this.store.paused) {
      this.service.updateCharacteristic(Characteristic.On, true);
      this.restoreAutoResume();
    }
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    if (value) {
      this.store.setPaused(true);
      this.platform.log.info('Glazenwasser AAN — alle screens omhoog, engine gepauzeerd.');
      await this.dispatcher.moveAll(100, 'system', 'glazenwasser: alles omhoog');
      this.scheduleAutoResume();
    } else {
      this.clearAutoResume();
      this.store.setGlazenwasserUntil(null);
      this.store.setPaused(false);
      this.platform.log.info('Glazenwasser UIT — normale werking hervat.');
    }
  }

  private scheduleAutoResume(): void {
    this.clearAutoResume();
    const hours = this.config.autoResumeHours ?? 0;
    if (hours <= 0) {
      this.store.setGlazenwasserUntil(null);
      return;
    }
    const until = new Date(Date.now() + hours * 3600_000);
    this.store.setGlazenwasserUntil(until);
    this.armTimer(until);
  }

  private restoreAutoResume(): void {
    const until = this.store.glazenwasserUntil;
    if (!until) {
      return;
    }
    if (until.getTime() <= Date.now()) {
      void this.setOn(false);
    } else {
      this.armTimer(until);
    }
  }

  private armTimer(until: Date): void {
    const ms = Math.max(0, until.getTime() - Date.now());
    this.autoResumeTimer = setTimeout(() => {
      this.platform.log.info('Glazenwasser auto-hervat (timeout verstreken).');
      this.service.updateCharacteristic(this.platform.Characteristic.On, false);
      void this.setOn(false);
    }, ms);
  }

  private clearAutoResume(): void {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
  }
}
