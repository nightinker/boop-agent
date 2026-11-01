import { useCallback, useEffect, useState } from "react";

/**
 * Phone layout kicks in below Tailwind's `md` breakpoint (768px). Every
 * phone-only class uses the `max-md:` variant and every phone-only CSS rule
 * sits in a `(max-width: 767px)` media query, so the desktop layout is
 * untouched.
 */
export const MOBILE_BREAKPOINT_PX = 768;
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;

/**
 * Classes that turn the desktop sidebar into a slide-in drawer on phones.
 * Only `max-md:` classes, so they never apply on desktop.
 */
export function navDrawerClasses(open: boolean): string {
  const drawer = [
    "max-md:fixed",
    "max-md:inset-y-0",
    "max-md:left-0",
    "max-md:z-50",
    "max-md:w-[min(280px,85vw)]",
    "max-md:overflow-y-auto",
    "max-md:shadow-2xl",
    "max-md:shadow-black/40",
  ];
  if (!open) drawer.push("max-md:hidden");
  return drawer.join(" ");
}

export function isMobileViewport(width: number): boolean {
  return width < MOBILE_BREAKPOINT_PX;
}

/**
 * Open/closed state for the phone nav drawer. Closes on Escape and when the
 * window grows to desktop width, so a stale drawer never covers the sidebar.
 */
export function useMobileNav() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onResize() {
      if (!isMobileViewport(window.innerWidth)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return { open, close, toggle };
}
