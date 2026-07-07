import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Headers de segurança. Twenty (referência que auditamos) NÃO tem nenhum — deixa
 * pra camada de proxy —, o que é frágil pra self-host. Aqui setamos explícito no
 * app, independente da infra à frente.
 *
 * A CSP restritiva só entra em produção: em dev o Next injeta eval/inline p/ HMR
 * e uma CSP dura quebra o WebSocket de recarga. `frame-ancestors 'none'` protege
 * o popup de assinatura da Casper Wallet contra clickjacking.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  ...(isProd
    ? [
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            // Next injeta scripts inline hidratados; sem nonce global, 'unsafe-inline'
            // é o baseline. Endurecer com nonce é evolução futura.
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            "font-src 'self' data:",
            // APIs externas que o cliente chama (RPC Casper, explorer, AWS/Bedrock
            // é server-side). Ajuste conforme os hosts reais em uso.
            "connect-src 'self' https: wss:",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
          ].join("; "),
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Hosts permitidos a acessar recursos de dev (HMR etc). Necessário quando o app
  // roda atrás de túnel (Cloudflare) sob outro domínio — sem isso o Next bloqueia
  // cross-origin e o WebSocket de HMR falha (502).
  allowedDevOrigins: ["casper.ultraself.com.br"],
  // casper-js-sdk e libs de cripto rodam só no server; nunca empacotar no client bundle.
  serverExternalPackages: [
    "casper-js-sdk",
    "@mastra/core",
    "@mastra/memory",
    "@mastra/pg",
    "@mastra/inngest",
    "inngest",
    // better-auth puxa @better-auth/kysely-adapter (deps Node/sqlite) que quebra
    // o bundler. Externalizamos só o adapter+kysely; o pacote better-auth em si
    // (e better-auth/react no client) continua bundled para compartilhar o React
    // do app — externalizá-lo inteiro causa "two Reacts" (useRef null).
    "@better-auth/kysely-adapter",
    "kysely",
  ],
};

export default nextConfig;
