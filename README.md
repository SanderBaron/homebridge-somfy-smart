# Homebridge Somfy Smart

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Homebridge](https://img.shields.io/badge/homebridge-v2-purple.svg)](https://homebridge.io)

Een slimme [Homebridge](https://homebridge.io)-plugin voor Somfy zonwering via de
**lokale TaHoma Developer Mode API** (Overkiz). De plugin is zelf het brein: hij
leest de zonlichtsensoren live uit en bepaalt zélf wanneer screens omhoog of
omlaag gaan. Geen logica in de Somfy-box, geen logica in Apple Home.

> **Eenmalige stap:** zet het ingebouwde *Smart*-zonscenario in de TaHoma-app uit.
> Anders sturen de box én deze plugin allebei je screens aan.

## Functies

- 🪟 **Screens** als HomeKit `WindowCovering`, individueel of in **groepen** (bv. Oost / Zuid).
- ☀️ **Zonlichtsensoren** als HomeKit lichtsensor (lux), willekeurig aantal.
- 🚪 **Deurcontact** als `ContactSensor`.
- 🧠 **Rule engine** op basis van zonlicht en/of tijd, met **Somfy-stijl anti-pendel** (zie onder).
- 🔒 **Deurcontact-interlock**: een screen mag alleen omlaag als het gekoppelde contact gesloten is.
- 🧽 **Glazenwasser-knop**: alle screens omhoog + automatisering gepauzeerd ("Hey Siri, activeer glazenwasser").
- ⏸️ **Pauzeer-knop**: legt een minimum-openstand vast op een handmatig opengezet scherm (bv. droogrek achter het raam) — het scherm mag mee omhoog, maar niet verder dicht.
- 🖥️ **Grafische config-UI** (Config UI X custom interface): verbinding testen, live devices, rule-builder en status.
- 💾 Pauze-status en laatste acties **overleven een herstart**.

## Anti-pendel zoals Somfy het doet

Echte Somfy-zonsensoren (Soliris/Sunis) voorkomen pendelen niet met een lux-deadband,
maar met **asymmetrische tijdsvertragingen**:

| Gebeurtenis | Vertraging |
|---|---|
| Zon boven drempel → **omlaag** | ~2 minuten |
| Zon onder drempel → **omhoog** | 15–30 minuten, **variabel naarmate de zon langer scheen** |

Die adaptieve omhoog-vertraging is de truc: een kort wolkje kan een lang-bezond
screen niet omhoog jagen. Deze plugin neemt dat over via aparte *duur omlaag* /
*duur omhoog* per regel, plus een optie om de omhoog-vertraging mee te laten groeien
met de zonduur (tot 2×). Daarbovenop is er een lux-hysterese (aparte hoge/lage
drempel) en een minimaal interval tussen commando's.

## HomeKit-positie ↔ Overkiz closure

Overkiz `core:ClosureState` is geïnverteerd t.o.v. HomeKit. De plugin mapt dit zo dat
het intuïtief klopt:

```
HomeKit-positie 100% = scherm omhoog/open   (closure 0)
HomeKit-positie 0%   = scherm omlaag/dicht  (closure 100)
```

## Vereisten

- Homebridge v1.8+ of v2.
- Node.js 18/20/22/24.
- Een TaHoma-box met **Developer Mode** ingeschakeld (PIN + Bearer-token).
  Zie [developer.somfy.com](https://developer.somfy.com/developer-mode).

## Installatie (vanaf broncode)

> Nog niet op npm gepubliceerd. Tot die tijd vanaf de broncode:

```bash
git clone https://github.com/SanderBaron/homebridge-somfy-smart.git
cd homebridge-somfy-smart
npm install
npm run build
npm link        # registreert de plugin globaal voor Homebridge
```

Herstart Homebridge en voeg het platform toe via de UI of in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "SomfySmart",
      "name": "Somfy Smart",
      "pin": "xxxx-xxxx-xxxx",
      "token": "<developer-mode-token>",
      "tlsMode": "insecure"
    }
  ]
}
```

De volledige beheerflow (devices, groepen, regels, interlock, knoppen) loopt via de
**custom UI** onder *Plugins → Homebridge Somfy Smart → Settings*.

### TLS-modus

- `insecure` (default): accepteert het zelfondertekende certificaat van de box. De
  normale keuze op een vertrouwd thuisnetwerk.
- `pinned`: verifieert tegen de Overkiz root-CA (PEM in `caCert`).

## Geverifieerde API-feiten

Niets in deze plugin is hardgecodeerd zonder verificatie. Bij het opstarten leest de
plugin `GET /setup/devices` en mapt op `controllableName`:

| controllableName | type | relevante states / commando's |
|---|---|---|
| `io:VerticalExteriorAwningIOComponent` | screen | `core:ClosureState`, `core:MovingState`; `open`/`close`/`stop`/`my`/`setClosure` |
| `io:LightIOSystemSensor` | zonsensor | `core:LuminanceState` (lux) |
| `io:SomfyContactIOSystemSensor` | deurcontact | `core:ContactState` |

Communicatie verloopt over de lokale API
(`https://gateway-XXXX-XXXX-XXXX.local:8443/enduser-mobile-web/1/enduserAPI`),
met een event-listener (`/events/register` → `/events/{id}/fetch`) voor live updates
en `POST /exec/apply` voor commando's (gebundeld om de Overkiz exec-queue-limiet te respecteren).

## Ontwikkeling

```bash
npm run build      # TypeScript → dist/
npm run lint       # ESLint
node scripts/engine-test.js   # offline logica-test van de rule engine + interlock
```

## Licentie

[MIT](LICENSE) © Sander Baron
