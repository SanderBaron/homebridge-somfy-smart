/* eslint-disable */
/**
 * Offline logica-test voor de rule engine + interlock. Geen box, geen beweging:
 * een nep-client registreert alleen welke commando's eruit zouden komen.
 */
const os = require('os');
const path = require('path');
const { DeviceRegistry } = require('../dist/state/registry');
const { StateStore } = require('../dist/state/store');
const { MoveDispatcher } = require('../dist/engine/dispatcher');
const { RuleEngine } = require('../dist/engine/rule-engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { info: () => {}, warn: () => {}, error: (m) => console.log('[err]', m), debug: () => {} };

const S1 = 'io://box/screen1';      // door regels bestuurd
const S2 = 'io://box/tuindeuren';   // interlocked
const SENSOR = 'io://box/sensor1';
const CONTACT = 'io://box/tuindeur';

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}

(async () => {
  const calls = [];
  const client = { execApply: async (label, actions) => { calls.push({ label, actions }); return 'exec'; } };

  const registry = new DeviceRegistry();
  const store = new StateStore(path.join(os.tmpdir(), `somfy-test-${Date.now()}.json`), log);
  registry.setClosure(S1, 100); // start dicht → HomeKit 0%
  registry.setClosure(S2, 0);   // start open → HomeKit 100%
  registry.setContact(CONTACT, true);

  const groups = new Map([['oost', [S1]]]);
  const dispatcher = new MoveDispatcher({
    client, registry, store, log,
    screenUrls: [S1, S2],
    groups,
    interlocks: new Map([[S2, { contact: CONTACT, mode: 'queue' }]]),
  });

  const rule = {
    id: 'r1', name: 'Zon Oost', enabled: true, targetType: 'screen', targetId: S1,
    minIntervalSec: 0,
    sun: { sensors: [SENSOR], combine: 'avg', thresholdHigh: 20000, thresholdLow: 10000,
      durationDownSec: 0, durationUpSec: 0, adaptiveUp: false, closedPosition: 0, openPosition: 100 },
  };
  const engine = new RuleEngine(registry, dispatcher, store, log, [rule], 3600, groups);
  engine.start();

  console.log('\n— Rule engine: hysterese & drempels —');
  const last = () => calls[calls.length - 1];
  const lastCmd = () => last()?.actions?.[0]?.commands?.[0]?.name;

  registry.setLux(SENSOR, 25000); await sleep(20);
  check('boven hoge drempel → screen omlaag (close)', lastCmd() === 'close');

  const n1 = calls.length;
  registry.setLux(SENSOR, 15000); await sleep(20);
  check('in deadband → geen nieuw commando (hysterese)', calls.length === n1);

  registry.setLux(SENSOR, 5000); await sleep(20);
  check('onder lage drempel → screen omhoog (open)', lastCmd() === 'open');

  const n2 = calls.length;
  registry.setLux(SENSOR, 4000); await sleep(20);
  check('blijft onder → geen herhaling (mode ongewijzigd)', calls.length === n2);
  engine.stop();

  console.log('\n— Interlock: omlaag onderdrukt bij open deur —');
  // Bedrading zoals het platform die legt: contact-wijziging → dispatcher.
  registry.on('contact', (u, c) => dispatcher.onContact(u, c));

  calls.length = 0;
  registry.setContact(CONTACT, false); // deur open

  await dispatcher.applyTarget('screen', S2, 100, 'manual', 'handmatig omhoog');
  check('omhoog bij open deur → wél toegestaan', calls.length === 1 && calls[0].actions[0].commands[0].name === 'open');

  calls.length = 0;
  await dispatcher.applyTarget('screen', S2, 0, 'manual', 'handmatig omlaag');
  check('omlaag bij open deur → onderdrukt (geen commando)', calls.length === 0);

  registry.setContact(CONTACT, true); // deur weer dicht → wachtrij flushen
  await sleep(20);
  check('deur dicht → uitgesteld omlaag wordt alsnog uitgevoerd', calls.length === 1 && calls[0].actions[0].commands[0].name === 'close');

  console.log('\n— Pauze (glazenwasser) —');
  calls.length = 0;
  store.setPaused(true);
  await dispatcher.applyTarget('screen', S1, 0, 'engine', 'engine tijdens pauze');
  check('engine-actie tijdens pauze → geblokkeerd', calls.length === 0);
  await dispatcher.applyTarget('screen', S1, 0, 'manual', 'handmatig tijdens pauze');
  check('handmatige actie tijdens pauze → wél toegestaan', calls.length === 1);
  store.setPaused(false);

  console.log('\n— Pauzeer zonwering: minimum-openstand-grendel —');
  // Zet de regel in 'down'-modus zodat de engine S1 wil sluiten.
  registry.setLux(SENSOR, 25000); await sleep(20);
  check('desiredPositionFor kent de regel-wens (omlaag = 0%)', engine.desiredPositionFor(S1) === 0);

  store.setSunPause(true, { [S1]: 60 }); // grendel: minstens 60% open
  calls.length = 0;
  await dispatcher.applyTarget('screen', S1, 0, 'engine', 'engine wil dicht');
  const cmd = calls[0]?.actions?.[0]?.commands?.[0];
  check('engine-omlaag wordt geclampt op grendel (60% → setClosure 40)', cmd?.name === 'setClosure' && cmd?.parameters?.[0] === 40);

  calls.length = 0;
  await dispatcher.applyTarget('screen', S1, 100, 'engine', 'engine wil open (wolk)');
  check('engine-omhoog mag wél volledig open (grendel blokkeert omhoog niet)', calls[0]?.actions?.[0]?.commands?.[0]?.name === 'open');

  calls.length = 0;
  await dispatcher.applyTarget('screen', S1, 0, 'manual', 'handmatig dicht');
  check('handmatig negeert de grendel (mag volledig dicht)', calls[0]?.actions?.[0]?.commands?.[0]?.name === 'close');
  store.setSunPause(false, {});

  console.log('\n— Asymmetrische vertraging (Somfy-stijl) —');
  {
    const calls2 = [];
    const client2 = { execApply: async (l, a) => { calls2.push({ l, a }); return 'e'; } };
    const reg2 = new DeviceRegistry();
    const store2 = new StateStore(path.join(os.tmpdir(), `somfy-asym-${Date.now()}.json`), log);
    reg2.setClosure(S1, 100);
    const disp2 = new MoveDispatcher({ client: client2, registry: reg2, store: store2, log, screenUrls: [S1], groups: new Map(), interlocks: new Map() });
    const rule2 = {
      id: 'r2', name: 'Asym', enabled: true, targetType: 'screen', targetId: S1, minIntervalSec: 0,
      sun: { sensors: [SENSOR], combine: 'avg', thresholdHigh: 20000, thresholdLow: 10000, durationDownSec: 0, durationUpSec: 100, adaptiveUp: false, closedPosition: 0, openPosition: 100 },
    };
    const eng2 = new RuleEngine(reg2, disp2, store2, log, [rule2], 3600, new Map());
    eng2.start();
    const lastName = () => calls2[calls2.length - 1]?.a?.[0]?.commands?.[0]?.name;
    reg2.setLux(SENSOR, 25000); await sleep(20);
    check('omlaag gaat direct (duur omlaag = 0)', lastName() === 'close');
    calls2.length = 0;
    reg2.setLux(SENSOR, 5000); await sleep(20);
    check('omhoog wacht (duur omhoog = 100s) → nog géén commando', calls2.length === 0);
    eng2.stop();
  }

  console.log(`\n${fail === 0 ? '✓ ALLE' : '✗ ' + fail + ' van de'} ${pass + fail} checks ${fail === 0 ? 'geslaagd' : 'gefaald'}.\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
