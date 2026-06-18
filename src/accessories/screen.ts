import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SomfySmartPlatform } from '../platform';
import type { MoveDispatcher } from '../engine/dispatcher';
import { OverkizDevice, OverkizState, StateName } from '../overkiz/types';
import { boolState, numberState } from '../overkiz/helpers';
import type { SomfyAccessory } from './base';

/**
 * Een io-screen (io:VerticalExteriorAwningIOComponent) als HomeKit WindowCovering.
 *
 * GEVERIFIEERDE mapping (tegen echte box): Overkiz `core:ClosureState` is
 * geïnverteerd t.o.v. HomeKit. Closure 0 = volledig omhoog/open, 100 = volledig
 * omlaag/dicht. HomeKit-positie 100 = open, 0 = dicht. Dus:
 *
 *     homekitPosition = 100 - closure
 *     closure         = 100 - homekitPosition
 */
export class ScreenAccessory implements SomfyAccessory {
  readonly deviceURL: string;
  private readonly service: Service;
  private targetPosition = 100;
  private currentPosition = 100;

  constructor(
    private readonly platform: SomfySmartPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly dispatcher: MoveDispatcher,
    device: OverkizDevice,
  ) {
    this.deviceURL = device.deviceURL;
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Somfy')
      .setCharacteristic(Characteristic.Model, 'io VerticalExteriorAwning')
      .setCharacteristic(Characteristic.SerialNumber, device.deviceURL);

    this.service =
      this.accessory.getService(Service.WindowCovering) ??
      this.accessory.addService(Service.WindowCovering, device.label);

    this.service.setCharacteristic(Characteristic.Name, device.label);

    this.service.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.targetPosition)
      .onSet(this.setTargetPosition.bind(this));

    this.service.getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.currentPosition);

    this.service.getCharacteristic(Characteristic.PositionState)
      .onGet(() => Characteristic.PositionState.STOPPED);

    // Initiële stand uit de discovery-states.
    this.applyClosure(numberState(device, StateName.CLOSURE));
    if (boolState(device, StateName.MOVING) === false) {
      this.setStopped();
    }
  }

  /** HomeKit → box: gebruiker schuift het screen. Loopt via de dispatcher,
   * zodat de interlock ook handmatige omlaag-commando's afdekt. */
  private async setTargetPosition(value: CharacteristicValue): Promise<void> {
    const position = Math.max(0, Math.min(100, Math.round(Number(value))));
    this.targetPosition = position;
    const { Characteristic } = this.platform;

    // Richting voor PositionState bepalen vóór we het commando sturen.
    this.service.updateCharacteristic(
      Characteristic.PositionState,
      position > this.currentPosition
        ? Characteristic.PositionState.INCREASING
        : Characteristic.PositionState.DECREASING,
    );

    await this.dispatcher.applyTarget(
      'screen',
      this.deviceURL,
      position,
      'manual',
      `handmatig: ${this.accessory.displayName}`,
    );
  }

  /** Box → HomeKit: live state-update uit de event-loop. */
  handleStateChange(states: OverkizState[]): void {
    const closure = numberState(states, StateName.CLOSURE);
    if (closure !== undefined) {
      this.applyClosure(closure);
    }
    const moving = boolState(states, StateName.MOVING);
    if (moving === false) {
      this.setStopped();
    }
  }

  private applyClosure(closure: number | undefined): void {
    if (closure === undefined) {
      return;
    }
    this.currentPosition = Math.max(0, Math.min(100, 100 - closure));
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentPosition,
      this.currentPosition,
    );
  }

  private setStopped(): void {
    const { Characteristic } = this.platform;
    // Beweging klaar: huidige stand is de doelstand.
    this.targetPosition = this.currentPosition;
    this.service.updateCharacteristic(Characteristic.TargetPosition, this.targetPosition);
    this.service.updateCharacteristic(
      Characteristic.PositionState,
      Characteristic.PositionState.STOPPED,
    );
  }
}
