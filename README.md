# cookie-options

Tiny, UI-free consent gate for optional (cookie-setting) scripts.

- Scripts you mark as optional don't run until the visitor opts in.
- You decide who may be opted in by default (e.g. US visitors) and who must be
  asked first; the library looks up the visitor's location for you.
- You bring the UI: subscribe to state changes, call a setter.

## Usage

Mark optional scripts with `type="text/plain"` and `data-cookie-optional`. The
browser ignores them until the library swaps them for real scripts:

```html
<script type="text/plain" data-cookie-optional
  src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>
<script type="text/plain" data-cookie-optional>
  window.dataLayer = window.dataLayer || [];
  // ...
</script>
```

For a module script, put the real type in the attribute value:

```html
<script type="text/plain" data-cookie-optional="module"
  src="/analytics.js"></script>
```

Then wire up your own UI:

```js
import { init, setConsent, subscribe } from "jsr:@marker/cookie-options";

subscribe((state) => {
  // "pending" | "unchosen" | "opted-in" | "opted-out"
  banner.hidden = state !== "unchosen";
  optOutLink.hidden = state !== "opted-in";
});

acceptButton.onclick = () => setConsent("opted-in");
rejectButton.onclick = () => setConsent("opted-out");

init({
  // Who may be opted in by default; everyone else is asked first.
  optInByDefault: (geo) => geo?.country === "US",
});
```

In a plain `<script type="module">` on a page, import from
`https://esm.sh/jsr/@marker/cookie-options` or from the bundled
`cookie-options.js` attached to each GitHub release.

### Behaviour

| Situation                            | Result                                      |
| ------------------------------------ | ------------------------------------------- |
| Valid stored `opted-in`              | Scripts load                                |
| Valid stored `opted-out`             | Nothing happens                             |
| No choice, browser sends GPC signal  | `opted-out` (not stored)                    |
| No choice, `optInByDefault` says yes | `opted-in` (not stored); scripts load       |
| No choice, `optInByDefault` says no  | `unchosen`; show your choose screen         |
| No choice, country lookup fails      | `unchosen`                                  |
| `setConsent("opted-in")`             | Stored; scripts load immediately            |
| `setConsent("opted-out")`            | Stored; page reloads if scripts already ran |

A stored choice is a record of `{ consent, at, version }`. It is discarded, and
the visitor asked again, when its `version` differs from the current option or
it is older than `maxAgeDays`.

GPC is the browser's [Global Privacy Control](https://globalprivacycontrol.org/)
signal, which several US states treat as a valid opt-out. An explicit stored
choice takes precedence over it.

Location comes from `https://ipv4-check-perf.radar.cloudflare.com/api/info` and
is cached in `sessionStorage`. Deciding which places allow opt-out consent is
your responsibility: the rules vary and change, and this library has no built-in
default. `optInByDefault` receives `{ country, region }`, or `undefined` if the
lookup failed. As of writing, the US generally allows opt-out; Canada requires
opt-in in Quebec but not elsewhere; the EU, UK and Brazil require opt-in:

```js
init({
  optInByDefault: (geo) =>
    geo?.country === "US" ||
    (geo?.country === "CA" && geo.region !== "Quebec"),
});
```

Returning `false` for `undefined` (a failed lookup) is the safe choice.

### API

- `init(options?)` – resolves the state and loads scripts if opted in.
  - `storageKey` – `localStorage` key, default `"cookie-options"`.
  - `version` – identifies the disclosure consented to; bump it when your
    optional cookies change. Default `"1"`.
  - `maxAgeDays` – how long a stored choice stays valid. Default `180`.
  - `optInByDefault(geo)` (required) – given `{ country, region }` (or
    `undefined` if the lookup failed), return whether to default to opted in
    instead of asking.
- `subscribe(listener)` – called immediately with the current state and on every
  change; returns an unsubscribe function.
- `getState()` – the current state:
  `"pending" | "unchosen" | "opted-in" | "opted-out"`.
- `getRecord()` – the stored `{ consent, at, version }`, or `null`. `consent` is
  `"unchosen"` after a reset.
- `setConsent("opted-in" | "opted-out")` – stores the visitor's choice.
- `resetConsent()` – forgets the stored choice and reloads the page in the
  `unchosen` state, so the visitor is asked again even where `optInByDefault`
  would opt them in. Wire this to a "cookie preferences" link.

## Development

```sh
deno task check    # fmt, lint, types
deno task test
deno task bundle   # -> dist/cookie-options.js
```

`example/index.html` is a small demo with accept/reject, opt in/out, and a
location override so you can see each path. Run `deno task bundle` and serve the
repo root (e.g. `deno run -A jsr:@std/http/file-server`) to try it.

## Releasing

```sh
deno task release patch   # or minor, major, or an explicit x.y.z
```

This bumps `deno.json`, commits, tags `vX.Y.Z` and pushes. The publish workflow
then runs the checks, publishes to JSR, and creates a GitHub release with the
bundle attached.

## Disclaimer

This library is not legal advice, and a single "optional cookie consent" may not
be sufficient for your site or cover all jurisdictions. You are responsible for
your own compliance with applicable laws and regulations.
