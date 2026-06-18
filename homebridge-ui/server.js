/* eslint-disable */
'use strict';

const fs = require('fs');
const path = require('path');
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { OverkizClient } = require('../dist/overkiz/client');

// Geverifieerde controllableNames → UI-type.
const TYPE = {
  'io:LightIOSystemSensor': 'sensor',
  'io:VerticalExteriorAwningIOComponent': 'screen',
  'io:SomfyContactIOSystemSensor': 'contact',
};

const stateName = {
  lux: 'core:LuminanceState',
  closure: 'core:ClosureState',
  contact: 'core:ContactState',
};

function st(dev, name) {
  return (dev.states || []).find((s) => s.name === name)?.value;
}

function resolveHost(p) {
  if (p.host && String(p.host).trim()) return String(p.host).trim();
  if (p.pin && String(p.pin).trim()) return `gateway-${String(p.pin).trim()}.local`;
  return null;
}

// Minimale logger voor de client binnen de UI-server.
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

class SomfyUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/test-connection', this.testConnection.bind(this));
    this.onRequest('/devices', this.devices.bind(this));
    this.onRequest('/status', this.status.bind(this));
    this.ready();
  }

  buildClient(payload) {
    const host = resolveHost(payload);
    if (!host || !payload.token) {
      throw new RequestError('Vul een PIN (of host) én token in.', { status: 400 });
    }
    return new OverkizClient({
      host,
      token: payload.token,
      tlsMode: payload.tlsMode === 'pinned' ? 'pinned' : 'insecure',
      ca: payload.caCert,
      pollIntervalMs: 1000,
      log,
    });
  }

  async testConnection(payload) {
    const client = this.buildClient(payload);
    try {
      const gw = (await client.getGateways())[0];
      return {
        ok: true,
        gatewayId: gw?.gatewayId,
        protocol: gw?.connectivity?.protocolVersion,
        status: gw?.connectivity?.status,
      };
    } catch (e) {
      throw new RequestError(`Verbinding mislukt: ${e.message}`, { status: 502 });
    } finally {
      client.stop();
    }
  }

  async devices(payload) {
    const client = this.buildClient(payload);
    try {
      const raw = await client.getDevices();
      const devices = raw
        .map((d) => {
          const type = TYPE[d.controllableName];
          if (!type) return null;
          const base = { type, label: d.label, deviceURL: d.deviceURL };
          if (type === 'sensor') base.lux = Number(st(d, stateName.lux));
          if (type === 'screen') {
            const closure = Number(st(d, stateName.closure));
            base.closure = closure;
            base.position = 100 - closure; // HomeKit-positie
          }
          if (type === 'contact') base.contact = st(d, stateName.contact);
          return base;
        })
        .filter(Boolean);
      return { devices };
    } catch (e) {
      throw new RequestError(`Devices ophalen mislukt: ${e.message}`, { status: 502 });
    } finally {
      client.stop();
    }
  }

  // Leest het persistente state-bestand (pauze + laatste acties).
  async status() {
    const file = path.join(this.homebridgeStoragePath, 'somfy-smart-state.json');
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (e) {
      // val terug op lege status
    }
    return { paused: false, glazenwasserUntil: null, lastActions: {} };
  }
}

(() => new SomfyUiServer())();
