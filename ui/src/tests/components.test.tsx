import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AssetCard } from "../components/AssetCard.tsx";
import { SearchBar } from "../components/SearchBar.tsx";
import { TrustBadgeTag, SensitivityTag } from "../components/TrustBadge.tsx";
import type { AssetListItem } from "../api/types.ts";

const mockAsset: AssetListItem = {
  name: "aria.dev/skills/hr-policy-lookup",
  version: "1.2.0",
  description: "Look up HR policies by keyword or topic.",
  lifecycle_state: "published",
  sensitivity_tier: "internal",
  domains: ["human_resources", "human_resources/policy"],
  skills: ["knowledge_retrieval/rag", "nlp/search/semantic_search"],
  trust_badge: "internal-use",
  tags: ["hr", "policy"],
  authors: ["ARIA Platform Team <platform@aria.dev>"],
  updated_at: "2026-02-15T10:30:00Z",
};

describe("AssetCard", () => {
  it("renders asset name and description", () => {
    render(
      <MemoryRouter>
        <AssetCard asset={mockAsset} />
      </MemoryRouter>
    );

    expect(screen.getByText(/hr policy lookup/i)).toBeInTheDocument();
    expect(screen.getByText(/Look up HR policies/i)).toBeInTheDocument();
  });

  it("renders version badge", () => {
    render(
      <MemoryRouter>
        <AssetCard asset={mockAsset} />
      </MemoryRouter>
    );
    expect(screen.getByText(/v1\.2\.0/)).toBeInTheDocument();
  });

  it("renders details link pointing to correct URL", () => {
    render(
      <MemoryRouter>
        <AssetCard asset={mockAsset} />
      </MemoryRouter>
    );
    const links = screen.getAllByRole("link");
    expect(links.some((l) => l.getAttribute("href")?.includes("hr-policy-lookup"))).toBe(true);
  });

  it("renders trust badge", () => {
    render(
      <MemoryRouter>
        <AssetCard asset={mockAsset} />
      </MemoryRouter>
    );
    expect(screen.getByText("Internal Use")).toBeInTheDocument();
  });
});

describe("SearchBar", () => {
  it("calls onSearch when form is submitted", () => {
    const onSearch = vi.fn();
    const onDomainChange = vi.fn();
    render(<SearchBar onSearch={onSearch} onDomainChange={onDomainChange} />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "hr policy" } });
    fireEvent.submit(input.closest("form")!);

    expect(onSearch).toHaveBeenCalledWith("hr policy");
  });

  it("calls onDomainChange when select changes", () => {
    const onSearch = vi.fn();
    const onDomainChange = vi.fn();
    render(<SearchBar onSearch={onSearch} onDomainChange={onDomainChange} />);

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "engineering" } });

    expect(onDomainChange).toHaveBeenCalledWith("engineering");
  });

  it("trims whitespace from search query", () => {
    const onSearch = vi.fn();
    const onDomainChange = vi.fn();
    render(<SearchBar onSearch={onSearch} onDomainChange={onDomainChange} />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "  summarize  " } });
    fireEvent.submit(input.closest("form")!);

    expect(onSearch).toHaveBeenCalledWith("summarize");
  });
});

describe("TrustBadgeTag", () => {
  it("renders approved-security badge", () => {
    render(<TrustBadgeTag badge="approved-security" />);
    expect(screen.getByText("Approved by Security")).toBeInTheDocument();
  });

  it("renders public badge", () => {
    render(<TrustBadgeTag badge="public" />);
    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  it("renders restricted badge", () => {
    render(<TrustBadgeTag badge="restricted" />);
    expect(screen.getByText("Restricted")).toBeInTheDocument();
  });
});

describe("SensitivityTag", () => {
  it("renders internal sensitivity", () => {
    render(<SensitivityTag tier="internal" />);
    expect(screen.getByText("Internal")).toBeInTheDocument();
  });

  it("renders highly_confidential sensitivity", () => {
    render(<SensitivityTag tier="highly_confidential" />);
    expect(screen.getByText("Highly Confidential")).toBeInTheDocument();
  });
});
