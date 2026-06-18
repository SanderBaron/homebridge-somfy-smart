import { OverkizDevice, OverkizState } from './types';

/** Zoek een state op naam in een lijst (of op een device). */
export function findState(
  source: OverkizDevice | OverkizState[] | undefined,
  name: string,
): OverkizState | undefined {
  const states = Array.isArray(source) ? source : source?.states;
  return states?.find((s) => s.name === name);
}

/** Lees een numerieke state; geeft `undefined` als afwezig of niet-numeriek. */
export function numberState(
  source: OverkizDevice | OverkizState[] | undefined,
  name: string,
): number | undefined {
  const v = findState(source, name)?.value;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Lees een string-state. */
export function stringState(
  source: OverkizDevice | OverkizState[] | undefined,
  name: string,
): string | undefined {
  const v = findState(source, name)?.value;
  return typeof v === 'string' ? v : undefined;
}

/** Lees een boolean-state (Overkiz stuurt soms `"true"`/`"false"` als string). */
export function boolState(
  source: OverkizDevice | OverkizState[] | undefined,
  name: string,
): boolean | undefined {
  const v = findState(source, name)?.value;
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'string') {
    return v.toLowerCase() === 'true';
  }
  return undefined;
}
