import { useState } from "react";
import { login } from "./api.ts";
import { AsyncButton } from "./AsyncButton.tsx";
import { BrandTitle } from "./BrandTitle.tsx";

export interface LoginProps {
  readonly onSignedIn: () => void;
}

export function Login({ onSignedIn }: LoginProps) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await login(token);
    setBusy(false);
    if (ok) {
      setToken("");
      onSignedIn();
    } else {
      setError("Invalid token.");
    }
  };

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <BrandTitle />
        <p className="sub">Enter the console access token.</p>
        <input
          data-testid="console-access-token"
          aria-label="Console access token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="access token"
          autoFocus
        />
        {error ? <p className="err">{error}</p> : null}
        <AsyncButton data-testid="console-sign-in" className="btn primary" type="submit" pending={busy} disabled={!token}>
          Sign in
        </AsyncButton>
      </form>
    </div>
  );
}
