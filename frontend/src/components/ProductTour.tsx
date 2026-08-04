'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { TOUR_STEPS } from '../lib/tour-steps';

/**
 * The first-login guided tour.
 *
 * It drives the REAL application rather than a simulation of it: each step
 * navigates to the route it describes and draws a ring around a real element
 * already on that page. Nothing is injected into those screens and nothing
 * about them changes while the tour runs — the ring is a fixed-position
 * element measured from `getBoundingClientRect()`, so a bug in here can make
 * the highlight land in the wrong place but can never corrupt the page it is
 * pointing at.
 *
 * State lives on the user's own row (PATCH /auth/me/product-tour), so skipping
 * on a laptop is also skipped on a phone — and clearing browser storage does
 * not resurrect a tour someone has already dismissed. It is written once, when
 * the user is finished with it, and never on merely opening a step.
 *
 * Re-launching is always allowed and deliberately does NOT reset the stored
 * status back to pending: "show me that again" is not the same as "start
 * pestering me at every login again".
 */

interface TourState {
  /** Open the tour from step one. Available to any signed-in user, anytime. */
  start: () => void;
  active: boolean;
}

const TourContext = createContext<TourState | null>(null);

export function useTour(): TourState {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within <TourProvider>.');
  return ctx;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** How long to wait for a step's anchor before showing the step without a ring. */
const ANCHOR_TIMEOUT_MS = 4000;
const CARD_WIDTH = 420;
const CARD_GAP = 14;
const VIEWPORT_PAD = 16;

export function TourProvider({ children }: { children: React.ReactNode }) {
  const { user, setProductTourStatus } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [ring, setRing] = useState<Rect | null>(null);
  /** Where the current step is headed. Null while it is still being resolved. */
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);

  // Auto-launch exactly once per mount, and only for a user who has never
  // finished with it. `autoLaunched` stops it re-opening if /auth/me refreshes.
  const autoLaunched = useRef(false);
  useEffect(() => {
    if (!user || autoLaunched.current) return;
    if (user.productTourStatus === 'pending') {
      autoLaunched.current = true;
      setIndex(0);
      setActive(true);
    }
  }, [user]);

  const start = useCallback(() => {
    autoLaunched.current = true; // a manual replay also satisfies "already offered"
    setIndex(0);
    setRing(null);
    setCardPos(null);
    setTargetPath(null);
    setActive(true);
  }, []);

  const finish = useCallback(
    (status: 'completed' | 'skipped') => {
      setActive(false);
      setRing(null);
      setCardPos(null);
      setTargetPath(null);
      // Optimistic: the tour closes now. If the write fails the user simply
      // gets offered it again next login, which is a far better failure than
      // a walkthrough that refuses to close because the network blipped.
      setProductTourStatus(status);
      void apiFetch('/auth/me/product-tour', { method: 'PATCH', body: { status } }).catch(() => {});
    },
    [setProductTourStatus],
  );

  const step = active ? TOUR_STEPS[index] : null;

  // Navigate to the step's real route. Steps whose target depends on tenant
  // data (the retention step opens an actual data element) resolve it here,
  // which costs a round trip — so `targetPath` records where this step is
  // headed, and the highlight below refuses to draw anything until the browser
  // has actually arrived. Without that, advancing a step leaves the previous
  // screen on display with a ring still sitting on the previous screen's
  // element, under copy describing something else entirely.
  useEffect(() => {
    if (!step) {
      setTargetPath(null);
      return;
    }
    let cancelled = false;
    setTargetPath(null);
    (async () => {
      const resolved = step.resolveHref ? await step.resolveHref() : null;
      if (cancelled) return;
      const target = resolved ?? step.href;
      setTargetPath(target);
      if (window.location.pathname !== target) router.push(target);
    })();
    return () => {
      cancelled = true;
    };
  }, [step, router]);

  // Find, measure, and KEEP measuring the anchor.
  //
  // Polling rather than one measurement, because every one of these screens
  // fetches before it paints: the element does not exist for the first frames,
  // and then it MOVES as rows, toolbars and error banners land above it. A ring
  // measured once ends up pointing at empty space a moment later — which is
  // exactly the bug a tour cannot afford, since the whole claim is "look here".
  // Cheap: one getBoundingClientRect per tick, and state only changes when the
  // rect actually does, so a settled page re-renders nothing.
  useEffect(() => {
    // Drop the previous step's ring the instant the step changes, so a stale
    // highlight never sits on screen under the new step's copy.
    setRing(null);
    if (!step || !targetPath || pathname !== targetPath) return;

    let cancelled = false;
    let timer = 0;
    let scrolledIntoView = false;
    const startedAt = Date.now();

    const same = (a: Rect | null, b: Rect | null) =>
      a === b ||
      (!!a &&
        !!b &&
        Math.abs(a.top - b.top) < 0.5 &&
        Math.abs(a.left - b.left) < 0.5 &&
        Math.abs(a.width - b.width) < 0.5 &&
        Math.abs(a.height - b.height) < 0.5);

    const measure = () => {
      if (cancelled) return;
      // A step may name an inner element that only exists once the screen's
      // data has arrived. Until it does, hold the ring back rather than draw it
      // around a shell that is still empty.
      if (step.waitFor && !document.querySelector(step.waitFor)) {
        if (Date.now() - startedAt > ANCHOR_TIMEOUT_MS) setRing(null);
        return;
      }
      const el = document.querySelector(step.anchor);
      if (!el) {
        // Never showed up (slow load, or a role that cannot see this panel).
        // Show the step centred rather than stalling the whole tour on it.
        if (Date.now() - startedAt > ANCHOR_TIMEOUT_MS) setRing(null);
        return;
      }
      if (!scrolledIntoView) {
        scrolledIntoView = true;
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
      const r = el.getBoundingClientRect();
      const next = { top: r.top, left: r.left, width: r.width, height: r.height };
      setRing((prev) => (same(prev, next) ? prev : next));
    };

    const tick = () => {
      measure();
      if (!cancelled) timer = window.setTimeout(tick, 200);
    };
    tick();

    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [step, pathname, targetPath]);

  // Place the card so it covers as little of the highlighted element as
  // possible. Below/above are preferred, but a full-width table is taller than
  // the gap around it, so those often do not fit — and simply centring the card
  // then parks it squarely on top of the very rows the step is talking about.
  // So: score the candidate positions by how much of the ring each one hides,
  // and take the least-bad one. Measured after paint, when the card's real
  // height is known.
  useLayoutEffect(() => {
    if (!step) return;
    const height = cardRef.current?.offsetHeight ?? 260;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!ring) {
      setCardPos({
        top: Math.max(VIEWPORT_PAD, (vh - height) / 2),
        left: Math.max(VIEWPORT_PAD, (vw - CARD_WIDTH) / 2),
      });
      return;
    }

    // Horizontal: hug the ring's left edge normally. But when the ring is much
    // wider than the card — a full-width table — sit against its RIGHT edge
    // instead, because the columns that identify a row (the document's name)
    // are on the left, and those are exactly what the reader needs to see.
    const preferRight = ring.width > CARD_WIDTH * 1.6;
    const rawLeft = preferRight ? ring.left + ring.width - CARD_WIDTH : ring.left;
    const left = Math.min(Math.max(VIEWPORT_PAD, rawLeft), vw - CARD_WIDTH - VIEWPORT_PAD);

    const overlap = (top: number) =>
      Math.max(0, Math.min(top + height, ring.top + ring.height) - Math.max(top, ring.top));

    const candidates = [
      ring.top + ring.height + CARD_GAP, // below
      ring.top - height - CARD_GAP, // above
      vh - height - VIEWPORT_PAD, // pinned to the bottom edge
      VIEWPORT_PAD, // pinned to the top edge
    ].filter((top) => top >= VIEWPORT_PAD && top + height <= vh - VIEWPORT_PAD);

    // Everything is taller than the viewport (a long panel on a short window):
    // fall back to the top edge, which at least keeps the card fully readable.
    const best = candidates.length
      ? candidates.reduce((a, b) => (overlap(b) < overlap(a) ? b : a))
      : VIEWPORT_PAD;

    setCardPos({ top: best, left: Math.max(VIEWPORT_PAD, left) });
  }, [step, ring]);

  // Esc is the universally expected way out of an overlay, and skipping is
  // always allowed — so Esc skips rather than silently pausing.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish('skipped');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  const isLast = index === TOUR_STEPS.length - 1;

  return (
    <TourContext.Provider value={{ start, active }}>
      {children}
      {step && (
        <>
          <div className={`tour-overlay${ring ? ' has-ring' : ''}`} data-testid="tour-overlay" />
          {ring && (
            <div
              className="tour-ring"
              data-testid="tour-ring"
              data-tour-anchor={step.anchor}
              style={{
                top: ring.top - 4,
                left: ring.left - 4,
                width: ring.width + 8,
                height: ring.height + 8,
              }}
            />
          )}
          <div
            className="panel tour-card"
            ref={cardRef}
            role="dialog"
            aria-modal="false"
            aria-labelledby="tour-title"
            data-testid="tour-card"
            data-tour-step={step.id}
            style={cardPos ? { top: cardPos.top, left: cardPos.left } : { top: -9999, left: -9999 }}
          >
            <div className="tour-step-count" data-testid="tour-step-count">
              Step {index + 1} of {TOUR_STEPS.length}
            </div>
            <h2 id="tour-title" style={{ marginTop: 6 }} data-testid="tour-title">
              {step.title}
            </h2>
            {step.body.map((paragraph, i) => (
              <p
                key={i}
                className={i === 0 ? undefined : 'muted'}
                style={{ fontSize: '0.9rem', margin: '0 0 8px' }}
              >
                {paragraph}
              </p>
            ))}

            <div className="tour-progress">
              {TOUR_STEPS.map((s, i) => (
                <span key={s.id} className={i <= index ? 'done' : undefined} />
              ))}
            </div>

            <div className="tour-actions">
              {/* Visible at every step, never behind a menu or an X in a corner. */}
              <button type="button" data-testid="tour-skip" onClick={() => finish('skipped')}>
                Skip
              </button>
              <div className="tour-actions-right">
                {index > 0 && (
                  <button type="button" data-testid="tour-back" onClick={() => setIndex((i) => i - 1)}>
                    Back
                  </button>
                )}
                {isLast ? (
                  <button
                    type="button"
                    className="primary"
                    data-testid="tour-done"
                    onClick={() => finish('completed')}
                  >
                    Got it
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    data-testid="tour-next"
                    onClick={() => setIndex((i) => i + 1)}
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </TourContext.Provider>
  );
}

/** The always-available re-launch control. Used in the shell and in Settings. */
export function TakeTheTourButton({
  className,
  testId = 'take-the-tour',
}: {
  className?: string;
  testId?: string;
}) {
  const { start } = useTour();
  return (
    <button type="button" className={className} data-testid={testId} onClick={start}>
      Take the tour
    </button>
  );
}
