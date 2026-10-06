import { defineConnection, definePlugin, defineSource } from '@jaspers-ai/sdk'

// A connection: an MCP server the plugin reaches over streamable HTTP, with a key in a header. The
// server's tools are offered to the assistant as they are; a source names one of them so views can
// run it and the assistant sees it by name. A server that signs in through the browser is auth:
// 'oauth' with no header. A plugin the assistant builds reaches servers by https address only,
// never a command of its own.

export default definePlugin({
  id: 'connection',
  secrets: { token: { label: 'Example MCP server key' } },
  connections: {
    server: defineConnection({
      url: 'https://mcp.example.com/mcp',
      auth: 'bearer',
      // Single quotes, never a template literal: the app fills the reference in when it connects.
      headers: { Authorization: 'Bearer ${secret:token}' },
    }),
  },
  sources: {
    // One tool on the connection. Its parameters are the server's own input schema.
    search: defineSource({ mcp: 'server', tool: 'search', description: 'Search the example service.' }),
  },
})
