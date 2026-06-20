import * as path from 'path';
import type {
  API,
  Characteristic as CharacteristicClass,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service as ServiceClass,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SomfySmartConfig, resolveHost } from './config';
import { OverkizClient } from './overkiz/client';
import { Controllable, OverkizDevice, OverkizState, StateName } from './overkiz/types';
import { numberState, stringState } from './overkiz/helpers';
import type { SomfyAccessory } from './accessories/base';
import { ScreenAccessory } from './accessories/screen';
import { SunSensorAccessory } from './accessories/sensor';
import { ContactAccessory } from './accessories/contact';
import { GlazenwasserAccessory } from './accessories/glazenwasser';
import { SunPauseAccessory } from './accessories/sunpause';
import { DeviceRegistry } from './state/registry';
import { StateStore } from './state/store';
import { HistoryLog } from './state/history';
import { MoveDispatcher } from './engine/dispatcher';
import { RuleEngine } from './engine/rule-engine';

const GLAZENWASSER_UUID_SEED = 'somfy-smart-glazenwasser';
const SUNPAUSE_UUID_SEED = 'somfy-smart-sunpause';

/**
 * Dynamic platform. Ontdekt de devices live via de lokale Overkiz API, exposeert
 * ze aan HomeKit en draait de slimme laag (rule engine, interlock, glazenwasser).
 */
