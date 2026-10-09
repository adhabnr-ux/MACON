# macon — a "Wake my Mac" button for your Home Screen

A tiny private web app (installable PWA). Open it on your phone, enter your PIN once, tap **Wake**: your Mac
leaves sleep and shows its normal lock screen, where **you type your password**. macOS never lets anything
bypass that, and this app doesn't try to.

* Zero runtime dependencies and a full automated test suite.
* Hardened: scrypt-hashed PIN, signed HttpOnly session cookie, CSRF header, rate-limited login, strict CSP.
* **Single target:** the server only ever wakes the one MAC in its config. No request can name another host.
* Live status (asleep / waking / awake) with confirmation that the Mac is really up.

## Option A: a small always-on helper on your network (instant wake)

A sleeping Mac cannot host a website, and a website on the internet cannot reach into your home network.
Waking a Mac instantly uses a **Wake-on-LAN magic packet**, which must be sent *from inside your home network*.
So this option has three pieces:

```
 iPhone (PWA) ──private Tailscale link──▶ macon server ──magic packet (LAN)──▶ your Mac wakes
                                           on an always-on device
                                           (Raspberry Pi, NAS, mini PC, old laptop)
```

**Tailscale** keeps the link private: only devices signed in to *your* tailnet can reach the page. `tailscale serve`
adds HTTPS, so "Add to Home Screen" behaves like a real app. Nothing is exposed to the public internet.

> The always-on device must be on the same network (same subnet/VLAN) as the Mac. Anything that runs Node or Docker works.

## Option B: no always-on device (periodic polling)

If you don't want a helper box, the Mac can do the "listening" itself in short bursts:

```
 iPhone (PWA) ──HTTPS──▶ relay (free Cloudflare Worker) ◀──HTTPS poll── Mac agent (wakes itself on a timer)
```

1. You tap **Wake**. The relay just records "wake requested" (it never reaches into your home).
2. A small **agent on the Mac** keeps a rolling chain of scheduled wake-ups (`pmset schedule wake`), every 5 min on power / 15 min on battery. Each one lasts a few seconds: the agent asks the relay "was Wake pressed?".
3. If yes, it lights the screen and holds it on for 5 minutes, so you land on the normal lock screen and type your password. If not, it puts the Mac straight back to sleep when nobody is using it.

**Honest limits**
* **Delay:** worst case equals the interval (default 5 min; the app shows "expected by 8:38 PM"). Lower it with `--interval=120` at the cost of more wake-ups.
* The Mac must be **asleep, not shut down**, and the agent installed. Keep a laptop on power for best results.
* Battery cost is small (a few seconds of dark wake per interval) but real; use `--quiet=23:00-07:00` to skip the night.
* The relay is a **public URL** protected by an 8+ character PIN, a keyed hash, persistent lockouts and a CSRF header. For stronger protection, put Cloudflare Access in front of it.
* Requests expire after 20 min, so a Mac that comes back online hours later never lights up by surprise.
* I could not test the macOS power behavior from the cloud sandbox. Everything else (relay, agent logic, the PWA) is tested end to end; verify the Mac part with `sudo /usr/local/libexec/macon-agent doctor` (see below).

**Setup (about 10 minutes, one time)**
```bash
git clone https://github.com/adhabnr-ux/MACON && cd MACON
node bin/macon.js relay-init --name="My Mac"            # prints your PIN once, writes relay/secrets.json (git-ignored)
cd relay && npx wrangler@4 login && npx wrangler@4 deploy   # prints https://macon-relay.<you>.workers.dev
npx wrangler@4 secret bulk secrets.json && cd ..
sudo ./mac/install-agent.sh --url=https://macon-relay.<you>.workers.dev
```
(Needs Node ≥ 20 for the deploy step only: `brew install node`. A free Cloudflare account is enough.)
Then open the URL in Safari on your phone → PIN → Share → **Add to Home Screen**.

**Verify on your Mac**
1. Tap Wake with the Mac awake: the screen should light within ~15 s.
2. Sleep the Mac, wait a minute, tap Wake: it should wake within one interval.
3. `sudo /usr/local/libexec/macon-agent doctor` shows the relay link, your scheduled wake events and recent wakes. `DarkWake ... due to RTC` means silent check-ins; plain `Wake` means the screen may flash on each check-in. If so, raise the interval or set quiet hours.
4. Logs: `tail -f /var/log/macon-agent.log`. Settings: `/usr/local/etc/macon-agent.conf` (restart with `sudo launchctl kickstart -k system/com.macon.agent`). Remove everything: `sudo ./mac/uninstall-agent.sh`.

Both options can coexist; the app detects which mode it is talking to.

## Option A setup: always-on helper on your network (about 10 minutes)

### 1. On the Mac
```bash
git clone https://github.com/adhabnr-ux/MACON && cd MACON
./mac/setup-mac.sh
```
This enables *Wake for network access*, prints the Mac's **MAC address and IP**, and checks whether a password is required after wake. Then:

