import type { CatalogAsset } from "../models/oasf.js";

export const sampleAssets: CatalogAsset[] = [
  {
    record: {
      name: "aria.dev/skills/hr-policy-lookup",
      version: "1.2.0",
      schema_version: "1.0.0",
      description:
        "Look up HR policies, benefits, and compliance documents by keyword or topic. Answers common employee questions instantly without contacting HR.",
      skills: [
        { id: 30101, name: "knowledge_retrieval/rag" },
        { id: 10201, name: "nlp/search/semantic_search" },
      ],
      domains: [
        { name: "human_resources" },
        { name: "human_resources/policy" },
      ],
      modules: [
        {
          type: "mcp_server",
          transport: "stdio",
          tools: ["lookup_policy", "list_topics", "get_document"],
        },
      ],
      locators: [
        {
          type: "oci",
          uri: "ghcr.io/aria-fx/aria-assets/hr-policy-lookup:1.2.0",
        },
      ],
      authors: ["ARIA Platform Team <platform@aria.dev>"],
      created_at: "2025-11-01T00:00:00Z",
      updated_at: "2026-02-15T10:30:00Z",
      lifecycle_state: "published",
      tags: ["hr", "policy", "knowledge", "rag"],
    },
    governance: {
      sensitivity_tier: "internal",
      data_classifications: ["PII"],
      approval_chain: ["hr-manager"],
      allowed_consumers: ["hr-team", "all-employees"],
      max_data_retention_days: 90,
      audit_level: "standard",
      compliance_frameworks: ["SOC2"],
    },
  },
  {
    record: {
      name: "aria.dev/agents/onboarding-assistant",
      version: "2.1.0",
      schema_version: "1.0.0",
      description:
        "A complete AI assistant that guides new employees through the onboarding process: paperwork, system access, policy acknowledgments, and first-week scheduling.",
      skills: [
        { id: 10101, name: "nlp/nlu/intent_classification" },
        { id: 30101, name: "knowledge_retrieval/rag" },
        { id: 40201, name: "workflow/document_generation" },
      ],
      domains: [
        { name: "human_resources" },
        { name: "human_resources/onboarding" },
      ],
      modules: [
        {
          type: "mcp_server",
          transport: "http",
          tools: ["lookup_policy", "generate_document", "schedule_meeting"],
        },
        {
          type: "knowledge_base",
          ref: "aria.dev/knowledge/hr-policies",
        },
      ],
      locators: [
        {
          type: "oci",
          uri: "ghcr.io/aria-fx/aria-assets/onboarding-assistant:2.1.0",
        },
      ],
      authors: ["HR Automation Team <hr-automation@aria.dev>"],
      created_at: "2025-09-15T00:00:00Z",
      updated_at: "2026-03-20T14:00:00Z",
      lifecycle_state: "published",
      tags: ["onboarding", "hr", "automation", "agent"],
    },
    governance: {
      sensitivity_tier: "confidential",
      data_classifications: ["PII", "PHI"],
      approval_chain: ["ai-governance-lead", "data-privacy-officer"],
      allowed_consumers: ["hr-team", "onboarding-automation"],
      max_data_retention_days: 90,
      audit_level: "full",
      dependency_sensitivity_ceiling: "highly_confidential",
      compliance_frameworks: ["HIPAA", "SOC2"],
    },
  },
  {
    record: {
      name: "aria.dev/skills/document-summarizer",
      version: "3.0.1",
      schema_version: "1.0.0",
      description:
        "Instantly summarize long documents, reports, and meeting notes. Supports PDFs, Word documents, and plain text. Extracts key points, action items, and decisions.",
      skills: [
        { id: 10301, name: "nlp/text_processing/summarization" },
        { id: 10401, name: "nlp/text_processing/extraction" },
      ],
      domains: [
        { name: "productivity" },
        { name: "productivity/document_management" },
      ],
      modules: [
        {
          type: "mcp_server",
          transport: "stdio",
          tools: ["summarize_document", "extract_action_items", "extract_key_points"],
        },
      ],
      locators: [
        {
          type: "oci",
          uri: "ghcr.io/aria-fx/aria-assets/document-summarizer:3.0.1",
        },
      ],
      authors: ["Productivity Tools Team <productivity@aria.dev>"],
      created_at: "2025-07-01T00:00:00Z",
      updated_at: "2026-04-01T09:00:00Z",
      lifecycle_state: "published",
      tags: ["summarization", "productivity", "documents", "nlp"],
    },
    governance: {
      sensitivity_tier: "internal",
      approval_chain: ["team-lead"],
      allowed_consumers: ["all-employees"],
      max_data_retention_days: 30,
      audit_level: "minimal",
      compliance_frameworks: ["SOC2"],
    },
  },
  {
    record: {
      name: "aria.dev/skills/code-review",
      version: "1.5.2",
      schema_version: "1.0.0",
      description:
        "AI-powered code review that checks for bugs, security vulnerabilities, performance issues, and coding standard violations. Works with 20+ programming languages.",
      skills: [
        { id: 50101, name: "code/review/static_analysis" },
        { id: 50201, name: "code/security/vulnerability_detection" },
      ],
      domains: [
        { name: "engineering" },
        { name: "engineering/software_development" },
      ],
      modules: [
        {
          type: "mcp_server",
          transport: "stdio",
          tools: ["review_code", "check_security", "suggest_improvements"],
        },
      ],
      locators: [
        {
          type: "oci",
          uri: "ghcr.io/aria-fx/aria-assets/code-review:1.5.2",
        },
      ],
      authors: ["Engineering Platform Team <eng-platform@aria.dev>"],
      created_at: "2025-06-01T00:00:00Z",
      updated_at: "2026-04-10T11:00:00Z",
      lifecycle_state: "published",
      tags: ["code", "review", "security", "engineering"],
    },
    governance: {
      sensitivity_tier: "public",
      allowed_consumers: ["all-employees", "external-contractors"],
      audit_level: "minimal",
    },
  },
  {
    record: {
      name: "aria.dev/skills/meeting-notes",
      version: "2.0.0",
      schema_version: "1.0.0",
      description:
        "Automatically generate structured meeting notes from transcripts or recordings. Captures attendees, decisions, action items, and follow-ups in a consistent format.",
      skills: [
        { id: 10301, name: "nlp/text_processing/summarization" },
        { id: 10501, name: "nlp/speech/transcription" },
      ],
      domains: [{ name: "productivity" }, { name: "productivity/meetings" }],
      modules: [
        {
          type: "mcp_server",
          transport: "stdio",
          tools: ["generate_notes", "extract_action_items", "identify_decisions"],
        },
      ],
      locators: [
        {
          type: "oci",
          uri: "ghcr.io/aria-fx/aria-assets/meeting-notes:2.0.0",
        },
      ],
      authors: ["Productivity Tools Team <productivity@aria.dev>"],
      created_at: "2025-10-01T00:00:00Z",
      updated_at: "2026-03-01T16:00:00Z",
      lifecycle_state: "published",
      tags: ["meetings", "notes", "productivity", "transcription"],
    },
    governance: {
      sensitivity_tier: "internal",
      allowed_consumers: ["all-employees"],
      max_data_retention_days: 60,
      audit_level: "standard",
      compliance_frameworks: ["SOC2"],
    },
  },
  {
    record: {
      name: "aria.dev/skills/financial-analyzer",
      version: "1.0.0",
      schema_version: "1.0.0",
      description:
        "Analyze financial reports, budget data, and expense records. Extracts key metrics, identifies trends, and flags anomalies. For Finance team use only.",
      skills: [
        { id: 60101, name: "data_analysis/financial/report_analysis" },
        { id: 60201, name: "data_analysis/anomaly_detection" },
      ],
      domains: [{ name: "finance" }, { name: "finance/reporting" }],
      modules: [
        {
          type: "mcp_server",
          transport: "http",
          tools: ["analyze_report", "detect_anomalies", "extract_metrics"],
        },
      ],
      locators: [
        {
          type: "oci",
          uri: "ghcr.io/aria-fx/aria-assets/financial-analyzer:1.0.0",
        },
      ],
      authors: ["Finance Technology Team <fin-tech@aria.dev>"],
      created_at: "2026-01-15T00:00:00Z",
      updated_at: "2026-04-25T08:00:00Z",
      lifecycle_state: "published",
      tags: ["finance", "analysis", "reporting", "data"],
    },
    governance: {
      sensitivity_tier: "highly_confidential",
      data_classifications: ["Financial", "PCI"],
      approval_chain: ["finance-director", "ciso"],
      allowed_consumers: ["finance-team"],
      max_data_retention_days: 365,
      audit_level: "full",
      compliance_frameworks: ["SOX", "PCI-DSS"],
    },
  },
  {
    record: {
      name: "aria.dev/skills/customer-insights",
      version: "1.3.0",
      schema_version: "1.0.0",
      description:
        "Query and analyze customer data, engagement metrics, and feedback. Build customer profiles, identify churn risks, and surface opportunities for account managers.",
      skills: [
        { id: 70101, name: "data_analysis/crm/customer_analytics" },
        { id: 10201, name: "nlp/search/semantic_search" },
      ],
      domains: [
        { name: "sales" },
        { name: "sales/customer_success" },
      ],
      modules: [
        {
          type: "mcp_server",
          transport: "http",
          tools: ["get_customer_profile", "analyze_engagement", "predict_churn"],
        },
      ],
      locators: [
        {
          type: "oci",
          uri: "ghcr.io/aria-fx/aria-assets/customer-insights:1.3.0",
        },
      ],
      authors: ["Sales Technology Team <sales-tech@aria.dev>"],
      created_at: "2025-12-01T00:00:00Z",
      updated_at: "2026-04-15T12:00:00Z",
      lifecycle_state: "published",
      tags: ["sales", "crm", "customers", "analytics"],
    },
    governance: {
      sensitivity_tier: "confidential",
      data_classifications: ["PII", "Business Sensitive"],
      approval_chain: ["sales-director"],
      allowed_consumers: ["sales-team", "customer-success"],
      max_data_retention_days: 180,
      audit_level: "full",
      compliance_frameworks: ["GDPR", "SOC2"],
    },
  },
];
