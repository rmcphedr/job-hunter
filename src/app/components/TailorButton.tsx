"use client";
import { useFormStatus } from "react-dom";

/** Tailor Resume / Regenerate: Codex can take a few minutes. */
export function TailorButton({ label, running }: { label: string; running?: boolean }) {
  const { pending } = useFormStatus();
  const busy = pending || running;
  return (
    <button className="btn primary" type="submit" disabled={busy}>
      {busy ? "Tailoring resume…" : label}
    </button>
  );
}

export function CancelTailorButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? "Cancelling…" : "Cancel"}
    </button>
  );
}
