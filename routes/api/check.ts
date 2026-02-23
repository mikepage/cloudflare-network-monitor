import { define } from "../../utils.ts";

const USER_AGENT =
  "cloudflare-network-monitor/1.0 - github.com/mikepage/cloudflare-network-monitor";

const CLOUDFLARE_AS = 13335;

interface BgpEntry {
  CIDR: string;
  ASN: number;
  Hits: number;
}

interface IspInfo {
  asn: number;
  name: string;
  country: string;
}

const ISP_LIST: IspInfo[] = [
  // Netherlands
  { asn: 1136, name: "KPN", country: "NL" },
  { asn: 9143, name: "Ziggo (VodafoneZiggo)", country: "NL" },
  { asn: 31615, name: "Odido (T-Mobile NL)", country: "NL" },
  { asn: 20857, name: "TransIP", country: "NL" },
  // Germany
  { asn: 3320, name: "Deutsche Telekom", country: "DE" },
  { asn: 3209, name: "Vodafone Germany", country: "DE" },
  { asn: 8560, name: "1&1 / IONOS", country: "DE" },
  { asn: 6805, name: "Telefonica Germany (O2)", country: "DE" },
  // Belgium
  { asn: 5432, name: "Proximus", country: "BE" },
  { asn: 6848, name: "Telenet", country: "BE" },
  { asn: 47377, name: "Orange Belgium", country: "BE" },
  { asn: 12392, name: "VOO", country: "BE" },
  // Luxembourg
  { asn: 6661, name: "POST Luxembourg", country: "LU" },
  { asn: 56665, name: "Tango (Proximus LU)", country: "LU" },
  { asn: 34769, name: "Orange Luxembourg", country: "LU" },
  // France
  { asn: 3215, name: "Orange France", country: "FR" },
  { asn: 12322, name: "Free (Iliad)", country: "FR" },
  { asn: 15557, name: "SFR", country: "FR" },
  { asn: 5410, name: "Bouygues Telecom", country: "FR" },
];

// --- IP math helpers ---

