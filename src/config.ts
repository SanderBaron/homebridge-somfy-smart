import type { PlatformConfig } from 'homebridge';

import type { AutomationConfig } from './engine/types';

/** Door de gebruiker ingestelde config (via config.schema.json of custom UI). */
export interface SomfySmartConfig extends PlatformConfig {
  /** Gateway-PIN, formaat `xxxx-xxxx-xxxx`. Gebruikt voor `gateway-{PIN}.local`. */
  pin?: string;
  /** Optioneel vast LAN-IP/hostnaam i.p.v. mDNS-naam (fallback / vaste setup). */
  host?: string;
  /** Developer Mode Bearer-token. */
  token?: string;
  /** TLS-modus op het LAN. Default `insecure`. */
  tlsMode?: 'insecure' | 'pinned';
  /** PEM van de Overkiz root-CA (alleen bij `tlsMode: 'pinned'`). */
  caCert?: string;
  /** Expose elke zonlichtsensor als HomeKit-lichtsensor (lux). Default true. */
  exposeSensors?: boolean;
  /** Expose het deurcontact als HomeKit ContactSensor. Default true. */
  exposeContact?: boolean;
  /** Poll-interval voor de event-listener in ms. Default 1000. */
  pollIntervalMs?: number;
  /** Slimme laag: groepen, regels, interlocks en glazenwasser. */
  automation?: AutomationConfig;
}

/** Bouw de effectieve gateway-host uit config (expliciete host wint). */
export function resolveHost(config: SomfySmartConfig): string | undefined {
  if (config.host && config.host.trim()) {
    return config.host.trim();
  }
  if (config.pin && config.pin.trim()) {
    return `gateway-${config.pin.trim()}.local`;
  }
  return undefined;
}
