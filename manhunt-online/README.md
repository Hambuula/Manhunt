# MANHUNT ONLINE — host a game over the internet

A mobile-friendly real-world Manhunt game with **Hunters / Runners**, custom timing, quests, points, play radius, interactive map and **opt-in periodic Runner location pings**. All players use the **same public HTTPS website**, from Wi-Fi or mobile data. The game host is simply the player who creates the lobby; they do **not** need to keep a computer running.

**Important:** The ZIP contains a deployable website, **not an already-live website**. You must deploy it to an online host. The walkthrough below uses Railway, which gives the web service a public HTTPS domain and offers a persistent data volume.

## Deploy to Railway (recommended)

1. Extract this project ZIP and upload its contents to a **private GitHub repository**. Put `server.js`, `package.json`, `public/`, `tests/`, etc. in the repository's root. **Do not** upload any `data/` folder, `.env` with secrets, or recovery keys. If you prefer the Railway CLI you can deploy the extracted folder rather than GitHub.
2. Go to [railway.com](https://railway.com), create a project, choose **Deploy from GitHub Repo**, and select the repository. The `npm start` script launches the server with Railway's `PORT` setting. In the service Settings, you can set **Healthcheck Path** to `/api/health`.
3. **Attach a persistent Volume to the web service and set its mount path to `/data`**. Do this before using the app for a real game. The app automatically reads `RAILWAY_VOLUME_MOUNT_PATH` and writes `/data/games.json`. If the Railway volume is missing, the app intentionally refuses to start rather than silently losing everyone after a restart.
4. In Railway's service **Variables**, set `NODE_ENV=production`. Do not set `PORT` unless you know why; Railway provides it automatically. You don't need to add `DATA_FILE` for a Railway volume.
5. In the service's **Settings → Networking**, choose **Generate Domain**. You will get an HTTPS address similar to `https://your-manhunt.up.railway.app`. Railway handles the public HTTPS certificate for this domain; no `mkcert` or browser certificate installation is needed.
6. Open the HTTPS link on a phone, create a game, and send the invite link or six-character code. Players can be on completely different networks and can use mobile data.

**Do not choose an ephemeral/static-only hosting setup.** The server needs a continuously running Node.js process and a durable writable volume. Use **one running instance / one replica**, since the game state is stored in a single JSON file. On Railway, a volume automatically prevents using multiple replicas. A deployment with an attached volume can have a short interruption during updates; the phones will reconnect afterward.

Railway's dashboard options and usage charges may change. Review the platform's pricing and [persistent-volume documentation](https://docs.railway.com/volumes). Railway volume backups are recommended, especially if you will keep games long-term.

### Deploying to another provider

You can use any host with Node.js 20+ and HTTPS (for example, a VPS with a reverse proxy or a platform that supports persistent disks). Set:

- `PORT`: public host's assigned **internal** listening port (default `3000`).
- `HOST=0.0.0.0`: listen on the container's network interface (default).
- `NODE_ENV=production`: enables the required persistent-storage check.
- `DATA_FILE=/path/on/a/persistent-disk/games.json`: path to a **durable, writable disk** mounted to the Node.js service, not the container's temporary filesystem.
- `TRUST_PROXY=1`: only if your app is behind a proxy you control, which correctly sets `X-Forwarded-For`.

The app serves HTTP internally. The hosting provider normally terminates HTTPS at its public edge and forwards requests to this internal port. You don't have to supply `TLS_KEY` or `TLS_CERT` on Railway.

## Local preview, without deployment

Install Node.js 20 or newer, extract the ZIP, and run:

```bash
npm start
```

Then visit `http://localhost:3000`. This is for local testing only: other phones on mobile networks cannot use your computer's localhost address. A real public HTTPS domain is required for GPS in ordinary phone browsers.

## Keeping players in the match after a restart

Every meaningful game change is saved atomically on the server's persistent disk at `games.json`:

- Room codes, room names and the original host
- Player identities and teams
- Scores, capture results, quests and completed quests
- Game rules, start times, pause times and remaining match time
- Private player login tokens and recovery keys

**A disconnected player is never removed just for closing the website.** The app saves each player's login in their browser's local storage and automatically restores their existing player, even if the hosting service restarted in the meantime. When the phone temporarily loses its connection, the page shows a reconnection notice and keeps retrying instead of deleting their saved login. A background fallback refresh also catches changes after mobile-network interruptions.

### Recover on a new phone or after browser data is cleared

While in a game, find **Stay in the game → Copy private recovery key**. Save this key somewhere private. On another phone/browser, open the website and choose **Lost your session? Recover player**. Enter your six-character room code and recovery key to take back your **original** player even if the round is already running. This generates a new login token and signs out the old browser.

If you simply switch rooms, your old player's login remains saved on that same browser and appears under **Resume your player** on the homepage. Recovery requires the private key if local storage is missing, the browser changes, or the public site domain changes. Don't share recovery keys, tag codes or login tokens with other players. The room code alone does **not** grant control of an existing player.

**If the storage volume itself is deleted or wiped, the game cannot be restored without a backup.** A temporary server restart is different from deleting storage. Do not use free/ephemeral filesystems for live matches.

## Periodic location pings and the live map

1. The game host sets a **map center**, radius, and Runner **ping interval from 1 to 30 minutes** before starting. The host may use their browser's GPS to fill the center coordinates.
2. When the game starts, each Runner can independently tap **Enable location pings** and confirm the prompt. GPS browser permission must also be granted. Location sharing defaults **OFF** for everyone.
3. Only **after the Runner head start** ends, opted-in Runners send **one fresh GPS fix per configured interval**, while their game tab is **open and visible**. Hunters see the latest ping pin, its age and GPS uncertainty on the map; they **do not** get a live movement trail. Other Runners do not see those pins.
4. Runners can tap **Stop sharing & clear ping** at any time. The server removes that Runner's latest ping for future viewers. The browser also tries to revoke sharing when the page closes. If a phone disconnects suddenly, the server stops displaying its last ping within about **90 seconds** of the last presence check (with normal connected browsers refreshing within another 20 seconds). Runners never automatically resume GPS sharing after a page or server restart, even though their **player identity** is restored.
5. A captured Runner stops sharing. The game also clears the GPS pings when paused or ended. **GPS positions and consent are held in server memory only**, not saved in `games.json`; historical GPS tracks are not kept. Any positions already viewed or copied by a Hunter cannot be retracted.

Phone browsers typically **pause location services in the background**. If a Runner locks their screen, switches tabs or closes the browser, scheduled GPS pings may stop. This is a browser/OS limitation, not a feature the website can reliably bypass. Runners should check their GPS and sharing indicator when they return to the page. GPS accuracy may vary, and the circular play boundary is **advisory, not enforced**.

The map works without street tiles as a relative map. If a player taps **Load Streets (Online)**, their browser fetches OpenStreetMap tiles for the displayed region and shows OpenStreetMap attribution. The viewed map area is sent to the tile provider; Runner pings are only sent to the Manhunt game server. [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Game rules and controls

- The host can set the round duration, Runner head start, center/radius, capture and survival points, quest list, and whether captured Runners join Hunters.
- Runners can self-report each quest **once**. Team scores are updated for all players.
- A physical tag is confirmed when the Hunter submits the tagged Runner's private four-digit tag code. Hunters cannot tag during the head start.
- The host can start, pause, resume, end or rematch a room. Capturing all Runners ends the round; otherwise the score decides the winner at time-up.
- Updates use Server-Sent Events (SSE) with a regular HTTP-refresh fallback. All players see the same server-authoritative state.

## Security and safe play

This is for **friendly, invite-only games**, not a public social network. Six-character room codes are private invitation identifiers rather than passwords. Random player tokens and recovery keys protect player sessions, and the server rate-limits room creation, joins, recovery attempts and tag attempts. Do not expose the storage volume or saved `games.json` to the public web. Back it up securely if necessary. Use HTTPS for all public access.

Only players with the correct Hunter role see eligible Runner pings. Map centers are visible to everyone in that game. Server data lives on the host you choose; make sure your group agrees to the GPS feature before play. Runners can choose not to opt in, and they can stop at any time.

Always play in permitted public areas, respect private property and road traffic, agree on gentle consensual tagging, and do not run into streets or unsafe spaces.

## Development and automated tests

Run:

```bash
npm test
```

The tests include launching a server process, creating a real match, awarding quest points, capturing a Runner, shutting down the entire server, restarting it from the same persistent data file, and verifying all original players and game progress survive. They also test recovery-key takeover and privacy of location pings across restarts.

Implementation: `server.js` (built-in Node.js modules), `public/` (vanilla HTML, CSS and JS), `tests/` (Node.js built-in test runner). **No npm dependencies, external user accounts or commercial map API keys are required.**
