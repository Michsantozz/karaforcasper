import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * LoginScreen (Tier 1): Google + magic link + e-mail/senha (signup + forgot).
 * Testamos que cada método chama o endpoint certo do better-auth com os
 * argumentos corretos, e que erros do SDK viram toast (não quebram a UI).
 *
 * O auth-client (better-auth/react) e o sonner são mockados — validamos a
 * ORQUESTRAÇÃO da tela, não a lib de auth.
 */

const social = vi.fn();
const magicLink = vi.fn();
const signUpEmail = vi.fn();
const signInEmail = vi.fn();
const requestPasswordReset = vi.fn();

vi.mock("@/features/auth/model/auth-client", () => ({
  signIn: { social: (...a: unknown[]) => social(...a) },
  authClient: {
    signIn: {
      magicLink: (...a: unknown[]) => magicLink(...a),
      email: (...a: unknown[]) => signInEmail(...a),
    },
    signUp: { email: (...a: unknown[]) => signUpEmail(...a) },
    requestPasswordReset: (...a: unknown[]) => requestPasswordReset(...a),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { LoginScreen } from "@/features/auth/ui/LoginScreen";

beforeEach(() => {
  vi.clearAllMocks();
  // window.location.href é setado no fluxo de senha; stub p/ não navegar em jsdom.
  Object.defineProperty(window, "location", {
    value: { href: "" },
    writable: true,
  });
});
afterEach(() => cleanup());

describe("LoginScreen — Google", () => {
  it("botão Google chama signIn.social com provider google + callbackURL", async () => {
    const user = userEvent.setup();
    render(<LoginScreen />);
    await user.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});

describe("LoginScreen — erro de verificação do magic link (?error=)", () => {
  function stubLocation(search: string) {
    const replaceState = vi.fn();
    Object.defineProperty(window, "location", {
      value: { href: "", search, pathname: "/" },
      writable: true,
    });
    Object.defineProperty(window, "history", {
      value: { replaceState },
      writable: true,
    });
    return replaceState;
  }

  it("token inválido na URL vira toast e limpa a query", async () => {
    const replaceState = stubLocation("?error=INVALID_TOKEN");
    render(<LoginScreen />);
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Invalid or already used link. Request a new one below.",
      ),
    );
    expect(replaceState).toHaveBeenCalledWith({}, "", "/");
  });

  it("erro desconhecido cai na mensagem genérica", async () => {
    stubLocation("?error=weird_thing");
    render(<LoginScreen />);
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Failed to sign in. Please try again."),
    );
  });

  it("sem ?error não dispara toast", async () => {
    stubLocation("");
    render(<LoginScreen />);
    // Deixa o effect rodar; nenhum toast de erro deve sair.
    await waitFor(() => expect(document.body).toBeInTheDocument());
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("LoginScreen — magic link (tab default)", () => {
  it("envia o link e mostra confirmação", async () => {
    magicLink.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<LoginScreen />);

    await user.type(screen.getByPlaceholderText("you@email.com"), "a@b.com");
    await user.click(screen.getByRole("button", { name: /send access link/i }));

    expect(magicLink).toHaveBeenCalledWith({
      email: "a@b.com",
      callbackURL: "/",
      // Token inválido/expirado na verificação volta pra home com ?error=.
      errorCallbackURL: "/",
    });
    await waitFor(() =>
      expect(screen.getByText(/we sent an access link/i)).toBeInTheDocument(),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("erro do SDK vira toast e não mostra confirmação", async () => {
    magicLink.mockResolvedValue({ error: { message: "rate limited" } });
    const user = userEvent.setup();
    render(<LoginScreen />);

    await user.type(screen.getByPlaceholderText("you@email.com"), "a@b.com");
    await user.click(screen.getByRole("button", { name: /send access link/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("rate limited"));
    expect(screen.queryByText(/we sent an access link/i)).not.toBeInTheDocument();
  });
});

describe("LoginScreen — e-mail + senha", () => {
  async function switchToPassword(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /password/i }));
  }

  it("login por senha chama signIn.email e navega em sucesso", async () => {
    signInEmail.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<LoginScreen />);
    await switchToPassword(user);

    await user.type(screen.getByPlaceholderText("you@email.com"), "a@b.com");
    await user.type(screen.getByPlaceholderText("Password"), "s3nh4forte");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(signInEmail).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "s3nh4forte",
      callbackURL: "/",
    });
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("credencial inválida vira toast, sem navegar", async () => {
    signInEmail.mockResolvedValue({ error: { message: "Invalid email or password." } });
    const user = userEvent.setup();
    render(<LoginScreen />);
    await switchToPassword(user);

    await user.type(screen.getByPlaceholderText("you@email.com"), "a@b.com");
    await user.type(screen.getByPlaceholderText("Password"), "errada");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Invalid email or password."),
    );
    expect(window.location.href).toBe("");
  });

  it("alternar para signup e criar conta chama signUp.email", async () => {
    signUpEmail.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<LoginScreen />);
    await switchToPassword(user);

    await user.click(screen.getByRole("button", { name: /sign up/i }));
    // Agora o form tem campo de nome e botão "Criar conta".
    await user.type(screen.getByPlaceholderText("Your name"), "Fulano");
    await user.type(screen.getByPlaceholderText("you@email.com"), "novo@b.com");
    await user.type(screen.getByPlaceholderText("Password"), "s3nh4forte");
    await user.click(screen.getByRole("button", { name: /^sign up$/i }));

    expect(signUpEmail).toHaveBeenCalledWith({
      name: "Fulano",
      email: "novo@b.com",
      password: "s3nh4forte",
      callbackURL: "/",
    });
  });

  it("esqueci a senha chama requestPasswordReset com redirectTo", async () => {
    requestPasswordReset.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<LoginScreen />);
    await switchToPassword(user);

    await user.type(screen.getByPlaceholderText("you@email.com"), "a@b.com");
    await user.click(screen.getByRole("button", { name: /forgot password/i }));

    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: "a@b.com",
      redirectTo: "/reset-password",
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it("esqueci a senha sem e-mail preenchido avisa e não chama o SDK", async () => {
    const user = userEvent.setup();
    render(<LoginScreen />);
    await switchToPassword(user);

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Enter your email first.");
  });
});
