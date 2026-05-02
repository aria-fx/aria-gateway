import { useState } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  onDomainChange: (domain: string) => void;
  placeholder?: string;
}

const DOMAINS = [
  { value: "", label: "All departments" },
  { value: "human_resources", label: "Human Resources" },
  { value: "engineering", label: "Engineering" },
  { value: "finance", label: "Finance" },
  { value: "sales", label: "Sales" },
  { value: "productivity", label: "Productivity" },
];

export function SearchBar({ onSearch, onDomainChange, placeholder }: SearchBarProps) {
  const [value, setValue] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearch(value.trim());
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col sm:flex-row gap-3"
      role="search"
    >
      <div className="relative flex-1">
        <span className="absolute inset-y-0 left-3 flex items-center text-gray-400 pointer-events-none">
          🔍
        </span>
        <input
          type="search"
          aria-label="Search skills"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder ?? "Search by name, capability, or topic…"}
          className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-aria-600 focus:border-transparent text-sm"
        />
      </div>

      <select
        aria-label="Filter by department"
        onChange={(e) => onDomainChange(e.target.value)}
        className="px-3 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-aria-600 text-sm bg-white"
      >
        {DOMAINS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      <button
        type="submit"
        className="px-5 py-2.5 bg-aria-700 text-white rounded-lg hover:bg-aria-800 focus:outline-none focus:ring-2 focus:ring-aria-600 text-sm font-medium transition-colors"
      >
        Search
      </button>
    </form>
  );
}
