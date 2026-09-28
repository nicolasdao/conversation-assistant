#!/usr/bin/env node
'use strict';

/**
 * cf.js — read-only Cloudflare access wrapper.
 *
 * Purpose: let an agent query the Cloudflare GraphQL Analytics API and the
 * REST API WITHOUT ever exposing the API token to stdout / the context window.
 *
 * The token is read from the environment variable CLOUDFLARE_API_TOKEN, or from
 * the nearest `.env` file walking up from the current working directory, INSIDE
 * this process. It is attached as the `Authorization: Bearer` header and never
 * printed. Only API result bodies are written to stdout: the token's value never
 * crosses the shell or the LLM context boundary.
 *
 * READ-ONLY by design: REST is restricted to GET; the GraphQL Analytics API has
 * no mutations. Write operations (DNS/WAF/zone-settings edits, deploys) are
 * deliberately NOT implemented here — they belong to the cloudflare-config and
 * cloudflare-deploy skills, and each write should be confirmed before it hits
 * the live account.
 *
 * Usage:
 *   node scripts/cf.js rest GET "/zones?name=example.com"
 *   node scripts/cf.js graphql '<query>' '<variablesJson>'
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.cloudflare.com/client/v4';
// The Cloudflare-canonical name, matching wrangler and the skill's env schema.
const TOKEN_VAR = 'CLOUDFLARE_API_TOKEN';

function fail(message, exitCode) {
	// Errors never include the token or the Authorization header.
	process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
	process.exit(exitCode || 1);
}

/**
 * Read the token. Never logs it.
 * 1. Prefer the process environment (CLOUDFLARE_API_TOKEN). An ambient
 *    environment variable always wins over the .env file.
 * 2. Otherwise walk up from the current working directory looking for a `.env`
 *    that defines it. Running from anywhere under the project finds the
 *    project-root `.env`.
 */
function loadToken() {
	if (process.env[TOKEN_VAR]) return process.env[TOKEN_VAR];

	const re = new RegExp('^\\s*(?:export\\s+)?' + TOKEN_VAR + '\\s*=\\s*(.*)$', 'm');
	let dir = process.cwd();
	// Walk up to the filesystem root.
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const envPath = path.join(dir, '.env');
		try {
			const raw = fs.readFileSync(envPath, 'utf8');
			const m = raw.match(re);
			if (m) {
				let v = m[1].trim();
				if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
				if (v) return v;
			}
		} catch (e) {
			// .env not present at this level — keep walking up.
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	fail(`${TOKEN_VAR} not found — set it in the environment or in a project-root .env`);
}

function authHeaders(token) {
	return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function emit(res) {
	const json = await res.json().catch(() => null);
	process.stdout.write(JSON.stringify(json, null, 2) + '\n');
	return json;
}

async function runGraphql(token, query, variablesJson) {
	if (!query) fail('usage: cf.js graphql <query> [variablesJson]');
	let variables = {};
	if (variablesJson) {
		try {
			variables = JSON.parse(variablesJson);
		} catch (e) {
			fail(`invalid variables JSON: ${e.message}`);
		}
	}
	const res = await fetch(`${API_BASE}/graphql`, {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ query, variables }),
	});
	const json = await emit(res);
	// GraphQL returns HTTP 200 even when the query has errors — surface via exit code.
	if (!res.ok || (json && Array.isArray(json.errors) && json.errors.length)) process.exit(2);
}

async function runRest(token, method, p) {
	method = (method || '').toUpperCase();
	if (!method || !p) fail('usage: cf.js rest <METHOD> <path> [GET only]');
	if (method !== 'GET') fail(`read-only wrapper: '${method}' not allowed (only GET)`);
	if (!p.startsWith('/')) fail('path must start with "/"');
	const res = await fetch(`${API_BASE}${p}`, { method, headers: authHeaders(token) });
	await emit(res);
	if (!res.ok) process.exit(2);
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const token = loadToken();
	if (cmd === 'graphql') return runGraphql(token, rest[0], rest[1]);
	if (cmd === 'rest') return runRest(token, rest[0], rest[1]);
	fail(`unknown command '${cmd || ''}' — commands: graphql, rest GET`);
}

main().catch((e) => fail(e.message));
