import type { OverkizState } from '../overkiz/types';

/**
 * Gemeenschappelijk contract voor elke Somfy-accessory: de platform-laag routeert
 * live state-wijzigingen (uit de event-loop) naar de juiste accessory via deze
 * methode.
 */
export interface SomfyAccessory {
  readonly deviceURL: string;
  handleStateChange(states: OverkizState[]): void;
}
