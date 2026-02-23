import { define } from "../../utils.ts";

const USER_AGENT =
  "cloudflare-network-monitor/1.0 - github.com/mikepage/cloudflare-network-monitor";

const CLOUDFLARE_AS = 13335;

interface BgpEntry {
  CIDR: string;
  ASN: number;
  Hits: number;
}

// Regional IXPs — PeeringDB IX IDs
// Cloudflare is present at all of these (open peering policy)
interface RegionalIxp {
  id: number;
  name: string;
  country: string;
}

const REGIONAL_IXPS: RegionalIxp[] = [
  { id: 26, name: "AMS-IX", country: "NL" },
  { id: 59, name: "BNIX", country: "BE" },
  { id: 31, name: "DE-CIX Frankfurt", country: "DE" },
  { id: 297, name: "LU-CIX", country: "LU" },
  { id: 359, name: "France-IX Paris", country: "FR" },
];

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

// --- Caching ---

let bgpCache: { data: BgpEntry[]; timestamp: number } | null = null;
let cfIxCache: { ixIds: Set<number>; timestamp: number } | null = null;
let ispIxCache: Map<number, { ixIds: Set<number>; ixCount: number }> =
  new Map();
let ispIxCacheTimestamp = 0;

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

// PeeringDB caches for 24h to respect rate limits (unauthenticated: ~20 req/min)
const PEERINGDB_CACHE_TTL = 86400_000;

