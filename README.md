# Marrow - Finasaan Internal API Service

Marrow is a Cloudflare Worker that serves as an internal API service for the Finasaan application.

## Features

- **Supabase Integration**: PostgreSQL database connection via Supabase client
- **Health Check**: Service health monitoring endpoint
- **CORS Support**: Configured for cross-origin requests
- **Simple HTTP API**: Easy to consume REST endpoints

## Database Setup

This service connects to a PostgreSQL database via Supabase. The schema is shared with the spine service.

### Local Development

For local development, the service connects to a local Supabase instance (Docker). Configure your `.dev.vars` file:

```bash
# Local Supabase connection (Docker container)
SUPABASE_URL=http://localhost:54321
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
```

### Production Deployment

For production, set the secrets using Wrangler:

```bash
npx wrangler secret put SUPABASE_URL
# Enter your Supabase project URL when prompted

npx wrangler secret put SUPABASE_KEY
# Enter your Supabase anon key when prompted
```

## API Endpoints

### GET /api/health

Health check endpoint for monitoring service status.

**Response:**

```json
{
  "status": "healthy",
  "service": "marrow",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### GET /api/db-test

Test database connection.

### GET /api/message

Simple hello world endpoint.

## Development

```bash
# Install dependencies
npm install

# Generate Cloudflare types
npm run cf-typegen

# Start development server (port 8788)
npm run dev

# Deploy to Cloudflare
npm run deploy
```
