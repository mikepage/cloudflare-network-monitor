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

interface PeeringInfo {
  sharedIxps: number;
  ispIxps: number;
  cfIxps: number;
  likelyDirectPeering: boolean;
}

interface IspResult {
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
  peering: PeeringInfo;
  score: number;
}

interface CheckResponse {
  success: boolean;
  result: IspResult;
  queryTime: number;
  bgpTableSize: number;
  error?: string;
}

interface IspInfo {
  asn: number;
  name: string;
  country: string;
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

function ScoreBadge({ score }: { score: number }) {
  let bg: string, text: string;
  if (score >= 90) {
    bg = "bg-green-100";
    text = "text-green-700";
  } else if (score >= 70) {
    bg = "bg-yellow-100";
    text = "text-yellow-700";
  } else if (score >= 50) {
    bg = "bg-orange-100";
    text = "text-orange-700";
  } else {
    bg = "bg-red-100";
    text = "text-red-700";
  }
  return (
    <span class={`text-xs px-2 py-0.5 rounded font-medium ${bg} ${text}`}>
      {score}%
    </span>
  );
}

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
  const isps = useSignal<IspInfo[]>([]);
  const results = useSignal<Map<number, IspResult>>(new Map());
  const loadingAsn = useSignal<number | null>(null);
  const loadingAll = useSignal(false);
  const error = useSignal<string | null>(null);
  const selectedAsn = useSignal<number | null>(null);
  const selectedResult = useSignal<CheckResponse | null>(null);
  const customAsn = useSignal("");
  const filterCountry = useSignal<string>("all");

