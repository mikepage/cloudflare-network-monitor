import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

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

interface IxpResult {
  id: number;
  name: string;
  country: string;
  cfPresent: boolean;
  peerPresent: boolean;
  peered: boolean;
}

interface CheckData {
  peerAs: number;
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
  queryTime: number;
  cached?: boolean;
}

const COUNTRY_FLAGS: Record<string, string> = {
  NL: "\u{1F1F3}\u{1F1F1}",
  DE: "\u{1F1E9}\u{1F1EA}",
  BE: "\u{1F1E7}\u{1F1EA}",
  LU: "\u{1F1F1}\u{1F1FA}",
  FR: "\u{1F1EB}\u{1F1F7}",
};

const COUNTRY_NAMES: Record<string, string> = {
  NL: "Netherlands",
  DE: "Germany",
  BE: "Belgium",
  LU: "Luxembourg",
  FR: "France",
};

function VisBar({ buckets }: { buckets: VisibilityBucket[] }) {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) return null;
  const colors = [
    "bg-red-400",
    "bg-orange-400",
    "bg-yellow-400",
    "bg-green-400",
    "bg-green-600",
  ];
  return (
    <div class="flex h-2 rounded-full overflow-hidden w-full">
      {buckets.map((b, i) => {
        const pct = (b.count / total) * 100;
        if (pct === 0) return null;
        return (
          <div
            key={i}
            class={`${colors[i]}`}
            style={{ width: `${pct}%` }}
            title={`${b.label} peers: ${b.count} prefixes (${pct.toFixed(1)}%)`}
          />
        );
      })}
    </div>
  );
}