async function fetchCloudflareIxIds(): Promise<Set<number>> {
  const now = Date.now();
  if (cfIxCache && now - cfIxCache.timestamp < PEERINGDB_CACHE_TTL) {
    return cfIxCache.ixIds;
  }

  try {
    const resp = await fetch(
      `https://www.peeringdb.com/api/netixlan?asn=${CLOUDFLARE_AS}`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    if (!resp.ok) {
      console.warn(`PeeringDB CF returned ${resp.status}, using cache`);
      return cfIxCache?.ixIds ?? new Set();
    }
    const data = await resp.json();
    if (data.meta?.error || !Array.isArray(data.data)) {
      console.warn("PeeringDB CF rate limited, using cache");
      return cfIxCache?.ixIds ?? new Set();
    }
    const ixIds = new Set<number>();
    for (const entry of data.data) {
      if (entry.ix_id) ixIds.add(entry.ix_id);
    }
    cfIxCache = { ixIds, timestamp: now };
    return ixIds;
  } catch {
    return cfIxCache?.ixIds ?? new Set();
  }
}

async function fetchIspIxData(
  asn: number,
): Promise<{ ixIds: Set<number>; ixCount: number }> {
  const now = Date.now();
  const cached = ispIxCache.get(asn);
  if (cached && now - ispIxCacheTimestamp < PEERINGDB_CACHE_TTL) {
    return cached;
  }

  try {
    const resp = await fetch(
      `https://www.peeringdb.com/api/netixlan?asn=${asn}`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    if (!resp.ok) {
      console.warn(`PeeringDB AS${asn} returned ${resp.status}, using cache`);
      return cached ?? { ixIds: new Set(), ixCount: 0 };
    }
    const data = await resp.json();
    if (data.meta?.error || !Array.isArray(data.data)) {
      console.warn(`PeeringDB AS${asn} rate limited, using cache`);
      return cached ?? { ixIds: new Set(), ixCount: 0 };
    }
    const ixIds = new Set<number>();
    for (const entry of data.data) {
      if (entry.ix_id) ixIds.add(entry.ix_id);
    }
    const result = { ixIds, ixCount: ixIds.size };
    ispIxCache.set(asn, result);
    ispIxCacheTimestamp = now;
    return result;
  } catch {
    return cached ?? { ixIds: new Set(), ixCount: 0 };
  }
}

// --- Types ---

interface CfPrefixInfo {
  prefix: string;
  type: "v4" | "v6";
  visibility: number;
  mask: number;
}

interface VisibilityBucket {
  label: string;
  min: number;
  count: number;
}

interface IxpStatus {
  id: number;
  name: string;
  country: string;
  cfPresent: boolean;
  ispPresent: boolean;
  peered: boolean;
}

interface IspCheckResult {
  asn: number;
  name: string;
  country: string;
  cfPrefixes: {
    total: number;
    v4: number;
    v6: number;
    avgVisibility: number;
    minVisibility: number;
    maxVisibility: number;
    lowVisibility: CfPrefixInfo[];
    visibilityBuckets: VisibilityBucket[];
  };
  peering: {
    sharedIxps: number;
    ispIxps: number;
    cfIxps: number;
    likelyDirectPeering: boolean;
    regionalIxp: IxpStatus | null;
    allIxps: IxpStatus[];
  };
  score: number;
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
      const [bgpTable, cfIxIds, ispIxData] = await Promise.all([
        fetchBgpTable(),
        fetchCloudflareIxIds(),
        fetchIspIxData(targetAsn),
      ]);

      // Get all Cloudflare-originated prefixes from the global BGP table
      const cfBgpEntries = bgpTable.filter((e) => e.ASN === CLOUDFLARE_AS);

      const v4Prefixes = cfBgpEntries.filter((e) => !e.CIDR.includes(":"));
      const v6Prefixes = cfBgpEntries.filter((e) => e.CIDR.includes(":"));

      const visibilities = cfBgpEntries.map((e) => e.Hits);
      const avgVisibility =
        visibilities.length > 0
          ? Math.round(
              visibilities.reduce((a, b) => a + b, 0) / visibilities.length,
            )
          : 0;
      const minVisibility =
        visibilities.length > 0 ? Math.min(...visibilities) : 0;
      const maxVisibility =
        visibilities.length > 0 ? Math.max(...visibilities) : 0;

      // Find prefixes with low visibility
      const visThreshold = Math.max(1000, avgVisibility * 0.5);
      const lowVisibility: CfPrefixInfo[] = cfBgpEntries
        .filter((e) => e.Hits < visThreshold)
        .sort((a, b) => a.Hits - b.Hits)
        .slice(0, 50)
        .map((e) => ({
          prefix: e.CIDR,
          type: e.CIDR.includes(":") ? ("v6" as const) : ("v4" as const),
          visibility: e.Hits,
          mask: parseInt(e.CIDR.split("/")[1]),
        }));

      // Visibility distribution buckets
      const buckets: VisibilityBucket[] = [
        { label: "0-500", min: 0, count: 0 },
        { label: "500-1000", min: 500, count: 0 },
        { label: "1000-2000", min: 1000, count: 0 },
        { label: "2000-3000", min: 2000, count: 0 },
        { label: "3000+", min: 3000, count: 0 },
      ];
      for (const e of cfBgpEntries) {
        if (e.Hits >= 3000) buckets[4].count++;
        else if (e.Hits >= 2000) buckets[3].count++;
        else if (e.Hits >= 1000) buckets[2].count++;
        else if (e.Hits >= 500) buckets[1].count++;
        else buckets[0].count++;
      }

      // Calculate peering info
      const sharedIxps = [...ispIxData.ixIds].filter((id) =>
        cfIxIds.has(id)
      ).length;

      // Regional IXP check — find the primary IXP for this ISP's country
      const ispCountry = ispInfo?.country ?? "??";
      const allIxpStatuses: IxpStatus[] = REGIONAL_IXPS.map((ixp) => ({
        id: ixp.id,
        name: ixp.name,
        country: ixp.country,
        cfPresent: cfIxIds.has(ixp.id),
        ispPresent: ispIxData.ixIds.has(ixp.id),
        peered: cfIxIds.has(ixp.id) && ispIxData.ixIds.has(ixp.id),
      }));

      // Primary regional IXP for this ISP's country
      const regionalIxp =
        allIxpStatuses.find((ix) => ix.country === ispCountry) ?? null;

      // Score: peering is the main factor for ISP relevance
      // - Regional IXP peering: 40 points
      // - Any shared IXP: 20 points
      // - BGP visibility health: up to 40 points
      const lowVisRatio =
        cfBgpEntries.length > 0
          ? lowVisibility.length / cfBgpEntries.length
          : 0;
      const healthScore = Math.round((1 - lowVisRatio) * 40);
      const regionalPeeringScore = regionalIxp?.peered ? 40 : 0;
      const anyPeeringScore =
        sharedIxps > 0 ? Math.min(sharedIxps * 10, 20) : 0;
      const score = Math.min(
        100,
        healthScore + regionalPeeringScore + anyPeeringScore,
      );

      const queryTime = Math.round(performance.now() - startTime);

      const result: IspCheckResult = {
        asn: targetAsn,
        name: ispInfo?.name ?? `AS${targetAsn}`,
        country: ispCountry,
        cfPrefixes: {
          total: cfBgpEntries.length,
          v4: v4Prefixes.length,
          v6: v6Prefixes.length,
          avgVisibility,
          minVisibility,
          maxVisibility,
          lowVisibility,
          visibilityBuckets: buckets,
        },
        peering: {
          sharedIxps,
          ispIxps: ispIxData.ixCount,
          cfIxps: cfIxIds.size,
          likelyDirectPeering: sharedIxps > 0,
          regionalIxp,
          allIxps: allIxpStatuses,
        },
        score,
      };

      return Response.json({
        success: true,
        result,
        queryTime,
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