export class SomfySmartPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof ServiceClass;
  public readonly Characteristic: typeof CharacteristicClass;

  private readonly cached: PlatformAccessory[] = [];
  private readonly handlers = new Map<string, SomfyAccessory>();
  private readonly registry = new DeviceRegistry();

  private readonly config: SomfySmartConfig;
  private client?: OverkizClient;
  private store?: StateStore;
  private history?: HistoryLog;
  private dispatcher?: MoveDispatcher;
  private engine?: RuleEngine;
  private screenUrls: string[] = [];
  private readonly lastLuxLogged = new Map<string, { lux: number; t: number }>();

  constructor(
    public readonly log: Logging,
    config: SomfySmartConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config;

    this.api.on('didFinishLaunching', () => void this.start());
    this.api.on('shutdown', () => {
      this.engine?.stop();
      this.client?.stop();
      this.history?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory);
  }

  private async start(): Promise<void> {
    const host = resolveHost(this.config);
    if (!host || !this.config.token) {
      this.log.error('Configuratie onvolledig: vul minimaal een PIN (of host) én token in. Plugin staat stil.');
      return;
    }

    this.client = new OverkizClient({
      host,
      token: this.config.token,
      tlsMode: this.config.tlsMode ?? 'insecure',
      ca: this.config.caCert,
      pollIntervalMs: this.config.pollIntervalMs ?? 1000,
      log: this.log,
    });

    try {
      const gw = (await this.client.getGateways())[0];
      this.log.info(
        `Verbonden met TaHoma ${gw?.gatewayId ?? '?'} ` +
        `(protocol ${gw?.connectivity?.protocolVersion ?? '?'}, status ${gw?.connectivity?.status ?? '?'})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Kan niet verbinden met de box op ${host}: ${msg}`);
      return;
    }

    const devices = await this.client.getDevices();
    this.seedRegistry(devices);
    this.buildAutomation(devices);
    this.discoverAccessories(devices);

    this.client.on('stateChanged', (url: string, states: OverkizState[]) => this.onStateChanged(url, states));
    this.client.on('reconnect', () => this.log.info('Event-listener hersteld.'));
    this.client.on('error', (err: Error) => this.log.error(`Event-loop fout: ${err.message}`));
    this.registry.on('contact', (url: string, closed: boolean) => {
      this.history?.add({ kind: 'contact', sensor: url, state: closed ? 'closed' : 'open' });
      this.dispatcher?.onContact(url, closed);
    });

    this.engine?.start();
    await this.client.startEventLoop();
    this.log.info('Live event-loop actief.');
  }

  /** Vul de registry met de begin-states uit de discovery (vóór de eerste events). */
  private seedRegistry(devices: OverkizDevice[]): void {
    for (const d of devices) {
      const lux = numberState(d, StateName.LUMINANCE);
      if (lux !== undefined) {
        this.registry.setLux(d.deviceURL, lux);
      }
      const closure = numberState(d, StateName.CLOSURE);
      if (closure !== undefined) {
        this.registry.setClosure(d.deviceURL, closure);
      }
      const contact = stringState(d, StateName.CONTACT);
      if (contact !== undefined) {
        this.registry.setContact(d.deviceURL, contact.toLowerCase() === 'closed');
      }
    }
  }

  /** Bouw store, dispatcher en rule engine uit config + ontdekte screens. */
  private buildAutomation(devices: OverkizDevice[]): void {
    const screenUrls = devices
      .filter((d) => d.controllableName === Controllable.SCREEN)
      .map((d) => d.deviceURL);
    this.screenUrls = screenUrls;
    const auto = this.config.automation ?? {};

    const groups = new Map<string, string[]>();
    for (const g of auto.groups ?? []) {
      const valid = g.screens.filter((s) => screenUrls.includes(s));
      if (valid.length !== g.screens.length) {
        this.log.warn(`Groep '${g.name}' bevat onbekende screens — die worden genegeerd.`);
      }
      groups.set(g.id, valid);
    }

    const interlocks = new Map<string, { contact: string; mode: 'queue' | 'drop'; debounceMs: number }>();
    for (const il of auto.interlocks ?? []) {
      interlocks.set(il.screen, {
        contact: il.contact,
        mode: il.onDoorOpen ?? 'queue',
        debounceMs: (il.closeDebounceSec ?? 10) * 1000,
      });
    }

    const storage = this.api.user.storagePath();
    this.store = new StateStore(path.join(storage, 'somfy-smart-state.json'), this.log);
    this.history = new HistoryLog(path.join(storage, 'somfy-smart-history.json'), this.log);

    this.dispatcher = new MoveDispatcher({
      client: this.client!,
      registry: this.registry,
      store: this.store,
      log: this.log,
      screenUrls,
      groups,
      interlocks,
      history: this.history,
    });

    this.engine = new RuleEngine(
      this.registry,
      this.dispatcher,
      this.store,
      this.log,
      auto.rules ?? [],
      auto.evaluateIntervalSec ?? 10,
      groups,
      this.history,
    );
  }

  private discoverAccessories(devices: OverkizDevice[]): void {
    const exposeSensors = this.config.exposeSensors ?? true;
    const exposeContact = this.config.exposeContact ?? true;
    const activeUuids = new Set<string>();

    for (const device of devices) {
      const factory = this.factoryFor(device, exposeSensors, exposeContact);
      if (!factory) {
        continue;
      }
      const accessory = this.obtainAccessory(device.deviceURL, device.label, activeUuids);
      this.handlers.set(device.deviceURL, factory(accessory));
    }

    this.setupGlazenwasser(activeUuids);
    this.setupSunPause(activeUuids);

    const stale = this.cached.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`${stale.length} verouderde accessory(s) verwijderd.`);
    }
    this.log.info(`Discovery klaar: ${this.handlers.size} bestuurbare device(s).`);
  }

  private factoryFor(
    device: OverkizDevice,
    exposeSensors: boolean,
    exposeContact: boolean,
  ): ((accessory: PlatformAccessory) => SomfyAccessory) | null {
    switch (device.controllableName) {
      case Controllable.SCREEN:
        return (a) => new ScreenAccessory(this, a, this.dispatcher!, device);
      case Controllable.SUN_SENSOR:
        return exposeSensors ? (a) => new SunSensorAccessory(this, a, device) : null;
      case Controllable.CONTACT:
        return exposeContact ? (a) => new ContactAccessory(this, a, device) : null;
      default:
        return null;
    }
  }

  private setupGlazenwasser(activeUuids: Set<string>): void {
    const gw = this.config.automation?.glazenwasser ?? { enabled: true };
    if (gw.enabled === false) {
      return;
    }
    const uuid = this.api.hap.uuid.generate(GLAZENWASSER_UUID_SEED);
    activeUuids.add(uuid);
    const name = gw.name ?? 'Glazenwasser';

    let accessory = this.cached.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Glazenwasser-schakelaar toegevoegd.');
    } else if (accessory.displayName !== name) {
      accessory.displayName = name;
      this.api.updatePlatformAccessories([accessory]);
      this.log.info(`Glazenwasser hernoemd naar "${name}".`);
    }
    new GlazenwasserAccessory(this, accessory, this.dispatcher!, this.store!, gw);
  }

  private setupSunPause(activeUuids: Set<string>): void {
    const sp = this.config.automation?.sunPause ?? { enabled: true };
    if (sp.enabled === false) {
      return;
    }
    const uuid = this.api.hap.uuid.generate(SUNPAUSE_UUID_SEED);
    activeUuids.add(uuid);
    const name = sp.name ?? 'Pauzeer zonwering';

    let accessory = this.cached.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Pauzeer-schakelaar toegevoegd.');
    } else if (accessory.displayName !== name) {
      accessory.displayName = name;
      this.api.updatePlatformAccessories([accessory]);
      this.log.info(`Pauzeer-schakelaar hernoemd naar "${name}".`);
    }
    new SunPauseAccessory(
      this, accessory, this.registry, this.store!, this.engine!, this.screenUrls, sp,
    );
  }

  /** Vind een gecachte accessory of registreer een nieuwe; markeer als actief. */
  private obtainAccessory(
    deviceURL: string,
    label: string,
    activeUuids: Set<string>,
  ): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(deviceURL);
    activeUuids.add(uuid);

    const existing = this.cached.find((a) => a.UUID === uuid);
    if (existing) {
      existing.displayName = label;
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }
    const accessory = new this.api.platformAccessory(label, uuid);
    accessory.context.deviceURL = deviceURL;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.log.info(`Nieuw device toegevoegd: ${label}`);
    return accessory;
  }

  private onStateChanged(url: string, states: OverkizState[]): void {
    this.handlers.get(url)?.handleStateChange(states);

    const lux = numberState(states, StateName.LUMINANCE);
    if (lux !== undefined) {
      this.registry.setLux(url, lux);
      this.recordLux(url, lux);
    }
    const closure = numberState(states, StateName.CLOSURE);
    if (closure !== undefined) {
      this.registry.setClosure(url, closure);
    }
    const contact = stringState(states, StateName.CONTACT);
    if (contact !== undefined) {
      this.registry.setContact(url, contact.toLowerCase() === 'closed');
    }
  }

  /** Leg het lux-verloop vast (gethrottled: bij ≥250 lux verschil of elke ~2 min). */
  private recordLux(url: string, lux: number): void {
    if (!this.history) {
      return;
    }
    const now = Date.now();
    const last = this.lastLuxLogged.get(url);
    if (last && Math.abs(lux - last.lux) < 250 && now - last.t < 120_000) {
      return;
    }
    this.lastLuxLogged.set(url, { lux, t: now });
    this.history.add({ kind: 'lux', sensor: url, lux: Math.round(lux) });
  }
}
