# 🪔 Diya Wall

A live, interactive Diwali wall for office parties and events. Guests scan a QR code on a big screen, type their name and an optional wish, and a glowing diya appears on the screen in real time.

- **Zero dependencies.** Plain Node.js, no `npm install`, no database, no build step.
- **Works on any phone.** Guests need no app or login, only a browser.
- **Built for a live audience.** Handles hundreds of diyas, shrinks them to fit, retries on bad Wi-Fi, ignores double taps.
- **Brandable.** Change the company name, event title, colours and wording in one file, `config.json`.

## How it works

```
Phone (join page)  --POST /wish-->  Node server  --Server-Sent Events-->  Big screen (wall)
```

1. The big screen opens `/wall`. It shows a QR code that points to the join page.
2. A guest scans it, enters a name and wish, and submits.
3. The server validates the entry and pushes it to every open wall instantly.
4. The wall adds a floating diya, shows the wish as a banner and fires fireworks.

## Tech stack

| Part | What is used |
| --- | --- |
| Server | Node.js 18 or newer, built-in `http`, `fs`, `crypto` modules only |
| Live updates | Server-Sent Events (one-way stream, 15 s heartbeat, auto-reconnect) |
| Front end | Plain HTML, CSS and JavaScript, no framework |
| QR code | Small generator built into `wall.html` (byte mode, ECC level M) |
| Animation | CSS animations and a `<canvas>` for fireworks |
| Storage | In memory, with a `wishes.json` snapshot so a restart does not lose the wall |

## Files

| File | Purpose |
| --- | --- |
| `server.js` | HTTP server, live stream, PIN gate, config loading |
| `wall.html` | Big-screen page |
| `join.html` | Page guests see after scanning the QR code |
| `config.json` | Company name, event title, colours and wording |
| `package.json` | Start script and Node version |

## Run it

```bash
node server.js
```

Then:

- Big screen: `http://localhost:3000/wall` (press **F** for fullscreen)
- Guests join at the address shown under the QR code

Options:

| Option | Meaning |
| --- | --- |
| `--port=3000` or `PORT` | Port to listen on |
| `--ip=192.168.1.50` or `HOST_IP` | Address shown in the QR code (when run on a local network) |
| `--fresh` | Ignore any saved diyas and start empty |
| `--pin=1234` or `WALL_PIN` | PIN needed to open the wall (see Security) |
| `CONFIG_FILE=/path/config.json` | Use a different config file |

Phones must be able to reach the server. On a local network, guests and the server must be on the same Wi-Fi, and the host firewall must allow the port. To let anyone join from any network, deploy it on a server (below).

## Make it yours: `config.json`

```json
{
  "company": "Your Company",
  "event": "Diwali 2026",
  "primaryColor": "#009488",
  "accentColor": "#F9BD20",
  "joinTitle": "Light a Diya",
  "joinIntro": "Add your name and, if you like, a wish. Your diya appears on the big screen.",
  "wishPlaceholder": "Your wish for the year (optional)",
  "thanks": "Look at the big screen. Shubh Deepavali!",
  "scanText": "Scan to light your diya"
}
```

| Key | Used for |
| --- | --- |
| `company` | Badge on the wall, the join page and the PIN screen |
| `event` | Title on the wall and PIN screen |
| `primaryColor` | Badge, QR frame, buttons (hex, e.g. `#009488`) |
| `accentColor` | Titles, names and glow (hex) |
| `joinTitle`, `joinIntro`, `wishPlaceholder`, `thanks` | Text on the guest page |
| `scanText` | Caption above the QR code |

Any key you leave out falls back to the default. Restart the server after editing. Text is escaped, so it is safe to use any characters. The dark green background and the emoji diya are fixed in the HTML files; edit `wall.html` and `join.html` to change them.

## Deploy on a server

Because the app is a single Node process with no dependencies, it runs anywhere Node 18+ runs: a VM, a container platform, a small VPS or a platform-as-a-service.

- **Start command:** `node server.js`
- **Port:** read from the `PORT` environment variable
- **Set `WALL_PIN`** as an environment variable so the wall is protected
- **Use HTTPS.** Most hosts provide it, and phones prefer it.
- **Keep one instance.** State is held in memory, so do not run several copies behind a load balancer.
- **Streaming must not be buffered.** If you use a reverse proxy, disable response buffering for `/events` (the server sends `X-Accel-Buffering: no` for nginx).
- **Hosts that sleep when idle** need a minute to wake up, so open the wall a few minutes before the event.

## Controls on the big screen

| Key | Action |
| --- | --- |
| **F** | Fullscreen |
| **T** | Add a test diya |
| **N** | Try the next network address for the QR code |
| **Shift+R** | Clear all diyas |
| Clear wall button | Top right of the wall, with a confirmation |

`/admin` is a page with a single Clear button, handy from a phone.

## Security

- The wall (`/wall`), the live stream, the counts and the admin functions require a PIN. Guests only need the join page and can add diyas without it.
- The PIN is read from `WALL_PIN` (or `--pin`) and never stored in the code. If none is set, a random PIN is generated and printed in the server log.
- The PIN is compared in constant time. After 5 wrong tries a visitor is locked out for 15 minutes, and a global cap slows down guessing from many addresses. A correct PIN sets a 12 hour `HttpOnly`, `SameSite=Strict` cookie.
- Names are limited to 24 characters and wishes to 120. Control characters and `<` `>` are removed, and names and wishes are inserted as text, not HTML.
- Data stays in server memory and in `wishes.json`, which is git-ignored and used only to survive a restart within 6 hours. Run with `--fresh` or press Clear to remove it.
- A 4-digit PIN is a convenience lock, not strong security. Use a longer PIN for anything sensitive.
- Adding a diya has no per-visitor rate limit. For a public deployment, add one in your reverse proxy.

## Limits

- Up to 2000 diyas are kept; the oldest is dropped beyond that.
- Diyas shrink automatically as more are added, and floating stops past 150 so the screen stays smooth.

## Contributing

Issues and pull requests are welcome. Keep it dependency-free and easy to run in front of a live audience.

## Licence

MIT. See `LICENSE`.
