import { EventEmitter } from 'events';

/**
 * Centrale live-status van alle devices, gevoed door de discovery én de
 * event-loop. Eén bron van waarheid die de rule engine, dispatcher en
 * interlock raadplegen.
 *
 * Events:
 *   - 'sensor'  (deviceURL, lux)            — luminantie gewijzigd
 *   - 'contact' (deviceURL, closed)         — deurcontact gewijzigd (alleen bij echte wijziging)
 */
export class DeviceRegistry extends EventEmitter {
  private readonly lux = new Map<string, number>();
  private readonly closure = new Map<string, number>();
  private readonly contactClosed = new Map<string, boolean>();

  setLux(deviceURL: string, value: number): void {
    this.lux.set(deviceURL, value);
    this.emit('sensor', deviceURL, value);
  }

  getLux(deviceURL: string): number | undefined {
    return this.lux.get(deviceURL);
  }

  /** Alle bekende sensor-URLs (handig als een regel "alle sensoren" wil). */
  luxUrls(): string[] {
    return [...this.lux.keys()];
  }

  setClosure(deviceURL: string, closure: number): void {
    this.closure.set(deviceURL, closure);
  }

  /** Huidige HomeKit-positie (100 = open). Undefined als onbekend. */
  getPosition(deviceURL: string): number | undefined {
    const c = this.closure.get(deviceURL);
    return c === undefined ? undefined : 100 - c;
  }

  setContact(deviceURL: string, closed: boolean): void {
    const prev = this.contactClosed.get(deviceURL);
    this.contactClosed.set(deviceURL, closed);
    if (prev !== closed) {
      this.emit('contact', deviceURL, closed);
    }
  }

  /** Is het contact gesloten? Default true (veilig: geen onterechte blokkade bij onbekend). */
  isClosed(deviceURL: string): boolean {
    return this.contactClosed.get(deviceURL) ?? true;
  }
}
