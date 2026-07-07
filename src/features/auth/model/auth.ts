import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { db } from "@/shared/db";
import {
  emailVerifyAccount,
  emailResetPassword,
  emailMagicLink,
} from "@/server/email";

/**
 * Configuração do better-auth (identidade/sessão do app).
 *
 * Login social com Google. `accessType: offline` + `prompt` com `consent`
 * garantem que a conta vinculada tenha refresh_token — usado depois para
 * conectar a agenda do usuário ao Recall (fluxo de calendar é separado, mas
 * reaproveita o mesmo OAuth client do Google).
 *
 * Tabelas (user/session/account/verification/rateLimit) geradas via `better-auth`
 * CLI e versionadas no schema do Drizzle. Após mudar rateLimit.storage="database"
 * rode a geração de schema/migration do better-auth p/ criar a tabela rateLimit.
 */

// Verificação de email só é EXIGIDA quando há provedor de email configurado
// (REQUIRE_EMAIL_VERIFICATION=true). Sem SMTP/provider, exigir travaria o login
// — então o default é off, mas o wiring já está pronto: basta a flag + integrar
// um provider real no lugar do console.log.
const requireEmailVerification =
  process.env.REQUIRE_EMAIL_VERIFICATION === "true";

// Origens confiáveis (CSRF/origin check do better-auth). Inclui o domínio de
// produção (env) + localhost nas portas de dev, para o mesmo build funcionar
// tanto no túnel quanto acessado direto em localhost.
const trustedOrigins = [
  process.env.BETTER_AUTH_URL,
  process.env.NEXT_PUBLIC_APP_URL,
  "http://localhost:3000",
  "http://localhost:3009",
].filter((v): v is string => Boolean(v));

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification,
    // Reset de senha via Resend (fluxo forget → e-mail → /reset-password).
    sendResetPassword: async ({ user, url }) => {
      await emailResetPassword({ to: user.email, url });
    },
  },
  emailVerification: {
    sendOnSignIn: requireEmailVerification,
    sendVerificationEmail: async ({ user, url }) => {
      await emailVerifyAccount({ to: user.email, url });
    },
  },
  // Rate limit nativo — cobre login/signup (o que o Twenty NÃO faz). Regras mais
  // duras nos endpoints de credencial pra frear brute-force e enumeração.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "database",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
      "/forget-password": { window: 60, max: 3 },
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      accessType: "offline",
      prompt: "select_account consent",
    },
  },
  plugins: [
    // Login por magic link (e-mail sem senha). Envia via Resend.
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await emailMagicLink({ to: email, url });
      },
    }),
    // nextCookies deve ser o ÚLTIMO plugin (intercepta Set-Cookie das respostas).
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
