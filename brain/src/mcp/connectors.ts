/**
 * Connectors: services bots can use after a one-click sign-in. Each is a
 * remote MCP server whose sign-in Local Bot can do on its own (OAuth with
 * dynamic client registration or a client metadata document). Checked by hand; services that need Local Bot
 * registered with them first (GitHub, Asana, HubSpot, Box) aren't here yet.
 */
export interface Connector {
  id: string;
  name: string;
  /** What bots can do with it, in a few words. */
  description: string;
  url: string;
  category: "Work" | "Design" | "Media" | "Developer" | "Business";
}

export const CONNECTORS: Connector[] = [
  { id: "notion", name: "Notion", description: "Search, read and write pages", url: "https://mcp.notion.com/mcp", category: "Work" },
  { id: "linear", name: "Linear", description: "Issues, projects and cycles", url: "https://mcp.linear.app/mcp", category: "Work" },
  { id: "atlassian", name: "Jira & Confluence", description: "Issues and wiki pages", url: "https://mcp.atlassian.com/v1/mcp", category: "Work" },
  { id: "monday", name: "monday.com", description: "Boards and items", url: "https://mcp.monday.com/mcp", category: "Work" },
  { id: "zapier", name: "Zapier", description: "Thousands of apps through your Zaps", url: "https://mcp.zapier.com/api/mcp/mcp", category: "Work" },
  { id: "canva", name: "Canva", description: "Find and create designs", url: "https://mcp.canva.com/mcp", category: "Design" },
  { id: "webflow", name: "Webflow", description: "Sites, pages and CMS", url: "https://mcp.webflow.com/mcp", category: "Design" },
  { id: "wix", name: "Wix", description: "Sites and business data", url: "https://mcp.wix.com/mcp", category: "Design" },
  { id: "elevenlabs", name: "ElevenLabs", description: "Voices, speech and voice agents", url: "https://api.elevenlabs.io/v1/mcp", category: "Media" },
  { id: "sentry", name: "Sentry", description: "Errors and performance", url: "https://mcp.sentry.dev/mcp", category: "Developer" },
  { id: "vercel", name: "Vercel", description: "Projects and deployments", url: "https://mcp.vercel.com", category: "Developer" },
  { id: "supabase", name: "Supabase", description: "Databases and projects", url: "https://mcp.supabase.com/mcp", category: "Developer" },
  { id: "cloudflare", name: "Cloudflare", description: "Workers, storage and DNS", url: "https://bindings.mcp.cloudflare.com/mcp", category: "Developer" },
  { id: "stripe", name: "Stripe", description: "Customers, payments, invoices", url: "https://mcp.stripe.com", category: "Business" },
  { id: "paypal", name: "PayPal", description: "Invoices and transactions", url: "https://mcp.paypal.com/mcp", category: "Business" },
  { id: "intercom", name: "Intercom", description: "Conversations and contacts", url: "https://mcp.intercom.com/mcp", category: "Business" },
];
