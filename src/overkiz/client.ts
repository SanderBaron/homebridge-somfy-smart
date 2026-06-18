import { EventEmitter } from 'events';
import * as https from 'https';
import type { Logging } from 'homebridge';

import {
  OverkizAction,
  OverkizDevice,
  OverkizEvent,
  OverkizEventRegisterResponse,
  OverkizExecResponse,
  OverkizGateway,
} from './types';

export interface OverkizClientOptions {
  /** Hostnaam of IP van de gateway. Bv. `gateway-XXXX-XXXX-XXXX.local` of een vast LAN-IP. */
  host: string;
  /** Developer Mode Bearer-token. */
  token: string;
  /**
   * TLS-modus:
   *  - `insecure`: https-agent met rejectUnauthorized=false (LAN-vertrouwen).
   *  - `pinned`:   verifieer tegen de meegegeven Overkiz root-CA (`ca`).
   */
  tlsMode: 'insecure' | 'pinned';
  /** PEM van de Overkiz root-CA, vereist bij `tlsMode: 'pinned'`. */
  ca?: string;
  /** Poll-interval voor de event-listener in ms (richtlijn ~1000). */
  pollIntervalMs: number;
  log: Logging;
}

const API_BASE = '/enduser-mobile-web/1/enduserAPI';
const PORT = 8443;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Lage-niveau client voor de lokale Overkiz Developer Mode API.
 *
 * Verantwoordelijk voor: TLS, auth, GET devices/states, POST /exec/apply, en
 * de event-poll-loop. Emit `stateChanged` per device-state-wijziging zodat de
 * accessory-laag live kan bijwerken.
 *
 * Events:
 *   - 'stateChanged' (deviceURL: string, states: OverkizState[])
 *   - 'reconnect'    ()  — listener opnieuw geregistreerd na verlies
 *   - 'error'        (err: Error)
 */
export class OverkizClient extends EventEmitter {
  private readonly agent: https.Agent;
  private listenerId: string | null = null;
  private polling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: OverkizClientOptions) {
    super();
    this.agent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: opts.tlsMode === 'pinned',
      ...(opts.tlsMode === 'pinned' && opts.ca ? { ca: opts.ca } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Publieke API
  // ---------------------------------------------------------------------------

  /** Test de verbinding; geeft de gateway-info terug of gooit bij fout. */
  async getGateways(): Promise<OverkizGateway[]> {
    return this.request<OverkizGateway[]>('GET', '/setup/gateways');
  }

  /** Haal alle devices op (de discovery-bron). */
  async getDevices(): Promise<OverkizDevice[]> {
    return this.request<OverkizDevice[]>('GET', '/setup/devices');
  }

  /**
   * Voer één action group uit. Bundel hier meerdere devices in om binnen de
   * Overkiz exec-queue-limiet (max 10 gelijktijdige device-commando's) te
   * blijven en `EXEC_QUEUE_FULL` te voorkomen.
   */
  async execApply(label: string, actions: OverkizAction[]): Promise<string> {
    const res = await this.request<OverkizExecResponse>('POST', '/exec/apply', {
      label,
      actions,
    });
    return res.execId;
  }

  /** Gemak: één commando op één device uitvoeren. */
  async execCommand(
    deviceURL: string,
    name: string,
    parameters: (string | number)[] = [],
    label = 'homebridge-somfy-smart',
  ): Promise<string> {
    return this.execApply(label, [{ deviceURL, commands: [{ name, parameters }] }]);
  }

  // ---------------------------------------------------------------------------
  // Event-poll-loop
  // ---------------------------------------------------------------------------

  /** Start de event-listener en poll-loop. Idempotent. */
  async startEventLoop(): Promise<void> {
    this.stopped = false;
    if (this.polling) {
      return;
    }
    this.polling = true;
    await this.registerListener();
    this.scheduleNextPoll();
  }

  /** Stop de poll-loop en geef de agent vrij. */
  stop(): void {
    this.stopped = true;
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.agent.destroy();
  }

  private async registerListener(): Promise<void> {
    const res = await this.request<OverkizEventRegisterResponse>(
      'POST',
      '/events/register',
      {},
    );
    this.listenerId = res.id;
    this.opts.log.debug(`Event-listener geregistreerd: ${this.listenerId}`);
  }

  private scheduleNextPoll(): void {
    if (this.stopped) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, this.opts.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.listenerId) {
      return;
    }
    try {
      const events = await this.request<OverkizEvent[]>(
        'POST',
        `/events/${this.listenerId}/fetch`,
        {},
      );
      for (const ev of events) {
        if (ev.name === 'DeviceStateChangedEvent' && ev.deviceURL && ev.deviceStates) {
          this.emit('stateChanged', ev.deviceURL, ev.deviceStates);
        }
      }
    } catch (err) {
      // Een verlopen/ongeldige listener geeft doorgaans 404 — opnieuw registreren.
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log.debug(`Event-poll fout, listener herstellen: ${message}`);
      try {
        await this.registerListener();
        this.emit('reconnect');
      } catch (reErr) {
        this.emit('error', reErr instanceof Error ? reErr : new Error(String(reErr)));
      }
    } finally {
      this.scheduleNextPoll();
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          host: this.opts.host,
          port: PORT,
          path: API_BASE + path,
          method,
          agent: this.agent,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            Accept: 'application/json',
            ...(payload
              ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`HTTP ${status} ${method} ${path}: ${raw.slice(0, 300)}`));
              return;
            }
            if (!raw) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch {
              reject(new Error(`Ongeldige JSON van ${method} ${path}: ${raw.slice(0, 200)}`));
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Timeout na ${REQUEST_TIMEOUT_MS}ms op ${method} ${path}`));
      });
      req.on('error', reject);

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
