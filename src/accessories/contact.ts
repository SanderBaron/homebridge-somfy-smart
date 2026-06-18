import type { PlatformAccessory, Service } from 'homebridge';

import type { SomfySmartPlatform } from '../platform';
import { OverkizDevice, OverkizState, StateName } from '../overkiz/types';
import { stringState } from '../overkiz/helpers';
import type { SomfyAccessory } from './base';

/**
 * Het deurcontact (io:SomfyContactIOSystemSensor) als HomeKit ContactSensor.
 * `core:ContactState` is `"closed"` of `"open"` — geverifieerd tegen de box.
 *
 * Deze sensor voedt straks (fase 2) de interlock: het screen boven de tuindeur
 * mag alleen omlaag als dit contact `closed` is.
 */
export class ContactAccessory implements SomfyAccessory {
  readonly deviceURL: string;
  private readonly service: Service;

  /** Laatst bekende stand; true = gesloten. Bruikbaar voor de interlock. */
  closed = true;

  constructor(
    private readonly platform: SomfySmartPlatform,
    private readonly accessory: PlatformAccessory,
    device: OverkizDevice,
  ) {
    this.deviceURL = device.deviceURL;
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Somfy')
      .setCharacteristic(Characteristic.Model, 'io deurcontact')
      .setCharacteristic(Characteristic.SerialNumber, device.deviceURL);

    this.service =
      this.accessory.getService(Service.ContactSensor) ??
      this.accessory.addService(Service.ContactSensor, device.label);

    this.service.setCharacteristic(Characteristic.Name, device.label);

    this.applyContact(stringState(device, StateName.CONTACT));
  }

  handleStateChange(states: OverkizState[]): void {
    this.applyContact(stringState(states, StateName.CONTACT));
  }

  private applyContact(value: string | undefined): void {
    if (value === undefined) {
      return;
    }
    this.closed = value.toLowerCase() === 'closed';
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(
      Characteristic.ContactSensorState,
      this.closed
        ? Characteristic.ContactSensorState.CONTACT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
  }
}
