import { define } from "../../utils.ts";

const USER_AGENT =
  "cloudflare-network-monitor/1.0 - github.com/mikepage/cloudflare-network-monitor";

const PEERINGDB_API_KEY = Deno.env.get("PEERINGDB_API_KEY") ?? "";

const CLOUDFLARE_AS = 13335;

interface BgpEntry {
  CIDR: string;
  ASN: number;
  Hits: number;
}

// Regional IXPs — PeeringDB IX IDs
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
  { id: 18, name: "LINX LON1", country: "GB" },
  { id: 48, name: "NL-ix", country: "NL" },
  { id: 87, name: "DE-CIX Munich", country: "DE" },
  { id: 49, name: "MIX-IT", country: "IT" },
  { id: 60, name: "Netnod Stockholm", country: "SE" },
  { id: 35, name: "SwissIX", country: "CH" },
  { id: 64, name: "ESPANIX", country: "ES" },
  { id: 74, name: "VIX", country: "AT" },
  { id: 69, name: "DE-CIX Hamburg", country: "DE" },
  { id: 58, name: "CIXP", country: "CH" },
];

// Networks to check connectivity to Cloudflare
interface NetworkDef {
  asn: number;
  name: string;
}

const NETWORKS: NetworkDef[] = [
  { asn: 13335, name: "Cloudflare" },
  { asn: 40401, name: "Backblaze" },
  { asn: 202053, name: "UpCloud" },
  { asn: 396982, name: "Google Cloud" },
  { asn: 16509, name: "AWS" },
  { asn: 8075, name: "Azure" },
];

// --- Deno KV persistence ---

const kv = await Deno.openKv();

const PEERINGDB_CACHE_TTL = 86400_000; // 24h
const RESULT_CACHE_TTL = 86400_000; // 24h

// BGP table is too large for KV (>64KB), so keep it in-memory.
let bgpCache: { data: BgpEntry[]; timestamp: number } | null = null;
const BGP_CACHE_TTL = 1800_000; // 30 min

async function fetchBgpTable(): Promise<BgpEntry[]> {
  const now = Date.now();
  if (bgpCache && now - bgpCache.timestamp < BGP_CACHE_TTL) {
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

async function fetchAsnIxIds(asn: number): Promise<Set<number>> {
  const cached = await kv.get<number[]>(["peeringdb", "asn", asn]);
  if (cached.value) {
    return new Set(cached.value);
  }

  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (PEERINGDB_API_KEY) {
      headers["Authorization"] = `Api-Key ${PEERINGDB_API_KEY}`;
    }
    const resp = await fetch(
      `https://www.peeringdb.com/api/netixlan?asn=${asn}`,
      { headers },
    );
    if (!resp.ok) {
      console.warn(
        `PeeringDB AS${asn} returned ${resp.status}, no cache available`,
      );
      return new Set();
    }
    const data = await resp.json();
    if (data.meta?.error || !Array.isArray(data.data)) {
      console.warn(`PeeringDB AS${asn} rate limited, no cache available`);
      return new Set();
    }
    const ixIds = new Set<number>();
    for (const entry of data.data) {
      if (entry.ix_id) ixIds.add(entry.ix_id);
    }
    if (ixIds.size > 0) {
      await kv.set(["peeringdb", "asn", asn], [...ixIds], {
        expireIn: PEERINGDB_CACHE_TTL,
      });
    }
    return ixIds;
  } catch {
    return new Set();
  }
}

// --- Types ---

interface NetworkPresence {
  asn: number;
  name: string;
  present: boolean;
}

interface IxpResult {
  id: number;
  name: string;
  country: string;
  networks: NetworkPresence[];
}

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

interface CheckResult {
  ixps: IxpResult[];
  bgp: {
    total: number;
    v4: number;
    v6: number;
    avgVisibility: number;
    minVisibility: number;
    maxVisibility: number;
    lowVisibility: CfPrefixInfo[];
    visibilityBuckets: VisibilityBucket[];
  };
  cfIxpsGlobal: number;
}

export const handler = define.handlers({
  async GET(_ctx) {
    try {
      const startTime = performance.now();

      // Check for cached result
      const cachedResult = await kv.get<CheckResult>(["result", "v4"]);
      if (cachedResult.value) {
        const queryTime = Math.round(performance.now() - startTime);
        return Response.json({
          success: true,
          ...cachedResult.value,
          queryTime,
          cached: true,
        });
      }

      // Fetch all data in parallel
      const [bgpTable, ...networkIxIds] = await Promise.all([
        fetchBgpTable(),
        ...NETWORKS.map((n) => fetchAsnIxIds(n.asn)),
      ]);

      // Build IXP-centric view with per-network presence
      const ixps: IxpResult[] = REGIONAL_IXPS.map((ixp) => ({
        id: ixp.id,
        name: ixp.name,
        country: ixp.country,
        networks: NETWORKS.map((net, i) => ({
          asn: net.asn,
          name: net.name,
          present: networkIxIds[i].has(ixp.id),
        })),
      }));

      const cfIxIds = networkIxIds[0]; // Cloudflare is first in NETWORKS

      // BGP stats
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

      const result: CheckResult = {
        ixps,
        bgp: {
          total: cfBgpEntries.length,
          v4: v4Prefixes.length,
          v6: v6Prefixes.length,
          avgVisibility,
          minVisibility,
          maxVisibility,
          lowVisibility,
          visibilityBuckets: buckets,
        },
        cfIxpsGlobal: cfIxIds.size,
      };

      // Only cache if we got valid CF IXP data
      if (cfIxIds.size > 0) {
        await kv.set(["result", "v4"], result, {
          expireIn: RESULT_CACHE_TTL,
        });
      }

      const queryTime = Math.round(performance.now() - startTime);
      return Response.json({
        success: true,
        ...result,
        queryTime,
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