  useEffect(() => {
    fetch("/api/check")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) isps.value = data.isps;
      })
      .catch(() => {
        error.value = "Failed to load ISP list";
      });
  }, []);

  const checkSingleIsp = async (asn: number) => {
    error.value = null;
    loadingAsn.value = asn;
    selectedAsn.value = asn;
    selectedResult.value = null;

    try {
      const resp = await fetch(`/api/check?asn=${asn}`);
      const data: CheckResponse = await resp.json();

      if (!data.success) {
        error.value = data.error || "Check failed";
        return;
      }

      selectedResult.value = data;
      const newMap = new Map(results.value);
      newMap.set(asn, data.result);
      results.value = newMap;
    } catch {
      error.value = "Failed to check ISP";
    } finally {
      loadingAsn.value = null;
    }
  };

  const checkAllIsps = async () => {
    error.value = null;
    loadingAll.value = true;
    selectedAsn.value = null;
    selectedResult.value = null;

    try {
      for (const isp of isps.value) {
        if (
          filterCountry.value !== "all" &&
          isp.country !== filterCountry.value
        ) {
          continue;
        }
        loadingAsn.value = isp.asn;
        try {
          const resp = await fetch(`/api/check?asn=${isp.asn}`);
          const data: CheckResponse = await resp.json();
          if (data.success) {
            const newMap = new Map(results.value);
            newMap.set(isp.asn, data.result);
            results.value = newMap;
          }
        } catch {
          // continue
        }
      }
    } finally {
      loadingAsn.value = null;
      loadingAll.value = false;
    }
  };

  const checkCustomAsn = async () => {
    const asn = parseInt(customAsn.value.replace(/^AS/i, ""));
    if (isNaN(asn)) {
      error.value = "Please enter a valid AS number";
      return;
    }
    await checkSingleIsp(asn);
  };

  const filteredIsps = isps.value.filter(
    (isp) =>
      filterCountry.value === "all" || isp.country === filterCountry.value,
  );

  const countries = [...new Set(isps.value.map((i) => i.country))];

  return (
    <div class="w-full">
      {/* Controls */}
      <div class="bg-white rounded-lg shadow p-6 mb-6">
        <div class="flex flex-col md:flex-row gap-3 mb-4">
          <div class="flex-1">
            <input
              type="text"
              value={customAsn.value}
              onInput={(e) =>
                (customAsn.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") checkCustomAsn();
              }}
              placeholder="Custom ASN (e.g. 1136 or AS1136)"
              class="w-full px-4 py-3 border border-[#ddd] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm bg-white"
            />
          </div>
          <div class="flex gap-2">
            <button
              onClick={checkCustomAsn}
              disabled={!customAsn.value.trim() || loadingAsn.value !== null}
              class="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              Check ASN
            </button>
            <button
              onClick={checkAllIsps}
              disabled={loadingAll.value || loadingAsn.value !== null}
              class="px-6 py-3 bg-[#f0f0f0] text-[#666] rounded-md hover:bg-[#e5e5e5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {loadingAll.value ? "Checking..." : "Check All ISPs"}
            </button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-4">
          <div class="flex items-center gap-2">
            <label class="text-xs text-[#666]">Filter</label>
            <select
              value={filterCountry.value}
              onChange={(e) =>
                (filterCountry.value = (e.target as HTMLSelectElement).value)}
              class="px-3 py-1.5 border border-[#ddd] rounded-md text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="all">All Countries</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {COUNTRY_FLAGS[c]} {COUNTRY_NAMES[c] ?? c}
                </option>
              ))}
            </select>
          </div>
          <div class="flex items-center gap-3 text-xs text-[#999]">
            <span>Visibility:</span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-red-400" />{" "}
              0-500
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-orange-400" />{" "}
              500-1k
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-yellow-400" />{" "}
              1-2k
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-green-400" />{" "}
              2-3k
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-green-600" />{" "}
              3k+
            </span>
          </div>
        </div>
      </div>

      {error.value && (
        <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p class="text-red-600 text-sm">{error.value}</p>
        </div>
      )}

      {loadingAsn.value !== null && !loadingAll.value && (
        <div class="bg-white rounded-lg shadow p-6 mb-6">
          <div class="flex items-center gap-3">
            <div class="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span class="text-sm text-[#666]">
              Checking AS{loadingAsn.value} — fetching BGP table and
              PeeringDB data...
            </span>
          </div>
        </div>
      )}

      {/* ISP Grid */}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {filteredIsps.map((isp) => {
          const result = results.value.get(isp.asn);
          const isLoading = loadingAsn.value === isp.asn;
          const isSelected = selectedAsn.value === isp.asn;

          return (
            <button
              key={isp.asn}
              onClick={() => checkSingleIsp(isp.asn)}
              disabled={isLoading}
              class={`bg-white rounded-lg shadow p-4 text-left hover:shadow-md transition-all cursor-pointer border-2 ${
                isSelected ? "border-blue-500" : "border-transparent"
              } ${isLoading ? "opacity-70" : ""}`}
            >
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="text-lg">
                    {COUNTRY_FLAGS[isp.country] ?? ""}
                  </span>
                  <span class="text-sm font-medium text-[#111]">
                    {isp.name}
                  </span>
                </div>
                {isLoading && (
                  <div class="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                )}
                {result && !isLoading && <ScoreBadge score={result.score} />}
              </div>
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs text-[#999]">AS{isp.asn}</span>
                {result && (
                  <div class="flex items-center gap-2">
                    {result.peering.likelyDirectPeering && (
                      <span class="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">
                        {result.peering.sharedIxps} shared IXP
                        {result.peering.sharedIxps !== 1 ? "s" : ""}
                      </span>
                    )}
                    <span class="text-xs text-[#999]">
                      {result.cfPrefixes.total.toLocaleString()} CF prefixes
                    </span>
                  </div>
                )}
              </div>
              {result && (
                <VisBar buckets={result.cfPrefixes.visibilityBuckets} />
              )}
            </button>
          );
        })}
      </div>

      {/* Loading indicator for check all */}
      {loadingAll.value && loadingAsn.value !== null && (
        <div class="bg-white rounded-lg shadow p-6 mb-6">
          <div class="flex items-center gap-3">
            <div class="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span class="text-sm text-[#666]">
              Checking AS{loadingAsn.value}... ({results.value.size}/
              {filteredIsps.length} done)
            </span>
          </div>
        </div>
      )}

      {/* Detail view */}
      {selectedResult.value &&
        selectedResult.value.result &&
        (() => {
          const r = selectedResult.value!;
          const res = r.result;
          const cf = res.cfPrefixes;
          return (
            <>
              {/* Summary cards */}
              <div class="bg-white rounded-lg shadow p-6 mb-6">
                <div class="flex flex-wrap items-center gap-4 md:gap-6">
                  <div>
                    <span class="text-xs text-[#999] block">ISP</span>
                    <span class="text-sm text-[#111]">{res.name}</span>
                  </div>
                  <div>
                    <span class="text-xs text-[#999] block">ASN</span>
                    <span class="text-sm text-[#111]">AS{res.asn}</span>
                  </div>
                  <div>
                    <span class="text-xs text-[#999] block">Country</span>
                    <span class="text-sm text-[#111]">
                      {COUNTRY_FLAGS[res.country] ?? ""}{" "}
                      {COUNTRY_NAMES[res.country] ?? res.country}
                    </span>
                  </div>
                  <div>
                    <span class="text-xs text-[#999] block">Score</span>
                    <ScoreBadge score={res.score} />
                  </div>
                  <div>
                    <span class="text-xs text-[#999] block">Query Time</span>
                    <span class="text-sm text-[#111]">{r.queryTime}ms</span>
                  </div>
                  <div>
                    <span class="text-xs text-[#999] block">
                      Global BGP Table
                    </span>
                    <span class="text-sm text-[#111]">
                      {r.bgpTableSize.toLocaleString()} prefixes
                    </span>
                  </div>
                </div>
              </div>

              {/* Stats grid */}
              <div class="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
                <div class="bg-white rounded-lg shadow p-4 text-center">
                  <div class="text-2xl font-medium text-[#111]">
                    {cf.total.toLocaleString()}
                  </div>
                  <div class="text-xs text-[#999]">
                    AS13335 Prefixes
                  </div>
                </div>
                <div class="bg-white rounded-lg shadow p-4 text-center">
                  <div class="text-2xl font-medium text-blue-600">
                    {cf.v4.toLocaleString()}
                  </div>
                  <div class="text-xs text-[#999]">IPv4</div>
                </div>
                <div class="bg-white rounded-lg shadow p-4 text-center">
                  <div class="text-2xl font-medium text-indigo-600">
                    {cf.v6.toLocaleString()}
                  </div>
                  <div class="text-xs text-[#999]">IPv6</div>
                </div>
                <div class="bg-white rounded-lg shadow p-4 text-center">
                  <div class="text-2xl font-medium text-green-600">
                    {cf.avgVisibility.toLocaleString()}
                  </div>
                  <div class="text-xs text-[#999]">Avg Visibility</div>
                </div>
                <div class="bg-white rounded-lg shadow p-4 text-center">
                  <div class="text-2xl font-medium text-[#999]">
                    {cf.minVisibility.toLocaleString()}
                  </div>
                  <div class="text-xs text-[#999]">Min Visibility</div>
                </div>
                <div class="bg-white rounded-lg shadow p-4 text-center">
                  <div class="text-2xl font-medium text-blue-600">
                    {res.peering.sharedIxps}
                  </div>
                  <div class="text-xs text-[#999]">Shared IXPs</div>
                </div>
              </div>

              {/* Visibility distribution */}
              <div class="bg-white rounded-lg shadow p-6 mb-6">
                <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider mb-4">
                  Cloudflare BGP Prefix Visibility Distribution (AS13335)
                </h3>
                <div class="mb-3">
                  <VisBar buckets={cf.visibilityBuckets} />
                </div>
                <div class="flex flex-wrap gap-4">
                  {cf.visibilityBuckets.map((b, i) => {
                    const colors = [
                      "text-red-600",
                      "text-orange-600",
                      "text-yellow-600",
                      "text-green-600",
                      "text-green-700",
                    ];
                    const pct =
                      cf.total > 0
                        ? ((b.count / cf.total) * 100).toFixed(1)
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

              {/* Peering info */}
              <div
                class={`border rounded-lg p-4 mb-6 ${
                  res.peering.likelyDirectPeering
                    ? "bg-green-50 border-green-200"
                    : "bg-amber-50 border-amber-200"
                }`}
              >
                <div class="flex items-start gap-3">
                  <svg
                    class={`w-5 h-5 shrink-0 mt-0.5 ${
                      res.peering.likelyDirectPeering
                        ? "text-green-600"
                        : "text-amber-600"
                    }`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    {res.peering.likelyDirectPeering ? (
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M5 13l4 4L19 7"
                      />
                    ) : (
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    )}
                  </svg>
                  <div>
                    <p
                      class={`text-sm font-medium ${
                        res.peering.likelyDirectPeering
                          ? "text-green-800"
                          : "text-amber-800"
                      }`}
                    >
                      {res.peering.likelyDirectPeering
                        ? `Direct peering likely — ${res.peering.sharedIxps} shared IXP(s) with Cloudflare`
                        : "No shared IXPs found via PeeringDB"}
                    </p>
                    <p
                      class={`text-xs mt-1 ${
                        res.peering.likelyDirectPeering
                          ? "text-green-700"
                          : "text-amber-700"
                      }`}
                    >
                      {res.name} has {res.peering.ispIxps} IXP connection(s) in
                      PeeringDB. Cloudflare is present at{" "}
                      {res.peering.cfIxps} IXPs globally (open peering policy).
                      {!res.peering.likelyDirectPeering &&
                        " The ISP may peer with Cloudflare via private peering or transit, or PeeringDB data may be incomplete."}
                    </p>
                  </div>
                </div>
              </div>

              {/* Low visibility prefixes */}
              {cf.lowVisibility.length > 0 && (
                <div class="bg-white rounded-lg shadow overflow-hidden mb-6">
                  <div class="px-4 py-3 bg-[#fafafa] border-b border-[#eee]">
                    <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider">
                      Low Visibility Prefixes — {cf.lowVisibility.length}{" "}
                      prefix(es) seen by fewer than{" "}
                      {Math.max(
                        1000,
                        Math.round(cf.avgVisibility * 0.5),
                      ).toLocaleString()}{" "}
                      peers
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
                        {cf.lowVisibility.map((p, idx) => {
                          const pctOfAvg =
                            cf.avgVisibility > 0
                              ? Math.round(
                                  (p.visibility / cf.avgVisibility) * 100,
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
                              <td class="px-4 py-3 text-[#999]">
                                /{p.mask}
                              </td>
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
                <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider mb-3">
                  About this data
                </h3>
                <div class="space-y-2 text-xs text-[#666]">
                  <p>
                    <span class="font-medium">BGP prefixes</span> are the
                    actual IP ranges that Cloudflare (AS13335) announces to
                    the global routing table. These are sourced from{" "}
                    <a
                      href="https://bgp.tools/kb/api"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-blue-600 hover:underline"
                    >
                      bgp.tools
                    </a>{" "}
                    (updated every ~30 min).
                  </p>
                  <p>
                    <span class="font-medium">Visibility</span> is the number
                    of bgp.tools peer sessions that observe each route. Higher
                    visibility means better global propagation. Prefixes with
                    low visibility may indicate routing issues or recent
                    announcements that haven't fully propagated.
                  </p>
                  <p>
                    <span class="font-medium">Shared IXPs</span> are Internet
                    Exchange Points where both the ISP and Cloudflare are
                    present (via{" "}
                    <a
                      href="https://www.peeringdb.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-blue-600 hover:underline"
                    >
                      PeeringDB
                    </a>
                    ). Shared IXP presence suggests direct peering, which
                    means lower latency and no transit costs. Cloudflare has
                    an open peering policy.
                  </p>
                </div>
              </div>
            </>
          );
        })()}

      {/* Summary table when multiple checked */}
      {results.value.size > 1 && !selectedResult.value && (
        <div class="bg-white rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 bg-[#fafafa] border-b border-[#eee]">
            <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider">
              Summary
            </h3>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[#eee] bg-[#fafafa]">
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    ISP
                  </th>
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    ASN
                  </th>
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Country
                  </th>
                  <th class="text-center px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Score
                  </th>
                  <th class="text-center px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    CF Prefixes
                  </th>
                  <th class="text-center px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Avg Vis
                  </th>
                  <th class="text-center px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Shared IXPs
                  </th>
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider w-36">
                    Visibility
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[#eee]">
                {[...results.value.values()]
                  .sort((a, b) => b.score - a.score)
                  .map((r) => (
                    <tr
                      key={r.asn}
                      class="hover:bg-[#fafafa] cursor-pointer"
                      onClick={() => checkSingleIsp(r.asn)}
                    >
                      <td class="px-4 py-3 text-[#111]">{r.name}</td>
                      <td class="px-4 py-3 text-[#999]">AS{r.asn}</td>
                      <td class="px-4 py-3">
                        {COUNTRY_FLAGS[r.country] ?? ""}{" "}
                        {COUNTRY_NAMES[r.country] ?? r.country}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <ScoreBadge score={r.score} />
                      </td>
                      <td class="px-4 py-3 text-center text-[#111]">
                        {r.cfPrefixes.total.toLocaleString()}
                      </td>
                      <td class="px-4 py-3 text-center text-[#111]">
                        {r.cfPrefixes.avgVisibility.toLocaleString()}
                      </td>
                      <td class="px-4 py-3 text-center text-blue-600">
                        {r.peering.sharedIxps}
                      </td>
                      <td class="px-4 py-3">
                        <VisBar buckets={r.cfPrefixes.visibilityBuckets} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