export default function NetworkMonitor() {
  const data = useSignal<CheckData | null>(null);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);

  useEffect(() => {
    fetch("/api/check")
      .then((r) => r.json())
      .then((resp) => {
        if (resp.success) {
          data.value = resp;
        } else {
          error.value = resp.error || "Check failed";
        }
      })
      .catch(() => {
        error.value = "Failed to fetch data";
      })
      .finally(() => {
        loading.value = false;
      });
  }, []);

  if (loading.value) {
    return (
      <div class="bg-white rounded-lg shadow p-6">
        <div class="flex items-center gap-3">
          <div class="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <span class="text-sm text-[#666]">
            Fetching BGP table and PeeringDB data...
          </span>
        </div>
      </div>
    );
  }

  if (error.value) {
    return (
      <div class="bg-red-50 border border-red-200 rounded-lg p-4">
        <p class="text-red-600 text-sm">{error.value}</p>
      </div>
    );
  }

  if (!data.value) return null;

  const { peerAs, ixps, bgp, cfIxpsGlobal, queryTime } = data.value;

  return (
    <div class="w-full">
      {/* IXP Grid */}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {ixps.map((ixp) => (
          <div
            key={ixp.id}
            class={`bg-white rounded-lg shadow p-5 border-2 ${
              ixp.peered ? "border-green-200" : "border-transparent"
            }`}
          >
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <span class="text-lg">
                  {COUNTRY_FLAGS[ixp.country] ?? ""}
                </span>
                <div>
                  <span class="text-sm font-medium text-[#111] block">
                    {ixp.name}
                  </span>
                  <span class="text-xs text-[#999]">
                    {COUNTRY_NAMES[ixp.country] ?? ixp.country}
                  </span>
                </div>
              </div>
              {ixp.peered ? (
                <span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-100 text-green-700">
                  <span class="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Peered
                </span>
              ) : (
                <span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-50 text-red-600">
                  <span class="w-1.5 h-1.5 rounded-full bg-red-400" />
                  Not peered
                </span>
              )}
            </div>
            <div class="flex gap-3 text-xs">
              <span class={ixp.cfPresent ? "text-green-600" : "text-red-500"}>
                {ixp.cfPresent ? "CF present" : "CF absent"}
              </span>
              <span class={ixp.peerPresent ? "text-green-600" : "text-red-500"}>
                {ixp.peerPresent ? `AS${peerAs} present` : `AS${peerAs} absent`}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* BGP Stats */}
      <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div class="bg-white rounded-lg shadow p-4 text-center">
          <div class="text-2xl font-medium text-[#111]">
            {bgp.total.toLocaleString()}
          </div>
          <div class="text-xs text-[#999]">AS13335 Prefixes</div>
        </div>
        <div class="bg-white rounded-lg shadow p-4 text-center">
          <div class="text-2xl font-medium text-blue-600">
            {bgp.v4.toLocaleString()}
          </div>
          <div class="text-xs text-[#999]">IPv4</div>
        </div>
        <div class="bg-white rounded-lg shadow p-4 text-center">
          <div class="text-2xl font-medium text-indigo-600">
            {bgp.v6.toLocaleString()}
          </div>
          <div class="text-xs text-[#999]">IPv6</div>
        </div>
        <div class="bg-white rounded-lg shadow p-4 text-center">
          <div class="text-2xl font-medium text-green-600">
            {bgp.avgVisibility.toLocaleString()}
          </div>
          <div class="text-xs text-[#999]">Avg Visibility</div>
        </div>
        <div class="bg-white rounded-lg shadow p-4 text-center">
          <div class="text-2xl font-medium text-blue-600">
            {cfIxpsGlobal}
          </div>
          <div class="text-xs text-[#999]">CF IXPs Global</div>
        </div>
      </div>

      {/* Visibility distribution */}
      <div class="bg-white rounded-lg shadow p-6 mb-6">
        <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider mb-4">
          Cloudflare BGP Prefix Visibility Distribution (AS13335)
        </h3>
        <div class="mb-3">
          <VisBar buckets={bgp.visibilityBuckets} />
        </div>
        <div class="flex flex-wrap gap-4">
          {bgp.visibilityBuckets.map((b, i) => {
            const colors = [
              "text-red-600",
              "text-orange-600",
              "text-yellow-600",
              "text-green-600",
              "text-green-700",
            ];
            const pct =
              bgp.total > 0
                ? ((b.count / bgp.total) * 100).toFixed(1)
                : "0";
            return (
              <div key={i} class="text-center">
                <div class={`text-sm font-medium ${colors[i]}`}>
                  {b.count.toLocaleString()}
                </div>
                <div class="text-xs text-[#999]">
                  {b.label} peers ({pct}%)
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Low visibility prefixes */}
      {bgp.lowVisibility.length > 0 && (
        <div class="bg-white rounded-lg shadow overflow-hidden mb-6">
          <div class="px-4 py-3 bg-[#fafafa] border-b border-[#eee]">
            <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider">
              Low Visibility Prefixes — {bgp.lowVisibility.length}{" "}
              prefix(es) below threshold
            </h3>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[#eee] bg-[#fafafa]">
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Prefix
                  </th>
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Type
                  </th>
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Mask
                  </th>
                  <th class="text-right px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Visibility
                  </th>
                  <th class="text-right px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    vs Avg
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[#eee]">
                {bgp.lowVisibility.map((p, idx) => {
                  const pctOfAvg =
                    bgp.avgVisibility > 0
                      ? Math.round(
                          (p.visibility / bgp.avgVisibility) * 100,
                        )
                      : 0;
                  return (
                    <tr key={idx} class="hover:bg-[#fafafa]">
                      <td class="px-4 py-3">
                        <code class="text-[#111]">{p.prefix}</code>
                      </td>
                      <td class="px-4 py-3">
                        <span
                          class={`text-xs px-2 py-0.5 rounded ${
                            p.type === "v4"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-indigo-100 text-indigo-700"
                          }`}
                        >
                          IPv{p.type === "v4" ? "4" : "6"}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-[#999]">/{p.mask}</td>
                      <td class="px-4 py-3 text-right">
                        <span
                          class={`text-sm ${
                            p.visibility < 500
                              ? "text-red-600"
                              : "text-orange-600"
                          }`}
                        >
                          {p.visibility.toLocaleString()}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-right">
                        <span class="text-xs text-[#999]">
                          {pctOfAvg}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legend */}
      <div class="bg-white rounded-lg shadow p-6 mb-6">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider">
            About this data
          </h3>
          <span class="text-xs text-[#999]">{queryTime}ms</span>
        </div>
        <div class="space-y-2 text-xs text-[#666]">
          <p>
            <span class="font-medium">BGP prefixes</span> are the actual IP
            ranges that Cloudflare (AS13335) announces to the global routing
            table, sourced from{" "}
            <a
              href="https://bgp.tools/kb/api"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:underline"
            >
              bgp.tools
            </a>{" "}
            (updated ~30 min).
          </p>
          <p>
            <span class="font-medium">Visibility</span> is the number of
            bgp.tools peer sessions that observe each route. Low visibility may
            indicate routing issues or recent announcements still propagating.
          </p>
          <p>
            <span class="font-medium">IXP presence</span> is checked via{" "}
            <a
              href="https://www.peeringdb.com/"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:underline"
            >
              PeeringDB
            </a>
            . Cloudflare has an open peering policy at {cfIxpsGlobal || "350+"}
            {" "}IXPs globally.
          </p>
        </div>
      </div>
    </div>
  );
}
