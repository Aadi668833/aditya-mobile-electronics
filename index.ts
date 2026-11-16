// Supabase Edge Function: product-lookup
// Runs on Supabase's servers, so API keys stay secret (never in admin.html).
// Only logged-in admins (rows in the `admins` table) can use it.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   GEMINI_API_KEY  (required)  free key from https://aistudio.google.com/apikey
//   GEMINI_MODEL    (optional)  default "gemini-3.5-flash"
//   ALLOWED_ORIGIN  (optional)  e.g. https://yourname.github.io  (locks browser access to your site)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UA = "AdityaMobileAutofill/1.0 (shop admin tool)";
const CATS = ["Mobile Phones", "Accessories", "Electronics"];
const MAX_IMG = 8_000_000;

const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// light protection against runaway use of the free quota (per server instance)
const hits = new Map<string, number[]>();
function limited(uid: string) {
  const now = Date.now();
  const a = (hits.get(uid) ?? []).filter((t) => now - t < 600_000);
  a.push(now);
  hits.set(uid, a);
  return a.length > 40;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return j({ error: "Use POST." }, 405);
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return j({ error: "Not logged in." }, 401);
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: u, error: ue } = await sb.auth.getUser(token);
    if (ue || !u?.user) return j({ error: "Not logged in." }, 401);
    const { data: isAdmin, error: ae } = await sb.rpc("is_admin");
    if (ae || !isAdmin) return j({ error: "Admins only." }, 403);
    if (limited(u.user.id)) return j({ error: "Too many searches. Wait a few minutes and try again." }, 429);

    const body = await req.json().catch(() => ({}));
    if (body.action === "search") return await search(String(body.query ?? ""));
    if (body.action === "image") return await image(String(body.url ?? ""));
    return j({ error: "Unknown request." }, 400);
  } catch (e) {
    console.error(e);
    return j({ error: "Something went wrong on the server. Please try again." }, 500);
  }
});

/* ------------------------------------------------------------------ search */
async function search(raw: string) {
  const q = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  if (q.length < 3) return j({ error: "Type a longer product name." }, 400);

  let info;
  try {
    info = await lookupInfo(q);
  } catch (e) {
    console.error(e);
    return j({ error: (e as Error).message || "Product search failed." }, 502);
  }
  if (!info.product) {
    return j({ error: `No reliable information found for "${q}". Check the spelling or add the brand and model number.` }, 422);
  }
  let images: Img[] = [];
  try {
    images = await findImages(info.product.name, info.product.model);
  } catch (e) {
    console.error("image search failed", e);
  }
  return j({ product: info.product, sources: info.sources, images });
}

const str = (v: unknown, n = 300) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "";

