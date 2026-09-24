// DuckDuckGo Websuche (Text + Bilder) ohne API-Key, für die KI-Tools.
// Fällt bei Bildern auf Wikimedia Commons zurück (stabile, hotlinkbare URLs).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export type TextHit = { title: string; url: string; snippet: string };
export type ImageHit = { imageUrl: string; thumbnailUrl: string; title: string; sourceUrl: string };

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function realUrl(duckHref: string): string {
  // DDG verpackt Ziele als //duckduckgo.com/l/?uddg=<encoded>&... oder direkte URLs.
  const m = duckHref.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fallthrough */ }
  }
  if (duckHref.startsWith("//")) return "https:" + duckHref;
  return duckHref;
}

export async function ddgText(query: string, maxResults = 5): Promise<TextHit[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Accept: "text/html",
      "Accept-Language": "de-CH,de;q=0.9",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`DDG text search HTTP ${res.status}`);
  const html = await res.text();
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links: Array<{ href: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < maxResults) {
    links.push({ href: m[1], title: stripTags(m[2]).slice(0, 150) });
  }
  const snippets: string[] = [];
  while ((m = snipRe.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(stripTags(m[1]).slice(0, 300));
  }
  const out: TextHit[] = [];
  for (let i = 0; i < links.length; i++) {
    const url = realUrl(links[i].href);
    if (!/^https?:\/\//.test(url) || url.includes("duckduckgo.com/y.js")) continue;
    out.push({ title: links[i].title || url, url, snippet: snippets[i] ?? "" });
  }
  return out;
}

async function ddgVqd(query: string): Promise<string> {
  const res = await fetch("https://duckduckgo.com/?q=" + encodeURIComponent(query) + "&iax=images&ia=images", {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`DDG vqd HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/vqd=['"]([^'"]+)['"]/);
  if (!m) throw new Error("DDG vqd token not found");
  return m[1];
}

export async function ddgImages(query: string, maxResults = 4): Promise<ImageHit[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  try {
    const vqd = await ddgVqd(q);
    const url = `https://duckduckgo.com/i.js?l=de-de&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1&v7=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://duckduckgo.com/" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`DDG i.js HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const results = Array.isArray(data?.results) ? data.results : [];
    const out: ImageHit[] = [];
    for (const r of results) {
      if (typeof r?.image !== "string" || !/^https?:\/\//.test(r.image)) continue;
      out.push({
        imageUrl: r.image,
        thumbnailUrl: typeof r?.thumbnail === "string" ? r.thumbnail : r.image,
        title: String(r?.title ?? "").slice(0, 150),
        sourceUrl: typeof r?.url === "string" ? r.url : "",
      });
      if (out.length >= maxResults) break;
    }
    if (out.length > 0) return out;
    throw new Error("DDG returned no images");
  } catch (e) {
    console.error("[search] DDG image search failed, trying Wikimedia Commons:", (e as Error)?.message ?? e);
    return commonsImages(q, maxResults);
  }
}

export async function commonsImages(query: string, maxResults = 4): Promise<ImageHit[]> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search" +
    `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=800`;
  const res = await fetch(url, {
    headers: { "User-Agent": "KahootClone/1.0 (classroom quiz)" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
  const data = (await res.json()) as any;
  const pages = data?.query?.pages ? Object.values(data.query.pages) as any[] : [];
  const out: ImageHit[] = [];
  for (const p of pages) {
    const info = p?.imageinfo?.[0];
    const thumb = info?.thumburl;
    if (typeof thumb !== "string" || !/^https?:\/\//.test(thumb)) continue;
    if (typeof info?.mime === "string" && !/image\/(jpeg|png|webp|gif)/.test(info.mime)) continue;
    out.push({
      imageUrl: thumb,
      thumbnailUrl: thumb,
      title: String(p?.title ?? "").replace(/^File:/, "").slice(0, 150),
      sourceUrl: typeof info?.descriptionurl === "string" ? info.descriptionurl : "",
    });
    if (out.length >= maxResults) break;
  }
  return out;
}
