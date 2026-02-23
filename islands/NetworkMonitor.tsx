import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

interface PrefixResult {
  prefix: string;
  type: "v4" | "v6";
  bgpStatus: "announced" | "deaggregated" | "not-found";
  bgpPrefixes: string[];
  visibility: number;
  moreSpecificCount: number;
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
  prefixes: PrefixResult[];
  totalPrefixes: number;
  announced: number;
  deaggregated: number;
  notFound: number;
  score: number;
  peering: PeeringInfo;
}

interface CheckResponse {
  success: boolean;
  result: IspResult;
  queryTime: number;
  cloudflare: {
    officialV4: string[];
    officialV6: string[];
    bgpPrefixCount: number;
    totalBgpVisibility: number;
  };
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

function BgpStatusBadge({ status }: { status: string }) {
  if (status === "announced") {
    return (
      <span class="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">
        exact match
      </span>
    );
  }
  if (status === "deaggregated") {
    return (
      <span class="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-700">
        deaggregated
      </span>
    );
  }
  return (
    <span class="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700">
      not found
    </span>
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
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-green-500" />{" "}
              Exact match
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-yellow-500" />{" "}
              Deaggregated
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-red-500" />{" "}
              Not found
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
              <div class="flex items-center justify-between">
                <span class="text-xs text-[#999]">AS{isp.asn}</span>
                {result && (
                  <div class="flex items-center gap-2">
                    {result.peering.likelyDirectPeering && (
                      <span class="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">
                        {result.peering.sharedIxps} shared IXP{result.peering.sharedIxps !== 1 ? "s" : ""}
                      </span>
                    )}
                    <span class="text-xs text-[#999]">
                      {result.announced + result.deaggregated}/
                      {result.totalPrefixes} in BGP
                    </span>
                  </div>
                )}
              </div>
              {result && (
                <div class="mt-3 flex gap-0.5">
                  {result.prefixes.map((p, i) => (
                    <div
                      key={i}
                      class={`h-1.5 flex-1 rounded-full ${
                        p.bgpStatus === "announced"
                          ? "bg-green-500"
                          : p.bgpStatus === "deaggregated"
                            ? "bg-yellow-500"
                            : "bg-red-300"
                      }`}
                      title={`${p.prefix}: ${p.bgpStatus} (${p.visibility} peers)`}
                    />
                  ))}
                </div>
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
      {selectedResult.value && selectedResult.value.result && (() => {
        const r = selectedResult.value!;
        const res = r.result;
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
                  <span class="text-xs text-[#999] block">BGP Table</span>
                  <span class="text-sm text-[#111]">
                    {r.bgpTableSize.toLocaleString()} prefixes
                  </span>
                </div>
              </div>
            </div>

            {/* Stats grid */}
            <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
              <div class="bg-white rounded-lg shadow p-4 text-center">
                <div class="text-2xl font-medium text-[#111]">
                  {res.totalPrefixes}
                </div>
                <div class="text-xs text-[#999]">Official CF Ranges</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4 text-center">
                <div class="text-2xl font-medium text-green-600">
                  {res.announced}
                </div>
                <div class="text-xs text-[#999]">Exact in BGP</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4 text-center">
                <div class="text-2xl font-medium text-yellow-600">
                  {res.deaggregated}
                </div>
                <div class="text-xs text-[#999]">Deaggregated</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4 text-center">
                <div class="text-2xl font-medium text-blue-600">
                  {r.cloudflare.bgpPrefixCount}
                </div>
                <div class="text-xs text-[#999]">CF BGP Total</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4 text-center">
                <div class="text-2xl font-medium text-blue-600">
                  {res.peering.sharedIxps}
                </div>
                <div class="text-xs text-[#999]">Shared IXPs</div>
              </div>
            </div>

            {/* Peering info */}
            <div class={`border rounded-lg p-4 mb-6 ${
              res.peering.likelyDirectPeering
                ? "bg-green-50 border-green-200"
                : "bg-amber-50 border-amber-200"
            }`}>
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
                  <p class={`text-sm font-medium ${
                    res.peering.likelyDirectPeering
                      ? "text-green-800"
                      : "text-amber-800"
                  }`}>
                    {res.peering.likelyDirectPeering
                      ? `Direct peering likely — ${res.peering.sharedIxps} shared IXP(s) with Cloudflare`
                      : "No shared IXPs found via PeeringDB"}
                  </p>
                  <p class={`text-xs mt-1 ${
                    res.peering.likelyDirectPeering
                      ? "text-green-700"
                      : "text-amber-700"
                  }`}>
                    {res.name} has {res.peering.ispIxps} IXP connection(s) in
                    PeeringDB. Cloudflare is present at{" "}
                    {res.peering.cfIxps} IXPs globally.
                    {!res.peering.likelyDirectPeering &&
                      " The ISP may still peer with Cloudflare via private peering or transit, or PeeringDB data may be incomplete."}
                  </p>
                </div>
              </div>
            </div>

            {/* Not-found alert */}
            {res.notFound > 0 && (
              <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                <div class="flex items-start gap-3">
                  <svg
                    class="w-5 h-5 text-red-600 shrink-0 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <div>
                    <p class="text-sm font-medium text-red-800">
                      {res.notFound} Cloudflare prefix(es) not found in
                      global BGP table
                    </p>
                    <p class="text-xs text-red-700 mt-1">
                      These official Cloudflare IP ranges are not being
                      announced by AS13335 in the global routing table.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Prefix table */}
            <div class="bg-white rounded-lg shadow overflow-hidden mb-6">
              <div class="px-4 py-3 bg-[#fafafa] border-b border-[#eee]">
                <h3 class="text-xs font-medium text-[#666] uppercase tracking-wider">
                  Cloudflare Prefix Analysis — Official IPs vs BGP
                  Announcements (AS13335)
                </h3>
              </div>
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-[#eee] bg-[#fafafa]">
                      <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                        Official Prefix
                      </th>
                      <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                        Type
                      </th>
                      <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                        BGP Status
                      </th>
                      <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                        BGP Announcements
                      </th>
                      <th class="text-right px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                        Visibility
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-[#eee]">
                    {res.prefixes
                      .sort((a, b) => {
                        const order = {
                          "not-found": 0,
                          deaggregated: 1,
                          announced: 2,
                        };
                        return order[a.bgpStatus] - order[b.bgpStatus];
                      })
                      .map((prefix, idx) => (
                        <tr key={idx} class="hover:bg-[#fafafa]">
                          <td class="px-4 py-3">
                            <code class="text-[#111]">{prefix.prefix}</code>
                          </td>
                          <td class="px-4 py-3">
                            <span
                              class={`text-xs px-2 py-0.5 rounded ${
                                prefix.type === "v4"
                                  ? "bg-blue-100 text-blue-700"
                                  : "bg-indigo-100 text-indigo-700"
                              }`}
                            >
                              IPv{prefix.type === "v4" ? "4" : "6"}
                            </span>
                          </td>
                          <td class="px-4 py-3">
                            <BgpStatusBadge status={prefix.bgpStatus} />
                          </td>
                          <td class="px-4 py-3">
                            {prefix.bgpPrefixes.length > 0 ? (
                              <div class="flex flex-wrap gap-1">
                                {prefix.bgpPrefixes.map((bp, i) => (
                                  <code
                                    key={i}
                                    class="text-xs text-[#666] bg-[#f5f5f5] px-1.5 py-0.5 rounded"
                                  >
                                    {bp}
                                  </code>
                                ))}
                                {prefix.moreSpecificCount > 10 && (
                                  <span class="text-xs text-[#999]">
                                    +{prefix.moreSpecificCount - 10} more
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span class="text-xs text-red-500">
                                Not in BGP table
                              </span>
                            )}
                          </td>
                          <td class="px-4 py-3 text-right">
                            {prefix.visibility > 0 ? (
                              <span class="text-xs text-[#999]">
                                {prefix.visibility.toLocaleString()} peers
                              </span>
                            ) : (
                              <span class="text-xs text-[#ccc]">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
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
                    Exact
                  </th>
                  <th class="text-center px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Deagg
                  </th>
                  <th class="text-center px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    Shared IXPs
                  </th>
                  <th class="text-left px-4 py-3 text-xs font-medium text-[#666] uppercase tracking-wider">
                    BGP Health
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
                      <td class="px-4 py-3 text-center text-green-600">
                        {r.announced}
                      </td>
                      <td class="px-4 py-3 text-center text-yellow-600">
                        {r.deaggregated}
                      </td>
                      <td class="px-4 py-3 text-center text-blue-600">
                        {r.peering.sharedIxps}
                      </td>
                      <td class="px-4 py-3">
                        <div class="flex gap-0.5 w-32">
                          {r.prefixes.map((p, i) => (
                            <div
                              key={i}
                              class={`h-1.5 flex-1 rounded-full ${
                                p.bgpStatus === "announced"
                                  ? "bg-green-500"
                                  : p.bgpStatus === "deaggregated"
                                    ? "bg-yellow-500"
                                    : "bg-red-300"
                              }`}
                            />
                          ))}
                        </div>
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
