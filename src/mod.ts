/**
 * Gates optional (cookie-setting) scripts behind the visitor's consent.
 *
 * Mark a script as optional by giving it `type="text/plain"` and the
 * `data-cookie-optional` attribute. The browser then ignores it until this
 * library swaps it for a real script:
 *
 * ```html
 * <script type="text/plain" data-cookie-optional src="https://example.com/analytics.js"></script>
 * <script type="text/plain" data-cookie-optional>
 *   console.log("only runs once opted in");
 * </script>
 * ```
 *
 * Give the attribute a value to set the activated script's `type`:
 *
 * ```html
 * <script type="text/plain" data-cookie-optional="module" src="/analytics.js"></script>
 * ```
 *
 * @module
 */

/** An explicit choice the visitor has made. */
export type Consent = "opted-in" | "opted-out";

/**
 * The current consent state.
 *
 * - `pending`: `init()` is still resolving (reading storage / geolocating).
 * - `unchosen`: no usable stored choice and the default policy says to ask.
 * - `opted-in`: stored choice, or the default policy allowed it.
 * - `opted-out`: stored choice, or the browser sent a Global Privacy Control signal.
 */
export type State = Consent | "unchosen" | "pending";

/** Called with the new state whenever it changes. */
export type Listener = (state: State) => void;

/** Where the visitor appears to be, from Cloudflare's IP lookup. */
export interface Geo {
  /** ISO 3166-1 alpha-2 code, e.g. `"US"`. */
  country: string;
  /** Region name as Cloudflare reports it, e.g. `"Michigan"` or `"Quebec"`. */
  region: string;
}

/** What is stored when the visitor makes a choice. */
export interface ConsentRecord {
  consent: Consent;
  /** ISO 8601 timestamp of the choice. */
  at: string;
  /** The `version` option in effect when the choice was made. */
  version: string;
}

export interface Options {
  /** `localStorage` key the visitor's choice is saved under. Defaults to `"cookie-options"`. */
  storageKey?: string;
  /**
   * Identifies the disclosure the visitor consented to. Bump it when the set
   * of optional cookies changes and stored choices are discarded, so the
   * visitor is asked again. Defaults to `"1"`.
   */
  version?: string;
  /** How long a stored choice stays valid, in days. Defaults to 180. */
  maxAgeDays?: number;
  /**
   * Whether a visitor with no stored choice should default to `opted-in`
   * rather than being asked. Called with the visitor's location, or
   * `undefined` if the lookup failed. Which places allow opt-out consent is
   * your call and changes over time, so there is no default.
   */
  optInByDefault: (geo: Geo | undefined) => boolean;
}

/**
 * Attribute that marks a `<script type="text/plain">` as gated. Its value, if
 * any, becomes the `type` of the activated script (e.g. `"module"`).
 */
export const ATTRIBUTE = "data-cookie-optional";

const GEO_URL = "https://ipv4-check-perf.radar.cloudflare.com/api/info";
const GEO_CACHE_KEY = "cookie-options:geo";
const DAY_MS = 24 * 60 * 60 * 1000;

const defaults = {
  storageKey: "cookie-options",
  version: "1",
  maxAgeDays: 180,
  optInByDefault: () => false,
};

let options: Required<Options> = defaults;
let state: State = "pending";
let scriptsLoaded = false;
const listeners = new Set<Listener>();

/** The current state. */
export function getState(): State {
  return state;
}

/** The visitor's stored choice, if there is a valid one. */
export function getRecord(): ConsentRecord | null {
  try {
    const raw = localStorage.getItem(options.storageKey);
    if (!raw) return null;
    const record: Partial<ConsentRecord> = JSON.parse(raw);
    const valid = (record.consent === "opted-in" ||
      record.consent === "opted-out") &&
      record.version === options.version &&
      typeof record.at === "string" &&
      Date.now() - Date.parse(record.at) < options.maxAgeDays * DAY_MS;
    if (!valid) {
      localStorage.removeItem(options.storageKey);
      return null;
    }
    return record as ConsentRecord;
  } catch {
    return null;
  }
}

/**
 * Registers a listener. It is called immediately with the current state and
 * again on every change. Returns a function that removes the listener.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

function setState(next: State): void {
  state = next;
  for (const listener of listeners) listener(next);
}

/**
 * Resolves the visitor's consent state and loads gated scripts if they are
 * opted in. Call once per page load, after registering any listeners.
 */
export async function init(opts: Options): Promise<State> {
  if (typeof opts?.optInByDefault !== "function") {
    throw new TypeError("init() requires an optInByDefault policy");
  }
  options = { ...defaults, ...opts };
  scriptsLoaded = false;
  setState("pending");

  let next: State;
  const record = getRecord();
  if (record) {
    next = record.consent;
  } else if (hasGlobalPrivacyControl()) {
    next = "opted-out";
  } else {
    const geo = await fetchGeo();
    // setConsent() may have been called while we were fetching.
    if (state !== "pending") return state;
    next = options.optInByDefault(geo) ? "opted-in" : "unchosen";
  }

  if (next === "opted-in") loadScripts();
  setState(next);
  return next;
}

/**
 * Stores the visitor's choice. Opting in loads the gated scripts right away.
 * Opting out after scripts have already run reloads the page so they stop.
 */
export function setConsent(consent: Consent): void {
  const record: ConsentRecord = {
    consent,
    at: new Date().toISOString(),
    version: options.version,
  };
  localStorage.setItem(options.storageKey, JSON.stringify(record));
  if (consent === "opted-out" && scriptsLoaded) {
    location.reload();
    return;
  }
  if (consent === "opted-in") loadScripts();
  setState(consent);
}

/**
 * Forgets the visitor's stored choice and reloads the page, so their state is
 * resolved from scratch as if they had never chosen.
 */
export function clearConsent(): void {
  localStorage.removeItem(options.storageKey);
  location.reload();
}

function hasGlobalPrivacyControl(): boolean {
  const nav = navigator as { globalPrivacyControl?: unknown };
  return nav.globalPrivacyControl === true;
}

async function fetchGeo(): Promise<Geo | undefined> {
  try {
    const cached = sessionStorage.getItem(GEO_CACHE_KEY);
    if (cached) return JSON.parse(cached);
    const response = await fetch(GEO_URL);
    const body: { country?: unknown; region?: unknown } = await response
      .json();
    if (typeof body.country !== "string") return undefined;
    const geo: Geo = {
      country: body.country,
      region: typeof body.region === "string" ? body.region : "",
    };
    sessionStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geo));
    return geo;
  } catch {
    return undefined;
  }
}

function loadScripts(): void {
  if (scriptsLoaded) return;
  scriptsLoaded = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", activateScripts, {
      once: true,
    });
  } else {
    activateScripts();
  }
}

function activateScripts(): void {
  const gated = document.querySelectorAll<HTMLScriptElement>(
    `script[${ATTRIBUTE}]`,
  );
  for (const original of gated) {
    const script = document.createElement("script");
    for (const { name, value } of Array.from(original.attributes)) {
      if (name !== "type" && name !== ATTRIBUTE) {
        script.setAttribute(name, value);
      }
    }
    // Dynamically inserted scripts are async by default; keep source order
    // unless the author asked for async explicitly.
    script.async = original.hasAttribute("async");
    const type = original.getAttribute(ATTRIBUTE);
    if (type) script.type = type;
    script.textContent = original.textContent;
    original.replaceWith(script);
  }
}
