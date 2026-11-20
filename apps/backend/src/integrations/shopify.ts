import type { Connector, ToolDescriptor, ToolResult } from "./types.js";
import { textResult } from "./types.js";

/** Shopify Admin GraphQL via a custom-app Admin API access token (created in the store admin). */
export const SHOPIFY_API_VERSION = "2026-10";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });

export class ShopifyConnector implements Connector {
  id = "shopify";
  displayName = "Shopify";
  constructor(private shopDomain: string, private token: string, private fetcher: typeof fetch = fetch) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain)) throw new Error("Shop domain must look like your-store.myshopify.com");
  }

  private async gql(query: string, variables: Record<string, unknown> = {}) {
    const res = await this.fetcher(`https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": this.token },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: unknown; errors?: unknown };
    if (!res.ok || json.errors) throw new Error(`Shopify ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
    return json.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      { name: "shopify__shop_summary", core: true, risk: "read", description: "Store name, currency, plan and today's order count.", inputSchema: obj({}) },
      {
        name: "shopify__search_orders", core: true, risk: "read",
        description: "Search orders with Shopify query syntax (e.g. 'created_at:>2026-11-01', 'fulfillment_status:unfulfilled', 'name:#1001').",
        inputSchema: obj({ query: { type: "string" }, first: { type: "integer", minimum: 1, maximum: 25 } }),
      },
      {
        name: "shopify__search_products", core: true, risk: "read",
        description: "Search products by title or query syntax; returns status, inventory and price.",
        inputSchema: obj({ query: { type: "string" }, first: { type: "integer", minimum: 1, maximum: 25 } }),
      },
      {
        name: "shopify__graphql_query", risk: "read",
        description: "Run a read-only Shopify Admin GraphQL query for anything the other tools don't cover. Mutations are rejected.",
        inputSchema: obj({ query: { type: "string" }, variables: { type: "object" } }, ["query"]),
      },
      {
        name: "shopify__graphql_mutation", risk: "consequential",
        description: "Run a Shopify Admin GraphQL mutation (changes the store). Always confirmed with the caller first.",
        inputSchema: obj({ mutation: { type: "string" }, variables: { type: "object" }, plain_english: { type: "string", description: "What this changes, in one sentence" } }, ["mutation", "plain_english"]),
        describe: (i) => String(i.plain_english ?? "change the Shopify store"),
      },
    ];
  }

  async callTool(name: string, i: Record<string, unknown>): Promise<ToolResult> {
    const first = typeof i.first === "number" ? i.first : 10;
    switch (name) {
      case "shopify__shop_summary": {
        const today = new Date().toISOString().slice(0, 10);
        const d = await this.gql(`query($q:String!){ shop { name currencyCode plan { displayName } } ordersCount(query:$q){ count } }`, { q: `created_at:>=${today}` });
        return textResult(true, { ...d.shop, ordersToday: d.ordersCount?.count });
      }
      case "shopify__search_orders": {
        const d = await this.gql(`query($q:String,$n:Int!){ orders(first:$n, query:$q, sortKey:CREATED_AT, reverse:true){ nodes{ id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{ shopMoney{ amount currencyCode } } customer{ displayName } } } }`, { q: i.query ?? null, n: first });
        return textResult(true, d.orders.nodes.length ? d.orders.nodes : "No matching orders.");
      }
      case "shopify__search_products": {
        const d = await this.gql(`query($q:String,$n:Int!){ products(first:$n, query:$q){ nodes{ id title status totalInventory priceRangeV2{ minVariantPrice{ amount currencyCode } } } } }`, { q: i.query ?? null, n: first });
        return textResult(true, d.products.nodes.length ? d.products.nodes : "No matching products.");
      }
      case "shopify__graphql_query": {
        const q = String(i.query ?? "");
        if (/^\s*mutation\b/i.test(q) || /\bmutation\s*[({]/i.test(q)) return textResult(false, "Mutations are not allowed here; use shopify__graphql_mutation.");
        return textResult(true, await this.gql(q, (i.variables as Record<string, unknown>) ?? {}));
      }
      case "shopify__graphql_mutation": {
        const d = await this.gql(String(i.mutation ?? ""), (i.variables as Record<string, unknown>) ?? {});
        const userErrors = JSON.stringify(d).match(/"userErrors":\[(.+?)\]/);
        return textResult(!userErrors, userErrors ? `Shopify rejected it: ${userErrors[1]}` : d);
      }
      default:
        return textResult(false, `Unknown Shopify tool ${name}`);
    }
  }

  async test() {
    const d = await this.gql(`{ shop { name myshopifyDomain } }`);
    return { ok: Boolean(d.shop?.name), detail: `Connected to ${d.shop?.name} (${d.shop?.myshopifyDomain})`, toolCount: (await this.listTools()).length };
  }
}
