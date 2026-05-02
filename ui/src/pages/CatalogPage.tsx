import { useEffect, useState, useCallback } from "react";
import { listAssets, getCatalogStats } from "../api/catalog.ts";
import type { AssetListItem, CatalogStats } from "../api/types.ts";
import { AssetCard } from "../components/AssetCard.tsx";
import { SearchBar } from "../components/SearchBar.tsx";

export function CatalogPage() {
  const [assets, setAssets] = useState<AssetListItem[]>([]);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [domain, setDomain] = useState("");

  const load = useCallback(
    async (kw: string, dm: string) => {
      setLoading(true);
      setError(null);
      try {
        const [catalog, catalogStats] = await Promise.all([
          listAssets({ keyword: kw || undefined, domain: dm || undefined }),
          getCatalogStats(),
        ]);
        setAssets(catalog.assets);
        setStats(catalogStats);
      } catch {
        setError("Unable to load the catalog. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(keyword, domain);
  }, [load, keyword, domain]);

  function handleSearch(q: string) {
    setKeyword(q);
  }

  function handleDomainChange(d: string) {
    setDomain(d);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero */}
      <header className="bg-gradient-to-br from-aria-800 to-aria-600 text-white">
        <div className="max-w-6xl mx-auto px-4 py-12 sm:py-16">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-4xl">🤖</span>
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold">ARIA Skills Catalog</h1>
              <p className="text-aria-200 mt-1">
                Governed AI capabilities for your organization
              </p>
            </div>
          </div>

          <p className="text-lg text-aria-100 max-w-2xl mt-4">
            Browse and add AI skills to Claude, ChatGPT, and VS Code — all approved and governed by your IT team.
            No technical setup required.
          </p>

          {stats && (
            <div className="flex flex-wrap gap-6 mt-8 text-sm">
              <div className="bg-white/10 rounded-lg px-4 py-2">
                <span className="font-bold text-xl">{stats.total_assets}</span>
                <span className="ml-2 text-aria-200">available skills</span>
              </div>
              {Object.entries(stats.by_domain).map(([d, count]) => (
                <div key={d} className="bg-white/10 rounded-lg px-4 py-2">
                  <span className="font-bold text-xl">{count}</span>
                  <span className="ml-2 text-aria-200 capitalize">{d.replace(/_/g, " ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Search */}
        <section aria-label="Search and filter" className="mb-8">
          <SearchBar
            onSearch={handleSearch}
            onDomainChange={handleDomainChange}
            placeholder="Search by name, capability, or topic…"
          />
        </section>

        {/* Results */}
        {loading && (
          <div className="text-center py-16 text-gray-400">
            <div className="text-4xl mb-3">⏳</div>
            <p>Loading skills…</p>
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 p-6 text-center text-red-700">
            <p className="font-semibold">⚠️ {error}</p>
            <button
              onClick={() => void load(keyword, domain)}
              className="mt-3 text-sm underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-500">
                {assets.length === 0
                  ? "No skills found"
                  : `${assets.length} skill${assets.length !== 1 ? "s" : ""} available`}
                {keyword && ` for "${keyword}"`}
                {domain && ` in ${domain.replace(/_/g, " ")}`}
              </p>
            </div>

            {assets.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-5xl mb-4">🔍</div>
                <p className="text-lg font-medium text-gray-500">No matching skills found</p>
                <p className="text-sm mt-2">
                  Try different keywords or browse all skills by clearing your search.
                </p>
                <button
                  onClick={() => { setKeyword(""); setDomain(""); }}
                  className="mt-4 text-sm text-aria-700 underline hover:no-underline"
                >
                  Clear search
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {assets.map((asset) => (
                  <AssetCard key={`${asset.name}@${asset.version}`} asset={asset} />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-16 border-t border-gray-200 py-8 text-center text-sm text-gray-400">
        <p>
          ARIA Distribution Gateway ·{" "}
          <a href="/openapi.json" className="hover:text-aria-700 transition-colors">
            OpenAPI
          </a>{" "}
          ·{" "}
          <a href="/.well-known/ai-plugin.json" className="hover:text-aria-700 transition-colors">
            ChatGPT Plugin
          </a>{" "}
          ·{" "}
          <a href="/mcp" className="hover:text-aria-700 transition-colors">
            MCP Server
          </a>
        </p>
      </footer>
    </div>
  );
}
