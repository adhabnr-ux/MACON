#!/usr/bin/env node
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { loadConfig, saveConfig, validateConfig, lanAddresses, DEFAULT_CONFIG_PATH } from '../src/config.js';
import { hashPin } from '../src/auth.js';
import { normalizeMac } from '../src/magic.js';
import { createServer } from '../src/server.js';
import { createWaker } from '../src/wake.js';
import { pinDigest } from '../relay/core.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAwake } from '../src/probe.js';

const [cmd = 'help', ...rest] = argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; }));

const HELP = `macon - wake my Mac from my phone

  macon init [--mac=aa:bb:cc:dd:ee:ff] [--ip=192.168.1.20] [--name="My Mac"] [--pin=123456 | --random-pin] [--trust-proxy]
  macon start        run the web server
  macon relay-init [--pin=… | --random-pin] [--name="My Mac"] [--ttl=1200] [--force]
                     create secrets for the cloud relay (no always-on device needed)
  macon doctor       check config, network and (optionally) the Mac
  macon wake         send a wake right now from this machine (no phone needed) and wait for the Mac
  macon help
`;

async function init() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q, def = '') => flags.yes ? def : ((await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def);
  try {
    let existing = {};
    try { existing = loadConfig(); } catch { /* none yet */ }
    const mac = normalizeMac(flags.mac || await ask("Mac's MAC address (on the Mac: run mac/setup-mac.sh)", existing.mac));
    const macIp = flags.ip ?? await ask("Mac's LAN IP (reserve it in your router so it never changes)", existing.macIp || '');
    const name = flags.name || await ask('Name shown in the app', existing.name || 'My Mac');
    let pin = flags.pin;
    let shown = false;
    if (flags['random-pin']) { pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); shown = true; }
    while (!pin) {
      const p = await ask('Choose a PIN (6+ characters)');
      if (p.length >= 6) pin = p; else console.log('PIN must be at least 6 characters.');
    }
    if (pin.length < 6) throw new Error('PIN must be at least 6 characters.');
    const cfg = {
      name, mac, macIp, port: existing.port || 8787,
      trustProxy: Boolean(flags['trust-proxy'] ?? existing.trustProxy),
      // Behind `tailscale serve` the proxy is local, so don't expose the plain-HTTP port on the LAN.
      host: (flags['trust-proxy'] ?? existing.trustProxy) ? '127.0.0.1' : (existing.host || '0.0.0.0'),
      pinHash: hashPin(pin),
      secret: existing.secret?.length >= 32 ? existing.secret : crypto.randomBytes(48).toString('base64url'),
    };
    validateConfig(cfg);
    saveConfig(cfg);
    console.log(`\nSaved ${DEFAULT_CONFIG_PATH} (chmod 600).`);
    if (shown) console.log(`Your PIN is: ${pin}   (write it down; it is stored only as a hash)`);
    console.log('Next: `node bin/macon.js doctor`, then `node bin/macon.js start`.');
  } finally {
    rl.close();
  }
}


const RELAY_SECRETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'secrets.json');

async function relayInit() {
  if (fs.existsSync(RELAY_SECRETS) && !flags.force) {
    throw new Error(`${RELAY_SECRETS} already exists. Re-running would sign out your phone and orphan the Mac agent. Use --force to replace it.`);
  }
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters
  let pin = flags.pin;
  let shown = false;
  if (!pin) {
    pin = Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
    shown = true;
  }
  // The relay is a public URL, so require a PIN that online guessing cannot realistically hit.
  if (pin.length < 8) throw new Error('For the cloud relay the PIN must be at least 8 characters.');
  const rand = (n) => crypto.randomBytes(n).toString('base64url');
  const secrets = { NAME: flags.name || 'My Mac', PIN_KEY: rand(32), SESSION_SECRET: rand(48), AGENT_TOKEN: rand(48), WAKE_TTL_SEC: String(flags.ttl || 1200) };
  secrets.PIN_HMAC = await pinDigest(secrets.PIN_KEY, pin);
  fs.writeFileSync(RELAY_SECRETS, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(RELAY_SECRETS, 0o600);
  console.log(`Saved ${RELAY_SECRETS} (chmod 600, git-ignored).`);
  if (shown) console.log(`Your PIN is: ${pin}   (write it down; it is stored only as a keyed hash)`);
  console.log(`
Next:
  1. cd relay && npx wrangler@4 login && npx wrangler@4 deploy
  2. npx wrangler@4 secret bulk secrets.json
  3. On the Mac:  sudo ./mac/install-agent.sh --url=https://<the URL wrangler printed>
  4. On your phone: open that URL in Safari > Share > Add to Home Screen`);
}

async function start() {
  const cfg = loadConfig();
  const server = createServer(cfg, { log: (...a) => console.log(new Date().toISOString(), ...a) });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`macon listening on http://${cfg.host}:${cfg.port}  (target: ${cfg.name} ${cfg.mac}${cfg.macIp ? ' @ ' + cfg.macIp : ''})`);
    for (const a of lanAddresses()) console.log(`  LAN: http://${a.address}:${cfg.port}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => exit(0)));
}

async function doctor() {
  let ok = true;
  const line = (good, msg, fix) => { if (!good) ok = false; console.log(`${good ? '✓' : '✗'} ${msg}${!good && fix ? `\n    → ${fix}` : ''}`); };
  let cfg;
  try { cfg = loadConfig(); line(true, `Config OK (${DEFAULT_CONFIG_PATH}) — target ${cfg.name} ${cfg.mac}`); }
  catch (e) { line(false, e.message, 'run `node bin/macon.js init`'); exit(1); }
  const lan = lanAddresses();
  line(lan.length > 0, `This server has a LAN address: ${lan.map((a) => a.address).join(', ') || 'none'}`, 'connect it to the same network as the Mac');
  line(Boolean(cfg.macIp), `Mac IP configured: ${cfg.macIp || '(not set)'}`, 'set macIp so the app can show status and confirm the wake');
  if (cfg.macIp && lan.length) {
    const same = lan.some((a) => a.address.split('.').slice(0, 3).join('.') === cfg.macIp.split('.').slice(0, 3).join('.'));
    line(same, 'Server and Mac are on the same /24 subnet', 'Wake-on-LAN broadcasts do not cross subnets/VLANs; run the server on the Mac\'s LAN');
  }
  if (cfg.macIp) {
    const up = await isAwake(cfg);
    console.log(`ℹ Mac is currently ${up ? 'AWAKE (reachable)' : 'asleep / unreachable'}`);
  }
  console.log(ok ? '\nAll checks passed. Run a real test: put the Mac to sleep, then `node bin/macon.js wake`.' : '\nSome checks failed — see above.');
  exit(ok ? 0 : 1);
}

async function wakeNow() {
  const cfg = loadConfig();
  const waker = createWaker(cfg, { awake: () => isAwake(cfg) });
  console.log(`Waking ${cfg.name} (${cfg.mac})…`);
  waker.start();
  const timer = setInterval(() => process.stdout.write('.'), 1000);
  const r = await waker.finished();
  clearInterval(timer);
  console.log(`\nResult: ${r.state}${r.error ? ' — ' + r.error : ''} (${r.packets} packets sent)`);
  exit(r.state === 'awake' || r.state === 'sent' ? 0 : 1);
}

const commands = { init, start, doctor, wake: wakeNow, 'relay-init': relayInit };
if (!commands[cmd]) { console.log(HELP); exit(cmd === 'help' ? 0 : 1); }
commands[cmd]().catch((e) => { console.error(`Error: ${e.message}`); exit(1); });