function parsePrefix(cidr: string): {
  ip: string;
  mask: number;
  isV6: boolean;
} {
  const [ip, maskStr] = cidr.split("/");
  return { ip, mask: parseInt(maskStr), isV6: ip.includes(":") };
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

function ipv4PrefixContains(parent: string, child: string): boolean {
  const p = parsePrefix(parent);
  const c = parsePrefix(child);
  if (p.isV6 || c.isV6) return false;
  if (c.mask < p.mask) return false;
  const parentStart = ipv4ToInt(p.ip);
  const childStart = ipv4ToInt(c.ip);
  const parentMask =
    p.mask === 0 ? 0 : (0xffffffff << (32 - p.mask)) >>> 0;
  return (parentStart & parentMask) === (childStart & parentMask);
}

function expandIPv6(ip: string): string {
  let parts = ip.split(":");
  const emptyIdx = parts.indexOf("");
  if (emptyIdx !== -1) {
    const before = parts.slice(0, emptyIdx);
    const after = parts.slice(emptyIdx + 1).filter((p) => p !== "");
    const fill = 8 - before.length - after.length;
    parts = [...before, ...Array(fill).fill("0000"), ...after];
  }
  return parts.map((p) => p.padStart(4, "0")).join(":");
}

function ipv6ToBigInt(ip: string): bigint {
  const expanded = expandIPv6(ip);
  const hex = expanded.replace(/:/g, "");
  return BigInt("0x" + hex);
}

function ipv6PrefixContains(parent: string, child: string): boolean {
  const p = parsePrefix(parent);
  const c = parsePrefix(child);
  if (!p.isV6 || !c.isV6) return false;
  if (c.mask < p.mask) return false;
  const parentStart = ipv6ToBigInt(p.ip);
  const childStart = ipv6ToBigInt(c.ip);
  const mask =
    p.mask === 0 ? 0n : ((1n << 128n) - 1n) << (128n - BigInt(p.mask));
  return (parentStart & mask) === (childStart & mask);
}

function prefixContains(parent: string, child: string): boolean {
  const p = parsePrefix(parent);
  const c = parsePrefix(child);
  if (p.isV6 !== c.isV6) return false;
  if (p.isV6) return ipv6PrefixContains(parent, child);
  return ipv4PrefixContains(parent, child);
}

// --- Caching ---

// deno-lint-ignore no-explicit-any
let bgpCache: { data: BgpEntry[]; timestamp: number } | null = null;
let cfIpCache: { v4: string[]; v6: string[]; timestamp: number } | null = null;
let cfIxCache: { ixIds: Set<number>; timestamp: number } | null = null;
let ispIxCache: Map<number, { ixIds: Set<number>; ixCount: number }> =
  new Map();
let ispIxCacheTimestamp = 0;

async function fetchCloudflareIPs(): Promise<{ v4: string[]; v6: string[] }> {
  const now = Date.now();
  if (cfIpCache && now - cfIpCache.timestamp < 3600_000) {
    return { v4: cfIpCache.v4, v6: cfIpCache.v6 };
  }

  const [v4Resp, v6Resp] = await Promise.all([
    fetch("https://www.cloudflare.com/ips-v4/", {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetch("https://www.cloudflare.com/ips-v6/", {
      headers: { "User-Agent": USER_AGENT },
    }),
  ]);

  const v4 = (await v4Resp.text())
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.includes("/"));
  const v6 = (await v6Resp.text())
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.includes("/"));

  cfIpCache = { v4, v6, timestamp: now };
  return { v4, v6 };
}

async function fetchBgpTable(): Promise<BgpEntry[]> {
  const now = Date.now();
  if (bgpCache && now - bgpCache.timestamp < 1800_000) {
    return bgpCache.data;
  }

  const resp = await fetch("https://bgp.tools/table.jsonl", {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!resp.ok) {
    throw new Error(`bgp.tools returned ${resp.status}: ${await resp.text()}`);
  }

  const text = await resp.text();
  const entries: BgpEntry[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }

  bgpCache = { data: entries, timestamp: now };
  return entries;
}

async function fetchCloudflareIxIds(): Promise<Set<number>> {
  const now = Date.now();
  if (cfIxCache && now - cfIxCache.timestamp < 3600_000) {
    return cfIxCache.ixIds;
  }

  const resp = await fetch(
    `https://www.peeringdb.com/api/netixlan?asn=${CLOUDFLARE_AS}`,
    { headers: { "User-Agent": USER_AGENT } },
  );
  const data = await resp.json();
  const ixIds = new Set<number>();
  for (const entry of data.data ?? []) {
    if (entry.ix_id) ixIds.add(entry.ix_id);
  }

  cfIxCache = { ixIds, timestamp: now };
  return ixIds;
}

async function fetchIspIxData(
  asn: number,
): Promise<{ ixIds: Set<number>; ixCount: number }> {
  const now = Date.now();
  const cached = ispIxCache.get(asn);
  if (cached && now - ispIxCacheTimestamp < 3600_000) {
    return cached;
  }

  try {
    const resp = await fetch(
      `https://www.peeringdb.com/api/netixlan?asn=${asn}`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    const data = await resp.json();
    const ixIds = new Set<number>();
    for (const entry of data.data ?? []) {
      if (entry.ix_id) ixIds.add(entry.ix_id);
    }
    const result = { ixIds, ixCount: ixIds.size };
    ispIxCache.set(asn, result);
    ispIxCacheTimestamp = now;
    return result;
  } catch {
    return { ixIds: new Set(), ixCount: 0 };
  }
}

// --- Types ---

interface PrefixResult {
  prefix: string;
  type: "v4" | "v6";
  bgpStatus: "announced" | "deaggregated" | "not-found";
  bgpPrefixes: string[];
  visibility: number;
  moreSpecificCount: number;
}

interface IspCheckResult {
  asn: number;
  name: string;
  country: string;
  prefixes: PrefixResult[];
  totalPrefixes: number;
  announced: number;
  deaggregated: number;
  notFound: number;
  score: number;
  peering: {
    sharedIxps: number;
    ispIxps: number;
    cfIxps: number;
    likelyDirectPeering: boolean;
  };
}

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const asnParam = url.searchParams.get("asn");

    try {
      const startTime = performance.now();

      // If no ASN specified, return the ISP list
      if (!asnParam) {
        return Response.json({ success: true, isps: ISP_LIST });
      }

      const targetAsn = parseInt(asnParam);
      if (isNaN(targetAsn)) {
        return Response.json(
          { success: false, error: "Invalid ASN" },
          { status: 400 },
        );
      }

      const ispInfo = ISP_LIST.find((i) => i.asn === targetAsn);

      // Fetch all data in parallel
      const [cfIps, bgpTable, cfIxIds, ispIxData] = await Promise.all([
        fetchCloudflareIPs(),
        fetchBgpTable(),
        fetchCloudflareIxIds(),
        fetchIspIxData(targetAsn),
      ]);

      const allCfPrefixes = [...cfIps.v4, ...cfIps.v6];

      // Get all Cloudflare-originated prefixes from BGP table
      const cfBgpEntries = bgpTable.filter((e) => e.ASN === CLOUDFLARE_AS);

      // Analyze each official Cloudflare prefix
      const prefixResults: PrefixResult[] = [];

      for (const cfPrefix of allCfPrefixes) {
        const isV6 = cfPrefix.includes(":");
        const type: "v4" | "v6" = isV6 ? "v6" : "v4";

        // Check exact match in BGP table
        const exactMatch = cfBgpEntries.find((e) => e.CIDR === cfPrefix);

        // Check for more-specific (deaggregated) announcements within this range
        const moreSpecifics = cfBgpEntries.filter(
          (e) => e.CIDR !== cfPrefix && prefixContains(cfPrefix, e.CIDR),
        );

        let bgpStatus: "announced" | "deaggregated" | "not-found";
        const bgpPrefixes: string[] = [];
        let visibility = 0;

        if (exactMatch) {
          bgpStatus = "announced";
          bgpPrefixes.push(exactMatch.CIDR);
          visibility = exactMatch.Hits;
          // Also include more-specifics if any
          for (const ms of moreSpecifics.slice(0, 10)) {
            bgpPrefixes.push(ms.CIDR);
          }
        } else if (moreSpecifics.length > 0) {
          bgpStatus = "deaggregated";
          for (const ms of moreSpecifics.slice(0, 10)) {
            bgpPrefixes.push(ms.CIDR);
          }
          visibility = Math.max(...moreSpecifics.map((e) => e.Hits));
        } else {
          bgpStatus = "not-found";
        }

        prefixResults.push({
          prefix: cfPrefix,
          type,
          bgpStatus,
          bgpPrefixes,
          visibility,
          moreSpecificCount: moreSpecifics.length,
        });
      }

      // Calculate peering info
      const sharedIxps = [...ispIxData.ixIds].filter((id) =>
        cfIxIds.has(id)
      ).length;

      const announced = prefixResults.filter(
        (p) => p.bgpStatus === "announced",
      ).length;
      const deaggregated = prefixResults.filter(
        (p) => p.bgpStatus === "deaggregated",
      ).length;
      const notFound = prefixResults.filter(
        (p) => p.bgpStatus === "not-found",
      ).length;
      const totalPrefixes = prefixResults.length;

      // Score based on: BGP health (are all prefixes announced?) + peering
      const bgpHealthScore =
        totalPrefixes > 0
          ? ((announced + deaggregated) / totalPrefixes) * 100
          : 0;
      const peeringBonus = sharedIxps > 0 ? Math.min(sharedIxps * 5, 20) : 0;
      const score = Math.min(
        100,
        Math.round(bgpHealthScore * 0.8 + peeringBonus),
      );

      const queryTime = Math.round(performance.now() - startTime);

      const result: IspCheckResult = {
        asn: targetAsn,
        name: ispInfo?.name ?? `AS${targetAsn}`,
        country: ispInfo?.country ?? "??",
        prefixes: prefixResults,
        totalPrefixes,
        announced,
        deaggregated,
        notFound,
        score,
        peering: {
          sharedIxps,
          ispIxps: ispIxData.ixCount,
          cfIxps: cfIxIds.size,
          likelyDirectPeering: sharedIxps > 0,
        },
      };

      return Response.json({
        success: true,
        result,
        queryTime,
        cloudflare: {
          officialV4: cfIps.v4,
          officialV6: cfIps.v6,
          bgpPrefixCount: cfBgpEntries.length,
          totalBgpVisibility: Math.round(
            cfBgpEntries.reduce((sum, e) => sum + e.Hits, 0) /
              cfBgpEntries.length,
          ),
        },
        bgpTableSize: bgpTable.length,
      });
    } catch (err) {
      console.error("Check failed:", err);
      return Response.json(
        {
          success: false,
          error: err instanceof Error ? err.message : "Check failed",
        },
        { status: 500 },
      );
    }
  },
});