function parseJson(text: string): any | null {
  const t = text.replace(/```json|```/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

async function lookupInfo(q: string) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("Auto-fill is not configured yet: add the GEMINI_API_KEY secret in Supabase.");
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash";

  const prompt = `You are a product-data assistant for a mobile and electronics shop in India.
Use web search to find factual details for this product: "${q}".
Rules:
- Use only facts you actually found on the manufacturer's site, well-known spec databases or major retailers. Never guess or invent. If a value is not found, use "" (or [] for lists).
- If you cannot identify ONE specific real product, return {"found": false, "reason": "short reason"}.
- Do NOT include any price.
- "category" must be exactly one of: "Mobile Phones", "Accessories", "Electronics".
- "confidence" is "high" only when several sources agree, otherwise "medium" or "low".
Return ONLY one JSON object, no other text, in this shape:
{"found": true, "confidence": "high|medium|low", "name": "full product name", "brand": "", "model": "model number such as SM-M356B", "category": "",
 "description": "2-3 plain sentences, no marketing claims you cannot verify", "ram": "", "storage": "", "display": "", "processor": "", "camera": "",
 "battery": "", "os": "", "colors": [""], "features": [""]}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1 },
      }),
    },
  );
  if (res.status === 429) throw new Error("The free AI daily limit is reached. Try again later, or fill the form by hand.");
  if (!res.ok) {
    console.error("Gemini error", res.status, (await res.text()).slice(0, 500));
    throw new Error("The AI service did not answer. Check the GEMINI_API_KEY secret and the model name (GEMINI_MODEL).");
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
  const p = parseJson(text);
  if (!p || p.found === false) return { product: null, sources: [] };

  const colors = (Array.isArray(p.colors) ? p.colors : []).map((c: unknown) => str(c, 40)).filter(Boolean).slice(0, 12);
  const features = (Array.isArray(p.features) ? p.features : []).map((c: unknown) => str(c, 60)).filter(Boolean).slice(0, 8);
  const f = {
    ram: str(p.ram, 60), storage: str(p.storage, 80), display: str(p.display, 200), processor: str(p.processor, 120),
    camera: str(p.camera, 250), battery: str(p.battery, 120), os: str(p.os, 80),
  };
  const specs = [
    f.display && `Display: ${f.display}`, f.processor && `Processor: ${f.processor}`, f.ram && `RAM: ${f.ram}`,
    f.storage && `Storage: ${f.storage}`, f.camera && `Camera: ${f.camera}`, f.battery && `Battery: ${f.battery}`,
    f.os && `OS: ${f.os}`, features.length && `Features: ${features.join(", ")}`,
  ].filter(Boolean).join("\n");

  const name = str(p.name, 160);
  const brand = str(p.brand, 60), model = str(p.model, 60);
  // Require some real substance before we call it a match
  if (!name || (!brand && !model && !specs)) return { product: null, sources: [] };

  const conf = ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "medium";
  const category = CATS.includes(p.category) ? p.category : (f.ram || f.storage ? "Mobile Phones" : "Electronics");

  const seen = new Set<string>();
  const sources: { title: string; url: string }[] = [];
  for (const c of cand?.groundingMetadata?.groundingChunks ?? []) {
    const url = c?.web?.uri;
    if (typeof url === "string" && url.startsWith("https://") && !seen.has(url)) {
      seen.add(url);
      sources.push({ title: str(c.web.title, 80) || "Source", url });
    }
    if (sources.length >= 6) break;
  }

  return {
    product: { name, brand, model, category, description: str(p.description, 600), ...f, colors, specs, confidence: conf },
    sources,
  };
}

/* ------------------------------------------------------------------ images */
// Only openly licensed sources (Wikimedia Commons, Openverse). No scraping of shops or spec sites.
type Img = { thumb: string; full: string; title: string; source: string; license: string; credit: string; page: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const STOP = new Set(["with", "the", "and", "gb", "ram", "new", "edition"]);

function relevant(title: string, name: string, model: string) {
  const t = norm(title);
  if (model && norm(model).length >= 4 && t.includes(norm(model))) return true;
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));
  if (!words.length) return false;
  const hit = words.filter((w) => t.includes(w)).length;
  return hit >= Math.max(2, Math.ceil(words.length * 0.6));
}

async function findImages(name: string, model: string): Promise<Img[]> {
  const [c, o] = await Promise.allSettled([commons(name), openverse(name)]);
  const all = [...(c.status === "fulfilled" ? c.value : []), ...(o.status === "fulfilled" ? o.value : [])];
  const seen = new Set<string>();
  return all
    .filter((m) => relevant(m.title, name, model))
    .filter((m) => (seen.has(m.thumb) ? false : (seen.add(m.thumb), true)))
    .slice(0, 12);
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

async function commons(q: string): Promise<Img[]> {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  u.search = new URLSearchParams({
    action: "query", format: "json", generator: "search", gsrsearch: `${q} filetype:bitmap`, gsrnamespace: "6",
    gsrlimit: "15", prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1000",
  }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const d = await r.json();
  const out: Img[] = [];
  for (const pg of Object.values<any>(d?.query?.pages ?? {})) {
    const ii = pg?.imageinfo?.[0];
    if (!ii?.thumburl || !["image/jpeg", "image/png", "image/webp"].includes(ii.mime)) continue;
    if ((ii.width ?? 0) < 500) continue;
    const em = ii.extmetadata ?? {};
    if (em.NonFree?.value === "true") continue;
    const license = stripTags(em.LicenseShortName?.value ?? "") || "See page";
    const artist = stripTags(em.Artist?.value ?? "").slice(0, 60);
    out.push({
      thumb: ii.thumburl, full: ii.thumburl, title: String(pg.title ?? "").replace(/^File:/, ""),
      source: "Wikimedia Commons", license,
      credit: `${artist ? artist + " / " : ""}Wikimedia Commons (${license})`,
      page: ii.descriptionurl ?? "",
    });
  }
  return out;
}

async function openverse(q: string): Promise<Img[]> {
  const u = new URL("https://api.openverse.org/v1/images/");
  u.search = new URLSearchParams({ q, page_size: "10", license_type: "commercial", mature: "false" }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const d = await r.json();
  const out: Img[] = [];
  for (const m of d?.results ?? []) {
    if (!m?.url || !String(m.url).startsWith("https://")) continue;
    if ((m.width ?? 0) && m.width < 500) continue;
    const license = `${String(m.license ?? "").toUpperCase()} ${m.license_version ?? ""}`.trim() || "See page";
    out.push({
      thumb: m.thumbnail || m.url, full: m.url, title: str(m.title, 120), source: str(m.source, 30) || "Openverse", license,
      credit: `${str(m.creator, 60) ? str(m.creator, 60) + " / " : ""}${str(m.source, 30) || "Openverse"} (${license})`,
      page: m.foreign_landing_url ?? "",
    });
  }
  return out;
}

/* ------------------------------------------------------- image download proxy */
// The browser cannot download most web images (CORS), so the server fetches the picked image and hands it back;
// admin.html then resizes it and uploads it to YOUR Supabase Storage.
function isPrivateIp(ip: string) {
  if (ip.includes(":")) return /^(::1|f[cd]|fe80)/i.test(ip) || ip === "::";
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function safeUrl(u: URL): Promise<boolean> {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return false;
  try {
    for (const type of ["A", "AAAA"] as const) {
      const ips = await Deno.resolveDns(h, type).catch(() => [] as string[]);
      if (ips.some((ip) => isPrivateIp(String(ip)))) return false;
    }
  } catch { /* DNS check is best effort */ }
  return true;
}

async function image(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return j({ error: "That image link is not valid." }, 400); }
  let res: Response | null = null;
  for (let i = 0; i < 4; i++) {
    if (!(await safeUrl(u))) return j({ error: "That image link is not allowed." }, 400);
    res = await fetch(u, { redirect: "manual", headers: { "User-Agent": UA, Accept: "image/*" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u); continue; }
    break;
  }
  if (!res || !res.ok) return j({ error: "Could not download that image. Choose another one or upload your own photo." }, 502);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) {
    return j({ error: "That link is not a photo (JPG, PNG or WebP)." }, 415);
  }
  if (Number(res.headers.get("content-length") ?? 0) > MAX_IMG) return j({ error: "That image is too large." }, 413);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_IMG) return j({ error: "That image is too large." }, 413);
  return new Response(buf, { headers: { ...CORS, "Content-Type": type, "Cache-Control": "no-store" } });
}
