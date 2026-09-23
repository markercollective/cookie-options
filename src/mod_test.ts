import { Window } from "happy-dom";
import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  clearConsent,
  type ConsentRecord,
  type Geo,
  getRecord,
  getState,
  init,
  setConsent,
  subscribe,
} from "./mod.ts";

const GATED = `
  <script type="text/plain" data-cookie-optional src="https://cdn.test/a.js" async></script>
  <script type="text/plain" data-cookie-optional id="inline">console.log("hi")</script>
  <script type="text/plain" data-cookie-optional="module" id="mod">import "./x.js"</script>
  <script type="text/plain">not gated</script>
`;

interface Env {
  country?: string;
  region?: string;
  fetchFails?: boolean;
  stored?: Partial<ConsentRecord>;
  gpc?: boolean;
}

const US = (geo: Geo | undefined) => geo?.country === "US";

function record(partial: Partial<ConsentRecord>): string {
  return JSON.stringify({
    consent: "opted-in",
    at: new Date().toISOString(),
    version: "1",
    ...partial,
  });
}

function setup(env: Env = {}) {
  const win = new Window({ url: "https://example.com/" });
  win.document.body.innerHTML = GATED;
  const calls = { fetch: 0, reload: 0 };
  Object.defineProperty(win.location, "reload", {
    value: () => calls.reload++,
  });
  const fetch = () => {
    calls.fetch++;
    if (env.fetchFails) return Promise.reject(new Error("offline"));
    return Promise.resolve(
      new Response(JSON.stringify({
        country: env.country ?? "DE",
        region: env.region ?? "Berlin",
      })),
    );
  };
  const globals = {
    document: win.document,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    location: win.location,
    navigator: { globalPrivacyControl: env.gpc },
    fetch,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  if (env.stored) {
    win.localStorage.setItem("cookie-options", record(env.stored));
  }
  return { win, calls };
}

function gatedScripts(win: Window) {
  return win.document.querySelectorAll("script[data-cookie-optional]").length;
}

function liveScripts(win: Window) {
  return Array.from(
    win.document.querySelectorAll("script:not([type]), script[type=module]"),
  );
}

function stored(win: Window): ConsentRecord | null {
  const raw = win.localStorage.getItem("cookie-options");
  return raw ? JSON.parse(raw) : null;
}

Deno.test("init requires a policy", async () => {
  setup();
  // deno-lint-ignore no-explicit-any
  await assertRejects(() => init({} as any), TypeError, "optInByDefault");
});

Deno.test("stored opt-in loads scripts without geolocating", async () => {
  const { win, calls } = setup({ stored: { consent: "opted-in" } });
  assertEquals(await init({ optInByDefault: US }), "opted-in");
  assertEquals(calls.fetch, 0);
  assertEquals(gatedScripts(win), 0);
  const [remote, inline, mod] = liveScripts(win);
  assertEquals(remote.getAttribute("src"), "https://cdn.test/a.js");
  assertEquals(remote.hasAttribute("async"), true);
  assertEquals(inline.id, "inline");
  assertEquals(inline.textContent, 'console.log("hi")');
  assertEquals(inline.hasAttribute("async"), false);
  assertEquals(mod.id, "mod");
  assertEquals(mod.getAttribute("type"), "module");
  assertEquals(mod.textContent, 'import "./x.js"');
});

Deno.test("stored opt-out leaves scripts alone", async () => {
  const { win, calls } = setup({ stored: { consent: "opted-out" } });
  assertEquals(await init({ optInByDefault: US }), "opted-out");
  assertEquals(calls.fetch, 0);
  assertEquals(gatedScripts(win), 3);
  assertEquals(liveScripts(win).length, 0);
});

Deno.test("US visitors default to opted in without storing a choice", async () => {
  const { win } = setup({ country: "US" });
  assertEquals(await init({ optInByDefault: US }), "opted-in");
  assertEquals(liveScripts(win).length, 3);
  assertEquals(stored(win), null);
});

Deno.test("other visitors default to unchosen", async () => {
  const { win } = setup({ country: "DE" });
  assertEquals(await init({ optInByDefault: US }), "unchosen");
  assertEquals(liveScripts(win).length, 0);
});

Deno.test("optInByDefault sees country and region", async () => {
  const policy = (geo: Geo | undefined) =>
    geo?.country === "CA" && geo.region !== "Quebec";
  setup({ country: "CA", region: "Ontario" });
  assertEquals(await init({ optInByDefault: policy }), "opted-in");
  setup({ country: "CA", region: "Quebec" });
  assertEquals(await init({ optInByDefault: policy }), "unchosen");
});

Deno.test("geolocation failure defaults to unchosen", async () => {
  const { win } = setup({ fetchFails: true });
  assertEquals(await init({ optInByDefault: US }), "unchosen");
  assertEquals(liveScripts(win).length, 0);
});

Deno.test("geolocation is cached per session", async () => {
  const { calls } = setup({ country: "US" });
  await init({ optInByDefault: US });
  await init({ optInByDefault: US });
  assertEquals(calls.fetch, 1);
});

Deno.test("Global Privacy Control opts out when nothing is stored", async () => {
  const { win, calls } = setup({ country: "US", gpc: true });
  assertEquals(await init({ optInByDefault: US }), "opted-out");
  assertEquals(calls.fetch, 0);
  assertEquals(liveScripts(win).length, 0);
  assertEquals(stored(win), null);
});

Deno.test("an explicit stored choice wins over Global Privacy Control", async () => {
  setup({ stored: { consent: "opted-in" }, gpc: true });
  assertEquals(await init({ optInByDefault: US }), "opted-in");
});

Deno.test("opting in later stores a record and loads scripts", async () => {
  const { win, calls } = setup({ country: "DE" });
  await init({ optInByDefault: US, version: "2" });
  setConsent("opted-in");
  assertEquals(getState(), "opted-in");
  const record = stored(win)!;
  assertEquals(record.consent, "opted-in");
  assertEquals(record.version, "2");
  assertMatch(record.at, /^\d{4}-\d{2}-\d{2}T/);
  assertEquals(getRecord(), record);
  assertEquals(liveScripts(win).length, 3);
  assertEquals(calls.reload, 0);
});

Deno.test("opting out after scripts ran stores the choice and reloads", async () => {
  const { win, calls } = setup({ country: "US" });
  await init({ optInByDefault: US });
  setConsent("opted-out");
  assertEquals(stored(win)?.consent, "opted-out");
  assertEquals(calls.reload, 1);
});

Deno.test("opting out before scripts ran does not reload", async () => {
  const { win, calls } = setup({ country: "DE" });
  await init({ optInByDefault: US });
  setConsent("opted-out");
  assertEquals(getState(), "opted-out");
  assertEquals(stored(win)?.consent, "opted-out");
  assertEquals(calls.reload, 0);
});

Deno.test("clearConsent forgets the choice and reloads", async () => {
  const { win, calls } = setup({ stored: { consent: "opted-out" } });
  await init({ optInByDefault: US });
  clearConsent();
  assertEquals(stored(win), null);
  assertEquals(calls.reload, 1);
});

Deno.test("a stored choice for an older version is discarded", async () => {
  const { win, calls } = setup({ stored: { version: "1" } });
  assertEquals(await init({ optInByDefault: US, version: "2" }), "unchosen");
  assertEquals(calls.fetch, 1);
  assertEquals(stored(win), null);
});

Deno.test("an expired stored choice is discarded", async () => {
  const old = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString();
  const { win } = setup({ stored: { at: old } });
  assertEquals(await init({ optInByDefault: US }), "unchosen");
  assertEquals(stored(win), null);

  setup({ stored: { at: old } });
  assertEquals(await init({ optInByDefault: US, maxAgeDays: 365 }), "opted-in");
});

Deno.test("malformed storage is treated as no choice", async () => {
  const { win } = setup({ country: "DE" });
  win.localStorage.setItem("cookie-options", "opted-in");
  assertEquals(await init({ optInByDefault: US }), "unchosen");
  assertEquals(getRecord(), null);
});

Deno.test("subscribe emits the current state, then changes, until unsubscribed", async () => {
  setup({ country: "DE" });
  const seen: string[] = [];
  const unsubscribe = subscribe((s) => seen.push(s));
  await init({ optInByDefault: US });
  setConsent("opted-in");
  unsubscribe();
  setConsent("opted-out");
  assertEquals(seen.slice(-3), ["pending", "unchosen", "opted-in"]);
});

Deno.test("a choice made while init is pending wins", async () => {
  const { calls } = setup({ country: "US" });
  const pending = init({ optInByDefault: US });
  setConsent("opted-out");
  assertEquals(await pending, "opted-out");
  assertEquals(getState(), "opted-out");
  assertEquals(calls.reload, 0);
});

Deno.test("custom storageKey is used for reading and writing", async () => {
  const { win } = setup({ country: "DE" });
  win.localStorage.setItem("consent", record({ consent: "opted-in" }));
  assertEquals(
    await init({ optInByDefault: US, storageKey: "consent" }),
    "opted-in",
  );
  setConsent("opted-out");
  assertEquals(
    JSON.parse(win.localStorage.getItem("consent")!).consent,
    "opted-out",
  );
});
