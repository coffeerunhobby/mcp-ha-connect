#!/usr/bin/env tsx
/**
 * Generate JWT tokens for MCP server authentication
 *
 * Usage:
 *   npx tsx scripts/generate-jwt.ts [options]
 *   npm run generate:jwt -- [options]
 *
 * Options:
 *   --sub <user>       Subject (username), default: 'admin'
 *   --exp <duration>   Expiration (e.g., '1h', '7d', '30d'), default: '7d'
 *   --secret <secret>  JWT secret (or use MCP_AUTH_SECRET env var)
 *
 * Examples:
 *   npm run generate:jwt
 *   npm run generate:jwt -- --sub claude --exp 30d
 *   npm run generate:jwt -- --sub readonly --exp 1h --secret mysecret
 */

import { createJwt } from '../src/utils/jwt.js';

function parseArgs(): { sub: string; exp: string; secret: string } {
  const args = process.argv.slice(2);
  let sub = 'admin';
  let exp = '7d';
  let secret = process.env.MCP_AUTH_SECRET || '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sub' && args[i + 1]) {
      sub = args[++i];
    } else if (args[i] === '--exp' && args[i + 1]) {
      exp = args[++i];
    } else if (args[i] === '--secret' && args[i + 1]) {
      secret = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Generate JWT tokens for MCP server authentication

Usage:
  npm run generate:jwt -- [options]

Options:
  --sub <user>       Subject (username), default: 'admin'
  --exp <duration>   Expiration (e.g., '1h', '7d', '30d'), default: '7d'
  --secret <secret>  JWT secret (or use MCP_AUTH_SECRET env var)

Examples:
  npm run generate:jwt
  npm run generate:jwt -- --sub claude --exp 30d
  npm run generate:jwt -- --sub readonly --exp 1h
`);
      process.exit(0);
    }
  }

  return { sub, exp, secret };
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}. Use format like '1h', '7d', '30d'`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = Math.floor(Date.now() / 1000);
  switch (unit) {
    case 's':
      return now + value;
    case 'm':
      return now + value * 60;
    case 'h':
      return now + value * 3600;
    case 'd':
      return now + value * 86400;
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }
}

function main() {
  const { sub, exp, secret } = parseArgs();

  if (!secret) {
    console.error('Error: No secret provided.');
    console.error('Set MCP_AUTH_SECRET environment variable or use --secret option.');
    console.error('\nExample:');
    console.error('  export MCP_AUTH_SECRET=your-secret-here');
    console.error('  npm run generate:jwt');
    process.exit(1);
  }

  if (secret.length < 32) {
    console.error('Warning: Secret should be at least 32 characters for security.');
  }

  const iat = Math.floor(Date.now() / 1000);
  const expTime = parseDuration(exp);

  const payload = {
    sub,
    iat,
    exp: expTime,
  };

  const token = createJwt(payload, secret);

  console.log('\n=== JWT Token Generated ===\n');
  console.log('Subject:', sub);
  console.log('Issued at:', new Date(iat * 1000).toISOString());
  console.log('Expires at:', new Date(expTime * 1000).toISOString());
  console.log('Duration:', exp);
  console.log('\n--- Token ---\n');
  console.log(token);
  console.log('\n--- Usage ---\n');
  console.log(`curl -H "Authorization: Bearer ${token}" http://localhost:3000/mcp ...`);
  console.log('');
}

main();
