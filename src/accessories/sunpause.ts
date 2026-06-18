import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SomfySmartPlatform } from '../platform';
import type { DeviceRegistry } from '../state/registry';
import type { StateStore } from '../state/store';
import type { RuleEngine } from '../engine/rule-engine';
import type { SunPauseConfig } from '../engine/types';

/** Een scherm telt als "afwijkend" als het meer dan zoveel % openstaat dan de regel wil. */
const TOLERANCE = 5;

/**
 * Stateful "Pauzeer zonwering"-schakelaar.
 *
 * AAN  → voor elk scherm dat op dit moment méér open staat dan de regels willen
 *        (handmatig opengezet, bv. voor een droogrek) wordt de huidige openstand
 *        als minimum-grendel vastgelegd. Het scherm blijft door de engine bestuurd
 *        — het mag mee omhoog bij bewolking, maar gaat niet verder dicht dan die stand.
 * UIT  → alle grendels eraf.
 *
 * Beweegt zelf niets bij inschakelen; legt alleen de grenzen vast. De grendels
 * overleven een herstart (persistente state).
 */
export class SunPauseAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: SomfySmartPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly registry: DeviceRegistry,
    private readonly store: StateStore,
    private readonly engine: RuleEngine,
    private readonly screenUrls: string[],
    config: SunPauseConfig,
  ) {
    const { Service, Characteristic } = this.platform;
    const name = config.name ?? 'Pauzeer zonwering';

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'homebridge-somfy-smart')
      .setCharacteristic(Characteristic.Model, 'Pauzeer-zonwering')
      .setCharacteristic(Characteristic.SerialNumber, 'sunpause');

    this.service =
      this.accessory.getService(Service.Switch) ??
      this.accessory.addService(Service.Switch, name);
    this.service.setCharacteristic(Characteristic.Name, name);
    // ConfiguredName is wat Apple Home gebruikt voor de tegelnaam (en renames).
    this.service.setCharacteristic(Characteristic.ConfiguredName, name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.store.sunPause)
      .onSet(this.setOn.bind(this));

    if (this.store.sunPause) {
      this.service.updateCharacteristic(Characteristic.On, true);
    }
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    if (!value) {
      this.store.setSunPause(false, {});
      this.platform.log.info('Pauzeer zonwering UIT — alle grendels eraf.');
      return;
    }

    const caps: Record<string, number> = {};
    const frozen: string[] = [];
    for (const url of this.screenUrls) {
      const desired = this.engine.desiredPositionFor(url);
      const actual = this.registry.getPosition(url);
      if (desired === undefined || actual === undefined) {
        continue;
      }
      // Afwijkend = handmatig verder open dan de regel wil.
      if (actual > desired + TOLERANCE) {
        caps[url] = actual;
        frozen.push(`${url} → min ${actual}%`);
      }
    }
    this.store.setSunPause(true, caps);

    if (frozen.length) {
      this.platform.log.info(`Pauzeer zonwering AAN — grendels: ${frozen.join(', ')}.`);
    } else {
      this.platform.log.info('Pauzeer zonwering AAN — geen enkel scherm wijkt af, niets vastgelegd.');
    }
  }
}
