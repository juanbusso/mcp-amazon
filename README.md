# mcp-amazon

MCP server that searches Amazon.com with a headless Chromium (Playwright) and estimates the door-to-door landed cost to Argentina: item price, shipping, import duty deposit, and the $99 USD free-shipping promo.

## Tools

| Tool | Description |
|---|---|
| `amazon_search` | Search products, optionally filtering to items that ship to Argentina / qualify for free shipping on $99+. |
| `amazon_get_product` | Product details by ASIN or URL: price, shipping, import fees, landed cost. |
| `amazon_landed_cost_calculator` | Simulate a multi-item cart and check whether it reaches the free-shipping threshold. |

## Requirements

- Node.js 18+
- Google Chrome or a Playwright Chromium build (`npx playwright install chromium`)

## Setup

```bash
npm install
cp .env.example .env   # optional: set CHROMIUM_PATH
npm run check
```

| Variable | Required | Description |
|---|---|---|
| `CHROMIUM_PATH` | No | Absolute path to a Chrome/Chromium binary. Defaults to the Playwright cache, then `/Applications/Google Chrome.app` (macOS). |

The browser profile is stored in `~/.config/mcp-amazon/browser_data`.

## MCP client config

```json
{
  "mcpServers": {
    "mcp-amazon": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-amazon/src/server.mjs"],
      "env": {  }
    }
  }
}
```

## CLI

```bash
node src/cli.mjs search "wireless mouse" [--free-shipping]
node src/cli.mjs product B0XXXXXXXX
```

## Notes

Scraping depends on Amazon's markup and may break when it changes. Cost figures are estimates. Use in line with Amazon's terms of service.

## License

MIT