* In your router, give the Mac a **DHCP reservation** so its IP never changes.
* Prefer **Ethernet**, which is the most reliable. On Wi-Fi, MacBooks usually wake only through an **Apple TV / HomePod** acting as a Bonjour Sleep Proxy. macon "knocks" on the Mac's service ports to trigger that. It works for many setups, but Apple doesn't guarantee it.
* System Settings → Lock Screen → *Require password after screen saver begins or display is turned off* → **Immediately**.
* System Settings → Battery / Energy → enable **Wake for network access**. Keep laptops on power for the best chance.

### 2. On the always-on device (Node ≥ 20, or Docker)
```bash
git clone https://github.com/adhabnr-ux/MACON && cd MACON
node bin/macon.js init --mac=AA:BB:CC:DD:EE:FF --ip=192.168.1.20 --name="My Mac" --random-pin --trust-proxy
node bin/macon.js doctor          # verifies config + network
node bin/macon.js start
```
`init` prints a random PIN once; only a hash is stored. Omit `--random-pin` to choose your own (6+ characters).
`--trust-proxy` binds the server to `127.0.0.1` so only `tailscale serve` can reach it.
Run it permanently with **systemd** (`deploy/macon.service`) or **Docker** (`docker compose up -d`; Linux host networking is required for broadcasts).

### 3. Private HTTPS link with Tailscale
1. Install Tailscale on the always-on device **and your iPhone**, signed in to the same account.
2. On the device: `tailscale serve --bg 8787`. It prints your link, e.g. `https://pi.tail1234.ts.net`. Use `serve`, never `funnel`, which would make it public.
3. Recommended: in the Tailscale admin console, enable MagicDNS and HTTPS, and restrict ACLs so only your phone can reach the device.

### 4. On the iPhone
1. Open the link in **Safari** and enter the PIN.
2. Share button → **Add to Home Screen**. It now launches full-screen like an app, and your login lasts 90 days.

### 5. Test it for real
Put the Mac to sleep, wait about 30 s, then tap **Wake**. The button turns amber, then green "Awake", and the Mac shows its lock screen for your password.
You can also test from the server without a phone: `node bin/macon.js wake`.

## How waking works
1. Magic packets go to the broadcast addresses (limited and your subnet's directed broadcast) and unicast to the Mac's IP, on UDP ports 9 and 7, in 6 rounds.
2. macon "knocks" the Mac's service ports (22, 5900, 445, 548). Connecting to an advertised service makes an Apple Sleep Proxy wake the Mac, which is the Wi-Fi path.
3. It polls ping plus those ports. Two consecutive answers mean awake, which guards against brief Dark Wake blips. It gives up after 60 s and says so.

## Configuration (`macon.config.json`, mode 600)
| key | meaning |
|---|---|
| `mac` | Mac's MAC address (required) |
| `macIp` | Mac's LAN IP. Enables status, confirmation, unicast wake and subnet broadcast |
| `prefix` | subnet prefix length (default 24) |
| `broadcast` | extra broadcast addresses |
| `wakePorts` / `probePorts` | UDP wake ports / TCP ports used to knock and detect |
| `host` / `port` | bind address (default `0.0.0.0:8787`) |
| `trustProxy` | `true` behind `tailscale serve` (Secure cookie and real client IP) |
| `sessionDays` | login lifetime (default 90) |

Environment overrides: `MACON_CONFIG`, `MACON_MAC`, `MACON_MAC_IP`, `MACON_PORT`, `MACON_HOST`, `MACON_PIN_HASH`, `MACON_SECRET`, `MACON_TRUST_PROXY`.

## Security model
* Reachable only through your tailnet (plus your LAN if you leave the port open).
* PIN stored as an scrypt hash. Sessions are HMAC-signed, `HttpOnly; SameSite=Strict; Secure`. Login is limited to 5 bad PINs per 15 min per client and 20 globally.
* State-changing calls need an `X-Macon` header (CSRF). Strict CSP, no third-party requests, no secrets in logs.
* The API takes **no parameters** that choose a target. A test proves a smuggled MAC or host is ignored.
* To sign out every phone, delete `secret` from the config and run `init` again (this also sets a new PIN).

## Troubleshooting
| symptom | fix |
|---|---|
| Mac never wakes | Check `womp` is 1 (`pmset -g`); use Ethernet; same subnet as the server; correct MAC (not a Wi-Fi *private address*); run `macon doctor` |
| Works on Ethernet, not Wi-Fi | Needs an Apple TV/HomePod as sleep proxy and Remote Login on, or a USB/Thunderbolt Ethernet adapter |
| "No response from your Mac" | Signals were sent but nothing answered: check `macIp`, firewall, and that the Mac is on power |
| "Can't reach the server" | Phone isn't on Tailscale, or the server is down: `systemctl status macon` |
| Mac was shut down, not asleep | Wake-on-LAN can't power on a fully shut-down Apple Silicon Mac; it wakes from sleep only |

## Development
```bash
npm test         # relay, Mac agent (real curl + stubbed pmset), packet format, wake orchestration over real UDP, auth, CSRF, rate limiting, path traversal...
npm run icons    # regenerate the PNG icons (dependency-free)
```
