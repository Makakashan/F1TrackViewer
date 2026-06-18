"use client";

import { FormEvent, useState, useSyncExternalStore } from "react";
import { Flag, Lock, LogIn, ShieldCheck, User } from "lucide-react";
import F1TrackApp from "@/components/f1-track-app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ADMIN_SESSION_KEY = "f1tv:admin-session:v1";
const ADMIN_USERNAME = process.env.NEXT_PUBLIC_ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD;
const ADMIN_ENABLED = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);

function subscribeToSessionStorage() {
  return () => {};
}

function getClientSessionSnapshot() {
  return window.sessionStorage.getItem(ADMIN_SESSION_KEY) === "1";
}

function getServerSessionSnapshot() {
  return false;
}

export default function AdminPage() {
  const sessionAuthenticated = useSyncExternalStore(
    subscribeToSessionStorage,
    getClientSessionSnapshot,
    getServerSessionSnapshot,
  );
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      window.sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
      setAuthenticated(true);
      setError(null);
      return;
    }

    setError("Invalid admin credentials");
  }

  if (!ADMIN_ENABLED) {
    return <main className="min-h-screen bg-background" />;
  }

  if (authenticated || sessionAuthenticated) {
    return <F1TrackApp startFinishCalibration />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-md border border-border bg-card p-5 shadow-lg"
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-linear-to-br from-red-600 to-orange-600 shadow-[0_0_20px_rgba(225,6,0,0.35)]">
            <ShieldCheck className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-none">
              Admin calibration
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Start/finish marker editor
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="admin-username" className="text-xs">
              Login
            </Label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="admin-username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="admin-password" className="text-xs">
              Password
            </Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </div>

        {error && <div className="mt-3 text-xs text-destructive">{error}</div>}

        <Button type="submit" className="mt-5 w-full gap-2">
          <LogIn className="h-4 w-4" />
          Open calibration
        </Button>

        <div className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Static hosting can only hide this tool in the UI; credentials are
            client-side build configuration.
          </span>
        </div>
      </form>
    </main>
  );
}
