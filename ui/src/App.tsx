import { Routes, Route } from "react-router-dom";
import { CatalogPage } from "./pages/CatalogPage.tsx";
import { AssetDetailPage } from "./pages/AssetDetailPage.tsx";

function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center text-center p-4">
      <div>
        <div className="text-6xl mb-4">🔍</div>
        <h1 className="text-2xl font-bold text-gray-800 mb-2">Page not found</h1>
        <a href="/" className="text-aria-700 hover:underline">
          ← Back to catalog
        </a>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<CatalogPage />} />
      <Route path="/assets/:name/:version" element={<AssetDetailPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
