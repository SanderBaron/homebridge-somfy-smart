/**
 * Type-definities voor de lokale Overkiz Developer Mode API.
 *
 * Alle namen hieronder zijn GEVERIFIEERD tegen een echte TaHoma-box
 * (protocolVersion 2026.1.3-4) via `GET /setup/devices`. Niets is verzonnen.
 * Zie README → "Geverifieerde API-feiten" voor de discovery-dump.
 */

/** Eén state zoals teruggegeven door de box, bv. `core:LuminanceState` = 8509. */
export interface OverkizState {
  name: string;
  type: number;
  value: string | number | boolean | unknown[];
}

/** Command-definitie uit `definition.commands` van een device. */
export interface OverkizCommandDefinition {
  commandName: string;
  /** Aantal verwachte parameters (0 indien afwezig). */
  nparams?: number;
}

export interface OverkizDeviceDefinition {
  commands?: OverkizCommandDefinition[];
  states?: { qualifiedName: string; type: string }[];
}

/** Eén device uit `GET /setup/devices`. */
export interface OverkizDevice {
  deviceURL: string;
  label: string;
  /**
   * De betrouwbare type-discriminator op de LOKALE API.
   * (`uiClass`/`widget` zijn op de lokale API vaak `null` — daarom gebruiken
   * we `controllableName`, bv. `io:VerticalExteriorAwningIOComponent`.)
   */
  controllableName: string;
  uiClass?: string | null;
  widget?: string | null;
  states?: OverkizState[];
  definition?: OverkizDeviceDefinition;
  available?: boolean;
  enabled?: boolean;
}

export interface OverkizGateway {
  gatewayId: string;
  connectivity?: { protocolVersion?: string; status?: string };
}

/** Eén commando binnen een action group voor `POST /exec/apply`. */
export interface OverkizCommand {
  name: string;
  parameters?: (string | number)[];
}

/** Eén action binnen een action group: alle commando's voor één device. */
export interface OverkizAction {
  deviceURL: string;
  commands: OverkizCommand[];
}

export interface OverkizExecResponse {
  execId: string;
}

export interface OverkizEventRegisterResponse {
  id: string;
}

/** Een event uit `POST /events/{listenerId}/fetch`. */
export interface OverkizEvent {
  name: string;
  deviceURL?: string;
  deviceStates?: OverkizState[];
  newState?: string;
  [key: string]: unknown;
}

/**
 * Geverifieerde Overkiz `controllableName`-waarden op deze box.
 * Gebruikt door de discovery-laag om devices op type te mappen.
 */
export const Controllable = {
  /** io:LightIOSystemSensor — Somfy Sunis zonlichtsensor, lux in core:LuminanceState. */
  SUN_SENSOR: 'io:LightIOSystemSensor',
  /** io:VerticalExteriorAwningIOComponent — io-screen / verticaal uitvalscherm. */
  SCREEN: 'io:VerticalExteriorAwningIOComponent',
  /** io:SomfyContactIOSystemSensor — deurcontact, core:ContactState. */
  CONTACT: 'io:SomfyContactIOSystemSensor',
} as const;

/** Geverifieerde state-namen die we daadwerkelijk uitlezen. */
export const StateName = {
  LUMINANCE: 'core:LuminanceState',
  CONTACT: 'core:ContactState',
  CLOSURE: 'core:ClosureState',
  TARGET_CLOSURE: 'core:TargetClosureState',
  OPEN_CLOSED: 'core:OpenClosedState',
  MOVING: 'core:MovingState',
  MEMORIZED_1: 'core:Memorized1PositionState',
  STATUS: 'core:StatusState',
  RSSI: 'core:RSSILevelState',
} as const;

/** Geverifieerde commando-namen op de screens. */
export const Command = {
  OPEN: 'open',
  CLOSE: 'close',
  STOP: 'stop',
  UP: 'up',
  DOWN: 'down',
  MY: 'my',
  SET_CLOSURE: 'setClosure',
} as const;
