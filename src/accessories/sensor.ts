import type { PlatformAccessory, Service } from 'homebridge';

import type { SomfySmartPlatform } from '../platform';
import { OverkizDevice, OverkizState, StateName } from '../overkiz/types';
import { numberState } from '../overkiz/helpers';
import type { SomfyAccessory } from './base';

/** HAP-minimum voor CurrentAmbientLightLevel. */
const MIN_LUX = 0.0001;

/**
 * Een Somfy zonlichtsensor (io:LightIOSystemSensor) als HomeKit LightSensor.
 * Luminantie komt uit `core:LuminanceState` (lux) — geverifieerd tegen de box.
 */
export class SunSensorAccessory implements SomfyAccessory {
  readonly deviceURL: string;
  private readonly service: Service;

  constructor(
    private readonly platform: SomfySmartPlatform,
    private readonly accessory: PlatformAccessory,
    device: OverkizDevice,
  ) {
    this.deviceURL = device.deviceURL;
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Somfy')
      .setCharacteristic(Characteristic.Model, 'Sunis io zonlichtsensor')
      .setCharacteristic(Characteristic.SerialNumber, device.deviceURL);

    this.service =
      this.accessory.getService(Service.LightSensor) ??
      this.accessory.addService(Service.LightSensor, device.label);

    this.service.setCharacteristic(Characteristic.Name, device.label);

    this.applyLux(numberState(device, StateName.LUMINANCE));
  }

  handleStateChange(states: OverkizState[]): void {
    this.applyLux(numberState(states, StateName.LUMINANCE));
  }

  private applyLux(lux: number | undefined): void {
    if (lux === undefined) {
      return;
    }
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      Math.max(MIN_LUX, lux),
    );
  }
}
